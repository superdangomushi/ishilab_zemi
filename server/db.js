// MySQL 接続まわり。接続情報は環境変数で渡す。
const crypto = require("crypto");
const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "aihelper",
  waitForConnections: true,
  connectionLimit: 5,
  charset: "utf8mb4",
  // tasks.deadline_at などをローカル時刻文字列として扱うため、UTC 変換を無効化。
  timezone: "local",
  dateStrings: true,
});

// 起動時にテーブルが無ければ作る（DB 自体は事前に作成しておく前提）。
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transcripts (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      email       VARCHAR(255) NOT NULL,
      filename    VARCHAR(255) NOT NULL,
      content     LONGTEXT     NOT NULL,
      kadai_json  LONGTEXT     NULL,
      yotei_json  LONGTEXT     NULL,
      summary     TEXT         NULL,
      analyzed_at DATETIME     NULL,
      created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_email_filename (email, filename)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      email         VARCHAR(255) NOT NULL,
      type          VARCHAR(16)  NOT NULL,
      content       VARCHAR(512) NOT NULL,
      details       TEXT         NULL,
      deadline_at   DATETIME     NULL,
      date_only     TINYINT(1)   NOT NULL DEFAULT 0,
      status        VARCHAR(16)  NOT NULL DEFAULT 'pending',
      source_id     INT          NULL,
      dedup_key     CHAR(40)     NOT NULL,
      notified_1d   TINYINT(1)   NOT NULL DEFAULT 0,
      notified_1h   TINYINT(1)   NOT NULL DEFAULT 0,
      created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_dedup (email, dedup_key),
      KEY idx_email_deadline (email, deadline_at),
      KEY idx_status (status)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_summaries (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      email        VARCHAR(255) NOT NULL,
      day          DATE         NOT NULL,
      summary      LONGTEXT     NOT NULL,
      generated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_email_day (email, day)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  // AIチャットの会話履歴。同じアカウントでの継続的な文脈維持に使う。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      email      VARCHAR(255) NOT NULL,
      role       VARCHAR(16)  NOT NULL,
      content    TEXT         NOT NULL,
      created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_email_created (email, created_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      email      VARCHAR(255) NOT NULL,
      task_id    INT          NULL,
      kind       VARCHAR(32)  NOT NULL,
      channel    VARCHAR(16)  NOT NULL DEFAULT 'line',
      message    TEXT         NOT NULL,
      acked      TINYINT(1)   NOT NULL DEFAULT 0,
      created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_email_created (email, created_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  // Web から自己登録したユーザー（メール＋パスワード）。パスワードは scrypt で保存。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      email         VARCHAR(255) NOT NULL,
      salt          CHAR(32)     NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      token         CHAR(48)     NOT NULL,
      created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_users_email (email),
      KEY idx_users_token (token)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  // 既存テーブルに後付けカラムを足す（MySQL は ADD COLUMN IF NOT EXISTS 非対応のため自前判定）。
  await addColumnIfMissing("transcripts", "kadai_json", "LONGTEXT NULL");
  await addColumnIfMissing("transcripts", "yotei_json", "LONGTEXT NULL");
  await addColumnIfMissing("transcripts", "summary", "TEXT NULL");
  await addColumnIfMissing("transcripts", "analyzed_at", "DATETIME NULL");
  await widenColumnIfNeeded("users", "password_hash", 255, "VARCHAR(255) NOT NULL");
  // 資料ファイル（PDF/TXT等）の AI 要約。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS documents (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      email       VARCHAR(255) NOT NULL,
      name        VARCHAR(512) NOT NULL,
      mime        VARCHAR(128) NULL,
      summary     LONGTEXT     NOT NULL,
      created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_doc (email, name)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  // 履修時間割（科目登録から取得）。曜日×時限×科目名×教室。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS courses (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      email      VARCHAR(255) NOT NULL,
      term       VARCHAR(32)  NULL,
      day        VARCHAR(8)   NULL,
      period     INT          NULL,
      name       VARCHAR(255) NOT NULL,
      room       VARCHAR(255) NULL,
      start_time VARCHAR(8)   NULL,
      end_time   VARCHAR(8)   NULL,
      updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_courses_email (email)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  // 端末からアップロードされた音声ファイルを外部PCワーカーに渡すジョブ。
  // status: 'queued' → 'processing' → 'done' | 'error'
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audio_jobs (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      email         VARCHAR(255) NOT NULL,
      filename      VARCHAR(255) NOT NULL,
      stored_path   VARCHAR(1024) NOT NULL,
      mime          VARCHAR(128) NULL,
      size_bytes    BIGINT       NOT NULL DEFAULT 0,
      status        VARCHAR(16)  NOT NULL DEFAULT 'queued',
      error         TEXT         NULL,
      transcript_id INT          NULL,
      claimed_by    INT          NULL,
      attempts      INT          NOT NULL DEFAULT 0,
      created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_audio_email (email, created_at),
      KEY idx_audio_status (status)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  // ジョブを確保したワーカーPC（audio_workers.id）。再キュー後の二重処理防止と
  // 「どのPCが処理したか」の表示に使う。
  await addColumnIfMissing("audio_jobs", "claimed_by", "INT NULL");
  // 処理を試みた回数（claim のたびに +1）。失敗時は上限までは自動で queued に戻して
  // 再割り振りし、上限を超えたら error で保留する（音声ファイルは残るので手動再試行できる）。
  await addColumnIfMissing("audio_jobs", "attempts", "INT NOT NULL DEFAULT 0");

  // 音声ジョブを処理するワーカーPC（クライアント）。クライアントが初回起動時に
  // UUID（client_uuid）と表示名を自分で決めてサーバーへ登録する。以後の全リクエストは
  // 認証情報（email+token）と client_uuid の組で検証され、他人の UUID を名乗っても
  // アカウントが一致しなければ拒否される。ユーザーはダッシュボードでどのPCに
  // 処理させるかを複数選択できる（allowed）。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audio_workers (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      email        VARCHAR(255) NOT NULL,
      ip           VARCHAR(64)  NULL,
      name         VARCHAR(255) NOT NULL,
      allowed      TINYINT(1)   NOT NULL DEFAULT 1,
      created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_workers_email (email)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  // クライアントが生成して登録するPCのID（UUID）。全体で一意（他アカウントとの衝突は登録時に拒否）。
  await addColumnIfMissing("audio_workers", "client_uuid", "CHAR(36) NULL");
  await addIndexIfMissing("audio_workers", "uq_workers_uuid", "UNIQUE KEY uq_workers_uuid (client_uuid)");

  // ワーカーPCの公開範囲。private=クライアントでログインしたアカウントのジョブのみ、
  // global=このサービスの全ユーザーのジョブを処理できる。クライアントUIで選択し、
  // 登録（/api/client/register）と claim のJSONボディで申告される。
  await addColumnIfMissing("audio_workers", "mode", "VARCHAR(16) NOT NULL DEFAULT 'private'");
  // クライアントが3秒ごとに送ってくるリソース使用率（PC選択画面の表示用）。
  await addColumnIfMissing("audio_workers", "cpu_pct", "FLOAT NULL");
  await addColumnIfMissing("audio_workers", "mem_pct", "FLOAT NULL");
  await addColumnIfMissing("audio_workers", "gpu_pct", "FLOAT NULL");
  await addColumnIfMissing("audio_workers", "metrics_at", "DATETIME NULL");

  // globalワーカーに対する各ユーザーの利用可否。行が無ければ「利用しない」扱い
  // （オプトイン。他ユーザー提供のPCへ音声が流れるのはユーザーが明示的に
  // チェックを入れたときだけ）。audio_workers.allowed は所有者自身の設定なので、
  // 他ユーザー分はここで持つ。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audio_worker_prefs (
      email      VARCHAR(255) NOT NULL,
      worker_id  INT          NOT NULL,
      allowed    TINYINT(1)   NOT NULL DEFAULT 0,
      updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (email, worker_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  // Moodle カレンダーの iCal 書き出し URL（ユーザーごと）。
  await addColumnIfMissing("users", "moodle_ical_url", "VARCHAR(1024) NULL");
  // ユーザー自身が登録する Gemini API キー（AES-256-GCM 暗号化。暗号化は呼び出し側）。
  // サーバー共通の GEMINI_API_KEY(.env) は廃止し、AI機能はこのキーで動く。
  await addColumnIfMissing("users", "gemini_api_key_enc", "VARCHAR(1024) NULL");
  // 音声認識クオリティ（light/standard/high）。将来プラン（課金）で制限する想定。今は自由選択。
  await addColumnIfMissing("users", "stt_quality", "VARCHAR(16) NOT NULL DEFAULT 'high'");
  // Gemini の自動解析（課題/予定抽出・要約）を文字起こし保存時に自動で走らせるか。
  // 0 のときは自動では走らず、ダッシュボードの「解析する」ボタンで手動実行する。
  await addColumnIfMissing("users", "gemini_auto", "TINYINT(1) NOT NULL DEFAULT 1");
  // 紐付けた Google アカウントのメール（端末でサインインしたもの）。
  await addColumnIfMissing("users", "google_email", "VARCHAR(255) NULL");
  // Web(OAuth) で連携した Google アカウント（1ユーザーに複数可）。
  // refresh_token は AES-256-GCM で暗号化した文字列を保存する（暗号化は呼び出し側）。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS google_accounts (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      email         VARCHAR(255) NOT NULL,
      google_email  VARCHAR(255) NOT NULL,
      refresh_token TEXT         NOT NULL,
      created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_user_google (email, google_email)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  // Waseda アカウント（時間割スクレイパ用）。パスワードは AES-256-GCM で暗号化して保存。
  await addColumnIfMissing("users", "waseda_user", "VARCHAR(255) NULL");
  await addColumnIfMissing("users", "waseda_password_enc", "VARCHAR(1024) NULL");

  // スマホから同期されたカレンダー予定
  await pool.query(`
    CREATE TABLE IF NOT EXISTS calendar_events (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      email        VARCHAR(255) NOT NULL,
      title        VARCHAR(512) NOT NULL,
      start_at     VARCHAR(64)  NOT NULL,
      start_millis BIGINT       NOT NULL,
      location     VARCHAR(512) NULL,
      updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_cal_email (email)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
}

async function addColumnIfMissing(table, column, definition) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  if (rows[0].n === 0) {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function addIndexIfMissing(table, indexName, definition) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
    [table, indexName]
  );
  if (rows[0].n === 0) {
    await pool.query(`ALTER TABLE ${table} ADD ${definition}`);
  }
}

async function widenColumnIfNeeded(table, column, minLength, definition) {
  const [rows] = await pool.query(
    `SELECT CHARACTER_MAXIMUM_LENGTH AS len
     FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?
     LIMIT 1`,
    [table, column]
  );
  const len = Number(rows[0]?.len || 0);
  if (len > 0 && len < minLength) {
    await pool.query(`ALTER TABLE ${table} MODIFY COLUMN ${column} ${definition}`);
  }
}

// =====================================================================
// 文字起こし（transcripts）
// =====================================================================

// テキストを保存（同じ email + filename は上書き）。再アップロード時は古い解析結果を消す。
// 端末側（TranscriptStore）は毎時ファイルを累積した全文を毎回送ってくるので、上書きが正しい。
// 保存した行の id を返す。
async function saveTranscript(email, filename, content) {
  await pool.query(
    `INSERT INTO transcripts (email, filename, content)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
       content = VALUES(content),
       kadai_json = NULL, yotei_json = NULL, summary = NULL, analyzed_at = NULL,
       updated_at = CURRENT_TIMESTAMP`,
    [email, filename, content]
  );
  const [rows] = await pool.query(
    `SELECT id FROM transcripts WHERE email = ? AND filename = ? LIMIT 1`,
    [email, filename]
  );
  return rows[0] ? rows[0].id : null;
}

// テキストを保存（同じ email + filename は追記）。
// 外部PCワーカーから返る音声文字起こしは録音1本ずつが独立した本文のため、
// 同じ時間帯に複数回録音停止すると同じファイル名（yyyy-MM-dd_HH.txt）になり得る。
// saveTranscript のように上書きすると先の録音分が消えてしまうため、こちらは追記する。
// 保存した行の id を返す。
async function appendTranscript(email, filename, content) {
  await pool.query(
    `INSERT INTO transcripts (email, filename, content)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
       content = CONCAT(content, '\n\n', VALUES(content)),
       kadai_json = NULL, yotei_json = NULL, summary = NULL, analyzed_at = NULL,
       updated_at = CURRENT_TIMESTAMP`,
    [email, filename, content]
  );
  const [rows] = await pool.query(
    `SELECT id FROM transcripts WHERE email = ? AND filename = ? LIMIT 1`,
    [email, filename]
  );
  return rows[0] ? rows[0].id : null;
}

// Gemini の解析結果（課題・予定の生JSON＋短い要約）を transcripts 側に保存する。
async function saveAnalysis(id, kadai, yotei, summary) {
  await pool.query(
    `UPDATE transcripts
     SET kadai_json = ?, yotei_json = ?, summary = ?, analyzed_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [JSON.stringify(kadai || []), JSON.stringify(yotei || []), summary || null, id]
  );
}

// 解析結果（課題 or 予定）を transcripts の生JSONから取得。kind は "kadai" | "yotei"。
// email を条件に含め、他アカウントの解析結果を取得できないようにする。
async function getAnalysis(email, id, kind) {
  const column = kind === "yotei" ? "yotei_json" : "kadai_json";
  const [rows] = await pool.query(
    `SELECT filename, ${column} AS json FROM transcripts WHERE id = ? AND email = ? LIMIT 1`,
    [id, email]
  );
  if (!rows[0]) return null;
  let items = [];
  try {
    items = rows[0].json ? JSON.parse(rows[0].json) : [];
  } catch (_e) {
    items = [];
  }
  return { filename: rows[0].filename, items };
}

// 今日（サーバーのローカル日付）更新された解析済みファイルから、
// email ごとに課題・予定をまとめて返す。日次サマリ送信用。
// 返り値: [{ email, kadai: [...], yotei: [...] }]
async function getTodaysAnalysisByEmail() {
  const [rows] = await pool.query(
    `SELECT email, kadai_json, yotei_json
     FROM transcripts
     WHERE analyzed_at IS NOT NULL AND DATE(updated_at) = CURDATE()
     ORDER BY email, updated_at`
  );

  const byEmail = new Map();
  for (const row of rows) {
    if (!byEmail.has(row.email)) {
      byEmail.set(row.email, { email: row.email, kadai: [], yotei: [] });
    }
    const bucket = byEmail.get(row.email);
    bucket.kadai.push(...parseItems(row.kadai_json));
    bucket.yotei.push(...parseItems(row.yotei_json));
  }
  return [...byEmail.values()];
}

function parseItems(json) {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch (_e) {
    return [];
  }
}

// アカウント本人の一覧（Android アプリ・ダッシュボードの履歴画面用）。
// contains を渡すと「本文にその文字列を含むファイル」だけに絞る（全文検索）。
async function listTranscriptsByEmail(email, limit = 100, { contains = null } = {}) {
  const where = ["email = ?"];
  const args = [email];
  const q = String(contains || "").trim();
  if (q) {
    where.push(`content LIKE ? ESCAPE '\\\\'`);
    args.push(`%${escapeLike(q)}%`);
  }
  const [rows] = await pool.query(
    `SELECT id, filename, CHAR_LENGTH(content) AS chars, updated_at, analyzed_at
     FROM transcripts
     WHERE ${where.join(" AND ")}
     ORDER BY updated_at DESC, id DESC
     LIMIT ?`,
    [...args, Number(limit) || 100]
  );
  return rows;
}

// アカウント本人の 1 件を中身ごと取得（Android アプリなど、認証付き API 用）。
async function getTranscriptForEmail(email, id) {
  const [rows] = await pool.query(
    `SELECT id, filename, content, summary, updated_at, analyzed_at
     FROM transcripts
     WHERE email = ? AND id = ?
     LIMIT 1`,
    [email, id]
  );
  return rows[0] || null;
}

// 指定日の本文を新しい順で集める（日次要約の材料）。
// day は "YYYY-MM-DD"。ファイル名 "YYYY-MM-DD_HH.txt" の日付か、updated_at の日付で一致を見る。
async function getTranscriptsForDay(email, day) {
  const [rows] = await pool.query(
    `SELECT filename, content, summary FROM transcripts
     WHERE email = ?
       AND (filename LIKE ? OR DATE(updated_at) = ?)
     ORDER BY filename ASC, id ASC`,
    [email, `${day}\\_%`, day]
  );
  return rows;
}

async function listEmailsForDailySummary(day) {
  const [rows] = await pool.query(
    `SELECT DISTINCT email FROM tasks
     UNION
     SELECT DISTINCT email FROM transcripts
     WHERE filename LIKE ? OR DATE(updated_at) = ?`,
    [`${day}\\_%`, day]
  );
  return rows.map((r) => r.email);
}

// 質問文のキーワードに一致する過去の文字起こしを探し、一致箇所前後の抜粋を返す。
// keywords は2文字以上の語の配列。返り値: [{ filename, snippet }]
async function searchTranscriptSnippets(email, keywords, { limit = 5, snippetLen = 400 } = {}) {
  const terms = (keywords || []).filter((k) => k && k.length >= 2).slice(0, 8);
  if (terms.length === 0) return [];
  const likes = terms.map(() => `content LIKE ?`).join(" OR ");
  const args = [email, ...terms.map((t) => `%${t}%`)];
  const [rows] = await pool.query(
    `SELECT filename, content FROM transcripts
     WHERE email = ? AND (${likes})
     ORDER BY updated_at DESC LIMIT ?`,
    [...args, limit]
  );
  return rows.map((r) => {
    // 最初に一致した語の前後を抜粋する。
    let idx = -1;
    for (const t of terms) {
      const i = r.content.indexOf(t);
      if (i >= 0 && (idx < 0 || i < idx)) idx = i;
    }
    const start = Math.max(0, (idx < 0 ? 0 : idx) - Math.floor(snippetLen / 2));
    const snippet = r.content.slice(start, start + snippetLen);
    return { filename: r.filename, snippet };
  });
}

// 文字起こしの「時間インデックス」（本文を含まない軽量一覧）。
// AIチャットが「どのファイルを読むか」を時間から選ぶ材料にする。
// ファイル名は "YYYY-MM-DD_HH.txt"（その日のHH時台の録音）が基本なので、名前の降順=新しい順。
async function listTranscriptIndex(email, limit = 200) {
  const [rows] = await pool.query(
    `SELECT filename, CHAR_LENGTH(content) AS chars, updated_at
     FROM transcripts
     WHERE email = ?
     ORDER BY filename DESC, id DESC
     LIMIT ?`,
    [email, Number(limit) || 200]
  );
  return rows;
}

// AIチャットが時間インデックスから選んだファイルの本文を返す。
// filenames は本人のインデックスに載っている名前のみ渡すこと（呼び出し側で検証）。
async function getTranscriptsByFilenames(email, filenames, { maxFiles = 5 } = {}) {
  const names = [...new Set((filenames || []).map((f) => String(f).trim()).filter(Boolean))]
    .slice(0, maxFiles);
  if (names.length === 0) return [];
  const [rows] = await pool.query(
    `SELECT filename, content FROM transcripts
     WHERE email = ? AND filename IN (${names.map(() => "?").join(",")})
     ORDER BY filename ASC`,
    [email, ...names]
  );
  return rows;
}

// =====================================================================
// 課題・予定（tasks）
// =====================================================================

function dedupKey(email, type, content, deadlineAt) {
  return crypto
    .createHash("sha1")
    .update(`${email}|${type}|${content}|${deadlineAt || ""}`)
    .digest("hex");
}

function escapeLike(s) {
  return String(s || "").replace(/[\\%_]/g, (m) => `\\${m}`);
}

// 抽出した課題・予定を1件ずつ upsert する。
// item: { type, content, details, deadline_at(null可), date_only }
// 既存（同一 dedup_key）なら詳細などを更新しつつ、完了状態と通知済みフラグは維持する。
async function upsertTask(email, item, sourceId) {
  const type = item.type === "yotei" ? "yotei" : "kadai";
  const content = String(item.content || "").slice(0, 512);
  if (!content) return;
  const deadlineAt = item.deadline_at || null;
  const key = dedupKey(email, type, content, deadlineAt);
  await pool.query(
    `INSERT INTO tasks (email, type, content, details, deadline_at, date_only, source_id, dedup_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       details = VALUES(details),
       date_only = VALUES(date_only),
       source_id = COALESCE(tasks.source_id, VALUES(source_id)),
       updated_at = CURRENT_TIMESTAMP`,
    [email, type, content, item.details || null, deadlineAt, item.date_only ? 1 : 0, sourceId || null, key]
  );
}

async function upsertTasks(email, items, sourceId) {
  for (const it of items || []) {
    await upsertTask(email, it, sourceId);
  }
}

// 音声/文字起こし中の「明日の〇〇なしで」「やっぱり△△キャンセル」などを反映する。
// 事故防止のため target が空の取り消し指示は無視し、未完了の一致候補だけを物理削除する。
async function cancelTasks(email, cancellations) {
  const canceled = [];
  for (const c of cancellations || []) {
    const target = String(c.target || "").trim().slice(0, 512);
    if (!target) continue;

    const where = ["email = ?", "status = 'pending'", "(content LIKE ? ESCAPE '\\\\' OR details LIKE ? ESCAPE '\\\\')"];
    const args = [email, `%${escapeLike(target)}%`, `%${escapeLike(target)}%`];
    if (c.type === "kadai" || c.type === "yotei") {
      where.push("type = ?");
      args.push(c.type);
    }
    if (c.deadline_at) {
      where.push("deadline_at IS NOT NULL AND DATE(deadline_at) = DATE(?)");
      args.push(c.deadline_at);
    }

    const [rows] = await pool.query(
      `SELECT id, type, content, details, deadline_at, date_only
       FROM tasks
       WHERE ${where.join(" AND ")}
       ORDER BY
         CASE WHEN content = ? THEN 0 ELSE 1 END,
         (deadline_at IS NULL),
         ABS(TIMESTAMPDIFF(MINUTE, COALESCE(deadline_at, NOW()), COALESCE(?, deadline_at, NOW()))),
         id DESC
       LIMIT 5`,
      [...args, target, c.deadline_at || null]
    );
    if (!rows.length) continue;

    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    await pool.query(`DELETE FROM tasks WHERE email = ? AND id IN (${placeholders})`, [email, ...ids]);
    canceled.push(...rows);
  }
  return canceled;
}

// 音声/文字起こし中の「〇〇を15時に変更」「△△は明後日に変更ね」などを反映する。
// target が空、または変更内容が空の場合は無視する。候補が複数あっても最上位1件だけ更新する。
async function applyTaskUpdates(email, updates) {
  const updated = [];
  for (const u of updates || []) {
    const target = String(u.target || "").trim().slice(0, 512);
    if (!target) continue;

    const where = ["email = ?", "status = 'pending'", "(content LIKE ? ESCAPE '\\\\' OR details LIKE ? ESCAPE '\\\\')"];
    const args = [email, `%${escapeLike(target)}%`, `%${escapeLike(target)}%`];
    if (u.type === "kadai" || u.type === "yotei") {
      where.push("type = ?");
      args.push(u.type);
    }
    if (u.deadline_at) {
      where.push("deadline_at IS NOT NULL AND DATE(deadline_at) = DATE(?)");
      args.push(u.deadline_at);
    }

    const [rows] = await pool.query(
      `SELECT id, type, content, details, deadline_at, date_only
       FROM tasks
       WHERE ${where.join(" AND ")}
       ORDER BY
         CASE WHEN content = ? THEN 0 ELSE 1 END,
         (deadline_at IS NULL),
         ABS(TIMESTAMPDIFF(MINUTE, COALESCE(deadline_at, NOW()), COALESCE(?, deadline_at, NOW()))),
         id DESC
       LIMIT 1`,
      [...args, target, u.deadline_at || null]
    );
    const row = rows[0];
    if (!row) continue;

    const next = {
      type: u.new_type === "kadai" || u.new_type === "yotei" ? u.new_type : row.type,
      content: String(u.new_content || row.content || "").trim(),
      details: u.new_details ? String(u.new_details).trim() : (row.details || ""),
      deadline_at: u.new_deadline_at || row.deadline_at || null,
      date_only: u.new_deadline_at ? !!u.new_date_only : !!row.date_only,
    };
    const ok = await updateTask(email, row.id, next);
    if (ok) updated.push({ before: row, after: { id: row.id, ...next } });
  }
  return updated;
}

// 手動でタスクを追加する（Web のフォームなどから）。
async function addTask(email, { type, content, details, deadline_at, date_only }) {
  await upsertTask(email, { type, content, details, deadline_at, date_only }, null);
}

// 未完了タスクのうち deadline が近い順。type 省略で全種。
async function listUpcomingTasks(email, { includeDone = false, limit = 100 } = {}) {
  const where = ["email = ?"];
  const args = [email];
  if (!includeDone) where.push("status = 'pending'");
  const [rows] = await pool.query(
    `SELECT id, type, content, details, deadline_at, date_only, status, notified_1d, notified_1h
     FROM tasks
     WHERE ${where.join(" AND ")}
     ORDER BY (deadline_at IS NULL), deadline_at ASC, id DESC
     LIMIT ?`,
    [...args, limit]
  );
  return rows;
}

async function setTaskStatus(id, status, email = null) {
  const [result] = email
    ? await pool.query(`UPDATE tasks SET status = ? WHERE id = ? AND email = ?`, [status, id, email])
    : await pool.query(`UPDATE tasks SET status = ? WHERE id = ?`, [status, id]);
  return result.affectedRows > 0;
}

// 手動編集（Web のカレンダー画面などから）。email を条件に含め、他アカウントの
// タスクを操作できないようにする。deadline が変わるので通知済みフラグはリセットする。
async function updateTask(email, id, { type, content, details, deadline_at, date_only }) {
  const t = type === "yotei" ? "yotei" : "kadai";
  const c = String(content || "").trim().slice(0, 512);
  const key = dedupKey(email, t, c, deadline_at || null);
  const [result] = await pool.query(
    `UPDATE tasks SET
       type = ?, content = ?, details = ?, deadline_at = ?, date_only = ?,
       dedup_key = ?, notified_1d = 0, notified_1h = 0, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND email = ?`,
    [t, c, details || null, deadline_at || null, date_only ? 1 : 0, key, id, email]
  );
  return result.affectedRows > 0;
}

async function deleteTask(id, email = null) {
  const [result] = email
    ? await pool.query(`DELETE FROM tasks WHERE id = ? AND email = ?`, [id, email])
    : await pool.query(`DELETE FROM tasks WHERE id = ?`, [id]);
  return result.affectedRows > 0;
}

// リマインド対象を探す。窓 [now, now+within分] に締切があり、まだ該当フラグが立っていない未完了タスク。
// flagColumn は "notified_1d" | "notified_1h"。
async function findDueTasks(flagColumn, withinMinutes) {
  const col = flagColumn === "notified_1h" ? "notified_1h" : "notified_1d";
  const [rows] = await pool.query(
    `SELECT id, email, type, content, details, deadline_at, date_only
     FROM tasks
     WHERE status = 'pending'
       AND deadline_at IS NOT NULL
       AND ${col} = 0
       AND deadline_at > NOW()
       AND deadline_at <= DATE_ADD(NOW(), INTERVAL ? MINUTE)
     ORDER BY deadline_at ASC`,
    [withinMinutes]
  );
  return rows;
}

async function markNotified(id, flagColumn) {
  const col = flagColumn === "notified_1h" ? "notified_1h" : "notified_1d";
  await pool.query(`UPDATE tasks SET ${col} = 1 WHERE id = ?`, [id]);
}

// =====================================================================
// 音声ワーカーPC（audio_workers）
// =====================================================================

// クライアントが自分で生成した UUID と表示名でPCを登録する（再登録は名前/モードの更新）。
// UUID はサービス全体で一意。別アカウントが既に使っている UUID は登録を拒否する
// （なりすまし・取違防止のため。呼び出し側は 409 を返してクライアントに再生成させる）。
async function registerAudioWorker(email, clientUuid, { name = null, mode = null, ip = null } = {}) {
  const uuid = String(clientUuid || "").trim().toLowerCase();
  const label = String(name || "").trim().slice(0, 255) || "PC";
  const newMode = mode === "global" || mode === "private" ? mode : null;
  const [rows] = await pool.query(
    `SELECT id, email, ip, name, allowed, mode, client_uuid FROM audio_workers WHERE client_uuid = ? LIMIT 1`,
    [uuid]
  );
  if (rows[0]) {
    if (rows[0].email !== email) return { conflict: true };
    await pool.query(
      `UPDATE audio_workers SET name = ?, mode = COALESCE(?, mode), ip = ?, last_seen_at = NOW() WHERE id = ?`,
      [label, newMode, ip, rows[0].id]
    );
    return { ...rows[0], name: label, mode: newMode || rows[0].mode, ip };
  }
  const [r] = await pool.query(
    `INSERT INTO audio_workers (email, ip, name, mode, client_uuid) VALUES (?, ?, ?, ?, ?)`,
    [email, ip, label, newMode || "private", uuid]
  );
  return { id: r.insertId, email, ip, name: label, allowed: 1, mode: newMode || "private", client_uuid: uuid };
}

// 認証済みアカウントと UUID の両方が一致するワーカーだけを返す。
// UUID が実在しても所有アカウントが違えば null（他人のPCを名乗れない）。
// 見つかったら last_seen_at を進める（ダッシュボードの「接続中」表示用）。
async function getAudioWorkerByUuid(email, clientUuid) {
  const uuid = String(clientUuid || "").trim().toLowerCase();
  if (!uuid) return null;
  const [rows] = await pool.query(
    `SELECT id, email, ip, name, allowed, mode, client_uuid FROM audio_workers
     WHERE client_uuid = ? AND email = ? LIMIT 1`,
    [uuid, email]
  );
  if (!rows[0]) return null;
  await pool.query(`UPDATE audio_workers SET last_seen_at = NOW() WHERE id = ?`, [rows[0].id]);
  return rows[0];
}

// 自分のPCに加え、他ユーザーが global として公開しているPC（所有者が稼働許可
// しているものだけ）も返す。global PC の利用可否は audio_worker_prefs から
// 引いた pref_allowed（行が無ければ不許可＝未選択扱い）。
async function listAudioWorkers(email) {
  const [rows] = await pool.query(
    `SELECT w.id, w.ip, w.name, w.allowed, w.mode,
            w.cpu_pct, w.mem_pct, w.gpu_pct, w.metrics_at,
            w.created_at, w.last_seen_at,
            (w.email = ?) AS owned,
            p.allowed AS pref_allowed
     FROM audio_workers w
     LEFT JOIN audio_worker_prefs p ON p.worker_id = w.id AND p.email = ?
     WHERE w.email = ? OR (w.mode = 'global' AND w.allowed = 1)
     ORDER BY (w.email = ?) DESC, w.id ASC`,
    [email, email, email, email]
  );
  return rows;
}

async function getAudioWorker(id) {
  const [rows] = await pool.query(
    `SELECT id, email, ip, name, allowed, mode FROM audio_workers WHERE id = ? LIMIT 1`,
    [Number(id)]
  );
  return rows[0] || null;
}

// 他ユーザーの global ワーカーに自分のジョブを任せるかどうかの設定。
async function setAudioWorkerPref(email, workerId, allowed) {
  const [rows] = await pool.query(
    `SELECT id FROM audio_workers WHERE id = ? AND mode = 'global' LIMIT 1`,
    [Number(workerId)]
  );
  if (!rows[0]) return 0;
  await pool.query(
    `INSERT INTO audio_worker_prefs (email, worker_id, allowed) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE allowed = VALUES(allowed)`,
    [email, Number(workerId), allowed ? 1 : 0]
  );
  return 1;
}

// クライアントが claim 時に申告してきた現在のモード（global/private）を反映する。
async function setAudioWorkerMode(id, mode) {
  if (mode !== "global" && mode !== "private") return 0;
  const [r] = await pool.query(
    `UPDATE audio_workers SET mode = ? WHERE id = ?`,
    [mode, Number(id)]
  );
  return r.affectedRows;
}

// クライアントが3秒ごとに送ってくるリソース使用率を記録する。
async function updateAudioWorkerMetrics(id, { cpu = null, mem = null, gpu = null } = {}) {
  await pool.query(
    `UPDATE audio_workers
     SET cpu_pct = ?, mem_pct = ?, gpu_pct = ?, metrics_at = NOW(), last_seen_at = NOW()
     WHERE id = ?`,
    [cpu, mem, gpu, Number(id)]
  );
}

async function updateAudioWorker(email, id, { allowed = null, name = null } = {}) {
  const sets = [];
  const args = [];
  if (allowed !== null) {
    sets.push("allowed = ?");
    args.push(allowed ? 1 : 0);
  }
  if (name !== null && String(name).trim()) {
    sets.push("name = ?");
    args.push(String(name).trim().slice(0, 255));
  }
  if (!sets.length) return 0;
  args.push(Number(id), email);
  const [r] = await pool.query(
    `UPDATE audio_workers SET ${sets.join(", ")} WHERE id = ? AND email = ?`,
    args
  );
  return r.affectedRows;
}

async function deleteAudioWorker(email, id) {
  const [r] = await pool.query(
    `DELETE FROM audio_workers WHERE id = ? AND email = ?`,
    [Number(id), email]
  );
  return r.affectedRows;
}

// =====================================================================
// 音声文字起こしジョブ（audio_jobs）
// =====================================================================

async function createAudioJob(email, filename, storedPath, mime, sizeBytes) {
  const [r] = await pool.query(
    `INSERT INTO audio_jobs (email, filename, stored_path, mime, size_bytes)
     VALUES (?, ?, ?, ?, ?)`,
    [email, filename, storedPath, mime || null, sizeBytes || 0]
  );
  return r.insertId;
}

// 次の待機ジョブを1件つかんで processing にする。
// UPDATE ... ORDER BY ... LIMIT 1 の1文で確保するため、複数のワーカーPCが
// 同時にポーリングしても同じジョブを二重取得せず、それぞれ別のジョブが渡る。
// email を渡すと、そのユーザー本人のジョブだけを外部ワーカーへ渡す。
// global ワーカー（email = null）の場合は respectPrefs を立てて、所有者本人のジョブと、
// そのPCの利用を明示的に許可したユーザー（audio_worker_prefs.allowed = 1）の
// ジョブだけを対象にする（オプトイン。未設定ユーザーのジョブは渡さない）。
async function claimNextAudioJob(email = null, workerId = null, { respectPrefs = false, workerOwner = null } = {}) {
  // LAST_INSERT_ID(expr) は接続ごとの値なので、UPDATE と SELECT を同一接続で行う。
  const conn = await pool.getConnection();
  try {
    const where = ["status = 'queued'"];
    const args = [workerId];
    if (email) {
      where.push("email = ?");
      args.push(email);
    }
    if (respectPrefs && workerId) {
      where.push(`(email = ? OR EXISTS (
        SELECT 1 FROM audio_worker_prefs p
        WHERE p.worker_id = ? AND p.email = audio_jobs.email AND p.allowed = 1
      ))`);
      args.push(workerOwner, workerId);
    }
    const [r] = await conn.query(
      `UPDATE audio_jobs
       SET id = LAST_INSERT_ID(id), status = 'processing', claimed_by = ?, attempts = attempts + 1
       WHERE ${where.join(" AND ")}
       ORDER BY id ASC LIMIT 1`,
      args
    );
    if (!r.affectedRows) return null;
    const [rows] = await conn.query(
      `SELECT id, email, filename, stored_path, mime, size_bytes, created_at
       FROM audio_jobs WHERE id = LAST_INSERT_ID()`
    );
    return rows[0] || null;
  } finally {
    conn.release();
  }
}

// claim 済みジョブを厳格に照合して返す。取違防止のため、
//   1. ジョブが processing であること
//   2. ジョブを claim したワーカー（claimed_by）が指定の workerId と一致すること
//   3. その workerId のワーカーを認証済みアカウントが所有していること
//   4. 他ユーザーのジョブは（globalワーカーで claim した場合のみ発生）3の所有チェックで担保
// のすべてを満たすジョブだけを返す。workerId 無しの寛容パスは廃止した。
async function getClaimedAudioJob(email, id, workerId) {
  if (!workerId) return null;
  const [rows] = await pool.query(
    `SELECT j.id, j.email, j.filename, j.stored_path, j.mime, j.size_bytes, j.status, j.claimed_by
     FROM audio_jobs j
     JOIN audio_workers w ON w.id = j.claimed_by
     WHERE j.id = ? AND j.status = 'processing' AND j.claimed_by = ? AND w.email = ?
     LIMIT 1`,
    [Number(id), Number(workerId), email]
  );
  return rows[0] || null;
}

// 処理中ジョブのハートビート。ワーカーが3秒ごとのメトリクス送信に載せてくる
// activeJobId で updated_at を進め、requeueStaleAudioJobs による再キューを防ぐ。
// 自分が claim したジョブ以外は触れない。
async function touchAudioJob(id, workerId) {
  if (!Number.isInteger(Number(id)) || !workerId) return 0;
  const [r] = await pool.query(
    `UPDATE audio_jobs SET updated_at = NOW()
     WHERE id = ? AND status = 'processing' AND claimed_by = ?`,
    [Number(id), Number(workerId)]
  );
  return r.affectedRows;
}

async function finishAudioJob(id, { status, error = null, transcriptId = null }) {
  await pool.query(
    `UPDATE audio_jobs SET status = ?, error = ?, transcript_id = ? WHERE id = ?`,
    [status, error, transcriptId, id]
  );
}

// 処理失敗の記録。試行回数（attempts。claim ごとに +1 済み）が maxAttempts 未満なら
// queued に戻して即座に別のPCへ再割り振りし、上限に達したら error で保留する。
// どちらの場合も音声ファイルは消さない（成功時に finishJobWithText 側で削除する）。
// 戻り値は更新後の { status, attempts }（ジョブが見つからなければ null）。
async function failAudioJob(id, error, maxAttempts = 3) {
  const max = Math.max(Number(maxAttempts) || 3, 1);
  await pool.query(
    `UPDATE audio_jobs
     SET status = IF(attempts < ?, 'queued', 'error'), claimed_by = NULL, error = ?
     WHERE id = ? AND status = 'processing'`,
    [max, error, Number(id)]
  );
  const [rows] = await pool.query(
    `SELECT status, attempts FROM audio_jobs WHERE id = ? LIMIT 1`,
    [Number(id)]
  );
  return rows[0] || null;
}

// 手動再試行用にジョブ1件を所有者チェック付きで返す。
async function getAudioJob(email, id) {
  const [rows] = await pool.query(
    `SELECT id, email, filename, stored_path, status, attempts FROM audio_jobs
     WHERE id = ? AND email = ? LIMIT 1`,
    [Number(id), email]
  );
  return rows[0] || null;
}

// error で保留されたジョブをダッシュボードの「再試行」から待機列に戻す。
// attempts を 0 に戻すので、また上限回数まで自動再試行される。
async function retryAudioJob(email, id) {
  const [r] = await pool.query(
    `UPDATE audio_jobs SET status = 'queued', attempts = 0, claimed_by = NULL
     WHERE id = ? AND email = ? AND status = 'error'`,
    [Number(id), email]
  );
  return r.affectedRows;
}

// activeOnly=true のときは未処理（queued）・処理中（processing）・失敗（error）だけを返す
// （完了済みは文字起こし一覧側で見えるので、音声ジョブ一覧には出さない）。
async function listAudioJobs(email, { limit = 30, activeOnly = false } = {}) {
  const statusCond = activeOnly ? `AND j.status IN ('queued','processing','error')` : "";
  const [rows] = await pool.query(
    `SELECT j.id, j.filename, j.size_bytes, j.status, j.error, j.transcript_id, j.attempts,
            j.created_at, j.updated_at, j.claimed_by, w.name AS worker_name
     FROM audio_jobs j
     LEFT JOIN audio_workers w ON w.id = j.claimed_by
     WHERE j.email = ? ${statusCond} ORDER BY j.id DESC LIMIT ?`,
    [email, Number(limit) || 30]
  );
  return rows;
}

// processing のまま updated_at が staleMinutes 以上進んでいないジョブを queued に戻す
// （ワーカー停止・切断とみなして別のPCへ振り直す）。処理中のワーカーはハートビート
// （touchAudioJob）で updated_at を進め続けるので、正常処理中のジョブは奪われない。
// staleMinutes 省略時は無条件（サーバー再起動時の残骸掃除用）。
async function requeueStaleAudioJobs(staleMinutes = null) {
  const minutes = Number(staleMinutes);
  const [r] = Number.isFinite(minutes) && minutes > 0
    ? await pool.query(
      `UPDATE audio_jobs SET status = 'queued', claimed_by = NULL
       WHERE status = 'processing' AND updated_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
      [Math.floor(minutes)]
    )
    : await pool.query(
      `UPDATE audio_jobs SET status = 'queued', claimed_by = NULL WHERE status = 'processing'`
    );
  return r.affectedRows;
}

// =====================================================================
// 日次要約（daily_summaries）
// =====================================================================

async function saveDailySummary(email, day, summary) {
  await pool.query(
    `INSERT INTO daily_summaries (email, day, summary)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE summary = VALUES(summary), generated_at = CURRENT_TIMESTAMP`,
    [email, day, summary]
  );
}

async function getDailySummary(email, day) {
  const [rows] = await pool.query(
    `SELECT day, summary, generated_at FROM daily_summaries
     WHERE email = ? AND day = ? LIMIT 1`,
    [email, day]
  );
  return rows[0] || null;
}

async function listDailySummaries(email, limit = 30) {
  const [rows] = await pool.query(
    `SELECT day, summary, generated_at FROM daily_summaries
     WHERE email = ? ORDER BY day DESC LIMIT ?`,
    [email, limit]
  );
  return rows;
}

// =====================================================================
// 通知履歴（notifications）
// =====================================================================

async function recordNotification(email, taskId, kind, channel, message) {
  const [r] = await pool.query(
    `INSERT INTO notifications (email, task_id, kind, channel, message)
     VALUES (?, ?, ?, ?, ?)`,
    [email, taskId || null, kind, channel || "line", message]
  );
  return r.insertId;
}

// 端末アプリ向け: まだ ack されていない通知を取得（ローカル通知として表示するため）。
async function pendingNotifications(email, limit = 50) {
  const [rows] = await pool.query(
    `SELECT id, task_id, kind, message, created_at FROM notifications
     WHERE email = ? AND acked = 0
     ORDER BY created_at ASC LIMIT ?`,
    [email, limit]
  );
  return rows;
}

async function ackNotifications(email, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  await pool.query(
    `UPDATE notifications SET acked = 1 WHERE email = ? AND id IN (${placeholders})`,
    [email, ...ids]
  );
}

// 全アカウント横断で email の一覧を返す（スケジューラが回す対象）。
async function listEmailsWithTasks() {
  const [rows] = await pool.query(`SELECT DISTINCT email FROM tasks`);
  return rows.map((r) => r.email);
}

// =====================================================================
// ユーザー（自己登録アカウント）
// =====================================================================

async function createUser(email, salt, passwordHash, token) {
  await pool.query(
    `INSERT INTO users (email, salt, password_hash, token) VALUES (?, ?, ?, ?)`,
    [email, salt, passwordHash, token]
  );
}

async function getUserByEmail(email) {
  const [rows] = await pool.query(
    `SELECT email, salt, password_hash, token FROM users WHERE email = ? LIMIT 1`,
    [email]
  );
  return rows[0] || null;
}

async function getUserByToken(email, token) {
  const [rows] = await pool.query(
    `SELECT email, token FROM users WHERE email = ? AND token = ? LIMIT 1`,
    [email, token]
  );
  return rows[0] || null;
}

async function updateUserPassword(email, salt, passwordHash) {
  await pool.query(
    `UPDATE users SET salt = ?, password_hash = ? WHERE email = ?`,
    [salt, passwordHash, email]
  );
}

async function userExists(email) {
  const [rows] = await pool.query(`SELECT 1 FROM users WHERE email = ? LIMIT 1`, [email]);
  return rows.length > 0;
}

// 音声認識クオリティ。行がない（accounts.json 由来のアカウント等）場合は既定の 'high'。
async function setSttQuality(email, quality) {
  await pool.query(`UPDATE users SET stt_quality = ? WHERE email = ?`, [quality, email]);
}

async function getSttQuality(email) {
  const [rows] = await pool.query(
    `SELECT stt_quality FROM users WHERE email = ? LIMIT 1`, [email]
  );
  return (rows[0] && rows[0].stt_quality) || "high";
}

// Gemini 自動解析の on/off。行がない（accounts.json 由来のアカウント等）場合は既定で on。
async function setGeminiAuto(email, enabled) {
  const [r] = await pool.query(
    `UPDATE users SET gemini_auto = ? WHERE email = ?`,
    [enabled ? 1 : 0, email]
  );
  return r.affectedRows;
}

async function getGeminiAuto(email) {
  const [rows] = await pool.query(
    `SELECT gemini_auto FROM users WHERE email = ? LIMIT 1`, [email]
  );
  return rows[0] ? Boolean(rows[0].gemini_auto) : true;
}

// ユーザーごとの Gemini API キー（暗号化済み文字列を保存。暗号化/復号は呼び出し側）。
async function setGeminiKeyEnc(email, enc) {
  const [r] = await pool.query(
    `UPDATE users SET gemini_api_key_enc = ? WHERE email = ?`,
    [enc || null, email]
  );
  return r.affectedRows;
}

async function getGeminiKeyEnc(email) {
  const [rows] = await pool.query(
    `SELECT gemini_api_key_enc FROM users WHERE email = ? LIMIT 1`, [email]
  );
  return (rows[0] && rows[0].gemini_api_key_enc) || null;
}

async function setMoodleUrl(email, url) {
  await pool.query(`UPDATE users SET moodle_ical_url = ? WHERE email = ?`, [url || null, email]);
}

async function getMoodleUrl(email) {
  const [rows] = await pool.query(
    `SELECT moodle_ical_url FROM users WHERE email = ? LIMIT 1`, [email]
  );
  return rows[0] ? rows[0].moodle_ical_url : null;
}

async function saveDocument(email, name, mime, summary) {
  await pool.query(
    `INSERT INTO documents (email, name, mime, summary) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE mime = VALUES(mime), summary = VALUES(summary), updated_at = CURRENT_TIMESTAMP`,
    [email, name, mime || null, summary]
  );
}

async function listDocuments(email, limit = 100) {
  const [rows] = await pool.query(
    `SELECT id, name, mime, summary, updated_at FROM documents WHERE email = ? ORDER BY updated_at DESC LIMIT ?`,
    [email, limit]
  );
  return rows;
}

// 時間割をまるごと置き換える（科目登録は滅多に変わらないため全入れ替え）。
async function replaceCourses(email, courses) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(`DELETE FROM courses WHERE email = ?`, [email]);
    for (const c of courses || []) {
      const name = String(c.name || "").trim();
      if (!name) continue;
      await conn.query(
        `INSERT INTO courses (email, term, day, period, name, room, start_time, end_time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          email, c.term || null, c.day || null,
          c.period != null ? Number(c.period) : null,
          name.slice(0, 255), (c.room || null), (c.start_time || null), (c.end_time || null),
        ]
      );
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function listCourses(email) {
  const [rows] = await pool.query(
    `SELECT id, term, day, period, name, room, start_time, end_time
     FROM courses WHERE email = ?
     ORDER BY FIELD(day,'月','火','水','木','金','土','日'), period`,
    [email]
  );
  return rows;
}

// Moodle/Waseda の自動取り込みが稀に誤っていることがあるための手動修正。
// email を条件に含めて他アカウントの科目を操作できないようにする。
async function updateCourse(email, id, { term, day, period, name, room, start_time, end_time }) {
  const [result] = await pool.query(
    `UPDATE courses SET
       term = ?, day = ?, period = ?, name = ?, room = ?, start_time = ?, end_time = ?
     WHERE id = ? AND email = ?`,
    [
      term || null, day || null, period != null && period !== "" ? Number(period) : null,
      String(name || "").trim().slice(0, 255), room || null, start_time || null, end_time || null,
      id, email,
    ]
  );
  return result.affectedRows > 0;
}

async function deleteCourse(email, id) {
  const [result] = await pool.query(`DELETE FROM courses WHERE id = ? AND email = ?`, [id, email]);
  return result.affectedRows > 0;
}

// Waseda アカウント情報の保存・取得。password は暗号化済み文字列を渡す（暗号化は呼び出し側）。
async function setWasedaCreds(email, wasedaUser, passwordEnc) {
  await pool.query(
    `UPDATE users SET waseda_user = ?, waseda_password_enc = ? WHERE email = ?`,
    [wasedaUser || null, passwordEnc || null, email]
  );
}

async function getWasedaCreds(email) {
  const [rows] = await pool.query(
    `SELECT waseda_user, waseda_password_enc FROM users WHERE email = ? LIMIT 1`,
    [email]
  );
  return rows[0] || null;
}

async function setGoogleEmail(email, googleEmail) {
  await pool.query(`UPDATE users SET google_email = ? WHERE email = ?`, [googleEmail || null, email]);
}

// ---- Web(OAuth) で連携した Google アカウント（複数可） ----

async function upsertGoogleAccount(email, googleEmail, refreshTokenEnc) {
  await pool.query(
    `INSERT INTO google_accounts (email, google_email, refresh_token) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE refresh_token = VALUES(refresh_token)`,
    [email, googleEmail, refreshTokenEnc]
  );
}

async function listGoogleAccounts(email) {
  const [rows] = await pool.query(
    `SELECT google_email, refresh_token FROM google_accounts WHERE email = ? ORDER BY id`,
    [email]
  );
  return rows;
}

async function removeGoogleAccount(email, googleEmail) {
  await pool.query(
    `DELETE FROM google_accounts WHERE email = ? AND google_email = ?`,
    [email, googleEmail]
  );
}

async function replaceCalendarEvents(email, events) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query("DELETE FROM calendar_events WHERE email = ?", [email]);
    if (events && events.length) {
      const values = events.map(e => [
        email,
        e.title || "",
        e.whenText || e.start_at || "",
        e.startMillis || 0,
        e.location || null
      ]);
      await connection.query(
        "INSERT INTO calendar_events (email, title, start_at, start_millis, location) VALUES ?",
        [values]
      );
    }
    await connection.commit();
  } catch (e) {
    await connection.rollback();
    throw e;
  } finally {
    connection.release();
  }
}

async function listCalendarEvents(email) {
  const [rows] = await pool.query(
    "SELECT title, start_at as whenText, start_millis as startMillis, location FROM calendar_events WHERE email = ? ORDER BY start_millis ASC",
    [email]
  );
  return rows;
}

// =====================================================================
// チャット履歴（AIとの会話。ChatGPT のような継続した文脈維持に使う）
// =====================================================================

async function addChatMessage(email, role, content) {
  await pool.query(
    `INSERT INTO chat_messages (email, role, content) VALUES (?, ?, ?)`,
    [email, role, String(content || "").slice(0, 8000)]
  );
}

// 直近 limit 件を古い順で返す（プロンプトへの注入・画面表示の両方に使う）。
async function listRecentChatMessages(email, limit = 30) {
  const [rows] = await pool.query(
    `SELECT role, content, created_at FROM chat_messages
     WHERE email = ? ORDER BY id DESC LIMIT ?`,
    [email, limit]
  );
  return rows.reverse();
}

// Moodle URL を登録済みのユーザー一覧（定期同期用）。
async function listUsersWithMoodle() {
  const [rows] = await pool.query(
    `SELECT email, moodle_ical_url FROM users WHERE moodle_ical_url IS NOT NULL AND moodle_ical_url <> ''`
  );
  return rows;
}

module.exports = {
  pool,
  ensureSchema,
  replaceCalendarEvents,
  listCalendarEvents,
  // users
  createUser,
  getUserByEmail,
  getUserByToken,
  updateUserPassword,
  userExists,
  setMoodleUrl,
  getMoodleUrl,
  setSttQuality,
  getSttQuality,
  setGeminiKeyEnc,
  getGeminiKeyEnc,
  setGeminiAuto,
  getGeminiAuto,
  listUsersWithMoodle,
  setWasedaCreds,
  getWasedaCreds,
  setGoogleEmail,
  upsertGoogleAccount,
  listGoogleAccounts,
  removeGoogleAccount,
  replaceCourses,
  listCourses,
  updateCourse,
  deleteCourse,
  saveDocument,
  listDocuments,
  // transcripts
  saveTranscript,
  appendTranscript,
  saveAnalysis,
  getAnalysis,
  getTodaysAnalysisByEmail,
  listTranscriptsByEmail,
  getTranscriptForEmail,
  getTranscriptsForDay,
  listEmailsForDailySummary,
  searchTranscriptSnippets,
  listTranscriptIndex,
  getTranscriptsByFilenames,
  // chat
  addChatMessage,
  listRecentChatMessages,
  // tasks
  upsertTasks,
  cancelTasks,
  applyTaskUpdates,
  addTask,
  listUpcomingTasks,
  setTaskStatus,
  updateTask,
  deleteTask,
  findDueTasks,
  markNotified,
  // audio jobs
  registerAudioWorker,
  getAudioWorkerByUuid,
  listAudioWorkers,
  getAudioWorker,
  setAudioWorkerPref,
  setAudioWorkerMode,
  updateAudioWorkerMetrics,
  updateAudioWorker,
  deleteAudioWorker,
  createAudioJob,
  claimNextAudioJob,
  getClaimedAudioJob,
  touchAudioJob,
  finishAudioJob,
  failAudioJob,
  getAudioJob,
  retryAudioJob,
  listAudioJobs,
  requeueStaleAudioJobs,
  // summaries
  saveDailySummary,
  getDailySummary,
  listDailySummaries,
  // notifications
  recordNotification,
  pendingNotifications,
  ackNotifications,
  listEmailsWithTasks,
};
