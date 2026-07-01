# ishilab_zemi 

研究室のゼミ課題(みんな見てね！！)

---

## できること（全体像）

| 機能 | 説明 | 担当 |
| --- | --- | --- |
| 🎙️ 常時録音＋ローカル文字起こし | バックグラウンドで録音し whisper.cpp でオフライン文字起こし。1時間=1ファイル | Android |
| ☁️ 定期アップロード | 文字起こしファイルを一定間隔で自動送信（手動送信も可） | Android → サーバー |
| 🧠 課題・予定の自動抽出 | Gemini が本文から「課題」「予定」を締切付きで構造化 | サーバー |
| ⏰ 締切リマインド | 締切の **1日前 / 1時間前** に自動でお知らせ（冪等＝二重送信しない） | サーバー |
| 💚 LINE 警告 | リマインドを LINE Messaging API で push 通知 | サーバー → LINE |
| 🔔 端末ローカル通知 | LINE 未連携でも、アプリが未読リマインドを取得して端末通知 | Android |
| 📅 日次要約 | その日の文字起こしから「今日何があったか」を日付ごとに要約 | サーバー |
| 💬 秘書チャット | 「今日の課題は？」に回答。「予定入れといて」「これ宿題らしい」で登録、「〇〇終わった」で完了化 | サーバー(Gemini) ＋ アプリ/Web |
| 🖥️ ダッシュボード | 締切カウントダウン・今日の要約・タスク管理・チャットを Web で操作 | サーバー(Web) |

構成は **Android アプリ（録音・文字起こし・通知）** と
**サーバー兼ウェブアプリ（保存・解析・リマインド・LINE・秘書・ダッシュボード）** の2本立てです。

```
[スマホ] 常時録音 → ローカル文字起こし → 定期アップロード
                                   │
                                   ▼
[サーバー] 保存 → Gemini抽出(課題/予定/要約) → tasksに正規化
                                   │
        ┌──────────────┼─────────────────┐
        ▼              ▼                 ▼
   締切リマインド    日次要約         秘書チャット
   (1日前/1時間前)   (日付ごと)      (質問応答＋操作)
        │
   ┌────┴────┐
   ▼         ▼
 LINE警告   端末ローカル通知
```

---

## Android アプリ（録音・文字起こし・通知）

バックグラウンドで常時録音し、端末上（ローカル / whisper.cpp）で文字起こしを続け、
**1時間ごとに1つのテキストファイル**として出力する。通知バーから一時停止/再開できる。
ログインしていれば、ファイルを**定期的に自動アップロード**し、サーバーからの**リマインドを
端末通知**として表示する。アプリ内の**秘書チャット**から質問・依頼もできる。

### 仕組み（概要）
- **AudioCaptureService**（フォアグラウンドサービス, type=microphone）が常時録音
  - 16kHz/mono PCM を 30 秒チャンクに分割 → whisper.cpp で逐次文字起こし
  - 結果は `filesDir/transcripts/YYYY-MM-DD_HH.txt` に追記（= 1時間1ファイル）
  - 文字起こし済みの音声データは破棄（テキストのみ保存）
  - 簡易VADでほぼ無音のチャンクはスキップし負荷を軽減
  - 画面OFFでも継続するため PARTIAL_WAKE_LOCK を保持
- **BackgroundSync**（サービスと一緒に起動）
  - ログイン済みのとき、更新されたファイルを一定間隔で `POST /api/upload`
  - `GET /api/reminders` で未読リマインドを取得し**ローカル通知**（チャンネル「締切・予定リマインド」）
  - 表示したら `POST /api/reminders/ack` で既読化
- **秘書チャット**: アプリ画面から `POST /api/ask`。回答表示と、依頼の実行（予定追加など）
- **通知**: [一時停止/再開]（マイクを完全解放/再取得）・[終了]、加えてリマインド通知
- **モデル**: 初回起動時に ggml モデル(tiny/base/small)をダウンロード。以降はオフライン動作
- whisper.cpp は git submodule（`app/src/main/cpp/whisper.cpp`, v1.7.4）として取り込み、
  NDK/CMake でビルドして単一の `libwhisper-jni.so` にまとめる

