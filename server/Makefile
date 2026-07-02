# aihelper サーバー (Node.js + Express + MySQL) 用 Makefile
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
DB_NAME     ?= aihelper
# サーバー(Node)が接続する専用ユーザー。fresh install の root は auth_socket で
# TCP 接続できないため、パスワード付きの専用ユーザーを作成して使う。
DB_USER     ?= aihelper
DB_PASSWORD ?= aihelper

# これらは Node サーバー(process.env)と mysql クライアント双方へ渡す。
export DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD

# DB とユーザーを「最初の一回だけ」作るための管理者接続。
# root は使わず、Ubuntu の保守用アカウント(debian-sys-maint)を既定にする。
# （新規ユーザーが自分自身を作ることはできないため、初回のみ管理者権限が要る）
# debian.cnf が無い/使えない環境では上書きする。例:
#   make db MYSQL_ADMIN='mysql -u root -p'   … どうしても root で入れる場合(対話でパスワード)
MYSQL_ADMIN ?= sudo mysql --defaults-file=/etc/mysql/debian.cnf

# 作成後の通常操作(schema 適用など)は、作った aihelper ユーザー自身で行う。
MYSQL_APP := mysql -h $(DB_HOST) -P $(DB_PORT) -u $(DB_USER) -p$(DB_PASSWORD)

.DEFAULT_GOAL := help
.PHONY: help install system-deps db db-user db-schema npm-deps python-deps stt-deps gpu-driver gpu-check run clean

help: ## 使い方を表示
	@echo "aihelper サーバー Makefile"
	@echo ""
	@echo "  make install       Node.js+MySQL 導入 → DB作成 → npm 依存導入 (sudo 使用)"
	@echo "  make run           サーバーを起動 (既定 http://localhost:$${PORT:-3000})"
	@echo "  make system-deps   Node.js $(NODE_MAJOR).x と MySQL を導入・起動 (要 sudo)"
	@echo "  make db            DB($(DB_NAME))・ユーザー($(DB_USER))作成 + schema 適用 (要 sudo)"
	@echo "  make npm-deps      npm 依存関係のみインストール"
	@echo "  make python-deps   時間割スクレイパの Python 依存を scraper/.venv に導入 (要 sudo)"
	@echo "  make stt-deps      ローカル文字起こし (faster-whisper, GPU対応) を stt/.venv に導入 (要 sudo)"
	@echo "  make gpu-driver    NVIDIA ドライバを導入 (RTX 50xx 対応。導入後に再起動が必要)"
	@echo "  make gpu-check     GPU と CUDA が文字起こしから使える状態か確認"
	@echo "  make clean         node_modules を削除"

# ワンショット・セットアップ。前提ターゲットは記載順に実行される。
install: system-deps db npm-deps python-deps stt-deps ## これ1つでサーバーを動かせる状態にする
	@echo ""
	@echo "✅ セットアップ完了。'make run' で起動できます。"
	@echo "   DB: $(DB_USER)@$(DB_HOST):$(DB_PORT)/$(DB_NAME)"

system-deps: ## Node.js + MySQL を導入し MySQL を起動 (要 sudo)
	@echo ">> Node.js $(NODE_MAJOR).x (NodeSource) と MySQL Server を導入します"
	curl -fsSL https://deb.nodesource.com/setup_$(NODE_MAJOR).x | sudo -E bash -
	sudo apt-get install -y nodejs mysql-server
	sudo systemctl enable --now mysql
	@echo ">> Node: $$(node -v) / npm: $$(npm -v)"

db: db-user db-schema ## DB/専用ユーザー作成(管理者・初回のみ) → schema 適用(aihelper ユーザー)
	@echo ">> DB 準備完了"

