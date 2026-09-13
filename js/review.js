// Review responses are data only. The editor owns all state changes.
class ReviewPanel {
    constructor(app) {
        this.app = app;
        this.result = null;
        this.context = null;
        this.controller = null;
        this.appliedContext = null;
        this.beforeState = null;
        this.beforeMasks = null;
        this.beforeContext = null;
        this.selection = '';
        this.elements = {};
        for (const name of ['endpoint', 'token', 'intent', 'consent', 'analyze', 'cancel',
            'status', 'result', 'feedback', 'adjustments', 'apply-bar', 'strength',
            'strength-value', 'apply', 'undo', 'compare', 'connection',
            'provider', 'provider-badge', 'provider-note', 'connection-title',
            'cloud-settings', 'local-settings', 'local-endpoint', 'local-token',
            'check-local', 'consent-text', 'data-terms', 'alternative',
            'consent-label', 'manual', 'export', 'download-preview', 'copy-prompt',
            'download-prompt', 'prompt', 'paste', 'import']) {
            this.elements[name] = document.getElementById(`review-${name}`);
        }
        const el = this.elements;
        el['local-endpoint'].value = this.localDefault();
        el.provider.addEventListener('change', () => this.changeProvider());
        el['check-local'].addEventListener('click', () => this.checkLocalConnection());
        el.analyze.addEventListener('click', () => this.analyze());
        el.export.addEventListener('click', () => this.exportManual());
        el['download-preview'].addEventListener('click', () => this.downloadManual('image'));
        el['download-prompt'].addEventListener('click', () => this.downloadManual('prompt'));
        el['copy-prompt'].addEventListener('click', () => this.copyManualPrompt());
        el.import.addEventListener('click', () => this.importManual());
        el.paste.addEventListener('input', () => this.updateButtons());
        el.cancel.addEventListener('click', () => this.invalidate('Review cancelled. Nothing was applied.'));
        el.apply.addEventListener('click', () => this.apply());
        el.alternative.addEventListener('change', () => {
            if (this.appliedContext) return;
            this.selection = el.alternative.value;
            this.showAdjustments();
            this.updateButtons();
        });
        el.undo.addEventListener('click', () => {
            if (this.canCompare()) this.app._undo();
        });
        el.consent.addEventListener('change', () => {
            if (!el.consent.checked) this.invalidate('Processing consent withdrawn. Nothing further will be sent.');
            this.updateButtons();
        });
        for (const field of ['endpoint', 'token', 'local-endpoint', 'local-token', 'intent']) {
            el[field].addEventListener('input', () => {
                this.invalidate('Review settings changed. Request a new review when ready.');
                if (field === 'endpoint' || field === 'local-endpoint') {
                    el.consent.checked = false;
                    this.localModel = null;
                }
                this.updateButtons();
            });
        }
        el.strength.addEventListener('input', () => {
            el['strength-value'].value = `${el.strength.value}%`;
            this.showAdjustments();
            this.updateButtons();
        });
        app._bindHoldCompare(el.compare, false, true);
        this.updateButtons();
    }

    isManual() {
        return this.elements.provider.value === 'manual';
    }

    isLocal() {
        return this.elements.provider.value === 'local';
    }

    localDefault() {
        const origin = new URL(window.location.href || window.location.origin);
        return ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
            ? origin.origin : 'http://127.0.0.1:4178';
    }

