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

// ─── 1. 解析 VLESS ────────────────────────────────────────────────────────────
const vlessLink = process.env.VLESS_LINK;
if (!vlessLink) {
    log('错误：未找到 VLESS_LINK！');
    fs.writeFileSync('status.txt', '失败: 未配置 VLESS_LINK');
    process.exit(1);
}

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
                    // 只隐藏底部广告横幅（顶部 80px 以下，高度小于 200px）
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

// ─── 工具：等待 Cloudflare 人机验证通过（固定等待，配合 turnstile:true 自动过验证）──
async function waitForCloudflare(page, ms = 15000) {
    log(`等待 ${ms / 1000} 秒让 Cloudflare 验证通过...`);
    await new Promise(r => setTimeout(r, ms));
}

// ─── 工具：容错版 page.evaluate ──────────────────────────────────────────────
// 点击按钮后页面可能会发生一次跳转/刷新，此时 evaluate 会抛出
// "Execution context was destroyed, most likely because of a navigation."
// 这类错误本质是"页面正在跳转，稍等即可"，不代表操作失败，因此这里做自动重试。
async function safeEvaluate(page, fn, { retries = 5, retryDelay = 1000, fallback = null, label = 'evaluate' } = {}) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await page.evaluate(fn);
        } catch (e) {
            const isNavError = /Execution context was destroyed|context was destroyed|detached Frame|Target closed|Cannot find context/i.test(e.message);
            if (isNavError && attempt < retries) {
                log(`[${label}] 页面正在跳转导致执行上下文失效，${retryDelay}ms 后重试 (${attempt + 1}/${retries})...`);
                await new Promise(r => setTimeout(r, retryDelay));
                continue;
            }
            log(`[${label}] evaluate 失败: ${e.message}`);
            return fallback;
        }
    }
    return fallback;
}

// ─── 工具：将 "X hours Y minutes Z seconds" 解析为总秒数，便于前后对比 ──────
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

// ─── 工具：打开 Timer 页并读取当前剩余时间（登录后可反复调用）─────────────────
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

// ─── 工具：点击 "+ Add Time" 按钮 ────────────────────────────────────────────
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

// ─── 工具：等待 "Watch Ad to Extend Timer" 弹窗中的 Watch Ad 按钮出现 ────────
async function waitForWatchAdButton(page, maxSeconds = 15) {
    log(`等待 Watch Ad 弹窗出现（最多 ${maxSeconds} 秒）...`);
    for (let i = 0; i < maxSeconds; i++) {
        const found = await safeEvaluate(page, () => {
            for (const btn of document.querySelectorAll('button')) {
                const text = btn.textContent.trim().replace(/\s+/g, ' ');
                if (btn.offsetParent !== null && (text === 'Watch Ad' || text.includes('Watch Ad'))) return true;
            }
            return false;
        }, { label: 'waitForWatchAdButton', retries: 2, fallback: false });
        if (found) { log(`Watch Ad 按钮在第 ${i + 1} 秒出现。`); return true; }
        await new Promise(r => setTimeout(r, 1000));
    }
    log(`${maxSeconds} 秒内未出现 Watch Ad 按钮。`);
    return false;
}

// ─── 工具：点击 Watch Ad 按钮 ────────────────────────────────────────────────
async function clickWatchAd(page) {
    log('点击 Watch Ad 按钮...');
    await safeEvaluate(page, () => {
        for (const btn of document.querySelectorAll('button')) {
            const text = btn.textContent.trim().replace(/\s+/g, ' ');
            if (btn.offsetParent !== null && (text === 'Watch Ad' || text.includes('Watch Ad'))) {
                btn.scrollIntoView({ block: 'center' });
                btn.click();
                return true;
            }
        }
        return false;
    }, { label: 'clickWatchAd', fallback: false });
    log('Watch Ad 已点击，广告开始播放。');
}

