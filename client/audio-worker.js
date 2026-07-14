#!/usr/bin/env node
// 公開サーバー上の音声ジョブを、このPCで処理する外部ワーカー。
//
// このプロセスは同時にローカル管理UIも起動する:
//   http://127.0.0.1:39123
//
// 起動後の最初のフェーズは「クライアント登録（アカウント作成）」:
//   1. UIで公開サーバーURL・このPCの表示名を決め、メール+パスワードでログイン
//   2. クライアントがこのPC用の ID（UUID）を自動生成し、表示名とともに
//      POST /api/client/register でサーバーに登録する
//   3. 登録が済んだアカウントだけがジョブのポーリングを開始する
//
// 以後のサーバーとのやりとりはすべて JSON ボディで行い、毎リクエストに
// 認証情報（auth.email / auth.token）と clientId（UUID）を含める。
// 音声のダウンロードも「認証情報+clientId+jobId のJSONリクエスト → WAV応答」で、
// 自分が claim したジョブ以外は取得できない（なりすまし・取違防止）。
// パスワードはログイン時に一度使うだけで保存しない。

const crypto = require("crypto");
const { execFile } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { localTranscribe } = require("./stt-local");

const DEFAULT_BASE_URL = String(process.env.AIHELPER_SERVER_URL || process.env.SERVER_URL || "http://localhost:3000")
  .replace(/\/+$/, "");
const CONFIG_PATH = process.env.AUDIO_WORKER_CONFIG || path.join(__dirname, "accounts.json");
const POLL_INTERVAL_MS = Math.max(Number(process.env.AUDIO_WORKER_POLL_SEC || 10), 1) * 1000;
const METRICS_INTERVAL_MS = Math.max(Number(process.env.AUDIO_WORKER_METRICS_SEC || 3), 1) * 1000;
const UI_HOST = process.env.AUDIO_WORKER_UI_HOST || "127.0.0.1";
const UI_PORT = Number(process.env.AUDIO_WORKER_UI_PORT || 39123);
const WORK_DIR = process.env.AUDIO_WORKER_DIR || path.join(__dirname, "worker-audio");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

fs.mkdirSync(WORK_DIR, { recursive: true });

let config = loadConfig();
const runtime = new Map();
let stopping = false;
let uiServer = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

// undici の fetch は接続失敗をすべて「fetch failed」に丸めてしまい、原因が
// ログから分からない。cause を辿って ECONNREFUSED 127.0.0.1:443 のような
// 実際の接続先とエラーコードまで表示する（DNS異常やURL間違いの切り分け用）。
function describeError(e) {
  const parts = [];
  let c = e;
  while (c && parts.length < 5) {
    if (Array.isArray(c.errors) && c.errors.length) {
      c = c.errors[0]; // AggregateError: 代表して先頭を辿る
      continue;
    }
    const host = c.address || c.hostname || "";
    const addr = host ? ` ${host}${c.port ? `:${c.port}` : ""}` : "";
    const label = c.code ? `${c.code}${addr}` : (c.message || String(c));
    if (!parts.includes(label)) parts.push(label);
    c = c.cause;
  }
  return parts.join(" ← ") || String(e);
}

function cleanBaseUrl(value) {
  const s = String(value || "").trim().replace(/\/+$/, "");
  return s || DEFAULT_BASE_URL;
}

function loadConfig() {
  let loaded = null;
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      loaded = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    }
  } catch (e) {
    console.error(`設定ファイルの読み込みに失敗: ${CONFIG_PATH}: ${e.message}`);
  }

  const accounts = Array.isArray(loaded?.accounts) ? loaded.accounts : [];
  const cfg = {
    baseUrl: cleanBaseUrl(loaded?.baseUrl || DEFAULT_BASE_URL),
    // このPCの公開範囲。private=登録したアカウントの音声のみ、global=全ユーザーの音声を処理。
    mode: normalizeMode(loaded?.mode),
    // ユーザーが決めるこのPCの表示名（サーバーのPC選択画面に出る）。既定はホスト名。
    clientName: String(loaded?.clientName || "").trim().slice(0, 100) || null,
    accounts: accounts
      .map(normalizeAccount)
      .filter((a) => a.email && a.token),
  };

  const envEmail = String(process.env.AIHELPER_EMAIL || process.env.EMAIL || "").trim();
  const envToken = String(process.env.AIHELPER_TOKEN || process.env.TOKEN || "").trim();
  if (envEmail && envToken && !cfg.accounts.some((a) => a.email === envEmail)) {
    cfg.accounts.push({
      email: envEmail,
      token: envToken,
      enabled: true,
      source: "env",
      clientId: null,
      registered: false,
      addedAt: nowIso(),
      updatedAt: nowIso(),
    });
  }
  return cfg;
}

