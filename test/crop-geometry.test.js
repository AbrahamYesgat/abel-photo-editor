const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../js/crop-geometry.js');
const crop = { version: 1, sourceWidth: 6000, sourceHeight: 4000,
    x: 1200, y: 400, width: 3000, height: 2400, rotation: 0 };

test('crop is a reversible source-coordinate viewport, including rotation and portrait sources', () => {
    for (const [width, height] of [[6000, 4000], [4000, 6000]]) {
        for (const rotation of [-45, -4.2, 0, 17, 45]) {
            const m = G.matrix({ ...crop, rotation }, width, height);
            for (const p of [{ x: 0, y: 0 }, { x: .31, y: .79 }, { x: 1, y: 1 }]) {
                const result = G.point(G.inverse(m), G.point(m, p));
                assert.ok(Math.abs(result.x - p.x) < 1e-12);
                assert.ok(Math.abs(result.y - p.y) < 1e-12);
            }
        }
    }
    const center = G.point(G.matrix(crop, 6000, 4000), { x: .5, y: .5 });
    assert.ok(Math.abs(center.x - .45) < 1e-12 && Math.abs(center.y - .4) < 1e-12);
});

test('saved crop validation rejects corruption, wrong source and unbounded allocations', () => {
    assert.equal(G.validate(null, 6000, 4000), null);
    assert.equal(G.validate({ ...crop, x: 0, y: 0, width: 6000, height: 4000 }, 6000, 4000), null);
    for (const bad of [{ x: -20000 }, { y: NaN }, { width: Infinity }, { width: 0 }, { x: .5 },
        { height: 8000 }, { sourceWidth: 2000 }, { rotation: 181 }, { version: 2 }, { width: '400' }])
        assert.throws(() => G.validate({ ...crop, ...bad }, 6000, 4000), /Saved crop/);
});

test('legacy repeated crops compose back to the original source without rasterizing it', () => {
    const next = { sourceWidth: 3000, sourceHeight: 2400, x: 200, y: 100, width: 1800, height: 1200, rotation: 0 };
    const migrated = G.legacy([crop, next], 6000, 4000);
    assert.deepEqual(migrated, { ...crop, x: 1400, y: 500, width: 1800, height: 1200 });
    assert.throws(() => G.legacy([next], 6000, 4000), /Saved crop/);
    const rotated = G.legacy([
        { sourceWidth: 6000, sourceHeight: 4000, x: 145, y: 652, width: 4800, height: 3200, rotation: 42 },
        { sourceWidth: 4800, sourceHeight: 3200, x: 92, y: 615, width: 3840, height: 2560, rotation: 11 },
        { sourceWidth: 3840, sourceHeight: 2560, x: 328, y: 436, width: 3072, height: 2048, rotation: -30 },
    ], 6000, 4000);
    assert.equal(rotated.rotation, 23);
    assert.equal(rotated.width, 3072);
    assert.ok(rotated.y + rotated.height > 4000, 'legacy rotation can put the frame beyond the unrotated plane');
});
