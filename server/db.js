// MySQL 接続まわり。接続情報は環境変数で渡す。
const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "moneybot",
  waitForConnections: true,
  connectionLimit: 5,
  charset: "utf8mb4",
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
      analyzed_at DATETIME     NULL,
      created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_email_filename (email, filename)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  // 既存テーブルに後付けカラムを足す（MySQL は ADD COLUMN IF NOT EXISTS 非対応のため自前判定）。
  await addColumnIfMissing("kadai_json", "LONGTEXT NULL");
  await addColumnIfMissing("yotei_json", "LONGTEXT NULL");
  await addColumnIfMissing("analyzed_at", "DATETIME NULL");
}

async function addColumnIfMissing(column, definition) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'transcripts' AND column_name = ?`,
    [column]
  );
  if (rows[0].n === 0) {
    await pool.query(`ALTER TABLE transcripts ADD COLUMN ${column} ${definition}`);
  }
}

// テキストを保存（同じ email + filename は上書き）。再アップロード時は古い解析結果を消す。
// 保存した行の id を返す。
async function saveTranscript(email, filename, content) {
  await pool.query(
    `INSERT INTO transcripts (email, filename, content)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
       content = VALUES(content),
       kadai_json = NULL, yotei_json = NULL, analyzed_at = NULL,
       updated_at = CURRENT_TIMESTAMP`,
    [email, filename, content]
  );
  const [rows] = await pool.query(
    `SELECT id FROM transcripts WHERE email = ? AND filename = ? LIMIT 1`,
    [email, filename]
  );
  return rows[0] ? rows[0].id : null;
}

// Gemini の解析結果（課題・予定）を保存する。
async function saveAnalysis(id, kadai, yotei) {
  await pool.query(
    `UPDATE transcripts
     SET kadai_json = ?, yotei_json = ?, analyzed_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [JSON.stringify(kadai || []), JSON.stringify(yotei || []), id]
  );
}

// 解析結果（課題 or 予定）を取得。kind は "kadai" | "yotei"。
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

module.exports = {
  pool,
  ensureSchema,
  saveTranscript,
  saveAnalysis,
  getAnalysis,
  listTranscripts,
  getTranscript,
};
