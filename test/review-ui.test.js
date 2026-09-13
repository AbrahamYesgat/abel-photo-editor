const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ReviewContract = require('../js/review-contract.js');
const ReviewManual = require('../js/review-manual.js');

function harness() {
    const elements = new Map();
    const element = () => ({
        disabled: false, hidden: false, value: '100', textContent: '',
        classList: { toggle() {}, remove() {} }, style: {},
        children: [],
        addEventListener() {},
        replaceChildren(...children) { this.children = children; },
        append(...children) { this.children.push(...children); },
        appendChild(child) { this.children.push(child); },
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
    };
    const context = vm.createContext({
        document, window: { location: { origin: 'http://localhost:3000' } },
        ReviewContract, ReviewManual, console, setTimeout, clearTimeout, URL, AbortController,
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
    const review = Object.create(context.ReviewPanel.prototype);
    Object.assign(review, {
        app, result: null, context: null, controller: null, appliedContext: null, beforeState: null,
        elements: {},
    });
    for (const name of ['analyze', 'cancel', 'status', 'consent', 'apply', 'undo', 'compare',
        'strength', 'apply-bar', 'result', 'provider', 'provider-badge', 'provider-note',
        'connection-title', 'connection', 'cloud-settings', 'local-settings', 'check-local',
        'consent-text', 'data-terms', 'endpoint', 'token', 'local-endpoint', 'local-token', 'intent',
        'feedback', 'adjustments', 'strength-value', 'alternative',
        'consent-label', 'manual', 'export', 'download-preview', 'copy-prompt',
        'download-prompt', 'prompt', 'paste', 'import', 'fix-quotes']) {
        review.elements[name] = element();
    }
    review.elements.provider.value = 'gemini';
    for (const name of ['endpoint', 'token', 'local-endpoint', 'local-token', 'intent']) {
        review.elements[name].value = '';
    }
    review.elements.consent.checked = true;
    app.review = review;
    return { app, review, document, context };
}

function response(adjustments) {
    return {
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
    };
}

function prepare(review, changes) {
    review.context = review.snapshot();
    review.result = ReviewContract.validateReview(response(changes));
    review.selection = 'global';
}

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
    assert.ok(textOf(review.elements.adjustments).includes('No major lighting or color edit needed.'));
    assert.equal(review.elements['apply-bar'].hidden, true);
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

test('adaptive strength scales regional offsets, not geometry; zero creates no masks or history', () => {
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
            assert.equal(app.history.length, count);
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
        assert.deepEqual(Object.keys(JSON.parse(requests[0].body)).sort(), ['adjustments', 'image', 'intent']);
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
    assert.equal(review.elements['apply-bar'].hidden, true);
    await review.exportManual();
    assert.equal(review.result, null);
    assert.equal(review.elements.paste.value, '');
});

test('manual smart-quote repair is opt-in, transparent, transactional and never auto-applies', async () => {
    const { app, review } = manualHarness();
    const text = readFileSync(path.join(__dirname, 'fixtures/mobile-review.json'), 'utf8').trim();
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
