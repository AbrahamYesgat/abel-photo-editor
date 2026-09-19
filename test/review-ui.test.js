const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ReviewContract = require('../js/review-contract.js');
const ReviewManual = require('../js/review-manual.js');
const reviewFixture = require('./helpers/review-fixture.cjs');

function memoryStorage() {
    const values = new Map();
    return {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
        removeItem: key => values.delete(key),
        values,
    };
}

function harness({ storage = memoryStorage(), initialize = false } = {}) {
    const elements = new Map();
    const element = () => ({
        disabled: false, hidden: false, value: '100', textContent: '',
        classList: { toggle() {}, remove() {} }, style: {},
        children: [],
        listeners: {},
        addEventListener(name, listener) { this.listeners[name] = listener; },
        dispatch(name) { this.listeners[name]?.(); },
        replaceChildren(...children) { this.children = children; },
        append(...children) { this.children.push(...children); },
        appendChild(child) { this.children.push(child); },
        querySelectorAll() { return []; },
        setAttribute() {},
    });
    const document = {
        addEventListener() {},
        createElement(tag) {
            const node = element();
            if (tag === 'canvas') node.getContext = () => ({
                drawImage() {}, fillRect() {}, clearRect() {}, save() {}, restore() {}, translate() {}, scale() {},
                createRadialGradient() { return { addColorStop() {} }; },
                createLinearGradient() { return { addColorStop() {} }; }
            });
            return node;
        },
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, element());
            return elements.get(id);
        },
        querySelectorAll() { return []; },
        querySelector() { return null; },
    };
    const context = vm.createContext({
        document, window: {
            location: { origin: 'http://localhost:3000' }, localStorage: storage,
            listeners: {}, addEventListener(name, listener) { this.listeners[name] = listener; },
        },
        ReviewContract, ReviewManual, ReviewJSON: require('../js/review-json.js'), console, setTimeout, clearTimeout, URL, AbortController,
        Blob, atob, navigator: {},
    });
    vm.runInContext(readFileSync(path.join(__dirname, '../js/app.js'), 'utf8') + '\nthis.App = App;', context);
    vm.runInContext(readFileSync(path.join(__dirname, '../js/review.js'), 'utf8') + '\nthis.ReviewPanel = ReviewPanel;', context);
    vm.runInContext(readFileSync(path.join(__dirname, '../js/mask-engine.js'), 'utf8') + '\nthis.MaskEngine = MaskEngine;', context);
    const app = Object.create(context.App.prototype);
    Object.assign(app, {
        state: context.App.prototype._defaultState(),
        image: { width: 500, height: 400 }, imageWidth: 500, imageHeight: 400,
        history: [], historyIndex: -1,
        curveEditor: { channels: { rgb: [{ x: 0, y: 0 }, { x: 255, y: 255 }] } },
        sliders: {},
        glEngine: { loadImage() {} },
        _fitCanvas() {}, _hideCompositeOverlay() {},
    });
    app.maskEngine = new context.MaskEngine(app);
    app._render = () => app.review?.onRender();
    app._pushHistory();
    let review = Object.create(context.ReviewPanel.prototype);
    Object.assign(review, {
        app, result: null, context: null, controller: null, appliedContext: null, beforeState: null,
        elements: {},
    });
    for (const name of ['analyze', 'cancel', 'status', 'consent', 'apply', 'undo', 'compare',
        'strength', 'apply-bar', 'result', 'provider', 'provider-badge', 'provider-note',
        'connection-title', 'connection', 'cloud-settings', 'local-settings', 'check-local',
        'local-token-field', 'remember-local', 'local-storage-status', 'forget-local',
        'check-gemini', 'token-field', 'remember-gemini', 'gemini-storage-status', 'forget-gemini',
        'gemini-options', 'gemini-mode', 'gemini-strength', 'gemini-strength-value', 'intent-note',
        'manual-choice', 'manual-strength', 'intensity', 'photo-controls', 'photo-mode',
        'photo-strength', 'photo-strength-value', 'photo-state', 'view-photo', 'open-drawer',
        'allow-details', 'photo-details',
        'consent-text', 'data-terms', 'endpoint', 'token', 'local-endpoint', 'local-token', 'intent',
        'feedback', 'adjustments', 'strength-value', 'alternative',
        'consent-label', 'manual', 'export', 'download-preview', 'copy-prompt',
        'download-prompt', 'prompt', 'paste', 'import', 'fix-quotes']) {
        review.elements[name] = element();
    }
    review.elements.provider.value = 'gemini';
    review.elements['gemini-mode'].value = initialize ? 'global' : 'review';
    review.elements['remember-gemini'].checked = false;
    for (const name of ['endpoint', 'token', 'local-endpoint', 'local-token', 'intent']) {
        review.elements[name].value = '';
    }
    review.elements.consent.checked = true;
    review.elements['remember-local'].checked = true;
    if (initialize) {
        for (const [name, element] of Object.entries(review.elements)) elements.set(`review-${name}`, element);
        review.elements.consent.checked = false;
        app._bindHoldCompare = () => {};
        review = new context.ReviewPanel(app);
    }
    app.review = review;
    return { app, review, document, context, storage };
}

function response(adjustments) {
    return reviewFixture({
        rating: 7.5,
        summary: 'Strong subject separation with room for a small exposure correction.',
        inferredIntent: { genre: 'Portrait', interpretation: 'The image appears intended to feel quiet.', intentionalTraits: ['Subdued light'] },
        categories: ReviewContract.reviewCategories.map(name => ({ name, score: 7, feedback: 'The subject is slightly dark.' })),
        portfolioVerdict: { label: 'Borderline', reason: 'Clear intent with a minor tonal limitation.' },
        strengths: ['Clear focal point.'],
        improvements: ['Open the darker midtones slightly.'],
        cropFeedback: 'Keep the framing.',
        adjustments,
        adaptive: { adjustments: [], regions: [] },
    });
}

function prepare(review, changes) {
    review.context = review.snapshot();
    review.result = reviewFixture(ReviewContract.validateReview(response(changes)));
    review.selection = 'global';
}

test('six saved variants replace one transaction from a frozen masked baseline, including strength and undo/redo', () => {
    const { app, review } = harness();
    const originalMask = app.maskEngine.createMask('radial');
    originalMask.adjustments.exposure = -0.15;
    app.state.exposure = 0.1;
    app.state.temperature = 2;
    app._pushHistory();
    prepare(review, []);
    review.result = ReviewContract.validateReview(require('./fixtures/intensity-review.json'));
    review.intensity = 'balanced';
    review.selection = 'adaptive';
    const baseline = review.snapshot();
    const historyLength = app.history.length;
    review.apply();
    const initial = structuredClone(ReviewContract.readAdjustments(app.state));
    assert.equal(app.maskEngine.masks.length, 3);
    assert.equal(app.history.length, historyLength + 1);
    for (const intensity of ['refine', 'expressive', 'balanced']) {
        review.chooseIntensity(intensity);
        assert.equal(review.result !== null, true);
        assert.equal(app.maskEngine.masks[0].id, originalMask.id);
        assert.equal(app.maskEngine.masks[0].adjustments.exposure, -0.15);
        assert.equal(app.history.length, historyLength + 1);
        assert.equal(review.beforeContext.edits, baseline.edits);
    }
    assert.deepEqual(ReviewContract.readAdjustments(app.state), initial);
    assert.equal(app.maskEngine.masks.length, 3, 'old AI masks are replaced, not accumulated');
    review.selection = 'global';
    review.apply();
    assert.equal(app.maskEngine.masks.length, 1);
    assert.equal(app.state.exposure, 0.5);
    review.elements.strength.value = '50';
    review.apply();
    assert.equal(app.state.exposure, 0.3, 'strength interpolates from 0.1, never the previous AI result');
    const edited = review.snapshot().edits;
    app._undo();
    assert.equal(review.snapshot().edits, baseline.edits);
    assert.equal(review.canCompare(), false);
    assert.equal(review.elements['photo-controls'].hidden, false);
    app._redo();
    assert.equal(review.snapshot().edits, edited);
    assert.equal(review.canCompare(), true);
    app._undo();
    review.chooseIntensity('expressive');
    assert.equal(app.state.exposure, 0.1, 'an omitted slider returns to its original baseline');
    assert.equal(app.history.length, historyLength + 1);
    assert.equal(app.state.temperature, 8);
});

test('manual edits clear saved alternatives even when manually returning to the exact review baseline', () => {
    for (const change of [
        app => { app.state.exposure = 0; },
        app => { app.curveEditor.channels.rgb[1].y = 220; },
        app => { app.maskEngine.createMask('radial'); },
        app => { app.image = {}; },
    ]) {
        const { app, review } = harness();
        prepare(review, [{ key: 'exposure', value: 0.5, reason: 'Lift.' }]);
        review.apply();
        change(app);
        app._render();
        assert.equal(review.result, null);
        assert.equal(review.elements['photo-controls'].hidden, true);
        const edits = review.snapshot().edits;
        review.chooseIntensity('expressive');
        assert.equal(review.snapshot().edits, edits);
    }
});

test('one request returns all intensities; no selection or strength switch calls the provider', async () => {
    const { app, review, context } = geminiHarness();
    let requests = 0;
    context.fetch = async () => { requests++; return Response.json(require('./fixtures/intensity-review.json')); };
    await review.analyze();
    for (const intensity of ['expressive', 'refine', 'balanced', 'expressive']) review.chooseIntensity(intensity);
    review.selection = 'adaptive';
    review.elements.strength.value = '25';
    review.apply();
    assert.equal(requests, 1);
    assert.equal(app.maskEngine.masks.length, 1);
    assert.equal(app.maskEngine.masks[0].adjustments.exposure, 0.275);
    assert.equal(app.history.length, 2);
});

test('intensity changes cancel in-flight one-click apply; duplicate response members are rejected', async () => {
    const { app, review, context } = geminiHarness();
    let finish;
    context.fetch = () => new Promise(resolve => { finish = resolve; });
    const pending = review.analyze();
    review.chooseIntensity('expressive');
    finish(Response.json(require('./fixtures/intensity-review.json')));
    await pending;
    assert.equal(review.result, null);
    assert.equal(app.state.exposure, 0);
    context.fetch = async () => new Response(JSON.stringify(require('./fixtures/intensity-review.json'))
        .replace('"variants":{', '"variants":{"balanced":{},'), { headers: { 'Content-Type': 'application/json' } });
    await review.analyze();
    assert.match(review.elements.status.textContent, /Duplicate JSON field/);
    assert.equal(app.history.length, 1);
});