    changeProvider() {
        this.app._stopComparison();
        this.elements.consent.checked = false;
        this.invalidate(this.isManual()
            ? 'Export this edit first. Upload the downloaded preview and prompt yourself in ChatGPT, then paste its JSON here.'
            : this.isLocal()
            ? 'Local Qwen selected. Check the companion connection, then consent to local processing.'
            : 'Gemini selected. Consent to uploading a preview before requesting a cloud review.');
        const local = this.isLocal();
        const manual = this.isManual();
        const el = this.elements;
        el['provider-badge'].textContent = manual ? 'ChatGPT Manual' : local ? 'Local Qwen' : 'Gemini Cloud';
        el['provider-note'].textContent = manual
            ? 'No automatic upload, API, backend, or ABEL login. You choose what to share in ChatGPT; its privacy settings and subscription limits apply.'
            : local
            ? 'Runs on this computer. No Google upload or API quota; CPU reviews may take several minutes. Never falls back to cloud.'
            : 'Cloud reviews send a preview to Google and use your project\'s API quota.';
        el['connection-title'].textContent = local ? 'Connect local companion' : 'Connect Gemini backend';
        el.connection.hidden = manual;
        el['consent-label'].hidden = manual;
        el.analyze.hidden = manual;
        el.manual.hidden = !manual;
        el['cloud-settings'].hidden = local || manual;
        el['local-settings'].hidden = !local;
        el['check-local'].hidden = !local;
        el['data-terms'].hidden = local;
        el['consent-text'].textContent = local
            ? 'Process a reduced photo preview and my editing intent with local Qwen on this computer. Nothing is sent to Google.'
            : 'Send a reduced photo preview and my editing intent to the connected server and Google. Free-tier content may be used to improve Google\'s products.';
        el.connection.open = local;
        this.updateButtons();
    }

    requestHeaders() {
        const token = this.elements[this.isLocal() ? 'local-token' : 'token'].value.trim();
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;
        return headers;
    }

    async checkLocalConnection() {
        if (!this.isLocal() || this.controller) return;
        let controller;
        let timeout;
        try {
            const endpoint = this.endpoint();
            this.invalidate('Checking local Ollama and the installed Qwen model...');
            controller = new AbortController();
            this.controller = controller;
            this.checkingConnection = true;
            this.updateButtons();
            timeout = setTimeout(() => controller.abort(), 15000);
            const response = await fetch(`${endpoint}/status`, {
                headers: this.requestHeaders(), signal: controller.signal,
                credentials: 'omit', redirect: 'error',
            });
            if (!response.headers.get('content-type')?.includes('application/json')) {
                throw new Error('No ABEL local companion found at this address. Start the companion, not just Ollama.');
            }
            const data = await response.json();
            if (this.controller !== controller) return;
            if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Local connection failed.');
            if (data.provider !== 'ollama' || data.ready !== true || data.localOnly !== true ||
                typeof data.model !== 'string' || !/^qwen3-vl:(2b|4b|8b|30b|32b)(-instruct)?$/.test(data.model)) {
                throw new Error('This address did not identify a ready, local-only Qwen companion.');
            }
            this.localModel = data.model;
            this.elements['provider-badge'].textContent = data.model;
            this.setStatus(`${data.model} is installed locally and ready. No photo was sent by this check.`);
        } catch (error) {
            if (controller && this.controller !== controller) return;
            this.setStatus(error.name === 'AbortError' ? 'Local connection check timed out.' :
                error instanceof TypeError ? this.localConnectionError() : error.message, true);
            this.elements.connection.open = true;
        } finally {
            clearTimeout(timeout);
            if (this.controller === controller) {
                this.controller = null;
                this.checkingConnection = false;
            }
            this.updateButtons();
        }
    }

    localConnectionError() {
        return 'Cannot reach your local companion. Start it on this computer and check its URL, allowed website origin, and browser local-network permission. Nothing was sent to Google.';
    }

    snapshot() {
        return {
            image: this.app.image,
            edits: JSON.stringify({
                state: this.app.state,
                curves: this.app.curveEditor.channels,
                size: [this.app.imageWidth, this.app.imageHeight],
                masks: this.app.maskEngine.describeMasks(),
            }),
        };
    }

    matches(context) {
        if (!context) return false;
        const current = this.snapshot();
        return context.image === current.image && context.edits === current.edits;
    }

    canCompare() {
        return !!this.beforeState && this.matches(this.appliedContext);
    }