db-user: ## DB と専用ユーザー aihelper を作成し権限付与 (初回のみ管理者権限が必要・root不使用)
	@echo ">> DB '$(DB_NAME)' と ユーザー '$(DB_USER)' を作成します (管理者: $(MYSQL_ADMIN))"
	# 識別子はシンプル名、文字列は "..." (既定は非ANSI_QUOTES)。
	# ポイント:
	#  - mysql2 は 127.0.0.1 へ TCP 接続するが、MySQL 側で localhost に逆引きされることがあるため
	#    'localhost' と '%' の両方のアカウントを作る。
	#  - 認証は caching_sha2_password（MySQL 8.4 既定）を明示。
	#    MySQL 8.4 では mysql_native_password が既定でロードされず ERROR 1524 になる。
	#    現行 mysql2(v3) は caching_sha2_password を非TLSのTCPでもサポートする。
	#  - 壊れた既存アカウントを避けるため一度 DROP してから作り直す。
	$(MYSQL_ADMIN) -e 'CREATE DATABASE IF NOT EXISTS $(DB_NAME) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; \
	  DROP USER IF EXISTS "$(DB_USER)"@"localhost"; \
	  DROP USER IF EXISTS "$(DB_USER)"@"%"; \
	  CREATE USER "$(DB_USER)"@"localhost" IDENTIFIED WITH caching_sha2_password BY "$(DB_PASSWORD)"; \
	  CREATE USER "$(DB_USER)"@"%" IDENTIFIED WITH caching_sha2_password BY "$(DB_PASSWORD)"; \
	  GRANT ALL PRIVILEGES ON $(DB_NAME).* TO "$(DB_USER)"@"localhost"; \
	  GRANT ALL PRIVILEGES ON $(DB_NAME).* TO "$(DB_USER)"@"%"; \
	  FLUSH PRIVILEGES;'

db-schema: ## schema.sql を aihelper ユーザー自身で適用 (管理者不要)
	@echo ">> schema.sql を $(DB_USER) で適用します"
	$(MYSQL_APP) $(DB_NAME) < schema.sql

npm-deps: ## npm 依存関係をインストール (package-lock.json に厳密一致)
	npm ci

# Ubuntu 23.04+ は pip のシステム全体インストールを禁止 (PEP 668) しているため、
# scraper/.venv に閉じて導入する。server.js は .venv があれば自動でそちらの python を使う。
python-deps: ## 時間割スクレイパの Python 依存 (bs4/selenium 等) を venv に導入 (要 sudo)
	@echo ">> scraper/.venv に Python 依存 (requests/bs4/selenium) を導入します"
	sudo apt-get install -y python3-venv
	python3 -m venv scraper/.venv
	scraper/.venv/bin/pip install -r scraper/requirements.txt
	@echo ">> selenium 用の Chromium ブラウザと chromedriver を導入します"
	sudo apt-get install -y chromium-browser chromium-chromedriver

# 文字起こしは Gemini でなくローカルの Whisper で行う（トークン節約）。
# GPU (NVIDIA) があれば自動で使い、精度最優先の large-v3 + float16 で動く。
# CUDA Toolkit のシステム導入は不要（cuBLAS/cuDNN は pip で venv 内に入る）。
# NVIDIA ドライバが未導入なら先に `make gpu-driver` → 再起動。
# 初回実行時にモデル（large-v3 約3GB）を自動ダウンロードする。
stt-deps: ## ローカル文字起こし (faster-whisper, GPU対応) を stt/.venv に導入 (要 sudo)
	@echo ">> stt/.venv に faster-whisper (GPU対応) を導入します"
	sudo apt-get install -y python3-venv ffmpeg
	python3 -m venv stt/.venv
	stt/.venv/bin/pip install --upgrade pip
	stt/.venv/bin/pip install -r stt/requirements.txt
	@$(MAKE) --no-print-directory gpu-check

# RTX 50xx (Blackwell) はドライバ 570 以降が必要。ubuntu-drivers が適切な版を選ぶ。
gpu-driver: ## NVIDIA ドライバを導入 (要 sudo。導入後に再起動すること)
	@echo ">> NVIDIA ドライバを導入します（完了後に再起動してください）"
	sudo apt-get update
	sudo apt-get install -y ubuntu-drivers-common
	sudo ubuntu-drivers install
	@echo ">> 再起動後、'make gpu-check' で認識を確認してください"

gpu-check: ## GPU が文字起こしから使える状態か確認
	@if command -v nvidia-smi >/dev/null 2>&1; then \
	  nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader; \
	else \
	  echo "⚠ nvidia-smi が見つかりません。GPU を使うには 'make gpu-driver' → 再起動。"; \
	  echo "  （GPU なしでも CPU で文字起こしは動きます）"; \
	fi
	@if [ -x stt/.venv/bin/python3 ]; then \
	  stt/.venv/bin/python3 -c "import ctranslate2; n = ctranslate2.get_cuda_device_count(); print('✅ CUDA デバイス ' + str(n) + ' 台を faster-whisper から利用できます' if n else '⚠ faster-whisper から CUDA が見えません（ドライバ導入後は再起動が必要。CPU では動きます）')"; \
	else \
	  echo "（stt/.venv 未作成。'make stt-deps' 後に再確認してください）"; \
	fi

run: ## サーバーを起動 (DB 認証情報は上の変数から環境変数で渡る)
	npm start

clean: ## node_modules を削除
	rm -rf node_modules
