const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const PUSHDEER_KEY = process.env.PUSHDEER_SENDKEY || process.env.PUSHDEER_KEY || 'PDU41296TxwEgSiPrhGtVn81Drnh7gjerPD1vEpwF';

async function sendTelegramMessage(message, imagePath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;

    try {
        const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: TG_CHAT_ID,
            text: message,
            parse_mode: 'Markdown'
        });
        console.log('[Telegram] Message sent.');
    } catch (e) {
        console.error('[Telegram] Failed to send message:', e.message);
    }

    if (imagePath && fs.existsSync(imagePath)) {
        console.log('[Telegram] Sending photo...');
        const cmd = `curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto" -F chat_id="${TG_CHAT_ID}" -F photo="@${imagePath}"`;
        await new Promise(resolve => {
            exec(cmd, (err) => {
                if (err) console.error('[Telegram] Failed to send photo via curl:', err.message);
                else console.log('[Telegram] Photo sent.');
                resolve();
            });
        });
    }
}

async function sendPushDeerMessage(text) {
    if (!PUSHDEER_KEY) return;
    try {
        const url = 'https://api2.pushdeer.com/message/push';
        const ts = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
        const fullMessage = `🔄 KataBump 续期通知\n\n时间: ${ts}\n\n${text}`;
        
        const params = new URLSearchParams();
        params.append('pushkey', PUSHDEER_KEY);
        params.append('text', fullMessage);
        
        await axios.post(url, params.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        console.log('[PushDeer] Message sent.');
    } catch (e) {
        console.error('[PushDeer] Failed to send message:', e.response ? e.response.data : e.message);
    }
}

chromium.use(stealth);

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;

process.env.NO_PROXY = 'localhost,127.0.0.1';

const HTTP_PROXY = process.env.HTTP_PROXY;
let PROXY_CONFIG = null;

if (HTTP_PROXY) {
    try {
        const proxyUrl = new URL(HTTP_PROXY);
        PROXY_CONFIG = {
            server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
            username: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined,
            password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined
        };
        console.log(`[代理] 检测到配置: 服务器=${PROXY_CONFIG.server}, 认证=${PROXY_CONFIG.username ? '是' : '否'}`);
    } catch (e) {
        console.error('[代理] TODO HTTP_PROXY 格式无效。');
        process.exit(1);
    }
}

const INJECTED_SCRIPT = `
(function() {
    if (window.self === window.top) return;
    try {
        function getRandomInt(min, max) {
            return Math.floor(Math.random() * (max - min + 1)) + min;
        }
        let screenX = getRandomInt(800, 1200);
        let screenY = getRandomInt(400, 600);
        Object.defineProperty(MouseEvent.prototype, 'screenX', { value: screenX });
        Object.defineProperty(MouseEvent.prototype, 'screenY', { value: screenY });
    } catch (e) { }
    try {
        const originalAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(init) {
            const shadowRoot = originalAttachShadow.call(this, init);
            if (shadowRoot) {
                const checkAndReport = () => {
                    const checkbox = shadowRoot.querySelector('input[type="checkbox"]');
                    if (checkbox) {
                        const rect = checkbox.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0 && window.innerWidth > 0 && window.innerHeight > 0) {
                            const xRatio = (rect.left + rect.width / 2) / window.innerWidth;
                            const yRatio = (rect.top + rect.height / 2) / window.innerHeight;
                            window.__turnstile_data = { xRatio, yRatio };
                            return true;
                        }
                    }
                    return false;
                };
                if (!checkAndReport()) {
                    const observer = new MutationObserver(() => {
                        if (checkAndReport()) observer.disconnect();
                    });
                    observer.observe(shadowRoot, { childList: true, subtree: true });
                }
            }
            return shadowRoot;
        };
    } catch (e) { }
})();
`;

async function checkProxy() {
    if (!PROXY_CONFIG) return true;
    try {
        const axiosConfig = {
            proxy: {
                protocol: 'http',
                host: new URL(PROXY_CONFIG.server).hostname,
                port: new URL(PROXY_CONFIG.server).port,
            },
            timeout: 10000
        };
        if (PROXY_CONFIG.username && PROXY_CONFIG.password) {
            axiosConfig.proxy.auth = { username: PROXY_CONFIG.username, password: PROXY_CONFIG.password };
        }
        await axios.get('https://www.google.com', axiosConfig);
        return true;
    } catch (error) {
        return false;
    }
}

function checkPort(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://localhost:${port}/json/version`, (res) => { resolve(true); });
        req.on('error', () => resolve(false));
        req.end();
    });
}

async function launchChrome() {
    if (await checkPort(DEBUG_PORT)) return;
    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--window-size=1280,720',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--user-data-dir=/tmp/chrome_user_data',
        '--disable-dev-shm-usage'
    ];
    if (PROXY_CONFIG) {
        args.push(`--proxy-server=${PROXY_CONFIG.server}`);
        args.push('--proxy-bypass-list=<-loopback>');
    }
    const chrome = spawn(CHROME_PATH, args, { detached: true, stdio: 'ignore' });
    chrome.unref();
    for (let i = 0; i < 20; i++) {
        if (await checkPort(DEBUG_PORT)) break;
        await new Promise(r => setTimeout(r, 1000));
    }
}

function getUsers() {
    try {
        if (process.env.USERS_JSON) {
            const parsed = JSON.parse(process.env.USERS_JSON);
            return Array.isArray(parsed) ? parsed : (parsed.users || []);
        }
    } catch (e) { }
    return [];
}

