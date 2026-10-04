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
        await page.goto(`http://127.0.0.1:${server.address().port}/`);
        await page.waitForFunction(() => window.app?.review);
        const result = await page.evaluate(async () => {
            const check = (ok, message) => { if (!ok) throw new Error(message); };
            const pixels = canvas => {
                const copy = document.createElement('canvas');
                copy.width = canvas.width; copy.height = canvas.height;
                const ctx = copy.getContext('2d'); ctx.drawImage(canvas, 0, 0);
                return ctx.getImageData(0, 0, copy.width, copy.height).data;
            };
            const source = document.createElement('canvas'), w = source.width = 2000, h = source.height = 280;
            const ctx = source.getContext('2d'), data = ctx.createImageData(w, h);
            let seed = 17;
            for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
                seed = (1664525 * seed + 1013904223) >>> 0;
                const i = (y * w + x) * 4;
                const v = 128 + 20 * Math.sin(x * 2 * Math.PI / 15) + 8 * Math.sin(y * 2 * Math.PI / 22) + (seed / 4294967296 - .5) * 12;
                data.data[i] = data.data[i + 1] = data.data[i + 2] = v; data.data[i + 3] = 255;
            }
            ctx.putImageData(data, 0, 0);
            const blob = await new Promise(resolve => source.toBlob(resolve));
            await app._loadFile(new File([blob], 'texture-export.png', { type: 'image/png' }));
            Object.assign(app.state, { texture: 60, clarity: 10, sharpenAmount: 8,
                noiseLuma: 40, noiseColor: 50, motionAmount: 40, motionLength: 5, motionAngle: 35 });
            const mask = app.maskEngine.createMask('radial');
            app.maskEngine.createRadialMask(1000, 140, 400, 130, 90);
            mask.adjustments.texture = -30; mask.blend = 'additive';
            app._pushHistory(); app._render();
            const beforeState = JSON.stringify(app.state), beforeMasks = JSON.stringify(app.maskEngine.describeMasks());
            const referenceEngine = new GLEngine(document.createElement('canvas'));
            referenceEngine.loadImage(app.image);
            referenceEngine.setRenderSize(w, h);
            referenceEngine.loadExportTile(app.image, app.state);
            referenceEngine.renderComposite(app.state, app.maskEngine.masks);
            const reference = pixels(referenceEngine.canvas);
            const exportCanvas = app._exportCanvas(1), exported = pixels(exportCanvas);
            const decodedBlob = await new Promise(resolve => exportCanvas.toBlob(resolve, 'image/png'));
            const bitmap = await createImageBitmap(decodedBlob);
            check(bitmap.width === w && bitmap.height === h, 'encoded native dimensions');
            const encoded = document.createElement('canvas');
            encoded.width = w; encoded.height = h; encoded.getContext('2d').drawImage(bitmap, 0, 0);
            check(pixels(encoded).every((v, i) => v === exported[i]), 'encoded PNG pixels exact');
            bitmap.close();
            let max = 0, mean = 0;
            for (let i = 0; i < reference.length; i++) {
                const d = Math.abs(reference[i] - exported[i]);
                max = Math.max(max, d); mean += d;
            }
            mean /= reference.length;
            check(max <= 3 && mean < .2, `untiled native parity including seams/edges: ${max}/${mean}`);
            const asyncCanvas = await app._exportCanvasAsync(1);
            check(pixels(asyncCanvas).every((v, i) => Math.abs(v - reference[i]) <= 3), '512px tiles preserve texture footprint');
            check(JSON.stringify(app.state) === beforeState && JSON.stringify(app.maskEngine.describeMasks()) === beforeMasks, 'export preserves state/masks');
            // Source-coordinate crop keeps the saved texture controls and undo restores local texture.
            app.state.textureEnabled = false;
            app._pushHistory();
            const uncropped = JSON.stringify(app.state);
            app.cropTool.activate();
            app.cropTool.cropX = .1; app.cropTool.cropY = .1;
            app.cropTool.cropW = .7; app.cropTool.cropH = .7;
            app.cropTool.apply();
            for (let i = 0; i < 200 && app.imageWidth === w; i++) await new Promise(resolve => setTimeout(resolve, 10));
            check(app.imageWidth === 1400 && app.imageHeight === 196, 'native crop dimensions');
            check(app.state.texture === 60 && app.state.textureEnabled === false, 'crop preserves disabled saved amount');
            const cropped = app._exportCanvas();
            check(cropped.width === 1400 && cropped.height === 196, 'cropped native export dimensions');
            app._undo();
            check(JSON.stringify(app.state) === uncropped, 'crop undo preserves texture flags');
            check(JSON.stringify(app.maskEngine.describeMasks()) === beforeMasks, 'crop undo restores masked texture');
            let sidecar;
            const photo = { id: 'texture-fixture', name: 'texture.png', fileHandle: {} };
            const library = Object.create(Library.prototype);
            Object.assign(library, { app, photos: [photo], activeIndex: 0, db: null,
                dirHandle: { getFileHandle: async () => ({
                    createWritable: async () => ({ write: async text => { sidecar = text; }, close: async () => {} }),
                    getFile: async () => ({ text: async () => sidecar })
                }) }
            });
            await library._saveCurrentEdits();
            app.state.texture = 0; app.state.textureEnabled = true; app.maskEngine.masks = [];
            await library._restoreEdits(photo);
            check(app.state.texture === 60 && app.state.textureEnabled === false, 'sidecar restores saved amount/switch');
            check(app.maskEngine.masks[0].adjustments.texture === -30, 'sidecar restores local texture');
            const legacy = JSON.parse(sidecar);
            delete legacy.state.texture; delete legacy.state.textureEnabled; delete legacy.masks[0].adjustments.texture;
            sidecar = JSON.stringify(legacy);
            await library._restoreEdits(photo);
            check(app.state.texture === 0 && app.state.textureEnabled === true, 'legacy state defaults neutral');
            // High-contrast boundaries and subthreshold grain should not acquire halos.
            const edge = document.createElement('canvas');
            edge.width = 96; edge.height = 48;
            const ec = edge.getContext('2d'), ed = ec.createImageData(96, 48);
            for (let y = 0; y < 48; y++) for (let x = 0; x < 96; x++) {
                const i = (y * 96 + x) * 4, v = (x < 48 ? 60 : 190) + ((x + y) % 2 ? 1 : -1);
                ed.data[i] = ed.data[i + 1] = ed.data[i + 2] = v; ed.data[i + 3] = 255;
            }
            ec.putImageData(ed, 0, 0);
            referenceEngine.loadImage(edge);
            referenceEngine.renderComposite({ texture: 0 }, []);
            const plain = pixels(referenceEngine.canvas);
            referenceEngine.renderComposite({ texture: 100 }, []);
            check(pixels(referenceEngine.canvas).every((v, i) => v === plain[i]), 'strong edge and weak fine grain protected');
            referenceEngine.destroy();
            for (const canvas of [source, edge, encoded, exportCanvas, asyncCanvas, cropped]) canvas.width = canvas.height = 1;
            return { maxChannelDifference: max, meanChannelDifference: mean, width: w, height: h };
        });
        console.log('Texture native PNG, synchronous/asynchronous tiles, night tools, masks, crop and undo:', result);
        assert.ok(result.maxChannelDifference <= 3);
    } finally {
        await browser.close(); server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
