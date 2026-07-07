# iOS アプリ（Android 版の移植）

Android アプリ（`app/`）と同じ挙動をする iOS アプリ。
バックグラウンドで常時録音し、端末上（whisper.cpp）で文字起こしを続け、
**1時間ごとに1つのテキストファイル**として出力する。ログインしていれば
ファイルを定期的に自動アップロードし、サーバーからのリマインドを端末通知として表示する。
録音/記録/予定/AIの4タブ・AIチャット・Google カレンダー連携・Moodle/Waseda 連携・
1日のまとめ通知まで、Android 版と同じ機能構成。

## ビルド手順

Xcode 15 以降と [XcodeGen](https://github.com/yonaskolb/XcodeGen) が必要。
whisper.cpp は Android と同じ git submodule（`app/src/main/cpp/whisper.cpp`）を参照するので
先に取得しておく。

```bash
# submodule（whisper.cpp 本体）を取得
git submodule update --init --recursive

# プロジェクト生成（ios/Transcriber.xcodeproj が生成済みならスキップ可）
brew install xcodegen
cd ios && xcodegen generate

# Xcode で開いてビルド（署名チームを自分のものに設定する）
open Transcriber.xcodeproj
```

whisper.cpp は Android の `app/src/main/cpp/CMakeLists.txt` と同一のソース一覧を
CPU バックエンド（`GGML_USE_CPU`）でアプリに直接コンパイルしている（`project.yml` 参照）。

## Google カレンダー連携の設定

iOS には Android のようなシステム Google アカウントが無いため、OAuth（PKCE）で連携する。

1. [Google Cloud Console](https://console.cloud.google.com/apis/credentials) で
   「OAuth クライアント ID（iOS）」を作成（Bundle ID: `com.ishilab.transcriber`）
2. `Transcriber/Info.plist` の `GoogleOAuthClientID` にクライアント ID を設定
3. 同じく `CFBundleURLSchemes` をクライアント ID の逆順表記
   （`com.googleusercontent.apps.XXXX`）に置き換える
4. Calendar API を有効化する

## 使い方（Android 版と同じ）

1. アプリ起動 → マイク/通知の権限を許可
2. 初回はモデルをダウンロード（日本語は base 以上を推奨）
3. 「AI」タブの AIHelper.jp 連携でサーバーURL・アカウントを入力しログイン
4. 「録音開始」→ 文字起こしが `transcripts/` に蓄積され、定期的に自動送信される
5. 締切が近づくとリマインド通知（了解を押すまで残る全画面アラート＋バイブ）が届く
6. マイクを一時的に手放したいときは「一時停止」、戻すときは「再開」

## Android 版との挙動の違い（iOS の制約によるもの）

| 項目 | Android | iOS |
| --- | --- | --- |
| 常時録音 | foreground service ＋常駐通知 | `UIBackgroundModes: audio`。**録音中はバックグラウンドでも動き続ける**が、録音を止めるとアプリはまもなくサスペンドされる |
| 一時停止/再開/終了 | 通知バーのボタン | アプリ内（録音タブ）のボタン |
| 録音していないときのリマインド取得 | AlarmManager で15分ごと | `BGAppRefreshTask`（実行タイミングは iOS 任せで保証なし。アプリを開いた時・録音中は10秒/5分間隔で確実に取得） |
| リマインドの全画面表示 | ロック中でも全画面アラートを起動 | アプリ使用中は全画面アラート＋バイブ。それ以外は Time Sensitive 通知を出し、タップで全画面アラートを表示 |
| 1日のまとめ通知 | 発火時刻にその場で内容を生成 | 予約時点の最新データで本文を作って予約し、アプリを開くたび／バックグラウンド更新のたびに内容を更新 |
| Google 連携 | 端末のアカウント選択画面 | ブラウザで OAuth サインイン（上記設定が必要） |
| モデル/記録の保存先 | `filesDir` | アプリの `Documents/`（`models/` `transcripts/` `segments/` `audio-outbox/`） |

通信仕様（`/api/upload` `/api/audio` `/api/reminders` `/api/ask` ほか全エンドポイント、
WAV ヘッダ付き PCM アップロード、送信済みファイルの永続化、5分間隔リトライ、
1時間=1区間のローテーション、簡易VAD など）は Android 版と同一。

## 主要ファイル

| 役割 | パス |
| --- | --- |
| 録音/文字起こしサービス | `Transcriber/Audio/AudioCaptureService.swift` |
| 区間PCM書き出し・読み出し | `Transcriber/Audio/PcmSegment.swift` |
| 簡易VAD・定数 | `Transcriber/Audio/AudioChunker.swift` |
| whisper エンジン / 抽象 | `Transcriber/Transcribe/WhisperEngine.swift`, `TranscriptionEngine.swift` |
| 出力ファイル管理 | `Transcriber/Transcribe/TranscriptStore.swift` |
| モデルDL管理 | `Transcriber/Model/ModelManager.swift` |
| 送信クライアント（upload/ask/reminders） | `Transcriber/Net/AiHelperClient.swift` |
| 定期アップロード＋リマインド通知 | `Transcriber/Net/BackgroundSync.swift`, `ReminderNotifier.swift` |
| ログイン情報の保存 | `Transcriber/Net/AccountStore.swift` |
| 1日のまとめ通知 | `Transcriber/Service/DailyDigest.swift` |
| 時間割ヘルパー | `Transcriber/Service/CourseSchedule.swift` |
| Google カレンダー | `Transcriber/Google/GoogleCalendarClient.swift`, `GoogleAccountStore.swift` |
| 画面（4タブ＋AIチャット） | `Transcriber/App/ContentView.swift`, `Transcriber/UI/*.swift` |
| C ブリッジ | `Transcriber/Transcriber-Bridging-Header.h` |
