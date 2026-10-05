'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const geometry = require('../js/polygon-geometry.js');
const points = values => values.map(([x, y]) => ({ x, y }));
const triangle = points([[0, 0], [1, 0], [0, 1]]);

test('simple convex/concave polygons support either winding, image corners and straight intermediate edges', () => {
    for (const values of [
        triangle, points([[0, 0], [.5, 0], [1, 0], [1, 1], [0, 1]]),
        points([[.1, .1], [.9, .1], [.9, .9], [.5, .4], [.1, .9]]),
        points([[0, 0], [1, 0], [1, .2], [.2, .2], [.2, 1], [0, 1]]),
    ]) {
        assert.equal(geometry.error(values), '');
        assert.equal(geometry.error(values.toReversed()), '');
    }
});

test('empty, duplicate, collinear, zero-area, crossing, touching and overlapping polygons are rejected', () => {
    for (const value of [
        null, {}, [], new Array(3), triangle.slice(0, 2), [...triangle, triangle[0]],
        points([[0, 0], [.5, .5], [1, 1]]),
        points([[0, 0], [1, 1], [0, 1], [1, 0]]),
        points([[0, 0], [1, 0], [.5, 0], [.5, 1]]),
        points([[0, 0], [1, 0], [1, 1], [.5, 0], [0, 1]]),
        points([[0, 0], [1, 0], [1, 1e-10]]),
        points([[0, 0], [NaN, 0], [0, 1]]),
        points([[0, 0], [Infinity, 0], [0, 1]]),
        points([[0, 0], [1.01, 0], [0, 1]]),
        points([[0, 0], ['1', 0], [0, 1]]),
    ]) assert.ok(geometry.error(value), JSON.stringify(value));
});

test('bounded 64-point geometry and finite feather validate before any raster allocation', () => {
    const ring = Array.from({ length: 64 }, (_, i) => ({
        x: .5 + .45 * Math.cos(i * Math.PI / 32), y: .5 + .45 * Math.sin(i * Math.PI / 32),
    }));
    assert.equal(geometry.error(ring), '');
    assert.match(geometry.error([...ring, { x: .8, y: .8 }]), /64/);
    assert.ok(geometry.validParams({ points: triangle, feather: 0 }));
    assert.ok(geometry.validParams({ points: triangle, feather: 100 }));
    for (const feather of [NaN, Infinity, -1, 101, '20', undefined])
        assert.ok(!geometry.validParams({ points: triangle, feather }));
    assert.throws(() => geometry.rasterize(null, 2000, 2000, triangle, NaN), /Invalid/);
    assert.throws(() => geometry.rasterize(null, 2000, 2000, [], 0), /3 corners/);
});

function engine() {
    const calls = [];
    const ctx = new Proxy({}, { get: (target, key) => target[key] || (() => {}) });
    ctx.fillRect = (...args) => calls.push([ctx.fillStyle, ...args]);
    ctx.createLinearGradient = ctx.createRadialGradient = () => ({ addColorStop() {} });
    const context = vm.createContext({ PolygonGeometry: geometry,
        ManualControls: require('../js/manual-controls.js'),
        document: { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) } });
    vm.runInContext(fs.readFileSync('js/mask-engine.js', 'utf8') + '\nthis.MaskEngine = MaskEngine;', context);
    return { engine: new context.MaskEngine({ imageWidth: 6000, imageHeight: 4000 }), calls };
}

test('polygon starts black, uses bounded normalized raster geometry and copies point ownership', () => {
    const h = engine(), m = h.engine.createMask('polygon');
    assert.equal(h.calls[0][0], 'black');
    assert.equal(m.canvas.width, 2048);
    const input = triangle.map(p => ({ ...p }));
    assert.equal(h.engine.setPolygon(m, input, 40), true);
    assert.equal(m.revision, 1);
    input[0].x = .2;
    assert.equal(m.params.points[0].x, 0);
    assert.equal(h.engine.setPolygon(m, [], 0), false);
    assert.equal(m.revision, 1, 'invalid edit does not touch pixels or revision');
    const saved = h.engine.captureMasks();
    h.engine.restoreMasks(saved);
    assert.equal(h.engine.getActiveMask().params.points[0].x, 0);
    h.engine.restoreMasks([{ ...saved[0], params: { points: [], feather: 0 } }]);
    assert.equal(h.engine.masks.length, 0, 'invalid stored geometry cannot become a full-photo mask');
});

test('crop bakes polygon coverage with adjustment/inversion metadata and repeated crop support', () => {
    const h = engine(), m = h.engine.createMask('polygon');
    h.engine.setPolygon(m, triangle, 40);
    m.inverted = true; m.opacity = .4; m.adjustments.exposure = -.5;
    const crop = { x: 1000, y: 1000, width: 2000, height: 2000, rotation: 12,
        sourceWidth: 6000, sourceHeight: 4000 };
    const [baked] = h.engine.cropDetectedMasks(crop);
    assert.equal(baked.type, 'brush');
    assert.equal(baked.polygonBaked, true);
    assert.equal(baked.params, null);
    assert.equal(baked.inverted, true);
    assert.equal(baked.opacity, .4);
    assert.equal(baked.adjustments.exposure, -.5);
    assert.equal(m.type, 'polygon', 'pre-crop geometry retained');
    h.engine.masks = [baked];
    assert.equal(h.engine.cropDetectedMasks(crop).length, 1);
    assert.match(baked.reason, /Undo crop restores/);
});

test('polygon geometry and controller are served locally and loaded in dependency order', async t => {
    const { createServer } = require('../server/index.js');
    const server = createServer({ env: {} });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    for (const file of ['polygon-geometry.js', 'polygon-tool.js']) {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/js/${file}`);
        assert.equal(response.status, 200);
        assert.equal(await response.text(), fs.readFileSync(`js/${file}`, 'utf8'));
    }
    const html = fs.readFileSync('index.html', 'utf8');
    assert.ok(html.indexOf('js/polygon-geometry.js') < html.indexOf('js/mask-engine.js'));
    assert.ok(html.indexOf('js/polygon-tool.js') < html.indexOf('js/app.js'));
});