function geminiHarness(options) {
    const fixture = harness({ initialize: true, ...options });
    fixture.review.preview = () => 'synthetic-preview';
    fixture.context.ReviewContract = { ...ReviewContract, validateRequest() {} };
    fixture.review.elements.consent.checked = true;
    return fixture;
}

function azureHarness(options) {
    const fixture = geminiHarness(options);
    fixture.review.elements.provider.value = 'azure';
    fixture.review.changeProvider();
    fixture.review.elements.consent.checked = true;
    fixture.review.elements.token.value = 'azure-test-token';
    return fixture;
}

test('clarity opt-in is off on initialization and never stored with connection preferences', async () => {
    const { review, context, storage } = geminiHarness();
    assert.equal(review.elements['allow-details'].checked, false);
    review.elements['allow-details'].checked = true;
    review.elements['remember-gemini'].checked = true;
    context.fetch = async () => Response.json(response([]));
    await review.analyze();
    assert.equal(JSON.stringify([...storage.values]).includes('allowDetails'), false);
    const restored = geminiHarness({ storage });
    assert.equal(restored.review.elements['allow-details'].checked, false);
});

test('cached detail toggles preserve nonzero baseline clarity and masks, with no calls or stacking', () => {
    const { app, review, context } = geminiHarness();
    context.fetch = () => assert.fail('Saved treatment switches never call a provider');
    app.state.clarity = 20;
    app.state.sharpenAmount = 19;
    const mask = app.maskEngine.createMask('radial');
    mask.adjustments.clarity = -7;
    app._pushHistory();
    review.elements['allow-details'].checked = true;
    review.requestPolicy = review.detailRequest();
    review.context = review.snapshot();
    review.result = require('./helpers/detail-fixture.cjs')();
    review.showResult('adaptive');
    const baseline = review.snapshot().edits;
    const historyLength = app.history.length;
    review.apply();
    assert.equal(app.state.clarity, 28);
    assert.equal(app.maskEngine.masks.length, 2);
    const details = review.snapshot().edits;
    for (let repeat = 0; repeat < 3; repeat++) {
        review.elements['photo-details'].dispatch('click');
        assert.equal(app.state.clarity, 20);
        assert.equal(app.maskEngine.masks.length, 1, 'detail-only region omitted, not a no-op mask');
        assert.equal(app.maskEngine.masks[0].adjustments.clarity, -7);
        assert.equal(app.state.sharpenAmount, 19);
        assert.equal(review.snapshot().edits, baseline, 'adaptive detail-only recipe off restores baseline exactly');
        review.elements['photo-details'].dispatch('click');
        const withoutIds = text => JSON.stringify(JSON.parse(text), (key, value) => key === 'id' ? undefined : value);
        assert.equal(withoutIds(review.snapshot().edits), withoutIds(details));
        assert.equal(app.history.length, historyLength + 1);
    }
    review.elements.strength.value = '0';
    review.apply();
    assert.equal(review.snapshot().edits, baseline);
    review.elements.strength.value = '50';
    review.apply();
    assert.equal(app.state.clarity, 24);
    assert.equal(app.maskEngine.masks[1].adjustments.clarity, 2);
    const partial = review.snapshot().edits;
    app._undo();
    assert.equal(review.snapshot().edits, baseline);
    app._redo();
    assert.equal(review.snapshot().edits, partial);
    review.selection = 'global';
    review.apply();
    review.elements['photo-details'].dispatch('click');
    assert.equal(app.state.clarity, 20);
    assert.equal(app.state.exposure, 0.15, 'same lighting treatment stays applied');
    review.chooseIntensity('expressive');
    assert.equal(app.state.clarity, 20, 'intensity never silently re-enables detail');
    app.state.contrast = 1;
    app._render();
    assert.equal(review.result, null);
});

test('browser rejects unsolicited detail and policy changes cancel pending requests before application', async () => {
    const { app, review, context } = geminiHarness();
    const detail = require('./helpers/detail-fixture.cjs');
    context.fetch = async () => Response.json(detail(0));
    await review.analyze();
    assert.equal(review.result, null);
    assert.equal(app.state.clarity, 0);
    assert.match(review.elements.status.textContent, /Unknown adjustment/);
    review.elements['allow-details'].checked = true;
    let finish;
    context.fetch = (_, options) => {
        assert.equal(JSON.parse(options.body).detailAdjustments.clarity, 0);
        return new Promise(resolve => { finish = resolve; });
    };
    const pending = review.analyze();
    review.elements['allow-details'].checked = false;
    review.elements['allow-details'].dispatch('change');
    finish(Response.json(detail(0)));
    await pending;
    assert.equal(review.result, null);
    assert.equal(app.state.clarity, 0);
    assert.equal(app.history.length, 1);
});

test('interpolated clarity remains inside relative limits even with a fractional manual baseline', () => {
    const { app, review } = geminiHarness();
    app.state.clarity = 20.6;
    review.elements['allow-details'].checked = true;
    review.requestPolicy = review.detailRequest();
    review.context = review.snapshot();
    review.result = require('./helpers/detail-fixture.cjs')(20.6);
    review.result.variants.refine.adjustments[1].value = 25.6;
    review.intensity = 'refine';
    review.showResult('global');
    review.apply();
    assert.equal(app.state.clarity, 25.6, 'step rounding must not exceed +5');
});

test('manual detail import is bound to exported policy and baseline, including smart quotes', async () => {
    const { app, review } = manualHarness();
    const detail = require('./helpers/detail-fixture.cjs');
    app.state.clarity = 20;
    await review.exportManual();
    review.elements.paste.value = JSON.stringify(detail());
    review.importManual();
    assert.equal(review.result, null);
    review.elements['allow-details'].checked = true;
    review.importManual();
    assert.equal(review.result, null, 'changing permission cannot bless an old export');
    await review.exportManual();
    review.elements.paste.value = JSON.stringify(detail()).replace(/"([^"]*)"/g, '“$1”');
    review.importManual(true);
    assert.ok(review.result);
    review.selection = 'global';
    review.apply();
    assert.equal(app.state.clarity, 28);
    review.includeDetails = false;
    review.apply();
    assert.equal(app.state.clarity, 20);
    assert.equal(app.state.exposure, 0.3);
});

test('Azure public endpoint default contains no token and never grants consent or probes', () => {
    const { review, context, document } = harness({ initialize: true });
    document.querySelector = selector => selector === 'meta[name="abel-azure-review-endpoint"]'
        ? { content: 'https://azure-backend.example' } : null;
    context.fetch = () => { throw new Error('Provider selection must not make requests'); };
    review.elements.provider.value = 'azure';
    review.changeProvider();
    assert.equal(review.endpoint(), 'https://azure-backend.example/api/review/azure');
    assert.equal(review.elements.token.value, '');
    assert.equal(review.elements.consent.checked, false);
    review.elements.provider.value = 'gemini';
    review.changeProvider();
    assert.equal(review.endpoint(), 'http://localhost:3000/api/review');
});

test('Azure separates cloud credentials, defaults and terms without granting consent or probing', async () => {
    const { review, context, storage } = harness({ initialize: true });
    review.elements.endpoint.value = 'https://gemini.example';
    review.elements.token.value = 'gemini-test-token';
    review.elements['remember-gemini'].checked = true;
    review.rememberGeminiConnection(review.endpoint());
    review.elements.provider.value = 'azure';
    review.changeProvider();
    assert.equal(review.elements.consent.checked, false);
    assert.equal(review.elements.token.value, '');
    assert.equal(review.savedGeminiConnection, null);
    assert.equal(review.endpoint(), 'http://localhost:3000/api/review/azure');
    assert.equal(review.elements['remember-gemini'].checked, false);
    assert.match(review.elements['consent-text'].textContent, /Microsoft Azure OpenAI/);
    assert.match(review.elements['data-terms'].href, /microsoft.com/);
    assert.equal(review.elements['gemini-mode'].value, 'global');
    review.elements.endpoint.value = 'https://azure-backend.example';
    review.elements.token.value = 'azure-test-token';
    review.elements['remember-gemini'].checked = true;
    context.fetch = async (url, options) => {
        assert.equal(url, 'https://azure-backend.example/api/review/azure/status');
        assert.equal(options.headers.Authorization, 'Bearer azure-test-token');
        assert.equal(options.body, undefined);
        return Response.json({ configured: true, provider: 'azure', model: 'gpt-5.4', authorized: true, tokenRequired: true });
    };
    await review.checkGeminiConnection();
    assert.equal(review.elements.token.value, '');
    assert.equal(JSON.parse(storage.getItem('abel.azure-connection.v1')).token, 'azure-test-token');
    assert.equal(JSON.parse(storage.getItem('abel.gemini-connection.v1')).token, 'gemini-test-token');
    review.elements.provider.value = 'gemini';
    review.changeProvider();
    assert.equal(review.requestHeaders().Authorization, 'Bearer gemini-test-token');
    assert.equal(review.endpoint(), 'https://gemini.example/api/review');
    review.elements.provider.value = 'azure';
    review.changeProvider();
    assert.equal(review.requestHeaders().Authorization, 'Bearer azure-test-token');
    assert.equal(review.endpoint(), 'https://azure-backend.example/api/review/azure');
    review.forgetGeminiConnection();
    assert.equal(storage.getItem('abel.azure-connection.v1'), null);
    assert.ok(storage.getItem('abel.gemini-connection.v1'));
});

test('Azure restoration is isolated and forgetting inactive credentials in another tab clears the cache', () => {
    const storage = memoryStorage();
    for (const provider of ['azure', 'gemini']) storage.setItem(`abel.${provider}-connection.v1`, JSON.stringify({
        version: 1, endpoint: `https://${provider}.example/api/review${provider === 'azure' ? '/azure' : ''}`,
        token: `${provider}-test-token`
    }));
    const { review, context } = harness({ initialize: true, storage });
    review.elements.provider.value = 'azure';
    review.changeProvider();
    assert.equal(review.requestHeaders().Authorization, 'Bearer azure-test-token');
    assert.equal(review.elements.consent.checked, false);
    storage.removeItem('abel.gemini-connection.v1');
    context.window.listeners.storage({ key: 'abel.gemini-connection.v1', newValue: null });
    assert.equal(review.requestHeaders().Authorization, 'Bearer azure-test-token');
    review.elements.provider.value = 'gemini';
    review.changeProvider();
    assert.equal(review.requestHeaders().Authorization, undefined);
    review.elements.provider.value = 'azure';
    review.changeProvider();
    context.window.listeners.storage({ key: 'abel.azure-connection.v1', newValue: null });
    assert.equal(review.requestHeaders().Authorization, undefined);
});

