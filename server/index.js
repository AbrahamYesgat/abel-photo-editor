'use strict';

const http = require('node:http');
const path = require('node:path');
const { existsSync } = require('node:fs');
const { readFile } = require('node:fs/promises');
const { timingSafeEqual } = require('node:crypto');
const { validateRequest, validateReview } = require('../js/review-contract.js');
const { geminiReviewSchema } = require('./schema.js');
const { systemInstruction } = require('./prompt.js');
const { parseJSON } = require('./json.js');
const { isLoopback, localConfig, sameLocalOrigin, createLocalProvider } = require('./local.js');

const ROOT = path.resolve(__dirname, '..');
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_UPSTREAM_BYTES = 256 * 1024;
const STATIC_FILES = new Map([
    ['/', 'index.html'], ['/index.html', 'index.html'], ['/manifest.json', 'manifest.json'],
    ...['styles.css'].map(name => [`/css/${name}`, `css/${name}`]),
    ...['app.js', 'auto-edit.js', 'curve-editor.js', 'gl-engine.js', 'histogram.js',
        'mask-engine.js', 'presets.js', 'shaders.js', 'review-contract.js', 'review.js',
        'review-prompt.js', 'review-json.js', 'review-manual.js']
        .map(name => [`/js/${name}`, `js/${name}`])
]);
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };

