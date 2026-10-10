import json
import os
import re
import sys
import time

import requests
from seleniumbase import SB

BASE = "https://client.falixnodes.net"
LOGIN_URL = f"{BASE}/auth/login"
TIMER_URL = os.getenv("FALIX_TIMER_URL") or f"{BASE}/timer?id=2845100"
COOKIE_FILE = "cookies/falix.json"

EMAIL = os.getenv("FALIX_EMAIL", "")
PASSWORD = os.getenv("FALIX_PASSWORD", "")
TG_TOKEN = os.getenv("TG_BOT_TOKEN", "")
TG_CHAT = os.getenv("TG_CHAT_ID", "")
IS_PROXY = os.getenv("IS_PROXY", "false").lower() == "true"
PROXY = f"socks5://127.0.0.1:{os.getenv('SOCKS_PORT', '1080')}" if IS_PROXY else None


def tg(text: str):
    print(text)
    if not (TG_TOKEN and TG_CHAT):
        return
    try:  # Telegram 通知直连，不走代理
        requests.post(
            f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage",
            data={"chat_id": TG_CHAT, "text": text},
            timeout=20,
        )
    except Exception as e:
        print("TG 发送失败:", e)


def fmt(sec: int) -> str:
    sec = max(int(sec), 0)
    h, r = divmod(sec, 3600)
    m, s = divmod(r, 60)
    return f"{h}小时{m}分{s}秒"


def read_timer(sb) -> int:
    """从页面读取剩余时间(秒)，格式如 '153 hours 34 minutes 37 seconds'。"""
    deadline = time.time() + 30
    while time.time() < deadline:
        text = sb.get_text("body")
        parts = {k: re.search(rf"(\d+)\s*{k}", text, re.I) for k in ("day", "hour", "minute", "second")}
        if any(parts.values()):
            g = lambda k: int(parts[k].group(1)) if parts[k] else 0
            return g("day") * 86400 + g("hour") * 3600 + g("minute") * 60 + g("second")
        time.sleep(1)
    raise RuntimeError("读取不到剩余时间")


def solve_turnstile(sb) -> bool:
    js = "var e=document.querySelector('[name=cf-turnstile-response]');return e?e.value:''"
    for _ in range(3):
        try:
            sb.uc_gui_click_captcha()
        except Exception as e:
            print("click captcha:", e)
        for _ in range(15):
            try:
                if sb.execute_script(js):
                    return True
            except Exception:
                pass
            time.sleep(1)
    return False


def load_cookies(sb) -> bool:
    if not os.path.exists(COOKIE_FILE):
        return False
    try:
        cookies = json.load(open(COOKIE_FILE))
    except Exception:
        return False
    sb.uc_open_with_reconnect(BASE, 4)
    for c in cookies:
        c = {k: v for k, v in c.items() if k in ("name", "value", "domain", "path", "secure", "httpOnly", "expiry", "sameSite")}
        if "expiry" in c:
            c["expiry"] = int(c["expiry"])
        try:
            sb.driver.add_cookie(c)
        except Exception:
            pass
    return True


def save_cookies(sb):
    os.makedirs(os.path.dirname(COOKIE_FILE), exist_ok=True)
    json.dump(sb.driver.get_cookies(), open(COOKIE_FILE, "w"))


def do_login(sb):
    if not (EMAIL and PASSWORD):
        raise RuntimeError("未设置 FALIX_EMAIL / FALIX_PASSWORD")
    sb.uc_open_with_reconnect(LOGIN_URL, 5)
    email_sel = 'input[type="email"], input[name="email"]'
    sb.wait_for_element(email_sel, timeout=30)
    sb.type(email_sel, EMAIL)
    sb.type('input[type="password"]', PASSWORD)
    if not solve_turnstile(sb):
        raise RuntimeError("登录页 CF 验证未通过")
    try:
        sb.click('button[type="submit"]', timeout=5)
    except Exception:
        sb.click('button:contains("Sign In")')
    for _ in range(40):
        if "/auth/login" not in sb.get_current_url():
            return
        time.sleep(1)
    raise RuntimeError("登录失败（仍停留在登录页）")


def open_timer_logged_in(sb):
    load_cookies(sb)
    sb.uc_open_with_reconnect(TIMER_URL, 4)
    time.sleep(3)
    if "/auth/login" in sb.get_current_url():
        print("Cookie 失效或不存在，使用账号密码登录")
        do_login(sb)
        sb.uc_open_with_reconnect(TIMER_URL, 4)
        time.sleep(3)
    else:
        print("使用 Cookie 登录成功")
    save_cookies(sb)


def main():
    with SB(uc=True, xvfb=True, locale_code="en", proxy=PROXY, headed=True) as sb:
        try:
            open_timer_logged_in(sb)

            t1, ts1 = read_timer(sb), time.time()
            print("续期前:", fmt(t1))

            if not solve_turnstile(sb):
                raise RuntimeError("续期页 CF 验证未通过")
            sb.click('button:contains("Add Time")')

            # 等待跳转回服务器页面
            for _ in range(45):
                if "/timer" not in sb.get_current_url():
                    break
                time.sleep(1)
            time.sleep(3)
            sb.save_screenshot("after_click.png")

            sb.uc_open_with_reconnect(TIMER_URL, 4)
            time.sleep(3)
            t2, ts2 = read_timer(sb), time.time()
            print("续期后:", fmt(t2))
            save_cookies(sb)

            added = (t2 - t1) + (ts2 - ts1)  # 补上两次读取之间自然流逝的时间
            if t2 > t1:
                tg(f"✅ Falix 续期成功\n续期前: {fmt(t1)}\n续期后: {fmt(t2)}\n本次增加: 约 {fmt(added)}")
            else:
                tg(f"❌ Falix 续期失败（时间没有增加）\n续期前: {fmt(t1)}\n续期后: {fmt(t2)}")
                sys.exit(1)
        except SystemExit:
            raise
        except Exception as e:
            try:
                sb.save_screenshot("error.png")
            except Exception:
                pass
            tg(f"❌ Falix 续期出错: {e}")
            sys.exit(1)


if __name__ == "__main__":
    main()
