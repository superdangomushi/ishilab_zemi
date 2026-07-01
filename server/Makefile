# moneybot サーバー (Node.js + Express + MySQL) 用 Makefile
# 想定環境: Ubuntu Server
#
#   make install   … これ1つで全部: Node.js + MySQL 導入 → DB/ユーザー作成 → npm 依存導入
#                     (apt / mysql 設定に sudo を使う)
#   make run       … サーバーを起動
#
# 個別に実行したい場合:
#   make system-deps … Node.js + MySQL を apt で導入し MySQL を起動 (要 sudo)
#   make db          … データベース・専用ユーザー作成 + schema.sql 適用 (要 sudo)
#   make npm-deps    … npm 依存関係のみインストール
#
# DB 認証やキーは変数/環境変数で上書き可。例:
#   make install DB_PASSWORD=好きなパスワード
#   make run GEMINI_API_KEY=xxx LINE_CHANNEL_ACCESS_TOKEN=yyy

# ---- 設定 (make VAR=値 で上書き可) ----
NODE_MAJOR  ?= 20
DB_HOST     ?= 127.0.0.1
DB_PORT     ?= 3306
DB_NAME     ?= moneybot
# サーバー(Node)が接続する専用ユーザー。fresh install の root は auth_socket で
# TCP 接続できないため、パスワード付きの専用ユーザーを作成して使う。
DB_USER     ?= moneybot
DB_PASSWORD ?= moneybot

# これらは Node サーバー(process.env)と mysql クライアント双方へ渡す。
export DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD

.DEFAULT_GOAL := help
.PHONY: help install system-deps db npm-deps run clean

help: ## 使い方を表示
	@echo "moneybot サーバー Makefile"
	@echo ""
	@echo "  make install       Node.js+MySQL 導入 → DB作成 → npm 依存導入 (sudo 使用)"
	@echo "  make run           サーバーを起動 (既定 http://localhost:$${PORT:-3000})"
	@echo "  make system-deps   Node.js $(NODE_MAJOR).x と MySQL を導入・起動 (要 sudo)"
	@echo "  make db            DB($(DB_NAME))・ユーザー($(DB_USER))作成 + schema 適用 (要 sudo)"
	@echo "  make npm-deps      npm 依存関係のみインストール"
	@echo "  make clean         node_modules を削除"

# ワンショット・セットアップ。前提ターゲットは記載順に実行される。
install: system-deps db npm-deps ## これ1つでサーバーを動かせる状態にする
	@echo ""
	@echo "✅ セットアップ完了。'make run' で起動できます。"
	@echo "   DB: $(DB_USER)@$(DB_HOST):$(DB_PORT)/$(DB_NAME)"

system-deps: ## Node.js + MySQL を導入し MySQL を起動 (要 sudo)
	@echo ">> Node.js $(NODE_MAJOR).x (NodeSource) と MySQL Server を導入します"
	curl -fsSL https://deb.nodesource.com/setup_$(NODE_MAJOR).x | sudo -E bash -
	sudo apt-get install -y nodejs mysql-server
	sudo systemctl enable --now mysql
	@echo ">> Node: $$(node -v) / npm: $$(npm -v)"

db: ## DB・専用ユーザーを作成し schema.sql を適用 (要 sudo)
	@echo ">> DB '$(DB_NAME)' と ユーザー '$(DB_USER)' を作成し schema.sql を適用します"
	# 管理者はソケット認証(sudo mysql)で接続。識別子はシンプル名、文字列は "..." (既定は非ANSI_QUOTES)。
	# ポイント:
	#  - mysql2 は 127.0.0.1 へ TCP 接続するが、MySQL 側で localhost に逆引きされることがあるため
	#    'localhost' と '%' の両方のアカウントを作る。
	#  - MySQL 8 の既定 caching_sha2_password は非TLSのTCPで失敗しやすいので
	#    mysql_native_password を明示（MySQL 8.0/Ubuntu LTS で利用可）。
	#  - 壊れた既存アカウントを避けるため一度 DROP してから作り直す。
	sudo mysql -e 'CREATE DATABASE IF NOT EXISTS $(DB_NAME) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; \
	  DROP USER IF EXISTS "$(DB_USER)"@"localhost"; \
	  DROP USER IF EXISTS "$(DB_USER)"@"%"; \
	  CREATE USER "$(DB_USER)"@"localhost" IDENTIFIED WITH mysql_native_password BY "$(DB_PASSWORD)"; \
	  CREATE USER "$(DB_USER)"@"%" IDENTIFIED WITH mysql_native_password BY "$(DB_PASSWORD)"; \
	  GRANT ALL PRIVILEGES ON $(DB_NAME).* TO "$(DB_USER)"@"localhost"; \
	  GRANT ALL PRIVILEGES ON $(DB_NAME).* TO "$(DB_USER)"@"%"; \
	  FLUSH PRIVILEGES;'
	sudo mysql $(DB_NAME) < schema.sql
	@echo ">> DB 準備完了"

npm-deps: ## npm 依存関係をインストール (package-lock.json に厳密一致)
	npm ci

run: ## サーバーを起動 (DB 認証情報は上の変数から環境変数で渡る)
	npm start

clean: ## node_modules を削除
	rm -rf node_modules
