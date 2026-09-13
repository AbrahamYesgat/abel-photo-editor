'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const contract = require('../js/review-contract.js');
const manual = require('../js/review-manual.js');

const response = () => ({
    rating: 8, summary: 'Quiet light.',
    inferredIntent: { genre: 'Landscape', interpretation: 'Appears quiet.', intentionalTraits: [] },
    categories: contract.reviewCategories.map(name => ({ name, score: 8, feedback: 'Subtle light.' })),
    strengths: [], improvements: [], cropFeedback: 'Keep the framing.',
    portfolioVerdict: { label: 'Portfolio worthy', reason: 'Clear focal point.' },
    adjustments: [], adaptive: { adjustments: [], regions: [] }
});

const smartDelimiters = text => text.replace(/"(?:[^"\\]|\\.)*"/g, token => `“${token.slice(1, -1)}”`);

test('manual and server use identical public prompt and duplicate-member parser', () => {
    assert.equal(require('../server/prompt.js'), require('../js/review-prompt.js'));
    assert.equal(require('../server/json.js'), require('../js/review-json.js'));
    const browser = vm.createContext({ atob, btoa, TextEncoder });
    for (const name of ['contract', 'prompt', 'json', 'manual']) {
        vm.runInContext(fs.readFileSync(require.resolve(`../js/review-${name}.js`), 'utf8'), browser);
    }
    assert.equal(browser.ReviewPrompt.systemInstruction, require('../server/prompt.js').systemInstruction);
    assert.equal(JSON.stringify(browser.ReviewContract.reviewSchema), JSON.stringify(contract.reviewSchema));
    assert.equal(JSON.stringify(browser.ReviewManual.parseResponse(JSON.stringify(response()))), JSON.stringify(response()));
    assert.throws(() => browser.ReviewJSON.parseJSON('{"a":1,"\\u0061":2}'), /Duplicate/);
});

test('manual accepts only a complete JSON object or a single complete code fence', () => {
    const json = JSON.stringify(response());
    for (const text of [json, ` \n${json}\n `, '```json\n' + json + '\n```', '```\r\n' + json + '\r\n```']) {
        assert.deepEqual(manual.parseResponse(text), response());
    }
    for (const text of ['', `Here is the review:\n${json}`, `${json}\nDone.`, `${json}${json}`,
        '```json\n' + json, '```json\n' + json + '\n```\n```json\n{}\n```',
        '```js\n' + json + '\n```', json.slice(0, -1), 'null', '[]']) {
        assert.throws(() => manual.parseResponse(text));
    }
});

test('manual rejects duplicate fields at all depths including escaped member names', () => {
    for (const [find, replace] of [
        ['"rating":8', '"rating":8,"rating":7'],
        ['"rating":8', '"rating":8,"\\u0072ating":7'],
        ['"genre":"Landscape"', '"genre":"Landscape","genre":"Portrait"'],
        ['"regions":[]', '"regions":[],"regions":[]'],
    ]) {
        assert.throws(() => manual.parseResponse(JSON.stringify(response()).replace(find, replace)), /Duplicate/);
    }
});

test('manual explains malformed mobile pastes without repairing or changing recipe text', () => {
    const data = response();
    data.summary = 'The \u201cquiet\u201d mood works.';
    assert.deepEqual(manual.parseResponse(JSON.stringify(data)), data);
    assert.throws(() => manual.parseResponse('{\u201crating\u201d:8}'), /curly quotation marks/);
    assert.throws(() => manual.parseResponse('{"rating":'), /entire JSON code block/);
    assert.throws(() => manual.parseResponse('Here is the JSON: {}'), /Invalid JSON syntax/);
    assert.throws(() => manual.parseResponse('   '), /No response pasted/);
    assert.throws(() => manual.parseResponse('{"rating":8,"rating":7}'), /Duplicate JSON field/);
});

test('reported mobile recipe passes unchanged with four global edits and two adaptive masks', () => {
    const text = fs.readFileSync(require.resolve('./fixtures/mobile-review.json'), 'utf8');
    const result = manual.parseResponse(text);
    assert.deepEqual(result, JSON.parse(text));
    assert.equal(result.adjustments.length, 4);
    assert.equal(result.adaptive.regions.length, 2);
});

test('opt-in repair imports the exact mobile recipe without changing text or numeric edit values', () => {
    const text = fs.readFileSync(require.resolve('./fixtures/mobile-review.json'), 'utf8').trim();
    const mobile = smartDelimiters(text);
    assert.throws(() => manual.parseResponse(mobile), /Invalid JSON/);
    const fixed = manual.repairSmartQuotes(mobile);
    assert.equal(fixed.text, text);
    assert.deepEqual(fixed.review, JSON.parse(text));
    assert.deepEqual(manual.parseResponse(fixed.text), fixed.review);
    for (const fenced of ['```json\r\n' + mobile + '\r\n```', ' \n```\n' + mobile + '\n``` \n']) {
        assert.equal(manual.repairSmartQuotes(fenced).text, text);
    }
});

