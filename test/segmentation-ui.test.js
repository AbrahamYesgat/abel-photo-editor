'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const SemanticMasks = require('../js/segmentation.js');

function harness() {
    const elements = new Map(), workers = [], timers = new Map();
    let nextTimer = 0;
    const element = () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, hidden: false,
        getContext: () => ({ drawImage() {}, fillRect() {}, putImageData() {},
            getImageData: () => ({ data: new Uint8ClampedArray(768 * 512 * 4) }) }) });
    const document = { baseURI: 'https://example.com/editor/', addEventListener() {},
        getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
        createElement: element, querySelector: () => ({ click() {} }) };
    class Worker {
        constructor(url) { this.url = url.href; workers.push(this); }
        postMessage(message, transfer) { this.message = message; this.transfer = transfer; }
        terminate() { this.terminated = true; }
        send(data) { this.onmessage({ data }); }
    }
    const schedule = fn => { timers.set(++nextTimer, fn); return nextTimer; };
    const context = vm.createContext({ document, window: { addEventListener() {} }, Worker, URL,
        SemanticMasks, console, Uint8ClampedArray, isSecureContext: true,
        ImageData: class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } },
        setTimeout: schedule, setInterval: schedule, clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id) });
    vm.runInContext(fs.readFileSync('js/mask-engine.js', 'utf8') + '\nthis.MaskEngine = MaskEngine;', context);
    vm.runInContext(fs.readFileSync('js/app.js', 'utf8') + '\nthis.App = App;', context);
    const app = Object.create(context.App.prototype);
    Object.assign(app, { image: {}, imageWidth: 6000, imageHeight: 4000, state: { exposure: .2 },
        history: [], historyIndex: -1, sliders: {}, _stopComparison() {}, _render() {},
        _updateMaskList() {}, _updateHistoryButtons() {}, _syncMaskSliders() {},
        review: { invalidate() {} } });
    app.maskEngine = new context.MaskEngine(app);
    app._pushHistory();
    return { app, workers, timers, elements };
}
function result() {
    const alpha = new Uint8ClampedArray(32 * 32);
    alpha.fill(255, 0, 512);
    return { type: 'result', alpha, width: 32, height: 32, milliseconds: 1000 };
}
test('explicit detect sends bounded source pixels to one subpath-safe module worker, no history until success', () => {
    const h = harness(), { app } = h;
    app._detectMask('sky');
    assert.equal(h.workers.length, 1);
    assert.equal(h.workers[0].url, 'https://example.com/editor/js/segmentation-worker.js?v=semantic-1');
    assert.equal(h.workers[0].transfer[0], h.workers[0].message.rgba.buffer);
    app._detectMask('subject');
    assert.equal(h.workers.length, 1);
    assert.equal(app.history.length, 1);
    h.workers[0].send(result());
    assert.equal(app.maskEngine.masks.length, 1);
    assert.equal(app.maskEngine.getActiveMask().type, 'brush');
    assert.equal(app.maskEngine.getActiveMask().name, 'Sky');
    assert.equal(app.maskEngine.getActiveMask().blend, 'additive');
    assert.equal(app.history.length, 2);
    assert.equal(h.workers[0].terminated, true);
    assert.equal(h.timers.size, 0);
    assert.equal(app.state.exposure, .2);
    assert.equal(app.history[1].masks[0].detection.kind, 'sky');
});
test('cancel, source replacement, crop, tone change and mask refinement discard late replies without history', () => {
    for (const kind of ['cancel', 'source', 'crop', 'tone', 'curves', 'mask']) {
        const { app, workers, timers } = harness();
        if (kind === 'mask') { app.maskEngine.createMask('brush'); app._pushHistory(); }
        const history = app.history.length, count = app.maskEngine.masks.length;
        app._detectMask('sky');
        if (kind === 'cancel') app._cancelDetection();
        if (kind === 'source') app.image = {};
        if (kind === 'crop') app.cropTool = { active: true };
        if (kind === 'tone') app.state.exposure = .3;
        if (kind === 'curves') app.curveEditor = { channels: { rgb: [{ x: 0, y: 50 }] } };
        if (kind === 'mask') app.maskEngine.touch(app.maskEngine.getActiveMask());
        workers[0].send(result());
        assert.equal(app.maskEngine.masks.length, count, kind);
        assert.equal(app.history.length, history, kind);
        assert.equal(workers[0].terminated, true, kind);
        assert.equal(timers.size, 0);
    }
});
test('no reliable region, worker errors and timeout never apply an empty/full mask or retain resources', () => {
    for (const kind of ['empty', 'full', 'download', 'worker', 'timeout']) {
        const { app, workers, timers } = harness();
        app._detectMask('subject');
        if (kind === 'empty' || kind === 'full') {
            const r = result(); r.alpha.fill(kind === 'full' ? 255 : 0); workers[0].send(r);
        }
        if (kind === 'download') workers[0].send({ type: 'error', text: 'Download failed' });
        if (kind === 'worker') workers[0].onerror({ preventDefault() {} });
        if (kind === 'timeout') [...timers.values()][1]();
        assert.equal(app.history.length, 1, kind);
        assert.equal(app.maskEngine.masks.length, 0, kind);
        assert.equal(workers[0].terminated, true, kind);
        assert.equal(timers.size, 0);
    }
});
test('sky presets guard selection and inversion; absolute replacement preserves shape, other masks, global edits', () => {
    const { app, workers } = harness();
    app.maskEngine.createMask('brush');
    app._pushHistory();
    const old = app.maskEngine.masks[0];
    app._applySkyPreset('sunset');
    assert.equal(old.adjustments.temperature, 0);
    app._detectMask('sky'); workers[0].send(result());
    const mask = app.maskEngine.getActiveMask(), canvas = mask.canvas, revision = mask.revision;
    app._applySkyPreset('sunset');
    assert.equal(mask.adjustments.temperature, 18);
    const history = app.history.length;
    app._applySkyPreset('sunset');
    assert.equal(app.history.length, history);
    app._applySkyPreset('blue');
    assert.equal(mask.adjustments.temperature, -15);
    assert.equal(mask.adjustments.tint, 0);
    assert.equal(mask.canvas, canvas);
    assert.equal(mask.revision, revision);
    assert.equal(old.adjustments.temperature, 0);
    assert.equal(app.state.exposure, .2);
    mask.inverted = true;
    app._applySkyPreset('sunset');
    assert.equal(mask.adjustments.temperature, -15);
    mask.inverted = false;
    app._applySkyPreset('reset');
    assert.ok(Object.values(mask.adjustments).every(v => v === 0));
});
test('cancelled worker messages and queued timers cannot cancel a newer detection', () => {
    const { app, workers, timers } = harness();
    app._detectMask('sky');
    const oldTimers = [...timers.values()];
    app._cancelDetection();
    app._detectMask('subject');
    for (const callback of oldTimers) callback();
    workers[0].send(result());
    assert.equal(app._detection.kind, 'subject');
    assert.equal(workers[1].terminated, undefined);
    workers[1].send(result());
    assert.equal(app.maskEngine.getActiveMask().name, 'Subject');
});
test('zero-feather brush retains a nondegenerate gradient for paint and erase', () => {
    const { app } = harness();
    const mask = app.maskEngine.createMask('brush');
    let radii;
    mask.ctx.createRadialGradient = (x, y, inner, endX, endY, outer) => {
        radii = [inner, outer];
        return { addColorStop() {} };
    };
    app.maskEngine.brushFeather = 0;
    app.maskEngine._brushStroke(mask, 10, 10);
    assert.ok(radii[0] < radii[1] && radii[0] >= 0);
    app.maskEngine.eraseMode = true;
    app.maskEngine._brushStroke(mask, 10, 10);
    assert.ok(radii[0] < radii[1]);
});
test('mask/history allocation failure rolls back detected creation without a phantom mask', () => {
    const { app, workers } = harness();
    app._detectMask('sky');
    const original = app._pushHistory;
    app._pushHistory = function () {
        if (this.maskEngine.masks.length) throw new Error('Out of memory');
        return original.call(this);
    };
    workers[0].send(result());
    assert.equal(app.maskEngine.masks.length, 0);
    assert.equal(app.maskEngine.activeMaskIndex, -1);
    assert.equal(app.history.length, 1);
    assert.equal(app._detection, null);
});
