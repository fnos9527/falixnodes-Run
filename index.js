const fs = require('fs');
const { spawn } = require('child_process');
const { connect } = require('puppeteer-real-browser');

// ─── 日志工具 ────────────────────────────────────────────────────────────────
function log(msg) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] ${msg}`);
}

// 写入初始默认状态
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
xrayProcess.stdout.on('data', d => log(`[Xray stdout] ${d.toString().trim()}`));
xrayProcess.stderr.on('data', d => log(`[Xray stderr] ${d.toString().trim()}`));
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

// ─── 4. Puppeteer 核心控制逻辑 ───────────────────────────────────────────────
async function runBrowser() {
    log('正在启动 puppeteer-real-browser...');
    const { page, browser } = await connect({
        headless: false,
        turnstile: true,
        args: [
            '--proxy-server=socks5://127.0.0.1:10808',
            '--no-sandbox',
            '--disable-setuid-sandbox'
        ],
        disableXvfb: false
    });
    log('浏览器已启动。');

    try {
        // ── 登录页 ──
        log('正在导航到登录页...');
        await page.goto('https://client.falixnodes.net/auth/login', { waitUntil: 'networkidle2', timeout: 60000 });
        log('登录页加载完成（networkidle2），等待 15 秒让 Cloudflare 验证通过...');
        await new Promise(r => setTimeout(r, 15000));

        await page.screenshot({ path: 'screenshot1_cf_login.png' });
        log('截图已保存: screenshot1_cf_login.png');

        // ── 填写邮箱 ──
        log('等待邮箱输入框出现...');
        const emailInput = await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 15000 });
        log('邮箱输入框已找到，开始输入...');
        await emailInput.type(process.env.FALIX_EMAIL);
        log('邮箱已输入。');

        // ── 填写密码 ──
        log('等待密码输入框出现...');
        const passwordInput = await page.waitForSelector('input[type="password"], input[name="password"]', { timeout: 15000 });
        log('密码输入框已找到，开始输入...');
        await passwordInput.type(process.env.FALIX_PASSWORD);
        log('密码已输入。');

        // ── 点击登录 ──
        log('等待登录按钮出现...');
        const signInBtn = await page.waitForSelector('button[type="submit"], button', { timeout: 15000 });
        log('登录按钮已找到，点击...');
        await signInBtn.click();
        log('已点击登录按钮，等待 10 秒...');
        await new Promise(r => setTimeout(r, 10000));
        log('等待完成，当前 URL: ' + page.url());

        // ── 进入 Timer 页 ──
        log('正在导航到 Timer 页面...');
        await page.goto('https://client.falixnodes.net/timer?id=2845100', { waitUntil: 'networkidle2', timeout: 60000 });
        log('Timer 页面加载完成（networkidle2）。');

        // ── 读取剩余时间 ──
        log('正在读取剩余时间文本...');
        const remainingTimeText = await page.evaluate(() => {
            const text = document.body.innerText;
            const match = text.match(/(\d+)\s*hours?\s*(\d+)\s*minutes?/i) || text.match(/(\d+)\s*h\s*(\d+)\s*m/i);
            return match ? match[0] : "未捕获到具体剩余时间";
        });
        log(`当前剩余时间: ${remainingTimeText}`);
        fs.writeFileSync('timer_status.txt', remainingTimeText);

        log('等待 15 秒让 Timer 页完全渲染...');
        await new Promise(r => setTimeout(r, 15000));
        await page.screenshot({ path: 'screenshot2_cf_timer.png' });
        log('截图已保存: screenshot2_cf_timer.png');

        // ── 点击 Add Time ──
        log('尝试点击 "Add Time" 按钮...');
        const addTimeClicked = await page.evaluate(() => {
            const elements = Array.from(document.querySelectorAll('button, div, a, span'));
            const target = elements.find(el => el.textContent.includes('Add Time'));
            if (target) { target.click(); return true; }
            return false;
        });
        if (addTimeClicked) {
            log('"Add Time" 按钮点击成功。');
        } else {
            log('"Add Time" 按钮未找到，尝试点击页面上第一个 button...');
            const addTimeBtn = await page.waitForSelector('button', { timeout: 5000 }).catch(() => null);
            if (addTimeBtn) {
                await addTimeBtn.click();
                log('已点击备用 button。');
            } else {
                log('备用 button 也未找到。');
            }
        }

        log('等待 5 秒让弹窗出现...');
        await new Promise(r => setTimeout(r, 5000));

        // ── 点击 Watch Ad ──
        log('尝试精确匹配 "Watch Ad" 按钮...');
        let watchAdClicked = await page.evaluate(() => {
            const elements = Array.from(document.querySelectorAll('button, div, a, span'));
            const target = elements.find(el => el.textContent.trim() === 'Watch Ad');
            if (target) { target.click(); return true; }
            return false;
        });

        if (!watchAdClicked) {
            log('精确匹配失败，尝试模糊匹配 "Watch Ad"...');
            watchAdClicked = await page.evaluate(() => {
                const elements = Array.from(document.querySelectorAll('button, div, a, span'));
                const target = elements.find(el => el.textContent.includes('Watch Ad'));
                if (target) { target.click(); return true; }
                return false;
            });
        }

        if (!watchAdClicked) {
            log('未出现 "Watch Ad" 按钮，可能当前时间已满，无需继续延长。');
            fs.writeFileSync('status.txt', '无需续期: 广告弹窗未出现（当前剩余时间已接近上限）');
            await page.screenshot({ path: 'screenshot3_result.png' });
            log('截图已保存: screenshot3_result.png');
            return;
        }

        log('"Watch Ad" 按钮已点击，开始轮询等待续期结果（最多 90 秒）...');

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
            fs.writeFileSync('status.txt', '❌ 续期失败: 广告播放完毕后未检测到重定向或时间延长');
        }

        await page.screenshot({ path: 'screenshot3_result.png' });
        log('截图已保存: screenshot3_result.png');

    } catch (e) {
        log(`执行中异常: ${e.message}`);
        console.error(e.stack);
        fs.writeFileSync('status.txt', `失败: 运行出现异常 (${e.message})`);
        // 异常时也截图，方便排查
        try {
            await page.screenshot({ path: 'screenshot_error.png' });
            log('异常截图已保存: screenshot_error.png');
        } catch (_) {}
    } finally {
        log('关闭浏览器...');
        await browser.close();
        log('浏览器已关闭。');
    }
}
