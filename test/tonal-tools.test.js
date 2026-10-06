'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const tonal = require('../js/tonal-tools.js');
const contract = require('../js/review-contract.js');
const prompt = require('../js/review-prompt.js');
const fixture = require('./fixtures/intensity-review.json');
const copy = value => JSON.parse(JSON.stringify(value));
const curves = () => Object.fromEntries(['rgb', 'r', 'g', 'b'].map(ch =>
    [ch, [{ x: 0, y: 0 }, { x: 128, y: 128 }, { x: 255, y: 255 }]]));
const policy = () => ({ allowColorGrading: true, currentColorGrading: tonal.defaults(),
    allowCurves: true, currentCurves: curves() });
function review(request = policy()) {
    const result = copy(fixture);
    for (const [intensity, variant] of Object.entries(result.variants)) {
        for (const recipe of [variant, variant.adaptive]) {
            recipe.colorGrading = [{ settings: { ...tonal.defaults(),
                shadows: { hue: 220, saturation: contract.gradeLimits[intensity] },
                highlights: { hue: 40, saturation: contract.gradeLimits[intensity] } }, reason: 'Preserve the scene with cool shadows and warm light.' }];
            recipe.curves = [{ points: request.currentCurves.rgb.map(p => ({
                x: p.x / 255, y: (p.y + (p.x === 128 ? { refine: 2, balanced: 4, expressive: 6 }[intensity] : 0)) / 255
            })), reason: 'A small midtone lift, preserving endpoints.' }];
        }
    }
    return result;
}
test('tonal reference: neutral and disabled are exact no-ops; hue wraps', () => {
    for (const c of [[0, 0, 0], [.2, .2, .2], [1, .3, .1], [1, 1, 1]]) {
        assert.deepEqual(tonal.gradePixel(c, tonal.defaults()), c);
        const g = tonal.defaults(); g.shadows.saturation = 100; g.enabled = false;
        assert.deepEqual(tonal.gradePixel(c, g), c);
    }
    assert.deepEqual(tonal.hueRGB(360), tonal.hueRGB(0));
    assert.deepEqual([...tonal.interpolate([{ x: 0, y: 0 }, { x: 255, y: 255 }])],
        Array.from({ length: 256 }, (_, i) => i));
});
test('tonal bands smoothly partition light, with balance crossover and blending', () => {
    for (let y = 0; y <= 1; y += .01) {
        const w = tonal.weights(y, 100, 0);
        assert.ok(w.every(v => v >= 0 && v <= 1));
        assert.ok(Math.abs(w.reduce((s, v) => s + v, 0) - 1) < 1e-9);
    }
    assert.ok(tonal.weights(.3, 50, 70)[0] > tonal.weights(.3, 50, -70)[0]);
    assert.ok(tonal.weights(.45, 100, 0)[0] > tonal.weights(.45, 0, 0)[0]);
    const grade = tonal.defaults();
    grade.shadows = { hue: 240, saturation: 80 };
    grade.highlights = { hue: 40, saturation: 80 };
    const dark = tonal.gradePixel([.1, .1, .1], grade), light = tonal.gradePixel([.9, .9, .9], grade);
    assert.ok(dark[2] > dark[0]); assert.ok(light[0] > light[2]);
    grade.midtones = { hue: 120, saturation: 80 };
    const mid = tonal.gradePixel([.5, .5, .5], grade);
    assert.ok(mid[1] > mid[0]);
});
test('grading preserves weighted luminance and stays in gamut, even at maximum chroma', () => {
    const grade = tonal.defaults();
    const y = c => c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
    for (const hue of [0, 30, 120, 210, 300, 360]) {
        for (const band of tonal.bands) grade[band] = { hue, saturation: 100 };
        for (const c of [[.12, .2, .34], [.98, .5, .2], [1, 0, .5], [0, 0, 0], [1, 1, 1]]) {
            const out = tonal.gradePixel(c, grade);
            assert.ok(out.every(v => v >= -1e-9 && v <= 1 + 1e-9));
            assert.ok(Math.abs(y(c) - y(out)) < 1e-9);
        }
    }
});
test('all six independently bounded tonal recipes validate; optional grammar is backwards compatible', () => {
    assert.deepEqual(contract.validateReview(review(), policy()), review());
    assert.deepEqual(contract.validateReview(fixture), fixture);
    const old = contract.schemaForRequest().properties.variants.properties.balanced.properties;
    assert.equal(old.colorGrading, undefined); assert.equal(old.curves, undefined);
    const allowed = contract.schemaForRequest(policy()).properties.variants.properties.balanced.properties;
    assert.ok(allowed.colorGrading && allowed.curves && allowed.adaptive.properties.curves);
});
test('permissions, unknown keys, duplicates and invalid baselines fail closed', () => {
    assert.throws(() => contract.validateReview(review()), /fields/);
    for (const request of [{ allowCurves: 'yes' }, { currentCurves: curves() },
        { currentColorGrading: tonal.defaults() }, { ...policy(), currentCurves: { rgb: [] } }]) {
        assert.throws(() => contract.tonalPolicy(request));
    }
    const bad = review(); bad.variants.refine.curves[0].points[1].x = NaN;
    assert.throws(() => contract.validateReview(bad, policy()), /curve input/);
    const extra = review(); extra.variants.balanced.colorGrading[0].settings.dehaze = 5;
    assert.throws(() => contract.validateReview(extra, policy()), /fields/);
    const regional = review(); regional.variants.refine.adaptive.curves[0].r = [];
    assert.throws(() => contract.validateReview(regional, policy()), /fields/);
});
test('AI saturation and hue/chroma changes are relative to the manual baseline', () => {
    const req = policy(); req.currentColorGrading.shadows = { hue: 220, saturation: 50 };
    const result = review(req);
    for (const variant of Object.values(result.variants)) for (const recipe of [variant, variant.adaptive]) {
        recipe.colorGrading[0].settings.shadows = { hue: 220, saturation: 53 };
    }
    contract.validateReview(result, req);
    result.variants.refine.colorGrading[0].settings.shadows.hue = 40;
    assert.throws(() => contract.validateReview(result, req), /bounds/);
    result.variants.refine.colorGrading[0].settings.shadows = { hue: 220, saturation: 56 };
    assert.throws(() => contract.validateReview(result, req), /bounds/);
});
test('curve guard checks endpoints, sample deviation, solarization, x gaps and point count', () => {
    for (const mutate of [
        p => { p[0].y = .01; }, p => { p[1].y = .95; },
        p => { p[1].y = 1; p[2].y = .9; }, p => { p[1].x = .01; },
        p => { p.push(...Array(6).fill({ x: 1, y: 1 })); }
    ]) {
        const result = review(); mutate(result.variants.refine.curves[0].points);
        assert.throws(() => contract.validateReview(result, policy()));
    }
    const req = policy(); req.currentCurves.rgb[1].y = 255; req.currentCurves.rgb[2].y = 120;
    const result = review(req);
    assert.throws(() => contract.validateReview(result, req));
    for (const variant of Object.values(result.variants)) for (const recipe of [variant, variant.adaptive]) recipe.curves = [];
    assert.doesNotThrow(() => contract.validateReview(result, req), 'arbitrary manual baselines may safely decline AI curves');
});
test('curve/grade strength zero preserves exact baseline including channels and disabled amounts', () => {
    const req = policy(), result = review(req).variants.balanced;
    req.currentColorGrading.enabled = false; req.currentColorGrading.shadows.saturation = 80;
    assert.deepEqual(tonal.blendGrade(req.currentColorGrading, result.colorGrading[0].settings, 0), req.currentColorGrading);
    assert.deepEqual(tonal.blendCurve(req.currentCurves.rgb, result.curves[0].points, 0), req.currentCurves.rgb);
    const partial = tonal.blendCurve(req.currentCurves.rgb, result.curves[0].points, .5);
    const a = tonal.interpolate(req.currentCurves.rgb), b = tonal.interpolate(tonal.blendCurve(req.currentCurves.rgb, result.curves[0].points, 1));
    assert.deepEqual([...tonal.interpolate(partial)], Array.from(a, (v, i) => Math.round((v + b[i]) / 2)));
});
test('every provider and manual prompt receive explicit independent tonal policies and baselines', () => {
    const text = prompt.detailInstruction(policy());
    assert.match(text, /color grading ON; curves ON/);
    assert.match(text, /universal teal\/orange/);
    assert.match(text, /only the composite RGB master/);
    assert.match(prompt.detailInstruction({}), /color grading OFF; curves OFF/);
    assert.deepEqual(prompt.requestData(policy()).currentCurves, curves());
});

