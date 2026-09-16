const { connect } = require('puppeteer-real-browser');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const EMAIL = process.env.FALIX_EMAIL;
const PASSWORD = process.env.FALIX_PASSWORD;
const SERVER_ID = process.env.SERVER_ID || '2845100';
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const IS_PROXY = process.env.IS_PROXY === 'true';

const TIMER_URL = `https://client.falixnodes.net/timer?id=${SERVER_ID}`;
const LOGIN_URL = 'https://client.falixnodes.net/auth/login';
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 辅助：解析 "108 hours 28 minutes 27 seconds" 为总秒数
function parseTimeToSeconds(text) {
  if (!text) return 0;
  const hMatch = text.match(/(\d+)\s*hours?/i);
  const mMatch = text.match(/(\d+)\s*minutes?/i);
  const sMatch = text.match(/(\d+)\s*seconds?/i);

  const hours = hMatch ? parseInt(hMatch[1], 10) : 0;
  const minutes = mMatch ? parseInt(mMatch[1], 10) : 0;
  const seconds = sMatch ? parseInt(sMatch[1], 10) : 0;

  return hours * 3600 + minutes * 60 + seconds;
}

// 辅助：从页面中提取时间字符串
async function extractTimerText(page) {
  try {
    const textContent = await page.evaluate(() => document.body.innerText);
    const match = textContent.match(/(\d+\s*hours?\s*\d+\s*minutes?\s*\d+\s*seconds?)/i);
    return match ? match[1] : null;
  } catch (e) {
    return null;
  }
}

/**
 * 用原生 value setter 一次性把值注入到输入框，并触发 input/change 事件。
 * 这样绕开了"一个字符一个字符模拟按键"的过程，不存在"打到一半被打断"的问题——
 * 这是解决"输入内容随机被截断/篡改"最根本的办法（普通的 page.type 本质是逐键发送
 * 键盘事件，很容易被页面上其他异步脚本、Cloudflare 校验等打断，且打断点是随机的）。
 *
 * React/Vue 等框架会重写 input 的 value setter 来做双向绑定追踪，所以如果直接
 * `input.value = xxx` 通常不会被框架检测到（onChange 不会触发）。这里通过
 * Object.getOwnPropertyDescriptor 拿到 HTMLInputElement 原生的 setter 来绕过框架
 * 的拦截，再手动 dispatch 'input' 和 'change' 事件，让框架能正确感知到这次变化。
 */
async function injectValue(page, selector, value) {
  await page.evaluate((sel, val) => {
    const input = document.querySelector(sel);
    if (!input) return false;
    const proto = window.HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    input.focus();
    nativeSetter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    nativeSetter.call(input, val);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, selector, value);
}

/**
 * 稳定输入函数（升级版）：
 * 1. 用 injectValue 一次性注入完整值（而不是逐字模拟打字）
 * 2. 注入后做"两次延时校验"：立刻读一次，再等 300ms 读一次
 *    —— 如果页面上有脚本会异步把值改掉/清空，两次读取就能发现不一致
 * 3. 只要任意一次校验不通过，就整体重新注入，最多重试 maxRetries 次
 * 4. 全部失败后，兜底尝试原来的逐字模拟打字方式，以防个别站点必须要"真实按键事件"
 */
async function safeType(page, selector, text, { maxRetries = 8, label = '' } = {}) {
  for (let i = 1; i <= maxRetries; i++) {
    const exists = await page.$(selector);
    if (!exists) {
      console.log(`[${label}] 未找到输入框，等待后重试 (${i}/${maxRetries})`);
      await sleep(1000);
      continue;
    }

    try {
      await injectValue(page, selector, text);

      const val1 = await page.$eval(selector, e => e.value).catch(() => null);
      await sleep(300);
      const val2 = await page.$eval(selector, e => e.value).catch(() => null);

      if (val1 === text && val2 === text) {
        console.log(`[${label}] 注入并二次校验通过 ✅`);
        return true;
      } else {
        console.log(`[${label}] 第 ${i} 次注入后校验未通过（第一次读到: "${val1}"，300ms 后读到: "${val2}"，期望: "${text}"），重试...`);
        await sleep(600);
      }
    } catch (err) {
      console.log(`[${label}] 注入过程中出现异常: ${err.message}，重试中...`);
      await sleep(1000);
    }
  }

  // 兜底方案：逐字模拟打字（延迟更长），以防站点对 input 事件来源有额外校验
  console.log(`[${label}] JS 注入方式多次失败，尝试兜底的逐字打字方式...`);
  for (let i = 1; i <= 3; i++) {
    const el = await page.$(selector);
    if (!el) { await sleep(1000); continue; }
    try {
      await el.click({ clickCount: 3 });
      await page.keyboard.press('Backspace');
      await sleep(200);
      await el.type(text, { delay: 150 });
      await sleep(500);
      const actualValue = await page.$eval(selector, e => e.value).catch(() => null);
      if (actualValue === text) {
        console.log(`[${label}] 兜底逐字打字校验通过 ✅`);
        return true;
      }
      console.log(`[${label}] 兜底方式第 ${i} 次仍不匹配，实际内容: "${actualValue}"`);
    } catch (err) {
      console.log(`[${label}] 兜底打字异常: ${err.message}`);
    }
    await sleep(800);
  }

  return false;
}

// 仅发送 Telegram 纯文字通知
async function sendTelegramNotification(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    console.log('未配置 Telegram 凭据，跳过发送 TG 通知。');
    return;
  }
  try {
    await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      chat_id: TG_CHAT_ID,
      text: text,
      parse_mode: 'HTML'
    });
    console.log('TG 纯文字通知发送成功');
  } catch (err) {
    console.error('发送 TG 消息失败:', err.message);
  }
}