test('Azure review-only, Global and Adaptive retain one-click bounds, undo, compare and consent', async () => {
    for (const mode of ['review', 'global', 'adaptive']) {
        const { app, review, context } = azureHarness();
        review.elements['gemini-mode'].value = mode;
        review.elements['gemini-strength'].value = '50';
        const baseline = review.snapshot().edits;
        const result = response([{ key: 'exposure', value: 0.8, reason: 'Lift.' }]);
        result.adaptive = { adjustments: [{ key: 'temperature', value: 8, reason: 'Warm.' }], regions: [adaptiveRegion()] };
        let calls = 0;
        context.fetch = async (url, options) => {
            calls++;
            assert.equal(url, 'http://localhost:3000/api/review/azure');
            assert.equal(options.headers.Authorization, 'Bearer azure-test-token');
            return Response.json(result);
        };
        review.elements.consent.checked = false;
        await review.analyze();
        assert.equal(calls, 0);
        review.elements.consent.checked = true;
        await review.analyze();
        assert.equal(calls, 1);
        assert.equal(app.state.exposure, mode === 'global' ? 0.4 : 0);
        assert.equal(app.state.temperature, mode === 'adaptive' ? 4 : 0);
        assert.equal(app.maskEngine.masks.length, mode === 'adaptive' ? 1 : 0);
        assert.equal(review.canCompare(), mode !== 'review');
        if (mode !== 'review') {
            app._undo();
            assert.equal(review.snapshot().edits, baseline);
            app._redo();
            assert.equal(review.canCompare(), true);
        } else assert.equal(review.snapshot().edits, baseline);
    }
});

test('Azure cancelled, stale, revoked and switched responses never apply or fall back', async () => {
    for (const mutate of [
        r => r.elements.cancel.dispatch('click'),
        r => { r.elements.consent.checked = false; },
        (r, a) => { a.state.exposure = 0.2; },
        r => { r.elements.provider.value = 'gemini'; r.changeProvider(); },
        r => { r.elements.provider.value = 'local'; r.changeProvider(); },
        r => { r.elements['gemini-strength'].value = '25'; }
    ]) {
        const { app, review, context } = azureHarness();
        let finish, calls = 0;
        context.fetch = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
        const pending = review.analyze();
        mutate(review, app);
        const baseline = review.snapshot().edits;
        finish(Response.json(response([{ key: 'exposure', value: 0.6, reason: 'Lift.' }])));
        await pending;
        assert.equal(calls, 1);
        assert.equal(review.snapshot().edits, baseline);
        assert.equal(review.result, null);
        assert.equal(review.canCompare(), false);
    }
    const { review, context } = azureHarness();
    const baseline = review.snapshot().edits;
    let calls = 0;
    context.fetch = async () => { calls++; return Response.json({ error: 'Monthly allowance exhausted', code: 'azure_monthly_limit' }, { status: 429 }); };
    await review.analyze();
    assert.equal(calls, 1);
    assert.equal(review.snapshot().edits, baseline);
    assert.match(review.elements.status.textContent, /Monthly allowance exhausted/);
});

test('Gemini defaults fill safely without network, invented backend, saved intent or upload consent', () => {
    const { review, storage } = harness({ initialize: true });
    assert.equal(review.elements.endpoint.value, 'http://localhost:3000');
    assert.equal(review.elements.token.value, '');
    assert.equal(review.elements.intent.value, review.defaultIntent());
    assert.equal(review.elements['gemini-mode'].value, 'global');
    assert.equal(review.elements['gemini-strength'].value, '100');
    assert.equal(review.elements.consent.checked, false);
    assert.equal(review.elements['remember-gemini'].checked, false);
    assert.equal(review.elements.analyze.disabled, true);
    assert.equal(review.elements.analyze.textContent, 'Review & apply Global');
    assert.equal(review.controller, null);
    assert.equal(storage.values.size, 0);
});

test('one Gemini click applies exactly the selected alternative once, retaining undo and compare', async () => {
    for (const mode of ['global', 'adaptive']) {
        const { app, review, context } = geminiHarness();
        review.elements['gemini-mode'].value = mode;
        review.elements['gemini-strength'].value = '50';
        const baseline = review.snapshot().edits;
        const result = response([{ key: 'exposure', value: 0.8, reason: 'Lift midtones.' }]);
        result.adaptive = { adjustments: [{ key: 'temperature', value: 8, reason: 'Warm light.' }], regions: [adaptiveRegion()] };
        let finish, requests = 0;
        context.fetch = () => { requests++; return new Promise(resolve => { finish = resolve; }); };
        const pending = review.analyze();
        await review.analyze();
        assert.equal(app.state.exposure, 0, 'no edit before a validated response');
        finish(Response.json(result));
        await pending;
        assert.equal(requests, 1);
        assert.equal(review.selection, mode);
        assert.equal(app.state.exposure, mode === 'global' ? 0.4 : 0);
        assert.equal(app.state.temperature, mode === 'adaptive' ? 4 : 0);
        assert.equal(app.maskEngine.masks.length, mode === 'adaptive' ? 1 : 0);
        if (mode === 'adaptive') assert.equal(app.maskEngine.masks[0].adjustments.exposure, 0.3);
        assert.equal(review.elements.apply.hidden, true);
        assert.equal(review.elements['manual-choice'].hidden, false);
        assert.equal(review.canCompare(), true);
        assert.match(review.elements.status.textContent, /applied/i);
        const historyLength = app.history.length;
        review.apply();
        assert.equal(app.history.length, historyLength);
        app._undo();
        assert.equal(review.snapshot().edits, baseline);
        app._redo();
        assert.equal(review.canCompare(), true);
    }
});

test('Gemini review-only remains manual and selected empty or zero-strength recipes never substitute alternatives', async () => {
    for (const mode of ['review', 'adaptive', 'global']) {
        const { app, review, context } = geminiHarness();
        review.elements['gemini-mode'].value = mode;
        if (mode === 'global') review.elements['gemini-strength'].value = '0';
        const baseline = review.snapshot().edits;
        const historyLength = app.history.length;
        context.fetch = async () => Response.json(response([{ key: 'exposure', value: 0.5, reason: 'Lift.' }]));
        await review.analyze();
        assert.equal(review.snapshot().edits, baseline);
        assert.equal(app.history.length, historyLength + (mode === 'review' ? 0 : 1));
        assert.equal(review.canCompare(), mode !== 'review');
        assert.match(review.elements.status.textContent, mode === 'review' ? /Nothing has changed/ : /applied/);
        assert.equal(review.elements.apply.hidden, mode !== 'review');
    }
});

test('Gemini never auto-applies cancelled, stale, switched, revoked or superseded async responses', async () => {
    const mutations = [
        (r, a) => { a.state.exposure = 0.2; },
        (r, a) => { a.image = {}; },
        (r, a) => { a.imageWidth = 300; },
        (r, a) => { a.curveEditor.channels.rgb[1].y = 220; },
        (r, a) => { a.maskEngine.createMask('brush'); },
        (r, a) => { a.cropTool = { active: true }; },
        r => { r.elements.intent.value = 'Different intent'; },
        r => { r.elements['gemini-mode'].value = 'adaptive'; },
        r => { r.elements['gemini-strength'].value = '25'; },
        r => { r.elements.consent.checked = false; },
        r => { r.elements.endpoint.value = 'https://different.example'; },
        r => { r.elements.token.value = 'different-test-token'; },
        r => { r.elements.provider.value = 'local'; r.changeProvider(); },
        r => { r.elements.provider.value = 'manual'; r.changeProvider(); },
        r => r.elements.cancel.dispatch('click'),
        r => { r.elements['gemini-mode'].value = 'adaptive'; r.elements['gemini-mode'].dispatch('change'); },
        r => { r.elements['gemini-strength'].value = '25'; r.elements['gemini-strength'].dispatch('input'); },
    ];
    for (const mutate of mutations) {
        const { review, app, context } = geminiHarness();
        let finish;
        context.fetch = () => new Promise(resolve => { finish = resolve; });
        const pending = review.analyze();
        mutate(review, app);
        const changedBaseline = review.snapshot().edits;
        const historyLength = app.history.length;
        finish(Response.json(response([{ key: 'exposure', value: 0.6, reason: 'Lift.' }])));
        await pending;
        assert.equal(review.snapshot().edits, changedBaseline);
        assert.equal(app.history.length, historyLength);
        assert.equal(review.result, null);
        assert.equal(review.canCompare(), false);
    }
});

test('late cancelled Gemini response cannot overwrite a newer completed one-click request', async () => {
    const { review, app, context } = geminiHarness();
    let finish;
    context.fetch = () => new Promise(resolve => { finish = resolve; });
    const old = review.analyze();
    review.elements.cancel.dispatch('click');
    context.fetch = async () => Response.json(response([{ key: 'exposure', value: 0.3, reason: 'New result.' }]));
    await review.analyze();
    finish(Response.json(response([{ key: 'exposure', value: 0.9, reason: 'Old result.' }])));
    await old;
    assert.equal(app.state.exposure, 0.3);
    assert.equal(review.canCompare(), true);
});

test('Gemini provider, schema and allocation errors leave edits unchanged and never report applied success', async () => {
    for (const failure of ['quota', 'malformed', 'allocation']) {
        const { review, app, context } = geminiHarness();
        review.elements['gemini-mode'].value = 'adaptive';
        const baseline = review.snapshot().edits;
        const result = response([]);
        result.adaptive.regions = [adaptiveRegion()];
        if (failure === 'allocation') app.maskEngine.buildReviewMasks = () => { throw new Error('Allocation failed'); };
        context.fetch = async () => failure === 'quota'
            ? Response.json({ error: 'Quota exhausted', code: 'provider_rate_limited' }, { status: 429 })
            : Response.json(failure === 'malformed' ? { ...result, crop: {} } : result);
        await review.analyze();
        assert.equal(review.snapshot().edits, baseline);
        assert.equal(review.canCompare(), false);
        assert.doesNotMatch(review.elements.status.textContent, /Adaptive applied|Lighting and color applied/);
    }
});

