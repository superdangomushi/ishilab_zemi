const fs = require("fs");
const path = require("path");
const db = require("./db");
const line = require("./line");

const ACCOUNTS_FILE = path.join(__dirname, "accounts.json");

function loadAccounts() {
  try {
    return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
  } catch (e) {
    console.error("accounts.json の読み込みに失敗:", e.message);
    return [];
  }
}

function todayString() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 1 項目を表示用の数行に整形する。
function formatItem(index, item) {
  const lines = [`${index}. ${item.content || "(内容なし)"}`];
  if (item.deadline) lines.push(`   期限: ${item.deadline}`);
  if (item.details) lines.push(`   詳細: ${item.details}`);
  return lines.join("\n");
}

function formatSection(title, items) {
  if (!items.length) return `【${title}】\n  （なし）`;
  const body = items.map((it, i) => formatItem(i + 1, it)).join("\n");
  return `【${title}】\n${body}`;
}

// 1 アカウント分のサマリ本文を作る。
function buildMessage(today, kadai, yotei) {
  return [
    `📋 今日のゼミまとめ (${today})`,
    "",
    formatSection("課題", kadai),
    "",
    formatSection("予定", yotei),
  ].join("\n");
}

// 日次サマリを送信する。戻り値は送信件数などの集計。
async function sendDailySummary() {
  if (!line.isConfigured()) {
    console.warn("LINE_CHANNEL_ACCESS_TOKEN が未設定のため日次サマリ送信をスキップします");
    return { sent: 0, skipped: 0, failed: 0 };
  }

  const today = todayString();
  const byEmail = new Map();
  for (const row of await db.getTodaysAnalysisByEmail()) {
    byEmail.set(row.email, row);
  }

  // lineUserId を持つアカウントだけが送信対象。
  const targets = loadAccounts().filter((a) => a.lineUserId);
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const account of targets) {
    const data = byEmail.get(account.email) || { kadai: [], yotei: [] };
    if (!data.kadai.length && !data.yotei.length) {
      skipped++;
      continue;
    }
    const message = buildMessage(today, data.kadai, data.yotei);
    try {
      await line.pushText(account.lineUserId, message);
      sent++;
      console.log(
        `日次サマリ送信: ${account.email} (課題 ${data.kadai.length} / 予定 ${data.yotei.length})`
      );
    } catch (e) {
      failed++;
      console.error(`日次サマリ送信に失敗 (${account.email}):`, e.message);
    }
  }

  console.log(`日次サマリ: 送信 ${sent} / スキップ ${skipped} / 失敗 ${failed}`);
  return { sent, skipped, failed };
}

module.exports = { sendDailySummary, buildMessage };
