// ABEL — Tone Curve Editor
class CurveEditor {
    constructor(container) {
        this.container = container;
        this.canvas = document.createElement('canvas');
        this.canvas.className = 'curve-canvas';
        this.canvas.width = 256;
        this.canvas.height = 256;
        container.appendChild(this.canvas);
        this.ctx = this.canvas.getContext('2d');

        this.channels = {
            rgb: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
            r: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
            g: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
            b: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
        };
        this.activeChannel = 'rgb';
        this.draggingPoint = null;
        this.onChange = null;

        this._buildTabs();
        this._bindEvents();
        this.draw();
    }

    _buildTabs() {
        const tabs = document.createElement('div');
        tabs.className = 'curve-tabs';
        ['rgb', 'r', 'g', 'b'].forEach(ch => {
            const btn = document.createElement('button');
            btn.textContent = ch.toUpperCase();
            btn.className = `curve-tab ${ch === 'rgb' ? 'active' : ''} curve-tab-${ch}`;
            btn.addEventListener('click', () => {
                this.activeChannel = ch;
                tabs.querySelectorAll('.curve-tab').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.draw();
            });
            tabs.appendChild(btn);
        });
        this.container.insertBefore(tabs, this.canvas);
    }

    _bindEvents() {
        const rect = () => this.canvas.getBoundingClientRect();
        const toCanvas = (clientX, clientY) => {
            const r = rect();
            return {
                x: Math.round((clientX - r.left) / r.width * 255),
                y: Math.round(255 - (clientY - r.top) / r.height * 255)
            };
        };

        const getPoint = (pos, threshold = 12) => {
            const points = this.channels[this.activeChannel];
            for (let i = 0; i < points.length; i++) {
                const dx = points[i].x - pos.x;
                const dy = points[i].y - pos.y;
                if (Math.sqrt(dx * dx + dy * dy) < threshold) return i;
            }
            return -1;
        };

        const onStart = (e) => {
            e.preventDefault();
            const touch = e.touches ? e.touches[0] : e;
            const pos = toCanvas(touch.clientX, touch.clientY);
            const idx = getPoint(pos);

            if (idx >= 0) {
                this.draggingPoint = idx;
            } else {
                // Add new point
                const points = this.channels[this.activeChannel];
                points.push({ x: Math.max(0, Math.min(255, pos.x)), y: Math.max(0, Math.min(255, pos.y)) });
                points.sort((a, b) => a.x - b.x);
                this.draggingPoint = points.findIndex(p => p.x === pos.x && p.y === pos.y);
                this.draw();
                this._emitChange();
            }
        };

        const onMove = (e) => {
            if (this.draggingPoint === null) return;
            e.preventDefault();
            const touch = e.touches ? e.touches[0] : e;
            const pos = toCanvas(touch.clientX, touch.clientY);
            const points = this.channels[this.activeChannel];
            const pt = points[this.draggingPoint];

            if (this.draggingPoint === 0) {
                pt.x = 0;
            } else if (this.draggingPoint === points.length - 1) {
                pt.x = 255;
            } else {
                pt.x = Math.max(points[this.draggingPoint - 1].x + 1, Math.min(points[this.draggingPoint + 1].x - 1, pos.x));
            }
            pt.y = Math.max(0, Math.min(255, pos.y));

            this.draw();
            this._emitChange();
        };

        const onEnd = () => {
            this.draggingPoint = null;
        };

        // Double-click to remove point
        this.canvas.addEventListener('dblclick', (e) => {
            const pos = toCanvas(e.clientX, e.clientY);
            const idx = getPoint(pos);
            if (idx > 0 && idx < this.channels[this.activeChannel].length - 1) {
                this.channels[this.activeChannel].splice(idx, 1);
                this.draw();
                this._emitChange();
            }
        });

        this.canvas.addEventListener('mousedown', onStart);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onEnd);
        this.canvas.addEventListener('touchstart', onStart, { passive: false });
        window.addEventListener('touchmove', onMove, { passive: false });
        window.addEventListener('touchend', onEnd);
    }

    _emitChange() {
        if (this.onChange) this.onChange(this.getLUT());
    }

    // Catmull-Rom spline interpolation
    _interpolate(points) {
        const lut = new Uint8Array(256);
        if (points.length < 2) {
            for (let i = 0; i < 256; i++) lut[i] = i;
            return lut;
        }

        for (let i = 0; i < 256; i++) {
            if (i <= points[0].x) {
                lut[i] = Math.max(0, Math.min(255, points[0].y));
                continue;
            }
            if (i >= points[points.length - 1].x) {
                lut[i] = Math.max(0, Math.min(255, points[points.length - 1].y));
                continue;
            }

            // Find segment
            let seg = 0;
            for (let j = 0; j < points.length - 1; j++) {
                if (i >= points[j].x && i <= points[j + 1].x) { seg = j; break; }
            }

            const p0 = points[Math.max(0, seg - 1)];
            const p1 = points[seg];
            const p2 = points[Math.min(points.length - 1, seg + 1)];
            const p3 = points[Math.min(points.length - 1, seg + 2)];

            const t = (i - p1.x) / (p2.x - p1.x);
            const t2 = t * t;
            const t3 = t2 * t;

            // Catmull-Rom
            const v = 0.5 * (
                (2 * p1.y) +
                (-p0.y + p2.y) * t +
                (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
                (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3
            );
            lut[i] = Math.max(0, Math.min(255, Math.round(v)));
        }
        return lut;
    }

    // Generate 4-row LUT texture data (RGB master, R, G, B)
    getLUT() {
        const rgb = this._interpolate(this.channels.rgb);
        const r = this._interpolate(this.channels.r);
        const g = this._interpolate(this.channels.g);
        const b = this._interpolate(this.channels.b);

        // 256 x 4 texture (RGBA format)
        const data = new Uint8Array(256 * 4 * 4);
        for (let i = 0; i < 256; i++) {
            // Row 0: RGB master
            data[(0 * 256 + i) * 4 + 0] = rgb[i];
            data[(0 * 256 + i) * 4 + 1] = rgb[i];
            data[(0 * 256 + i) * 4 + 2] = rgb[i];
            data[(0 * 256 + i) * 4 + 3] = 255;
            // Row 1: Blue
            data[(1 * 256 + i) * 4 + 0] = i;
            data[(1 * 256 + i) * 4 + 1] = i;
            data[(1 * 256 + i) * 4 + 2] = b[i];
            data[(1 * 256 + i) * 4 + 3] = 255;
            // Row 2: Green
            data[(2 * 256 + i) * 4 + 0] = i;
            data[(2 * 256 + i) * 4 + 1] = g[i];
            data[(2 * 256 + i) * 4 + 2] = i;
            data[(2 * 256 + i) * 4 + 3] = 255;
            // Row 3: Red
            data[(3 * 256 + i) * 4 + 0] = r[i];
            data[(3 * 256 + i) * 4 + 1] = i;
            data[(3 * 256 + i) * 4 + 2] = i;
            data[(3 * 256 + i) * 4 + 3] = 255;
        }

        return { data, width: 256, height: 4, isIdentity: this._isIdentity() };
    }

    _isIdentity() {
        for (const ch of ['rgb', 'r', 'g', 'b']) {
            const pts = this.channels[ch];
            if (pts.length !== 2) return false;
            if (pts[0].x !== 0 || pts[0].y !== 0 || pts[1].x !== 255 || pts[1].y !== 255) return false;
        }
        return true;
    }

    reset() {
        for (const ch of ['rgb', 'r', 'g', 'b']) {
            this.channels[ch] = [{ x: 0, y: 0 }, { x: 255, y: 255 }];
        }
        this.draw();
        this._emitChange();
    }

    draw() {
        const ctx = this.ctx;
        const w = 256, h = 256;
        ctx.clearRect(0, 0, w, h);

        // Background grid
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 0.5;
        for (let i = 0; i <= 4; i++) {
            const pos = (i / 4) * 255;
            ctx.beginPath(); ctx.moveTo(pos, 0); ctx.lineTo(pos, h); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(0, pos); ctx.lineTo(w, pos); ctx.stroke();
        }

        // Diagonal reference
        ctx.strokeStyle = '#444';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(0, h); ctx.lineTo(w, 0); ctx.stroke();
        ctx.setLineDash([]);

        // Draw inactive channels faintly
        const channelColors = { rgb: '#fff', r: '#ff4444', g: '#44ff44', b: '#4488ff' };
        for (const ch of ['rgb', 'r', 'g', 'b']) {
            if (ch === this.activeChannel) continue;
            const lut = this._interpolate(this.channels[ch]);
            const isDefault = this.channels[ch].length === 2 &&
                this.channels[ch][0].y === 0 && this.channels[ch][1].y === 255;
            if (isDefault) continue;

            ctx.strokeStyle = channelColors[ch];
            ctx.globalAlpha = 0.25;
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (let i = 0; i < 256; i++) {
                const y = h - lut[i];
                i === 0 ? ctx.moveTo(i, y) : ctx.lineTo(i, y);
            }
            ctx.stroke();
            ctx.globalAlpha = 1;
        }

        // Draw active channel
        const ch = this.activeChannel;
        const lut = this._interpolate(this.channels[ch]);
        ctx.strokeStyle = channelColors[ch];
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = 0; i < 256; i++) {
            const y = h - lut[i];
            i === 0 ? ctx.moveTo(i, y) : ctx.lineTo(i, y);
        }
        ctx.stroke();

        // Draw control points
        const points = this.channels[ch];
        points.forEach((pt, i) => {
            ctx.beginPath();
            ctx.arc(pt.x, h - pt.y, 5, 0, Math.PI * 2);
            ctx.fillStyle = i === this.draggingPoint ? '#fff' : channelColors[ch];
            ctx.fill();
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1.5;
            ctx.stroke();
        });
    }
}