async function attemptTurnstileCdp(page) {
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);
            if (data) {
                const iframeElement = await frame.frameElement();
                if (!iframeElement) continue;
                const box = await iframeElement.boundingBox();
                if (!box) continue;
                const clickX = box.x + (box.width * data.xRatio);
                const clickY = box.y + (box.height * data.yRatio);
                const client = await page.context().newCDPSession(page);
                await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1 });
                await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
                await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1 });
                await client.detach();
                return true;
            }
        } catch (e) { }
    }
    return false;
}

(async () => {
    const users = getUsers();
    if (users.length === 0) process.exit(1);
    if (PROXY_CONFIG && !(await checkProxy())) process.exit(1);

    await launchChrome();
    let browser;
    for (let k = 0; k < 5; k++) {
        try {
            browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
            break;
        } catch (e) {
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    if (!browser) process.exit(1);

    const context = browser.contexts()[0];
    let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    page.setDefaultTimeout(60000);

    if (PROXY_CONFIG && PROXY_CONFIG.username) {
        await context.setHTTPCredentials({ username: PROXY_CONFIG.username, password: PROXY_CONFIG.password });
    }

    await page.addInitScript(INJECTED_SCRIPT);
    const photoDir = path.join(process.cwd(), 'screenshots');
    if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const safeUsername = user.username.replace(/[^a-z0-9]/gi, '_');
        console.log(`\n=== 正在处理用户 ${i + 1}/${users.length} ===`);

        try {
            if (page.isClosed()) {
                page = await context.newPage();
                await page.addInitScript(INJECTED_SCRIPT);
            }
            if (page.url().includes('dashboard')) {
                await page.goto('https://dashboard.katabump.com/auth/logout');
                await page.waitForTimeout(1000);
            }
            await page.goto('https://dashboard.katabump.com/auth/login');
            await page.waitForTimeout(1000);

            const emailInput = page.getByRole('textbox', { name: 'Email' });
            await emailInput.waitFor({ state: 'visible', timeout: 5000 });
            await emailInput.fill(user.username);
            await page.getByRole('textbox', { name: 'Password' }).fill(user.password);

            for (let findAttempt = 0; findAttempt < 10; findAttempt++) {
                if (await attemptTurnstileCdp(page)) break;
                await page.waitForTimeout(1000);
            }
            await page.getByRole('button', { name: 'Login', exact: true }).click();

            if (await page.getByText('Incorrect password or no account').isVisible({ timeout: 3000 })) {
                const failShotPath = path.join(photoDir, `${safeUsername}_fail.png`);
                try { await page.screenshot({ path: failShotPath }); } catch (e) { }
                const msg = `❌ *登录失败*\n用户: ${user.username}\n原因: 账号或密码错误`;
                await sendTelegramMessage(msg, failShotPath);
                await sendPushDeerMessage(msg);
                continue;
            }

            await page.getByRole('link', { name: 'See' }).first().waitFor({ timeout: 15000 });
            await page.getByRole('link', { name: 'See' }).first().click();

            let renewSuccess = false;
            // TIGHTENED RETRY: Reduced from 20 to 10 attempts for faster failure
            for (let attempt = 1; attempt <= 10; attempt++) {
                const renewBtn = page.getByRole('button', { name: 'Renew', exact: true }).first();
                try { await renewBtn.waitFor({ state: 'visible', timeout: 5000 }); } catch (e) { }

                if (await renewBtn.isVisible()) {
                    await renewBtn.click();
                    const modal = page.locator('#renew-modal');
                    try { await modal.waitFor({ state: 'visible', timeout: 5000 }); } catch (e) { continue; }

                    for (let findAttempt = 0; findAttempt < 15; findAttempt++) {
                        if (await attemptTurnstileCdp(page)) break;
                        await page.waitForTimeout(1000);
                    }
                    await page.waitForTimeout(4000);

                    const confirmBtn = modal.getByRole('button', { name: 'Renew' });
                    if (await confirmBtn.isVisible()) {
                        await confirmBtn.click();
                        const startVerifyTime = Date.now();
                        let hasCaptchaError = false;
                        while (Date.now() - startVerifyTime < 3000) {
                            if (await page.getByText('Please complete the captcha to continue').isVisible()) {
                                hasCaptchaError = true;
                                break;
                            }
                            const notTimeLoc = page.getByText("You can't renew your server yet");
                            if (await notTimeLoc.isVisible()) {
                                const text = await notTimeLoc.innerText();
                                const match = text.match(/as of\s+(.*?)\s+\(/);
                                let dateStr = match ? match[1] : 'Unknown Date';
                                const skipShotPath = path.join(photoDir, `${safeUsername}_skip.png`);
                                try { await page.screenshot({ path: skipShotPath }); } catch (e) { }
                                const msg = `⏳ *暂无法续期 (跳过)*\n用户: ${user.username}\n下次可用: ${dateStr}`;
                                await sendTelegramMessage(msg, skipShotPath);
                                await sendPushDeerMessage(msg);
                                renewSuccess = true;
                                break;
                            }
                            await page.waitForTimeout(200);
                        }
                        if (renewSuccess) break;
                        if (hasCaptchaError) {
                            await page.reload();
                            await page.waitForTimeout(2000);
                            continue;
                        }
                        await page.waitForTimeout(2000);
                        if (!await modal.isVisible()) {
                            const successShotPath = path.join(photoDir, `${safeUsername}_success.png`);
                            try { await page.screenshot({ path: successShotPath }); } catch (e) { }
                            const msg = `✅ *续期成功*\n用户: ${user.username}`;
                            await sendTelegramMessage(msg, successShotPath);
                            await sendPushDeerMessage(msg);
                            renewSuccess = true;
                            break;
                        } else {
                            await page.reload();
                            await page.waitForTimeout(2000);
                            continue;
                        }
                    }
                } else {
                    break;
                }
            }
        } catch (err) { }
    }
    await browser.close();
    process.exit(0);
})();
