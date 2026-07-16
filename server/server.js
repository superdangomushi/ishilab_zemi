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
const conflicts = require("./conflicts");
const moodle = require("./moodle");
const audio = require("./audio");
const google = require("./google");
const {
  ACCOUNTS_FILE, loadAccounts, hashPassword, verifyPassword, genToken,
  resolveAccount, resolveLineTarget, isLoginBlocked, recordLoginFailure,
  recordLoginSuccess, authFromReq, authFromJsonBody,
} = require("./auth");
const { renderDashboard } = require("./dashboard");

const PORT = process.env.PORT || 3000;
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

// 認証・パスワードハッシュ・ログイン試行制限は auth.js、
// Waseda パスワード等の可逆暗号化（AES-256-GCM）は cred.js に切り出した。

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
    // 同期されたカレンダー予定同士・「予定」タスクとの時間帯重複（ダブルブッキング）を
    // チェックして通知する。同期の応答は待たせない（失敗しても同期自体は成功扱い）。
    conflicts.checkCalendarConflicts(account.email, events).catch((e) => {
      console.error("カレンダー同期の重複チェックに失敗:", e.message);
    });
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
    res.json({ ok: true });
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

// ---- Gemini 自動解析の on/off（ユーザーごと） ----
// off にすると、文字起こしの保存時に課題/予定抽出・要約が自動では走らず、
// ダッシュボードの「解析する」ボタンを押したときだけ実行される。