test('repair preserves nested smart-quoted prose, apostrophes, escapes and already straight strings', () => {
    const data = response();
    data.summary = 'The “quiet, “soft” mood” works; photographer’s 6’ framing.';
    data.cropFeedback = 'Keep \\"quoted\\" framing.\nPath C:\\photo; tab\tend.';
    const text = JSON.stringify(data).replace('framing.', '\\u0066raming.');
    const fixed = manual.repairSmartQuotes(smartDelimiters(text));
    assert.equal(fixed.text, text);
    assert.deepEqual(fixed.review, data);
    const mixed = text.replace('"rating"', '“rating”').replace('"genre":"Landscape"', '“genre”:“Landscape”');
    assert.equal(manual.repairSmartQuotes(mixed).text, text);
    data.summary = 'Ordinary unpaired ” punctuation and “ opening inside a valid straight string.';
    const straight = JSON.stringify(data);
    assert.deepEqual(manual.parseResponse(straight), data);
    assert.equal(manual.repairSmartQuotes(straight.replace('"rating"', '“rating”')).text, straight);
    assert.throws(() => manual.repairSmartQuotes(straight), /No structural smart-quote pairs/);
    const escaped = text.replace('"summary":', '"\\u0073ummary":').replace('"rating":8', '"rating":8e0');
    assert.equal(manual.repairSmartQuotes(smartDelimiters(escaped)).text, escaped);
});

test('repair rejects unsafe boundaries, truncation, other syntax and unsupported full recipes', () => {
    const valid = smartDelimiters(JSON.stringify(response()));
    for (const text of [
        valid.replace('“Quiet light.”', '“Quiet light."'),
        valid.replace('“Quiet light.”', '"Quiet light.”'),
        valid.replace('“Quiet light.”', '”Quiet light.”'),
        valid.replace('“Quiet light.”', '“Quiet ” light.”'),
        valid.replace('“Quiet light.”', '“Quiet “light.”'),
        valid.replace('“Quiet light.”', '“Quiet "light".”'),
        valid.replace('“Quiet light.”', '“Quiet\\” light.”'),
        valid.replace('“Quiet light.”', '“Quiet\nlight.”'),
        valid.slice(0, -1), valid.slice(0, -3), valid + valid,
        `Here is the review: ${valid}`, `${valid}\nDone.`,
        '```json\n' + valid, '```js\n' + valid + '\n```',
        valid.replace('“rating”:8', '“rating”:8,'),
        valid.replace('“rating”:8', '“rating”:1e999'),
        valid.replace('“rating”:8', '“rating”:“8”'),
        valid.replace('“rating”:8', '“rating”:8,“tool”:“retouch”'),
        valid.replace('“rating”:8,', ''),
        valid.replace('“adjustments”:[]', '“adjustments”:[{“key”:“clarity”,“value”:5,“reason”:“Sharp”}]'),
        valid.replace('“regions”:[]', '“regions”:[{“name”:“Invalid”}]'),
    ]) {
        assert.throws(() => manual.repairSmartQuotes(text), undefined, text.slice(0, 100));
    }
    assert.throws(() => manual.repairSmartQuotes('{"rating":'), /No structural smart-quote pairs/);
    assert.throws(() => manual.repairSmartQuotes('not JSON'), /No structural smart-quote pairs/);
    assert.throws(() => manual.repairSmartQuotes(valid.slice(0, -1)), /Other syntax errors/);
});

test('repair retains shared duplicate detection including escaped aliases and byte bounds', () => {
    const text = JSON.stringify(response());
    for (const [find, replacement] of [
        ['"rating":8', '"rating":8,"\\u0072ating":7'],
        ['"genre":"Landscape"', '"genre":"Landscape","genre":"Portrait"'],
        ['"regions":[]', '"regions":[],"\\u0072egions":[]'],
    ]) {
        assert.throws(() => manual.repairSmartQuotes(smartDelimiters(text.replace(find, replacement))), /Duplicate JSON field/);
    }
    const mobile = smartDelimiters(text);
    const byteLength = new TextEncoder().encode(mobile).length;
    assert.deepEqual(manual.repairSmartQuotes(mobile + ' '.repeat(manual.MAX_RESPONSE_BYTES - byteLength)).review, response());
    for (const parse of [manual.parseResponse, manual.repairSmartQuotes]) {
        assert.throws(() => parse(mobile + ' '.repeat(manual.MAX_RESPONSE_BYTES - byteLength + 1)), /too large/);
        assert.throws(() => parse('雪'.repeat(90000)), /too large/);
        assert.throws(() => parse('x'.repeat(manual.MAX_RESPONSE_BYTES + 1)), /too large/);
    }
});

test('manual rejects unsupported, missing, nonfinite, oversized and out-of-bounds recipes without repairs', () => {
    for (const mutate of [
        value => { delete value.adaptive; },
        value => { value.tool = 'retouch'; },
        value => { value.rating = '8'; },
        value => { value.adjustments = [{ key: 'exposure', value: 6, reason: 'Lift' }]; },
        value => { value.adjustments = [{ key: 'clarity', value: 5, reason: 'Sharp' }]; },
        value => { value.adaptive.regions = [{ name: 'Invalid' }]; },
        value => { value.categories[0].name = value.categories[1].name; },
        value => { value.summary = 'x'.repeat(1201); },
    ]) {
        const data = response();
        mutate(data);
        assert.throws(() => manual.parseResponse(JSON.stringify(data)));
    }
    assert.throws(() => manual.parseResponse(JSON.stringify(response()).replace('"rating":8', '"rating":1e999')));
    assert.throws(() => manual.parseResponse('x'.repeat(manual.MAX_RESPONSE_BYTES + 1)), /too large/);
    assert.throws(() => manual.parseResponse('雪'.repeat(90000)), /too large/);
    const html = response();
    html.summary = '<img src=x onerror=alert(1)>';
    assert.equal(manual.parseResponse(JSON.stringify(html)).summary, html.summary, 'safe text preserved, not interpreted');
});

test('manual filenames are bounded safe source-derived basenames', () => {
    assert.equal(manual.filename('summer day'), 'summer_day_ChatGPT');
    assert.ok(!manual.filename('../../a/<script>').includes('/'));
    assert.ok(manual.filename('a'.repeat(300)).length < 100);
    assert.equal(manual.filename(''), 'ABEL_photo_ChatGPT');
});
