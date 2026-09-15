'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { localRequest } = require('../server/local-transport.js');

async function setup(t, handler) {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
        server.closeAllConnections();
        return new Promise(resolve => server.close(resolve));
    });
    const controller = new AbortController();
    t.after(() => controller.abort());
    const options = { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: '{"model":"qwen3-vl:4b-instruct"}', signal: controller.signal };
    const request = (url, init, callback) => {
        assert.equal(url.origin, 'http://127.0.0.1:11434');
        assert.equal(init.timeout, 0, 'No independent socket deadline');
        assert.equal(init.agent, false, 'No shared fetch dispatcher or pooled socket');
        assert.equal(init.signal, controller.signal);
        url.port = server.address().port;
        return http.request(url, init, callback);
    };
    return { controller, call: () => localRequest('http://127.0.0.1:11434/api/chat', options, request) };
}

test('local native transport waits for delayed headers and idle chunks until the caller deadline', async t => {
    let releaseHeaders;
    let releaseBody;
    const headersGate = new Promise(resolve => { releaseHeaders = resolve; });
    const bodyGate = new Promise(resolve => { releaseBody = resolve; });
    t.after(() => { releaseHeaders(); releaseBody(); });
    const { call } = await setup(t, async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        assert.equal(req.method, 'POST');
        assert.equal(req.url, '/api/chat');
        assert.equal(JSON.parse(body).model, 'qwen3-vl:4b-instruct');
        await headersGate;
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write('first\n');
        await bodyGate;
        res.end('last\n');
    });
    let receivedHeaders = false;
    const pending = call().then(response => { receivedHeaders = true; return response; });
    await delay(30);
    assert.equal(receivedHeaders, false);
    releaseHeaders();
    const response = await pending;
    assert.equal(response.ok, true);
    const reader = response.body.getReader();
    assert.equal(Buffer.from((await reader.read()).value).toString(), 'first\n');
    let receivedNext = false;
    const next = reader.read().then(chunk => { receivedNext = true; return chunk; });
    await delay(30);
    assert.equal(receivedNext, false);
    releaseBody();
    assert.equal(Buffer.from((await next).value).toString(), 'last\n');
    assert.equal((await reader.read()).done, true);
});

test('local native transport aborts a pending first byte and closes the upstream socket', async t => {
    let started;
    let closed;
    const began = new Promise(resolve => { started = resolve; });
    const ended = new Promise(resolve => { closed = resolve; });
    const { call, controller } = await setup(t, (req, res) => {
        res.on('close', closed);
        started();
    });
    const pending = call();
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await began;
    controller.abort();
    await rejected;
    await ended;
});

test('local native transport aborts during an idle response body', async t => {
    let closed;
    const ended = new Promise(resolve => { closed = resolve; });
    const { call, controller } = await setup(t, (req, res) => {
        res.on('close', closed);
        res.write('partial');
    });
    const reader = (await call()).body.getReader();
    await reader.read();
    const rejected = assert.rejects(reader.read());
    controller.abort();
    await rejected;
    await ended;
});

test('cancelling a native response stops the upstream stream', async t => {
    let closed;
    const ended = new Promise(resolve => { closed = resolve; });
    const { call } = await setup(t, (req, res) => {
        res.on('close', closed);
        res.write('partial');
    });
    const response = await call();
    await response.body.cancel();
    await ended;
});

test('native transport rejects truncated bodies instead of silently accepting partial output', async t => {
    const { call } = await setup(t, async (req, res) => {
        res.write('partial');
        await delay(20);
        res.destroy();
    });
    const response = await call();
    await assert.rejects(new Response(response.body).text());
});

test('native transport does not follow redirects or accept another origin', async t => {
    let requests = 0;
    const { call } = await setup(t, (req, res) => {
        requests++;
        res.writeHead(307, { Location: 'https://example.invalid/private' });
        res.end();
    });
    const response = await call();
    assert.equal(response.status, 307);
    assert.equal(response.ok, false);
    await response.body.cancel();
    assert.equal(requests, 1);
    for (const url of ['https://127.0.0.1:11434/api/chat', 'http://localhost:11434/api/chat',
        'http://127.0.0.1:11435/api/chat', 'http://user:password@127.0.0.1:11434/api/chat']) {
        await assert.rejects(localRequest(url, {}, () => assert.fail('Must not connect')), /fixed Ollama origin/);
    }
});

test('an already aborted request never opens a socket', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(localRequest('http://127.0.0.1:11434/api/chat', { signal: controller.signal },
        () => assert.fail('Must not connect')), { name: 'AbortError' });
});
