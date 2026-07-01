# moneybot サーバー (Node.js + Express + MySQL) 用 Makefile
# 想定環境: Ubuntu Server
#
#   make install   … サーバーの依存関係(npm パッケージ)をインストール
#   make run       … サーバーを起動
#
# 初回セットアップ用の補助ターゲット:
#   make system-deps … Ubuntu に Node.js + MySQL を導入 (要 sudo)
#   make db          … データベース作成 + schema.sql 適用
#
# DB 接続やキーは環境変数で渡す (README 参照)。例:
#   make run DB_USER=root DB_PASSWORD=secret GEMINI_API_KEY=xxx

# ---- 設定 (make VAR=値 で上書き可) ----
NODE_MAJOR ?= 20
DB_HOST    ?= localhost
DB_PORT    ?= 3306
DB_USER    ?= root
DB_NAME    ?= moneybot
# パスワードは既定で空。設定時は make ... DB_PASSWORD=xxx
DB_PASSWORD ?=

# DB_PASSWORD が空でなければ mysql に -p<パスワード> を渡す
MYSQL_PWFLAG := $(if $(DB_PASSWORD),-p$(DB_PASSWORD),)
MYSQL := mysql -h $(DB_HOST) -P $(DB_PORT) -u $(DB_USER) $(MYSQL_PWFLAG)

.DEFAULT_GOAL := help
.PHONY: help install run system-deps db clean

help: ## 使い方を表示
	@echo "moneybot サーバー Makefile"
	@echo ""
	@echo "  make install       npm 依存関係をインストール"
	@echo "  make run           サーバーを起動 (既定 http://localhost:3000)"
	@echo "  make system-deps   Ubuntu に Node.js $(NODE_MAJOR).x と MySQL を導入 (要 sudo)"
	@echo "  make db            データベース($(DB_NAME))作成 + schema.sql 適用"
	@echo "  make clean         node_modules を削除"

install: ## npm 依存関係をインストール (package-lock.json に厳密一致)
	npm ci

run: ## サーバーを起動
	npm start

system-deps: ## Ubuntu に Node.js + MySQL を導入 (要 sudo)
	@echo ">> Node.js $(NODE_MAJOR).x (NodeSource) と MySQL Server を導入します"
	curl -fsSL https://deb.nodesource.com/setup_$(NODE_MAJOR).x | sudo -E bash -
	sudo apt-get install -y nodejs mysql-server
	@echo ">> Node: $$(node -v) / npm: $$(npm -v)"

db: ## データベース作成 + schema.sql 適用
	@echo ">> データベース $(DB_NAME) を作成し schema.sql を適用します"
	$(MYSQL) -e "CREATE DATABASE IF NOT EXISTS \`$(DB_NAME)\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
	$(MYSQL) $(DB_NAME) < schema.sql
	@echo ">> 完了"

clean: ## node_modules を削除
	rm -rf node_modules
