# データベーススキーマ

MySQL（DB名は既定 `aihelper`、`DB_NAME` で変更可）。
テーブルは `server/db.js` の `ensureSchema()` がサーバー起動時に自動作成する
（`CREATE TABLE IF NOT EXISTS` + 後付けカラムの `addColumnIfMissing`）。**手動マイグレーション不要**。

## テーブル相関の概観

```
users ─────────────┐ (email が全テーブルの外部キー相当。FK制約は張っていない)
                   │
audio_jobs ──claimed_by──→ audio_workers ←──worker_id── audio_worker_prefs
     │
     └─transcript_id──→ transcripts ──source_id←── tasks ──task_id←── notifications
                                                daily_summaries / chat_messages / ...
```

## users — 自己登録ユーザー

| カラム | 型 | 意味 |
| --- | --- | --- |
| `email` | VARCHAR(255) UNIQUE | ログインID。**全テーブルの紐付けキー** |
| `salt` / `password_hash` | | scrypt形式 `scrypt$N$r$p$salt$hash`（旧sha256はログイン成功時に自動移行） |
| `token` | CHAR(48) | APIトークン（`crypto.randomBytes(24).hex`） |
| `moodle_ical_url` | VARCHAR(1024) | Moodleカレンダーの書き出しURL |
| `gemini_api_key_enc` | VARCHAR(1024) | ユーザー登録のGemini APIキー（AES-256-GCM暗号化。`cred.js`） |
| `gemini_auto` | TINYINT(1) 既定1 | **自動解析のon/off**。0なら「解析する」ボタンでのみ解析 |
| `stt_quality` | VARCHAR(16) 既定'high' | 音声認識クオリティ（light/standard/high）。claim時にワーカーへ渡る |
| `google_email` | | 端末でサインインしたGoogleメール |
| `waseda_user` / `waseda_password_enc` | | Waseda連携（パスワードは暗号化） |

## audio_jobs — 音声文字起こしジョブ

| カラム | 型 | 意味 |
| --- | --- | --- |
| `email` | | ジョブ所有者（音声をアップロードしたユーザー） |
| `filename` | | 元のWAVファイル名（サニタイズ済み） |
| `stored_path` | VARCHAR(1024) | サーバー上の保存パス（`uploads/audio/`）。**処理完了で物理削除** |
| `mime` / `size_bytes` | | |
| `status` | VARCHAR(16) | `queued` → `processing` → `done` / `error` |
| `error` | TEXT | 失敗理由（ワーカーからの報告、最大1000文字） |
| `transcript_id` | INT | 完了時に紐付く transcripts.id |
| `claimed_by` | INT | **claimしたワーカー（audio_workers.id）**。取違防止の照合キー。再キューでNULLに戻る |
| `updated_at` | | ハートビート（touchAudioJob）で進む。`AUDIO_WORKER_STALE_MIN` 分止まると再キュー対象 |

claim は `UPDATE ... SET id=LAST_INSERT_ID(id), status='processing', claimed_by=? WHERE status='queued' ... ORDER BY id ASC LIMIT 1`
の1文で行うため、複数ワーカーが同時に来ても同じジョブは二重に渡らない。

## audio_workers — ワーカーPC（クライアント）

| カラム | 型 | 意味 |
| --- | --- | --- |
| `id` | INT AUTO_INCREMENT | 内部ID（claimed_by 等の参照用） |
| `email` | | このPCを登録したアカウント（所有者） |
| `client_uuid` | CHAR(36) **UNIQUE** | **クライアントが生成したUUID**。全体で一意。他アカウントの登録は409で拒否 |
| `name` | VARCHAR(255) | ユーザーが決めた表示名 |
| `ip` | VARCHAR(64) | 登録時の接続元IP（表示用のみ。**識別には使わない**） |
| `allowed` | TINYINT(1) 既定1 | 所有者がこのPCに処理させるか（ダッシュボードのチェックボックス） |
| `mode` | VARCHAR(16) 既定'private' | `private` / `global` |
| `cpu_pct` / `mem_pct` / `gpu_pct` / `metrics_at` | | 3秒ごとのメトリクス（PC選択画面の表示用） |
| `last_seen_at` | | 最終接続。60秒以内なら「接続中」表示 |

## audio_worker_prefs — 他人のglobal PCを使うかのオプトイン

| カラム | 意味 |
| --- | --- |
| `email` + `worker_id` (PK) | 「このユーザーが、このglobal PCに」 |
| `allowed` | 1=自分のジョブを任せる。**行が無い=任せない**（既定でオプトアウト） |

## transcripts — 文字起こし本文と解析結果

| カラム | 意味 |
| --- | --- |
| `email` + `filename` (UNIQUE) | 1ファイル=1行。`yyyy-MM-dd_HH.txt` が基本形 |
| `content` | LONGTEXT 本文。`/api/upload` は上書き、音声ジョブ経由は**追記**（`appendTranscript`） |
| `kadai_json` / `yotei_json` | Gemini抽出の生JSON（CSVダウンロードの元データ） |
| `summary` | 短い要約 |
| `analyzed_at` | 解析済みか（NULL=未解析）。再アップロード/追記でNULLに戻る |

## tasks — 課題・予定（リマインドの単位）

| カラム | 意味 |
| --- | --- |
| `type` | `kadai`（課題）/ `yotei`（予定） |
| `content` / `details` | 内容・詳細 |
| `deadline_at` | 締切。日付のみの指示は `23:59:00` を補完し `date_only=1` |
| `status` | `pending` / `done` |
| `source_id` | 抽出元の transcripts.id（手動追加はNULL） |
| `dedup_key` | sha1(email\|type\|content\|deadline)。`(email, dedup_key)` UNIQUE で重複登録を防ぐ |
| `notified_1d` / `notified_1h` | リマインド送信済みフラグ（二重送信防止）。締切変更でリセット |

## その他のテーブル

| テーブル | 役割 |
| --- | --- |
| `daily_summaries` | 日次要約（email × day UNIQUE） |
| `notifications` | 送信済みリマインドの記録。`acked=0` をアプリがローカル通知として取得 |
| `chat_messages` | AIチャットの会話履歴（文脈維持用、直近をプロンプトに注入） |
| `documents` | PDF/TXT資料のGemini要約（本文は保存しない） |
| `courses` | 履修時間割（曜日×時限×科目×教室）。Waseda/Moodle取り込み or 手動編集 |
| `google_accounts` | Web OAuthで連携したGoogleアカウント（refresh_tokenは暗号化） |
| `calendar_events` | スマホから同期されたローカルカレンダー予定（全置き換え方式） |

## 暗号化について

`waseda_password_enc` / `gemini_api_key_enc` / `google_accounts.refresh_token` は
`server/cred.js` の AES-256-GCM（`iv:tag:cipher` hex形式）で暗号化して保存。
鍵は環境変数 `CRED_ENC_KEY`（64桁hex）か、無ければ初回起動時に `server/.cred-key` に自動生成。
鍵ローテーションは `node server/rotate-cred-key.js`（全暗号化カラムを再暗号化する）。
