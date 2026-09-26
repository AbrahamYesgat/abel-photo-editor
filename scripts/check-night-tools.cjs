'use strict';
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createServer } = require('../server/index.js');

(async () => {
    const server = createServer({ env: { LOCAL_REVIEW_ENABLED: 'false' } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        const errors = [], requests = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('request', request => { if (request.url().includes('/api/review')) requests.push(request.url()); });
        await page.goto(process.env.BASE_URL || `http://127.0.0.1:${server.address().port}/`);
        await page.waitForFunction(() => window.app?.review);
        assert.equal(await page.locator('#btn-denoise').isDisabled(), true);
        const results = await page.evaluate(async () => {
            const check = (value, message) => { if (!value) throw new Error(message); };
            const pixels = canvas => {
                const copy = document.createElement('canvas');
                copy.width = canvas.width; copy.height = canvas.height;
                const ctx = copy.getContext('2d');
                ctx.drawImage(canvas, 0, 0);
                return ctx.getImageData(0, 0, copy.width, copy.height).data;
            };
            const source = document.createElement('canvas');
            const w = source.width = 1310, h = source.height = 360;
            const ctx = source.getContext('2d'), data = ctx.createImageData(w, h);
            let seed = 7;
            const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 4294967296; };
            for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
                const i = (y * w + x) * 4;
                const base = x < 655 ? 65 : 155;
                for (let c = 0; c < 3; c++) data.data[i + c] = base + (random() - .5) * 34;
                data.data[i + 3] = 255;
            }
            ctx.putImageData(data, 0, 0);
            const load = async canvas => {
                const blob = await new Promise(resolve => canvas.toBlob(resolve));
                check(await app._loadFile(new File([blob], 'night-synthetic.png', { type: 'image/png' })), 'load photo');
            };
            await load(source);
            const initial = pixels(app.glEngine.canvas);
            document.getElementById('btn-denoise').click();
            const denoised = pixels(app.glEngine.canvas);
            check(app.state.noiseLuma === 60 && app.state.noiseColor === 70, 'moderate one-click settings');
            check(app.state.motionAmount === 0 && app.state.sharpenAmount === 0, 'denoise is not blur/sharpen');
            const count = app.history.length;
            document.getElementById('btn-denoise').click();
            check(app.history.length === count, 'repeated denoise does not stack or add undo');
            const variance = image => {
                let sum = 0, square = 0, n = 0;
                for (let y = 40; y < 300; y++) for (let x = 40; x < 600; x++) {
                    const v = image[(y * w + x) * 4];
                    sum += v; square += v * v; n++;
                }
                return square / n - (sum / n) ** 2;
            };
            const noiseRatio = variance(denoised) / variance(initial);
            check(noiseRatio < .5, `noise variance reduced: ${noiseRatio}`);
            let edge = 0;
            for (let y = 20; y < h - 20; y++) edge += denoised[(y * w + 656) * 4] - denoised[(y * w + 653) * 4];
            edge /= h - 40;
            check(edge > 80, `edge retained rather than plain blur: ${edge}`);
            app._undo();
            check(pixels(app.glEngine.canvas).every((v, i) => v === initial[i]), 'undo exact original pixels');
            app._redo();
            check(pixels(app.glEngine.canvas).every((v, i) => v === denoised[i]), 'redo exact denoised pixels');
            document.getElementById('btn-motion').click();
            check(app.state.motionAmount === 0, 'opening motion tool does not apply a guessed blur');
            app.state.clarity = 12;
            app.state.sharpenAmount = 8;
            app._setNight({ motionAmount: 65, motionLength: 7, motionAngle: 33 });
            check(!document.getElementById('night-status').textContent, 'GPU restoration has no errors');
            const reference = pixels(app.glEngine.canvas);
            const output = app._exportCanvas(1), exported = pixels(output);
            let tileMax = 0, tileMean = 0;
            for (let i = 0; i < reference.length; i++) {
                const d = Math.abs(reference[i] - exported[i]);
                tileMax = Math.max(tileMax, d); tileMean += d;
            }
            tileMean /= reference.length;
            check(tileMax <= 3 && tileMean < .2, `padded native export matches: ${tileMax}, ${tileMean}`);
            let heartbeat = 0, progress = 0;
            const timer = setInterval(() => heartbeat++, 0);
            const asyncOutput = await app._exportCanvasAsync(1, { onProgress: value => { progress = value; } });
            clearInterval(timer);
            const asyncPixels = pixels(asyncOutput);
            check(asyncPixels.every((value, i) => Math.abs(value - exported[i]) <= 3),
                'cancellable 512px-tile export matches native synchronous reference');
            check(heartbeat > 0 && progress === 1, 'async export yields and reports completion');
            asyncOutput.width = asyncOutput.height = 1;
            const controller = new AbortController();
            let cancelled = false;
            try {
                await app._exportCanvasAsync(1, { signal: controller.signal, onProgress: () => controller.abort() });
            } catch (error) { cancelled = error.name === 'AbortError'; }
            check(cancelled, 'cancel stops between tiles');
            check(pixels(app.glEngine.canvas).every((value, i) => value === reference[i]),
                'export and cancellation leave the visible photo untouched');
            const saved = { ...app.state };
            app.showingOriginal = true; app._render();
            check(pixels(app.glEngine.canvas).every((v, i) => v === initial[i]), 'compare bypasses both restorations');
            app.showingOriginal = false; app._render();
            check(JSON.stringify(saved) === JSON.stringify(app.state), 'compare does not mutate state');

            // Known seven-pixel horizontal/vertical box motion, independent of the inverse code.
            const clean = (x, y, vertical) => 115 + 44 * Math.sin((vertical ? y : x) * .42) +
                25 * Math.sin((vertical ? y : x) * .15);
            const quality = [];
            for (const vertical of [false, true]) {
                for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
                    let blurred = 0;
                    for (let k = -3; k <= 3; k++) blurred += clean(x + (vertical ? 0 : k), y + (vertical ? k : 0), vertical) / 7;
                    const i = (y * w + x) * 4;
                    data.data[i] = data.data[i + 1] = data.data[i + 2] = blurred;
                }
                ctx.putImageData(data, 0, 0);
                await load(source);
                app._setNight({ motionAmount: 100, motionLength: 7, motionAngle: vertical ? 90 : 0 });
                const restored = pixels(app.glEngine.canvas);
                let before = 0, after = 0;
                for (let y = 40; y < h - 40; y++) for (let x = 40; x < w - 40; x++) {
                    const i = (y * w + x) * 4, ideal = clean(x, y, vertical);
                    before += (data.data[i] - ideal) ** 2; after += (restored[i] - ideal) ** 2;
                }
                const ratio = after / before;
                check(ratio < .3, `known ${vertical ? 'vertical' : 'horizontal'} blur recovery: ${ratio}`);
                quality.push(ratio);
            }
            document.getElementById('night-inspector').open = true;
            app._render();
            check(app._nightInspector?.engine.canvas.width >= 120 &&
                app._nightInspector.engine.canvas.width <= 280, '100% native detail inspector renders');
            check(!document.getElementById('night-status').textContent, 'inspector has no GPU errors');
            const native = app._nightInspector, nativePixels = pixels(native.engine.canvas);
            const developed = pixels(app.glEngine.canvas);
            const ix = Math.round((w - native.engine.canvas.width) / 2), iy = Math.round((h - 180) / 2);
            let inspectorMax = 0;
            for (let y = 0; y < 180; y++) for (let x = 0; x < native.engine.canvas.width; x++) {
                const a = (y * native.engine.canvas.width + x) * 4;
                const b = ((y + iy) * w + x + ix) * 4;
                inspectorMax = Math.max(inspectorMax, Math.abs(nativePixels[a] - developed[b]));
            }
            check(inspectorMax <= 2, `100% inspector preserves source position/direction: ${inspectorMax}`);
            // Cached correction is not repeated during lighting or mask-strength edits.
            const engine = app.glEngine;
            const texture = engine._nightTexture;
            for (let i = 0; i < 6; i++) {
                const mask = app.maskEngine.createMask('radial');
                app.maskEngine.createRadialMask(300 + i * 100, 150, 200, 130, 80);
                mask.adjustments.exposure = .1; mask.blend = 'additive';
            }
            app._render();
            const times = [];
            for (let i = 0; i < 8; i++) {
                const start = performance.now();
                app.maskEngine.masks[5].opacity = .2 + i / 10;
                app._render();
                engine.gl.finish();
                times.push(performance.now() - start);
            }
            check(engine._nightTexture === texture, 'global restoration reused across masks and strengths');
            const beforeCrop = pixels(engine.canvas), beforeSource = app.image;
            app.cropTool.activate();
            app.cropTool.rotation = 30;
            app.cropTool.cropX = .1; app.cropTool.cropY = .1;
            app.cropTool.cropW = .8; app.cropTool.cropH = .8;
            app.cropTool.apply();
            const deadline = performance.now() + 5000;
            while (app.image === beforeSource && performance.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            check(app.image !== beforeSource, 'crop completes');
            check(app.state.motionAngle === 120 && app.state.motionLength === 7,
                'crop rotation changes PSF direction, not native-pixel distance');
            app._undo();
            check(app.state.motionAngle === 90 && app.image === beforeSource, 'crop undo restores PSF and source');
            check(pixels(engine.canvas).every((v, i) => v === beforeCrop[i]), 'crop undo restores exact restored composite');
            return { noiseRatio, edge, tileMax, tileMean, recoveryErrorRatios: quality,
                maskMedianMs: times.sort((a, b) => a - b)[4], inspectorMax, exportHeartbeat: heartbeat };
        });
        for (const width of [390, 320, 768, 1440]) {
            await page.setViewportSize({ width, height: 900 });
            const boxes = await page.locator('#btn-auto, #btn-denoise, #btn-motion').evaluateAll(nodes =>
                nodes.map(node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }));
            for (const box of boxes) {
                assert.ok(box.x >= 0 && box.x + box.w <= width && box.h >= 44, `accessible toolbar at ${width}`);
            }
            for (let i = 1; i < boxes.length; i++) assert.ok(boxes[i].x >= boxes[i - 1].x + boxes[i - 1].w);
            const canvas = await page.locator('#canvas-container').boundingBox();
            assert.ok(canvas.width > 100 && canvas.height > 50, `photo area remains usable at ${width}`);
        }
        assert.deepEqual(errors, []);
        assert.deepEqual(requests, []);
        const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
        mobile.on('pageerror', error => errors.push(error.message));
        await mobile.goto(process.env.BASE_URL || `http://127.0.0.1:${server.address().port}/`);
        await mobile.waitForFunction(() => window.app?.review);
        await mobile.evaluate(async () => {
            const image = document.createElement('canvas');
            image.width = 600; image.height = 900;
            image.getContext('2d').fillRect(0, 0, 600, 900);
            const blob = await new Promise(resolve => image.toBlob(resolve));
            await app._loadFile(new File([blob], 'portrait.png', { type: 'image/png' }));
        });
        await mobile.locator('#btn-denoise').tap();
        assert.equal(await mobile.evaluate(() => app.state.noiseLuma), 60);
        await mobile.locator('#btn-motion').tap();
        assert.equal(await mobile.evaluate(() => app.state.motionAmount), 0);
        assert.equal(await mobile.locator('.sidebar-right').evaluate(node => node.classList.contains('mobile-open')), true);
        assert.ok((await mobile.getByRole('slider', { name: 'Motion blur — amount', exact: true }).boundingBox()).height >= 44);
        await mobile.getByRole('slider', { name: 'Motion blur — amount', exact: true }).evaluate(input => {
            input.value = '40'; input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await mobile.waitForTimeout(300);
        assert.equal(await mobile.evaluate(() => app.state.motionAmount), 40);
        await mobile.evaluate(() => { app._undo(); });
        assert.equal(await mobile.evaluate(() => app.state.motionAmount), 0);
        await mobile.evaluate(() => { app._redo(); app.cropTool.activate(); });
        assert.equal(await mobile.locator('#btn-denoise').isDisabled(), true);
        assert.equal(await mobile.locator('#btn-motion').isDisabled(), true);
        await mobile.evaluate(() => app.cropTool.deactivate());
        assert.equal(await mobile.locator('#btn-denoise').isDisabled(), false);
        await mobile.evaluate(() => {
            window.nightTestDownloads = 0;
            app._downloadBlob = () => window.nightTestDownloads++;
            app._showExportModal();
            document.getElementById('export-format').value = 'png';
            app._doExport();
            if (document.getElementById('export-cancel').textContent !== 'Cancel export') throw new Error('cancel action is visible');
            document.getElementById('export-cancel').click();
        });
        await mobile.waitForFunction(() => !app._exporting);
        assert.equal(await mobile.evaluate(() => window.nightTestDownloads), 0);
        assert.equal(await mobile.locator('#btn-denoise').isDisabled(), false);
        assert.deepEqual(errors, []);
        await mobile.close();
        console.log(JSON.stringify(results));
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