    onRender() {
        if (this.context && !this.matches(this.context)) {
            this.invalidate('Photo or edits changed. Review again for up-to-date recommendations.');
        } else if (this.appliedContext && !this.matches(this.appliedContext) && !this.matches(this.beforeContext)) {
            this.appliedContext = null;
            this.beforeState = null;
            this.beforeMasks = null;
            this.beforeContext = null;
            this.setStatus('Edits changed. Use the toolbar undo/redo, or request a fresh review.');
        }
        this.updateButtons();
    }

    invalidate(message) {
        this.controller?.abort();
        this.controller = null;
        this.checkingConnection = false;
        this.context = null;
        this.manualExport = null;
        this.elements.prompt.value = '';
        this.elements.paste.value = '';
        this.result = null;
        this.appliedContext = null;
        this.beforeState = null;
        this.beforeMasks = null;
        this.beforeContext = null;
        this.selection = '';
        this.elements.alternative.value = '';
        this.elements['apply-bar'].hidden = true;
        this.elements.result.hidden = true;
        this.setStatus(message);
        this.updateButtons();
    }

    setStatus(message, error = false) {
        this.elements.status.textContent = message;
        this.elements.status.classList.toggle('review-error', error);
    }

    updateButtons() {
        const el = this.elements;
        const busy = !!this.controller;
        el.analyze.disabled = this.isManual() || !this.app.image || !el.consent.checked || busy || !!this.app.cropTool?.active;
        el.analyze.textContent = busy ? (this.checkingConnection ? 'Checking...' : 'Reviewing...') : 'Review photo';
        el['check-local'].disabled = busy;
        el.cancel.hidden = !busy;
        el.apply.disabled = busy || !!this.app.cropTool?.active || !this.result || !this.matches(this.context) ||
            !this.hasChanges() || !!this.appliedContext;
        el.undo.disabled = !this.canCompare();
        el.compare.disabled = !this.canCompare();
        el.strength.disabled = !!this.appliedContext;
        el.alternative.disabled = !!this.appliedContext || busy;
        el.export.disabled = !this.isManual() || !this.app.image || busy || !!this.app.cropTool?.active;
        const manualReady = this.manualReady() && !busy && !this.app.cropTool?.active;
        for (const name of ['download-preview', 'download-prompt', 'copy-prompt']) {
            el[name].disabled = !manualReady;
        }
        el.import.disabled = !manualReady || !el.paste.value.trim();
        el.paste.disabled = !manualReady;
    }

    manualReady() {
        return this.isManual() && !!this.manualExport && this.matches(this.context) &&
            this.manualExport.intent === this.elements.intent.value.trim();
    }

    download(blob, name) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = name;
        document.body.appendChild(link);
        try {
            link.click();
        } finally {
            link.remove();
            // Give the browser time to consume the download before releasing its backing memory.
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
    }

    async exportManual() {
        if (!this.isManual() || !this.app.image || this.controller || this.app.cropTool?.active) return;
        this.invalidate('Preparing a local preview and prompt. Nothing is uploaded.');
        const controller = new AbortController();
        this.controller = controller;
        this.context = this.snapshot();
        const baseline = this.context;
        const intent = this.elements.intent.value.trim();
        const name = ReviewManual.filename(this.app._fileName);
        this.updateButtons();
        try {
            const adjustments = ReviewContract.readAdjustments(this.app.state);
            const image = await this.preview();
            if (this.controller !== controller || !this.isManual() || !this.matches(baseline) ||
                intent !== this.elements.intent.value.trim() || this.app.cropTool?.active) {
                if (this.controller === controller) this.invalidate('Photo or settings changed during export. Export again.');
                return;
            }
            const prompt = ReviewManual.buildPrompt({ image, adjustments, intent }, `${name}.jpg`);
            const bytes = Uint8Array.from(atob(image), character => character.charCodeAt(0));
            this.manualExport = { image: new Blob([bytes], { type: 'image/jpeg' }), prompt, name, intent };
            this.elements.prompt.value = prompt;
            this.download(this.manualExport.image, `${name}.jpg`);
            this.setStatus('Preview download prepared. Copy or download the prompt below. Manually upload both to ChatGPT, then paste its complete JSON. Nothing was sent by ABEL.');
        } catch (error) {
            if (this.controller !== controller) return;
            this.invalidate(`Export failed: ${error.message}. Try exporting again.`);
        } finally {
            if (this.controller === controller) this.controller = null;
            this.updateButtons();
        }
    }

