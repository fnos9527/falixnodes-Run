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
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return false;
  try {
    const fd = new FormData();
    fd.append('chat_id', TG_CHAT_ID);
    fd.append('caption', caption.slice(0, 1000));
    fd.append('photo', new Blob([fs.readFileSync(file)]), 'shot.png');
    const r = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto`, { method: 'POST', body: fd });
    return r.ok;
  } catch (e) { log('TG 图片发送失败', e.message); return false; }
}
// 截图只保存到 shots/，不发送
let lastShot = null;
async function shot(page, name) {
  const file = `shots/${name}.png`;
  try { await page.screenshot({ path: file }); lastShot = file; }
  catch (e) { log('截图失败', e.message); }
}
// 全流程只发一条 TG：有截图就发「截图+文字」，否则发文字
async function tgFinal(msg) {
  if (lastShot && fs.existsSync(lastShot) && await tgPhoto(lastShot, msg)) return;
  await tgText(msg);
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

// 等待 Cloudflare 整页挑战(Just a moment...)结束；卡住则刷新一次
async function waitCF(page, maxMs = 90000) {
  const start = Date.now();
  let reloaded = 0;
  while (Date.now() - start < maxMs) {
    const t = await page.title().catch(() => '');
    const b = await page.evaluate(() => (document.body ? document.body.innerText.slice(0, 200) : '')).catch(() => '');
    const challenge = /just a moment|attention required/i.test(t) || /verifying you are human|performing security verification/i.test(b);
    if (!challenge) return true;
    if (reloaded < 1 && Date.now() - start > 40000) {
      reloaded++;
      log('CF 挑战卡住，刷新页面重试');
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    }
    await sleep(2000);
  }
  log('CF 挑战等待超时');
  return false;
}

async function gotoCF(page, url) {
  for (let i = 0; i < 2; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      break;
    } catch (e) {
      log(`打开 ${url} 失败(${e.message})${i === 0 ? '，重试' : ''}`);
      if (i === 1) throw e;
      await sleep(3000);
    }
  }
  await waitCF(page);
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

// 直接赋值(不依赖焦点，不会被 turnstile 的后台点击打断)，并回读校验
async function setValue(page, sel, val) {
  for (let i = 0; i < 3; i++) {
    await page.evaluate((sel, val) => {
      const el = document.querySelector(sel);
      if (!el) return;
      el.focus();
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    }, sel, val).catch(() => {});
    const cur = await page.evaluate((sel) => (document.querySelector(sel) || {}).value, sel).catch(() => null);
    if (cur === val) return true;
    await sleep(500);
  }
  return false;
}

// 等待 Turnstile token（不干预页面，由 turnstile:true 自动点击）
async function solveTurnstile(page) {
  return waitTurnstile(page, 45000);
}

async function login(page) {
  if (!FALIX_EMAIL || !FALIX_PASSWORD) throw new Error('缺少 FALIX_EMAIL / FALIX_PASSWORD');
  const email = FALIX_EMAIL.replace(/[\r\n]+$/g, '');
  const pass = FALIX_PASSWORD.replace(/[\r\n]+$/g, '');
  const emailSel = 'input[type="email"], input[name="email"], input[autocomplete="username"], input:not([type="password"]):not([type="hidden"]):not([type="checkbox"]):not([type="submit"])';
  const passSel = 'input[type="password"]';

  for (let attempt = 1; attempt <= 3; attempt++) {
    log(`账号密码登录，第 ${attempt} 轮`);
    if (attempt === 1 && page.url().includes('/auth/login')) await waitCF(page);
    else await gotoCF(page, LOGIN_URL);

    let found = false;
    for (let i = 0; i < 60; i++) {
      found = await page.evaluate((sel) => !!document.querySelector(sel), emailSel).catch(() => false);
      if (found) break;
      await sleep(1000);
    }
    if (!found) { await debug(page, `login-no-input-${attempt}`, '登录页找不到输入框'); continue; }
    await sleep(3000); // 等页面和验证框渲染稳定

    log('等待 CF 验证…');
    const ok = await solveTurnstile(page);
    log('CF 验证结果:', ok);
    if (!ok) { await debug(page, `login-turnstile-failed-${attempt}`, `第 ${attempt} 轮 Turnstile 未通过`); continue; }

    const a1 = await setValue(page, emailSel, email);
    const b1 = await setValue(page, passSel, pass);
    log(`邮箱填写${a1 ? '成功' : '失败'}(长度 ${email.length})，密码填写${b1 ? '成功' : '失败'}(长度 ${pass.length})`);

    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      const btn = btns.find((b) => /^sign\s*in$/i.test(b.innerText.trim())) || btns.find((b) => b.type === 'submit');
      if (btn) btn.click();
    });
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      if (!page.url().includes('/auth/login')) break;
    }
    await sleep(2000);
    if (!page.url().includes('/auth/login')) {
      await shot(page, 'login', '✅ 登录成功截图');
      await saveCookies(page);
      return;
    }
    await debug(page, `login-failed-${attempt}`, `第 ${attempt} 轮登录失败`);
  }
  throw new Error('登录失败，3 轮均停留在登录页');
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
      args: [`--proxy-server=${PROXY}`, '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--webrtc-ip-handling-policy=disable_non_proxied_udp'],
    });
    browser = conn.browser;
    page = conn.page;

    // 1. 优先用 Cookie
    const hadCookie = await loadCookies(page);
    await gotoCF(page, TIMER_URL);
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
        await gotoCF(page, TIMER_URL);
        await sleep(3000);
        if (page.url().includes('/auth/login')) { await login(page); await gotoCF(page, TIMER_URL); }

        const before = await getRemaining(page);
        if (result.before == null) result.before = before;
        log('续期前剩余:', fmt(before));
        if (before == null) throw new Error('读取不到剩余时间');

        await waitTurnstile(page, 60000);
        const clicked = await clickAddTime(page);
        if (!clicked) throw new Error('未找到 Add Time 按钮');
        log('已点击 Add Time');
        await sleep(2500);

        await gotoCF(page, TIMER_URL);
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
  await tgFinal(msg);
  process.exit(result.ok ? 0 : 1);
})();