const geminiKey = 'abel.gemini-connection.v1';
const geminiReady = () => Response.json({ configured: true, model: 'gemini-3.6-flash', authorized: true, tokenRequired: true });

test('Gemini connection check autofills model and opt-in saves only verified URL and token, hidden on reload', async () => {
    for (const token of ['', 'synthetic-gemini-access-token']) {
        const { review, context, storage } = geminiHarness();
        review.elements.endpoint.value = 'https://backend.example';
        review.elements.token.value = token;
        review.elements['remember-gemini'].checked = true;
        review.elements.consent.checked = false;
        context.fetch = async (url, options) => {
            assert.equal(url, 'https://backend.example/api/review/status');
            assert.equal(options.body, undefined);
            assert.equal(options.redirect, 'error');
            assert.equal(options.credentials, 'omit');
            assert.equal(storage.values.size, 0);
            return geminiReady();
        };
        await review.checkGeminiConnection();
        assert.equal(review.elements['provider-badge'].textContent, 'gemini-3.6-flash');
        assert.deepEqual(JSON.parse(storage.getItem(geminiKey)), {
            version: 1, endpoint: 'https://backend.example/api/review', token,
        });
        const restored = harness({ storage, initialize: true }).review;
        assert.equal(restored.elements.endpoint.value, 'https://backend.example/api/review');
        assert.equal(restored.elements.token.value, '');
        assert.equal(restored.elements['token-field'].hidden, true);
        assert.equal(restored.elements.consent.checked, false);
        assert.equal(restored.geminiAccessToken(), token);
        assert.equal(restored.controller, null);
        restored.elements.endpoint.value = 'https://other.example';
        assert.throws(() => restored.geminiAccessToken(), /different Gemini backend/);
        restored.elements['forget-gemini'].dispatch('click');
        assert.equal(storage.getItem(geminiKey), null);
        assert.equal(restored.elements['token-field'].hidden, false);
    }
});

test('Gemini storage is opt-in and failed or outdated status never persists credentials', async () => {
    for (const [remember, result] of [
        [false, () => geminiReady()],
        [true, () => Response.json({ configured: true, model: 'gemini-3.6-flash' })],
        [true, () => Response.json({ configured: false, model: 'gemini-3.6-flash', authorized: true })],
        [true, () => Response.json({ configured: true, model: 'gemini-3.6-flash', authorized: false })],
        [true, () => new Response('<html>Static website</html>')],
        [true, () => { throw new TypeError('Offline'); }],
    ]) {
        const { review, context, storage } = geminiHarness();
        review.elements.token.value = 'synthetic-access-token';
        review.elements['remember-gemini'].checked = remember;
        context.fetch = async () => result();
        await review.checkGeminiConnection();
        assert.equal(storage.getItem(geminiKey), null);
    }
});

test('Gemini malformed stored connections cannot supply tokens or restore consent', () => {
    for (const saved of [
        'bad json',
        JSON.stringify({ version: 1, endpoint: 'http://remote.example', token: 'test-token' }),
        JSON.stringify({ version: 1, endpoint: 'https://user:password@example.com', token: 'test-token' }),
        JSON.stringify({ version: 1, endpoint: 'https://backend.example?token=test-token', token: 'test-token' }),
        JSON.stringify({ version: 1, endpoint: 'https://backend.example', token: 'bad\nheader' }),
        JSON.stringify({ version: 1, endpoint: 'https://backend.example', token: 'test-token', consent: true }),
    ]) {
        const storage = memoryStorage();
        storage.setItem(geminiKey, saved);
        const { review } = harness({ storage, initialize: true });
        assert.equal(review.savedGeminiConnection, undefined);
        assert.equal(review.elements.consent.checked, false);
        assert.equal(review.geminiAccessToken(), '');
        assert.match(review.elements['gemini-storage-status'].textContent, /invalid or storage is unavailable/);
    }
});

test('Gemini review persists only successful validated responses and never forwards saved cloud tokens to local Qwen', async () => {
    for (const valid of [true, false]) {
        const { review, context, storage } = geminiHarness();
        review.elements.token.value = 'synthetic-gemini-token';
        review.elements['remember-gemini'].checked = true;
        context.fetch = async () => Response.json(valid ? response([]) : { error: 'Invalid' });
        await review.analyze();
        assert.equal(storage.getItem(geminiKey) !== null, valid);
        review.elements.provider.value = 'local';
        review.changeProvider();
        review.elements['local-token'].value = 'synthetic-local-token';
        assert.equal(review.requestHeaders().Authorization, 'Bearer synthetic-local-token');
    }
});

test('Gemini status cannot save credentials changed programmatically during its response', async () => {
    for (const field of ['endpoint', 'token']) {
        const { review, context, storage } = geminiHarness();
        review.elements['remember-gemini'].checked = true;
        let finish;
        context.fetch = () => new Promise(resolve => { finish = resolve; });
        const pending = review.checkGeminiConnection();
        review.elements[field].value = field === 'endpoint' ? 'https://changed.example' : 'changed-test-token';
        finish(geminiReady());
        await pending;
        assert.equal(storage.values.size, 0);
        assert.match(review.elements.status.textContent, /changed during the check/);
    }
});

test('Gemini uncheck, storage events, pending Forget and storage failures never leak or silently retain credentials', async () => {
    const { review, context, storage } = geminiHarness();
    review.elements.token.value = 'synthetic-access-token';
    review.elements['remember-gemini'].checked = true;
    context.fetch = async () => geminiReady();
    await review.checkGeminiConnection();
    review.elements['remember-gemini'].checked = false;
    review.elements['remember-gemini'].dispatch('change');
    assert.equal(storage.getItem(geminiKey), null);
    assert.equal(review.geminiAccessToken(), 'synthetic-access-token');
    review.elements['remember-gemini'].checked = true;
    await review.checkGeminiConnection();
    let finish, signal;
    context.fetch = (url, options) => {
        signal = options.signal;
        return new Promise(resolve => { finish = resolve; });
    };
    const pending = review.checkGeminiConnection();
    review.elements['forget-gemini'].dispatch('click');
    assert.equal(signal.aborted, true);
    finish(geminiReady());
    await pending;
    assert.equal(storage.getItem(geminiKey), null);
    assert.equal(review.elements.token.value, '');
    context.window.listeners.storage({ key: geminiKey, newValue: null });
    assert.equal(review.savedGeminiConnection, null);
    assert.equal(review.elements.consent.checked, false);

    const blocked = geminiHarness({ storage: {
        getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); },
        removeItem() { throw new Error('blocked'); },
    } });
    blocked.review.elements.token.value = 'synthetic-access-token';
    blocked.review.elements['remember-gemini'].checked = true;
    blocked.context.fetch = async () => geminiReady();
    await blocked.review.checkGeminiConnection();
    assert.equal(blocked.review.geminiAccessToken(), 'synthetic-access-token');
    assert.match(blocked.review.elements['gemini-storage-status'].textContent, /could not save/);
    blocked.review.forgetGeminiConnection();
    assert.match(blocked.review.elements['gemini-storage-status'].textContent, /storage could not be cleared/);
});

test('intent-first review renders new sections safely and shows genuine no-change outcomes', () => {
    const { review } = harness();
    prepare(review, []);
    review.result.improvements = [];
    review.result.inferredIntent.interpretation = '<img src=x onerror=alert(1)>';
    review.showResult();
    const textOf = node => [node.textContent, ...node.children.flatMap(textOf)];
    const feedback = textOf(review.elements.feedback);
    assert.ok(feedback.includes('Inferred intent (tentative)'));
    assert.ok(feedback.includes('Likely genre: Portrait'));
    assert.ok(feedback.includes('<img src=x onerror=alert(1)>'), 'Model text is assigned as text, not HTML');
    assert.ok(feedback.includes('Potentially intentional choices'));
    assert.ok(feedback.includes('Portfolio verdict'));
    assert.ok(feedback.includes('Borderline'));
    assert.ok(feedback.includes('No major issue identified.'));
    for (const name of ReviewContract.reviewCategories) assert.ok(feedback.includes(`${name}  7.0/10`));
    assert.ok(textOf(review.elements.adjustments).includes('No changes in this treatment at the current settings.'));
    assert.equal(review.elements['apply-bar'].hidden, false);
});

test('review applies only permitted color/light targets as one undoable transaction', () => {
    const { app, review } = harness();
    app.state.exposure = 0.2;
    app.state.clarity = 17;
    app.state.sharpenAmount = 9;
    app.state.colorGrading.shadows.blend = 0.25;
    const mask = { type: 'brush', canvas: { width: 500, height: 400 }, adjustments: { exposure: 0.1 }, visible: true };
    app.maskEngine.masks = [mask];
    app.curveEditor.channels.rgb[1].y = 240;
    const before = JSON.stringify(app.state);
    const originalImage = app.image;
    prepare(review, [
        { key: 'exposure', value: 0.6, reason: 'Lift the subject.' },
        { key: 'hslLum_3', value: -8, reason: 'Subdue bright greens.' },
    ]);
    review.apply();
    assert.equal(app.state.exposure, 0.6);
    assert.equal(app.state.hslLum[3], -8);
    assert.equal(app.state.clarity, 17);
    assert.equal(app.state.sharpenAmount, 9);
    assert.equal(app.state.colorGrading.shadows.blend, 0.25);
    assert.equal(app.image, originalImage);
    assert.equal(app.maskEngine.masks[0], mask);
    assert.equal(app.curveEditor.channels.rgb[1].y, 240);
    assert.equal(review.canCompare(), true);
    const historyLength = app.history.length;
    review.apply();
    assert.equal(app.history.length, historyLength, 'repeat Apply is disabled and idempotent');
    app._undo();
    assert.equal(JSON.stringify(app.state), before);
    assert.equal(app.image, originalImage);
    app._redo();
    assert.equal(app.state.exposure, 0.6);
});