    downloadManual(kind) {
        if (!this.manualReady() || this.app.cropTool?.active) return;
        const data = this.manualExport;
        try {
            this.download(kind === 'image' ? data.image : new Blob([data.prompt], { type: 'text/plain;charset=utf-8' }),
                `${data.name}${kind === 'image' ? '.jpg' : '_prompt.txt'}`);
        } catch {
            this.setStatus('Download could not start. Try again; the prompt can also be selected and copied below.', true);
        }
    }

    async copyManualPrompt() {
        if (!this.manualReady()) return;
        const data = this.manualExport;
        try {
            if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
            await navigator.clipboard.writeText(data.prompt);
            if (this.manualExport === data) this.setStatus('Prompt copied. Attach the matching downloaded JPEG yourself in ChatGPT.');
        } catch {
            if (this.manualExport !== data) return;
            this.elements.prompt.focus();
            this.elements.prompt.select();
            this.setStatus('Clipboard unavailable or denied. Select and copy the visible prompt, or use Download prompt.', true);
        }
    }

    importManual() {
        if (!this.isManual() || this.controller || this.app.cropTool?.active) return;
        if (!this.manualReady()) {
            this.invalidate('Export the current photo first. An export from another edit or a previous tab session cannot be imported.');
            return;
        }
        // Clear an earlier proposal on a failed retry, but retain the unchanged export baseline.
        this.result = null;
        this.selection = '';
        this.elements.alternative.value = '';
        this.elements.result.hidden = true;
        this.elements['apply-bar'].hidden = true;
        try {
            this.result = ReviewManual.parseResponse(this.elements.paste.value);
            this.showResult();
            this.setStatus(this.hasSuggestions()
                ? 'ChatGPT review imported. Choose Global or Adaptive, check strength, then Apply. Nothing has changed yet.'
                : 'ChatGPT review imported. No lighting or color changes were recommended.');
        } catch (error) {
            this.setStatus(`Cannot import: ${error.message} Copy the complete JSON or ask ChatGPT to correct it using the same prompt. Nothing was applied.`, true);
        }
        this.updateButtons();
    }

