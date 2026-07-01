// moneybot.jp 側の受信サーバー兼ウェブアプリ (Node.js + Express + MySQL)
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
const db = require("./db");
const gemini = require("./gemini");
const line = require("./line");
const summary = require("./summary");
const reminders = require("./reminders");

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

function findAccount(email, token) {
  if (!email || !token) return null;
  return loadAccounts().find((a) => a.email === email && a.token === token) || null;
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

// API 用の認証ヘルパ。body / query / ヘッダのいずれかから email+token を取り、照合する。
function authFromReq(req) {
  const email =
    req.get("X-Account-Email") || req.body?.email || req.query.email || "";
  const token =
    (req.get("Authorization") || "").replace(/^Bearer\s+/i, "") ||
    req.body?.token ||
    req.query.token ||
    "";
  return findAccount(email, token);
}

// =====================================================================
// 認証・アップロード
// =====================================================================

// アプリのアップロード前にトークン＋アカウントの整合を確認するためのログイン。
app.post("/api/login", (req, res) => {
  const { email, token } = req.body || {};
  const account = findAccount(email, token);
  if (!account) {
    return res.status(401).json({ ok: false, error: "アカウント情報が一致しません" });
  }
  res.json({ ok: true, email: account.email, line: Boolean(account.lineUserId) });
});

// 文字起こしテキストの受信 → MySQL に保存 → Gemini で課題/予定/要約を抽出。
app.post("/api/upload", async (req, res) => {
  const email = req.get("X-Account-Email");
  const token = (req.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const account = findAccount(email, token);
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
  const account = authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "アカウント情報が一致しません" });
  if (!gemini.isConfigured()) {
    return res.status(503).json({ ok: false, error: "Gemini が未設定です（GEMINI_API_KEY）" });
  }
  const question = String(req.body?.question || "").trim();
  if (!question) return res.status(400).json({ ok: false, error: "質問が空です" });

  try {
    const tasks = await db.listUpcomingTasks(account.email, { includeDone: true, limit: 100 });
    const summaries = await db.listDailySummaries(account.email, 5);
    const result = await gemini.ask(question, { tasks, summaries });

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
  const account = authFromReq(req);
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
  const account = authFromReq(req);
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
  const account = authFromReq(req);
  if (!account) return res.status(401).json({ ok: false, error: "認証エラー" });
  try {
    await db.setTaskStatus(Number(req.params.id), req.body?.status === "pending" ? "pending" : "done");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete("/api/tasks/:id", async (req, res) => {
  const account = authFromReq(req);
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
  const account = authFromReq(req);
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
  const account = authFromReq(req);
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
  const account = authFromReq(req);
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
  const account = authFromReq(req);
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
  const account = authFromReq(req);
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
          <td><a class="dl" href="/download/${r.id}">DL</a></td>
          <td>${csvLinks}</td>
        </tr>`;
        })
        .join("")
    : `<tr><td colspan="6" class="empty">まだファイルがありません。</td></tr>`;

  res.type("text/html").send(renderDashboard(tableRows));
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
  <title>moneybot — あなたの秘書</title>
  <style>
    :root { --bg:#0f172a; --card:#fff; --accent:#2563eb; --green:#16a34a; --muted:#64748b; }
    * { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, "Hiragino Kaku Gothic ProN", sans-serif;
           margin: 0; background: #f1f5f9; color: #0f172a; }
    header { background: var(--bg); color: #fff; padding: 1rem 1.5rem; }
    header h1 { margin: 0; font-size: 1.25rem; }
    header p { margin: .3rem 0 0; color: #cbd5e1; font-size: .85rem; }
    main { max-width: 980px; margin: 1.25rem auto; padding: 0 1rem; display: grid; gap: 1.25rem; }
    .card { background: var(--card); border-radius: 12px; padding: 1.1rem 1.25rem;
            box-shadow: 0 1px 3px rgba(0,0,0,.08); }
    .card h2 { margin: 0 0 .8rem; font-size: 1.05rem; }
    .row { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; }
    input, select, textarea { font: inherit; padding: .5rem .6rem; border: 1px solid #cbd5e1;
            border-radius: 8px; }
    input, textarea { width: 100%; }
    button { font: inherit; padding: .5rem .9rem; border: none; border-radius: 8px;
             background: var(--accent); color: #fff; cursor: pointer; }
    button.ghost { background: #e2e8f0; color: #0f172a; }
    button.small { padding: .25rem .55rem; font-size: .8rem; }
    .muted { color: var(--muted); font-size: .85rem; }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: .5rem; }
    @media (max-width: 640px){ .grid2 { grid-template-columns: 1fr; } }
    table { border-collapse: collapse; width: 100%; font-size: .9rem; }
    th, td { border: 1px solid #e2e8f0; padding: 6px 8px; text-align: left; }
    th { background: #f8fafc; }
    td.num { text-align: right; }
    td.empty { text-align: center; color: #94a3b8; }
    a.dl { display: inline-block; padding: 3px 8px; background: var(--accent);
           color: #fff; text-decoration: none; border-radius: 6px; font-size: .8rem; }
    a.dl.csv { background: var(--green); }
    span.pending { color: #94a3b8; font-size: .85em; }
    .task { display:flex; align-items:flex-start; gap:.6rem; padding:.5rem 0; border-bottom:1px solid #eef2f7; }
    .task .body { flex:1; }
    .badge { display:inline-block; font-size:.7rem; padding:.1rem .45rem; border-radius:999px; color:#fff; }
    .badge.kadai { background:#7c3aed; } .badge.yotei { background:#0891b2; }
    .due { font-size:.8rem; } .due.soon { color:#dc2626; font-weight:600; }
    .due.warn { color:#d97706; }
    .chatlog { display:flex; flex-direction:column; gap:.5rem; max-height:320px; overflow:auto;
               margin-bottom:.6rem; }
    .bubble { padding:.55rem .75rem; border-radius:12px; max-width:85%; white-space:pre-wrap; line-height:1.4; }
    .bubble.me { align-self:flex-end; background:var(--accent); color:#fff; }
    .bubble.bot { align-self:flex-start; background:#eef2f7; }
    .done { text-decoration: line-through; color:#94a3b8; }
  </style>
</head>
<body>
  <header>
    <h1>🗒️ moneybot — あなたの秘書</h1>
    <p>常時録音から課題・予定を拾い、締切前に LINE で警告。聞けば答え、頼めば登録します。</p>
  </header>
  <main>
    <section class="card">
      <h2>ログイン情報</h2>
      <div class="grid2">
        <input id="email" placeholder="アカウント(メール)">
        <input id="token" placeholder="トークン" type="password">
      </div>
      <div class="row" style="margin-top:.5rem">
        <button onclick="saveAuth()">保存して読み込み</button>
        <span id="authState" class="muted"></span>
      </div>
    </section>

    <section class="card">
      <h2>💬 秘書に聞く / 頼む</h2>
      <div id="chatlog" class="chatlog"></div>
      <div class="row">
        <input id="q" placeholder="例）今日の予定は？ / 来週月曜10時にゼミ入れといて"
               onkeydown="if(event.key==='Enter')ask()">
        <button onclick="ask()">送信</button>
      </div>
      <p class="muted">「〜の予定入れといて」「〇〇の宿題が出てるらしい、登録して」「〇〇終わった」も実行できます。</p>
    </section>

    <section class="card">
      <h2>⏰ 締切が近い課題・予定</h2>
      <div id="tasks"><p class="muted">ログイン情報を入れると表示されます。</p></div>
      <details style="margin-top:.6rem">
        <summary class="muted">手動で追加</summary>
        <div class="grid2" style="margin-top:.5rem">
          <select id="t_type"><option value="kadai">課題</option><option value="yotei">予定</option></select>
          <input id="t_deadline" placeholder="期限 2026-07-05 17:00（任意）">
        </div>
        <input id="t_content" placeholder="内容" style="margin-top:.5rem">
        <input id="t_details" placeholder="詳細（任意）" style="margin-top:.5rem">
        <button style="margin-top:.5rem" onclick="addTask()">追加</button>
      </details>
    </section>

    <section class="card">
      <h2>📅 今日の要約</h2>
      <div id="summary"><p class="muted">ログイン情報を入れると表示されます。</p></div>
      <button class="ghost small" style="margin-top:.5rem" onclick="genSummary()">今すぐ生成し直す</button>
    </section>

    <section class="card">
      <h2>📂 受信した文字起こしファイル</h2>
      <table>
        <thead><tr><th>アカウント</th><th>ファイル名</th><th>文字数</th><th>更新</th><th></th><th>課題/予定</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </section>
  </main>

  <script>
    const $ = (id) => document.getElementById(id);
    let auth = JSON.parse(localStorage.getItem('mb_auth') || '{}');
    function headers(){ return { 'Content-Type':'application/json',
      'X-Account-Email': auth.email||'', 'Authorization':'Bearer '+(auth.token||'') }; }

    function initAuth(){
      if(auth.email){ $('email').value = auth.email; $('token').value = auth.token||''; loadAll(); }
    }
    async function saveAuth(){
      auth = { email: $('email').value.trim(), token: $('token').value.trim() };
      localStorage.setItem('mb_auth', JSON.stringify(auth));
      const r = await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},
        body: JSON.stringify(auth)});
      const j = await r.json();
      $('authState').textContent = j.ok ? ('✓ '+j.email+(j.line?'（LINE連携あり）':'（LINE未連携）')) : ('✗ '+(j.error||'失敗'));
      if(j.ok) loadAll();
    }
    function loadAll(){ loadTasks(); loadSummary(); }

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
    function dueClass(at){
      if(!at) return '';
      const ms = new Date(at.replace(' ','T')) - new Date();
      if(ms < 0) return 'soon'; if(ms < 3600e3) return 'soon'; if(ms < 86400e3) return 'warn'; return '';
    }
    function dueText(t){
      if(!t.deadline_at) return '期限未定';
      const s = t.deadline_at; const base = t.date_only ? s.slice(0,10) : s.slice(0,16);
      const ms = new Date(s.replace(' ','T')) - new Date();
      let rel = '';
      if(ms < 0) rel = '（期限切れ）';
      else { const h = Math.floor(ms/3600e3);
        rel = h < 24 ? '（あと'+h+'時間）' : '（あと'+Math.floor(h/24)+'日）'; }
      return base + ' ' + rel;
    }
    async function loadTasks(){
      if(!auth.email) return;
      const r = await fetch('/api/tasks?done=1',{headers:headers()});
      const j = await r.json(); if(!j.ok){ $('tasks').innerHTML='<p class="muted">'+j.error+'</p>'; return; }
      if(!j.tasks.length){ $('tasks').innerHTML='<p class="muted">課題・予定はありません。</p>'; return; }
      $('tasks').innerHTML = j.tasks.map(t => {
        const done = t.status==='done';
        return '<div class="task">'+
          '<input type="checkbox" '+(done?'checked':'')+' onchange="toggle('+t.id+',this.checked)">'+
          '<div class="body"><span class="badge '+t.type+'">'+(t.type==='yotei'?'予定':'課題')+'</span> '+
          '<span class="'+(done?'done':'')+'">'+escapeHtml(t.content)+'</span>'+
          '<div class="due '+dueClass(t.deadline_at)+'">'+dueText(t)+'</div>'+
          (t.details?'<div class="muted">'+escapeHtml(t.details)+'</div>':'')+'</div>'+
          '<button class="ghost small" onclick="delTask('+t.id+')">削除</button></div>';
      }).join('');
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
        details:$('t_details').value.trim(), deadline:$('t_deadline').value.trim() };
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

  app.listen(PORT, () => {
    console.log(`moneybot listening on http://localhost:${PORT}`);
    console.log(`accounts: ${ACCOUNTS_FILE}`);
    console.log(`DB: ${process.env.DB_NAME || "moneybot"}@${process.env.DB_HOST || "localhost"}`);
    console.log(`Gemini: ${gemini.isConfigured() ? gemini.MODEL : "未設定"} / LINE: ${line.isConfigured() ? "有効" : "未設定"}`);
    if (line.isConfigured()) {
      scheduleDailySummary();
    } else {
      console.log("LINE_CHANNEL_ACCESS_TOKEN が未設定のため日次サマリは無効です");
    }
  });
}

main();
