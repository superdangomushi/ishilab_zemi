// ダブルブッキング（予定の時間帯重複）の検知と通知。
//
// 予定・カレンダーイベントの多くは終了時刻の情報を持たないため、
// 各予定を「開始から60分のブロック」とみなし、ブロック同士が重なったら
// 重複の可能性ありとして扱う。
// 通知は notifications テーブルに記録（アプリのローカル通知が拾う）し、
// LINE 連携済みなら LINE にも送る。同じ組み合わせで二重通知しないよう、
// 同一メッセージが記録済みならスキップする（冪等）。

const db = require("./db");
const line = require("./line");
const { resolveLineTarget } = require("./auth");

const ASSUMED_DURATION_MS = 60 * 60 * 1000;
const KIND = "double_booking";

// "YYYY-MM-DD HH:MM(:SS)" / "YYYY-MM-DDTHH:MM" をサーバーローカル時刻の millis に変換。
function millisOf(s) {
  const t = String(s || "").trim().replace(" ", "T");
  if (!t) return 0;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : 0;
}

// whenText に時刻が含まれるか（終日予定 "2026-07-20" は重複判定の対象外にする）。
function hasTime(whenText) {
  return /\d{4}[-\/]\d{1,2}[-\/]\d{1,2}[ T]\d{1,2}:\d{2}/.test(String(whenText || ""));
}

function overlaps(aStart, bStart) {
  return Math.abs(aStart - bStart) < ASSUMED_DURATION_MS;
}

const pad = (n) => String(n).padStart(2, "0");

function fmtWhen(ms) {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// item: { title, startMillis }
// existing のうち item と時間帯が重なるものを返す。同名は「同じ予定が別経路で
// 見えているだけ」（タスクとそのGoogleカレンダー登録など）とみなし重複扱いしない。
function findConflicts(item, existing) {
  const seen = new Set();
  const out = [];
  for (const e of existing) {
    if (!(e.startMillis > 0) || !(item.startMillis > 0)) continue;
    if (!overlaps(e.startMillis, item.startMillis)) continue;
    const titleA = String(item.title || "").trim();
    const titleB = String(e.title || "").trim();
    if (titleA === titleB) continue;
    const key = `${titleB}|${Math.floor(e.startMillis / 60000)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

function buildMessage(item, conflicts) {
  return [
    "【ダブルブッキング注意】予定の時間が重なっています。",
    `・${item.title} (${fmtWhen(item.startMillis)})`,
    ...conflicts.map((c) => `・${c.title} (${fmtWhen(c.startMillis)})`),
  ].join("\n");
}

// 重複を通知する。同一メッセージが通知済みなら何もしない。
// 戻り値: 送った（記録した）メッセージ。スキップ時は null。
async function notifyConflict(email, item, conflicts) {
  const message = buildMessage(item, conflicts);
  if (await db.hasNotification(email, KIND, message)) return null;
  const sent = await line.pushText(resolveLineTarget(email), message);
  await db.recordNotification(email, null, KIND, sent ? "line" : "local", message);
  return message;
}

// カレンダー同期時のチェック: 同期されたイベント同士と「予定」タスクを突き合わせ、
// 重なりが見つかったペアごとに通知する。
async function checkCalendarConflicts(email, events) {
  const items = (events || [])
    .filter((e) => e && e.startMillis > 0 && hasTime(e.whenText))
    .map((e) => ({ title: e.title, startMillis: e.startMillis }));
  try {
    const tasks = await db.listUpcomingTasks(email, { includeDone: false, limit: 200 });
    for (const t of tasks) {
      if (t.type !== "yotei" || !t.deadline_at || t.date_only) continue;
      items.push({ title: t.content, startMillis: millisOf(t.deadline_at) });
    }
  } catch (e) {
    console.error("重複チェック用のタスク取得に失敗:", e.message);
  }
  for (let i = 0; i < items.length; i++) {
    const conflicts = findConflicts(items[i], items.slice(i + 1));
    if (!conflicts.length) continue;
    try {
      await notifyConflict(email, items[i], conflicts);
    } catch (e) {
      console.error("ダブルブッキング通知に失敗:", e.message);
    }
  }
}

module.exports = {
  millisOf,
  hasTime,
  findConflicts,
  buildMessage,
  notifyConflict,
  checkCalendarConflicts,
};
