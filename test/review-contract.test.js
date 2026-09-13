'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const contract = require('../js/review-contract.js');
const { controls, readAdjustments, validateRequest, validateReview, reviewCategories } = contract;

const image = '/9j/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9sAQwACAgICAgIDAgIDBQMDAwUGBQUFBQYIBgYGBgYICggICAgICAoKCgoKCgoKDAwMDAwMDg4ODg4PDw8PDw8PDw8P/9sAQwECAgIEBAQHBAQHEAsJCxAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ/90ABAAB/9oADAMBAAIRAxEAPwD1yiiiv8qz/Sg//9k=';
const adjustments = () => Object.fromEntries(Object.keys(controls).map(key => [key, 0]));
const request = () => ({ image, adjustments: adjustments(), intent: '' });
const review = () => ({
    rating: 7.5, summary: 'Warm, balanced light with an intentional dark background.',
    inferredIntent: { genre: 'Portrait', interpretation: 'The image appears intended to emphasize quiet warmth.', intentionalTraits: ['Dark background'] },
    categories: reviewCategories.map(name => ({ name, score: 8, feedback: 'The subject stands out from the background.' })),
    strengths: ['Warm color harmony.'], improvements: ['The brightest edge draws attention.'],
    cropFeedback: 'Consider removing a little empty space at the right.',
    portfolioVerdict: { label: 'Borderline', reason: 'A strong subject with a distracting bright edge.' },
    adjustments: [{ key: 'exposure', value: -0.25, reason: 'Protect the bright edge.' }],
    adaptive: { adjustments: [], regions: [] }
});

test('UMD exports the same browser and CommonJS contract without dependencies', () => {
    const context = vm.createContext({ atob, btoa });
    vm.runInContext(fs.readFileSync(require.resolve('../js/review-contract.js'), 'utf8'), context);
    assert.equal(typeof context.ReviewContract.validateReview, 'function');
    assert.equal(globalThis.ReviewContract, contract);
    assert.equal(Object.keys(context.ReviewContract.controls).length, 34);
    assert.equal(context.ReviewContract.validateRequest(request()).image, image);
});

test('readAdjustments extracts only allowed basic controls and nested HSL arrays', () => {
    const state = { ...adjustments(), hslHue: [1, 2, 3, 4, 5, 6, 7, 8],
        hslSat: Array(8).fill(-20), hslLum: Array(8).fill(10), crop: {}, clarity: 80 };
    const result = readAdjustments(state);
    assert.equal(result.hslHue_7, 8);
    assert.equal(result.hslSat_4, -20);
    assert.equal(result.hslLum_0, 10);
    assert.equal(Object.keys(result).length, 34);
    assert.equal('crop' in result, false);
    assert.equal('clarity' in result, false);
    assert.equal(controls.exposure.step, 0.01);
    assert.equal(controls.hslHue_0.min, -100);
    assert.throws(() => readAdjustments({}), Error);
});

test('valid requests and reviews return independent allowlisted objects, including no-change reviews', () => {
    assert.deepEqual(validateRequest(request()), request());
    const input = review();
    const result = validateReview(input);
    assert.deepEqual(result, input);
    assert.notEqual(result, input);
    assert.notEqual(result.adjustments, input.adjustments);
    input.adjustments = [];
    assert.deepEqual(validateReview(input).adjustments, []);
    input.adjustments = [{ key: 'hslHue_7', value: -100, reason: 'Preserve the palette.' },
        { key: 'hslLum_0', value: 100, reason: 'Lift the reds.' }];
    assert.deepEqual(validateReview(input), input);
});

test('request rejects missing/unknown fields, tool controls and invalid slider numbers', () => {
    for (const mutate of [
        value => { value.url = 'https://example.com/photo.jpg'; },
        value => { value.model = 'arbitrary'; },
        value => { delete value.intent; },
        value => { value.intent = 'x'.repeat(601); },
        value => { value.intent = 42; },
        value => { value.adjustments.crop = 1; },
        value => { delete value.adjustments.hslSat_0; },
        value => { value.adjustments.exposure = 5.01; },
        value => { value.adjustments.contrast = -101; },
        value => { value.adjustments.hslHue_0 = Infinity; },
        value => { value.adjustments.hslLum_0 = NaN; },
        value => { value.adjustments.saturation = '4'; }
    ]) {
        const value = request();
        mutate(value);
        assert.throws(() => validateRequest(value), Error);
    }
});

