'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createServer, loadConfig, MAX_BODY_BYTES } = require('../server/index.js');
const { isLoopback } = require('../server/local.js');
const { controls, reviewSchema, reviewCategories } = require('../js/review-contract.js');
const { systemInstruction } = require('../server/prompt.js');

const image = '/9j/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9sAQwACAgICAgIDAgIDBQMDAwUGBQUFBQYIBgYGBgYICggICAgICAoKCgoKCgoKDAwMDAwMDg4ODg4PDw8PDw8PDw8P/9sAQwECAgIEBAQHBAQHEAsJCxAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ/90ABAAB/9oADAMBAAIRAxEAPwD1yiiiv8qz/Sg//9k=';
const request = () => ({ image, adjustments: Object.fromEntries(Object.keys(controls).map(key => [key, 0])), intent: 'Keep the warm mood.' });
const result = () => ({
    rating: 8, summary: 'Warm window light separates the subject from the darker wall.',
    inferredIntent: { genre: 'Portrait', interpretation: 'The light appears intended to separate the subject.', intentionalTraits: ['Dark background'] },
    categories: reviewCategories.map(name => ({ name, score: 8, feedback: 'The window light gives the subject definition.' })),
    portfolioVerdict: { label: 'Portfolio worthy', reason: 'The directional light supports the mood.' },
    strengths: ['Directional light.'], improvements: [], cropFeedback: 'Keep the space around the subject.',
    adjustments: [{ key: 'hslSat_1', value: -5, reason: 'Reduce orange dominance in the highlights.' }],
    adaptive: { adjustments: [], regions: [] }
});
const model = 'qwen3-vl:4b-instruct';
const tags = () => ({ models: [{ name: model, model }] });
const show = () => ({ capabilities: ['completion', 'vision'], model_info: { 'general.architecture': 'qwen3vl' } });
const chat = () => ({ done: true, done_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(result()) } });
const mock = async url => Response.json(url.endsWith('/api/tags') ? tags() : url.endsWith('/api/show') ? show() : chat());

test('local validates soft adaptive masks using the same contract, with no cloud fallback', async t => {
    const value = result();
    value.adaptive.regions = [{
        name: 'Lower light', reason: 'Soft lower-image lift.',
        geometry: { type: 'gradient', x: 0, y: 0, width: 0, height: 0, endX: 0, endY: 1, feather: 1 },
        adjustments: [{ key: 'shadows', value: 10, reason: 'Open the lower tones.' }]
    }];
    const { post, calls } = await setup(t, {}, async url => Response.json(
        url.endsWith('/api/tags') ? tags() : url.endsWith('/api/show') ? show() :
            { ...chat(), message: { role: 'assistant', content: JSON.stringify(value) } }
    ));
    assert.deepEqual(await (await post()).json(), value);
    value.adaptive.regions[0].adjustments[0].key = 'clarity';
    assert.equal((await post()).status, 502);
    assert.ok(calls.every(call => call.url.startsWith('http://127.0.0.1:11434/')));
    const request = JSON.parse(calls.find(call => call.url.endsWith('/api/chat')).body);
    assert.deepEqual(request.format.properties.adaptive, reviewSchema.properties.adaptive);
    assert.equal(request.messages[0].content, systemInstruction);
});

async function setup(t, env = {}, fetchImpl = mock, host = '127.0.0.1') {
    const calls = [];
    const server = createServer({ env, fetch: async (url, options) => {
        calls.push({ url, ...options });
        return fetchImpl(url, options);
    } });
    server.listen(0, host);
    await once(server, 'listening');
    t.after(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    return { server, base, calls,
        status: (headers = {}) => fetch(`${base}/api/review/local/status`, { headers }),
        post: (body = request(), headers = {}) => fetch(`${base}/api/review/local`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
            body: typeof body === 'string' ? body : JSON.stringify(body)
        }) };
}

