const fs = require('fs');
const { spawn } = require('child_process');
const { connect } = require('puppeteer-real-browser');

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
    // 提高协议超时上限，避免广告播放期间截图超时
    page.setDefaultTimeout(120000);
    log('浏览器已启动。');

    try {
        // ── 登录 ──
        log('导航到登录页...');
        await page.goto('https://client.falixnodes.net/auth/login', { waitUntil: 'networkidle2', timeout: 60000 });
        log('等待 15 秒 Cloudflare 通过...');
        await new Promise(r => setTimeout(r, 15000));
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
        await safeScreenshot(page, 'screenshot2_timer.png');

        // ── 点击 Add Time（精准匹配 <button> 标签）──
        log('尝试点击 "Add Time" 按钮...');
        const addResult = await page.evaluate(() => {
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
        });
        log(`Add Time 结果: ${JSON.stringify(addResult)}`);

        if (!addResult.ok) {
            log('未找到 "Add Time" 按钮。');
            fs.writeFileSync('status.txt', '失败: 未找到 Add Time 按钮');
            await safeScreenshot(page, 'screenshot3_no_addtime.png');
            return;
        }

        // ── 等待弹窗出现（"Watch Ad to Extend Timer" 对话框）──
        log('已点击 Add Time，等待 Watch Ad 弹窗出现（最多 15 秒）...');
        let watchAdFound = false;
        for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 1000));
            watchAdFound = await page.evaluate(() => {
                for (const btn of document.querySelectorAll('button')) {
                    const text = btn.textContent.trim().replace(/\s+/g, ' ');
                    if (btn.offsetParent !== null && (text === 'Watch Ad' || text.includes('Watch Ad'))) return true;
                }
                return false;
            });
            if (watchAdFound) { log(`Watch Ad 按钮在第 ${i+1} 秒出现！`); break; }
            log(`等待弹窗... ${i+1}/15`);
        }

        if (!watchAdFound) {
            log('15 秒内未出现 Watch Ad 按钮，剩余时间可能已满（>70小时），无需续期。');
            fs.writeFileSync('status.txt', '无需续期: Watch Ad 按钮未出现（剩余时间已接近上限）');
            await safeScreenshot(page, 'screenshot3_result.png');
            return;
        }

        await safeScreenshot(page, 'screenshot3_watch_ad_dialog.png');

        // ── 点击 Watch Ad ──
        log('点击 Watch Ad 按钮...');
        await page.evaluate(() => {
            for (const btn of document.querySelectorAll('button')) {
                const text = btn.textContent.trim().replace(/\s+/g, ' ');
                if (btn.offsetParent !== null && (text === 'Watch Ad' || text.includes('Watch Ad'))) {
                    btn.scrollIntoView({ block: 'center' });
                    btn.click();
                    return;
                }
            }
        });
        log('Watch Ad 已点击，广告加载中...');

        // ── 等待广告播放完毕并跳转回主页 ──
        // 流程：点击 Watch Ad → 广告全屏播放 → 播完自动跳回 client.falixnodes.net
        // 策略：轮询检查 URL 是否跳回主页，或页面出现 "Timer has been extended"
        log('等待广告播放完毕并跳转（最多 180 秒）...');
        let success = false;
        for (let i = 0; i < 36; i++) {
            await new Promise(r => setTimeout(r, 5000));
            const currentUrl = page.url();
            log(`第 ${i+1}/36 次检查，当前 URL: ${currentUrl}`);

            // 检查是否已跳回主页并出现成功提示
            const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
            if (pageText.includes('Timer has been extended') || pageText.includes('extended')) {
                log('检测到 "Timer has been extended" 成功提示！');
                success = true;
                break;
            }

            // 如果 URL 已跳回主页（不再是广告页），再多等 5 秒让成功提示渲染
            if (currentUrl.includes('client.falixnodes.net') && !currentUrl.includes('#go')) {
                log('URL 已跳回主页，再等 5 秒让提示渲染...');
                await new Promise(r => setTimeout(r, 5000));
                const finalText = await page.evaluate(() => document.body.innerText).catch(() => '');
                if (finalText.includes('Timer has been extended') || finalText.includes('extended')) {
                    log('检测到续期成功！');
                    success = true;
                }
                break;
            }
        }

        if (success) {
            log('续期成功！');
            fs.writeFileSync('status.txt', '✅ 续期成功: 时间已成功延长');
        } else {
            log('等待超时，未检测到时间延长提示。');
            fs.writeFileSync('status.txt', '❌ 续期失败: 广告播放后未检测到成功跳转');
        }

        // 最终截图（不截广告页，等跳回主页后再截）
        await safeScreenshot(page, 'screenshot4_result.png');

    } catch (e) {
        log(`异常: ${e.message}`);
        console.error(e.stack);
        fs.writeFileSync('status.txt', `失败: 运行异常 (${e.message})`);
        await safeScreenshot(page, 'screenshot_error.png');
    } finally {
        log('关闭浏览器...');
        await browser.close();
    }
}
