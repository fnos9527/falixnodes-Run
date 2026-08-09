const fs = require('fs');
const { spawn } = require('child_process');
const { connect } = require('puppeteer-real-browser');

// 1. 获取并解析 VLESS 链接
const vlessLink = process.env.VLESS_LINK;
if (!vlessLink) {
    console.error("错误：未找到 VLESS_LINK 环境变量！");
    process.exit(1);
}

function parseVless(vless) {
    try {
        const parsed = new URL(vless);
        
        // 解析 UUID
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
        
        // sni 缺失时兜底为 host 参数或服务器地址本身
        const rawSni = params.get('sni');
        const rawHost = params.get('host');
        const sni = rawSni || rawHost || host;
        
        // insecure 和 allowInsecure 兼容处理
        const rawInsecure = params.get('insecure') || params.get('allowInsecure') || '';
        const allowInsecure = (rawInsecure === '1' || rawInsecure.toLowerCase() === 'true');
        
        // TLS 指纹
        const fp = params.get('fp') || '';
        
        // path 解码并补齐 /
        let path = params.get('path') || '';
        if (path) {
            path = decodeURIComponent(path);
            if (!path.startsWith('/')) {
                path = '/' + path;
            }
        }
        
        // REALITY 支持
        const pbk = params.get('pbk') || '';
        const sid = params.get('sid') || '';
        const spx = params.get('spx') || '';
        
        return {
            uuid, host, port, type, security, sni, allowInsecure, fp, path, pbk, sid, spx, hostHeader: rawHost || ''
        };
    } catch (e) {
        console.error("VLESS 链接解析失败:", e);
        process.exit(1);
    }
}

const node = parseVless(vlessLink);
console.log("解析出的节点参数：", {
    host: node.host,
    port: node.port,
    type: node.type,
    security: node.security,
    sni: node.sni,
    allowInsecure: node.allowInsecure,
    fp: node.fp,
    path: node.path,
    hasPbk: !!node.pbk
});

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

// 证书校验与传输安全层配置
if (node.security === 'tls') {
    stream.tlsSettings = {
        serverName: node.sni,
        allowInsecure: node.allowInsecure
    };
    if (node.fp) stream.tlsSettings.fingerprint = node.fp;
} else if (node.security === 'reality') {
    stream.realitySettings = {
        show: false,
        publicKey: node.pbk,
        shortId: node.sid,
        serverName: node.sni,
        spiderX: node.spx
    };
    if (node.fp) stream.realitySettings.fingerprint = node.fp;
}

// 传输层细节配置（ws / tcp / grpc / http）
if (node.type === 'ws') {
    stream.wsSettings = { path: node.path || "/" };
    if (node.hostHeader) {
        stream.wsSettings.headers = { Host: node.hostHeader };
    }
} else if (node.type === 'tcp') {
    stream.tcpSettings = { header: { type: "none" } };
} else if (node.type === 'grpc') {
    stream.grpcSettings = { serviceName: node.path || "grpc" };
} else if (node.type === 'http' || node.type === 'h2') {
    stream.httpSettings = { path: node.path || "/" };
    if (node.hostHeader) {
        stream.httpSettings.host = [node.hostHeader];
    }
}

fs.writeFileSync('xray_config.json', JSON.stringify(xrayConfig, null, 2));
console.log("Xray 配置文件生成成功。");

// 3. 后台启动本地 Xray v25.9.11 代理进程
let xrayProcess = spawn('./xray-bin/xray', ['-c', 'xray_config.json']);

xrayProcess.stdout.on('data', (data) => console.log(`[Xray Log] ${data}`));
xrayProcess.stderr.on('data', (data) => console.error(`[Xray Err] ${data}`));
xrayProcess.on('close', (code) => console.log(`Xray 进程关闭，退出码 ${code}`));

// 等待 3 秒使代理就绪
setTimeout(async () => {
    try {
        await runBrowser();
    } catch (err) {
        console.error("续期脚本执行出现异常:", err);
    } finally {
        console.log("正在清理 Xray 代理进程...");
        xrayProcess.kill();
        process.exit(0);
    }
}, 3000);

