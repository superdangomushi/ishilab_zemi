# 音声ワーカー JSONプロトコル詳細

ワーカーPC（`client/audio-worker.js`）と公開サーバー（`/api/client/*`）のやりとりの完全な仕様。
2026-07-13 に全面刷新され、**旧ヘッダー方式（`X-Worker-*`）と接続元IPによる同一PC推定は廃止**された。

## 基本ルール

1. **すべて `POST` + JSONボディ**（`Content-Type: application/json`）。
2. 毎リクエストのボディに必ず次の2つを含める:
   ```json
   {
     "auth": { "email": "user@example.com", "token": "691ff8ca9ac0...(48桁hex)" },
     "clientId": "41685d34-86c5-42be-a598-e4985d8d43f4"
   }
   ```
   - `auth` … `/api/login` で得たアカウント認証情報。
   - `clientId` … **クライアントが自分で生成した UUID**（このPCのID）。登録フェーズでアカウントに紐付く。
3. レスポンスは常に `{"ok": true, ...}` か `{"ok": false, "error": "...", "code": "..."}`。
   `code` は機械判定用（下記エラーコード表）。
4. 唯一の例外: `jobs/download` の成功レスポンスは JSON ではなく**音声バイナリ**。

## エンドポイント一覧

| # | エンドポイント | 目的 | 呼ぶタイミング |
| --- | --- | --- | --- |
| 1 | `POST /api/client/register` | クライアント登録（初回セットアップ） | クライアント起動後の最初のフェーズ / 表示名変更時 |
| 2 | `POST /api/client/claim` | ジョブを1件確保 | 10秒ごと |
| 3 | `POST /api/client/jobs/download` | 音声本体の取得 | claim でジョブを得た直後 |
| 4 | `POST /api/client/jobs/result` | 文字起こし結果/エラーの返却 | 文字起こし完了/失敗時 |
| 5 | `POST /api/client/metrics` | 使用率報告+ハートビート | 3秒ごと（登録済みのみ） |

## 全体シーケンス

```
ワーカーPC                                  サーバー
   │                                          │
   │ ①register {auth, clientId, name, mode}   │  clientId をアカウントに紐付けて登録
   ├─────────────────────────────────────────→│  （他人のUUIDなら 409 uuid_conflict）
   │ ← {ok, client:{clientId, name, ...}}     │
   │                                          │
   │ ②claim {auth, clientId, mode}   (10秒毎) │  queued を1件だけ原子的に processing へ
   ├─────────────────────────────────────────→│  claimed_by = このワーカーのID
   │ ← {ok, client, job:{jobId, ...}}         │
   │                                          │
   │ ③download {auth, clientId, jobId}        │  「claim したワーカー本人か」を厳格照合
   ├─────────────────────────────────────────→│
   │ ← WAVバイナリ                             │
   │                                          │
   │ （faster-whisper でローカル文字起こし）      │
   │    ⑤metrics {auth, clientId,             │
   │      cpu, mem, gpu, activeJobId} (3秒毎)  │  ハートビート。途絶えたら再キュー
   ├─────────────────────────────────────────→│
   │                                          │
   │ ④result {auth, clientId, jobId, text}    │  transcripts へ追記保存
   ├─────────────────────────────────────────→│  → gemini_auto がONなら解析
   │ ← {ok, status:"done", filename, chars}   │  → 音声ファイル削除
```

---

## 1. クライアント登録 `POST /api/client/register`

クライアント起動後の**最初のフェーズ（アカウント作成フェーズ）**。
クライアントが `crypto.randomUUID()` で生成した ID と、ユーザーが決めた表示名を登録する。
再実行すると表示名・モードの更新になる（冪等）。

リクエスト:

```json
{
  "auth": { "email": "user@example.com", "token": "691ff8ca9ac063e6..." },
  "clientId": "41685d34-86c5-42be-a598-e4985d8d43f4",
  "name": "研究室デスクトップ",
  "mode": "private"
}
```

| フィールド | 必須 | 説明 |
| --- | --- | --- |
| `clientId` | ✓ | UUID形式（`8-4-4-4-12` の hex）。形式不正は 400 |
| `name` | ✓ | このPCの表示名（最大255文字）。ダッシュボードのPC選択画面に出る |
| `mode` | — | `"private"`（既定）/ `"global"` |

成功レスポンス（200）:

