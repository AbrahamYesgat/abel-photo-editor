'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { rm } = require('node:fs/promises');
const contract = require('../js/review-contract.js');
const prompt = require('../js/review-prompt.js');
const manual = require('../js/review-manual.js');
const { createServer } = require('../server/index.js');
const fixture = require('./helpers/detail-fixture.cjs');
const policy = { allowDetails: true, detailAdjustments: { clarity: 20 } };
const request = () => ({
    image: Buffer.from('ffd8ffc0000b080001000101011100ffda0008010100003f0000ffd9', 'hex').toString('base64'),
    adjustments: Object.fromEntries(Object.keys(contract.controls).map(key => [key, 0])),
    intent: 'Preserve intentional blur and haze.'
});

test('detail permission is explicit, closed, finite, backwards compatible and separate from lighting controls', () => {
    assert.equal(Object.keys(contract.controls).length, 34);
    assert.equal(Object.keys(contract.maskControls).length, 7);
    assert.deepEqual(Object.keys(contract.detailControls), ['clarity']);
    assert.deepEqual(contract.validateRequest(request()), request());
    assert.deepEqual(contract.validateRequest({ ...request(), allowDetails: false }), { ...request(), allowDetails: false });
    const input = { ...request(), ...policy };
    const output = contract.validateRequest(input);
    assert.deepEqual(output, input);
    assert.notEqual(output.detailAdjustments, input.detailAdjustments);
    for (const bad of [
        { allowDetails: 'true' }, { allowDetails: 1 }, { allowDetails: null },
        { allowDetails: true }, { detailAdjustments: { clarity: 0 } },
        { allowDetails: false, detailAdjustments: { clarity: 0 } },
        { allowDetails: true, detailAdjustments: { clarity: 0, texture: 1 } },
        ...[null, '20', NaN, Infinity, 100.1, -100.1].map(clarity => ({ allowDetails: true, detailAdjustments: { clarity } }))
    ]) assert.throws(() => contract.validateRequest({ ...request(), ...bad }));
});

test('all six recipes require opt-in, absolute global clarity limits and regional overlap budgets', () => {
    const value = fixture();
    assert.deepEqual(contract.validateReview(value, policy), value);
    for (const off of [undefined, {}, { allowDetails: false }]) {
        assert.throws(() => contract.validateReview(value, off), /Unknown adjustment/);
    }
    for (const intensity of contract.intensities) {
        for (const location of ['global', 'adaptive', 'region']) {
            const isolated = structuredClone(require('./fixtures/intensity-review.json'));
            const variant = isolated.variants[intensity];
            if (location === 'region') variant.adaptive.regions = fixture().variants[intensity].adaptive.regions;
            else {
                const changes = [{ key: 'clarity', value: 20, reason: 'Unauthorized even at baseline.' }];
                if (location === 'global') variant.adjustments = changes;
                else variant.adaptive.adjustments = changes;
            }
            assert.throws(() => contract.validateReview(isolated), /Unknown adjustment/);
        }
        const limit = contract.detailLimits[intensity];
        for (const mode of ['global', 'adaptive']) {
            for (const target of [20 - limit, 20 + limit]) {
                const data = fixture();
                const changes = mode === 'global' ? data.variants[intensity].adjustments : data.variants[intensity].adaptive.adjustments;
                changes.find(change => change.key === 'clarity').value = target;
                assert.doesNotThrow(() => contract.validateReview(data, policy));
                changes.find(change => change.key === 'clarity').value = target + (target > 20 ? 0.01 : -0.01);
                assert.throws(() => contract.validateReview(data, policy), /adjustment value/);
            }
        }
        const data = fixture();
        const regions = data.variants[intensity].adaptive.regions;
        regions[0].adjustments[0].value = limit / 2;
        regions.push({ ...structuredClone(regions[0]), name: 'Second', adjustments: [
            { key: 'clarity', value: -limit / 2, reason: 'Opposite sign still consumes budget.' }
        ] });
        assert.doesNotThrow(() => contract.validateReview(data, policy));
        regions[1].adjustments[0].value -= 0.01;
        assert.throws(() => contract.validateReview(data, policy), /Combined regional clarity/);
    }
    for (const key of ['texture', 'dehaze', 'sharpening', 'noiseReduction', 'grain', 'vignette', 'curves']) {
        const value = fixture();
        value.variants.balanced.adjustments[1].key = key;
        assert.throws(() => contract.validateReview(value, policy), /Unknown adjustment/);
    }
    for (const baseline of [-100, 100]) {
        const data = fixture(baseline);
        for (const variant of Object.values(data.variants)) {
            for (const changes of [variant.adjustments, variant.adaptive.adjustments]) {
                changes.find(change => change.key === 'clarity').value = baseline;
            }
        }
        const edgePolicy = { allowDetails: true, detailAdjustments: { clarity: baseline } };
        assert.doesNotThrow(() => contract.validateReview(data, edgePolicy));
        data.variants.refine.adjustments[1].value = baseline * 1.001;
        assert.throws(() => contract.validateReview(data, edgePolicy), /adjustment value/);
    }
});

