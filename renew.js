const { connect } = require('puppeteer-real-browser');
const fs = require('fs');

const { FALIX_EMAIL, FALIX_PASSWORD, TG_BOT_TOKEN, TG_CHAT_ID } = process.env;
const SERVER_ID = process.env.SERVER_ID || '2845100';
const BASE = 'https://client.falixnodes.net';
const LOGIN_URL = `${BASE}/auth/login`;
const TIMER_URL = `${BASE}/timer?id=${SERVER_ID}`;
const COOKIE_FILE = 'data/cookies.json';
const PROXY = 'socks5://127.0.0.1:1080';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

fs.mkdirSync('data', { recursive: true });
fs.mkdirSync('shots', { recursive: true });

// ---------- Telegram ----------
async function tgText(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return log('未配置 TG，跳过发送:', text);
  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text }),
    });
  } catch (e) { log('TG 文字发送失败', e.message); }
}
async function tgPhoto(file, caption) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  try {
    const fd = new FormData();
    fd.append('chat_id', TG_CHAT_ID);
    fd.append('caption', caption);
    fd.append('photo', new Blob([fs.readFileSync(file)]), 'shot.png');
    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto`, { method: 'POST', body: fd });
  } catch (e) { log('TG 图片发送失败', e.message); }
}
async function shot(page, name, caption) {
  const file = `shots/${name}.png`;
  try { await page.screenshot({ path: file }); await tgPhoto(file, caption); }
  catch (e) { log('截图失败', e.message); }
}

// 失败诊断：截图 + 标题 + 正文摘要 + HTML，并发到 TG
async function debug(page, name, note) {
  try {
    const title = await page.title().catch(() => '');
    const body = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 300) : '').catch(() => '');
    log(`[诊断:${name}] url=${page.url()} title=${title}`);
    log(`[诊断:${name}] body=${body.replace(/\s+/g, ' ')}`);
    const html = await page.content().catch(() => '');
    fs.writeFileSync(`shots/${name}.html`, html);
    await shot(page, name, `🔍 ${note}\nURL: ${page.url()}\n标题: ${title}\n正文: ${body.replace(/\s+/g, ' ').slice(0, 150)}`);
  } catch (e) { log('诊断失败', e.message); }
}

// ---------- 工具函数 ----------
function fmt(sec) {
  if (sec == null) return '未知';
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${d ? d + '天' : ''}${h}小时${m}分${s}秒`;
}

async function getRemaining(page) {
  for (let i = 0; i < 20; i++) {
    const text = await page.evaluate(() => document.body.innerText).catch(() => '');
    const h = text.match(/(\d+)\s*hours?/i);
    const m = text.match(/(\d+)\s*minutes?/i);
    const s = text.match(/(\d+)\s*seconds?/i);
    const d = text.match(/(\d+)\s*days?/i);
    if (h && m) {
      return (d ? +d[1] : 0) * 86400 + +h[1] * 3600 + +m[1] * 60 + (s ? +s[1] : 0);
    }
    await sleep(1000);
  }
  return null;
}

// 等待 Cloudflare Turnstile 通过（puppeteer-real-browser 的 turnstile:true 会自动点击）
async function waitTurnstile(page, timeout = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const v = await page.evaluate(() => {
      const el = document.querySelector('input[name="cf-turnstile-response"]');
      return el ? el.value : null;
    }).catch(() => null);
    if (v) return true;
    if (v === null && Date.now() - start > 10000) return false; // 页面没有验证框
    await sleep(1000);
  }
  return false;
}

async function saveCookies(page) {
  try {
    const cookies = await page.cookies();
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
    log(`已保存 ${cookies.length} 条 Cookie`);
  } catch (e) { log('保存 Cookie 失败', e.message); }
}

async function loadCookies(page) {
  if (!fs.existsSync(COOKIE_FILE)) return false;
  try {
    const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
    if (!cookies.length) return false;
    await page.setCookie(...cookies);
    log(`已加载 ${cookies.length} 条 Cookie`);
    return true;
  } catch (e) { log('加载 Cookie 失败', e.message); return false; }
}

