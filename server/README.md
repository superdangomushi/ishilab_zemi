# AIHelper.jp サーバー兼ウェブアプリ (Node.js + Express + MySQL)

文字起こしアプリから送られてくるテキストを受け取り **MySQL に保存**し、
**Gemini** で「課題」「予定」「要約」を抽出する。締切が近づくと **LINE** と
**端末ローカル通知**で警告し、その日の出来事を**日次要約**にまとめ、
**AIチャット**で質問応答・予定登録までこなす。ブラウザ（`/`）がダッシュボード。

## できること

- 文字起こしの受信・保存（`POST /api/upload`）
- 音声ファイルの受信・キュー化（`POST /api/audio`）と、ローカルPCワーカーによる文字起こし
- Gemini による課題・予定の抽出（締切付き）と、このアップロード分の短い要約
- 締切の **1日前 / 1時間前** リマインド（LINE push ＋ 端末通知用に記録、冪等）
- **日次要約**（その日の文字起こしから「今日何があったか」を生成）
- **AIチャット**（`POST /api/ask`）— 質問に回答し、依頼（予定追加・完了化）を実行
- ダッシュボード（締切カウントダウン・タスク管理・今日の要約・チャット）

## セットアップ

### Ubuntu Server なら Makefile で一発

```bash
cd server
make install       # Node.js + MySQL 導入 → DB/専用ユーザー作成 → schema 適用 → npm ci (sudo 使用)
make run           # http://localhost:3000

# パスワード等は変数で上書き可
make install DB_PASSWORD=好きなパスワード
make run GEMINI_API_KEY=xxx LINE_CHANNEL_ACCESS_TOKEN=yyy
```

`make install` は Node が接続する専用ユーザー（既定 `aihelper`/`aihelper`）を作成し、
`make run` はその認証情報を環境変数で Node に渡す。`make help` で全ターゲットを表示。

### 手動で行う場合

```bash
cd server
npm install

# DB を用意（schema.sql で AIHelper DB と各テーブルを作成）
mysql -u root < schema.sql

# 起動
npm start          # http://localhost:3000
```

接続情報・連携キーは環境変数で渡す。

| 変数 | デフォルト | 説明 |
| --- | --- | --- |
| `DB_HOST` | `localhost` | MySQL ホスト |
| `DB_PORT` | `3306` | ポート |
| `DB_USER` | `root` | ユーザー |
| `DB_PASSWORD` | （空） | パスワード |
| `DB_NAME` | `AIHelper` | データベース名 |
| `PORT` | `3000` | サーバーの待受ポート |
| `GEMINI_API_KEY` | （空） | Gemini の API キー。未設定なら抽出・要約・AIチャットは無効 |
| `GEMINI_MODEL` | `gemini-2.5-flash` | 使用する Gemini モデル |
| `LINE_CHANNEL_ACCESS_TOKEN` | （空） | LINE Messaging API のチャネルアクセストークン。未設定なら LINE 送信はスキップ |
| `REMINDER_INTERVAL_SEC` | `60` | 締切チェックの間隔（秒） |
| `DAILY_SUMMARY_INTERVAL_MIN` | `300` | 「今日の要約」自動再生成の間隔（分）。`0` で無効 |
| `DAILY_SUMMARY_PREGENERATE_LEAD_MIN` | `15` | `DAILY_SUMMARY_TIME` の何分前に「今日の要約」を事前生成するか |
| `GOOGLE_CLIENT_ID` | （空） | Web からの Google カレンダー連携用 OAuth クライアント ID |
| `GOOGLE_CLIENT_SECRET` | （空） | 同シークレット。両方未設定なら Web の Google 連携は無効 |
| `GOOGLE_REDIRECT_URL` | リクエストから自動 | OAuth リダイレクト URI を固定したい場合に指定 |
| `AUDIO_WORKER_STALE_MIN` | `180` | 外部PCワーカーが落ちたとみなして音声ジョブを再キューするまでの分数 |

音声文字起こしは、公開サーバーの負荷を避けるため `../client` の外部PCワーカーで行う。
Whisper / GPU / CUDA 関連の設定は `client/README.md` を参照。

