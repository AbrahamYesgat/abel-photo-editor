'use strict';

// Synthetic photos only. No provider calls, private photos or credentials.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createServer } = require('../server/index.js');

(async () => {
    const server = createServer({ env: { LOCAL_REVIEW_ENABLED: 'false' },
        fetch: () => { throw new Error('Unexpected inference'); } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ headless: true });
    const base = process.env.BASE_URL || `http://127.0.0.1:${server.address().port}/`;
    try {
        for (const mobile of [false, true]) {
            const context = await browser.newContext({
                viewport: { width: mobile ? 320 : 1440, height: mobile ? 844 : 1000 },
                isMobile: mobile, hasTouch: mobile
            });
            const page = await context.newPage();
            const errors = [];
            let inference = 0;
            page.on('pageerror', error => errors.push(error.message));
            await page.route('**/*', route => {
                const request = route.request(), url = new URL(request.url());
                if (url.pathname.includes('/api/review') && request.method() === 'POST') inference++;
                if (url.origin !== new URL(base).origin || url.pathname.includes('/api/')) return route.abort();
                return route.continue();
            });
            await page.goto(base);
            await page.waitForFunction(() => window.app?.review);
            assert.equal(await page.inputValue('#review-provider'), 'azure');
            await page.evaluate(async () => {
                const source = document.createElement('canvas');
                source.width = 800; source.height = 500;
                const ctx = source.getContext('2d');
                ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, 800, 500);
                const blob = await new Promise(resolve => source.toBlob(resolve));
                await app._loadFile(new File([blob], 'uniform-mask.png', { type: 'image/png' }));
                const [mask] = app.maskEngine.buildReviewMasks([{
                    name: 'Synthetic center', reason: 'Soft center; surroundings may receive spill.',
                    geometry: { type: 'radial', x: .5, y: .5, width: .3, height: .2, feather: 1, endX: 0, endY: 0 },
                    adjustments: [{ key: 'exposure', value: .5 }]
                }]);
                app.maskEngine.masks = [mask];
                app.maskEngine.activeMaskIndex = 0;
                app.maskEngine.tool = 'radial';
                app._updateMaskList(); app._pushHistory(); app._render();
            });
            const geometry = await page.evaluate(() => {
                const m = app.maskEngine.masks[0], p = m.params;
                return [[400, 250], [520, 250], [400, 300], [640, 250], [600, 330]].map(([x, y]) => {
                    const d = Math.hypot((x + .5 - p.cx) / p.rx, (y + .5 - p.cy) / p.ry);
                    return { actual: m.ctx.getImageData(x, y, 1, 1).data[0],
                        expected: Math.round(255 * Math.max(0, Math.min(1, (1 - d) / (p.feather / 100)))) };
                });
            });
            geometry.forEach(sample => assert.ok(Math.abs(sample.actual - sample.expected) <= 2,
                `ellipse/radius/linear feather matches independent reference: ${JSON.stringify(sample)}`));
            const pixels = () => page.evaluate(() => {
                const c = app._exportCanvas(), ctx = c.getContext('2d');
                const points = [[400, 250], [520, 250], [400, 300], [640, 250], [600, 330]]
                    .map(([x, y]) => ctx.getImageData(x, y, 1, 1).data[0]);
                c.width = c.height = 1;
                return points;
            });
            const original = await pixels();
            assert.ok(original[0] > original[1] && Math.abs(original[1] - original[2]) <= 2);
            assert.equal(original[3], original[4], 'outside ellipse has no exposure spill');
            await page.locator(mobile ? '.mobile-tab[data-panel=masks]' : '.vtab[data-panel=masks]').click();
            await page.locator('#mask-list .mask-item').first().click();
            await page.locator('#mask-geometry > summary').click();
            const bounds = await page.locator('#mask-geometry input').evaluateAll(inputs =>
                inputs.map(input => ({ left: input.getBoundingClientRect().left,
                    right: input.getBoundingClientRect().right, height: input.getBoundingClientRect().height })));
            bounds.forEach(b => assert.ok(b.left >= 0 && b.right <= (mobile ? 320 : 1440) && b.height >= 44));
            await page.getByRole('slider', { name: 'Mask strength', exact: true }).fill('40');
            await page.waitForTimeout(650);
            const faded = await pixels();
            assert.ok(faded[0] < original[0] && faded[0] > faded[4], 'independent strength reduces center brightness');
            for (let i = 0; i < faded.length; i++) {
                assert.ok(Math.abs(faded[i] - (original[4] + (original[i] - original[4]) * .4)) <= 2,
                    'strength is an interpolation, not an extra exposure offset');
            }
            await page.locator('#mask-geometry-rx').fill('15');
            await page.locator('#mask-geometry-rx').press('Tab');
            assert.equal(await page.evaluate(() => app.maskEngine.masks[0].params.rx), 120);
            const narrowed = await pixels();
            assert.equal(narrowed[1], narrowed[4], 'narrower ellipse removes horizontal spill');
            assert.equal(await page.evaluate(() => app.maskEngine.masks[0].params.feather), 100);
            await page.evaluate(() => app._undo());
            assert.deepEqual(await pixels(), faded, 'undo restores geometry and opacity');
            await page.evaluate(() => app._redo());
            assert.deepEqual(await pixels(), narrowed, 'redo restores refinement');
            const persistence = await page.evaluate(async () => {
                let sidecar;
                const photo = { id: 'synthetic-refinement', name: 'synthetic.png', fileHandle: {} };
                const lib = Object.create(Library.prototype);
                Object.assign(lib, { app, photos: [photo], activeIndex: 0, db: null,
                    dirHandle: { getFileHandle: async () => ({
                        createWritable: async () => ({ write: async text => { sidecar = text; }, close: async () => {} }),
                        getFile: async () => ({ text: async () => sidecar })
                    }) }
                });
                await lib._saveCurrentEdits();
                const saved = JSON.parse(sidecar).masks[0];
                app.maskEngine.masks = [];
                await lib._restoreEdits(photo);
                const restored = app.maskEngine.describeMasks()[0];
                const legacy = JSON.parse(sidecar);
                delete legacy.masks[0].opacity;
                sidecar = JSON.stringify(legacy);
                await lib._restoreEdits(photo);
                const legacyOpacity = app.maskEngine.masks[0].opacity;
                app.maskEngine.masks[0].opacity = saved.opacity;
                app._render();
                return { saved: { opacity: saved.opacity, params: saved.params },
                    restored: { opacity: restored.opacity, params: restored.params }, legacyOpacity };
            });
            assert.deepEqual(persistence.saved, persistence.restored, 'sidecar reload retains geometry and strength');
            assert.equal(persistence.legacyOpacity, 1);
            assert.deepEqual(await pixels(), narrowed, 'reload/export preserves rendered pixels');
            const allocations = await page.evaluate(() => {
                app._exitMaskMode(); app._render();
                const engine = app.glEngine, gl = engine.gl;
                const m = app.maskEngine.masks[0], snapshot = app.maskEngine.captureMasks()[0].canvas;
                let creates = 0, reads = 0, uploads = 0;
                const create = document.createElement.bind(document);
                const read = CanvasRenderingContext2D.prototype.getImageData;
                const upload = gl.texImage2D.bind(gl);
                document.createElement = (...args) => { if (args[0] === 'canvas') creates++; return create(...args); };
                CanvasRenderingContext2D.prototype.getImageData = function(...args) { reads++; return read.apply(this, args); };
                gl.texImage2D = (...args) => { uploads++; return upload(...args); };
                try {
                    for (const opacity of [.1, .6, .3, .8, .4]) {
                        m.opacity = opacity; app._render();
                        if (app.maskEngine.captureMasks()[0].canvas !== snapshot) throw new Error('Opacity copied mask pixels');
                    }
                } finally {
                    document.createElement = create;
                    CanvasRenderingContext2D.prototype.getImageData = read;
                    gl.texImage2D = upload;
                }
                return { creates, reads, uploads };
            });
            assert.deepEqual(allocations, { creates: 0, reads: 0, uploads: 0 });
            assert.equal(inference, 0);
            assert.deepEqual(errors, []);
            console.log(`${mobile ? 'Mobile 320px' : 'Desktop'}: radial reference, strength, spill, undo/redo, sidecar, native export and zero-allocation warm strength passed.`);
            await context.close();
        }
    } finally {
        await browser.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