function normalizeMode(value) {
  return String(value || "").trim().toLowerCase() === "global" ? "global" : "private";
}


function normalizeAccount(raw) {
  // clientId はこのクライアントが自分で生成したPCのID（UUID）。アカウントごとに1つ持ち、
  // サーバーへの登録（/api/client/register）が済むと registered が true になる。
  // 旧形式（workerId など）の設定は clientId が無いため、起動時に登録フェーズをやり直す。
  const clientId = String(raw?.clientId || "").trim().toLowerCase();
  return {
    email: String(raw?.email || "").trim(),
    token: String(raw?.token || "").trim(),
    enabled: raw?.enabled !== false,
    source: raw?.source || "ui",
    clientId: UUID_RE.test(clientId) ? clientId : null,
    registered: raw?.registered === true && UUID_RE.test(clientId),
    addedAt: raw?.addedAt || nowIso(),
    updatedAt: raw?.updatedAt || nowIso(),
  };
}

function saveConfig() {
  const stored = {
    baseUrl: cleanBaseUrl(config.baseUrl),
    mode: normalizeMode(config.mode),
    clientName: clientName(),
    accounts: config.accounts
      .filter((a) => a.source !== "env")
      .map((a) => ({
        email: a.email,
        token: a.token,
        enabled: a.enabled !== false,
        source: "ui",
        clientId: a.clientId || null,
        registered: a.registered === true,
        addedAt: a.addedAt,
        updatedAt: a.updatedAt || nowIso(),
      })),
  };
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(stored, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_PATH);
}

function statusOf(email) {
  if (!runtime.has(email)) {
    runtime.set(email, {
      state: "idle",
      message: "",
      lastSeenAt: null,
      lastJobAt: null,
      completed: 0,
      failed: 0,
      lastJobId: null,
    });
  }
  return runtime.get(email);
}

function updateStatus(email, patch) {
  const current = statusOf(email);
  Object.assign(current, patch, { lastSeenAt: nowIso() });
}

function publicState() {
  return {
    ok: true,
    baseUrl: config.baseUrl,
    mode: normalizeMode(config.mode),
    clientName: clientName(),
    metrics: latestMetrics,
    hostname: HOST_LABEL,
    pollSec: POLL_INTERVAL_MS / 1000,
    metricsSec: METRICS_INTERVAL_MS / 1000,
    ui: `http://${UI_HOST}:${UI_PORT}`,
    configPath: CONFIG_PATH,
    accounts: config.accounts.map((a) => ({
      email: a.email,
      enabled: a.enabled !== false,
      source: a.source || "ui",
      clientId: a.clientId || null,
      registered: a.registered === true,
      addedAt: a.addedAt,
      updatedAt: a.updatedAt,
      status: statusOf(a.email),
    })),
  };
}

function accountByEmail(email) {
  return config.accounts.find((a) => a.email === email);
}

// 既定の表示名に使うホスト名（ASCII以外は落とす）。
const HOST_LABEL = String(os.hostname() || "").replace(/[^\x20-\x7E]/g, "").trim().slice(0, 100);

// ユーザーが決めたこのPCの表示名。未設定ならホスト名。
function clientName() {
  return String(config.clientName || "").trim().slice(0, 100) || HOST_LABEL || "PC";
}

// すべてのAPIリクエストのJSONボディに載せる共通部分: 認証情報とこのPCのID。
function authBody(account, extra = {}) {
  return {
    auth: { email: account.email, token: account.token },
    clientId: account.clientId || null,
    ...extra,
  };
}

// =====================================================================
// リソース使用率（CPU/メモリ/GPU）の計測とサーバーへの報告
// ダッシュボードの「処理に使うPC」選択画面に表示される。
// =====================================================================

let lastCpuTimes = null;
let latestMetrics = { cpu: null, mem: null, gpu: null, at: null };
let gpuUnavailable = false;
const metricsErrorLogged = new Set();

function cpuTimesTotal() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const key of Object.keys(cpu.times)) total += cpu.times[key];
    idle += cpu.times.idle;
  }
  return { idle, total };
}

// 前回サンプルとの差分からCPU使用率(%)を出す。初回は基準がないので null。
function sampleCpuPct() {
  const now = cpuTimesTotal();
  let pct = null;
  if (lastCpuTimes && now.total > lastCpuTimes.total) {
    const dTotal = now.total - lastCpuTimes.total;
    const dIdle = now.idle - lastCpuTimes.idle;
    pct = Math.min(Math.max((1 - dIdle / dTotal) * 100, 0), 100);
  }
  lastCpuTimes = now;
  return pct;
}

