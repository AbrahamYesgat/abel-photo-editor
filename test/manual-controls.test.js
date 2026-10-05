'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const manual = require('../js/manual-controls.js');
const review = require('../js/review-contract.js');
const { createServer } = require('../server/index.js');

test('every shared manual control has a shader uniform and neutral default', () => {
    const shader = fs.readFileSync('js/shaders.js', 'utf8');
    const renderer = fs.readFileSync('js/gl-engine.js', 'utf8');
    assert.equal(Object.keys(manual.controls).length, 14);
    for (const [key, c] of Object.entries(manual.controls)) {
        assert.match(shader, new RegExp(`uniform float u_${key};`));
        assert.match(renderer, new RegExp(`gl.uniform1f\\(u.u_${key},`));
        assert.equal(manual.defaults()[key], 0);
        assert.ok(c.min <= 0 && c.max > 0 && c.step > 0);
    }
    assert.ok(!Object.hasOwn(manual.controls, 'noiseLuma'));
    assert.ok(!Object.hasOwn(manual.controls, 'noiseColor'));
    assert.ok(!Object.hasOwn(review.controls, 'dehaze'));
    assert.ok(!Object.hasOwn(review.maskControls, 'sharpenAmount'));
    assert.ok(!Object.hasOwn(review.maskControls, 'dehaze'));
});

test('manual defaults, legacy migration and finite bounded additive merges', () => {
    assert.deepEqual(manual.normalize({ exposure: .3 }), { ...manual.defaults(), exposure: .3 });
    const input = { dehaze: Infinity, whites: '40', blacks: NaN, sharpenAmount: -4, texture: null, noiseLuma: 90 };
    assert.deepEqual(manual.normalize(input), manual.defaults());
    const base = { ...manual.defaults(), dehaze: 90, sharpenAmount: 120, exposure: 4.5, marker: true };
    const merged = manual.merge(base, { dehaze: 50, sharpenAmount: 100, exposure: 2, noiseLuma: 90 });
    assert.equal(merged.dehaze, 100);
    assert.equal(merged.sharpenAmount, 150);
    assert.equal(merged.exposure, 5);
    assert.equal(merged.marker, true);
    assert.ok(!Object.hasOwn(merged, 'noiseLuma'));
    assert.equal(base.dehaze, 90);
    assert.equal(manual.merge(base, { exposure: 2 }, false).exposure, 6.5, 'legacy normal-layer offsets retained');
    for (const key of Object.keys(manual.controls)) {
        for (const value of [-1e100, -100, 0, 100, 1e100, Infinity, NaN, null, '10']) {
            const result = manual.merge({ [key]: value }, { [key]: value });
            assert.ok(Number.isFinite(result[key]));
            assert.ok(result[key] >= manual.controls[key].min && result[key] <= manual.controls[key].max);
        }
    }
});

test('legacy mask descriptions and restored snapshots have identical neutral fields', () => {
    const canvas = { width: 100, height: 100, getContext: () => ({ drawImage() {} }) };
    const context = vm.createContext({ ManualControls: manual, document: { createElement: () => ({ ...canvas }) } });
    vm.runInContext(fs.readFileSync('js/mask-engine.js', 'utf8') + '\nthis.MaskEngine = MaskEngine;', context);
    const engine = new context.MaskEngine({});
    engine.masks = [{ id: 1, type: 'brush', canvas, visible: true, adjustments: { whites: 17 } }];
    const before = JSON.stringify(engine.describeMasks());
    const saved = engine.captureMasks();
    engine.restoreMasks(saved);
    assert.equal(JSON.stringify(engine.describeMasks()), before, 'restoring legacy defaults must not fork redo history');
    assert.equal(engine.masks[0].adjustments.whites, 17);
    assert.equal(engine.masks[0].adjustments.dehaze, 0);
});

test('manual capabilities load in browser and are served by the static allowlist', async t => {
    const context = vm.createContext({});
    vm.runInContext(fs.readFileSync('js/manual-controls.js', 'utf8'), context);
    assert.equal(context.ManualControls.controls.whites.label, 'Whites');
    const server = createServer({ env: {} });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/js/manual-controls.js`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), fs.readFileSync('js/manual-controls.js', 'utf8'));
    const index = fs.readFileSync('index.html', 'utf8');
    assert.ok(index.indexOf('js/manual-controls.js') < index.indexOf('js/gl-engine.js'));
});