```json
{
  "ok": true,
  "client": {
    "clientId": "41685d34-86c5-42be-a598-e4985d8d43f4",
    "name": "研究室デスクトップ",
    "mode": "private",
    "allowed": true
  }
}
```

UUID衝突（他アカウントが使用中、409）:

```json
{
  "ok": false,
  "code": "uuid_conflict",
  "error": "このIDは他のアカウントで使用されています。クライアント側でIDを再生成してください"
}
```

→ クライアントは UUID を**再生成して再登録**する（`registerAccount()` が最大3回リトライ）。

## 2. ジョブ確保 `POST /api/client/claim`

リクエスト:

```json
{
  "auth": { "email": "user@example.com", "token": "691ff8ca9ac063e6..." },
  "clientId": "41685d34-86c5-42be-a598-e4985d8d43f4",
  "mode": "private"
}
```

`mode` は現在のモードの申告。DBの値と違えばサーバー側を更新する。
**global ジョブ（他ユーザーの音声）が渡るのは、DB上のmodeとリクエストのmodeが両方 global のときだけ。**

ジョブありレスポンス:

```json
{
  "ok": true,
  "client": {
    "clientId": "41685d34-86c5-42be-a598-e4985d8d43f4",
    "name": "研究室デスクトップ",
    "mode": "private",
    "allowed": true
  },
  "job": {
    "jobId": 42,
    "filename": "2026-07-13_18.wav",
    "mime": "audio/wav",
    "sizeBytes": 10485760,
    "quality": "high"
  }
}
```

- `quality` … **ジョブ所有者**の音声認識クオリティ設定（`light`/`standard`/`high`）。
  globalモードでは処理PCの持ち主ではなくジョブ所有者の設定が使われる。

ジョブなしレスポンス:

```json
{ "ok": true, "client": { "...": "..." }, "job": null }
```

このPCがダッシュボードで処理対象外にされている場合:

```json
{ "ok": true, "client": { "clientId": "...", "name": "...", "mode": "private", "allowed": false }, "job": null }
```

→ クライアントはポーリングを続けるがジョブは来ない（UIに「処理対象外」と表示）。

## 3. 音声ダウンロード `POST /api/client/jobs/download`

リクエスト:

```json
{
  "auth": { "email": "user@example.com", "token": "691ff8ca9ac063e6..." },
  "clientId": "41685d34-86c5-42be-a598-e4985d8d43f4",
  "jobId": 42
}
```

成功レスポンス: **JSONではなく音声バイナリ**。

```
HTTP/1.1 200 OK
Content-Type: audio/wav
Content-Disposition: attachment; filename*=UTF-8''2026-07-13_18.wav
Content-Length: 10485760

(WAVバイト列)
```

失敗（自分が claim したジョブでない / processing でない / 存在しない → すべて同じ404）:

```json
{ "ok": false, "error": "処理中の音声ジョブが見つかりません" }
```

## 4. 結果送信 `POST /api/client/jobs/result`

成功時のリクエスト:

```json
{
  "auth": { "email": "user@example.com", "token": "691ff8ca9ac063e6..." },
  "clientId": "41685d34-86c5-42be-a598-e4985d8d43f4",
  "jobId": 42,
  "text": "今日のゼミは15時からです。レポートの締切は金曜日。"
}
```

失敗時のリクエスト（`text` の代わりに `error`。最大1000文字に切り詰められる）:

```json
{
  "auth": { "...": "..." },
  "clientId": "41685d34-86c5-42be-a598-e4985d8d43f4",
  "jobId": 42,
  "error": "CUDA out of memory"
}
```

成功レスポンス:

```json
{
  "ok": true,
  "status": "done",
  "empty": false,
  "transcriptId": 123,
  "filename": "2026-07-13_18.txt",
  "chars": 26
}
```

- `filename` … 保存された文字起こしのファイル名（`yyyy-MM-dd_HH.txt`。音声名から拡張子を差し替え）。
  同名が既にあれば**追記**される（同じ時間帯の複数録音を消さないため）。
- 無音などで本文が空だった場合は `{"ok": true, "status": "done", "empty": true, "transcriptId": null}`。
- エラー報告を受理した場合は `{"ok": true, "status": "queued"}` または `{"ok": true, "status": "error"}`。
  - `queued` … 試行回数（attempts）が上限（`AUDIO_MAX_ATTEMPTS`、既定3回）未満だったので、
    サーバーがジョブを**即座に待機列へ戻した**。次の claim（10秒ポーリング。失敗直後のワーカーは
    0.5秒後に再ポーリングする）で同じPCまたは別のPCがすぐ再試行する。
  - `error` … 上限に達したので保留。音声ファイルはサーバーに残り、ユーザーが
    ダッシュボードの「再試行」で待機列に戻せる。
  - どちらの場合もワーカー側での追加対応は不要（次のポーリングに進むだけでよい）。

