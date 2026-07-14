# server/ コードマップ

「どのファイルの何行目あたりに何が書いてあるか」の地図。行番号は 2026-07-14 時点。

## ファイル一覧

| ファイル | 行数目安 | 役割 |
| --- | --- | --- |
| `server.js` | ~3600 | 本体。Expressの全ルート定義 + ダッシュボードHTML + 定期ジョブの起動 |
| `db.js` | ~1400 | MySQL接続・スキーマ自動作成・全クエリ関数。**SQLはこのファイルにしか書かない** |
| `audio.js` | ~180 | 音声ジョブのライフサイクル管理（enqueue / claim / 完了処理 / 再キュー） |
| `gemini.js` | ~630 | Gemini API 呼び出し（解析・要約・チャット）。ユーザーごとのAPIキーで動く |
| `reminders.js` | — | 締切リマインドエンジン + 日次要約の生成 |
| `summary.js` | — | 日次サマリのLINE送信（21:00の定期便） |
| `line.js` | — | LINE Messaging API への push 送信 |
| `moodle.js` | — | Moodle iCal(.ics) の取り込み（課題・予定→tasks） |
| `google.js` | — | Google OAuth + Calendar v3 REST（Web連携） |
| `cred.js` | — | 可逆暗号化（AES-256-GCM）。Wasedaパスワード・Google refresh_token・GeminiキーのDB保存用 |
| `rotate-cred-key.js` | — | 暗号鍵ローテーションスクリプト（手動実行） |
| `send-summary.js` | — | 日次サマリを手動送信するCLIスクリプト |
| `scraper/waseda_scraper.py` | — | MyWaseda から時間割をスクレイピング（子プロセスとして起動） |
| `accounts.json` | — | LINE連携用の静的アカウント（git管理外。`accounts.example.json` が雛形） |
| `.env` | — | DB接続情報など（git管理外。`.env.example` が雛形） |

## server.js の構造（行番号つき）

### 前半: 基盤（1〜260行あたり）

| 行 | 内容 |
| --- | --- |
| 18-35 | `.env` の自前ローダー（dotenv不使用。既存の環境変数が優先） |
| 53-66 | Express初期化とセキュリティヘッダー（nosniff / X-Frame-Options / HSTS） |
| 68-105 | レートリミッタ。`authLimiter`（15分20回、login/register用）と `heavyLimiter`（1時間30回、アップロード/AI系） |
| 107-112 | ボディパーサー。JSON 10MB / text 10MB / PDF 25MB / **audio 300MB** |
| 115-123 | `loadAccounts()` — accounts.json をリクエスト毎に読む |
| 127-161 | パスワード関連: `hashPassword`（scrypt）、`verifyPassword`（旧sha256互換→scrypt移行）、`genToken` |
| 167-173 | `resolveAccount(email, token)` — accounts.json → DB users の順で照合 |
| 189-203 | `serverErr`（内部エラーを隠して汎用メッセージ化）、`handleBadGeminiKey`（失効キーの案内） |
| 209-248 | ログイン総当たり対策（IP毎に失敗回数を数えて15分ロック） |
| 251-258 | **`authFromReq(req)`** — ヘッダー(or 互換でbody)から email+token を取り認証。ほぼ全APIの1行目で呼ばれる |

### 認証・ユーザー系（265〜355行）

| 行 | エンドポイント |
| --- | --- |
| 265 | `POST /api/register` — 新規ユーザー登録（メール+パスワード→トークン発行） |
| 295 | `POST /api/login` — ログイン（password または token で照合） |
| 331 | `POST /api/change-password` |

### 時間割・資料・カレンダー（357〜733行）

| 行 | エンドポイント |
| --- | --- |
| 357-407 | `GET/POST /api/courses`, `PATCH/DELETE /api/courses/:id` — 履修時間割 |
| 411-454 | `POST/GET /api/files` — PDF/TXTのGemini要約（documents テーブル） |
| 457-480 | `POST /api/google-link`（端末のGoogleメール記録）, `POST /api/calendar/sync`（スマホカレンダー同期） |
| 483-733 | Google Web OAuth 一式: `auth-url` → `callback` → `accounts` / `unlink` / `events` / `add-event` / `sync-courses` |

### 設定系（737〜1041行）