test('review strength interpolates from existing values; zero strength is a no-op', () => {
    const { app, review } = harness();
    app.state.exposure = 0.2;
    prepare(review, [{ key: 'exposure', value: 0.6, reason: 'Lift midtones.' }]);
    review.elements.strength.value = '0';
    review.apply();
    assert.equal(app.state.exposure, 0.2);
    review.elements.strength.value = '50';
    review.apply();
    assert.equal(app.state.exposure, 0.4);
});

function adaptiveRegion(type = 'radial') {
    return {
        name: 'Subject light', reason: 'Broad light around the subject; may spill.',
        geometry: type === 'radial'
            ? { type, x: 0.5, y: 0.5, width: 0.3, height: 0.4, endX: 0, endY: 0, feather: 1 }
            : { type, x: 0, y: 0, width: 0, height: 0, endX: 0, endY: 1, feather: 1 },
        adjustments: [{ key: 'exposure', value: 0.6, reason: 'Lift the center.' }]
    };
}

test('adaptive selection is explicit, noncumulative, and applies masks plus its own base in one undo', () => {
    const { app, review } = harness();
    const old = app.maskEngine.createMask('brush');
    old.adjustments.saturation = -8;
    app.state.exposure = 0.1;
    prepare(review, [{ key: 'exposure', value: 0.7, reason: 'Global lift.' }]);
    review.result.adaptive = {
        adjustments: [{ key: 'temperature', value: 5, reason: 'Warm the scene.' }],
        regions: [adaptiveRegion(), { ...adaptiveRegion('gradient'), name: 'Foreground' }]
    };
    const baseline = review.snapshot().edits;
    review.showResult();
    review.apply();
    assert.equal(review.snapshot().edits, baseline, 'no implicit choice');
    review.selection = 'global';
    assert.equal(review.targets()[0].value, 0.7);
    review.selection = 'adaptive';
    assert.equal(review.targets()[0].key, 'temperature');
    assert.equal(review.snapshot().edits, baseline, 'switching only changes the proposal display');
    review.apply();
    assert.equal(app.state.exposure, 0.1, 'global alternative was not added');
    assert.equal(app.state.temperature, 5);
    assert.equal(app.maskEngine.masks.length, 3);
    assert.equal(app.maskEngine.masks[0], old, 'existing mask is untouched');
    assert.equal(app.maskEngine.masks[1].adjustments.exposure, 0.6);
    assert.equal(app.maskEngine.masks[1].params.cx, 250);
    assert.equal(app.maskEngine.masks[1].params.ry, 160);
    assert.equal(app.maskEngine.masks[2].params.y2, 400);
    const applied = review.snapshot().edits;
    app._startComparison(true);
    assert.equal(app._comparisonMasks.length, 1);
    assert.equal(app._comparisonState.temperature, 0);
    app._stopComparison();
    app._undo();
    assert.equal(review.snapshot().edits, baseline);
    app._redo();
    assert.equal(review.snapshot().edits, applied);
    assert.equal(review.canCompare(), true, 'redo can compare against the same baseline');
});

test('adaptive strength scales offsets, not geometry; zero is a baseline transaction ready to switch', () => {
    for (const strength of [0, 50, 100]) {
        const { app, review } = harness();
        prepare(review, []);
        review.result.adaptive.regions = [adaptiveRegion()];
        review.selection = 'adaptive';
        review.elements.strength.value = String(strength);
        const count = app.history.length;
        review.apply();
        if (!strength) {
            assert.equal(app.maskEngine.masks.length, 0);
            assert.equal(app.history.length, count + 1);
        } else {
            assert.equal(app.maskEngine.masks[0].adjustments.exposure, 0.6 * strength / 100);
            assert.equal(app.maskEngine.masks[0].params.rx, 150);
        }
    }
});

test('adaptive revalidates geometry, offsets, strength, and stale mask pixels before application', () => {
    for (const mutate of [
        review => { review.result.adaptive.regions[0].geometry.x = NaN; },
        review => { review.result.adaptive.regions[0].adjustments[0].key = 'clarity'; },
        review => { review.elements.strength.value = 'Infinity'; },
        review => { review.app.maskEngine.touch(review.app.maskEngine.masks[0]); },
        review => { review.app.imageWidth = 200; },
        review => { review.app.cropTool = { active: true }; }
    ]) {
        const { app, review } = harness();
        app.maskEngine.createMask('radial');
        prepare(review, []);
        review.result.adaptive.regions = [adaptiveRegion()];
        review.selection = 'adaptive';
        const historyLength = app.history.length;
        mutate(review);
        review.apply();
        assert.equal(app.maskEngine.masks.length, 1);
        assert.equal(app.history.length, historyLength);
    }
});

test('mask allocation failure leaves global adjustments and history unchanged', () => {
    const { app, review } = harness();
    prepare(review, []);
    review.result.adaptive = {
        adjustments: [{ key: 'exposure', value: 0.5, reason: 'Lift.' }], regions: [adaptiveRegion()]
    };
    review.selection = 'adaptive';
    app.maskEngine.buildReviewMasks = () => { throw new Error('Allocation failed'); };
    const before = review.snapshot().edits;
    review.apply();
    assert.equal(review.snapshot().edits, before);
    assert.equal(app.history.length, 1);
    assert.match(review.elements.status.textContent, /not applied/);
});

test('normalized adaptive geometry maps to capped mask pixels, not original or preview dimensions', () => {
    const { app, review } = harness();
    app.imageWidth = 8000;
    app.imageHeight = 4000;
    prepare(review, []);
    review.result.adaptive.regions = [adaptiveRegion()];
    review.selection = 'adaptive';
    review.apply();
    const mask = app.maskEngine.masks[0];
    assert.equal(mask.canvas.width, 4096);
    assert.equal(mask.canvas.height, 2048);
    assert.equal(mask.params.cx, 2048);
    assert.equal(mask.params.cy, 1024);
    assert.equal(mask.params.rx, 4096 * 0.3);
});

test('zero global strength does not quantize existing fractional slider values', () => {
    const { app, review } = harness();
    app.state.exposure = 0.205;
    prepare(review, [{ key: 'exposure', value: 0.8, reason: 'Lift.' }]);
    review.elements.strength.value = '0';
    review.apply();
    assert.equal(app.state.exposure, 0.205);
});

test('edited, recropped, or replaced photos cannot receive stale recommendations', () => {
    for (const change of [
        app => { app.state.saturation = 4; },
        app => { app.image = { width: 500, height: 400 }; },
        app => { app.curveEditor.channels.rgb[1].y = 230; },
        app => { app.maskEngine.masks = [{ canvas: { width: 500, height: 400 }, adjustments: {} }]; },
    ]) {
        const { app, review } = harness();
        prepare(review, [{ key: 'exposure', value: 0.5, reason: 'Lift midtones.' }]);
        change(app);
        review.apply();
        assert.equal(app.state.exposure, 0);
        review.onRender();
        assert.equal(review.result, null);
    }
});

test('a tampered response cannot set crop, sharpen, or arbitrary state', () => {
    for (const key of ['crop', 'sharpenAmount', '__proto__', 'showOriginal']) {
        const { app, review } = harness();
        prepare(review, [{ key: 'exposure', value: 0.5, reason: 'Lift midtones.' }]);
        review.result.adjustments[0].key = key;
        const before = JSON.stringify(app.state);
        // Application validation happens again, independently of request validation.
        review.apply();
        assert.match(review.elements.status.textContent, /not applied/);
        assert.equal(JSON.stringify(app.state), before);
    }
});

test('Undo after review restores color edits before undoing an earlier crop', () => {
    const { app, review } = harness();
    app.state.temperature = 12;
    app._pushHistory();
    const cropped = app.image;
    const original = { width: 1000, height: 800 };
    app._preCropImage = original;
    app._preCropWidth = 1000;
    app._preCropHeight = 800;
    app._preCropHistoryIndex = app.historyIndex;
    prepare(review, [{ key: 'exposure', value: 0.5, reason: 'Lift midtones.' }]);
    review.apply();
    app._undo();
    assert.equal(app.state.exposure, 0);
    assert.equal(app.state.temperature, 12);
    assert.equal(app.image, cropped);
    app._undo();
    assert.equal(app.image, original);
    assert.equal(app.imageWidth, 1000);
    assert.equal(app.state.temperature, 12);
});

test('comparison selects pre-review state without changing real edits or source', () => {
    const { app, review, document } = harness();
    prepare(review, [{ key: 'exposure', value: 0.5, reason: 'Lift midtones.' }]);
    review.apply();
    const image = app.image;
    app._startComparison(true);
    assert.equal(app._comparisonState.exposure, 0);
    assert.equal(app.state.exposure, 0.5);
    assert.equal(app.showingOriginal, false);
    assert.equal(document.getElementById('compare-label').hidden, false);
    app._stopComparison();
    assert.equal(app._comparisonState, null);
    assert.equal(app.state.exposure, 0.5);
    assert.equal(app.image, image);
    assert.equal(document.getElementById('compare-label').hidden, true);
});

test('review accepts backend base or full endpoint URLs without exposing credentials in URLs', () => {
    const { review } = harness();
    review.elements.endpoint = { value: '' };
    assert.equal(review.endpoint(), 'http://localhost:3000/api/review');
    for (const value of ['https://review.example', 'https://review.example/api/review/']) {
        review.elements.endpoint.value = value;
        assert.equal(review.endpoint(), 'https://review.example/api/review');
    }
    for (const value of ['not a URL', 'http://public.example', 'https://user:password@example.com',
        'https://review.example?key=secret', 'javascript:alert(1)']) {
        review.elements.endpoint.value = value;
        assert.throws(() => review.endpoint());
    }
});

test('provider errors do not misleadingly open backend connection settings', async () => {
    for (const code of ['provider_model_unavailable', 'provider_authentication', 'provider_permission',
        'provider_rate_limited', 'provider_request_rejected', 'unauthorized', 'origin_denied']) {
        const { review, context } = harness();
        for (const field of ['endpoint', 'token', 'intent']) review.elements[field] = { value: '' };
        review.elements.connection = { open: false };
        review.preview = () => 'test-preview';
        context.ReviewContract = { ...ReviewContract, validateRequest() {} };
        let requested = false;
        context.fetch = async () => {
            requested = true;
            return Response.json({ error: 'Actionable provider error.', code }, { status: 503 });
        };
        await review.analyze();
        assert.equal(requested, true);
        assert.equal(review.elements.status.textContent, 'Actionable provider error.');
        assert.equal(review.elements.connection.open, ['unauthorized', 'origin_denied'].includes(code));
        assert.equal(review.result, null);
        assert.equal(review.controller, null);
    }
});

