# client/ コードマップ（ワーカーPC側）

ワーカーPCで動かすクライアント一式。サーバーの音声ジョブをポーリングし、
ローカルの faster-whisper で文字起こしして結果を返す。

## ファイル一覧

| ファイル | 役割 |
| --- | --- |
| `audio-worker.js` | 本体（~1000行）。ポーリングループ + メトリクス送信 + ローカル管理UI（http://127.0.0.1:39123） |
| `stt-local.js` | `stt/transcribe.py` を子プロセスで呼ぶラッパー。`localTranscribe(filePath, quality)` を提供 |
| `stt/transcribe.py` | faster-whisper 実行本体（Python。`stt/.venv` 内で動く） |
| `accounts.json` | 設定ファイル（git管理外）。下記参照 |
| `Makefile` | `make install` / `make stt-deps`（Python venv構築）/ `make gpu-check` |
| `worker-audio/` | ダウンロードした音声の一時置き場（処理後すぐ削除） |

## accounts.json の形式（実例）

```json
{
  "baseUrl": "https://aihelper.example.com",
  "mode": "private",
  "clientName": "研究室デスクトップ",
  "accounts": [
    {
      "email": "user@example.com",
      "token": "691ff8ca9ac063e6caa6f0bd952869212d198da27f1c55ed",
      "enabled": true,
      "source": "ui",
      "clientId": "41685d34-86c5-42be-a598-e4985d8d43f4",
      "registered": true,
      "addedAt": "2026-07-13T09:18:28.500Z",
      "updatedAt": "2026-07-13T09:18:28.512Z"
    }
  ]
}
```

| キー | 意味 |
| --- | --- |
| `baseUrl` | 公開サーバーURL |
| `mode` | このPCの公開範囲。`private`（自分のジョブのみ）/ `global`（全ユーザーのジョブを処理） |
| `clientName` | **ユーザーが決めるこのPCの表示名**。サーバーのPC選択画面に出る。未設定ならホスト名 |
| `accounts[].token` | `/api/login` で得たAPIトークン。**パスワードは保存しない** |
| `accounts[].clientId` | **クライアントが自動生成したこのPCのID（UUID）**。アカウントごとに1つ |
| `accounts[].registered` | サーバーへのクライアント登録（`/api/client/register`）が済んでいるか |

旧形式（`workerId` / `workerName` を持つもの）を読み込んだ場合、`clientId` が無いため
`registered=false` となり、起動後の最初のポーリングで自動的に登録フェーズをやり直す。

## audio-worker.js の構造（行番号つき、2026-07-14時点）

### 設定・状態（29〜225行）

| 行 | 内容 |
| --- | --- |
| 29-36 | 環境変数から定数化: `AIHELPER_SERVER_URL` / `AUDIO_WORKER_CONFIG` / `AUDIO_WORKER_POLL_SEC`(10) / `AUDIO_WORKER_METRICS_SEC`(3) / `AUDIO_WORKER_UI_PORT`(39123) / `AUDIO_WORKER_DIR` |
| 56 | `describeError(e)` — fetch失敗の cause を辿って原因（ECONNREFUSED等）まで表示 |
| 78-115 | `loadConfig()` — accounts.json + 環境変数（`AIHELPER_EMAIL`/`AIHELPER_TOKEN`）のマージ |
| 121-138 | `UUID_RE` / `normalizeAccount()` — clientId の形式検証と旧形式の移行 |
| 140-162 | `saveConfig()` — tmpファイル経由のアトミック保存（mode 0600） |
| 164-182 | `statusOf` / `updateStatus` — アカウント毎の実行状態（UIに表示） |
| 184-207 | `publicState()` — ローカルUIの `/api/state` が返す内容 |
| 214-225 | `HOST_LABEL` / `clientName()` / **`authBody(account, extra)`** — 全リクエスト共通のJSONボディ（`auth` + `clientId`）を作る |

### メトリクス（230〜323行）

| 行 | 内容 |
| --- | --- |
| 240-289 | CPU（os.cpus差分）/ メモリ / GPU（nvidia-smi、無ければnull）のサンプリング |
| 291-323 | `metricsLoop()` — 3秒ごとに `POST /api/client/metrics`。**登録済みアカウントのみ送る**。処理中ジョブのIDをハートビートとして同送。`unregistered` エラーで登録フラグを落とす |