test('local config defaults, allowlist, public opt-out and mapped loopback normalization', () => {
    assert.equal(loadConfig({}).localEnabled, true);
    assert.equal(loadConfig({}).localModel, model);
    assert.equal(loadConfig({}).localTimeoutMs, 600000);
    assert.equal(loadConfig({ HOST: '0.0.0.0', REVIEW_ACCESS_TOKEN: 'cloud' }).localEnabled, false);
    assert.equal(loadConfig({ LOCAL_REVIEW_ENABLED: 'false' }).localEnabled, false);
    for (const size of ['2b', '4b', '8b', '30b', '32b']) {
        assert.equal(loadConfig({ QWEN_MODEL: `qwen3-vl:${size}` }).localModel, `qwen3-vl:${size}`);
        assert.equal(loadConfig({ QWEN_MODEL: `qwen3-vl:${size}-instruct` }).localModel, `qwen3-vl:${size}-instruct`);
    }
    for (const env of [
        { HOST: '0.0.0.0', REVIEW_ACCESS_TOKEN: 'cloud', LOCAL_REVIEW_ENABLED: 'true' },
        { LOCAL_REVIEW_ENABLED: '1' }, { QWEN_MODEL: 'qwen3-vl:cloud' },
        { QWEN_MODEL: 'qwen3-vl:4b-cloud' }, { QWEN_MODEL: 'qwen3-vl:2b-instruct-cloud' }, { QWEN_MODEL: 'other' },
        { QWEN_MODEL: 'https://other/model' }, { QWEN_MODEL: 'qwen3-vl' },
        { LOCAL_REVIEW_TIMEOUT_MS: '900001' }, { LOCAL_REVIEW_TIMEOUT_MS: '0' },
        { LOCAL_REVIEW_ACCESS_TOKEN: ' bad ' }
    ]) assert.throws(() => loadConfig(env));
    for (const host of ['localhost', '127.0.0.1', '127.99.1.1', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
        assert.equal(isLoopback(host), true, host);
    }
    for (const host of ['127.999.0.1', '127.evil', '0.0.0.0', '::', '::ffff:192.168.1.2', '192.168.1.2']) {
        assert.equal(isLoopback(host), false, host);
    }
});

test('local status is exact and live; no Google key is needed', async t => {
    const { status, calls, base } = await setup(t);
    assert.deepEqual(await (await status()).json(), { provider: 'ollama', model, ready: true, localOnly: true });
    assert.deepEqual(calls.map(call => call.url), ['http://127.0.0.1:11434/api/tags', 'http://127.0.0.1:11434/api/show']);
    assert.deepEqual(await (await fetch(`${base}/api/review/status`)).json(), { configured: false, model: 'gemini-3.6-flash' });
    await status();
    assert.equal(calls.length, 4, 'Status checks installed model every time');
});

test('allowlisted MoE Qwen3-VL uses the configured installed model', async t => {
    const selected = 'qwen3-vl:30b';
    const { status, calls } = await setup(t, { QWEN_MODEL: selected }, async url => Response.json(
        url.endsWith('/api/tags') ? { models: [{ name: selected, model: selected }] }
            : { ...show(), model_info: { 'general.architecture': 'qwen3vlmoe' } }));
    assert.deepEqual(await (await status()).json(), { provider: 'ollama', model: selected, ready: true, localOnly: true });
    assert.deepEqual(JSON.parse(calls[1].body), { model: selected });
});

test('local review uses full contract and rubric with fixed image-only Ollama transport, never cloud credentials', async t => {
    const { post, calls } = await setup(t, {
        GEMINI_API_KEY: 'google-private-key', REVIEW_ACCESS_TOKEN: 'cloud-private-token',
        OLLAMA_HOST: 'https://evil.example', OLLAMA_URL: 'https://evil.example'
    });
    const response = await post();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), result());
    assert.equal(calls.length, 3);
    for (const call of calls) {
        assert.ok(call.url.startsWith('http://127.0.0.1:11434/api/'));
        assert.equal(call.redirect, 'error');
        assert.deepEqual(call.headers, { 'Content-Type': 'application/json' });
        assert.doesNotMatch(JSON.stringify(call), /google-private-key|cloud-private-token|evil\.example|generativelanguage/);
    }
    const payload = JSON.parse(calls[2].body);
    assert.equal(payload.model, model);
    assert.equal(payload.stream, true);
    assert.equal(payload.think, false);
    assert.deepEqual(payload.format, reviewSchema);
    assert.deepEqual(payload.options, { temperature: 0.2, num_ctx: 8192, num_predict: 4096 });
    assert.deepEqual(payload.messages, [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: JSON.stringify({ adjustments: request().adjustments, intent: request().intent }), images: [image] }
    ]);
    assert.equal(payload.tools, undefined);
});