### 主要ファイル
| 役割 | パス |
| --- | --- |
| 録音/文字起こしサービス | `app/.../service/AudioCaptureService.kt` |
| 通知制御の受信 | `app/.../service/MicControlReceiver.kt` |
| チャンク化・簡易VAD | `app/.../audio/AudioChunker.kt` |
| whisper エンジン / 抽象 | `app/.../transcribe/WhisperEngine.kt`, `TranscriptionEngine.kt` |
| 出力ファイル管理 | `app/.../transcribe/TranscriptStore.kt` |
| モデルDL管理 | `app/.../model/ModelManager.kt` |
| 送信クライアント（upload/ask/reminders） | `app/.../net/MoneybotClient.kt` |
| 定期アップロード＋リマインド通知 | `app/.../net/BackgroundSync.kt` |
| ログイン情報の保存 | `app/.../net/AccountStore.kt` |
| 画面（秘書チャット含む） | `app/.../MainActivity.kt`, `app/.../ui/MainViewModel.kt` |
| JNI ブリッジ | `app/.../whisper/WhisperLib.kt`, `app/src/main/cpp/{jni.c,CMakeLists.txt}` |

### ビルド手順
NDK 27 / CMake 3.22 / JDK 17 が必要。
```bash
# submodule（whisper.cpp 本体）を取得
git submodule update --init --recursive

# JDK 17 を指定してビルド
export JAVA_HOME=$(/usr/libexec/java_home -v 17)
./gradlew :app:assembleDebug
# 生成物: app/build/outputs/apk/debug/app-debug.apk
```

### 使い方
1. アプリ起動 → マイク/通知の権限を許可
2. 初回はモデルをダウンロード（日本語は base 以上を推奨）
3. 「moneybot.jp 連携」でサーバーURL・アカウント・トークンを入力しログイン
4. 「録音開始」→ 通知が常駐し、文字起こしが `transcripts/` に蓄積され、定期的に自動送信される
5. 締切が近づくとリマインド通知が届く。「秘書に聞く / 頼む」から質問・依頼もできる
6. マイクを一時的に手放したいときは通知の「一時停止」、戻すときは「再開」

---

## サーバー兼ウェブアプリ（保存・解析・リマインド・LINE・秘書）

`server/`（Node.js + Express + MySQL）。受け取ったテキストを MySQL に保存し、
Gemini で課題・予定・要約を抽出、締切前に LINE / 端末通知でリマインドする。
ブラウザ（`/`）からは締切・要約・タスク・秘書チャットを操作できる。

詳細は **[server/README.md](server/README.md)** を参照。要点だけ:

- **アカウント**: `accounts.json` に `email` / `token` /（任意）`lineUserId` を登録
- **Gemini**: `GEMINI_API_KEY` を設定すると抽出・要約・秘書チャットが有効化
- **LINE**: `LINE_CHANNEL_ACCESS_TOKEN` ＋ アカウントの `lineUserId` で push 警告
- **リマインド**: 締切の 1日前 / 1時間前を定期チェックして自動通知（送信済みフラグで冪等）
- **日次要約**: その日の文字起こしから「今日の要約」を生成（自動／手動）
- **秘書チャット**: `POST /api/ask` で質問応答＋操作（予定追加・完了化）

```bash
cd server
npm install
mysql -u root < schema.sql                 # DB 初期化
GEMINI_API_KEY=xxxx \
LINE_CHANNEL_ACCESS_TOKEN=yyyy \
npm start                                   # http://localhost:3000
```

---

## 通信・セキュリティ
- 通信は追加ライブラリなし（`HttpURLConnection` + `org.json`）。本番は HTTPS、ローカル動作
  確認用に `10.0.2.2` / `localhost` などへの平文 HTTP のみ許可（`res/xml/network_security_config.xml`）
- サーバー側でアカウント情報とトークンの一致を確認できたときだけ受け付ける

## 注意
- 常時録音＋推論はバッテリー/発熱の負荷が大きい。端末の電池最適化からの除外を推奨。
- 端末再起動後の自動再開・話者分離・音声保存は対象外（必要なら拡張可能）。
- moneybot.jp 連携・LINE・Gemini 連携はゼミ課題向けの簡易実装（トークン平文保持・最小限の認証）。
- リマインドや日次要約の自動生成は Gemini / LINE の API を消費する。間隔は環境変数で調整可能。
