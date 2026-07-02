// Moodle 連携。個人カレンダーの iCal 書き出し URL(.ics) を取得して VEVENT を解析し、
// 課題(提出物)・予定として tasks テーブルへ取り込む。読み取り専用。
//
// 早稲田 Moodle など SSO 環境でも、カレンダーの「書き出し URL」はトークン付きで
// 認証不要に取得できるためこの方式を使う。

const db = require("./db");

// iCal を取得（リダイレクト追従。https/http のみ）。
function fetchIcs(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    let mod, u;
    try {
      u = new URL(url);
      mod = u.protocol === "http:" ? require("http") : require("https");
    } catch (e) {
      return reject(new Error("URL が不正です"));
    }
    const req = mod.get(u, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        const next = new URL(res.headers.location, u).toString();
        return resolve(fetchIcs(next, redirectsLeft - 1));
      }
      if (status < 200 || status >= 300) {
        res.resume();
        return reject(new Error(`iCal 取得に失敗 (HTTP ${status})`));
      }
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(data));
    });
    req.on("error", (e) => reject(e));
    req.setTimeout(20000, () => req.destroy(new Error("iCal 取得がタイムアウトしました")));
  });
}

// 折り返し（行頭スペース/タブは前行の続き）を戻す。
function unfoldLines(ics) {
  return ics.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
}

// ICS の日時値を "YYYY-MM-DD HH:MM:SS" と dateOnly に変換する。
function parseIcsDate(raw, params) {
  if (!raw) return null;
  const dateOnly = /VALUE=DATE(?!-TIME)/i.test(params || "") || /^\d{8}$/.test(raw.trim());
  const v = raw.trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?(Z)?$/);
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss, z] = m;
  if (dateOnly || !hh) {
    return { at: `${y}-${mo}-${d} 23:59:00`, dateOnly: true };
  }
  if (z === "Z") {
    // UTC → ローカル時刻へ
    const dt = new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mi, +ss || 0));
    const p = (n) => String(n).padStart(2, "0");
    return {
      at: `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())} ` +
        `${p(dt.getHours())}:${p(dt.getMinutes())}:${p(dt.getSeconds())}`,
      dateOnly: false,
    };
  }
  return { at: `${y}-${mo}-${d} ${hh}:${mi}:${ss || "00"}`, dateOnly: false };
}

function unescapeText(s) {
  return String(s || "")
    .replace(/\\n/gi, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

// ICS 文字列から予定を抽出。返り値: [{ summary, description, at, dateOnly }]
function parseEvents(ics) {
  const text = unfoldLines(ics);
  const events = [];
  let cur = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("BEGIN:VEVENT")) {
      cur = {};
    } else if (line.startsWith("END:VEVENT")) {
      if (cur && cur.start) {
        const parsed = parseIcsDate(cur.start, cur.startParams);
        if (parsed) {
          events.push({
            summary: unescapeText(cur.summary) || "(無題)",
            description: unescapeText(cur.description),
            // Moodle はコース名を CATEGORIES に入れる（無ければ LOCATION を試す）。
            course: unescapeText(cur.categories) || unescapeText(cur.location),
            at: parsed.at,
            dateOnly: parsed.dateOnly,
          });
        }
      }
      cur = null;
    } else if (cur) {
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      const keyPart = line.slice(0, idx); // 例: DTSTART;VALUE=DATE
      const value = line.slice(idx + 1);
      const name = keyPart.split(";")[0].toUpperCase();
      const params = keyPart.slice(name.length);
      if (name === "SUMMARY") cur.summary = value;
      else if (name === "DESCRIPTION") cur.description = value;
      else if (name === "CATEGORIES") cur.categories = value;
      else if (name === "LOCATION") cur.location = value;
      else if (name === "DTSTART") { cur.start = value; cur.startParams = params; }
    }
  }
  return events;
}

// 1ユーザー分を同期。取り込んだ件数を返す。
async function syncUser(email, url) {
  console.log(`[Moodle Sync] 取得開始: ${email} (URL: ${url})`);
  const ics = await fetchIcs(url);
  const events = parseEvents(ics);
  console.log(`[Moodle Sync] パース完了: 全 ${events.length} 件のイベントを取得しました。`);
  
  let imported = 0;
  for (const ev of events) {
    // 「提出」「due」「課題」を含むものは課題、それ以外は予定として登録。
    const isKadai = /(提出|課題|due|assignment|レポート|test|quiz|小テスト)/i.test(ev.summary);
    // 授業名（CATEGORIES）が取れていれば内容の先頭に付ける。
    const content = ev.course ? `[${ev.course}] ${ev.summary}` : ev.summary;
    const details = [ev.course ? `授業: ${ev.course}` : "", ev.description]
      .filter((s) => s).join(" / ") || "Moodle";
      
    console.log(`[Moodle Sync] ${isKadai ? '課題' : '予定'}を検知 - 科目: ${ev.course || '(科目情報なし)'}, タイトル: ${ev.summary}, 期限: ${ev.at}`);

    await db.addTask(email, {
      type: isKadai ? "kadai" : "yotei",
      content,
      details,
      deadline_at: ev.at,
      date_only: ev.dateOnly,
    });
    imported++;
  }
  console.log(`[Moodle Sync] 取得・登録完了: ${imported} 件を DB に反映しました。`);
  return imported;
}

// Moodle URL 登録済みの全ユーザーを同期。
async function syncAll() {
  let users = [];
  try {
    users = await db.listUsersWithMoodle();
  } catch (e) {
    console.error("Moodle 同期対象の取得に失敗:", e.message);
    return;
  }
  for (const u of users) {
    try {
      const n = await syncUser(u.email, u.moodle_ical_url);
      console.log(`Moodle 同期: ${u.email} → ${n} 件`);
    } catch (e) {
      console.error(`Moodle 同期に失敗 (${u.email}):`, e.message);
    }
  }
}

// 定期同期を開始（既定 72 時間＝3日ごと。重いので既定は控えめ）。0 で自動同期無効（手動のみ）。
function start() {
  const hours = Number(process.env.MOODLE_SYNC_INTERVAL_HOURS ?? 72);
  if (!(hours > 0)) {
    console.log("Moodle 自動同期は無効（手動同期のみ）");
    return;
  }
  const ms = hours * 3600 * 1000;
  setTimeout(function tick() {
    syncAll().finally(() => setTimeout(tick, ms));
  }, 60_000); // 起動1分後に初回
  console.log(`Moodle 定期同期: ${hours} 時間ごと`);
}

module.exports = { fetchIcs, parseEvents, syncUser, syncAll, start };
