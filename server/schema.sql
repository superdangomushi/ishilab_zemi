-- aihelper 受信サーバー用のスキーマ
-- 文字起こしテキストを保存し、Gemini で抽出した課題・予定や日次要約も保存する。

CREATE DATABASE IF NOT EXISTS aihelper
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE aihelper;

-- 端末から送られてくる文字起こしテキスト（1ファイル = 1行）。
CREATE TABLE IF NOT EXISTS transcripts (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  email       VARCHAR(255) NOT NULL,
  filename    VARCHAR(255) NOT NULL,
  content     LONGTEXT     NOT NULL,
  -- Gemini が抽出した課題・予定（{ deadline, content, details } の JSON 配列）。
  -- 後方互換のために残しているが、正規化済みデータは tasks テーブルを参照する。
  kadai_json  LONGTEXT     NULL,
  yotei_json  LONGTEXT     NULL,
  -- このアップロード分の短い要約（Gemini）。日次要約の材料になる。
  summary     TEXT         NULL,
  analyzed_at DATETIME     NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- 同じアカウントの同じファイル名は上書き（毎時ファイルの追記再送に対応）。
  UNIQUE KEY uq_email_filename (email, filename)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 抽出された課題・予定を1件1行で正規化して持つ。リマインドの単位。
CREATE TABLE IF NOT EXISTS tasks (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  email         VARCHAR(255) NOT NULL,
  -- 'kadai'(課題) | 'yotei'(予定)
  type          VARCHAR(16)  NOT NULL,
  content       VARCHAR(512) NOT NULL,
  details       TEXT         NULL,
  -- 締切/予定日時。時刻不明な日付のみの場合は既定時刻を補って格納する。
  deadline_at   DATETIME     NULL,
  -- 元が「日付のみ」だったか（UI 表示の出し分け用）。
  date_only     TINYINT(1)   NOT NULL DEFAULT 0,
  -- 'pending'(未完了) | 'done'(完了)
  status        VARCHAR(16)  NOT NULL DEFAULT 'pending',
  -- 抽出元の文字起こし（手動追加なら NULL）。
  source_id     INT          NULL,
  -- 同一内容の重複を防ぐためのキー（email + type + content + deadline のハッシュ）。
  dedup_key     CHAR(40)     NOT NULL,
  -- リマインド送信済みフラグ（冪等化）。
  notified_1d   TINYINT(1)   NOT NULL DEFAULT 0,
  notified_1h   TINYINT(1)   NOT NULL DEFAULT 0,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_dedup (email, dedup_key),
  KEY idx_email_deadline (email, deadline_at),
  KEY idx_status (status)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 日付ごとの「今日1日の要約」。
CREATE TABLE IF NOT EXISTS daily_summaries (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  email        VARCHAR(255) NOT NULL,
  day          DATE         NOT NULL,
  summary      LONGTEXT     NOT NULL,
  generated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_email_day (email, day)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- チャット（秘書）の会話履歴。同じアカウントでの継続的な文脈維持に使う。
CREATE TABLE IF NOT EXISTS chat_messages (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  email      VARCHAR(255) NOT NULL,
  -- 'user' | 'assistant'
  role       VARCHAR(16)  NOT NULL,
  content    TEXT         NOT NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_email_created (email, created_at)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Web から自己登録したユーザー。パスワードは scrypt で保存（平文は持たない）。
CREATE TABLE IF NOT EXISTS users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  email         VARCHAR(255) NOT NULL,
  salt          CHAR(32)     NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  token         CHAR(48)     NOT NULL,
  moodle_ical_url VARCHAR(1024) NULL,
  google_email  VARCHAR(255) NULL,
  -- Waseda アカウント（時間割スクレイパ用）。パスワードは AES-256-GCM 暗号化（iv:tag:cipher の hex）。
  waseda_user   VARCHAR(255) NULL,
  waseda_password_enc VARCHAR(1024) NULL,
  -- 音声認識クオリティ（light/standard/high）。将来プラン（課金）で制限する想定。今は自由選択。
  stt_quality   VARCHAR(16)  NOT NULL DEFAULT 'high',
  -- ユーザー自身が登録する Gemini API キー（AES-256-GCM 暗号化。iv:tag:cipher の hex）。
  -- サーバー共通の GEMINI_API_KEY(.env) は廃止し、AI機能はこのキーで動く。
  gemini_api_key_enc VARCHAR(1024) NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_email (email),
  KEY idx_users_token (token)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Web(OAuth) で連携した Google アカウント（1ユーザーに複数可）。
-- refresh_token は AES-256-GCM で暗号化した文字列（iv:tag:cipher の hex）。
CREATE TABLE IF NOT EXISTS google_accounts (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  email         VARCHAR(255) NOT NULL,
  google_email  VARCHAR(255) NOT NULL,
  refresh_token TEXT         NOT NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_user_google (email, google_email)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 履修時間割（科目登録から取得）。曜日×時限×科目名×教室。
CREATE TABLE IF NOT EXISTS courses (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  email      VARCHAR(255) NOT NULL,
  term       VARCHAR(32)  NULL,
  day        VARCHAR(8)   NULL,
  period     INT          NULL,
  name       VARCHAR(255) NOT NULL,
  room       VARCHAR(255) NULL,
  start_time VARCHAR(8)   NULL,
  end_time   VARCHAR(8)   NULL,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_courses_email (email)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 資料ファイル（PDF/TXT等）の AI 要約。
CREATE TABLE IF NOT EXISTS documents (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  email       VARCHAR(255) NOT NULL,
  name        VARCHAR(512) NOT NULL,
  mime        VARCHAR(128) NULL,
  summary     LONGTEXT     NOT NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_doc (email, name)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 端末からアップロードされた音声を外部PCワーカーへ渡すジョブ。
-- status: 'queued'(待機) → 'processing'(処理中) → 'done'(完了) | 'error'(失敗)
-- 処理に失敗しても attempts が上限（AUDIO_MAX_ATTEMPTS、既定3回）未満なら
-- 自動で queued に戻して別のPCへ再割り振りする。上限に達したら error で保留し、
-- 音声ファイルは done になるまで削除しない（error でも残り、手動再試行できる）。
CREATE TABLE IF NOT EXISTS audio_jobs (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  email         VARCHAR(255) NOT NULL,
  filename      VARCHAR(255) NOT NULL,
  stored_path   VARCHAR(1024) NOT NULL,
  mime          VARCHAR(128) NULL,
  size_bytes    BIGINT       NOT NULL DEFAULT 0,
  status        VARCHAR(16)  NOT NULL DEFAULT 'queued',
  error         TEXT         NULL,
  -- 文字起こし完了後に作られた transcripts 行への参照。
  transcript_id INT          NULL,
  -- ジョブを確保したワーカーPC（audio_workers.id）。二重処理防止と処理元表示用。
  claimed_by    INT          NULL,
  -- 処理を試みた回数（claim のたびに +1）。失敗時の自動再試行の上限判定に使う。
  attempts      INT          NOT NULL DEFAULT 0,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_audio_email (email, created_at),
  KEY idx_audio_status (status)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 音声ジョブを処理するワーカーPC（クライアント）。IDはサーバーが自動採番し、
-- ユーザーはダッシュボードでどのPCに処理させるか（allowed）を複数選択できる。
-- IDを送らない旧クライアントは接続元IP＋アカウントで同一PCとみなして再利用する。
CREATE TABLE IF NOT EXISTS audio_workers (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  email        VARCHAR(255) NOT NULL,
  ip           VARCHAR(64)  NULL,
  name         VARCHAR(255) NOT NULL,
  allowed      TINYINT(1)   NOT NULL DEFAULT 1,
  -- 公開範囲。private=クライアントでログインしたアカウントのジョブのみ、
  -- global=全ユーザーのジョブを処理できる（クライアントUIで選択）。
  mode         VARCHAR(16)  NOT NULL DEFAULT 'private',
  -- クライアントが3秒ごとに報告するリソース使用率（PC選択画面の表示用）。
  cpu_pct      FLOAT        NULL,
  mem_pct      FLOAT        NULL,
  gpu_pct      FLOAT        NULL,
  metrics_at   DATETIME     NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_workers_email (email)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- globalワーカーPCに対する各ユーザーの利用可否（行が無ければ利用する扱い）。
-- audio_workers.allowed は所有者自身の稼働設定なので、他ユーザー分はここで持つ。
CREATE TABLE IF NOT EXISTS audio_worker_prefs (
  email      VARCHAR(255) NOT NULL,
  worker_id  INT          NOT NULL,
  allowed    TINYINT(1)   NOT NULL DEFAULT 1,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (email, worker_id)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 送信済みリマインド通知の記録（履歴・二重送信防止の補助）。
CREATE TABLE IF NOT EXISTS notifications (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  email      VARCHAR(255) NOT NULL,
  task_id    INT          NULL,
  -- 'remind_1d' | 'remind_1h' など
  kind       VARCHAR(32)  NOT NULL,
  channel    VARCHAR(16)  NOT NULL DEFAULT 'line',
  message    TEXT         NOT NULL,
  -- 端末アプリが取得済みにしたか（ローカル通知表示済みフラグ）。
  acked      TINYINT(1)   NOT NULL DEFAULT 0,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_email_created (email, created_at)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
