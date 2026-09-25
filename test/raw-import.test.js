'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const policy = require('../js/raw-policy.js');
const { createServer } = require('../server/index.js');

function header(brand = 'crx ') {
    const bytes = new Uint8Array(24);
    new DataView(bytes.buffer).setUint32(0, 24);
    bytes.set(Buffer.from(`ftyp${brand}`), 4);
    bytes.set(Buffer.from('isom'), 16);
    return bytes;
}
test('CR3 recognizes extension/MIME case-insensitively but validates Canon BMFF brand', () => {
    for (const type of ['', 'application/octet-stream', 'image/x-canon-cr3']) {
        assert.equal(policy.isCandidate({ name: 'photo.Cr3', type }), true);
        assert.equal(policy.isImage({ name: 'photo.CR3', type }), true);
    }
    assert.equal(policy.isCandidate({ name: '', type: 'image/canon-cr3' }), true);
    assert.equal(policy.isCR3(header()), true);
    assert.equal(policy.isCR3(header('heic')), false);
    assert.equal(policy.isCR3(header('isom')), false);
    assert.equal(policy.isCR3(new Uint8Array([0xff, 0xd8, 0xff])), false);
    assert.equal(policy.isCR3(header().subarray(0, 20)), false);
    const compatible = header('isom');
    compatible.set(Buffer.from('crx '), 20);
    assert.equal(policy.isCR3(compatible), true);
    for (const extension of ['jpg', 'PNG', 'webp', 'heic', 'tiff', 'bmp', 'gif']) {
        assert.equal(policy.isImage({ name: `photo.${extension}`, type: '' }), true);
    }
});
test('RAW budgets check size before reading, sensor dimensions before unpack and explicit half-size', () => {
    assert.throws(() => policy.checkSize(0, false), /truncated/);
    assert.throws(() => policy.checkSize(101 * 1024 * 1024, false), /100 MiB/);
    assert.throws(() => policy.checkSize(61 * 1024 * 1024, true), /60 MiB/);
    const eosR = { raw_width: 6888, raw_height: 4546, width: 6742, height: 4498 };
    policy.checkDimensions(eosR, 28e6, false, false);
    policy.checkDimensions(eosR, 28e6, true, true);
    assert.throws(() => policy.checkDimensions(eosR, 28e6, true, false), /Smaller RAW/);
    assert.throws(() => policy.checkDimensions({ ...eosR, raw_width: 99999 }, 28e6, false, true), /dimensions/);
    assert.throws(() => policy.checkDimensions({ ...eosR, width: NaN }, 28e6, false, true), /dimensions/);
});
function harness() {
    const workers = [], events = {}, timers = new Map();
    let timerID = 0;
    class Worker {
        constructor(url, options) { Object.assign(this, { url: String(url), options }); workers.push(this); }
        postMessage(message, transfer) { this.message = message; this.transfer = transfer; }
        terminate() { this.terminated = true; }
        complete() { this.onmessage({ data: { bitmap: { width: 10, height: 20 }, info: { decoder: 'LibRaw' } } }); }
    }
    const context = { RawPolicy: policy, navigator: { userAgent: 'Desktop', deviceMemory: 8 },
        document: { currentScript: { src: 'https://example.com/project/js/image-import.js' } },
        Worker, WebAssembly, createImageBitmap() {}, URL, Uint8Array, DOMException, console,
        setTimeout(fn) { timers.set(++timerID, fn); return timerID; },
        clearTimeout(id) { timers.delete(id); },
        addEventListener(name, fn) { events[name] = fn; } };
    context.window = context;
    vm.runInNewContext(readFileSync('js/image-import.js', 'utf8'), context);
    const file = new Blob([header()]);
    file.name = 'photo.CR3';
    return { ...context.ImageImport, workers, file, timers, events };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test('RAW transfer is queued one file at a time, relative to project subpath; workers released', async () => {
    const h = harness();
    const first = h.decode(h.file), second = h.decode(h.file);
    await tick();
    assert.equal(h.workers.length, 1);
    assert.equal(h.workers[0].url, 'https://example.com/project/js/raw-worker.js?v=cr3-1');
    assert.equal(h.workers[0].transfer[0], h.workers[0].message.buffer);
    h.workers[0].complete();
    await first; await tick();
    assert.equal(h.workers[0].terminated, true);
    assert.equal(h.workers.length, 2);
    h.workers[1].complete(); await second;
    assert.equal(h.workers[1].terminated, true);
    assert.equal(h.timers.size, 0);
});
test('RAW cancellation, module failure, malformed reply, timeout and page exit release workers', async t => {
    for (const kind of ['abort', 'error', 'reply', 'timeout', 'pagehide']) {
        await t.test(kind, async () => {
            const h = harness(), controller = new AbortController();
            const pending = h.decode(h.file, { signal: controller.signal });
            const rejection = assert.rejects(pending);
            await tick();
            const worker = h.workers[0];
            if (kind === 'abort') controller.abort();
            if (kind === 'error') worker.onerror();
            if (kind === 'reply') worker.onmessage({ data: {} });
            if (kind === 'timeout') [...h.timers.values()][0]();
            if (kind === 'pagehide') h.events.pagehide();
            await rejection;
            assert.equal(worker.terminated, true);
            assert.equal(h.timers.size, 0);
        });
    }
});
test('already cancelled and oversized CR3 requests never start a worker', async () => {
    const h = harness(), controller = new AbortController();
    controller.abort();
    await assert.rejects(h.decode(h.file, { signal: controller.signal }), { name: 'AbortError' });
    const oversized = { name: 'huge.CR3', size: 101 * 1024 * 1024, slice: () => h.file };
    await assert.rejects(h.decode(oversized), /100 MiB/);
    assert.equal(h.workers.length, 0);
});
test('vendor checksums pin decoder bytes, worker develops sensors rather than extracting previews', () => {
    const manifest = require('../js/vendor/libraw/integrity.json');
    for (const [name, hash] of Object.entries(manifest.files)) {
        assert.equal(createHash('sha256').update(readFileSync(`js/vendor/libraw/${name}`)).digest('hex'), hash);
    }
    const source = readFileSync('js/raw-worker.js', 'utf8');
    assert.match(source, /raw\.imageData\(\)/);
    assert.doesNotMatch(source, /raw\.thumbnailData\(/);
    assert.ok(source.indexOf('RawPolicy.checkDimensions') < source.indexOf('raw.imageData()'));
    assert.match(source, /useCameraWb: true/);
    assert.match(source, /gamm: \[1 \/ 2.4, 12.92\]/);
});
test('all RAW public assets have valid MIME, while arbitrary vendor/server paths stay private', async t => {
    const server = createServer({ env: {} });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const name of ['raw-policy.js', 'raw-worker.js', 'image-import.js', 'vendor/libraw/libraw.js']) {
        const response = await fetch(`${base}/js/${name}`);
        assert.equal(response.status, 200, name);
        assert.match(response.headers.get('content-type'), /javascript/);
        await response.arrayBuffer();
    }
    const wasm = await fetch(`${base}/js/vendor/libraw/libraw.wasm`);
    assert.equal(wasm.headers.get('content-type'), 'application/wasm');
    const bytes = await wasm.arrayBuffer();
    assert.equal(WebAssembly.validate(bytes), true);
    for (const name of ['LICENSE', 'LICENSE.CDDL', 'COPYRIGHT', 'LICENSE-LCMS', 'NOTICE.txt', 'LICENSE-JPEG', 'LICENSE-PNG', 'LICENSE-ZLIB', 'LICENSE-EMSCRIPTEN', 'LICENSE-LIBRAW-NOTICES']) {
        const response = await fetch(`${base}/js/vendor/libraw/${name}`);
        assert.equal(response.status, 200, name);
        assert.match(response.headers.get('content-type'), /text\/plain/);
        await response.text();
    }
    for (const file of ['package-lock.json', '.env', 'js/vendor/libraw/secret.txt', 'server/index.js']) {
        const response = await fetch(`${base}/${file}`);
        assert.equal(response.status, 404);
        await response.text();
    }
});
