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

  // Web から自己登録したユーザー（メール＋パスワード）。パスワードは sha256(salt+password) で保存。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      email         VARCHAR(255) NOT NULL,
      salt          CHAR(32)     NOT NULL,
      password_hash CHAR(64)     NOT NULL,
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
  // Moodle カレンダーの iCal 書き出し URL（ユーザーごと）。
  await addColumnIfMissing("users", "moodle_ical_url", "VARCHAR(1024) NULL");
  // 紐付けた Google アカウントのメール（端末でサインインしたもの）。
  await addColumnIfMissing("users", "google_email", "VARCHAR(255) NULL");
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

// =====================================================================
// 文字起こし（transcripts）
// =====================================================================

// テキストを保存（同じ email + filename は上書き）。再アップロード時は古い解析結果を消す。
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
async function getAnalysis(id, kind) {
  const column = kind === "yotei" ? "yotei_json" : "kadai_json";
  const [rows] = await pool.query(
    `SELECT filename, ${column} AS json FROM transcripts WHERE id = ? LIMIT 1`,
    [id]
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

// 一覧（中身は含めない。サイズと更新時刻、解析済みかだけ）。
async function listTranscripts() {
  const [rows] = await pool.query(
    `SELECT id, email, filename, CHAR_LENGTH(content) AS chars, updated_at, analyzed_at
     FROM transcripts
     ORDER BY updated_at DESC, id DESC`
  );
  return rows;
}

// 1 件を中身ごと取得。
async function getTranscript(id) {
  const [rows] = await pool.query(
    `SELECT id, email, filename, content FROM transcripts WHERE id = ? LIMIT 1`,
    [id]
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

// =====================================================================
// 課題・予定（tasks）
// =====================================================================

function dedupKey(email, type, content, deadlineAt) {
  return crypto
    .createHash("sha1")
    .update(`${email}|${type}|${content}|${deadlineAt || ""}`)
    .digest("hex");
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

async function setTaskStatus(id, status) {
  await pool.query(`UPDATE tasks SET status = ? WHERE id = ?`, [status, id]);
}

async function deleteTask(id) {
  await pool.query(`DELETE FROM tasks WHERE id = ?`, [id]);
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

async function setMoodleUrl(email, url) {
  await pool.query(`UPDATE users SET moodle_ical_url = ? WHERE email = ?`, [url || null, email]);
}

async function getMoodleUrl(email) {
  const [rows] = await pool.query(
    `SELECT moodle_ical_url FROM users WHERE email = ? LIMIT 1`, [email]
  );
  return rows[0] ? rows[0].moodle_ical_url : null;
}

async function setGoogleEmail(email, googleEmail) {
  await pool.query(`UPDATE users SET google_email = ? WHERE email = ?`, [googleEmail || null, email]);
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
  // users
  createUser,
  getUserByEmail,
  getUserByToken,
  updateUserPassword,
  userExists,
  setMoodleUrl,
  getMoodleUrl,
  listUsersWithMoodle,
  setGoogleEmail,
  // transcripts
  saveTranscript,
  saveAnalysis,
  getAnalysis,
  getTodaysAnalysisByEmail,
  listTranscripts,
  getTranscript,
  getTranscriptsForDay,
  // tasks
  upsertTasks,
  addTask,
  listUpcomingTasks,
  setTaskStatus,
  deleteTask,
  findDueTasks,
  markNotified,
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