    endpoint() {
        if (!['gemini', 'local'].includes(this.elements.provider.value)) {
            throw new Error('Choose Gemini or Local Qwen before reviewing.');
        }
        const localProvider = this.isLocal();
        let url;
        try {
            url = new URL(localProvider
                ? this.elements['local-endpoint'].value.trim() || this.localDefault()
                : this.elements.endpoint.value.trim() || window.location.origin);
        } catch {
            throw new Error('Enter a valid HTTPS backend URL, or leave it blank for this server.');
        }
        const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
        if (localProvider && !local) {
            throw new Error('Local Qwen must use a loopback address on this computer (127.0.0.1, localhost, or [::1]). Remote hosts are not allowed in local mode.');
        }
        if (url.username || url.password || url.search || url.hash ||
            (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) {
            throw new Error('Use an HTTPS backend URL, or HTTP on localhost for development.');
        }
        const path = url.pathname.replace(/\/$/, '');
        if (localProvider) {
            if (path !== '' && path !== '/api/review/local') {
                throw new Error('Use the local companion base URL, not the Gemini or Ollama API endpoint.');
            }
            url.pathname = '/api/review/local';
            return url.href;
        }
        url.pathname = path.endsWith('/api/review') ? path : `${path}/api/review`;
        return url.href;
    }

    preview() {
        this.app._stopComparison();
        this.app._render();
        const composite = document.getElementById('composite-overlay');
        const source = composite && composite.style.display !== 'none'
            ? composite : document.getElementById('main-canvas');
        const scale = Math.min(1, (this.isLocal() ? 768 : 1280) / Math.max(source.width, source.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(source.width * scale));
        canvas.height = Math.max(1, Math.round(source.height * scale));
        const ctx = canvas.getContext('2d');
        ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
        // Re-encoding the displayed pixels excludes the original file's EXIF metadata.
        return canvas.toDataURL('image/jpeg', 0.82).split(',')[1];
    }

    async analyze() {
        const el = this.elements;
        if (this.isManual() || !this.app.image || !el.consent.checked || this.controller || this.app.cropTool?.active) return;
        let controller;
        let timeout;
        let timedOut = false;
        let connectionIssue = true;
        const localProvider = this.isLocal();
        try {
            const endpoint = this.endpoint();
            this.invalidate('Preparing your current edit...');
            const request = {
                image: this.preview(),
                adjustments: ReviewContract.readAdjustments(this.app.state),
                intent: el.intent.value.trim(),
            };
            ReviewContract.validateRequest(request);
            this.context = this.snapshot();
            controller = new AbortController();
            this.controller = controller;
            this.updateButtons();
            this.setStatus(localProvider
                ? 'Qwen is reviewing locally. First use loads the model; CPU processing can take several minutes. Cancel anytime. Nothing is sent to Google.'
                : 'Gemini is reviewing your photo. You can cancel; no changes are applied automatically.');
            timeout = setTimeout(() => { timedOut = true; controller.abort(); }, localProvider ? 910000 : 75000);
            const headers = this.requestHeaders();
            const response = await fetch(endpoint, {
                method: 'POST', headers, body: JSON.stringify(request),
                signal: controller.signal, credentials: 'omit', redirect: 'error',
            });
            if (!response.headers.get('content-type')?.includes('application/json')) {
                throw new Error(localProvider
                    ? 'No local review companion found. Start the updated ABEL companion on this computer.'
                    : 'No review backend found. GitHub Pages cannot run Gemini; connect your backend URL above.');
            }
            const data = await response.json();
            connectionIssue = ['unauthorized', 'origin_denied', 'local_token_required', 'local_unauthorized'].includes(data.code);
            if (!response.ok) {
                throw new Error(typeof data.error === 'string' ? data.error : `Review failed (${response.status}).`);
            }
            if (this.controller !== controller || !this.matches(this.context)) return;
            this.result = ReviewContract.validateReview(data);
            this.showResult();
            this.setStatus(this.hasSuggestions()
                ? 'Review ready. Select Global or Adaptive, check strength and suggestions, then Apply. Nothing has changed yet.'
                : 'Review ready. No lighting or color changes were recommended.');
        } catch (error) {
            if (controller && this.controller !== controller) return;
            this.result = null;
            this.context = null;
            const message = timedOut ? (localProvider ? 'Local Qwen timed out. Try a smaller local model. Nothing was sent to Google.' : 'The review timed out. Try again later.') :
                error.name === 'AbortError' ? 'Review cancelled.' :
                error instanceof TypeError ? (localProvider ? this.localConnectionError() : 'Could not reach the review backend. Check its URL, connection, and allowed origins.') : error.message;
            this.setStatus(message, true);
            if (connectionIssue) el.connection.open = true;
        } finally {
            clearTimeout(timeout);
            if (this.controller === controller) this.controller = null;
            this.updateButtons();
        }
    }

    text(tag, value, className) {
        const element = document.createElement(tag);
        element.textContent = value;
        if (className) element.className = className;
        return element;
    }

    feedbackList(title, entries, emptyMessage) {
        if (!entries.length && !emptyMessage) return;
        this.elements.feedback.append(this.text('h3', title));
        if (!entries.length) {
            this.elements.feedback.append(this.text('p', emptyMessage));
            return;
        }
        const list = document.createElement('ul');
        for (const entry of entries) list.append(this.text('li', entry));
        this.elements.feedback.append(list);
    }

    showResult() {
        const el = this.elements;
        const result = this.result;
        el.feedback.replaceChildren();
        el.feedback.append(this.text('div', `${result.rating.toFixed(1)} / 10`, 'review-rating'));
        el.feedback.append(this.text('p', 'Subjective assessment of the current edit', 'review-note'));
        el.feedback.append(this.text('p', result.summary));
        el.feedback.append(this.text('h3', 'Inferred intent (tentative)'));
        el.feedback.append(this.text('p', `Likely genre: ${result.inferredIntent.genre}`));
        el.feedback.append(this.text('p', result.inferredIntent.interpretation));
        this.feedbackList('Potentially intentional choices', result.inferredIntent.intentionalTraits);
        for (const category of result.categories) {
            el.feedback.append(this.text('h3', `${category.name}  ${category.score.toFixed(1)}/10`));
            el.feedback.append(this.text('p', category.feedback));
        }
        this.feedbackList('What works', result.strengths, 'No specific strengths listed.');
        this.feedbackList('What limits it', result.improvements, 'No major issue identified.');
        el.feedback.append(this.text('h3', 'Framing / crop advice only'));
        el.feedback.append(this.text('p', result.cropFeedback));
        el.feedback.append(this.text('h3', 'Portfolio verdict'));
        el.feedback.append(this.text('strong', result.portfolioVerdict.label));
        el.feedback.append(this.text('p', result.portfolioVerdict.reason));
        el.result.hidden = false;
        el['apply-bar'].hidden = !this.hasSuggestions();
        this.selection = '';
        el.alternative.value = '';
        el.strength.value = '100';
        el['strength-value'].value = '100%';
        this.showAdjustments();
    }

    hasSuggestions() {
        return !!this.result && !!(this.result.adjustments.length ||
            this.result.adaptive.adjustments.length || this.result.adaptive.regions.length);
    }

    strength() {
        const value = Number(this.elements.strength.value);
        return Number.isFinite(value) && value >= 0 && value <= 100 ? value / 100 : 0;
    }

    proposal() {
        if (this.selection === 'global') return { adjustments: this.result.adjustments, regions: [] };
        if (this.selection === 'adaptive') return this.result.adaptive;
        return { adjustments: [], regions: [] };
    }

    targets() {
        if (!this.result || !this.context) return [];
        const state = JSON.parse(this.context.edits).state;
        const current = ReviewContract.readAdjustments(state);
        const strength = this.strength();
        return this.proposal().adjustments.map(change => {
            const control = ReviewContract.controls[change.key];
            const value = current[change.key] + (change.value - current[change.key]) * strength;
            return { ...change, from: current[change.key],
                value: !strength || change.value === current[change.key] ? current[change.key]
                    : Number((Math.round(value / control.step) * control.step).toFixed(2)) };
        });
    }

    hasChanges() {
        return this.targets().some(change => change.value !== change.from) || this.regions().length > 0;
    }

    regions() {
        if (!this.result || !this.context || !this.strength()) return [];
        return this.proposal().regions.map(region => ({
            ...region, adjustments: region.adjustments.map(change => ({
                ...change, value: Number((change.value * this.strength()).toFixed(4))
            }))
        })).filter(region => region.adjustments.some(change => change.value !== 0));
    }

    showAdjustments() {
        const container = this.elements.adjustments;
        container.replaceChildren();
        if (!this.hasSuggestions() || (this.selection && !this.hasChanges())) {
            container.append(this.text('p', 'No major lighting or color edit needed.'));
        } else if (!this.selection) {
            container.append(this.text('p', 'Choose an alternative to inspect its changes. Both start from this same edit; they are never combined.'));
        }
        for (const change of this.targets()) {
            const row = document.createElement('div');
            row.className = 'review-adjustment';
            row.append(this.text('strong', ReviewContract.controls[change.key].label));
            row.append(this.text('span', `${change.from} to ${change.value}`));
            row.append(this.text('p', change.reason));
            container.append(row);
        }
        for (const region of this.regions()) {
            const row = document.createElement('div');
            row.className = 'review-adjustment';
            row.append(this.text('strong', `${region.name} — soft ${region.geometry.type}`));
            row.append(this.text('p', region.reason));
            const g = region.geometry;
            row.append(this.text('p', g.type === 'radial'
                ? `Center ${Math.round(g.x * 100)}%, ${Math.round(g.y * 100)}%; radii ${Math.round(g.width * 100)}%, ${Math.round(g.height * 100)}%; feather ${Math.round(g.feather * 100)}%.`
                : `No effect at ${Math.round(g.x * 100)}%, ${Math.round(g.y * 100)}%; full effect at ${Math.round(g.endX * 100)}%, ${Math.round(g.endY * 100)}%.`));
            for (const change of region.adjustments) {
                row.append(this.text('p', `${ReviewContract.maskControls[change.key].label}: ${change.value > 0 ? '+' : ''}${change.value} — ${change.reason}`));
            }
            container.append(row);
        }
    }

    apply() {
        if (!this.result || !this.matches(this.context) || this.appliedContext || this.app.cropTool?.active) return;
        let rollback;
        try {
            ReviewContract.validateReview(this.result);
            if (!this.hasChanges()) return;
            this.app._stopComparison();
            const next = JSON.parse(JSON.stringify(this.app.state));
            for (const { key, value } of this.targets()) {
                if (!Object.hasOwn(ReviewContract.controls, key)) throw new Error('Unsupported review adjustment.');
                const hsl = /^(hslHue|hslSat|hslLum)_([0-7])$/.exec(key);
                if (hsl) next[hsl[1]][Number(hsl[2])] = value;
                else next[key] = value;
            }
            const newMasks = this.app.maskEngine.buildReviewMasks(this.regions());
            const beforeMasks = this.app.maskEngine.captureMasks();
            rollback = { state: this.app.state, masks: this.app.maskEngine.masks,
                history: this.app.history, historyIndex: this.app.historyIndex };
            clearTimeout(this.app._historyDebounce);
            this.app._pushHistory();
            this.beforeState = JSON.parse(JSON.stringify(this.app.state));
            this.beforeMasks = beforeMasks;
            this.beforeContext = this.context;
            this.app.state = next;
            this.app.maskEngine.masks = [...this.app.maskEngine.masks, ...newMasks];
            this.app._pushHistory();
            this.app._syncSlidersFromState();
            this.app._updateMaskList();
            this.context = null;
            this.appliedContext = this.snapshot();
            this.app._render();
            this.setStatus(newMasks.length
                ? 'Adaptive applied in one edit. Hold to compare or Undo. Soft regions may spill; inspect, redraw or delete them in Masks and adjust their sliders.'
                : 'Lighting and color applied. Hold the photo to see before this review, or undo.');
            this.updateButtons();
        } catch (error) {
            if (rollback) {
                this.app.state = rollback.state;
                this.app.maskEngine.masks = rollback.masks;
                this.app.history = rollback.history;
                this.app.historyIndex = rollback.historyIndex;
                this.appliedContext = null;
                this.beforeState = null;
                this.beforeMasks = null;
                this.beforeContext = null;
                this.app._syncSlidersFromState();
                this.app._updateMaskList();
                this.app._updateHistoryButtons();
            }
            this.setStatus(`Changes were not applied: ${error.message}`, true);
        }
    }
}
