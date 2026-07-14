# APIリファレンス

公開サーバー（`server/server.js`）の全エンドポイント。
**ワーカー用 `/api/client/*` は [04-worker-protocol.md](04-worker-protocol.md) 参照**（ここでは省略）。

## 共通事項

### 認証

`/api/register` `/api/login` `/api/google/callback` 以外は認証必須。ヘッダーで渡す:

```
X-Account-Email: user@example.com
Authorization: Bearer 691ff8ca9ac063e6caa6f0bd952869212d198da27f1c55ed
```

（互換のため一部POSTはボディの `email`/`token` も受けるが、新規コードはヘッダーを使うこと）

### レスポンスの基本形

```json
{ "ok": true,  ... }                        // 成功
{ "ok": false, "error": "日本語のメッセージ" } // 失敗（内部詳細は返さない）
```

### レートリミット

- `authLimiter`: 15分に20回（IP+email毎）— register / login
- `heavyLimiter`: 1時間に30回（email毎）— upload / audio / files / ask / analyze / summary generate
- 超過時は 429 + `Retry-After` ヘッダー

---

## 認証・アカウント

### POST /api/register — 新規登録

```json
// リクエスト
{ "email": "user@example.com", "password": "passw0rd" }
// レスポンス（token は以後のAPI認証に使う。48桁hex）
{ "ok": true, "email": "user@example.com", "token": "691ff8ca9ac063e6..." }
```

失敗: 400（形式不正/6文字未満）、409（登録済みメール）。パスワードは scrypt でハッシュ保存。

### POST /api/login — ログイン

```json
// Web（パスワード）
{ "email": "user@example.com", "password": "passw0rd" }
// アプリ（トークン照合）
{ "email": "user@example.com", "token": "691ff8ca..." }
// レスポンス
{ "ok": true, "email": "user@example.com", "token": "691ff8ca...", "line": false }
```

総当たり対策: IP毎に10回失敗で15分ロック（429）。

### POST /api/change-password

```json
{ "currentPassword": "old", "newPassword": "new123" }  → { "ok": true }
```

---

## 音声ジョブ（アプリ→サーバー）

### POST /api/audio — WAVアップロード

ボディは**JSON ではなく音声バイナリ**（最大300MB）。メタはヘッダーで渡す:

```
POST /api/audio
X-Account-Email: user@example.com
Authorization: Bearer 691ff8ca...
Content-Type: audio/wav
X-Filename: 2026-07-13_18.wav

(WAVバイト列)
```

```json
{ "ok": true, "jobId": 42, "queued": true }
```

### GET /api/audio/jobs — ジョブ状況

`?active=1` を付けると **未処理(queued)・処理中(processing)・失敗(error) のみ**返す
（ダッシュボードはこれを使う。完了分は文字起こし一覧側で見る）。`?limit=30` も可。

```json
{
  "ok": true,
  "jobs": [
    {
      "id": 42,
      "filename": "2026-07-13_18.wav",
      "size_bytes": 10485760,
      "status": "processing",
      "error": null,
      "transcript_id": null,
      "claimed_by": 4,
      "worker_name": "研究室デスクトップ",
      "created_at": "2026-07-13 18:00:01",
      "updated_at": "2026-07-13 18:00:15"
    }
  ]
}
```

### GET /api/audio/workers — 処理PC一覧（ダッシュボードのPC選択画面用）

自分のPC + 他ユーザーが公開している global PC を返す。

```json
{
  "ok": true,
  "workers": [
    {
      "id": 4,
      "name": "研究室デスクトップ",
      "ip": "203.0.113.5",        // 自分のPCのみ。他人のglobal PCは null
      "owned": true,
      "mode": "private",
      "allowed": true,             // 自分のPC=処理許可 / 他人のPC=自分のジョブを任せるか(prefs)
      "lastSeenAt": "2026-07-13T18:00:15.000Z",
      "online": true,              // 60秒以内に接続あり
      "cpuPct": 43.2, "memPct": 61.5, "gpuPct": null,
      "metricsAt": "2026-07-13T18:00:15.000Z",
      "metricsFresh": true         // 15秒以内のメトリクスか（古ければUIは "—" 表示）
    }
  ]
}
```