function sampleMemPct() {
  const total = os.totalmem();
  if (!(total > 0)) return null;
  return Math.min(Math.max(((total - os.freemem()) / total) * 100, 0), 100);
}

// GPU使用率は nvidia-smi があれば取得（複数GPUは最大値）。無い環境（macOS等）は null。
function sampleGpuPct() {
  if (gpuUnavailable) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"],
      { timeout: 2000 },
      (err, stdout) => {
        if (err) {
          if (err.code === "ENOENT") gpuUnavailable = true;
          return resolve(null);
        }
        const vals = String(stdout).trim().split("\n")
          .map((v) => Number(v.trim()))
          .filter((v) => Number.isFinite(v));
        resolve(vals.length ? Math.max(...vals) : null);
      }
    );
  });
}

async function metricsLoop() {
  sampleCpuPct(); // 差分計測の基準を作る
  while (!stopping) {
    await sleep(METRICS_INTERVAL_MS);
    if (stopping) break;
    const gpu = await sampleGpuPct();
    latestMetrics = { cpu: sampleCpuPct(), mem: sampleMemPct(), gpu, at: nowIso() };
    for (const account of activeAccounts()) {
      // 登録フェーズ（/api/client/register）が済むまでは送らない。
      if (!account.registered || !account.clientId) continue;
      try {
        const st = statusOf(account.email);
        await postJson(account, "/api/client/metrics", {
          cpu: latestMetrics.cpu,
          mem: latestMetrics.mem,
          gpu: latestMetrics.gpu,
          // 処理中ジョブのハートビート。サーバーはこれが途絶えたジョブを
          // 「ワーカーが停止した」とみなして再キューし、別のPCへ振り直す。
          activeJobId: st.state === "working" && st.lastJobId ? st.lastJobId : null,
        });
        metricsErrorLogged.delete(account.email);
      } catch (e) {
        // ダッシュボードからPCを削除された等で未登録扱いになったら、次の
        // ポーリングで登録フェーズからやり直す。
        if (e.code === "unregistered") markUnregistered(account);
        if (!metricsErrorLogged.has(account.email)) {
          metricsErrorLogged.add(account.email);
          console.error(`[${account.email}] メトリクス送信に失敗（以後同じログは抑制）: ${describeError(e)}`);
        }
      }
    }
  }
}

function serverUrl(pathname) {
  return `${cleanBaseUrl(config.baseUrl)}${pathname}`;
}

// fetch は 301/302 を追いかける際に POST を GET に変えるため、リダイレクトの先で
// 「Cannot GET /api/...」になって原因が分からなくなる（http→https 転送のある
// プロキシ配下で起きがち）。リダイレクトは追わずに、設定すべきURLを伝えて止める。
async function serverFetch(pathname, options = {}) {
  const res = await fetch(serverUrl(pathname), { redirect: "manual", ...options });
  if ([301, 302, 303, 307, 308].includes(res.status)) {
    const loc = res.headers.get("location") || "(不明)";
    throw new Error(
      `公開サーバーURL ${cleanBaseUrl(config.baseUrl)} はリダイレクトされています ` +
      `(HTTP ${res.status} → ${loc})。POSTがGETに変わって失敗するため、` +
      `設定の公開サーバーURLをリダイレクト先に合わせてください`
    );
  }
  return res;
}

async function loginWithPassword(email, password) {
  let res;
  try {
    res = await serverFetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email, password }),
    });
  } catch (e) {
    if (String(e.message).includes("リダイレクト")) throw e;
    throw new Error(`${serverUrl("")} に接続できません: ${describeError(e)}`);
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_e) {
    // HTTPエラーとして扱う。
  }
  if (!res.ok || !json?.ok || !json?.token) {
    throw new Error(json?.error || text || `HTTP ${res.status}`);
  }
  return { email: json.email || email, token: json.token };
}

// JSON API 呼び出し。認証情報とclientIdを常にボディへ含める。
// サーバーがエラーに code（unregistered / uuid_conflict 等）を付けてきたら
// Error オブジェクトに引き継ぐ（呼び出し側が登録やり直し等を判断する）。
async function postJson(account, pathname, body = {}) {
  const res = await serverFetch(pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(authBody(account, body)),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_e) {
    // 下でHTTPエラーとして扱う。
  }
  if (!res.ok || !json?.ok) {
    const err = new Error(json?.error || text || `HTTP ${res.status}`);
    if (json?.code) err.code = json.code;
    throw err;
  }
  return json;
}

