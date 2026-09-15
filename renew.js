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

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function run() {
  let initialTimeText = '未知';
  let finalTimeText = '未知';
  let initialSeconds = 0;
  let finalSeconds = 0;
  let isSuccess = false;

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
    await sleep(3000);

    await page.waitForSelector('input[type="email"], input[name="email"], input[placeholder*="email" i]', { timeout: 15000 });
    await page.type('input[type="email"], input[name="email"], input[placeholder*="email" i]', EMAIL);
    await page.type('input[type="password"]', PASSWORD);

    // 等待 CF 自动验证
    await sleep(6000);

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
        console.log('未找到或无法点击 [Add Time] 按钮');
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
<b>状态:</b> ${isSuccess ? '已成功续期（时间已增加）' : '重试 3 次后时间仍未增加'}
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
