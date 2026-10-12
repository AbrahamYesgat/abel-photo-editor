'use strict';
const assert = require('node:assert/strict');
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
                { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile });
            const page = await context.newPage(), errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.route('**/*', route => {
                const url = new URL(route.request().url());
                if (url.origin !== new URL(base).origin || url.pathname.includes('/api/')) return route.abort();
                return route.continue();
            });
            await page.goto(base);
            await page.waitForFunction(() => window.app && window.library?.db);
            const result = await page.evaluate(async () => {
                const check = (condition, message) => { if (!condition) throw Error(message); };
                const source = document.createElement('canvas'); source.width = 960; source.height = 640;
                const ctx = source.getContext('2d');
                const rgba = ctx.createImageData(960, 640);
                for (let y = 0; y < 640; y++) for (let x = 0; x < 960; x++) {
                    const i = (y * 960 + x) * 4;
                    rgba.data.set([x % 256, y % 256, (x + y) % 256, 255], i);
                }
                ctx.putImageData(rgba, 0, 0);
                const blob = await new Promise(resolve => source.toBlob(resolve));
                const file = new File([blob], 'crop-regression.png', { type: 'image/png', lastModified: 1234 });
                check(await app._loadFile(file), 'load source');
                await library.addFiles([file]);
                library.activeIndex = library.photos.findIndex(p => p.name === file.name);
                window.cropFile = file;
                const original = app.image;
                const pixels = canvas => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
                const exported = () => {
                    const c = app._exportCanvas(); const data = pixels(c); c.width = c.height = 1; return data;
                };
                const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
                const full = exported();
                const crop = (x, y, w, h, rotation = 0) => {
                    app.cropTool.activate();
                    Object.assign(app.cropTool, { cropX: x, cropY: y, cropW: w, cropH: h, rotation });
                    app.cropTool.apply();
                    check(app.image === original, 'crop must never replace source image');
                };
                crop(.1, .125, .75, .75, 13);
                const rotated = exported(), matrix = app._geometry();
                let rotatedError = 0;
                for (let y = 2; y < 478; y += 17) for (let x = 2; x < 718; x += 19) {
                    const p = CropGeometry.point(matrix, { x: (x + .5) / 720, y: (y + .5) / 480 });
                    if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) continue;
                    const sx = p.x * 960 - .5, sy = p.y * 640 - .5;
                    const ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy;
                    const read = (dx, dy, channel) => full[(Math.max(0, Math.min(639, iy + dy)) * 960 +
                        Math.max(0, Math.min(959, ix + dx))) * 4 + channel];
                    for (let channel = 0; channel < 3; channel++) {
                        const expected = (read(0, 0, channel) * (1 - fx) + read(1, 0, channel) * fx) * (1 - fy) +
                            (read(0, 1, channel) * (1 - fx) + read(1, 1, channel) * fx) * fy;
                        rotatedError = Math.max(rotatedError, Math.abs(rotated[(y * 720 + x) * 4 + channel] - expected));
                    }
                }
                check(rotatedError < 3, `native rotated crop samples original coordinates: ${rotatedError}`);
                app._undo();
                crop(.1, .125, .75, .75);
                check(app.imageWidth === 720 && app.imageHeight === 480, 'first native dimensions');
                const first = exported();
                const expected = new Uint8ClampedArray(720 * 480 * 4);
                for (let y = 0; y < 480; y++) expected.set(full.subarray(((y + 80) * 960 + 96) * 4,
                    ((y + 80) * 960 + 96 + 720) * 4), y * 720 * 4);
                check(equal(first, expected), 'native crop pixels must match original exactly');
                app.state.exposure = .35; app._render(); app._pushHistory();
                const edits = exported();
                crop(.25, .25, .5, .5);
                const second = exported();
                app._undo(); check(equal(exported(), edits), 'undo second crop retains global edits');
                app._undo(); check(equal(exported(), first), 'undo interleaved edit retains first crop');
                app._undo(); check(equal(exported(), full), 'undo first crop restores every source pixel');
                app._redo(); check(equal(exported(), first), 'redo first crop');
                app._redo(); check(equal(exported(), edits), 'redo interleaved edit');
                app._redo(); check(equal(exported(), second), 'redo second crop');
                const before = app.history.length;
                app.cropTool.activate();
                check(app.imageWidth === 960 && app.cropTool.cropX === .25, 'reopen full source with existing rectangle');
                app.cropTool.cropX = 0; app.cropTool.cropW = 1;
                app.cropTool.cancel();
                check(app.imageWidth === 480 && app.history.length === before && equal(exported(), second), 'cancel is not an edit');
                app.cropTool.activate();
                document.getElementById('crop-reset').click(); app.cropTool.apply();
                check(app.crop === null && app.state.exposure === .35, 'reset only crop');
                app._undo();
                const mask = app.maskEngine.createMask('polygon');
                app.maskEngine.setPolygon(mask, [{ x: .02, y: .02 }, { x: .98, y: .02 },
                    { x: .98, y: .98 }, { x: .02, y: .98 }], 10);
                mask.adjustments.temperature = 12; mask.inverted = true;
                app._render(); app._pushHistory();
                const vertices = JSON.stringify(mask.params), canvas = mask.canvas;
                crop(.2, .1, .6, .7, 7);
                check(app.maskEngine.masks[0].canvas === canvas &&
                    JSON.stringify(mask.params) === vertices && mask.type === 'polygon', 'crop retains mask geometry and pixels');
                app.cropTool.activate(); document.getElementById('crop-reset').click(); app.cropTool.apply();
                check(JSON.stringify(mask.params) === vertices && mask.inverted, 'uncrop retains original polygon corners/inversion');
                crop(.15, .2, .6, .65);
                const stable = app.review.snapshot();
                app._setCrop({ ...app.crop, x: app.crop.x + 1 });
                check(!app.review.matches(stable), 'same-size reframing invalidates async review');
                app._pushHistory();
                const brush = app.maskEngine.createMask('brush');
                app.viewport.zoomAt(2, { x: 0, y: 0 });
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                const r = document.getElementById('main-canvas').getBoundingClientRect();
                const event = { clientX: r.left + r.width * .01, clientY: r.top + r.height * .5 };
                const mapped = app._canvasToImage(event);
                check(Math.abs(mapped.imgX - (app.crop.x + app.crop.width * .01)) < .001, 'zoomed brush maps to source pixels');
                app.maskEngine.brushSize = 80; app.maskEngine.brushFlow = 100; app.maskEngine.brushFeather = 0;
                app.maskEngine.handlePointerDown(mapped.canvasX, mapped.canvasY, mapped.imgX, mapped.imgY);
                app.maskEngine.handlePointerUp();
                const sample = x => brush.ctx.getImageData(x, Math.round(mapped.imgY), 1, 1).data[0];
                check(sample(app.crop.x + 2) > 240 && sample(app.crop.x - 2) === 0,
                    'painting at cropped edge cannot change hidden source pixels');
                app.maskEngine.deleteMask(1); app.viewport.reset();
                const region = { name: 'test', reason: 'geometry', geometry: {
                    type: 'radial', x: .5, y: .5, width: .2, height: .2, feather: 0 },
                    adjustments: [{ key: 'exposure', value: .2 }] };
                const [adaptive] = app.maskEngine.buildReviewMasks([region]);
                check(Math.abs(adaptive.params.cx - (app.crop.x + app.crop.width / 2)) < .001,
                    'new AI region maps cropped preview back to original source');
                check(adaptive.ctx.getImageData(0, 0, 1, 1).data[0] === 0, 'new AI mask excludes hidden corners');
                window.expectedCrop = { crop: app.crop, vertices, exposure: app.state.exposure, history: app.history.length,
                    width: app.imageWidth, height: app.imageHeight, pixels: Array.from(exported()) };
                await library._saveCurrentEdits();
                const saved = await library._readEdits(library.photos[library.activeIndex]);
                check(saved.geometryVersion === 1 && saved.crop.width === app.imageWidth, 'persist metadata not cropped bitmap');
                check(!Object.hasOwn(saved, 'sourceCrops'), 'no destructive replay chain');
                return { history: app.history.length, source: [app.sourceWidth, app.sourceHeight],
                    output: [app.imageWidth, app.imageHeight] };
            });
            const persisted = await page.evaluate(() => ({ expected: window.expectedCrop,
                file: { name: cropFile.name, lastModified: cropFile.lastModified } }));
            // Reload the actual origin/IndexedDB; reselecting the original remains supported.
            const dataURL = await page.evaluate(() => new Promise(resolve => {
                const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(cropFile);
            }));
            await page.reload();
            await page.waitForFunction(() => window.app && window.library?.db);
            await page.evaluate(async ({ dataURL, expected, file }) => {
                const check = (condition, message) => { if (!condition) throw Error(message); };
                const blob = await (await fetch(dataURL)).blob();
                const originalFile = new File([blob], file.name, { type: 'image/png', lastModified: file.lastModified });
                check(library.photos.some(p => p.name === file.name && p.file), 'browser retains the original across reload');
                await library.addFiles([originalFile]);
                await library.openPhoto(library.photos.findIndex(p => p.name === file.name));
                check(app.imageWidth === expected.width && app.imageHeight === expected.height, 'reload restores framing');
                check(JSON.stringify(app.maskEngine.masks[0].params) === expected.vertices, 'reload retains polygon vertices');
                check(app.history.length === expected.history, 'reload retains all undo transactions');
                const out = await app._exportCanvasAsync();
                const actual = out.getContext('2d').getImageData(0, 0, out.width, out.height).data;
                check(actual.every((v, i) => v === expected.pixels[i]), 'async native export after reload has exact pixels');
                const batchCanvas = document.createElement('canvas'), engine = new GLEngine(batchCanvas);
                const batchBlob = await batchProcessor._processOneImage(originalFile, engine, batchCanvas, 'image/png', 1, 'png');
                const bitmap = await createImageBitmap(batchBlob);
                check(bitmap.width === expected.width && bitmap.height === expected.height, 'batch uses saved native crop dimensions');
                const copy = document.createElement('canvas'); copy.width = bitmap.width; copy.height = bitmap.height;
                copy.getContext('2d').drawImage(bitmap, 0, 0);
                const batchPixels = copy.getContext('2d').getImageData(0, 0, copy.width, copy.height).data;
                check(batchPixels.every((v, i) => v === expected.pixels[i]), 'batch export preserves saved crop, masks, curves and grading');
                bitmap.close(); engine.destroy(); copy.width = copy.height = 1;
                app.cropTool.activate(); document.getElementById('crop-reset').click(); app.cropTool.apply();
                check(app.imageWidth === 960 && app.imageHeight === 640 && app.state.exposure === expected.exposure,
                    'reload uncrop restores full original, retaining edits');
                app._undo(); check(app.imageWidth === expected.width, 'undo reset after reload');
                app._redo(); check(app.imageWidth === 960, 'redo reset after reload');
                const end = app.historyIndex;
                for (let i = 0; i < end; i++) app._undo();
                check(app.crop === null && app.state.exposure === 0 && app.maskEngine.masks.length === 0,
                    'undo entire saved history restores original baseline');
                for (let i = 0; i < end; i++) app._redo();
                check(app.crop === null && app.state.exposure === expected.exposure && app.maskEngine.masks.length === 1,
                    'redo entire saved history restores last edit');
                out.width = out.height = 1;
            }, { dataURL, expected: persisted.expected, file: persisted.file });
            await page.evaluate(() => {
                app.cropTool.activate();
                Object.assign(app.cropTool, { cropX: .25, cropY: .25, cropW: .5, cropH: .5 });
                app.cropTool.apply();
            });
            await page.locator(`${mobile ? '.mobile-tab' : '.vtab'}[data-panel="crop"]`).click();
            await page.waitForTimeout(400);
            const handles = await page.evaluate(() => {
                const cr = app.cropTool._canvasRect, r = app.cropTool.overlay.getBoundingClientRect();
                return { start: { x: r.left + cr.x + cr.w * .25, y: r.top + cr.y + cr.h * .25 },
                    end: { x: r.left + cr.x + cr.w * .1, y: r.top + cr.y + cr.h * .1 } };
            });
            if (mobile) {
                const cdp = await context.newCDPSession(page);
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, ...handles.start }] });
                await page.waitForTimeout(260);
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, ...handles.end }] });
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            } else {
                await page.mouse.move(handles.start.x, handles.start.y); await page.mouse.down();
                await page.mouse.move(handles.end.x, handles.end.y, { steps: 4 }); await page.mouse.up();
            }
            await page.locator(mobile ? '#mcrop-apply' : '#crop-apply').click();
            assert.ok(await page.evaluate(() => app.imageWidth > 600 && app.imageHeight > 400),
                'real pointer/touch crop handles expand the existing frame into hidden source pixels');
            assert.deepEqual(errors, []);
            console.log(`${mobile ? 'Mobile' : 'Desktop'} non-destructive source, exact native pixels, repeated crop/undo/redo, masks, cancel/reset, reload:`, result);
            await context.close();
        }
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
