const fs = require('fs');
const { spawn } = require('child_process');
const { connect } = require('puppeteer-real-browser');

function log(msg) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] ${msg}`);
}

fs.writeFileSync('status.txt', '失败: 脚本异常中断');
log('脚本启动，初始状态已写入。');

// ─── 1. 解析 VLESS ────────────────────────────────────────────────────────────
const vlessLink = process.env.VLESS_LINK;
if (!vlessLink) {
    log('错误：未找到 VLESS_LINK 环境变量！');
    fs.writeFileSync('status.txt', '失败: 未配置 VLESS_LINK');
    process.exit(1);
}

function parseVless(vless) {
    try {
        const parsed = new URL(vless);
        let uuid = parsed.username;
        if (!uuid) { const m = vless.match(/vless:\/\/([^@]+)@/); if (m) uuid = m[1]; }
        uuid = decodeURIComponent(uuid || '');
        const host = parsed.hostname;
        const port = parseInt(parsed.port) || 443;
        const params = parsed.searchParams;
        const type = params.get('type') || 'tcp';
        const security = params.get('security') || 'none';
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

// ─── 工具：截图 + 打印所有可见按钮 ──────────────────────────────────────────
async function screenshotWithInfo(page, filename) {
    await page.screenshot({ path: filename, fullPage: true });
    const buttons = await page.evaluate(() =>
        Array.from(document.querySelectorAll('button, [role="button"], a.btn, .btn'))
            .filter(el => el.offsetParent !== null)
            .map(el => el.textContent.trim().replace(/\s+/g, ' ').substring(0, 80))
            .filter(t => t.length > 0)
    );
    log(`[截图] ${filename} | 可见按钮: ${JSON.stringify(buttons)}`);
}

// ─── 工具：关闭广告 ──────────────────────────────────────────────────────────
async function dismissAds(page) {
    const n = await page.evaluate(() => {
        let count = 0;
        // 点击常见关闭按钮
        ['[class*="close"]','[class*="dismiss"]','[aria-label="close"]','[aria-label="Close"]',
         'button[class*="close"]','.ad-close','#ad-close'].forEach(sel => {
            try { document.querySelectorAll(sel).forEach(el => { if (el.offsetParent) { el.click(); count++; } }); } catch(_){}
        });
        // 隐藏底部固定广告横幅（排除顶部导航）
        document.querySelectorAll('*').forEach(el => {
            try {
                const s = window.getComputedStyle(el);
                if ((s.position === 'fixed' || s.position === 'sticky') && s.display !== 'none') {
                    const r = el.getBoundingClientRect();
                    if (r.top > 80 && r.height > 20 && r.height < 300) { el.style.display = 'none'; count++; }
                }
            } catch(_){}
        });
        return count;
    });
    if (n > 0) log(`广告处理: 操作了 ${n} 个元素。`);
}

// ─── 核心：精准点击 Add Time 按钮 ────────────────────────────────────────────
// 通过检查元素是否在 .card / .timer-card 等容器内，或者是否是 <button> 标签来过滤
async function clickAddTimeBtn(page) {
    const result = await page.evaluate(() => {
        // 策略1：找 href 包含 timer 页面内的 button 标签，文字精确匹配 "+ Add Time" 或 "Add Time"
        const candidates = Array.from(document.querySelectorAll('button'));
        for (const btn of candidates) {
            const text = btn.textContent.trim().replace(/\s+/g, ' ');
            if ((text === 'Add Time' || text === '+ Add Time') && btn.offsetParent !== null) {
                btn.scrollIntoView({ block: 'center' });
                btn.click();
                return { ok: true, text, tag: 'button' };
            }
        }
        // 策略2：找 <a> 标签，文字精确匹配
        const links = Array.from(document.querySelectorAll('a'));
        for (const a of links) {
            const text = a.textContent.trim().replace(/\s+/g, ' ');
            if ((text === 'Add Time' || text === '+ Add Time') && a.offsetParent !== null) {
                a.scrollIntoView({ block: 'center' });
                a.click();
                return { ok: true, text, tag: 'a' };
            }
        }
        // 策略3：找 class 含 btn / button 的元素，文字精确匹配
        const btnLike = Array.from(document.querySelectorAll('[class*="btn"],[class*="button"]'));
        for (const el of btnLike) {
            const text = el.textContent.trim().replace(/\s+/g, ' ');
            if ((text === 'Add Time' || text === '+ Add Time') && el.offsetParent !== null) {
                el.scrollIntoView({ block: 'center' });
                el.click();
                return { ok: true, text, tag: el.tagName };
            }
        }
        // 调试：返回页面上所有 button 标签的文字，帮助排查
        const allBtns = candidates.filter(b => b.offsetParent !== null)
            .map(b => b.textContent.trim().replace(/\s+/g, ' ').substring(0, 60));
        return { ok: false, allBtns };
    });
    return result;
}

// ─── 核心：精准点击 Watch Ad 按钮 ────────────────────────────────────────────
async function clickWatchAdBtn(page) {
    const result = await page.evaluate(() => {
        // Watch Ad 只会出现在弹窗/modal 里，优先找 button 标签
        const candidates = Array.from(document.querySelectorAll('button'));
        for (const btn of candidates) {
            const text = btn.textContent.trim().replace(/\s+/g, ' ');
            if (text === 'Watch Ad' && btn.offsetParent !== null) {
                btn.scrollIntoView({ block: 'center' });
                btn.click();
                return { ok: true, text, tag: 'button' };
            }
        }
        // 模糊匹配 button
        for (const btn of candidates) {
            const text = btn.textContent.trim().replace(/\s+/g, ' ');
            if (text.includes('Watch Ad') && btn.offsetParent !== null) {
                btn.scrollIntoView({ block: 'center' });
                btn.click();
                return { ok: true, text, tag: 'button' };
            }
        }
        // 找其他标签，精确匹配
        const all = Array.from(document.querySelectorAll('a, [role="button"], [class*="btn"]'));
        for (const el of all) {
            const text = el.textContent.trim().replace(/\s+/g, ' ');
            if (text === 'Watch Ad' && el.offsetParent !== null) {
                el.scrollIntoView({ block: 'center' });
                el.click();
                return { ok: true, text, tag: el.tagName };
            }
        }
        const allBtns = candidates.filter(b => b.offsetParent !== null)
            .map(b => b.textContent.trim().replace(/\s+/g, ' ').substring(0, 60));
        return { ok: false, allBtns };
    });
    return result;
}

// ─── 4. 主流程 ───────────────────────────────────────────────────────────────
async function runBrowser() {
    log('启动浏览器（1920×1080）...');
    const { page, browser } = await connect({
        headless: false,
        turnstile: true,
        args: ['--proxy-server=socks5://127.0.0.1:10808', '--no-sandbox', '--disable-setuid-sandbox', '--window-size=1920,1080'],
        disableXvfb: false
    });
    await page.setViewport({ width: 1920, height: 1080 });
    log('浏览器已启动。');

    try {
        // ── 登录 ──
        log('导航到登录页...');
        await page.goto('https://client.falixnodes.net/auth/login', { waitUntil: 'networkidle2', timeout: 60000 });
        log('等待 15 秒 Cloudflare 通过...');
        await new Promise(r => setTimeout(r, 15000));
        await screenshotWithInfo(page, 'screenshot1_login.png');

        const emailInput = await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 15000 });
        await emailInput.type(process.env.FALIX_EMAIL);
        const passwordInput = await page.waitForSelector('input[type="password"], input[name="password"]', { timeout: 15000 });
        await passwordInput.type(process.env.FALIX_PASSWORD);
        const signInBtn = await page.waitForSelector('button[type="submit"]', { timeout: 15000 });
        await signInBtn.click();
        log('已点击登录，等待 10 秒...');
        await new Promise(r => setTimeout(r, 10000));
        log('当前 URL: ' + page.url());

        // ── Timer 页 ──
        log('导航到 Timer 页...');
        await page.goto('https://client.falixnodes.net/timer?id=2845100', { waitUntil: 'networkidle2', timeout: 60000 });
        log('Timer 页加载完成。');

        const remainingTimeText = await page.evaluate(() => {
            const text = document.body.innerText;
            const match = text.match(/(\d+)\s*hours?\s*(\d+)\s*minutes?/i) || text.match(/(\d+)\s*h\s*(\d+)\s*m/i);
            return match ? match[0] : '未捕获到具体剩余时间';
        });
        log(`剩余时间: ${remainingTimeText}`);
        fs.writeFileSync('timer_status.txt', remainingTimeText);

        log('等待 15 秒让页面渲染完成...');
        await new Promise(r => setTimeout(r, 15000));
        await dismissAds(page);
        await new Promise(r => setTimeout(r, 500));
        await screenshotWithInfo(page, 'screenshot2_timer.png');

        // ── 点击 Add Time（精准版）──
        log('尝试点击 "Add Time" 按钮（精准匹配 <button> 标签）...');
        const addResult = await clickAddTimeBtn(page);
        log(`Add Time 结果: ${JSON.stringify(addResult)}`);

        if (!addResult.ok) {
            log('未找到 "Add Time" 按钮，页面结构可能有变，请查看截图。');
            fs.writeFileSync('status.txt', '失败: 未找到 Add Time 按钮');
            await screenshotWithInfo(page, 'screenshot3_no_addtime.png');
            return;
        }

        // ── 等待弹窗 ──
        log('已点击 Add Time，等待 8 秒让广告弹窗加载...');
        await new Promise(r => setTimeout(r, 8000));
        await dismissAds(page);
        await new Promise(r => setTimeout(r, 500));
        await screenshotWithInfo(page, 'screenshot3_after_addtime.png');

        // ── 点击 Watch Ad（精准版）──
        log('尝试点击 "Watch Ad" 按钮...');
        const watchResult = await clickWatchAdBtn(page);
        log(`Watch Ad 结果: ${JSON.stringify(watchResult)}`);

        if (!watchResult.ok) {
            log('未出现 "Watch Ad" 按钮，剩余时间可能已满（>70小时），无需续期。');
            fs.writeFileSync('status.txt', '无需续期: Watch Ad 按钮未出现（剩余时间已接近上限）');
            await screenshotWithInfo(page, 'screenshot4_result.png');
            return;
        }

        // ── 轮询检测续期结果 ──
        log('Watch Ad 已点击，轮询等待续期结果（最多 120 秒）...');
        let success = false;
        for (let i = 0; i < 12; i++) {
            log(`轮询 ${i + 1}/12，等待 10 秒...`);
            await new Promise(r => setTimeout(r, 10000));
            const bodyText = await page.evaluate(() => document.body.innerText);
            if (bodyText.includes('Timer has been extended') || bodyText.includes('extended') || bodyText.includes('Success')) {
                log('检测到续期成功关键字！');
                success = true;
                break;
            }
            log('暂未检测到成功关键字，继续...');
        }

        if (success) {
            log('续期成功！');
            fs.writeFileSync('status.txt', '✅ 续期成功: 时间已成功延长');
        } else {
            log('轮询结束，未检测到时间延长。');
            fs.writeFileSync('status.txt', '❌ 续期失败: 广告播放完毕后未检测到时间延长');
        }
        await screenshotWithInfo(page, 'screenshot4_result.png');

    } catch (e) {
        log(`异常: ${e.message}`);
        console.error(e.stack);
        fs.writeFileSync('status.txt', `失败: 运行异常 (${e.message})`);
        try { await page.screenshot({ path: 'screenshot_error.png', fullPage: true }); } catch (_) {}
    } finally {
        log('关闭浏览器...');
        await browser.close();
    }
}
