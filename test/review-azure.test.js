'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { mkdir, writeFile, readFile, rm } = require('node:fs/promises');
const { once } = require('node:events');
const { createServer, loadConfig } = require('../server/index.js');
const { responseSchema } = require('../server/azure.js');
const { controls, reviewCategories } = require('../js/review-contract.js');
const { azureSystemInstruction, detailInstruction } = require('../server/prompt.js');
const reviewFixture = require('./helpers/review-fixture.cjs');

const request = () => ({
    image: Buffer.from('ffd8ffc0000b080001000101011100ffda0008010100003f0000ffd9', 'hex').toString('base64'),
    adjustments: Object.fromEntries(Object.keys(controls).map(key => [key, 0])), intent: 'Preserve the mood.'
});
const result = () => reviewFixture({
    rating: 7, summary: 'A synthetic tonal study.',
    inferredIntent: { genre: 'Abstract', interpretation: 'Muted tones appear intentional.', intentionalTraits: ['Muted tones'] },
    categories: reviewCategories.map(name => ({ name, score: 7, feedback: 'The tonal relationship supports this study.' })),
    strengths: ['Clear shapes.'], improvements: [], cropFeedback: 'Keep the framing.',
    portfolioVerdict: { label: 'Borderline', reason: 'A simple tonal study.' },
    adjustments: [], adaptive: { adjustments: [], regions: [] }
});
const completion = (value = result(), overrides = {}) => ({
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value), refusal: null, tool_calls: [] }, ...overrides }]
});
const env = () => ({
    AZURE_OPENAI_ENDPOINT: 'https://abel-test.openai.azure.com/',
    AZURE_OPENAI_DEPLOYMENT: 'abel-critic', AZURE_OPENAI_MODEL: 'gpt-5.4',
    AZURE_OPENAI_API_KEY: 'synthetic-server-key', REVIEW_ACCESS_TOKEN: 'synthetic-access-token',
    LOCAL_REVIEW_ENABLED: 'false', REVIEW_RATE_LIMIT: '100'
});
async function setup(t, overrides = {}, upstream = async () => Response.json(completion())) {
    const directory = path.resolve('.azure-budget', `test-${randomUUID()}`);
    const config = { ...env(), AZURE_REVIEW_BUDGET_DIR: directory, ...overrides };
    const server = createServer({ env: config, fetch: upstream });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await rm(directory, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    return { base, directory, config, post: (body = request(), headers = {}) => fetch(`${base}/api/review/azure`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer synthetic-access-token', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body)
    }) };
}

test('Azure configuration is explicit, authenticated and limited to trusted resource origins', () => {
    assert.equal(loadConfig({}).azure.configured, false);
    assert.equal(loadConfig(env()).azure.maxTokens, 12000);
    assert.equal(loadConfig(env()).azure.monthlyLimit, 100);
    for (const endpoint of [
        'http://abel.openai.azure.com', 'https://evil.example', 'https://abel.openai.azure.com.evil.example',
        'https://user:pass@abel.openai.azure.com', 'https://abel.openai.azure.com/path',
        'https://abel.openai.azure.com/?key=x', 'https://abel.openai.azure.com/#x', 'https://abel.openai.azure.com:444'
    ]) assert.throws(() => loadConfig({ ...env(), AZURE_OPENAI_ENDPOINT: endpoint }), /AZURE_OPENAI_ENDPOINT/);
    for (const changes of [
        { REVIEW_ACCESS_TOKEN: '' }, { AZURE_OPENAI_DEPLOYMENT: '../other' }, { AZURE_OPENAI_MODEL: '' },
        { AZURE_REVIEW_MAX_COMPLETION_TOKENS: '16001' }, { AZURE_REVIEW_MONTHLY_LIMIT: '1001' }
    ]) assert.throws(() => loadConfig({ ...env(), ...changes }));
});

test('Azure schema retains closed required objects and enums, with unsupported bounds in descriptions', () => {
    function inspect(schema) {
        if (schema.type === 'object') {
            assert.equal(schema.additionalProperties, false);
            assert.deepEqual(schema.required.slice().sort(), Object.keys(schema.properties).sort());
            Object.values(schema.properties).forEach(inspect);
        }
        if (schema.items) inspect(schema.items);
    }
    inspect(responseSchema);
    assert.doesNotMatch(JSON.stringify(responseSchema), /"(minimum|maximum|minItems|maxItems|minLength|maxLength)":/);
    assert.deepEqual(responseSchema.properties.variants.properties.balanced.properties.adjustments.items.properties.key.enum, Object.keys(controls));
    assert.match(responseSchema.properties.rating.description, /maximum: 10/);
});

