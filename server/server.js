// moneybot.jp 側の簡易受信サーバー (Node.js + Express + MySQL)
//
// - 事前に accounts.json にアカウント (email) とトークンを登録しておく。
// - アプリ側のアカウント情報＋トークンが一致したときだけテキストを受け付け、
//   ファイルはファイルシステムではなく MySQL に直接保存する。
// - Web サイト（ / ）にアクセスすると保存済みファイルを一覧・ダウンロードできる。

const express = require("express");
const fs = require("fs");
const path = require("path");
const db = require("./db");
const gemini = require("./gemini");

const PORT = process.env.PORT || 3000;
const ACCOUNTS_FILE = path.join(__dirname, "accounts.json");

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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// アプリのアップロード前にトークン＋アカウントの整合を確認するためのログイン。
app.post("/api/login", (req, res) => {
  const { email, token } = req.body || {};
  const account = findAccount(email, token);
  if (!account) {
    return res.status(401).json({ ok: false, error: "アカウント情報が一致しません" });
  }
  res.json({ ok: true, email: account.email });
});

// 文字起こしテキストの受信 → MySQL に保存。
// ヘッダ: Authorization: Bearer <token>, X-Account-Email, X-Filename
// 本文 : テキストファイルの中身そのもの
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

  // Gemini で「課題」「予定」を抽出して保存する。失敗してもアップロード自体は成功扱い。
  let analyzed = false;
  if (gemini.isConfigured() && id != null) {
    try {
      const result = await gemini.analyze(content);
      await db.saveAnalysis(id, result.kadai, result.yotei);
      analyzed = true;
      console.log(
        `解析: ${safeName} -> 課題 ${result.kadai.length} 件 / 予定 ${result.yotei.length} 件`
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
  });
});

// CSV 用ユーティリティ。値内のカンマ・引用符・改行を RFC4180 に従ってエスケープ。
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
  // Excel で文字化けしないよう UTF-8 BOM を付ける。
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

// 課題 CSV のダウンロード。
app.get("/kadai/:id.csv", async (req, res) => {
  await serveAnalysisCsv(req, res, "kadai", "課題");
});

// 予定 CSV のダウンロード。
app.get("/yotei/:id.csv", async (req, res) => {
  await serveAnalysisCsv(req, res, "yotei", "予定");
});

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

// Web サイト: 保存済みファイルの一覧（ダウンロードリンク付き）。
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
          <td><a class="dl" href="/download/${r.id}">ダウンロード</a></td>
          <td>${csvLinks}</td>
        </tr>`;
        })
        .join("")
    : `<tr><td colspan="6" class="empty">まだファイルがありません。</td></tr>`;

  res.type("text/html").send(`<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>moneybot.jp 文字起こしファイル</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; color: #222; }
    h1 { font-size: 1.4rem; }
    table { border-collapse: collapse; width: 100%; max-width: 900px; }
    th, td { border: 1px solid #ddd; padding: 8px 10px; text-align: left; }
    th { background: #f5f5f5; }
    td.num { text-align: right; }
    td.empty { text-align: center; color: #888; }
    a.dl { display: inline-block; padding: 4px 10px; background: #2563eb;
           color: #fff; text-decoration: none; border-radius: 4px; }
    a.dl.csv { background: #16a34a; margin: 2px 0; }
    span.pending { color: #888; font-size: 0.9em; }
  </style>
</head>
<body>
  <h1>文字起こしファイル一覧</h1>
  <table>
    <thead>
      <tr><th>アカウント</th><th>ファイル名</th><th>文字数</th><th>更新</th><th></th><th>課題/予定</th></tr>
    </thead>
    <tbody>${tableRows}</tbody>
  </table>
</body>
</html>`);
});

// ファイルのダウンロード（.txt として保存）。
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

async function main() {
  try {
    await db.ensureSchema();
    console.log("DB スキーマを確認しました");
  } catch (e) {
    console.error("DB 初期化に失敗（接続情報を確認してください）:", e.message);
  }
  app.listen(PORT, () => {
    console.log(`moneybot receiver listening on http://localhost:${PORT}`);
    console.log(`accounts: ${ACCOUNTS_FILE}`);
    console.log(`DB: ${process.env.DB_NAME || "moneybot"}@${process.env.DB_HOST || "localhost"}`);
  });
}

main();