function safeName(job) {
  const base = path.basename(job.filename || `audio-${job.jobId}.wav`);
  return `${job.jobId}-${base.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200)}`;
}

// 音声本体の取得。認証情報+clientId+jobId をJSONで送り、WAV等のバイナリを受け取る。
async function downloadJobFile(account, job) {
  const filePath = path.join(WORK_DIR, `${account.email.replace(/[^A-Za-z0-9._-]/g, "_")}-${safeName(job)}`);
  const res = await serverFetch("/api/client/jobs/download", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/octet-stream" },
    body: JSON.stringify(authBody(account, { jobId: job.jobId })),
  });
  if (!res.ok) {
    const message = await res.text().catch(() => "");
    throw new Error(message || `音声ダウンロード失敗: HTTP ${res.status}`);
  }
  if (!res.body) throw new Error("音声レスポンスが空です");
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(filePath));
  return filePath;
}

async function reportError(account, job, error) {
  try {
    await postJson(account, "/api/client/jobs/result", {
      jobId: job.jobId,
      error: String(error.message || error).slice(0, 1000),
    });
  } catch (e) {
    console.error(`[${account.email}] ジョブ #${job.jobId} のエラー報告に失敗: ${e.message}`);
  }
}

// =====================================================================
// クライアント登録（起動後の最初のフェーズ）
// このPCのID（UUID）をクライアント側で生成し、表示名とともにサーバーへ登録する。
// UUID が他アカウントと衝突したら（通常起きない）再生成してやり直す。
// =====================================================================

function markUnregistered(account) {
  if (!account.registered) return;
  account.registered = false;
  account.updatedAt = nowIso();
  persistConfig();
  console.log(`[${account.email}] サーバー側でこのPCの登録が失われました。次回ポーリングで再登録します`);
}

function persistConfig() {
  try {
    saveConfig();
  } catch (e) {
    console.error(`設定の保存に失敗（動作は継続）: ${e.message}`);
  }
}

async function registerAccount(account) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!account.clientId) account.clientId = crypto.randomUUID();
    try {
      const r = await postJson(account, "/api/client/register", {
        name: clientName(),
        mode: normalizeMode(config.mode),
      });
      account.registered = true;
      account.updatedAt = nowIso();
      if (account.source !== "env") persistConfig();
      console.log(
        `[${account.email}] このPCを登録しました: ${r.client?.name || clientName()} (ID ${account.clientId})`
      );
      return;
    } catch (e) {
      if (e.code === "uuid_conflict") {
        account.clientId = null; // 再生成して次のループで登録し直す
        continue;
      }
      throw e;
    }
  }
  throw new Error("クライアントIDの登録に失敗しました（ID衝突が解消できません）");
}

// 未登録なら登録フェーズを済ませてからジョブ処理へ進む。
async function ensureRegistered(account) {
  if (account.registered && account.clientId) return;
  updateStatus(account.email, { state: "polling", message: "このPCをサーバーに登録中" });
  await registerAccount(account);
}

async function processOne(account) {
  await ensureRegistered(account);
  updateStatus(account.email, { state: "polling", message: "ジョブ確認中" });
  let claimed;
  try {
    claimed = await postJson(account, "/api/client/claim", { mode: normalizeMode(config.mode) });
  } catch (e) {
    if (e.code === "unregistered") markUnregistered(account);
    throw e;
  }
  if (claimed.client?.allowed === false) {
    updateStatus(account.email, {
      state: "idle",
      message: "このPCはサーバー設定で処理対象外です（ダッシュボードのPC選択を確認）",
    });
    return false;
  }
  const job = claimed.job;
  if (!job) {
    updateStatus(account.email, { state: "idle", message: "待機中" });
    return false;
  }

  let filePath = null;
  updateStatus(account.email, {
    state: "working",
    message: `${job.filename} を処理中`,
    lastJobAt: nowIso(),
    lastJobId: job.jobId,
  });
  console.log(`[${account.email}] ジョブ #${job.jobId} を取得: ${job.filename} (${job.quality || "high"})`);
  try {
    filePath = await downloadJobFile(account, job);
    const text = await localTranscribe(filePath, job.quality || "high");
    const result = await postJson(account, "/api/client/jobs/result", { jobId: job.jobId, text });
    statusOf(account.email).completed += 1;
    updateStatus(account.email, {
      state: "idle",
      message: `完了: ${result.filename || "(本文なし)"}`,
    });
    console.log(
      `[${account.email}] ジョブ #${job.jobId} 完了: ${result.filename || "(本文なし)"} ` +
      `${result.chars ? `${result.chars}文字` : ""}`
    );
  } catch (e) {
    statusOf(account.email).failed += 1;
    updateStatus(account.email, { state: "error", message: describeError(e) });
    console.error(`[${account.email}] ジョブ #${job.jobId} 失敗: ${describeError(e)}`);
    await reportError(account, job, e);
  } finally {
    if (filePath) fs.unlink(filePath, () => {});
  }
  return true;
}

