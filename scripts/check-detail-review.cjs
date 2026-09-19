'use strict';

// Synthetic image and intercepted inference only; BASE_URL can verify deployed assets.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createServer } = require('../server/index.js');
const fixture = require('../test/helpers/detail-fixture.cjs');
const hash = value => createHash('sha256').update(value).digest('hex');

(async () => {
    const server = createServer({ env: { LOCAL_REVIEW_ENABLED: 'false' },
        fetch: () => { throw new Error('Unexpected inference'); } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = process.env.BASE_URL || `http://127.0.0.1:${server.address().port}/`;
    const browser = await chromium.launch({ headless: true });
    try {
        for (const mobile of [false, true]) {
            const width = mobile ? 320 : 1440;
            const context = await browser.newContext({
                viewport: { width, height: mobile ? 844 : 1000 }, isMobile: mobile, hasTouch: mobile
            });
            const page = await context.newPage();
            const errors = [], requests = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.route('**/*', route => {
                const url = new URL(route.request().url());
                if (url.pathname.endsWith('/api/review')) {
                    requests.push(route.request().postDataJSON());
                    return route.fulfill({ json: fixture() });
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
                ctx.fillStyle = '#687078'; ctx.fillRect(0, 0, 640, 400);
                for (let x = 100; x < 540; x += 4) {
                    ctx.fillStyle = x % 8 ? '#495058' : '#939ba3';
                    ctx.fillRect(x, 60, 2, 280);
                }
                const blob = await new Promise(resolve => canvas.toBlob(resolve));
                await app._loadFile(new File([blob], 'synthetic-detail.png', { type: 'image/png' }));
                app.state.clarity = 20;
                app.state.exposure = 0.2;
                const mask = app.maskEngine.createMask('brush');
                mask.ctx.fillStyle = 'white'; mask.ctx.fillRect(0, 0, 160, 400);
                mask.adjustments.clarity = -7;
                app.maskEngine.touch(mask);
                app._pushHistory(); app._render();
            });
            await load();
            assert.equal(await page.isChecked('#review-allow-details'), false);
            const png = () => page.evaluate(() => app._renderedCanvas().toDataURL().split(',')[1]);
            const pixels = async () => hash(Buffer.from(await png(), 'base64'));
            const exportPixels = async () => hash(Buffer.from(await page.evaluate(() => new Promise(resolve => {
                const original = app._downloadBlob;
                app._downloadBlob = blob => {
                    app._downloadBlob = original;
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result.split(',')[1]);
                    reader.readAsDataURL(blob);
                };
                document.getElementById('export-format').value = 'png';
                document.getElementById('export-scale').value = '1';
                app._doExport();
            })), 'base64'));
            const baseline = await pixels();
            const beforeMasks = await page.evaluate(() => JSON.stringify(app.maskEngine.describeMasks()));
            const history = await page.evaluate(() => app.history.length);
            await page.locator(mobile ? '.mobile-tab[data-panel=review]' : '.vtab[data-panel=review]').click();
            await page.locator('#review-connection').evaluate(node => { node.open = true; });
            await page.fill('#review-endpoint', new URL(base).origin);
            await page.locator('#review-connection').evaluate(node => { node.open = false; });
            await page.check('#review-allow-details');
            await page.check('#review-consent');
            await page.selectOption('#review-gemini-mode', 'adaptive');
            await page.click('#review-analyze');
            await page.waitForFunction(() => app.review.canCompare());
            if (mobile) await page.click('#review-view-photo');
            const details = page.locator('#review-photo-details');
            await details.waitFor({ state: 'visible' });
            const applied = await pixels();
            assert.notEqual(applied, baseline, 'clarity has a real pixel effect');
            assert.equal(await exportPixels(), applied, 'PNG export matches the full masked render');
            assert.equal(requests.length, 1);
            assert.equal(requests[0].allowDetails, true);
            assert.deepEqual(requests[0].detailAdjustments, { clarity: 20 });
            const buttons = await page.locator('.review-intensities button').evaluateAll(nodes =>
                nodes.filter(node => !node.hidden).map(node => {
                    const r = node.getBoundingClientRect();
                    return { left: r.left, right: r.right, height: r.height };
                }));
            assert.equal(buttons.length, 4);
            buttons.forEach((box, i) => {
                assert.ok(box.left >= 0 && box.right <= width && box.height >= 44, 'mobile-safe tap bounds');
                if (i) assert.ok(box.left >= buttons[i - 1].right, 'buttons do not overlap');
            });
            for (let i = 0; i < 3; i++) {
                await details.click();
                assert.equal(await pixels(), baseline, 'detail-only adaptive off retains original global and masked clarity');
                assert.equal(await page.evaluate(() => JSON.stringify(app.maskEngine.describeMasks())), beforeMasks);
                assert.equal(await exportPixels(), baseline);
                await details.click();
                assert.equal(await pixels(), applied, 'repeated toggle never stacks');
            }
            for (const intensity of ['refine', 'expressive', 'balanced']) {
                await page.click(`[data-intensity=${intensity}]`);
                await details.click();
                assert.equal(await pixels(), baseline);
                await details.click();
                assert.notEqual(await pixels(), baseline);
            }
            await page.selectOption('#review-photo-mode', 'global');
            const global = await pixels();
            await details.click();
            const lighting = await pixels();
            assert.notEqual(lighting, baseline);
            assert.notEqual(lighting, global);
            assert.equal(await page.evaluate(() => app.state.clarity), 20);
            await details.click();
            assert.equal(await pixels(), global);
            await page.locator('#review-photo-strength').fill('0');
            await page.locator('#review-photo-strength').dispatchEvent('input');
            assert.equal(await pixels(), baseline);
            await page.locator('#review-photo-strength').fill('50');
            await page.locator('#review-photo-strength').dispatchEvent('input');
            assert.equal(await page.evaluate(() => app.state.clarity), 24);
            const partial = await pixels();
            await page.click('#btn-undo');
            assert.equal(await pixels(), baseline);
            await page.click('#btn-redo');
            assert.equal(await pixels(), partial);
            await page.evaluate(() => app._startComparison(true));
            assert.equal(await pixels(), baseline);
            await page.evaluate(() => app._stopComparison());
            assert.equal(await pixels(), partial);
            assert.equal(await page.evaluate(() => app.history.length), history + 1);
            assert.equal(requests.length, 1, 'all cached choices and exports use zero new requests');

            // Flat source areas must not gain false "detail" from unrelated exposure/color edits.
            const flat = await page.evaluate(() => {
                app.review.invalidate('Renderer check');
                app.maskEngine.masks = [];
                app.state.exposure = 1;
                app.state.temperature = 15;
                const sample = clarity => {
                    app.state.clarity = clarity; app._render();
                    const canvas = document.createElement('canvas');
                    canvas.width = 640; canvas.height = 400;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(app._renderedCanvas(), 0, 0);
                    return Array.from(ctx.getImageData(600, 370, 1, 1).data);
                };
                return [sample(0), sample(30)];
            });
            assert.deepEqual(flat[0], flat[1], 'clarity compares source with source, not post-exposure color');
            await load();
            assert.equal(await page.isChecked('#review-allow-details'), false, 'new photo requires fresh opt-in');
            assert.equal(await details.isVisible(), false);
            assert.deepEqual(errors, []);
            console.log(`${mobile ? 'Mobile 320px' : 'Desktop'}: detail pixel effect, cached comparison, masks, export, undo/redo, bounds and reset passed.`);
            await context.close();
        }
    } finally {
        await browser.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
