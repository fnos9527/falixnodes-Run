import json
import os
import re
import subprocess
import time
import urllib.parse
from playwright.sync_api import sync_playwright
import requests


def send_tg_message(text, image_path=None):
  token = os.environ.get('TG_BOT_TOKEN')
  chat_id = os.environ.get('TG_CHAT_ID')
  if not token or not chat_id:
    return
  try:
    if image_path and os.path.exists(image_path):
      with open(image_path, 'rb') as photo:
        requests.post(
            f'https://api.telegram.org/bot{token}/sendPhoto',
            data={'chat_id': chat_id, 'caption': text},
            files={'photo': photo},
        )
    else:
      requests.post(
          f'https://api.telegram.org/bot{token}/sendMessage',
          json={'chat_id': chat_id, 'text': text},
      )
  except Exception as e:
    print(f'发送 TG 消息失败: {e}')


def setup_sing_box(vless_url):
  print('正在解析 VLESS 节点并生成 sing-box 配置...')
  parsed = urllib.parse.urlparse(vless_url)
  uuid = parsed.username
  netloc = parsed.netloc.split('@')[-1]
  if ':' in netloc:
    host, port = netloc.rsplit(':', 1)
    port = int(port)
  else:
    host = netloc
    port = 443

  query = urllib.parse.parse_qs(parsed.query)
  security = query.get('security', ['tls'])[0]
  sni = query.get('sni', [host])[0]
  insecure_val = (
      query.get('insecure', ['0'])[0] == '1'
      or query.get('allowInsecure', ['0'])[0] == '1'
  )
  trans_type = query.get('type', ['tcp'])[0]

  outbound = {
      'type': 'vless',
      'tag': 'vless-out',
      'server': host,
      'server_port': port,
      'uuid': uuid,
      'tls': {'enabled': security == 'tls', 'server_name': sni, 'insecure': insecure_val},
  }

  if trans_type == 'ws':
    path = query.get('path', ['/'])[0]
    path = urllib.parse.unquote(path)
    ws_host = query.get('host', [host])[0]
    outbound['transport'] = {'type': 'ws', 'path': path, 'headers': {'Host': ws_host}}

  config = {
      'log': {'level': 'error'},
      'inbounds': [{'type': 'socks', 'tag': 'socks-in', 'listen': '127.0.0.1', 'listen_port': 10808}],
      'outbounds': [outbound],
  }

  with open('config.json', 'w') as f:
    json.dump(config, f, indent=2)

  subprocess.Popen(['./sing-box', 'run', '-c', 'config.json'])
  time.sleep(3)
  print('sing-box 代理启动成功.')


def parse_time_to_seconds(time_str):
  days = re.search(r'(\d+)\s*days?', time_str, re.IGNORECASE)
  hours = re.search(r'(\d+)\s*hours?', time_str, re.IGNORECASE)
  minutes = re.search(r'(\d+)\s*minutes?', time_str, re.IGNORECASE)
  seconds = re.search(r'(\d+)\s*seconds?', time_str, re.IGNORECASE)

  total = 0
  if days:
    total += int(days.group(1)) * 86400
  if hours:
    total += int(hours.group(1)) * 3600
  if minutes:
    total += int(minutes.group(1)) * 60
  if seconds:
    total += int(seconds.group(1))
  return total


def main():
  email = os.environ.get('FALIX_EMAIL')
  password = os.environ.get('FALIX_PASSWORD')
  proxy_url = os.environ.get('PROXY_URL')
  timer_url = os.environ.get('TIMER_URL', 'https://client.falixnodes.net/timer?id=2845100')

  if not proxy_url:
    print('错误: 未配置 PROXY_URL 环境变量')
    return

  setup_sing_box(proxy_url)

  with sync_playwright() as p:
    browser = p.chromium.launch(
        headless=False,
        proxy={'server': 'socks5://127.0.0.1:10808'},
        args=['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    )
    context = browser.new_context(
        user_agent=(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
            'Chrome/122.0.0.0 Safari/537.36'
        ),
        viewport={'width': 1280, 'height': 800},
    )

    cookie_file = 'cookies.json'
    if os.path.exists(cookie_file):
      try:
        with open(cookie_file, 'r') as f:
          cookies = json.load(f)
          context.add_cookies(cookies)
        print('已加载本地缓存 Cookie')
      except Exception as e:
        print(f'加载 Cookie 失败: {e}')

    page = context.new_page()

    try:
      print('正在访问登录页面...')
      page.goto('https://client.falixnodes.net/auth/login', wait_until='networkidle')
      time.sleep(3)

      if 'auth/login' in page.url:
        print('检测到未登录或 Cookie 失效，开始账号密码登录...')
        if not email or not password:
          raise Exception('未配置 FALIX_EMAIL 或 FALIX_PASSWORD 密钥！')

        page.fill('input[type="email"]', email)
        page.fill('input[type="password"]', password)

        print('等待处理 Cloudflare 验证，请稍候...')
        time.sleep(6)

        try:
          page.click('button:has-text("Sign In")')
        except Exception:
          page.locator('button[type="submit"]').click()

        time.sleep(5)

      screenshot_path = 'login_success.png'
      page.screenshot(path=screenshot_path)
      send_tg_message('🔄 FalixNodes 登录动作执行完成，当前登录状态截图：', screenshot_path)

      new_cookies = context.cookies()
      with open(cookie_file, 'w') as f:
        json.dump(new_cookies, f)

      success = False
      for attempt in range(1, 4):
        print(f'=== 第 {attempt} 次尝试续期 ===')
        page.goto(timer_url, wait_until='networkidle')
        time.sleep(4)

        try:
          timer_element = page.locator('text=/\\d+\\s*(hours|days)/i').first
          old_time_str = timer_element.inner_text()
          old_seconds = parse_time_to_seconds(old_time_str)
          print(f'当前剩余时间: {old_time_str} ({old_seconds} 秒)')
        except Exception as e:
          print(f'获取时间失败: {e}')
          page.screenshot(path=f'error_attempt_{attempt}.png')
          continue

        try:
          add_btn = page.locator('button:has-text("Add Time")')
          add_btn.click()
          print('已点击 + Add Time 按钮，等待 3 秒...')
          time.sleep(3)
        except Exception as e:
          print(f'点击 Add Time 按钮失败: {e}')
          continue

        page.goto(timer_url, wait_until='networkidle')
        time.sleep(3)

        try:
          new_timer_element = page.locator('text=/\\d+\\s*(hours|days)/i').first
          new_time_str = new_timer_element.inner_text()
          new_seconds = parse_time_to_seconds(new_time_str)
          print(f'操作后剩余时间: {new_time_str} ({new_seconds} 秒)')

          if new_seconds > old_seconds:
            success = True
            msg = f'✅ FalixNodes 续期成功！\n- 续期前: {old_time_str}\n- 续期后: {new_time_str}'
            print(msg)
            send_tg_message(msg)
            break
          else:
            print('时间未增加，准备重试...')
        except Exception as e:
          print(f'校验新时间出错: {e}')

      if not success:
        fail_msg = '❌ FalixNodes 续期失败：重试 3 次后时间均未增加。'
        print(fail_msg)
        send_tg_message(fail_msg)

    except Exception as e:
      err_msg = f'❌ 脚本运行发生异常: {str(e)}'
      print(err_msg)
      page.screenshot(path='fatal_error.png')
      send_tg_message(err_msg, 'fatal_error.png')
    finally:
      browser.close()


if __name__ == '__main__':
  main()