test('local routes disabled on public config, actual public bind, or explicit opt-out, ignoring proxy headers', async t => {
    for (const [env, host] of [
        [{ HOST: '0.0.0.0', REVIEW_ACCESS_TOKEN: 'cloud' }, '127.0.0.1'],
        [{}, '0.0.0.0'], [{ LOCAL_REVIEW_ENABLED: 'false' }, '127.0.0.1']
    ]) {
        const { status, post, calls } = await setup(t, env, mock, host);
        for (const response of [await status({ 'X-Forwarded-For': '127.0.0.1' }), await post()]) {
            assert.equal(response.status, 403);
            assert.equal((await response.json()).code, 'local_disabled');
        }
        assert.equal(calls.length, 0);
    }
});

test('local NDJSON response is assembled across byte boundaries before applying strict validation', async t => {
    const expected = { ...result(), summary: 'Warm caf\u00e9 light.' };
    const content = JSON.stringify(expected);
    const middle = Math.floor(content.length / 2);
    const encoded = new TextEncoder().encode([
        { done: false, message: { role: 'assistant', content: content.slice(0, middle) } },
        { done: false, message: { role: 'assistant', content: content.slice(middle) } },
        { done: true, done_reason: 'stop', message: { role: 'assistant', content: '' } }
    ].map(value => JSON.stringify(value)).join('\n') + '\n');
    const { post } = await setup(t, {}, async url => {
        if (!url.endsWith('/api/chat')) return mock(url);
        return new Response(new ReadableStream({
            start(controller) {
                for (let i = 0; i < encoded.length; i += 3) controller.enqueue(encoded.slice(i, i + 3));
                controller.close();
            }
        }), { headers: { 'Content-Type': 'application/x-ndjson' } });
    });
    assert.deepEqual(await (await post()).json(), expected);
});

test('local streaming rejects missing completion, trailing data, tools and truncated generations', async t => {
    const part = { done: false, message: { role: 'assistant', content: JSON.stringify(result()) } };
    const end = { done: true, done_reason: 'stop', message: { role: 'assistant', content: '' } };
    for (const frames of [
        [part],
        [part, end, part],
        [part, { ...end, done_reason: 'length' }],
        [{ ...part, message: { ...part.message, tool_calls: [{ function: { name: 'crop' } }] } }, end],
        [{ ...part, message: { ...part.message, content: '{"rating":8,"rating":9}' } }, end]
    ]) {
        const { post } = await setup(t, {}, async url => url.endsWith('/api/chat')
            ? new Response(frames.map(frame => JSON.stringify(frame)).join('\n')) : mock(url));
        const response = await post();
        assert.equal(response.status, 502);
        assert.equal((await response.json()).code, 'invalid_review');
    }
});

test('local transport timeouts are not mislabeled as a missing Ollama service', async t => {
    const { status } = await setup(t, {}, async () => {
        throw new TypeError('fetch failed', { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } });
    });
    const response = await status();
    assert.equal(response.status, 504);
    assert.equal((await response.json()).code, 'local_timeout');
});

test('non-loopback requester socket is denied even when forwarding headers claim loopback', async t => {
    const { server, status, calls } = await setup(t);
    server.prependListener('request', req => {
        Object.defineProperty(req.socket, 'remoteAddress', { value: '::ffff:192.168.1.2', configurable: true });
    });
    const response = await status({ 'X-Forwarded-For': '127.0.0.1', Forwarded: 'for=127.0.0.1' });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'local_disabled');
    assert.equal(calls.length, 0);
});

