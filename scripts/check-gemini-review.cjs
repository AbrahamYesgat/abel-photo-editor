'use strict';

// Uses an already-installed Playwright; never calls Google, Azure, Ollama or an external website.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createServer } = require('../server/index.js');
const contract = require('../js/review-contract.js');
const provider = process.env.REVIEW_PROVIDER || 'gemini';
assert.ok(['gemini', 'azure'].includes(provider), 'REVIEW_PROVIDER must be gemini or azure');
const apiPath = `/api/review${provider === 'azure' ? '/azure' : ''}`;
const model = provider === 'azure' ? 'gpt-5.4' : 'gemini-3.6-flash';

const region = {
    name: 'Upper image-right patch',
    reason: 'Lift the visible dark green patch in the upper right; may spill into nearby gray.',
    geometry: { type: 'radial', x: 0.75, y: 0.25, width: 0.12, height: 0.15, endX: 0, endY: 0, feather: 1 },
    adjustments: [{ key: 'exposure', value: 0.6, reason: 'Improve readability of this patch.' }],
};
const result = require('../test/helpers/review-fixture.cjs')({
    rating: 7, summary: 'Synthetic region-localization fixture.',
    inferredIntent: { genre: 'Abstract', interpretation: 'The blocks appear intended to study tonal separation.', intentionalTraits: ['Muted palette'] },
    categories: contract.reviewCategories.map(name => ({ name, score: 7, feedback: 'The upper image-right green patch contrasts with the gray field.' })),
    strengths: ['Clear tonal separation.'], improvements: ['Gently lift the upper image-right patch.'],
    cropFeedback: 'Keep the framing.', portfolioVerdict: { label: 'Borderline', reason: 'A simple tonal study.' },
    adjustments: [{ key: 'exposure', value: 0.3, reason: 'Optional whole-image lift.' }],
    adaptive: { adjustments: [], regions: [region] },
});

