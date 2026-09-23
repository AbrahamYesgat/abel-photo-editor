'use strict';

// Synthetic, intercepted responses only. BASE_URL optionally checks deployed static assets.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createServer } = require('../server/index.js');
const result = require('../test/fixtures/intensity-review.json');

(async () => {
    const server = createServer({ env: { LOCAL_REVIEW_ENABLED: 'false' },
        fetch: () => { throw new Error('Unexpected inference'); } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = process.env.BASE_URL || `http://127.0.0.1:${server.address().port}/`;
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
            let calls = 0;
            await page.route('**/*', route => {
                const url = new URL(route.request().url());
                if (url.pathname.endsWith('/api/review')) {
                    calls++;
                    return route.fulfill({ json: result });
                }
                if (url.origin !== new URL(base).origin || url.pathname.includes('/api/')) return route.abort();
                return route.continue();
            });
            await page.goto(base);
            await page.waitForFunction(() => window.app?.review);
            const load = () => page.evaluate(async () => {
                const canvas = document.createElement('canvas');
                canvas.width = 640; canvas.height = 400;
                const ctx = canvas.getContext('2d');
                const gradient = ctx.createLinearGradient(0, 0, 640, 400);
                gradient.addColorStop(0, '#435965'); gradient.addColorStop(1, '#a48a66');
                ctx.fillStyle = gradient; ctx.fillRect(0, 0, 640, 400);
                const blob = await new Promise(resolve => canvas.toBlob(resolve));
                await app._loadFile(new File([blob], 'synthetic-intensities.png', { type: 'image/png' }));
                const mask = app.maskEngine.createMask('brush');
                mask.ctx.fillStyle = 'white'; mask.ctx.fillRect(0, 0, 90, 400);
                mask.adjustments.exposure = -.2;
                app.maskEngine.touch(mask);
                app.state.exposure = .1;
                app.state.temperature = 2;
                app.curveEditor.channels.rgb = [{ x: 0, y: 0 }, { x: 128, y: 119 }, { x: 255, y: 255 }];
                app._pushHistory(); app._render();
            });
            await load();
            const pixels = async () => createHash('sha256').update(await page.evaluate(() =>
                app._renderedCanvas().toDataURL())).digest('hex');
            const baseline = await pixels();
            const beforeEdits = await page.evaluate(() => app.review.snapshot().edits);
            const baselineHistory = await page.evaluate(() => app.history.length);
            await page.locator(mobile ? '.mobile-tab[data-panel=review]' : '.vtab[data-panel=review]').click();
            await page.selectOption('#review-provider', 'gemini');
            await page.locator('#review-connection').evaluate(node => { node.open = true; });
            // The mocked endpoint is local to this page, including on Pages.
            await page.fill('#review-endpoint', new URL(base).origin);
            await page.locator('#review-connection').evaluate(node => { node.open = false; });
            await page.selectOption('#review-gemini-mode', 'adaptive');
            await page.check('#review-consent');
            await page.click('#review-analyze');
            await page.waitForFunction(() => app.review.canCompare());
            if (mobile) await page.click('#review-view-photo');
            await page.locator('#review-photo-controls').waitFor({ state: 'visible' });
            await page.waitForTimeout(400);
            const balanced = await pixels();
            assert.notEqual(balanced, baseline);
            const box = await page.locator('#review-photo-controls').boundingBox();
            assert.ok(box.x >= 0 && box.x + box.width <= (mobile ? 390 : 1440));
            assert.ok(box.y >= 0 && box.y + box.height <= (mobile ? 844 : 1000));
            assert.ok(box.height <= 48, 'collapsed controls leave the photo unobscured');
            const tap = async intensity => {
                const button = page.locator(`[data-intensity="${intensity}"]`);
                if (mobile) await button.tap(); else await button.click();
                assert.equal(await button.getAttribute('aria-pressed'), 'true');
                assert.equal(await page.evaluate(() => !!app._comparisonState || app.showingOriginal), false);
            };
            const hashes = { balanced };
            for (const intensity of ['refine', 'expressive', 'balanced', 'refine', 'expressive', 'balanced']) {
                await tap(intensity);
                const hash = await pixels();
                if (hashes[intensity]) assert.equal(hash, hashes[intensity], 'exact pixel repeat, no cumulative stacking');
                hashes[intensity] = hash;
                assert.equal(await page.evaluate(() => app.history.length), baselineHistory + 1);
                assert.equal(await page.evaluate(() => app.maskEngine.masks[0].adjustments.exposure), -.2);
                await page.evaluate(() => app._startComparison(true));
                assert.equal(await pixels(), baseline, 'all variants compare to the same frozen baseline');
                await page.evaluate(() => app._stopComparison());
                assert.equal(await pixels(), hash);
            }
            assert.equal(new Set(Object.values(hashes)).size, 3, 'independently authored fixtures have distinct rendered results');
            await page.locator('.review-photo-more > summary').click();
            assert.equal(await page.textContent('#review-photo-details'), 'No AI clarity suggested');
            assert.equal(await page.isDisabled('#review-photo-details'), true);
            await page.selectOption('#review-photo-mode', 'global');
            assert.equal(await page.evaluate(() => app.maskEngine.masks.length), 1, 'Global preserves only existing masks');
            const global = await pixels();
            await page.locator('#review-photo-strength').fill('50');
            await page.locator('#review-photo-strength').dispatchEvent('input');
            await page.waitForFunction(() => app.state.exposure === .3);
            assert.equal(await page.evaluate(() => app.state.exposure), .3);
            const partial = await pixels();
            assert.notEqual(partial, global);
            assert.notEqual(partial, baseline);
            await page.selectOption('#review-photo-mode', 'adaptive');
            await page.selectOption('#review-photo-mode', 'global');
            assert.equal(await pixels(), partial);
            await page.click('#btn-undo');
            assert.equal(await pixels(), baseline);
            assert.equal(await page.locator('[data-intensity][aria-pressed=true]').count(), 0);
            await page.click('#btn-redo');
            assert.equal(await pixels(), partial);
            assert.equal(await page.getAttribute('[data-intensity=balanced]', 'aria-pressed'), 'true');
            assert.equal(calls, 1, 'all intensity/mode/strength/history interactions use one review');
            await page.click('#review-open-drawer');
            if (mobile) {
                assert.equal(await page.locator('.sidebar-right').evaluate(node => node.classList.contains('mobile-open')), true);
                await page.click('#review-view-photo');
            }
            // Genuine touch/mouse hold away from the controls, then release.
            const canvas = await page.locator('#main-canvas').boundingBox();
            const point = { x: canvas.x + canvas.width * .5, y: canvas.y + Math.min(30, canvas.height * .2) };
            if (mobile) {
                const cdp = await context.newCDPSession(page);
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
                await page.waitForTimeout(450);
                assert.equal(await pixels(), baseline);
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            } else {
                await page.mouse.move(point.x, point.y); await page.mouse.down();
                await page.waitForTimeout(450);
                assert.equal(await pixels(), baseline);
                await page.mouse.up();
            }
            assert.equal(await pixels(), partial);
            await page.evaluate(() => app._onSliderChange('exposure', .42, 'basic'));
            assert.equal(await page.locator('#review-photo-controls').isVisible(), false);
            assert.equal(await page.evaluate(() => app.review.result), null);
            assert.notEqual(await page.evaluate(() => app.review.snapshot().edits), beforeEdits);
            assert.equal(calls, 1);
            assert.deepEqual(errors, []);
            console.log(`${mobile ? 'Mobile' : 'Desktop'}: one call, six variants, exact pixels, frozen masks/curves, strength, history, drawer and hold/release passed`);
            await context.close();
        }
    } finally {
        await browser.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