test('all cross-origin local calls require configured separate token, including status', async t => {
    const origin = 'https://photos.example';
    const without = await setup(t, { ALLOWED_ORIGINS: `${origin},http://localhost:8080` });
    for (const Origin of [origin, 'http://localhost:8080']) {
        for (const response of [await without.status({ Origin }), await without.post(request(), { Origin })]) {
            assert.equal(response.status, 401);
            assert.equal((await response.json()).code, 'local_token_required');
        }
    }
    assert.equal(without.calls.length, 0);
    assert.equal((await without.status({ Origin: without.base })).status, 200);
    assert.equal((await without.post(request(), { Origin: without.base.replace('127.0.0.1', 'localhost') })).status, 200);
    const withToken = await setup(t, { ALLOWED_ORIGINS: origin, LOCAL_REVIEW_ACCESS_TOKEN: 'local-secret', REVIEW_ACCESS_TOKEN: 'cloud-secret' });
    for (const Authorization of ['', 'Bearer wrong', 'Bearer cloud-secret']) {
        for (const response of [
            await withToken.status({ Origin: origin, Authorization }),
            await withToken.post(request(), { Origin: origin, Authorization })
        ]) {
            assert.equal(response.status, 401);
            assert.deepEqual(await response.json(), { code: 'local_unauthorized', error: 'A valid local review access token is required.' });
        }
    }
    assert.equal(withToken.calls.length, 0);
    assert.equal((await withToken.status()).status, 401, 'Configured local token also protects no-Origin requests');
    assert.equal((await withToken.status({ 'Sec-Fetch-Site': 'same-origin' })).status, 200,
        'Browser same-origin GET status may omit Origin');
    assert.equal((await withToken.status({ 'Sec-Fetch-Site': 'same-site' })).status, 401,
        'Same-site is not same-origin');
    for (const Origin of [withToken.base, withToken.base.replace('127.0.0.1', 'localhost')]) {
        assert.equal((await withToken.status({ Origin })).status, 200, 'Trusted companion origin does not need the configured token');
        assert.equal((await withToken.post(request(), { Origin })).status, 200);
    }
    for (const response of [
        await withToken.status({ Origin: origin, Authorization: 'Bearer local-secret' }),
        await withToken.post(request(), { Origin: origin, Authorization: 'Bearer local-secret' })
    ]) {
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('access-control-allow-origin'), origin);
    }
    assert.doesNotMatch(JSON.stringify(withToken.calls), /local-secret|cloud-secret/);
});

test('configured local token remains required on another allowed loopback port', async t => {
    const Origin = 'http://localhost:8080';
    const { status, post, calls } = await setup(t, {
        ALLOWED_ORIGINS: Origin, LOCAL_REVIEW_ACCESS_TOKEN: 'local-secret'
    });
    for (const response of [await status({ Origin }), await post(request(), { Origin }),
        await status({ Origin, 'Sec-Fetch-Site': 'same-origin' })]) {
        assert.equal(response.status, 401);
        assert.equal((await response.json()).code, 'local_unauthorized');
    }
    assert.equal(calls.length, 0);
    assert.equal((await status({ Origin, Authorization: 'Bearer local-secret' })).status, 200);
});

test('unexpected origins and spoofed host/forwarding headers are rejected before local work', async t => {
    const { status, calls } = await setup(t, { ALLOWED_ORIGINS: 'https://photos.example' });
    for (const headers of [
        { Origin: 'https://photos.example.evil' }, { Origin: 'null' },
        { Origin: 'http://rebound.example', Host: 'rebound.example', 'X-Forwarded-Host': 'localhost' },
        { 'Sec-Fetch-Site': 'cross-site', 'X-Forwarded-For': '127.0.0.1' },
        { Origin: 'http://localhost:8080' }
    ]) {
        const response = await status(headers);
        assert.equal(response.status, 403);
        assert.equal((await response.json()).code, 'origin_denied');
    }
    assert.equal(calls.length, 0);
});

