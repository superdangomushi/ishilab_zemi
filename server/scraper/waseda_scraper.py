#!/usr/bin/env python3
"""
Waseda 科目登録（時間割）を取得して AIHelper サーバーへ登録するスクレイパ。

seiseki-viewer の実績あるログイン手順（MyWaseda → Microsoft ログイン → coursereg）を流用。
科目登録は滅多に変わらないため、cron ではなく「手動実行（取得ボタン相当）」を想定。
Moodle の自動巡回（3日ごと）も、このスクリプトを cron で回して実現できる（--moodle は今後拡張）。

使い方:
  pip install -r requirements.txt   # selenium webdriver-manager beautifulsoup4 requests
  # (a) サーバー保存の資格情報を使う（各ユーザーがアカウント画面で Waseda 連携を保存済みの場合）
  AIHELPER_URL=http://localhost:3000 AIHELPER_EMAIL=you@example.com AIHELPER_TOKEN=xxxx \
  python3 waseda_scraper.py            # 資格情報取得→ログイン→時間割取得→サーバー登録
  # (b) 環境変数で直接渡す（従来どおり。こちらが優先）
  WASEDA_ID=xxxx@akane.waseda.jp WASEDA_PASSWORD=**** \
  AIHELPER_URL=http://localhost:3000 AIHELPER_EMAIL=you@example.com AIHELPER_TOKEN=xxxx \
  python3 waseda_scraper.py
  python3 waseda_scraper.py --dump timetable.html   # HTML を保存（セレクタ調整用）
  python3 waseda_scraper.py --headful  # ブラウザ表示（2FA/初回確認用）

注意: 実際の科目登録ページの HTML 構造は環境で異なるため、parse_timetable() の
セレクタは --dump で保存した HTML を見て調整してください。
"""

import os
import re
import sys
import time
import json
import requests
from bs4 import BeautifulSoup

PORTAL = "https://coursereg.waseda.jp/portal/simpleportal.php?HID_P14=JA"
LOGIN_ENTRY = "https://my.waseda.jp/login/login"
DAYS = ["月", "火", "水", "木", "金", "土", "日"]


