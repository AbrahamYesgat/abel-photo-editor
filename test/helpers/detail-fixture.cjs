'use strict';

module.exports = function detailFixture(baseline = 20) {
    const value = structuredClone(require('../fixtures/intensity-review.json'));
    for (const [index, variant] of Object.values(value.variants).entries()) {
        const change = { key: 'clarity', value: baseline + (index + 1) * 4, reason: 'Subtle visible surface contrast.' };
        variant.adjustments = [{ key: 'exposure', value: 0.3, reason: 'Lift midtones.' }, change];
        variant.adaptive.adjustments = [structuredClone(change)];
        variant.adaptive.regions = [{
            name: 'Broad surface', reason: 'Central surface contrast; spill onto nearby edges.',
            geometry: { type: 'radial', x: 0.5, y: 0.5, width: 0.4, height: 0.4, endX: 0, endY: 0, feather: 1 },
            adjustments: [{ key: 'clarity', value: (index + 1) * 2, reason: 'Visible local contrast.' }]
        }];
    }
    return value;
};
