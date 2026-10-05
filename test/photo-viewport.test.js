const { test } = require('node:test');
const assert = require('node:assert/strict');
const PhotoViewport = require('../js/photo-viewport.js');

function view() {
    return Object.assign(Object.create(PhotoViewport.prototype), {
        scale: 1, x: 0, y: 0, width: 400, height: 300, viewWidth: 400, viewHeight: 300,
        draw() {},
    });
}

test('photo zoom anchors the image point beneath the centroid', () => {
    const v = view();
    v.zoomAt(3, { x: 50, y: -25 });
    assert.equal(v.scale, 3);
    assert.equal((50 - v.x) / v.scale, 50);
    assert.equal((-25 - v.y) / v.scale, -25);
    v.zoomAt(1, { x: 50, y: -25 });
    assert.equal(v.x, 0);
    assert.equal(v.y, 0);
});

test('fit/8x bounds and centered short axis cannot lose the image', () => {
    const v = view();
    v.zoomAt(100, { x: 0, y: 0 });
    assert.equal(v.scale, 8);
    v.x = 1e6; v.y = -1e6; v.clamp();
    assert.equal(v.x, 1400);
    assert.equal(v.y, -1050);
    v.zoomAt(.01, { x: 0, y: 0 });
    assert.equal(v.scale, 1);
    assert.equal(v.x, 0);
    assert.equal(v.y, 0);
    v.height = 50; v.scale = 2; v.y = 50; v.clamp();
    assert.equal(v.y, 0);
});

test('staged touch painting commits once and established strokes finish once', () => {
    const events = [];
    const v = view();
    v.app = { maskMode: true, _canvasPointerDown: p => events.push(['down', p]),
        _canvasPointerMove: p => events.push(['move', p]), _canvasPointerUp: () => events.push(['up']) };
    v.pending = [{ clientX: 3 }, { clientX: 8 }];
    v.commitMask(); v.commitMask(); v.finishMask(); v.finishMask();
    assert.deepEqual(events, [['down', { clientX: 3 }], ['move', { clientX: 8 }], ['up']]);
});
