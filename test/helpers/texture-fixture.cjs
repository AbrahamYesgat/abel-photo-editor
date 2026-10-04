'use strict';

module.exports = function textureFixture(baseline = 20, clarity = false) {
    const value = require('./detail-fixture.cjs')(baseline);
    for (const variant of Object.values(value.variants)) {
        for (const changes of [variant.adjustments, variant.adaptive.adjustments,
            ...variant.adaptive.regions.map(region => region.adjustments)]) {
            for (const change of changes) if (change.key === 'clarity') change.key = 'texture';
            if (clarity) changes.push({ key: 'clarity', value: 2, reason: 'Independent contrast.' });
        }
    }
    return value;
};
