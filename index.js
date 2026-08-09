const fs = require('fs');
const { spawn } = require('child_process');
const { connect } = require('puppeteer-real-browser');

// 写入初始默认状态
fs.writeFileSync('status.txt', '失败: 脚本异常中断');

// 1. 获取并解析 VLESS 链接
const vlessLink = process.env.VLESS_LINK;
if (!vlessLink) {
    console.error("错误：未找到 VLESS_LINK 环境变量！");
    fs.writeFileSync('status.txt', '失败: 未配置 VLESS_LINK');
    process.exit(1);
}

function parseVless(vless) {
    try {
        const parsed = new URL(vless);
        let uuid = parsed.username;
        if (!uuid) {
            const match = vless.match(/vless:\/\/([^@]+)@/);
            if (match) {
                uuid = match[1];
            }
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
            if (!path.startsWith('/')) {
                path = '/' + path;
            }
        }
        const pbk = params.get('pbk') || '';
        const sid = params.get('sid') || '';
        const spx = params.get('spx') || '';
        
        return {
            uuid, host, port, type, security, sni, allowInsecure, fp, path, pbk, sid, spx, hostHeader: rawHost || ''
        };
    } catch (e) {
        console.error("VLESS 链接解析失败:", e);
        fs.writeFileSync('status.txt', '失败: VLESS 格式解析错误');
        process.exit(1);
    }
}

const node = parseVless(vlessLink);

// 2. 动态生成 Xray 配置文件
const xrayConfig = {
    log: { loglevel: "warning" },
    inbounds: [
        {
            port: 10808,
            listen: "127.0.0.1",
            protocol: "socks",
            settings: { auth: "noauth", udp: true }
        }
    ],
    outbounds: [
        {
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
        }
    ]
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

// 3. 后台启动 Xray
let xrayProcess = spawn('./xray-bin/xray', ['-c', 'xray_config.json']);
xrayProcess.on('close', (code) => console.log(`Xray 进程关闭，退出码 ${code}`));

setTimeout(async () => {
    try {
        await runBrowser();
    } catch (err) {
        console.error("运行任务中遭遇错误:", err);
        fs.writeFileSync('status.txt', `失败: 脚本运行异常 (${err.message})`);
    } finally {
        xrayProcess.kill();
        process.exit(0);
    }
}, 3000);

// 4. Puppeteer 核心控制逻辑
async function runBrowser() {
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

    try {
        await page.goto('https://client.falixnodes.net/auth/login', { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(resolve => setTimeout(resolve, 15000));
        await page.screenshot({ path: 'screenshot1_cf_login.png' });
        
        const emailInput = await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 15000 });
        await emailInput.type(process.env.FALIX_EMAIL);
        
        const passwordInput = await page.waitForSelector('input[type="password"], input[name="password"]', { timeout: 15000 });
        await passwordInput.type(process.env.FALIX_PASSWORD);
        
        const signInBtn = await page.waitForSelector('button[type="submit"], button', { timeout: 15000 });
        await signInBtn.click();
        await new Promise(resolve => setTimeout(resolve, 10000));
        
        await page.goto('https://client.falixnodes.net/timer?id=2845100', { waitUntil: 'networkidle2', timeout: 60000 });
        
        const remainingTimeText = await page.evaluate(() => {
            const text = document.body.innerText;
            const match = text.match(/(\d+)\s*hours?\s*(\d+)\s*minutes?/i) || text.match(/(\d+)\s*h\s*(\d+)\s*m/i);
            return match ? match[0] : "未捕获到具体剩余时间";
        });
        fs.writeFileSync('timer_status.txt', remainingTimeText);
        
        await new Promise(resolve => setTimeout(resolve, 15000));
        await page.screenshot({ path: 'screenshot2_cf_timer.png' });
        
        // 点击 + Add Time 按钮
        const addTimeClicked = await page.evaluate(() => {
            const elements = Array.from(document.querySelectorAll('button, div, a, span'));
            const target = elements.find(el => el.textContent.includes('Add Time'));
            if (target) {
                target.click();
                return true;
            }
            return false;
        });
        
        if (!addTimeClicked) {
            const addTimeBtn = await page.waitForSelector('button', { timeout: 5000 }).catch(() => null);
            if (addTimeBtn) await addTimeBtn.click();
        }
        
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // 尝试点击 Watch Ad 按钮
        let watchAdClicked = await page.evaluate(() => {
            const elements = Array.from(document.querySelectorAll('button, div, a, span'));
            const target = elements.find(el => el.textContent.trim() === 'Watch Ad');
            if (target) {
                target.click();
                return true;
            }
            return false;
        });
        
        if (!watchAdClicked) {
            watchAdClicked = await page.evaluate(() => {
                const elements = Array.from(document.querySelectorAll('button, div, a, span'));
                const target = elements.find(el => el.textContent.includes('Watch Ad'));
                if (target) {
                    target.click();
                    return true;
                }
                return false;
            });
        }
        
        // 如果没有成功触发广告按钮，说明可能因为时间太满（通常大于70小时）导致无法继续续期
        if (!watchAdClicked) {
            console.log("未出现 'Watch Ad' 按钮，可能当前时间已满，无需继续延长。");
            fs.writeFileSync('status.txt', '无需续期: 广告弹窗未出现（当前剩余时间已接近上限）');
            await page.screenshot({ path: 'screenshot3_result.png' });
            return;
        }
        
        // 如果有广告按钮并成功点击，等待最多 90 秒进行续期判定
        let success = false;
        for (let i = 0; i < 9; i++) {
            await new Promise(resolve => setTimeout(resolve, 10000));
            const bodyText = await page.evaluate(() => document.body.innerText);
            if (bodyText.includes("Timer has been extended") || bodyText.includes("extended")) {
                success = true;
                break;
            }
        }
        
        if (success) {
            console.log("续期成功。");
            fs.writeFileSync('status.txt', '✅ 续期成功: 时间已成功延长');
        } else {
            console.log("未能检测到时间延长的提示。");
            fs.writeFileSync('status.txt', '❌ 续期失败: 广告播放完毕后未检测到重定向或时间延长');
        }
        
        await page.screenshot({ path: 'screenshot3_result.png' });
        
    } catch (e) {
        console.error("执行中异常:", e);
        fs.writeFileSync('status.txt', `失败: 运行出现异常 (${e.message})`);
    } finally {
        await browser.close();
    }
}
