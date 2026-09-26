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
        const page = await browser.newPage({
            viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
            isMobile: mobile, hasTouch: mobile,
        });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(process.env.BASE_URL || `http://127.0.0.1:${server.address().port}/`);
        await page.waitForFunction(() => window.app?.review);
        const metrics = await page.evaluate(async ({ mobile, skipExport, nightTools }) => {
            const source = document.createElement('canvas');
            source.width = 6000; source.height = 4000;
            const ctx = source.getContext('2d');
            const gradient = ctx.createLinearGradient(0, 0, 6000, 4000);
            gradient.addColorStop(0, '#273f59'); gradient.addColorStop(1, '#b99f78');
            ctx.fillStyle = gradient; ctx.fillRect(0, 0, 6000, 4000);
            const blob = await new Promise(resolve => source.toBlob(resolve));
            source.width = source.height = 1;
            await app._loadFile(new File([blob], 'large.png', { type: 'image/png' }));
            if (nightTools) app._setNight({ noiseLuma: 60, noiseColor: 70,
                motionAmount: 60, motionLength: 8, motionAngle: 20 });
            for (let i = 0; i < 6; i++) {
                const mask = app.maskEngine.createMask('radial');
                app.maskEngine.createRadialMask(mask.canvas.width * (i + 1) / 7,
                    mask.canvas.height / 2, mask.canvas.width / 4, mask.canvas.height / 2, 80);
                mask.adjustments.exposure = (i % 2 ? -.2 : .3);
                if (i > 2) mask.blend = 'additive';
            }
            const times = [];
            for (let i = 0; i < 5; i++) {
                app.maskEngine.getActiveMask().adjustments.exposure = i / 10;
                const start = performance.now();
                app._render();
                // Include GPU completion rather than timing command submission alone.
                app.glEngine.gl.readPixels(0, 0, 1, 1, app.glEngine.gl.RGBA,
                    app.glEngine.gl.UNSIGNED_BYTE, new Uint8Array(4));
                times.push(Math.round((performance.now() - start) * 10) / 10);
                await new Promise(requestAnimationFrame);
            }
            const latency = [];
            app.maskMode = true;
            app.showMaskOverlay = true;
            for (let i = 0; i < 5; i++) {
                const start = performance.now();
                app._onSliderChange('mask_exposure', .13 + i * .017, 'mask');
                await new Promise(requestAnimationFrame);
                app.glEngine.gl.readPixels(0, 0, 1, 1, app.glEngine.gl.RGBA,
                    app.glEngine.gl.UNSIGNED_BYTE, new Uint8Array(4));
                latency.push(Math.round((performance.now() - start) * 10) / 10);
            }
            const brushLatency = [];
            app.maskEngine.getActiveMask().type = 'brush';
            app.maskEngine.tool = 'brush';
            const box = app.glEngine.canvas.getBoundingClientRect();
            const point = i => ({ clientX: box.x + box.width * (.3 + i * .025), clientY: box.y + box.height * .5 });
            app._canvasPointerDown(point(0));
            for (let i = 1; i <= 5; i++) {
                const start = performance.now();
                app._canvasPointerMove(point(i));
                await new Promise(requestAnimationFrame);
                app.glEngine.gl.readPixels(0, 0, 1, 1, app.glEngine.gl.RGBA,
                    app.glEngine.gl.UNSIGNED_BYTE, new Uint8Array(4));
                brushLatency.push(Math.round((performance.now() - start) * 10) / 10);
            }
            app._canvasPointerUp();
            app.maskMode = false;
            app.showMaskOverlay = false;
            let exported = null;
            if (!mobile && !skipExport) {
                const start = performance.now();
                const canvas = nightTools ? await app._exportCanvasAsync() : app._exportCanvas();
                exported = { width: canvas.width, height: canvas.height,
                    milliseconds: Math.round(performance.now() - start) };
                canvas.width = canvas.height = 1;
            }
            app._render();
            return { mobile, nightTools, times, latency, brushLatency, exported, render: [app.glEngine.canvas.width, app.glEngine.canvas.height],
                masks: app.maskEngine.masks.map(mask => [mask.canvas.width, mask.canvas.height]),
                composite: !!document.getElementById('composite-overlay'),
                glError: app.glEngine.gl.getError(), contextLost: app.glEngine.gl.isContextLost() };
        }, { mobile, skipExport: !!process.env.SKIP_EXPORT, nightTools: !!process.env.NIGHT_TOOLS });
        console.log(JSON.stringify(metrics));
        assert.deepEqual(errors, []);
        assert.equal(metrics.glError, 0);
        assert.equal(metrics.contextLost, false);
        assert.ok(Math.max(...metrics.render) <= 1600);
        assert.equal(metrics.composite, false);
        if (!mobile && !process.env.SKIP_EXPORT) {
            assert.equal(metrics.exported.width, 6000);
            assert.equal(metrics.exported.height, 4000);
        }
        await page.close();
      }
    } finally {
        await browser.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
