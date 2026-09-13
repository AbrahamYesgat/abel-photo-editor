(function (root, factory) {
    'use strict';
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.ReviewJSON = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
'use strict';

function parseJSON(text) {
    const value = JSON.parse(text);
    // JSON.parse otherwise silently keeps the last occurrence of duplicate object keys.
    const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}[\]:,]/g) || [];
    const stack = [];
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token === '{') stack.push(new Set());
        else if (token === '[') stack.push(null);
        else if (token === '}' || token === ']') stack.pop();
        else if (token.startsWith('"') && tokens[i + 1] === ':') {
            const key = JSON.parse(token);
            const object = stack[stack.length - 1];
            if (object.has(key)) throw new Error('Duplicate JSON field.');
            object.add(key);
        }
    }
    return value;
}

return Object.freeze({ parseJSON });
});