test('permitted local PNA preflights work without bearer; cloud and denied origins never receive PNA opt-in', async t => {
    const { base, calls } = await setup(t, { ALLOWED_ORIGINS: 'https://photos.example', LOCAL_REVIEW_ACCESS_TOKEN: 'local-secret' });
    const headers = { Origin: 'https://photos.example', 'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type', 'Access-Control-Request-Private-Network': 'true' };
    for (const path of ['/api/review/local', '/api/review/local/status']) {
        const response = await fetch(base + path, { method: 'OPTIONS', headers });
        assert.equal(response.status, 204);
        assert.equal(response.headers.get('access-control-allow-private-network'), 'true');
        assert.equal(response.headers.get('access-control-allow-origin'), headers.Origin);
    }
    const cloud = await fetch(`${base}/api/review`, { method: 'OPTIONS', headers });
    assert.equal(cloud.status, 204);
    assert.equal(cloud.headers.get('access-control-allow-private-network'), null);
    for (const extra of [
        { Origin: 'https://evil.example' }, { 'Access-Control-Request-Headers': 'x-evil' },
        { 'Access-Control-Request-Method': 'DELETE' }
    ]) {
        const response = await fetch(`${base}/api/review/local`, { method: 'OPTIONS', headers: { ...headers, ...extra } });
        assert.equal(response.status, 403);
        assert.equal(response.headers.get('access-control-allow-private-network'), null);
    }
    const noOrigin = await fetch(`${base}/api/review/local`, { method: 'OPTIONS',
        headers: { 'Access-Control-Request-Private-Network': 'true' } });
    assert.equal(noOrigin.headers.get('access-control-allow-private-network'), null);
    assert.equal(calls.length, 0);
});

test('missing runtime/model, remote aliases and non-vision metadata fail safely before image transmission', async t => {
    const cases = [
        ['offline', () => { throw new Error('private-image google-private-key'); }, 'local_unavailable'],
        ['runtime error', () => new Response('private-image google-private-key', { status: 500 }), 'local_runtime_error'],
        ['missing model', async () => Response.json({ models: [] }), 'local_model_missing'],
        ['missing show', async url => url.endsWith('/api/tags') ? Response.json(tags()) : new Response('secret', { status: 404 }), 'local_model_missing'],
        ['malformed tags', async () => new Response('not JSON'), 'local_model_invalid'],
        ['oversized metadata', async () => new Response('x'.repeat(262145)), 'local_model_invalid'],
        ['missing vision', async url => Response.json(url.endsWith('/api/tags') ? tags() : { capabilities: ['completion'] }), 'local_model_no_vision'],
        ['missing capabilities', async url => Response.json(url.endsWith('/api/tags') ? tags() : {}), 'local_model_invalid'],
        ['different architecture alias', async url => Response.json(url.endsWith('/api/tags') ? tags() : { ...show(), model_info: { 'general.architecture': 'llama' } }), 'local_model_invalid'],
        ['remote tags', async url => Response.json(url.endsWith('/api/tags') ? { models: [{ name: model, remote_host: 'https://ollama.com' }] } : show()), 'local_model_remote'],
        ['remote show', async url => Response.json(url.endsWith('/api/tags') ? tags() : { ...show(), remote_model: 'qwen3-vl:cloud' }), 'local_model_remote'],
        ['nested remote metadata', async url => Response.json(url.endsWith('/api/tags') ? tags() : { ...show(), details: { remote_host: 'https://ollama.com' } }), 'local_model_remote'],
        ['alias', async url => Response.json(url.endsWith('/api/tags') ? { models: [{ name: model, model: 'other-cloud' }] } : show()), 'local_model_remote'],
        ['cloud modelfile', async url => Response.json(url.endsWith('/api/tags') ? tags() : { ...show(), modelfile: 'FROM qwen3-vl:235b-cloud\n' }), 'local_model_remote']
    ];
    for (const [name, fetchImpl, code] of cases) await t.test(name, async t => {
        const { post, status, calls } = await setup(t, { GEMINI_API_KEY: 'google-private-key' }, fetchImpl);
        for (const response of [await status(), await post()]) {
            assert.equal(response.status, 503);
            const body = await response.json();
            assert.deepEqual(Object.keys(body).sort(), ['code', 'error']);
            assert.equal(body.code, code);
            assert.doesNotMatch(body.error, /private-image|google-private-key/);
            if (code === 'local_model_missing') assert.ok(body.error.includes(`ollama pull ${model}`));
            if (code === 'local_unavailable') assert.match(body.error, /Start Ollama/);
        }
        assert.ok(calls.every(call => !call.url.endsWith('/api/chat')));
        assert.ok(calls.every(call => call.url.startsWith('http://127.0.0.1:11434/')));
    });
});

