// 文字起こしテキストを Gemini に渡し、「課題」と「予定」を構造化抽出する。
// 追加ライブラリは使わず Node 標準の fetch で Generative Language API を呼ぶ。
//
// 必要な環境変数:
//   GEMINI_API_KEY ... Google AI Studio で発行した API キー（未設定なら解析はスキップ）
//   GEMINI_MODEL   ... 使用モデル（既定 gemini-2.5-flash）

const API_KEY = process.env.GEMINI_API_KEY || "";
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const ENDPOINT = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

// 抽出結果のスキーマ。キーは ASCII にして CSV 出力時に日本語ヘッダへ変換する。
// deadline=期限, content=内容, details=詳細
const ITEM_SCHEMA = {
  type: "object",
  properties: {
    deadline: { type: "string" },
    content: { type: "string" },
    details: { type: "string" },
  },
  required: ["deadline", "content", "details"],
};

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    kadai: { type: "array", items: ITEM_SCHEMA },
    yotei: { type: "array", items: ITEM_SCHEMA },
  },
  required: ["kadai", "yotei"],
};

function buildPrompt(content, today) {
  return [
    "あなたは会議・ゼミの文字起こしから「課題」と「予定」を抜き出すアシスタントです。",
    `本日の日付は ${today} です。「来週」「明日」などの相対的な表現はこの日付を基準に YYYY-MM-DD へ変換してください。`,
    "",
    "次の文字起こしを読み、以下の2種類を抽出してください。",
    "- 課題 (kadai): やるべきこと・宿題・タスク・成果物など。",
    "- 予定 (yotei): 会議・締切・イベントなど日時に紐づく予定。",
    "",
    "各項目について次の3つを埋めてください。",
    "- deadline (期限): 期限や日時。YYYY-MM-DD 形式を優先。時刻があれば YYYY-MM-DD HH:MM。不明なら空文字。",
    "- content (内容): 一言でわかる短い要約。",
    "- details (詳細): 背景・担当者・条件などの補足。文字起こしにある情報のみ。",
    "",
    "該当が無ければ空配列にしてください。文字起こしに無いことは創作しないでください。",
    "",
    "=== 文字起こし ここから ===",
    content,
    "=== 文字起こし ここまで ===",
  ].join("\n");
}

// 解析できない場合は例外を投げる。呼び出し側でアップロード自体は失敗させない想定。
async function analyze(content, opts = {}) {
  if (!API_KEY) {
    throw new Error("GEMINI_API_KEY が未設定です");
  }
  const today = opts.today || new Date().toISOString().slice(0, 10);

  const body = {
    contents: [{ role: "user", parts: [{ text: buildPrompt(content, today) }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.2,
    },
  };

  const res = await fetch(ENDPOINT(MODEL), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": API_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gemini API エラー ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  if (!text) {
    throw new Error("Gemini から空の応答が返りました");
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error("Gemini 応答の JSON 解析に失敗: " + text.slice(0, 300));
  }

  return {
    kadai: normalizeItems(parsed.kadai),
    yotei: normalizeItems(parsed.yotei),
  };
}

function normalizeItems(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((it) => ({
    deadline: String(it?.deadline ?? "").trim(),
    content: String(it?.content ?? "").trim(),
    details: String(it?.details ?? "").trim(),
  }));
}

const isConfigured = () => Boolean(API_KEY);

module.exports = { analyze, isConfigured, MODEL };
