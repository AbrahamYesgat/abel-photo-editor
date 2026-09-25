'use strict';
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createServer } = require('../server/index.js');

(async () => {
    const file = process.env.CR3_FIXTURE || '.azure-tools/raw-validation/Canon-EOS-R.CR3';
    assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'),
        'cfd118af4477ef37538eb953421572a7a5c80694e59764049223107cc0c9ae83', 'CC0 raw.pixls.us sample #4611');
    const server = createServer({ env: { LOCAL_REVIEW_ENABLED: 'false' } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ headless: true });
    try {
        for (const mobile of [false, true]) {
            const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
                isMobile: mobile, hasTouch: mobile,
                ...(mobile ? { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' } : {}) });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.goto(process.env.BASE_URL || `http://127.0.0.1:${server.address().port}/`);
            await page.waitForFunction(() => window.app && window.ImageImport);
            const uploads = [];
            page.on('request', request => { if (request.method() === 'POST') uploads.push(request.url()); });
            await page.setInputFiles('#file-input', file);
            await page.waitForFunction(() => window.app._rawInfo || document.getElementById('import-status').dataset.error === 'true', null, { timeout: 120000 });
            const info = await page.evaluate(() => ({ raw: app._rawInfo,
                status: document.getElementById('import-status').textContent, width: app.imageWidth, height: app.imageHeight }));
            console.log(JSON.stringify({ mobile, ...info }));
            assert.ok(info.raw, info.status);
            assert.equal(info.raw.decoder, 'LibRaw 0.22.1');
            assert.match(info.raw.camera, /EOS R/);
            assert.equal(info.raw.halfSize, mobile);
            assert.equal(info.width, mobile ? 3371 : 6742);
            assert.equal(info.height, mobile ? 2249 : 4498);
            await page.waitForFunction(() => library.photos.length === 1);
            const edited = await page.evaluate(async () => {
                const canvas = document.createElement('canvas');
                canvas.width = canvas.height = 20;
                canvas.getContext('2d').drawImage(app.image, 0, 0, 20, 20);
                const values = canvas.getContext('2d').getImageData(0, 0, 20, 20).data;
                const variance = new Set(values).size;
                app.state.exposure = 0.3;
                app.state.clarity = 8;
                app.maskEngine.createMask('radial');
                const mask = app.maskEngine.getActiveMask();
                mask.ctx.fillStyle = 'white';
                mask.ctx.fillRect(0, 0, mask.canvas.width, mask.canvas.height);
                mask.adjustments.exposure = 0.25;
                app.maskEngine.touch(mask);
                app._render();
                app._pushHistory();
                app._undo();
                app._redo();
                const output = app._exportCanvas();
                const size = { width: output.width, height: output.height };
                const blob = await new Promise(resolve => output.toBlob(resolve, 'image/jpeg', 0.8));
                output.width = output.height = 1;
                const roundtrip = await createImageBitmap(blob);
                const result = { ...size, roundtrip: [roundtrip.width, roundtrip.height], bytes: blob.size, variance,
                    filename: app._fileName, original: app._originalFile.name };
                roundtrip.close();
                return result;
            });
            console.log(JSON.stringify({ mobile, edited }));
            assert.equal(edited.width, info.width);
            assert.equal(edited.height, info.height);
            assert.deepEqual(edited.roundtrip, [info.width, info.height]);
            assert.ok(edited.variance > 80);
            assert.ok(edited.bytes > 10000);
            assert.equal(edited.filename, 'Canon-EOS-R');
            assert.equal(edited.original, 'Canon-EOS-R.CR3');
            const lifecycle = await page.evaluate(async mobile => {
                const file = app._originalFile;
                await library._saveCurrentEdits();
                document.getElementById('raw-half-size').checked = !mobile;
                await library.openPhoto(0);
                const restored = { exposure: app.state.exposure, masks: app.maskEngine.masks.length,
                    halfSize: app._rawInfo.halfSize, width: app.imageWidth };
                const before = app.image;
                const invalid = await app._loadFile(new File(['not a raw image'], '<bad>.CR3'));
                const unchanged = app.image === before;
                const truncated = await app._loadFile(new File([await file.slice(0, 1024).arrayBuffer()], 'broken.CR3'));
                const error = document.getElementById('import-status').textContent;
                const pending = app._loadFile(file, { halfSize: mobile });
                await new Promise(resolve => setTimeout(resolve, 30));
                app._importController.abort();
                const cancelled = await pending;
                const cancelledUnchanged = app.image === before;
                const crop = app.cropTool;
                crop.cropX = 0.1; crop.cropY = 0.1; crop.cropW = 0.5; crop.cropH = 0.5; crop.rotation = 0;
                crop.apply();
                await new Promise((resolve, reject) => {
                    const start = Date.now();
                    const check = () => app.image !== before ? resolve() : Date.now() - start > 10000 ? reject(new Error('Crop timed out')) : setTimeout(check, 20);
                    check();
                });
                const cropped = [app.imageWidth, app.imageHeight];
                app._undo();
                return { restored, invalid, unchanged, truncated, error, cancelled, cancelledUnchanged,
                    cropped, uncropped: [app.imageWidth, app.imageHeight], sameOriginal: app.image === before };
            }, mobile);
            console.log(JSON.stringify({ mobile, lifecycle }));
            assert.equal(lifecycle.restored.halfSize, mobile, 'library restores RAW development size with edits');
            assert.equal(lifecycle.restored.exposure, 0.3);
            assert.equal(lifecycle.restored.masks, 1);
            assert.equal(lifecycle.invalid, false);
            assert.equal(lifecycle.unchanged, true);
            assert.equal(lifecycle.truncated, false);
            assert.match(lifecycle.error, /Cannot develop this CR3/);
            assert.equal(lifecycle.cancelled, false);
            assert.equal(lifecycle.cancelledUnchanged, true);
            assert.deepEqual(lifecycle.cropped, [Math.round(info.width / 2), Math.round(info.height / 2)]);
            assert.deepEqual(lifecycle.uncropped, [info.width, info.height]);
            assert.equal(lifecycle.sameOriginal, true);
            if (mobile) {
                const portrait = await page.evaluate(async () => {
                    const file = app._originalFile;
                    const bytes = new Uint8Array(await file.arrayBuffer());
                    const data = new DataView(bytes.buffer);
                    let tiff;
                    for (let i = 0; i < 10000; i++) {
                        if (String.fromCharCode(...bytes.subarray(i, i + 4)) === 'CMT1') { tiff = i + 4; break; }
                    }
                    if (!tiff || data.getUint16(tiff, true) !== 0x4949) throw new Error('Fixture TIFF not found');
                    const ifd = tiff + data.getUint32(tiff + 4, true);
                    let changed = false;
                    for (let i = 0; i < data.getUint16(ifd, true); i++) {
                        const entry = ifd + 2 + 12 * i;
                        if (data.getUint16(entry, true) === 0x112) { data.setUint16(entry + 8, 6, true); changed = true; break; }
                    }
                    if (!changed) throw new Error('Fixture orientation not found');
                    const canvas = document.createElement('canvas');
                    canvas.width = canvas.height = 64;
                    const ctx = canvas.getContext('2d');
                    ctx.translate(32, 32); ctx.rotate(Math.PI / 2);
                    ctx.drawImage(app.image, -32, -32, 64, 64);
                    const expected = ctx.getImageData(0, 0, 64, 64).data;
                    const loaded = await app._loadFile(new File([bytes], 'portrait.CR3'), { halfSize: true });
                    ctx.resetTransform(); ctx.drawImage(app.image, 0, 0, 64, 64);
                    const actual = ctx.getImageData(0, 0, 64, 64).data;
                    const difference = actual.reduce((sum, value, i) => sum + Math.abs(value - expected[i]), 0) / actual.length;
                    return { loaded, width: app.imageWidth, height: app.imageHeight, difference, flip: app._rawInfo.orientation };
                });
                console.log(JSON.stringify({ portrait }));
                assert.equal(portrait.loaded, true);
                assert.deepEqual([portrait.width, portrait.height], [2249, 3371]);
                assert.equal(portrait.flip, 6);
                assert.ok(portrait.difference < 3, 'EXIF rotation is applied exactly once');
            }
            if (!mobile) {
                const crawFile = process.env.CRAW_FIXTURE || '.azure-tools/raw-validation/Canon-EOS-M50-CRAW.CR3';
                assert.equal(createHash('sha256').update(readFileSync(crawFile)).digest('hex'),
                    '15384b775867ec4c42b11882837f1e368cedc0561832ffab271221e6bb80be4c');
                await page.setInputFiles('#lib-file-input', crawFile);
                await page.waitForFunction(() => library.photos.length === 2, null, { timeout: 120000 });
                const craw = await page.evaluate(async () => {
                    document.getElementById('raw-half-size').checked = false;
                    await library.openPhoto(1);
                    const info = app._rawInfo;
                    const file = app._originalFile;
                    document.getElementById('raw-half-size').checked = true;
                    batchProcessor.show();
                    batchProcessor.addFiles([file]);
                    await batchProcessor.processAll();
                    const output = await createImageBitmap(batchProcessor.processedBlobs[0].blob);
                    const result = { info, batch: [output.width, output.height], name: batchProcessor.processedBlobs[0].name,
                        thumb: library.photos[1].thumbUrl.startsWith('data:image/jpeg') };
                    output.close();
                    return result;
                });
                console.log(JSON.stringify({ craw }));
                assert.match(craw.info.camera, /EOS M50/);
                assert.equal(craw.info.halfSize, false);
                assert.ok(craw.info.width * craw.info.height > 23e6);
                assert.deepEqual(craw.batch, [Math.ceil(craw.info.width / 2), Math.ceil(craw.info.height / 2)]);
                assert.equal(craw.thumb, true);
                assert.match(craw.name, /_ABEL\.jpe?g$/);
            }
            assert.deepEqual(uploads, [], 'RAW processing never uploads photos');
            assert.deepEqual(errors, []);
            await context.close();
        }
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
