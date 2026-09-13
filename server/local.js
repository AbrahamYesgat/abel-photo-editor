'use strict';

const { BlockList, isIP } = require('node:net');
const { reviewSchema, validateReview } = require('../js/review-contract.js');
const { systemInstruction } = require('./prompt.js');
const { parseJSON } = require('./json.js');

const OLLAMA = 'http://127.0.0.1:11434';
const MODELS = new Set(['2b', '4b', '8b', '30b', '32b']
    .flatMap(size => [`qwen3-vl:${size}`, `qwen3-vl:${size}-instruct`]));
const loopbacks = new BlockList();
loopbacks.addSubnet('127.0.0.0', 8, 'ipv4');
loopbacks.addAddress('::1', 'ipv6');

function isLoopback(host) {
    const family = isIP(host);
    return host === 'localhost' || Boolean(family && loopbacks.check(host, family === 6 ? 'ipv6' : 'ipv4'));
}

function localConfig(env, host, positive) {
    if (env.LOCAL_REVIEW_ENABLED && !['true', 'false'].includes(env.LOCAL_REVIEW_ENABLED)) {
        throw new Error('LOCAL_REVIEW_ENABLED must be true or false.');
    }
    const enabled = env.LOCAL_REVIEW_ENABLED ? env.LOCAL_REVIEW_ENABLED === 'true' : isLoopback(host);
    if (enabled && !isLoopback(host)) throw new Error('LOCAL_REVIEW_ENABLED requires a loopback HOST.');
    const model = env.QWEN_MODEL || 'qwen3-vl:4b-instruct';
    if (!MODELS.has(model)) throw new Error('QWEN_MODEL must be a local qwen3-vl 2b, 4b, 8b, 30b, or 32b tag, optionally ending in -instruct.');
    const token = env.LOCAL_REVIEW_ACCESS_TOKEN || '';
    if (token && (token.trim() !== token || /[\s\x00-\x1f\x7f]/.test(token))) {
        throw new Error('LOCAL_REVIEW_ACCESS_TOKEN must not contain whitespace or control characters.');
    }
    return { localEnabled: enabled, localModel: model, localAccessToken: token,
        localTimeoutMs: positive(env.LOCAL_REVIEW_TIMEOUT_MS, 600000, 'LOCAL_REVIEW_TIMEOUT_MS', 900000) };
}

function sameLocalOrigin(req, config) {
    if (!isLoopback(config.host)) return false;
    // Same-origin browser GETs often omit Origin; Fetch Metadata is browser-controlled.
    if (!req.headers.origin) return req.headers['sec-fetch-site'] === 'same-origin';
    try {
        const origin = new URL(req.headers.origin);
        return origin.origin === req.headers.origin && origin.protocol === 'http:' &&
            ['localhost', '127.0.0.1', '[::1]', config.host.includes(':') ? `[${config.host}]` : config.host].includes(origin.hostname) &&
            Number(origin.port || 80) === req.socket.localPort;
    } catch { return false; }
}

function hasRemoteMetadata(value) {
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).some(([key, child]) =>
        ((key === 'remote_host' || key === 'remote_model') && child !== null && child !== '') ||
        (key === 'modelfile' && typeof child === 'string' && /^\s*FROM\s+.*(?:https?:\/\/|:.*cloud)/im.test(child)) ||
        hasRemoteMetadata(child));
}

