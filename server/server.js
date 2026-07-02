// AIHelper.jp 側の受信サーバー兼ウェブアプリ (Node.js + Express + MySQL)
//
// できること:
//  - 端末アプリから文字起こしテキストを受信し MySQL に保存
//  - Gemini で「課題」「予定」を抽出し、締切付きタスクとして正規化保存
//  - 締切の「1日前」「1時間前」に LINE で警告（+ 端末ローカル通知用に記録）
//  - その日の文字起こしから「今日の要約」を日付ごとに生成
//  - 秘書チャット: 「今日の予定は？」と聞けば回答、「予定入れといて」で登録まで実行
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
const gemini = require("./gemini");
const line = require("./line");
const summary = require("./summary");
const reminders = require("./reminders");
const moodle = require("./moodle");

const PORT = process.env.PORT || 3000;
const ACCOUNTS_FILE = path.join(__dirname, "accounts.json");
// 日次サマリの送信時刻（サーバーのローカル時刻）。"HH:MM" 形式。既定 21:00。
const SUMMARY_TIME = process.env.DAILY_SUMMARY_TIME || "21:00";

const app = express();

app.use(express.json());
app.use(express.text({ type: "text/plain", limit: "10mb" }));

// accounts.json はリクエストのたびに読み直す（編集してすぐ反映できるように）。
function loadAccounts() {
  try {
    return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
  } catch (e) {
    console.error("accounts.json の読み込みに失敗:", e.message);
    return [];
  }
}

// ---- 自己登録ユーザー（MySQL 保存・sha256 ハッシュ） ----
// パスワードは平文で持たず、sha256(salt + password) の16進のみを保存する。
function sha256(salt, password) {
  return crypto.createHash("sha256").update(salt + String(password)).digest("hex");
}
function genSalt() {
  return crypto.randomBytes(16).toString("hex"); // 32 hex chars
}
function genToken() {
  return crypto.randomBytes(24).toString("hex"); // 48 hex chars
}

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

// API 用の認証ヘルパ。body / query / ヘッダのいずれかから email+token を取り、照合する（非同期）。
async function authFromReq(req) {
  const email =
    req.get("X-Account-Email") || req.body?.email || req.query.email || "";
  const token =
    (req.get("Authorization") || "").replace(/^Bearer\s+/i, "") ||
    req.body?.token ||
    req.query.token ||
    "";
  return resolveAccount(email, token);
}

// =====================================================================
// 認証・アップロード
// =====================================================================

