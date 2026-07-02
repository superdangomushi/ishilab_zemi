// Gemini 連携。追加ライブラリは使わず Node 標準の fetch で Generative Language API を呼ぶ。
//
// 提供する機能:
//   analyze(content)      ... 文字起こしから「課題」「予定」を抽出し、短い要約も返す
//   summarizeDay(day, …)  ... 1日分の文字起こしから「今日の出来事の要約」を作る
//   ask(question, ctx)    ... 蓄積データを文脈に、秘書として自然文で回答＋必要なら操作コマンドを返す
//
// 必要な環境変数:
//   GEMINI_API_KEY ... Google AI Studio で発行した API キー（未設定なら各機能はスキップ/例外）
//   GEMINI_MODEL   ... 使用モデル（既定 gemini-2.5-flash）

const API_KEY = process.env.GEMINI_API_KEY || "";
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const ENDPOINT = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

// 日付のみで時刻が不明な締切に補う既定時刻（締切は1日の終わり=23:59 とみなす）。
const DEFAULT_DEADLINE_TIME = "23:59";

const isConfigured = () => Boolean(API_KEY);

// ---- 低レベル: JSON モードで1回 generateContent を呼ぶ ----
async function callJson(prompt, responseSchema, { temperature = 0.2 } = {}) {
  if (!API_KEY) throw new Error("GEMINI_API_KEY が未設定です");
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema,
      temperature,
    },
  };
  const res = await fetch(ENDPOINT(MODEL), {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gemini API エラー ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  if (!text) throw new Error("Gemini から空の応答が返りました");
  try {
    return JSON.parse(text);
  } catch (_e) {
    throw new Error("Gemini 応答の JSON 解析に失敗: " + text.slice(0, 300));
  }
}

// ---- 低レベル: ふつうのテキスト応答 ----
async function callText(prompt, { temperature = 0.3 } = {}) {
  if (!API_KEY) throw new Error("GEMINI_API_KEY が未設定です");
  const res = await fetch(ENDPOINT(MODEL), {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gemini API エラー ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("").trim() || "";
}

// =====================================================================
// 1) 抽出 + 要約
// =====================================================================
const ITEM_SCHEMA = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["kadai", "yotei"] },
    deadline: { type: "string" },
    content: { type: "string" },
    details: { type: "string" },
  },
  required: ["type", "deadline", "content", "details"],
};

const ANALYZE_SCHEMA = {
  type: "object",
  properties: {
    tasks: { type: "array", items: ITEM_SCHEMA },
    summary: { type: "string" },
  },
  required: ["tasks", "summary"],
};

function buildAnalyzePrompt(content, today) {
  return [
    "あなたは会議・ゼミ・日常会話の文字起こしから「課題」と「予定」を抜き出す優秀な秘書です。",
    `本日の日付は ${today} です。「来週」「明日」「今度の金曜」などの相対表現はこの日付基準で YYYY-MM-DD（時刻があれば YYYY-MM-DD HH:MM）へ変換してください。`,
    "",
    "次の文字起こしから以下を抽出してください。",
    "- type='kadai'（課題）: 宿題・タスク・提出物・やるべきこと。",
    "- type='yotei'（予定）: 会議・締切・イベント・約束など日時に紐づくもの。",
    "",
    "各項目について:",
    "- deadline: 期限/日時。YYYY-MM-DD か YYYY-MM-DD HH:MM。不明なら空文字。",
    "- content: 一言でわかる短い要約（例『レポート提出』『研究会議』）。",
    "- details: 担当・条件・場所などの補足。文字起こしにある情報のみ。",
    "",
    "さらに summary に、この文字起こしの内容を2〜4文で要約してください（何の話題だったか）。",
    "該当が無ければ tasks は空配列に。文字起こしに無いことは創作しないでください。",
    "",
    "=== 文字起こし ここから ===",
    content,
    "=== 文字起こし ここまで ===",
  ].join("\n");
}

// 文字起こしを解析して { kadai[], yotei[], tasks[], summary } を返す。
// kadai/yotei は後方互換（{deadline,content,details}）、tasks は正規化済み（deadline_at 付き）。
async function analyze(content, opts = {}) {
  const today = opts.today || localDate();
  const parsed = await callJson(buildAnalyzePrompt(content, today), ANALYZE_SCHEMA, {
    temperature: 0.2,
  });

  const rawTasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
  const tasks = rawTasks
    .map((it) => {
      const deadlineStr = String(it?.deadline ?? "").trim();
      const norm = normalizeDeadline(deadlineStr);
      return {
        type: it?.type === "yotei" ? "yotei" : "kadai",
        content: String(it?.content ?? "").trim(),
        details: String(it?.details ?? "").trim(),
        deadline_at: norm.at,
        date_only: norm.dateOnly,
      };
    })
    .filter((t) => t.content);

  // 後方互換の kadai/yotei（CSV 出力に利用）。
  const toLegacy = (t) => ({
    deadline: t.deadline_at || "",
    content: t.content,
    details: t.details,
  });

  return {
    tasks,
    kadai: tasks.filter((t) => t.type === "kadai").map(toLegacy),
    yotei: tasks.filter((t) => t.type === "yotei").map(toLegacy),
    summary: String(parsed.summary ?? "").trim(),
  };
}

