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

-- Web から自己登録したユーザー。パスワードは sha256(salt + password) で保存（平文は持たない）。
CREATE TABLE IF NOT EXISTS users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  email         VARCHAR(255) NOT NULL,
  salt          CHAR(32)     NOT NULL,
  password_hash CHAR(64)     NOT NULL,
  token         CHAR(48)     NOT NULL,
  moodle_ical_url VARCHAR(1024) NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_email (email),
  KEY idx_users_token (token)
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
