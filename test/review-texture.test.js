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
const fixture = require('./helpers/texture-fixture.cjs');
const policy = { allowTexture: true, textureAdjustments: { texture: 20 } };
const request = () => ({
    image: Buffer.from('ffd8ffc0000b080001000101011100ffda0008010100003f0000ffd9', 'hex').toString('base64'),
    adjustments: Object.fromEntries(Object.keys(contract.controls).map(key => [key, 0])),
    intent: 'Keep intentional fog and softness.'
});

test('texture permission is independent, explicit, closed and backwards compatible', () => {
    for (const clarity of [{}, { allowDetails: false }, { allowDetails: true, detailAdjustments: { clarity: 0 } }]) {
        const input = { ...request(), ...clarity, ...policy };
        const output = contract.validateRequest(input);
        assert.deepEqual(output, input);
        assert.notEqual(output.textureAdjustments, input.textureAdjustments);
        assert.deepEqual(contract.validateReview(fixture(), input), fixture());
        for (const texture of [{}, { allowTexture: false }]) {
            assert.throws(() => contract.validateReview(fixture(), { ...clarity, ...texture }), /Unknown adjustment/);
        }
    }
    for (const bad of [
        { allowTexture: 'true' }, { allowTexture: null }, { allowTexture: 1 }, { allowTexture: true },
        { textureAdjustments: { texture: 0 } }, { allowTexture: false, textureAdjustments: { texture: 0 } },
        { allowTexture: true, textureAdjustments: { texture: 0, clarity: 0 } },
        ...[NaN, Infinity, null, '0', -101, 101].map(texture => ({ allowTexture: true, textureAdjustments: { texture } }))
    ]) assert.throws(() => contract.validateRequest({ ...request(), ...bad }));
    const clarity = require('./helpers/detail-fixture.cjs')();
    assert.throws(() => contract.validateReview(clarity, policy), /Unknown adjustment/);
});

test('texture bounds apply to every recipe and absolute overlapping regional offsets', () => {
    for (const intensity of contract.intensities) {
        const limit = contract.detailLimits[intensity];
        for (const mode of ['global', 'adaptive']) {
            for (const sign of [-1, 1]) {
                const value = fixture();
                const changes = mode === 'global' ? value.variants[intensity].adjustments : value.variants[intensity].adaptive.adjustments;
                const change = changes.find(item => item.key === 'texture');
                change.value = 20 + sign * limit;
                assert.doesNotThrow(() => contract.validateReview(value, policy));
                change.value += sign * .01;
                assert.throws(() => contract.validateReview(value, policy), /adjustment value/);
            }
        }
        const value = fixture();
        const regions = value.variants[intensity].adaptive.regions;
        regions[0].adjustments[0].value = limit / 2;
        regions.push({ ...structuredClone(regions[0]), name: 'Overlapping texture', adjustments: [
            { key: 'texture', value: -limit / 2, reason: 'Opposite sign still counts.' }
        ] });
        assert.doesNotThrow(() => contract.validateReview(value, policy));
        regions[1].adjustments[0].value -= .01;
        assert.throws(() => contract.validateReview(value, policy), /Combined regional texture/);
    }
    for (const texture of [-100, 100]) {
        const allowed = contract.globalControls('expressive', { allowTexture: true, textureAdjustments: { texture } }).texture;
        assert.ok(allowed.min >= -100 && allowed.max <= 100);
    }
});

test('texture schemas and manual quote repair use only frozen explicit permissions', () => {
    const keys = request => {
        const variant = contract.schemaForRequest(request).properties.variants.properties.balanced.properties;
        return [variant.adjustments, variant.adaptive.properties.adjustments,
            variant.adaptive.properties.regions.items.properties.adjustments].map(node => node.items.properties.key.enum);
    };
    for (const list of keys({})) assert.ok(!list.includes('texture'));
    for (const list of keys(policy)) {
        assert.ok(list.includes('texture'));
        assert.ok(!list.includes('clarity'));
    }
    const text = manual.buildPrompt({ ...request(), ...policy }, 'preview.jpg');
    assert.match(text, /TRUSTED TEXTURE POLICY: ON/);
    assert.match(text, /uncertainty means OMIT texture/);
    assert.match(text, /6000 output tokens/);
    assert.match(prompt.detailInstruction(), /TRUSTED TEXTURE POLICY: OFF/);
    const json = JSON.stringify(fixture()), smart = json.replace(/"([^"]*)"/g, '“$1”');
    assert.deepEqual(manual.parseResponse(json, policy), fixture());
    assert.deepEqual(manual.repairSmartQuotes(smart, policy).review, fixture());
    assert.throws(() => manual.repairSmartQuotes(smart), /Unknown adjustment/);
    assert.throws(() => manual.parseResponse(json, { ...policy, textureAdjustments: { texture: -20 } }));
});

for (const provider of ['azure', 'gemini', 'local']) {
    test(`${provider} passes texture policy to inference and validates without retries`, async t => {
        const directory = path.resolve('.azure-budget', `texture-test-${randomUUID()}`);
        const calls = [];
        let result = fixture();
        const server = createServer({
            env: { GEMINI_API_KEY: 'synthetic', REVIEW_ACCESS_TOKEN: 'synthetic-token', REVIEW_RATE_LIMIT: '100',
                AZURE_OPENAI_ENDPOINT: 'https://test.openai.azure.com/', AZURE_OPENAI_API_KEY: 'synthetic',
                AZURE_OPENAI_DEPLOYMENT: 'test', AZURE_OPENAI_MODEL: 'gpt-5.5', AZURE_REVIEW_BUDGET_DIR: directory },
            fetch: async (url, options) => {
                if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'qwen3-vl:4b-instruct' }] });
                if (url.endsWith('/api/show')) return Response.json({
                    capabilities: ['completion', 'vision'], model_info: { 'general.architecture': 'qwen3vl' }
                });
                calls.push(JSON.parse(options.body));
                const text = JSON.stringify(result);
                if (provider === 'gemini') return Response.json({ candidates: [
                    { finishReason: 'STOP', content: { parts: [{ text }] } }
                ] });
                if (provider === 'azure') return Response.json({ choices: [
                    { finish_reason: 'stop', message: { content: text } }
                ] });
                return Response.json({ done: true, done_reason: 'stop', message: { role: 'assistant', content: text } });
            }
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        t.after(async () => {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
            await rm(directory, { recursive: true, force: true });
        });
        const post = body => fetch(`http://127.0.0.1:${server.address().port}/api/review${provider === 'gemini' ? '' : '/' + provider}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer synthetic-token' },
            body: JSON.stringify(body)
        });
        assert.equal((await post({ ...request(), ...policy })).status, 200);
        const payload = calls[0];
        const schema = provider === 'gemini' ? payload.generationConfig.responseJsonSchema :
            provider === 'azure' ? payload.response_format.json_schema.schema : payload.format;
        assert.ok(schema.properties.variants.properties.refine.properties.adjustments.items.properties.key.enum.includes('texture'));
        assert.match(JSON.stringify(payload), /TRUSTED TEXTURE POLICY: ON/);
        assert.equal((await post(request())).status, 502);
        assert.equal((await post({ ...request(), allowTexture: false })).status, 502);
        result.variants.expressive.adjustments[1].value = 36;
        assert.equal((await post({ ...request(), ...policy })).status, 502);
        assert.equal((await post({ ...request(), allowTexture: true })).status, 400);
        assert.equal(calls.length, 4, 'invalid permission never dispatches; no retries');
    });
}
