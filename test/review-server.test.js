'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createServer, loadConfig, MAX_BODY_BYTES } = require('../server/index.js');
const { controls, reviewCategories } = require('../js/review-contract.js');
const { parseJSON } = require('../server/json.js');
const { geminiReviewSchema } = require('../server/schema.js');
const { systemInstruction, critiqueRubric } = require('../server/prompt.js');

const image = '/9j/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9sAQwACAgICAgIDAgIDBQMDAwUGBQUFBQYIBgYGBgYICggICAgICAoKCgoKCgoKDAwMDAwMDg4ODg4PDw8PDw8PDw8P/9sAQwECAgIEBAQHBAQHEAsJCxAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ/90ABAAB/9oADAMBAAIRAxEAPwD1yiiiv8qz/Sg//9k=';
const request = () => ({ image, adjustments: Object.fromEntries(Object.keys(controls).map(key => [key, 0])), intent: 'Keep the warm mood.' });
const result = () => ({
    rating: 8, summary: 'A warm scene with gentle contrast.',
    inferredIntent: { genre: 'Portrait', interpretation: 'Warm tones appear intended to create intimacy.', intentionalTraits: ['Warm palette'] },
    categories: reviewCategories.map(name => ({ name, score: 8, feedback: 'Warm tones support the mood.' })),
    portfolioVerdict: { label: 'Portfolio worthy', reason: 'The palette and composition support a clear intent.' },
    strengths: ['Gentle contrast.'], improvements: [], cropFeedback: 'The current framing works.',
    adjustments: [{ key: 'hslSat_1', value: -5, reason: 'Keep orange tones subtle.' }],
    adaptive: { adjustments: [], regions: [] }
});
const upstream = value => new Response(JSON.stringify({
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }]
}), { headers: { 'Content-Type': 'application/json' } });

async function setup(t, env = {}, fetchImpl = async () => upstream(result())) {
    const server = createServer({ env: { GEMINI_API_KEY: 'test-server-key', ...env }, fetch: fetchImpl });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    return {
        server, base,
        post: (body = request(), headers = {}) => fetch(`${base}/api/review`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
            body: typeof body === 'string' ? body : JSON.stringify(body)
        })
    };
}

test('configuration uses safe defaults and requires auth for non-loopback hosting', () => {
    const config = loadConfig({});
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.port, 3000);
    assert.equal(config.model, 'gemini-3.6-flash');
    for (const host of ['0.0.0.0', '::', '192.168.1.5', 'public.example.com']) {
        assert.throws(() => loadConfig({ HOST: host }), /REVIEW_ACCESS_TOKEN/);
    }
    assert.doesNotThrow(() => loadConfig({ HOST: '0.0.0.0', REVIEW_ACCESS_TOKEN: 'test-token' }));
    for (const env of [
        { ALLOWED_ORIGINS: '*' }, { ALLOWED_ORIGINS: 'https://example.com/' },
        { GEMINI_MODEL: '../models/other' }, { PORT: '0' }, { REVIEW_CONCURRENCY: '0' },
        { REVIEW_ACCESS_TOKEN: ' token ' }
    ]) assert.throws(() => loadConfig(env), Error);
});

test('provider schema preserves closed fields, enums and numeric bounds without complex size constraints', () => {
    assert.equal(geminiReviewSchema.additionalProperties, false);
    assert.equal(geminiReviewSchema.properties.rating.minimum, 0);
    assert.equal(geminiReviewSchema.properties.rating.maximum, 10);
    assert.deepEqual(geminiReviewSchema.properties.adjustments.items.properties.key.enum, Object.keys(controls));
    assert.equal(geminiReviewSchema.properties.adjustments.items.additionalProperties, false);
    assert.equal(geminiReviewSchema.properties.categories.items.additionalProperties, false);
    assert.match(geminiReviewSchema.properties.summary.description, /1200 characters/);
    assert.match(geminiReviewSchema.properties.adjustments.description, /34 items/);
    assert.doesNotMatch(JSON.stringify(geminiReviewSchema), /"(minLength|maxLength|minItems|maxItems)":/);
    const adaptive = geminiReviewSchema.properties.adaptive;
    assert.equal(adaptive.additionalProperties, false);
    assert.match(adaptive.properties.regions.description, /3 items/);
    assert.deepEqual(adaptive.properties.regions.items.properties.geometry.properties.type.enum, ['radial', 'gradient']);
});