function activeAccounts() {
  return config.accounts.filter((a) => a.enabled !== false && a.email && a.token);
}

async function workerLoop() {
  console.log(
    `audio-worker 起動: ${cleanBaseUrl(config.baseUrl)} / ${POLL_INTERVAL_MS / 1000}秒間隔 ` +
    `/ 表示名=${clientName()} / モード=${normalizeMode(config.mode)}`
  );
  const unregistered = activeAccounts().filter((a) => !a.registered);
  if (unregistered.length) {
    console.log(
      `未登録のアカウントが ${unregistered.length} 件あります。` +
      `各アカウントは最初のポーリングで登録フェーズ（このPCのID生成と表示名の登録）を実行します`
    );
  }
  while (!stopping) {
    const accounts = activeAccounts();
    if (!accounts.length) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    let worked = false;
    for (const account of accounts) {
      if (stopping) break;
      try {
        worked = (await processOne(account)) || worked;
      } catch (e) {
        updateStatus(account.email, { state: "error", message: describeError(e) });
        console.error(`[${account.email}] ポーリング失敗: ${describeError(e)}`);
      }
    }
    await sleep(worked ? 500 : POLL_INTERVAL_MS);
  }
  console.log("audio-worker を停止します");
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function sendHtml(res, html) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(html);
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk.toString("utf8");
    if (body.length > 1024 * 1024) throw new Error("リクエストが大きすぎます");
  }
  return body ? JSON.parse(body) : {};
}

