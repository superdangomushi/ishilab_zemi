-- moneybot 受信サーバー用のスキーマ
-- 文字起こしテキストを 1 ファイル = 1 行として直接 MySQL に保存する。

CREATE DATABASE IF NOT EXISTS moneybot
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE moneybot;

CREATE TABLE IF NOT EXISTS transcripts (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  email       VARCHAR(255) NOT NULL,
  filename    VARCHAR(255) NOT NULL,
  content     LONGTEXT     NOT NULL,
  -- Gemini が抽出した課題・予定（{ deadline, content, details } の JSON 配列）
  kadai_json  LONGTEXT     NULL,
  yotei_json  LONGTEXT     NULL,
  analyzed_at DATETIME     NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- 同じアカウントの同じファイル名は上書き（毎時ファイルの追記再送に対応）
  UNIQUE KEY uq_email_filename (email, filename)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
