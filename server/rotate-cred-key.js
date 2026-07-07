// 資格情報の暗号鍵ローテーション用スクリプト。
//
// 背景: 旧 .cred-key は git 履歴に残ってしまっているため「漏洩済み」とみなす。
// この鍵で暗号化された Waseda パスワードと Google refresh_token は、履歴を消しても
// 過去に clone した相手なら復号できる。そこで新しい鍵で全件を再暗号化し、旧鍵を無効化する。
//
// 使い方:
//   1) 新しい鍵を生成:   openssl rand -hex 32   → 出力を控える
//   2) 旧鍵を渡す:        CRED_ENC_KEY_OLD=<旧64桁hex>   （既存 .cred-key の中身）
//      新鍵を渡す:        CRED_ENC_KEY=<新64桁hex>
//   3) DB 接続情報(.env と同じ DB_*)を環境に用意して実行:
//        node rotate-cred-key.js            # 実際に書き換え
//        node rotate-cred-key.js --dry-run  # 変換可否だけ確認（書き込まない）
//   4) 完了後、サーバーには新鍵(CRED_ENC_KEY)だけを渡す。旧 .cred-key は破棄する。
//
// このスクリプトは server.js と同じ iv:tag:cipher(hex) 形式・AES-256-GCM を用いる。

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

(function loadDotEnv() {
  try {
    const envPath = path.join(__dirname, ".env");
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || line.trimStart().startsWith("#")) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch (_e) { /* .env は任意 */ }
})();

const mysql = require("mysql2/promise");

const DRY_RUN = process.argv.includes("--dry-run");

function keyFromHex(hex, label) {
  const s = String(hex || "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(s)) {
    throw new Error(`${label} が不正です（64桁の hex を指定してください）`);
  }
  return Buffer.from(s, "hex");
}

function decrypt(stored, key) {
  const [ivHex, tagHex, encHex] = String(stored || "").split(":");
  if (!ivHex || !tagHex || !encHex) throw new Error("暗号データの形式が不正です");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(encHex, "hex")), decipher.final()]).toString("utf8");
}

function encrypt(plain, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${enc.toString("hex")}`;
}

// 旧鍵で復号できたものだけ新鍵で再暗号化する。既に新鍵形式のもの（復号失敗）はスキップして数える。
function reencrypt(stored, oldKey, newKey, counters) {
  if (!stored) return null;
  let plain;
  try {
    plain = decrypt(stored, oldKey);
  } catch (_e) {
    counters.skipped += 1; // 旧鍵で解けない＝既に新鍵 or 壊れている
    return null;
  }
  counters.converted += 1;
  return encrypt(plain, newKey);
}

async function main() {
  const oldKey = keyFromHex(process.env.CRED_ENC_KEY_OLD, "CRED_ENC_KEY_OLD");
  const newKey = keyFromHex(process.env.CRED_ENC_KEY, "CRED_ENC_KEY");
  if (Buffer.compare(oldKey, newKey) === 0) {
    throw new Error("旧鍵と新鍵が同一です。新しい鍵を生成してください（openssl rand -hex 32）");
  }

  const pool = mysql.createPool({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "aihelper",
    connectionLimit: 3,
    charset: "utf8mb4",
  });

  const counters = { converted: 0, skipped: 0 };
  try {
    // 1) Waseda パスワード
    const [wrows] = await pool.query(
      "SELECT email, waseda_password_enc FROM users WHERE waseda_password_enc IS NOT NULL AND waseda_password_enc <> ''"
    );
    for (const r of wrows) {
      const next = reencrypt(r.waseda_password_enc, oldKey, newKey, counters);
      if (next && !DRY_RUN) {
        await pool.query("UPDATE users SET waseda_password_enc = ? WHERE email = ?", [next, r.email]);
      }
    }
    console.log(`Waseda: ${wrows.length} 件を確認`);

    // 2) Google refresh_token
    const [grows] = await pool.query(
      "SELECT id, refresh_token FROM google_accounts WHERE refresh_token IS NOT NULL AND refresh_token <> ''"
    );
    for (const r of grows) {
      const next = reencrypt(r.refresh_token, oldKey, newKey, counters);
      if (next && !DRY_RUN) {
        await pool.query("UPDATE google_accounts SET refresh_token = ? WHERE id = ?", [next, r.id]);
      }
    }
    console.log(`Google: ${grows.length} 件を確認`);

    console.log(
      `${DRY_RUN ? "[dry-run] " : ""}再暗号化: ${counters.converted} 件 / スキップ(旧鍵で解けず): ${counters.skipped} 件`
    );
    if (DRY_RUN) console.log("--dry-run のため DB は変更していません。");
    else console.log("完了。サーバーには新しい CRED_ENC_KEY だけを渡し、旧 .cred-key は破棄してください。");
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error("鍵ローテーションに失敗:", e.message);
  process.exit(1);
});