test('refusal, truncation, invalid JSON, duplicate keys, unsupported controls and tools never become reviews', async t => {
    const cases = [
        ['refusal', { ...chat(), message: { refusal: 'private-image' } }, 422],
        ['done false', { ...chat(), done: false }],
        ['length', { ...chat(), done_reason: 'length' }],
        ['missing finish', { message: chat().message }],
        ['tools', { ...chat(), message: { ...chat().message, tool_calls: [{ function: { name: 'crop' } }] } }],
        ['function', { ...chat(), message: { ...chat().message, function_call: {} } }],
        ['role', { ...chat(), message: { ...chat().message, role: 'tool' } }],
        ['invalid JSON', { ...chat(), message: { role: 'assistant', content: '```json\n{}\n```' } }],
        ['duplicates', { ...chat(), message: { role: 'assistant', content: '{"rating":1,"rating":8}' } }],
        ['crop', { ...chat(), message: { role: 'assistant', content: JSON.stringify({ ...result(), adjustments: [{ key: 'crop', value: 1, reason: 'crop' }] }) } }],
        ['unknown field', { ...chat(), message: { role: 'assistant', content: JSON.stringify({ ...result(), extra: true }) } }],
        ['invalid range', { ...chat(), message: { role: 'assistant', content: JSON.stringify({ ...result(), rating: 11 }) } }],
        ['oversized', 'x'.repeat(262145)],
        ['bad envelope', 'not JSON'],
        ['error envelope', { ...chat(), error: 'private-image google-private-key' }]
    ];
    for (const [name, value, expected = 502] of cases) await t.test(name, async t => {
        const { post } = await setup(t, {}, async url => url.endsWith('/api/chat')
            ? (typeof value === 'string' ? new Response(value) : Response.json(value)) : mock(url));
        const response = await post();
        assert.equal(response.status, expected);
        const body = await response.json();
        assert.equal(body.code, expected === 422 ? 'review_refused' : 'invalid_review');
        assert.doesNotMatch(body.error, /private-image|google-private-key/);
    });
});

test('invalid local request contracts and oversized bodies are rejected before metadata or image calls', async t => {
    const { post, calls, base } = await setup(t);
    for (const body of ['{', { ...request(), model }, { ...request(), url: 'https://evil.example' },
        { ...request(), image: 'bad' }, { ...request(), adjustments: { crop: 1 } },
        JSON.stringify(request()).replace('"intent":', '"intent":"duplicate","intent":')]) {
        assert.equal((await post(body)).status, 400);
    }
    assert.equal((await post(request(), { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await post(request(), { 'Content-Encoding': 'gzip' })).status, 415);
    for (const chunked of [false, true]) {
        const response = await new Promise((resolve, reject) => {
            const req = http.request(`${base}/api/review/local`, { method: 'POST',
                headers: { 'Content-Type': 'application/json',
                    ...(chunked ? { 'Transfer-Encoding': 'chunked' } : { 'Content-Length': MAX_BODY_BYTES + 1 }) }
            }, res => {
                res.resume();
                res.on('end', () => resolve(res));
            });
            req.on('error', reject);
            if (chunked) req.end('x'.repeat(MAX_BODY_BYTES + 1));
            else req.flushHeaders();
        });
        assert.equal(response.statusCode, 413);
    }
    assert.equal((await fetch(`${base}/api/review/local`)).status, 405);
    assert.equal((await fetch(`${base}/api/review/local/status`, { method: 'POST' })).status, 405);
    assert.equal(calls.length, 0);
});

test('local concurrency is one, separate from cloud slots and quota, and releases after success', async t => {
    let release;
    let began;
    const started = new Promise(resolve => { began = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const { post, base, status } = await setup(t, {
        GEMINI_API_KEY: 'google-private-key', REVIEW_RATE_LIMIT: '1', REVIEW_CONCURRENCY: '1'
    }, async url => {
        if (url.startsWith('https://generativelanguage.googleapis.com/')) return Response.json({
            candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(result()) }] } }]
        });
        if (url.endsWith('/api/chat')) { began(); await gate; }
        return mock(url);
    });
    const first = post();
    await started;
    assert.equal((await (await post()).json()).code, 'local_busy');
    assert.equal((await (await status()).json()).code, 'local_busy');
    const cloudPost = () => fetch(`${base}/api/review`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request()) });
    assert.equal((await cloudPost()).status, 200);
    assert.equal((await (await cloudPost()).json()).code, 'rate_limited');
    release();
    assert.equal((await first).status, 200);
    assert.equal((await post()).status, 200, 'Cloud quota does not apply locally');
});