test('JPEG rejects wrong encoding, oversized bodies, missing scans and invalid frame dimensions', () => {
    const change = modify => {
        const bytes = Buffer.from(image, 'base64');
        modify(bytes);
        return bytes.toString('base64');
    };
    for (const invalid of [
        '', 'not-an-image', `data:image/jpeg;base64,${image}`, `${image}\n`,
        Buffer.from('PNG').toString('base64'), '/9j/2Q==',
        change(bytes => bytes.writeUInt16BE(1281, 7)),
        change(bytes => bytes.writeUInt16BE(0, 9)),
        change(bytes => bytes.writeUInt16BE(65535, 4)),
        change(bytes => { bytes[bytes.length - 1] = 0; }),
        Buffer.alloc(contract.MAX_IMAGE_BYTES + 1).toString('base64')
    ]) assert.throws(() => validateRequest({ ...request(), image: invalid }), Error);
    const boundary = change(bytes => {
        bytes.writeUInt16BE(1280, 7);
        bytes.writeUInt16BE(1280, 9);
    });
    assert.equal(validateRequest({ ...request(), image: boundary }).image, boundary);
});

test('review rejects unsupported editing controls and unknown fields at every level', () => {
    for (const mutate of [
        value => { value.crop = {}; },
        value => { value.categories[0].extra = true; },
        value => { value.adjustments[0].delta = 0.2; },
        value => { value.adjustments[0].key = 'crop'; },
        value => { value.adjustments[0].key = 'clarity'; },
        value => { value.adjustments[0].key = 'sharpenAmount'; },
        value => { value.adjustments[0].key = 'hslHue_8'; },
        value => { value.adjustments[0].key = '__proto__'; },
        value => { value.adjustments[0].key = ['exposure']; },
        value => { delete value.cropFeedback; }
    ]) {
        const value = review();
        mutate(value);
        assert.throws(() => validateReview(value), Error);
    }
});

test('review rejects nonfinite/out-of-range values, duplicate entries and excessive text/items', () => {
    for (const mutate of [
        value => { value.rating = 10.01; },
        value => { value.rating = NaN; },
        value => { value.categories[0].score = Infinity; },
        value => { value.adjustments[0].value = -5.01; },
        value => { value.adjustments[0].value = '0'; },
        value => { value.adjustments.push({ ...value.adjustments[0] }); },
        value => { value.categories[1].name = value.categories[0].name; },
        value => { value.strengths.push(' warm color harmony. '); },
        value => { value.summary = 'x'.repeat(1201); },
        value => { value.categories = []; },
        value => { value.categories = Array(9).fill(value.categories[0]); },
        value => { value.strengths = Array(9).fill('x'); },
        value => { value.improvements = ['x'.repeat(401)]; },
        value => { value.cropFeedback = ''; },
        value => { value.adjustments[0].reason = ' '; }
    ]) {
        const value = review();
        mutate(value);
        assert.throws(() => validateReview(value), Error);
    }
});

test('intent-first fields and five categories are required, bounded, and normalized without invented defaults', () => {
    for (const mutate of [
        value => { delete value.inferredIntent; },
        value => { delete value.portfolioVerdict; },
        value => { value.inferredIntent.extra = true; },
        value => { value.inferredIntent.genre = ''; },
        value => { value.inferredIntent.genre = 'x'.repeat(81); },
        value => { value.inferredIntent.interpretation = 'x'.repeat(601); },
        value => { value.inferredIntent.intentionalTraits = ['x'.repeat(161)]; },
        value => { value.inferredIntent.intentionalTraits = Array(7).fill('Fog'); },
        value => { value.inferredIntent.intentionalTraits = ['Fog', ' fog ']; },
        value => { value.portfolioVerdict.label = 'Perfect'; },
        value => { value.portfolioVerdict.reason = ' '; },
        value => { value.portfolioVerdict.reason = 'x'.repeat(401); },
        value => { value.portfolioVerdict.execute = 'crop'; },
        value => { value.categories.pop(); },
        value => { value.categories[0].name = 'Invented category'; },
        value => { value.strengths = ['One', 'Two', 'Three', 'Four']; },
        value => { value.improvements = ['One', 'Two', 'Three', 'Four']; }
    ]) {
        const value = review();
        mutate(value);
        assert.throws(() => validateReview(value), Error);
    }
    const value = review();
    value.categories.reverse();
    value.adjustments = [];
    value.improvements = [];
    const validated = validateReview(value);
    assert.deepEqual(validated.categories.map(category => category.name), reviewCategories);
    assert.deepEqual(validated.adjustments, []);
    assert.deepEqual(validated.improvements, []);
    assert.notEqual(validated.inferredIntent, value.inferredIntent);
    assert.notEqual(validated.portfolioVerdict, value.portfolioVerdict);
});

