'use strict';

const path = require('node:path');
const { mkdir, open, readFile, rename, rm } = require('node:fs/promises');
const { reviewSchema, validateReview } = require('../js/review-contract.js');
const { azureSystemInstruction } = require('./prompt.js');
const { parseJSON } = require('./json.js');

// Keep constraints in the prompt and runtime validator; Azure's strict grammar
// does not support all of the JSON Schema validation keywords.
function azureSchema(schema) {
    const result = {};
    const bounds = [];
    for (const [key, value] of Object.entries(schema)) {
        if (['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern'].includes(key)) {
            bounds.push(`${key}: ${value}`);
        } else if (key === 'properties') {
            result.properties = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, azureSchema(child)]));
        } else result[key] = key === 'items' ? azureSchema(value) : value;
    }
    if (bounds.length) result.description = [result.description, ...bounds].filter(Boolean).join('; ');
    return result;
}
const responseSchema = azureSchema(reviewSchema);

function azureConfig(env, positive) {
    const endpoint = env.AZURE_OPENAI_ENDPOINT || '';
    if (endpoint) {
        let url;
        try { url = new URL(endpoint); } catch { throw new Error('Invalid AZURE_OPENAI_ENDPOINT.'); }
        if (url.protocol !== 'https:' || !/^[a-z0-9][a-z0-9-]*\.openai\.azure\.com$/.test(url.hostname) ||
            url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
            throw new Error('AZURE_OPENAI_ENDPOINT must be an HTTPS Azure OpenAI resource origin.');
        }
    }
    const deployment = env.AZURE_OPENAI_DEPLOYMENT || '';
    const model = env.AZURE_OPENAI_MODEL || '';
    for (const [name, value] of [['AZURE_OPENAI_DEPLOYMENT', deployment], ['AZURE_OPENAI_MODEL', model]]) {
        if (value && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/.test(value)) throw new Error(`Invalid ${name}.`);
    }
    const key = (env.AZURE_OPENAI_API_KEY || '').trim();
    const configured = Boolean(endpoint && deployment && model && key);
    if ([endpoint, deployment, model, key].some(Boolean) && !configured) {
        throw new Error('Configure all four AZURE_OPENAI_ENDPOINT, DEPLOYMENT, MODEL and API_KEY values.');
    }
    if (configured && !env.REVIEW_ACCESS_TOKEN) throw new Error('Azure review requires REVIEW_ACCESS_TOKEN, even on loopback.');
    return { azure: {
        endpoint: endpoint.replace(/\/$/, ''), deployment, model, key, configured,
        maxTokens: positive(env.AZURE_REVIEW_MAX_COMPLETION_TOKENS, 12000, 'AZURE_REVIEW_MAX_COMPLETION_TOKENS', 16000),
        timeoutMs: positive(env.AZURE_REVIEW_TIMEOUT_MS, 120000, 'AZURE_REVIEW_TIMEOUT_MS', 120000),
        monthlyLimit: positive(env.AZURE_REVIEW_MONTHLY_LIMIT, 100, 'AZURE_REVIEW_MONTHLY_LIMIT', 1000),
        budgetDir: path.resolve(env.AZURE_REVIEW_BUDGET_DIR || '.azure-budget')
    } };
}

async function reserveRequest(config, SafeError) {
    const directory = config.budgetDir;
    const lock = path.join(directory, 'lock');
    let locked = false;
    try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await mkdir(lock, { mode: 0o700 });
        locked = true;
        const month = new Date().toISOString().slice(0, 7);
        const file = path.join(directory, `${month}.json`);
        let used = 0;
        try {
            const data = parseJSON(await readFile(file, 'utf8'));
            if (data.month !== month || !Number.isSafeInteger(data.used) || data.used < 0) throw new Error('Invalid ledger');
            used = data.used;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (used >= config.monthlyLimit) {
            throw new SafeError(429, 'azure_monthly_limit', 'Azure monthly review allowance is exhausted. No provider request was sent.');
        }
        const pending = await open(path.join(lock, 'pending'), 'wx', 0o600);
        try {
            await pending.writeFile(JSON.stringify({ month, used: used + 1 }));
            await pending.sync();
        } finally { await pending.close(); }
        await rename(path.join(lock, 'pending'), file);
    } catch (error) {
        if (error instanceof SafeError) throw error;
        throw new SafeError(503, 'azure_budget_unavailable', 'Azure spending guard is unavailable or busy. No provider request was sent.');
    } finally {
        if (locked) await rm(lock, { recursive: true, force: true });
    }
}

function createAzureProvider({ config, fetchImpl, SafeError, readUpstream }) {
    return {
        async review(request, controller) {
            const azure = config.azure;
            await reserveRequest(azure, SafeError);
            if (controller.signal.aborted) throw new SafeError(504, 'review_timeout', 'Azure review was interrupted.');
            let response;
            try {
                response = await fetchImpl(`${azure.endpoint}/openai/v1/chat/completions`, {
                    method: 'POST', redirect: 'error', signal: controller.signal,
                    headers: { 'Content-Type': 'application/json', 'api-key': azure.key },
                    body: JSON.stringify({
                        model: azure.deployment,
                        max_completion_tokens: azure.maxTokens,
                        ...(azure.model.startsWith('gpt-5') ? { reasoning_effort: 'low' } : {}),
                        messages: [
                            { role: 'system', content: azureSystemInstruction },
                            { role: 'user', content: [
                                { type: 'text', text: JSON.stringify({ adjustments: request.adjustments, intent: request.intent }) },
                                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${request.image}`, detail: 'high' } }
                            ] }
                        ],
                        response_format: { type: 'json_schema', json_schema: { name: 'photo_review', strict: true, schema: responseSchema } }
                    })
                });
            } catch {
                throw new SafeError(502, 'upstream_unavailable', 'Azure could not be reached. No alternate provider was contacted.');
            }
            if (!response.ok) {
                await response.body?.cancel().catch(() => {});
                if (response.status === 429) throw new SafeError(429, 'provider_rate_limited', 'Azure quota is temporarily exhausted. Try again later.', 60);
                if ([400, 401, 403, 404].includes(response.status)) {
                    throw new SafeError(503, 'azure_configuration', 'Azure rejected this request. Check the server resource, deployment, key, vision and structured-output support.');
                }
                throw new SafeError(502, 'upstream_unavailable', 'Azure is temporarily unavailable.');
            }
            try {
                const data = await readUpstream(response);
                const choice = data.choices?.[0];
                if (choice?.message?.refusal || choice?.finish_reason === 'content_filter') {
                    throw new SafeError(422, 'review_refused', 'Azure could not review this image or intent.');
                }
                if (data.choices?.length !== 1 || choice.finish_reason !== 'stop' ||
                    typeof choice.message?.content !== 'string' ||
                    (choice.message.tool_calls != null && (!Array.isArray(choice.message.tool_calls) || choice.message.tool_calls.length)) ||
                    choice.message.function_call) {
                    throw new Error('Incomplete output');
                }
                return validateReview(parseJSON(choice.message.content));
            } catch (error) {
                if (error instanceof SafeError) throw error;
                throw new SafeError(502, 'invalid_review', 'Azure returned an incomplete or invalid review. No changes were applied.');
            }
        }
    };
}

module.exports = { azureConfig, responseSchema, createAzureProvider, reserveRequest };
