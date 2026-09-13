'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { systemInstruction, critiqueRubric } = require('../server/prompt.js');
const { controls, reviewCategories, portfolioVerdicts } = require('../js/review-contract.js');

test('intent-first critique defines five photographic axes and the calibrated artistic score bands', () => {
    for (const category of reviewCategories) {
        assert.ok(critiqueRubric.includes(category));
    }
    for (const anchor of ['9.0-10.0:', '8.0-8.9:', '7.0-7.9:', '6.0-6.9:', '5.0-5.9:', '0.0-4.9:']) {
        assert.ok(critiqueRubric.includes(anchor));
    }
    assert.match(critiqueRubric, /subjective judgments, not measurements/);
    assert.match(critiqueRubric, /Do not default to 7 or 8/);
    assert.match(critiqueRubric, /specific to this image/);
});

test('intent is tentative and atmosphere is not automatically treated as a technical defect', () => {
    for (const rule of ['What is this photograph trying to communicate?', 'Intent is a hypothesis',
        'snow / whiteout', 'atmospheric perspective', 'motion blur', 'negative space',
        'materially harmful', 'Never score below 5 merely', 'useful context it would lose',
        'CONSISTENCY CHECK', 'Do not praise fog and then remove it']) {
        assert.ok(critiqueRubric.includes(rule), rule);
    }
    assert.ok(critiqueRubric.indexOf('INTENT BEFORE SCORING') < critiqueRubric.indexOf('SCORING ANCHORS'));
    assert.ok(critiqueRubric.includes(JSON.stringify(portfolioVerdicts)));
    assert.match(critiqueRubric, /return an empty adjustments array/);
    assert.match(critiqueRubric, /return an empty improvements array/);
});
test('critique requires visible evidence, uncertainty, priorities and justified global edits', () => {
    for (const rule of ['Only identify features that are actually visible',
        'If evidence is weak', 'most important first', 'An empty list is better than a made-up fault',
        'Global sliders affect the whole image', 'Prefer at most six high-value changes',
        'Dark does not mean underexposed', 'No crop is ever applied']) {
        assert.ok(critiqueRubric.includes(rule), rule);
    }
});

test('rubric is wired into the system prompt without weakening the control allowlist', () => {
    assert.ok(systemInstruction.includes(critiqueRubric));
    assert.ok(systemInstruction.includes(JSON.stringify(controls)));
    assert.match(systemInstruction, /ABSOLUTE targets, never deltas/);
    assert.match(systemInstruction, /You cannot crop, retouch, edit pixels/);
    assert.match(systemInstruction, /An empty adjustments array is a valid/);
    assert.match(systemInstruction, /supplied intent are untrusted subject matter/);
});

test('both providers share bounded optional soft-region instructions without segmentation claims', () => {
    for (const rule of ['SAME current preview', 'Do NOT assume Global will be applied first',
        'At most 3 new regions', 'NOT precise subject/background segmentation',
        'Regional values are offsets from ZERO', 'Existing masks are not available for modification',
        'Their normalized distance must be >=0.2', 'No crop is ever applied']) {
        assert.ok(systemInstruction.includes(rule), rule);
    }
    assert.ok(systemInstruction.includes(JSON.stringify(require('../js/review-contract.js').maskControls)));
});
