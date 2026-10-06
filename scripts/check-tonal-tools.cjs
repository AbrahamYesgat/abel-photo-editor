'use strict';
// Synthetic pixels and intercepted inference only, on desktop and mobile.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createServer } = require('../server/index.js');
const contract = require('../js/review-contract.js');
const fixture = require('../test/fixtures/intensity-review.json');
const copy = value => JSON.parse(JSON.stringify(value));

(async () => {
    const server = createServer({ env: { LOCAL_REVIEW_ENABLED: 'false' } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = process.env.BASE_URL || `http://127.0.0.1:${server.address().port}/`;
    const browser = await chromium.launch({ headless: true });
    try {
        for (const mobile of [false, true]) {
            const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } :
                { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile });
            const page = await context.newPage(), errors = [];
            page.on('pageerror', error => errors.push(error.message));
            let calls = 0;
            await page.route('**/*', route => {
                const url = new URL(route.request().url());
                if (url.pathname.endsWith('/api/review')) {
                    calls++;
                    const request = contract.validateRequest(route.request().postDataJSON());
                    assert.equal(request.allowColorGrading, true); assert.equal(request.allowCurves, true);
                    const result = copy(fixture);
                    for (const [intensity, variant] of Object.entries(result.variants)) {
                        for (const recipe of [variant, variant.adaptive]) {
                            const settings = copy(request.currentColorGrading);
                            settings.highlights = { hue: 40, saturation: settings.highlights.saturation +
                                { refine: 4, balanced: 8, expressive: 16 }[intensity] };
                            recipe.colorGrading = [{ settings, reason: 'Support the warm light without cooling skin.' }];
                            recipe.curves = [{ points: request.currentCurves.rgb.map(p => ({
                                x: p.x / 255, y: (p.y + (p.x === 128 ? { refine: 2, balanced: 4, expressive: 6 }[intensity] : 0)) / 255
                            })), reason: 'Lift midtones while preserving the black and white points.' }];
                        }
                    }
                    return route.fulfill({ json: contract.validateReview(result, request) });
                }
                if (url.origin !== new URL(base).origin || url.pathname.includes('/api/')) return route.abort();
                return route.continue();
            });
            await page.goto(base); await page.waitForFunction(() => window.app?.review);
            await page.evaluate(async () => {
                const source = document.createElement('canvas'); source.width = 640; source.height = 400;
                const ctx = source.getContext('2d');
                for (let x = 0; x < 640; x++) {
                    const v = Math.round(25 + x * 205 / 640);
                    ctx.fillStyle = `rgb(${v},${v},${v})`; ctx.fillRect(x, 0, 1, 400);
                }
                const blob = await new Promise(resolve => source.toBlob(resolve));
                await app._loadFile(new File([blob], 'tonal-synthetic.png', { type: 'image/png' }));
            });
            const pixels = async () => createHash('sha256').update(await page.evaluate(() =>
                app._renderedCanvas().toDataURL())).digest('hex');
            const open = panel => page.locator(`${mobile ? '.mobile-tab' : '.vtab'}[data-panel=${panel}]`).click();
            await open('color');
            const plain = await pixels();
            for (const [key, value] of [['shadows_hue', 220], ['shadows_saturation', 12], ['midtones_hue', 90],
                ['midtones_saturation', 3], ['highlights_hue', 40], ['highlights_saturation', 5],
                ['blending', 60], ['balance', 5]]) {
                await page.locator(`#slider-grade_${key}`).evaluate((node, v) => {
                    node.value = v; node.dispatchEvent(new Event('input', { bubbles: true }));
                }, value);
            }
            const graded = await pixels(); assert.notEqual(graded, plain);
            await page.uncheck('#color-grading-enabled'); assert.equal(await pixels(), plain);
            await page.check('#color-grading-enabled'); assert.equal(await pixels(), graded);
            const gpu = await page.evaluate(() => {
                const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 400;
                const ctx = canvas.getContext('2d'); ctx.drawImage(app._renderedCanvas(), 0, 0, 640, 400);
                let max = 0;
                for (const x of [50, 150, 320, 500, 590]) {
                    const value = Math.round(25 + x * 205 / 640) / 255;
                    const expected = TonalTools.gradePixel([value, value, value], app.state.colorGrading);
                    const actual = ctx.getImageData(x, 200, 1, 1).data;
                    expected.forEach((v, i) => max = Math.max(max, Math.abs(actual[i] - v * 255)));
                }
                return max;
            });
            assert.ok(gpu <= 2, `GPU grading reference error ${gpu}`);
            await open('curve');
            assert.equal(await page.locator('.curve-tab').count(), 4, 'reuse existing RGB/channel editor');
            const curveCanvas = page.locator('.curve-canvas'), curveBox = await curveCanvas.boundingBox();
            await curveCanvas.click({ position: { x: curveBox.width * .5, y: curveBox.height * .55 } });
            assert.notEqual(await pixels(), graded, 'manual canvas point visibly changes the curve');
            await page.evaluate(() => app._undo());
            assert.equal(await pixels(), graded, 'manual curve gesture has a working baseline undo');
            await page.evaluate(() => {
                app.curveEditor.onBeforeChange();
                app.curveEditor.channels.rgb = [{ x: 0, y: 4 }, { x: 128, y: 120 }, { x: 255, y: 251 }];
                app.curveEditor.channels.r = [{ x: 0, y: 1 }, { x: 128, y: 126 }, { x: 255, y: 253 }];
                app.curveEditor.draw(); app.curveEditor._emitChange(); app.curveEditor.onCommit();
                const mask = app.maskEngine.createMask('radial');
                app.maskEngine.createRadialMask(140, 200, 130, 160, 90);
                mask.adjustments.exposure = -.1;
                app._pushHistory(); app._render();
            });
            const baseline = await pixels();
            const before = await page.evaluate(() => JSON.parse(app.review.snapshot().edits));
            await open('review');
            assert.equal(await page.isChecked('#review-allow-grade'), false);
            assert.equal(await page.isChecked('#review-allow-curves'), false);
            await page.selectOption('#review-provider', 'gemini');
            await page.locator('#review-connection').evaluate(node => node.open = true);
            await page.fill('#review-endpoint', new URL(base).origin);
            await page.locator('#review-connection').evaluate(node => node.open = false);
            await page.check('#review-allow-grade'); await page.check('#review-allow-curves');
            await page.check('#review-consent');
            await page.selectOption('#review-gemini-mode', 'global');
            await page.click('#review-analyze');
            await page.waitForFunction(() => app.review.canCompare());
            if (mobile) await page.click('#review-view-photo');
            await page.locator('.review-photo-more > summary').click();
            const hashes = new Map();
            for (const mode of ['global', 'adaptive']) {
                await page.selectOption('#review-photo-mode', mode);
                for (const intensity of ['refine', 'balanced', 'expressive', 'balanced']) {
                    await page.locator(`[data-intensity=${intensity}]`).click();
                    const key = `${mode}/${intensity}`, hash = await pixels();
                    assert.notEqual(hash, baseline);
                    if (hashes.has(key)) assert.equal(hash, hashes.get(key)); else hashes.set(key, hash);
                    await page.evaluate(() => app._startComparison(true));
                    assert.equal(await pixels(), baseline, 'before includes exact pre-AI curves and grade');
                    await page.evaluate(() => app._stopComparison());
                    await page.click('#review-photo-grade');
                    assert.deepEqual(await page.evaluate(() => app.state.colorGrading), before.state.colorGrading);
                    assert.notDeepEqual(await page.evaluate(() => app.curveEditor.channels.rgb), before.curves.rgb);
                    await page.click('#review-photo-curves');
                    assert.deepEqual(await page.evaluate(() => app.curveEditor.channels), before.curves);
                    assert.notEqual(await pixels(), baseline, 'lighting remains when both optional components are off');
                    await page.click('#review-photo-grade'); await page.click('#review-photo-curves');
                    assert.equal(await pixels(), hash, 'toggles use cached targets, never stack');
                }
            }
            const latest = await pixels();
            await page.evaluate(() => app._undo()); assert.equal(await pixels(), baseline);
            await page.evaluate(() => app._redo()); assert.equal(await pixels(), latest);
            await page.evaluate(() => {
                app.curveEditor.onBeforeChange();
                app.curveEditor.channels.g[0].y = 3;
                app.curveEditor._emitChange(); app.curveEditor.onCommit();
            });
            assert.equal(await page.evaluate(() => app.review.result), null);
            assert.equal(calls, 1); assert.deepEqual(errors, []);
            console.log(`${mobile ? 'Mobile' : 'Desktop'}: manual grading, GPU reference, existing curves, six tonal recipes, independent toggles, exact before/undo/redo; one request`);
            await context.close();
        }
    } finally {
        await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
