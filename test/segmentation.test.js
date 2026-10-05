'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const api = require('../js/segmentation.js');
const { createServer } = require('../server/index.js');

test('bounded detector inputs preserve sky aspect ratio; subject explicitly follows square training contract', () => {
    assert.deepEqual(api.sizeFor('sky', 6000, 4000), { width: 768, height: 512 });
    assert.deepEqual(api.sizeFor('sky', 4000, 6000), { width: 512, height: 768 });
    assert.deepEqual(api.sizeFor('sky', 10000, 1000), { width: 768, height: 77 });
    assert.deepEqual(api.sizeFor('subject', 4000, 6000), { width: 320, height: 320 });
    for (const dims of [[0, 1], [NaN, 4000], [3, Infinity]])
        assert.throws(() => api.sizeFor('sky', ...dims));
    assert.throws(() => api.sizeFor('unknown', 10, 10));
});
test('RGB NCHW normalization ignores alpha and follows each model contract', () => {
    const sky = api.normalize(new Uint8ClampedArray([255, 0, 128, 99, 0, 255, 0, 255]), 'sky');
    assert.equal(sky.length, 6);
    assert.ok(Math.abs(sky[0] - (1 - .485) / .229) < 1e-5);
    assert.ok(Math.abs(sky[2] - (-.456) / .224) < 1e-5);
    const subject = api.normalize(new Uint8ClampedArray([128, 0, 64, 255]), 'subject');
    assert.ok(Math.abs(subject[0] - (1 - .485) / .229) < 1e-5);
    assert.ok(api.normalize(new Uint8ClampedArray(4), 'subject').every(Number.isFinite));
});
function skyFixture() {
    const logits = { dims: [1, 3, 251], data: new Float32Array(3 * 251).fill(-20) };
    logits.data[187] = 10; // COCO panoptic sky-other-merged, not old COCO-Stuff sky 157
    logits.data[251 + 197] = 10; // building-other-merged
    logits.data[502 + 250] = 10; // no-object
    const masks = { dims: [1, 3, 4, 4], data: new Float32Array(48).fill(-10) };
    masks.data.fill(10, 0, 8); masks.data.fill(10, 24, 32); masks.data.fill(100, 32);
    return { logits, masks };
}
test('sky uses semantic class competition, excludes no-object, and respects output row orientation', () => {
    const { logits, masks } = skyFixture(), result = api.skyMask(logits, masks);
    assert.equal(result.width, 4); assert.equal(result.height, 4);
    assert.deepEqual([...result.alpha], [...Array(8).fill(255), ...Array(8).fill(0)]);
    logits.data.fill(0);
    assert.ok(api.skyMask(logits, masks).alpha.every(v => v === 0), 'uncertain logits never invent sky');
});
test('sky panoptic masks compete as logits, not absolute sigmoid thresholds or class-weighted saturation', () => {
    const { logits, masks } = skyFixture();
    masks.data.fill(-10, 0, 8);
    masks.data.fill(-12, 16, 24);
    masks.data.fill(20, 8, 16);
    masks.data.fill(22, 24, 32);
    const result = api.skyMask(logits, masks);
    assert.deepEqual([...result.alpha], [...Array(8).fill(255), ...Array(8).fill(0)]);
    assert.equal(api.models.sky.skyClass, 187);
});
test('sky rejects malformed, mismatched and nonfinite output tensors', () => {
    assert.throws(() => api.skyMask({}, {}), /Unsupported/);
    const { logits, masks } = skyFixture();
    masks.dims[2] = 5;
    assert.throws(() => api.skyMask(logits, masks), /dimensions/);
    masks.dims[2] = 4; logits.data[0] = NaN;
    assert.throws(() => api.skyMask(logits, masks), /values/);
});
test('foreground reads fused probabilities, retaining soft edges without contrast-amplifying empty output', () => {
    const tensor = { dims: [1, 1, 320, 320], data: new Float32Array(320 * 320) };
    tensor.data.fill(.95, 0, 20000); tensor.data[20000] = .5;
    const result = api.subjectMask(tensor);
    assert.equal(result.alpha[0], 255); assert.equal(result.alpha[20000], 128);
    assert.equal(result.alpha[30000], 0); assert.equal(api.reliable(result), true);
    tensor.data.fill(.3);
    assert.ok(api.subjectMask(tensor).alpha.every(v => !v));
    tensor.data[0] = Infinity;
    assert.throws(() => api.subjectMask(tensor), /probabilities/);
    tensor.dims[2] = 1024;
    assert.throws(() => api.subjectMask(tensor), /Unsupported/);
});
test('empty, almost-empty and full-frame masks fail closed, grayscale output is opaque not photo brightness', () => {
    for (const value of [0, 100, 255]) assert.equal(api.reliable({
        alpha: new Uint8ClampedArray(100).fill(value), width: 10, height: 10 }), false);
    assert.deepEqual([...api.rgbaMask(new Uint8ClampedArray([0, 127, 255]))],
        [0, 0, 0, 255, 127, 127, 127, 255, 255, 255, 255, 255]);
});
test('presets only declare supported bounded local adjustments and do not accumulate deltas', () => {
    const allowed = new Set(['exposure', 'contrast', 'highlights', 'saturation', 'clarity', 'temperature', 'tint']);
    for (const preset of Object.values(api.presets)) for (const [key, value] of Object.entries(preset.adjustments)) {
        assert.ok(allowed.has(key));
        assert.ok(Number.isFinite(value) && Math.abs(value) <= (key === 'exposure' ? 5 : 100));
    }
    assert.deepEqual(api.presets.reset.adjustments, {});
});
test('runtime bytes and model URLs are pinned; licensed general foreground replaces restricted RMBG', () => {
    const dir = 'js/vendor/segmentation/';
    const integrity = JSON.parse(fs.readFileSync(dir + 'integrity.json'));
    assert.equal(integrity.version, '1.22.0');
    for (const [file, hash] of Object.entries(integrity.hashes))
        assert.equal(createHash('sha256').update(fs.readFileSync(dir + file)).digest('hex'), hash, file);
    for (const model of Object.values(api.models)) {
        assert.match(model.url, /^https:\/\/huggingface.co\/[^/]+\/[^/]+\/resolve\/[a-f0-9]{40}\//);
        assert.match(model.sha256, /^[a-f0-9]{64}$/);
    }
    assert.doesNotMatch(fs.readFileSync('js/app.js', 'utf8'), /briaai\/RMBG|_segPipeline/);
});
test('static host serves exact worker/runtime assets with correct MIME, not arbitrary files', async t => {
    const server = createServer({ env: {} });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const [file, type] of [['js/segmentation.js', 'text/javascript'],
        ['js/segmentation-worker.js', 'text/javascript'],
        ['js/vendor/segmentation/ort.wasm.min.mjs', 'text/javascript'],
        ['js/vendor/segmentation/ort-wasm-simd-threaded.mjs', 'text/javascript'],
        ['js/vendor/segmentation/ort-wasm-simd-threaded.wasm', 'application/wasm'],
        ['js/vendor/segmentation/NOTICE.txt', 'text/plain']]) {
        const response = await fetch(`${base}/${file}`);
        assert.equal(response.status, 200, file);
        assert.ok(response.headers.get('content-type').startsWith(type), file);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), fs.readFileSync(file));
    }
    assert.equal((await fetch(base + '/node_modules/onnxruntime-web/package.json')).status, 404);
});