// 新規ユーザー登録（Web 用）。メール＋パスワードで登録し、API 用トークンを発行する。
app.post("/api/register", async (req, res) => {
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
    const salt = genSalt();
    const passwordHash = sha256(salt, password);
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
app.post("/api/login", async (req, res) => {
  const { email, token, password } = req.body || {};
  try {
    let account = null;
    if (password) {
      const u = await db.getUserByEmail(email);
      if (u && u.password_hash === sha256(u.salt, password)) {
        account = { email: u.email, token: u.token, lineUserId: "" };
      }
    } else {
      account = await resolveAccount(email, token);
    }
    if (!account) {
      return res.status(401).json({ ok: false, error: "アカウント情報が一致しません" });
    }
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
    if (u.password_hash !== sha256(u.salt, currentPassword)) {
      return res.status(401).json({ ok: false, error: "現在のパスワードが違います" });
    }
    const salt = genSalt();
    await db.updateUserPassword(account.email, salt, sha256(salt, newPassword));
    res.json({ ok: true });
  } catch (e) {
    console.error("パスワード変更に失敗:", e.message);
    res.status(500).json({ ok: false, error: "保存に失敗しました" });
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
    res.status(500).json({ ok: false, error: e.message });
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
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/moodle", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  const url = String(req.body?.url || "").trim();
  if (url && !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ ok: false, error: "http(s) の URL を入力してください" });
  }
  try {
    await db.setMoodleUrl(account.email, url);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/moodle/sync", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  try {
    const url = await db.getMoodleUrl(account.email);
    if (!url) return res.status(400).json({ ok: false, error: "Moodle の URL が未設定です" });
    const imported = await moodle.syncUser(account.email, url);
    res.json({ ok: true, imported });
  } catch (e) {
    console.error(`Moodle 同期に失敗 (${account.email}):`, e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 文字起こしテキストの受信 → MySQL に保存 → Gemini で課題/予定/要約を抽出。
app.post("/api/upload", async (req, res) => {
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
  if (gemini.isConfigured() && id != null) {
    try {
      const result = await gemini.analyze(content);
      await db.saveAnalysis(id, result.kadai, result.yotei, result.summary);
      await db.upsertTasks(account.email, result.tasks, id);
      taskCount = result.tasks.length;
      analyzed = true;
      console.log(`解析: ${safeName} -> タスク ${taskCount} 件 / 要約 ${result.summary ? "有" : "無"}`);
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

// =====================================================================
// 秘書チャット
// =====================================================================

// POST /api/ask  body: { email, token, question }
// 質問に答え、依頼（予定追加・完了化）なら実行する。
app.post("/api/ask", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "アカウント情報が一致しません" });
  if (!gemini.isConfigured()) {
    return res.status(503).json({ ok: false, error: "Gemini が未設定です（GEMINI_API_KEY）" });
  }
  const question = String(req.body?.question || "").trim();
  if (!question) return res.status(400).json({ ok: false, error: "質問が空です" });

  try {
    const tasks = await db.listUpcomingTasks(account.email, { includeDone: true, limit: 100 });
    const summaries = await db.listDailySummaries(account.email, 5);
    // アプリが送ってきた端末側カレンダー（Google等）も渡す。
    const calendar = Array.isArray(req.body?.calendar) ? req.body.calendar.slice(0, 100) : [];
    const result = await gemini.ask(question, { tasks, summaries, calendar });

    // Gemini が返した操作を実行する。
    const applied = [];
    for (const a of result.actions) {
      if (a.op === "add_task" && a.content) {
        await db.addTask(account.email, {
          type: a.type,
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
      }
    }
    res.json({ ok: true, reply: result.reply, applied });
  } catch (e) {
    console.error("ask に失敗:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

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
    res.status(500).json({ ok: false, error: e.message });
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
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/tasks/:id/done", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  try {
    await db.setTaskStatus(Number(req.params.id), req.body?.status === "pending" ? "pending" : "done");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete("/api/tasks/:id", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  try {
    await db.deleteTask(Number(req.params.id));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
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
    res.status(500).json({ ok: false, error: e.message });
  }
});

// その日の要約をいま生成し直す。
app.post("/api/summary/:day/generate", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  if (!gemini.isConfigured()) return res.status(503).json({ ok: false, error: "Gemini が未設定です" });
  const day = req.params.day === "today" ? gemini.localDate() : req.params.day;
  try {
    const summary = await reminders.generateDailySummary(account.email, day);
    res.json({ ok: true, day, summary, empty: !summary });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/summaries", async (req, res) => {
  const account = await authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  try {
    const rows = await db.listDailySummaries(account.email, 30);
    res.json({ ok: true, summaries: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
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
    res.status(500).json({ ok: false, error: e.message });
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
    res.status(500).json({ ok: false, error: e.message });
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
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
  res.send(itemsToCsv(items));
}

app.get("/kadai/:id.csv", async (req, res) => serveAnalysisCsv(req, res, "kadai", "課題"));
app.get("/yotei/:id.csv", async (req, res) => serveAnalysisCsv(req, res, "yotei", "予定"));

async function serveAnalysisCsv(req, res, kind, label) {
  let data;
  try {
    data = await db.getAnalysis(req.params.id, kind);
  } catch (e) {
    return res.status(500).type("text/plain").send("DB 接続エラー: " + e.message);
  }
  if (!data) return res.status(404).type("text/plain").send("見つかりません");
  const base = data.filename.replace(/\.[^.]+$/, "");
  sendCsv(res, `${base}_${label}.csv`, data.items);
}

// =====================================================================
// ダッシュボード
// =====================================================================
app.get("/", async (_req, res) => {
  let rows = [];
  try {
    rows = await db.listTranscripts();
  } catch (e) {
    return res.status(500).type("text/plain").send("DB 接続エラー: " + e.message);
  }

  const tableRows = rows.length
    ? rows
        .map((r) => {
          const analyzed = Boolean(r.analyzed_at);
          const csvLinks = analyzed
            ? `<a class="dl csv" href="/kadai/${r.id}.csv">課題CSV</a>
               <a class="dl csv" href="/yotei/${r.id}.csv">予定CSV</a>`
            : `<span class="pending">未解析</span>`;
          return `
        <tr>
          <td>${escapeHtml(r.email)}</td>
          <td>${escapeHtml(r.filename)}</td>
          <td class="num">${r.chars}</td>
          <td>${new Date(r.updated_at).toLocaleString("ja-JP")}</td>
          <td><button class="small" onclick="viewText(${r.id})">本文</button>
              <a class="dl" href="/download/${r.id}">DL</a></td>
          <td>${csvLinks}</td>
        </tr>`;
        })
        .join("")
    : `<tr><td colspan="6" class="empty">まだファイルがありません。</td></tr>`;

  res.type("text/html").send(renderDashboard(tableRows));
});

// ブラウザ内で本文を確認するための JSON 取得（ダッシュボードのモーダル用）。
app.get("/api/transcript/:id", async (req, res) => {
  try {
    const row = await db.getTranscript(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: "見つかりません" });
    res.json({ ok: true, filename: row.filename, content: row.content, summary: row.summary || "" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/download/:id", async (req, res) => {
  let row;
  try {
    row = await db.getTranscript(req.params.id);
  } catch (e) {
    return res.status(500).type("text/plain").send("DB 接続エラー: " + e.message);
  }
  if (!row) return res.status(404).type("text/plain").send("見つかりません");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${row.filename}"; filename*=UTF-8''${encodeURIComponent(row.filename)}`
  );
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
    res.status(500).json({ ok: false, error: e.message });
  }
});

// "HH:MM" を解釈し、次にその時刻になるまでのミリ秒を返す。
function msUntilNext(hhmm) {
  const [h, m] = hhmm.split(":").map((s) => Number(s));
  const now = new Date();
  const next = new Date(now);
  next.setHours(h, m, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1); // 今日の時刻を過ぎていれば翌日
  return next - now;
}

// 毎日 SUMMARY_TIME に日次サマリを送る。setTimeout を都度貼り直して回す。
function scheduleDailySummary() {
  if (!/^\d{1,2}:\d{2}$/.test(SUMMARY_TIME)) {
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

function renderDashboard(tableRows) {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AIHelper — あなたの秘書</title>
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
    hr { border:none; border-top:1px solid var(--line); margin:1.1rem 0; }
  </style>
</head>
<body>
  <header>
    <div class="wrap">
      <h1>AIHelper — あなたの秘書</h1>
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
        <button class="tab" data-tab="chat" onclick="showTab('chat')">秘書</button>
        <button class="tab" data-tab="tasks" onclick="showTab('tasks')">予定・課題</button>
        <button class="tab" data-tab="summary" onclick="showTab('summary')">今日の要約</button>
        <button class="tab" data-tab="files" onclick="showTab('files')">ファイル</button>
        <button class="tab" data-tab="account" onclick="showTab('account')">アカウント</button>
      </nav>

      <section class="card panel" data-panel="chat">
        <h2>秘書に聞く / 頼む</h2>
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

      <section class="card panel" data-panel="summary">
        <h2>今日の要約</h2>
        <div id="summary"><p class="muted">読み込み中…</p></div>
        <button class="ghost small" style="margin-top:.5rem" onclick="genSummary()">今すぐ生成し直す</button>
      </section>

      <section class="card panel" data-panel="files">
        <h2>受信した文字起こしファイル</h2>
        <table>
          <thead><tr><th>アカウント</th><th>ファイル名</th><th>文字数</th><th>更新</th><th></th><th>課題/予定</th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </section>

      <section class="card panel" data-panel="account">
        <h2>アカウント</h2>
        <p>ログイン中: <strong id="accEmail"></strong></p>
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
      document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active', b.dataset.tab===name));
      document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('active', p.dataset.panel===name));
    }
    function initAuth(){ if(auth.email && auth.token) onAuthed(); }
    function onAuthed(){
      $('login').style.display = 'none';
      $('app').style.display = '';
      $('accEmail').textContent = auth.email || '';
      showTab('chat');
      loadAll();
    }
    function logout(){
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
    function loadAll(){ loadTasks(); loadSummary(); loadMoodle(); }

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

    // ---- 本文表示（モーダル） ----
    async function viewText(id){
      $('modalTitle').textContent = '読み込み中…'; $('modalBody').textContent = '';
      $('modal').style.display = 'flex';
      try {
        const r = await fetch('/api/transcript/'+id, {headers: headers()});
        const j = await r.json();
        if(j.ok){
          $('modalTitle').textContent = j.filename;
          $('modalBody').textContent = (j.summary ? '【要約】\\n'+j.summary+'\\n\\n【本文】\\n' : '') + j.content;
        } else { $('modalTitle').textContent = 'エラー'; $('modalBody').textContent = j.error||''; }
      } catch(e){ $('modalTitle').textContent='通信エラー'; }
    }
    function closeModal(){ $('modal').style.display = 'none'; }

    // ---- チャット ----
    function bubble(text, who){
      const d = document.createElement('div');
      d.className = 'bubble '+who; d.textContent = text;
      $('chatlog').appendChild(d); $('chatlog').scrollTop = $('chatlog').scrollHeight;
    }
    async function ask(){
      const q = $('q').value.trim(); if(!q) return;
      $('q').value=''; bubble(q,'me');
      try{
        const r = await fetch('/api/ask',{method:'POST',headers:headers(),body:JSON.stringify({question:q})});
        const j = await r.json();
        bubble(j.ok ? j.reply : ('エラー: '+(j.error||'')), 'bot');
        if(j.ok && j.applied && j.applied.length){ loadTasks(); }
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
          '<td class="col-mid"><button class="ghost small" onclick="delTask('+t.id+')">削除</button></td>'+
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

  app.listen(PORT, () => {
    console.log(`AIHelper listening on http://localhost:${PORT}`);
    console.log(`accounts: ${ACCOUNTS_FILE}`);
    console.log(`DB: ${process.env.DB_NAME || "aihelper"}@${process.env.DB_HOST || "localhost"}`);
    console.log(`Gemini: ${gemini.isConfigured() ? gemini.MODEL : "未設定"} / LINE: ${line.isConfigured() ? "有効" : "未設定"}`);
    if (line.isConfigured()) {
      scheduleDailySummary();
    } else {
      console.log("LINE_CHANNEL_ACCESS_TOKEN が未設定のため日次サマリは無効です");
    }
  });
}

main();