このあとサーバー側では（ジョブ所有者の `gemini_auto` がONなら）Gemini解析→タスク登録→日次要約更新が走る。
詳細は [07-gemini-pipeline.md](07-gemini-pipeline.md)。

## 5. メトリクス `POST /api/client/metrics`

3秒ごと。ダッシュボードのPC選択画面の使用率表示と、**処理中ジョブのハートビート**を兼ねる。

```json
{
  "auth": { "email": "user@example.com", "token": "691ff8ca9ac063e6..." },
  "clientId": "41685d34-86c5-42be-a598-e4985d8d43f4",
  "cpu": 43.2,
  "mem": 61.5,
  "gpu": null,
  "activeJobId": 42
}
```

- `cpu`/`mem`/`gpu` … 0〜100 の使用率。GPUは nvidia-smi が無い環境（mac等）では `null`。
- `activeJobId` … いま処理中のジョブID（無ければ `null`）。
  これが `AUDIO_WORKER_STALE_MIN`（既定10分）以上途絶えると、サーバーはワーカー停止とみなして
  ジョブを queued に戻し**別のPCへ振り直す**。

レスポンス: `{ "ok": true }`

## エラーコード一覧

| HTTP | `code` | 意味 | クライアントの対応 |
| --- | --- | --- | --- |
| 401 | — | `auth` の email/token が不一致 | 再ログインが必要（UIで再登録） |
| 400 | — | `clientId` がUUID形式でない / `jobId` 不正 / `name` 空 | バグ。ログ確認 |
| 403 | `unregistered` | この clientId は未登録（またはダッシュボードからPC削除された） | `registered=false` にして次のポーリングで register からやり直す（自動） |
| 409 | `uuid_conflict` | UUIDが他アカウントで使用中（register時のみ） | UUIDを再生成して再登録（自動、最大3回） |
| 404 | — | download/result: 自分がclaimしたジョブではない | 再キュー済みとみなして諦める |
| 429 | — | レートリミット | Retry-After 秒待つ |

## なりすまし・取違を防ぐ仕組み

音声データが第三者に渡らないこと・結果が他ユーザーに混ざらないことは、
`db.getClaimedAudioJob()`（`server/db.js`）の1本のクエリで担保している:

```sql
SELECT j.*
FROM audio_jobs j
JOIN audio_workers w ON w.id = j.claimed_by
WHERE j.id = ?              -- 要求されたジョブ
  AND j.status = 'processing'
  AND j.claimed_by = ?       -- claim したのがこのワーカー（clientIdから解決したID）
  AND w.email = ?            -- そのワーカーの所有者が認証アカウント本人
```

つまり download / result が通る条件は:

1. `auth` が正しい（トークン一致）
2. `clientId` が**そのアカウントの登録済みワーカー**である（`getAudioWorkerByUuid` は email と UUID の両一致のみ返す）
3. 要求したジョブを **その clientId のワーカー自身が claim している**

このため以下はすべて拒否される（E2Eテストで確認済み）:

| 攻撃パターン | 結果 |
| --- | --- |
| 他人が claim したジョブの jobId を自分の clientId で要求 | 404（claimed_by 不一致） |
| 他人の clientId を名乗る（トークンは自分の） | 403 `unregistered`（email+UUIDの組が存在しない） |
| 未登録のでたらめUUID | 403 `unregistered` |
| 他人のUUIDを register で乗っ取る | 409 `uuid_conflict` |
| 再キュー後に元のPCが遅れて結果送信 | 404（claimed_by が新PCに変わっている＝二重保存防止） |

補足:

- global モードで他ユーザーのジョブを処理している場合も、条件3の「claim したワーカーの所有者＝認証アカウント」で
  認可される（ジョブ所有者のトークンは不要。ジョブ所有者側はダッシュボードのオプトインで許可済み）。
- IPアドレスは登録時に記録するだけで、**識別には一切使わない**（NAT配下の別PC誤併合・IP偽装を排除）。
- 旧クライアント（ヘッダー方式）はサーバーに接続できない。`git pull` してクライアント登録が必要。
