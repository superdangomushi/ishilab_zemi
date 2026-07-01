// LINE への警告/通知送信。LINE Messaging API の push を Node 標準 fetch で叩く。
//
// 必要な設定:
//   環境変数 LINE_CHANNEL_ACCESS_TOKEN ... LINE Developers のチャネルアクセストークン（長期）
//   accounts.json の各アカウントに lineUserId ... 送信先ユーザーの userId（U で始まる文字列）
//
// LINE_CHANNEL_ACCESS_TOKEN が未設定、または送信先 lineUserId が無い場合は送信をスキップする
// （アプリ/サーバーは動き続け、ローカル通知だけ機能する）。

const CHANNEL_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const PUSH_ENDPOINT = "https://api.line.me/v2/bot/message/push";

const isConfigured = () => Boolean(CHANNEL_TOKEN);

// to: 送信先 userId。text: 本文。成功で true、未設定/失敗で false（例外は投げない）。
async function pushText(to, text) {
  if (!CHANNEL_TOKEN || !to) return false;
  try {
    const res = await fetch(PUSH_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CHANNEL_TOKEN}`,
      },
      body: JSON.stringify({
        to,
        messages: [{ type: "text", text: String(text).slice(0, 4900) }],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`LINE push 失敗 ${res.status}: ${body.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error("LINE push 例外:", e.message);
    return false;
  }
}

module.exports = { isConfigured, pushText };
