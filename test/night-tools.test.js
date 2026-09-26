'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const NightTools = require('../js/night-tools.js');
const ReviewContract = require('../js/review-contract.js');

test('night settings are bounded, finite, opt-in and not AI recipe controls', () => {
    assert.deepEqual(NightTools.settings(), {
        noiseLuma: 0, noiseColor: 0, motionAmount: 0, motionLength: 4, motionAngle: 0
    });
    assert.deepEqual(NightTools.settings({ noiseLuma: Infinity, noiseColor: 1000, motionAmount: -1,
        motionLength: NaN, motionAngle: '90' }), {
        noiseLuma: 0, noiseColor: 100, motionAmount: 0, motionLength: 4, motionAngle: 0
    });
    for (const key of Object.keys(NightTools.settings())) {
        assert.equal(ReviewContract.controls[key], undefined);
        assert.equal(ReviewContract.detailControls[key], undefined);
    }
});

test('finite Wiener kernels conserve DC, are symmetric and bound spectral amplification', () => {
    for (const length of [1, 1.5, 4, 7, 12, Infinity, NaN]) {
        const k = NightTools.kernel(length);
        assert.equal(k.length, 49);
        assert.ok(Math.abs(k.reduce((sum, x) => sum + x, 0) - 1) < 1e-6);
        for (let i = 0; i < k.length; i++) {
            assert.ok(Number.isFinite(k[i]));
            assert.ok(Math.abs(k[i] - k[48 - i]) < 1e-6);
        }
        for (let f = 0; f <= 128; f++) {
            const gain = k.reduce((sum, x, i) => sum + x * Math.cos(Math.PI * f / 128 * (i - 24)), 0);
            assert.ok(Math.abs(gain) < 2.05, `bounded gain ${gain} at length ${length}`);
        }
    }
    const identity = NightTools.kernel(1);
    assert.ok(Math.abs(identity[24] - 1) < 1e-6);
});

test('Wiener inverse reduces error on a known line-blurred signal instead of just unsharp masking', () => {
    const signal = Array.from({ length: 512 }, (_, x) => 0.45 + 0.18 * Math.sin(x * 0.42) + 0.1 * Math.sin(x * 0.15));
    const convolve = (input, weights) => input.map((_, x) => weights.reduce((sum, w, i) =>
        sum + w * input[Math.max(0, Math.min(input.length - 1, x + i - (weights.length - 1) / 2))], 0));
    const blur = convolve(signal, Array(7).fill(1 / 7));
    const restored = convolve(blur, NightTools.kernel(7));
    const mse = data => data.slice(40, -40).reduce((sum, v, x) => sum + (v - signal[x + 40]) ** 2, 0);
    assert.ok(mse(restored) < mse(blur) * 0.25);
});

test('night actions preserve other settings, are idempotent and have one-step undo/redo', () => {
    const nodes = new Map();
    const context = vm.createContext({
        NightTools, console, clearTimeout, setTimeout,
        document: { addEventListener() {}, getElementById(id) {
            if (!nodes.has(id)) nodes.set(id, {});
            return nodes.get(id);
        } },
        window: { addEventListener() {} }
    });
    vm.runInContext(fs.readFileSync(require.resolve('../js/app.js'), 'utf8') + '\nthis.App = App;', context);
    const app = Object.create(context.App.prototype);
    Object.assign(app, {
        image: {}, imageWidth: 6000, imageHeight: 4000, state: context.App.prototype._defaultState(),
        history: [], historyIndex: -1, sliders: {},
        maskEngine: { describeMasks: () => [], captureMasks: () => [], restoreMasks() {} },
        _stopComparison() {}, _render() {}, _exitMaskMode() {}, _updateMaskList() {}, _syncMaskSliders() {}
    });
    app.state.exposure = 0.6;
    app.state.motionAmount = 35;
    app._pushHistory();
    app._setNight({ noiseLuma: 60, noiseColor: 70 });
    assert.equal(app.history.length, 2);
    assert.equal(app.state.exposure, 0.6);
    assert.equal(app.state.motionAmount, 35);
    app._setNight({ noiseLuma: 60, noiseColor: 70 });
    assert.equal(app.history.length, 2);
    app._undo();
    assert.equal(app.state.noiseLuma, 0);
    assert.equal(app.state.motionAmount, 35);
    app._redo();
    assert.equal(app.state.noiseLuma, 60);
    app.cropTool = { active: true };
    app._setNight({ motionAmount: 100 });
    assert.equal(app.state.motionAmount, 35);
});
