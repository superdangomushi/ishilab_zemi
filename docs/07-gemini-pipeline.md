# Gemini 解析パイプライン

文字起こしテキストから課題・予定・要約を取り出し、タスクとして正規化するまでの流れ。

## 前提: APIキーはユーザーごと

サーバー共通の `GEMINI_API_KEY` は**廃止済み**。各ユーザーが
[Google AI Studio](https://aistudio.google.com/apikey) で発行したキーをダッシュボードの
「アカウント」タブから登録する（`POST /api/gemini-key`。登録時に疎通確認あり）。
キーは暗号化して `users.gemini_api_key_enc` に保存され、`gemini.js` の全関数は
**email を第一引数**に取り、そのユーザーのキーでAPIを呼ぶ。

キー未登録のユーザーは AI機能（解析・要約・チャット・資料要約）が使えないが、
**音声の文字起こし自体はキー無しでも動く**（解析だけスキップ）。

## 自動解析の on/off（`users.gemini_auto`）

| 設定 | 挙動 |
| --- | --- |
| ON（既定） | 文字起こしが保存されるたびに自動で解析パイプラインが走る（従来どおり） |
| OFF | 自動では**一切解析しない**。ダッシュボード「ファイル」タブの各ファイルの「解析する」ボタン（`POST /api/transcripts/:id/analyze`）を押したときだけ実行 |

- 設定API: `GET/POST /api/gemini-auto`（[05-api-reference.md](05-api-reference.md)）
- UI: ダッシュボード「アカウント」タブのチェックボックス
- OFF の場合、音声ジョブ完了後の**日次要約の自動更新もスキップ**される
  （「今日の要約」タブの「今すぐ生成し直す」ボタンでは従来どおり生成できる）

## 解析パイプラインの中身

入口は3つあるが、中身は同じ:

| 入口 | 場所 | 実行条件 |
| --- | --- | --- |
| 音声ジョブ完了時 | `server/audio.js finishJobWithText()` | gemini_auto=ON かつ キー登録済み |
| テキストアップロード時 | `server/server.js POST /api/upload` → `runAnalysisPipeline()` | 同上 |
| 手動「解析する」ボタン | `server/server.js POST /api/transcripts/:id/analyze` → `runAnalysisPipeline()` | キー登録済み（gemini_autoは無関係） |

処理内容（`runAnalysisPipeline(email, transcriptId, content)`）:

```
gemini.analyze(email, 本文)
  │  Gemini に構造化出力(responseSchema)で依頼し、以下を得る:
  │  { kadai: [...], yotei: [...], summary: "...",
  │    tasks: [...], updates: [...], cancellations: [...] }
  │
  ├→ db.saveAnalysis()      … kadai_json / yotei_json / summary を transcripts に保存
  ├→ db.upsertTasks()       … 抽出タスクを登録（dedup_keyで重複防止、既存は詳細だけ更新）
  ├→ db.applyTaskUpdates()  … 「〇〇を15時に変更」等の変更指示を既存タスクへ反映
  └→ db.cancelTasks()       … 「やっぱり△△キャンセル」等で一致タスクを削除
```

`updates` / `cancellations` のターゲット解決は content/details の LIKE 部分一致 +
締切日の近さでランク付けし、cancel は最大5件・update は最上位1件だけ操作する（誤爆防止）。

## 日次要約（daily_summaries）

- 生成: `reminders.generateDailySummary(email, day)` → `gemini.summarizeDay()`。
  その日の transcripts（ファイル名 `YYYY-MM-DD_*` か updated_at 一致）を材料にする。
- 自動更新のタイミング:
  1. 音声ジョブ完了後（gemini_auto=ON のときのみ）
  2. `DAILY_SUMMARY_INTERVAL_MIN`（既定300分）ごとの定期再生成
  3. 毎日 `DAILY_SUMMARY_TIME`（既定21:00）の15分前の事前生成 → 21:00にLINE送信（`summary.js`）
- 手動: `POST /api/summary/today/generate`

## AIチャット（/api/ask）が受け取る文脈

`server.js` の `/api/ask` はGemini呼び出し前に以下を集めてプロンプトに詰める:

| 文脈 | 出どころ |
| --- | --- |
| タスク一覧（完了含む100件） | `tasks` |
| 直近の日次要約5件 | `daily_summaries` |
| 履修時間割 | `courses` |
| カレンダー予定 | リクエストの `calendar` + Google連携 + スマホ同期分をマージ |
| 資料要約20件 | `documents` |
| 質問キーワードに一致する文字起こし抜粋 | `searchTranscriptSnippets`（前後400文字） |
| 「今日/7月1日の授業」等、日付特定質問ならその日の全文 | `getTranscriptsForDay` |
| 会話履歴20件 | `chat_messages` |
| ファイルの時間インデックス | `listTranscriptIndex` + 時間割から「水 統計学」のようなラベル付け |

Gemini は `needFiles`（読みたいファイル名）を返せる。その場合サーバーは実在する本人の
ファイルだけ本文を取得して**2回目の呼び出し**で回答させる（トークン節約の2段階方式）。
返ってきた `actions`（add_task 等）はサーバーが実行し、`applied` としてクライアントに返す。

## モデルとエラー処理

- モデル: `gemini.MODEL`（現在 `gemini-2.5-flash-lite`。`gemini.js` 冒頭で定義）
- 構造化出力: `callJson()` が responseSchema 付きで呼び、JSONで受ける
- 登録済みキーが失効した場合（Google側で削除等）は `handleBadGeminiKey()` が
  「登録し直してください」という導線付き400を返す
- 解析の失敗は文字起こし保存自体には影響しない（ログに残して続行）