test('local endpoints stay on loopback and never reuse the cloud backend URL', () => {
    const { review, context } = harness();
    context.window.location.origin = 'https://abel.example';
    review.elements.endpoint.value = 'https://cloud.example';
    review.elements.provider.value = 'local';
    assert.equal(review.endpoint(), 'http://127.0.0.1:4178/api/review/local');
    for (const url of ['http://localhost:3000', 'http://127.0.0.1:4178/api/review/local/',
        'http://[::1]:4178']) {
        review.elements['local-endpoint'].value = url;
        assert.match(review.endpoint(), /\/api\/review\/local$/);
    }
    for (const url of ['https://cloud.example', 'http://192.168.1.2:4178',
        'http://127.0.0.1.evil.example', 'http://127.0.0.1:4178/api/review',
        'http://localhost:11434/api/chat', 'http://localhost:4178?token=secret']) {
        review.elements['local-endpoint'].value = url;
        assert.throws(() => review.endpoint());
    }
    context.window.location = { href: 'file:///tmp/abel/index.html', origin: 'null' };
    review.elements['local-endpoint'].value = '';
    assert.equal(review.endpoint(), 'http://127.0.0.1:4178/api/review/local');
});

test('cloud and local reviews use separate endpoints and credentials with identical safe application', async () => {
    for (const provider of ['gemini', 'local']) {
        const { app, review, context } = harness();
        review.elements.provider.value = provider;
        review.elements.endpoint.value = 'https://cloud.example';
        review.elements['local-endpoint'].value = 'http://localhost:4178';
        review.elements.token.value = 'cloud-test-token';
        review.elements['local-token'].value = 'local-test-token';
        review.preview = () => 'synthetic-preview';
        review.showResult = () => {};
        context.ReviewContract = { ...ReviewContract, validateRequest() {} };
        const requests = [];
        context.fetch = async (url, options) => {
            requests.push({ url, ...options });
            return Response.json(response([{ key: 'exposure', value: 0.4, reason: 'Lift midtones.' }]));
        };
        await review.analyze();
        assert.equal(requests.length, 1);
        assert.equal(requests[0].url, provider === 'local'
            ? 'http://localhost:4178/api/review/local' : 'https://cloud.example/api/review');
        assert.equal(requests[0].headers.Authorization, `Bearer ${provider === 'local' ? 'local' : 'cloud'}-test-token`);
        assert.equal(requests[0].redirect, 'error');
        assert.equal(requests[0].credentials, 'omit');
        assert.deepEqual(Object.keys(JSON.parse(requests[0].body)).sort(), ['adjustments', 'allowDetails', 'image', 'intent']);
        const image = app.image;
        review.selection = 'global';
        review.apply();
        assert.equal(app.state.exposure, 0.4);
        app._undo();
        assert.equal(app.state.exposure, 0);
        assert.equal(app.image, image);
    }
});

test('a failed local review never falls back to Gemini', async () => {
    const { review, context } = harness();
    review.elements.provider.value = 'local';
    review.preview = () => 'synthetic-preview';
    context.ReviewContract = { ...ReviewContract, validateRequest() {} };
    const urls = [];
    context.fetch = async url => {
        urls.push(url);
        return Response.json({ error: 'Ollama is not running.', code: 'local_unavailable' }, { status: 503 });
    };
    await review.analyze();
    assert.deepEqual(urls, ['http://localhost:3000/api/review/local']);
    assert.equal(review.result, null);
    assert.match(review.elements.status.textContent, /Ollama is not running/);
});

test('switching providers aborts pending reviews, resets consent and discards late responses', async () => {
    const { review, context } = harness();
    review.elements.provider.value = 'local';
    review.preview = () => 'synthetic-preview';
    context.ReviewContract = { ...ReviewContract, validateRequest() {} };
    let finish;
    let signal;
    let requests = 0;
    context.fetch = (url, options) => {
        requests++;
        signal = options.signal;
        return new Promise(resolve => { finish = resolve; });
    };
    const pending = review.analyze();
    assert.equal(requests, 1);
    review.elements.provider.value = 'gemini';
    review.changeProvider();
    assert.equal(signal.aborted, true);
    assert.equal(review.elements.consent.checked, false);
    assert.equal(review.elements.analyze.disabled, true);
    finish(Response.json(response([])));
    await pending;
    assert.equal(review.result, null);
    assert.equal(review.controller, null);
    assert.equal(requests, 1, 'switching does not automatically send a cloud request');
});

test('local connection checks send no photo and require a local-only ready model response', async () => {
    for (const valid of [true, false]) {
        const { review, context } = harness();
        review.elements.provider.value = 'local';
        review.elements.consent.checked = false;
        let captured;
        context.fetch = async (url, options) => {
            captured = { url, ...options };
            return Response.json(valid
                ? { provider: 'ollama', model: 'qwen3-vl:2b-instruct', ready: true, localOnly: true }
                : { provider: 'gemini', model: 'gemini-3.6-flash', ready: true });
        };
        await review.checkLocalConnection();
        assert.equal(captured.url, 'http://localhost:3000/api/review/local/status');
        assert.equal(captured.body, undefined);
        assert.equal(review.localModel, valid ? 'qwen3-vl:2b-instruct' : undefined);
        assert.equal(review.result, null);
        assert.match(review.elements.status.textContent, valid ? /No photo was sent/ : /did not identify/);
    }
});

const localReady = () => Response.json({
    provider: 'ollama', model: 'qwen3-vl:2b-instruct', ready: true, localOnly: true,
});
const savedLocal = {
    version: 1, endpoint: 'http://localhost:4178/api/review/local', token: 'synthetic-local-token',
};
const localKey = 'abel.local-connection.v1';

function localConnectionHarness(options) {
    const fixture = harness({ initialize: true, ...options });
    fixture.review.elements.provider.value = 'local';
    fixture.review.changeProvider();
    fixture.review.elements['local-endpoint'].value = 'http://localhost:4178';
    fixture.context.fetch = async () => localReady();
    return fixture;
}

test('local credentials are saved only after success and restored hidden without consent or requests', async () => {
    const { review, context, storage } = localConnectionHarness();
    review.elements['local-token'].value = savedLocal.token;
    review.elements['local-token'].dispatch('input');
    assert.equal(storage.getItem(localKey), null, 'typing does not persist credentials');
    let request;
    context.fetch = async (url, options) => {
        request = { url, ...options };
        assert.equal(storage.getItem(localKey), null, 'authentication must finish first');
        return localReady();
    };
    await review.checkLocalConnection();
    assert.equal(request.headers.Authorization, `Bearer ${savedLocal.token}`);
    assert.equal(request.body, undefined);
    assert.deepEqual(JSON.parse(storage.getItem(localKey)), savedLocal);
    assert.equal(storage.values.size, 1);
    assert.equal(review.elements['local-token'].value, '');
    assert.equal(review.elements['local-token-field'].hidden, true);
    assert.equal(review.elements['forget-local'].hidden, false);
    assert.match(review.elements['local-storage-status'].textContent, /Saved on this browser/);
    for (let tab = 0; tab < 2; tab++) {
        const restored = harness({ storage, initialize: true }).review;
        assert.equal(restored.elements.provider.value, 'local');
        assert.equal(restored.elements.consent.checked, false);
        assert.equal(restored.elements.analyze.disabled, true);
        assert.equal(restored.elements['local-token-field'].hidden, true);
        assert.equal(restored.requestHeaders().Authorization, `Bearer ${savedLocal.token}`);
        assert.equal(restored.controller, null);
        assert.equal(restored.result, null);
    }
});

test('opt-out and same-origin tokenless checks never persist credentials', async () => {
    for (const token of ['', savedLocal.token]) {
        const { review, storage } = localConnectionHarness();
        review.elements['remember-local'].checked = !token;
        review.elements['local-token'].value = token;
        await review.checkLocalConnection();
        assert.equal(storage.getItem(localKey), null);
        assert.equal(review.elements['local-token'].value, token);
    }
});

test('unauthorized, unready, malformed and failed checks never save a token', async () => {
    for (const result of [
        () => Response.json({ error: 'Denied' }, { status: 401 }),
        () => Response.json({ provider: 'ollama', ready: false, localOnly: true, model: 'qwen3-vl:2b' }),
        () => Response.json({ provider: 'gemini', ready: true }),
        () => new Response('not json'),
        () => { throw new TypeError('Network failed'); },
    ]) {
        const { review, context, storage } = localConnectionHarness();
        review.elements['local-token'].value = savedLocal.token;
        context.fetch = async () => result();
        await review.checkLocalConnection();
        assert.equal(storage.getItem(localKey), null);
        assert.equal(review.elements['local-token-field'].hidden, false);
        assert.doesNotMatch(review.elements['local-storage-status'].textContent, /Saved on this browser/);
    }
});

test('only successful validated local reviews persist; cloud credentials and request bodies stay separate', async () => {
    for (const provider of ['local', 'gemini']) {
        for (const valid of [true, false]) {
            const { review, context, storage } = localConnectionHarness();
            review.elements.provider.value = provider;
            review.elements.consent.checked = true;
            review.elements['local-token'].value = savedLocal.token;
            review.elements.token.value = 'synthetic-cloud-token';
            review.preview = () => 'synthetic-preview';
            review.showResult = () => {};
            context.ReviewContract = { ...ReviewContract, validateRequest() {} };
            context.fetch = async (url, options) => {
                assert.equal(options.headers.Authorization, `Bearer ${provider === 'local' ? savedLocal.token : 'synthetic-cloud-token'}`);
                assert.deepEqual(Object.keys(JSON.parse(options.body)).sort(), ['adjustments', 'allowDetails', 'image', 'intent']);
                assert.ok(!options.body.includes('token'));
                return Response.json(valid ? response([]) : { error: 'Malformed review' });
            };
            await review.analyze();
            assert.equal(storage.getItem(localKey) !== null, provider === 'local' && valid);
        }
    }
});