async function run() {
    const server = createServer({ env: { GEMINI_API_KEY: '', LOCAL_REVIEW_ENABLED: 'false' },
        fetch: () => { throw new Error('Unexpected provider call'); } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
            const context = await browser.newContext({ viewport, hasTouch: viewport.width < 500 });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            let reviews = 0, checks = 0;
            await page.route('**/*', async route => {
                const request = route.request();
                if (!request.url().startsWith(`${base}/`)) return route.abort();
                if (request.url().endsWith(`${apiPath}/status`)) {
                    checks++;
                    assert.equal(request.postData(), null);
                    return route.fulfill({ json: { configured: true, model, provider, authorized: true, tokenRequired: false } });
                }
                if (request.url().endsWith(apiPath)) {
                    reviews++;
                    contract.validateRequest(request.postDataJSON());
                    return route.fulfill({ json: result });
                }
                return route.continue();
            });
            await page.goto(base);
            await page.waitForFunction(() => window.app?.review);
            assert.equal(await page.inputValue('#review-endpoint'), base);
            assert.equal(await page.isChecked('#review-consent'), false);
            assert.equal(await page.inputValue('#review-gemini-mode'), 'global');
            assert.equal(reviews + checks, 0, 'initialization does not contact a backend or provider');
            await page.evaluate(async () => {
                const canvas = document.createElement('canvas');
                canvas.width = 800; canvas.height = 500;
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = '#606060'; ctx.fillRect(0, 0, 800, 500);
                ctx.fillStyle = '#506450'; ctx.fillRect(512, 60, 176, 140);
                const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
                await app._loadFile(new File([blob], 'synthetic-region.png', { type: 'image/png' }));
            });
            await page.locator(viewport.width < 500 ? '.mobile-tab[data-panel="review"]' : '.vtab[data-panel="review"]').click();
            if (provider === 'azure') {
                await page.selectOption('#review-provider', 'azure');
                assert.equal(await page.inputValue('#review-endpoint'), 'https://abel-review-66c1d915.azurewebsites.net');
                await page.locator('#review-connection').evaluate(node => { node.open = true; });
                await page.fill('#review-endpoint', base);
                assert.equal(await page.isChecked('#review-consent'), false);
                assert.equal(await page.inputValue('#review-token'), '');
                assert.match(await page.textContent('#review-consent-text'), /Microsoft Azure/);
                assert.equal(reviews + checks, 0, 'switching to Azure does not contact a provider');
            }
            await page.locator('#review-connection').evaluate(node => { node.open = true; });
            await page.check('#review-remember-gemini');
            await page.click('#review-check-gemini');
            await page.waitForFunction(model => document.getElementById('review-provider-badge').textContent === model, model);
            assert.equal(checks, 1);
            assert.equal(reviews, 0);
            assert.equal(await page.isChecked('#review-consent'), false);
            await page.locator('#review-connection').evaluate(node => { node.open = false; });
            await page.selectOption('#review-gemini-mode', 'adaptive');
            await page.check('#review-consent');
            const pixels = () => page.evaluate(() => {
                const source = app._renderedCanvas();
                const canvas = document.createElement('canvas');
                canvas.width = source.width; canvas.height = source.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(source, 0, 0);
                return [[0.75, 0.25], [0.25, 0.75], [0.75, 0.75]].map(([x, y]) =>
                    [...ctx.getImageData(Math.floor(x * canvas.width), Math.floor(y * canvas.height), 1, 1).data]);
            });
            const before = await pixels();
            await page.click('#review-analyze');
            await page.waitForFunction(() => app.review.canCompare());
            assert.equal(reviews, 1);
            assert.equal(await page.locator('#review-apply').isVisible(), false, 'no redundant Apply button');
            assert.equal(await page.locator('.review-region-map').count(), 1);
            assert.equal(await page.evaluate(() => app.state.exposure), 0, 'Global alternative not stacked');
            const after = await pixels();
            assert.ok(after[0][1] > before[0][1] + 5, 'upper-right target receives a real visible pixel change');
            for (const index of [1, 2]) assert.deepEqual(after[index], before[index], 'other regions are unchanged');
            await page.evaluate(() => app._startComparison(true));
            assert.deepEqual(await pixels(), before);
            await page.evaluate(() => app._stopComparison());
            assert.deepEqual(await pixels(), after);
            await page.click('#review-undo');
            assert.deepEqual(await pixels(), before);
            assert.equal(await page.evaluate(() => app.maskEngine.masks.length), 0);

            // Cropped previews are a new top-left coordinate frame, with no old-image offset.
            await page.evaluate(() => {
                app.cropTool.cropX = 0.25; app.cropTool.cropY = 0.1;
                app.cropTool.cropW = 0.5; app.cropTool.cropH = 0.7;
                app.cropTool.apply();
            });
            await page.waitForFunction(() => app.imageWidth === 400 && app.imageHeight === 350);
            await page.locator(viewport.width < 500 ? '.mobile-tab[data-panel="review"]' : '.vtab[data-panel="review"]').click();
            await page.check('#review-consent');
            await page.click('#review-analyze');
            await page.waitForFunction(() => app.review.canCompare());
            const cropped = await page.evaluate(() => {
                const mask = app.maskEngine.masks[0];
                return { width: mask.canvas.width, height: mask.canvas.height, ...mask.params };
            });
            assert.equal(cropped.cx, 300);
            assert.equal(cropped.cy, 87.5);
            assert.equal(cropped.rx, 48);
            assert.equal(cropped.ry, 52.5);

            const mapping = await page.evaluate(region => {
                return [[800, 500], [400, 700], [9000, 3000], [3000, 9000], [321, 197]].map(([imageWidth, imageHeight]) => {
                    const engine = new MaskEngine({ imageWidth, imageHeight });
                    const mask = engine.buildReviewMasks([region])[0];
                    const w = mask.canvas.width, h = mask.canvas.height, g = region.geometry;
                    const sample = (x, y) => mask.ctx.getImageData(Math.floor(x * w), Math.floor(y * h), 1, 1).data[0];
                    const radial = [sample(g.x, g.y), sample(g.x + g.width / 2, g.y),
                        sample(g.x, g.y + g.height / 2), sample(g.x - g.width - 0.02, g.y), sample(g.x, 0.75)];
                    const gradient = engine.buildReviewMasks([{ ...region, geometry: {
                        type: 'gradient', x: 0, y: 0.4, endX: 0, endY: 0.8, width: 0, height: 0, feather: 1,
                    } }])[0];
                    const grad = y => gradient.ctx.getImageData(Math.floor(w / 2), Math.floor(y * h), 1, 1).data[0];
                    return { size: [w, h], radial, gradient: [grad(0.2), grad(0.6), grad(0.9)] };
                });
            }, region);
            for (const sample of mapping) {
                assert.ok(Math.max(...sample.size) <= 4096);
                assert.ok(sample.radial[0] >= 243);
                for (const half of sample.radial.slice(1, 3)) assert.ok(half > 115 && half < 140, JSON.stringify(sample));
                assert.deepEqual(sample.radial.slice(3), [0, 0]);
                assert.equal(sample.gradient[0], 0);
                assert.ok(sample.gradient[1] >= 125 && sample.gradient[1] <= 130);
                assert.equal(sample.gradient[2], 255);
            }
            await page.reload();
            await page.waitForFunction(() => window.app?.review);
            if (provider === 'azure') {
                assert.equal(await page.inputValue('#review-endpoint'), base, 'Azure endpoint never fills Gemini fields');
                await page.evaluate(() => {
                    app.review.elements.provider.value = 'azure';
                    app.review.changeProvider();
                });
            }
            assert.equal(await page.inputValue('#review-endpoint'), `${base}${apiPath}`);
            assert.equal(await page.isChecked('#review-consent'), false);
            assert.equal(reviews, 2);
            assert.equal(checks, 1, 'restoring a connection does not silently contact it');
            assert.deepEqual(errors, []);
            console.log(`${provider} ${viewport.width}px: defaults, privacy, one-click pixels, region maps, crop, cap, undo and compare passed`);
            await context.close();
        }
    } finally {
        await browser?.close();
        await new Promise(resolve => server.close(resolve));
    }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