// ─── 工具：写入本次续期结果，供 Telegram 通知步骤读取 ────────────────────────
function writeRenewResult({ beforeRaw, afterRaw, statusText }) {
    fs.writeFileSync('time_before.txt', beforeRaw || 'N/A');
    fs.writeFileSync('time_after.txt', afterRaw || 'N/A');
    fs.writeFileSync('status.txt', statusText);
    // 兼容旧字段
    fs.writeFileSync('timer_status.txt', beforeRaw || 'N/A');
}

// ─── 4. 主流程 ───────────────────────────────────────────────────────────────
async function runBrowser() {
    log('启动浏览器（1920×1080）...');
    const { page, browser } = await connect({
        headless: false,
        turnstile: true,
        args: [
            '--proxy-server=socks5://127.0.0.1:10808',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--window-size=1920,1080',
        ],
        disableXvfb: false
    });
    await page.setViewport({ width: 1920, height: 1080 });
    page.setDefaultTimeout(120000);
    log('浏览器已启动。');

    try {
        // ── 登录 ──
        log('导航到登录页...');
        await page.goto('https://client.falixnodes.net/auth/login', { waitUntil: 'networkidle2', timeout: 60000 });
        await waitForCloudflare(page, 15000);
        await safeScreenshot(page, 'screenshot1_login.png');

        const emailInput = await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 15000 });
        await emailInput.type(process.env.FALIX_EMAIL);
        const passwordInput = await page.waitForSelector('input[type="password"], input[name="password"]', { timeout: 15000 });
        await passwordInput.type(process.env.FALIX_PASSWORD);
        const signInBtn = await page.waitForSelector('button[type="submit"]', { timeout: 15000 });
        await signInBtn.click();
        log('已点击登录，等待 10 秒...');
        await new Promise(r => setTimeout(r, 10000));
        log('当前 URL: ' + page.url());

        // ── 第一步：打开 Timer 页，读取续期前剩余时间 ──
        const before = await readTimerPage(page, 'screenshot2_timer_before.png');
        // 立刻写盘：即使后面步骤异常中断，通知里也能看到真实的续期前时间
        fs.writeFileSync('time_before.txt', before.raw || 'N/A');

        // ── 第二步：点击 "+ Add Time" ──
        const addResult = await clickAddTime(page);
        if (!addResult.ok) {
            log('未找到 "Add Time" 按钮，终止本次续期。');
            await safeScreenshot(page, 'screenshot3_no_addtime.png');
            writeRenewResult({
                beforeRaw: before.raw,
                afterRaw: 'N/A',
                statusText: '❌ 续期失败: 未找到 Add Time 按钮'
            });
            return;
        }

        // 点击后页面可能触发一次跳转/刷新（新版页面常见），先缓冲等待，
        // 避免紧接着的 evaluate 恰好撞在导航中途。
        await new Promise(r => setTimeout(r, 2000));

        // ── 第三步：等待 "Watch Ad to Extend Timer" 弹窗 ──
        const dialogShown = await waitForWatchAdButton(page, 20);
        if (!dialogShown) {
            log('未出现 Watch Ad 弹窗，可能剩余时间已接近上限，无需续期。');
            await safeScreenshot(page, 'screenshot3_no_dialog.png');
            writeRenewResult({
                beforeRaw: before.raw,
                afterRaw: before.raw,
                statusText: '⚠️ 无需续期: 未出现 Watch Ad 弹窗（剩余时间可能已接近上限）'
            });
            return;
        }
        await safeScreenshot(page, 'screenshot3_watch_ad_dialog.png');

        // ── 第四步：点击 Watch Ad，播放广告，最多等待 30 秒 ──
        await clickWatchAd(page);
        log('等待广告播放，最多 30 秒...');
        await new Promise(r => setTimeout(r, 30000));
        await safeScreenshot(page, 'screenshot4_after_ad.png');

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
        await safeScreenshot(page, 'screenshot_error.png');
    } finally {
        log('关闭浏览器...');
        await browser.close();
    }
}