async function login(page) {
  if (!FALIX_EMAIL || !FALIX_PASSWORD) throw new Error('缺少 FALIX_EMAIL / FALIX_PASSWORD');
  log('开始账号密码登录');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const emailSel = 'input[type="email"], input[name="email"], input[autocomplete="username"], input:not([type="password"]):not([type="hidden"]):not([type="checkbox"]):not([type="submit"])';
  const passSel = 'input[type="password"]';
  let found = false;
  for (let i = 0; i < 60; i++) {
    found = await page.evaluate((sel) => !!document.querySelector(sel), emailSel).catch(() => false);
    if (found) break;
    if (i === 15) await debug(page, 'login-wait-15s', '登录页 15 秒仍无输入框');
    await sleep(1000);
  }
  if (!found) { await debug(page, 'login-no-input', '登录页找不到输入框'); throw new Error('登录页找不到输入框'); }
  await sleep(1500);
  await page.click(emailSel); await page.type(emailSel, FALIX_EMAIL, { delay: 60 });
  await page.click(passSel); await page.type(passSel, FALIX_PASSWORD, { delay: 60 });
  log('等待 CF 验证…');
  const ok = await waitTurnstile(page, 60000);
  log('CF 验证结果:', ok);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => /sign\s*in/i.test(b.innerText) && b.type !== 'button') ||
                [...document.querySelectorAll('button')].find((b) => /^sign\s*in$/i.test(b.innerText.trim()));
    if (btn) btn.click();
  });
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    if (!page.url().includes('/auth/login')) break;
  }
  await sleep(2000);
  const success = !page.url().includes('/auth/login');
  await shot(page, 'login', success ? '✅ 登录成功截图' : '❌ 登录失败截图');
  if (!success) { await debug(page, 'login-failed', '登录后仍在登录页'); throw new Error('登录失败，仍停留在登录页'); }
  await saveCookies(page);
}

async function clickAddTime(page) {
  const handle = await page.evaluateHandle(() =>
    [...document.querySelectorAll('button, a')].find((b) => /add\s*time/i.test(b.innerText))
  );
  const el = handle.asElement();
  if (!el) return false;
  await el.click();
  return true;
}

// ---------- 主流程 ----------
(async () => {
  let browser, page;
  const result = { before: null, after: null, attempts: 0, ok: false, error: null };
  try {
    const conn = await connect({
      headless: false,
      turnstile: true,
      disableXvfb: false,
      ignoreAllFlags: false,
      args: [`--proxy-server=${PROXY}`, '--window-size=1280,900', '--no-sandbox'],
    });
    browser = conn.browser;
    page = conn.page;
    await page.setViewport({ width: 1280, height: 900 });

    // 1. 优先用 Cookie
    const hadCookie = await loadCookies(page);
    await page.goto(TIMER_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);
    await debug(page, 'first-load', '首次打开 timer 页的状态');
    if (page.url().includes('/auth/login')) {
      log(hadCookie ? 'Cookie 已失效，改用账号密码' : '无 Cookie，使用账号密码');
      await login(page);
    } else {
      log('Cookie 登录成功');
      await shot(page, 'login', '✅ Cookie 登录成功截图');
      await saveCookies(page);
    }

    // 2. 续期（最多 3 次）
    for (let attempt = 1; attempt <= 3; attempt++) {
      result.attempts = attempt;
      log(`第 ${attempt} 次续期`);
      try {
        await page.goto(TIMER_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(3000);
        if (page.url().includes('/auth/login')) { await login(page); await page.goto(TIMER_URL, { waitUntil: 'domcontentloaded' }); }

        const before = await getRemaining(page);
        if (result.before == null) result.before = before;
        log('续期前剩余:', fmt(before));
        if (before == null) throw new Error('读取不到剩余时间');

        await waitTurnstile(page, 60000);
        const clicked = await clickAddTime(page);
        if (!clicked) throw new Error('未找到 Add Time 按钮');
        log('已点击 Add Time');
        await sleep(2500);

        await page.goto(TIMER_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(3000);
        const after = await getRemaining(page);
        result.after = after;
        log('续期后剩余:', fmt(after));

        if (after != null && after > before) {
          result.ok = true;
          await shot(page, 'timer', '⏱ 续期后的计时页面');
          break;
        }
        log('时间未增加，准备重试');
      } catch (e) {
        log(`第 ${attempt} 次出错:`, e.message);
        await debug(page, `attempt-${attempt}-error`, `第 ${attempt} 次出错: ${e.message}`);
        result.error = e.message;
      }
    }
    await saveCookies(page);
  } catch (e) {
    result.error = e.message;
    log('致命错误:', e.message);
    if (page) await debug(page, 'fatal', '致命错误: ' + e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  const msg = result.ok
    ? `✅ FalixNodes 续期成功\n服务器ID: ${SERVER_ID}\n续期前: ${fmt(result.before)}\n续期后: ${fmt(result.after)}\n尝试次数: ${result.attempts}`
    : `❌ FalixNodes 续期失败\n服务器ID: ${SERVER_ID}\n续期前: ${fmt(result.before)}\n最后读取: ${fmt(result.after)}\n尝试次数: ${result.attempts}\n错误: ${result.error || '时间未增加'}`;
  log(msg);
  await tgText(msg);
  process.exit(result.ok ? 0 : 1);
})();
