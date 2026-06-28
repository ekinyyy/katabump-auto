const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const PUSHDEER_KEY = process.env.PUSHDEER_SENDKEY || process.env.PUSHDEER_KEY;

async function sendTelegramMessage(message, imagePath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
    try {
        await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, { chat_id: TG_CHAT_ID, text: message, parse_mode: 'Markdown' });
    } catch (e) { }
    if (imagePath && fs.existsSync(imagePath)) {
        const cmd = `curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto" -F chat_id="${TG_CHAT_ID}" -F photo="@${imagePath}"`;
        exec(cmd);
    }
}

async function sendPushDeerMessage(text) {
    if (!PUSHDEER_KEY) return;
    try {
        const fullMessage = `🔄 KataBump 续期通知\n\n${text}`;
        const params = new URLSearchParams();
        params.append('pushkey', PUSHDEER_KEY);
        params.append('text', fullMessage);
        await axios.post('https://api2.pushdeer.com/message/push', params.toString());
    } catch (e) { }
}

chromium.use(stealth);
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;

const INJECTED_SCRIPT = `
(function() {
    if (window.self === window.top) return;
    try {
        const originalAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(init) {
            const shadowRoot = originalAttachShadow.call(this, init);
            if (shadowRoot) {
                const checkAndReport = () => {
                    const checkbox = shadowRoot.querySelector('input[type="checkbox"]');
                    if (checkbox) {
                        const rect = checkbox.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0) {
                            window.__turnstile_data = { xRatio: (rect.left + rect.width / 2) / window.innerWidth, yRatio: (rect.top + rect.height / 2) / window.innerHeight };
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
    } catch (e) { }
})();
`;

async function attemptTurnstileCdp(page) {
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);
            if (data) {
                const iframeElement = await frame.frameElement();
                const box = await iframeElement.boundingBox();
                const client = await page.context().newCDPSession(page);
                await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x + box.width * data.xRatio, y: box.y + box.height * data.yRatio, button: 'left', clickCount: 1 });
                await new Promise(r => setTimeout(r, 100));
                await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + box.width * data.xRatio, y: box.y + box.height * data.yRatio, button: 'left', clickCount: 1 });
                await client.detach();
                return true;
            }
        } catch (e) { }
    }
    return false;
}

(async () => {
    const users = JSON.parse(process.env.USERS_JSON || '[]');
    if (users.length === 0) process.exit(1);
    const chrome = spawn(CHROME_PATH, [`--remote-debugging-port=${DEBUG_PORT}`, '--no-sandbox', '--user-data-dir=/tmp/chrome_user_data']);
    await new Promise(r => setTimeout(r, 5000));
    const browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
    const context = browser.contexts()[0];
    let page = await context.newPage();
    await page.addInitScript(INJECTED_SCRIPT);
    for (const user of users) {
        try {
            await page.goto('https://dashboard.katabump.com/auth/login');
            await page.getByRole('textbox', { name: 'Email' }).fill(user.username);
            await page.getByRole('textbox', { name: 'Password' }).fill(user.password);
            for (let i = 0; i < 10; i++) { if (await attemptTurnstileCdp(page)) break; await page.waitForTimeout(1000); }
            await page.getByRole('button', { name: 'Login' }).click();
            await page.getByRole('link', { name: 'See' }).first().click();
            const renewBtn = page.getByRole('button', { name: 'Renew' }).first();
            if (await renewBtn.isVisible()) {
                await renewBtn.click();
                for (let i = 0; i < 10; i++) { if (await attemptTurnstileCdp(page)) break; await page.waitForTimeout(1000); }
                await page.locator('#renew-modal').getByRole('button', { name: 'Renew' }).click();
                await sendPushDeerMessage(`User ${user.username} renewed successfully!`);
            }
        } catch (e) { }
    }
    await browser.close();
    process.exit(0);
})();
