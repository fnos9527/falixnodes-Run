const { connect } = require('puppeteer-real-browser');
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');

const EMAIL = process.env.FALIX_EMAIL;
const PASSWORD = process.env.FALIX_PASSWORD;
const SERVER_ID = process.env.SERVER_ID || '2845100';
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const IS_PROXY = process.env.IS_PROXY === 'true';

const TIMER_URL = `https://client.falixnodes.net/timer?id=${SERVER_ID}`;
const LOGIN_URL = 'https://client.falixnodes.net/auth/login';

// 发送 Telegram 消息与图片
async function sendTelegramNotification(text, photoPaths = []) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    console.log('未配置 Telegram 凭据，跳过通知。');
    return;
  }
  try {
    // 发送文字
    await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      chat_id: TG_CHAT_ID,
      text: text,
      parse_mode: 'HTML'
    });

    // 发送截图
    for (const photoPath of photoPaths) {
      if (fs.existsSync(photoPath)) {
        const form = new FormData();
        form.append('chat_id', TG_CHAT_ID);
        form.append('photo', fs.createReadStream(photoPath));
        await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto`, form, {
          headers: form.getHeaders()
        });
      }
    }
  } catch (err) {
    console.error('发送 TG 消息失败:', err.message);
  }
}

// 延迟辅助函数
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function run() {
  const screenshots = [];
  let beforeTimeText = '未知';
  let afterTimeText = '未知';
  let isSuccess = false;

  console.log('启动浏览器...');
  const browserArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--window-size=1920,1080'
  ];

  if (IS_PROXY) {
    browserArgs.push('--proxy-server=socks5://127.0.0.1:1080');
    console.log('已启用代理: socks5://127.0.0.1:1080');
  }

  const { browser, page } = await connect({
    headless: false,
    args: browserArgs,
    turnstile: true
  });

  try {
    await page.setViewport({ width: 1920, height: 1080 });

    // 1. 登录流程
    console.log('正在打开登录页...');
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(3000);

    // 输入账号密码
    await page.waitForSelector('input[type="email"], input[name="email"], input[placeholder*="email" i]', { timeout: 15000 });
    await page.type('input[type="email"], input[name="email"], input[placeholder*="email" i]', EMAIL);
    await page.type('input[type="password"]', PASSWORD);

    // 等待 CF 验证自动处理
    await sleep(5000);

    // 点击登录按钮
    const submitBtn = await page.$('button[type="submit"]');
    if (submitBtn) {
      await submitBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }

    // 等待登录跳转完成
    await sleep(8000);
    const loginScreenshot = 'login_result.png';
    await page.screenshot({ path: loginScreenshot, fullPage: true });
    screenshots.push(loginScreenshot);
    console.log('登录阶段已截图');

    // 2. 续期重试逻辑 (最多重试 3 次)
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`\n--- 开始第 ${attempt} 次续期尝试 ---`);

      // 导航到续期页面
      await page.goto(TIMER_URL, { waitUntil: 'networkidle2', timeout: 60000 });
      await sleep(4000);

      // 截图：进入续期页面
      const timerPageScreenshot = `timer_page_attempt_${attempt}.png`;
      await page.screenshot({ path: timerPageScreenshot, fullPage: true });
      if (attempt === 1) {
        screenshots.push(timerPageScreenshot);
      }

      // 获取当前剩余时间文本
      try {
        const timeElement = await page.$('div:has(> span), h1, h2, div');
        const textContent = await page.evaluate(() => document.body.innerText);
        const match = textContent.match(/(\d+\s*hours?\s*\d+\s*minutes?\s*\d+\s*seconds?)/i);
        if (match) {
          if (attempt === 1) beforeTimeText = match[1];
          console.log(`当前读取到的时间: ${match[1]}`);
        }
      } catch (e) {
        console.log('提取时间文本异常:', e.message);
      }

      // 等待并处理 CF 验证框
      await sleep(6000);

      // 查找并点击 "Add Time" 按钮
      const addTimeClicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const btn = buttons.find(b => b.innerText.includes('Add Time'));
        if (btn && !btn.disabled) {
          btn.click();
          return true;
        }
        return false;
      });

      if (addTimeClicked) {
        console.log('已点击 Add Time 按钮，等待响应跳转...');
        await sleep(8000);
      } else {
        console.log('未找到或无法点击 Add Time 按钮');
      }

      // 3. 重新进入 Timer 页面校验时间是否增加
      console.log('重新进入 Timer 页面验证时间...');
      await page.goto(TIMER_URL, { waitUntil: 'networkidle2', timeout: 60000 });
      await sleep(4000);

      const verifyScreenshot = `timer_final_attempt_${attempt}.png`;
      await page.screenshot({ path: verifyScreenshot, fullPage: true });

      const verifyTextContent = await page.evaluate(() => document.body.innerText);
      const verifyMatch = verifyTextContent.match(/(\d+\s*hours?\s*\d+\s*minutes?\s*\d+\s*seconds?)/i);

      if (verifyMatch) {
        afterTimeText = verifyMatch[1];
        console.log(`续期后时间: ${afterTimeText}`);

        // 比对时间文本变动
        if (beforeTimeText !== '未知' && afterTimeText !== beforeTimeText) {
          console.log('时间已成功增加！');
          isSuccess = true;
          screenshots.push(verifyScreenshot);
          break;
        } else if (attempt === 3) {
          screenshots.push(verifyScreenshot);
        }
      } else {
        if (attempt === 3) screenshots.push(verifyScreenshot);
      }

      if (!isSuccess && attempt < 3) {
        console.log('时间未检测到增加，等待 5 秒后进行下一次重试...');
        await sleep(5000);
      }
    }

    // 4. 发送通知
    const statusEmoji = isSuccess ? '✅' : '⚠️';
    const tgMessage = `
<b>${statusEmoji} FalixNodes 服务器续期通知</b>
——————————————
<b>状态:</b> ${isSuccess ? '续期成功' : '续期未完成或时间无变动'}
<b>续期前时间:</b> <code>${beforeTimeText}</code>
<b>续期后时间:</b> <code>${afterTimeText}</code>
<b>服务器 ID:</b> <code>${SERVER_ID}</code>
<b>执行时间:</b> ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
    `.trim();

    await sendTelegramNotification(tgMessage, screenshots);

  } catch (error) {
    console.error('执行过程出错:', error);
    await sendTelegramNotification(`❌ <b>FalixNodes 续期脚本运行异常</b>\n错误详情: <code>${error.message}</code>`, screenshots);
  } finally {
    await browser.close();
    console.log('浏览器已退出。');
  }
}

run();