test('local deadlines abort stalled metadata and chat, release slots and never fall back', async t => {
    for (const endpoint of ['/api/tags', '/api/chat']) await t.test(endpoint, async t => {
        let signal;
        let hang = true;
        const { post, status, calls } = await setup(t, { LOCAL_REVIEW_TIMEOUT_MS: '25', GEMINI_API_KEY: 'google-private-key' },
            async (url, options) => {
                if (hang && url.endsWith(endpoint)) {
                    signal = options.signal;
                    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('secret')), { once: true }));
                }
                return mock(url);
            });
        const response = await (endpoint === '/api/tags' ? status() : post());
        assert.equal(response.status, 504);
        assert.equal((await response.json()).code, 'local_timeout');
        assert.equal(signal.aborted, true);
        hang = false;
        assert.equal((await post()).status, 200);
        assert.ok(calls.every(call => call.url.startsWith('http://127.0.0.1:11434/')));
    });
});

test('deadline bounds response-body streaming and aborts upstream', async t => {
    let signal;
    const { post } = await setup(t, { LOCAL_REVIEW_TIMEOUT_MS: '25' }, async (url, options) => {
        if (!url.endsWith('/api/chat')) return mock(url);
        signal = options.signal;
        return new Response(new ReadableStream({
            start(controller) { signal.addEventListener('abort', () => controller.error(new Error('aborted'))); }
        }));
    });
    assert.equal((await post()).status, 504);
    assert.equal(signal.aborted, true);
});

test('local deadline also stops an incomplete upload and releases its slot without provider work', async t => {
    const { base, status, calls } = await setup(t, { LOCAL_REVIEW_TIMEOUT_MS: '50' });
    const response = await new Promise((resolve, reject) => {
        const req = http.request(`${base}/api/review/local`, { method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': 100 } }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
        });
        req.on('error', reject);
        req.write('{');
    });
    assert.equal(response.status, 504);
    assert.equal(response.body.code, 'local_timeout');
    assert.equal(calls.length, 0);
    assert.equal((await status()).status, 200);
});

test('client disconnect aborts local request and releases slot without waiting for deadline', async t => {
    let began;
    let aborted;
    let hang = true;
    const started = new Promise(resolve => { began = resolve; });
    const cancelled = new Promise(resolve => { aborted = resolve; });
    const { base, status } = await setup(t, {}, async (url, { signal }) => {
        if (!url.endsWith('/api/chat') || !hang) return mock(url);
        began();
        return new Promise((_, reject) => signal.addEventListener('abort', () => {
            aborted();
            reject(new Error('aborted'));
        }, { once: true }));
    });
    const req = http.request(`${base}/api/review/local`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    req.on('error', () => {});
    req.end(JSON.stringify(request()));
    await started;
    req.destroy();
    await cancelled;
    hang = false;
    assert.equal((await status()).status, 200);
});
