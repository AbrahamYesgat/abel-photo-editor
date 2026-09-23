'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createServer } = require('../server/index.js');
const fixture = require('../test/fixtures/intensity-review.json');

(async () => {
    const server = createServer({ env: { LOCAL_REVIEW_ENABLED: 'false' } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ headless: true });
    try {
        for (const mobile of [false, true]) {
            const context = await browser.newContext({
                viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
                isMobile: mobile, hasTouch: mobile,
            });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            if (process.env.BASELINE_REV) {
                assert.match(process.env.BASELINE_REV, /^[a-f0-9]{7,40}$/);
                await page.route('**/*', route => {
                    const path = new URL(route.request().url()).pathname.slice(1) || 'index.html';
                    if (!/^(index\.html|js\/[\w-]+\.js|css\/styles\.css)$/.test(path)) return route.continue();
                    const body = execFileSync('git', ['show', `${process.env.BASELINE_REV}:${path}`]);
                    return route.fulfill({ body, contentType: path.endsWith('.js') ? 'application/javascript'
                        : path.endsWith('.css') ? 'text/css' : 'text/html' });
                });
            }
            await page.goto(process.env.BASE_URL || `http://127.0.0.1:${server.address().port}/`);
            await page.waitForFunction(() => window.app?.review);
            await page.evaluate(async fixture => {
                const canvas = document.createElement('canvas');
                canvas.width = 640; canvas.height = 900;
                const ctx = canvas.getContext('2d');
                const gradient = ctx.createLinearGradient(0, 0, 640, 900);
                gradient.addColorStop(0, '#406579'); gradient.addColorStop(1, '#b29477');
                ctx.fillStyle = gradient; ctx.fillRect(0, 0, 640, 900);
                const blob = await new Promise(resolve => canvas.toBlob(resolve));
                await app._loadFile(new File([blob], 'portrait.png', { type: 'image/png' }));
                app.review.result = fixture;
                app.review.context = app.review.snapshot();
                app.review.showResult('adaptive', '100');
                app.review.apply();
            }, fixture);
            await page.locator(mobile ? '.mobile-tab[data-panel=review]' : '.vtab[data-panel=review]').click();
            await page.waitForTimeout(400);
            await page.evaluate(() => app._render());
            await page.evaluate(() => {
                window.transitionFrames = [];
                const start = performance.now();
                const frame = () => {
                    const main = document.getElementById('main-canvas').getBoundingClientRect();
                    const composite = document.getElementById('composite-overlay');
                    const overlay = composite?.getBoundingClientRect();
                    const mismatch = !!overlay && ['x', 'y', 'width', 'height'].some(key => Math.abs(overlay[key] - main[key]) > 1);
                    window.transitionFrames.push({ time: Math.round(performance.now() - start),
                        mismatch, width: main.width, height: main.height,
                        overlayWidth: overlay?.width, overlayHeight: overlay?.height });
                    if (performance.now() - start < 900) requestAnimationFrame(frame);
                };
                requestAnimationFrame(frame);
            });
            if (mobile) await page.click('#review-view-photo');
            else await page.setViewportSize({ width: 1080, height: 760 });
            await page.waitForTimeout(1000);
            const frames = await page.evaluate(() => window.transitionFrames);
            const mismatches = frames.filter(frame => frame.mismatch);
            if (process.env.CAPTURE_ARTIFACTS) {
                mkdirSync('.azure-tools/render-artifacts', { recursive: true });
                const stem = `.azure-tools/render-artifacts/${process.env.BASELINE_REV || 'fixed'}-${mobile ? 'mobile' : 'desktop'}`;
                writeFileSync(`${stem}.json`, JSON.stringify(frames, null, 2));
                await page.screenshot({ path: `${stem}.png` });
            }
            console.log(JSON.stringify({ mobile, baseline: process.env.BASELINE_REV || null,
                frames: frames.length, mismatches: mismatches.length, example: mismatches[0] }));
            if (!process.env.BASELINE_REV) {
                assert.ok(frames.length >= 5);
                assert.equal(mismatches.length, 0, 'every captured frame has one aligned photo');
                assert.equal(await page.locator('#composite-overlay').count(), 0);
                assert.ok((await page.locator('#review-photo-controls').boundingBox()).height <= 48);
                // Orientation change preserves a usable, safe-area-sized control strip.
                if (mobile) {
                    await page.setViewportSize({ width: 667, height: 390 });
                    await page.waitForTimeout(400);
                    const box = await page.locator('#review-photo-controls').boundingBox();
                    assert.ok(box.y >= 0 && box.y + box.height <= 390);
                    await page.locator('.review-photo-more > summary').focus();
                    await page.keyboard.press('Enter');
                    assert.equal(await page.locator('#review-photo-mode').isVisible(), true);
                }
            }
            assert.deepEqual(errors, []);
            await context.close();
        }
    } finally {
        await browser.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
