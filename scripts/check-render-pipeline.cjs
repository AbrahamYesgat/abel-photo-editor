'use strict';

// Synthetic photos only: validates pixels against the previous CPU blend semantics.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createServer } = require('../server/index.js');

(async () => {
    const server = createServer({ env: { LOCAL_REVIEW_ENABLED: 'false' } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(process.env.BASE_URL || `http://127.0.0.1:${server.address().port}/`);
        await page.waitForFunction(() => window.app?.review);
        const results = await page.evaluate(async () => {
            const check = (condition, message) => { if (!condition) throw new Error(message); };
            const source = document.createElement('canvas');
            source.width = 1310; source.height = 900;
            const context = source.getContext('2d');
            const gradient = context.createLinearGradient(0, 0, 1310, 900);
            gradient.addColorStop(0, '#23405a'); gradient.addColorStop(1, '#b9a987');
            context.fillStyle = gradient; context.fillRect(0, 0, 1310, 900);
            for (let x = 1; x < 1310; x += 11) {
                context.fillStyle = x % 3 ? '#788880' : '#586776';
                context.fillRect(x, 0, 2, 900);
            }
            context.clearRect(0, 0, 30, 30);
            const blob = await new Promise(resolve => source.toBlob(resolve));
            await app._loadFile(new File([blob], 'render-regression.png', { type: 'image/png' }));
            app.state.clarity = 12;
            app.state.sharpenAmount = 8;
            app.state.vignetteAmount = -8;
            app.state.grainAmount = 3;
            const first = app.maskEngine.createMask('radial');
            app.maskEngine.createRadialMask(420, 450, 380, 420, 90);
            first.adjustments.exposure = .3;
            first.opacity = .4;
            const second = app.maskEngine.createMask('gradient');
            app.maskEngine.createLinearMask(0, 80, 1310, 820, true);
            second.blend = 'additive';
            second.adjustments.exposure = -.2;
            second.adjustments.clarity = 10;
            const third = app.maskEngine.createMask('brush');
            app.maskEngine.brushSize = 180;
            app.maskEngine.brushStart(850, 350);
            app.maskEngine.brushMove(900, 350); app.maskEngine.brushEnd();
            third.adjustments.temperature = 8;
            third.inverted = true;
            third.opacity = .7;
            app._pushHistory();
            const engine = app.glEngine, gl = engine.gl;
            const pixels = canvas => {
                const copy = document.createElement('canvas');
                copy.width = canvas.width; copy.height = canvas.height;
                copy.getContext('2d').drawImage(canvas, 0, 0);
                const data = copy.getContext('2d').getImageData(0, 0, copy.width, copy.height);
                copy.width = copy.height = 1;
                return data;
            };
            const difference = (a, b) => {
                check(a.length === b.length, 'pixel buffers have matching dimensions');
                let max = 0, sum = 0;
                for (let i = 0; i < a.length; i++) {
                    const delta = Math.abs(a[i] - b[i]); max = Math.max(max, delta); sum += delta;
                }
                return { max, mean: sum / a.length };
            };
            const cpuReference = () => {
                const w = engine.canvas.width, h = engine.canvas.height;
                engine.setAdjustments(app.state); engine.render();
                const output = document.createElement('canvas'); output.width = w; output.height = h;
                const ctx = output.getContext('2d', { willReadFrequently: true });
                ctx.drawImage(engine.canvas, 0, 0);
                const base = ctx.getImageData(0, 0, w, h).data;
                for (const mask of app.maskEngine.masks.filter(mask => mask.visible)) {
                    const adjusted = { ...app.state };
                    for (const [key, value] of Object.entries(mask.adjustments)) {
                        if (typeof adjusted[key] === 'number') adjusted[key] += value;
                    }
                    engine.setAdjustments(adjusted); engine.render();
                    const layer = pixels(engine.canvas);
                    const selection = document.createElement('canvas'); selection.width = w; selection.height = h;
                    const mctx = selection.getContext('2d', { willReadFrequently: true });
                    mctx.drawImage(mask.canvas, 0, 0, w, h);
                    const md = mctx.getImageData(0, 0, w, h).data;
                    if (mask.blend === 'additive') {
                        const data = ctx.getImageData(0, 0, w, h);
                        for (let i = 0; i < md.length; i += 4) {
                            const weight = (mask.inverted ? 255 - md[i] : md[i]) / 255 * (mask.opacity ?? 1);
                            for (let c = 0; c < 3; c++) data.data[i + c] += (layer.data[i + c] - base[i + c]) * weight;
                        }
                        ctx.putImageData(data, 0, 0);
                    } else {
                        for (let i = 0; i < md.length; i += 4) layer.data[i + 3] = (mask.inverted ? 255 - md[i] : md[i]) * (mask.opacity ?? 1);
                        mctx.putImageData(layer, 0, 0);
                        ctx.drawImage(selection, 0, 0);
                    }
                    selection.width = selection.height = 1;
                }
                const result = ctx.getImageData(0, 0, w, h);
                output.width = output.height = 1;
                return result.data;
            };
            app._render();
            const expected = cpuReference();
            app._render();
            const blend = difference(expected, pixels(engine.canvas).data);
            check(blend.max <= 3 && blend.mean < .5, `GPU/CPU blend accuracy: ${JSON.stringify(blend)}`);
            first.opacity = .8;
            const changedOpacity = cpuReference();
            app._render();
            const opacityDiff = difference(changedOpacity, pixels(engine.canvas).data);
            check(opacityDiff.max <= 3 && opacityDiff.mean < .5,
                `earlier-mask opacity invalidates the cached composite prefix: ${JSON.stringify(opacityDiff)}`);
            const before = pixels(engine.canvas).data;
            // Cached geometry must not hide brush edits, visibility, inversion or deletion.
            app.maskEngine.brushStart(300, 300); app.maskEngine.brushEnd(); app._render();
            check(difference(before, pixels(engine.canvas).data).max > 0, 'brush revision invalidates GPU mask');
            third.inverted = false; app._render();
            const inverted = pixels(engine.canvas).data;
            third.visible = false; app._render();
            check(difference(inverted, pixels(engine.canvas).data).max > 0, 'mask visibility updates');
            third.visible = true;
            app._render();
            const preview = pixels(engine.canvas).data;
            const exported = app._exportCanvas();
            check(exported.width === 1310 && exported.height === 900, 'native export dimensions');
            const exportDiff = difference(preview, pixels(exported).data);
            check(exportDiff.max <= 3 && exportDiff.mean < .1, `tiled export seam/clarity accuracy: ${JSON.stringify(exportDiff)}`);
            check(difference(preview, pixels(engine.canvas).data).max === 0, 'export restores exact preview');
            exported.width = exported.height = 1;

            // Slider-only renders allocate/upload/read back no full-frame CPU canvases.
            let creates = 0, reads = 0, uploads = 0, draws = 0, visibleDraws = 0;
            const create = document.createElement.bind(document);
            const getData = CanvasRenderingContext2D.prototype.getImageData;
            const upload = gl.texImage2D.bind(gl), draw = gl.drawArrays.bind(gl);
            document.createElement = (...args) => { if (args[0] === 'canvas') creates++; return create(...args); };
            CanvasRenderingContext2D.prototype.getImageData = function(...args) { reads++; return getData.apply(this, args); };
            gl.texImage2D = (...args) => { uploads++; return upload(...args); };
            gl.drawArrays = (...args) => {
                draws++;
                if (!gl.getParameter(gl.FRAMEBUFFER_BINDING)) visibleDraws++;
                return draw(...args);
            };
            let passes;
            try {
                first.adjustments.exposure = .4;
                app._render();
                passes = { creates, reads, uploads, draws, visibleDraws };
                check(creates === 0 && reads === 0 && uploads === 0, 'slider reuses textures without CPU readback');
                check(visibleDraws === 1 && draws === 4, 'one adjusted layer + three blends, only final result visible');
                const render = app._render.bind(app);
                let frames = 0;
                app._render = (...args) => { frames++; render(...args); };
                for (let i = 0; i < 20; i++) app._onSliderChange('mask_exposure', i / 100, 'mask');
                await new Promise(requestAnimationFrame);
                app._render = render;
                check(frames === 1, 'slider burst is coalesced into one animation frame');
            } finally {
                document.createElement = create;
                CanvasRenderingContext2D.prototype.getImageData = getData;
                gl.texImage2D = upload; gl.drawArrays = draw;
            }
            check(!document.getElementById('composite-overlay'), 'single display canvas');
            check(!gl.isContextLost() && gl.getError() === 0, 'WebGL remains healthy');
            app._render();
            const wand = app.maskEngine.createMask('wand');
            const wandStart = performance.now();
            app.maskEngine.magicWandSelect(400, 420, false);
            wand.adjustments.exposure = .15;
            app._render();
            const wandMilliseconds = Math.round(performance.now() - wandStart);
            check(wand.revision > 0, 'wand selection invalidates its cached texture');
            app.maskEngine.deleteMask(0);
            app._render();
            const deletedReference = cpuReference();
            app._render();
            check(difference(deletedReference, pixels(engine.canvas).data).max <= 3, 'deletion invalidates cached prefix');
            for (let i = 0; i < 4; i++) {
                const mask = app.maskEngine.createMask('radial');
                app.maskEngine.createRadialMask(250 + 200 * i, 450, 300, 400, 80);
                mask.adjustments.exposure = .1 + i * .05;
                mask.blend = i % 2 ? 'additive' : undefined;
            }
            app._render();
            check(engine._layers.length + engine._mixTargets.length === 4, 'more than six masks use bounded scratch targets');
            const manyReference = cpuReference();
            app._render();
            const manyDiff = difference(manyReference, pixels(engine.canvas).data);
            check(manyDiff.max <= 4 && manyDiff.mean < .5, 'streamed mask layers preserve blend order');

            // A source wider than common GPU texture limits is exported from native tiles.
            const strip = document.createElement('canvas');
            strip.width = 9000; strip.height = 32;
            const stripContext = strip.getContext('2d');
            stripContext.fillStyle = '#203040'; stripContext.fillRect(0, 0, 9000, 32);
            stripContext.fillStyle = '#ffffff';
            for (let x = 0; x < 9000; x += 7) stripContext.fillRect(x, 0, 1, 32);
            const stripPixels = pixels(strip).data;
            const stripBlob = await new Promise(resolve => strip.toBlob(resolve));
            await app._loadFile(new File([stripBlob], 'wide-native.png', { type: 'image/png' }));
            const wideExport = app._exportCanvas();
            check(wideExport.width === 9000 && wideExport.height === 32, 'wide source keeps native dimensions');
            const wideDiff = difference(stripPixels, pixels(wideExport).data);
            check(wideDiff.max <= 1, `native one-pixel details survive export: ${JSON.stringify(wideDiff)}`);
            check(!gl.isContextLost() && gl.getError() === 0, 'wide image does not exceed GPU texture limits');
            return { blend, exportDiff, wideDiff, manyDiff, passes, wandMilliseconds };
        });
        assert.deepEqual(errors, []);
        console.log(JSON.stringify(results));
    } finally {
        await browser.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
