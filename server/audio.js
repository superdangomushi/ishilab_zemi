// 音声ファイルの文字起こしジョブ管理。
//
// 端末は音声(WAV等)を POST /api/audio へアップロードするだけ:
//   1. アップロードを uploads/audio/ に保存し、audio_jobs に queued で登録
//   2. ローカルPCの client/audio-worker.js が10秒ごとに
//      claim → download → Whisper 処理 → result 送信する
//   3. 文字起こし結果は従来のテキストアップロードと同じ流れ
//      （transcripts 保存 → 課題/予定の抽出(Gemini) → tasks 登録）に乗せる
//   4. 進行状況は audio_jobs.status（queued/processing/done/error）で確認できる

const fs = require("fs");
const path = require("path");
const db = require("./db");
const gemini = require("./gemini");
const reminders = require("./reminders");

const AUDIO_DIR = path.join(__dirname, "uploads", "audio");
// 処理中ジョブのハートビート（クライアントが3秒ごとのメトリクスに載せる activeJobId）が
// この分数以上途絶えたら、ワーカー停止とみなして queued に戻し別のPCへ振り直す。
// ハートビートを送らない旧クライアントでは、10分を超える処理は途中で奪われてやり直しになる。
const STALE_WORKER_MIN = Math.max(Number(process.env.AUDIO_WORKER_STALE_MIN || 10), 1);

function ensureDir() {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

// アップロードされた音声を保存してジョブ登録し、ジョブ ID を返す。
async function enqueue(email, filename, buffer, mime) {
  ensureDir();
  const safe = path.basename(filename).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);
  const stored = path.join(AUDIO_DIR, `${Date.now()}-${safe}`);
  fs.writeFileSync(stored, buffer);
  const id = await db.createAudioJob(email, safe, stored, mime, buffer.length);
  return id;
}

async function finishJobWithText(job, text) {
  const body = String(text || "").trim();
  if (!body) {
    // 無音などで本文なし。エラーではなく完了扱いにする。
    await db.finishAudioJob(job.id, { status: "done" });
    fs.unlink(job.stored_path, () => {});
    console.log(`音声文字起こし完了(本文なし): #${job.id}`);
    return { empty: true, transcriptId: null };
  }

  // テキストアップロードと同じファイル名規約（yyyy-MM-dd_HH.txt）に寄せる。
  // 同じ時間帯に複数回録音停止すると同名ファイルになり得るため、
  // saveTranscript（上書き）ではなく appendTranscript（追記）で既存分を残す。
  const txtName = job.filename.replace(/\.[^.]+$/, "") + ".txt";
  const transcriptId = await db.appendTranscript(job.email, txtName, body);

  // 課題・予定・要約の抽出も同じパイプラインで実行（失敗しても文字起こし自体は成功扱い）。
  // Gemini APIキーはジョブ所有者のものを使う。未登録ならスキップ（文字起こしは残る）。
  // ユーザーが自動解析を off にしている場合もスキップし、ダッシュボードの
  // 「解析する」ボタンからの手動実行に任せる。
  const geminiAuto = await db.getGeminiAuto(job.email).catch(() => true);
  if (geminiAuto) {
    try {
      if (!(await gemini.isConfiguredFor(job.email))) {
        throw new Error(gemini.NO_KEY_MESSAGE);
      }
      const result = await gemini.analyze(job.email, body);
      await db.saveAnalysis(transcriptId, result.kadai, result.yotei, result.summary);
      await db.upsertTasks(job.email, result.tasks, transcriptId);
      const updated = await db.applyTaskUpdates(job.email, result.updates);
      const canceled = await db.cancelTasks(job.email, result.cancellations);
      if (updated.length) {
        console.log(`音声ジョブ #${job.id} で予定/課題を ${updated.length} 件変更しました`);
      }
      if (canceled.length) {
        console.log(`音声ジョブ #${job.id} で予定/課題を ${canceled.length} 件削除しました`);
      }
    } catch (e) {
      console.error(`音声ジョブ #${job.id} の解析に失敗:`, e.message);
    }
  }

  await db.finishAudioJob(job.id, { status: "done", transcriptId });
  if (geminiAuto) {
    try {
      const day = gemini.localDate();
      const daily = await reminders.generateDailySummary(job.email, day);
      if (daily) console.log(`音声ジョブ #${job.id} 完了後に日次要約を更新: ${job.email} ${day}`);
    } catch (e) {
      console.error(`音声ジョブ #${job.id} 完了後の日次要約生成に失敗:`, e.message);
    }
  }
  fs.unlink(job.stored_path, () => {}); // 処理済み音声は保持しない
  console.log(`音声文字起こし完了: #${job.id} -> ${txtName} (${body.length} 文字)`);
  return { empty: false, transcriptId, filename: txtName, chars: body.length };
}

