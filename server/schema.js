'use strict';

const { reviewSchema } = require('../js/review-contract.js');

// Gemini can reject the combined string/collection bounds as an overly complex
// grammar. Keep them in descriptions; both runtime validators still enforce them.
function compatibleSchema(schema) {
    const { minLength, maxLength, minItems, maxItems, ...result } = schema;
    const descriptions = result.description ? [result.description] : [];
    if (minLength !== undefined) descriptions.push(`At least ${minLength} characters.`);
    if (maxLength !== undefined) descriptions.push(`At most ${maxLength} characters.`);
    if (minItems !== undefined) descriptions.push(`At least ${minItems} items.`);
    if (maxItems !== undefined) descriptions.push(`At most ${maxItems} items.`);
    if (descriptions.length) result.description = descriptions.join(' ');
    if (result.properties) {
        result.properties = Object.fromEntries(Object.entries(result.properties)
            .map(([key, value]) => [key, compatibleSchema(value)]));
    }
    if (result.items) result.items = compatibleSchema(result.items);
    return result;
}

module.exports = { geminiReviewSchema: compatibleSchema(reviewSchema) };
