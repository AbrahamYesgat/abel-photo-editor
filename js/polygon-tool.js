class PolygonTool {
    constructor(app, panel) {
        this.app = app;
        this.draft = this.drag = this.pending = this.hover = null;
        this.controls = document.createElement('div');
        this.controls.id = 'polygon-controls';
        this.controls.hidden = true;
        this.controls.innerHTML = `
            <p id="polygon-status" class="panel-info" role="status" aria-live="polite"></p>
            <div class="polygon-actions">
                <button type="button" class="btn btn-accent" id="polygon-finish">Finish polygon</button>
                <button type="button" class="btn btn-outline" id="polygon-undo-point">Undo point</button>
                <button type="button" class="btn btn-outline" id="polygon-cancel">Cancel</button>
            </div>
            <div id="polygon-edit">
                <label for="polygon-feather">Feather (%)</label>
                <div class="polygon-feather-row">
                    <input id="polygon-feather" type="range" min="0" max="100" step="1" value="0">
                    <input id="polygon-feather-value" class="slider-value" aria-label="Polygon feather percent" type="number" min="0" max="100" step="1" value="0">
                </div>
                <button type="button" class="btn btn-outline" id="polygon-invert" aria-pressed="false">Invert polygon</button>
            </div>`;
        panel.appendChild(this.controls);
        const get = id => document.getElementById(id);
        this.status = get('polygon-status');
        this.finishButton = get('polygon-finish');
        this.undoButton = get('polygon-undo-point');
        this.cancelButton = get('polygon-cancel');
        this.edit = get('polygon-edit');
        this.feather = get('polygon-feather');
        this.featherValue = get('polygon-feather-value');
        this.invert = get('polygon-invert');
        this.finishButton.onclick = () => this.finish();
        this.undoButton.onclick = () => this.undoPoint();
        this.cancelButton.onclick = () => this.cancel();
        this.invert.onclick = () => {
            if (!this.active || this.draft || this.drag) return;
            const mask = app.maskEngine.getActiveMask();
            this.commit(() => { mask.inverted = !mask.inverted; });
        };
        for (const input of [this.feather, this.featherValue]) {
            input.addEventListener('keydown', e => {
                if (input === this.featherValue && (e.key === 'Enter' || e.key === 'Escape')) {
                    e.preventDefault();
                    if (e.key === 'Escape') this.sync();
                    input.blur();
                }
            });
            input.addEventListener('input', () => {
                if (input.value !== '' && Number.isFinite(input.valueAsNumber)) {
                    const value = Math.max(0, Math.min(100, Math.round(input.valueAsNumber)));
                    (input === this.feather ? this.featherValue : this.feather).value = value;
                }
            });
            input.addEventListener('change', () => {
                const mask = app.maskEngine.getActiveMask();
                if (!this.active || this.draft || input.value === '' || !Number.isFinite(input.valueAsNumber)) {
                    this.sync(); return;
                }
                const value = Math.max(0, Math.min(100, Math.round(input.valueAsNumber)));
                if (value !== mask.params.feather)
                    this.commit(() => app.maskEngine.setPolygon(mask, mask.params.points, value));
                else this.sync();
            });
        }
        this.overlay = document.createElement('canvas');
        this.overlay.id = 'polygon-overlay';
        this.overlay.setAttribute('aria-hidden', 'true');
        get('canvas-container').appendChild(this.overlay);
        document.addEventListener('keydown', e => {
            if (!this.active || e.ctrlKey || e.metaKey || e.altKey ||
                e.target.closest('input, textarea, select, [contenteditable]')) return;
            if (e.key === 'Escape') {
                e.preventDefault();
                if (this.draft) this.cancel();
                else if (this.drag) this.up(true);
                else app._exitMaskMode();
            } else if (this.draft && (e.key === 'Backspace' || e.key === 'Delete')) {
                e.preventDefault(); this.undoPoint();
            } else if (this.draft && e.key === 'Enter' && !e.target.closest('button')) {
                e.preventDefault(); this.finish();
            }
        });
    }

    get active() {
        return this.app.maskMode && !this.app.cropTool?.active &&
            (!!this.draft || this.app.maskEngine.getActiveMask()?.type === 'polygon');
    }

    start() {
        if (!this.app.image || this.app._importController || this.app.cropTool?.active) return;
        this.app.viewport?.cancel();
        this.app._stopComparison();
        this.draft = [];
        this.drag = this.pending = this.hover = null;
        this.app.maskMode = true;
        this.app.showMaskOverlay = false;
        document.getElementById('mask-overlay').style.display = 'none';
        document.getElementById('brush-cursor')?.style.setProperty('display', 'none');
        document.getElementById('canvas-container').classList.add('mask-mode');
        for (const id of ['brush-settings', 'wand-settings', 'mask-adjustments', 'delete-mask-btn',
            'mask-toggle-overlay', 'mask-done-btn']) document.getElementById(id).style.display = 'none';
        this.sync();
        this.controls.scrollIntoView({ block: 'nearest' });
    }

    clear() {
        this.draft = this.drag = this.pending = this.hover = null;
        this.overlay.style.display = 'none';
        this.sync();
    }

    cancel() {
        this.draft = this.drag = this.pending = this.hover = null;
        this.app._exitMaskMode();
        this.controls.hidden = false;
        this.edit.hidden = true;
        this.status.textContent = 'Polygon cancelled. Photo unchanged.';
    }

    sync(message) {
        if (!this.controls) return;
        this.controls.hidden = !this.active;
        document.getElementById('canvas-container').classList.toggle('polygon-mode', this.active);
        const drafting = !!this.draft;
        for (const button of [this.finishButton, this.undoButton, this.cancelButton]) button.hidden = !drafting;
        this.finishButton.disabled = !drafting || this.draft.length < 3;
        this.undoButton.disabled = !drafting || !this.draft.length;
        this.edit.hidden = drafting;
        if (!this.active) { this.overlay.style.display = 'none'; return; }
        if (!drafting) {
            const mask = this.app.maskEngine.getActiveMask();
            this.feather.value = this.featherValue.value = mask.params.feather;
            this.invert.setAttribute('aria-pressed', String(mask.inverted));
        }
        this.status.textContent = message || (drafting
            ? `${this.draft.length} / 64 corners — not yet applied. Tap the photo to place corners; tap the first corner or Finish to close. Enter finishes; Escape cancels. Two fingers zoom/pan.`
            : 'Drag a corner to reshape; changes apply on release. Feather softens inward from every edge. Use Polygon for a new shape. Two fingers zoom/pan.');
        this.draw();
    }

    commit(change) {
        this.app._stopComparison();
        this.app._pushHistory();
        change();
        this.app.review?.invalidate('Polygon changed. Request a fresh review when finished.');
        this.app._updateMaskList();
        this.app._render();
        if (this.app.showMaskOverlay) this.app._renderMaskOverlay();
        this.app._pushHistory();
        this.sync();
    }

    finish() {
        if (!this.draft || this.pending || this.drag) return;
        const error = PolygonGeometry.error(this.draft);
        if (error) { this.sync(error); return; }
        const points = this.draft;
        this.commit(() => {
            const mask = this.app.maskEngine.createMask('polygon');
            this.app.maskEngine.setPolygon(mask, points, 0);
            this.draft = this.hover = null;
        });
        for (const id of ['mask-adjustments', 'delete-mask-btn', 'mask-done-btn', 'mask-toggle-overlay'])
            document.getElementById(id).style.display = '';
    }

    undoPoint() {
        if (!this.draft) return;
        this.pending = this.hover = null;
        this.draft.pop();
        this.sync();
    }

    point(e) {
        const r = document.getElementById('main-canvas').getBoundingClientRect();
        const snap = (value, size) => value < 8 ? 0 : value > size - 8 ? 1 : value / size;
        return { x: Math.max(0, Math.min(1, snap(e.clientX - r.left, r.width))),
            y: Math.max(0, Math.min(1, snap(e.clientY - r.top, r.height))) };
    }

    hitsImage(e) {
        const r = document.getElementById('main-canvas').getBoundingClientRect();
        return e.clientX >= r.left - 22 && e.clientX <= r.right + 22 &&
            e.clientY >= r.top - 22 && e.clientY <= r.bottom + 22;
    }

    hit(points, e, radius = 22) {
        const r = document.getElementById('main-canvas').getBoundingClientRect();
        let best = -1, distance = radius;
        points.forEach((p, i) => {
            const d = Math.hypot(r.left + p.x * r.width - e.clientX, r.top + p.y * r.height - e.clientY);
            if (d < distance) { best = i; distance = d; }
        });
        return best;
    }

    down(e) {
        if (!this.active || this.app._importController || !this.hitsImage(e)) return;
        this.app._stopComparison();
        if (this.draft) this.pending = { point: this.point(e),
            close: this.draft.length >= 3 && this.hit([this.draft[0]], e, 18) === 0 };
        else {
            const points = this.app.maskEngine.getActiveMask().params.points;
            const index = this.hit(points, e);
            if (index >= 0) this.drag = { index, points: points.map(p => ({ ...p })) };
        }
        this.draw();
    }

    move(e) {
        if (!this.active) return;
        if (this.drag) this.drag.points[this.drag.index] = this.point(e);
        else if (this.draft) this.hover = this.point(e);
        this.draw();
    }

    up(cancelled = false) {
        const pending = this.pending, drag = this.drag;
        this.pending = this.drag = null;
        if (!this.active || cancelled) { this.draw(); return; }
        if (pending && this.draft) {
            if (pending.close) { this.finish(); return; }
            if (this.draft.length >= PolygonGeometry.MAX_POINTS) {
                this.sync('64 corners is the limit. Finish, undo a point, or cancel.'); return;
            }
            if (this.draft.some(p => Math.hypot(p.x - pending.point.x, p.y - pending.point.y) < 1e-6)) {
                this.sync('That corner already exists. Tap a new position.'); return;
            }
            this.draft.push(pending.point);
            this.hover = null;
            this.sync();
        } else if (drag) {
            const error = PolygonGeometry.error(drag.points);
            if (error) { this.sync(`${error} Previous shape kept.`); return; }
            const mask = this.app.maskEngine.getActiveMask();
            if (JSON.stringify(drag.points) !== JSON.stringify(mask.params.points))
                this.commit(() => this.app.maskEngine.setPolygon(mask, drag.points, mask.params.feather));
        }
        this.draw();
    }

    draw() {
        if (this.frame) return;
        this.frame = requestAnimationFrame(() => {
            this.frame = null;
            if (!this.active || this.app.showingOriginal || this.app._comparisonState) { this.overlay.style.display = 'none'; return; }
            const container = document.getElementById('canvas-container').getBoundingClientRect();
            const photo = document.getElementById('main-canvas').getBoundingClientRect();
            const dpr = Math.min(2, window.devicePixelRatio || 1);
            const width = Math.max(1, Math.round(container.width * dpr));
            const height = Math.max(1, Math.round(container.height * dpr));
            if (this.overlay.width !== width) this.overlay.width = width;
            if (this.overlay.height !== height) this.overlay.height = height;
            this.overlay.style.display = 'block';
            const ctx = this.overlay.getContext('2d');
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, container.width, container.height);
            const points = this.drag?.points || this.draft || this.app.maskEngine.getActiveMask()?.params?.points;
            if (!points?.length) return;
            const screen = p => ({ x: photo.left - container.left + p.x * photo.width,
                y: photo.top - container.top + p.y * photo.height });
            const vertices = points.map(screen);
            ctx.beginPath();
            ctx.moveTo(vertices[0].x, vertices[0].y);
            for (const p of vertices.slice(1)) ctx.lineTo(p.x, p.y);
            if (!this.draft || points.length >= 3) ctx.closePath();
            if (this.draft || this.drag) {
                ctx.fillStyle = 'rgba(80,180,255,.12)';
                ctx.fill();
            }
            ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.stroke();
            ctx.lineWidth = 2;
            ctx.strokeStyle = (this.drag || this.draft) && points.length >= 3 && PolygonGeometry.error(points) ? '#ffb454' : 'white';
            ctx.stroke();
            if (this.draft && this.hover) {
                const p = screen(this.hover), last = vertices.at(-1);
                ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
                ctx.setLineDash([]);
            }
            vertices.forEach((p, i) => {
                ctx.beginPath(); ctx.arc(p.x, p.y, this.draft && i === 0 ? 7 : 5, 0, Math.PI * 2);
                ctx.fillStyle = this.draft && i === 0 ? '#63d9b0' : '#51acff'; ctx.fill();
                ctx.strokeStyle = 'white'; ctx.lineWidth = 2; ctx.stroke();
            });
        });
    }
}
