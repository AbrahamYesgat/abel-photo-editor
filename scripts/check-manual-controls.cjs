'use strict';

// Synthetic photo, real WebGL and UI. No model requests or model downloads.
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
            const page = await browser.newPage({
                viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
                isMobile: mobile, hasTouch: mobile
            });
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.route('**/*', route => {
                const url = new URL(route.request().url());
                if (url.origin !== new URL(base).origin || url.pathname.includes('/api/')) return route.abort();
                return route.continue();
            });
            await page.goto(base);
            await page.waitForFunction(() => window.app?.review);
            const pixels = await page.evaluate(async () => {
                const check = (condition, message) => { if (!condition) throw new Error(message); };
                const source = document.createElement('canvas');
                source.width = 768; source.height = 384;
                const ctx = source.getContext('2d');
                const image = ctx.createImageData(768, 384);
                for (let y = 0; y < 384; y++) for (let x = 0; x < 768; x++) {
                    const i = (y * 768 + x) * 4;
                    const l = 20 + (y / 383) * 218 + Math.sin(x * .55) * 9;
                    image.data.set([l, l * .92, l * .85, 255], i);
                }
                ctx.putImageData(image, 0, 0);
                const blob = await new Promise(resolve => source.toBlob(resolve));
                await app._loadFile(new File([blob], 'manual-fixture.png', { type: 'image/png' }));
                source.width = source.height = 1;
                const read = canvas => {
                    const c = document.createElement('canvas'); c.width = canvas.width; c.height = canvas.height;
                    c.getContext('2d').drawImage(canvas, 0, 0);
                    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
                    c.width = c.height = 1;
                    return data;
                };
                const render = () => { app._render(); return read(app.glEngine.canvas); };
                const diff = (a, b, side) => {
                    let max = 0, sum = 0;
                    for (let y = 0; y < 384; y++) for (let x = 0; x < 768; x++) {
                        if (side === 'inside' && x >= 380 || side === 'outside' && x <= 390) continue;
                        for (let c = 0; c < 3; c++) {
                            const i = (y * 768 + x) * 4 + c, d = Math.abs(a[i] - b[i]);
                            max = Math.max(max, d); sum += d;
                        }
                    }
                    return { max, sum };
                };
                const neutral = render(), checks = {};
                for (const [key, c] of Object.entries(ManualControls.controls)) {
                    check(app.sliders[key] && app.sliders[`mask_${key}`], `${key} global and local UI`);
                    const value = key === 'exposure' ? .7 : key === 'whites' ? -75 : 75;
                    app.state[key] = value;
                    const global = render();
                    check(diff(neutral, global).max > 0, `${key} changes global pixels`);
                    app.state[key] = 0;
                    const mask = app.maskEngine.createMask('brush');
                    mask.ctx.fillStyle = 'white'; mask.ctx.fillRect(0, 0, 384, 384);
                    app.maskEngine.touch(mask);
                    mask.adjustments[key] = value;
                    const local = render();
                    const inside = diff(neutral, local, 'inside'), outside = diff(neutral, local, 'outside');
                    check(inside.max > 0, `${key} changes selected pixels`);
                    check(outside.max === 0, `${key} preserves outside pixels`);
                    check(diff(global, local, 'inside').max <= 1, `${key} local/global processing matches`);
                    mask.opacity = 0;
                    check(diff(neutral, render()).max === 0, `${key} zero strength is exact`);
                    app.maskEngine.masks = [];
                    checks[key] = inside.max;
                }
                // Tonal selection is distinct from whole-image contrast.
                for (const [key, bright] of [['whites', true], ['blacks', false]]) {
                    app.state[key] = -75;
                    const result = render();
                    let dark = 0, light = 0;
                    for (let x = 0; x < 768; x++) for (let c = 0; c < 3; c++) {
                        dark += Math.abs(result[(20 * 768 + x) * 4 + c] - neutral[(20 * 768 + x) * 4 + c]);
                        light += Math.abs(result[(370 * 768 + x) * 4 + c] - neutral[(370 * 768 + x) * 4 + c]);
                    }
                    check(bright ? light > dark : dark > light, `${key} selects the intended tonal range`);
                    app.state[key] = 0;
                }
                app.state.dehaze = 75; const clear = render();
                app.state.dehaze = -75; const haze = render();
                const mean = a => a.reduce((sum, v, i) => sum + (i % 4 === 3 ? 0 : v), 0);
                check(mean(clear) < mean(neutral) && mean(haze) > mean(neutral), 'dehaze removes/adds the RGB veil');
                app.state.dehaze = 0;
                const first = app.maskEngine.createMask('brush');
                first.ctx.fillStyle = 'white'; first.ctx.fillRect(0, 0, 384, 384); app.maskEngine.touch(first);
                first.name = 'Sky'; first.detection = { kind: 'sky', version: 1 };
                Object.assign(first.adjustments, { whites: -42, blacks: 33, vibrance: 40, dehaze: 23,
                    sharpenAmount: 45, clarity: 15, texture: 25 });
                first.opacity = .7;
                app._updateMaskList(); app._pushHistory();
                const edited = render(), selected = app.maskEngine.describeMasks()[0];
                app._resetMaskAdjustments();
                check(Object.values(first.adjustments).every(v => v === 0), 'reset zeros every adjustment');
                check(first.opacity === .7 && first.detection.kind === 'sky', 'reset preserves strength and detection');
                check(diff(neutral, render()).max === 0, 'reset returns exact global pixels');
                app._undo();
                check(diff(edited, read(app.glEngine.canvas)).max === 0, 'undo reset restores exact pixels');
                check(app.sliders.mask_dehaze.input.value === '23', 'undo syncs hidden/new controls');
                app._redo();
                check(diff(neutral, read(app.glEngine.canvas)).max === 0, 'redo reset restores exact pixels');
                app._undo();
                // Exercise the actual Library serialization and migration path.
                let saved;
                const originalDB = library.db;
                library.photos = [{ id: 'synthetic-manual', name: 'manual-fixture.png' }];
                library.activeIndex = 0;
                library.db = { transaction: () => ({ objectStore: () => ({ put: value => { saved = value; } }) }) };
                await library._saveCurrentEdits();
                library.db = originalDB;
                await library._restoreEdits(library.photos[0], saved);
                check(app.maskEngine.getActiveMask().adjustments.dehaze === selected.adjustments.dehaze, 'Library retains dehaze');
                check(diff(edited, render()).max === 0, 'Library retains all mask pixels and adjustments');
                const exported = app._exportCanvas();
                const exportDifference = diff(edited, read(exported));
                check(exportDifference.max <= 2, `native/tiled export: ${JSON.stringify(exportDifference)}`);
                check(exported.width === 768 && exported.height === 384, 'native export dimensions');
                exported.width = exported.height = 1;
                const second = app.maskEngine.createMask('brush');
                second.adjustments.dehaze = -31;
                app._updateMaskList(); app._syncMaskSliders();
                check(app.sliders.mask_dehaze.input.value === '-31', 'second mask sync');
                app.maskEngine.activeMaskIndex = 0; app._updateMaskList(); app._syncMaskSliders();
                check(app.sliders.mask_dehaze.input.value === '23', 'first mask retains its controls');
                app.maskMode = false; app.showMaskOverlay = false;
                document.getElementById('mask-adjustments').style.display = 'block';
                window.manualBeforeUI = read(app.glEngine.canvas);
                return { controls: checks, exportMax: exportDifference.max };
            });
            await page.locator(mobile ? '.mobile-tab[data-panel="masks"]' : '.vtab[data-panel="masks"]').click();
            // Actual focus, keyboard and scrolling, including the last group on phones.
            for (const key of ['whites', 'blacks', 'vibrance', 'dehaze', 'sharpenAmount']) {
                const input = page.locator(`#slider-mask_${key}`);
                await input.scrollIntoViewIfNeeded();
                assert.ok(await input.isVisible(), `${key} visible on ${mobile ? 'mobile' : 'desktop'}`);
                await input.focus(); await input.press('ArrowRight');
            }
            const value = page.locator('#slider-mask_dehaze').locator('..').locator('input[type=number]');
            await value.fill('37'); await value.press('Enter');
            assert.equal(await page.evaluate(() => app.maskEngine.getActiveMask().adjustments.dehaze), 37);
            await value.fill('900'); await value.press('Enter');
            assert.equal(await value.inputValue(), '100');
            await value.fill(''); await value.press('Tab');
            assert.equal(await value.inputValue(), '100');
            await value.fill('18'); await value.press('Enter');
            await page.evaluate(() => app._undo());
            assert.equal(await value.inputValue(), '100', 'numeric commit undoes to previous value');
            await page.evaluate(() => app._redo());
            assert.equal(await value.inputValue(), '18', 'redo updates numeric field');
            assert.deepEqual(errors, []);
            console.log(JSON.stringify({ mobile, ...pixels, ui: 'all new controls accessible; numeric/reset/history/save/export pass' }));
            await page.close();
        }
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
