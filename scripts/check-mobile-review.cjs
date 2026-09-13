// Run with PLAYWRIGHT_PATH pointing at an existing Playwright installation.
// BASE_URL can target a preview or the deployed editor; no inference/upload is used.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const origin = process.env.BASE_URL || 'http://localhost:4178/';
const baseline = process.env.CHECK_BASELINE === '1';
const digest = text => createHash('sha256').update(text).digest('hex');

(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        for (const mobile of [true, false]) {
            const context = await browser.newContext({
                viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
                isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1,
            });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.addInitScript(() => {
                window.addEventListener('pointerdown', event => { window.lastHoldPointer = event.pointerId; }, true);
                // Exercise absent pointer releases independently of real touchend delivery.
                for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
                    window.addEventListener(name, event => {
                        if (window.dropPointerRelease) event.stopImmediatePropagation();
                    }, true);
                }
                document.addEventListener('pointerup', event => {
                    if (window.blockReleaseBubble) event.stopPropagation();
                });
            });
            await page.route('**/*', route => {
                const url = new URL(route.request().url());
                if (url.origin !== new URL(origin).origin || url.pathname.includes('/api/')) return route.abort();
                if (baseline) {
                    const file = ['js/app.js', 'css/styles.css'].find(file => url.pathname.endsWith('/' + file));
                    if (file) return route.fulfill({
                        contentType: file.endsWith('.js') ? 'text/javascript' : 'text/css',
                        body: execFileSync('git', ['show', `06514df:${file}`], { encoding: 'utf8' }),
                    });
                }
                return route.continue();
            });
            await page.goto(origin);
            await page.waitForFunction(() => !!window.app?.review);
            const cdp = await context.newCDPSession(page);
            const pixels = async () => digest(await page.evaluate(() => app._renderedCanvas().toDataURL()));
            const isComparing = () => page.evaluate(() => !!(app.showingOriginal || app._comparisonState));
            const release = () => mobile
                ? cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
                : page.mouse.up();
            const press = async (point, image = false) => {
                if (mobile) await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
                else { await page.mouse.move(point.x, point.y); await page.mouse.down(); }
                await page.waitForTimeout(image ? 450 : 40);
            };
            const move = point => mobile
                ? cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point] })
                : page.mouse.move(point.x, point.y);
            for (const selection of ['global', 'adaptive']) {
                await page.evaluate(async selection => {
                    const source = document.createElement('canvas');
                    source.width = 640; source.height = 400;
                    const ctx = source.getContext('2d');
                    ctx.fillStyle = '#426d7e'; ctx.fillRect(0, 0, 640, 400);
                    ctx.fillStyle = '#a68f69'; ctx.fillRect(240, 80, 180, 280);
                    const blob = await new Promise(resolve => source.toBlob(resolve, 'image/png'));
                    await app._loadFile(new File([blob], 'synthetic.png', { type: 'image/png' }));
                    if (selection === 'adaptive') {
                        const mask = app.maskEngine.createMask('brush');
                        mask.ctx.fillStyle = 'white';
                        mask.ctx.fillRect(0, 0, mask.canvas.width * .2, mask.canvas.height);
                        mask.adjustments.exposure = -.3;
                        app.maskEngine.touch(mask);
                    }
                    app.state.temperature = 4;
                    app._pushHistory();
                    app._render();
                    const review = app.review;
                    review.context = review.snapshot();
                    review.result = ReviewContract.validateReview({
                        rating: 7, summary: 'A quiet synthetic scene.',
                        inferredIntent: { genre: 'Landscape', interpretation: 'Restrained light.', intentionalTraits: ['Muted color'] },
                        portfolioVerdict: { label: 'Borderline', reason: 'A little dark.' },
                        categories: ReviewContract.reviewCategories.map(name => ({ name, score: 7, feedback: 'Open the midtones gently. '.repeat(12) })),
                        strengths: ['Clear focal point.'], improvements: ['Lift the subject.'], cropFeedback: 'Keep framing.',
                        adjustments: [{ key: 'exposure', value: .8, reason: 'Lift.' }],
                        adaptive: { adjustments: [{ key: 'temperature', value: 18, reason: 'Warm.' }], regions: [{
                            name: 'Subject', reason: 'Soft lift.',
                            geometry: { type: 'radial', x: .5, y: .5, width: .3, height: .4, endX: 0, endY: 0, feather: 1 },
                            adjustments: [{ key: 'exposure', value: .7, reason: 'Lift.' }],
                        }] },
                    });
                    review.showResult();
                    review.selection = selection;
                    review.elements.alternative.value = selection;
                    review.showAdjustments();
                    review.updateButtons();
                }, selection);
                await page.locator(mobile ? '.mobile-tab[data-panel=review]' : '.vtab[data-panel=review]').click();
                const before = await pixels();
                await page.locator('#review-apply').click();
                const after = await pixels();
                assert.notEqual(after, before);
                const edits = await page.evaluate(() => app.review.snapshot().edits);
                const history = await page.evaluate(() => app.historyIndex);
                const layout = await page.evaluate(async () => {
                    const scroll = document.querySelector('.panels-container');
                    const bar = document.getElementById('review-apply-bar');
                    scroll.scrollTop = 0;
                    await new Promise(requestAnimationFrame);
                    const first = bar.getBoundingClientRect().top;
                    const bottom = scroll.getBoundingClientRect().bottom;
                    scroll.scrollTop = 120;
                    await new Promise(requestAnimationFrame);
                    return { first, bottom, delta: first - bar.getBoundingClientRect().top, scroll: scroll.scrollTop };
                });
                if (baseline) {
                    assert.ok(layout.first < layout.bottom, 'baseline reproduces floating bar');
                    console.log('Baseline: strength overlays feedback, scroll delta', layout.delta);
                } else {
                    assert.ok(layout.first >= layout.bottom, JSON.stringify(layout));
                    assert.equal(layout.delta, layout.scroll, 'strength moves exactly with parent scroll');
                    assert.equal(layout.scroll, 120);
                }
                await page.locator('#review-compare').scrollIntoViewIfNeeded();
                const button = await page.locator('#review-compare').boundingBox();
                const canvas = await page.locator('#main-canvas').boundingBox();
                const sidebar = await page.locator('.sidebar-right').boundingBox();
                const points = {
                    button: { x: button.x + button.width / 2, y: button.y + button.height / 2 },
                    image: { x: canvas.x + canvas.width / 2, y: Math.min(canvas.y + 35, mobile ? sidebar.y - 20 : canvas.y + 35) },
                };
                const restored = async label => {
                    assert.equal(await isComparing(), false, label);
                    assert.equal(await pixels(), after, label + ' restores composite pixels');
                    assert.deepEqual(await page.evaluate(() => ({
                        state: app._comparisonState, masks: app._comparisonMasks,
                        original: app.showingOriginal, label: document.getElementById('compare-label').hidden,
                    })), { state: null, masks: null, original: false, label: true });
                    assert.equal(await page.evaluate(() => app.review.snapshot().edits), edits);
                    assert.equal(await page.evaluate(() => app.historyIndex), history);
                };
                for (const [name, point] of Object.entries(points)) {
                    for (let repeat = 0; repeat < 3; repeat++) {
                        await press(point, name === 'image');
                        assert.equal(await isComparing(), true, name + ' starts');
                        assert.equal(await pixels(), before, name + ' displays pre-review pixels');
                        assert.equal(await page.locator('#review-compare').isDisabled(), false, 'before render keeps comparison valid');
                        await release();
                        await restored(name + ' native release');
                    }
                    if (mobile) {
                        await page.evaluate(() => { window.dropPointerRelease = true; });
                        await press(point, name === 'image');
                        assert.equal(await isComparing(), true);
                        await release();
                        if (baseline) {
                            assert.equal(await isComparing(), true, 'baseline sticks when pointer terminal events are absent');
                            console.log(`Baseline: ${selection} ${name} remains before after real touchend without pointer terminal events`);
                            await page.evaluate(() => app._stopComparison());
                        } else await restored(name + ' touch-only release');
                        await page.evaluate(() => { window.dropPointerRelease = false; });
                    }
                    if (baseline) continue;
                    await page.evaluate(() => { window.blockReleaseBubble = true; });
                    await press(point, name === 'image');
                    await release();
                    await restored(name + ' stopped bubble');
                    await page.evaluate(() => { window.blockReleaseBubble = false; });
                    await press(point, name === 'image');
                    await move({ x: 5, y: 60 });
                    await release();
                    await restored(name + ' outside/movement');
                    if (mobile) {
                        await press(point, name === 'image');
                        await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
                        await restored(name + ' touchcancel');
                        await page.evaluate(() => { window.dropPointerRelease = true; });
                        await press(point, name === 'image');
                        await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
                        await restored(name + ' touch-only cancel');
                        await page.evaluate(() => { window.dropPointerRelease = false; });
                        await press(point, name === 'image');
                        await cdp.send('Input.dispatchTouchEvent', {
                            type: 'touchStart', touchPoints: [
                                { ...point, id: 0 }, { x: point.x + 25, y: point.y, id: 1 },
                            ],
                        });
                        await release();
                        await restored(name + ' multitouch');
                    }
                    if (name === 'button') {
                        await press(point);
                        await page.evaluate(() => { document.getElementById('review-compare').disabled = true; });
                        await release();
                        await restored('disabled button release');
                    }
                    await press(point, name === 'image');
                    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
                    await release();
                    await restored(name + ' blur');
                    await press(point, name === 'image');
                    await page.evaluate(name => {
                        const el = document.getElementById(name === 'image' ? 'main-canvas' : 'review-compare');
                        if (el.hasPointerCapture(window.lastHoldPointer)) el.releasePointerCapture(window.lastHoldPointer);
                        // Chromium may not announce pending implicit touch capture until a move.
                        el.dispatchEvent(new PointerEvent('lostpointercapture', { pointerId: window.lastHoldPointer }));
                    }, name);
                    await page.waitForTimeout(30);
                    // The browser reports capture loss on the next pointer event.
                    await move({ x: point.x + 1, y: point.y });
                    await restored(name + ' lost capture');
                    await release();
                    await restored(name + ' capture lifecycle');
                }
                if (!baseline) {
                    if (mobile) {
                        const scroll = page.locator('.panels-container');
                        const barScroll = await scroll.evaluate(el => el.scrollTop);
                        await press(points.button);
                        for (let dy = 15; dy <= 60; dy += 15) {
                            await move({ x: points.button.x, y: points.button.y + dy });
                        }
                        await release();
                        await page.waitForTimeout(250);
                        assert.ok(await scroll.evaluate(el => el.scrollTop) < barScroll, 'dragging compare can scroll the drawer');
                        await restored('scrolling from compare button');
                        await scroll.evaluate(el => { el.scrollTop = 300; });
                        const bounds = await scroll.boundingBox();
                        const from = { x: bounds.x + bounds.width / 2, y: bounds.y + 180 };
                        const previousScroll = await scroll.evaluate(el => el.scrollTop);
                        await press(from);
                        for (let dy = 20; dy <= 100; dy += 20) {
                            await move({ x: from.x, y: from.y - dy });
                        }
                        await release();
                        await page.waitForTimeout(250);
                        assert.ok(await scroll.evaluate(el => el.scrollTop) > previousScroll, 'real touch scroll moves feedback');
                        assert.equal(await page.locator('.sidebar-right').evaluate(el => el.style.transform), '');
                        assert.equal(await page.locator('.sidebar-right').evaluate(el => el.classList.contains('mobile-open')), true);
                        await restored('scrolling feedback');
                    }
                    await press(points.image, false);
                    await release();
                    await page.waitForTimeout(400);
                    await restored('short tap never starts delayed comparison');
                    if (!mobile) {
                        for (const key of ['Space', 'Enter']) {
                            await page.locator('#review-compare').focus();
                            await page.keyboard.down(key);
                            assert.equal(await pixels(), before);
                            await page.keyboard.up(key);
                            await restored('keyboard button');
                        }
                        await page.locator('#main-canvas').click();
                        await page.keyboard.down('\\');
                        assert.equal(await isComparing(), true);
                        await page.keyboard.up('\\');
                        await restored('backslash');
                    }
                    await page.evaluate(() => app._undo());
                    assert.equal(await pixels(), before);
                    await page.evaluate(() => app._redo());
                    await restored('undo/redo');
                    await page.evaluate(() => app.review.invalidate('Testing original comparison without a review.'));
                    await page.waitForTimeout(100);
                    const currentCanvas = await page.locator('#main-canvas').boundingBox();
                    points.image = { x: currentCanvas.x + currentCanvas.width / 2, y: currentCanvas.y + 35 };
                    await press(points.image, true);
                    assert.equal(await page.evaluate(() => app.showingOriginal), true);
                    assert.notEqual(await pixels(), after);
                    await release();
                    await restored('original image hold');
                    for (const mode of ['mask', 'crop']) {
                        await page.evaluate(mode => {
                            if (mode === 'mask') app.maskMode = true;
                            else app.cropTool.active = true;
                        }, mode);
                        await press(points.image, true);
                        assert.equal(await isComparing(), false, mode + ' has gesture priority');
                        await release();
                        await page.evaluate(() => { app.maskMode = false; app.cropTool.active = false; });
                    }
                }
                console.log(`${mobile ? 'CDP touch' : 'Desktop'} ${selection}: layout, pixels and lifecycle verified`);
            }
            assert.deepEqual(errors, []);
            await context.close();
        }
    } finally {
        await browser.close();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