const request = () => ({
    image: Buffer.from('ffd8ffc0000b080001000101011100ffda0008010100003f0000ffd9', 'hex').toString('base64'),
    adjustments: Object.fromEntries(Object.keys(contract.controls).map(key => [key, 0])),
    intent: 'Preserve the mood, consider a gentle warm/cool palette and curve.'
});
test('requests copy tonal baselines, manual import validates frozen permission and full six-recipe shape', () => {
    const manual = require('../js/review-manual.js');
    const input = { ...request(), ...policy() }, validated = contract.validateRequest(input);
    assert.deepEqual(validated, input);
    assert.notEqual(validated.currentCurves, input.currentCurves);
    assert.notEqual(validated.currentColorGrading, input.currentColorGrading);
    const json = JSON.stringify(review());
    assert.deepEqual(manual.parseResponse(json, policy()), review());
    assert.throws(() => manual.parseResponse(json, {}), /fields/);
    assert.match(manual.buildPrompt(input, 'synthetic.jpg'), /color grading ON; curves ON/);
    const missing = review(); delete missing.variants.balanced.curves;
    assert.throws(() => manual.parseResponse(JSON.stringify(missing), policy()), /fields/);
});
for (const provider of ['gemini', 'azure', 'local']) {
    test(`${provider} enforces independent tonal permissions and bounds without retry or fallback`, async t => {
        const { createServer } = require('../server/index.js');
        const { randomUUID } = require('node:crypto');
        const { rm } = require('node:fs/promises');
        const path = require('node:path');
        const directory = path.resolve('.azure-budget', `tonal-test-${randomUUID()}`);
        const inference = [];
        let result = review();
        const server = createServer({
            env: { GEMINI_API_KEY: 'synthetic-key', REVIEW_ACCESS_TOKEN: 'synthetic-token',
                REVIEW_RATE_LIMIT: '100', AZURE_OPENAI_ENDPOINT: 'https://test.openai.azure.com/',
                AZURE_OPENAI_API_KEY: 'synthetic-key', AZURE_OPENAI_DEPLOYMENT: 'test',
                AZURE_OPENAI_MODEL: 'gpt-5.5', AZURE_REVIEW_BUDGET_DIR: directory },
            fetch: async (url, options) => {
                if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'qwen3-vl:4b-instruct' }] });
                if (url.endsWith('/api/show')) return Response.json({
                    capabilities: ['completion', 'vision'], model_info: { 'general.architecture': 'qwen3vl' }
                });
                const payload = JSON.parse(options.body); inference.push(payload);
                if (provider === 'gemini') return Response.json({
                    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(result) }] } }]
                });
                if (provider === 'azure') return Response.json({
                    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }]
                });
                return Response.json({ done: true, done_reason: 'stop',
                    message: { role: 'assistant', content: JSON.stringify(result) } });
            }
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        t.after(async () => {
            server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
            await rm(directory, { recursive: true, force: true });
        });
        const post = body => fetch(`http://127.0.0.1:${server.address().port}/api/review${provider === 'gemini' ? '' : `/${provider}`}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer synthetic-token' },
            body: JSON.stringify(body)
        });
        assert.equal((await post({ ...request(), ...policy() })).status, 200);
        const payload = inference[0];
        const schema = provider === 'gemini' ? payload.generationConfig.responseJsonSchema :
            provider === 'azure' ? payload.response_format.json_schema.schema : payload.format;
        assert.ok(schema.properties.variants.properties.refine.properties.colorGrading);
        assert.ok(schema.properties.variants.properties.refine.properties.adaptive.properties.curves);
        assert.match(JSON.stringify(payload), /color grading ON; curves ON/);
        assert.equal((await post(request())).status, 502);
        result.variants.expressive.adaptive.curves[0].points[1].y = .99;
        assert.equal((await post({ ...request(), ...policy() })).status, 502);
        result = review(); result.variants.refine.colorGrading[0].settings.shadows.saturation = 6;
        assert.equal((await post({ ...request(), ...policy() })).status, 502);
        assert.equal((await post({ ...request(), allowCurves: true })).status, 400);
        assert.equal(inference.length, 4, 'one inference per valid request, never retries invalid output');
        result = copy(fixture);
        assert.equal((await post(request())).status, 200, 'old clients retain old closed response grammar');
    });
}
