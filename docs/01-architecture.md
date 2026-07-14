# 全体構成（アーキテクチャ）

## 登場人物

```
┌──────────────┐  WAVアップロード   ┌──────────────────────┐
│ スマホアプリ  │ ────────────────→ │  公開サーバー (server/)│
│ (app/, ios/) │  タスク/通知取得    │  Node.js + Express     │
└──────────────┘ ←──────────────── │  + MySQL               │
                                    │                        │
┌──────────────┐  ダッシュボード操作 │  - API                 │
│ ブラウザ      │ ←───────────────→ │  - ダッシュボード(/)    │
│ (PC/スマホ)  │                    │  - リマインドエンジン    │
└──────────────┘                    │  - Gemini解析          │
                                    └──────────┬────────────┘
┌──────────────────────┐   JSONでやり取り       │
│ ワーカーPC (client/)  │ ←────────────────────┘
│ audio-worker.js       │   claim / download / result
│ + faster-whisper      │   （04-worker-protocol.md 参照）
└──────────────────────┘
```

| 役割 | 場所 | 概要 |
| --- | --- | --- |
| 公開サーバー | `server/` | すべてのデータの置き場所。音声ジョブのキュー管理、文字起こしの保存、Gemini による課題/予定抽出、締切リマインド（LINE + アプリ通知）、Web ダッシュボード |
| ワーカーPC | `client/` | ユーザーの手元のPC。サーバーの音声ジョブをポーリングし、faster-whisper でローカル文字起こしして結果を返す。**重い処理をサーバーから逃がすための存在** |
| Androidアプリ | `app/` | 常時録音し、WAV をサーバーへアップロード。タスク・通知・文字起こしをサーバーから取得して表示 |
| iOSアプリ | `ios/` | Android版の移植（SwiftUI）。ビルド未検証 |

## 音声が「課題リスト」になるまでの流れ

1. **録音・アップロード** — スマホアプリが録音した WAV を `POST /api/audio` へ送る。
   サーバーは `server/uploads/audio/` に保存し、`audio_jobs` テーブルに `status='queued'` で登録するだけ（自分では処理しない）。
2. **claim（ジョブ確保）** — ワーカーPCが 10秒ごとに `POST /api/client/claim` を呼ぶ。
   サーバーは queued のジョブを **原子的に1件だけ** `processing` に変えて渡す（複数PCが同時に来ても同じジョブは二重に渡らない）。
3. **ダウンロード** — ワーカーが `POST /api/client/jobs/download` で音声本体を取得。
4. **文字起こし** — ワーカーPC上で `client/stt/transcribe.py`（faster-whisper）が実行される。
5. **結果送信** — `POST /api/client/jobs/result` にテキストを返す。サーバーは `transcripts` テーブルへ保存（同名ファイルは追記）。
6. **Gemini解析** — ジョブ所有者が自動解析ON（`users.gemini_auto=1`、既定）なら、
   本文から課題・予定・要約を抽出して `tasks` へ登録し、日次要約も更新する。
   OFF ならスキップされ、ダッシュボードの「解析する」ボタンで手動実行する。
7. **リマインド** — `server/reminders.js` が締切の1日前・1時間前に LINE 送信＋`notifications` へ記録。
   アプリは `GET /api/reminders` をポーリングしてローカル通知を出す。

## 認証の2系統

| 系統 | 使う相手 | 渡し方 |
| --- | --- | --- |
| ヘッダー認証 | ブラウザ（ダッシュボード）・スマホアプリ | `X-Account-Email: <email>` + `Authorization: Bearer <token>` |
| JSONボディ認証 | **ワーカーPC（`/api/client/*` のみ）** | ボディに `"auth": {"email":..., "token":...}` + `"clientId": "<UUID>"` |

トークンはユーザー登録時（`POST /api/register`）にサーバーが発行する48桁hexで、
`users.token` に保存される。ワーカーの `clientId` はクライアントが自分で生成した UUID で、
登録フェーズ（`POST /api/client/register`）でアカウントに紐付く。詳細は [04-worker-protocol.md](04-worker-protocol.md)。

## private / global ワーカー

- **private**（既定）: そのPCでログインしたアカウントの音声だけを処理する。
- **global**: 全ユーザーの音声処理を担うPCとして公開する。ただし他ユーザーのジョブが流れるのは、
  そのユーザーがダッシュボードのPC選択画面で**明示的にそのPCへチェックを入れた場合だけ**（オプトイン。`audio_worker_prefs` テーブル）。

## 主要な定期処理（サーバー側）

| 処理 | 間隔 | 場所 |
| --- | --- | --- |
| 締切リマインド監視 | 60秒（`REMINDER_INTERVAL_SEC`） | `reminders.js` |
| 「今日の要約」自動再生成 | 300分（`DAILY_SUMMARY_INTERVAL_MIN`） | `reminders.js` |
| 日次サマリのLINE送信 | 毎日 21:00（`DAILY_SUMMARY_TIME`） | `server.js scheduleDailySummary()` |
| Moodle 定期同期 | 72時間 | `moodle.js` |
| 止まった音声ジョブの再キュー | 60秒（stale判定は `AUDIO_WORKER_STALE_MIN` 分） | `audio.js start()` |

## 主要な定期処理（ワーカーPC側）

| 処理 | 間隔 | 内容 |
| --- | --- | --- |
| ジョブポーリング | 10秒（`AUDIO_WORKER_POLL_SEC`） | アカウントごとに claim を試みる |
| メトリクス送信 | 3秒（`AUDIO_WORKER_METRICS_SEC`） | CPU/メモリ/GPU使用率 + 処理中ジョブのハートビート |
