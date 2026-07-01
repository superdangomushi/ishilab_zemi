const ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const PUSH_ENDPOINT = "https://api.line.me/v2/bot/message/push";

// LINE のテキストメッセージは 1 通あたり最大 5000 文字。余裕をもって切る。
const MAX_TEXT_LENGTH = 4900;

const isConfigured = () => Boolean(ACCESS_TOKEN);

// 指定した userId（またはグループ ID）へテキストを送る。
async function pushText(to, text) {
  if (!ACCESS_TOKEN) throw new Error("LINE_CHANNEL_ACCESS_TOKEN が未設定です");
  if (!to) throw new Error("送信先 (userId) が未指定です");

  const body = {
    to,
    messages: [{ type: "text", text: text.slice(0, MAX_TEXT_LENGTH) }],
  };

  const res = await fetch(PUSH_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`LINE API エラー ${res.status}: ${detail.slice(0, 300)}`);
  }
}

module.exports = { pushText, isConfigured };
