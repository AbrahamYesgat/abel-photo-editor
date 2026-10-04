'use strict';

// Synthetic pixels and intercepted inference only; no provider usage.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createServer } = require('../server/index.js');
const fixture = require('../test/helpers/texture-fixture.cjs');

(async () => {
    const server = createServer({ env: { LOCAL_REVIEW_ENABLED: 'false' } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = process.env.BASE_URL || `http://127.0.0.1:${server.address().port}/`;
    const browser = await chromium.launch({ headless: true });
    try {
        for (const mobile of [false, true]) {
            const page = await browser.newPage({ viewport: { width: mobile ? 320 : 1440, height: 1000 },
                isMobile: mobile, hasTouch: mobile });
            const errors = [], requests = [];
            let pending;
            page.on('pageerror', error => errors.push(error.message));
            await page.route('**/*', route => {
                const url = new URL(route.request().url());
                if (url.pathname.endsWith('/api/review/azure')) {
                    const request = route.request().postDataJSON();
                    requests.push(request);
                    const result = fixture(request.textureAdjustments?.texture || 0, true);
                    if (pending) return pending(route, result);
                    return route.fulfill({ json: result });
                }
                if (url.origin !== new URL(base).origin || url.pathname.includes('/api/')) return route.abort();
                return route.continue();
            });
            await page.goto(base);
            await page.waitForFunction(() => window.app?.review);
            assert.equal(await page.isDisabled('#texture-enabled'), true);
            assert.equal(await page.isChecked('#review-allow-texture'), false);
            assert.equal(await page.isChecked('#review-allow-details'), true);
            const load = () => page.evaluate(async () => {
                const source = document.createElement('canvas');
                source.width = 640; source.height = 400;
                const ctx = source.getContext('2d'), data = ctx.createImageData(640, 400);
                for (let y = 0; y < 400; y++) for (let x = 0; x < 640; x++) {
                    const i = (y * 640 + x) * 4;
                    const v = x > 560 ? 128 : 128 + 20 * Math.sin(x * 2 * Math.PI / 12) + 8 * Math.sin(y * 2 * Math.PI / 18);
                    data.data[i] = data.data[i + 1] = data.data[i + 2] = v;
                    data.data[i + 3] = 255;
                }
                ctx.putImageData(data, 0, 0);
                const blob = await new Promise(resolve => source.toBlob(resolve));
                await app._loadFile(new File([blob], 'surface.png', { type: 'image/png' }));
            });
            await load();
            const png = () => page.evaluate(() => app._renderedCanvas().toDataURL());
            const baseline = await png();
            await page.locator(mobile ? '.mobile-tab[data-panel=detail]' : '.vtab[data-panel=detail]').click();
            const slider = page.getByRole('slider', { name: 'Texture', exact: true });
            const set = async value => { await slider.fill(String(value)); await slider.dispatchEvent('input'); };
            await set(80);
            const positive = await png();
            assert.notEqual(positive, baseline);
            await page.uncheck('#texture-enabled');
            assert.equal(await png(), baseline);
            assert.equal(await slider.inputValue(), '80');
            assert.equal(await slider.isDisabled(), true);
            await page.check('#texture-enabled');
            assert.equal(await png(), positive);
            await page.click('#btn-undo');
            assert.equal(await png(), baseline);
            assert.equal(await page.isChecked('#texture-enabled'), false);
            await page.click('#btn-redo');
            assert.equal(await png(), positive);
            await set(-80);
            assert.notEqual(await png(), positive);

            const renderer = await page.evaluate(() => {
                const check = (ok, text) => { if (!ok) throw new Error(text); };
                const pixels = canvas => {
                    const copy = document.createElement('canvas');
                    copy.width = canvas.width; copy.height = canvas.height;
                    const ctx = copy.getContext('2d'); ctx.drawImage(canvas, 0, 0);
                    return ctx.getImageData(0, 0, copy.width, copy.height).data;
                };
                const sample = changes => {
                    app.state = { ...app._defaultState(), ...changes };
                    app._render();
                    return pixels(app._renderedCanvas());
                };
                const stats = data => {
                    let sum = 0, square = 0, count = 0;
                    for (let y = 30; y < 370; y++) for (let x = 30; x < 530; x++) {
                        const v = data[(y * 640 + x) * 4];
                        sum += v; square += v * v; count++;
                    }
                    return { mean: sum / count, variance: square / count - (sum / count) ** 2 };
                };
                const zero = sample({}), plus = sample({ texture: 100 }), minus = sample({ texture: -100 });
                const clarity = sample({ clarity: 100 }), sharpen = sample({ sharpenAmount: 100 });
                const a = stats(zero), b = stats(plus), c = stats(minus);
                check(b.variance > a.variance * 1.15, 'positive texture increases surface-band energy');
                check(c.variance < a.variance * .9, 'negative texture reduces surface-band energy');
                check(Math.abs(a.mean - b.mean) < .15 && Math.abs(a.mean - c.mean) < .15, 'no imagewide brightness shift');
                check(plus.some((v, i) => v !== clarity[i]) && plus.some((v, i) => v !== sharpen[i]), 'texture distinct from clarity and sharpening');
                const flat = [sample({ exposure: .6, temperature: 10 }), sample({ exposure: .6, temperature: 10, texture: 100 })];
                check(flat[0].slice((380 * 640 + 600) * 4, (380 * 640 + 600) * 4 + 4).every((v, i) =>
                    v === flat[1][(380 * 640 + 600) * 4 + i]), 'flat area unchanged after tonal edits');
                app.state = app._defaultState();
                const mask = app.maskEngine.createMask('brush');
                mask.ctx.fillStyle = '#fff'; mask.ctx.fillRect(0, 0, 200, 400);
                mask.adjustments.texture = 80; app.maskEngine.touch(mask);
                app._render();
                const local = pixels(app._renderedCanvas());
                check(local.some((v, i) => i < 200 * 4 && v !== zero[i]), 'local texture visible');
                for (let y = 0; y < 400; y++) for (let x = 220; x < 640; x++) {
                    const i = (y * 640 + x) * 4;
                    check(local[i] === zero[i], 'outside mask unchanged');
                }
                app.state.texture = 35; app.state.textureEnabled = false; app._render();
                check(pixels(app._renderedCanvas()).every((v, i) => v === local[i]), 'manual global off keeps original local texture');
                app.state.textureEnabled = true; app._render();
                const gl = app.glEngine.gl, cachedBand = app.glEngine._textureTarget;
                let allocations = 0, readbacks = 0;
                const createTexture = gl.createTexture.bind(gl), readPixels = gl.readPixels.bind(gl);
                const createElement = document.createElement.bind(document);
                const getImageData = CanvasRenderingContext2D.prototype.getImageData;
                gl.createTexture = () => { allocations++; return createTexture(); };
                gl.readPixels = (...args) => { readbacks++; return readPixels(...args); };
                document.createElement = (...args) => { if (args[0] === 'canvas') allocations++; return createElement(...args); };
                CanvasRenderingContext2D.prototype.getImageData = function(...args) {
                    readbacks++; return getImageData.apply(this, args);
                };
                try {
                    for (const value of [40, -20, 60, 0, 35]) {
                        app.state.texture = value; app._render();
                        check(app.glEngine._textureTarget === cachedBand, 'surface cache reused across amounts');
                    }
                } finally {
                    gl.createTexture = createTexture; gl.readPixels = readPixels;
                    document.createElement = createElement;
                    CanvasRenderingContext2D.prototype.getImageData = getImageData;
                }
                check(allocations === 0 && readbacks === 0, `warm texture has no GPU/canvas allocations or readbacks: ${allocations}/${readbacks}`);
                app.state.textureEnabled = false;
                app._render();
                app._syncSlidersFromState(); app._pushHistory();
                return { zero: a, positive: b, negative: c, allocations, readbacks };
            });
            const manualBaseline = await png();
            const masks = await page.evaluate(() => JSON.stringify(app.maskEngine.describeMasks()));
            await page.locator(mobile ? '.mobile-tab[data-panel=review]' : '.vtab[data-panel=review]').click();
            await page.locator('#review-connection').evaluate(node => { node.open = true; });
            await page.fill('#review-endpoint', new URL(base).origin);
            await page.fill('#review-token', 'synthetic-token');
            await page.locator('#review-connection').evaluate(node => { node.open = false; });
            await page.check('#review-allow-texture');
            await page.check('#review-consent');
            await page.selectOption('#review-gemini-mode', 'adaptive');
            await page.click('#review-analyze');
            await page.waitForFunction(() => app.review.canCompare());
            assert.equal(requests.length, 1);
            assert.equal(requests[0].allowTexture, true);
            assert.deepEqual(requests[0].textureAdjustments, { texture: 0 }, 'disabled saved amount is not effective baseline');
            if (mobile) await page.click('#review-view-photo');
            await page.locator('.review-photo-more > summary').click();
            const toggle = page.locator('#review-photo-texture'), clarityToggle = page.locator('#review-photo-details');
            const applied = await png();
            for (let repeat = 0; repeat < 2; repeat++) {
                await toggle.click();
                assert.equal(await page.evaluate(() => app.state.texture), 35);
                assert.equal(await page.evaluate(() => app.state.textureEnabled), false);
                assert.equal(await page.evaluate(() => app.state.clarity), 2, 'texture comparison leaves AI clarity');
                await clarityToggle.click();
                assert.equal(await png(), manualBaseline, 'both AI detail toggles off restore complete baseline');
                assert.equal(await page.evaluate(() => JSON.stringify(app.maskEngine.describeMasks())), masks);
                await clarityToggle.click(); await toggle.click();
                assert.equal(await png(), applied, 'repeat choices never stack');
            }
            for (const intensity of ['refine', 'expressive', 'balanced']) {
                await page.click(`[data-intensity=${intensity}]`);
                await toggle.click(); await clarityToggle.click();
                assert.equal(await png(), manualBaseline);
                await toggle.click(); await clarityToggle.click();
            }
            await page.locator('#review-photo-strength').fill('0');
            await page.locator('#review-photo-strength').dispatchEvent('input');
            assert.equal(await png(), manualBaseline);
            assert.equal(await page.evaluate(() => app.state.textureEnabled), false);
            await page.locator('#review-photo-strength').fill('100');
            await page.locator('#review-photo-strength').dispatchEvent('input');
            assert.equal(await png(), applied);
            await page.click('#btn-undo'); assert.equal(await png(), manualBaseline);
            await page.click('#btn-redo'); assert.equal(await png(), applied);
            assert.equal(requests.length, 1);
            await page.evaluate(() => app._onSliderChange('texture', 14));
            assert.equal(await page.evaluate(() => app.review.result), null, 'manual edit invalidates cached alternatives');

            // Explicit permission revoked while a response is pending cannot apply it.
            await page.locator(mobile ? '.mobile-tab[data-panel=review]' : '.vtab[data-panel=review]').click();
            let release;
            pending = async (route, result) => {
                await new Promise(resolve => { release = resolve; });
                await route.fulfill({ json: result }).catch(() => {});
            };
            const beforeBusy = await png();
            await page.click('#review-analyze');
            await page.waitForFunction(() => !!app.review.controller);
            await page.uncheck('#review-allow-texture');
            while (!release) await new Promise(resolve => setTimeout(resolve, 10));
            release();
            await page.waitForFunction(() => !app.review.controller);
            assert.equal(await png(), beforeBusy);
            assert.equal(await page.evaluate(() => app.review.result), null);
            pending = null;
            await page.click('#review-analyze');
            await page.waitForFunction(() => !app.review.controller);
            assert.equal(requests.at(-1).allowTexture, false);
            assert.equal(requests.at(-1).textureAdjustments, undefined);
            assert.equal(await page.evaluate(() => app.review.result), null, 'unsolicited texture rejects entire response');
            await load();
            assert.equal(await page.isChecked('#review-consent'), false);
            assert.equal(await page.isChecked('#review-allow-texture'), false);
            assert.equal(await page.evaluate(() => app.state.texture), 0);
            assert.deepEqual(errors, []);
            console.log(`${mobile ? 'Mobile 320px' : 'Desktop'} Texture: manual/toggles, pixels, masks, cached AI, undo, consent/stale response passed. ${JSON.stringify(renderer)}`);
            await page.close();
        }
    } finally {
        await browser.close(); server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
