'use strict';
// Opt-in real inference: downloads pinned public model weights, never uploads a photo.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createServer } = require('../server/index.js');

(async () => {
    const directory = '.azure-tools/semantic-validation';
    fs.mkdirSync(directory, { recursive: true });
    const server = createServer({ env: { LOCAL_REVIEW_ENABLED: 'false' },
        fetch: () => { throw new Error('Unexpected review request'); } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = process.env.BASE_URL || `http://127.0.0.1:${server.address().port}/`;
    const browser = await chromium.launch({ headless: true });
    try {
        const mobile = process.env.MOBILE === '1';
        const context = await browser.newContext({ viewport: { width: mobile ? 390 : 1440, height: mobile ? 844 : 1000 },
            isMobile: mobile, hasTouch: mobile });
        const page = await context.newPage();
        const errors = [], requests = [];
        page.on('pageerror', e => errors.push(e.message));
        context.on('request', r => {
            requests.push({ url: r.url(), method: r.method() });
            if (r.method() !== 'GET' || /\/api\/review/.test(r.url())) throw new Error(`Unexpected upload: ${r.url()}`);
        });
        page.on('console', m => { if (m.type() === 'error') console.log('browser:', m.text().slice(0, 600)); });
        await page.goto(base);
        await page.waitForFunction(() => window.app?.maskEngine);
        assert.equal(await page.locator('#detect-sky').isDisabled(), true);
        const file = process.env.PHOTO || '.azure-tools/semantic-validation/Fronalpstock.jpg';
        await page.locator('#file-input').setInputFiles(file);
        await page.waitForFunction(() => app.image && !app._importController, null, { timeout: 120000 });
        if (process.env.GRAYSCALE === '1') await page.evaluate(async () => {
            const c = document.createElement('canvas');
            c.width = 1200; c.height = Math.round(1200 * app.imageHeight / app.imageWidth);
            const ctx = c.getContext('2d'); ctx.filter = 'grayscale(1)';
            ctx.drawImage(app.image, 0, 0, c.width, c.height);
            const blob = await new Promise(resolve => c.toBlob(resolve));
            await app._loadFile(new File([blob], 'gray-sky.png', { type: 'image/png' }));
        });
        await page.click(`${mobile ? '.mobile-tab' : '.vtab'}[data-panel="masks"]`);
        for (const kind of (process.env.KINDS || 'sky,subject').split(',')) {
            const before = await page.evaluate(() => ({ count: app.maskEngine.masks.length,
                history: app.historyIndex, state: JSON.stringify(app.state) }));
            await page.evaluate(() => {
                window.__ticks = 0;
                window.__timer = setInterval(() => window.__ticks++, 50);
            });
            const start = Date.now();
            await page.click(`#detect-${kind}`);
            await page.waitForFunction(() => !app._detection, null, { timeout: 190000 });
            const result = await page.evaluate(() => {
                clearInterval(window.__timer);
                const mask = app.maskEngine.getActiveMask();
                return { status: document.getElementById('ai-status').textContent, ticks: window.__ticks,
                    count: app.maskEngine.masks.length, history: app.historyIndex,
                    state: JSON.stringify(app.state), metadata: mask?.detection,
                    seed: mask?.canvas.toDataURL(), image: (() => {
                        const c = document.createElement('canvas');
                        c.width = 768; c.height = Math.round(768 * app.imageHeight / app.imageWidth);
                        c.getContext('2d').drawImage(app.image, 0, 0, c.width, c.height);
                        return c.toDataURL();
                    })() };
            });
            const stem = `${path.basename(file).replace(/\W/g, '-')}-${kind}`;
            for (const key of ['image', 'seed']) if (result[key])
                fs.writeFileSync(`${directory}/${stem}-${key}.png`, Buffer.from(result[key].split(',')[1], 'base64'));
            delete result.image; delete result.seed;
            delete result.state;
            console.log(JSON.stringify({ kind, elapsed: Date.now() - start, ...result }));
            await page.screenshot({ path: `${directory}/${stem}.png` });
            if (process.env.EXPECT_EMPTY === '1') {
                assert.equal(result.count, before.count);
                assert.match(result.status, /No reliable/);
                assert.equal(result.history, before.history);
                continue;
            }
            assert.equal(result.count, before.count + 1, result.status);
            assert.equal(result.history, before.history + 1, 'Detection is one undo');
            assert.equal(await page.evaluate(() => JSON.stringify(app.state)), before.state);
            assert.equal(result.metadata.kind, kind);
            assert.ok(result.ticks > 2, 'UI timer remains responsive during inference');
            if (kind === 'sky' && path.basename(file) === 'Fronalpstock.jpg') {
                const iou = await page.evaluate(() => {
                    const w = 768, h = 345, c = document.createElement('canvas'); c.width = w; c.height = h;
                    const ctx = c.getContext('2d');
                    ctx.drawImage(app.maskEngine.getActiveMask().canvas, 0, 0, w, h);
                    const mask = ctx.getImageData(0, 0, w, h).data;
                    ctx.fillStyle = 'black'; ctx.fillRect(0, 0, w, h);
                    // Coarse hand-traced reference skyline, not model-generated ground truth.
                    const edge = [[0,156],[58,143],[125,139],[152,125],[180,129],[205,125],[224,127],
                        [272,111],[299,101],[326,99],[350,94],[368,100],[402,98],[435,121],[463,112],
                        [498,112],[522,96],[548,103],[580,94],[616,105],[638,102],[657,81],[686,91],
                        [720,75],[750,90],[768,89]];
                    ctx.fillStyle = 'white'; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(w, 0);
                    for (const [x, y] of edge.reverse()) ctx.lineTo(x, y);
                    ctx.closePath(); ctx.fill();
                    const reference = ctx.getImageData(0, 0, w, h).data;
                    let intersection = 0, union = 0;
                    for (let i = 0; i < mask.length; i += 4) {
                        const a = mask[i] >= 128, b = reference[i] >= 128;
                        if (a && b) intersection++; if (a || b) union++;
                    }
                    return intersection / union;
                });
                console.log('coarse skyline IoU', iou);
                assert.ok(iou > .9, 'Sky selection matches hand-traced skyline and includes non-blue clouds');
            }
            const maskPNG = await page.evaluate(() => app.maskEngine.getActiveMask().canvas.toDataURL());
            await page.evaluate(() => app._undo());
            assert.equal(await page.evaluate(() => app.maskEngine.masks.length), before.count);
            await page.evaluate(() => app._redo());
            assert.equal(await page.evaluate(() => app.maskEngine.getActiveMask().canvas.toDataURL()), maskPNG);
            if (kind === 'sky') {
                await page.evaluate(() => {
                    document.querySelector('#mask-list .mask-item:last-child').click();
                    const canvas = app._exportCanvas(256 / app.imageWidth);
                    window.__beforeSky = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
                    app._applySkyPreset('sunset');
                });
                const locality = await page.evaluate(() => {
                    const after = app._exportCanvas(256 / app.imageWidth), w = after.width, h = after.height;
                    const pixels = after.getContext('2d').getImageData(0, 0, w, h).data;
                    const c = document.createElement('canvas'); c.width = w; c.height = h;
                    c.getContext('2d').drawImage(app.maskEngine.getActiveMask().canvas, 0, 0, w, h);
                    const mask = c.getContext('2d').getImageData(0, 0, w, h).data;
                    let outside = 0, outsideChanged = 0, insideChanged = 0;
                    for (let i = 0; i < pixels.length; i += 4) {
                        const difference = Math.max(...[0, 1, 2].map(c => Math.abs(pixels[i + c] - window.__beforeSky.data[i + c])));
                        if (!mask[i]) { outside++; if (difference > 1) outsideChanged++; }
                        else if (difference > 1) insideChanged++;
                    }
                    delete window.__beforeSky;
                    return { outside, outsideChanged, insideChanged };
                });
                console.log('preset locality', locality);
                assert.ok(locality.outside > 100);
                assert.equal(locality.outsideChanged, 0);
                assert.ok(locality.insideChanged > 100);
                const preset = await page.evaluate(() => ({ state: JSON.stringify(app.state), history: app.historyIndex,
                    pixels: app._exportCanvas(.2).toDataURL(), seed: app.maskEngine.getActiveMask().canvas.toDataURL() }));
                await page.evaluate(() => app._applySkyPreset('sunset'));
                assert.deepEqual(await page.evaluate(() => ({ state: JSON.stringify(app.state), history: app.historyIndex,
                    pixels: app._exportCanvas(.2).toDataURL(), seed: app.maskEngine.getActiveMask().canvas.toDataURL() })), preset);
                assert.equal(preset.state, before.state);
                assert.equal(preset.seed, maskPNG);
            }
            const refinement = await page.evaluate(() => {
                const mask = app.maskEngine.getActiveMask(), before = mask.canvas.toDataURL();
                const pixels = mask.ctx.getImageData(0, 0, mask.canvas.width, mask.canvas.height).data;
                let index = -1;
                for (let i = 0; i < pixels.length; i += 4)
                    if (pixels[i] > 240) { index = i / 4; break; }
                if (index < 0) throw new Error('No detected foreground to refine');
                app._pushHistory();
                app.maskEngine.eraseMode = true; app.maskEngine.brushFlow = 100;
                app.maskEngine.brushFeather = 0; app.maskEngine.brushSize = 300;
                app.maskEngine._brushStroke(mask, index % mask.canvas.width, Math.floor(index / mask.canvas.width));
                app._pushHistory();
                const after = mask.canvas.toDataURL();
                app._undo();
                const undone = app.maskEngine.getActiveMask().canvas.toDataURL();
                app._redo();
                const redone = app.maskEngine.getActiveMask().canvas.toDataURL();
                return { changed: before !== after, undo: undone === before, redo: redone === after };
            });
            assert.deepEqual(refinement, { changed: true, undo: true, redo: true });
            const persisted = await page.evaluate(async () => {
                await library._saveCurrentEdits();
                const photo = library.photos[library.activeIndex];
                const saved = await library._readEdits(photo);
                const before = app.maskEngine.getActiveMask().canvas.toDataURL();
                await library._restoreEdits(photo, saved);
                return { kind: app.maskEngine.getActiveMask().detection?.kind,
                    identical: app.maskEngine.getActiveMask().canvas.toDataURL() === before };
            });
            assert.equal(persisted.kind, kind); assert.equal(persisted.identical, true);
        }
        if (process.env.EXPECT_EMPTY !== '1') {
            const cancelled = await page.evaluate(async () => {
                const count = app.maskEngine.masks.length, history = app.history.length;
                app._detectMask('subject'); app._cancelDetection();
                await new Promise(resolve => setTimeout(resolve, 200));
                return { same: app.maskEngine.masks.length === count && app.history.length === history, pending: !!app._detection };
            });
            assert.deepEqual(cancelled, { same: true, pending: false });
            await page.evaluate(() => {
                window.__preCropImage = app.image;
                window.__preCropMasks = app.maskEngine.masks.map(m => m.canvas.toDataURL());
                app.cropTool.activate();
                app.cropTool.cropX = .1; app.cropTool.cropY = .1;
                app.cropTool.cropW = .8; app.cropTool.cropH = .8;
                app.cropTool.rotation = 4;
                app.cropTool.apply();
            });
            await page.waitForFunction(() => app.image !== window.__preCropImage && !app.cropTool.active, null, { timeout: 30000 });
            const crop = await page.evaluate(async () => {
                const masks = app.maskEngine.masks.map(m => ({ kind: m.detection.kind, png: m.canvas.toDataURL() }));
                await library._saveCurrentEdits();
                const photo = library.photos[library.activeIndex], saved = await library._readEdits(photo);
                const original = app._originalFile, width = app.imageWidth, height = app.imageHeight;
                await app._loadFile(original);
                await library._restoreEdits(photo, saved);
                return { masks, restored: app.maskEngine.masks.map(m => ({ kind: m.detection.kind, png: m.canvas.toDataURL() })),
                    size: [width, height], restoredSize: [app.imageWidth, app.imageHeight] };
            });
            assert.deepEqual(crop.restored, crop.masks, 'cropped mask survives source reload and Library restoration');
            assert.deepEqual(crop.restoredSize, crop.size);
        }
        assert.deepEqual(errors, []);
        console.log('PASS: real local inference, named editable masks, Undo/Redo, sky preset idempotence, no photo uploads.');
        await context.close();
    } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
