'use strict';

// Existing focused recipe tests mutate one recipe. Keep those convenient handles
// non-enumerable: the wire fixture contains only the new, closed six-recipe shape.
module.exports = function reviewFixture({ adjustments, adaptive, ...critique }) {
    const empty = () => ({ adjustments: [], adaptive: { adjustments: [], regions: [] } });
    const result = critique.variants ? critique :
        { ...critique, variants: { refine: empty(), balanced: { adjustments, adaptive }, expressive: empty() } };
    for (const key of ['adjustments', 'adaptive']) {
        Object.defineProperty(result, key, {
            get: () => result.variants.balanced[key],
            set: value => { result.variants.balanced[key] = value; }
        });
    }
    return result;
};