def make_driver(headful=False):
    from selenium import webdriver
    from selenium.webdriver.chrome.service import Service
    opts = webdriver.ChromeOptions()
    if not headful:
        opts.add_argument("--headless=new")
    for a in ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
              "--window-size=1920,1080", "--disable-extensions"]:
        opts.add_argument(a)
    opts.add_argument("--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
    path = os.environ.get("CHROMEDRIVER_PATH")
    if path:
        service = Service(executable_path=path)
    else:
        import shutil
        sys_cd = shutil.which("chromedriver")
        if sys_cd:
            service = Service(executable_path=sys_cd)
        else:
            from webdriver_manager.chrome import ChromeDriverManager
            service = Service(ChromeDriverManager().install())
    return webdriver.Chrome(service=service, options=opts)


def login(driver, username, password):
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC
    wait = WebDriverWait(driver, 25)

    driver.get(LOGIN_ENTRY)
    time.sleep(3)
    try:
        links = driver.find_elements(By.XPATH, "//a[contains(text(),'Login') or contains(text(),'ログイン')]")
        if links:
            links[0].click(); time.sleep(3)
    except Exception:
        pass

    try:
        wait.until(lambda d: "login.microsoftonline.com" in d.current_url or "my.waseda.jp/portal" in d.current_url)
    except Exception:
        pass

    if "login.microsoftonline.com" in driver.current_url:
        wait.until(EC.presence_of_element_located((By.NAME, "loginfmt"))).send_keys(username)
        wait.until(EC.element_to_be_clickable((By.ID, "idSIButton9"))).click()
        wait.until(EC.visibility_of_element_located((By.NAME, "passwd"))).send_keys(password)
        wait.until(EC.element_to_be_clickable((By.ID, "idSIButton9"))).click()
        try:
            wait.until(EC.element_to_be_clickable((By.ID, "idBtn_Back"))).click()  # Stay signed in? → No
        except Exception:
            pass
        try:
            wait.until(lambda d: "my.waseda.jp/portal" in d.current_url or "waseda.jp" in d.current_url)
        except Exception:
            if "login.microsoftonline.com" in driver.current_url:
                raise RuntimeError("ログイン未完了（2FA が必要か認証情報が誤り）")


def open_timetable(driver):
    """coursereg ポータルから科目登録ページを開き HTML を返す。

    ポータルの「科目登録」リンクは JavaScript の doSubmit() で hidden form (F01) を
    送信する仕組み。Selenium で同じ手順を再現する:
      1. ポータルページ (simpleportal.php) を開く
      2. F01 フォームの hidden フィールドに doSubmit() と同じ値をセットして submit
      3. 新しいウィンドウに科目登録ページ (epb1110.htm) が開くので、そちらに切り替える
    """
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC

    driver.get(PORTAL)
    time.sleep(3)

    # doSubmit('https://wcrs.waseda.jp/kyomu/epb1110.htm', 'eStudent', 'ea02', '0', 'ApWindow_00')
    # と同等の操作を Selenium で実行する。
    js = """
    var f = document.F01;
    if (!f) return false;
    f.url.value = 'https://wcrs.waseda.jp/kyomu/epb1110.htm';
    f.HID_P6.value = 'eStudent';
    f.HID_P8.value = 'ea02';
    f.pageflag.value = '1000';
    f.status.value = '0';
    // 新しいウィンドウを先に開いてから target を合わせる
    window.open('', 'ApWindow_00', 'menubar=no,status=yes,scrollbars=yes,location=no,resizable=yes');
    f.target = 'ApWindow_00';
    f.submit();
    return true;
    """
    ok = driver.execute_script(js)
    if not ok:
        # フォームが見つからなかった場合のフォールバック: リンクをクリック
        for kw in ["科目登録照会", "科目登録", "時間割", "履修"]:
            try:
                link = driver.find_element(By.XPATH, f"//a[contains(., '{kw}')]")
                link.click()
                time.sleep(4)
                break
            except Exception:
                continue

    # 新しいウィンドウに切り替える（科目登録ページがそこに開く）。
    time.sleep(4)
    if len(driver.window_handles) > 1:
        driver.switch_to.window(driver.window_handles[-1])
        time.sleep(3)

    # 科目登録ページが完全に読み込まれるまで待つ。
    try:
        WebDriverWait(driver, 15).until(
            lambda d: "登録科目一覧" in d.page_source or "履修" in d.title
        )
    except Exception:
        pass
    time.sleep(2)
    return driver.page_source


# 全角数字→半角変換テーブル
_ZEN2HAN = str.maketrans("０１２３４５６７８９", "0123456789")


def _normalize_num(s):
    """全角数字を半角に変換して返す。"""
    return s.translate(_ZEN2HAN)


def _parse_period(text):
    """時限テキストから (開始時限, 終了時限) を返す。

    "１" → (1, 1), "１～２" → (1, 2), "１～４" → (1, 4),
    "その他"/"フルオンデマンド" → (None, None)
    """
    t = _normalize_num(text.strip())
    m = re.match(r"(\d+)\s*[～〜~-]\s*(\d+)", t)
    if m:
        return int(m.group(1)), int(m.group(2))
    m = re.match(r"(\d+)", t)
    if m:
        return int(m.group(1)), int(m.group(1))
    return None, None


def parse_timetable(html):
    """科目登録ページの「■登録科目一覧」テーブルをパースする。

    テーブルは行リスト形式で、各行の列は:
      0:学期 / 1:曜日 / 2:時限 / 3:開講学部 / 4:備考 / 5:科目名 /
      6:担当教員 / 7:キャンパス / 8:教室名 / 9:科目区分 / 10:単位 / 11:状態
    時限が "１～４" のように範囲の場合は、start_time/end_time は None のまま period だけ入れる。
    """
    soup = BeautifulSoup(html, "html.parser")
    courses = []

    # ■登録科目一覧 のヘッダ行（学期/曜日/時限/…）を含むテーブルを見つける。
    target_table = None
    for table in soup.find_all("table"):
        first_row = table.find("tr")
        if not first_row:
            continue
        cells = first_row.find_all(["th", "td"])
        header = [c.get_text(strip=True) for c in cells]
        # ヘッダに「学期」「曜日」「時限」「科目名」が含まれていれば対象テーブル
        header_joined = "".join(header)
        if "学期" in header_joined and "曜日" in header_joined and "科目名" in header_joined:
            target_table = table
            break

    if not target_table:
        return courses

    rows = target_table.find_all("tr")
    if len(rows) < 2:
        return courses

    # ヘッダ行から列インデックスを特定（列順が変わっても対応）
    header_cells = rows[0].find_all(["th", "td"])
    col_map = {}
    for i, cell in enumerate(header_cells):
        t = cell.get_text(strip=True)
        if "学期" in t:
            col_map["term"] = i
        elif "曜日" in t:
            col_map["day"] = i
        elif "時限" in t:
            col_map["period"] = i
        elif "科目名" in t:
            col_map["name"] = i
        elif "担当教員" in t:
            col_map["instructor"] = i
        elif "キャンパス" in t:
            col_map["campus"] = i
        elif "教室" in t:
            col_map["room"] = i
        elif "科目区分" in t:
            col_map["category"] = i
        elif "単位" in t:
            col_map["credits"] = i
        elif "状態" in t or "希望順位" in t:
            col_map["status"] = i

    def cell_text(cells, key):
        idx = col_map.get(key)
        if idx is None or idx >= len(cells):
            return ""
        return cells[idx].get_text(" ", strip=True)

    # データ行を処理
    for row in rows[1:]:
        cells = row.find_all(["th", "td"])
        if len(cells) < 6:
            continue
        name = cell_text(cells, "name").strip()
        if not name:
            continue

        term_raw = cell_text(cells, "term").strip()
        day_raw = cell_text(cells, "day").strip()
        period_raw = cell_text(cells, "period").strip()
        room = cell_text(cells, "room").strip()
        campus = cell_text(cells, "campus").strip()

        # 曜日: "月", "火", ... / "無" はオンデマンド等（None にする）
        day = day_raw if day_raw in DAYS else None

        # 時限: "１～２" 等の範囲もパース
        period_start, period_end = _parse_period(period_raw)

        # 学期の正規化: "春学期" → "春", "秋学期" → "秋" 等
        term = term_raw.replace("学期", "").replace("クォーター", "Q").strip()

        # 教室にキャンパス情報も含める（教室名が空のときはキャンパスだけ使う）
        if room and campus:
            display_room = room
        elif campus:
            display_room = campus
        else:
            display_room = room

        course = {
            "term": term or None,
            "day": day,
            "period": period_start,
            "name": name[:255],
            "room": display_room or None,
        }

        # 時限が範囲の場合（1～4 等）は start_time/end_time で表現
        if period_start and period_end and period_end > period_start:
            course["start_time"] = str(period_start)
            course["end_time"] = str(period_end)

        courses.append(course)

    return courses


def fetch_server_credentials():
    """AIHelper サーバーに保存された本人の Waseda ID・パスワードを取得する。

    AIHELPER_URL / AIHELPER_EMAIL / AIHELPER_TOKEN が揃っていて、
    ユーザーがアカウント画面から Waseda 連携を保存済みのときに使える。
    """
    base = os.environ.get("AIHELPER_URL")
    email = os.environ.get("AIHELPER_EMAIL")
    token = os.environ.get("AIHELPER_TOKEN")
    if not base or not email or not token:
        return None
    try:
        r = requests.get(f"{base.rstrip('/')}/api/waseda/credentials",
                         headers={"X-Account-Email": email, "Authorization": f"Bearer {token}"},
                         timeout=15)
        j = r.json()
        if r.ok and j.get("ok"):
            print(f"サーバー保存の Waseda アカウントを使用: {j['wasedaUser']}")
            return j["wasedaUser"], j["wasedaPassword"]
        print("サーバーから資格情報を取得できません:", j.get("error", f"HTTP {r.status_code}"))
    except Exception as e:
        print("サーバーへの資格情報の問い合わせに失敗:", e)
    return None


def post_courses(courses):
    base = os.environ["AIHELPER_URL"].rstrip("/")
    email = os.environ["AIHELPER_EMAIL"]
    token = os.environ["AIHELPER_TOKEN"]
    r = requests.post(f"{base}/api/courses",
                      headers={"X-Account-Email": email, "Authorization": f"Bearer {token}",
                               "Content-Type": "application/json"},
                      data=json.dumps({"courses": courses}), timeout=30)
    r.raise_for_status()
    print("サーバー登録:", r.json())


def filter_by_current_semester(courses):
    """現在の月に応じて、該当学期の科目だけを残す。

    4〜9月 → 春学期系 (春, 春Q, 夏Q, 夏季集中, 通年) を採用
    10〜3月 → 秋学期系 (秋, 秋Q, 冬Q, 冬季集中, 通年) を採用
    """
    from datetime import datetime
    month = datetime.now().month
    is_spring = 4 <= month <= 9

    # 通年は常に含める
    ALWAYS = {"通年"}
    SPRING = {"春", "春Q", "夏Q", "夏季集中"}
    FALL = {"秋", "秋Q", "冬Q", "冬季集中"}

    allowed = ALWAYS | (SPRING if is_spring else FALL)

    filtered = []
    for c in courses:
        term = (c.get("term") or "").strip()
        if not term:
            # term が空なら通す（情報不足のため除外しない）
            filtered.append(c)
        elif term in allowed:
            filtered.append(c)
    return filtered


def main():
    dump = None
    headful = "--headful" in sys.argv
    if "--dump" in sys.argv:
        i = sys.argv.index("--dump")
        dump = sys.argv[i + 1] if i + 1 < len(sys.argv) else "timetable.html"

    username = os.environ.get("WASEDA_ID")
    password = os.environ.get("WASEDA_PASSWORD")
    if not username or not password:
        # 環境変数に無ければ、AIHelper サーバーに保存された本人の Waseda アカウントを使う。
        creds = fetch_server_credentials()
        if creds:
            username, password = creds
        else:
            print("環境変数 WASEDA_ID / WASEDA_PASSWORD か、"
                  "AIHELPER_URL / AIHELPER_EMAIL / AIHELPER_TOKEN（サーバー保存の資格情報）が必要です")
            sys.exit(1)

    driver = make_driver(headful=headful)
    try:
        print("ログイン中…")
        login(driver, username, password)
        print("時間割ページを取得中…")
        html = open_timetable(driver)
        if dump:
            with open(dump, "w", encoding="utf-8") as f:
                f.write(html)
            print(f"HTML を保存しました: {dump}（parse_timetable のセレクタ調整に使ってください）")
        all_courses = parse_timetable(html)
        print(f"全科目数: {len(all_courses)}")
        for c in all_courses:
            print("  (全)", c)
        courses = filter_by_current_semester(all_courses)
        print(f"現在の学期に該当する科目数: {len(courses)}")
        for c in courses:
            print(" ", c)
        if courses and os.environ.get("AIHELPER_URL"):
            post_courses(courses)
        elif not courses:
            print("科目が抽出できませんでした。--dump で HTML を保存し、parse_timetable を調整してください。")
    finally:
        driver.quit()


if __name__ == "__main__":
    main()
