const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');
const http = require('http');

chromium.use(stealth);

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const USER_DATA_DIR = path.join(__dirname, 'ChromeData_Katabump');
const DEBUG_PORT = 9222;
const HEADLESS = false;
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
        console.log(`[Proxy] Configuration detected: Server=${PROXY_CONFIG.server}, Auth=${PROXY_CONFIG.username ? 'Yes' : 'No'}`);
    } catch (e) {
        console.error('[Proxy] Invalid HTTP_PROXY format.');
        process.exit(1);
    }
}

const INJECTED_SCRIPT = `
(function() {
    if (window.self === window.top) return;
    try {
        function getRandomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
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
                    const observer = new MutationObserver(() => { if (checkAndReport()) observer.disconnect(); });
                    observer.observe(shadowRoot, { childList: true, subtree: true });
                }
            }
            return shadowRoot;
        };
    } catch (e) { console.error('[Injected] Error hooking attachShadow:', e); }
})();
`;

async function checkProxy() {
    if (!PROXY_CONFIG) return true;
    try {
        const axiosConfig = {
            proxy: { protocol: 'http', host: new URL(PROXY_CONFIG.server).hostname, port: new URL(PROXY_CONFIG.server).port },
            timeout: 10000
        };
        if (PROXY_CONFIG.username && PROXY_CONFIG.password) {
            axiosConfig.proxy.auth = { username: PROXY_CONFIG.username, password: PROXY_CONFIG.password };
        }
        await axios.get('https://www.google.com', axiosConfig);
        return true;
    } catch (error) { return false; }
}

function checkPort(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://localhost:${port}/json/version`, (res) => resolve(true));
        req.on('error', () => resolve(false));
        req.end();
    });
}

async function launchNativeChrome() {
    if (await checkPort(DEBUG_PORT)) return;
    const args = [`--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${USER_DATA_DIR}`, '--no-first-run', '--no-default-browser-check'];
    if (PROXY_CONFIG) {
        args.push(`--proxy-server=${PROXY_CONFIG.server}`);
        args.push('--proxy-bypass-list=<-loopback>');
    }
    if (HEADLESS) args.push('--headless=new');
    const chrome = spawn(CHROME_PATH, args, { detached: true, stdio: 'ignore' });
    chrome.unref();
    for (let i = 0; i < 20; i++) {
        if (await checkPort(DEBUG_PORT)) break;
        await new Promise(r => setTimeout(r, 1000));
    }
}

function getUsers() {
    try {
        const data = fs.readFileSync(path.join(__dirname, 'login.json'), 'utf8');
        const json = JSON.parse(data);
        return Array.isArray(json) ? json : (json.users || []);
    } catch (e) { return []; }
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
    if (users.length === 0) return;
    if (PROXY_CONFIG && !(await checkProxy())) process.exit(1);
    await launchNativeChrome();
    let browser;
    for (let k = 0; k < 5; k++) {
        try {
            browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
            break;
        } catch (e) { await new Promise(r => setTimeout(r, 2000)); }
    }
    if (!browser) return;
    const context = browser.contexts()[0];
    let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    if (PROXY_CONFIG && PROXY_CONFIG.username) {
        await context.setHTTPCredentials({ username: PROXY_CONFIG.username, password: PROXY_CONFIG.password });
    }
    await page.addInitScript(INJECTED_SCRIPT);
    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        try {
            if (page.isClosed()) page = await context.newPage();
            await page.goto('https://dashboard.katabump.com/auth/login');
            await page.getByRole('textbox', { name: 'Email' }).fill(user.username);
            await page.getByRole('textbox', { name: 'Password' }).fill(user.password);
            for (let findAttempt = 0; findAttempt < 15; findAttempt++) {
                if (await attemptTurnstileCdp(page)) break;
                await page.waitForTimeout(1000);
            }
            await page.getByRole('button', { name: 'Login', exact: true }).click();
            await page.getByRole('link', { name: 'See' }).first().click();
            for (let attempt = 1; attempt <= 20; attempt++) {
                const renewBtn = page.getByRole('button', { name: 'Renew', exact: true }).first();
                if (await renewBtn.isVisible()) {
                    await renewBtn.click();
                    const modal = page.locator('#renew-modal');
                    for (let findAttempt = 0; findAttempt < 30; findAttempt++) {
                        if (await attemptTurnstileCdp(page)) break;
                        await page.waitForTimeout(1000);
                    }
                    await modal.getByRole('button', { name: 'Renew' }).click();
                    await page.waitForTimeout(2000);
                    if (!await modal.isVisible()) break;
                    await page.reload();
                } else break;
            }
        } catch (err) { }
    }
    await browser.close();
})();
