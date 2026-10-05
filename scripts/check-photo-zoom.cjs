'use strict';

// Real Chromium touch input; synthetic photos and intercepted review, never inference.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createServer } = require('../server/index.js');
const result = require('../test/fixtures/intensity-review.json');
const fs = require('node:fs');

(async () => {
    const server = createServer({ env: { LOCAL_REVIEW_ENABLED: 'false' },
        fetch: () => { throw new Error('Unexpected inference'); } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = process.env.BASE_URL || `http://127.0.0.1:${server.address().port}/`;
    const browser = await chromium.launch({ headless: true });
    try {
        for (const mobile of [true, false]) {
            const context = await browser.newContext({ viewport: { width: mobile ? 390 : 1440, height: mobile ? 844 : 1000 },
                isMobile: mobile, hasTouch: true });
            const page = await context.newPage(), errors = [];
            page.on('pageerror', e => errors.push(e.message));
            await page.route('**/*', route => {
                const url = new URL(route.request().url());
                if (url.pathname.endsWith('/api/review')) return route.fulfill({ json: result });
                if (url.origin !== new URL(base).origin || url.pathname.includes('/api/')) return route.abort();
                return route.continue();
            });
            await page.goto(base);
            await page.waitForFunction(() => window.app?.viewport);
            const load = (width = 1200, height = 800) => page.evaluate(async ([w, h]) => {
                const c = document.createElement('canvas'); c.width = w; c.height = h;
                const ctx = c.getContext('2d'), g = ctx.createLinearGradient(0, 0, w, h);
                g.addColorStop(0, '#193759'); g.addColorStop(1, '#f9c17f');
                ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
                ctx.fillStyle = '#f34'; ctx.fillRect(w * .3, h * .3, w * .12, h * .12);
                const blob = await new Promise(resolve => c.toBlob(resolve));
                await app._loadFile(new File([blob], 'zoom.png', { type: 'image/png' }));
            }, [width, height]);
            await load();
            const cdp = await context.newCDPSession(page);
            const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', {
                type, touchPoints: points.map((p, i) => ({ id: i + 1, radiusX: 2, radiusY: 2, ...p })),
            });
            const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            const metrics = () => page.evaluate(() => {
                const r = document.getElementById('main-canvas').getBoundingClientRect();
                return { x: r.x, y: r.y, width: r.width, height: r.height, scale: app.viewport.scale,
                    panX: app.viewport.x, panY: app.viewport.y, pageScale: visualViewport.scale };
            });
            const center = async () => {
                const c = await page.locator('#canvas-container').boundingBox();
                return { x: c.x + c.width / 2, y: c.y + c.height / 2 };
            };
            const pinch = async (factor = 2, dx = 0, dy = 0, finish = true) => {
                const p = await center();
                const pair = (d, x = 0, y = 0) => [{ x: p.x - d + x, y: p.y + y }, { x: p.x + d + x, y: p.y + y }];
                await touch('touchStart', pair(35));
                for (let i = 1; i <= 8; i++) {
                    await touch('touchMove', pair(35 * (1 + (factor - 1) * i / 8), dx * i / 8, dy * i / 8));
                }
                if (finish) await touch('touchEnd', []);
                await frame();
            };
            const pristine = await page.evaluate(() => ({
                png: app._exportCanvas(1).toDataURL(), preview: app.review.preview(),
                edits: app.review.snapshot().edits, history: app.history.length,
            }));
            const fit = await metrics(), toolbar = await page.locator('.toolbar').boundingBox();
            await pinch(2, 18);
            let zoom = await metrics();
            assert.ok(Math.abs(zoom.scale - 2) < .01);
            assert.ok(Math.abs(zoom.panX - 18) < .5, 'centroid movement pans');
            assert.equal(zoom.pageScale, 1);
            assert.ok(Math.abs(zoom.width / fit.width - 2) < .01);
            assert.deepEqual(await page.locator('.toolbar').boundingBox(), toolbar);
            assert.deepEqual(await page.evaluate(() => ({
                png: app._exportCanvas(1).toDataURL(), preview: app.review.preview(),
                edits: app.review.snapshot().edits, history: app.history.length,
            })), pristine, 'zoom does not change native export, full AI preview, edits or history');
            assert.equal(await page.locator('#composite-overlay').count(), 0);
            await pinch(.1);
            assert.equal((await metrics()).scale, 1);
            for (let i = 0; i < 4; i++) await pinch(2);
            assert.equal((await metrics()).scale, 8);
            await page.click('#btn-fit'); await frame();
            assert.equal((await metrics()).scale, 1);
            // Noncentral image anchor, then a remaining finger pans without restarting a hold.
            const p = await center(), anchor = { x: p.x + 25, y: p.y };
            await touch('touchStart', [{ x: anchor.x - 30, y: anchor.y }, { x: anchor.x + 30, y: anchor.y }]);
            await touch('touchMove', [{ x: anchor.x - 60, y: anchor.y }, { x: anchor.x + 60, y: anchor.y }]);
            await frame();
            assert.ok(Math.abs((await metrics()).panX + 25) < .5, 'off-center anchor retained');
            await touch('touchEnd', [{ id: 2, x: anchor.x + 60, y: anchor.y }]);
            await touch('touchMove', [{ x: anchor.x - 40, y: anchor.y }]);
            await page.waitForTimeout(400);
            assert.equal(await page.evaluate(() => app.showingOriginal || !!app._comparisonState), false);
            await touch('touchEnd', []);
            await frame();
            assert.ok(Math.abs((await metrics()).panX + 5) < .5, JSON.stringify(await metrics()));
            // New one-finger drag, cancellation and a fresh hold/release.
            await touch('touchStart', [p]); await touch('touchMove', [{ x: p.x - 30, y: p.y }]);
            await touch('touchCancel', []); await frame();
            assert.equal(await page.evaluate(() => app.viewport.pointers.size), 0);
            await touch('touchStart', [p]); await page.waitForTimeout(410);
            assert.equal(await page.evaluate(() => app.showingOriginal), true);
            await pinch(1.2);
            assert.equal(await page.evaluate(() => app.showingOriginal), false);
            await touch('touchStart', [p]); await page.waitForTimeout(410);
            await page.evaluate(() => window.dispatchEvent(new Event('blur')));
            await touch('touchEnd', []);
            assert.equal(await page.evaluate(() => app.showingOriginal || app.viewport.pointers.size), 0);
            await touch('touchStart', [p]);
            await page.evaluate(() => {
                const id = [...app.viewport.pointers.keys()][0];
                document.getElementById('main-canvas').releasePointerCapture(id);
            });
            await touch('touchMove', [{ x: p.x + 2, y: p.y }]);
            await touch('touchEnd', []);
            assert.equal(await page.evaluate(() => app.viewport.pointers.size), 0);
            // Brush, wand and geometry tools must not change even a selected mask when pinching.
            for (const tool of ['brush', 'wand', 'radial', 'gradient']) {
                await page.evaluate(tool => {
                    app.maskEngine.masks = [];
                    app.maskEngine.createMask(tool);
                    app.maskMode = true; app.showMaskOverlay = true;
                    app._renderMaskOverlay(); app._pushHistory();
                }, tool);
                const snapshot = () => page.evaluate(() => ({
                    masks: app.maskEngine.describeMasks(), pixels: app.maskEngine.getActiveMask().canvas.toDataURL(),
                    history: app.history.length, review: !!app.review.result,
                }));
                const before = await snapshot();
                // Sequential arrival and an early first-finger move, not simultaneous synthetic handlers.
                await touch('touchStart', [{ x: p.x - 35, y: p.y }]);
                await touch('touchMove', [{ x: p.x - 30, y: p.y }]);
                await touch('touchStart', [{ x: p.x - 30, y: p.y }, { x: p.x + 30, y: p.y }]);
                await touch('touchMove', [{ x: p.x - 45, y: p.y }, { x: p.x + 45, y: p.y }]);
                await touch('touchEnd', []);
                assert.deepEqual(await snapshot(), before, `${tool} pinch cannot mutate masks/history`);
            }
            await page.evaluate(() => { app.maskEngine.masks = []; app.maskEngine.createMask('brush'); app.viewport.reset(); });
            await frame(); await pinch(2);
            const expected = await page.evaluate(p => app._canvasToImage({ clientX: p.x, clientY: p.y }), p);
            await touch('touchStart', [p]); await touch('touchEnd', []);
            assert.ok(await page.evaluate(({ imgX, imgY }) => {
                const m = app.maskEngine.getActiveMask();
                return m.ctx.getImageData(Math.floor(imgX), Math.floor(imgY), 1, 1).data[0] > 0;
            }, expected), 'brush maps through zoom to source pixels');
            // A real established stroke is retained on second-finger takeover.
            await touch('touchStart', [p]); await page.waitForTimeout(260);
            await touch('touchMove', [{ x: p.x + 20, y: p.y }]);
            const painted = await page.evaluate(() => app.maskEngine.getActiveMask().canvas.toDataURL());
            await touch('touchStart', [{ x: p.x + 20, y: p.y }, { x: p.x - 20, y: p.y }]);
            await touch('touchMove', [{ x: p.x + 40, y: p.y }, { x: p.x - 40, y: p.y }]);
            await touch('touchEnd', []);
            assert.equal(await page.evaluate(() => app.maskEngine.getActiveMask().canvas.toDataURL()), painted);
            await page.evaluate(() => { app.maskMode = false; app.cropTool.activate(); });
            await frame();
            assert.equal((await metrics()).scale, 1);
            const crop = () => page.evaluate(() => [app.cropTool.cropX, app.cropTool.cropY, app.cropTool.cropW, app.cropTool.cropH]);
            const beforeCrop = await crop();
            await pinch(2);
            assert.deepEqual(await crop(), beforeCrop);
            assert.equal((await metrics()).scale, 1);
            await page.evaluate(() => app.cropTool.setAspectRatio(1));
            const movableCrop = await crop();
            await touch('touchStart', [p]);
            await touch('touchMove', [{ x: p.x + 18, y: p.y }]);
            await touch('touchEnd', []);
            assert.notDeepEqual(await crop(), movableCrop, 'single-finger crop still moves after pinch');
            await page.evaluate(() => app.cropTool.deactivate());
            // Mouse/trackpad and captured release outside the image.
            await page.mouse.move(p.x, p.y); await page.mouse.wheel(0, -350); await frame();
            assert.ok((await metrics()).scale > 1);
            await page.mouse.down(); await page.mouse.move(p.x + 60, 2); await page.mouse.up();
            assert.equal(await page.evaluate(() => app.viewport.pointers.size), 0);
            const beforeResize = (await metrics()).scale;
            await page.setViewportSize({ width: mobile ? 844 : 1280, height: mobile ? 390 : 900 });
            await page.waitForTimeout(350);
            assert.equal((await metrics()).scale, beforeResize);
            assert.equal(await page.evaluate(() => document.getElementById('main-canvas').style.transform ===
                document.getElementById('mask-overlay').style.transform), true);
            await page.setViewportSize({ width: mobile ? 390 : 1440, height: mobile ? 844 : 1000 });
            await page.waitForTimeout(350);
            // All six cached review variants remain usable while zoomed.
            await load(640, 400); await frame();
            assert.equal((await metrics()).scale, 1);
            await page.locator(mobile ? '.mobile-tab[data-panel=review]' : '.vtab[data-panel=review]').click();
            await page.selectOption('#review-provider', 'gemini');
            await page.locator('#review-connection').evaluate(n => { n.open = true; });
            await page.fill('#review-endpoint', new URL(base).origin);
            await page.locator('#review-connection').evaluate(n => { n.open = false; });
            await page.check('#review-consent'); await page.click('#review-analyze');
            await page.waitForFunction(() => app.review.canCompare());
            if (mobile) await page.click('#review-view-photo');
            await page.waitForTimeout(400);
            const frozen = await page.evaluate(() => JSON.stringify([app.review.beforeState, app.review.beforeMasks]));
            await pinch(2);
            const controlBox = await page.locator('#review-photo-controls').boundingBox();
            for (const mode of ['global', 'adaptive']) {
                await page.locator('.review-photo-more').evaluate(n => { n.open = true; });
                await page.selectOption('#review-photo-mode', mode);
                await page.locator('.review-photo-more').evaluate(n => { n.open = false; });
                for (const intensity of ['refine', 'balanced', 'expressive']) {
                    await page.click(`[data-intensity="${intensity}"]`);
                    const before = await page.evaluate(() => ({ png: app._renderedCanvas().toDataURL(), preview: app.review.preview() }));
                    await pinch(1.1);
                    assert.deepEqual(await page.evaluate(() => ({ png: app._renderedCanvas().toDataURL(), preview: app.review.preview() })), before);
                    assert.equal(await page.evaluate(() => JSON.stringify([app.review.beforeState, app.review.beforeMasks])), frozen);
                    assert.deepEqual(await page.locator('#review-photo-controls').boundingBox(), controlBox);
                    assert.equal(await page.evaluate(() => app.review.canCompare()), true);
                }
            }
            if (process.env.ARTIFACT_DIR) {
                fs.mkdirSync(process.env.ARTIFACT_DIR, { recursive: true });
                await page.screenshot({ path: `${process.env.ARTIFACT_DIR}/zoom-${mobile ? 'mobile' : 'desktop'}.png` });
            }
            // Large cached photo: pinch must not allocate/rerender its GPU image.
            await load(6000, 4000);
            await page.evaluate(() => { app.state.texture = 30; app._render(); });
            await page.waitForTimeout(350);
            await page.evaluate(() => {
                window.zoomStats = { renders: 0, allocations: 0, readbacks: 0 };
                const render = app._render.bind(app); app._render = (...args) => { zoomStats.renders++; return render(...args); };
                const gl = app.glEngine.gl, create = gl.createTexture.bind(gl), read = gl.readPixels.bind(gl);
                gl.createTexture = (...args) => { zoomStats.allocations++; return create(...args); };
                gl.readPixels = (...args) => { zoomStats.readbacks++; return read(...args); };
            });
            const started = Date.now();
            await pinch(2); await pinch(.7); await pinch(1.3, 10);
            const stats = await page.evaluate(() => window.zoomStats);
            assert.deepEqual(stats, { renders: 0, allocations: 0, readbacks: 0 });
            assert.deepEqual(errors, []);
            console.log(`${mobile ? 'Mobile' : 'Desktop'} passed: genuine pinch/pan, masks/crop/hold, six variants, export/AI pixels; 24MP navigation ${Date.now() - started}ms, ${JSON.stringify(stats)}`);
            if (mobile) {
                await touch('touchStart', [{ x: 120, y: 20 }, { x: 200, y: 20 }]);
                for (let d = 45; d <= 90; d += 5) await touch('touchMove', [{ x: 160 - d, y: 20 }, { x: 160 + d, y: 20 }]);
                await touch('touchEnd', []);
                assert.ok(await page.evaluate(() => visualViewport.scale > 1), 'native page zoom remains available outside photo');
            }
            await context.close();
        }
    } finally {
        await browser.close(); server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