app.get("/api/gemini-auto", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  try {
    const enabled = await db.getGeminiAuto(account.email);
    res.json({ ok: true, enabled });
  } catch (e) {
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

app.post("/api/gemini-auto", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  const enabled = req.body?.enabled;
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ ok: false, error: "enabled を true/false で指定してください" });
  }
  try {
    const n = await db.setGeminiAuto(account.email, enabled);
    if (!n) {
      return res.status(400).json({ ok: false, error: "このアカウントでは設定を保存できません（Web登録のアカウントでログインしてください）" });
    }
    res.json({ ok: true, enabled });
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

// 音声ジョブの処理状況一覧。active=1 で未処理（queued）・処理中（processing）・
// 失敗（error）だけに絞る（ダッシュボードはこちらを使う。完了分は表示しない）。
app.get("/api/audio/jobs", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  try {
    const activeOnly = req.query.active === "1" || req.query.active === "true";
    const jobs = await db.listAudioJobs(account.email, { limit: Number(req.query.limit) || 30, activeOnly });
    res.json({ ok: true, jobs });
  } catch (e) {
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

// 失敗（error）で保留された音声ジョブを待機列に戻す（ダッシュボードの「再試行」）。
// 上限回数の自動再試行を使い切ったジョブも、これで attempts が 0 に戻り再処理される。
app.post("/api/audio/jobs/:id/retry", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  try {
    const r = await audio.retryJob(account.email, req.params.id);
    if (!r.ok) return res.status(r.status || 500).json({ ok: false, error: r.error });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

// 失敗（error）で保留された音声ジョブを削除する（ダッシュボードの一括削除用）。
// 保持していた音声ファイルも一緒に消える。error 以外の状態は削除できない。
app.delete("/api/audio/jobs/:id", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  try {
    const r = await audio.deleteJob(account.email, req.params.id);
    if (!r.ok) return res.status(r.status || 500).json({ ok: false, error: r.error });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

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
          // （未設定なら利用しない扱い＝デフォルト未選択のオプトイン）。
          allowed: owned ? Boolean(w.allowed) : Boolean(w.pref_allowed),
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

// =====================================================================
// 音声ワーカークライアント用 JSON API（/api/client/*）
//
// すべて POST + JSON ボディ。毎リクエストに認証情報（auth.email / auth.token）と、
// クライアントが初回起動時に自分で生成した UUID（clientId）を含める。
// 旧ヘッダー方式（X-Worker-* / 接続元IPによる同一PC推定）は廃止した:
// なりすましたクライアントが音声を取得できないよう、
//   - clientId は登録済みかつ認証アカウントの所有であること
//   - ダウンロード/結果送信は「その clientId のワーカーが claim したジョブ」に限ること
// をすべてのエンドポイントで検証する。
// =====================================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


function clientIdFromBody(req) {
  const raw = String(req.body?.clientId || "").trim().toLowerCase();
  return UUID_RE.test(raw) ? raw : null;
}

// 認証 + clientId から登録済みワーカーを特定する共通処理。
// 失敗時はレスポンスを書いて null を返す（呼び出し側は return するだけ）。
async function requireClientWorker(req, res) {
  const account = await authFromJsonBody(req);
  if (!account) {
    res.status(401).json({ ok: false, error: "アカウント情報が一致しません" });
    return null;
  }
  const clientId = clientIdFromBody(req);
  if (!clientId) {
    res.status(400).json({ ok: false, error: "clientId（UUID）をJSONボディで指定してください" });
    return null;
  }
  const worker = await db.getAudioWorkerByUuid(account.email, clientId);
  if (!worker) {
    res.status(403).json({
      ok: false,
      code: "unregistered",
      error: "このPCは未登録です。クライアントの初回登録（/api/client/register）をやり直してください",
    });
    return null;
  }
  return { account, worker };
}

// クライアント初回起動の「アカウント作成フェーズ」: クライアントが生成した UUID と
// ユーザーが決めた表示名でこのPCを登録する。再実行は表示名・モードの更新になる。
// UUID が他アカウントで使用済みなら 409（クライアント側で再生成して再登録する）。
app.post("/api/client/register", async (req, res) => {
  const account = await authFromJsonBody(req);
  if (!account) return res.status(401).json({ ok: false, error: "アカウント情報が一致しません" });
  const clientId = clientIdFromBody(req);
  if (!clientId) return res.status(400).json({ ok: false, error: "clientId（UUID形式）を指定してください" });
  const name = String(req.body?.name || "").trim().slice(0, 255);
  if (!name) return res.status(400).json({ ok: false, error: "このPCの表示名（name）を指定してください" });
  const mode = req.body?.mode === "global" ? "global" : "private";
  try {
    const worker = await db.registerAudioWorker(account.email, clientId, { name, mode, ip: clientIpOf(req) });
    if (worker.conflict) {
      return res.status(409).json({
        ok: false,
        code: "uuid_conflict",
        error: "このIDは他のアカウントで使用されています。クライアント側でIDを再生成してください",
      });
    }
    console.log(`ワーカー登録: ${account.email} clientId=${clientId} name=${name} (${worker.mode || mode})`);
    res.json({
      ok: true,
      client: { clientId, name: worker.name, mode: worker.mode || "private", allowed: Boolean(worker.allowed) },
    });
  } catch (e) {
    console.error("ワーカー登録に失敗:", e.message);
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

// queued 音声ジョブを1件確保する。ユーザーが許可したPCにだけジョブを渡す。
// 複数のワーカーPCが同時にポーリングしても claim は1件ずつ原子的に確保される。
app.post("/api/client/claim", async (req, res) => {
  try {
    const ctx = await requireClientWorker(req, res);
    if (!ctx) return;
    const { account, worker } = ctx;
    // クライアントが申告する現在のモード。変わっていればサーバー側にも反映する。
    const declaredMode = req.body?.mode === "global" || req.body?.mode === "private" ? req.body.mode : null;
    if (declaredMode && declaredMode !== worker.mode) {
      await db.setAudioWorkerMode(worker.id, declaredMode);
      worker.mode = declaredMode;
    }
    const base = {
      ok: true,
      client: { clientId: worker.client_uuid, name: worker.name, mode: worker.mode || "private", allowed: Boolean(worker.allowed) },
    };
    if (!worker.allowed) return res.json({ ...base, job: null });
    // global のPCは、所有者本人と、そのPCの利用を明示的に許可したユーザーの
    // ジョブだけを処理対象にする（オプトイン。未設定ユーザーのジョブは流れない）。
    const global = worker.mode === "global" && declaredMode === "global";
    const job = await audio.claimRemoteJob(account.email, worker.id, { global });
    if (!job) return res.json({ ...base, job: null });
    res.json({
      ...base,
      job: {
        jobId: job.id,
        filename: job.filename,
        mime: job.mime,
        sizeBytes: job.sizeBytes,
        quality: job.quality,
      },
    });
  } catch (e) {
    console.error("ワーカーのジョブ確保に失敗:", e.message);
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

// リソース使用率（CPU/メモリ/GPU）の報告と処理中ジョブのハートビート。
app.post("/api/client/metrics", async (req, res) => {
  const pct = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(Math.max(n, 0), 100) : null;
  };
  try {
    const ctx = await requireClientWorker(req, res);
    if (!ctx) return;
    const { worker } = ctx;
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
    res.json({ ok: true });
  } catch (e) {
    console.error("ワーカーのメトリクス保存に失敗:", e.message);
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

// claim 済みジョブの音声本体をダウンロードする。認証情報 + clientId + jobId を
// JSON で受け、その clientId のワーカーが自分で claim したジョブ以外は 404。
app.post("/api/client/jobs/download", async (req, res) => {
  try {
    const ctx = await requireClientWorker(req, res);
    if (!ctx) return;
    const { account, worker } = ctx;
    const jobId = Number(req.body?.jobId);
    if (!Number.isInteger(jobId) || jobId <= 0) {
      return res.status(400).json({ ok: false, error: "jobId を指定してください" });
    }
    const job = await audio.getClaimedJob(account.email, jobId, worker.id);
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
    console.error("ワーカーの音声取得に失敗:", e.message);
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

// ローカルPCで文字起こしした結果（text）またはエラーを返す。
// download と同じ厳格な照合（claim したワーカー本人のみ）を通る。
app.post("/api/client/jobs/result", async (req, res) => {
  try {
    const ctx = await requireClientWorker(req, res);
    if (!ctx) return;
    const { account, worker } = ctx;
    const jobId = Number(req.body?.jobId);
    if (!Number.isInteger(jobId) || jobId <= 0) {
      return res.status(400).json({ ok: false, error: "jobId を指定してください" });
    }
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    const error = req.body?.error ? String(req.body.error) : "";
    if (!text && !error) {
      return res.status(400).json({ ok: false, error: "text または error を指定してください" });
    }
    const result = await audio.completeRemoteJob(account.email, jobId, { text, error, workerId: worker.id });
    if (!result.ok) return res.status(result.status || 500).json({ ok: false, error: result.error });
    res.json(result);
  } catch (e) {
    console.error("ワーカーの結果保存に失敗:", e.message);
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

// Gemini 解析（課題/予定抽出 → タスク登録 → 変更/取消の反映）の共通パイプライン。
// 自動解析（/api/upload）と手動解析（/api/transcripts/:id/analyze）の両方から使う。
async function runAnalysisPipeline(email, transcriptId, content) {
  const result = await gemini.analyze(email, content);
  await db.saveAnalysis(transcriptId, result.kadai, result.yotei, result.summary);
  await db.upsertTasks(email, result.tasks, transcriptId);
  const updated = await db.applyTaskUpdates(email, result.updates);
  const canceled = await db.cancelTasks(email, result.cancellations);
  return { ...result, updated, canceled };
}

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
  // 自動解析 off のユーザーはスキップ（「解析する」ボタンでの手動実行に任せる）。
  let analyzed = false;
  let taskCount = 0;
  const geminiAuto = await db.getGeminiAuto(account.email).catch(() => true);
  if (id != null && geminiAuto && (await gemini.isConfiguredFor(account.email))) {
    try {
      const result = await runAnalysisPipeline(account.email, id, content);
      taskCount = result.tasks.length;
      analyzed = true;
      console.log(
        `解析: ${safeName} -> タスク ${taskCount} 件 / 変更 ${result.updated.length} 件 / 削除 ${result.canceled.length} 件 / ` +
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
// contains=文字列 で「本文にその文字列を含むファイル」だけに絞れる（履歴画面の全文検索用）。
app.get("/api/transcripts", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);
  const contains = String(req.query.contains || "").trim().slice(0, 200) || null;
  try {
    const transcripts = await db.listTranscriptsByEmail(account.email, limit, { contains });
    res.json({ ok: true, transcripts });
  } catch (e) {
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

// 手動解析: 自動解析を off にしているユーザーが「解析する」ボタンで実行する
// （on のユーザーが解析し直すのにも使える）。要約・課題/予定抽出・タスク登録まで走る。
app.post("/api/transcripts/:id/analyze", heavyLimiter, async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  try {
    const row = await db.getTranscriptForEmail(account.email, req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: "見つかりません" });
    if (!(await gemini.isConfiguredFor(account.email))) {
      return res.status(400).json({ ok: false, error: gemini.NO_KEY_MESSAGE });
    }
    const result = await runAnalysisPipeline(account.email, row.id, row.content);
    console.log(
      `手動解析: ${account.email} ${row.filename} -> タスク ${result.tasks.length} 件 / ` +
        `変更 ${result.updated.length} 件 / 削除 ${result.canceled.length} 件`
    );
    res.json({
      ok: true,
      analyzed: true,
      tasks: result.tasks.length,
      summary: result.summary || "",
    });
  } catch (e) {
    if (handleBadGeminiKey(res, e)) return;
    console.error(`手動解析に失敗 (${account.email}):`, e.message);
    res.status(500).json({ ok: false, error: serverErr(e) });
  }
});

// 一括解析: 未解析（analyzed_at IS NULL）の文字起こしをまとめて解析する。
// Gemini 呼び出しは1件ずつ直列に行うため、1リクエストあたりの件数を絞り、
// まだ残りがあれば remaining で返す（クライアントは remaining が 0 になるまで続けて呼ぶ）。
const BULK_ANALYZE_BATCH = 10;
app.post("/api/transcripts/analyze-unanalyzed", heavyLimiter, async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  if (!(await gemini.isConfiguredFor(account.email))) {
    return res.status(400).json({ ok: false, error: gemini.NO_KEY_MESSAGE });
  }
  try {
    const rows = await db.listUnanalyzedTranscripts(account.email, BULK_ANALYZE_BATCH);
    let analyzed = 0;
    const failed = [];
    for (const row of rows) {
      try {
        await runAnalysisPipeline(account.email, row.id, row.content);
        analyzed++;
      } catch (e) {
        console.error(`一括解析に失敗 (${account.email} ${row.filename}):`, e.message);
        failed.push({ id: row.id, filename: row.filename, error: String(e.message || "").slice(0, 200) });
        // キーが無効なら以降も全件失敗するので打ち切る。
        if (String(e.message || "").includes("API key not valid")) break;
      }
    }
    const remaining = await db.countUnanalyzedTranscripts(account.email);
    console.log(
      `一括解析: ${account.email} -> 成功 ${analyzed} 件 / 失敗 ${failed.length} 件 / 残り ${remaining} 件`
    );
    res.json({ ok: true, analyzed, failed, remaining });
  } catch (e) {
    console.error(`一括解析に失敗 (${account.email}):`, e.message);
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
    // 文字起こしの時間インデックス（ファイル名＋その時間帯の授業名。本文なし）。
    // Gemini はここから読みたいファイルを need_files で指名でき、指名があれば
    // そのファイルの本文だけを取得して2回目の呼び出しで回答させる（トークン節約）。
    const fileIndex = buildTranscriptIndex(await db.listTranscriptIndex(account.email), courses);
    const askCtx = {
      tasks, summaries, calendar, courses, documents, snippets, targetDay, dayTranscripts, history, fileIndex,
    };
    let result = await gemini.ask(account.email, question, askCtx);

    if (result.needFiles && result.needFiles.length > 0) {
      // 実在する本人のファイル名だけに絞ってから本文を取得する。
      const known = new Set(fileIndex.map((f) => f.filename));
      const wanted = result.needFiles.filter((f) => known.has(f));
      const fetchedTranscripts = wanted.length
        ? await db.getTranscriptsByFilenames(account.email, wanted, { maxFiles: 5 })
        : [];
      if (fetchedTranscripts.length > 0) {
        result = await gemini.ask(account.email, question, { ...askCtx, fetchedTranscripts });
      } else if (!result.reply) {
        // ファイルを読みたがったが実在しなかった（reply は空で返る想定）。空応答のまま返さない。
        result.reply = "関連する録音の記録を探しましたが、該当するファイルが見つかりませんでした。";
      }
    }

    // Gemini が返した操作を実行する。
    const applied = [];
    // 追加された「予定」（あとで Google カレンダー登録・重複チェックに使う）。
    const addedYotei = [];
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
        if (a.type === "yotei" && a.deadline_at) {
          addedYotei.push({ title: a.content, deadline_at: a.deadline_at, date_only: !!a.date_only });
        }
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
          if (t.type === "yotei" && t.deadline_at) {
            addedYotei.push({ title: t.content, deadline_at: t.deadline_at, date_only: !!t.date_only });
          }
        }
        if (!fallback.length) {
          reply += "\n（※すみません、今回は登録できていません。「〇月〇日に△△を予定に入れて」の形でもう一度お願いします）";
        }
      } catch (e) {
        console.error("ask の登録フォールバックに失敗:", e.message);
      }
    }

    // 追加された「予定」について:
    // 1) 既存の予定・カレンダーイベントと時間帯が重なっていないか（ダブルブッキング）を
    //    確認し、重なっていれば返信に警告を足して LINE/アプリ通知にも記録する。
    // 2) Google 連携済みなら Google カレンダーにも登録する
    //    （従来はサーバー内のタスク表に入るだけでカレンダーに反映されなかった）。
    if (addedYotei.length) {
      const busy = [
        ...tasks
          .filter((t) => t.type === "yotei" && t.status !== "done" && t.deadline_at && !t.date_only)
          .map((t) => ({ title: t.content, startMillis: conflicts.millisOf(t.deadline_at) })),
        ...calendar.map((ev) => ({ title: ev.title, startMillis: ev.startMillis || 0 })),
      ];
      for (const ev of addedYotei) {
        if (ev.date_only) continue;
        const item = { title: ev.title, startMillis: conflicts.millisOf(ev.deadline_at) };
        if (!(item.startMillis > 0)) continue;
        const found = conflicts.findConflicts(item, busy);
        if (found.length) {
          reply += `\n\n⚠️ ${found.map((c) => `「${c.title}」`).join("・")}と時間が重なっています（ダブルブッキングの可能性）。`;
          try {
            await conflicts.notifyConflict(account.email, item, found);
          } catch (ce) {
            console.error("ダブルブッキング通知に失敗:", ce.message);
          }
        }
        // 同じ発話で複数の予定が追加されたとき、新規予定同士の重複も見られるようにする。
        busy.push(item);
      }
      try {
        const gAccounts = await db.listGoogleAccounts(account.email);
        if (gAccounts.length) {
          const token = await google.accessTokenOf(decryptCred(gAccounts[0].refresh_token));
          for (const ev of addedYotei) {
            await google.insertEvent(token, ev.title, ev.deadline_at, ev.date_only);
          }
          reply += "\n（Google カレンダーにも登録しました）";
        }
      } catch (ge) {
        console.error("Google カレンダーへの予定登録に失敗:", ge.message);
        reply += "\n（Google カレンダーへの登録には失敗しました）";
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

// 文字起こしの時間インデックスを作る。
// ファイル名 "YYYY-MM-DD_HH.txt" の日付・時刻を履修時間割（曜日×時限）と突き合わせ、
// その時間帯の授業名をラベルとして付ける（例: 2026-07-08_13.txt →「水 統計学」）。
// Gemini が「Aの授業の録音はどのファイルか」を時間から特定できるようにするため。
const WEEKDAY_CHARS = ["日", "月", "火", "水", "木", "金", "土"];
// 時限の既定時間帯（start_time 未登録の科目用。早稲田の時限）。
const PERIOD_HOURS = { 1: [8, 10], 2: [10, 12], 3: [13, 14], 4: [15, 16], 5: [17, 18], 6: [18, 20] };
function buildTranscriptIndex(files, courses) {
  return (files || []).map((f) => {
    const m = String(f.filename || "").match(/^(\d{4})-(\d{2})-(\d{2})_(\d{1,2})/);
    let label = "";
    if (m) {
      const wd = WEEKDAY_CHARS[new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay()];
      const hour = Number(m[4]);
      const hit = (courses || []).find((c) => {
        if (c.day !== wd) return false;
        if (c.start_time) {
          const sh = Number(String(c.start_time).split(":")[0]);
          const eh = c.end_time ? Number(String(c.end_time).split(":")[0]) : sh + 1;
          return hour >= sh && hour <= eh;
        }
        const range = PERIOD_HOURS[c.period];
        return range ? hour >= range[0] && hour <= range[1] : false;
      });
      label = hit ? `${wd} ${hit.name}` : wd;
    }
    return { filename: f.filename, chars: f.chars, label };
  });
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
