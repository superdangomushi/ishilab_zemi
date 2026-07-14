# ダッシュボード（Web UI）ガイド

`GET /` が返す1枚のHTML。**コードはすべて `server/server.js` の `renderDashboard()`**
（約2128行目〜末尾）にテンプレート文字列で埋め込まれている。ビルド工程はない。
UIを直したいときはこの関数内のHTML/CSS/JSを編集してサーバーを再起動するだけ。

## 画面構成

- **ログイン画面** — ログイン / 新規登録（`/api/login` / `/api/register`）。
  成功すると `localStorage.mb_auth` に `{email, token}` を保存し、以後のfetchは
  `headers()` 関数がヘッダー認証を付ける。
- **タブ**: チャット / 予定・課題 / カレンダー / 今日の要約 / ファイル / アカウント。
  選択中タブは `localStorage.mb_tab` に記憶。15秒ごとに表示中タブを自動更新
  （入力中・非表示タブ中はスキップ）。

## タブごとの機能と対応コード

JS関数はすべて `renderDashboard()` 内の `<script>` にある。

### チャット

| 機能 | 関数 | API |
| --- | --- | --- |
| 質問送信・操作実行の表示 | `ask()` | `POST /api/ask` |
| 履歴復元 | `loadChatHistory()` | `GET /api/chat/history` |

実行された操作（`applied`）は「✓ 登録: 課題「…」」のように吹き出しで明示される。

### 予定・課題

| 機能 | 関数 |
| --- | --- |
| 一覧取得 | `loadTasks()`（`GET /api/tasks?done=1`） |
| 絞り込み（状態/種別/期間/キーワード）+ ソート | `renderTasks()`（クライアント側でフィルタ） |
| 完了切替 / 削除 / 手動追加 | `toggle()` / `delTask()` / `addTask()` |
| Googleカレンダー登録ボタン | `addToCalendar()`（連携済みのときだけ表示） |

### カレンダー

月表示グリッド。タスク・Google/スマホ予定・時間割（学期の曜日×時限から展開）をドット表示し、
日を選ぶとその日の予定一覧+日次要約を出す。`renderCalendar()` / `courseOccursOn()` など。

### 今日の要約

`loadSummary()`（`GET /api/summary/today`）と `genSummary()`（`POST /api/summary/today/generate`）。

### ファイル ★2026-07-13 に刷新

上から順に:

1. **資料の要約（PDF/TXT）** — `uploadDoc()` / `loadDocs()`（`/api/files`）
2. **処理に使うPC（クライアント）** — `loadAudioWorkers()`（`GET /api/audio/workers`）。
   表示中は3秒ごとに再取得。チェックボックス=`allowed`（`setWorkerAllowed()`）、
   名前変更（`renameWorker()`）、削除（`deleteWorker()`）。
   他ユーザー提供のglobal PCは初期チェック無し（オプトイン）。
   CPU/メモリ/GPUのメーターは `meterCell()`（15秒より古いメトリクスは「—」）。
3. **未完了の音声（処理中・待機中・失敗）** — `loadAudioJobs()`（`GET /api/audio/jobs?active=1&limit=100`）。
   processing=処理中 / queued=待機中 / error=失敗 を**状態別の `<details>` 折りたたみ**で表示
   （見出しに件数。開閉状態は `audioJobsOpen` に覚えて15秒ごとの自動更新でも維持。
   失敗は件数が嵩みやすいので初期状態では畳んである）。**完了した音声は出ない**
   （完了分は下の履歴に文字起こしとして現れる）。未完了がある間は15秒ごとに自動更新。
   失敗ジョブの行には**「再試行」ボタン**（`retryAudioJob()` → `POST /api/audio/jobs/:id/retry`）。
   2回目以降の試行は「N回目」と表示される（自動再試行の仕組みは docs/06 参照）。
4. **文字起こしの履歴** — 一覧は `loadTranscripts()` → `renderTranscripts()`。
   - ファイル名絞り込み（`#trName`、入力のたび）
   - 解析済み/未解析フィルタ（`#trFilter`）
   - ソート6種（`#trSort`: 更新新旧・ファイル名新旧・文字数多少）
   - **本文検索**（`#trContains` + `searchTranscripts()`）:
     `GET /api/transcripts?contains=語` でサーバー側の全文検索。「解除」で通常一覧へ
   - 各行: 本文（モーダル `viewText()`）/ DL / 課題CSV / 予定CSV /
     **「解析する」ボタン**（`analyzeTranscript()` → `POST /api/transcripts/:id/analyze`。
     解析済みの行では「再解析」表示）

### アカウント

| 機能 | 関数 | API |
| --- | --- | --- |
| Gemini APIキー登録/削除 | `saveGeminiKey()` / `deleteGeminiKey()` | `/api/gemini-key` |
| **自動解析のon/offトグル** ★ | `loadGeminiAuto()` / `saveGeminiAuto()` | `/api/gemini-auto` |
| パスワード変更 | `changePassword()` | `/api/change-password` |
| Moodle連携（iCal URL） | `saveMoodle()` / `syncMoodle()` | `/api/moodle`, `/api/moodle/sync` |
| Waseda連携（時間割取り込み+進捗バー） | `saveWaseda()` / `syncWaseda()` / `pollWasedaSync()` | `/api/waseda*` |
| Googleカレンダー連携（複数可） | `connectGoogle()` / `unlinkGoogle()` | `/api/google/*` |

## 実装上の注意（UIをいじる人向け）

- テンプレート文字列内なので、JS中のバッククォート・`${}`・`\` はエスケープが必要
  （既存コードは `\\'` や `\\n` を多用している）。編集後は
  `node --check server/server.js` と、ブラウザで実際に開いての確認を必ずやる。
- ユーザー由来の文字列は必ず `escapeHtml()` を通す（XSS防止）。
- 自動更新は `refreshCurrentTab()` に一元化されている。新しいタブ/セクションを足すときは
  ここと `loadAll()` に読み込み関数を追加する。
- ワーカー一覧（3秒）と音声ジョブ（15秒）は独自タイマー
  （`audioWorkersTimer` / `audioJobsTimer`）を持ち、タブ切替時に `stopAutoRefresh()` で止まる。

## ワーカーPC側のローカル管理UI

ダッシュボードとは別に、ワーカーPC上にも管理UI（http://127.0.0.1:39123）がある。
こちらのコードは `client/audio-worker.js` の `htmlPage()`。詳細は
[03-client-code-map.md](03-client-code-map.md) の「ローカル管理UI」を参照。