// 4. Puppeteer 核心控制逻辑
async function runBrowser() {
    console.log("正在通过本地 SOCKS5 代理启动 puppeteer-real-browser...");
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
        console.log("正在前往登录页面...");
        await page.goto('https://client.falixnodes.net/auth/login', { waitUntil: 'networkidle2', timeout: 60000 });
        
        console.log("等待 Cloudflare 登录防护自动绕过（15秒）...");
        await new Promise(resolve => setTimeout(resolve, 15000));
        
        await page.screenshot({ path: 'screenshot1_cf_login.png' });
        console.log("已保存截图 1: 登录页 CF 验证状态");
        
        console.log("正在填写账号与密码...");
        const emailInput = await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 15000 });
        await emailInput.type(process.env.FALIX_EMAIL);
        
        const passwordInput = await page.waitForSelector('input[type="password"], input[name="password"]', { timeout: 15000 });
        await passwordInput.type(process.env.FALIX_PASSWORD);
        
        console.log("点击登录...");
        const signInBtn = await page.waitForSelector('button[type="submit"], button', { timeout: 15000 });
        await signInBtn.click();
        
        console.log("等待登录处理（10秒）...");
        await new Promise(resolve => setTimeout(resolve, 10000));
        
        console.log("跳转往计时器页面...");
        await page.goto('https://client.falixnodes.net/timer?id=2845100', { waitUntil: 'networkidle2', timeout: 60000 });
        
        console.log("提取剩余运行时间...");
        const remainingTimeText = await page.evaluate(() => {
            const text = document.body.innerText;
            const match = text.match(/(\d+)\s*hours?\s*(\d+)\s*minutes?/i) || text.match(/(\d+)\s*h\s*(\d+)\s*m/i);
            return match ? match[0] : "未捕获到具体剩余时间字符串";
        });
        console.log(`服务器剩余运行时间: ${remainingTimeText}`);
        fs.writeFileSync('timer_status.txt', remainingTimeText);
        
        console.log("等待计时器页面的 Cloudflare 二次防护自动绕过（15秒）...");
        await new Promise(resolve => setTimeout(resolve, 15000));
        
        await page.screenshot({ path: 'screenshot2_cf_timer.png' });
        console.log("已保存截图 2: 计时器页 CF 验证状态");
        
        console.log("正在查找并点击 '+ Add Time' 按钮...");
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
            console.log("文本模糊查找 '+ Add Time' 失败，尝试定位标准按钮选择器...");
            const addTimeBtn = await page.waitForSelector('button', { timeout: 5000 }).catch(() => null);
            if (addTimeBtn) await addTimeBtn.click();
        }
        
        console.log("等待 Watch Ad 弹窗展现（5秒）...");
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        console.log("正在查找并点击 'Watch Ad' 按钮...");
        const watchAdClicked = await page.evaluate(() => {
            const elements = Array.from(document.querySelectorAll('button, div, a, span'));
            const target = elements.find(el => el.textContent.trim() === 'Watch Ad');
            if (target) {
                target.click();
                return true;
            }
            return false;
        });
        
        if (!watchAdClicked) {
            console.log("文本精确查找 'Watch Ad' 失败，尝试模糊匹配...");
            await page.evaluate(() => {
                const elements = Array.from(document.querySelectorAll('button, div, a, span'));
                const target = elements.find(el => el.textContent.includes('Watch Ad'));
                if (target) target.click();
            });
        }
        
        console.log("开始加载并播放广告。等待播放结束重定向（最长等候 90 秒）...");
        let success = false;
        for (let i = 0; i < 9; i++) {
            await new Promise(resolve => setTimeout(resolve, 10000));
            const bodyText = await page.evaluate(() => document.body.innerText);
            if (bodyText.includes("Timer has been extended") || bodyText.includes("extended")) {
                success = true;
                console.log("成功检测到续期字符: 'Timer has been extended.'");
                break;
            }
        }
        
        if (success) {
            console.log("续期任务成功执行。");
        } else {
            console.log("在规定时间内未检测到续期完成字样，截取当前页面分析。");
        }
        
        await page.screenshot({ path: 'screenshot3_result.png' });
        console.log("已保存截图 3: 续期最终状态");
        
    } catch (e) {
        console.error("运行任务中遭遇错误:", e);
    } finally {
        await browser.close();
        console.log("浏览器实例正常关闭。");
    }
}