### POST /api/audio/workers/:id — PC設定変更

```json
{ "allowed": false }          // 処理を止める（自分のPC）/ 任せない（他人のglobal PC）
{ "name": "新しい表示名" }     // 自分のPCのみ
```

### DELETE /api/audio/workers/:id — PC削除

削除されたPCのクライアントは次のリクエストで 403 `unregistered` を受け、自動で再登録する（新しい行になる）。

---

## 文字起こし

### POST /api/upload — テキスト文字起こしの受信（アプリの端末内Whisper用）

ボディは `text/plain` の本文そのもの。ファイル名はヘッダー `X-Filename` で渡す（同名は**上書き**）。

```json
{ "ok": true, "saved": "2026-07-13_18.txt", "bytes": 1234, "analyzed": true, "tasks": 2 }
```

`analyzed` は Gemini 自動解析が走ったか（キー未登録 or `gemini_auto=false` なら false）。

### GET /api/transcripts — 一覧

クエリ: `?limit=200`（最大200）、**`?contains=ゼミ`（本文にその文字列を含むファイルだけに絞る全文検索）**。

```json
{
  "ok": true,
  "transcripts": [
    {
      "id": 123,
      "filename": "2026-07-13_18.txt",
      "chars": 2048,
      "updated_at": "2026-07-13 18:20:00",
      "analyzed_at": null            // null = 未解析
    }
  ]
}
```

### GET /api/transcripts/:id — 本文取得

```json
{
  "ok": true,
  "transcript": {
    "id": 123,
    "filename": "2026-07-13_18.txt",
    "content": "今日のゼミは15時からです。…",
    "summary": "ゼミの時間変更とレポート締切の連絡。",
    "updated_at": "2026-07-13 18:20:00",
    "analyzed_at": "2026-07-13 18:21:00"
  }
}
```

### POST /api/transcripts/:id/analyze — 手動解析 ★

自動解析OFF（`gemini_auto=false`）のユーザーが「解析する」ボタンで叩く（ONのユーザーの再解析にも使える）。
要約・課題/予定の抽出・タスク登録/変更/取消まで一式が走る。

```json
// レスポンス
{ "ok": true, "analyzed": true, "tasks": 2, "summary": "ゼミの時間変更と…" }
// Geminiキー未登録（400）
{ "ok": false, "error": "Gemini APIキーが未登録です。ダッシュボードの「アカウント」タブで登録してください" }
```

### GET /download/:id — 本文をtxtでダウンロード / GET /kadai/:id.csv, /yotei/:id.csv — 解析結果CSV

いずれも認証必須・本人の分のみ。CSVは `期限,内容,詳細` の3列（BOM付きUTF-8）。

---

## タスク（課題・予定）

### GET /api/tasks

`?done=1` で完了済みも含む。締切が近い順（未定は末尾）。

```json
{
  "ok": true,
  "tasks": [
    {
      "id": 7,
      "type": "kadai",              // "kadai" | "yotei"
      "content": "統計学レポート",
      "details": "第5章まで",
      "deadline_at": "2026-07-18 23:59:00",
      "date_only": 1,               // 1 = 日付だけ指定（23:59補完済み）
      "status": "pending",          // "pending" | "done"
      "notified_1d": 0, "notified_1h": 0
    }
  ]
}
```

### POST /api/tasks — 手動追加

```json
{ "type": "yotei", "content": "ゼミ", "details": "", "deadline": "2026-07-20T15:00" }
```

`deadline` は `"YYYY-MM-DDTHH:MM"`（時刻あり）か `"YYYY-MM-DD"`（日付のみ→23:59補完・date_only=1）。

### PATCH /api/tasks/:id — 編集 / POST /api/tasks/:id/done — 完了切替 / DELETE /api/tasks/:id

```json
// done の切替
{ "status": "done" }   // または "pending"
```

---

## AIチャット

### POST /api/ask

