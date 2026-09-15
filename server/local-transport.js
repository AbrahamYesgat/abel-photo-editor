'use strict';

const http = require('node:http');

function responseBody(response) {
    const iterator = response[Symbol.asyncIterator]();
    let cancelled = false;
    // Avoid Node 20's Readable.toWeb empty-body cancellation double-close.
    return new ReadableStream({
        async pull(controller) {
            try {
                const { value, done } = await iterator.next();
                if (cancelled) return;
                if (done) controller.close();
                else controller.enqueue(value);
            } catch (error) {
                if (!cancelled) controller.error(error);
            }
        },
        cancel() {
            cancelled = true;
            response.destroy();
        }
    }, { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength });
}

function localRequest(url, { method, headers, body, signal }, request = http.request) {
    const target = new URL(url);
    if (target.origin !== 'http://127.0.0.1:11434' || target.username || target.password) {
        return Promise.reject(new Error('Local transport requires the fixed Ollama origin'));
    }
    return new Promise((resolve, reject) => {
        signal.throwIfAborted();
        // fetch imposes a five-minute headers/idle deadline even with streaming.
        // The route's AbortSignal owns the entire local deadline instead.
        const req = request(target, { method, headers, signal, agent: false, timeout: 0 }, response => {
            resolve({
                ok: response.statusCode >= 200 && response.statusCode < 300,
                status: response.statusCode,
                body: responseBody(response)
            });
        });
        req.on('error', reject);
        req.end(body);
    });
}

module.exports = { localRequest };