test('conditional schemas never widen default controls and manual import/quote repair use frozen policy', () => {
    const enums = schema => {
        const variant = schema.properties.variants.properties.balanced.properties;
        return [variant.adjustments, variant.adaptive.properties.adjustments,
            variant.adaptive.properties.regions.items.properties.adjustments].map(node => node.items.properties.key.enum);
    };
    for (const keys of enums(contract.reviewSchema)) assert.ok(!keys.includes('clarity'));
    for (const keys of enums(contract.schemaForRequest(policy))) {
        assert.ok(keys.includes('clarity'));
        assert.ok(!keys.includes('texture'));
    }
    assert.match(prompt.detailInstruction(), /OFF.*Never propose clarity/);
    assert.match(prompt.detailInstruction(policy), /lighting\/color treatment MUST stand alone/);
    assert.match(prompt.detailInstruction(policy), /uncertainty means OMIT clarity/);
    const text = manual.buildPrompt({ ...request(), ...policy }, 'preview.jpg');
    assert.match(text, /TRUSTED DETAIL POLICY: ON/);
    assert.match(text, /"allowDetails": true/);
    assert.match(manual.buildPrompt(request(), 'preview.jpg'), /TRUSTED DETAIL POLICY: OFF/);
    const json = JSON.stringify(fixture());
    assert.throws(() => manual.parseResponse(json), /Unknown adjustment/);
    assert.deepEqual(manual.parseResponse(json, policy), fixture());
    const smart = json.replace(/"([^"]*)"/g, '“$1”');
    assert.throws(() => manual.repairSmartQuotes(smart), /Unknown adjustment/);
    assert.deepEqual(manual.repairSmartQuotes(smart, policy).review, fixture());
    assert.throws(() => manual.parseResponse(json, { allowDetails: true, detailAdjustments: { clarity: 0 } }));
});

for (const provider of ['gemini', 'azure', 'local']) {
    test(`${provider} schema/prompt and runtime validation enforce detail consent with no fallback`, async t => {
        const directory = path.resolve('.azure-budget', `detail-test-${randomUUID()}`);
        let result = fixture();
        const inference = [];
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
                const body = JSON.parse(options.body);
                inference.push({ url, body });
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
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
            await rm(directory, { recursive: true, force: true });
        });
        const post = body => fetch(`http://127.0.0.1:${server.address().port}/api/review${provider === 'gemini' ? '' : `/${provider}`}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer synthetic-token' },
            body: JSON.stringify(body)
        });
        assert.equal((await post({ ...request(), ...policy })).status, 200);
        assert.equal(inference.length, 1);
        const payload = inference[0].body;
        const schema = provider === 'gemini' ? payload.generationConfig.responseJsonSchema :
            provider === 'azure' ? payload.response_format.json_schema.schema : payload.format;
        assert.ok(schema.properties.variants.properties.refine.properties.adjustments.items.properties.key.enum.includes('clarity'));
        assert.match(JSON.stringify(payload), /TRUSTED DETAIL POLICY: ON/);
        assert.equal((await post(request())).status, 502, 'omission never authorizes details');
        assert.equal((await post({ ...request(), allowDetails: false })).status, 502);
        assert.match(JSON.stringify(inference.at(-1).body), /TRUSTED DETAIL POLICY: OFF/);
        result.variants.expressive.adjustments[1].value = 36;
        assert.equal((await post({ ...request(), ...policy })).status, 502, 'late variant cannot bypass limits');
        result = fixture();
        result.variants.balanced.adaptive.regions[0].adjustments[0].value = 11;
        assert.equal((await post({ ...request(), ...policy })).status, 502);
        const count = inference.length;
        assert.equal((await post({ ...request(), allowDetails: true })).status, 400);
        assert.equal(inference.length, count);
        assert.equal(count, 5, 'one inference per valid request, including rejected output; never retry');
    });
}
