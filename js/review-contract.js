(function (root, factory) {
    'use strict';
    const contract = factory();
    if (typeof module === 'object' && module.exports) module.exports = contract;
    root.ReviewContract = contract;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const controls = {};
    for (const key of ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks',
        'temperature', 'tint', 'vibrance', 'saturation']) {
        controls[key] = Object.freeze({
            label: key[0].toUpperCase() + key.slice(1),
            min: key === 'exposure' ? -5 : -100,
            max: key === 'exposure' ? 5 : 100,
            step: key === 'exposure' ? 0.01 : 1
        });
    }
    const colors = ['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta'];
    for (const [group, label] of [['hslHue', 'hue'], ['hslSat', 'saturation'], ['hslLum', 'luminance']]) {
        colors.forEach((color, i) => {
            controls[`${group}_${i}`] = Object.freeze({ label: `${color} ${label}`, min: -100, max: 100, step: 1 });
        });
    }
    Object.freeze(controls);
    const keys = Object.keys(controls);
    const maskControls = Object.freeze(Object.fromEntries(
        ['exposure', 'contrast', 'highlights', 'shadows', 'temperature', 'tint', 'saturation']
            .map(key => {
                const max = key === 'exposure' ? 0.75 : ['temperature', 'tint', 'saturation'].includes(key) ? 15 : 20;
                return [key, Object.freeze({ ...controls[key], min: -max, max })];
            })
    ));
    const MAX_REGIONS = 3;
    const MAX_IMAGE_BYTES = 1400000;
    const reviewCategories = Object.freeze([
        'Composition', 'Light / exposure', 'Color / tone',
        'Technical execution', 'Moment / story / impact'
    ]);
    const portfolioVerdicts = Object.freeze([
        'Portfolio standout', 'Portfolio worthy', 'Borderline', 'Not portfolio-ready'
    ]);

    function exact(value, allowed, label) {
        if (!value || typeof value !== 'object' || Array.isArray(value) ||
            Object.keys(value).length !== allowed.length ||
            allowed.some(key => !Object.prototype.hasOwnProperty.call(value, key))) {
            throw new Error(`Invalid ${label} fields.`);
        }
    }
    function text(value, max, label, empty = false) {
        if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) {
            throw new Error(`Invalid ${label}.`);
        }
        return value;
    }
    function number(value, min, max, label) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
            throw new Error(`Invalid ${label}.`);
        }
        return value;
    }
    function adjustment(key, value) {
        if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(controls, key)) throw new Error('Unknown adjustment.');
        return number(value, controls[key].min, controls[key].max, 'adjustment value');
    }
    function currentAdjustments(value) {
        exact(value, keys, 'current adjustments');
        return Object.fromEntries(keys.map(key => [key, adjustment(key, value[key])]));
    }
    function readAdjustments(state) {
        if (!state || typeof state !== 'object') throw new Error('Invalid editor state.');
        return currentAdjustments(Object.fromEntries(keys.map(key => {
            const match = /^(hslHue|hslSat|hslLum)_(\d)$/.exec(key);
            return [key, match ? state[match[1]]?.[Number(match[2])] : state[key]];
        })));
    }

    // Validate bounded JPEG frame/scan structure without a native image decoder.
    function validateImage(image) {
        if (typeof image !== 'string' || !image.length || image.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
            image.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image)) {
            throw new Error('Expected a base64 JPEG preview.');
        }
        let bytes;
        try {
            const binary = atob(image);
            if (btoa(binary) !== image || binary.length > MAX_IMAGE_BYTES) throw new Error();
            bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
        } catch {
            throw new Error('Invalid JPEG encoding or size.');
        }
        const fail = () => { throw new Error('Invalid JPEG; preview dimensions must be at most 1280 × 1280.'); };
        const word = offset => (bytes[offset] << 8) | bytes[offset + 1];
        if (word(0) !== 0xffd8 || word(bytes.length - 2) !== 0xffd9) fail();
        let offset = 2;
        let frame = false;
        let scan = false;
        let entropy = false;
        while (offset < bytes.length) {
            if (entropy) {
                while (offset < bytes.length && bytes[offset] !== 0xff) offset++;
            }
            if (bytes[offset++] !== 0xff) fail();
            while (bytes[offset] === 0xff) offset++;
            const marker = bytes[offset++];
            if (entropy && (marker === 0 || (marker >= 0xd0 && marker <= 0xd7))) continue;
            entropy = false;
            if (marker === 0xd9) {
                if (!frame || !scan || offset !== bytes.length) fail();
                return image;
            }
            if (marker === undefined || marker === 0 || marker === 0xd8 ||
                (marker >= 0xd0 && marker <= 0xd7) || offset + 2 > bytes.length) fail();
            const length = word(offset);
            if (length < 2 || offset + length > bytes.length) fail();
            if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
                if (frame || ![0xc0, 0xc1, 0xc2].includes(marker) || length < 11) fail();
                const height = word(offset + 3);
                const width = word(offset + 5);
                const components = bytes[offset + 7];
                if (bytes[offset + 2] !== 8 || ![1, 3].includes(components) ||
                    length !== 8 + 3 * components || !width || !height || width > 1280 || height > 1280) fail();
                frame = true;
            }
            if (marker === 0xda) {
                if (!frame || length < 8 || length !== 6 + 2 * bytes[offset + 2]) fail();
                scan = true;
                entropy = true;
            }
            offset += length;
        }
        fail();
    }
    function validateRequest(value) {
        exact(value, ['image', 'adjustments', 'intent'], 'request');
        return {
            image: validateImage(value.image),
            adjustments: currentAdjustments(value.adjustments),
            intent: text(value.intent, 600, 'intent', true)
        };
    }
    function list(value, max, label, map, min = 0) {
        if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`Invalid ${label}.`);
        return value.map(map);
    }
    function unique(values, label) {
        if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}.`);
    }
    function changes(value, allowed = controls, max = keys.length, min = 0) {
        const result = list(value, max, 'adjustments', item => {
            exact(item, ['key', 'value', 'reason'], 'adjustment');
            if (typeof item.key !== 'string' || !Object.hasOwn(allowed, item.key)) throw new Error('Unknown adjustment.');
            const control = allowed[item.key];
            return { key: item.key, value: number(item.value, control.min, control.max, 'adjustment value'),
                reason: text(item.reason, 400, 'reason') };
        }, min);
        unique(result.map(item => item.key), 'adjustment');
        return result;
    }
    function region(value) {
        exact(value, ['name', 'reason', 'geometry', 'adjustments'], 'region');
        const g = value.geometry;
        // A fixed geometry shape keeps both providers' structured grammars small.
        exact(g, ['type', 'x', 'y', 'width', 'height', 'endX', 'endY', 'feather'], 'geometry');
        if (!['radial', 'gradient'].includes(g.type)) throw new Error('Invalid mask type.');
        const geometry = { type: g.type };
        for (const key of ['x', 'y', 'width', 'height', 'endX', 'endY', 'feather']) {
            geometry[key] = number(g[key], 0, 1, `geometry ${key}`);
        }
        if (g.type === 'radial') {
            if (g.width < 0.05 || g.height < 0.05 || g.feather < 0.5 || g.endX !== 0 || g.endY !== 0) {
                throw new Error('Invalid soft radial geometry.');
            }
        } else if (g.width !== 0 || g.height !== 0 || g.feather !== 1 ||
            Math.hypot(g.endX - g.x, g.endY - g.y) + 1e-9 < 0.2) {
            throw new Error('Invalid soft gradient geometry.');
        }
        return { name: text(value.name, 80, 'region name'), reason: text(value.reason, 400, 'region reason'),
            geometry, adjustments: changes(value.adjustments, maskControls, 4, 1) };
    }
    function validateReview(value) {
        exact(value, ['rating', 'summary', 'inferredIntent', 'categories', 'strengths',
            'improvements', 'cropFeedback', 'portfolioVerdict', 'adjustments', 'adaptive'], 'review');
        exact(value.adaptive, ['adjustments', 'regions'], 'adaptive');
        const adaptive = {
            adjustments: changes(value.adaptive.adjustments),
            regions: list(value.adaptive.regions, MAX_REGIONS, 'regions', region)
        };
        unique(adaptive.regions.map(item => item.name.trim().toLowerCase()), 'region name');
        exact(value.inferredIntent, ['genre', 'interpretation', 'intentionalTraits'], 'inferred intent');
        const inferredIntent = {
            genre: text(value.inferredIntent.genre, 80, 'genre'),
            interpretation: text(value.inferredIntent.interpretation, 600, 'intent interpretation'),
            intentionalTraits: list(value.inferredIntent.intentionalTraits, 6, 'intentional traits',
                item => text(item, 160, 'intentional trait'))
        };
        unique(inferredIntent.intentionalTraits.map(item => item.trim().toLowerCase()), 'intentional trait');
        exact(value.portfolioVerdict, ['label', 'reason'], 'portfolio verdict');
        if (!portfolioVerdicts.includes(value.portfolioVerdict.label)) throw new Error('Invalid portfolio verdict.');
        const portfolioVerdict = {
            label: value.portfolioVerdict.label,
            reason: text(value.portfolioVerdict.reason, 400, 'portfolio reason')
        };
        const categories = list(value.categories, reviewCategories.length, 'categories', category => {
            exact(category, ['name', 'score', 'feedback'], 'category');
            if (!reviewCategories.includes(category.name)) throw new Error('Invalid category name.');
            return {
                name: text(category.name, 60, 'category name'),
                score: number(category.score, 0, 10, 'category score'),
                feedback: text(category.feedback, 600, 'category feedback')
            };
        }, reviewCategories.length);
        unique(categories.map(category => category.name.trim().toLowerCase()), 'category');
        categories.sort((a, b) => reviewCategories.indexOf(a.name) - reviewCategories.indexOf(b.name));
        const adjustments = changes(value.adjustments);
        const strings = (items, label) => {
            const result = list(items, 3, label, item => text(item, 400, label));
            unique(result.map(item => item.trim().toLowerCase()), label);
            return result;
        };
        return {
            rating: number(value.rating, 0, 10, 'rating'),
            summary: text(value.summary, 1200, 'summary'),
            inferredIntent,
            categories,
            strengths: strings(value.strengths, 'strengths'),
            improvements: strings(value.improvements, 'improvements'),
            cropFeedback: text(value.cropFeedback, 600, 'crop feedback'),
            portfolioVerdict,
            adjustments,
            adaptive
        };
    }
    const stringSchema = maxLength => ({ type: 'string', minLength: 1, maxLength });
    const objectSchema = properties => ({
        type: 'object', properties, required: Object.keys(properties), additionalProperties: false
    });
    const scoreSchema = { type: 'number', minimum: 0, maximum: 10 };
    const changeSchema = (allowed, max, min = 0) => ({
        type: 'array', minItems: min, maxItems: max, items: objectSchema({
            key: { type: 'string', enum: Object.keys(allowed) },
            value: { type: 'number', minimum: -100, maximum: 100 },
            reason: stringSchema(400)
        })
    });
    const unitSchema = { type: 'number', minimum: 0, maximum: 1 };
    const reviewSchema = objectSchema({
        rating: scoreSchema,
        summary: stringSchema(1200),
        inferredIntent: objectSchema({
            genre: stringSchema(80),
            interpretation: stringSchema(600),
            intentionalTraits: { type: 'array', maxItems: 6, items: stringSchema(160) }
        }),
        categories: { type: 'array', minItems: reviewCategories.length, maxItems: reviewCategories.length, items: objectSchema({
            name: { type: 'string', enum: reviewCategories }, score: scoreSchema, feedback: stringSchema(600)
        }) },
        strengths: { type: 'array', maxItems: 3, items: stringSchema(400) },
        improvements: { type: 'array', maxItems: 3, items: stringSchema(400) },
        cropFeedback: stringSchema(600),
        portfolioVerdict: objectSchema({
            label: { type: 'string', enum: portfolioVerdicts },
            reason: stringSchema(400)
        }),
        adjustments: changeSchema(controls, keys.length),
        adaptive: objectSchema({
            adjustments: changeSchema(controls, keys.length),
            regions: { type: 'array', maxItems: MAX_REGIONS, items: objectSchema({
                name: stringSchema(80), reason: stringSchema(400),
                geometry: objectSchema({
                    type: { type: 'string', enum: ['radial', 'gradient'] },
                    x: unitSchema, y: unitSchema, width: unitSchema, height: unitSchema,
                    endX: unitSchema, endY: unitSchema, feather: unitSchema
                }),
                adjustments: changeSchema(maskControls, 4, 1)
            }) }
        })
    });
    return Object.freeze({ controls, readAdjustments, validateRequest, validateReview, reviewSchema,
        reviewCategories, portfolioVerdicts, maskControls, MAX_REGIONS, MAX_IMAGE_BYTES });
});