// =====================================================================
// 2) 日次要約
// =====================================================================
// transcripts: [{ filename, content, summary }]
async function summarizeDay(day, transcripts) {
  const material = (transcripts || [])
    .map((t, i) => `--- (${i + 1}) ${t.filename || ""} ---\n${t.content || ""}`)
    .join("\n\n")
    .slice(0, 24000); // トークン上限の保険
  if (!material.trim()) return "";

  const prompt = [
    `あなたは利用者専属の秘書です。${day} の1日の文字起こしをもとに、その日の出来事の要約を作成してください。`,
    "形式:",
    "1) 冒頭に2〜3文の総括。",
    "2) 続けて『主な出来事』を箇条書き（時系列がわかれば時系列で）。",
    "3) 最後に『この日に出た課題・予定』があれば箇条書き。",
    "事実に忠実に、なかった情報は書かないでください。日本語で簡潔に。",
    "",
    "=== その日の文字起こし ===",
    material,
  ].join("\n");

  return callText(prompt, { temperature: 0.3 });
}

// =====================================================================
// 3) 秘書チャット（質問応答 + 操作コマンド）
// =====================================================================
const ASK_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["add_task", "complete_task", "none"] },
          type: { type: "string", enum: ["kadai", "yotei"] },
          content: { type: "string" },
          details: { type: "string" },
          deadline: { type: "string" },
          target: { type: "string" },
        },
        required: ["op"],
      },
    },
  },
  required: ["reply", "actions"],
};

// question: 利用者の発話。 ctx: { today, tasks:[…], summaries:[{day,summary}] }
// 戻り値: { reply, actions:[{op, type, content, details, deadline_at, date_only, target}] }
async function ask(question, ctx = {}) {
  const today = ctx.today || localDate();
  const tasksText = (ctx.tasks || [])
    .map(
      (t) =>
        `#${t.id} [${t.type === "yotei" ? "予定" : "課題"}] ${t.content}` +
        `${t.deadline_at ? ` (期限 ${t.deadline_at})` : ""}` +
        `${t.status === "done" ? " ※完了" : ""}` +
        `${t.details ? ` — ${t.details}` : ""}`
    )
    .join("\n");
  const summariesText = (ctx.summaries || [])
    .map((s) => `[${s.day}] ${s.summary}`)
    .join("\n\n")
    .slice(0, 8000);
  const calendarText = (ctx.calendar || [])
    .map((e) => `${e.whenText || e.when || ""} ${e.title || ""}`.trim())
    .filter((s) => s)
    .join("\n")
    .slice(0, 4000);

  const prompt = [
    "あなたは利用者専属の有能な秘書です。利用者の課題・予定・日々の記録を把握しており、",
    "話し言葉で親しみやすく、かつ的確に答えます。",
    `本日は ${today} です。相対的な日付表現はこの日付基準で YYYY-MM-DD(HH:MM) に変換して扱ってください。`,
    "",
    "【あなたが把握しているデータ】",
    "■ 現在の課題・予定一覧:",
    tasksText || "（登録なし）",
    "",
    "■ 最近の日次要約:",
    summariesText || "（なし）",
    "",
    "■ カレンダーの予定（Googleカレンダー等）:",
    calendarText || "（なし）",
    "",
    "【利用者の発話】",
    question,
    "",
    "【あなたのすべきこと】",
    "- 質問（例『今日の予定は？』『締切が近い課題は？』）には、上のデータを根拠に簡潔に答える。reply に回答文。",
    "- 依頼（例『来週月曜にゼミの予定入れといて』『数学の宿題が出てるらしい、登録して』）なら、",
    "  actions に op='add_task' を入れる。type は課題=kadai/予定=yotei、content=短い名前、",
    "  deadline=YYYY-MM-DD か YYYY-MM-DD HH:MM（不明なら空）、details=補足。",
    "- 『〇〇終わった/完了にして』なら op='complete_task'、target に対象の番号(#)か内容を入れる。",
    "- 操作が不要なら actions は op='none' 1件のみ、または空配列。",
    "- reply には、依頼を実行したことや結果が利用者に伝わる自然な一言を必ず入れる。",
    "  ※実際の登録はシステム側が actions を見て行うので、reply では『登録しておきました』のように話す。",
  ].join("\n");

  const parsed = await callJson(prompt, ASK_SCHEMA, { temperature: 0.4 });
  const actions = (Array.isArray(parsed.actions) ? parsed.actions : [])
    .filter((a) => a && a.op && a.op !== "none")
    .map((a) => {
      const norm = normalizeDeadline(String(a.deadline ?? "").trim());
      return {
        op: a.op,
        type: a.type === "yotei" ? "yotei" : "kadai",
        content: String(a.content ?? "").trim(),
        details: String(a.details ?? "").trim(),
        deadline_at: norm.at,
        date_only: norm.dateOnly,
        target: String(a.target ?? "").trim(),
      };
    });
  return { reply: String(parsed.reply ?? "").trim(), actions };
}

// =====================================================================
// ユーティリティ
// =====================================================================
// "YYYY-MM-DD" / "YYYY-MM-DD HH:MM" → { at: "YYYY-MM-DD HH:MM:00" | null, dateOnly }
function normalizeDeadline(s) {
  if (!s) return { at: null, dateOnly: false };
  const dt = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/);
  if (dt) {
    const hh = dt[4].padStart(2, "0");
    return { at: `${dt[1]}-${dt[2]}-${dt[3]} ${hh}:${dt[5]}:00`, dateOnly: false };
  }
  const d = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (d) {
    return { at: `${d[1]}-${d[2]}-${d[3]} ${DEFAULT_DEADLINE_TIME}:00`, dateOnly: true };
  }
  return { at: null, dateOnly: false };
}

// サーバーのローカル日付 "YYYY-MM-DD"。
function localDate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

module.exports = { analyze, summarizeDay, ask, isConfigured, localDate, MODEL };