test('Azure status is public safe metadata and unauthorized/CORS/invalid requests never call upstream', async t => {
    let calls = 0;
    const { base, post } = await setup(t, { ALLOWED_ORIGINS: 'https://abrahamyesgat.github.io' }, async () => { calls++; throw new Error(); });
    const status = await (await fetch(`${base}/api/review/azure/status`)).json();
    assert.equal(status.provider, 'azure');
    assert.equal(status.authorized, false);
    assert.equal(status.configured, true);
    assert.equal(status.tokenRequired, true);
    assert.doesNotMatch(JSON.stringify(status), /synthetic/);
    assert.equal((await post(request(), { Authorization: '' })).status, 401);
    assert.equal((await post(request(), { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await post({ ...request(), endpoint: 'https://evil.example' })).status, 400);
    assert.equal((await post(request(), { 'Content-Type': 'text/plain' })).status, 415);
    const preflight = await fetch(`${base}/api/review/azure`, { method: 'OPTIONS', headers: {
        Origin: 'https://abrahamyesgat.github.io', 'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Authorization,Content-Type'
    } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://abrahamyesgat.github.io');
    assert.equal(calls, 0);
});

test('Azure sends one bounded vision + strict-schema request without temperature, retries or fallback', async t => {
    let calls = 0;
    const { post, directory } = await setup(t, {}, async (url, options) => {
        calls++;
        assert.equal(url, 'https://abel-test.openai.azure.com/openai/v1/chat/completions');
        assert.equal(options.redirect, 'error');
        assert.equal(options.headers['api-key'], 'synthetic-server-key');
        assert.equal(options.headers.Authorization, undefined);
        const payload = JSON.parse(options.body);
        assert.equal(payload.model, 'abel-critic');
        assert.equal(payload.max_completion_tokens, 12000);
        assert.equal(payload.reasoning_effort, 'low');
        assert.equal(payload.temperature, undefined);
        assert.equal(payload.max_tokens, undefined);
        assert.equal(payload.messages[0].content, azureSystemInstruction + detailInstruction());
        assert.equal(payload.messages[1].content[1].image_url.url, `data:image/jpeg;base64,${request().image}`);
        assert.equal(payload.messages[1].content[1].image_url.detail, 'high');
        assert.equal(payload.response_format.json_schema.strict, true);
        assert.deepEqual(payload.response_format.json_schema.schema, responseSchema);
        assert.equal(options.signal.aborted, false);
        return Response.json(completion());
    });
    assert.deepEqual(await (await post()).json(), result());
    assert.equal(calls, 1);
    const ledger = JSON.parse(await readFile(path.join(directory, `${new Date().toISOString().slice(0, 7)}.json`), 'utf8'));
    assert.equal(ledger.used, 1);
});

test('Azure rejects truncation, refusal, tools, duplicate keys and invalid runtime geometry', async t => {
    const bad = result();
    bad.adaptive.regions = [{ name: 'Unsupported', reason: 'Invalid', geometry: { type: 'radial', x: 2 }, adjustments: [] }];
    const cases = [
        [completion(result(), { finish_reason: 'length' }), 502],
        [completion(result(), { finish_reason: 'content_filter' }), 422],
        [completion(result(), { message: { refusal: 'No' } }), 422],
        [completion(result(), { message: { content: JSON.stringify(result()), tool_calls: [{ function: { name: 'x' } }] } }), 502],
        [completion(result(), { message: { content: '{"rating":7,"rating":8}' } }), 502],
        [completion(bad), 502],
        [{ choices: [] }, 502],
        [completion({ ...result(), rating: 11 }), 502],
        [completion({ ...result(), crop: {} }), 502]
    ];
    for (const [body, status] of cases) {
        const { post } = await setup(t, {}, async () => Response.json(body));
        const response = await post();
        assert.equal(response.status, status);
        assert.equal(typeof (await response.json()).error, 'string');
    }
});

test('Azure upstream errors never expose secrets or invoke a fallback', async t => {
    for (const status of [400, 401, 403, 404, 429, 500]) {
        let calls = 0;
        const { post } = await setup(t, {}, async () => { calls++; return new Response('synthetic-server-key private-provider-detail', { status }); });
        const response = await post();
        assert.equal(response.status, status === 429 ? 429 : status === 500 ? 502 : 503);
        assert.doesNotMatch(await response.text(), /synthetic-server-key|private-provider-detail/);
        assert.equal(calls, 1);
    }
});

test('Azure monthly attempts survive server recreation; failed calls are never refunded', async t => {
    let calls = 0;
    const upstream = async () => { calls++; throw new Error('network'); };
    const first = await setup(t, { AZURE_REVIEW_MONTHLY_LIMIT: '1' }, upstream);
    assert.equal((await first.post()).status, 502);
    const second = await setup(t, { AZURE_REVIEW_MONTHLY_LIMIT: '1', AZURE_REVIEW_BUDGET_DIR: first.directory }, upstream);
    const blocked = await second.post();
    assert.equal(blocked.status, 429);
    assert.equal((await blocked.json()).code, 'azure_monthly_limit');
    assert.equal(calls, 1);
});

test('Azure budget corruption and concurrent locks fail closed before dispatch', async t => {
    for (const failure of ['lock', 'corrupt']) {
        let calls = 0;
        const { post, directory } = await setup(t, {}, async () => { calls++; return Response.json(completion()); });
        await mkdir(directory, { recursive: true });
        if (failure === 'lock') await mkdir(path.join(directory, 'lock'));
        else await writeFile(path.join(directory, `${new Date().toISOString().slice(0, 7)}.json`), '{"used":-1}');
        const response = await post();
        assert.equal(response.status, 503);
        assert.equal((await response.json()).code, 'azure_budget_unavailable');
        assert.equal(calls, 0);
    }
});

test('Azure timeout aborts its request and preserves the charged attempt', async t => {
    let signal;
    const { post } = await setup(t, { AZURE_REVIEW_TIMEOUT_MS: '1000' }, async (url, options) => {
        signal = options.signal;
        return new Promise(() => {});
    });
    const response = await post();
    assert.equal(response.status, 504);
    assert.equal(signal.aborted, true);
});
