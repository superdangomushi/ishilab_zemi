// 音声ファイルのサーバー側文字起こし。
//
// 端末は音声(WAV等)を POST /api/audio へアップロードするだけで、重い処理はサーバーが行う:
//   1. アップロードを uploads/audio/ に保存し、audio_jobs に queued で登録
//   2. ワーカーが順番にローカルの Whisper (faster-whisper) で文字起こし
//      （Gemini はトークン消費が大きいため文字起こしには使わない。導入は `make stt-deps`）
//   3. 文字起こし結果は従来のテキストアップロードと同じ流れ
//      （transcripts 保存 → 課題/予定の抽出(Gemini) → tasks 登録）に乗せる
//   4. 進行状況は audio_jobs.status（queued/processing/done/error）で確認できる

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const db = require("./db");
const gemini = require("./gemini");
const reminders = require("./reminders");

const STT_DIR = path.join(__dirname, "stt");

// ローカル文字起こしに使う python。WHISPER_PYTHON で上書きでき、
// 既定は stt/.venv（make stt-deps が作る）の python。
function sttPython() {
  if (process.env.WHISPER_PYTHON) return process.env.WHISPER_PYTHON;
  const venv = path.join(STT_DIR, ".venv", "bin", "python3");
  return fs.existsSync(venv) ? venv : null;
}

// stt/transcribe.py を子プロセスで実行し、stdout の本文を返す。
function localTranscribe(filePath) {
  return new Promise((resolve, reject) => {
    const py = sttPython();
    if (!py) {
      return reject(new Error(
        "ローカル文字起こしが未設定です（サーバーで `make stt-deps` を実行してください）"
      ));
    }
    const child = spawn(py, [path.join(STT_DIR, "transcribe.py"), filePath], { env: process.env });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => { out += c.toString(); });
    child.stderr.on("data", (c) => { err = (err + c.toString()).slice(-2000); });
    child.on("error", (e) => reject(new Error(`文字起こしを起動できません: ${e.message}`)));
    // 長時間録音対策のタイムアウト（2時間）。
    const timer = setTimeout(() => child.kill("SIGKILL"), 2 * 3600_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(out.trim());
      const tail = err.trim().split("\n").filter(Boolean).slice(-2).join(" / ");
      reject(new Error(`文字起こし失敗 (exit ${code})${tail ? `: ${tail}` : ""}`));
    });
  });
}

const AUDIO_DIR = path.join(__dirname, "uploads", "audio");

// 同時実行は1本（Gemini への負荷と RAM を抑える）。
let running = false;

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
  // 登録したらすぐ処理を試みる（実行中なら次の周回で拾われる）。
  setImmediate(processQueue);
  return id;
}

// キューを処理し切る。多重起動しない。
async function processQueue() {
  if (running) return;
  running = true;
  try {
    while (true) {
      const job = await db.claimNextAudioJob();
      if (!job) break;
      await processJob(job);
    }
  } catch (e) {
    console.error("音声ジョブ処理ループでエラー:", e.message);
  } finally {
    running = false;
  }
}

async function processJob(job) {
  console.log(`音声文字起こし開始: #${job.id} ${job.email} ${job.filename}`);
  try {
    if (!fs.existsSync(job.stored_path)) throw new Error("音声ファイルが見つかりません");

    const text = await localTranscribe(job.stored_path);
    if (!text.trim()) {
      // 無音などで本文なし。エラーではなく完了扱いにする。
      await db.finishAudioJob(job.id, { status: "done" });
      fs.unlink(job.stored_path, () => {});
      console.log(`音声文字起こし完了(本文なし): #${job.id}`);
      return;
    }

    // テキストアップロードと同じファイル名規約（yyyy-MM-dd_HH.txt）に寄せる。
    // 同じ時間帯に複数回録音停止すると同名ファイルになり得るため、
    // saveTranscript（上書き）ではなく appendTranscript（追記）で既存分を残す。
    const txtName = job.filename.replace(/\.[^.]+$/, "") + ".txt";
    const transcriptId = await db.appendTranscript(job.email, txtName, text);

    // 課題・予定・要約の抽出も同じパイプラインで実行（失敗しても文字起こし自体は成功扱い）。
    try {
      const result = await gemini.analyze(text);
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

    await db.finishAudioJob(job.id, { status: "done", transcriptId });
    try {
      const day = gemini.localDate();
      const daily = await reminders.generateDailySummary(job.email, day);
      if (daily) console.log(`音声ジョブ #${job.id} 完了後に日次要約を更新: ${job.email} ${day}`);
    } catch (e) {
      console.error(`音声ジョブ #${job.id} 完了後の日次要約生成に失敗:`, e.message);
    }
    fs.unlink(job.stored_path, () => {}); // 処理済み音声は保持しない
    console.log(`音声文字起こし完了: #${job.id} -> ${txtName} (${text.length} 文字)`);
  } catch (e) {
    console.error(`音声文字起こし失敗: #${job.id}:`, e.message);
    await db.finishAudioJob(job.id, { status: "error", error: String(e.message).slice(0, 1000) });
  }
}

// 起動時: 中断されたジョブを queued に戻し、定期的にキューを見る。
function start() {
  ensureDir();
  db.requeueStaleAudioJobs()
    .then((n) => { if (n > 0) console.log(`中断されていた音声ジョブ ${n} 件を再キューしました`); })
    .catch(() => {});
  setInterval(processQueue, 60_000);
  setTimeout(processQueue, 5_000); // 起動直後にも一度
  console.log("音声文字起こしワーカーを開始しました");
}

module.exports = { enqueue, processQueue, start };
