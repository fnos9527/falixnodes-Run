const fs = require('fs');
const { spawn } = require('child_process');
const { connect } = require('puppeteer-real-browser');

// ─── 日志工具 ────────────────────────────────────────────────────────────────
function log(msg) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] ${msg}`);
}

fs.writeFileSync('status.txt', '失败: 脚本异常中断');
log('脚本启动，初始状态已写入。');

// ─── 1. 获取并解析 VLESS 链接 ─────────────────────────────────────────────────
const vlessLink = process.env.VLESS_LINK;
if (!vlessLink) {
    log('错误：未找到 VLESS_LINK 环境变量！');
    fs.writeFileSync('status.txt', '失败: 未配置 VLESS_LINK');
    process.exit(1);
}
log('VLESS_LINK 已读取，开始解析...');

function parseVless(vless) {
    try {
        const parsed = new URL(vless);
        let uuid = parsed.username;
        if (!uuid) {
            const match = vless.match(/vless:\/\/([^@]+)@/);
            if (match) uuid = match[1];
        }
        uuid = decodeURIComponent(uuid || '');
        const host = parsed.hostname;
        const port = parseInt(parsed.port) || 443;
        const params = parsed.searchParams;
        const type = params.get('type') || 'tcp';
        const security = params.get('security') || 'none';
        const rawSni = params.get('sni');
        const rawHost = params.get('host');
        const sni = rawSni || rawHost || host;
        const rawInsecure = params.get('insecure') || params.get('allowInsecure') || '';
        const allowInsecure = (rawInsecure === '1' || rawInsecure.toLowerCase() === 'true');
        const fp = params.get('fp') || '';
        let path = params.get('path') || '';
        if (path) {
            path = decodeURIComponent(path);
            if (!path.startsWith('/')) path = '/' + path;
        }
        const pbk = params.get('pbk') || '';
        const sid = params.get('sid') || '';
        const spx = params.get('spx') || '';

        log(`VLESS 解析完成 -> host=${host} port=${port} type=${type} security=${security}`);
        return { uuid, host, port, type, security, sni, allowInsecure, fp, path, pbk, sid, spx, hostHeader: rawHost || '' };
    } catch (e) {
        log(`VLESS 链接解析失败: ${e.message}`);
        fs.writeFileSync('status.txt', '失败: VLESS 格式解析错误');
        process.exit(1);
    }
}

const node = parseVless(vlessLink);

// ─── 2. 动态生成 Xray 配置文件 ────────────────────────────────────────────────
log('开始生成 Xray 配置文件...');
const xrayConfig = {
    log: { loglevel: "warning" },
    inbounds: [{
        port: 10808,
        listen: "127.0.0.1",
        protocol: "socks",
        settings: { auth: "noauth", udp: true }
    }],
    outbounds: [{
        protocol: "vless",
        settings: {
            vnext: [{
                address: node.host,
                port: node.port,
                users: [{ id: node.uuid, encryption: "none" }]
            }]
        },
        streamSettings: {
            network: node.type,
            security: node.security
        }
    }]
};

const stream = xrayConfig.outbounds[0].streamSettings;
if (node.security === 'tls') {
    stream.tlsSettings = { serverName: node.sni, allowInsecure: node.allowInsecure };
    if (node.fp) stream.tlsSettings.fingerprint = node.fp;
    log(`TLS 配置已设置，SNI=${node.sni}`);
} else if (node.security === 'reality') {
    stream.realitySettings = { show: false, publicKey: node.pbk, shortId: node.sid, serverName: node.sni, spiderX: node.spx };
    if (node.fp) stream.realitySettings.fingerprint = node.fp;
    log(`Reality 配置已设置，SNI=${node.sni}`);
}

if (node.type === 'ws') {
    stream.wsSettings = { path: node.path || "/" };
    if (node.hostHeader) stream.wsSettings.headers = { Host: node.hostHeader };
    log(`WebSocket 配置，path=${node.path}`);
} else if (node.type === 'tcp') {
    stream.tcpSettings = { header: { type: "none" } };
    log('TCP 配置已设置。');
} else if (node.type === 'grpc') {
    stream.grpcSettings = { serviceName: node.path || "grpc" };
    log('gRPC 配置已设置。');
} else if (node.type === 'http' || node.type === 'h2') {
    stream.httpSettings = { path: node.path || "/" };
    if (node.hostHeader) stream.httpSettings.host = [node.hostHeader];
    log('HTTP/H2 配置已设置。');
}

fs.writeFileSync('xray_config.json', JSON.stringify(xrayConfig, null, 2));
log('xray_config.json 已写入。');

// ─── 3. 后台启动 Xray ────────────────────────────────────────────────────────
log('启动 Xray 进程...');
let xrayProcess = spawn('./xray-bin/xray', ['-c', 'xray_config.json']);
xrayProcess.stdout.on('data', d => log(`[Xray] ${d.toString().trim()}`));
xrayProcess.stderr.on('data', d => log(`[Xray ERR] ${d.toString().trim()}`));
xrayProcess.on('close', code => log(`Xray 进程关闭，退出码 ${code}`));

log('等待 3 秒让 Xray 完成初始化...');
setTimeout(async () => {
    try {
        await runBrowser();
    } catch (err) {
        log(`运行任务中遭遇顶层错误: ${err.message}`);
        console.error(err.stack);
        fs.writeFileSync('status.txt', `失败: 脚本运行异常 (${err.message})`);
    } finally {
        log('终止 Xray 进程并退出脚本。');
        xrayProcess.kill();
        process.exit(0);
    }
}, 3000);

// ─── 工具函数：关闭页面上所有广告/横幅 ─────────────────────────────────────
async function dismissAds(page) {
    log('尝试关闭页面广告横幅...');
    const closed = await page.evaluate(() => {
        let count = 0;
        // 1. 点击所有常见关闭按钮（×、close、dismiss）
        const closeSelectors = [
            '[class*="close"]', '[class*="dismiss"]', '[class*="banner"] button',
            '[id*="close"]', '[aria-label="close"]', '[aria-label="Close"]',
            'button[class*="close"]', '.ad-close', '#ad-close'
        ];
        for (const sel of closeSelectors) {
            try {
                document.querySelectorAll(sel).forEach(el => {
                    if (el.offsetParent !== null) { el.click(); count++; }
                });
            } catch (_) {}
        }
        // 2. 强制隐藏固定定位的广告覆盖层
        document.querySelectorAll('*').forEach(el => {
            try {
                const style = window.getComputedStyle(el);
                if ((style.position === 'fixed' || style.position === 'sticky') &&
                    style.display !== 'none' && style.visibility !== 'hidden') {
                    // 跳过导航栏（顶部 header）
                    const rect = el.getBoundingClientRect();
                    if (rect.top > 50 && rect.height < 200) {
                        el.style.display = 'none';
                        count++;
                    }
                }
            } catch (_) {}
        });
        return count;
    });
    log(`广告处理完毕，共操作 ${closed} 个元素。`);
}

// ─── 工具函数：截图并打印当前页面上所有可见按钮文字 ─────────────────────────
async function screenshotWithButtons(page, filename) {
    await page.screenshot({ path: filename, fullPage: true });
    log(`截图已保存: ${filename} (全页)`);

    const buttons = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('button, [role="button"], a.btn, .btn'))
            .filter(el => el.offsetParent !== null)
            .map(el => el.textContent.trim().replace(/\s+/g, ' ').substring(0, 60))
            .filter(t => t.length > 0);
    });
    log(`当前页面可见按钮列表: ${JSON.stringify(buttons)}`);
}

// ─── 4. Puppeteer 核心控制逻辑 ───────────────────────────────────────────────
async function runBrowser() {
    log('正在启动 puppeteer-real-browser（1920x1080 桌面视口）...');
    const { page, browser } = await connect({
        headless: false,
        turnstile: true,
        args: [
            '--proxy-server=socks5://127.0.0.1:10808',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            // ★ 关键：使用 1920×1080 的桌面分辨率，避免移动端布局
            '--window-size=1920,1080',
        ],
        disableXvfb: false
    });

    // ★ 强制设置桌面视口大小
    await page.setViewport({ width: 1920, height: 1080 });
    log('浏览器已启动，视口已设为 1920×1080。');

    try {
        // ── 登录页 ──
        log('正在导航到登录页...');
        await page.goto('https://client.falixnodes.net/auth/login', { waitUntil: 'networkidle2', timeout: 60000 });
        log('登录页加载完成，等待 15 秒让 Cloudflare 验证通过...');
        await new Promise(r => setTimeout(r, 15000));

        await screenshotWithButtons(page, 'screenshot1_cf_login.png');

        // ── 填写邮箱 ──
        log('等待邮箱输入框...');
        const emailInput = await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 15000 });
        await emailInput.type(process.env.FALIX_EMAIL);
        log('邮箱已输入。');

        // ── 填写密码 ──
        log('等待密码输入框...');
        const passwordInput = await page.waitForSelector('input[type="password"], input[name="password"]', { timeout: 15000 });
        await passwordInput.type(process.env.FALIX_PASSWORD);
        log('密码已输入。');

        // ── 点击登录 ──
        log('等待登录按钮...');
        const signInBtn = await page.waitForSelector('button[type="submit"], button', { timeout: 15000 });
        await signInBtn.click();
        log('已点击登录按钮，等待 10 秒...');
        await new Promise(r => setTimeout(r, 10000));
        log('当前 URL: ' + page.url());

        // ── 进入 Timer 页 ──
        log('正在导航到 Timer 页面...');
        await page.goto('https://client.falixnodes.net/timer?id=2845100', { waitUntil: 'networkidle2', timeout: 60000 });
        log('Timer 页面加载完成。');

        // ── 读取剩余时间 ──
        const remainingTimeText = await page.evaluate(() => {
            const text = document.body.innerText;
            const match = text.match(/(\d+)\s*hours?\s*(\d+)\s*minutes?/i) || text.match(/(\d+)\s*h\s*(\d+)\s*m/i);
            return match ? match[0] : "未捕获到具体剩余时间";
        });
        log(`当前剩余时间: ${remainingTimeText}`);
        fs.writeFileSync('timer_status.txt', remainingTimeText);

        log('等待 15 秒让 Timer 页完全渲染...');
        await new Promise(r => setTimeout(r, 15000));

        // ★ 关闭广告后再截图
        await dismissAds(page);
        await new Promise(r => setTimeout(r, 1000));
        await screenshotWithButtons(page, 'screenshot2_cf_timer.png');

        // ── 滚动到页面底部确保按钮可见 ──
        log('滚动页面确保按钮区域可见...');
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await new Promise(r => setTimeout(r, 1000));

        // ── 点击 Add Time（优先用 JS 点击，找不到则用 evaluate） ──
        log('尝试点击 "Add Time" 按钮...');
        let addTimeClicked = false;
        try {
            // 先尝试通过文字找到元素并用 Puppeteer 点击（更可靠）
            addTimeClicked = await page.evaluate(() => {
                const all = Array.from(document.querySelectorAll('button, [role="button"], a, div, span'));
                const target = all.find(el =>
                    el.offsetParent !== null &&
                    el.textContent.trim().replace(/\s+/g, ' ').includes('Add Time')
                );
                if (target) {
                    target.scrollIntoView({ block: 'center' });
                    target.click();
                    return target.textContent.trim();
                }
                return null;
            });
        } catch (e) {
            log(`Add Time 点击异常: ${e.message}`);
        }

        if (addTimeClicked) {
            log(`"Add Time" 已点击，元素文字: "${addTimeClicked}"`);
        } else {
            log('未找到 "Add Time" 按钮，可能已不需要续期或页面结构有变。');
            fs.writeFileSync('status.txt', '未知: 未找到 Add Time 按钮');
            await screenshotWithButtons(page, 'screenshot3_result.png');
            return;
        }

        log('等待 5 秒让弹窗/广告加载...');
        await new Promise(r => setTimeout(r, 5000));

        // ★ 关闭弹出的广告横幅，避免遮挡 Watch Ad 按钮
        await dismissAds(page);
        await new Promise(r => setTimeout(r, 1000));
        await screenshotWithButtons(page, 'screenshot3_watch_ad_before.png');

        // ── 点击 Watch Ad ──
        log('尝试点击 "Watch Ad" 按钮...');
        let watchAdClicked = await page.evaluate(() => {
            const all = Array.from(document.querySelectorAll('button, [role="button"], a, div, span'));
            // 精确匹配
            let target = all.find(el =>
                el.offsetParent !== null &&
                el.textContent.trim().replace(/\s+/g, ' ') === 'Watch Ad'
            );
            // 模糊匹配
            if (!target) {
                target = all.find(el =>
                    el.offsetParent !== null &&
                    el.textContent.trim().replace(/\s+/g, ' ').includes('Watch Ad')
                );
            }
            if (target) {
                target.scrollIntoView({ block: 'center' });
                target.click();
                return target.textContent.trim();
            }
            return null;
        });

        if (!watchAdClicked) {
            log('未出现 "Watch Ad" 按钮，可能当前时间已满，无需继续延长。');
            fs.writeFileSync('status.txt', '无需续期: Watch Ad 按钮未出现（剩余时间已接近上限）');
            await screenshotWithButtons(page, 'screenshot4_result.png');
            return;
        }

        log(`"Watch Ad" 已点击，元素文字: "${watchAdClicked}"`);
        log('开始轮询等待续期结果（最多 90 秒）...');

        // ── 轮询检测续期结果 ──
        let success = false;
        for (let i = 0; i < 9; i++) {
            log(`轮询第 ${i + 1}/9 次，等待 10 秒...`);
            await new Promise(r => setTimeout(r, 10000));
            const bodyText = await page.evaluate(() => document.body.innerText);
            if (bodyText.includes("Timer has been extended") || bodyText.includes("extended")) {
                log('检测到续期成功关键字！');
                success = true;
                break;
            } else {
                log('暂未检测到成功关键字，继续等待...');
            }
        }

        if (success) {
            log('续期成功。');
            fs.writeFileSync('status.txt', '✅ 续期成功: 时间已成功延长');
        } else {
            log('轮询结束，未能检测到时间延长的提示。');
            fs.writeFileSync('status.txt', '❌ 续期失败: 广告播放完毕后未检测到时间延长');
        }

        await screenshotWithButtons(page, 'screenshot4_result.png');

    } catch (e) {
        log(`执行中异常: ${e.message}`);
        console.error(e.stack);
        fs.writeFileSync('status.txt', `失败: 运行出现异常 (${e.message})`);
        try {
            await page.screenshot({ path: 'screenshot_error.png', fullPage: true });
            log('异常截图已保存: screenshot_error.png');
        } catch (_) {}
    } finally {
        log('关闭浏览器...');
        await browser.close();
        log('浏览器已关闭。');
    }
}
