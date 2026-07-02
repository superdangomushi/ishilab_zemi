// リマインドエンジンと日次要約ジョブ。
//
// - 締切/予定の「1日前」「1時間前」になったタスクを定期的に探し、LINE で警告を送る。
//   送信済みフラグ（notified_1d / notified_1h）で二重送信を防ぐ（冪等）。
// - 送った通知は notifications テーブルにも記録し、端末アプリがローカル通知として
//   取得できるようにする（LINE 未設定でもアプリ側の通知は機能する）。
// - あわせて一定間隔で、その日の文字起こしから「今日の要約」を生成して保存する。

const db = require("./db");
const line = require("./line");
const gemini = require("./gemini");

// 設定（環境変数で調整可）。
const REMINDER_INTERVAL_MS = Number(process.env.REMINDER_INTERVAL_SEC || 60) * 1000;
const DEFAULT_DAILY_SUMMARY_INTERVAL_MIN = 5 * 60;
const DAILY_SUMMARY_INTERVAL_MS =
  Number(process.env.DAILY_SUMMARY_INTERVAL_MIN || DEFAULT_DAILY_SUMMARY_INTERVAL_MIN) * 60 * 1000;
// 締切の何分手前を「1日前/1時間前」とみなすか。ループ間隔ぶんの取りこぼしを防ぐため少し広めの窓で見る。
const WINDOW_1D_MIN = 24 * 60; // 24時間以内
const WINDOW_1H_MIN = 60; // 1時間以内

function typeLabel(type) {
  return type === "yotei" ? "予定" : "課題";
}

function fmtDeadline(task) {
  if (!task.deadline_at) return "期限未定";
  // "YYYY-MM-DD HH:MM:SS" → 日付のみなら時刻を省く。
  const s = String(task.deadline_at);
  return task.date_only ? s.slice(0, 10) : s.slice(0, 16);
}

function buildMessage(task, when) {
  const head = when === "1h" ? "【まもなく】1時間以内" : "【リマインド】まもなく1日以内";
  return (
    `${head}に${typeLabel(task.type)}の締切です。\n` +
    `・${task.content}\n` +
    `・期限: ${fmtDeadline(task)}` +
    (task.details ? `\n・メモ: ${task.details}` : "")
  );
}

// 1回ぶんのリマインドチェック。resolveLineTarget(email) は送信先 userId を返す関数。
async function checkReminders(resolveLineTarget) {
  for (const [flag, windowMin, when] of [
    ["notified_1d", WINDOW_1D_MIN, "1d"],
    ["notified_1h", WINDOW_1H_MIN, "1h"],
  ]) {
    let due = [];
    try {
      due = await db.findDueTasks(flag, windowMin);
    } catch (e) {
      console.error("リマインド対象の取得に失敗:", e.message);
      continue;
    }
    for (const task of due) {
      const message = buildMessage(task, when);
      const target = resolveLineTarget ? resolveLineTarget(task.email) : null;
      // LINE 送信（未設定/失敗でも続行。アプリ側ローカル通知の記録は必ず残す）。
      const sent = await line.pushText(target, message);
      try {
        await db.recordNotification(
          task.email,
          task.id,
          when === "1h" ? "remind_1h" : "remind_1d",
          sent ? "line" : "local",
          message
        );
        await db.markNotified(task.id, flag);
      } catch (e) {
        console.error("通知記録に失敗:", e.message);
        continue;
      }
      console.log(
        `リマインド(${when}) ${task.email}: ${task.content} -> ` +
          `${sent ? "LINE送信" : "記録のみ(アプリ通知用)"}`
      );
    }
  }
}

// 指定 email・day の日次要約を生成して保存する。戻り値は要約文字列（材料が無ければ ""）。
async function generateDailySummary(email, day) {
  if (!gemini.isConfigured()) return "";
  const transcripts = await db.getTranscriptsForDay(email, day);
  if (!transcripts.length) return "";
  const summary = await gemini.summarizeDay(day, transcripts);
  if (summary) await db.saveDailySummary(email, day, summary);
  return summary;
}

// 全アクティブアカウントについて「今日」の要約を作り直す。
async function refreshTodaySummaries() {
  if (!gemini.isConfigured()) return;
  const day = gemini.localDate();
  let emails = [];
  try {
    emails = await db.listEmailsForDailySummary(day);
  } catch (e) {
    console.error("要約対象アカウントの取得に失敗:", e.message);
    return;
  }
  for (const email of emails) {
    try {
      const s = await generateDailySummary(email, day);
      if (s) console.log(`日次要約を更新: ${email} ${day}`);
    } catch (e) {
      console.error(`日次要約の生成に失敗 (${email}):`, e.message);
    }
  }
}

let reminderTimer = null;
let summaryTimer = null;

// スケジューラ開始。resolveLineTarget(email)->userId を渡す。
function start(resolveLineTarget) {
  stop();
  // すぐ1回 + 以後インターバル。
  checkReminders(resolveLineTarget).catch((e) => console.error(e));
  reminderTimer = setInterval(
    () => checkReminders(resolveLineTarget).catch((e) => console.error(e)),
    REMINDER_INTERVAL_MS
  );
  console.log(`リマインド監視を開始（${REMINDER_INTERVAL_MS / 1000}秒間隔）`);

  if (DAILY_SUMMARY_INTERVAL_MS > 0 && gemini.isConfigured()) {
    summaryTimer = setInterval(
      () => refreshTodaySummaries().catch((e) => console.error(e)),
      DAILY_SUMMARY_INTERVAL_MS
    );
    console.log(`日次要約の自動生成を開始（${DAILY_SUMMARY_INTERVAL_MS / 60000}分間隔）`);
  }
}

function stop() {
  if (reminderTimer) clearInterval(reminderTimer);
  if (summaryTimer) clearInterval(summaryTimer);
  reminderTimer = summaryTimer = null;
}

module.exports = { start, stop, checkReminders, generateDailySummary, refreshTodaySummaries };
