// Gemini 連携。追加ライブラリは使わず Node 標準の fetch で Generative Language API を呼ぶ。
//
// API キーはサーバー共通の環境変数ではなく、**ユーザーごとに登録されたもの**を使う
// （users.gemini_api_key_enc に AES-256-GCM で暗号化保存。ダッシュボードから登録）。
// そのため各機能は対象ユーザーの email を第一引数に取り、そのユーザーのキーで呼ぶ。
//
// 提供する機能:
//   analyze(email, content)      ... 文字起こしから「課題」「予定」を抽出し、短い要約も返す
//   summarizeDay(email, day, …)  ... 1日分の文字起こしから「今日の出来事の要約」を作る
//   ask(email, question, ctx)    ... 蓄積データを文脈に、AIアシスタントとして自然文で回答＋必要なら操作コマンドを返す
//
// 環境変数:
//   GEMINI_MODEL ... 使用モデル（既定 gemini-2.5-flash-lite。サーバー共通）

const db = require("./db");
const { decryptCred } = require("./cred");

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
const ENDPOINT = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

// 日付のみで時刻が不明な締切に補う既定時刻（締切は1日の終わり=23:59 とみなす）。
const DEFAULT_DEADLINE_TIME = "23:59";

// キー未登録時に投げる/表示するメッセージ（ダッシュボードへの導線を含める）。
const NO_KEY_MESSAGE = "Gemini APIキーが未登録です。ダッシュボードの「アカウント」タブで登録してください";

// ユーザーの Gemini API キーを復号して返す（未登録なら ""）。
async function apiKeyFor(email) {
  const enc = await db.getGeminiKeyEnc(email);
  if (!enc) return "";
  try {
    return decryptCred(enc);
  } catch (e) {
    console.error(`Gemini APIキーの復号に失敗 (${email}):`, e.message);
    return "";
  }
}

// このユーザーで Gemini 機能が使えるか（キー登録済みか）。
async function isConfiguredFor(email) {
  return Boolean(await apiKeyFor(email));
}

async function requireApiKey(email) {
  const key = await apiKeyFor(email);
  if (!key) throw new Error(NO_KEY_MESSAGE);
  return key;
}