test('cloud validates adaptive output before returning any alternative', async t => {
    const value = result();
    value.adaptive.regions = [{
        name: 'Foreground', reason: 'Subtle broad lift.',
        geometry: { type: 'radial', x: 0.5, y: 0.8, width: 0.4, height: 0.3, endX: 0, endY: 0, feather: 1 },
        adjustments: [{ key: 'exposure', value: 0.2, reason: 'Lift the foreground.' }]
    }];
    const { post } = await setup(t, {}, async () => upstream(value));
    assert.deepEqual(await (await post()).json(), value);
    for (const key of ['x', 'width', 'feather']) {
        const previous = value.adaptive.regions[0].geometry[key];
        value.adaptive.regions[0].geometry[key] = -1;
        assert.equal((await post()).status, 502);
        value.adaptive.regions[0].geometry[key] = previous;
    }
});

test('strict JSON parser rejects escaped and nested duplicate fields', () => {
    for (const value of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"outer":[{"a":1,"a":2}]}']) {
        assert.throws(() => parseJSON(value), /Duplicate/);
    }
    assert.deepEqual(parseJSON('{"a":{"x":1},"b":{"x":2},"c":"a:b{[]}"}'), { a: { x: 1 }, b: { x: 2 }, c: 'a:b{[]}' });
});

test('status discloses only configuration/model; no-key review returns no fake result', async t => {
    let calls = 0;
    const { base, post } = await setup(t, { GEMINI_API_KEY: '' }, async () => { calls++; });
    const status = await fetch(`${base}/api/review/status`);
    assert.deepEqual(await status.json(), { configured: false, model: 'gemini-3.6-flash' });
    const response = await post();
    assert.equal(response.status, 503);
    const failure = await response.json();
    assert.equal(failure.code, 'not_configured');
    assert.equal(typeof failure.error, 'string');
    assert.equal(calls, 0);
});

test('valid critique sends only fixed image/model/schema and returns validated absolute HSL targets', async t => {
    let captured;
    const { post, base } = await setup(t, {}, async (url, options) => {
        captured = { url, ...options };
        return upstream(result());
    });
    const input = request();
    input.adjustments.hslSat_1 = 10;
    const response = await post(input);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), result());
    assert.equal(captured.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent');
    assert.equal(captured.headers['x-goog-api-key'], 'test-server-key');
    assert.equal(captured.redirect, 'error');
    const payload = JSON.parse(captured.body);
    assert.equal(payload.contents[0].parts[0].inlineData.data, image);
    assert.equal(JSON.parse(payload.contents[0].parts[1].text).adjustments.hslSat_1, 10);
    assert.equal(payload.generationConfig.responseMimeType, 'application/json');
    assert.equal(payload.generationConfig.thinkingConfig, undefined, 'Do not send a Gemini 2.5 thinking budget to Gemini 3');
    assert.equal(payload.generationConfig.responseJsonSchema.additionalProperties, false);
    assert.deepEqual(payload.generationConfig.responseJsonSchema, geminiReviewSchema);
    assert.match(payload.systemInstruction.parts[0].text, /ABSOLUTE targets/);
    assert.equal(payload.systemInstruction.parts[0].text, systemInstruction);
    assert.ok(payload.systemInstruction.parts[0].text.includes(critiqueRubric));
    assert.equal(payload.systemInstruction.parts[0].text.includes(input.intent), false);
    const status = await (await fetch(`${base}/api/review/status`)).json();
    assert.deepEqual(status, { configured: true, model: 'gemini-3.6-flash' });
});

