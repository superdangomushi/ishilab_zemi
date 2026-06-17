# moneybot.jp 受信サーバー (Node.js + Express + MySQL)

文字起こしアプリから送られてくるテキストを受け取り、**MySQL に直接保存**する簡易サーバー。
Web サイトにアクセスすると保存済みファイルを一覧・ダウンロードできる。

アップロード時に **Gemini** で本文を解析し、「課題」と「予定」を抽出する。それぞれ
`期限,内容,詳細` の **CSV** として Web からダウンロードできる。

## セットアップ

```bash
cd server
npm install

# DB を用意（schema.sql で moneybot データベースと transcripts テーブルを作成）
mysql -u root < schema.sql

# 起動
npm start          # http://localhost:3000
```

接続情報は環境変数で渡す（デフォルトは下表）。

| 変数 | デフォルト | 説明 |
| --- | --- | --- |
| `DB_HOST` | `localhost` | MySQL ホスト |
| `DB_PORT` | `3306` | ポート |
| `DB_USER` | `root` | ユーザー |
| `DB_PASSWORD` | （空） | パスワード |
| `DB_NAME` | `moneybot` | データベース名 |
| `PORT` | `3000` | サーバーの待受ポート |
| `GEMINI_API_KEY` | （空） | Gemini の API キー。未設定なら課題/予定の解析はスキップ |
| `GEMINI_MODEL` | `gemini-2.5-flash` | 使用する Gemini モデル |

```bash
DB_USER=root DB_PASSWORD=secret PORT=8080 npm start

# Gemini 解析を有効にする場合（キーは Google AI Studio で発行）
GEMINI_API_KEY=xxxxxxxx npm start
```

テーブルは起動時に `CREATE TABLE IF NOT EXISTS` で自動作成する（DB 自体は事前に作成が必要）。

## 保存先

ファイルはファイルシステムではなく `transcripts` テーブルに 1 行ずつ保存する。
`(email, filename)` がユニークキーで、同じアカウントの同じファイル名は**上書き**される
（毎時ファイルを追記して再送するケースに対応）。

| カラム | 内容 |
| --- | --- |
| `email` | 送信したアカウント |
| `filename` | ファイル名（例 `2026-06-14_15.txt`） |
| `content` | テキスト本文（LONGTEXT） |
| `kadai_json` / `yotei_json` | Gemini が抽出した課題・予定（JSON 配列） |
| `analyzed_at` | 解析した時刻（未解析なら NULL） |
| `created_at` / `updated_at` | 作成・更新時刻 |

`kadai_json` / `yotei_json` の各要素は `{ deadline, content, details }`（= 期限/内容/詳細）。
本文を上書き再送すると解析結果はクリアされ、再度 Gemini にかけ直される。

## 課題・予定の抽出（Gemini）

`GEMINI_API_KEY` を設定して起動すると、`/api/upload` で本文を保存した直後に Gemini が
本文を解析し「課題」「予定」を抽出する。解析に失敗してもアップロード自体は成功扱いに
する（本文は保存される。レスポンスの `analyzed` が `false` になる）。

一覧ページの「課題/予定」列、または以下のエンドポイントから CSV を取得できる。
CSV は `期限,内容,詳細` のヘッダ付き・UTF-8 BOM 付き（Excel でそのまま開ける）。

## アカウント登録

`accounts.json` に「アカウント情報（email）」と「事前に作っておくトークン」を書く。
アプリ側でログインしたアカウント情報がここと一致したときだけ受け付ける。

```json
[
  { "email": "demo@moneybot.jp", "token": "demo-token-1234567890" }
]
```

## API / ページ

| メソッド | パス | 用途 |
| --- | --- | --- |
| POST | `/api/login` | アカウント情報＋トークンの照合（アプリのログイン） |
| POST | `/api/upload` | 文字起こしテキストの受信 → MySQL 保存 |
| GET | `/` | 保存済みファイルの一覧ページ（ダウンロードリンク付き） |
| GET | `/download/:id` | ファイルを `.txt` としてダウンロード |
| GET | `/kadai/:id.csv` | 抽出した**課題**を CSV（`期限,内容,詳細`）でダウンロード |
| GET | `/yotei/:id.csv` | 抽出した**予定**を CSV（`期限,内容,詳細`）でダウンロード |

### POST /api/upload
```
Authorization: Bearer demo-token-1234567890
X-Account-Email: demo@moneybot.jp
X-Filename: 2026-06-14_15.txt
Content-Type: text/plain

（本文 = テキストファイルの中身）
```

## 動作確認 (curl)

```bash
# 送信
curl -X POST http://localhost:3000/api/upload \
  -H 'Authorization: Bearer demo-token-1234567890' \
  -H 'X-Account-Email: demo@moneybot.jp' \
  -H 'X-Filename: test.txt' \
  -H 'Content-Type: text/plain' \
  --data-binary 'これはテスト文字起こしです'

# ブラウザで http://localhost:3000/ を開くと一覧＋ダウンロードができる
```