class SafeError extends Error {
    constructor(status, code, message, retryAfter) {
        super(message);
        Object.assign(this, { status, code, retryAfter });
    }
}
const unavailable = () => new SafeError(503, 'not_configured', 'Photo review is not configured on this server.');
function positive(value, fallback, name, max = 3600000) {
    const result = value === undefined || value === '' ? fallback : Number(value);
    if (!Number.isSafeInteger(result) || result < 1 || result > max) throw new Error(`Invalid ${name}.`);
    return result;
}
function loadConfig(env = process.env) {
    const host = env.HOST || '127.0.0.1';
    const accessToken = env.REVIEW_ACCESS_TOKEN || '';
    if (!isLoopback(host) && !accessToken.trim()) {
        throw new Error('REVIEW_ACCESS_TOKEN is required when HOST is not loopback.');
    }
    if (accessToken && (accessToken.trim() !== accessToken || /[\s\x00-\x1f\x7f]/.test(accessToken))) {
        throw new Error('REVIEW_ACCESS_TOKEN must not contain whitespace or control characters.');
    }
    const model = env.GEMINI_MODEL || 'gemini-3.6-flash';
    if (!/^gemini-[a-z0-9.-]{1,80}$/.test(model)) throw new Error('Invalid GEMINI_MODEL.');
    const allowedOrigins = new Set();
    for (const origin of (env.ALLOWED_ORIGINS || '').split(',').map(item => item.trim()).filter(Boolean)) {
        let parsed;
        try { parsed = new URL(origin); } catch { throw new Error('Invalid ALLOWED_ORIGINS.'); }
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin || parsed.username || parsed.password) {
            throw new Error('ALLOWED_ORIGINS must contain exact HTTP(S) origins without paths.');
        }
        allowedOrigins.add(origin);
    }
    return {
        host, port: positive(env.PORT, 3000, 'PORT', 65535), accessToken,
        apiKey: (env.GEMINI_API_KEY || '').trim(), model, allowedOrigins,
        rateLimit: positive(env.REVIEW_RATE_LIMIT, 10, 'REVIEW_RATE_LIMIT', 10000),
        rateWindowMs: positive(env.REVIEW_RATE_WINDOW_MS, 60000, 'REVIEW_RATE_WINDOW_MS'),
        concurrency: positive(env.REVIEW_CONCURRENCY, 2, 'REVIEW_CONCURRENCY', 100),
        timeoutMs: positive(env.REVIEW_TIMEOUT_MS, 30000, 'REVIEW_TIMEOUT_MS', 120000),
        ...localConfig(env, host, positive)
    };
}
function json(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
}
function authorized(req, token) {
    if (!token) return true;
    const actual = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${token}`);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function checkOrigin(req, res, config) {
    const origin = req.headers.origin;
    if (!origin) {
        if (req.headers['sec-fetch-site'] === 'cross-site') {
            throw new SafeError(403, 'origin_denied', 'This origin is not allowed.');
        }
        return;
    }
    const port = req.socket.localPort;
    const localOrigins = isLoopback(config.host)
        ? [`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`] : [];
    // Never derive trusted origins from Host or forwarding headers.
    if (!config.allowedOrigins.has(origin) && !localOrigins.includes(origin)) {
        throw new SafeError(403, 'origin_denied', 'This origin is not allowed.');
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Expose-Headers', 'Retry-After');
}
function readBody(req, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new SafeError(400, 'invalid_request', 'Review request was interrupted.'));
        let size = 0;
        const chunks = [];
        const timer = setTimeout(() => finish(new SafeError(408, 'request_timeout', 'Request body timed out.')), 15000);
        const finish = (error, result) => {
            clearTimeout(timer);
            req.off('data', onData);
            req.off('end', onEnd);
            req.off('error', onError);
            req.off('aborted', onAbort);
            signal?.removeEventListener('abort', onAbort);
            if (error) { req.pause(); reject(error); } else resolve(result);
        };
        const onData = chunk => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) finish(new SafeError(413, 'body_too_large', 'Review request exceeds 2 MiB.'));
            else chunks.push(chunk);
        };
        const onEnd = () => finish(null, Buffer.concat(chunks).toString('utf8'));
        const onError = () => finish(new SafeError(400, 'invalid_request', 'Could not read review request.'));
        const onAbort = () => finish(new SafeError(400, 'invalid_request', 'Review request was interrupted.'));
        req.on('data', onData);
        req.on('end', onEnd);
        req.on('error', onError);
        req.on('aborted', onAbort);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
async function readUpstream(response) {
    if (!response.body) throw new Error('Missing upstream body');
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_UPSTREAM_BYTES) throw new Error('Oversized upstream body');
            chunks.push(Buffer.from(value));
        }
        return parseJSON(Buffer.concat(chunks).toString('utf8'));
    } finally {
        await reader.cancel().catch(() => {});
    }
}
async function review(request, config, fetchImpl, controller) {
    let response;
    try {
        response = await fetchImpl(
            `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent`,
            {
                method: 'POST', signal: controller.signal, redirect: 'error',
                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey },
                body: JSON.stringify({
                    systemInstruction: { parts: [{ text: systemInstruction }] },
                    contents: [{ role: 'user', parts: [
                        { inlineData: { mimeType: 'image/jpeg', data: request.image } },
                        { text: JSON.stringify({ adjustments: request.adjustments, intent: request.intent }) }
                    ] }],
                    generationConfig: {
                        temperature: 0.2, maxOutputTokens: 8192,
                        ...(config.model.startsWith('gemini-2.5-') ? { thinkingConfig: { thinkingBudget: 1024 } } : {}),
                        responseMimeType: 'application/json', responseJsonSchema: geminiReviewSchema
                    }
                })
            }
        );
    } catch {
        throw new SafeError(502, 'upstream_unavailable', 'The review provider could not be reached. Please try again.');
    }
    if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (response.status === 429) throw new SafeError(429, 'provider_rate_limited', 'Gemini quota is temporarily exhausted. Try again later.', 60);
        if (response.status === 400) throw new SafeError(503, 'provider_request_rejected',
            'Gemini rejected the request. Check the server API key, model, and review schema configuration.');
        if (response.status === 401) throw new SafeError(503, 'provider_authentication',
            'Gemini rejected the server API key. Check GEMINI_API_KEY in the server environment and restart the server.');
        if (response.status === 403) throw new SafeError(503, 'provider_permission',
            'Gemini denied access. Check the API key restrictions and Gemini API permissions in Google AI Studio.');
        if (response.status === 404) throw new SafeError(503, 'provider_model_unavailable',
            'The configured Gemini model is unavailable for this account. Update GEMINI_MODEL in the server environment to a supported model and restart the server.');
        throw new SafeError(502, 'upstream_unavailable', 'The review provider is temporarily unavailable.');
    }
    try {
        const data = await readUpstream(response);
        if (data.promptFeedback?.blockReason) {
            throw new SafeError(422, 'review_refused', 'The provider could not review this image or intent.');
        }
        const candidate = data.candidates?.[0];
        if (candidate && ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'IMAGE_SAFETY'].includes(candidate.finishReason)) {
            throw new SafeError(422, 'review_refused', 'The provider could not review this image or intent.');
        }
        if (data.candidates?.length !== 1 || candidate.finishReason !== 'STOP') throw new Error('Incomplete output');
        const parts = candidate.content?.parts;
        if (!Array.isArray(parts) || !parts.length) throw new Error('Missing output');
        const output = parts.filter(part => !part.thought);
        if (!output.length || output.some(part => typeof part.text !== 'string' || part.functionCall)) throw new Error('Invalid output');
        return validateReview(parseJSON(output.map(part => part.text).join('')));
    } catch (error) {
        if (error instanceof SafeError) throw error;
        throw new SafeError(502, 'invalid_review', 'The provider returned an incomplete or invalid review. No changes were applied.');
    }
}

function createServer({ env = process.env, fetch: fetchImpl = globalThis.fetch } = {}) {
    const config = loadConfig(env);
    const local = createLocalProvider({ config, fetchImpl, SafeError, readUpstream });
    let localActive = 0;
    let active = 0;
    let used = 0;
    let windowStart = Date.now();
    const server = http.createServer(async (req, res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        try {
            const pathname = new URL(req.url, 'http://server.invalid').pathname;
            if (pathname.startsWith('/api/')) {
                const localPath = ['/api/review/local', '/api/review/local/status'].includes(pathname);
                checkOrigin(req, res, config);
                if (!localPath && !['/api/review', '/api/review/status'].includes(pathname)) {
                    throw new SafeError(404, 'not_found', 'Not found.');
                }
                if (localPath && (!config.localEnabled || !isLoopback(config.host) ||
                    !isLoopback(server.address()?.address) ||
                    !isLoopback(req.socket.localAddress) || !isLoopback(req.socket.remoteAddress))) {
                    throw new SafeError(403, 'local_disabled', 'Local review is available only on an enabled loopback companion server.');
                }
                if (req.method === 'OPTIONS') {
                    const requested = (req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map(item => item.trim()).filter(Boolean);
                    const method = req.headers['access-control-request-method'];
                    if ((method && !['GET', 'POST'].includes(method)) ||
                        requested.some(header => !['authorization', 'content-type'].includes(header))) {
                        throw new SafeError(403, 'origin_denied', 'This cross-origin request is not allowed.');
                    }
                    if (localPath && req.headers.origin && req.headers['access-control-request-private-network'] === 'true') {
                        res.setHeader('Access-Control-Allow-Private-Network', 'true');
                    }
                    res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                        'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '600' });
                    res.end();
                    return;
                }
                if (localPath) {
                    const trustedLocalOrigin = sameLocalOrigin(req, config);
                    if (req.headers.origin && !trustedLocalOrigin && !config.localAccessToken) {
                        throw new SafeError(401, 'local_token_required', 'Configure LOCAL_REVIEW_ACCESS_TOKEN on the companion before using cross-origin local review.');
                    }
                    if (!trustedLocalOrigin && !authorized(req, config.localAccessToken)) {
                        throw new SafeError(401, 'local_unauthorized', 'A valid local review access token is required.');
                    }
                    const statusRequest = pathname === '/api/review/local/status' && req.method === 'GET';
                    if (!statusRequest && !(pathname === '/api/review/local' && req.method === 'POST')) {
                        throw new SafeError(405, 'method_not_allowed', 'Method not allowed.');
                    }
                    if (!statusRequest) {
                        if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '') ||
                            (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')) {
                            throw new SafeError(415, 'unsupported_media_type', 'Send an uncompressed application/json request.');
                        }
                        if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
                            throw new SafeError(413, 'body_too_large', 'Review request exceeds 2 MiB.');
                        }
                    }
                    if (localActive >= 1) throw new SafeError(429, 'local_busy', 'The local model is busy. Wait for the current local request to finish.', 5);
                    localActive++;
                    const controller = new AbortController();
                    let timer;
                    let onClose;
                    const interrupted = new Promise((_, reject) => {
                        onClose = () => {
                            if (!res.writableEnded) {
                                reject(new SafeError(400, 'invalid_request', 'Local review was interrupted.'));
                                controller.abort();
                            }
                        };
                        res.on('close', onClose);
                        timer = setTimeout(() => {
                            reject(new SafeError(504, 'local_timeout', 'Local review timed out. Try a smaller Qwen model or increase LOCAL_REVIEW_TIMEOUT_MS.'));
                            controller.abort();
                        }, config.localTimeoutMs);
                    });
                    try {
                        const work = async () => {
                            if (statusRequest) return local.ready(controller);
                            const body = await readBody(req, controller.signal);
                            let request;
                            try { request = validateRequest(parseJSON(body)); } catch {
                                throw new SafeError(400, 'invalid_request', 'Invalid review request. Supply a JPEG up to 1280 × 1280, all allowed adjustments, and intent up to 600 characters.');
                            }
                            if (controller.signal.aborted) return;
                            return local.review(request, controller);
                        };
                        const result = await Promise.race([work(), interrupted]);
                        if (!res.destroyed) json(res, 200, result);
                    } finally {
                        clearTimeout(timer);
                        controller.abort();
                        res.off('close', onClose);
                        localActive--;
                    }
                    return;
                }
                if (pathname === '/api/review/status' && req.method === 'GET') {
                    json(res, 200, { configured: Boolean(config.apiKey), model: config.model });
                    return;
                }
                if (pathname !== '/api/review' || req.method !== 'POST') {
                    throw new SafeError(405, 'method_not_allowed', 'Method not allowed.');
                }
                if (!authorized(req, config.accessToken)) {
                    throw new SafeError(401, 'unauthorized', 'A valid review access token is required.');
                }
                if (!config.apiKey) throw unavailable();
                if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '') ||
                    (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')) {
                    throw new SafeError(415, 'unsupported_media_type', 'Send an uncompressed application/json request.');
                }
                if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
                    throw new SafeError(413, 'body_too_large', 'Review request exceeds 2 MiB.');
                }
                if (Date.now() - windowStart >= config.rateWindowMs) { windowStart = Date.now(); used = 0; }
                if (used >= config.rateLimit) {
                    throw new SafeError(429, 'rate_limited', 'Too many review requests. Please wait.',
                        Math.max(1, Math.ceil((windowStart + config.rateWindowMs - Date.now()) / 1000)));
                }
                if (active >= config.concurrency) {
                    throw new SafeError(429, 'busy', 'The review server is busy. Please try again shortly.', 5);
                }
                used++;
                active++;
                const controller = new AbortController();
                const onClose = () => { if (!res.writableEnded) controller.abort(); };
                res.on('close', onClose);
                let timer;
                try {
                    const body = await readBody(req);
                    let request;
                    try { request = validateRequest(parseJSON(body)); } catch {
                        throw new SafeError(400, 'invalid_request', 'Invalid review request. Supply a JPEG up to 1280 × 1280, all allowed adjustments, and intent up to 600 characters.');
                    }
                    if (controller.signal.aborted) return;
                    const timeout = new Promise((_, reject) => {
                        timer = setTimeout(() => {
                            reject(new SafeError(504, 'review_timeout', 'The review provider timed out. Please try again.'));
                            controller.abort();
                        }, config.timeoutMs);
                    });
                    const result = await Promise.race([review(request, config, fetchImpl, controller), timeout]);
                    json(res, 200, result);
                } finally {
                    clearTimeout(timer);
                    controller.abort();
                    res.off('close', onClose);
                    active--;
                }
                return;
            }
            if (!['GET', 'HEAD'].includes(req.method)) throw new SafeError(405, 'method_not_allowed', 'Method not allowed.');
            const file = STATIC_FILES.get(pathname);
            if (!file) throw new SafeError(404, 'not_found', 'Not found.');
            let body;
            try { body = await readFile(path.join(ROOT, file)); } catch { throw new SafeError(404, 'not_found', 'Not found.'); }
            res.writeHead(200, { 'Content-Type': MIME[path.extname(file)], 'Cache-Control': 'no-cache' });
            res.end(req.method === 'HEAD' ? undefined : body);
        } catch (error) {
            if (res.destroyed || res.writableEnded) return;
            const safe = error instanceof SafeError ? error : new SafeError(500, 'internal_error', 'The review server encountered an error.');
            if (!req.complete) {
                req.resume();
                res.setHeader('Connection', 'close');
            }
            if (safe.retryAfter) res.setHeader('Retry-After', safe.retryAfter);
            json(res, safe.status, { error: safe.message, code: safe.code });
        }
    });
    server.requestTimeout = 20000;
    server.headersTimeout = 10000;
    server.keepAliveTimeout = 5000;
    server.maxRequestsPerSocket = 100;
    return server;
}

if (require.main === module) {
    try {
        const [major, minor] = process.versions.node.split('.').map(Number);
        if (major < 20 || (major === 20 && minor < 17)) throw new Error('Node.js 20.17 or newer is required; Node.js 22+ is recommended.');
        if (existsSync('.env')) process.loadEnvFile('.env');
        const config = loadConfig();
        const server = createServer();
        server.on('error', () => { console.error('Unable to start review server. Check HOST and PORT.'); process.exitCode = 1; });
        server.listen(config.port, config.host, () => {
            console.log(`ABEL server listening on port ${config.port}; review ${config.apiKey ? 'configured' : 'not configured'}.`);
        });
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = { createServer, loadConfig, MAX_BODY_BYTES };
