import './segmentation.js?v=semantic-1';
import * as ort from './vendor/segmentation/ort.wasm.min.mjs';

ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.wasm.wasmPaths = new URL('./vendor/segmentation/', import.meta.url).href;
const api = globalThis.SemanticMasks;
const status = text => postMessage({ type: 'status', text });

async function modelBytes(model) {
    let cache;
    try { cache = await caches.open('abel-semantic-models-v1'); } catch { /* Private browsing/quota may disallow storage. */ }
    let cached;
    try { cached = await cache?.match(model.url); } catch { cache = null; }
    let bytes;
    if (cached) {
        status('Reading cached model…');
        bytes = await cached.arrayBuffer();
    } else {
        status(`Downloading ${model.label} (${(model.bytes / 1e6).toFixed(1)} MB)…`);
        const response = await fetch(model.url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
        if (!response.ok || !response.body) throw new Error('Model download failed. Check your connection and retry.');
        const reader = response.body.getReader();
        const data = new Uint8Array(model.bytes);
        let offset = 0, last = 0;
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (offset + value.length > data.length) { await reader.cancel(); throw new Error('Unexpected model download size.'); }
            data.set(value, offset); offset += value.length;
            if (performance.now() - last > 200) {
                status(`Downloading ${model.label}: ${(offset / 1e6).toFixed(1)} / ${(model.bytes / 1e6).toFixed(1)} MB`);
                last = performance.now();
            }
        }
        if (offset !== model.bytes) throw new Error('Incomplete model download. Retry when connected.');
        bytes = data.buffer;
    }
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map(x => x.toString(16).padStart(2, '0')).join('');
    if (hash !== model.sha256) {
        await cache?.delete(model.url);
        throw new Error('Model integrity check failed. Please retry.');
    }
    if (!cached) try { await cache?.put(model.url, new Response(bytes)); } catch { /* Detection works without persistent cache. */ }
    return bytes;
}

self.onmessage = async ({ data }) => {
    let session;
    const tensors = [];
    try {
        const { kind, width, height, rgba } = data;
        const model = api.models[kind];
        if (!model || width < 1 || height < 1 || width > 768 || height > 768 ||
            rgba?.length !== width * height * 4) throw new Error('Invalid detection request.');
        let bytes = await modelBytes(model);
        status('Preparing local model…');
        session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], logSeverityLevel: 3,
            graphOptimizationLevel: 'all', enableCpuMemArena: false, enableMemPattern: false });
        bytes = null;
        const input = new ort.Tensor('float32', api.normalize(rgba, kind), [1, 3, height, width]);
        tensors.push(input);
        const feeds = { [session.inputNames[0]]: input };
        if (kind === 'sky') {
            // This pinned Xenova export uses a fixed 64×64 attention mask, resized inside the graph.
            const mask = new ort.Tensor('int64', new BigInt64Array(64 * 64).fill(1n), [1, 64, 64]);
            tensors.push(mask);
            feeds.pixel_mask = mask;
        }
        status(`Detecting ${kind} locally… You can cancel or keep editing.`);
        const started = performance.now();
        const output = await session.run(feeds);
        tensors.push(...Object.values(output));
        const result = kind === 'sky' ? api.skyMask(output.logits, output.pred_masks) :
            api.subjectMask(output[session.outputNames[0]]);
        if (!api.reliable(result)) throw new Error(`No reliable ${kind} found. Try a clearer photo or use Brush / Select.`);
        postMessage({ type: 'result', ...result, milliseconds: Math.round(performance.now() - started) }, [result.alpha.buffer]);
    } catch (error) {
        postMessage({ type: 'error', text: error.message || 'Local detection failed. Try again or use Brush / Select.' });
    } finally {
        for (const tensor of tensors) tensor.dispose();
        await session?.release();
        self.close();
    }
};