// ローカルPCの外部ワーカー用: queued ジョブを1件だけ確保する。
// workerId は登録済みワーカー（audio_workers）の内部ID。複数PCが同時に
// ポーリングしても claim は1件ずつ原子的に確保されるため、手が空いたPCから順に
// 別々のジョブが割り振られる。
// private（既定）はログインユーザー本人のジョブのみ。global は所有者本人のジョブと、
// そのPCの利用をPC選択画面で明示的に許可したユーザーのジョブだけを対象にする
// （オプトイン。何も設定していないユーザーのジョブは他人のPCへ流れない）。
async function claimRemoteJob(email, workerId, { global = false } = {}) {
  const job = await db.claimNextAudioJob(global ? null : email, workerId, {
    respectPrefs: global,
    workerOwner: email,
  });
  if (!job) return null;
  // 音声認識クオリティはジョブ所有者の設定に従う（globalでは処理PCの持ち主と異なる）。
  const quality = await db.getSttQuality(job.email).catch(() => "high");
  return {
    id: job.id,
    filename: job.filename,
    mime: job.mime || "audio/wav",
    sizeBytes: job.size_bytes || 0,
    quality,
  };
}

// claim 済みジョブの取得。workerId は必須で、認証アカウント所有のワーカーが
// 自分で claim したジョブ以外は返さない（取違・なりすまし防止）。
async function getClaimedJob(email, id, workerId) {
  if (!workerId) return null;
  const job = await db.getClaimedAudioJob(email, Number(id), workerId);
  if (!job) return null;
  if (!fs.existsSync(job.stored_path)) {
    await db.finishAudioJob(job.id, { status: "error", error: "音声ファイルが見つかりません" });
    return null;
  }
  return job;
}

async function completeRemoteJob(email, id, { text, error, workerId } = {}) {
  const job = await getClaimedJob(email, id, workerId);
  if (!job) return { ok: false, status: 404, error: "処理中の音声ジョブが見つかりません" };
  if (error) {
    await db.finishAudioJob(job.id, { status: "error", error: String(error).slice(0, 1000) });
    return { ok: true, status: "error" };
  }
  try {
    const result = await finishJobWithText(job, text || "");
    return { ok: true, status: "done", ...result };
  } catch (e) {
    console.error(`外部ワーカー結果の保存に失敗: #${job.id}:`, e.message);
    await db.finishAudioJob(job.id, { status: "error", error: String(e.message).slice(0, 1000) });
    return { ok: false, status: 500, error: e.message };
  }
}

// 起動時: 中断されたジョブを queued に戻し、定期的にキューを見る。
function start() {
  ensureDir();
  db.requeueStaleAudioJobs(STALE_WORKER_MIN)
    .then((n) => { if (n > 0) console.log(`中断されていた音声ジョブ ${n} 件を再キューしました`); })
    .catch(() => {});
  setInterval(
    () => db.requeueStaleAudioJobs(STALE_WORKER_MIN)
      .then((n) => { if (n > 0) console.log(`停止した外部音声ジョブ ${n} 件を再キューしました`); })
      .catch(() => {}),
    60_000
  );
  console.log("音声文字起こしは client/audio-worker.js からの外部PC処理待ちです");
}

module.exports = {
  enqueue,
  start,
  claimRemoteJob,
  getClaimedJob,
  completeRemoteJob,
};
