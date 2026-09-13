// Uses an existing Playwright installation; all companion requests are mocked.
// By default, public assets are served from disk at a synthetic deployed origin.
// BASE_URL optionally checks the actual deployed frontend, never real inference.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const origin = process.env.BASE_URL || 'https://abel-editor.test/';
const key = 'abel.local-connection.v1';
const token = 'synthetic-browser-test-token';
const endpoint = 'http://127.0.0.1:4178';

(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        for (const mobile of [false, true]) {
            const context = await browser.newContext({
                viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
                isMobile: mobile, hasTouch: mobile,
            });
            let checks = 0;
            const unexpected = [];
            const errors = [];
            await context.route('**/*', async route => {
                const request = route.request();
                const url = new URL(request.url());
                if (url.origin === endpoint && url.pathname === '/api/review/local/status') {
                    assert.equal(request.headers().authorization, `Bearer ${token}`);
                    assert.equal(request.method(), 'GET');
                    assert.equal(request.postData(), null);
                    checks++;
                    return route.fulfill({ json: {
                        provider: 'ollama', model: 'qwen3-vl:2b-instruct', ready: true, localOnly: true,
                    } });
                }
                if (url.origin === new URL(origin).origin && !url.pathname.includes('/api/')) {
                    if (process.env.BASE_URL) return route.continue();
                    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
                    if (/^(index\.html|manifest\.json|(?:js|css)\/[\w.-]+\.(?:js|css))$/.test(file)) {
                        return route.fulfill({
                            body: readFileSync(path.join(__dirname, '..', file)),
                            contentType: file.endsWith('.js') ? 'text/javascript'
                                : file.endsWith('.css') ? 'text/css' : 'text/html',
                        });
                    }
                }
                if (url.pathname.includes('/api/')) unexpected.push(request.url());
                return route.abort();
            });
            const openPanel = async page => {
                await page.waitForFunction(() => !!window.app?.review);
                await page.locator(mobile ? '.mobile-tab[data-panel=review]' : '.vtab[data-panel=review]').click();
            };
            const page = await context.newPage();
            page.on('pageerror', error => errors.push(error.message));
            await page.goto(origin);
            await openPanel(page);
            await page.locator('#review-provider').selectOption('local');
            await page.locator('#review-local-token').fill(token);
            assert.equal(await page.evaluate(key => localStorage.getItem(key), key), null);
            assert.equal(await page.locator('#review-remember-local').isChecked(), true);
            await page.locator('#review-check-local').click();
            await page.waitForFunction(() => document.getElementById('review-local-token-field').hidden);
            assert.equal(checks, 1);
            assert.equal(await page.locator('#review-local-token').inputValue(), '');
            assert.match(await page.locator('#review-local-storage-status').textContent(), /Saved on this browser/);
            assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key), {
                version: 1, endpoint: `${endpoint}/api/review/local`, token,
            });
            await page.reload();
            await openPanel(page);
            assert.equal(await page.locator('#review-provider').inputValue(), 'local');
            assert.equal(await page.locator('#review-local-token').isVisible(), false);
            assert.equal(await page.locator('#review-consent').isChecked(), false);
            assert.equal(checks, 1, 'refresh never checks or uploads automatically');
            assert.equal(await page.locator('#review-analyze').isDisabled(), true);
            await page.locator('#review-check-local').click();
            await page.waitForFunction(() => !app.review.controller);
            assert.equal(checks, 2, 'remembered token authenticates a new explicit check');
            const tab = await context.newPage();
            await tab.goto(origin);
            await openPanel(tab);
            assert.equal(await tab.locator('#review-local-token').isVisible(), false);
            assert.equal(await tab.locator('#review-consent').isChecked(), false);
            assert.equal(checks, 2, 'new tabs do not make requests');
            await page.evaluate(() => { app.state.exposure = 0.4; });
            await page.locator('#review-forget-local').click();
            await tab.waitForFunction(() => !app.review.savedLocalConnection);
            assert.equal(await tab.locator('#review-local-token').inputValue(), '');
            assert.equal(await tab.locator('#review-local-token').isVisible(), true);
            await tab.close();
            assert.equal(await page.locator('#review-local-token').isVisible(), true);
            assert.equal(await page.locator('#review-local-token').inputValue(), '');
            assert.equal(await page.evaluate(key => localStorage.getItem(key), key), null);
            assert.equal(await page.evaluate(() => app.state.exposure), 0.4);
            await page.locator('#review-local-token').fill(token);
            await page.locator('#review-check-local').click();
            await page.waitForFunction(() => document.getElementById('review-local-token-field').hidden);
            await page.locator('#review-local-endpoint').fill('http://127.0.0.1:4180');
            assert.equal(await page.locator('#review-local-token').inputValue(), '');
            assert.equal(await page.evaluate(key => localStorage.getItem(key), key), null);
            assert.equal(await page.locator('#review-consent').isChecked(), false);
            await page.locator('#review-local-endpoint').fill(endpoint);
            await page.locator('#review-remember-local').uncheck();
            await page.locator('#review-local-token').fill(token);
            await page.locator('#review-check-local').click();
            await page.waitForFunction(() => !app.review.controller);
            assert.equal(await page.evaluate(key => localStorage.getItem(key), key), null);
            await page.locator('#review-remember-local').check();
            await page.evaluate(() => {
                Storage.prototype.setItem = () => { throw new DOMException('Blocked', 'QuotaExceededError'); };
            });
            await page.locator('#review-check-local').click();
            await page.waitForFunction(() => !app.review.controller);
            assert.match(await page.locator('#review-local-storage-status').textContent(), /could not save/);
            assert.equal(await page.locator('#review-local-token').isVisible(), true);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            assert.deepEqual(unexpected, []);
            assert.deepEqual(errors, []);
            await context.close();
            console.log(`${mobile ? 'Mobile' : 'Desktop'}: persistence, refresh/tab, consent, forget, endpoint binding, opt-out and storage failure passed.`);
        }
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
