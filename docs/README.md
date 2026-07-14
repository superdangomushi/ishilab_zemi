# AIHelper ドキュメント

このフォルダは AIHelper（常時録音 → 文字起こし → 課題/予定の抽出・リマインド）の
コード構成と通信仕様の説明書です。**やりとりの形式はすべて実際のJSON例つき**で説明しています。

> 記載している行番号は 2026-07-14 時点のものです。コードを編集すると行番号はずれるので、
> 迷ったら関数名・エンドポイント名で `grep` してください。

## 目次

| ファイル | 内容 |
| --- | --- |
| [01-architecture.md](01-architecture.md) | 全体構成。登場人物（サーバー / ワーカーPC / スマホアプリ / ブラウザ）と音声が文字になるまでの流れ |
| [02-server-code-map.md](02-server-code-map.md) | `server/` の各ファイルの役割と、`server.js`（3600行）のどこに何が書いてあるかの地図 |
| [03-client-code-map.md](03-client-code-map.md) | `client/audio-worker.js`（ワーカーPC側）の構造、設定ファイル `accounts.json`、ローカル管理UI |
| [04-worker-protocol.md](04-worker-protocol.md) | **音声ワーカーのJSONプロトコル詳細**。登録フェーズ・claim・ダウンロード・結果送信を全JSON例つきで。なりすまし/取違対策の仕組みも |
| [05-api-reference.md](05-api-reference.md) | 全APIエンドポイントのリファレンス（リクエスト/レスポンスのJSON例つき） |
| [06-database.md](06-database.md) | MySQLの全テーブルスキーマとカラムの意味 |
| [07-gemini-pipeline.md](07-gemini-pipeline.md) | Gemini解析パイプライン（自動/手動解析、gemini_auto設定、日次要約、AIチャット） |
| [08-dashboard.md](08-dashboard.md) | ダッシュボード（Web UI）の画面ごとの機能と対応するコードの場所 |

## まず読むなら

- 仕組みの全体像を知りたい → [01-architecture.md](01-architecture.md)
- ワーカーPCとサーバーのやりとりを知りたい → [04-worker-protocol.md](04-worker-protocol.md)
- 「この機能のコードはどこ？」→ [02-server-code-map.md](02-server-code-map.md) / [03-client-code-map.md](03-client-code-map.md)
- APIを叩きたい → [05-api-reference.md](05-api-reference.md)

## リポジトリ全体の構成

```
ishilab_zemi/
├── server/     公開サーバー（Node.js + Express + MySQL）。API・ダッシュボード・リマインド
├── client/     ワーカーPC用クライアント。音声ジョブを取得して faster-whisper で文字起こし
├── app/        Androidアプリ（録音・アップロード・通知）。whisper.cpp を同梱
├── ios/        iOS移植（SwiftUI + whisper.cpp）。ビルド未検証
└── docs/       このドキュメント
```
