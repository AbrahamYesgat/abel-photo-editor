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
            'check-local', 'local-token-field', 'remember-local', 'local-storage-status', 'forget-local',
            'check-gemini', 'token-field', 'remember-gemini', 'gemini-storage-status', 'forget-gemini',
            'gemini-options', 'gemini-mode', 'gemini-strength', 'gemini-strength-value', 'intent-note',
            'manual-choice', 'manual-strength',
            'consent-text', 'data-terms', 'alternative',
            'consent-label', 'manual', 'export', 'download-preview', 'copy-prompt',
            'download-prompt', 'prompt', 'paste', 'import', 'fix-quotes']) {
            this.elements[name] = document.getElementById(`review-${name}`);
        }
        const el = this.elements;
        el['local-endpoint'].value = this.localDefault();
        el.endpoint.value = window.location.origin;
        el.intent.value = this.defaultIntent();
        el['check-gemini'].addEventListener('click', () => this.checkGeminiConnection());
        el['forget-gemini'].addEventListener('click', () => this.forgetGeminiConnection());
        el['remember-gemini'].addEventListener('change', () => {
            if (!el['remember-gemini'].checked) {
                const token = this.savedGeminiConnection?.token || el.token.value;
                this.forgetGeminiConnection();
                el.token.value = token;
            }
        });
        for (const field of ['gemini-mode', 'gemini-strength']) {
            el[field].addEventListener(field === 'gemini-mode' ? 'change' : 'input', () => {
                this.invalidate('Review action or strength changed. Click the new action when ready.');
                el['gemini-strength-value'].value = `${el['gemini-strength'].value}%`;
            });
        }
        el.provider.addEventListener('change', () => this.changeProvider());
        el['check-local'].addEventListener('click', () => this.checkLocalConnection());
        el['forget-local'].addEventListener('click', () => this.forgetLocalConnection());
        el['remember-local'].addEventListener('change', () => {
            if (!el['remember-local'].checked) {
                const token = this.savedLocalConnection?.token || el['local-token'].value;
                this.forgetLocalConnection();
                el['local-token'].value = token;
            }
        });
        window.addEventListener('storage', event => {
            if (event.key === null || event.key === this.geminiStorageKey()) {
                this.savedGeminiConnection = null;
                el.token.value = '';
                if (!this.isLocal() && !this.isManual()) {
                    this.invalidate('Saved Gemini connection changed in another tab. Reload or check the connection again.');
                    el.consent.checked = false;
                }
                this.geminiStorageStatus('Saved connection changed in another tab. Reload to use it, or Forget to clear it.');
                this.renderGeminiConnection();
                this.updateButtons();
            }
            if (event.key !== null && event.key !== this.localStorageKey()) return;
            if (this.isLocal()) {
                this.invalidate('Saved local connection changed in another tab. Check the connection again when ready.');
                el.consent.checked = false;
            }
            this.savedLocalConnection = null;
            el['local-token'].value = '';
            this.localModel = null;
            this.localStorageIssue = false;
            this.localStorageStatus(event.newValue === null
                ? 'Not saved on this browser. The connection was forgotten in another tab.'
                : 'Saved connection changed in another tab. Reload to use it, or enter a token here.');
            this.renderLocalConnection();
            this.updateButtons();
        });
        el.analyze.addEventListener('click', () => this.analyze());
        el.export.addEventListener('click', () => this.exportManual());
        el['download-preview'].addEventListener('click', () => this.downloadManual('image'));
        el['download-prompt'].addEventListener('click', () => this.downloadManual('prompt'));
        el['copy-prompt'].addEventListener('click', () => this.copyManualPrompt());
        el.import.addEventListener('click', () => this.importManual());
        el['fix-quotes'].addEventListener('click', () => this.importManual(true));
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
                if (field === 'local-endpoint') this.forgetLocalConnection();
                if (field === 'endpoint') this.forgetGeminiConnection();
                this.updateButtons();
            });
        }
        el.strength.addEventListener('input', () => {
            el['strength-value'].value = `${el.strength.value}%`;
            this.showAdjustments();
            this.updateButtons();
        });
        app._bindHoldCompare(el.compare, false, true);
        this.restoreGeminiConnection();
        this.restoreLocalConnection();
        this.updateButtons();
    }

    defaultIntent() {
        return 'Preserve the scene’s existing mood and intentional styling. Make only clearly justified lighting and color refinements.';
    }

    geminiStorageKey() { return 'abel.gemini-connection.v1'; }

    geminiStorageStatus(message, error = false) {
        this.elements['gemini-storage-status'].textContent = message;
        this.elements['gemini-storage-status'].classList.toggle('review-error', error);
    }

    renderGeminiConnection() {
        this.elements['token-field'].hidden = !!this.savedGeminiConnection;
        this.elements['forget-gemini'].hidden = !this.savedGeminiConnection && !this.geminiStorageIssue;
    }

    restoreGeminiConnection() {
        try {
            const raw = window.localStorage.getItem(this.geminiStorageKey());
            if (raw !== null) {
                const saved = JSON.parse(raw);
                if (!saved || saved.version !== 1 || typeof saved.endpoint !== 'string' ||
                    !saved.endpoint || saved.endpoint.length > 2048 || typeof saved.token !== 'string' ||
                    !/^[\x21-\x7e]{0,4096}$/.test(saved.token) ||
                    Object.keys(saved).sort().join(',') !== 'endpoint,token,version') throw new Error('Invalid saved connection');
                const endpoint = this.validatedEndpoint(saved.endpoint, false);
                this.savedGeminiConnection = { version: 1, endpoint, token: saved.token };
                this.elements.endpoint.value = endpoint;
                this.elements.token.value = '';
                this.elements['remember-gemini'].checked = true;
                this.geminiStorageStatus('Saved Gemini connection filled. Consent and a click are still required; no photo has been sent.');
            }
        } catch {
            this.geminiStorageIssue = true;
            this.geminiStorageStatus('Saved Gemini connection is invalid or storage is unavailable. Enter the connection again, or Forget to clear it.', true);
        }
        this.renderGeminiConnection();
    }

    geminiAccessToken() {
        if (this.savedGeminiConnection) {
            if (this.endpoint() !== this.savedGeminiConnection.endpoint) {
                throw new Error('The saved token belongs to a different Gemini backend. Forget / change Gemini connection first.');
            }
            return this.savedGeminiConnection.token;
        }
        return this.elements.token.value.trim();
    }

    rememberGeminiConnection(endpoint) {
        if (!this.elements['remember-gemini'].checked) return;
        const token = this.geminiAccessToken();
        try {
            if (!/^[\x21-\x7e]{0,4096}$/.test(token)) throw new Error('Invalid token');
            const saved = { version: 1, endpoint: this.validatedEndpoint(endpoint, false), token };
            window.localStorage.setItem(this.geminiStorageKey(), JSON.stringify(saved));
            this.savedGeminiConnection = saved;
            this.elements.token.value = '';
            this.geminiStorageIssue = false;
            this.geminiStorageStatus('Gemini connection saved on this browser. Forget removes its saved access token.');
        } catch {
            this.geminiStorageIssue = true;
            this.geminiStorageStatus('Connected in this tab, but browser storage could not save the connection.', true);
        }
        this.renderGeminiConnection();
    }

    forgetGeminiConnection() {
        this.invalidate('Gemini credentials cleared. Existing photo edits are unchanged.');
        this.elements.consent.checked = false;
        this.savedGeminiConnection = null;
        this.elements.token.value = '';
        this.elements['provider-badge'].textContent = this.isLocal() ? 'Local Qwen' : this.isManual() ? 'ChatGPT Manual' : 'Gemini Cloud';
        try {
            window.localStorage.removeItem(this.geminiStorageKey());
            this.geminiStorageIssue = false;
            this.geminiStorageStatus('Not saved on this browser. Check the new connection when ready.');
        } catch {
            this.geminiStorageIssue = true;
            this.geminiStorageStatus('Cleared from this tab, but storage could not be cleared. Remove this site’s stored data in browser settings.', true);
        }
        this.renderGeminiConnection();
        this.updateButtons();
    }

    async checkGeminiConnection() {
        if (this.isLocal() || this.isManual() || this.controller) return;
        let controller, timeout;
        try {
            const endpoint = this.endpoint();
            const token = this.geminiAccessToken();
            this.invalidate('Checking Gemini backend configuration. No photo is sent.');
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
                throw new Error('No Gemini backend here. GitHub Pages needs your actual HTTPS backend URL, or an explicitly configured desktop companion; it cannot be discovered automatically.');
            }
            const data = await response.json();
            if (this.controller !== controller) return;
            if (this.isLocal() || this.isManual() || this.endpoint() !== endpoint || this.geminiAccessToken() !== token) {
                this.invalidate('Gemini connection changed during the check. Check it again before saving.');
                return;
            }
            if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Gemini connection failed.');
            if (typeof data.configured !== 'boolean' || typeof data.model !== 'string' ||
                !/^gemini-[a-z0-9.-]{1,80}$/.test(data.model) || typeof data.authorized !== 'boolean') {
                throw new Error('This address did not identify an updated ABEL Gemini backend.');
            }
            this.elements['provider-badge'].textContent = data.model;
            if (!data.configured) throw new Error('Set GEMINI_API_KEY on this backend and restart it. The API key is never filled into the browser.');
            if (!data.authorized) throw new Error('This backend requires a valid REVIEW_ACCESS_TOKEN. Enter that token, not a local Qwen token or Gemini API key; cross-origin use requires server configuration.');
            this.rememberGeminiConnection(endpoint);
            this.setStatus(`${data.model} is configured on this backend. No photo or Google request was sent. This check cannot verify Gemini quota or generation access.`);
        } catch (error) {
            if (controller && this.controller !== controller) return;
            this.setStatus(error.name === 'AbortError' ? 'Gemini connection check timed out.' :
                error instanceof TypeError ? 'Cannot reach the Gemini backend. Check its URL, allowed origin and browser local-network permission.' : error.message, true);
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

    geminiAction() {
        return !this.isLocal() && !this.isManual() && ['global', 'adaptive'].includes(this.elements['gemini-mode'].value)
            ? this.elements['gemini-mode'].value : '';
    }

    localStorageKey() {
        return 'abel.local-connection.v1';
    }

    localStorageStatus(message, error = false) {
        this.elements['local-storage-status'].textContent = message;
        this.elements['local-storage-status'].classList.toggle('review-error', error);
    }

    renderLocalConnection() {
        this.elements['local-token-field'].hidden = !!this.savedLocalConnection;
        this.elements['forget-local'].hidden = !this.savedLocalConnection && !this.localStorageIssue;
    }

    restoreLocalConnection() {
        try {
            const raw = window.localStorage.getItem(this.localStorageKey());
            if (raw !== null) {
                const saved = JSON.parse(raw);
                if (!saved || saved.version !== 1 || typeof saved.endpoint !== 'string' ||
                    !saved.endpoint || saved.endpoint.length > 2048 ||
                    typeof saved.token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(saved.token) ||
                    Object.keys(saved).sort().join(',') !== 'endpoint,token,version') {
                    throw new Error('Invalid saved connection');
                }
                const endpoint = this.localEndpoint(saved.endpoint);
                this.savedLocalConnection = { version: 1, endpoint, token: saved.token };
                this.elements['local-endpoint'].value = endpoint.replace(/\/api\/review\/local$/, '');
                this.elements['local-token'].value = '';
                this.elements['remember-local'].checked = true;
                this.elements.provider.value = 'local';
                this.changeProvider();
                this.localStorageStatus('Saved on this browser. No photo is sent until you consent and request a review.');
            }
        } catch {
            this.localStorageIssue = true;
            this.localStorageStatus('Saved connection could not be loaded: browser storage is unavailable or the saved connection is invalid. Enter a valid loopback URL and token, or Forget to clear it.', true);
        }
        this.renderLocalConnection();
    }

    localAccessToken() {
        if (this.savedLocalConnection) {
            if (this.localEndpoint(this.elements['local-endpoint'].value) !== this.savedLocalConnection.endpoint) {
                throw new Error('The saved token belongs to a different local companion. Use Forget / change connection and enter its token.');
            }
            return this.savedLocalConnection.token;
        }
        return this.elements['local-token'].value.trim();
    }

    rememberLocalConnection(endpoint) {
        if (!this.elements['remember-local'].checked) return;
        const token = this.localAccessToken();
        // Same-origin local use needs no token; never obtain one from the server.
        if (!token) return;
        try {
            if (!/^[\x21-\x7e]{1,4096}$/.test(token)) throw new Error('Invalid token');
            const saved = { version: 1, endpoint: this.localEndpoint(endpoint), token };
            window.localStorage.setItem(this.localStorageKey(), JSON.stringify(saved));
            this.savedLocalConnection = saved;
            this.elements['local-token'].value = '';
            this.localStorageIssue = false;
            this.localStorageStatus('Saved on this browser. Use Forget / change connection to remove the saved token.');
        } catch {
            this.localStorageIssue = true;
            this.localStorageStatus('Connected, but browser storage could not save this connection. It works in this tab only; you may need to paste the token after refreshing.', true);
        }
        this.renderLocalConnection();
    }

    forgetLocalConnection() {
        this.invalidate('Local credentials cleared. Enter the connection token again when ready. Existing photo edits are unchanged.');
        this.elements.consent.checked = false;
        this.localModel = null;
        this.savedLocalConnection = null;
        this.elements['local-token'].value = '';
        try {
            window.localStorage.removeItem(this.localStorageKey());
            this.localStorageIssue = false;
            this.localStorageStatus('Not saved on this browser.');
        } catch {
            this.localStorageIssue = true;
            this.localStorageStatus('Token cleared from this tab, but browser storage could not be cleared. Clear this site’s stored data in browser settings to remove any saved connection.', true);
        }
        this.renderLocalConnection();
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
        if (this.elements.intent.value === this.defaultIntent() && (this.isLocal() || this.isManual())) {
            this.elements.intent.value = '';
            this.defaultIntentRemoved = true;
        } else if (!this.isLocal() && !this.isManual() && !this.elements.intent.value && this.defaultIntentRemoved) {
            this.elements.intent.value = this.defaultIntent();
        }
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
        const token = this.isLocal() ? this.localAccessToken() : this.geminiAccessToken();
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
            this.rememberLocalConnection(endpoint);
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
        const gemini = !this.isManual() && !this.isLocal();
        const action = this.geminiAction();
        el['gemini-options'].hidden = !gemini;
        el['intent-note'].hidden = !gemini;
        el['check-gemini'].disabled = busy;
        el['manual-choice'].hidden = !!action;
        el['manual-strength'].hidden = !!action;
        el.apply.hidden = !!action;
        el.analyze.disabled = this.isManual() || !this.app.image || !el.consent.checked || busy || !!this.app.cropTool?.active;
        el.analyze.textContent = busy ? (this.checkingConnection ? 'Checking...' : 'Reviewing...')
            : action ? `Review & apply ${action === 'adaptive' ? 'Adaptive' : 'Global'}` : 'Review photo';
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
        el['fix-quotes'].disabled = el.import.disabled;
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

    importManual(fixQuotes = false) {
        if (!this.isManual() || this.controller || this.app.cropTool?.active) return;
        if (!this.manualReady()) {
            const pasted = this.elements.paste.value;
            this.invalidate('Export the current photo first. An export from another edit or a previous tab session cannot be imported.');
            if (fixQuotes) this.elements.paste.value = pasted;
            return;
        }
        // Clear an earlier proposal on a failed retry, but retain the unchanged export baseline.
        this.result = null;
        this.selection = '';
        this.elements.alternative.value = '';
        this.elements.result.hidden = true;
        this.elements['apply-bar'].hidden = true;
        try {
            if (fixQuotes) {
                const repaired = ReviewManual.repairSmartQuotes(this.elements.paste.value);
                this.result = repaired.review;
                this.elements.paste.value = repaired.text;
            } else {
                this.result = ReviewManual.parseResponse(this.elements.paste.value);
            }
            this.showResult();
            this.setStatus((fixQuotes ? 'Smart-quote delimiters fixed; corrected JSON is shown above. ' : '') + (this.hasSuggestions()
                ? 'ChatGPT review imported. Choose Global or Adaptive, check strength, then Apply. Nothing has changed yet.'
                : 'ChatGPT review imported. No lighting or color changes were recommended.'));
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
        if (localProvider) return this.localEndpoint(this.elements['local-endpoint'].value);
        return this.validatedEndpoint(this.elements.endpoint.value.trim() || window.location.origin, false);
    }

    localEndpoint(value) {
        return this.validatedEndpoint(value.trim() || this.localDefault(), true);
    }

    validatedEndpoint(value, localProvider) {
        let url;
        try {
            url = new URL(value);
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
        const action = this.geminiAction();
        const requestSettings = JSON.stringify({
            provider: el.provider.value, endpoint: el.endpoint.value, token: el.token.value,
            intent: el.intent.value, mode: el['gemini-mode'].value, strength: el['gemini-strength'].value,
        });
        const settingsUnchanged = () => requestSettings === JSON.stringify({
            provider: el.provider.value, endpoint: el.endpoint.value, token: el.token.value,
            intent: el.intent.value, mode: el['gemini-mode'].value, strength: el['gemini-strength'].value,
        });
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
                : action ? `Gemini is reviewing your photo, then applying only ${action === 'adaptive' ? 'Adaptive' : 'Global'}. Cancel to stop.`
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
            connectionIssue = ['unauthorized', 'origin_denied', 'review_token_required', 'local_token_required', 'local_unauthorized'].includes(data.code);
            if (!response.ok) {
                throw new Error(typeof data.error === 'string' ? data.error : `Review failed (${response.status}).`);
            }
            if (this.controller !== controller) return;
            if (!this.matches(this.context) || !settingsUnchanged() || !el.consent.checked || this.app.cropTool?.active) {
                this.invalidate('Photo, review settings or consent changed. Nothing was applied; request a fresh review.');
                return;
            }
            this.result = ReviewContract.validateReview(data);
            if (localProvider) this.rememberLocalConnection(endpoint);
            else this.rememberGeminiConnection(endpoint);
            this.showResult(action, localProvider ? '100' : el['gemini-strength'].value);
            if (action) {
                if (this.hasChanges()) this.apply();
                else this.setStatus(`Review complete. ${action === 'adaptive' ? 'Adaptive' : 'Global'} has no changes at this strength; nothing was applied. The other alternative was not substituted.`);
            } else this.setStatus(this.hasSuggestions()
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

    showResult(selection = '', strength = '100') {
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
        this.selection = selection;
        el.alternative.value = selection;
        el.strength.value = strength;
        el['strength-value'].value = `${strength}%`;
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
            this.showRegionMap(row, region);
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

    showRegionMap(container, region) {
        const composite = document.getElementById('composite-overlay');
        const source = composite && composite.style.display !== 'none'
            ? composite : document.getElementById('main-canvas');
        if (!source?.width || !source?.height) return;
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 320 / Math.max(source.width, source.height));
        canvas.width = Math.max(1, Math.round(source.width * scale));
        canvas.height = Math.max(1, Math.round(source.height * scale));
        canvas.className = 'review-region-map';
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', `${region.name}: approximate mask extent on the reviewed photo. Not a subject selection.`);
        const ctx = canvas.getContext('2d'), g = region.geometry;
        const w = canvas.width, h = canvas.height;
        ctx.drawImage(source, 0, 0, w, h);
        ctx.strokeStyle = '#ffcf54';
        ctx.fillStyle = '#ffcf54';
        ctx.lineWidth = 2;
        ctx.beginPath();
        if (g.type === 'radial') {
            ctx.ellipse(g.x * w, g.y * h, g.width * w, g.height * h, 0, 0, 2 * Math.PI);
            ctx.stroke();
            ctx.fillRect(g.x * w - 2, g.y * h - 2, 4, 4);
        } else {
            ctx.moveTo(g.x * w, g.y * h);
            ctx.lineTo(g.endX * w, g.endY * h);
            ctx.stroke();
            ctx.font = '12px sans-serif';
            for (const [text, x, y] of [['0%', g.x, g.y], ['100%', g.endX, g.endY]]) {
                ctx.fillRect(x * w - 2, y * h - 2, 4, 4);
                ctx.fillText(text, Math.max(2, Math.min(w - 34, x * w)), Math.max(13, Math.min(h - 2, y * h)));
            }
        }
        container.append(canvas);
        container.append(this.text('p', g.type === 'radial'
            ? 'Region map: dot = strongest effect; outline = zero-effect edge. Soft falloff inside, not an object outline.'
            : 'Region map: 0% → 100% effect across the entire image; beyond the full-effect end it stays at 100%.', 'review-note'));
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