async function run() {
  let initialTimeText = '未知';
  let finalTimeText = '未知';
  let initialSeconds = 0;
  let finalSeconds = 0;
  let isSuccess = false;
  let loginSuccess = false;

  console.log('正在启动浏览器...');
  const browserArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--window-size=1920,1080'
  ];

  if (IS_PROXY) {
    browserArgs.push('--proxy-server=socks5://127.0.0.1:1080');
    console.log('浏览器已挂载本地代理: socks5://127.0.0.1:1080');
  }

  const { browser, page } = await connect({
    headless: false,
    args: browserArgs,
    turnstile: true
  });

  try {
    await page.setViewport({ width: 1920, height: 1080 });

    // 1. 登录
    console.log('正在访问登录页面...');
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    // 页面刚加载完成时，Cloudflare 验证脚本和前端框架（React/Vue 等）可能还在
    // 初始化/重新渲染 DOM，过早输入很容易被打断（这正是截图里邮箱只剩 "af" 的原因）。
    // 这里先多等一会，让页面彻底稳定下来。
    await sleep(5000);

    const EMAIL_SELECTOR = 'input[type="email"], input[name="email"], input[placeholder*="email" i]';
    const PASSWORD_SELECTOR = 'input[type="password"]';

    await page.waitForSelector(EMAIL_SELECTOR, { timeout: 20000, visible: true });
    await page.waitForSelector(PASSWORD_SELECTOR, { timeout: 20000, visible: true });

    // 使用稳定输入函数，输入后自动校验+重试
    const emailOk = await safeType(page, EMAIL_SELECTOR, EMAIL, { label: '邮箱' });
    const passwordOk = await safeType(page, PASSWORD_SELECTOR, PASSWORD, { label: '密码' });

    if (!emailOk || !passwordOk) {
      console.log('⚠️ 邮箱或密码多次重试后仍未能正确输入，仍尝试继续流程（可能导致登录失败）。');
    }

    // 等待 CF 自动验证（Turnstile）完成
    console.log('等待 Cloudflare 验证通过...');
    await sleep(6000);

    // 提交前最后一次校验：如果这段等待期间值又被改动了，立刻重新注入一次，
    // 尽量缩短"确认无误"到"点击提交"之间的时间窗口。
    const emailValBeforeSubmit = await page.$eval(EMAIL_SELECTOR, e => e.value).catch(() => null);
    const pwdValBeforeSubmit = await page.$eval(PASSWORD_SELECTOR, e => e.value).catch(() => null);
    if (emailValBeforeSubmit !== EMAIL) {
      console.log(`提交前发现邮箱值被改动（当前: "${emailValBeforeSubmit}"），重新注入...`);
      await injectValue(page, EMAIL_SELECTOR, EMAIL);
      await sleep(300);
    }
    if (pwdValBeforeSubmit !== PASSWORD) {
      console.log('提交前发现密码值被改动，重新注入...');
      await injectValue(page, PASSWORD_SELECTOR, PASSWORD);
      await sleep(300);
    }

    const submitBtn = await page.$('button[type="submit"]');
    if (submitBtn) {
      await submitBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }

    await sleep(8000);

    // 保存截图 1：登录结果（供 GitHub Artifacts 下载）
    const loginPic = path.join(SCREENSHOT_DIR, '01_login_result.png');
    await page.screenshot({ path: loginPic, fullPage: true });
    console.log('已保存关键截图 1：登录结果');

    // 简单判断是否登录成功：登录后地址不再停留在 /auth/login
    const currentUrl = page.url();
    loginSuccess = !currentUrl.includes('/auth/login');
    console.log(`登录后当前地址: ${currentUrl}，判定登录${loginSuccess ? '成功' : '失败'}`);

    // 2. 循环续期与重试（最多 3 次）
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`\n================= 第 ${attempt} 次续期尝试 =================`);

      await page.goto(TIMER_URL, { waitUntil: 'networkidle2', timeout: 60000 });
      await sleep(4000);

      // 保存截图 2：转到续期页面
      if (attempt === 1) {
        const timerPic = path.join(SCREENSHOT_DIR, '02_timer_page.png');
        await page.screenshot({ path: timerPic, fullPage: true });
        console.log('已保存关键截图 2：续期初始页面');

        const curText = await extractTimerText(page);
        if (curText) {
          initialTimeText = curText;
          initialSeconds = parseTimeToSeconds(curText);
          console.log(`续期前时间: ${initialTimeText} (换算为 ${initialSeconds} 秒)`);
        }
      }

      // 等待 CF 验证框通过
      console.log('等待 Cloudflare 验证通过...');
      await sleep(8000);

      // 点击 Add Time 按钮
      const clicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const btn = buttons.find(b => b.innerText && b.innerText.includes('Add Time'));
        if (btn && !btn.disabled) {
          btn.click();
          return true;
        }
        return false;
      });

      if (clicked) {
        console.log('已成功点击 [Add Time] 按钮，等待响应跳转...');
        await sleep(10000);
      } else {
        console.log('未找到或无法点击 [Add Time] 按钮（如果尚未登录成功，这里通常会失败）');
      }

      // 重新打开 Timer 页面确认时间是否增加
      console.log('重新加载 Timer 页面验证时间...');
      await page.goto(TIMER_URL, { waitUntil: 'networkidle2', timeout: 60000 });
      await sleep(4000);

      const afterText = await extractTimerText(page);
      if (afterText) {
        finalTimeText = afterText;
        finalSeconds = parseTimeToSeconds(afterText);
        console.log(`续期后读取到时间: ${finalTimeText} (换算为 ${finalSeconds} 秒)`);
      }

      // 真正判断时间是否增加（增加了至少 60 秒以上）
      if (finalSeconds > initialSeconds + 60) {
        console.log('✅ 判定成功：时间已成功增加！');
        isSuccess = true;
        break;
      } else {
        console.log(`⚠️ 第 ${attempt} 次尝试后时间未增加 (当前: ${finalSeconds}s <= 初始: ${initialSeconds}s)`);
        if (attempt < 3) {
          console.log('等待 5 秒后重试...');
          await sleep(5000);
        }
      }
    }

    // 保存截图 3：最后确认页面
    const finalPic = path.join(SCREENSHOT_DIR, '03_final_confirmation.png');
    await page.screenshot({ path: finalPic, fullPage: true });
    console.log('已保存关键截图 3：最终确认页面');

    // 仅发送 Telegram 纯文字汇总通知
    const statusEmoji = isSuccess ? '🎉' : '❌';
    const tgMessage = `
<b>${statusEmoji} FalixNodes 续期${isSuccess ? '成功' : '失败'}通知</b>
——————————————
<b>登录状态:</b> ${loginSuccess ? '成功' : '失败（请检查账号密码或截图）'}
<b>续期状态:</b> ${isSuccess ? '已成功续期（时间已增加）' : '重试 3 次后时间仍未增加'}
<b>续期前时间:</b> <code>${initialTimeText}</code>
<b>续期后时间:</b> <code>${finalTimeText}</code>
<b>服务器 ID:</b> <code>${SERVER_ID}</code>
<b>执行时间:</b> ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
    `.trim();

    await sendTelegramNotification(tgMessage);

  } catch (err) {
    console.error('运行异常:', err);
    await sendTelegramNotification(`❌ <b>FalixNodes 脚本运行异常</b>\n报错: <code>${err.message}</code>`);
  } finally {
    await browser.close();
    console.log('浏览器已退出。');
  }
}

run();