// キー登録時の疎通確認。モデル情報の GET が通れば有効なキーとみなす。
// 戻り値: { ok, error? }
async function verifyApiKey(apiKey) {
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}`, {
      headers: { "x-goog-api-key": apiKey },
    });
    if (res.ok) return { ok: true };
    const text = await res.text().catch(() => "");
    return { ok: false, error: `Gemini API エラー ${res.status}: ${text.slice(0, 200)}` };
  } catch (e) {
    return { ok: false, error: `Gemini API へ接続できません: ${e.message}` };
  }
}

// ---- 低レベル: JSON モードで1回 generateContent を呼ぶ ----
async function callJson(apiKey, prompt, responseSchema, { temperature = 0.2 } = {}) {
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
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
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
async function callText(apiKey, prompt, { temperature = 0.3 } = {}) {
  const res = await fetch(ENDPOINT(MODEL), {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
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

// ---- 資料ファイルの要約（PDF は inlineData、TXT はテキストで渡す） ----
// opts: { name, mimeType, text?, base64? }
async function summarizeDocument(email, { name, mimeType, text, base64 }) {
  const apiKey = await requireApiKey(email);
  const instruction =
    `次の資料「${name}」の内容を日本語で要約してください。` +
    `要点を箇条書き中心に300〜600字程度で。課題・提出物・締切・日付があれば必ず明記してください。`;
  const parts = [{ text: instruction }];
  if (base64 && mimeType) {
    parts.push({ inlineData: { mimeType, data: base64 } });
  } else if (text && text.trim()) {
    parts.push({ text: "\n\n--- 資料本文 ---\n" + text.slice(0, 100000) });
  } else {
    throw new Error("要約する内容がありません");
  }
  const res = await fetch(ENDPOINT(MODEL), {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: { temperature: 0.3 },
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Gemini API エラー ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  const out = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("").trim() || "";
  if (!out) throw new Error("Gemini から空の応答が返りました");
  return out;
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

const CANCELLATION_SCHEMA = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["kadai", "yotei", "any"] },
    target: { type: "string" },
    deadline: { type: "string" },
    details: { type: "string" },
  },
  required: ["type", "target", "deadline", "details"],
};

const UPDATE_SCHEMA = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["kadai", "yotei", "any"] },
    target: { type: "string" },
    deadline: { type: "string" },
    new_type: { type: "string", enum: ["kadai", "yotei", "same"] },
    new_content: { type: "string" },
    new_deadline: { type: "string" },
    new_details: { type: "string" },
  },
  required: ["type", "target", "deadline", "new_type", "new_content", "new_deadline", "new_details"],
};

const ANALYZE_SCHEMA = {
  type: "object",
  properties: {
    tasks: { type: "array", items: ITEM_SCHEMA },
    cancellations: { type: "array", items: CANCELLATION_SCHEMA },
    updates: { type: "array", items: UPDATE_SCHEMA },
    summary: { type: "string" },
  },
  required: ["tasks", "cancellations", "updates", "summary"],
};

function buildAnalyzePrompt(content, today) {
  return [
    "あなたは会議・ゼミ・日常会話の文字起こしから「課題」と「予定」を抜き出す優秀なAIアシスタントです。",
    `本日の日付は ${today} です。「来週」「明日」「今度の金曜」などの相対表現はこの日付基準で YYYY-MM-DD（時刻があれば YYYY-MM-DD HH:MM）へ変換してください。`,
    "",
    "次の文字起こしから以下を抽出してください。",
    "- type='kadai'（課題）: 宿題・タスク・提出物・やるべきこと。",
    "- type='yotei'（予定）: 会議・締切・イベント・約束など日時に紐づくもの。",
    "- cancellations: 既存の課題/予定を取り消す発話（例『明日の研究会なしで』『やっぱりゼミはキャンセル』『その予定消して』）。",
    "- updates: 既存の課題/予定を変更する発話（例『明日の研究会15時に変更』『ゼミは明後日に変更ね』『場所は52号館に変更』）。",
    "",
    "tasks の各項目について:",
    "- deadline: 期限/日時。YYYY-MM-DD か YYYY-MM-DD HH:MM。不明なら空文字。",
    "- content: 一言でわかる短い要約（例『レポート提出』『研究会議』）。",
    "- details: 担当・条件・場所などの補足。文字起こしにある情報のみ。",
    "",
    "cancellations の各項目について:",
    "- type: 予定なら yotei、課題なら kadai、不明なら any。",
    "- target: 取り消したい対象の短い名前（例『研究会』『ゼミ』『レポート提出』）。",
    "- deadline: 取り消し対象の日付/日時。YYYY-MM-DD か YYYY-MM-DD HH:MM。不明なら空文字。",
    "- details: 補足。文字起こしにある情報のみ。",
    "- 取り消し発話は tasks に入れないでください。",
    "",
    "updates の各項目について:",
    "- type: 予定なら yotei、課題なら kadai、不明なら any。",
    "- target: 変更したい既存対象の短い名前（例『研究会』『ゼミ』『レポート提出』）。",
    "- deadline: 変更前の対象を探すための日付/日時。発話に『明日の』などがあれば入れる。不明なら空文字。",
    "- new_type: 種別を変更するなら kadai/yotei、変更しないなら same。",
    "- new_content: 名前/内容を変更する場合の新しい名前。変更しないなら空文字。",
    "- new_deadline: 日時/期限を変更する場合の新しい日付/日時。YYYY-MM-DD か YYYY-MM-DD HH:MM。変更しないなら空文字。",
    "- new_details: 場所・メモなど詳細を変更する場合の新しい補足。変更しないなら空文字。",
    "- 変更発話は tasks や cancellations に入れないでください。",
    "",
    "さらに summary に、この文字起こしの内容を2〜4文で要約してください（何の話題だったか）。",
    "該当が無ければ tasks / cancellations / updates は空配列に。文字起こしに無いことは創作しないでください。",
    "",
    "=== 文字起こし ここから ===",
    content,
    "=== 文字起こし ここまで ===",
  ].join("\n");
}

// 文字起こしを解析して { kadai[], yotei[], tasks[], cancellations[], updates[], summary } を返す。
// kadai/yotei は後方互換（{deadline,content,details}）、tasks は正規化済み（deadline_at 付き）。
async function analyze(email, content, opts = {}) {
  const apiKey = await requireApiKey(email);
  const today = opts.today || localDate();
  const parsed = await callJson(apiKey, buildAnalyzePrompt(content, today), ANALYZE_SCHEMA, {
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
  const rawCancellations = Array.isArray(parsed.cancellations) ? parsed.cancellations : [];
  const cancellations = rawCancellations
    .map((it) => {
      const deadlineStr = String(it?.deadline ?? "").trim();
      const norm = normalizeDeadline(deadlineStr);
      const type = it?.type === "kadai" || it?.type === "yotei" ? it.type : "any";
      return {
        type,
        target: String(it?.target ?? "").trim(),
        details: String(it?.details ?? "").trim(),
        deadline_at: norm.at,
        date_only: norm.dateOnly,
      };
    })
    .filter((c) => c.target);
  const rawUpdates = Array.isArray(parsed.updates) ? parsed.updates : [];
  const updates = rawUpdates
    .map((it) => {
      const deadlineNorm = normalizeDeadline(String(it?.deadline ?? "").trim());
      const newDeadlineNorm = normalizeDeadline(String(it?.new_deadline ?? "").trim());
      const type = it?.type === "kadai" || it?.type === "yotei" ? it.type : "any";
      const newType = it?.new_type === "kadai" || it?.new_type === "yotei" ? it.new_type : null;
      return {
        type,
        target: String(it?.target ?? "").trim(),
        deadline_at: deadlineNorm.at,
        date_only: deadlineNorm.dateOnly,
        new_type: newType,
        new_content: String(it?.new_content ?? "").trim(),
        new_deadline_at: newDeadlineNorm.at,
        new_date_only: newDeadlineNorm.dateOnly,
        new_details: String(it?.new_details ?? "").trim(),
      };
    })
    .filter((u) => u.target && (u.new_type || u.new_content || u.new_deadline_at || u.new_details));

  // 後方互換の kadai/yotei（CSV 出力に利用）。
  const toLegacy = (t) => ({
    deadline: t.deadline_at || "",
    content: t.content,
    details: t.details,
  });

  return {
    tasks,
    cancellations,
    updates,
    kadai: tasks.filter((t) => t.type === "kadai").map(toLegacy),
    yotei: tasks.filter((t) => t.type === "yotei").map(toLegacy),
    summary: String(parsed.summary ?? "").trim(),
  };
}

// =====================================================================
// 2) 日次要約
// =====================================================================
// transcripts: [{ filename, content, summary }]
async function summarizeDay(email, day, transcripts) {
  const apiKey = await requireApiKey(email);
  const material = (transcripts || [])
    .map((t, i) => `--- (${i + 1}) ${t.filename || ""} ---\n${t.content || ""}`)
    .join("\n\n")
    .slice(0, 24000); // トークン上限の保険
  if (!material.trim()) return "";

  const prompt = [
    `あなたは利用者専属のAIアシスタントです。${day} の1日の文字起こしをもとに、その日の出来事の要約を作成してください。`,
    "形式:",
    "1) 冒頭に2〜3文の総括。",
    "2) 続けて『主な出来事』を箇条書き（時系列がわかれば時系列で）。",
    "3) 最後に『この日に出た課題・予定』があれば箇条書き。",
    "事実に忠実に、なかった情報は書かないでください。日本語で簡潔に。",
    "",
    "=== その日の文字起こし ===",
    material,
  ].join("\n");

  return callText(apiKey, prompt, { temperature: 0.3 });
}

// =====================================================================
// 3) AIチャット（質問応答 + 操作コマンド）
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
          op: { type: "string", enum: ["add_task", "complete_task", "delete_task", "update_task", "none"] },
          type: { type: "string", enum: ["kadai", "yotei"] },
          content: { type: "string" },
          details: { type: "string" },
          deadline: { type: "string" },
          target: { type: "string" },
        },
        required: ["op"],
      },
    },
    need_files: { type: "array", items: { type: "string" } },
  },
  required: ["reply", "actions", "need_files"],
};

// question: 利用者の発話。
// ctx: { today, tasks, summaries, calendar, courses, documents, snippets,
//        targetDay, dayTranscripts, history,
//        fileIndex:[{filename,chars,label}],            … 文字起こしの時間インデックス
//        fetchedTranscripts:[{filename,content}] }      … need_files 要求に応じて取得済みの本文（2回目呼び出し）
// 戻り値: { reply, actions:[…], needFiles:[filename] }
//   needFiles が非空のときは「このファイルの本文を読ませてほしい」という要求。
//   呼び出し側が本文を取得し、fetchedTranscripts に入れて再度 ask を呼ぶ（2段階検索）。
async function ask(email, question, ctx = {}) {
  const apiKey = await requireApiKey(email);
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
  const coursesText = (ctx.courses || [])
    .map((c) => {
      const dp = `${c.day || ""}${c.period != null ? c.period + "限" : ""}`.trim();
      const time = c.start_time ? ` ${c.start_time}-${c.end_time || ""}` : "";
      const room = c.room ? ` @${c.room}` : "";
      return `${dp}${time} ${c.name}${room}`.trim();
    })
    .filter((s) => s)
    .join("\n")
    .slice(0, 4000);
  const documentsText = (ctx.documents || [])
    .map((d) => `《${d.name}》\n${d.summary}`)
    .join("\n\n")
    .slice(0, 12000);
  const snippetsText = (ctx.snippets || [])
    .map((s) => `--- ${s.filename} ---\n${s.snippet}`)
    .join("\n\n")
    .slice(0, 8000);
  // 質問文から日付が特定できた場合、その日の文字起こし全文（キーワード抜粋ではなく）を渡す。
  const dayTranscriptsText = (ctx.dayTranscripts || [])
    .map((t) => `--- ${t.filename} ---\n${t.content}`)
    .join("\n\n")
    .slice(0, 30000);
  // 文字起こしの時間インデックス（本文なしの軽量一覧）。
  // Gemini はここから「読みたいファイル」を need_files で指名できる（トークン節約のための2段階検索）。
  const fileIndexText = (ctx.fileIndex || [])
    .map((f) => `${f.filename}${f.label ? `（${f.label}）` : ""} ${f.chars != null ? `${f.chars}字` : ""}`.trim())
    .join("\n")
    .slice(0, 8000);
  // need_files の要求に応じてシステムが取得したファイル本文（2回目の呼び出しで入る）。
  const fetchedText = (ctx.fetchedTranscripts || [])
    .map((t) => `--- ${t.filename} ---\n${t.content}`)
    .join("\n\n")
    .slice(0, 40000);
  // 直近の会話履歴（同じチャット画面内で文脈が途切れないようにする）。
  const historyText = (ctx.history || [])
    .map((m) => `${m.role === "user" ? "利用者" : "あなた"}: ${m.content}`)
    .join("\n")
    .slice(-6000);

  const prompt = [
    "あなたは利用者（大学生）専属の有能なAIアシスタントです。利用者の課題・予定・授業の記録・資料を把握しており、",
    "話し言葉で親しみやすく、かつ的確に答えます。",
    `本日は ${today} です。相対的な日付表現はこの日付基準で YYYY-MM-DD(HH:MM) に変換して扱ってください。`,
    "",
    ...(historyText ? [
      "【ここまでの会話（新しい発話ほど下）】",
      historyText,
      "この続きとして、話の流れ・指示語（それ、さっきの、など）を踏まえて応答してください。",
      "",
    ] : []),
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
    "■ 履修時間割（曜日・時限・科目・教室）:",
    "（早稲田大学の時限: 1限8:50〜10:30 / 2限10:40〜12:20 / 3限13:10〜14:50 / 4限15:05〜16:45 / 5限17:00〜18:40 / 6限18:55〜20:35）",
    coursesText || "（なし）",
    "",
    "■ 授業資料の要約（アップロードされた PDF/テキスト）:",
    documentsText || "（なし）",
    "",
    "■ 質問に関連する過去の授業・会話の文字起こし抜粋:",
    snippetsText || "（なし）",
    "",
    ...(ctx.targetDay ? [
      `■ ${ctx.targetDay} の授業記録（全文）:`,
      dayTranscriptsText || "（この日の記録なし）",
      "",
    ] : []),
    ...(fileIndexText ? [
      "■ 授業・会話の録音ファイル一覧（時間インデックス。本文は含まれていない）:",
      "（ファイル名は YYYY-MM-DD_HH.txt = その日の HH 時台の録音の文字起こし。括弧内はその時間帯の授業名）",
      fileIndexText,
      "",
    ] : []),
    ...(fetchedText ? [
      "■ あなたの要求（need_files）に応じて取得したファイル本文:",
      fetchedText,
      "",
    ] : []),
    "【利用者の発話】",
    question,
    "",
    "【あなたのすべきこと】",
    "- 質問（例『今日の予定は？』『締切が近い課題は？』）には、上のデータを根拠に簡潔に答える。reply に回答文。",
    "- 授業の内容に関する質問（例『先週の統計学で何やった？』『レポートの提出条件は？』）には、",
    "  文字起こし抜粋・資料要約・日次要約を根拠に答える。どの記録に基づくかを一言添える。",
    ...(fetchedText
      ? [
          "- 上の「取得したファイル本文」はあなたの要求で読み込み済みのもの。これと他のデータを根拠に必ず回答する。",
          "  need_files は空配列にすること（追加のファイル要求はできない）。本文に答えが無ければ正直に無いと言う。",
        ]
      : fileIndexText
      ? [
          "- 過去の授業・会話の具体的な内容（例『〇〇の授業でテストはいつと言っていた？』『先生が言った提出条件』）が",
          "  必要なのに、上のデータ（抜粋・要約）だけでは確信を持って答えられない場合は、推測で答えず、",
          "  need_files に読みたいファイル名を最大5件入れて返すこと。ファイル名は必ず上の一覧にあるものをそのまま使う。",
          "  選び方: 履修時間割の曜日・時限とファイル名の日付・時刻を突き合わせる",
          "  （例: 水曜3限の授業なら、水曜日の 13時台のファイル。直近の回から優先）。",
          "  need_files を返すとシステムが本文を取得してもう一度あなたを呼ぶので、そのときの reply は空文字でよい。",
          "  上のデータだけで十分答えられるなら need_files は空配列にして普通に回答する。",
        ]
      : []),
    "- 学習内容の一般的な質問（例『t検定ってなに？』）には、あなた自身の知識で分かりやすく教えてよい。",
    "  ただし利用者の記録にある情報と一般知識の説明は区別が伝わるように話す。",
    "- 依頼（例『来週月曜にゼミの予定入れといて』『数学の宿題が出てるらしい、登録して』）なら、",
    "  actions に op='add_task' を入れる。type は課題=kadai/予定=yotei、content=短い名前、",
    "  deadline=YYYY-MM-DD か YYYY-MM-DD HH:MM（不明なら空）、details=補足。",
    "- 『〇〇終わった/完了にして』なら op='complete_task'、target に対象の番号(#)か内容を入れる。",
    "- 『〇〇なしで/キャンセル/削除/消して』なら op='delete_task'、target に対象の番号(#)か内容を入れる。",
    "- 『〇〇を15時に変更』『〇〇は明後日に変更』『場所を△△に変更』なら op='update_task'、",
    "  target に既存対象、deadline に新しい日時（日時変更時）、content に新しい名前（名前変更時）、details に新しい補足（場所変更時）を入れる。",
    "- 操作が不要なら actions は op='none' 1件のみ、または空配列。",
    "- reply には、依頼を実行したことや結果が利用者に伝わる自然な一言を必ず入れる。",
    "  ※実際の登録はシステム側が actions を見て行うので、reply では『登録しておきました』のように話す。",
    "- 【重要】actions に入れない限り実際には何も登録・完了・削除・変更されない。操作依頼には必ず対応する",
    "  actions を入れること。逆に actions に入れていないのに reply で『登録した』と言ってはいけない。",
  ].join("\n");

  const parsed = await callJson(apiKey, prompt, ASK_SCHEMA, { temperature: 0.4 });
  const actions = (Array.isArray(parsed.actions) ? parsed.actions : [])
    .filter((a) => a && a.op && a.op !== "none")
    .map((a) => {
      const norm = normalizeDeadline(String(a.deadline ?? "").trim());
      return {
        op: a.op,
        type: a.type === "yotei" ? "yotei" : (a.type === "kadai" ? "kadai" : ""),
        content: String(a.content ?? "").trim(),
        details: String(a.details ?? "").trim(),
        deadline_at: norm.at,
        date_only: norm.dateOnly,
        target: String(a.target ?? "").trim(),
      };
    });
  // ファイル本文の追加要求。取得済み本文を渡した2回目の呼び出しでは受け付けない（無限ループ防止）。
  const needFiles = ctx.fetchedTranscripts
    ? []
    : (Array.isArray(parsed.need_files) ? parsed.need_files : [])
        .map((f) => String(f).trim())
        .filter(Boolean)
        .slice(0, 5);
  return { reply: String(parsed.reply ?? "").trim(), actions, needFiles };
}

// 発話から「登録すべき課題・予定」だけを抽出する。
// ask が reply で『登録した』と言いつつ actions を返し忘れたときの保険として使う。
const TASK_REQUEST_SCHEMA = {
  type: "object",
  properties: {
    tasks: { type: "array", items: ITEM_SCHEMA },
  },
  required: ["tasks"],
};

async function extractTaskRequests(email, question, today = localDate()) {
  const apiKey = await requireApiKey(email);
  const prompt = [
    "次の発話はアプリ利用者の依頼です。登録すべき課題・予定があればすべて抽出してください。",
    `本日は ${today} です。「明日」「来週の金曜」等の相対表現はこの日付基準で YYYY-MM-DD`,
    "（時刻があれば YYYY-MM-DD HH:MM）へ変換してください。",
    "type は課題=kadai / 予定=yotei。content は短い名前。deadline が不明なら空文字。",
    "登録の依頼でなければ tasks は空配列にすること。",
    "",
    "【発話】",
    question,
  ].join("\n");
  const parsed = await callJson(apiKey, prompt, TASK_REQUEST_SCHEMA, { temperature: 0.1 });
  return (Array.isArray(parsed.tasks) ? parsed.tasks : [])
    .map((t) => {
      const norm = normalizeDeadline(String(t.deadline ?? "").trim());
      return {
        type: t.type === "yotei" ? "yotei" : "kadai",
        content: String(t.content ?? "").trim(),
        details: String(t.details ?? "").trim(),
        deadline_at: norm.at,
        date_only: norm.dateOnly,
      };
    })
    .filter((t) => t.content);
}

// =====================================================================
// ユーティリティ
// =====================================================================
// "YYYY-MM-DD" / "YYYY-MM-DD HH:MM" → { at: "YYYY-MM-DD HH:MM:00" | null, dateOnly }
// 月日が1桁（"2026-7-2"）や区切りが "/" のゆらぎも受け付ける
// （LLM の出力ゆれで厳密な2桁ゼロ埋め形式にならず、deadline_at が黙って null になっていたのを修正）。
function normalizeDeadline(s) {
  if (!s) return { at: null, dateOnly: false };
  const t = String(s).trim();
  const dt = t.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})[ T](\d{1,2}):(\d{2})/);
  if (dt) {
    const mm = dt[2].padStart(2, "0");
    const dd = dt[3].padStart(2, "0");
    const hh = dt[4].padStart(2, "0");
    return { at: `${dt[1]}-${mm}-${dd} ${hh}:${dt[5]}:00`, dateOnly: false };
  }
  const d = t.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
  if (d) {
    const mm = d[2].padStart(2, "0");
    const dd = d[3].padStart(2, "0");
    return { at: `${d[1]}-${mm}-${dd} ${DEFAULT_DEADLINE_TIME}:00`, dateOnly: true };
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

module.exports = {
  analyze, summarizeDay, ask, extractTaskRequests, summarizeDocument,
  isConfiguredFor, verifyApiKey, localDate, MODEL, NO_KEY_MESSAGE,
};
