// AIHelper.jp 側の受信サーバー兼ウェブアプリ (Node.js + Express + MySQL)
//
// できること:
//  - 端末アプリから文字起こしテキストを受信し MySQL に保存
//  - Gemini で「課題」「予定」を抽出し、締切付きタスクとして正規化保存
//  - 締切の「1日前」「1時間前」に LINE で警告（+ 端末ローカル通知用に記録）
//  - その日の文字起こしから「今日の要約」を日付ごとに生成
//  - AIチャット: 「今日の予定は？」と聞けば回答、「予定入れといて」で登録まで実行
//  - ダッシュボード（ / ）で締切・要約・タスク・チャットを操作

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// .env があれば読み込む（既存の環境変数が優先。追加ライブラリは使わない）。
// db.js は require 時に process.env を読むので、必ず db を require する前に実行する。
(function loadDotEnv() {
  try {
    const envPath = path.join(__dirname, ".env");
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || line.trimStart().startsWith("#")) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
    console.log(".env を読み込みました");
  } catch (e) {
    console.error(".env の読み込みに失敗:", e.message);
  }
})();

const db = require("./db");
const { encryptCred, decryptCred } = require("./cred");
const gemini = require("./gemini");
const line = require("./line");
const summary = require("./summary");
const reminders = require("./reminders");
const moodle = require("./moodle");
const audio = require("./audio");
const google = require("./google");

const PORT = process.env.PORT || 3000;
const ACCOUNTS_FILE = path.join(__dirname, "accounts.json");
// 日次サマリの送信時刻（サーバーのローカル時刻）。"HH:MM" 形式。既定 21:00。
const SUMMARY_TIME = process.env.DAILY_SUMMARY_TIME || "21:00";
const SUMMARY_PREGENERATE_LEAD_MIN = Number(process.env.DAILY_SUMMARY_PREGENERATE_LEAD_MIN || 15);

const app = express();

app.set("trust proxy", process.env.TRUST_PROXY === "1");

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (req.secure || req.headers["x-forwarded-proto"] === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
  next();
});

function rateLimit({ windowMs, max, keyPrefix, keyOf }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, value] of hits) {
      if (value.resetAt <= now) hits.delete(key);
    }
  }, Math.max(windowMs, 60_000)).unref();
  return (req, res, next) => {
    const now = Date.now();
    const rawKey = keyOf ? keyOf(req) : (req.ip || req.socket.remoteAddress || "unknown");
    const key = `${keyPrefix}:${rawKey || "unknown"}`;
    const current = hits.get(key);
    if (!current || current.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    current.count += 1;
    if (current.count > max) {
      res.setHeader("Retry-After", String(Math.ceil((current.resetAt - now) / 1000)));
      return res.status(429).json({ ok: false, error: "リクエストが多すぎます。少し待ってから再試行してください" });
    }
    next();
  };
}

const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 20,
  keyPrefix: "auth",
  keyOf: (req) => `${req.ip || req.socket.remoteAddress || ""}:${String(req.body?.email || "").toLowerCase()}`,
});
const heavyLimiter = rateLimit({
  windowMs: 60 * 60_000,
  max: 30,
  keyPrefix: "heavy",
  keyOf: (req) => String(req.get("X-Account-Email") || req.body?.email || req.ip || req.socket.remoteAddress || ""),
});

app.use(express.json({ limit: "10mb" }));
app.use(express.text({ type: "text/plain", limit: "10mb" }));
// 資料アップロード（PDF 等）はバイナリで受ける。
app.use(express.raw({ type: ["application/pdf", "application/octet-stream"], limit: "25mb" }));
// 音声アップロード（1時間の WAV で 100MB を超えるため上限を大きく取る）。
app.use(express.raw({ type: ["audio/*"], limit: "300mb" }));

// accounts.json はリクエストのたびに読み直す（編集してすぐ反映できるように）。
function loadAccounts() {
  try {
    return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return [];
    console.error("accounts.json の読み込みに失敗:", e.message);
    return [];
  }
}

// ---- 自己登録ユーザー（MySQL 保存・scrypt ハッシュ） ----
// 既存の sha256(salt + password) 形式はログイン時だけ互換検証し、成功時に scrypt へ移行する。
function sha256(salt, password) {
  return crypto.createHash("sha256").update(salt + String(password)).digest("hex");
}
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const n = 16384;
  const r = 8;
  const p = 1;
  const derived = crypto.scryptSync(String(password), salt, 64, { N: n, r, p }).toString("hex");
  return { salt, hash: `scrypt$${n}$${r}$${p}$${salt}$${derived}` };
}
function timingSafeHexEqual(a, b) {
  if (!/^[0-9a-f]+$/i.test(a || "") || !/^[0-9a-f]+$/i.test(b || "")) return false;
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
function verifyPassword(user, password) {
  const stored = String(user?.password_hash || "");
  if (stored.startsWith("scrypt$")) {
    const [, n, r, p, salt, expected] = stored.split("$");
    if (!n || !r || !p || !salt || !expected) return { ok: false, legacy: false };
    const actual = crypto.scryptSync(String(password), salt, 64, {
      N: Number(n), r: Number(r), p: Number(p),
    }).toString("hex");
    return { ok: timingSafeHexEqual(actual, expected), legacy: false };
  }
  return { ok: stored === sha256(user.salt, password), legacy: true };
}
function genSalt() {
  return crypto.randomBytes(16).toString("hex"); // 32 hex chars
}
function genToken() {
  return crypto.randomBytes(24).toString("hex"); // 48 hex chars
}

// Waseda パスワード等の可逆暗号化（AES-256-GCM）は cred.js に切り出した
// （gemini.js がユーザーごとの API キーを復号するのにも使うため）。

// email + token を accounts.json → DB の順で照合し、アカウント相当を返す（非同期）。
async function resolveAccount(email, token) {
  if (!email || !token) return null;
  const acc = loadAccounts().find((a) => a.email === email && a.token === token);
  if (acc) return acc;
  const u = await db.getUserByToken(email, token);
  return u ? { email: u.email, token: u.token, lineUserId: "" } : null;
}

// email から LINE の送信先 userId を引く（リマインドエンジンが使う）。
function resolveLineTarget(email) {
  const a = loadAccounts().find((x) => x.email === email);
  return a ? a.lineUserId || "" : "";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// 例外の詳細（DB エラー・スタック・内部パス等）はクライアントへ返さない。
// サーバーログには全文を残し、レスポンスには汎用メッセージだけを載せる。
function serverErr(e, context) {
  console.error(context ? `サーバーエラー(${context}):` : "サーバーエラー:", e?.message || e);
  return "サーバー内部でエラーが発生しました";
}

// 登録後に Gemini API キーが失効した場合（Google 側で削除等）は、汎用エラーではなく
// 再登録への導線を返す。該当すれば true（レスポンス送信済み）。
function handleBadGeminiKey(res, e) {
  if (!String(e?.message || "").includes("API key not valid")) return false;
  res.status(400).json({
    ok: false,
    error: "登録されている Gemini APIキーが無効になっています。「アカウント」タブで登録し直してください",
  });
  return true;
}

// ---- ログイン試行のレート制限（総当たり対策） ----
// パスワードは sha256 保存とはいえ、試行回数に制限が無いと弱いパスワードを
// オンラインで総当たりされうる。IP ごとに直近の失敗回数を数え、一定回数を超えたら
// 短時間ロックする（メモリ管理。サーバー再起動でリセットされるが実害は小さい）。
const LOGIN_MAX_FAILS = Number(process.env.LOGIN_MAX_FAILS || 10);
const LOGIN_LOCK_MS = Number(process.env.LOGIN_LOCK_SEC || 900) * 1000; // 既定15分
const loginAttempts = new Map(); // key -> { fails, firstAt, lockedUntil }

function loginRateKey(req) {
  // プロキシ配下では X-Forwarded-For の先頭が実 IP。無ければ接続元。
  const fwd = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return fwd || req.socket?.remoteAddress || "unknown";
}

// true を返したらブロック（レスポンスは呼び出し側で返す）。
function isLoginBlocked(req) {
  const rec = loginAttempts.get(loginRateKey(req));
  return Boolean(rec && rec.lockedUntil && rec.lockedUntil > Date.now());
}

function recordLoginFailure(req) {
  const key = loginRateKey(req);
  const now = Date.now();
  const rec = loginAttempts.get(key) || { fails: 0, firstAt: now, lockedUntil: 0 };
  // 前回ロックが切れていれば数え直す。
  if (rec.lockedUntil && rec.lockedUntil <= now) {
    rec.fails = 0;
    rec.firstAt = now;
    rec.lockedUntil = 0;
  }
  rec.fails += 1;
  if (rec.fails >= LOGIN_MAX_FAILS) rec.lockedUntil = now + LOGIN_LOCK_MS;
  loginAttempts.set(key, rec);
  // 溜まった古いレコードを掃除。
  if (loginAttempts.size > 5000) {
    for (const [k, v] of loginAttempts) {
      if ((v.lockedUntil || v.firstAt) < now - LOGIN_LOCK_MS) loginAttempts.delete(k);
    }
  }
}

function recordLoginSuccess(req) {
  loginAttempts.delete(loginRateKey(req));
}

// API 用の認証ヘルパ。ヘッダ（推奨）または互換用 JSON body から email+token を取り、照合する（非同期）。
async function authFromReq(req) {
  const email = req.get("X-Account-Email") || req.body?.email || "";
  const token =
    (req.get("Authorization") || "").replace(/^Bearer\s+/i, "") ||
    req.body?.token ||
    "";
  return resolveAccount(email, token);
}

// =====================================================================
// 認証・アップロード
// =====================================================================

// 新規ユーザー登録（Web 用）。メール＋パスワードで登録し、API 用トークンを発行する。
app.post("/api/register", authLimiter, async (req, res) => {
  const email = String(req.body?.email || "").trim();
  const password = String(req.body?.password || "");
  if (!email || !password) {
    return res.status(400).json({ ok: false, error: "メールとパスワードを入力してください" });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: "メールアドレスの形式が不正です" });
  }
  if (password.length < 6) {
    return res.status(400).json({ ok: false, error: "パスワードは6文字以上にしてください" });
  }
  // 既存（accounts.json / DB users）と重複しないこと。
  try {
    if (loadAccounts().some((a) => a.email === email) || (await db.userExists(email))) {
      return res.status(409).json({ ok: false, error: "このメールは既に登録されています" });
    }
    const { salt, hash: passwordHash } = hashPassword(password);
    const token = genToken();
    await db.createUser(email, salt, passwordHash, token);
    console.log(`ユーザー登録: ${email}`);
    res.json({ ok: true, email, token });
  } catch (e) {
    console.error("ユーザー登録に失敗:", e.message);
    res.status(500).json({ ok: false, error: "登録の保存に失敗しました" });
  }
});

// ログイン。Web はメール＋パスワード、アプリはメール＋トークンで照合する。
// いずれも成功時は API 用トークンを返す（Web はこれを保存して以降の API に使う）。
app.post("/api/login", authLimiter, async (req, res) => {
  const { email, token, password } = req.body || {};
  if (isLoginBlocked(req)) {
    return res.status(429).json({
      ok: false,
      error: "ログイン試行が多すぎます。しばらく待ってから再度お試しください",
    });
  }
  try {
    let account = null;
    if (password) {
      const u = await db.getUserByEmail(email);
      const verified = u ? verifyPassword(u, password) : { ok: false };
      if (u && verified.ok) {
        if (verified.legacy) {
          const next = hashPassword(password);
          await db.updateUserPassword(u.email, next.salt, next.hash);
        }
        account = { email: u.email, token: u.token, lineUserId: "" };
      }
    } else {
      account = await resolveAccount(email, token);
    }
    if (!account) {
      recordLoginFailure(req);
      return res.status(401).json({ ok: false, error: "アカウント情報が一致しません" });
    }
    recordLoginSuccess(req);
    res.json({ ok: true, email: account.email, token: account.token, line: Boolean(account.lineUserId) });
  } catch (e) {
    console.error("ログイン処理に失敗:", e.message);
    res.status(500).json({ ok: false, error: "サーバーエラー" });
  }
});

// パスワード変更（自己登録ユーザーのみ）。現在のパスワードで本人確認する。トークンは変えない。
app.post("/api/change-password", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  const currentPassword = String(req.body?.currentPassword || "");
  const newPassword = String(req.body?.newPassword || "");
  if (newPassword.length < 6) {
    return res.status(400).json({ ok: false, error: "新しいパスワードは6文字以上にしてください" });
  }
  try {
    const u = await db.getUserByEmail(account.email);
    if (!u) {
      return res.status(400).json({ ok: false, error: "このアカウントはパスワード変更に対応していません" });
    }
    if (!verifyPassword(u, currentPassword).ok) {
      return res.status(401).json({ ok: false, error: "現在のパスワードが違います" });
    }
    const next = hashPassword(newPassword);
    await db.updateUserPassword(account.email, next.salt, next.hash);
    res.json({ ok: true });
  } catch (e) {
    console.error("パスワード変更に失敗:", e.message);
    res.status(500).json({ ok: false, error: "保存に失敗しました" });
  }
});