```json
// リクエスト
{ "question": "来週月曜10時にゼミ入れといて" }
// レスポンス
{
  "ok": true,
  "reply": "来週月曜10時にゼミを予定として登録しました。",
  "applied": [
    { "op": "add_task", "type": "yotei", "content": "ゼミ", "deadline_at": "2026-07-20 10:00:00" }
  ]
}
```

`applied` は**実際にDBに反映された操作**の一覧（op: `add_task` / `complete_task` / `delete_task` / `update_task`）。
Geminiが「登録した」と言いつつ操作を返さなかった場合の保険抽出もある。
サーバーはタスク・要約・時間割・Google/スマホカレンダー・資料要約・関連する文字起こし抜粋を文脈として渡す。

### GET /api/chat/history

```json
{ "ok": true, "messages": [ { "role": "user", "content": "…", "created_at": "…" }, ... ] }
```

---

## 要約・リマインド

### GET /api/summary/:day — 日次要約（`:day` は `today` か `YYYY-MM-DD`）

```json
{ "ok": true, "day": "2026-07-13", "summary": "今日は…", "generated_at": "2026-07-13 20:45:00" }
```

### POST /api/summary/:day/generate — いま生成し直す

```json
{ "ok": true, "day": "2026-07-13", "summary": "…", "empty": false }
```

### GET /api/summaries — 直近30日分の一覧

### GET /api/reminders — 未読通知（アプリがローカル通知化）

```json
{ "ok": true, "reminders": [ { "id": 1, "task_id": 7, "kind": "1h", "message": "…", "created_at": "…" } ] }
```

### POST /api/reminders/ack

```json
{ "ids": [1, 2] }  → { "ok": true }
```

---

## 設定（ユーザーごと）

### GET/POST /api/stt-quality — 音声認識クオリティ

```json
// GET → { "ok": true, "quality": "high", "choices": ["light", "standard", "high"] }
// POST { "quality": "standard" } → { "ok": true }
```

### GET/POST/DELETE /api/gemini-key — Gemini APIキー

```json
// GET → 本体は返さない
{ "ok": true, "hasKey": true, "tail": "Xy9z", "model": "gemini-2.5-flash-lite" }
// POST（登録前に疎通確認あり。無効キーは保存されない）
{ "apiKey": "AIza..." }  → { "ok": true, "tail": "Xy9z" }
```

### GET/POST /api/gemini-auto — 自動解析のon/off ★

```json
// GET → { "ok": true, "enabled": true }
// POST
{ "enabled": false }  → { "ok": true, "enabled": false }
```

OFFにすると文字起こし保存時の自動解析（課題/予定抽出・要約・日次要約更新）が止まり、
`POST /api/transcripts/:id/analyze`（ダッシュボードの「解析する」ボタン）でのみ実行される。

---

## 連携系（概要のみ）

| エンドポイント | 内容 |
| --- | --- |
| `GET/POST /api/moodle`, `POST /api/moodle/sync` | Moodle iCal URLの保存と即時同期（→tasks） |
| `GET/POST /api/waseda`, `POST /api/waseda/sync`, `GET /api/waseda/sync/status` | Waseda資格情報（暗号化保存）とスクレイパによる時間割取り込み・進捗 |
| `GET/POST/PATCH/DELETE /api/courses` | 時間割のCRUD |
| `POST/GET /api/files` | PDF/TXTのGemini要約（`X-Filename` ヘッダー + バイナリ/テキストボディ） |
| `GET /api/google/auth-url` → `GET /api/google/callback` | Web OAuth（同意画面URL発行→code交換） |
| `GET /api/google/accounts`, `POST /api/google/unlink` | 連携Google一覧・解除 |
| `GET /api/google/events` | 全連携アカウント+スマホ同期分の直近予定 |
| `POST /api/google/add-event`, `POST /api/google/sync-courses` | 締切のカレンダー登録・時間割の週次一括登録 |
| `POST /api/calendar/sync` | スマホのローカルカレンダー予定を同期 |
| `POST /api/send-summary` | 日次サマリの手動トリガ（accounts.jsonのトークン限定） |