test('saved credentials cannot follow changed endpoints, including a changed loopback port', async () => {
    const { review, context, storage } = localConnectionHarness();
    review.elements['local-token'].value = savedLocal.token;
    await review.checkLocalConnection();
    review.elements['local-endpoint'].value = 'http://localhost:4179';
    let requests = 0;
    context.fetch = async () => { requests++; return localReady(); };
    await review.checkLocalConnection();
    assert.equal(requests, 0, 'even a programmatic endpoint change cannot forward saved credentials');
    assert.match(review.elements.status.textContent, /different local companion/);
    review.elements['local-endpoint'].dispatch('input');
    assert.equal(storage.getItem(localKey), null);
    assert.equal(review.elements['local-token'].value, '');
    assert.equal(review.elements['local-token-field'].hidden, false);
    assert.equal(review.elements.consent.checked, false);
    assert.equal(review.requestHeaders().Authorization, undefined);
});

test('Forget clears token and aborts checks, ignores late success, and preserves photo edits and masks', async () => {
    const { review, context, storage, app } = localConnectionHarness();
    review.elements['local-token'].value = savedLocal.token;
    await review.checkLocalConnection();
    app.state.exposure = 0.7;
    app.maskEngine.createMask('brush');
    const before = review.snapshot();
    let finish;
    let signal;
    context.fetch = (url, options) => {
        signal = options.signal;
        return new Promise(resolve => { finish = resolve; });
    };
    const pending = review.checkLocalConnection();
    review.elements['forget-local'].dispatch('click');
    assert.equal(signal.aborted, true);
    finish(localReady());
    await pending;
    assert.equal(storage.getItem(localKey), null);
    assert.equal(review.savedLocalConnection, null);
    assert.equal(review.elements['local-token'].value, '');
    assert.equal(review.elements['local-token-field'].hidden, false);
    assert.equal(review.snapshot().edits, before.edits);
    assert.equal(app.image, before.image);
});

test('editing token during authentication aborts and does not save the late response', async () => {
    const { review, context, storage } = localConnectionHarness();
    let finish;
    context.fetch = () => new Promise(resolve => { finish = resolve; });
    review.elements['local-token'].value = 'first-test-token';
    const pending = review.checkLocalConnection();
    review.elements['local-token'].value = 'second-test-token';
    review.elements['local-token'].dispatch('input');
    finish(localReady());
    await pending;
    assert.equal(storage.getItem(localKey), null);
});

test('unchecking remember removes persistence but retains usable session-only credentials', async () => {
    const { review, storage } = localConnectionHarness();
    review.elements['local-token'].value = savedLocal.token;
    await review.checkLocalConnection();
    review.elements['remember-local'].checked = false;
    review.elements['remember-local'].dispatch('change');
    assert.equal(storage.getItem(localKey), null);
    assert.equal(review.requestHeaders().Authorization, `Bearer ${savedLocal.token}`);
    await review.checkLocalConnection();
    assert.equal(storage.getItem(localKey), null);
});

test('forgetting in another tab clears memory and aborts local work without affecting cloud or manual work', async () => {
    for (const provider of ['local', 'gemini', 'manual']) {
        const storage = memoryStorage();
        storage.setItem(localKey, JSON.stringify(savedLocal));
        const { review, context } = harness({ storage, initialize: true });
        review.elements.provider.value = provider;
        review.elements.consent.checked = true;
        const controller = new AbortController();
        review.controller = controller;
        storage.removeItem(localKey);
        context.window.listeners.storage({ key: localKey, newValue: null });
        assert.equal(review.savedLocalConnection, null);
        assert.equal(review.elements['local-token'].value, '');
        assert.equal(review.elements['local-token-field'].hidden, false);
        assert.equal(controller.signal.aborted, provider === 'local');
        assert.equal(review.elements.consent.checked, provider !== 'local');
    }
});

test('invalid stored values are rejected visibly using the same loopback URL constraints', () => {
    for (const raw of [
        'bad json', 'null', '[]', JSON.stringify({ ...savedLocal, version: 2 }),
        JSON.stringify({ ...savedLocal, token: '' }), JSON.stringify({ ...savedLocal, token: 'a\nb' }),
        JSON.stringify({ ...savedLocal, image: 'must-not-be-stored' }),
        ...['https://remote.example', 'http://localhost:4178/api/chat', 'http://user:pass@localhost:4178',
            'http://localhost:4178?token=anything', 'http://localhost:4178#fragment', 'file:///etc/passwd', '']
            .map(endpoint => JSON.stringify({ ...savedLocal, endpoint })),
    ]) {
        const storage = memoryStorage();
        storage.setItem(localKey, raw);
        const { review } = harness({ storage, initialize: true });
        assert.equal(review.savedLocalConnection, undefined);
        assert.equal(review.elements['local-token'].value, '');
        assert.equal(review.elements['local-token-field'].hidden, false);
        assert.match(review.elements['local-storage-status'].textContent, /could not be loaded/);
        review.forgetLocalConnection();
        assert.equal(storage.getItem(localKey), null);
    }
});

test('storage read/write/removal failures stay explicit and do not prevent in-memory authentication', async () => {
    const storage = {
        getItem() { throw new Error('Denied'); },
        setItem() { throw new Error('Quota exceeded'); },
        removeItem() { throw new Error('Denied'); },
    };
    const { review } = localConnectionHarness({ storage });
    assert.match(review.elements['local-storage-status'].textContent, /could not be loaded/);
    review.elements['local-token'].value = savedLocal.token;
    await review.checkLocalConnection();
    assert.match(review.elements.status.textContent, /ready/);
    assert.match(review.elements['local-storage-status'].textContent, /could not save/);
    assert.equal(review.elements['local-token-field'].hidden, false);
    assert.equal(review.requestHeaders().Authorization, `Bearer ${savedLocal.token}`);
    review.forgetLocalConnection();
    assert.equal(review.requestHeaders().Authorization, undefined);
    assert.match(review.elements['local-storage-status'].textContent, /could not be cleared/);
});

test('restored local tokens never enter cloud headers or manual exports', async () => {
    const storage = memoryStorage();
    storage.setItem(localKey, JSON.stringify(savedLocal));
    const { review, context } = harness({ storage, initialize: true });
    review.elements.provider.value = 'gemini';
    review.changeProvider();
    assert.equal(review.requestHeaders().Authorization, undefined);
    review.elements.provider.value = 'manual';
    review.changeProvider();
    review.preview = () => manualJPEG;
    review.download = () => {};
    context.fetch = () => { throw new Error('Must not send requests'); };
    await review.exportManual();
    assert.ok(review.manualExport);
    assert.ok(!review.manualExport.prompt.includes(savedLocal.token));
    assert.ok(!review.manualExport.prompt.includes(savedLocal.endpoint));
    assert.deepEqual(JSON.parse(storage.getItem(localKey)), savedLocal);
});

// Minimal structural JPEG fixture; browser checks use an actual decoded rendered JPEG.
const manualJPEG = Buffer.from([
    255, 216, 255, 192, 0, 11, 8, 0, 1, 0, 1, 1, 1, 17, 0,
    255, 218, 0, 8, 1, 1, 0, 0, 63, 0, 0, 255, 217
]).toString('base64');

function manualHarness() {
    const fixture = harness();
    const { app, review, context } = fixture;
    review.elements.provider.value = 'manual';
    review.changeProvider();
    review.preview = () => manualJPEG;
    app._fileName = 'Quiet scene';
    const downloads = [];
    review.download = (blob, name) => downloads.push({ blob, name });
    context.fetch = () => { assert.fail('Manual review must never call fetch, including on error'); };
    return { ...fixture, downloads };
}

test('manual export bundles current settings and shares no data; import uses normal global strength/apply/undo', async () => {
    const { app, review, downloads } = manualHarness();
    app.state.exposure = 0.2;
    app.state.hslSat[3] = -7;
    review.elements.intent.value = 'Quiet, warm.';
    const before = review.snapshot().edits;
    await review.exportManual();
    assert.equal(review.elements.connection.hidden, true);
    assert.equal(review.elements['consent-label'].hidden, true);
    assert.equal(review.elements.analyze.hidden, true);
    assert.equal(review.elements.consent.checked, false);
    assert.equal(downloads.length, 1);
    assert.equal(downloads[0].name, 'Quiet_scene_ChatGPT.jpg');
    assert.equal(downloads[0].blob.type, 'image/jpeg');
    assert.equal(Buffer.from(await downloads[0].blob.arrayBuffer()).toString('base64'), manualJPEG);
    assert.equal(review.context.edits, before);
    assert.match(review.elements.prompt.value, /"exposure": 0.2/);
    assert.match(review.elements.prompt.value, /"hslSat_3": -7/);
    assert.match(review.elements.prompt.value, /Quiet, warm/);
    review.downloadManual('prompt');
    assert.equal(await downloads[1].blob.text(), review.elements.prompt.value);
    assert.equal(downloads[1].name, 'Quiet_scene_ChatGPT_prompt.txt');
    review.elements.paste.value = JSON.stringify(response([{ key: 'exposure', value: 0.6, reason: 'Lift.' }]));
    review.importManual();
    assert.equal(review.snapshot().edits, before);
    assert.equal(review.elements.apply.disabled, true);
    review.selection = 'global';
    review.elements.strength.value = '50';
    review.apply();
    assert.equal(app.state.exposure, 0.4);
    assert.equal(review.canCompare(), true);
    app._startComparison(true);
    assert.equal(app._comparisonState.exposure, 0.2);
    app._stopComparison();
    app._undo();
    assert.equal(review.snapshot().edits, before);
    app._redo();
    assert.equal(app.state.exposure, 0.4);
    await review.analyze();
    await review.checkLocalConnection();
});