// 履修時間割の取得・登録（スクレイパやアプリから）。滅多に変わらないので全入れ替え。
app.get("/api/courses", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  try {
    res.json({ ok: true, courses: await db.listCourses(account.email) });
  } catch (e) {
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

app.post("/api/courses", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  const courses = Array.isArray(req.body?.courses) ? req.body.courses : null;
  if (!courses) return res.status(400).json({ ok: false, error: "courses 配列が必要です" });
  try {
    await db.replaceCourses(account.email, courses);
    res.json({ ok: true, count: courses.length });
  } catch (e) {
    console.error("時間割の保存に失敗:", e.message);
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

// Moodle/Waseda の自動取り込みが稀に誤っていることがあるための手動修正（曜日変更・編集・削除）。
// 注意: 時間割の再取り込み（/api/courses の全置き換え）を行うと、この手動修正は失われる。
app.patch("/api/courses/:id", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  const { term, day, period, name, room, start_time, end_time } = req.body || {};
  if (!String(name || "").trim()) return res.status(400).json({ ok: false, error: "科目名が必要です" });
  try {
    const ok = await db.updateCourse(account.email, req.params.id, { term, day, period, name, room, start_time, end_time });
    if (!ok) return res.status(404).json({ ok: false, error: "科目が見つかりません" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

app.delete("/api/courses/:id", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  try {
    const ok = await db.deleteCourse(account.email, req.params.id);
    if (!ok) return res.status(404).json({ ok: false, error: "科目が見つかりません" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

// 資料ファイル（PDF/TXT）を受け取り、その場で Gemini 要約して DB に保存する。
// Content-Type が text/plain ならテキスト、application/pdf 等ならバイナリで受ける。
app.post("/api/files", heavyLimiter, async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  if (!(await gemini.isConfiguredFor(account.email))) {
    return res.status(503).json({ ok: false, error: gemini.NO_KEY_MESSAGE });
  }
  const rawName = req.get("X-Filename") || `document-${Date.now()}`;
  const name = path.basename(rawName).slice(0, 500);
  const ctype = (req.get("Content-Type") || "").toLowerCase();
  try {
    let summary;
    if (ctype.startsWith("text/plain")) {
      const text = typeof req.body === "string" ? req.body : "";
      if (!text.trim()) return res.status(400).json({ ok: false, error: "本文が空です" });
      summary = await gemini.summarizeDocument(account.email, { name, mimeType: "text/plain", text });
    } else if (Buffer.isBuffer(req.body) && req.body.length > 0) {
      // PDF はそのまま Gemini に渡す（inlineData）。
      const mimeType = ctype.startsWith("application/pdf") ? "application/pdf" : "application/pdf";
      summary = await gemini.summarizeDocument(account.email, {
        name, mimeType, base64: req.body.toString("base64"),
      });
    } else {
      return res.status(400).json({ ok: false, error: "ファイル本文がありません（PDF か .txt を送ってください）" });
    }
    await db.saveDocument(account.email, name, ctype, summary);
    console.log(`資料要約: ${account.email} -> ${name}`);
    res.json({ ok: true, name, summary });
  } catch (e) {
    console.error("資料要約に失敗:", e.message);
    if (handleBadGeminiKey(res, e)) return;
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

app.get("/api/files", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  try {
    const docs = await db.listDocuments(account.email, 100);
    res.json({ ok: true, documents: docs });
  } catch (e) {
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

// Google アカウントの紐付け（端末でサインインした Google メールをアカウントに記録）。
app.post("/api/google-link", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  const googleEmail = String(req.body?.googleEmail || "").trim();
  try {
    await db.setGoogleEmail(account.email, googleEmail);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

// スマホのローカルカレンダーから取得した予定を同期（保存）する。
app.post("/api/calendar/sync", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  const events = Array.isArray(req.body?.events) ? req.body.events : [];
  try {
    await db.replaceCalendarEvents(account.email, events);
    res.json({ ok: true, count: events.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});


// ---- Google 連携（Web OAuth: PC ブラウザから複数アカウントを連携） ----

// OAuth の state → どのユーザーの連携要求か（CSRF 対策。10分で失効）。
const googleOAuthStates = new Map();

// OAuth の redirect_uri。原則は環境変数 GOOGLE_REDIRECT_URL を明示指定する。
// 未指定時のみ Host ヘッダから組み立てるが、Host ヘッダ汚染を防ぐため許可ホスト
// （GOOGLE_ALLOWED_HOSTS のカンマ区切り、なければリクエストの Host）に限定し、本番では https を強制する。
function googleRedirectUri(req) {
  if (process.env.GOOGLE_REDIRECT_URL) return process.env.GOOGLE_REDIRECT_URL;
  const host = req.get("host") || "";
  const allow = String(process.env.GOOGLE_ALLOWED_HOSTS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (allow.length && !allow.includes(host)) {
    throw new Error("この Host からの Google 連携は許可されていません（GOOGLE_REDIRECT_URL を設定してください）");
  }
  const isProd = process.env.NODE_ENV === "production";
  const proto = isProd
    ? "https"
    : (req.headers["x-forwarded-proto"] || req.protocol || "http");
  return `${proto}://${host}/api/google/callback`;
}

// 同意画面の URL を返す。ブラウザ側はこの URL へ遷移する。
app.get("/api/google/auth-url", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  if (!google.isConfigured()) {
    return res.status(503).json({
      ok: false,
      error: "Google 連携が未設定です（GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET）",
    });
  }
  const state = crypto.randomBytes(24).toString("hex");
  let redirectUri;
  try {
    redirectUri = googleRedirectUri(req);
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
  googleOAuthStates.set(state, { email: account.email, redirectUri, expires: Date.now() + 10 * 60_000 });
  // 溜まった期限切れ state を掃除。
  for (const [k, v] of googleOAuthStates) if (v.expires < Date.now()) googleOAuthStates.delete(k);
  res.json({ ok: true, url: google.authUrl(redirectUri, state) });
});

// Google からのリダイレクト先。code を refresh_token に交換して保存し、画面へ戻す。
app.get("/api/google/callback", async (req, res) => {
  const back = (q) => res.redirect(`/?google=${q}#account`);
  try {
    const pending = googleOAuthStates.get(String(req.query.state || ""));
    if (!pending || pending.expires < Date.now()) return back("expired");
    googleOAuthStates.delete(String(req.query.state));
    if (!req.query.code) return back("denied");
    const { googleEmail, refreshToken } = await google.exchangeCode(String(req.query.code), pending.redirectUri);
    if (!refreshToken) return back("error");
    await db.upsertGoogleAccount(pending.email, googleEmail, encryptCred(refreshToken));
    console.log(`Google 連携(Web): ${pending.email} <- ${googleEmail}`);
    back("linked");
  } catch (e) {
    console.error("Google 連携(Web)に失敗:", e.message);
    back("error");
  }
});

// 連携中の Google アカウント一覧。
app.get("/api/google/accounts", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  try {
    const rows = await db.listGoogleAccounts(account.email);
    res.json({ ok: true, configured: google.isConfigured(), accounts: rows.map((r) => r.google_email) });
  } catch (e) {
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

// 指定した Google アカウントの連携を解除。
app.post("/api/google/unlink", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  try {
    await db.removeGoogleAccount(account.email, String(req.body?.googleEmail || ""));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

// 連携中の全アカウントから直近の予定を取得して開始時刻順に返す。
app.get("/api/google/events", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  try {
    const rows = await db.listGoogleAccounts(account.email);
    const events = [];
    const errors = [];
    for (const r of rows) {
      try {
        const token = await google.accessTokenOf(decryptCred(r.refresh_token));
        const list = await google.listUpcomingEvents(token);
        events.push(...list.map((ev) => ({ ...ev, accountEmail: r.google_email })));
      } catch (e) {
        errors.push(`${r.google_email}: ${e.message}`);
      }
    }

    // スマホから同期されたカレンダー予定もマージする
    try {
      const localEvents = await db.listCalendarEvents(account.email);
      for (const ev of localEvents) {
        const exists = events.some(
          (x) => x.title === ev.title && Math.abs((x.startMillis || 0) - ev.startMillis) < 60000
        );
        if (!exists) {
          events.push({
            title: ev.title,
            whenText: ev.whenText,
            startMillis: ev.startMillis,
            location: ev.location || "",
            accountEmail: "スマホ同期",
          });
        }
      }
    } catch (le) {
      console.error("ローカル同期カレンダー取得失敗:", le.message);
    }

    events.sort((a, b) => a.startMillis - b.startMillis);
    res.json({ ok: true, events, error: errors.join(" / ") || undefined });
  } catch (e) {
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

// 課題・予定の締切を指定アカウントの Google カレンダーに登録する。
app.post("/api/google/add-event", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  const googleEmail = String(req.body?.googleEmail || "").trim();
  const content = String(req.body?.content || "").trim();
  if (!content) return res.status(400).json({ ok: false, error: "内容が空です" });
  try {
    const rows = await db.listGoogleAccounts(account.email);
    const row = rows.find((r) => r.google_email === googleEmail) || rows[0];
    if (!row) return res.status(400).json({ ok: false, error: "Google アカウントが未連携です" });
    const token = await google.accessTokenOf(decryptCred(row.refresh_token));
    await google.insertDeadline(token, content, String(req.body?.deadline || ""), Boolean(req.body?.dateOnly));
  } catch (e) {
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

// 時間割を指定アカウントの Google カレンダーに毎週繰り返しで一括登録する。
app.post("/api/google/sync-courses", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  const googleEmail = String(req.body?.googleEmail || "").trim();
  try {
    const rows = await db.listGoogleAccounts(account.email);
    const row = rows.find((r) => r.google_email === googleEmail) || rows[0];
    if (!row) return res.status(400).json({ ok: false, error: "Google アカウントが未連携です" });

    const courses = await db.listCourses(account.email);
    if (!courses.length) {
      return res.status(400).json({ ok: false, error: "時間割が空のため同期できません" });
    }

    const token = await google.accessTokenOf(decryptCred(row.refresh_token));

    // 早稲田大学の公式時間割（100分授業）。1限〜6限＋夜間の7限。
    const periods = {
      1: { start: "08:50:00", end: "10:30:00" },
      2: { start: "10:40:00", end: "12:20:00" },
      3: { start: "13:10:00", end: "14:50:00" },
      4: { start: "15:05:00", end: "16:45:00" },
      5: { start: "17:00:00", end: "18:40:00" },
      6: { start: "18:55:00", end: "20:35:00" },
      7: { start: "20:45:00", end: "22:25:00" },
    };

    const daysMap = { "日": 0, "月": 1, "火": 2, "水": 3, "木": 4, "金": 5, "土": 6 };

    // 学期終了日（UNTILルール）の決定
    const now = new Date();
    const month = now.getMonth() + 1; // 1-indexed
    const isSpring = month >= 4 && month <= 9;
    const year = now.getFullYear();
    const untilStr = isSpring ? `${year}0731T235959Z` : `${year + (month <= 3 ? 0 : 1)}0131T235959Z`;

    let successCount = 0;
    let skippedCount = 0;
    for (const c of courses) {
      const dayNum = daysMap[c.day];
      if (dayNum === undefined) continue; // 曜日が「無」等はカレンダー登録不可のためスキップ

      let startTime = "";
      let endTime = "";
      if (c.start_time && c.end_time) {
        const startP = periods[c.start_time];
        const endP = periods[c.end_time];
        if (startP && endP) {
          startTime = startP.start;
          endTime = endP.end;
        }
      } else if (c.period) {
        const p = periods[c.period];
        if (p) {
          startTime = p.start;
          endTime = p.end;
        }
      }

      if (!startTime || !endTime) continue;

      // 次の該当曜日の日付を計算して開始日とする
      const startDt = new Date();
      const currentDay = startDt.getDay();
      let diff = dayNum - currentDay;
      if (diff <= 0) diff += 7; // 今日より後（来週のその曜日）
      startDt.setDate(startDt.getDate() + diff);

      // YYYY-MM-DD フォーマット（サーバーのローカル日付ベース）
      const pad = (n) => String(n).padStart(2, "0");
      const ymd = `${startDt.getFullYear()}-${pad(startDt.getMonth() + 1)}-${pad(startDt.getDate())}`;

      const startIso = `${ymd}T${startTime}`;
      const endIso = `${ymd}T${endTime}`;

      const summary = c.name;
      const location = c.room || "";
      const recurrence = [`RRULE:FREQ=WEEKLY;UNTIL=${untilStr}`];

      // 科目を識別するキーをイベントに埋め込み、再同期しても二重登録しない。
      const courseKey = crypto.createHash("sha1")
        .update([untilStr, c.term || "", c.day || "", c.period || "", c.start_time || "", c.end_time || "", c.name].join("|"))
        .digest("hex");
      const existing = await google.findEventsByPrivateKey(token, "aihelperCourse", courseKey);
      if (existing.length) { skippedCount++; continue; }

      await google.insertRecurringEvent(
        token, summary, location, startIso, endIso, recurrence, { aihelperCourse: courseKey }
      );
      successCount++;
    }

    res.json({ ok: true, count: successCount, skipped: skippedCount, googleEmail: row.google_email });
  } catch (e) {
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});


// Moodle 連携: iCal 書き出し URL の取得・保存・即時同期（自己登録ユーザーのみ）。
app.get("/api/moodle", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  try {
    const url = await db.getMoodleUrl(account.email);
    res.json({ ok: true, url: url || "" });
  } catch (e) {
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

// 音声認識クオリティの取得・変更。
// 将来はプラン（課金）で選択肢を制限する想定だが、現時点では課金要素はなく全員が自由に選べる。
const STT_QUALITIES = ["light", "standard", "high"];

app.get("/api/stt-quality", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  try {
    const quality = await db.getSttQuality(account.email);
    res.json({ ok: true, quality, choices: STT_QUALITIES });
  } catch (e) {
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

app.post("/api/stt-quality", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  const quality = String(req.body?.quality || "").trim();
  if (!STT_QUALITIES.includes(quality)) {
    return res.status(400).json({ ok: false, error: "quality は light/standard/high のいずれかを指定してください" });
  }
  try {
    await db.setSttQuality(account.email, quality);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

// ---- ユーザーごとの Gemini API キー ----
// サーバー共通の GEMINI_API_KEY(.env) は廃止。各ユーザーが Google AI Studio で
// 発行した自分のキーを登録し、AI機能（チャット/解析/要約）はそのキーで動く。
// キーは AES-256-GCM で暗号化して users.gemini_api_key_enc に保存し、
// GET では本体を返さず「登録済みかどうか」と末尾4文字だけ返す。

app.get("/api/gemini-key", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  try {
    const enc = await db.getGeminiKeyEnc(account.email);
    let tail = "";
    if (enc) {
      try {
        tail = decryptCred(enc).slice(-4);
      } catch (_e) { /* 鍵ローテーション直後など。登録済み扱いのまま伏せる */ }
    }
    res.json({ ok: true, hasKey: Boolean(enc), tail, model: gemini.MODEL });
  } catch (e) {
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

app.post("/api/gemini-key", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  const apiKey = String(req.body?.apiKey || "").trim();
  if (!apiKey || apiKey.length > 200 || /[^\x21-\x7E]/.test(apiKey)) {
    return res.status(400).json({ ok: false, error: "APIキーの形式が不正です" });
  }
  try {
    // 登録前に Gemini へ疎通確認し、無効なキーは保存しない。
    const check = await gemini.verifyApiKey(apiKey);
    if (!check.ok) {
      return res.status(400).json({ ok: false, error: `APIキーの確認に失敗しました: ${check.error}` });
    }
    const n = await db.setGeminiKeyEnc(account.email, encryptCred(apiKey));
    if (!n) {
      // accounts.json 由来のアカウントは users 行が無く保存できない。
      return res.status(400).json({ ok: false, error: "このアカウントにはAPIキーを保存できません（Web登録のアカウントでログインしてください）" });
    }
    console.log(`Gemini APIキーを登録: ${account.email}`);
    res.json({ ok: true, tail: apiKey.slice(-4) });
  } catch (e) {
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

app.delete("/api/gemini-key", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  try {
    await db.setGeminiKeyEnc(account.email, null);
    console.log(`Gemini APIキーを削除: ${account.email}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

app.post("/api/moodle", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  const url = String(req.body?.url || "").trim();
  if (url && !/^https:\/\//i.test(url)) {
    return res.status(400).json({ ok: false, error: "https の URL を入力してください" });
  }
  try {
    await db.setMoodleUrl(account.email, url);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

// Waseda アカウント連携: 各ユーザーが自分の Waseda ID・パスワードを保存する。
// GET はパスワード本体を返さず「保存済みかどうか」だけ返す。
app.get("/api/waseda", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  try {
    const row = await db.getWasedaCreds(account.email);
    res.json({
      ok: true,
      wasedaUser: row?.waseda_user || "",
      hasPassword: Boolean(row?.waseda_password_enc),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

app.post("/api/waseda", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  const wasedaUser = String(req.body?.wasedaUser || "").trim();
  const wasedaPassword = String(req.body?.wasedaPassword || "");
  try {
    if (!wasedaUser) {
      // 空で保存＝連携解除。
      await db.setWasedaCreds(account.email, null, null);
      return res.json({ ok: true, cleared: true });
    }
    if (!wasedaPassword) {
      // ID のみ更新（パスワードは既存を維持）。
      const row = await db.getWasedaCreds(account.email);
      await db.setWasedaCreds(account.email, wasedaUser, row?.waseda_password_enc || null);
    } else {
      await db.setWasedaCreds(account.email, wasedaUser, encryptCred(wasedaPassword));
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("Waseda アカウント保存に失敗:", e.message);
    res.status(500).json({ ok: false, error: "保存に失敗しました" });
  }
});

// ---- Waseda 時間割の取り込み（スクレイパをサーバー側で実行） ----
// Selenium でのログイン〜取得は数分かかるため非同期ジョブとして走らせ、状況をポーリングで返す。
// 状態はメモリ管理（サーバー再起動で消えるが、取り込みは冪等なので再実行すればよい）。
const wasedaSyncJobs = new Map(); // email -> { state:'running'|'done'|'error', message, log, startedAt }

app.post("/api/waseda/sync", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  const current = wasedaSyncJobs.get(account.email);
  if (current?.state === "running") {
    return res.status(409).json({ ok: false, error: "すでに取り込み実行中です" });
  }
  try {
    const row = await db.getWasedaCreds(account.email);
    if (!row?.waseda_user || !row?.waseda_password_enc) {
      return res.status(400).json({ ok: false, error: "先に Waseda アカウントを保存してください" });
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: serverErr(e) });
  }
  const job = { state: "running", message: "時間割を取得しています…", log: "", startedAt: Date.now() };
  wasedaSyncJobs.set(account.email, job);
  runWasedaScraper(account, job);
  res.json({ ok: true, started: true });
});

app.get("/api/waseda/sync/status", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  const job = wasedaSyncJobs.get(account.email);
  if (!job) return res.json({ ok: true, state: "idle", message: "", log: "" });
  res.json({ ok: true, state: job.state, message: job.message, log: job.log || "" });
});

// スクレイパを子プロセスで実行する。資格情報はスクレイパ自身が /api/waseda/credentials から取る。
function runWasedaScraper(account, job) {
  const { spawn } = require("child_process");
  const scriptDir = path.join(__dirname, "scraper");
  // 依存(bs4/selenium)は venv に入れる想定（make python-deps）。あれば venv の python を使う。
  const venvPython = path.join(scriptDir, ".venv", "bin", "python3");
  const pythonBin = process.env.PYTHON_BIN || (fs.existsSync(venvPython) ? venvPython : "python3");
  const child = spawn(pythonBin, ["waseda_scraper.py"], {
    cwd: scriptDir,
    env: {
      ...process.env,
      AIHELPER_URL: `http://localhost:${PORT}`,
      AIHELPER_EMAIL: account.email,
      AIHELPER_TOKEN: account.token,
    },
  });
  const append = (chunk) => {
    job.log = (job.log + chunk.toString()).slice(-20000);
    // スクレイパの進捗表示（「ログイン中…」等）をそのままステータスに反映する。
    const lines = job.log.trim().split("\n").filter((l) => l.trim());
    if (lines.length) job.message = lines[lines.length - 1].slice(0, 200);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("error", (e) => {
    job.state = "error";
    job.message = `スクレイパを起動できません: ${e.message}（サーバーに python3 と selenium が必要です）`;
  });
  child.on("close", (code) => {
    if (job.state === "error") return;
    if (code === 0) {
      const m = job.log.match(/抽出した科目数:\s*(\d+)/);
      job.state = "done";
      job.message = m ? `取り込み完了（${m[1]} 科目）` : "取り込み完了";
    } else {
      job.state = "error";
      const tail = job.log.trim().split("\n").slice(-3).join(" / ");
      job.message = `取り込み失敗: ${tail.slice(0, 300) || `終了コード ${code}`}`;
    }
  });
  // 念のためのタイムアウト（15分）。
  setTimeout(() => {
    if (job.state === "running") {
      job.state = "error";
      job.message = "取り込みがタイムアウトしました（15分）";
      child.kill("SIGKILL");
    }
  }, 15 * 60_000).unref();
}

// スクレイパ用: 本人のトークンで認証し、復号済みの資格情報を返す。
app.get("/api/waseda/credentials", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  try {
    const row = await db.getWasedaCreds(account.email);
    if (!row?.waseda_user || !row?.waseda_password_enc) {
      return res.status(404).json({ ok: false, error: "Waseda アカウントが未登録です" });
    }
    res.json({ ok: true, wasedaUser: row.waseda_user, wasedaPassword: decryptCred(row.waseda_password_enc) });
  } catch (e) {
    console.error("Waseda 資格情報の取得に失敗:", e.message);
    res.status(500).json({ ok: false, error: "取得に失敗しました" });
  }
});

app.post("/api/moodle/sync", heavyLimiter, async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  try {
    const url = await db.getMoodleUrl(account.email);
    if (!url) return res.status(400).json({ ok: false, error: "Moodle の URL が未設定です" });
    const imported = await moodle.syncUser(account.email, url);
    res.json({ ok: true, imported });
  } catch (e) {
    console.error(`Moodle 同期に失敗 (${account.email}):`, e.message);
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

// 音声ファイルの受信 → ジョブ登録（文字起こしは外部PCワーカーが非同期で実行）。
// 端末での Whisper 処理の代わりに、録音した WAV をそのまま送れる。
app.post("/api/audio", heavyLimiter, async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "アカウント情報が一致しません" });
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ ok: false, error: "音声データがありません（audio/wav 等で送ってください）" });
  }
  const rawName = req.get("X-Filename") || `audio-${Date.now()}.wav`;
  const mime = (req.get("Content-Type") || "audio/wav").split(";")[0];
  try {
    const jobId = await audio.enqueue(account.email, rawName, req.body, mime);
    console.log(`音声受信: ${account.email} -> ${rawName} (${req.body.length} bytes) job#${jobId}`);
    res.json({ ok: true, jobId, queued: true });
  } catch (e) {
    console.error("音声の受付に失敗:", e.message);
    res.status(500).json({ ok: false, error: "音声の保存に失敗しました" });
  }
});

// 音声ジョブの処理状況一覧（queued/processing/done/error）。
app.get("/api/audio/jobs", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  try {
    const jobs = await db.listAudioJobs(account.email, Number(req.query.limit) || 30);
    res.json({ ok: true, jobs });
  } catch (e) {
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

// ワーカーPC（クライアント）のID。サーバーが audio_workers で自動採番し、
// claim レスポンスで通知する。新クライアントは以後 X-Worker-Id で送り返して
// くるが、旧クライアントは何も送らないため接続元IPで同一PCを推定する。
function workerIdFromReq(req) {
  const n = Number(String(req.get("x-worker-id") || "").trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

// 新クライアントが名乗るPC名（ホスト名）。ワーカー一覧の表示名に使う。
function workerNameFromReq(req) {
  const raw = String(req.get("x-worker-name") || "").replace(/[^\x20-\x7E]/g, "").trim();
  return raw ? raw.slice(0, 100) : null;
}

// 新クライアントが申告する公開範囲（global/private）。クライアントUIで選択される。
// 旧クライアントはヘッダーを送らないので null（サーバー側の既存値を維持）。
function workerModeFromReq(req) {
  const raw = String(req.get("x-worker-mode") || "").trim().toLowerCase();
  return raw === "global" || raw === "private" ? raw : null;
}

function clientIpOf(req) {
  const ip = String(req.ip || req.socket?.remoteAddress || "").trim().slice(0, 64);
  return ip || null;
}

// 音声を処理するクライアントPCの一覧。ユーザーはこの中から処理させるPCを
// 複数選択（allowed の付け外し）できる。
app.get("/api/audio/workers", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  try {
    const workers = await db.listAudioWorkers(account.email);
    res.json({
      ok: true,
      workers: workers.map((w) => {
        const owned = Boolean(w.owned);
        return {
          id: w.id,
          name: w.name,
          // 他ユーザーのglobal PCの接続元IPは晒さない。
          ip: owned ? w.ip : null,
          owned,
          mode: w.mode || "private",
          // 自分のPCは所有者設定(allowed)、他ユーザーのglobal PCは自分のprefs
          // （未設定なら利用する扱い）。
          allowed: owned ? Boolean(w.allowed) : w.pref_allowed === null || Boolean(w.pref_allowed),
          lastSeenAt: w.last_seen_at,
          // クライアントの3秒間隔メトリクス送信があるため60秒以内なら「接続中」。
          online: Boolean(w.last_seen_at) && Date.now() - new Date(w.last_seen_at).getTime() < 60_000,
          // クライアントから3秒ごとに届くリソース使用率。古い値は表示しない。
          cpuPct: w.metrics_at ? w.cpu_pct : null,
          memPct: w.metrics_at ? w.mem_pct : null,
          gpuPct: w.metrics_at ? w.gpu_pct : null,
          metricsAt: w.metrics_at,
          metricsFresh: Boolean(w.metrics_at) && Date.now() - new Date(w.metrics_at).getTime() < 15_000,
        };
      }),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

// クライアントPCの設定変更。自分のPCは処理の許可/停止・表示名を変更できる。
// 他ユーザーのglobal PCは「自分のジョブを任せるかどうか（allowed）」だけ変更できる。
app.post("/api/audio/workers/:id", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: "IDが不正です" });
  const allowed = typeof req.body?.allowed === "boolean" ? req.body.allowed : null;
  const name = typeof req.body?.name === "string" ? req.body.name : null;
  try {
    const worker = await db.getAudioWorker(id);
    if (!worker) return res.status(404).json({ ok: false, error: "クライアントが見つかりません" });
    if (worker.email === account.email) {
      await db.updateAudioWorker(account.email, id, { allowed, name });
      return res.json({ ok: true });
    }
    if (worker.mode !== "global" || allowed === null) {
      return res.status(404).json({ ok: false, error: "クライアントが見つかりません" });
    }
    const n = await db.setAudioWorkerPref(account.email, id, allowed);
    if (!n) return res.status(404).json({ ok: false, error: "クライアントが見つかりません" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

// クライアントPCを一覧から削除する（再接続すると新しいIDで自動登録される）。
app.delete("/api/audio/workers/:id", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: "IDが不正です" });
  try {
    const n = await db.deleteAudioWorker(account.email, id);
    if (!n) return res.status(404).json({ ok: false, error: "クライアントが見つかりません" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

// 外部PCワーカー用: 自分のアカウントの queued 音声ジョブを1件確保する。
// 接続してきたPCを audio_workers に自動登録し、割り振ったIDをレスポンスで
// 知らせる。ユーザーが許可したPCにだけジョブを渡す。複数のワーカーPCが
// 同時にポーリングしても、claim は1件ずつ原子的に確保されるため、
// 手の空いたPCから順にジョブが分散される。
app.post("/api/audio/worker/claim", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  try {
    const worker = await db.resolveAudioWorker(account.email, {
      id: workerIdFromReq(req),
      ip: clientIpOf(req),
      name: workerNameFromReq(req),
      mode: workerModeFromReq(req),
    });
    const base = {
      ok: true,
      workerId: worker.id,
      workerName: worker.name,
      mode: worker.mode || "private",
      allowed: Boolean(worker.allowed),
    };
    if (!worker.allowed) return res.json({ ...base, job: null });
    // global モードのPCは全ユーザーのジョブを処理対象にする（そのPCの利用を
    // 断っているユーザーのジョブは claim 時に除外される）。ただしリクエスト自体が
    // global を申告している場合に限る: 旧クライアント（ヘッダー無し）は他ユーザーの
    // ジョブをダウンロードできず滞留させてしまうため、常に本人のジョブだけを渡す。
    const global = worker.mode === "global" && workerModeFromReq(req) === "global";
    const job = await audio.claimRemoteJob(account.email, worker.id, { global });
    if (!job) return res.json({ ...base, job: null });
    res.json({
      ...base,
      job: {
        ...job,
        downloadPath: `/api/audio/worker/jobs/${job.id}/file`,
        resultPath: `/api/audio/worker/jobs/${job.id}/result`,
      },
    });
  } catch (e) {
    console.error("外部音声ワーカーのジョブ確保に失敗:", e.message);
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

// 外部PCワーカー用: リソース使用率（CPU/メモリ/GPU）の報告。クライアントが
// 3秒ごとに送ってくる。ダッシュボードの「処理に使うPC」選択画面に表示する。
// レスポンスで割り振り済みIDを知らせるので、初回接続でもPC登録が完了する。
app.post("/api/audio/worker/metrics", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  const pct = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(Math.max(n, 0), 100) : null;
  };
  try {
    const worker = await db.resolveAudioWorker(account.email, {
      id: workerIdFromReq(req),
      ip: clientIpOf(req),
      name: workerNameFromReq(req),
      mode: workerModeFromReq(req),
    });
    await db.updateAudioWorkerMetrics(worker.id, {
      cpu: pct(req.body?.cpu),
      mem: pct(req.body?.mem),
      gpu: pct(req.body?.gpu),
    });
    // 処理中ジョブのハートビート。これが10分（AUDIO_WORKER_STALE_MIN）途絶えると
    // requeueStaleAudioJobs がジョブを queued に戻し、別のPCへ振り直す。
    const activeJobId = Number(req.body?.activeJobId);
    if (Number.isInteger(activeJobId) && activeJobId > 0) {
      await db.touchAudioJob(activeJobId, worker.id);
    }
    res.json({ ok: true, workerId: worker.id, workerName: worker.name, mode: worker.mode || "private" });
  } catch (e) {
    console.error("外部音声ワーカーのメトリクス保存に失敗:", e.message);
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

// 外部PCワーカー用: claim 済みジョブの音声本体をダウンロードする。
app.get("/api/audio/worker/jobs/:id/file", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  try {
    const job = await audio.getClaimedJob(account.email, req.params.id, workerIdFromReq(req));
    if (!job) return res.status(404).json({ ok: false, error: "処理中の音声ジョブが見つかりません" });
    const filename = encodeURIComponent(job.filename || `audio-${job.id}.wav`);
    res.setHeader("Content-Type", job.mime || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${filename}`);
    try {
      const st = fs.statSync(job.stored_path);
      res.setHeader("Content-Length", String(st.size));
    } catch (_e) {
      // sendFile 側のエラー処理に任せる。
    }
    res.sendFile(path.resolve(job.stored_path));
  } catch (e) {
    console.error("外部音声ワーカーの音声取得に失敗:", e.message);
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

// 外部PCワーカー用: ローカルPCで文字起こしした結果を返す。
app.post("/api/audio/worker/jobs/:id/result", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  const text = typeof req.body?.text === "string" ? req.body.text : "";
  const error = req.body?.error ? String(req.body.error) : "";
  if (!text && !error) {
    return res.status(400).json({ ok: false, error: "text または error を指定してください" });
  }
  try {
    const result = await audio.completeRemoteJob(account.email, req.params.id, { text, error, workerId: workerIdFromReq(req) });
    if (!result.ok) return res.status(result.status || 500).json({ ok: false, error: result.error });
    res.json(result);
  } catch (e) {
    console.error("外部音声ワーカーの結果保存に失敗:", e.message);
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

// 文字起こしテキストの受信 → MySQL に保存 → Gemini で課題/予定/要約を抽出。
app.post("/api/upload", heavyLimiter, async (req, res) => {
  const account = await authFromReq(req);
  if (!account) {
    return res.status(401).json({ ok: false, error: "アカウント情報が一致しません" });
  }

  const content = typeof req.body === "string" ? req.body : "";
  if (!content) {
    return res.status(400).json({ ok: false, error: "本文が空です" });
  }

  const rawName = req.get("X-Filename") || `transcript-${Date.now()}.txt`;
  const safeName = path.basename(rawName).replace(/[^A-Za-z0-9._-]/g, "_");

  let id;
  try {
    id = await db.saveTranscript(account.email, safeName, content);
  } catch (e) {
    console.error("DB 保存に失敗:", e.message);
    return res.status(500).json({ ok: false, error: "保存に失敗しました" });
  }
  console.log(`受信: ${account.email} -> ${safeName} (${content.length} 文字) を DB 保存`);

  // Gemini で「課題」「予定」「要約」を抽出して保存。失敗してもアップロードは成功扱い。
  let analyzed = false;
  let taskCount = 0;
  if (id != null && (await gemini.isConfiguredFor(account.email))) {
    try {
      const result = await gemini.analyze(account.email, content);
      await db.saveAnalysis(id, result.kadai, result.yotei, result.summary);
      await db.upsertTasks(account.email, result.tasks, id);
      const updated = await db.applyTaskUpdates(account.email, result.updates);
      const canceled = await db.cancelTasks(account.email, result.cancellations);
      taskCount = result.tasks.length;
      analyzed = true;
      console.log(
        `解析: ${safeName} -> タスク ${taskCount} 件 / 変更 ${updated.length} 件 / 削除 ${canceled.length} 件 / ` +
          `要約 ${result.summary ? "有" : "無"}`
      );
    } catch (e) {
      console.error(`Gemini 解析に失敗 (${safeName}):`, e.message);
    }
  }

  res.json({
    ok: true,
    saved: safeName,
    bytes: Buffer.byteLength(content, "utf8"),
    analyzed,
    tasks: taskCount,
  });
});

// ログイン中アカウント本人の文字起こし一覧を返す。
// サーバー文字起こしモードでは本文が端末に残らないため、Android アプリからも最新記録を読めるようにする。
app.get("/api/transcripts", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);
  try {
    const transcripts = await db.listTranscriptsByEmail(account.email, limit);
    res.json({ ok: true, transcripts });
  } catch (e) {
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

// ログイン中アカウント本人の文字起こし本文を返す。
app.get("/api/transcripts/:id", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  try {
    const row = await db.getTranscriptForEmail(account.email, req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: "見つかりません" });
    res.json({ ok: true, transcript: row });
  } catch (e) {
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

// =====================================================================
// AIチャット
// =====================================================================

// POST /api/ask  body: { email, token, question }
// 質問に答え、依頼（予定追加・完了化）なら実行する。
app.post("/api/ask", heavyLimiter, async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "アカウント情報が一致しません" });
  if (!(await gemini.isConfiguredFor(account.email))) {
    return res.status(503).json({ ok: false, error: gemini.NO_KEY_MESSAGE });
  }
  const question = String(req.body?.question || "").trim();
  if (!question) return res.status(400).json({ ok: false, error: "質問が空です" });

  try {
    const tasks = await db.listUpcomingTasks(account.email, { includeDone: true, limit: 100 });
    const summaries = await db.listDailySummaries(account.email, 5);
    const courses = await db.listCourses(account.email);
    // アプリが送ってきた端末側カレンダー（Google等）も渡す。
    const calendar = Array.isArray(req.body?.calendar) ? req.body.calendar.slice(0, 100) : [];
    
    // 連携している Google カレンダーの直近の予定も自動取得してマージする
    try {
      const gAccounts = await db.listGoogleAccounts(account.email);
      for (const r of gAccounts) {
        try {
          const gToken = await google.accessTokenOf(decryptCred(r.refresh_token));
          const gEvents = await google.listUpcomingEvents(gToken, 20);
          for (const ev of gEvents) {
            // 開始時間とタイトルが一致する予定は重複としてスキップ
            const exists = calendar.some(x => x.title === ev.title && Math.abs((x.startMillis || 0) - ev.startMillis) < 60000);
            if (!exists) {
              calendar.push({
                title: ev.title,
                whenText: ev.whenText,
                startMillis: ev.startMillis,
              });
            }
          }
        } catch (ge) {
          console.error(`Ask連携カレンダー取得失敗 (${r.google_email}):`, ge.message);
        }
      }
    } catch (e) {
      console.error("Askカレンダーアカウントリスト取得失敗:", e.message);
    }

    // スマホから同期されたカレンダー予定もマージする
    try {
      const localEvents = await db.listCalendarEvents(account.email);
      for (const ev of localEvents) {
        const exists = calendar.some(x => x.title === ev.title && Math.abs((x.startMillis || 0) - ev.startMillis) < 60000);
        if (!exists) {
          calendar.push({
            title: ev.title,
            whenText: ev.whenText,
            startMillis: ev.startMillis,
          });
        }
      }
    } catch (le) {
      console.error("Askローカル同期カレンダー取得失敗:", le.message);
    }

    // 授業の質問にも答えられるよう、資料要約と質問に関連する文字起こし抜粋も渡す。
    const documents = await db.listDocuments(account.email, 20);
    const snippets = await db.searchTranscriptSnippets(
      account.email, extractKeywords(question, courses)
    );
    // 「今日の授業」「7/1の講義」のように日付が特定できる質問には、
    // キーワード抜粋ではなくその日の文字起こし全文を渡す。
    const targetDay = extractDateFromQuestion(question, gemini.localDate());
    const dayTranscripts = targetDay ? await db.getTranscriptsForDay(account.email, targetDay) : [];
    // 会話が1問1答で毎回途切れないよう、直近の会話履歴も文脈として渡す。
    const history = await db.listRecentChatMessages(account.email, 20);
    const result = await gemini.ask(account.email, question, {
      tasks, summaries, calendar, courses, documents, snippets, targetDay, dayTranscripts, history,
    });

    // Gemini が返した操作を実行する。
    const applied = [];
    for (const a of result.actions) {
      if (a.op === "add_task" && a.content) {
        await db.addTask(account.email, {
          type: a.type || "kadai",
          content: a.content,
          details: a.details,
          deadline_at: a.deadline_at,
          date_only: a.date_only,
        });
        applied.push({ op: "add_task", type: a.type, content: a.content, deadline_at: a.deadline_at });
      } else if (a.op === "complete_task" && a.target) {
        const target = resolveTaskTarget(tasks, a.target);
        if (target) {
          await db.setTaskStatus(target.id, "done");
          applied.push({ op: "complete_task", id: target.id, content: target.content });
        }
      } else if (a.op === "delete_task" && a.target) {
        const target = resolveTaskTarget(tasks, a.target);
        if (target) {
          await db.deleteTask(target.id, account.email);
          applied.push({ op: "delete_task", id: target.id, content: target.content });
        }
      } else if (a.op === "update_task" && a.target) {
        const target = resolveTaskTarget(tasks, a.target);
        if (target) {
          const nextDeadline = a.deadline_at || target.deadline_at || null;
          await db.updateTask(account.email, target.id, {
            type: a.type || target.type,
            content: a.content || target.content,
            details: a.details || target.details || "",
            deadline_at: nextDeadline,
            date_only: a.deadline_at ? a.date_only : !!target.date_only,
          });
          applied.push({
            op: "update_task",
            id: target.id,
            content: a.content || target.content,
            deadline_at: nextDeadline,
          });
        }
      }
    }

    // Gemini が reply では「登録した」と言いつつ actions を返し忘れることがある。
    // その場合は依頼内容を専用プロンプトで抽出し直して登録する（保険）。
    let reply = result.reply;
    const claimsAdd = /(登録|追加)(し|いたし)ました|入れ(て|と)おきました|入れました/.test(reply);
    if (claimsAdd && !applied.some((x) => x.op === "add_task")) {
      try {
        const fallback = await gemini.extractTaskRequests(account.email, question);
        for (const t of fallback) {
          await db.addTask(account.email, t);
          applied.push({ op: "add_task", type: t.type, content: t.content, deadline_at: t.deadline_at });
        }
        if (!fallback.length) {
          reply += "\n（※すみません、今回は登録できていません。「〇月〇日に△△を予定に入れて」の形でもう一度お願いします）";
        }
      } catch (e) {
        console.error("ask の登録フォールバックに失敗:", e.message);
      }
    }

    // 次回以降の会話でも文脈を維持できるよう、発話と返答を履歴として保存する。
    try {
      await db.addChatMessage(account.email, "user", question);
      await db.addChatMessage(account.email, "assistant", reply);
    } catch (e) {
      console.error("チャット履歴の保存に失敗:", e.message);
    }

    res.json({ ok: true, reply, applied });
  } catch (e) {
    console.error("ask に失敗:", e.message);
    if (handleBadGeminiKey(res, e)) return;
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

// チャットの過去の会話履歴を返す（画面再読み込み後も続きから表示するため）。
app.get("/api/chat/history", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  try {
    const messages = await db.listRecentChatMessages(account.email, 50);
    res.json({ ok: true, messages });
  } catch (e) {
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

// 質問文から文字起こし検索用のキーワードを取り出す。
// 履修科目名に一致する語を最優先し、続けて名詞らしい 2 文字以上の語を拾う。
function extractKeywords(question, courses) {
  const keywords = [];
  for (const c of courses || []) {
    const name = String(c.name || "").trim();
    if (name && question.includes(name)) keywords.push(name);
  }
  // 記号・助詞的な1文字語を除き、空白/句読点区切りの語を追加。
  const words = question
    .split(/[\s、。．，,.!?！？「」『』（）()]+/)
    .map((w) => w.replace(/(について|とは|って|ですか|でしたか|教えて|何|なに)$/g, ""))
    .filter((w) => w.length >= 2);
  for (const w of words) {
    if (!keywords.includes(w)) keywords.push(w);
  }
  return keywords.slice(0, 8);
}

// 質問文から対象の日付("YYYY-MM-DD")を抽出する。見つからなければ null。
// 「今日の授業」「7/1の講義で〜」のように日付が特定できる質問には、
// キーワード抜粋ではなくその日の文字起こし全文を渡すために使う。
function extractDateFromQuestion(question, today) {
  const base = new Date(`${today}T00:00:00`);
  const shift = (days) => {
    const d = new Date(base);
    d.setDate(d.getDate() + days);
    return gemini.localDate(d);
  };
  if (/一昨日/.test(question)) return shift(-2);
  if (/昨日/.test(question)) return shift(-1);
  if (/今日|本日/.test(question)) return shift(0);
  if (/明日/.test(question)) return shift(1);

  let m = question.match(/(\d{4})[-\/年](\d{1,2})[-\/月](\d{1,2})日?/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;

  m = question.match(/(\d{1,2})月(\d{1,2})日/);
  if (m) return `${base.getFullYear()}-${String(m[1]).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}`;

  return null;
}

// "#3" やタスク内容の一部からタスクを特定する。
function resolveTaskTarget(tasks, target) {
  const m = target.match(/#?(\d+)/);
  if (m) {
    const byId = tasks.find((t) => String(t.id) === m[1]);
    if (byId) return byId;
  }
  const pending = tasks.filter((t) => t.status !== "done");
  return (
    pending.find((t) => t.content === target) ||
    pending.find((t) => t.content.includes(target) || target.includes(t.content)) ||
    null
  );
}

// =====================================================================
// タスク（課題・予定）API
// =====================================================================

app.get("/api/tasks", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  const includeDone = req.query.done === "1";
  try {
    const tasks = await db.listUpcomingTasks(account.email, { includeDone });
    res.json({ ok: true, tasks });
  } catch (e) {
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

app.post("/api/tasks", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  const { type, content, details, deadline } = req.body || {};
  if (!content) return res.status(400).json({ ok: false, error: "内容が空です" });
  const norm = normalizeDeadlineInput(deadline);
  try {
    await db.addTask(account.email, {
      type: type === "yotei" ? "yotei" : "kadai",
      content: String(content).trim(),
      details: details ? String(details).trim() : "",
      deadline_at: norm.at,
      date_only: norm.dateOnly,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

// 課題・予定の手動編集（Web のカレンダー画面から）。
app.patch("/api/tasks/:id", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  const { type, content, details, deadline } = req.body || {};
  if (!content) return res.status(400).json({ ok: false, error: "内容が空です" });
  const norm = normalizeDeadlineInput(deadline);
  try {
    const ok = await db.updateTask(account.email, req.params.id, {
      type: type === "yotei" ? "yotei" : "kadai",
      content: String(content).trim(),
      details: details ? String(details).trim() : "",
      deadline_at: norm.at,
      date_only: norm.dateOnly,
    });
    if (!ok) return res.status(404).json({ ok: false, error: "見つかりません" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

app.post("/api/tasks/:id/done", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  try {
    const ok = await db.setTaskStatus(
      Number(req.params.id),
      req.body?.status === "pending" ? "pending" : "done",
      account.email
    );
    if (!ok) return res.status(404).json({ ok: false, error: "見つかりません" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

app.delete("/api/tasks/:id", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  try {
    const ok = await db.deleteTask(Number(req.params.id), account.email);
    if (!ok) return res.status(404).json({ ok: false, error: "見つかりません" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

// 同じ正規化を Web 入力にも使う（gemini.js の normalizeDeadline と同等の簡易版）。
function normalizeDeadlineInput(s) {
  s = String(s || "").trim();
  if (!s) return { at: null, dateOnly: false };
  const dt = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/);
  if (dt) return { at: `${dt[1]}-${dt[2]}-${dt[3]} ${dt[4].padStart(2, "0")}:${dt[5]}:00`, dateOnly: false };
  const d = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (d) return { at: `${d[1]}-${d[2]}-${d[3]} 23:59:00`, dateOnly: true };
  return { at: null, dateOnly: false };
}

// =====================================================================
// 日次要約 API
// =====================================================================

app.get("/api/summary/:day", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  const day = req.params.day === "today" ? gemini.localDate() : req.params.day;
  try {
    const row = await db.getDailySummary(account.email, day);
    res.json({ ok: true, day, summary: row ? row.summary : "", generated_at: row?.generated_at || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

// その日の要約をいま生成し直す。
app.post("/api/summary/:day/generate", heavyLimiter, async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  if (!(await gemini.isConfiguredFor(account.email))) {
    return res.status(503).json({ ok: false, error: gemini.NO_KEY_MESSAGE });
  }
  const day = req.params.day === "today" ? gemini.localDate() : req.params.day;
  try {
    const summary = await reminders.generateDailySummary(account.email, day);
    res.json({ ok: true, day, summary, empty: !summary });
  } catch (e) {
    if (handleBadGeminiKey(res, e)) return;
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

app.get("/api/summaries", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  try {
    const rows = await db.listDailySummaries(account.email, 30);
    res.json({ ok: true, summaries: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

// =====================================================================
// リマインド（端末アプリのローカル通知用）
// =====================================================================

// 未取得の通知を返す。アプリはこれをポーリングしてローカル通知を出す。
app.get("/api/reminders", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  try {
    const items = await db.pendingNotifications(account.email);
    res.json({ ok: true, reminders: items });
  } catch (e) {
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

// 表示済みにする。
app.post("/api/reminders/ack", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  try {
    await db.ackNotifications(account.email, req.body?.ids || []);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

// =====================================================================
// CSV（既存機能）
// =====================================================================
function csvCell(value) {
  const s = String(value ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function itemsToCsv(items) {
  const header = ["期限", "内容", "詳細"];
  const lines = [header.join(",")];
  for (const it of items) {
    lines.push([csvCell(it.deadline), csvCell(it.content), csvCell(it.details)].join(","));
  }
  return "﻿" + lines.join("\r\n") + "\r\n";
}

function sendCsv(res, filename, items) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", contentDisposition(filename));
  res.send(itemsToCsv(items));
}

// filename に日本語等の非ASCIIが含まれるとヘッダ値として不正になりサーバーが落ちるため、
// filename= には ASCII 化した名前、filename*= に UTF-8 エンコード名を入れる（RFC 5987）。
function contentDisposition(filename) {
  const ascii = String(filename).replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

app.get("/kadai/:id.csv", async (req, res) => serveAnalysisCsv(req, res, "kadai", "課題"));
app.get("/yotei/:id.csv", async (req, res) => serveAnalysisCsv(req, res, "yotei", "予定"));

// 本人確認したうえで、本人の文字起こしに紐づく解析結果だけを返す
// （認証なしだと ID を総当たりするだけで全ユーザーの課題・予定が読めてしまう）。
async function serveAnalysisCsv(req, res, kind, label) {
  const account = await authFromReq(req);
  if (!account) return res.status(401).type("text/plain").send("認証エラー");
  let data;
  try {
    data = await db.getAnalysis(account.email, req.params.id, kind);
  } catch (e) {
    return res.status(500).type("text/plain").send(serverErr(e, "db"));
  }
  if (!data) return res.status(404).type("text/plain").send("見つかりません");
  const base = data.filename.replace(/\.[^.]+$/, "");
  sendCsv(res, `${base}_${label}.csv`, data.items);
}

// =====================================================================
// ダッシュボード
// =====================================================================
app.get("/", (_req, res) => {
  res.type("text/html").send(renderDashboard());
});

// ブラウザ内で本文を確認するための JSON 取得（ダッシュボードのモーダル用）。
// 認証必須。本人の文字起こししか取得できない。
app.get("/api/transcript/:id", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  try {
    const row = await db.getTranscriptForEmail(account.email, req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: "見つかりません" });
    res.json({ ok: true, filename: row.filename, content: row.content, summary: row.summary || "" });
  } catch (e) {
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

// 本文ダウンロード。認証必須（<a> リンクから使うため email/token はクエリで渡せる）。
app.get("/download/:id", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).type("text/plain").send("認証エラー");
  let row;
  try {
    row = await db.getTranscriptForEmail(account.email, req.params.id);
  } catch (e) {
    return res.status(500).type("text/plain").send(serverErr(e, "db"));
  }
  if (!row) return res.status(404).type("text/plain").send("見つかりません");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", contentDisposition(row.filename));
  res.send(row.content);
});

// 動作確認用に、その場で日次サマリを送れる手動トリガ。
// accounts.json のいずれかの token を Bearer で要求する（誰でも叩けないように）。
app.post("/api/send-summary", async (req, res) => {
  const token = (req.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const ok = token && loadAccounts().some((a) => a.token === token);
  if (!ok) return res.status(401).json({ ok: false, error: "トークンが一致しません" });

  try {
    const result = await summary.sendDailySummary();
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error("日次サマリ送信に失敗:", e.message);
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

function parseHHMM(hhmm) {
  const m = String(hhmm || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min) || h < 0 || h > 23 || min < 0 || min > 59) {
    return null;
  }
  return { h, m: min };
}

// "HH:MM" を解釈し、次にその時刻になるまでのミリ秒を返す。
function msUntilNext(hhmm) {
  const parsed = parseHHMM(hhmm);
  if (!parsed) return null;
  const now = new Date();
  const next = new Date(now);
  next.setHours(parsed.h, parsed.m, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1); // 今日の時刻を過ぎていれば翌日
  return next - now;
}

let summaryPregenerationTimer = null;
let lastPregeneratedForSendAt = 0;

function nextSummarySendAt() {
  const parsed = parseHHMM(SUMMARY_TIME);
  if (!parsed) return null;
  const now = new Date();
  const sendAt = new Date(now);
  sendAt.setHours(parsed.h, parsed.m, 0, 0);
  if (sendAt <= now) sendAt.setDate(sendAt.getDate() + 1);
  return sendAt;
}

// 毎日 SUMMARY_TIME の少し前に、LINE 送信や画面表示に備えて「今日の要約」を作り直す。
// （Gemini キーはユーザーごとの登録制。未登録ユーザーは生成側でスキップされる）
function scheduleDailySummaryPregeneration() {
  if (!parseHHMM(SUMMARY_TIME)) {
    console.error(`DAILY_SUMMARY_TIME の形式が不正です: ${SUMMARY_TIME}（HH:MM で指定）`);
    return;
  }
  const leadMin = Number.isFinite(SUMMARY_PREGENERATE_LEAD_MIN) ? SUMMARY_PREGENERATE_LEAD_MIN : 15;
  if (leadMin < 0) return;

  const now = new Date();
  let sendAt = nextSummarySendAt();
  let generateAt = new Date(sendAt.getTime() - leadMin * 60_000);
  if (generateAt <= now) {
    if (lastPregeneratedForSendAt !== sendAt.getTime()) {
      generateAt = now;
    } else {
      sendAt = new Date(sendAt.getTime() + 24 * 3600_000);
      generateAt = new Date(sendAt.getTime() - leadMin * 60_000);
    }
  }

  if (summaryPregenerationTimer) clearTimeout(summaryPregenerationTimer);
  const delay = Math.max(0, generateAt - now);
  console.log(
    `次回の日次要約事前生成: ${generateAt.toLocaleString("ja-JP")} ` +
      `（送信予定 ${sendAt.toLocaleString("ja-JP")} の ${leadMin}分前）`
  );
  summaryPregenerationTimer = setTimeout(async () => {
    lastPregeneratedForSendAt = sendAt.getTime();
    try {
      await reminders.refreshTodaySummaries();
    } catch (e) {
      console.error("日次要約の事前生成に失敗:", e.message);
    }
    scheduleDailySummaryPregeneration();
  }, delay);
}

// 毎日 SUMMARY_TIME に日次サマリを送る。setTimeout を都度貼り直して回す。
function scheduleDailySummary() {
  if (!parseHHMM(SUMMARY_TIME)) {
    console.error(`DAILY_SUMMARY_TIME の形式が不正です: ${SUMMARY_TIME}（HH:MM で指定）`);
    return;
  }
  const delay = msUntilNext(SUMMARY_TIME);
  const next = new Date(Date.now() + delay);
  console.log(`次回の日次サマリ送信: ${next.toLocaleString("ja-JP")}`);
  setTimeout(async () => {
    try {
      await summary.sendDailySummary();
    } catch (e) {
      console.error("日次サマリ送信に失敗:", e.message);
    }
    scheduleDailySummary(); // 翌日分を予約
  }, delay);
}

function renderDashboard() {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AIHelper — あなたのAIアシスタント</title>
  <style>
    :root {
      --accent:#4f46e5; --accent-2:#6366f1; --ink:#0f172a; --muted:#64748b;
      --line:#e5e7eb; --bg:#f6f7fb; --card:#ffffff; --green:#16a34a; --danger:#dc2626;
      --radius:16px; --shadow:0 6px 24px rgba(15,23,42,.06);
    }
    * { box-sizing: border-box; }
    html { -webkit-text-size-adjust:100%; }
    body { font-family: system-ui,-apple-system,"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif;
           margin:0; background:var(--bg); color:var(--ink); line-height:1.55; }
    header { background:linear-gradient(135deg,var(--accent),var(--accent-2));
             color:#fff; padding:1.5rem 1.25rem; }
    header .wrap { max-width:980px; margin:0 auto; }
    header h1 { margin:0; font-size:1.35rem; font-weight:700; letter-spacing:.02em; }
    header p { margin:.35rem 0 0; color:#e0e7ff; font-size:.85rem; }
    main { max-width:980px; margin:1.25rem auto 3rem; padding:0 1rem; display:grid; gap:1.1rem; }
    .card { background:var(--card); border:1px solid var(--line); border-radius:var(--radius);
            padding:1.2rem 1.3rem; box-shadow:var(--shadow); }
    .card h2 { margin:0 0 .9rem; font-size:1.05rem; font-weight:700; }
    .card h3 { font-size:.95rem; font-weight:700; }
    .row { display:flex; gap:.5rem; flex-wrap:wrap; align-items:center; }
    label { font-size:.85rem; color:var(--muted); }
    input, select, textarea { font:inherit; padding:.6rem .7rem; border:1px solid var(--line);
            border-radius:10px; background:#fff; color:var(--ink); transition:border-color .15s,box-shadow .15s; }
    input:focus, select:focus, textarea:focus { outline:none; border-color:var(--accent);
            box-shadow:0 0 0 3px rgba(79,70,229,.15); }
    input, textarea { width:100%; }
    button { font:inherit; font-weight:600; padding:.6rem 1rem; border:none; border-radius:10px;
             background:var(--accent); color:#fff; cursor:pointer; transition:filter .15s,transform .02s; }
    button:hover { filter:brightness(1.06); }
    button:active { transform:translateY(1px); }
    button:disabled { opacity:.5; cursor:default; }
    button.ghost { background:#eef2ff; color:var(--accent); }
    button.small { padding:.3rem .6rem; font-size:.8rem; border-radius:8px; }
    .muted { color:var(--muted); font-size:.85rem; }
    .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:.6rem; }
    @media (max-width:640px){ .grid2 { grid-template-columns:1fr; } }
    table { border-collapse:collapse; width:100%; font-size:.9rem; }
    th, td { border-bottom:1px solid var(--line); padding:.55rem .6rem; text-align:left; vertical-align:top; }
    th { background:#f8fafc; font-weight:600; color:#475569; font-size:.82rem; }
    tr:last-child td { border-bottom:none; }
    td.num { text-align:right; } td.empty { text-align:center; color:#94a3b8; }
    a.dl { display:inline-block; padding:.25rem .6rem; background:#eef2ff; color:var(--accent);
           text-decoration:none; border-radius:8px; font-size:.8rem; font-weight:600; }
    a.dl.csv { background:#dcfce7; color:#15803d; }
    span.pending { color:#94a3b8; font-size:.85em; }
    .badge { display:inline-block; font-size:.7rem; padding:.15rem .55rem; border-radius:999px;
             color:#fff; font-weight:700; }
    .badge.kadai { background:#7c3aed; } .badge.yotei { background:#0891b2; }
    .due { font-size:.82rem; color:var(--muted); } .due.soon { color:var(--danger); font-weight:700; }
    .due.warn { color:#d97706; font-weight:600; }
    /* 課題テーブル: 内容に幅を寄せ、種別・期限・操作は折り返さない */
    #tasks td, #tasks th { vertical-align:top; }
    #tasks .col-type, #tasks .col-due, #tasks .col-mid { white-space:nowrap; width:1%; }
    #tasks .col-mid { text-align:center; }
    #tasks td:nth-child(2) { width:100%; }
    #tasks .due .rel { font-size:.75rem; opacity:.85; margin-top:.1rem; }
    .chatlog { display:flex; flex-direction:column; gap:.5rem; max-height:340px; overflow:auto;
               margin-bottom:.7rem; padding:.25rem; }
    .bubble { padding:.6rem .8rem; border-radius:14px; max-width:82%; white-space:pre-wrap; line-height:1.5;
              font-size:.92rem; }
    .bubble.me { align-self:flex-end; background:var(--accent); color:#fff; border-bottom-right-radius:4px; }
    .bubble.bot { align-self:flex-start; background:#f1f5f9; border-bottom-left-radius:4px; }
    .done { text-decoration:line-through; color:#94a3b8; }
    .modalbg { position:fixed; inset:0; background:rgba(15,23,42,.5); backdrop-filter:blur(2px);
               display:flex; align-items:center; justify-content:center; padding:1rem; z-index:50; }
    .modalbox { background:#fff; border-radius:var(--radius); padding:1.1rem 1.25rem; width:min(760px,100%);
                max-height:85vh; display:flex; flex-direction:column; box-shadow:var(--shadow); }
    .modalpre { white-space:pre-wrap; word-break:break-word; overflow:auto; margin:.6rem 0 0;
                font-size:.9rem; line-height:1.6; background:#f8fafc; padding:.8rem; border-radius:10px; }
    /* タブ: スティッキーな横並びナビ */
    .tabs { display:flex; gap:.35rem; flex-wrap:wrap; position:sticky; top:0; z-index:10;
            background:var(--bg); padding:.5rem 0; }
    .tab { background:transparent; color:var(--muted); font-weight:600; border:1px solid transparent; }
    .tab:hover { color:var(--accent); }
    .tab.active { background:#fff; color:var(--accent); border-color:var(--line); box-shadow:var(--shadow); }
    .panel { display:none; }
    .panel.active { display:block; animation:fade .2s ease; }
    @keyframes fade { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:none; } }
    .login-wrap { max-width:420px; margin:3rem auto; text-align:center; }
    .login-wrap h2 { font-size:1.5rem; }
    .calendar-grid { display:grid; grid-template-columns:repeat(7,1fr); gap:4px; text-align:center; }
    .calendar-cell { padding:.6rem 0; border-radius:8px; cursor:pointer; position:relative; }
    .calendar-cell:hover { background:var(--line); }
    .calendar-cell.active { background:var(--accent); color:#fff; }
    .calendar-cell .dot { width:5px; height:5px; background:var(--accent); border-radius:50%; position:absolute; bottom:4px; left:50%; transform:translateX(-50%); }
    .calendar-cell.active .dot { background:#fff; }
    .calendar-day-header { font-weight:600; color:var(--muted); font-size:.85rem; padding-bottom:.4rem; }
    hr { border:none; border-top:1px solid var(--line); margin:1.1rem 0; }
  </style>
</head>
<body>
  <header>
    <div class="wrap">
      <h1>AIHelper — あなたのAIアシスタント</h1>
      <p>常時録音から課題・予定を拾い、締切前に通知。聞けば答え、頼めば登録します。</p>
    </div>
  </header>
  <main>
    <!-- ログイン画面: ボタンのみ。押すとフォームが出る -->
    <div id="login">
      <section class="card login-wrap">
        <h2 style="margin:.2rem 0">AIHelper</h2>
        <p class="muted">常時録音から課題・予定を整理し、締切前に通知します。</p>
        <div class="row" style="justify-content:center; margin-top:1rem">
          <button onclick="showForm('login')">ログイン</button>
          <button class="ghost" onclick="showForm('register')">新規登録</button>
        </div>
        <div id="authForm" style="display:none; margin-top:1.2rem; text-align:left">
          <h3 id="formTitle" style="margin:.2rem 0 .6rem"></h3>
          <input id="email" placeholder="メールアドレス" autocomplete="username" style="margin-bottom:.5rem">
          <input id="password" type="password" placeholder="パスワード(6文字以上)"
                 autocomplete="current-password" onkeydown="if(event.key==='Enter')submitAuth()">
          <div class="row" style="margin-top:.6rem">
            <button id="submitBtn" onclick="submitAuth()"></button>
            <button class="ghost small" onclick="hideForm()">戻る</button>
          </div>
          <p id="authState" class="muted"></p>
        </div>
      </section>
    </div>

    <!-- アプリ本体: ログイン後にタブ表示 -->
    <div id="app" style="display:none">
      <nav class="tabs">
        <button class="tab" data-tab="chat" onclick="showTab('chat')">チャット</button>
        <button class="tab" data-tab="tasks" onclick="showTab('tasks')">予定・課題</button>
        <button class="tab" data-tab="calendar" onclick="showTab('calendar')">カレンダー</button>
        <button class="tab" data-tab="summary" onclick="showTab('summary')">今日の要約</button>
        <button class="tab" data-tab="files" onclick="showTab('files')">ファイル</button>
        <button class="tab" data-tab="account" onclick="showTab('account')">アカウント</button>
      </nav>

      <section class="card panel" data-panel="chat">
        <h2>AIに聞く / 頼む</h2>
        <div id="chatlog" class="chatlog"></div>
        <div class="row">
          <input id="q" placeholder="例）今日の予定は？ / 来週月曜10時にゼミ入れといて"
                 onkeydown="if(event.key==='Enter')ask()">
          <button onclick="ask()">送信</button>
        </div>
        <p class="muted">「〜の予定入れといて」「〇〇の宿題が出てるらしい、登録して」「〇〇終わった」も実行できます。</p>
      </section>

      <section class="card panel" data-panel="tasks">
        <h2>課題・予定</h2>
        <div id="tasksCalendarEvents" style="margin-bottom:1rem; display:none">
          <h3 style="font-size:.9rem; margin:.4rem 0 .2rem">Google カレンダーの直近予定</h3>
          <div id="tasksCalendarEventsList" style="font-size:.85rem; padding:.6rem; background:#f8fafc; border-radius:8px; line-height:1.5"></div>
        </div>
        <div style="display:grid; gap:.5rem; margin-bottom:.7rem">
          <input id="taskSearch" placeholder="キーワード検索（内容・詳細）" oninput="renderTasks()">
          <div class="row">
            <select id="taskFilter" onchange="renderTasks()">
              <option value="pending">未完了のみ</option>
              <option value="active">期限内のみ（未期限切れ）</option>
              <option value="overdue">期限切れ</option>
              <option value="all">すべて</option>
            </select>
            <select id="taskType" onchange="renderTasks()">
              <option value="all">課題+予定</option>
              <option value="kadai">課題のみ</option>
              <option value="yotei">予定のみ</option>
            </select>
            <select id="taskSort" onchange="renderTasks()">
              <option value="due-asc">締切が近い順</option>
              <option value="due-desc">締切が遠い順</option>
              <option value="new">追加が新しい順</option>
            </select>
            <button class="ghost small" onclick="loadTasks()">更新</button>
          </div>
          <div class="row">
            <label class="muted">期間</label>
            <input id="taskFrom" type="date" onchange="renderTasks()" style="width:auto">
            <span class="muted">〜</span>
            <input id="taskTo" type="date" onchange="renderTasks()" style="width:auto">
            <button class="ghost small" onclick="clearTaskPeriod()">期間クリア</button>
          </div>
        </div>
        <div id="tasks"><p class="muted">読み込み中…</p></div>
        <details style="margin-top:.6rem">
          <summary class="muted">手動で追加</summary>
          <div class="grid2" style="margin-top:.5rem">
            <select id="t_type"><option value="kadai">課題</option><option value="yotei">予定</option></select>
            <input id="t_deadline" type="datetime-local">
          </div>
          <input id="t_content" placeholder="内容" style="margin-top:.5rem">
          <input id="t_details" placeholder="詳細（任意）" style="margin-top:.5rem">
          <button style="margin-top:.5rem" onclick="addTask()">追加</button>
        </details>
      </section>

      <section class="card panel" data-panel="calendar">
        <h2>カレンダー</h2>
        <div class="row" style="justify-content:space-between; margin-bottom:.8rem">
          <button class="ghost small" onclick="prevMonth()">‹ 前月</button>
          <strong id="calMonthTitle" style="font-size:1.1rem"></strong>
          <button class="ghost small" onclick="nextMonth()">翌月 ›</button>
        </div>
        <div class="calendar-grid" id="calendarDayHeaders">
          <div class="calendar-day-header">日</div><div class="calendar-day-header">月</div><div class="calendar-day-header">火</div>
          <div class="calendar-day-header">水</div><div class="calendar-day-header">木</div><div class="calendar-day-header">金</div>
          <div class="calendar-day-header">土</div>
        </div>
        <div class="calendar-grid" id="calendarCells" style="margin-bottom:1rem"></div>
        <hr>
        <h3 id="calSelectedDateTitle" style="font-size:.95rem; margin:.4rem 0 .6rem">選択した日の予定</h3>
        <div id="calSelectedEvents" class="muted">日付を選択してください。</div>
        <div id="calSelectedSummaryBox" class="card" style="display:none; margin-top:.8rem; background:#f8fafc">
          <h4 style="font-size:.85rem; margin:0 0 .4rem; font-weight:700">この日の要約</h4>
          <div id="calSelectedSummary" style="font-size:.85rem; line-height:1.5; white-space:pre-wrap"></div>
        </div>
      </section>

      <section class="card panel" data-panel="summary">
        <h2>今日の要約</h2>
        <div id="summary"><p class="muted">読み込み中…</p></div>
        <button class="ghost small" style="margin-top:.5rem" onclick="genSummary()">今すぐ生成し直す</button>
      </section>

      <section class="card panel" data-panel="files">
        <h2>資料の要約（PDF / TXT）</h2>
        <p class="muted">PDF か テキストをアップロードすると、その場で AI が要約して保存します。</p>
        <div class="row">
          <input type="file" id="docFile" accept=".pdf,.txt,application/pdf,text/plain">
          <button onclick="uploadDoc()">要約する</button>
          <span id="docState" class="muted"></span>
        </div>
        <div id="docList" style="margin-top:.8rem"></div>
        <hr>
        <h2>音声の文字起こし状況（PCワーカー処理）</h2>
        <p class="muted">端末からアップロードされた音声はサーバーでキュー化され、ローカルPCワーカーが順番に文字起こしします。</p>
        <div class="row" style="margin-bottom:.5rem">
          <button class="ghost small" onclick="loadAudioJobs();loadAudioWorkers()">更新</button>
        </div>
        <h3 style="font-size:.95rem; margin:.2rem 0 .4rem">処理に使うPC（クライアント）</h3>
        <p class="muted" style="margin:.2rem 0 .5rem">
          音声を処理させるPCを選べます（複数選択可）。チェックを外したPCには新しいジョブを割り振りません。
          PCで audio-worker を起動して最初に接続した時に、サーバーがIDを自動で割り振ってここに表示します。
          種別が global のPCは提供者以外のユーザーの音声も処理します（他ユーザー提供のglobal PCに任せたくない場合はチェックを外してください）。
          CPU/メモリ/GPU はクライアントから3秒ごとに届く使用率です。
        </p>
        <div id="audioWorkers" style="margin-bottom:.8rem"><p class="muted">読み込み中…</p></div>
        <h3 style="font-size:.95rem; margin:.6rem 0 .4rem">ジョブ一覧</h3>
        <div id="audioJobs"><p class="muted">読み込み中…</p></div>
        <hr>
        <h2>受信した文字起こしファイル</h2>
        <div id="transcripts"><p class="muted">読み込み中…</p></div>
      </section>

      <section class="card panel" data-panel="account">
        <h2>アカウント</h2>
        <p>ログイン中: <strong id="accEmail"></strong></p>
        <hr>
        <h3 style="font-size:.95rem; margin:.2rem 0 .6rem">Gemini API キー（AI機能に必須）</h3>
        <p class="muted" style="margin:.2rem 0 .5rem">
          AIチャット・課題/予定の抽出・要約には、あなた自身の Gemini API キーが必要です。
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio</a>
          で無料発行し、ここに登録してください。キーは暗号化して保存され、あなたのAI処理にのみ使われます。
        </p>
        <input id="geminiKey" type="password" placeholder="AIza..." autocomplete="off">
        <div class="row" style="margin-top:.6rem">
          <button onclick="saveGeminiKey()">登録する</button>
          <button class="ghost" onclick="deleteGeminiKey()">削除</button>
          <span id="geminiKeyState" class="muted"></span>
        </div>
        <hr>
        <h3 style="font-size:.95rem; margin:.2rem 0 .6rem">パスワード変更</h3>
        <input id="curpw" type="password" placeholder="現在のパスワード" autocomplete="current-password" style="margin-bottom:.5rem">
        <input id="newpw" type="password" placeholder="新しいパスワード(6文字以上)" autocomplete="new-password">
        <div class="row" style="margin-top:.6rem">
          <button onclick="changePassword()">変更する</button>
          <span id="pwState" class="muted"></span>
        </div>
        <hr>
        <h3 style="font-size:.95rem; margin:.2rem 0 .6rem">Moodle 連携（提出物・予定の取り込み）</h3>
        <p class="muted" style="margin:.2rem 0 .5rem">
          Moodle のカレンダー › 書き出し › 「カレンダーの URL を取得」で得た iCal URL を貼り付けてください。
          取り込んだ提出物・予定は課題一覧・リマインドに反映されます。
        </p>
        <input id="moodleUrl" placeholder="https://…/calendar/export_execute.php?...">
        <div class="row" style="margin-top:.6rem">
          <button onclick="saveMoodle()">保存</button>
          <button class="ghost" onclick="syncMoodle()">今すぐ同期</button>
          <span id="moodleState" class="muted"></span>
        </div>
        <hr>
        <h3 style="font-size:.95rem; margin:.2rem 0 .6rem">Waseda アカウント連携（時間割の取り込み）</h3>
        <p class="muted" style="margin:.2rem 0 .5rem">
          MyWaseda のログイン情報を保存すると、科目登録（時間割）を自動取得できます。
          パスワードは暗号化して保存され、時間割取得のログインにのみ使われます。
        </p>
        <input id="wasedaUser" placeholder="Waseda ID（例: xxxx@akane.waseda.jp）" autocomplete="off" style="margin-bottom:.5rem">
        <input id="wasedaPw" type="password" placeholder="Waseda パスワード" autocomplete="new-password">
        <div class="row" style="margin-top:.6rem">
          <button onclick="saveWaseda()">保存</button>
          <button id="wasedaSyncBtn" class="ghost" onclick="syncWaseda()">時間割を取り込む</button>
          <button class="ghost" onclick="clearWaseda()">連携解除</button>
          <span id="wasedaState" class="muted"></span>
        </div>
        <div id="wasedaSyncBox" style="display:none; margin-top:.6rem">
          <div style="height:6px; background:#e5e7eb; border-radius:999px; overflow:hidden">
            <div id="wasedaSyncBar" style="height:100%; width:30%; background:var(--accent); border-radius:999px;
                 animation: slide 1.2s ease-in-out infinite alternate"></div>
          </div>
          <p id="wasedaSyncMsg" class="muted" style="margin:.4rem 0 0"></p>
          <details style="margin-top:.4rem">
            <summary class="muted" style="cursor:pointer; font-size:.85rem">実行ログを表示</summary>
            <pre id="wasedaSyncLog" style="max-height:220px; overflow:auto; background:#f9fafb;
                 border:1px solid #e5e7eb; border-radius:6px; padding:.5rem; font-size:.72rem;
                 white-space:pre-wrap; word-break:break-all; margin:.3rem 0 0"></pre>
          </details>
        </div>
        <div id="wasedaCoursesBox" style="display:none; margin-top:.8rem">
          <h4 style="font-size:.9rem; margin:.4rem 0 .2rem">取り込んだ時間割</h4>
          <div id="wasedaCourses" style="font-size:.85rem; margin-bottom:.5rem; line-height:1.6"></div>
          <div class="row">
            <button class="ghost small" onclick="syncWasedaCoursesToGoogle()">Google カレンダーに同期</button>
            <span id="wasedaSyncGoogleState" class="muted"></span>
          </div>
        </div>
        <style>@keyframes slide { from { margin-left:0 } to { margin-left:70% } }</style>
        <hr>
        <h3 style="font-size:.95rem; margin:.2rem 0 .6rem">Google カレンダー連携</h3>
        <p class="muted" style="margin:.2rem 0 .5rem">
          Google アカウントを連携すると、課題・予定の締切を Google カレンダーに登録したり、
          直近の予定を表示できます。複数アカウントを連携できます。
        </p>
        <div id="googleAccounts"><p class="muted">未連携です。</p></div>
        <div class="row" style="margin-top:.6rem">
          <button onclick="connectGoogle()">Google アカウントを連携</button>
          <span id="googleState" class="muted"></span>
        </div>
        <div id="googleEvents" style="margin-top:.6rem"></div>
        <hr>
        <button class="ghost" onclick="logout()">ログアウト</button>
      </section>
    </div><!-- /#app -->
  </main>

  <div id="modal" class="modalbg" style="display:none" onclick="if(event.target===this)closeModal()">
    <div class="modalbox">
      <div class="row" style="justify-content:space-between">
        <strong id="modalTitle"></strong>
        <button class="ghost small" onclick="closeModal()">閉じる</button>
      </div>
      <pre id="modalBody" class="modalpre"></pre>
    </div>
  </div>

  <script>
    const $ = (id) => document.getElementById(id);
    let auth = JSON.parse(localStorage.getItem('mb_auth') || '{}');
    function headers(){ return { 'Content-Type':'application/json',
      'X-Account-Email': auth.email||'', 'Authorization':'Bearer '+(auth.token||'') }; }
    const AUTO_REFRESH_MS = 15000;
    const GOOGLE_REFRESH_MS = 60000;
    let activeTab = 'chat';
    let autoRefreshTimer = null;
    let audioJobsTimer = null;
    let audioWorkersTimer = null;
    let autoRefreshBusy = false;
    let lastGoogleRefresh = 0;
    function activeControl(){
      const el = document.activeElement;
      return el && ['INPUT','TEXTAREA','SELECT'].includes(el.tagName);
    }
    function startAutoRefresh(){
      stopAutoRefresh();
      autoRefreshTimer = setInterval(() => refreshCurrentTab(), AUTO_REFRESH_MS);
      document.addEventListener('visibilitychange', refreshWhenVisible);
    }
    function stopAutoRefresh(){
      if(autoRefreshTimer) clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
      if(audioJobsTimer) clearTimeout(audioJobsTimer);
      audioJobsTimer = null;
      if(audioWorkersTimer) clearTimeout(audioWorkersTimer);
      audioWorkersTimer = null;
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    }
    function refreshWhenVisible(){
      if(!document.hidden) refreshCurrentTab(true);
    }
    async function refreshGoogleEvents(force){
      const now = Date.now();
      if(!force && now - lastGoogleRefresh < GOOGLE_REFRESH_MS) return;
      lastGoogleRefresh = now;
      await loadGoogleEvents();
    }
    async function refreshCurrentTab(force){
      if(!auth.email || autoRefreshBusy) return;
      if(!force && (document.hidden || activeControl())) return;
      autoRefreshBusy = true;
      try {
        if(activeTab === 'chat') await loadChatHistory();
        else if(activeTab === 'tasks') { await loadTasks(); await refreshGoogleEvents(false); }
        else if(activeTab === 'calendar') { await loadTasks(); await refreshGoogleEvents(false); }
        else if(activeTab === 'summary') await loadSummary();
        else if(activeTab === 'files') { await loadDocs(); await loadAudioWorkers(); await loadAudioJobs(); await loadTranscripts(); }
      } catch(e) {
      } finally {
        autoRefreshBusy = false;
      }
    }

    let allGoogleEvents = [];
    let allCourses = [];
    let calYear = new Date().getFullYear();
    let calMonth = new Date().getMonth() + 1;
    // sv-SE gives yyyy-mm-dd format natively
    let calSelectedDate = new Date().toLocaleDateString('sv-SE').slice(0,10);
    
    function prevMonth(){ calMonth--; if(calMonth<1){ calMonth=12; calYear--; } renderCalendar(); }
    function nextMonth(){ calMonth++; if(calMonth>12){ calMonth=1; calYear++; } renderCalendar(); }

    const DOW_JA = ['日','月','火','水','木','金','土'];
    // 学期の大まかな開始日・終了日（早稲田の一般的な目安。公式の学事暦とはズレる場合あり）。
    // /api/google/sync-courses の「春学期は〜7/31, それ以外は翌1/31まで」という既存の目安に合わせた。
    function courseTermRange(term, refDate){
      const m = refDate.getMonth() + 1;
      const ay = m >= 4 ? refDate.getFullYear() : refDate.getFullYear() - 1; // 学年度の開始年（4月始まり）
      const d = (y,mo,day) => y + '-' + String(mo).padStart(2,'0') + '-' + String(day).padStart(2,'0');
      switch(term){
        case '通年': return { start: d(ay,4,1), end: d(ay+1,1,31) };
        case '春': return { start: d(ay,4,1), end: d(ay,7,31) };
        case '春Q': return { start: d(ay,4,1), end: d(ay,6,15) };
        case '夏Q': return { start: d(ay,6,16), end: d(ay,7,31) };
        case '夏季集中': return { start: d(ay,8,1), end: d(ay,9,15) };
        case '秋': return { start: d(ay,9,1), end: d(ay+1,1,31) };
        case '秋Q': return { start: d(ay,9,1), end: d(ay,11,15) };
        case '冬Q': return { start: d(ay,11,16), end: d(ay+1,1,31) };
        case '冬季集中': return { start: d(ay+1,1,1), end: d(ay+1,1,31) };
        default: return { start: d(ay,4,1), end: d(ay+1,1,31) }; // 不明な学期は通年扱いで広めに表示
      }
    }
    // この科目が指定日(YYYY-MM-DD)に該当するか。
    // 曜日・時限が判明していれば毎週その曜日、不明（オンデマンド等）なら学期中の全日に配置する。
    function courseOccursOn(course, dateStr){
      const dateObj = new Date(dateStr + 'T00:00:00');
      const range = courseTermRange(course.term || '', dateObj);
      if(dateStr < range.start || dateStr > range.end) return false;
      if(!course.day) return true; // オンデマンド等: 学期中は毎日
      return DOW_JA[dateObj.getDay()] === course.day;
    }

    function renderCalendar(){
      if(!$('calMonthTitle')) return;
      $('calMonthTitle').textContent = calYear + '年' + calMonth + '月';
      const firstDay = new Date(calYear, calMonth - 1, 1).getDay();
      const lastDate = new Date(calYear, calMonth, 0).getDate();
      let html = '';
      for(let i=0; i<firstDay; i++){
        html += '<div class="calendar-cell muted" style="opacity:.3; cursor:default"></div>';
      }
      const pad = (n) => String(n).padStart(2,'0');
      const dateMap = {};
      allTasks.forEach(t => {
        if(t.deadline_at){ dateMap[t.deadline_at.slice(0,10)] = true; }
      });
      allGoogleEvents.forEach(ev => {
        if(ev.startMillis){ dateMap[new Date(ev.startMillis).toLocaleDateString('sv-SE').slice(0,10)] = true; }
      });
      for(let d=1; d<=lastDate; d++){
        const dateStr = calYear + '-' + pad(calMonth) + '-' + pad(d);
        const isActive = dateStr === calSelectedDate;
        const hasEvents = dateMap[dateStr] || allCourses.some(c => courseOccursOn(c, dateStr));
        html += '<div class="calendar-cell ' + (isActive ? 'active' : '') + '" onclick="selectCalDate(\\'' + dateStr + '\\')">' + d + (hasEvents ? '<span class="dot"></span>' : '') + '</div>';
      }
      $('calendarCells').innerHTML = html;
      renderSelectedDateEvents();
    }
    function selectCalDate(d){ calSelectedDate = d; renderCalendar(); }
    async function renderSelectedDateEvents(){
      $('calSelectedDateTitle').textContent = calSelectedDate + ' の予定';
      const dayItems = [];
      allTasks.forEach(t => {
        if(t.deadline_at && t.deadline_at.slice(0,10) === calSelectedDate){
          const norm = t.deadline_at.replace('T',' ');
          const time = (!t.date_only && norm.length >= 16) ? norm.substring(11,16) : '終日';
          dayItems.push({ time, kind: 'task', task: t });
        }
      });
      allGoogleEvents.forEach(ev => {
        if(ev.startMillis){
          const dStr = new Date(ev.startMillis).toLocaleDateString('sv-SE').slice(0,10);
          if(dStr === calSelectedDate){
            const norm = ev.whenText.replace('T',' ');
            const start = norm.length >= 16 ? norm.substring(11,16) : '終日';
            const endNorm = (ev.endText || '').replace('T',' ');
            const end = endNorm.length >= 16 ? endNorm.substring(11,16) : '';
            const time = (start !== '終日' && end) ? start + '〜' + end : start;
            dayItems.push({ time, kind: 'calendar', title: '[カレンダー] ' + ev.title });
          }
        }
      });
      // 早稲田大学の公式時間割（100分授業。/api/google/sync-courses と同じ定義）。表示のソート・ラベル用。
      const PERIOD_TIMES = {
        1:{s:'08:50',e:'10:30'},2:{s:'10:40',e:'12:20'},3:{s:'13:10',e:'14:50'},
        4:{s:'15:05',e:'16:45'},5:{s:'17:00',e:'18:40'},6:{s:'18:55',e:'20:35'},7:{s:'20:45',e:'22:25'}
      };
      allCourses.forEach(c => {
        if(courseOccursOn(c, calSelectedDate)){
          // start_time/end_time は複数時限にまたがる授業の時限番号。単一時限は period。
          const startP = PERIOD_TIMES[c.start_time || c.period];
          const endP = PERIOD_TIMES[c.end_time || c.period];
          const time = startP ? (endP ? startP.s + '〜' + endP.e : startP.s) : '終日';
          dayItems.push({ time, kind: 'course', course: c });
        }
      });
      dayItems.sort((a,b) => (a.time === '終日' ? '00:00' : a.time).localeCompare(b.time === '終日' ? '00:00' : b.time));
      if(!dayItems.length){
        $('calSelectedEvents').innerHTML = '<p class="muted">予定はありません。</p>';
      } else {
        $('calSelectedEvents').innerHTML = dayItems.map(it => {
          if(it.kind === 'task') return dayTaskItemHtml(it.task, it.time);
          if(it.kind === 'course') return dayCourseItemHtml(it.course, it.time);
          return '<div class="card" style="margin:.3rem 0; padding:.6rem .8rem; display:flex; gap:.8rem; background:#fff; border:1px solid var(--line); border-radius:10px">' +
            '<strong style="color:var(--accent); min-width:40px">' + it.time + '</strong>' +
            '<span>' + escapeHtml(it.title) + '</span>' +
            '</div>';
        }).join('');
      }
      $('calSelectedSummaryBox').style.display = 'none';
      try {
        const r = await fetch('/api/summary/' + calSelectedDate, {headers: headers()});
        const j = await r.json();
        if(j.ok && j.summary){
          $('calSelectedSummaryBox').style.display = '';
          $('calSelectedSummary').textContent = j.summary;
        }
      } catch(e){}
    }

    // 選択した日の「授業」項目。編集フォームは courseRowHtml を 'day' prefix で共用する
    // （アカウント画面の一覧と同時に描画されても要素 id が衝突しないようにするため）。
    function dayCourseItemHtml(c, time){
      return '<div style="margin:.3rem 0">' +
        '<div class="muted" style="font-size:.75rem; margin:0 0 .1rem .1rem">' + time + '</div>' +
        courseRowHtml(c, 'day') +
        '</div>';
    }

    // 選択した日の「課題・予定」項目の編集。
    let taskEditingId = null;
    function isoForInput(deadlineAt){
      return deadlineAt ? deadlineAt.replace(' ', 'T').slice(0,16) : '';
    }
    function dayTaskItemHtml(t, time){
      const label = t.type === 'yotei' ? '予定' : '課題';
      if(taskEditingId === t.id){
        return '<div class="card" style="margin:.3rem 0; padding:.5rem .7rem; background:#fff; border:1px solid var(--line); border-radius:10px">' +
          '<div class="row" style="gap:.4rem; flex-wrap:wrap">' +
          '<select id="te_type_' + t.id + '" style="width:90px">' +
          '<option value="kadai"' + (t.type!=='yotei'?' selected':'') + '>課題</option>' +
          '<option value="yotei"' + (t.type==='yotei'?' selected':'') + '>予定</option>' +
          '</select>' +
          '<input id="te_content_' + t.id + '" value="' + escapeHtml(t.content) + '" placeholder="内容" style="flex:1; min-width:160px">' +
          '<input id="te_deadline_' + t.id + '" type="datetime-local" value="' + isoForInput(t.deadline_at) + '" style="width:180px">' +
          '</div>' +
          '<input id="te_details_' + t.id + '" value="' + escapeHtml(t.details || '') + '" placeholder="詳細（任意）" style="width:100%; margin-top:.4rem">' +
          '<div class="row" style="margin-top:.4rem; gap:.4rem">' +
          '<button class="small" onclick="saveTaskEdit(' + t.id + ')">保存</button>' +
          '<button class="ghost small" onclick="cancelTaskEdit()">キャンセル</button>' +
          '</div></div>';
      }
      return '<div class="card" style="margin:.3rem 0; padding:.6rem .8rem; display:flex; gap:.8rem; justify-content:space-between; align-items:center; background:#fff; border:1px solid var(--line); border-radius:10px">' +
        '<div style="display:flex; gap:.8rem; align-items:center; min-width:0"><strong style="color:var(--accent); min-width:40px">' + time + '</strong><span>[' + label + '] ' + escapeHtml(t.content) + '</span></div>' +
        '<span class="row" style="gap:.3rem; flex-shrink:0">' +
        '<button class="ghost small" onclick="startTaskEdit(' + t.id + ')">編集</button>' +
        '<button class="ghost small" onclick="delTask(' + t.id + ')">削除</button>' +
        '</span></div>';
    }
    function startTaskEdit(id){ taskEditingId = id; renderSelectedDateEvents(); }
    function cancelTaskEdit(){ taskEditingId = null; renderSelectedDateEvents(); }
    async function saveTaskEdit(id){
      const content = $('te_content_' + id).value.trim();
      if(!content){ alert('内容を入力してください'); return; }
      const body = {
        type: $('te_type_' + id).value,
        content,
        details: $('te_details_' + id).value.trim(),
        deadline: $('te_deadline_' + id).value,
      };
      try {
        const r = await fetch('/api/tasks/' + id, {method:'PATCH', headers:headers(), body:JSON.stringify(body)});
        const j = await r.json();
        if(j.ok){ taskEditingId = null; await loadTasks(); }
        else alert('保存に失敗しました: ' + (j.error || ''));
      } catch(e){ alert('通信エラー'); }
    }

    // ---- 認証・画面切替 ----
    let authMode = 'login';
    function showForm(mode){
      authMode = mode;
      $('formTitle').textContent = mode==='register' ? '新規登録' : 'ログイン';
      $('submitBtn').textContent = mode==='register' ? '登録する' : 'ログイン';
      $('authForm').style.display = ''; $('authState').textContent = '';
      $('email').focus();
    }
    function hideForm(){ $('authForm').style.display='none'; $('authState').textContent=''; }
    async function submitAuth(){
      const email = $('email').value.trim(), password = $('password').value;
      if(!email || !password){ $('authState').textContent='メールとパスワードを入力'; return; }
      const path = authMode==='register' ? '/api/register' : '/api/login';
      const r = await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},
        body: JSON.stringify({email, password})});
      const j = await r.json();
      if(j.ok){ auth = {email:j.email, token:j.token}; localStorage.setItem('mb_auth', JSON.stringify(auth)); onAuthed(); }
      else $('authState').textContent = '✗ ' + (j.error || (authMode==='register'?'登録失敗':'ログイン失敗'));
    }
    function showTab(name){
      activeTab = name;
      localStorage.setItem('mb_tab', name);
      document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active', b.dataset.tab===name));
      document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('active', p.dataset.panel===name));
      refreshCurrentTab(true);
    }
    function initAuth(){ if(auth.email && auth.token) onAuthed(); }
    function onAuthed(){
      $('login').style.display = 'none';
      $('app').style.display = '';
      $('accEmail').textContent = auth.email || '';
      const savedTab = localStorage.getItem('mb_tab');
      showTab(document.querySelector('.tab[data-tab="'+savedTab+'"]') ? savedTab : 'chat');
      loadAll();
      startAutoRefresh();
      // Google OAuth から戻ってきた直後は、アカウントタブを開いて結果を表示する。
      const gq = new URLSearchParams(location.search).get('google');
      if(gq){
        history.replaceState(null, '', location.pathname);
        showTab('account');
        $('googleState').textContent =
          gq==='linked' ? '✓ Google アカウントを連携しました' :
          gq==='denied' ? '✗ 連携がキャンセルされました' :
          gq==='expired' ? '✗ 時間切れです。もう一度お試しください' : '✗ 連携に失敗しました';
      }
    }
    function logout(){
      stopAutoRefresh();
      auth = {}; localStorage.removeItem('mb_auth');
      $('app').style.display = 'none'; $('login').style.display = '';
      $('password').value = ''; hideForm();
    }
    async function changePassword(){
      const currentPassword = $('curpw').value, newPassword = $('newpw').value;
      if(!currentPassword || !newPassword){ $('pwState').textContent='両方入力してください'; return; }
      const r = await fetch('/api/change-password',{method:'POST',headers:headers(),
        body: JSON.stringify({currentPassword, newPassword})});
      const j = await r.json();
      if(j.ok){ $('pwState').textContent='✓ 変更しました'; $('curpw').value=$('newpw').value=''; }
      else $('pwState').textContent = '✗ ' + (j.error||'変更失敗');
    }
    function loadAll(){ loadTasks(); loadSummary(); loadMoodle(); loadWaseda(); loadDocs(); loadAudioWorkers(); loadAudioJobs(); loadTranscripts(); loadGoogle(); loadChatHistory(); loadGeminiKey(); }

    // ---- Google カレンダー連携（Web OAuth） ----
    let googleAccounts = [];
    function googleDefault(){
      const d = localStorage.getItem('mb_gdefault');
      return googleAccounts.includes(d) ? d : (googleAccounts[0]||'');
    }
    function setGoogleDefault(e){ localStorage.setItem('mb_gdefault', e); renderGoogleAccounts(); }
    function renderGoogleAccounts(){
      if(!googleAccounts.length){
        $('googleAccounts').innerHTML = '<p class="muted">未連携です。</p>';
      } else {
        const def = googleDefault();
        $('googleAccounts').innerHTML = googleAccounts.map(e =>
          '<div class="row" style="margin:.2rem 0; gap:.4rem">'+
          '<label style="flex:1"><input type="radio" name="gdef" '+(e===def?'checked':'')+
          ' onchange="setGoogleDefault(\\\''+escapeHtml(e)+'\\\')"> '+escapeHtml(e)+'</label>'+
          '<button class="ghost small" onclick="unlinkGoogle(\\\''+escapeHtml(e)+'\\\')">解除</button></div>').join('') +
          (googleAccounts.length>1 ? '<p class="muted" style="margin:.2rem 0">選択中のアカウントが「カレンダー登録」の登録先になります。</p>' : '');
      }
      renderTasks(); // 連携状態でタスク行の「カレンダー登録」ボタン表示が変わる
    }
    async function loadGoogle(){
      if(!auth.email) return;
      try {
        const r = await fetch('/api/google/accounts',{headers:headers()});
        const j = await r.json();
        if(!j.ok){ $('googleState').textContent = '✗ ' + (j.error||'取得失敗'); return; }
        googleAccounts = j.accounts || [];
        if(!j.configured && !googleAccounts.length){
          $('googleState').textContent = 'サーバー側の設定（GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET）が必要です';
        }
        renderGoogleAccounts();
        loadGoogleEvents();
      } catch(e){}
    }
    async function loadGoogleEvents(){
      lastGoogleRefresh = Date.now();
      // Fetch events from server even if no Google accounts are linked,
      // because the server also merges and returns smartphone local calendar events.
      try {
        const r = await fetch('/api/google/events',{headers:headers()});
        const j = await r.json();
        if(!j.ok){
          const errMsg = '<p class="muted">'+escapeHtml(j.error||'予定取得失敗')+'</p>';
          $('googleEvents').innerHTML = errMsg;
          return;
        }
        allGoogleEvents = j.events || [];
        renderCalendar();
        const evs = (j.events||[]).slice(0,8);
        const html = evs.length ? evs.map(ev =>
          '<div>・'+escapeHtml(ev.whenText)+'　'+escapeHtml(ev.title)+
          (googleAccounts.length>1 ? ' <span class="muted">('+escapeHtml((ev.accountEmail||'').split('@')[0])+')</span>' : '')+
          '</div>').join('')
        : '<p class="muted">直近の予定はありません。</p>';
        $('googleEvents').innerHTML = '<p class="muted" style="margin:.4rem 0 .2rem">直近の予定</p>' + html + (j.error ? '<p class="muted">'+escapeHtml(j.error)+'</p>' : '');
        if($('tasksCalendarEvents')){
          if(evs.length){
            $('tasksCalendarEvents').style.display = '';
            $('tasksCalendarEventsList').innerHTML = html;
          } else {
            $('tasksCalendarEvents').style.display = 'none';
          }
        }
      } catch(e){}
    }
    async function connectGoogle(){
      $('googleState').textContent = '';
      const r = await fetch('/api/google/auth-url',{headers:headers()});
      const j = await r.json();
      if(!j.ok){ $('googleState').textContent = '✗ ' + (j.error||'連携を開始できません'); return; }
      location.href = j.url; // Google の同意画面へ（戻り先は /?google=linked）
    }
    async function unlinkGoogle(email){
      await fetch('/api/google/unlink',{method:'POST',headers:headers(),
        body:JSON.stringify({googleEmail:email})});
      $('googleState').textContent = email + ' の連携を解除しました';
      loadGoogle();
    }
    async function addToCalendar(id){
      const t = allTasks.find(x=>x.id===id); if(!t) return;
      const r = await fetch('/api/google/add-event',{method:'POST',headers:headers(),
        body:JSON.stringify({googleEmail:googleDefault(), content:t.content,
          deadline:t.deadline_at, dateOnly:!!t.date_only})});
      const j = await r.json();
      if(j.ok){ $('googleState').textContent = '✓ 「'+t.content+'」を '+j.googleEmail+' に登録しました'; loadGoogleEvents(); }
      else alert('カレンダー登録失敗: ' + (j.error||''));
    }

    // ---- 音声ワーカーPC（クライアント）選択 ----
    // クライアントは3秒ごとに使用率を送ってくるので、filesタブ表示中は
    // こちらも3秒ごとに再取得して最新の値を見せる。
    function meterCell(pct, fresh){
      if(pct===null || pct===undefined || !fresh) return '<span class="muted">—</span>';
      const v = Math.round(Number(pct));
      const color = v>=90 ? '#b42318' : v>=70 ? '#b7791f' : '#117a37';
      return '<div style="min-width:70px"><span style="font-variant-numeric:tabular-nums">'+v+'%</span>'+
        '<div style="height:4px;border-radius:2px;background:#e5eaf1;margin-top:2px">'+
        '<div style="height:4px;border-radius:2px;width:'+Math.min(v,100)+'%;background:'+color+'"></div></div></div>';
    }
    async function loadAudioWorkers(){
      if(!auth.email) return;
      if(audioWorkersTimer) clearTimeout(audioWorkersTimer);
      audioWorkersTimer = null;
      try {
        const r = await fetch('/api/audio/workers',{headers:headers()});
        const j = await r.json();
        if(!j.ok){ $('audioWorkers').innerHTML='<p class="muted">'+escapeHtml(j.error||'取得失敗')+'</p>'; return; }
        if(!j.workers.length){
          $('audioWorkers').innerHTML='<p class="muted">まだクライアントPCが接続していません。PC側で audio-worker を起動すると自動でここに表示されます。</p>';
          return;
        }
        const rows = j.workers.map(w =>
          '<tr><td><label style="display:flex;align-items:center;gap:.4rem;margin:0;cursor:pointer">'+
            '<input type="checkbox" '+(w.allowed?'checked':'')+' onchange="setWorkerAllowed('+w.id+',this.checked)">'+
            '#'+w.id+'</label></td>'+
          '<td>'+escapeHtml(w.name)+
            (w.owned && w.ip ? '<div class="muted" style="font-size:.8rem">'+escapeHtml(w.ip)+'</div>' : '')+'</td>'+
          '<td>'+(w.mode==='global'
            ? '<span style="color:#1f6feb">global</span>'+(w.owned?'':'<div class="muted" style="font-size:.8rem">他ユーザー提供</div>')
            : '<span class="muted">private</span>')+'</td>'+
          '<td>'+meterCell(w.cpuPct, w.metricsFresh)+'</td>'+
          '<td>'+meterCell(w.memPct, w.metricsFresh)+'</td>'+
          '<td>'+meterCell(w.gpuPct, w.metricsFresh)+'</td>'+
          '<td>'+(w.online
            ? '<span style="color:#117a37">接続中</span>'
            : '<span class="muted">'+(w.lastSeenAt ? new Date(w.lastSeenAt).toLocaleString('ja-JP') : '未接続')+'</span>')+'</td>'+
          '<td>'+(w.owned
            ? '<span class="row" style="gap:.3rem">'+
              '<button class="ghost small" onclick="renameWorker('+w.id+')">名前変更</button>'+
              '<button class="ghost small" onclick="deleteWorker('+w.id+')">削除</button>'+
            '</span>'
            : '')+'</td></tr>').join('');
        $('audioWorkers').innerHTML =
          '<table><thead><tr><th>処理する</th><th>名前</th><th>種別</th><th>CPU</th><th>メモリ</th><th>GPU</th><th>最終接続</th><th></th></tr></thead><tbody>'+rows+'</tbody></table>';
      } catch(e){}
      finally {
        if(activeTab==='files' && !document.hidden){
          audioWorkersTimer = setTimeout(loadAudioWorkers, 3000);
        }
      }
    }
    async function setWorkerAllowed(id, allowed){
      try {
        await fetch('/api/audio/workers/'+id,{method:'POST',headers:headers(),body:JSON.stringify({allowed})});
      } finally { loadAudioWorkers(); }
    }
    async function renameWorker(id){
      const name = prompt('このPCの表示名を入力してください');
      if(!name) return;
      await fetch('/api/audio/workers/'+id,{method:'POST',headers:headers(),body:JSON.stringify({name})});
      loadAudioWorkers();
    }
    async function deleteWorker(id){
      if(!confirm('このクライアントを一覧から削除しますか？（同じPCが再接続すると新しいIDで登録されます）')) return;
      await fetch('/api/audio/workers/'+id,{method:'DELETE',headers:headers()});
      loadAudioWorkers();
    }

    // ---- 音声ジョブ状況 ----
    const AUDIO_STATUS = { queued:'待機中', processing:'処理中', done:'完了', error:'失敗' };
    async function loadAudioJobs(){
      if(!auth.email) return;
      if(audioJobsTimer) clearTimeout(audioJobsTimer);
      audioJobsTimer = null;
      try {
        const r = await fetch('/api/audio/jobs',{headers:headers()});
        const j = await r.json();
        if(!j.ok){ $('audioJobs').innerHTML='<p class="muted">'+escapeHtml(j.error||'取得失敗')+'</p>'; return; }
        if(!j.jobs.length){ $('audioJobs').innerHTML='<p class="muted">音声のアップロードはまだありません。</p>'; return; }
        const rows = j.jobs.map(a => '<tr><td>'+escapeHtml(a.filename)+'</td>'+
          '<td class="num">'+Math.round((a.size_bytes||0)/1024/1024*10)/10+' MB</td>'+
          '<td>'+(AUDIO_STATUS[a.status]||a.status)+(a.error?'<div class="muted">'+escapeHtml(a.error)+'</div>':'')+'</td>'+
          '<td>'+(a.worker_name ? escapeHtml(a.worker_name) : (a.claimed_by ? '#'+a.claimed_by : ''))+'</td>'+
          '<td>'+new Date(a.updated_at).toLocaleString('ja-JP')+'</td></tr>').join('');
        $('audioJobs').innerHTML = '<table><thead><tr><th>ファイル</th><th>サイズ</th><th>状態</th><th>処理PC</th><th>更新</th></tr></thead><tbody>'+rows+'</tbody></table>';
        // 未完了ジョブがあれば少し待って自動更新。
        if(j.jobs.some(a => a.status==='queued'||a.status==='processing')) audioJobsTimer = setTimeout(loadAudioJobs, 15000);
      } catch(e){}
    }

    // ---- Waseda アカウント連携 ----
    async function loadWaseda(){
      if(!auth.email) return;
      try {
        const r = await fetch('/api/waseda',{headers:headers()});
        const j = await r.json();
        if(j.ok){
          $('wasedaUser').value = j.wasedaUser || '';
          $('wasedaState').textContent = j.hasPassword ? '登録済み（パスワード保存済み）' : '';
        }
        // 取り込みが実行中のままならステータス表示を復元する（画面更新後も追える）。
        const s = await (await fetch('/api/waseda/sync/status',{headers:headers()})).json();
        if(s.ok && s.state==='running'){ showWasedaProgress(s.message||'取り込み中…'); pollWasedaSync(); }
        loadWasedaCourses();
      } catch(e){}
    }
    async function loadWasedaCourses(){
      try {
        const r = await fetch('/api/courses',{headers:headers()});
        const j = await r.json();
        allCourses = (j.ok && Array.isArray(j.courses)) ? j.courses : [];
        if($('wasedaCoursesBox')) $('wasedaCoursesBox').style.display = allCourses.length ? '' : 'none';
        renderCourseLists();
        renderCalendar();
      } catch(e){}
    }
    // ---- 時間割の編集（アカウント画面の一覧・カレンダー画面の日別一覧の両方から使う）----
    // 同じ科目が複数箇所（アカウント画面／カレンダーの日別一覧）に同時に描画され得るため、
    // 呼び出し元ごとに prefix を分けて要素 id を一意にする（そうしないと id 重複により、
    // 見えている方に入力しても隠れている方の古い値を保存してしまう）。
    let courseEditingKey = null; // 例: 'acct-14' | 'day-14'
    function courseRowHtml(c, prefix){
      const dayPeriod = c.day ? (c.day + '曜' + (c.period || '') + '限') : 'オンデマンド等';
      const room = c.room ? (' (' + c.room + ')') : '';
      const term = c.term ? ('[' + c.term + '] ') : '';
      if(courseEditingKey === (prefix + '-' + c.id)){
        const dayOptions = ['', '月','火','水','木','金','土','日'].map(d =>
          '<option value="' + d + '"' + (d === (c.day || '') ? ' selected' : '') + '>' + (d || '(なし/オンデマンド)') + '</option>'
        ).join('');
        return '<div class="card" style="margin:.3rem 0; padding:.5rem .7rem; background:#fff; border:1px solid var(--line); border-radius:10px">' +
          '<div class="row" style="gap:.4rem; flex-wrap:wrap">' +
          '<input id="ce_' + prefix + '_name_' + c.id + '" value="' + escapeHtml(c.name) + '" placeholder="科目名" style="flex:1; min-width:140px">' +
          '<input id="ce_' + prefix + '_term_' + c.id + '" value="' + escapeHtml(c.term || '') + '" placeholder="学期(例: 春)" style="width:90px">' +
          '<select id="ce_' + prefix + '_day_' + c.id + '" style="width:130px">' + dayOptions + '</select>' +
          '<input id="ce_' + prefix + '_period_' + c.id + '" type="number" min="1" max="7" value="' + (c.period || '') + '" placeholder="時限" style="width:70px">' +
          '<input id="ce_' + prefix + '_room_' + c.id + '" value="' + escapeHtml(c.room || '') + '" placeholder="教室" style="width:120px">' +
          '</div>' +
          '<div class="row" style="margin-top:.4rem; gap:.4rem">' +
          '<button class="small" onclick="saveCourseEdit(' + c.id + ',&#39;' + prefix + '&#39;)">保存</button>' +
          '<button class="ghost small" onclick="cancelCourseEdit()">キャンセル</button>' +
          '</div></div>';
      }
      return '<div style="padding:.3rem 0; border-bottom:1px dashed #f3f4f6; display:flex; justify-content:space-between; align-items:center; gap:.5rem">' +
        '<span>・' + term + '<strong>' + dayPeriod + '</strong> ' + escapeHtml(c.name) + escapeHtml(room) + '</span>' +
        '<span class="row" style="gap:.3rem; flex-shrink:0">' +
        '<button class="ghost small" onclick="startCourseEdit(' + c.id + ',&#39;' + prefix + '&#39;)">編集</button>' +
        '<button class="ghost small" onclick="deleteCourseRow(' + c.id + ')">削除</button>' +
        '</span></div>';
    }
    function renderCourseLists(){
      const html = allCourses.length ? allCourses.map(c => courseRowHtml(c, 'acct')).join('') : '<p class="muted">時間割が未登録です。</p>';
      if($('wasedaCourses')) $('wasedaCourses').innerHTML = html;
    }
    function startCourseEdit(id, prefix){ courseEditingKey = prefix + '-' + id; renderCourseLists(); renderSelectedDateEvents(); }
    function cancelCourseEdit(){ courseEditingKey = null; renderCourseLists(); renderSelectedDateEvents(); }
    async function saveCourseEdit(id, prefix){
      const name = $('ce_' + prefix + '_name_' + id).value.trim();
      if(!name){ alert('科目名を入力してください'); return; }
      const body = {
        name,
        term: $('ce_' + prefix + '_term_' + id).value.trim(),
        day: $('ce_' + prefix + '_day_' + id).value,
        period: $('ce_' + prefix + '_period_' + id).value ? Number($('ce_' + prefix + '_period_' + id).value) : null,
        room: $('ce_' + prefix + '_room_' + id).value.trim(),
      };
      try {
        const r = await fetch('/api/courses/' + id, {method:'PATCH', headers:headers(), body:JSON.stringify(body)});
        const j = await r.json();
        if(j.ok){ courseEditingKey = null; await loadWasedaCourses(); }
        else alert('保存に失敗しました: ' + (j.error || ''));
      } catch(e){ alert('通信エラー'); }
    }
    async function deleteCourseRow(id){
      if(!confirm('この科目を削除しますか？')) return;
      try {
        const r = await fetch('/api/courses/' + id, {method:'DELETE', headers:headers()});
        const j = await r.json();
        if(j.ok){ await loadWasedaCourses(); }
        else alert('削除に失敗しました: ' + (j.error || ''));
      } catch(e){ alert('通信エラー'); }
    }
    async function syncWasedaCoursesToGoogle(){
      $('wasedaSyncGoogleState').textContent = '同期中…';
      try {
        const r = await fetch('/api/google/sync-courses',{method:'POST',headers:headers(),
          body:JSON.stringify({googleEmail:googleDefault()})});
        const j = await r.json();
        if(j.ok){
          $('wasedaSyncGoogleState').textContent = '✓ ' + j.googleEmail + ' に ' + j.count + ' 件の授業予定を同期しました' +
            (j.skipped ? '（' + j.skipped + ' 件は登録済みのためスキップ）' : '');
          loadGoogleEvents();
        } else {
          $('wasedaSyncGoogleState').textContent = '✗ ' + (j.error||'同期失敗');
        }
      } catch(e){
        $('wasedaSyncGoogleState').textContent = '✗ 通信エラー';
      }
    }
    async function saveWaseda(){
      const wasedaUser = $('wasedaUser').value.trim(), wasedaPassword = $('wasedaPw').value;
      if(!wasedaUser){ $('wasedaState').textContent='Waseda ID を入力してください'; return; }
      const r = await fetch('/api/waseda',{method:'POST',headers:headers(),
        body:JSON.stringify({wasedaUser, wasedaPassword})});
      const j = await r.json();
      if(j.ok){ $('wasedaState').textContent='✓ 保存しました'; $('wasedaPw').value=''; }
      else $('wasedaState').textContent='✗ '+(j.error||'保存失敗');
    }
    async function clearWaseda(){
      const r = await fetch('/api/waseda',{method:'POST',headers:headers(),
        body:JSON.stringify({wasedaUser:'', wasedaPassword:''})});
      const j = await r.json();
      if(j.ok){ $('wasedaUser').value=''; $('wasedaPw').value=''; $('wasedaState').textContent='✓ 解除しました'; loadWasedaCourses(); }
      else $('wasedaState').textContent='✗ '+(j.error||'解除失敗');
    }
    // 時間割の取り込み（サーバーでスクレイパを実行し、完了まで状況をポーリング表示）。
    let wasedaPollTimer = null;
    async function syncWaseda(){
      $('wasedaState').textContent='';
      const r = await fetch('/api/waseda/sync',{method:'POST',headers:headers()});
      const j = await r.json();
      if(!j.ok && !/実行中/.test(j.error||'')){ $('wasedaState').textContent='✗ '+(j.error||'開始失敗'); return; }
      showWasedaProgress('時間割を取得しています…');
      pollWasedaSync();
    }
    function showWasedaProgress(msg){
      $('wasedaSyncBox').style.display=''; $('wasedaSyncBar').style.display='';
      $('wasedaSyncMsg').textContent = msg;
      $('wasedaSyncBtn').disabled = true;
    }
    // スクレイパの実行ログを表示欄に反映する（開いていれば末尾へ自動スクロール）。
    function updateWasedaLog(log){
      const el = $('wasedaSyncLog');
      if(!el || el.textContent === (log||'')) return;
      el.textContent = log || '';
      el.scrollTop = el.scrollHeight;
    }
    async function pollWasedaSync(){
      clearTimeout(wasedaPollTimer);
      try {
        const r = await fetch('/api/waseda/sync/status',{headers:headers()});
        const j = await r.json();
        if(j.ok){
          updateWasedaLog(j.log);
          if(j.state==='running'){
            $('wasedaSyncMsg').textContent = '取り込み中: '+(j.message||'…');
            wasedaPollTimer = setTimeout(pollWasedaSync, 3000);
            return;
          }
          $('wasedaSyncBar').style.display='none';
          $('wasedaSyncMsg').textContent = (j.state==='done' ? '✓ ' : (j.state==='error' ? '✗ ' : '')) + (j.message||'');
          if(j.state==='done'){
            loadTasks(); loadWasedaCourses();
            // Google 連携済みなら、取り込んだ時間割をそのままカレンダーへ反映する。
            if(googleAccounts.length) syncWasedaCoursesToGoogle();
          }
        }
      } catch(e){ $('wasedaSyncMsg').textContent='状況の取得に失敗しました'; }
      $('wasedaSyncBtn').disabled = false;
    }

    // ---- 資料要約 ----
    async function loadDocs(){
      if(!auth.email) return;
      try {
        const r = await fetch('/api/files',{headers:headers()});
        const j = await r.json();
        if(!j.ok || !j.documents.length){ $('docList').innerHTML=''; return; }
        $('docList').innerHTML = j.documents.map(d =>
          '<details style="margin:.3rem 0"><summary>'+escapeHtml(d.name)+'</summary>'+
          '<div style="white-space:pre-wrap;line-height:1.6;margin-top:.4rem">'+escapeHtml(d.summary)+'</div></details>'
        ).join('');
      } catch(e){}
    }
    async function uploadDoc(){
      const f = $('docFile').files[0];
      if(!f){ $('docState').textContent='ファイルを選んでください'; return; }
      $('docState').textContent='要約中…';
      try {
        const isTxt = /\.txt$/i.test(f.name) || f.type==='text/plain';
        const h = { 'X-Account-Email': auth.email||'', 'Authorization':'Bearer '+(auth.token||''),
                    'X-Filename': f.name, 'Content-Type': isTxt ? 'text/plain' : 'application/pdf' };
        const body = isTxt ? await f.text() : await f.arrayBuffer();
        const r = await fetch('/api/files',{method:'POST',headers:h,body});
        const j = await r.json();
        if(j.ok){ $('docState').textContent='✓ 要約しました'; $('docFile').value=''; loadDocs(); }
        else $('docState').textContent='✗ '+(j.error||'失敗');
      } catch(e){ $('docState').textContent='✗ 通信エラー'; }
    }

    // ---- Gemini API キー（ユーザーごとの登録制） ----
    async function loadGeminiKey(){
      if(!auth.email) return;
      try {
        const r = await fetch('/api/gemini-key',{headers:headers()});
        const j = await r.json();
        if(!j.ok) return;
        $('geminiKeyState').textContent = j.hasKey
          ? '登録済み'+(j.tail ? '（****'+j.tail+'）' : '')+' / モデル: '+j.model
          : '未登録（AI機能を使うには登録が必要です）';
      } catch(e){}
    }
    async function saveGeminiKey(){
      const apiKey = $('geminiKey').value.trim();
      if(!apiKey){ $('geminiKeyState').textContent = '✗ APIキーを入力してください'; return; }
      $('geminiKeyState').textContent = '確認中…';
      try {
        const r = await fetch('/api/gemini-key',{method:'POST',headers:headers(),body:JSON.stringify({apiKey})});
        const j = await r.json();
        if(j.ok){ $('geminiKey').value=''; $('geminiKeyState').textContent = '✓ 登録しました（****'+j.tail+'）'; }
        else $('geminiKeyState').textContent = '✗ '+(j.error||'登録失敗');
      } catch(e){ $('geminiKeyState').textContent = '✗ 通信エラー'; }
    }
    async function deleteGeminiKey(){
      if(!confirm('登録済みの Gemini API キーを削除しますか？AI機能が使えなくなります。')) return;
      const r = await fetch('/api/gemini-key',{method:'DELETE',headers:headers()});
      const j = await r.json();
      if(j.ok){ $('geminiKeyState').textContent = '削除しました'; loadGeminiKey(); }
      else $('geminiKeyState').textContent = '✗ '+(j.error||'削除失敗');
    }

    // ---- Moodle 連携 ----
    async function loadMoodle(){
      if(!auth.email) return;
      try {
        const r = await fetch('/api/moodle',{headers:headers()});
        const j = await r.json();
        if(j.ok) $('moodleUrl').value = j.url || '';
      } catch(e){}
    }
    async function saveMoodle(){
      const url = $('moodleUrl').value.trim();
      const r = await fetch('/api/moodle',{method:'POST',headers:headers(),body:JSON.stringify({url})});
      const j = await r.json();
      $('moodleState').textContent = j.ok ? '✓ 保存しました' : ('✗ '+(j.error||'保存失敗'));
    }
    async function syncMoodle(){
      $('moodleState').textContent = '同期中…';
      const r = await fetch('/api/moodle/sync',{method:'POST',headers:headers()});
      const j = await r.json();
      if(j.ok){ $('moodleState').textContent = '✓ '+j.imported+' 件取り込みました'; loadTasks(); }
      else $('moodleState').textContent = '✗ '+(j.error||'同期失敗');
    }

    // ---- 文字起こし一覧 ----
    async function loadTranscripts(){
      if(!auth.email) return;
      try {
        const r = await fetch('/api/transcripts?limit=100',{headers:headers()});
        const j = await r.json();
        if(!j.ok){
          $('transcripts').innerHTML = '<p class="muted">'+escapeHtml(j.error||'取得に失敗しました')+'</p>';
          return;
        }
        const list = Array.isArray(j.transcripts) ? j.transcripts : [];
        if(!list.length){
          $('transcripts').innerHTML = '<p class="muted">まだファイルがありません。</p>';
          return;
        }
        const rows = list.map(t => {
          const analyzed = !!t.analyzed_at;
          const csvLinks = analyzed
            ? '<button class="small" onclick="downloadFile(\\'/kadai/'+t.id+'.csv\\', \\'kadai-'+t.id+'.csv\\')">課題CSV</button> ' +
              '<button class="small" onclick="downloadFile(\\'/yotei/'+t.id+'.csv\\', \\'yotei-'+t.id+'.csv\\')">予定CSV</button>'
            : '<span class="pending">未解析</span>';
          return '<tr>'+
            '<td>'+escapeHtml(t.filename)+'</td>'+
            '<td class="num">'+(t.chars || 0)+'</td>'+
            '<td>'+new Date(t.updated_at).toLocaleString('ja-JP')+'</td>'+
            '<td><button class="small" onclick="viewText('+t.id+')">本文</button> '+
            '<button class="small" onclick="downloadFile(\\'/download/'+t.id+'\\', '+JSON.stringify(t.filename || ('transcript-'+t.id+'.txt'))+')">DL</button></td>'+
            '<td>'+csvLinks+'</td>'+
          '</tr>';
        }).join('');
        $('transcripts').innerHTML =
          '<table><thead><tr><th>ファイル名</th><th>文字数</th><th>更新</th><th></th><th>課題/予定</th></tr></thead>'+
          '<tbody>'+rows+'</tbody></table>';
      } catch(e){
        $('transcripts').innerHTML = '<p class="muted">取得に失敗しました。</p>';
      }
    }

    // ---- 本文表示（モーダル） ----
    async function viewText(id){
      $('modalTitle').textContent = '読み込み中…'; $('modalBody').textContent = '';
      $('modal').style.display = 'flex';
      try {
        const r = await fetch('/api/transcripts/'+id, {headers: headers()});
        const j = await r.json();
        if(j.ok){
          const t = j.transcript || {};
          $('modalTitle').textContent = t.filename || '';
          $('modalBody').textContent = (t.summary ? '【要約】\\n'+t.summary+'\\n\\n【本文】\\n' : '') + (t.content || '');
        } else { $('modalTitle').textContent = 'エラー'; $('modalBody').textContent = j.error||''; }
      } catch(e){ $('modalTitle').textContent='通信エラー'; }
    }

    async function downloadFile(path, fallbackName){
      try {
        const r = await fetch(path, {headers: headers()});
        if(!r.ok){
          alert('ダウンロードに失敗しました');
          return;
        }
        const blob = await r.blob();
        let filename = fallbackName || 'download';
        const cd = r.headers.get('Content-Disposition') || '';
        const m = cd.match(/filename\\*=UTF-8''([^;]+)/);
        if(m) filename = decodeURIComponent(m[1]);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch(e){
        alert('ダウンロードに失敗しました');
      }
    }
    function closeModal(){ $('modal').style.display = 'none'; }

    // ---- チャット ----
    function bubble(text, who){
      const d = document.createElement('div');
      d.className = 'bubble '+who; d.textContent = text;
      $('chatlog').appendChild(d); $('chatlog').scrollTop = $('chatlog').scrollHeight;
    }
    // 画面を開き直しても会話が途切れないよう、保存済みの履歴を読み込んで表示する。
    async function loadChatHistory(){
      if(!auth.email) return;
      try {
        const r = await fetch('/api/chat/history',{headers:headers()});
        const j = await r.json();
        if(j.ok && Array.isArray(j.messages) && j.messages.length){
          $('chatlog').innerHTML = '';
          j.messages.forEach(m => bubble(m.content, m.role === 'user' ? 'me' : 'bot'));
        }
      } catch(e){}
    }
    async function ask(){
      const q = $('q').value.trim(); if(!q) return;
      $('q').value=''; bubble(q,'me');
      try{
        const r = await fetch('/api/ask',{method:'POST',headers:headers(),body:JSON.stringify({question:q})});
        const j = await r.json();
        bubble(j.ok ? j.reply : ('エラー: '+(j.error||'')), 'bot');
        if(j.ok){
          // 実際に登録・完了された内容を明示する（言っただけで登録されていない事故の可視化）。
          if(Array.isArray(j.applied) && j.applied.length){
            bubble(j.applied.map(a => a.op==='add_task'
              ? '✓ 登録: '+(a.type==='yotei'?'予定':'課題')+'「'+a.content+'」'+(a.deadline_at?'（期限 '+String(a.deadline_at).slice(0,16).replace('T',' ')+'）':'（期限未設定）')
              : (a.op==='delete_task'
                ? '✓ 削除: 「'+(a.content||'')+'」'
                : (a.op==='update_task'
                  ? '✓ 変更: 「'+(a.content||'')+'」'+(a.deadline_at?'（'+String(a.deadline_at).slice(0,16).replace('T',' ')+'）':'')
                  : '✓ 完了: 「'+(a.content||'')+'」'))).join('\\n'), 'bot');
          }
          loadTasks();
        }
      }catch(e){ bubble('通信エラー','bot'); }
    }

    // ---- タスク ----
    let allTasks = [];
    // deadline_at ("YYYY-MM-DD HH:MM:SS" 等) を Date に。不正なら null。
    function parseDeadline(s){
      if(!s) return null;
      const d = new Date(String(s).replace(' ','T'));
      return isNaN(d.getTime()) ? null : d;
    }
    function dueClass(at){
      const d = parseDeadline(at); if(!d) return '';
      const ms = d - new Date();
      if(ms < 3600e3) return 'soon';
      if(ms < 86400e3) return 'warn';
      return '';
    }
    // 期限を { base:日時, rel:相対 } に分けて返す（列で2行に分けて表示するため）。
    function dueParts(t){
      const d = parseDeadline(t.deadline_at); if(!d) return { base:'期限未定', rel:'' };
      const s = t.deadline_at;
      const base = t.date_only ? s.slice(0,10) : s.slice(0,16);
      const ms = d - new Date();
      let rel;
      if(ms < 0) rel = '期限切れ';
      else { const h = Math.floor(ms/3600e3);
        rel = h < 24 ? 'あと'+h+'時間' : 'あと'+Math.floor(h/24)+'日'; }
      return { base, rel };
    }
    async function loadTasks(){
      if(!auth.email) return;
      const r = await fetch('/api/tasks?done=1',{headers:headers()});
      const j = await r.json();
      if(!j.ok){ $('tasks').innerHTML='<p class="muted">'+escapeHtml(j.error||'取得に失敗しました')+'</p>'; return; }
      allTasks = Array.isArray(j.tasks) ? j.tasks : [];
      renderTasks();
      renderCalendar();
    }
    function clearTaskPeriod(){ $('taskFrom').value=''; $('taskTo').value=''; renderTasks(); }

    // 絞り込み（状態・種別・期間・キーワード）＋並び替え。
    function renderTasks(){
      const f = ($('taskFilter')||{}).value || 'pending';
      const type = ($('taskType')||{}).value || 'all';
      const sort = ($('taskSort')||{}).value || 'due-asc';
      const q = (($('taskSearch')||{}).value || '').trim().toLowerCase();
      const from = ($('taskFrom')||{}).value ? new Date(($('taskFrom').value)+'T00:00:00') : null;
      const to = ($('taskTo')||{}).value ? new Date(($('taskTo').value)+'T23:59:59') : null;
      const now = new Date();
      let list = allTasks.slice();

      // 状態
      if(f==='pending') list = list.filter(t => t.status!=='done');
      else if(f==='active') list = list.filter(t => { if(t.status==='done') return false; const d=parseDeadline(t.deadline_at); return !d || d>=now; });
      else if(f==='overdue') list = list.filter(t => { const d=parseDeadline(t.deadline_at); return d && d<now && t.status!=='done'; });
      // 種別
      if(type==='kadai') list = list.filter(t => t.type==='kadai');
      else if(type==='yotei') list = list.filter(t => t.type==='yotei');
      // キーワード
      if(q) list = list.filter(t => ((t.content||'')+' '+(t.details||'')).toLowerCase().includes(q));
      // 期間（締切が範囲内。期限未定は範囲指定時は除外）
      if(from || to) list = list.filter(t => { const d=parseDeadline(t.deadline_at); if(!d) return false; if(from && d<from) return false; if(to && d>to) return false; return true; });

      // 並び替え
      const val = t => { const d=parseDeadline(t.deadline_at); return d ? d.getTime() : null; };
      if(sort==='new') list.sort((a,b) => (b.id||0)-(a.id||0));
      else list.sort((a,b) => {
        const av=val(a), bv=val(b);
        if(av==null && bv==null) return 0;
        if(av==null) return 1;      // 未定は末尾
        if(bv==null) return -1;
        return sort==='due-desc' ? bv-av : av-bv;
      });

      if(!list.length){ $('tasks').innerHTML='<p class="muted">該当する項目はありません。</p>'; return; }
      const rows = list.map(t => {
        const done = t.status==='done';
        const label = t.type==='yotei' ? '予定' : '課題';
        const details = t.details ? '<div class="muted">'+escapeHtml(t.details)+'</div>' : '';
        const due = dueParts(t);
        const dueHtml = escapeHtml(due.base) +
          (due.rel ? '<div class="rel">'+escapeHtml(due.rel)+'</div>' : '');
        return '<tr>'+
          '<td class="col-type"><span class="badge '+(t.type==='yotei'?'yotei':'kadai')+'">'+label+'</span></td>'+
          '<td class="'+(done?'done':'')+'">'+escapeHtml(t.content)+details+'</td>'+
          '<td class="col-due due '+dueClass(t.deadline_at)+'">'+dueHtml+'</td>'+
          '<td class="col-mid"><input type="checkbox" '+(done?'checked':'')+
            ' onchange="toggle('+t.id+',this.checked)"></td>'+
          '<td class="col-mid"><button class="ghost small" onclick="delTask('+t.id+')">削除</button>'+
            (googleAccounts.length && t.deadline_at ?
              '<button class="ghost small" title="Google カレンダーに登録" onclick="addToCalendar('+t.id+')">📅</button>' : '')+
          '</td>'+
        '</tr>';
      }).join('');
      $('tasks').innerHTML =
        '<table><thead><tr><th>種別</th><th>内容</th><th>期限</th><th>完了</th><th></th></tr></thead>'+
        '<tbody>'+rows+'</tbody></table>';
    }
    async function toggle(id, done){
      await fetch('/api/tasks/'+id+'/done',{method:'POST',headers:headers(),
        body:JSON.stringify({status: done?'done':'pending'})}); loadTasks();
    }
    async function delTask(id){
      await fetch('/api/tasks/'+id,{method:'DELETE',headers:headers()}); loadTasks();
    }
    async function addTask(){
      const body = { type:$('t_type').value, content:$('t_content').value.trim(),
        details:$('t_details').value.trim(), deadline:$('t_deadline').value };
      if(!body.content) return;
      await fetch('/api/tasks',{method:'POST',headers:headers(),body:JSON.stringify(body)});
      $('t_content').value=$('t_details').value=$('t_deadline').value=''; loadTasks();
    }

    // ---- 要約 ----
    async function loadSummary(){
      if(!auth.email) return;
      const r = await fetch('/api/summary/today',{headers:headers()});
      const j = await r.json();
      $('summary').innerHTML = (j.ok && j.summary)
        ? '<div style="white-space:pre-wrap;line-height:1.5">'+escapeHtml(j.summary)+'</div>'
        : '<p class="muted">まだ今日の要約はありません。「今すぐ生成し直す」を押すか、録音がたまると自動生成されます。</p>';
    }
    async function genSummary(){
      if(!auth.email) return;
      $('summary').innerHTML='<p class="muted">生成中…</p>';
      const r = await fetch('/api/summary/today/generate',{method:'POST',headers:headers()});
      const j = await r.json();
      $('summary').innerHTML = (j.ok && j.summary)
        ? '<div style="white-space:pre-wrap;line-height:1.5">'+escapeHtml(j.summary)+'</div>'
        : '<p class="muted">'+(j.error || '今日の文字起こしがまだありません。')+'</p>';
    }

    function escapeHtml(s){ return String(s).replace(/[&<>"']/g,c=>(
      {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
    initAuth();
  </script>
</body>
</html>`;
}

async function main() {
  try {
    await db.ensureSchema();
    console.log("DB スキーマを確認しました");
  } catch (e) {
    console.error("DB 初期化に失敗（接続情報を確認してください）:", e.message);
  }
  // リマインド監視・日次要約ジョブを開始。
  reminders.start(resolveLineTarget);
  // Moodle の定期同期を開始。
  moodle.start();
  // 音声文字起こしワーカーを開始。
  audio.start();

  app.listen(PORT, () => {
    console.log(`AIHelper listening on http://localhost:${PORT}`);
    console.log(`accounts: ${ACCOUNTS_FILE}`);
    console.log(`DB: ${process.env.DB_NAME || "aihelper"}@${process.env.DB_HOST || "localhost"}`);
    console.log(`Gemini: ユーザーごとのAPIキー登録制 (モデル ${gemini.MODEL}) / LINE: ${line.isConfigured() ? "有効" : "未設定"}`);
    scheduleDailySummaryPregeneration();
    if (line.isConfigured()) {
      scheduleDailySummary();
    } else {
      console.log("LINE_CHANNEL_ACCESS_TOKEN が未設定のため日次サマリは無効です");
    }
  });
}

main();
