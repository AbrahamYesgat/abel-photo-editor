const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function target() {
    const listeners = new Map();
    return {
        disabled: false,
        addEventListener(type, fn, options) {
            if (!listeners.has(type)) listeners.set(type, new Map());
            listeners.get(type).set(fn, options);
        },
        removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
        fire(type, properties = {}) {
            const event = { preventDefault() {}, ...properties };
            for (const fn of [...(listeners.get(type)?.keys() || [])]) fn(event);
        },
        count() { return [...listeners.values()].reduce((n, set) => n + set.size, 0); },
        options(type) { return [...listeners.get(type).values()]; },
        setPointerCapture(id) { this.capture = id; },
        hasPointerCapture(id) { return this.capture === id; },
        releasePointerCapture(id) {
            this.capture = null;
            this.fire('lostpointercapture', { pointerId: id });
        },
    };
}

function harness(delayed = false) {
    const window = target();
    const element = target();
    const nodes = new Map();
    const document = { addEventListener() {}, getElementById(id) {
        if (!nodes.has(id)) nodes.set(id, { style: {}, hidden: true });
        return nodes.get(id);
    } };
    const timers = new Map();
    let timerId = 0;
    const context = vm.createContext({
        window, document, console,
        setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
        clearTimeout(id) { timers.delete(id); },
    });
    vm.runInContext(readFileSync(path.join(__dirname, '../js/app.js'), 'utf8') + '\nthis.App = App;', context);
    const app = Object.create(context.App.prototype);
    const beforeState = { exposure: 0 };
    const beforeMasks = [];
    Object.assign(app, {
        image: {}, state: { exposure: 0.8 },
        review: { canCompare: () => true, beforeState, beforeMasks },
        _render() { this.renders = (this.renders || 0) + 1; },
    });
    app._bindHoldCompare(element, delayed, true);
    const down = (properties = {}) => element.fire('pointerdown', {
        isPrimary: true, pointerId: 7, pointerType: 'touch', button: 0,
        clientX: 20, clientY: 20, ...properties,
    });
    const tick = () => {
        const pending = [...timers.values()];
        timers.clear();
        pending.forEach(fn => fn());
    };
    const restored = () => {
        assert.equal(app._comparisonState, null);
        assert.equal(app._comparisonMasks, null);
        assert.equal(app.showingOriginal, false);
        assert.equal(document.getElementById('compare-label').hidden, true);
        assert.equal(app.state.exposure, 0.8);
        assert.equal(window.count(), 0, 'temporary global listeners cleaned up');
        assert.equal(element.capture, null);
        tick();
        assert.equal(app._comparisonState, null, 'no delayed restart');
    };
    return { window, element, app, down, tick, restored };
}

for (const delayed of [false, true]) {
    for (const release of ['pointerup', 'pointercancel', 'touchend', 'touchcancel', 'scroll', 'lostpointercapture']) {
        test(`${delayed ? 'image' : 'button'} hold restores on ${release}, even after disabling`, () => {
            const h = harness(delayed);
            for (let i = 0; i < 3; i++) {
                h.element.disabled = false;
                h.down();
                h.tick();
                assert.equal(h.app._comparisonState.exposure, 0);
                assert.equal(h.app._comparisonMasks, h.app.review.beforeMasks);
                assert.ok(h.window.options('pointerup').every(options => options.capture && options.passive));
                h.element.disabled = true;
                (release === 'lostpointercapture' ? h.element : h.window).fire(release, { pointerId: 7 });
                h.restored();
            }
        });
    }
}

test('pending image hold cancels on release, movement, multitouch and global cleanup', () => {
    for (const cancel of [
        h => h.window.fire('touchend'),
        h => h.window.fire('touchmove', { touches: [{ clientX: 50, clientY: 20 }] }),
        h => h.window.fire('touchstart', { touches: [{}, {}] }),
        h => h.window.fire('pointerdown', { pointerId: 8 }),
        h => h.app._stopComparison(),
    ]) {
        const h = harness(true);
        h.down();
        cancel(h);
        h.tick();
        assert.ok(!h.app._comparisonState);
        assert.equal(h.window.count(), 0);
    }
});

test('touch compatibility events do not restart or double-render a completed hold', () => {
    const h = harness();
    h.down();
    h.window.fire('touchstart', { touches: [{}] });
    h.window.fire('pointerup', { pointerId: 7 });
    h.window.fire('touchend');
    h.element.fire('mousedown');
    h.element.fire('click');
    assert.equal(h.app.renders, 2);
    h.restored();
});

test('capture failure still releases via touch and unrelated pointerup is ignored', () => {
    const h = harness();
    h.element.setPointerCapture = () => { throw new Error('Pointer already gone'); };
    h.down();
    h.window.fire('pointerup', { pointerId: 8 });
    assert.ok(h.app._comparisonState);
    h.window.fire('touchend');
    assert.equal(h.app._comparisonState, null);
    assert.equal(h.window.count(), 0);
});

test('mouse missing-button movement and keyboard focus loss both restore', () => {
    const h = harness();
    h.down({ pointerType: 'mouse' });
    h.window.fire('pointermove', { pointerId: 7, pointerType: 'mouse', buttons: 0 });
    h.restored();
    for (const key of [' ', 'Enter']) {
        h.element.fire('keydown', { key, repeat: false });
        assert.ok(h.app._comparisonState);
        h.window.fire('keyup', { key });
        h.restored();
        h.element.fire('keydown', { key, repeat: false });
        h.element.fire('blur');
        h.restored();
    }
});

test('image comparison does not claim mask or crop gestures', () => {
    for (const mode of ['maskMode', 'cropTool']) {
        const h = harness(true);
        h.app[mode] = mode === 'maskMode' ? true : { active: true };
        h.down();
        h.tick();
        assert.ok(!h.app._comparisonState);
        assert.equal(h.element.capture, undefined);
        assert.equal(h.window.count(), 0);
    }
});
