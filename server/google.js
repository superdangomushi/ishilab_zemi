// Google 連携（Web OAuth 2.0 + Calendar v3 REST）。
//
// Android アプリは端末の Google アカウントから直接トークンを取るが、Web(PC)には
// それがないため、標準の「認可コード + refresh_token」方式でサーバーが代行する:
//   1. /api/google/auth-url が返す URL へブラウザを飛ばす（Google の同意画面）
//   2. Google が /api/google/callback へ code を返す
//   3. code を refresh_token に交換し、暗号化して google_accounts に保存
//   4. 以降は refresh_token → access_token を都度発行してカレンダーを読み書き
//
// 必要な環境変数（Google Cloud Console の「OAuth クライアント ID（ウェブ）」）:
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
//   リダイレクト URI には https://<ドメイン>/api/google/callback を登録すること。

const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

const clientId = () => (process.env.GOOGLE_CLIENT_ID || "").trim();
const clientSecret = () => (process.env.GOOGLE_CLIENT_SECRET || "").trim();

function isConfigured() {
  return Boolean(clientId() && clientSecret());
}

/** Google の同意画面 URL。access_type=offline + prompt=consent で必ず refresh_token をもらう。 */
function authUrl(redirectUri, state) {
  const p = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri,
    response_type: "code",
    scope: `openid email ${SCOPE}`,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${AUTH_URL}?${p}`;
}

async function tokenRequest(params) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), ...params }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(j.error_description || j.error || `Google トークン取得エラー (${res.status})`);
  }
  return j;
}

/** 認可コードをトークンに交換し、どの Google アカウントかも返す。 */
async function exchangeCode(code, redirectUri) {
  const j = await tokenRequest({ code, redirect_uri: redirectUri, grant_type: "authorization_code" });
  // id_token は Google から直接受け取ったものなので署名検証なしで payload を読んでよい。
  const payload = JSON.parse(Buffer.from(String(j.id_token).split(".")[1], "base64url").toString("utf8"));
  return { googleEmail: payload.email, refreshToken: j.refresh_token || "", accessToken: j.access_token };
}

/** refresh_token から短命の access_token を発行する。 */
async function accessTokenOf(refreshToken) {
  const j = await tokenRequest({ refresh_token: refreshToken, grant_type: "refresh_token" });
  return j.access_token;
}

/** 直近の予定を取得する。返り値はアプリの CalendarEvent と同じ形。 */
async function listUpcomingEvents(accessToken, max = 20) {
  const p = new URLSearchParams({
    timeMin: rfc3339(Date.now()),
    maxResults: String(max),
    singleEvents: "true",
    orderBy: "startTime",
  });
  const res = await fetch(`${API}?${p}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error?.message || `カレンダー取得エラー (${res.status})`);
  return (j.items || []).map((o) => {
    const dt = o.start?.dateTime || "";
    const d = o.start?.date || "";
    return {
      title: o.summary || "(無題)",
      whenText: dt ? dt.replace("T", " ").slice(0, 16) : d,
      startMillis: parseMillis(dt || d),
    };
  }).sort((a, b) => a.startMillis - b.startMillis);
}

/**
 * 締切をカレンダーに登録する。deadline は "yyyy-MM-dd HH:mm[:ss]" または ISO。
 * dateOnly のときは終日予定、それ以外は締切時刻の30分イベントにする（アプリと同じ仕様）。
 */
async function insertDeadline(accessToken, title, deadline, dateOnly) {
  const at = parseMillis(deadline);
  if (!at) throw new Error("期限が未設定のためカレンダーに登録できません");
  const body = { summary: title };
  if (dateOnly) {
    // 終日予定の end.date は排他的（翌日）を指定する。同日だと API が 400 を返す。
    body.start = { date: dayString(at) };
    body.end = { date: dayString(at + 24 * 3600_000) };
  } else {
    body.start = { dateTime: rfc3339(at - 30 * 60_000) };
    body.end = { dateTime: rfc3339(at) };
  }
  const res = await fetch(API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error?.message || `カレンダー登録エラー (${res.status})`);
}

// ---- 時刻ヘルパー（サーバーのローカルタイムゾーン基準。DB の DATETIME と同じ扱い） ----

const pad = (n) => String(n).padStart(2, "0");

function rfc3339(ms) {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function dayString(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 日時文字列を millis に。オフセット付き ISO はそのまま、素の日時はサーバーローカルとして解釈。 */
function parseMillis(s) {
  if (!s) return 0;
  const str = String(s).trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(str)) {
    const t = Date.parse(str);
    return Number.isNaN(t) ? 0 : t;
  }
  const m = str.replace("T", " ").match(/^(\d{4})-(\d{2})-(\d{2})(?:[ ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return 0;
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime();
}

async function insertRecurringEvent(accessToken, summary, location, startIso, endIso, recurrenceRules, privateProps) {
  const body = {
    summary,
    location,
    start: {
      dateTime: startIso,
      timeZone: "Asia/Tokyo",
    },
    end: {
      dateTime: endIso,
      timeZone: "Asia/Tokyo",
    },
    recurrence: recurrenceRules,
  };
  // 呼び出し側が付けた識別キー（再同期時の重複登録防止に使う）。
  if (privateProps) body.extendedProperties = { private: privateProps };
  const res = await fetch(API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error?.message || `カレンダー繰り返し登録エラー (${res.status})`);
}

/** extendedProperties.private のキーで登録済みイベントを探す（重複登録の判定用）。 */
async function findEventsByPrivateKey(accessToken, key, value) {
  const p = new URLSearchParams({
    privateExtendedProperty: `${key}=${value}`,
    maxResults: "1",
    showDeleted: "false",
  });
  const res = await fetch(`${API}?${p}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j?.error?.message || `カレンダー検索エラー (${res.status})`);
  return j.items || [];
}

module.exports = {
  SCOPE,
  isConfigured,
  authUrl,
  exchangeCode,
  accessTokenOf,
  listUpcomingEvents,
  insertDeadline,
  insertRecurringEvent,
  findEventsByPrivateKey,
};
