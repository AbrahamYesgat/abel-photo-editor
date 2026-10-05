// Navigation changes CSS geometry only, never the rendered photo or edit history.
class PhotoViewport {
    constructor(app) {
        this.app = app;
        this.canvas = document.getElementById('main-canvas');
        this.overlay = document.getElementById('mask-overlay');
        this.container = document.getElementById('canvas-container');
        this.button = document.getElementById('btn-fit');
        this.pointers = new Map();
        this.scale = 1;
        this.x = this.y = 0;
        this.button.addEventListener('click', () => this.reset());
        this.container.addEventListener('pointerdown', e => this.down(e));
        window.addEventListener('pointermove', e => this.move(e), { passive: false });
        window.addEventListener('pointerup', e => this.up(e));
        window.addEventListener('pointercancel', e => this.up(e, true));
        this.canvas.addEventListener('lostpointercapture', e => {
            if (!this.canvas.hasPointerCapture(e.pointerId)) this.up(e, true);
        });
        // Touch events are release fallbacks only: never a second gesture pipeline.
        window.addEventListener('touchcancel', () => this.cancel());
        window.addEventListener('touchend', e => {
            if (!e.touches.length && this.pointers.size) this.cancel();
        });
        window.addEventListener('blur', () => this.cancel());
        window.addEventListener('pagehide', () => this.cancel());
        document.addEventListener('visibilitychange', () => { if (document.hidden) this.cancel(); });
        this.container.addEventListener('wheel', e => {
            if (!this.accepts(e) || this.pointers.size) return;
            e.preventDefault();
            this.app._stopComparison();
            const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.height : 1);
            this.zoomAt(this.scale * Math.exp(-delta * .002), this.local(e));
        }, { passive: false });
    }

    accepts(e) {
        return this.app.image && !this.app.cropTool?.active &&
            (e.target === this.canvas || e.target === this.container);
    }

    local(e) {
        const r = this.container.getBoundingClientRect();
        return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 };
    }

    fit(width, height) {
        const changed = this.image !== this.app.image ||
            this.imageWidth !== this.app.imageWidth || this.imageHeight !== this.app.imageHeight;
        this.image = this.app.image;
        this.imageWidth = this.app.imageWidth;
        this.imageHeight = this.app.imageHeight;
        this.width = width;
        this.height = height;
        this.viewWidth = Math.max(1, this.container.clientWidth - 16);
        this.viewHeight = Math.max(1, this.container.clientHeight - 16);
        if (changed) this.reset();
        else {
            this.clamp();
            this.rebase();
            this.draw();
        }
    }

    reset() {
        this.cancel();
        this.scale = 1;
        this.x = this.y = 0;
        this.draw();
    }

    clamp() {
        this.scale = Math.max(1, Math.min(8, this.scale));
        const bx = Math.max(0, (this.width * this.scale - this.viewWidth) / 2);
        const by = Math.max(0, (this.height * this.scale - this.viewHeight) / 2);
        this.x = bx ? Math.max(-bx, Math.min(bx, this.x)) : 0;
        this.y = by ? Math.max(-by, Math.min(by, this.y)) : 0;
    }

    zoomAt(scale, point) {
        const next = Math.max(1, Math.min(8, scale));
        this.x = point.x - (point.x - this.x) * next / this.scale;
        this.y = point.y - (point.y - this.y) * next / this.scale;
        this.scale = next;
        this.clamp();
        this.draw();
    }

    draw() {
        if (this.frame) return;
        this.frame = requestAnimationFrame(() => {
            this.frame = null;
            // Crop owns rotation and its fit-only overlay while active.
            if (!this.app.cropTool?.active) {
                const transform = `translate(-50%, -50%) translate(${this.x}px, ${this.y}px) scale(${this.scale})`;
                this.canvas.style.transform = this.overlay.style.transform = transform;
            }
            this.container.classList.toggle('photo-zoomed', this.scale > 1);
            this.button.hidden = !this.app.image || this.app.cropTool?.active;
            this.button.textContent = this.scale === 1 ? 'Fit' : `${this.scale.toFixed(1)}× · Fit`;
        });
    }

    rebase() {
        const points = [...this.pointers.values()];
        if (points.length < 2) { this.pinch = null; return; }
        const a = this.local(points[0]), b = this.local(points[1]);
        this.pinch = { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
            point: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
            scale: this.scale, x: this.x, y: this.y };
    }

    down(e) {
        if (!this.accepts(e) || e.button !== 0) return;
        if (e.pointerType !== 'touch' && this.pointers.size) return;
        this.pointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
        try { this.canvas.setPointerCapture(e.pointerId); } catch { /* Window release fallback. */ }
        if (this.pointers.size > 1) {
            this.app._stopComparison();
            this.finishMask();
            this.pending = null;
            this.navigation = true;
            const cursor = document.getElementById('brush-cursor');
            if (cursor) cursor.style.display = 'none';
            this.app._suppressCanvasClickUntil = Date.now() + 600;
            this.rebase();
            return;
        }
        this.start = { clientX: e.clientX, clientY: e.clientY, shiftKey: e.shiftKey };
        this.startedAt = performance.now();
        this.navigation = false;
        if (this.app.maskMode && e.target === this.canvas) {
            if (e.pointerType === 'touch') this.pending = [this.start];
            else { this.app._canvasPointerDown(e); this.drawing = true; }
        }
        if (e.pointerType !== 'touch') e.preventDefault();
    }

    move(e) {
        const previous = this.pointers.get(e.pointerId);
        if (!previous) {
            if (e.pointerType === 'mouse' && e.target === this.canvas) this.app._canvasPointerMove(e);
            return;
        }
        if (e.pointerType === 'mouse' && !e.buttons) { this.up(e, true); return; }
        e.preventDefault();
        this.pointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
        if (this.pointers.size > 1) {
            const [a, b] = [...this.pointers.values()].map(p => this.local(p));
            const base = this.pinch;
            const scale = Math.max(1, Math.min(8, base.scale * Math.hypot(a.x - b.x, a.y - b.y) / base.distance));
            this.x = (a.x + b.x) / 2 - (base.point.x - base.x) * scale / base.scale;
            this.y = (a.y + b.y) / 2 - (base.point.y - base.y) * scale / base.scale;
            this.scale = scale;
            this.clamp();
            this.draw();
            return;
        }
        const moved = Math.hypot(e.clientX - this.start.clientX, e.clientY - this.start.clientY) > 12;
        if (this.pending) {
            // Stage the beginning of a touch stroke. A second finger discards it
            // before pixels, review validity or history change; established strokes survive.
            if (this.pending.length < 128) this.pending.push({ clientX: e.clientX, clientY: e.clientY });
            if (moved && performance.now() - this.startedAt >= 240) this.commitMask();
            return;
        }
        if (this.drawing) { this.app._canvasPointerMove(e); return; }
        if (this.scale > 1 && (this.navigation || moved)) {
            if (!this.navigation) this.app._stopComparison();
            this.navigation = true;
            this.x += e.clientX - previous.clientX;
            this.y += e.clientY - previous.clientY;
            this.clamp();
            this.draw();
        }
    }

    commitMask() {
        const pending = this.pending;
        this.pending = null;
        if (!pending || !this.app.maskMode) return;
        this.app._canvasPointerDown(pending[0]);
        for (const point of pending.slice(1)) this.app._canvasPointerMove(point);
        this.drawing = true;
    }

    finishMask() {
        if (this.drawing) this.app._canvasPointerUp();
        this.drawing = false;
    }

    up(e, cancelled = false) {
        if (!this.pointers.has(e.pointerId)) return;
        if (!cancelled && !this.navigation && this.pointers.size === 1) this.commitMask();
        this.pending = null;
        this.finishMask();
        this.pointers.delete(e.pointerId);
        if (this.navigation) this.app._suppressCanvasClickUntil = Date.now() + 600;
        if (cancelled) this.app._stopComparison();
        if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
        this.rebase();
        // A remaining finger may pan, but cannot start painting or comparing.
        if (!this.pointers.size) this.navigation = false;
    }

    cancel() {
        this.pending = null;
        this.finishMask();
        const ids = [...this.pointers.keys()];
        this.pointers.clear();
        this.pinch = null;
        this.navigation = false;
        this.app._stopComparison();
        for (const id of ids) if (this.canvas.hasPointerCapture(id)) this.canvas.releasePointerCapture(id);
    }
}

if (typeof module !== 'undefined') module.exports = PhotoViewport;