### 通信（325〜425行）

| 行 | 内容 |
| --- | --- |
| 332 | `serverFetch()` — リダイレクト検出（POSTがGETに化ける事故の防止） |
| 345 | `loginWithPassword(email, password)` — `/api/login` |
| 373 | **`postJson(account, path, body)`** — authBodyを合成してPOST。サーバーの `code`（unregistered等）を `Error.code` に引き継ぐ |
| 400 | **`downloadJobFile(account, job)`** — `POST /api/client/jobs/download`（JSON→バイナリstream） |
| 416 | `reportError(account, job, error)` — 失敗を `jobs/result` に `{jobId, error}` で報告。サーバーは上限（既定3回）までは即 queued に戻して再割り振りするので、クライアント側の追加対応は不要 |

### 登録フェーズとジョブ処理（427〜580行あたり）

| 関数 | 内容 |
| --- | --- |
| `registerAccount(account)` | clientId が無ければ `crypto.randomUUID()` で生成 → `POST /api/client/register`。`uuid_conflict`(409) なら再生成して最大3回リトライ |
| `ensureRegistered(account)` | 未登録なら登録フェーズを済ませてから処理へ進む（**毎ポーリングの1行目**） |
| `markUnregistered(account)` | サーバー側で登録が消えた（PC削除等）ときにフラグを落として再登録に回す |
| `processOne(account)` | 1アカウント分の1周: ensureRegistered → claim → (job無ければ待機) → download → `localTranscribe` → result送信。失敗時は reportError |
| `workerLoop()` | 全有効アカウントを順に processOne。仕事があったら0.5秒後、無ければ10秒後に次周 |

### ローカル管理UI（600行〜末尾）

`http.createServer` で 127.0.0.1:39123 に立つ。認証なし（ローカルのみバインド）。

| ルート | 内容 |
| --- | --- |
| `GET /` | 管理画面HTML（`htmlPage()` のテンプレート文字列） |
| `GET /api/state` | 現在の設定+アカウント状態（`publicState()`） |
| `POST /api/settings` | `{baseUrl?, clientName?, mode?}` の部分更新。**clientName が変わったら登録済みアカウントを自動再登録**（表示名はregister経由でしか変わらないため） |
| `POST /api/accounts` | **初回セットアップの本体**。`{email, password, baseUrl?, clientName?}` → `/api/login` → UUID生成 → `/api/client/register`。レスポンス例: |
| `PATCH /api/accounts/:email` | `{enabled}` の切替 |
| `DELETE /api/accounts/:email` | アカウント削除 |

`POST /api/accounts` のレスポンス例:

```json
{
  "ok": true,
  "email": "user@example.com",
  "registered": true,
  "clientId": "41685d34-86c5-42be-a598-e4985d8d43f4",
  "registerError": null
}
```

登録に失敗してもアカウントは保存され（`registered: false`）、次のポーリングで自動再試行される。

## stt-local.js / transcribe.py

- `localTranscribe(filePath, quality)` が `stt/.venv/bin/python3 stt/transcribe.py <file>` を起動。
- quality（`light` / `standard` / `high`）は**ジョブ所有者**のサーバー側設定（`users.stt_quality`）から
  claim レスポンスで届く。モデルや計算精度は環境変数（`WHISPER_MODEL` / `WHISPER_COMPUTE` など）でも上書き可。
- venv が無い場合は「ローカル文字起こしが未設定です（`make stt-deps` を実行してください）」を投げ、
  それがそのままサーバーへエラー報告される。

## 起動から処理開始までのタイムライン

```
npm start
 ├─ startUi()            … 管理UI (127.0.0.1:39123) 起動
 ├─ metricsLoop()        … 3秒ごと（登録済みアカウントのみ送信）
 └─ workerLoop()         … 10秒ごと
     └─ processOne(account)
         ├─ ensureRegistered()  ← 未登録ならここで登録フェーズ
         │    └─ POST /api/client/register （409なら UUID再生成）
         ├─ POST /api/client/claim
         ├─ POST /api/client/jobs/download → WAV保存
         ├─ transcribe.py（faster-whisper）
         └─ POST /api/client/jobs/result
```
