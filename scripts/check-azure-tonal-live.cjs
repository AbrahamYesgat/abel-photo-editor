'use strict';
// Explicitly opt in: ONE paid synthetic request through the existing hosted budget guard.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const contract = require('../js/review-contract.js');
const tonal = require('../js/tonal-tools.js');

(async () => {
    if (process.env.RUN_LIVE_AZURE !== '1') throw new Error('Set RUN_LIVE_AZURE=1 to authorize one live synthetic review.');
    const settings = JSON.parse(fs.readFileSync('.env.azure-hosted', 'utf8'));
    const base = 'https://abel-review-66c1d915.azurewebsites.net';
    const browser = await chromium.launch({ headless: true });
    let image;
    try {
        const page = await browser.newPage();
        image = await page.evaluate(() => {
            const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 320;
            const ctx = canvas.getContext('2d');
            const gradient = ctx.createLinearGradient(0, 320, 480, 0);
            gradient.addColorStop(0, '#202b38'); gradient.addColorStop(.5, '#747776');
            gradient.addColorStop(1, '#e0c9a3');
            ctx.fillStyle = gradient; ctx.fillRect(0, 0, 480, 320);
            ctx.fillStyle = '#515b60'; ctx.fillRect(65, 160, 90, 90);
            ctx.fillStyle = '#c0b7a5'; ctx.fillRect(300, 60, 85, 85);
            return canvas.toDataURL('image/jpeg', .88).split(',')[1];
        });
    } finally { await browser.close(); }
    const request = {
        image, adjustments: Object.fromEntries(Object.keys(contract.controls).map(key => [key, 0])),
        intent: 'An intentional abstract tonal study: preserve the quiet geometric mood. Consider subtle cool shadows, warm highlights and a very gentle midtone curve where useful, without forcing changes or neutralizing the existing palette.',
        allowColorGrading: true, currentColorGrading: tonal.defaults(), allowCurves: true,
        currentCurves: Object.fromEntries(['rgb', 'r', 'g', 'b'].map(ch =>
            [ch, [{ x: 0, y: 0 }, { x: 255, y: 255 }]]))
    };
    contract.validateRequest(request);
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.REVIEW_ACCESS_TOKEN}` };
    const before = await (await fetch(`${base}/api/review/azure/status`, { headers })).json();
    assert.equal(before.authorized, true);
    const started = Date.now();
    const response = await fetch(`${base}/api/review/azure`, {
        method: 'POST', headers, body: JSON.stringify(request), signal: AbortSignal.timeout(135000)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`Live review failed (${response.status}): ${data.code || data.error || 'unknown error'}`);
    const result = contract.validateReview(data, request);
    const counts = Object.fromEntries(Object.entries(result.variants).map(([key, variant]) => [key,
        [variant, variant.adaptive].map(recipe => ({ grade: recipe.colorGrading.length, curve: recipe.curves.length }))]));
    fs.mkdirSync('.azure-tools', { recursive: true });
    fs.writeFileSync('.azure-tools/tonal-live-result.json', JSON.stringify(result, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ validated: true, milliseconds: Date.now() - started, recipes: counts,
        note: 'One live synthetic review; empty suggestions are valid. Not a photo-quality evaluation.' }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
