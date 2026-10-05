'use strict';

// Real mouse/touch UI and Canvas/WebGL pixels, never AI requests or model downloads.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createServer } = require('../server/index.js');

(async () => {
    const server = createServer({ env: { LOCAL_REVIEW_ENABLED: 'false' } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = process.env.BASE_URL || `http://127.0.0.1:${server.address().port}/`;
    const browser = await chromium.launch({ headless: true });
    try {
        for (const mobile of [false, true]) {
            const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } :
                { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: true });
            const page = await context.newPage(), errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.route('**/*', route => {
                const url = new URL(route.request().url());
                if (url.origin !== new URL(base).origin || url.pathname.includes('/api/')) return route.abort();
                return route.continue();
            });
            await page.goto(base);
            await page.waitForFunction(() => window.app?.polygon).catch(error => {
                throw Error(`${error.message}; browser errors: ${JSON.stringify(errors)}`);
            });
            const load = (w = 768, h = 512) => page.evaluate(async ([w, h]) => {
                const c = document.createElement('canvas'); c.width = w; c.height = h;
                const ctx = c.getContext('2d'), g = ctx.createLinearGradient(0, 0, w, h);
                g.addColorStop(0, '#354b60'); g.addColorStop(.2, '#f8eee0');
                g.addColorStop(.4, '#030608'); g.addColorStop(1, '#baa184');
                ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
                const blob = await new Promise(resolve => c.toBlob(resolve));
                c.width = c.height = 1;
                await app._loadFile(new File([blob], 'polygon.png', { type: 'image/png' }));
            }, [w, h]);
            await load();
            const frame = () => page.evaluate(() => new Promise(resolve =>
                requestAnimationFrame(() => requestAnimationFrame(resolve))));
            const cdp = await context.newCDPSession(page);
            const touch = (type, values) => cdp.send('Input.dispatchTouchEvent', {
                type, touchPoints: values.map((p, i) => ({ id: i + 1, radiusX: 2, radiusY: 2, ...p })),
            });
            const tab = () => page.locator(mobile ? '.mobile-tab[data-panel="masks"]' : '.vtab[data-panel="masks"]').click();
            const start = async () => {
                await tab(); await page.click('#add-polygon'); await page.waitForTimeout(380); await frame();
            };
            const position = async (x, y) => {
                const r = await page.locator('#main-canvas').boundingBox();
                return { x: r.x + x * r.width, y: r.y + y * r.height };
            };
            const tap = async (x, y) => {
                const p = await position(x, y);
                if (mobile) { await touch('touchStart', [p]); await touch('touchEnd', []); }
                else await page.mouse.click(p.x, p.y);
                await frame();
            };
            const drag = async (from, to) => {
                const a = await position(...from), b = await position(...to);
                if (mobile) {
                    await touch('touchStart', [a]); await page.waitForTimeout(260);
                    await touch('touchMove', [{ x: b.x, y: b.y }]); await touch('touchEnd', []);
                } else {
                    await page.mouse.move(a.x, a.y); await page.mouse.down();
                    await page.mouse.move(b.x, b.y, { steps: 5 }); await page.mouse.up();
                }
                await frame();
            };
            const snapshot = () => page.evaluate(() => ({
                masks: app.maskEngine.describeMasks(), history: app.history.length,
                pixels: app.maskEngine.masks.map(m => m.canvas.toDataURL()), draft: app.polygon.draft,
            }));
            const pinch = async (late = false) => {
                const p = await position(.5, .5);
                await touch('touchStart', [{ x: p.x - 25, y: p.y }]);
                if (late) {
                    await page.waitForTimeout(270);
                    await touch('touchMove', [{ x: p.x - 10, y: p.y }]);
                }
                await touch('touchStart', [{ x: p.x - 10, y: p.y }, { x: p.x + 30, y: p.y }]);
                await touch('touchMove', [{ x: p.x - 30, y: p.y }, { x: p.x + 50, y: p.y }]);
                await touch('touchEnd', []); await frame();
            };
            const fit = async () => { await page.click('#btn-fit'); await frame(); };
            const initial = await snapshot();
            await start(); await tap(.1, .1); await tap(.9, .1);
            assert.equal((await snapshot()).masks.length, 0);
            assert.equal((await snapshot()).history, initial.history);
            let before = await snapshot();
            await pinch(true);
            assert.deepEqual(await snapshot(), before, 'late second finger does not add a draft point');
            assert.ok(await page.evaluate(() => app.viewport.scale > 1));
            await fit();
            await page.click('#polygon-undo-point');
            assert.equal((await snapshot()).draft.length, 1);
            // Text input keys do not remove draft vertices.
            await page.evaluate(() => {
                const input = document.createElement('textarea'); input.id = 'polygon-test-input';
                document.getElementById('polygon-controls').appendChild(input);
            });
            await page.locator('#polygon-test-input').fill('abc');
            await page.locator('#polygon-test-input').press('Backspace');
            assert.equal((await snapshot()).draft.length, 1);
            await page.locator('#polygon-test-input').evaluate(el => el.remove());
            await page.click('#polygon-cancel');
            assert.deepEqual(await snapshot(), initial, 'cancel leaves pixels, masks and history unchanged');
            await start(); await tap(.2, .2);
            await page.locator(mobile ? '.mobile-tab[data-panel="basic"]' : '.vtab[data-panel="basic"]').click();
            assert.equal((await snapshot()).draft, null, 'leaving mask panel cancels draft');
            await start();
            await tap(0, 0); await tap(.85, 0); await tap(0, .85);
            assert.equal((await snapshot()).masks.length, 0);
            if (mobile) await page.click('#polygon-finish');
            else await tap(0, 0);
            assert.equal((await snapshot()).masks.length, 1);
            assert.equal((await snapshot()).history, initial.history + 1);
            assert.equal((await snapshot()).masks[0].params.points.length, 3);
            assert.equal((await snapshot()).masks[0].params.points[0].x, 0);
            const raster = await page.evaluate(() => {
                const m = app.maskEngine.getActiveMask();
                const pixel = (x, y) => [...m.ctx.getImageData(x, y, 1, 1).data];
                return { inside: pixel(40, 40), outside: pixel(650, 450) };
            });
            assert.deepEqual(raster.inside, [255, 255, 255, 255]);
            assert.deepEqual(raster.outside, [0, 0, 0, 255]);
            before = await snapshot();
            await pinch(true);
            assert.deepEqual(await snapshot(), before, 'pinching selected polygon preserves its exact pixels');
            await fit();
            // Drag a corner after zoom; the existing photograph is not rerendered on each move.
            await pinch();
            // Return to Fit for the corner at the image boundary, then zoom around that corner.
            await fit();
            await page.evaluate(() => app.viewport.zoomAt(1.35, { x: -10000, y: -10000 }));
            await frame();
            before = await snapshot();
            await drag([0, 0], [.12, .1]);
            let moved = await snapshot();
            assert.equal(moved.history, before.history + 1);
            assert.ok(Math.abs(moved.masks[0].params.points[0].x - .12) < .008);
            assert.ok(Math.abs(moved.masks[0].params.points[0].y - .1) < .008);
            await fit();
            const validMove = await snapshot();
            await drag([.12, .1], [.85, 0]);
            assert.deepEqual(await snapshot(), validMove, 'invalid corner drag keeps geometry, pixels and history');
            assert.match(await page.locator('#polygon-status').innerText(), /Previous shape kept/);
            await page.setViewportSize(mobile ? { width: 430, height: 900 } : { width: 1280, height: 900 });
            await page.waitForTimeout(380); await frame();
            assert.deepEqual(await snapshot(), validMove, 'resize does not rewrite normalized corners');
            await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
            await page.waitForTimeout(380); await frame();
            await page.evaluate(() => app._undo());
            assert.deepEqual((await snapshot()).pixels, before.pixels, 'undo restores exact mask raster');
            assert.deepEqual((await snapshot()).masks[0].params, before.masks[0].params);
            await page.evaluate(() => app._redo());
            assert.deepEqual((await snapshot()).pixels, moved.pixels);
            await page.locator('#mask-list .mask-item').first().click();
            const featherHistory = (await snapshot()).history;
            await page.locator('#polygon-feather-value').fill('40');
            await page.locator('#polygon-feather-value').press('Tab');
            assert.equal((await snapshot()).history, featherHistory + 1);
            assert.equal((await snapshot()).masks[0].params.feather, 40);
            const soft = await page.evaluate(() => {
                const m = app.maskEngine.getActiveMask();
                const row = m.ctx.getImageData(0, 100, 140, 1).data;
                return Array.from({ length: 140 }, (_, i) => row[i * 4]);
            });
            assert.ok(soft.some(v => v > 0 && v < 255), 'genuine feather contains intermediate mask values');
            // Inversion and all 14 controls use the existing local-adjustment pipeline.
            const pixels = await page.evaluate(() => {
                const read = canvas => {
                    const c = document.createElement('canvas'); c.width = canvas.width; c.height = canvas.height;
                    c.getContext('2d').drawImage(canvas, 0, 0);
                    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
                    c.width = c.height = 1; return data;
                };
                const render = () => { app._render(); return read(app.glEngine.canvas); };
                const pixel = (data, x, y) => Array.from(data.slice((y * 768 + x) * 4, (y * 768 + x) * 4 + 3));
                const check = (condition, message) => { if (!condition) throw Error(message); };
                const m = app.maskEngine.getActiveMask(), neutral = render(), controls = [];
                for (const [key] of Object.entries(ManualControls.controls)) {
                    m.adjustments[key] = key === 'exposure' ? 1 : key === 'whites' ? -70 : 70;
                    const changed = render();
                    // Clarity/texture/sharpen need detail rather than a flat interior; covered in their dedicated suite.
                    if (!['clarity', 'texture', 'sharpenAmount'].includes(key))
                        check(changed.some((v, i) => v !== neutral[i]), key);
                    check(JSON.stringify(pixel(neutral, 700, 450)) === JSON.stringify(pixel(changed, 700, 450)), `${key} outside`);
                    m.adjustments[key] = 0; controls.push(key);
                }
                m.adjustments.exposure = .8;
                const edited = render();
                m.opacity = 0;
                check(JSON.stringify(pixel(neutral, 180, 120)) === JSON.stringify(pixel(render(), 180, 120)), 'zero strength');
                m.opacity = 1; m.inverted = true;
                const inverse = render();
                check(JSON.stringify(pixel(neutral, 700, 450)) !== JSON.stringify(pixel(inverse, 700, 450)), 'inverted outside');
                m.inverted = false; render();
                app._pushHistory();
                window.polygonRead = read;
                window.polygonEdited = edited;
                return { controls: controls.length };
            });
            assert.equal(pixels.controls, 14);
            await page.click('#polygon-invert');
            assert.equal((await snapshot()).masks[0].inverted, true);
            await page.click('#polygon-invert');
            await page.locator('#reset-mask-adjustments').click();
            assert.ok(await page.evaluate(() => Object.values(app.maskEngine.getActiveMask().adjustments).every(v => v === 0)));
            await page.evaluate(() => app._undo());
            await page.locator('#mask-list .mask-item').first().click();
            const persistence = await page.evaluate(async () => {
                let saved;
                const old = library.db;
                library.photos = [{ id: 'polygon-test', name: 'polygon.png' }]; library.activeIndex = 0;
                library.db = { transaction: () => ({ objectStore: () => ({ put: data => { saved = data; } }) }) };
                await library._saveCurrentEdits(); library.db = old;
                const before = app.maskEngine.getActiveMask().canvas.toDataURL();
                await library._restoreEdits(library.photos[0], saved);
                const restored = app.maskEngine.getActiveMask().canvas.toDataURL();
                const canvas = app._exportCanvas(), exported = polygonRead(canvas), preview = polygonRead(app.glEngine.canvas);
                let max = 0;
                for (let i = 0; i < preview.length; i++) max = Math.max(max, Math.abs(preview[i] - exported[i]));
                const size = [canvas.width, canvas.height]; canvas.width = canvas.height = 1;
                window.polygonSaved = saved;
                return { same: before === restored, exportMax: max, size };
            });
            assert.equal(persistence.same, true, 'Library regenerates identical geometry pixels');
            assert.deepEqual(persistence.size, [768, 512]); assert.ok(persistence.exportMax <= 2);
            const savedSnapshot = await snapshot();
            await page.evaluate(async () => {
                await library._saveCurrentEdits();
                if (!(await library._readEdits(library.photos[0]))) throw Error('IndexedDB save failed');
                const bad = structuredClone(polygonSaved);
                bad.masks[0].params.points = [{ x: 0, y: 0 }];
                let rejected = false;
                try { await library._restoreEdits(library.photos[0], bad); } catch { rejected = true; }
                if (!rejected) throw Error('Invalid saved polygon accepted');
            });
            assert.deepEqual((await snapshot()).pixels, savedSnapshot.pixels);
            await page.reload(); await page.waitForFunction(() => window.app?.polygon && window.library?.db);
            await load();
            await page.evaluate(() => library._restoreEdits({ id: 'polygon-test', name: 'polygon.png' }));
            assert.deepEqual((await snapshot()).pixels, savedSnapshot.pixels, 'real reload restores IndexedDB mask pixels');
            assert.deepEqual((await snapshot()).masks[0].params, savedSnapshot.masks[0].params);
            await tab(); await page.waitForTimeout(380);
            await page.locator('#mask-list .mask-item').first().click();
            await page.locator('#polygon-controls').scrollIntoViewIfNeeded();
            if (process.env.ARTIFACT_DIR) {
                fs.mkdirSync(process.env.ARTIFACT_DIR, { recursive: true });
                await page.screenshot({ path: `${process.env.ARTIFACT_DIR}/polygon-${mobile ? 'mobile' : 'desktop'}.png` });
            }
            // Crop preserves the exact old raster selection, then undo restores editable corners.
            const preCrop = await snapshot();
            await page.evaluate(() => {
                const m = app.maskEngine.getActiveMask(), expected = document.createElement('canvas');
                expected.width = Math.round(768 * .7); expected.height = Math.round(512 * .7);
                const ctx = expected.getContext('2d');
                ctx.translate(-Math.round(768 * .1), -Math.round(512 * .1));
                ctx.drawImage(m.canvas, 0, 0, 768, 512);
                window.expectedPolygonCrop = expected.toDataURL();
                expected.width = expected.height = 1;
                app._exitMaskMode(); app.cropTool.activate();
                Object.assign(app.cropTool, { cropX: .1, cropY: .1, cropW: .7, cropH: .7, rotation: 0 });
                app.cropTool.apply();
            });
            await page.waitForFunction(() => app.imageWidth === 538);
            assert.equal((await snapshot()).masks[0].type, 'brush');
            assert.equal((await snapshot()).masks[0].polygonBaked, true);
            assert.equal(await page.evaluate(() => app.maskEngine.getActiveMask().canvas.toDataURL() === expectedPolygonCrop),
                true, 'crop coverage matches the exact cropped mask raster');
            await page.evaluate(() => app._undo());
            assert.equal(await page.evaluate(() => app.imageWidth), 768);
            assert.deepEqual((await snapshot()).masks[0].params, preCrop.masks[0].params);
            assert.deepEqual((await snapshot()).pixels, preCrop.pixels);
            // Concavity and cross-browser Canvas feather: compare to analytic inward distance.
            const quality = await page.evaluate(() => {
                let maxError = 0, outside = 0;
                const points = [{ x: .1, y: .1 }, { x: .9, y: .1 }, { x: .9, y: .9 },
                    { x: .5, y: .5 }, { x: .1, y: .9 }];
                for (const [w, h] of [[240, 160], [160, 240]]) for (const reverse of [false, true]) {
                    const c = document.createElement('canvas'); c.width = w; c.height = h;
                    const ctx = c.getContext('2d'); const p = reverse ? points.toReversed() : points;
                    PolygonGeometry.rasterize(ctx, w, h, p, 60);
                    const data = ctx.getImageData(0, 0, w, h).data;
                    for (let y = 0; y < h; y += 3) for (let x = 0; x < w; x += 3) {
                        const px = x + .5, py = y + .5; let inside = false, distance = Infinity;
                        for (let i = 0; i < p.length; i++) {
                            const a = p[i], b = p[(i + 1) % p.length], ax = a.x * w, ay = a.y * h, bx = b.x * w, by = b.y * h;
                            if ((ay > py) !== (by > py) && px < (bx - ax) * (py - ay) / (by - ay) + ax) inside = !inside;
                            const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) /
                                ((bx - ax) ** 2 + (by - ay) ** 2)));
                            distance = Math.min(distance, Math.hypot(px - ax - t * (bx - ax), py - ay - t * (by - ay)));
                        }
                        if (distance < 1.5) continue; // Canvas boundary antialiasing differs by backend.
                        const actual = data[(y * w + x) * 4];
                        const expected = inside ? Math.min(255, distance / (Math.min(w, h) * .15) * 255) : 0;
                        maxError = Math.max(maxError, Math.abs(actual - expected));
                        if (!inside) outside = Math.max(outside, actual);
                    }
                    c.width = c.height = 1;
                }
                return { maxError, outside };
            });
            assert.ok(quality.maxError < 8, JSON.stringify(quality));
            assert.equal(quality.outside, 0);
            // Invalid completion never creates a phantom mask; Enter and Escape work without a focused input.
            await start(); await tap(.1, .1); await tap(.9, .9); await tap(.1, .9); await tap(.9, .1);
            before = await snapshot();
            await page.click('#polygon-finish');
            assert.equal((await snapshot()).masks.length, before.masks.length);
            assert.match(await page.locator('#polygon-status').innerText(), /cross|area/);
            await page.locator('#polygon-finish').evaluate(el => el.blur());
            await page.keyboard.press('Escape');
            assert.equal((await snapshot()).draft, null);
            assert.equal(await page.locator('#polygon-overlay').isVisible(), false);
            await start(); await tap(.2, .2); await tap(.8, .2); await tap(.5, .8);
            await page.locator('#add-polygon').evaluate(el => el.blur());
            await page.keyboard.press('Enter');
            assert.equal((await snapshot()).masks.length, before.masks.length + 1);
            await start();
            for (const p of [[.1, .1], [.9, .1], [.9, .9], [.5, .5], [.1, .9]]) await tap(...p);
            await tap(.1, .1);
            assert.equal((await snapshot()).masks.at(-1).params.points.length, 5, 'concave shape closes via first point');
            await start(); await tap(.2, .2);
            await load(512, 768);
            assert.equal((await snapshot()).draft, null, 'new source discards draft');
            assert.equal((await snapshot()).masks.length, 0);
            assert.equal(await page.locator('#polygon-overlay').isVisible(), false);
            assert.deepEqual(errors, []);
            console.log(JSON.stringify({ mobile, quality, persistence, actualMouseTouchUI: true }));
            await context.close();
        }
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