function htmlPage() {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>AIHelper 音声ワーカー</title>
  <style>
    :root { color-scheme: light; --bg:#f5f7fa; --panel:#fff; --line:#d9e0ea; --ink:#1d2733; --muted:#617083; --accent:#1f6feb; --danger:#b42318; --ok:#117a37; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--ink); font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#172033; color:white; padding:14px 20px; display:flex; justify-content:space-between; align-items:center; gap:12px; }
    h1 { font-size:18px; margin:0; font-weight:700; }
    main { max-width:1080px; margin:0 auto; padding:20px; display:grid; gap:16px; }
    section { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    h2 { font-size:16px; margin:0 0 12px; }
    label { display:block; font-size:13px; color:var(--muted); margin-bottom:6px; }
    input { width:100%; padding:10px 11px; border:1px solid var(--line); border-radius:6px; font:inherit; background:white; }
    button { border:0; border-radius:6px; padding:10px 12px; font:inherit; font-weight:700; cursor:pointer; background:var(--accent); color:white; }
    button.ghost { background:#edf2f7; color:var(--ink); }
    button.danger { background:#fff1f0; color:var(--danger); border:1px solid #ffd3cf; }
    button:disabled { opacity:.55; cursor:default; }
    .grid { display:grid; grid-template-columns:1.5fr 1fr auto; gap:10px; align-items:end; }
    .add { display:grid; grid-template-columns:1fr 1fr auto; gap:10px; align-items:end; }
    .muted { color:var(--muted); }
    .small { font-size:12px; }
    table { width:100%; border-collapse:collapse; }
    th, td { padding:10px 8px; border-bottom:1px solid var(--line); text-align:left; vertical-align:middle; }
    th { font-size:12px; color:var(--muted); font-weight:700; }
    .pill { display:inline-block; padding:3px 8px; border-radius:999px; font-size:12px; background:#eef2f7; color:var(--muted); }
    .pill.ok { background:#e7f6ec; color:var(--ok); }
    .pill.err { background:#fff1f0; color:var(--danger); }
    .actions { display:flex; gap:8px; flex-wrap:wrap; }
    .modes { margin-top:14px; display:grid; gap:6px; }
    .mode-option { display:flex; align-items:flex-start; gap:8px; margin:0; font-size:13px; color:var(--ink); cursor:pointer; }
    .mode-option input { width:auto; margin-top:2px; }
    #notice { min-height:20px; }
    @media (max-width:760px) {
      .grid, .add { grid-template-columns:1fr; }
      table, thead, tbody, tr, th, td { display:block; }
      thead { display:none; }
      tr { border-bottom:1px solid var(--line); padding:8px 0; }
      td { border:0; padding:6px 0; }
    }
  </style>
</head>
<body>
  <header>
    <h1>AIHelper 音声ワーカー</h1>
    <div class="small" id="topState">読み込み中</div>
  </header>
  <main>
    <section>
      <h2>サーバー / このPC</h2>
      <div class="grid">
        <div>
          <label for="baseUrl">公開サーバーURL</label>
          <input id="baseUrl" placeholder="https://example.com">
        </div>
        <div>
          <label for="clientName">このPCの表示名（サーバーのPC選択画面に表示）</label>
          <input id="clientName" placeholder="例: 研究室デスクトップ">
        </div>
        <button id="saveSettings">保存</button>
      </div>
      <div class="small muted" id="configPath" style="margin-top:8px"></div>
      <div class="modes">
        <label style="margin-bottom:4px">このPCの処理モード</label>
        <label class="mode-option">
          <input type="radio" name="workerMode" value="private" checked>
          <span><strong>private</strong> — このPCで登録したアカウントの音声だけを処理します</span>
        </label>
        <label class="mode-option">
          <input type="radio" name="workerMode" value="global">
          <span><strong>global</strong> — このサービスの全ユーザーの音声処理を担うPCとして公開します</span>
        </label>
        <div class="small muted">モードは選択した時点で保存されます。globalでは他のユーザーの音声データがこのPCにダウンロードされて処理されます。</div>
      </div>
      <div class="small muted" id="metricsLine" style="margin-top:10px"></div>
    </section>
    <section>
      <h2>アカウント登録（初回セットアップ）</h2>
      <p class="small muted" style="margin:0 0 10px">
        メール+パスワードでログインすると、このPC用のIDを自動生成し、上の表示名とともに
        サーバーへクライアント登録します。登録が済んだアカウントだけが音声処理を開始します。
        パスワードはログインに一度使うだけで保存されません。
      </p>
      <div class="add">
        <div>
          <label for="email">メール</label>
          <input id="email" type="email" autocomplete="username">
        </div>
        <div>
          <label for="password">パスワード</label>
          <input id="password" type="password" autocomplete="current-password">
        </div>
        <button id="addAccount">ログインして登録</button>
      </div>
      <div id="notice" class="small muted" style="margin-top:10px"></div>
    </section>
    <section>
      <h2>処理対象アカウント</h2>
      <div id="accounts"></div>
    </section>
  </main>
  <script>
    const $ = (id) => document.getElementById(id);

    async function api(path, options = {}) {
      const res = await fetch(path, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.error || 'HTTP ' + res.status);
      return json;
    }

    function statusPill(status) {
      const state = status?.state || 'idle';
      const cls = state === 'error' ? 'err' : (state === 'working' ? 'ok' : '');
      const label = state === 'working' ? '処理中' : state === 'polling' ? '確認中' : state === 'error' ? 'エラー' : '待機';
      return '<span class="pill ' + cls + '">' + label + '</span>';
    }

    function esc(s) {
      return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    let baseUrlDirty = false;
    let clientNameDirty = false;
    let modeDirty = false;

    function pct(v) {
      return (v === null || v === undefined) ? '—' : Math.round(v) + '%';
    }

    async function load() {
      const state = await api('/api/state');
      const baseUrlInput = $('baseUrl');
      if (!baseUrlDirty && document.activeElement !== baseUrlInput) {
        baseUrlInput.value = state.baseUrl || '';
      }
      const clientNameInput = $('clientName');
      if (!clientNameDirty && document.activeElement !== clientNameInput) {
        clientNameInput.value = state.clientName || '';
      }
      if (!modeDirty) {
        const radio = document.querySelector('input[name="workerMode"][value="' + (state.mode || 'private') + '"]');
        if (radio) radio.checked = true;
      }
      const m = state.metrics || {};
      $('metricsLine').textContent =
        'このPCの使用率 (' + state.metricsSec + '秒ごとにサーバーへ送信): CPU ' + pct(m.cpu) + ' / メモリ ' + pct(m.mem) + ' / GPU ' + pct(m.gpu);
      $('configPath').textContent = '設定: ' + state.configPath;
      $('topState').textContent = state.accounts.length + '件 / ' + state.pollSec + '秒間隔 / ' + (state.mode || 'private');
      if (!state.accounts.length) {
        $('accounts').innerHTML = '<p class="muted">まだアカウントがありません。上でログインして、このPCをクライアント登録してください。</p>';
        return;
      }
      $('accounts').innerHTML = '<table><thead><tr><th>メール</th><th>状態</th><th>直近</th><th>完了/失敗</th><th></th></tr></thead><tbody>' +
        state.accounts.map(a => {
          const st = a.status || {};
          const reg = a.registered
            ? '<br><span class="small muted">登録済み / クライアントID ' + esc(a.clientId || '') + '</span>'
            : '<br><span class="small" style="color:#b7791f">未登録（次回ポーリングで登録します）</span>';
          return '<tr>' +
            '<td><strong>' + esc(a.email) + '</strong><br><span class="small muted">' + (a.enabled ? '有効' : '停止中') + ' / ' + esc(a.source) + '</span>' +
              reg + '</td>' +
            '<td>' + statusPill(st) + '</td>' +
            '<td><div>' + esc(st.message || '') + '</div><div class="small muted">' + esc(st.lastSeenAt || '') + '</div></td>' +
            '<td>' + (st.completed || 0) + ' / ' + (st.failed || 0) + '</td>' +
            '<td><div class="actions">' +
              '<button class="ghost" onclick="toggleAccount(\\'' + encodeURIComponent(a.email) + '\\',' + (!a.enabled) + ')">' + (a.enabled ? '停止' : '再開') + '</button>' +
              '<button class="danger" onclick="removeAccount(\\'' + encodeURIComponent(a.email) + '\\')">削除</button>' +
            '</div></td>' +
          '</tr>';
        }).join('') + '</tbody></table>';
    }

    async function saveSettings() {
      const mode = document.querySelector('input[name="workerMode"]:checked')?.value || 'private';
      try {
        await api('/api/settings', { method:'POST', body: JSON.stringify({
          baseUrl: $('baseUrl').value, clientName: $('clientName').value, mode }) });
      } catch (e) {
        $('notice').textContent = '設定の保存に失敗しました: ' + e.message;
        return;
      }
      baseUrlDirty = false;
      clientNameDirty = false;
      modeDirty = false;
      $('notice').textContent = '設定を保存しました（モード: ' + mode + '）。表示名の変更は各アカウントの再登録で反映されます';
      await load();
    }

    async function addAccount() {
      const btn = $('addAccount');
      btn.disabled = true;
      $('notice').textContent = 'ログインしてこのPCを登録中...';
      try {
        const r = await api('/api/accounts', {
          method:'POST',
          body: JSON.stringify({ baseUrl: $('baseUrl').value, clientName: $('clientName').value,
            email: $('email').value, password: $('password').value })
        });
        $('password').value = '';
        $('notice').textContent = r.registered
          ? '✓ ログインし、このPCをクライアント登録しました'
          : '✓ ログインしました（クライアント登録は次回ポーリングで再試行します: ' + (r.registerError || '') + '）';
        await load();
      } catch (e) {
        $('notice').textContent = e.message;
      } finally {
        btn.disabled = false;
      }
    }

    async function toggleAccount(encoded, enabled) {
      await api('/api/accounts/' + encoded, { method:'PATCH', body: JSON.stringify({ enabled }) });
      await load();
    }

    async function removeAccount(encoded) {
      if (!confirm('このアカウントを削除しますか？')) return;
      await api('/api/accounts/' + encoded, { method:'DELETE' });
      await load();
    }

    $('baseUrl').addEventListener('input', () => { baseUrlDirty = true; });
    $('clientName').addEventListener('input', () => { clientNameDirty = true; });
    $('clientName').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') saveSettings();
    });
    // モードはラジオを選んだ時点で保存する（「保存」ボタン待ちにすると、押し忘れて
    // リロードで元に戻ったように見えるため）。baseUrl は入力途中がありうるので送らない。
    document.querySelectorAll('input[name="workerMode"]').forEach((el) => {
      el.addEventListener('change', async () => {
        modeDirty = true;
        try {
          await api('/api/settings', { method:'POST', body: JSON.stringify({ mode: el.value }) });
          modeDirty = false;
          $('notice').textContent = 'モードを ' + el.value + ' に変更しました';
        } catch (e) {
          $('notice').textContent = 'モードの保存に失敗しました: ' + e.message;
        }
      });
    });
    $('baseUrl').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') saveSettings();
    });
    $('saveSettings').addEventListener('click', saveSettings);
    $('addAccount').addEventListener('click', addAccount);
    setInterval(load, 3000);
    load().catch(e => { $('topState').textContent = e.message; });
  </script>
</body>
</html>`;
}

async function handleUi(req, res) {
  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (req.method === "GET" && u.pathname === "/") return sendHtml(res, htmlPage());
    if (req.method === "GET" && u.pathname === "/api/state") return sendJson(res, 200, publicState());

    if (req.method === "POST" && u.pathname === "/api/settings") {
      const body = await readJson(req);
      // モードだけの部分更新でも baseUrl を既定値に巻き戻さないよう、送られた項目のみ反映する。
      if (body.baseUrl !== undefined) config.baseUrl = cleanBaseUrl(body.baseUrl);
      if (body.mode !== undefined) config.mode = normalizeMode(body.mode);
      let nameChanged = false;
      if (body.clientName !== undefined) {
        const next = String(body.clientName || "").trim().slice(0, 100) || null;
        nameChanged = next !== config.clientName;
        config.clientName = next;
      }
      saveConfig();
      // 表示名は登録APIで伝わるため、変わったら登録済みアカウントを再登録する
      // （失敗しても次のポーリングの ensureRegistered で追い付く）。
      if (nameChanged) {
        for (const account of activeAccounts()) {
          if (!account.registered) continue;
          registerAccount(account).catch((e) =>
            console.error(`[${account.email}] 表示名変更の再登録に失敗: ${describeError(e)}`)
          );
        }
      }
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && u.pathname === "/api/accounts") {
      const body = await readJson(req);
      const originalBaseUrl = config.baseUrl;
      if (body.baseUrl) config.baseUrl = cleanBaseUrl(body.baseUrl);
      if (body.clientName !== undefined) {
        config.clientName = String(body.clientName || "").trim().slice(0, 100) || null;
      }
      const email = String(body.email || "").trim();
      const password = String(body.password || "");
      if (!email || !password) return sendJson(res, 400, { ok: false, error: "メールとパスワードを入力してください" });
      let loggedIn;
      try {
        loggedIn = await loginWithPassword(email, password);
      } catch (e) {
        config.baseUrl = originalBaseUrl;
        throw e;
      }
      const existing = accountByEmail(loggedIn.email);
      const entry = {
        email: loggedIn.email,
        token: loggedIn.token,
        enabled: true,
        source: "ui",
        clientId: existing?.clientId || null,
        registered: false,
        addedAt: existing?.addedAt || nowIso(),
        updatedAt: nowIso(),
      };
      const account = existing ? Object.assign(existing, entry) : entry;
      if (!existing) config.accounts.push(account);
      saveConfig();
      // 初回セットアップの本体: このPCのIDを生成してサーバーにクライアント登録する。
      // 失敗してもアカウント自体は保存し、次のポーリングで再登録を試みる。
      let registerError = null;
      try {
        await registerAccount(account);
        updateStatus(account.email, { state: "idle", message: "クライアント登録済み" });
      } catch (e) {
        registerError = describeError(e);
        updateStatus(account.email, { state: "error", message: `クライアント登録に失敗: ${registerError}` });
      }
      return sendJson(res, 200, {
        ok: true,
        email: account.email,
        registered: account.registered === true,
        clientId: account.clientId,
        registerError,
      });
    }

    const accountMatch = u.pathname.match(/^\/api\/accounts\/(.+)$/);
    if (accountMatch && (req.method === "PATCH" || req.method === "DELETE")) {
      const email = decodeURIComponent(accountMatch[1]);
      const account = accountByEmail(email);
      if (!account) return sendJson(res, 404, { ok: false, error: "アカウントが見つかりません" });
      if (account.source === "env") {
        return sendJson(res, 400, { ok: false, error: "環境変数由来のアカウントはUIから変更できません" });
      }
      if (req.method === "DELETE") {
        config.accounts = config.accounts.filter((a) => a.email !== email);
        runtime.delete(email);
        saveConfig();
        return sendJson(res, 200, { ok: true });
      }
      const body = await readJson(req);
      account.enabled = body.enabled !== false;
      account.updatedAt = nowIso();
      saveConfig();
      return sendJson(res, 200, { ok: true });
    }

    sendJson(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e.message });
  }
}

function startUi() {
  uiServer = http.createServer((req, res) => {
    handleUi(req, res).catch((e) => sendJson(res, 500, { ok: false, error: e.message }));
  });
  uiServer.listen(UI_PORT, UI_HOST, () => {
    console.log(`管理UI: http://${UI_HOST}:${UI_PORT}`);
  });
}

function requestStop() {
  if (stopping) {
    process.exit(0);
    return;
  }
  stopping = true;
  if (uiServer) {
    uiServer.close(() => {});
  }
}

process.on("SIGINT", requestStop);
process.on("SIGTERM", requestStop);

startUi();
metricsLoop().catch((e) => {
  console.error(`メトリクス送信ループが停止しました: ${e.message}`);
});
workerLoop().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
