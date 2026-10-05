'use strict';

const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createServer } = require('../server/index.js');

(async () => {
    const server = createServer({ env: { LOCAL_REVIEW_ENABLED: 'false' } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ headless: true });
    try {
        for (const mobile of [false, true]) {
            const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } :
                { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile });
            const errors = [];
            page.on('pageerror', e => errors.push(e.message));
            const base = process.env.BASE_URL || `http://127.0.0.1:${server.address().port}/`;
            await page.route('**/*', route => {
                const url = new URL(route.request().url());
                return url.origin === new URL(base).origin && !url.pathname.includes('/api/')
                    ? route.continue() : route.abort();
            });
            await page.goto(base); await page.waitForFunction(() => window.app?.polygon);
            const metrics = await page.evaluate(async ({ mobile, exportPhoto }) => {
                const c = document.createElement('canvas'); c.width = 6000; c.height = 4000;
                const ctx = c.getContext('2d'), g = ctx.createLinearGradient(0, 0, 6000, 4000);
                g.addColorStop(0, '#435670'); g.addColorStop(1, '#b7a180');
                ctx.fillStyle = g; ctx.fillRect(0, 0, 6000, 4000);
                const blob = await new Promise(resolve => c.toBlob(resolve)); c.width = c.height = 1;
                await app._loadFile(new File([blob], 'large-polygon.png', { type: 'image/png' }));
                for (let i = 0; i < 3; i++) {
                    const m = app.maskEngine.createMask('radial');
                    app.maskEngine.createRadialMask(m.canvas.width * (i + 1) / 4,
                        m.canvas.height / 2, m.canvas.width / 4, m.canvas.height / 3, 70);
                    m.adjustments.exposure = .1 + i * .1;
                }
                const mask = app.maskEngine.createMask('polygon');
                const points = Array.from({ length: 64 }, (_, i) => ({
                    x: .5 + .4 * Math.cos(i * Math.PI / 32), y: .5 + .4 * Math.sin(i * Math.PI / 32),
                }));
                const rasterTimes = [];
                for (const feather of [0, 25, 70, 100]) {
                    const start = performance.now();
                    app.maskEngine.setPolygon(mask, points, feather);
                    mask.ctx.getImageData(0, 0, 1, 1); // Flush canvas commands.
                    rasterTimes.push(performance.now() - start);
                }
                mask.adjustments.exposure = .7; mask.adjustments.dehaze = 18;
                app.maskMode = true; app.showMaskOverlay = false;
                app._updateMaskList(); app._pushHistory();
                const gl = app.glEngine.gl;
                const flush = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
                app._render(); flush();
                const controlTimes = [];
                for (let i = 0; i < 6; i++) {
                    const start = performance.now();
                    app._onSliderChange('mask_dehaze', 20 + i, 'mask');
                    await new Promise(requestAnimationFrame); flush();
                    controlTimes.push(performance.now() - start);
                }
                clearTimeout(app._historyDebounce); app._pushHistory();
                app._render(); flush(); // Settle the existing low-resolution slider preview before measuring drag.
                await new Promise(requestAnimationFrame);
                let rasterCalls = 0, photoRenders = 0, uploads = 0;
                const setPolygon = app.maskEngine.setPolygon, render = app._render, upload = gl.texImage2D;
                app.maskEngine.setPolygon = function (...args) { rasterCalls++; return setPolygon.apply(this, args); };
                app._render = function (...args) { photoRenders++; return render.apply(this, args); };
                gl.texImage2D = function (...args) { uploads++; return upload.apply(this, args); };
                const revision = mask.revision, history = app.history.length;
                const r = document.getElementById('main-canvas').getBoundingClientRect();
                const p = (x, y) => ({ clientX: r.left + x * r.width, clientY: r.top + y * r.height });
                app._canvasPointerDown(p(.9, .5));
                const moveTimes = [];
                for (let i = 0; i < 30; i++) {
                    const start = performance.now();
                    app._canvasPointerMove(p(.9 - i * .0005, .5));
                    await new Promise(requestAnimationFrame);
                    moveTimes.push(performance.now() - start);
                }
                const during = { rasterCalls, photoRenders, uploads, revisionUnchanged: mask.revision === revision,
                    historyUnchanged: app.history.length === history };
                const start = performance.now(); app._canvasPointerUp(); flush();
                const commitMs = performance.now() - start;
                const committed = { rasterCalls, photoRenders, uploads, historySteps: app.history.length - history };
                app.maskEngine.setPolygon = setPolygon; app._render = render; gl.texImage2D = upload;
                let exported;
                if (exportPhoto && !mobile) {
                    const started = performance.now(), canvas = await app._exportCanvasAsync();
                    exported = { width: canvas.width, height: canvas.height, ms: performance.now() - started };
                    canvas.width = canvas.height = 1;
                }
                return { mobile, rasterTimes, controlTimes, moveTimes, commitMs, during, committed, exported,
                    maskSize: [mask.canvas.width, mask.canvas.height], glError: gl.getError(),
                    contextLost: gl.isContextLost(), singlePhoto: !document.getElementById('composite-overlay') };
            }, { mobile, exportPhoto: !!process.env.EXPORT_PHOTO });
            console.log(JSON.stringify(metrics));
            assert.deepEqual(errors, []);
            assert.deepEqual(metrics.during, { rasterCalls: 0, photoRenders: 0, uploads: 0,
                revisionUnchanged: true, historyUnchanged: true });
            assert.equal(metrics.committed.rasterCalls, 1);
            assert.equal(metrics.committed.historySteps, 1);
            assert.equal(metrics.committed.uploads, 1, 'only changed mask uploaded on commit');
            assert.ok(Math.max(...metrics.controlTimes.slice(1)) < 1000);
            assert.ok(Math.max(...metrics.rasterTimes.slice(1)) < 1000);
            assert.ok(Math.max(...metrics.moveTimes.slice(1)) < 250);
            assert.equal(metrics.glError, 0); assert.equal(metrics.contextLost, false); assert.equal(metrics.singlePhoto, true);
            if (metrics.exported) assert.deepEqual([metrics.exported.width, metrics.exported.height], [6000, 4000]);
            await page.close();
        }
    } finally {
        await browser.close(); server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
