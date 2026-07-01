const db = require("./db");
const summary = require("./summary");

(async () => {
  try {
    const result = await summary.sendDailySummary();
    console.log("完了:", result);
  } catch (e) {
    console.error("送信に失敗:", e.message);
    process.exitCode = 1;
  } finally {
    await db.pool.end().catch(() => {});
  }
})();