### 音声処理をローカルPCに逃がす

公開サーバーは `POST /api/audio` で音声を受け取り、`audio_jobs` に `queued` として保存するだけにする。
処理用PCでは同じリポジトリの `client/` で、公開サーバーURLと自分のアカウント情報を指定してワーカーを起動する。

```bash
cd client
make stt-deps

npm start
```

起動後、`http://127.0.0.1:39123` を開き、公開サーバーURLと処理したいアカウントのメール・パスワードを複数登録する。
パスワードは `/api/login` に使うだけで、PC側には返ってきたトークンだけを保存する。

ワーカーは既定で10秒ごとに `/api/audio/worker/claim` を呼び、登録済みアカウントと同じ `email + token` の音声ジョブだけを確保する。
その後 `/api/audio/worker/jobs/:id/file` で音声をダウンロードし、このPCで Whisper 処理を行い、
`/api/audio/worker/jobs/:id/result` へ JSON で文字起こし結果を返す。ポーリング間隔は
`AUDIO_WORKER_POLL_SEC=10` で変更できる。

Web の Google 連携を有効にするには、Google Cloud Console で「OAuth クライアント ID（ウェブアプリケーション）」を作成し、
承認済みリダイレクト URI に `https://<ドメイン>/api/google/callback` を登録して、上記 2 変数を `.env` などで渡す。
（Android アプリの連携は端末内のアカウントを使うため、この設定は不要。）

```bash
# フル機能で起動する例
DB_USER=root DB_PASSWORD=secret \
GEMINI_API_KEY=xxxxxxxx \
LINE_CHANNEL_ACCESS_TOKEN=yyyyyyyy \
npm start
```

テーブルは起動時に `CREATE TABLE IF NOT EXISTS` で自動作成（DB 自体は事前に作成が必要）。
既存 DB に対しても不足カラムは自動で追加される。

## アカウント登録（LINE 連携）

`accounts.example.json` を `accounts.json` にコピーし、「アカウント(email)」「事前に作るトークン」、LINE 送信先の `lineUserId` を書く。
`accounts.json` は機密を含むため git 管理しない。
アプリでログインしたアカウントがここと一致したときだけ受け付ける。

```json
[
  {
    "email": "demo@AIHelper.jp",
    "token": "demo-token-1234567890",
    "lineUserId": "Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  }
]
```

- `lineUserId` … 警告を送る相手の userId（LINE Developers の Webhook 等で取得。`U` で始まる）。
  空なら LINE 送信はスキップし、端末ローカル通知だけが機能する。
- LINE 側は **Messaging API チャネル**を作成し、`LINE_CHANNEL_ACCESS_TOKEN`（長期）を発行しておく。

## データモデル（主なテーブル）

| テーブル | 役割 |
| --- | --- |
| `transcripts` | 受信した文字起こし（1ファイル=1行）。`summary` に短い要約、生 JSON の課題/予定も保持 |
| `tasks` | 抽出/手動追加した課題・予定を1件1行で正規化。`deadline_at`・`status`・`notified_1d/1h` を持つ＝リマインドの単位 |
| `daily_summaries` | 日付ごとの「今日の要約」（email × day でユニーク） |
| `notifications` | 送信済みリマインドの記録。`acked=0` を端末アプリがローカル通知として取得 |

`tasks` は `(email, dedup_key)` がユニーク（同じ内容・締切は重複登録しない）。
締切が日付のみのときは時刻 `23:59` を補って格納する。

## API / ページ