test('manual adaptive import preserves old masks, uses independent base and full undo/redo comparison', async () => {
    const { app, review } = manualHarness();
    const old = app.maskEngine.createMask('brush');
    old.adjustments.exposure = -0.1;
    await review.exportManual();
    const before = review.snapshot().edits;
    const data = response([{ key: 'exposure', value: 0.9, reason: 'Global lift.' }]);
    data.adaptive = { adjustments: [{ key: 'temperature', value: 8, reason: 'Warm.' }],
        regions: [adaptiveRegion()] };
    review.elements.paste.value = '```json\n' + JSON.stringify(data) + '\n```';
    review.importManual();
    review.selection = 'adaptive';
    review.elements.strength.value = '50';
    review.apply();
    assert.equal(app.state.exposure, 0);
    assert.equal(app.state.temperature, 4);
    assert.equal(app.maskEngine.masks.length, 2);
    assert.equal(app.maskEngine.masks[0], old);
    assert.equal(app.maskEngine.masks[1].adjustments.exposure, 0.3);
    app._startComparison(true);
    assert.equal(app._comparisonMasks.length, 1);
    app._stopComparison();
    app._undo();
    assert.equal(review.snapshot().edits, before);
    app._redo();
    assert.equal(review.canCompare(), true);
});

test('manual import requires an export in this tab; malformed replies can be corrected without a new export', async () => {
    const { app, review } = manualHarness();
    review.elements.paste.value = JSON.stringify(response([]));
    review.importManual();
    assert.equal(review.result, null);
    assert.match(review.elements.status.textContent, /Export the current photo first/);
    await review.exportManual();
    const baseline = review.context;
    const history = app.history.length;
    for (const text of ['not JSON', '{"rating": 7}', ' '.repeat(262145),
        JSON.stringify(response([])).replace('"rating":7.5', '"rating":7.5,"rating":8')]) {
        review.elements.paste.value = text;
        review.importManual();
        assert.equal(review.result, null);
        assert.equal(review.context, baseline);
        assert.equal(app.history.length, history);
        assert.match(review.elements.status.textContent, /Cannot import/);
    }
    review.elements.paste.value = JSON.stringify(response([]));
    review.importManual();
    assert.ok(review.result);
    assert.equal(review.elements['apply-bar'].hidden, false);
    await review.exportManual();
    assert.equal(review.result, null);
    assert.equal(review.elements.paste.value, '');
});

test('manual smart-quote repair is opt-in, transparent, transactional and never auto-applies', async () => {
    const { app, review } = manualHarness();
    const text = readFileSync(path.join(__dirname, 'fixtures/intensity-review.json'), 'utf8').trim();
    const mobile = text.replace(/"(?:[^"\\]|\\.)*"/g, token => `“${token.slice(1, -1)}”`);
    review.updateButtons();
    assert.equal(review.elements['fix-quotes'].disabled, true);
    await review.exportManual();
    const baseline = review.context;
    const state = JSON.stringify(app.state);
    const history = app.history.length;
    review.elements.paste.value = mobile;
    review.updateButtons();
    assert.equal(review.elements['fix-quotes'].disabled, false);
    review.importManual();
    assert.equal(review.result, null);
    assert.equal(review.elements.paste.value, mobile);
    review.importManual(true);
    assert.deepEqual(review.result, JSON.parse(text));
    assert.equal(review.elements.paste.value, text);
    assert.match(review.elements.status.textContent, /corrected JSON is shown above/);
    assert.equal(review.elements.apply.disabled, true);
    assert.equal(review.selection, '');
    assert.equal(review.context, baseline);
    assert.equal(JSON.stringify(app.state), state);
    assert.equal(app.history.length, history);
    for (const invalid of [
        mobile.slice(0, -1),
        mobile.replace('“rating”:', '“rating”:8,“\\u0072ating”:'),
        mobile.replace('“rating”:', '“unsupported”:1,“rating”:'),
        mobile.replace('“summary”:', '“summary":'),
        'not JSON',
    ]) {
        review.elements.paste.value = invalid;
        review.importManual(true);
        assert.equal(review.result, null);
        assert.equal(review.elements.paste.value, invalid);
        assert.equal(review.context, baseline);
        assert.equal(JSON.stringify(app.state), state);
        assert.equal(app.history.length, history);
        assert.match(review.elements.status.textContent, /Cannot import/);
    }
});

test('repair action refuses absent, stale, switched, busy and crop baselines', async () => {
    for (const change of [
        (app, review) => { review.manualExport = null; },
        app => { app.image = {}; },
        app => { app.state.saturation = 8; },
        app => { app.curveEditor.channels.rgb[1].y = 220; },
        (app, review) => { review.elements.intent.value = 'Different intent'; },
        (app, review) => { review.elements.provider.value = 'gemini'; review.changeProvider(); },
        (app, review) => { review.controller = new AbortController(); },
        app => { app.cropTool = { active: true }; },
    ]) {
        const { app, review } = manualHarness();
        await review.exportManual();
        change(app, review);
        const state = JSON.stringify(app.state);
        const history = app.history.length;
        review.elements.paste.value = JSON.stringify(response([])).replace('"rating"', '“rating”');
        const pasted = review.elements.paste.value;
        review.updateButtons();
        assert.equal(review.elements['fix-quotes'].disabled, true);
        review.importManual(true);
        assert.equal(review.result, null);
        assert.equal(review.elements.paste.value, pasted);
        assert.equal(JSON.stringify(app.state), state);
        assert.equal(app.history.length, history);
    }
});

test('every manual baseline component and provider/intent change invalidates the export', async () => {
    for (const change of [
        app => { app.image = {}; },
        app => { app.imageWidth = 200; },
        app => { app.state.saturation = 5; },
        app => { app.curveEditor.channels.rgb[1].y = 220; },
        app => { app.maskEngine.touch(app.maskEngine.masks[0]); },
        app => { app.maskEngine.masks[0].adjustments.exposure = 0.1; },
        app => { app.review.elements.intent.value = 'Different intent'; },
    ]) {
        const { app, review, downloads } = manualHarness();
        app.maskEngine.createMask('radial');
        await review.exportManual();
        change(app);
        review.elements.paste.value = JSON.stringify(response([]));
        review.importManual();
        assert.equal(review.result, null);
        assert.equal(review.manualExport, null);
        review.downloadManual('image');
        assert.equal(downloads.length, 1);
    }
    const { app, review } = manualHarness();
    await review.exportManual();
    review.elements.paste.value = JSON.stringify(response([{ key: 'exposure', value: 0.4, reason: 'Lift.' }]));
    review.importManual();
    review.selection = 'global';
    review.apply();
    review.elements.provider.value = 'gemini';
    review.changeProvider();
    assert.equal(app.state.exposure, 0.4, 'provider change must not undo applied edits');
    assert.equal(review.manualExport, null);
    assert.equal(review.elements.prompt.value, '');
    assert.equal(review.elements.manual.hidden, true);
    assert.equal(review.elements.connection.hidden, false);
    assert.equal(review.elements.consent.checked, false);
});

test('in-flight manual exports discard cancelled, switched, or changed photo/edit/intent contexts', async () => {
    for (const action of [
        review => review.invalidate('Cancelled'),
        review => { review.elements.provider.value = 'local'; review.changeProvider(); },
        review => { review.app.image = {}; },
        review => { review.app.state.exposure = 0.2; },
        review => { review.elements.intent.value = 'New intent'; },
        review => { review.app.cropTool = { active: true }; },
    ]) {
        const { review, downloads } = manualHarness();
        let finish;
        review.preview = () => new Promise(resolve => { finish = resolve; });
        const exporting = review.exportManual();
        action(review);
        finish(manualJPEG);
        await exporting;
        assert.equal(downloads.length, 0);
        assert.equal(review.manualExport, null);
        assert.equal(review.result, null);
        assert.equal(review.controller, null);
    }
});

test('manual clipboard denial offers selectable prompt and download fallback without losing export', async () => {
    const { review, context, downloads } = manualHarness();
    await review.exportManual();
    let selected = false;
    review.elements.prompt.focus = () => {};
    review.elements.prompt.select = () => { selected = true; };
    for (const clipboard of [undefined, { writeText: async () => { throw new Error('Denied'); } }]) {
        context.navigator.clipboard = clipboard;
        await review.copyManualPrompt();
        assert.equal(selected, true);
        assert.match(review.elements.status.textContent, /Clipboard unavailable or denied/);
        assert.ok(review.manualReady());
    }
    review.downloadManual('prompt');
    assert.equal(downloads.length, 2);
});

test('switching a pending network request to manual aborts it and cannot overwrite a fresh export', async () => {
    const { review, context } = harness();
    review.preview = () => manualJPEG;
    let finish;
    let signal;
    context.fetch = (url, options) => {
        signal = options.signal;
        return new Promise(resolve => { finish = resolve; });
    };
    const pending = review.analyze();
    review.elements.provider.value = 'manual';
    review.changeProvider();
    assert.equal(signal.aborted, true);
    review.download = () => {};
    await review.exportManual();
    const exported = review.manualExport;
    finish(Response.json(response([{ key: 'exposure', value: 0.5, reason: 'Late reply.' }])));
    await pending;
    assert.equal(review.result, null);
    assert.equal(review.manualExport, exported);
    assert.equal(review.manualReady(), true);
    assert.equal(review.elements.consent.checked, false);
});

test('manual export errors and unavailable photos/crop sessions do not create usable contexts', async () => {
    for (const failure of [
        review => { review.preview = () => { throw new Error('Canvas unavailable'); }; },
        review => { review.preview = () => 'not-jpeg'; },
        review => { review.app.state.exposure = NaN; },
        review => { review.elements.intent.value = 'x'.repeat(601); },
        review => { review.app.image = null; },
        review => { review.app.cropTool = { active: true }; }
    ]) {
        const { review, downloads } = manualHarness();
        failure(review);
        await review.exportManual();
        assert.equal(downloads.length, 0);
        assert.equal(review.manualExport, null);
        assert.equal(review.controller, null);
    }
});

test('manual download links release object URLs and are removed even if clicking fails', () => {
    for (const fail of [false, true]) {
        const { review, context, document } = harness();
        let revoked, removed = false, filename, attached = false;
        context.URL = { createObjectURL: () => 'blob:review-test', revokeObjectURL: url => { revoked = url; } };
        context.setTimeout = callback => callback();
        const link = { click() { filename = this.download; if (fail) throw new Error('Blocked'); },
            remove() { removed = true; } };
        document.createElement = () => link;
        document.body = { appendChild() { attached = true; } };
        if (fail) assert.throws(() => review.download(new Blob(['test']), 'photo.jpg'), /Blocked/);
        else review.download(new Blob(['test']), 'photo.jpg');
        assert.equal(attached, true);
        assert.equal(removed, true);
        assert.equal(filename, 'photo.jpg');
        assert.equal(revoked, 'blob:review-test');
    }
});
