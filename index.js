const fs = require('fs');
const { spawn } = require('child_process');
const { connect } = require('puppeteer-real-browser');

const TIMER_URL = 'https://client.falixnodes.net/timer?id=2845100';

function log(msg) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] ${msg}`);
}

fs.writeFileSync('status.txt', '失败: 脚本异常中断');
log('脚本启动。');

const vlessLink = process.env.VLESS_LINK;
const falixEmail = process.env.FALIX_EMAIL;
const falixPassword = process.env.FALIX_PASSWORD;

if (!vlessLink) {
    log('错误：未找到 VLESS_LINK！');
    fs.writeFileSync('status.txt', '失败: 未配置 VLESS_LINK');
    process.exit(1);
}
if (!falixEmail || !falixPassword) {
    log('错误：未配置 FALIX_EMAIL 或 FALIX_PASSWORD！');
    fs.writeFileSync('status.txt', '失败: 未配置 FALIX_EMAIL/PASSWORD');
    process.exit(1);
}

// ─── 1. 解析 VLESS ────────────────────────────────────────────────────────────
function parseVless(vless) {
    try {
        const parsed = new URL(vless);
        let uuid = parsed.username;
        if (!uuid) { const m = vless.match(/vless:\/\/([^@]+)@/); if (m) uuid = m[1]; }
        uuid = decodeURIComponent(uuid || '');
        const host = parsed.hostname, port = parseInt(parsed.port) || 443;
        const params = parsed.searchParams;
        const type = params.get('type') || 'tcp', security = params.get('security') || 'none';
        const rawSni = params.get('sni'), rawHost = params.get('host');
        const sni = rawSni || rawHost || host;
        const rawInsecure = params.get('insecure') || params.get('allowInsecure') || '';
        const allowInsecure = (rawInsecure === '1' || rawInsecure.toLowerCase() === 'true');
        const fp = params.get('fp') || '';
        let path = params.get('path') || '';
        if (path) { path = decodeURIComponent(path); if (!path.startsWith('/')) path = '/' + path; }
        const pbk = params.get('pbk') || '', sid = params.get('sid') || '', spx = params.get('spx') || '';
        log(`VLESS -> host=${host} port=${port} type=${type} security=${security}`);
        return { uuid, host, port, type, security, sni, allowInsecure, fp, path, pbk, sid, spx, hostHeader: rawHost || '' };
    } catch (e) {
        log(`VLESS 解析失败: ${e.message}`);
        fs.writeFileSync('status.txt', '失败: VLESS 格式解析错误');
        process.exit(1);
    }
}

const node = parseVless(vlessLink);

// ─── 2. 生成 Xray 配置 ────────────────────────────────────────────────────────
const xrayConfig = {
    log: { loglevel: "warning" },
    inbounds: [{ port: 10808, listen: "127.0.0.1", protocol: "socks", settings: { auth: "noauth", udp: true } }],
    outbounds: [{
        protocol: "vless",
        settings: { vnext: [{ address: node.host, port: node.port, users: [{ id: node.uuid, encryption: "none" }] }] },
        streamSettings: { network: node.type, security: node.security }
    }]
};
const stream = xrayConfig.outbounds[0].streamSettings;
if (node.security === 'tls') {
    stream.tlsSettings = { serverName: node.sni, allowInsecure: node.allowInsecure };
    if (node.fp) stream.tlsSettings.fingerprint = node.fp;
} else if (node.security === 'reality') {
    stream.realitySettings = { show: false, publicKey: node.pbk, shortId: node.sid, serverName: node.sni, spiderX: node.spx };
    if (node.fp) stream.realitySettings.fingerprint = node.fp;
}
if (node.type === 'ws') {
    stream.wsSettings = { path: node.path || "/" };
    if (node.hostHeader) stream.wsSettings.headers = { Host: node.hostHeader };
} else if (node.type === 'tcp') {
    stream.tcpSettings = { header: { type: "none" } };
} else if (node.type === 'grpc') {
    stream.grpcSettings = { serviceName: node.path || "grpc" };
} else if (node.type === 'http' || node.type === 'h2') {
    stream.httpSettings = { path: node.path || "/" };
    if (node.hostHeader) stream.httpSettings.host = [node.hostHeader];
}
fs.writeFileSync('xray_config.json', JSON.stringify(xrayConfig, null, 2));
log('Xray 配置已写入。');

// ─── 3. 启动 Xray ─────────────────────────────────────────────────────────────
let xrayProcess = spawn('./xray-bin/xray', ['-c', 'xray_config.json']);
xrayProcess.stdout.on('data', d => log(`[Xray] ${d.toString().trim()}`));
xrayProcess.stderr.on('data', d => log(`[Xray ERR] ${d.toString().trim()}`));
xrayProcess.on('close', code => log(`Xray 关闭，退出码 ${code}`));
log('等待 3 秒让 Xray 初始化...');

setTimeout(async () => {
    try { await runBrowser(); }
    catch (err) {
        log(`顶层错误: ${err.message}`);
        console.error(err.stack);
        fs.writeFileSync('status.txt', `失败: 脚本运行异常 (${err.message})`);
    } finally {
        xrayProcess.kill();
        process.exit(0);
    }
}, 3000);

// ─── 工具：安全截图（超时保护，不抛异常）────────────────────────────────────
async function safeScreenshot(page, filename, timeout = 15000) {
    try {
        await Promise.race([
            page.screenshot({ path: filename, fullPage: false }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('截图超时')), timeout))
        ]);
        const btns = await page.evaluate(() =>
            Array.from(document.querySelectorAll('button'))
                .filter(b => b.offsetParent !== null)
                .map(b => b.textContent.trim().replace(/\s+/g, ' ').substring(0, 60))
                .filter(t => t)
        ).catch(() => []);
        log(`[截图] ${filename} | 可见button: ${JSON.stringify(btns)}`);
    } catch (e) {
        log(`[截图跳过] ${filename}: ${e.message}`);
    }
}

// ─── 工具：关闭固定定位广告横幅 ─────────────────────────────────────────────
async function dismissAds(page) {
    const n = await page.evaluate(() => {
        let count = 0;
        document.querySelectorAll('*').forEach(el => {
            try {
                const s = window.getComputedStyle(el);
                if ((s.position === 'fixed' || s.position === 'sticky') && s.display !== 'none') {
                    const r = el.getBoundingClientRect();
                    if (r.top > 80 && r.height > 10 && r.height < 200) {
                        el.style.setProperty('display', 'none', 'important');
                        count++;
                    }
                }
            } catch(_) {}
        });
        return count;
    }).catch(() => 0);
    if (n > 0) log(`广告处理: 隐藏了 ${n} 个固定定位元素。`);
}

// ─── 工具：等待 Cloudflare 人机验证通过 ────────────────────────────────────
async function waitForCloudflare(page, ms = 15000) {
    log(`等待 ${ms / 1000} 秒让 Cloudflare 验证通过...`);
    await new Promise(r => setTimeout(r, ms));
}

// ─── 工具：容错版 evaluate ──────────────────────────────────────────────
async function safeEvaluate(page, fn, { retries = 5, retryDelay = 1000, fallback = null, label = 'evaluate' } = {}) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await page.evaluate(fn);
        } catch (e) {
            const isNavError = /Execution context was destroyed|context was destroyed|detached Frame|Target closed|Cannot find context/i.test(e.message);
            if (isNavError && attempt < retries) {
                log(`[${label}] 页面正在跳转导致执行上下文失效，${retryDelay}ms 后重试...`);
                await new Promise(r => setTimeout(r, retryDelay));
                continue;
            }
            log(`[${label}] evaluate 失败: ${e.message}`);
            return fallback;
        }
    }
    return fallback;
}

// ─── 工具：解析时间 ──────────────────────────────────────────────────────────
function parseRemainingTime(text) {
    const full = text.match(/(\d+)\s*hours?\s*(\d+)\s*minutes?\s*(\d+)\s*seconds?/i);
    if (full) {
        const [, h, m, s] = full;
        return { raw: full[0], totalSeconds: (+h) * 3600 + (+m) * 60 + (+s) };
    }
    const short = text.match(/(\d+)\s*hours?\s*(\d+)\s*minutes?/i) || text.match(/(\d+)\s*h\s*(\d+)\s*m/i);
    if (short) {
        const [, h, m] = short;
        return { raw: short[0], totalSeconds: (+h) * 3600 + (+m) * 60 };
    }
    return { raw: '未捕获到具体剩余时间', totalSeconds: null };
}

// ─── 工具：验证并强力输入（防止漏字或吞字）──────────────────────────────────
async function typeAndVerify(page, selector, text, name) {
    for (let i = 0; i < 3; i++) {
        const handle = await page.evaluateHandle((sel) => {
            const els = Array.from(document.querySelectorAll(sel));
            return els.find(el => el.offsetParent !== null) || null;
        }, selector);

        if (!handle || !handle.asElement()) {
            throw new Error(`找不到可见的输入框: ${name}`);
        }

        const el = handle.asElement();
        await el.focus();
        await el.click({ clickCount: 3 });
        await page.keyboard.press('Backspace');
        await new Promise(r => setTimeout(r, 200));
        
        await el.type(text, { delay: 50 });
        await new Promise(r => setTimeout(r, 500));
        
        const val = await page.evaluate(node => node.value, el);
        if (val === text) {
            log(`[验证成功] ${name} 已正确填入。`);
            return true;
        }
        log(`[验证失败] ${name} 输入被吞或未匹配 (当前值: ${val})，正在重试...`);
        await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error(`无法正确输入 ${name}，重试次数超限`);
}

// ─── 工具：操作 Timer 页 ─────────────────────────────────────────────────────
async function readTimerPage(page, screenshotName) {
    log(`导航到 Timer 页: ${TIMER_URL}`);
    await page.goto(TIMER_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    log('Timer 页加载完成，等待 Cloudflare 验证...');
    await waitForCloudflare(page, 15000);
    await dismissAds(page);
    await new Promise(r => setTimeout(r, 500));
    if (screenshotName) await safeScreenshot(page, screenshotName);

    const bodyText = await safeEvaluate(page, () => document.body.innerText, { label: 'readTimerPage', fallback: '' });
    const timeInfo = parseRemainingTime(bodyText);
    log(`剩余时间: ${timeInfo.raw} (总秒数: ${timeInfo.totalSeconds})`);
    return timeInfo;
}

async function clickAddTime(page) {
    log('尝试点击 "Add Time" 按钮...');
    const result = await safeEvaluate(page, () => {
        for (const btn of document.querySelectorAll('button')) {
            const text = btn.textContent.trim().replace(/\s+/g, ' ');
            if ((text === 'Add Time' || text === '+ Add Time') && btn.offsetParent !== null) {
                btn.scrollIntoView({ block: 'center' });
                btn.click();
                return { ok: true, text };
            }
        }
        const allBtns = Array.from(document.querySelectorAll('button'))
            .filter(b => b.offsetParent !== null)
            .map(b => b.textContent.trim().replace(/\s+/g, ' ').substring(0, 60));
        return { ok: false, allBtns };
    }, { label: 'clickAddTime', fallback: { ok: false, allBtns: [] } });
    log(`Add Time 结果: ${JSON.stringify(result)}`);
    return result;
}

async function waitForWatchAdButton(page, maxSeconds = 15) {
    log(`等待 Watch Ad 弹窗出现（最多 ${maxSeconds} 秒）...`);
    for (let i = 0; i < maxSeconds; i++) {
        const found = await safeEvaluate(page, () => {
            for (const btn of document.querySelectorAll('button')) {
                const text = btn.textContent.trim().replace(/\s+/g, ' ');
                if (btn.offsetParent !== null && (text === 'Watch Ad' || text.includes('Watch Ad') || text.includes('Watch Video'))) return true;
            }
            return false;
        }, { label: 'waitForWatchAdButton', retries: 2, fallback: false });
        if (found) { log(`Watch Ad 按钮在第 ${i + 1} 秒出现。`); return true; }
        await new Promise(r => setTimeout(r, 1000));
    }
    return false;
}

async function clickWatchAd(page) {
    log('点击 Watch Ad 按钮...');
    const clicked = await safeEvaluate(page, () => {
        for (const btn of document.querySelectorAll('button')) {
            const text = btn.textContent.trim().replace(/\s+/g, ' ');
            if (btn.offsetParent !== null && (text === 'Watch Ad' || text.includes('Watch Ad') || text.includes('Watch Video'))) {
                btn.scrollIntoView({ block: 'center' });
                btn.click();
                return true;
            }
        }
        return false;
    }, { label: 'clickWatchAd', fallback: false });
    if(clicked) log('Watch Ad 已点击，广告开始请求。');
    else log('警告：未找到 Watch Ad 按钮！');
}

// ─── 工具：智能广告监控并自动点击 Close ──────────────────────────────────────
async function handleAdPlayback(page) {
    log('▶️ 开始智能监控广告状态，寻找关闭按钮，最多等待 90 秒...');
    let adClosed = false;
    let maxWaitSeconds = 90; 
    let checkInterval = 3000;

    for (let i = 0; i < maxWaitSeconds / (checkInterval / 1000); i++) {
        let clicked = false;
        
        // 遍历所有 iframe（包含主页面），寻找跨域的广告弹窗
        for (const frame of page.frames()) {
            try {
                clicked = await frame.evaluate(() => {
                    // 1. 根据文字特征寻找关闭/跳过按钮
                    const els = Array.from(document.querySelectorAll('button, div, span, a'));
                    for (const el of els) {
                        const rect = el.getBoundingClientRect();
                        // 必须是可见的元素，且避免巨大的容器 div
                        if (rect.width === 0 || rect.height === 0 || el.children.length > 2) continue;

                        const text = (el.innerText || el.textContent || '').trim().toLowerCase();
                        const validTexts = ['close', 'close ad', 'skip', 'skip ad', 'x', '×', 'reward granted, close ad', '关闭', '跳过'];
                        
                        if (validTexts.includes(text)) {
                            el.scrollIntoView({ block: 'center' });
                            el.click();
                            return true;
                        }
                    }
                    
                    // 2. 特殊情况：部分广告关闭按钮是没文字的图片/SVG
                    const icons = Array.from(document.querySelectorAll('svg, i, img'));
                    for (const icon of icons) {
                        const className = (icon.getAttribute('class') || '').toLowerCase();
                        const id = (icon.getAttribute('id') || '').toLowerCase();
                        if ((className.includes('close') || id.includes('close')) && !className.includes('container')) {
                            const rect = icon.getBoundingClientRect();
                            if (rect.width > 0 && rect.height > 0) {
                                icon.scrollIntoView({ block: 'center' });
                                if (icon.parentElement) icon.parentElement.click();
                                else icon.click();
                                return true;
                            }
                        }
                    }
                    return false;
                });
                if (clicked) break;
            } catch(e) { } // 忽略无权访问的跨域 iframe 异常
        }

        if (clicked) {
            adClosed = true;
            log('✅ 成功找到了关闭/跳过广告的按钮并已点击！等待 8 秒让回调数据传回服务器...');
            await new Promise(r => setTimeout(r, 8000));
            break; // 点击完成，退出监控循环
        }

        if (i > 0 && i % 5 === 0) {
            log(`⏳ 广告正在播放/监控中... 已经等待 ${i * (checkInterval/1000)} 秒`);
            await safeScreenshot(page, `screenshot_ad_monitor_${i * (checkInterval/1000)}s.png`);
        }
        await new Promise(r => setTimeout(r, checkInterval));
    }

    if (!adClosed) {
        log('⚠️ 90秒超时仍未找到关闭按钮，广告可能已自动关闭，或本次广告无法被自动识别。');
    }
}

function writeRenewResult({ beforeRaw, afterRaw, statusText }) {
    fs.writeFileSync('time_before.txt', beforeRaw || 'N/A');
    fs.writeFileSync('time_after.txt', afterRaw || 'N/A');
    fs.writeFileSync('status.txt', statusText);
    fs.writeFileSync('timer_status.txt', beforeRaw || 'N/A');
}

// ─── 4. 主流程 ───────────────────────────────────────────────────────────────
async function runBrowser() {
    log('准备启动浏览器...');
    
    let browser, page;
    let launchRetries = 3;
    
    for (let i = 0; i < launchRetries; i++) {
        try {
            log(`尝试启动浏览器 (第 ${i + 1}/${launchRetries} 次)...`);
            const browserData = await connect({
                headless: false,
                turnstile: true,
                args: [
                    '--proxy-server=socks5://127.0.0.1:10808',
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--disable-software-rasterizer',
                    '--window-size=1920,1080',
                ],
                disableXvfb: false
            });
            browser = browserData.browser;
            page = browserData.page;
            break; 
        } catch (err) {
            log(`浏览器启动失败: ${err.message}`);
            if (i === launchRetries - 1) throw new Error('浏览器启动重试达到上限，放弃。');
            await new Promise(r => setTimeout(r, 5000));
        }
    }

    await page.setViewport({ width: 1920, height: 1080 });
    page.setDefaultTimeout(120000);
    log('浏览器已成功启动。');

    try {
        // ── 登录 ──
        log('导航到登录页...');
        await page.goto('https://client.falixnodes.net/auth/login', { waitUntil: 'networkidle2', timeout: 60000 });
        await waitForCloudflare(page, 15000);
        await safeScreenshot(page, 'screenshot1_login_before.png');

        log('开始强制校验输入账号密码...');
        await typeAndVerify(page, 'input[name="identifier"], input[type="email"], input[name="email"]', falixEmail, '账号 (Email)');
        await typeAndVerify(page, 'input[name="password"], input[type="password"]', falixPassword, '密码 (Password)');
        
        log('等待 5 秒以确保 React 状态更新且 Turnstile 安全盾已通过...');
        await new Promise(r => setTimeout(r, 5000));
        await safeScreenshot(page, 'screenshot1_login_filled.png');

        log('尝试按 Enter 键提交表单...');
        await page.keyboard.press('Enter');
        
        log('等待 5 秒检查是否发生跳转...');
        await new Promise(r => setTimeout(r, 5000));

        if (page.url().includes('/auth/login')) {
            log('按 Enter 后仍未跳转，尝试精确点击 Sign In 按钮...');
            const btnRect = await page.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('button'));
                let target = btns.find(b => typeof b.className === 'string' && b.className.includes('cl-formButtonPrimary'));
                if (!target) target = btns.find(b => b.textContent.trim() === 'Sign In' && b.offsetParent !== null);
                if (target && !target.disabled) {
                    target.scrollIntoView({ block: 'center' });
                    const rect = target.getBoundingClientRect();
                    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
                }
                return null;
            });
            if (btnRect) {
                await page.mouse.click(btnRect.x, btnRect.y);
                log('已精确点击坐标位置，等待 10 秒...');
                await new Promise(r => setTimeout(r, 10000));
            }
        }
        
        if (page.url().includes('/auth/login')) {
            log('⚠️ 警告：当前仍然在登录页，表单可能提交失败！');
        }

        // ── 第一步：打开 Timer 页，读取续期前剩余时间 ──
        const before = await readTimerPage(page, 'screenshot2_timer_before.png');
        fs.writeFileSync('time_before.txt', before.raw || 'N/A');

        // ── 第二步：点击 "+ Add Time" ──
        const addResult = await clickAddTime(page);
        if (!addResult.ok) {
            log('未找到 "Add Time" 按钮，终止本次续期。');
            await safeScreenshot(page, 'screenshot3_no_addtime.png');
            writeRenewResult({
                beforeRaw: before.raw,
                afterRaw: 'N/A',
                statusText: '❌ 续期失败: 未找到 Add Time 按钮 (可能登录未成功)'
            });
            return;
        }

        log('Add Time 点击完毕，缓冲等待 5 秒检查是否有页面跳转拦截...');
        await new Promise(r => setTimeout(r, 5000));
        await waitForCloudflare(page, 5000);

        // 拦截机制：如果跳转去了容器页面，说明时间已满
        const currentUrlAfterAdd = page.url();
        if (!currentUrlAfterAdd.includes('/timer')) {
            log(`⚠️ 页面从 Timer 跳转到了 ${currentUrlAfterAdd}`);
            log('这通常意味着时间已达服务器设定的最大上限，面板自动阻断了广告请求。');
            await safeScreenshot(page, 'screenshot3_redirected_to_server.png');
            writeRenewResult({
                beforeRaw: before.raw,
                afterRaw: before.raw,
                statusText: '✅ 续期完成: 返回了主面板界面 (时间可能已达最大上限)'
            });
            return;
        }

        // ── 第三步：等待 "Watch Ad to Extend Timer" 弹窗 ──
        const dialogShown = await waitForWatchAdButton(page, 20);
        if (!dialogShown) {
            log('未出现 Watch Ad 弹窗，可能剩余时间已接近上限，或者被防机器拦截。');
            await safeScreenshot(page, 'screenshot3_no_dialog.png');
            writeRenewResult({
                beforeRaw: before.raw,
                afterRaw: before.raw,
                statusText: '⚠️ 无需续期: 未出现 Watch Ad 弹窗（可能剩余时间接近上限）'
            });
            return;
        }
        await safeScreenshot(page, 'screenshot3_watch_ad_dialog.png');

        // ── 第四步：点击 Watch Ad，开启智能广告播放与关闭监控 ──
        await clickWatchAd(page);
        
        // 关键改进：自动扫描并点击关闭按钮
        await handleAdPlayback(page);
        await safeScreenshot(page, 'screenshot4_after_ad_handled.png');

        // ── 第五步：重新回到 Timer 页，读取续期后剩余时间 ──
        const after = await readTimerPage(page, 'screenshot5_timer_after.png');

        // ── 第六步：对比前后时间，判断续期是否成功 ──
        let statusText;
        if (before.totalSeconds === null || after.totalSeconds === null) {
            statusText = '⚠️ 无法判断: 未能正确解析剩余时间文本，请查看截图确认';
        } else if (after.totalSeconds > before.totalSeconds) {
            log(`续期成功！剩余时间从 ${before.raw} 增加到 ${after.raw}`);
            statusText = '✅ 续期成功: 剩余时间已增加';
        } else {
            log(`续期失败，剩余时间未增加（续期前: ${before.raw}，续期后: ${after.raw}）`);
            statusText = '❌ 续期失败: 观看广告后剩余时间未增加';
        }

        writeRenewResult({ beforeRaw: before.raw, afterRaw: after.raw, statusText });

    } catch (e) {
        log(`异常: ${e.message}`);
        console.error(e.stack);
        writeRenewResult({
            beforeRaw: fs.existsSync('time_before.txt') ? fs.readFileSync('time_before.txt', 'utf8') : 'N/A',
            afterRaw: 'N/A',
            statusText: `❌ 续期失败: 运行异常 (${e.message})`
        });
        if (page) await safeScreenshot(page, 'screenshot_error.png');
    } finally {
        log('关闭浏览器...');
        if (browser) await browser.close();
    }
}