| メソッド | パス | 用途 |
| --- | --- | --- |
| POST | `/api/login` | アカウント＋トークンの照合（LINE 連携状況も返す） |
| POST | `/api/upload` | 文字起こし受信 → 保存 → Gemini で課題/予定/要約を抽出 |
| POST | `/api/audio` | 音声ファイル受信 → 音声ジョブとしてキュー化 |
| POST | `/api/audio/worker/claim` | 外部PCワーカーが自分の音声ジョブを1件確保 |
| GET | `/api/audio/worker/jobs/:id/file` | claim 済み音声ジョブの音声本体を取得 |
| POST | `/api/audio/worker/jobs/:id/result` | 外部PCワーカーが文字起こし結果またはエラーを返す |
| GET | `/api/transcripts` | ログイン中ユーザーの文字起こし一覧 |
| GET | `/api/transcripts/:id` | ログイン中ユーザーの文字起こし本文 |
| POST | `/api/ask` | AIチャット。回答＋依頼（予定追加・完了化）の実行 |
| GET | `/api/chat/history` | AIチャット履歴 |
| GET | `/api/tasks` | 課題・予定の一覧（`?done=1` で完了も含む） |
| POST | `/api/tasks` | タスクを手動追加（`type, content, details, deadline`） |
| POST | `/api/tasks/:id/done` | 完了/未完了の切替（`{status}`） |
| DELETE | `/api/tasks/:id` | タスク削除 |
| GET | `/api/summary/:day` | 指定日（`today` 可）の要約を取得 |
| POST | `/api/summary/:day/generate` | その日の要約をいま生成し直す |
| GET | `/api/summaries` | 直近の日次要約一覧 |
| GET | `/api/reminders` | 未読リマインド（端末がローカル通知化する） |
| POST | `/api/reminders/ack` | リマインドを既読化（`{ids:[...]}`） |
| GET | `/` | ダッシュボード（締切・要約・タスク・チャット） |
| GET | `/download/:id` | 文字起こしを `.txt` でダウンロード |
| GET | `/kadai/:id.csv` / `/yotei/:id.csv` | 抽出した課題/予定を CSV（`期限,内容,詳細`）で取得 |

認証は API 共通で、`X-Account-Email` + `Authorization: Bearer <token>` ヘッダで渡す。
互換性のため一部 POST は JSON ボディの `email` `token` も受け付けるが、URL クエリには載せない。

### POST /api/upload
```
Authorization: Bearer demo-token-1234567890
X-Account-Email: demo@AIHelper.jp
X-Filename: 2026-06-14_15.txt
Content-Type: text/plain

（本文 = テキストファイルの中身）
```

### POST /api/ask
```bash
curl -X POST http://localhost:3000/api/ask \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@AIHelper.jp","token":"demo-token-1234567890",
       "question":"来週月曜10時にゼミの予定入れといて"}'
# → { ok:true, reply:"了解です。来週月曜10時にゼミを登録しました。", applied:[{op:"add_task",...}] }
```

## リマインドの仕組み

- `reminders.js` が `REMINDER_INTERVAL_SEC` ごとに `tasks` を走査。
- 締切が **今から24時間以内**で `notified_1d=0` のもの →「1日前」警告。
- 締切が **今から1時間以内**で `notified_1h=0` のもの →「1時間前」警告。
- LINE に push（設定時）し、`notifications` に記録、フラグを立てて二重送信を防ぐ。
- 端末アプリは `GET /api/reminders` で未読を取得しローカル通知 → `ack` で既読化。

## 日次要約

- `DAILY_SUMMARY_INTERVAL_MIN` ごと（既定は5時間ごと）に、アクティブな各アカウントの「今日」をまとめて再生成。
- さらに `DAILY_SUMMARY_TIME` の `DAILY_SUMMARY_PREGENERATE_LEAD_MIN` 分前（既定15分前）にも、送信/表示直前の最終生成を行う。
- 音声ジョブが完了した直後にも、そのユーザーの当日要約を再生成する。
- ダッシュボードの「今すぐ生成し直す」や `POST /api/summary/:day/generate` で任意の日も生成可能。

## 動作確認 (curl)

```bash
# 文字起こしを送る（Gemini 設定時は課題/予定/要約も付く）
curl -X POST http://localhost:3000/api/upload \
  -H 'Authorization: Bearer demo-token-1234567890' \
  -H 'X-Account-Email: demo@AIHelper.jp' \
  -H 'X-Filename: 2026-07-01_15.txt' \
  -H 'Content-Type: text/plain' \
  --data-binary '来週月曜までにレポート提出。水曜15時から研究会議です。'

# ブラウザで http://localhost:3000/ を開き、ログイン情報を入れると
# 締切カウントダウン・今日の要約・タスク・AIチャットが使える
```