test('Gemini schema closes every response object and enumerates the exact allowlist', () => {
    const schema = contract.reviewSchema;
    for (const object of [schema, schema.properties.categories.items, schema.properties.adjustments.items,
        schema.properties.inferredIntent, schema.properties.portfolioVerdict]) {
        assert.equal(object.additionalProperties, false);
        assert.deepEqual(object.required, Object.keys(object.properties));
    }
    assert.deepEqual(schema.properties.adjustments.items.properties.key.enum, Object.keys(controls));
    assert.deepEqual(schema.properties.categories.items.properties.name.enum, reviewCategories);
    assert.equal(schema.properties.categories.minItems, 5);
    assert.equal(schema.properties.categories.maxItems, 5);
    assert.deepEqual(schema.properties.portfolioVerdict.properties.label.enum, contract.portfolioVerdicts);
});

const region = () => ({
    name: 'Soft foreground', reason: 'Lift the foreground without lifting distant haze.',
    geometry: { type: 'radial', x: 0.5, y: 0.8, width: 0.4, height: 0.3, endX: 0, endY: 0, feather: 1 },
    adjustments: [{ key: 'exposure', value: 0.3, reason: 'Gentle local lift.' }]
});

test('adaptive alternatives validate independent bases and normalized soft geometry', () => {
    const input = review();
    input.adaptive = { adjustments: [], regions: [region()] };
    const output = validateReview(input);
    assert.deepEqual(output, input);
    assert.notEqual(output.adaptive.regions[0].geometry, input.adaptive.regions[0].geometry);
    input.adaptive.regions[0].geometry = {
        type: 'gradient', x: 0, y: 0, width: 0, height: 0, endX: 0, endY: 1, feather: 1
    };
    assert.deepEqual(validateReview(input), input);
    input.adaptive.regions = [];
    input.adaptive.adjustments = [{ key: 'hslHue_0', value: 5, reason: 'A different global base.' }];
    assert.deepEqual(validateReview(input), input);
});

test('adaptive rejects unknown actions, hard masks, invalid ranges, counts and degenerate geometry', () => {
    for (const mutate of [
        v => { delete v.adaptive; },
        v => { v.adaptive.maskId = 2; },
        v => { v.adaptive.regions[0].existingMask = 1; },
        v => { v.adaptive.regions[0].geometry.type = 'subject'; },
        v => { v.adaptive.regions[0].geometry.polygon = []; },
        v => { v.adaptive.regions[0].geometry.x = -0.01; },
        v => { v.adaptive.regions[0].geometry.y = 1.01; },
        v => { v.adaptive.regions[0].geometry.width = 0; },
        v => { v.adaptive.regions[0].geometry.height = 0.049; },
        v => { v.adaptive.regions[0].geometry.feather = 0.49; },
        v => { v.adaptive.regions[0].geometry.endX = 0.1; },
        v => { v.adaptive.regions[0].geometry.x = NaN; },
        v => { v.adaptive.regions[0].geometry.width = Infinity; },
        v => { v.adaptive.regions[0].geometry.y = '0.5'; },
        v => { v.adaptive.regions[0].geometry = { type: 'gradient', x: 0.5, y: 0.5, width: 0, height: 0, endX: 0.5, endY: 0.51, feather: 1 }; },
        v => { v.adaptive.regions[0].adjustments[0].key = 'hslHue_0'; },
        v => { v.adaptive.regions[0].adjustments[0].key = 'dehaze'; },
        v => { v.adaptive.regions[0].adjustments[0].key = 'sharpenAmount'; },
        v => { v.adaptive.regions[0].adjustments[0].value = 0.76; },
        v => { v.adaptive.regions[0].adjustments[0].value = -Infinity; },
        v => { v.adaptive.regions[0].adjustments = []; },
        v => { v.adaptive.regions[0].adjustments.push({ ...v.adaptive.regions[0].adjustments[0] }); },
        v => { v.adaptive.regions[0].name = ' '; },
        v => { v.adaptive.regions = Array(4).fill(region()); },
        v => { v.adaptive.regions.push(region()); }
    ]) {
        const input = review();
        input.adaptive.regions = [region()];
        mutate(input);
        assert.throws(() => validateReview(input), Error);
    }
    const schema = contract.reviewSchema.properties.adaptive;
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.regions.maxItems, 3);
    assert.deepEqual(schema.properties.regions.items.properties.adjustments.items.properties.key.enum, Object.keys(contract.maskControls));
    for (const key of ['clarity', 'dehaze', 'sharpenAmount', 'hslHue_0']) assert.equal(Object.hasOwn(contract.maskControls, key), false);
});