| 行 | エンドポイント |
| --- | --- |
| 737, 871 | `GET/POST /api/moodle` — iCal URL の取得/保存 |
| 752, 763 | `GET/POST /api/stt-quality` — 音声認識クオリティ（light/standard/high） |
| 784-836 | `GET/POST/DELETE /api/gemini-key` — ユーザーごとのGemini APIキー（暗号化保存） |
| 842, 853 | **`GET/POST /api/gemini-auto`** — 自動解析のon/off（2026-07-13追加） |
| 888-1026 | Waseda連携（資格情報保存・スクレイパ起動・進捗ポーリング） |
| 1028 | `POST /api/moodle/sync` — 即時同期 |

### 音声ジョブ・ワーカー管理（1044〜1160行）

| 行 | エンドポイント |
| --- | --- |
| 1044 | `POST /api/audio` — スマホからのWAV受信→キュー化 |
| 1064 | `GET /api/audio/jobs` — ジョブ一覧（`?active=1` で未処理・処理中・失敗のみ） |
| 1083 | `GET /api/audio/workers` — PC選択画面用のワーカー一覧（メトリクス・online判定つき） |
| 1121 | `POST /api/audio/workers/:id` — allowed/名前の変更（他人のglobal PCはprefsのみ） |
| 1147 | `DELETE /api/audio/workers/:id` |

### ワーカークライアント用 JSON API（1161〜1362行）★新プロトコル

| 行 | 内容 |
| --- | --- |
| 1171 | `UUID_RE` — clientId の形式チェック |
| 1176 | `authFromJsonBody(req)` — ボディの `auth.{email,token}` で認証 |
| 1188 | **`requireClientWorker(req, res)`** — 認証+clientId照合の共通ガード。全ワーカーAPIの入口 |
| 1214 | `POST /api/client/register` — クライアント登録（UUID+表示名。409=uuid_conflict） |
| 1244 | `POST /api/client/claim` — ジョブ1件確保 |
| 1282 | `POST /api/client/metrics` — 使用率報告+ハートビート |
| 1311 | `POST /api/client/jobs/download` — 音声本体（JSONリクエスト→バイナリ応答） |
| 1340 | `POST /api/client/jobs/result` — 文字起こし結果/エラー |

詳細は [04-worker-protocol.md](04-worker-protocol.md)。

### 文字起こし・解析（1365〜1487行）

| 行 | 内容 |
| --- | --- |
| 1365 | **`runAnalysisPipeline(email, transcriptId, content)`** — Gemini解析→saveAnalysis→タスクupsert/更新/取消の共通パイプライン |
| 1375 | `POST /api/upload` — テキスト文字起こしの受信（gemini_auto がONなら自動解析） |
| 1429 | `GET /api/transcripts` — 一覧（`?contains=語` で本文全文検索） |
| 1444 | `POST /api/transcripts/:id/analyze` — 手動解析（「解析する」ボタン） |
| 1472 | `GET /api/transcripts/:id` — 本文取得 |

### AIチャット（1490〜1762行）

| 行 | 内容 |
| --- | --- |
| 1490 | `POST /api/ask` — 質問応答+タスク操作の実行。文脈としてタスク/要約/時間割/カレンダー/資料要約/文字起こし抜粋/会話履歴を渡す。Geminiが `need_files` を返したらファイル本文を取得して2回目の呼び出し |
| 1665 | `GET /api/chat/history` |
| 1678-1762 | 補助関数: `extractKeywords` / `extractDateFromQuestion` / `buildTranscriptIndex` / `resolveTaskTarget` |

### タスク・要約・リマインド・CSV（1768〜2035行）

| 行 | エンドポイント |
| --- | --- |
| 1768-1848 | `GET/POST /api/tasks`, `PATCH /api/tasks/:id`, `POST /api/tasks/:id/done`, `DELETE /api/tasks/:id` |
| 1865-1903 | `GET /api/summary/:day`（`today`可）, `POST /api/summary/:day/generate`, `GET /api/summaries` |
| 1910-1931 | `GET /api/reminders`, `POST /api/reminders/ack` |
| 1963-1980 | `GET /kadai/:id.csv`, `GET /yotei/:id.csv` — 解析結果のCSVダウンロード |
| 1985 | `GET /` — ダッシュボード（HTML一枚返し） |
| 1991-2017 | `GET /api/transcript/:id`（モーダル用）, `GET /download/:id`（txtダウンロード） |
| 2021 | `POST /api/send-summary` — 日次サマリの手動トリガ |