test('unauthorized and unallowed origins are rejected before invoking Gemini', async t => {
    let calls = 0;
    const { post } = await setup(t, { REVIEW_ACCESS_TOKEN: 'secret', ALLOWED_ORIGINS: 'https://allowed.example' },
        async () => { calls++; return upstream(result()); });
    for (const [headers, expected] of [
        [{}, 401],
        [{ Authorization: 'Bearer wrong' }, 401],
        [{ Authorization: 'Bearer secret', Origin: 'https://evil.example' }, 403],
        [{ Authorization: 'Bearer secret', Origin: 'null' }, 403],
        [{ Authorization: 'Bearer secret', Origin: 'https://allowed.example.evil' }, 403],
        [{ Authorization: 'Bearer secret', 'Sec-Fetch-Site': 'cross-site' }, 403]
    ]) assert.equal((await post(request(), headers)).status, expected);
    assert.equal(calls, 0);
    const response = await post(request(), { Authorization: 'Bearer secret', Origin: 'https://allowed.example' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://allowed.example');
    assert.equal(calls, 1);
});

test('CORS preflight works without bearer; invalid headers and origin are denied', async t => {
    const { base, post } = await setup(t, { REVIEW_ACCESS_TOKEN: 'secret', ALLOWED_ORIGINS: 'https://allowed.example' });
    const response = await fetch(`${base}/api/review`, {
        method: 'OPTIONS', headers: { Origin: 'https://allowed.example',
            'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' }
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://allowed.example');
    assert.match(response.headers.get('access-control-allow-headers'), /Authorization/);
    const bad = await fetch(`${base}/api/review`, { method: 'OPTIONS',
        headers: { Origin: 'https://allowed.example', 'Access-Control-Request-Headers': 'x-arbitrary' } });
    assert.equal(bad.status, 403);
    const local = await post(request(), { Origin: base, Authorization: 'Bearer secret' });
    assert.equal(local.status, 200);
    const denied = await post(request(), { Origin: 'http://rebound.example', Host: 'rebound.example', Authorization: 'Bearer secret' });
    assert.equal(denied.status, 403);
});

test('invalid requests, JSON duplicate members and oversized declared bodies never call upstream', async t => {
    let calls = 0;
    const { post, base } = await setup(t, { REVIEW_RATE_LIMIT: '100' }, async () => { calls++; return upstream(result()); });
    const invalid = [
        '{', { ...request(), model: 'gemini-arbitrary' }, { ...request(), crop: {} },
        { ...request(), image: 'data:image/jpeg;base64,abc' },
        { ...request(), adjustments: { exposure: 0 } },
        JSON.stringify(request()).replace('"intent":', '"intent":"first","intent":')
    ];
    for (const body of invalid) assert.equal((await post(body)).status, 400);
    assert.equal((await post(request(), { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await post(request(), { 'Content-Encoding': 'gzip' })).status, 415);
    const oversized = await new Promise((resolve, reject) => {
        const req = http.request(`${base}/api/review`, { method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': MAX_BODY_BYTES + 1 } }, res => {
            res.resume();
            res.on('end', () => resolve(res));
        });
        req.on('error', reject);
        req.flushHeaders();
    });
    assert.equal(oversized.statusCode, 413);
    assert.equal(calls, 0);
});

test('chunked uploads enforce the body limit without Content-Length', async t => {
    let calls = 0;
    const { base } = await setup(t, {}, async () => { calls++; });
    const response = await new Promise((resolve, reject) => {
        const req = http.request(`${base}/api/review`, { method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, res => {
            res.resume();
            res.on('end', () => resolve(res));
        });
        req.on('error', reject);
        req.end('x'.repeat(MAX_BODY_BYTES + 1));
    });
    assert.equal(response.statusCode, 413);
    assert.equal(calls, 0);
});

test('rate limiting is process-global, not bypassable with proxy/IP headers', async t => {
    let calls = 0;
    const { post } = await setup(t, { REVIEW_RATE_LIMIT: '1' }, async () => { calls++; return upstream(result()); });
    assert.equal((await post()).status, 200);
    const response = await post(request(), { 'X-Forwarded-For': '198.51.100.8' });
    assert.equal(response.status, 429);
    assert.ok(Number(response.headers.get('retry-after')) > 0);
    assert.equal((await response.json()).code, 'rate_limited');
    assert.equal(calls, 1);
});

test('concurrency is bounded and released after completion', async t => {
    let release;
    let began;
    const started = new Promise(resolve => { began = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const { post } = await setup(t, { REVIEW_CONCURRENCY: '1' }, async () => {
        began();
        await gate;
        return upstream(result());
    });
    const first = post();
    await started;
    const second = await post();
    assert.equal(second.status, 429);
    assert.equal((await second.json()).code, 'busy');
    release();
    assert.equal((await first).status, 200);
    assert.equal((await post()).status, 200);
});

test('provider timeout aborts fetch and releases the concurrency slot', async t => {
    let signal;
    let count = 0;
    const { post } = await setup(t, { REVIEW_TIMEOUT_MS: '25', REVIEW_CONCURRENCY: '1' }, async (_, options) => {
        if (++count > 1) return upstream(result());
        signal = options.signal;
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    });
    const response = await post();
    assert.equal(response.status, 504);
    assert.equal((await response.json()).code, 'review_timeout');
    assert.equal(signal.aborted, true);
    assert.equal((await post()).status, 200);
});

test('client disconnect aborts the in-flight provider request', async t => {
    let began;
    let aborted;
    const started = new Promise(resolve => { began = resolve; });
    const cancelled = new Promise(resolve => { aborted = resolve; });
    const { base } = await setup(t, {}, async (_, { signal }) => {
        began();
        return new Promise((_, reject) => signal.addEventListener('abort', () => {
            aborted();
            reject(new Error('aborted'));
        }, { once: true }));
    });
    const req = http.request(`${base}/api/review`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' } });
    req.on('error', () => {});
    req.end(JSON.stringify(request()));
    await started;
    req.destroy();
    await cancelled;
});

test('provider status errors are safe and never echo provider bodies or secrets', async t => {
    for (const [status, expected, code] of [[429, 429, 'provider_rate_limited'],
        [400, 503, 'provider_request_rejected'],
        [401, 503, 'provider_authentication'], [403, 503, 'provider_permission'],
        [404, 503, 'provider_model_unavailable'], [500, 502, 'upstream_unavailable']]) {
        await t.test(String(status), async t => {
            const { post } = await setup(t, {}, async () => new Response('test-server-key private-image provider details', { status }));
            const response = await post();
            assert.equal(response.status, expected);
            const body = await response.json();
            assert.equal(body.code, code);
            assert.equal(typeof body.error, 'string');
            if (status === 404) assert.match(body.error, /GEMINI_MODEL/);
            if (status === 401) assert.match(body.error, /GEMINI_API_KEY/);
            if (status === 403) assert.match(body.error, /permissions/);
            assert.doesNotMatch(JSON.stringify(body), /test-server-key|private-image|provider details/);
        });
    }
});

test('refusals, truncation, missing content, invalid JSON/controls and network errors are explicit', async t => {
    const cases = [
        ['refused prompt', () => Response.json({ promptFeedback: { blockReason: 'SAFETY' } }), 422, 'review_refused'],
        ['refused candidate', () => Response.json({ candidates: [{ finishReason: 'SAFETY' }] }), 422, 'review_refused'],
        ['truncated', () => Response.json({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{}' }] } }] }), 502, 'invalid_review'],
        ['missing', () => Response.json({ candidates: [] }), 502, 'invalid_review'],
        ['invalid JSON', () => new Response('not json'), 502, 'invalid_review'],
        ['crop', () => upstream({ ...result(), adjustments: [{ key: 'crop', value: 0, reason: 'Crop it.' }] }), 502, 'invalid_review'],
        ['unknown field', () => upstream({ ...result(), extra: true }), 502, 'invalid_review'],
        ['oversized output', () => new Response('x'.repeat(262145)), 502, 'invalid_review'],
        ['network', () => { throw new Error('network error test-server-key'); }, 502, 'upstream_unavailable']
    ];
    for (const [name, fetchImpl, status, code] of cases) {
        await t.test(name, async t => {
            const { post } = await setup(t, {}, fetchImpl);
            const response = await post();
            assert.equal(response.status, status);
            const body = await response.json();
            assert.equal(body.code, code);
            assert.equal(typeof body.error, 'string');
            assert.doesNotMatch(JSON.stringify(body), /test-server-key/);
        });
    }
});

test('static serving allowlists app assets and never exposes backend/env/git/test files', async t => {
    const { base } = await setup(t);
    for (const file of ['/', '/js/review-contract.js', '/js/review-prompt.js',
        '/js/review-json.js', '/js/review-manual.js', '/css/styles.css', '/manifest.json']) {
        const response = await fetch(`${base}${file}`);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    }
    for (const file of ['/.env', '/.env.example', '/server/index.js', '/package.json',
        '/.git/config', '/test/review-server.test.js', '/js/%2e%2e/server/index.js']) {
        assert.equal((await fetch(`${base}${file}`)).status, 404);
    }
    assert.equal((await fetch(`${base}/api/review`)).status, 405);
    assert.equal((await fetch(`${base}/api/unknown`)).status, 404);
    const head = await fetch(`${base}/`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
});