function createLocalProvider({ config, fetchImpl, SafeError, readUpstream }) {
    const missing = () => new SafeError(503, 'local_model_missing',
        `Install the local vision model first: ollama pull ${config.localModel}. Models are never downloaded automatically.`);
    const invalidMetadata = () => new SafeError(503, 'local_model_invalid',
        'Ollama returned unrecognized model metadata. Update Ollama and reinstall the configured Qwen vision model.');
    function requireLocalMetadata(metadata) {
        if (hasRemoteMetadata(metadata) ||
            [metadata?.name, metadata?.model].some(name => name !== undefined && name !== config.localModel)) {
            throw new SafeError(503, 'local_model_remote',
                'Cloud-backed models and aliases are not allowed. Remove the alias, pull the configured local Qwen model, and restart Ollama with OLLAMA_NO_CLOUD=1.');
        }
    }

    async function call(endpoint, body, controller) {
        let response;
        try {
            controller.signal.throwIfAborted();
            response = await fetchImpl(`${OLLAMA}${endpoint}`, {
                method: body ? 'POST' : 'GET', redirect: 'error', signal: controller.signal,
                headers: { 'Content-Type': 'application/json' },
                ...(body ? { body: JSON.stringify(body) } : {})
            });
        } catch (error) {
            if (['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(error.cause?.code)) {
                throw new SafeError(504, 'local_timeout',
                    'The local model took too long to respond. Try a smaller Qwen model or a faster computer.');
            }
            throw new SafeError(503, 'local_unavailable',
                'Ollama could not be reached at 127.0.0.1:11434. Start Ollama locally with OLLAMA_NO_CLOUD=1 and OLLAMA_NUM_PARALLEL=1.');
        }
        if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            if (response.status === 404 && endpoint !== '/api/tags') throw missing();
            throw new SafeError(503, 'local_runtime_error',
                'Ollama could not run the local model. Check Ollama is current, cloud is disabled, and enough memory is available.');
        }
        return response;
    }

    async function ready(controller) {
        let tags;
        try { tags = await readUpstream(await call('/api/tags', null, controller)); } catch (error) {
            if (error instanceof SafeError) throw error;
            throw invalidMetadata();
        }
        if (!Array.isArray(tags?.models)) throw invalidMetadata();
        const installed = tags.models.find(model => model?.name === config.localModel || model?.model === config.localModel);
        if (!installed) throw missing();
        requireLocalMetadata(installed);
        let metadata;
        try { metadata = await readUpstream(await call('/api/show', { model: config.localModel }, controller)); } catch (error) {
            if (error instanceof SafeError) throw error;
            throw invalidMetadata();
        }
        requireLocalMetadata(metadata);
        if (!Array.isArray(metadata?.capabilities)) throw invalidMetadata();
        if (!metadata.capabilities.includes('vision')) {
            throw new SafeError(503, 'local_model_no_vision',
                `The installed model lacks vision support. Update Ollama and run: ollama pull ${config.localModel}.`);
        }
        if (!['qwen3vl', 'qwen3vlmoe'].includes(metadata.model_info?.['general.architecture'])) throw invalidMetadata();
        return { provider: 'ollama', model: config.localModel, ready: true, localOnly: true };
    }

    async function review(request, controller) {
        await ready(controller);
        const response = await call('/api/chat', {
            model: config.localModel, stream: true, think: false, format: reviewSchema,
            messages: [
                { role: 'system', content: systemInstruction },
                { role: 'user', content: JSON.stringify({ adjustments: request.adjustments, intent: request.intent }),
                    images: [request.image] }
            ],
            options: { temperature: 0.2, num_ctx: 8192, num_predict: 4096 }
        }, controller);
        try {
            return validateReview(parseJSON(await readChat(response)));
        } catch (error) {
            if (error instanceof SafeError) throw error;
            throw new SafeError(502, 'invalid_review', 'The local model returned an incomplete or invalid review. No changes were applied.');
        }
    }

    async function readChat(response) {
        if (!response.body) throw new Error('Missing local response body');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = '';
        let content = '';
        let bytes = 0;
        let contentBytes = 0;
        let done = false;
        const consume = line => {
            if (!line.trim()) return;
            if (done) throw new Error('Unexpected data after completed local response');
            const data = parseJSON(line);
            const message = data?.message;
            if (message?.refusal || data?.done_reason === 'refusal') {
                throw new SafeError(422, 'review_refused', 'The local model could not review this image or intent.');
            }
            if (data?.error || typeof data?.done !== 'boolean' ||
                message?.role !== 'assistant' || typeof message.content !== 'string' ||
                (message.tool_calls !== undefined && (!Array.isArray(message.tool_calls) || message.tool_calls.length)) ||
                message.function_call !== undefined || data.tool_calls !== undefined) {
                throw new Error('Unsupported local response');
            }
            contentBytes += Buffer.byteLength(message.content);
            if (contentBytes > 256 * 1024) throw new Error('Oversized local review');
            content += message.content;
            if (data.done) {
                if (data.done_reason !== 'stop') throw new Error('Incomplete local review');
                done = true;
            }
        };
        try {
            // Streaming avoids fetch's five-minute wait-for-headers limit on slow CPUs.
            // Extra space covers NDJSON envelopes; review content is bounded separately.
            while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                bytes += chunk.value.byteLength;
                if (bytes > 2 * 1024 * 1024) throw new Error('Oversized local stream');
                pending += decoder.decode(chunk.value, { stream: true });
                let newline;
                while ((newline = pending.indexOf('\n')) !== -1) {
                    const line = pending.slice(0, newline);
                    if (Buffer.byteLength(line) > 256 * 1024) throw new Error('Oversized local stream line');
                    consume(line);
                    pending = pending.slice(newline + 1);
                }
                if (Buffer.byteLength(pending) > 256 * 1024) throw new Error('Oversized local stream line');
            }
            pending += decoder.decode();
            consume(pending);
            if (!done) throw new Error('Truncated local stream');
            return content;
        } finally {
            await reader.cancel().catch(() => {});
        }
    }
    return { ready, review };
}

module.exports = { isLoopback, localConfig, sameLocalOrigin, createLocalProvider };