### 後半: 定期ジョブとダッシュボード（2035行〜末尾）

| 行 | 内容 |
| --- | --- |
| 2035-2126 | 日次サマリのスケジューラ（`scheduleDailySummary` / 事前生成） |
| 2128〜約3560 | **`renderDashboard()`** — ダッシュボードのHTML+CSS+JSをテンプレート文字列で丸ごと返す。UIの変更はここ（[08-dashboard.md](08-dashboard.md) 参照） |
| 末尾 `main()` | `db.ensureSchema()` → reminders/moodle/audio の start → `app.listen` |

## audio.js の構造

| 関数 | 役割 |
| --- | --- |
| `enqueue(email, filename, buffer, mime)` | WAVを `uploads/audio/` に保存し `audio_jobs` に queued 登録 |
| `claimRemoteJob(email, workerId, {global})` | queued ジョブを1件確保して claim レスポンス用の形に整形（quality はジョブ所有者の設定） |
| `getClaimedJob(email, id, workerId)` | claim済みジョブの厳格照合（workerId必須）。ファイル消失時は error で閉じる |
| `completeRemoteJob(email, id, {text,error,workerId})` | 結果受理 → `finishJobWithText` |
| `finishJobWithText(job, text)` | transcripts へ**追記**保存 → gemini_auto がONなら解析+日次要約 → ジョブdone → 音声ファイル削除 |
| `start()` | 起動時+60秒ごとに止まったジョブを再キュー（`AUDIO_WORKER_STALE_MIN` 分ハートビートが無いもの） |

## db.js の構造（セクション別）

| 行 | セクション | 主な関数 |
| --- | --- | --- |
| 20-295 | スキーマ | `ensureSchema()`（CREATE TABLE IF NOT EXISTS + 後付けカラム）、`addColumnIfMissing` / `addIndexIfMissing` |
| 297-515 | transcripts | `saveTranscript`（上書き）/ `appendTranscript`（追記）/ `saveAnalysis` / `listTranscriptsByEmail`（contains対応）/ `searchTranscriptSnippets` / `listTranscriptIndex` |
| 517-719 | tasks | `upsertTask(s)` / `cancelTasks` / `applyTaskUpdates` / `listUpcomingTasks` / `findDueTasks` / `markNotified` |
| 721-855 | audio_workers | **`registerAudioWorker`**（UUID登録、他人のUUIDなら`{conflict:true}`）/ **`getAudioWorkerByUuid`**（email+UUID両一致のみ）/ `listAudioWorkers` / `setAudioWorkerPref` / `setAudioWorkerMode` / `updateAudioWorkerMetrics` |
| 857-982 | audio_jobs | `claimNextAudioJob`（`UPDATE...LIMIT 1`+`LAST_INSERT_ID`で原子的claim）/ **`getClaimedAudioJob`**（JOINで厳格照合）/ `touchAudioJob`（ハートビート）/ `requeueStaleAudioJobs` |
| 984-1052 | daily_summaries / notifications | |
| 1054-1300 | users・設定・連携 | `createUser` / `getUserByToken` / `setGeminiAuto` / `getGeminiAuto` / `setGeminiKeyEnc` / Waseda / Google / courses / documents / calendar_events |
| 1303-1330 | chat_messages | |

## gemini.js の構造

すべての関数が **email を第一引数**に取り、そのユーザーの登録キー（`users.gemini_api_key_enc` を復号）で API を呼ぶ。

| 関数 | 役割 |
| --- | --- |
| `apiKeyFor(email)` / `isConfiguredFor(email)` / `requireApiKey(email)` | キーの取得と存在確認 |
| `verifyApiKey(apiKey)` | 登録前の疎通確認 |
| `analyze(email, content)` | 本文→ `{kadai, yotei, summary, tasks, updates, cancellations}` を抽出（メインの解析） |
| `summarizeDocument(email, {...})` | PDF/TXTの要約 |
| `summarizeDay(email, day, transcripts)` | 日次要約の生成 |
| `ask(email, question, ctx)` | AIチャット。`{reply, actions, needFiles}` を返す |
| `extractTaskRequests(email, question)` | askの登録フォールバック |
| `localDate()` | サーバーローカルの "YYYY-MM-DD" |
| `MODEL` / `NO_KEY_MESSAGE` | 定数 |
