// ABEL — Mask Engine
class MaskEngine {
    constructor(app) {
        this.app = app;
        this.masks = [];
        this.activeMaskIndex = -1;
        this.isDrawing = false;
        this.tool = 'brush'; // brush, radial, gradient, wand
        this.brushSize = 50;
        this.brushFeather = 50;
        this.brushFlow = 80;
        this.eraseMode = false;
        this.wandTolerance = 32;
        this.wandContiguous = true; // true = flood fill, false = color range (all similar pixels)

        // For gradient/radial creation
        this._startPos = null;
        this._endPos = null;
        this._creating = false;
        this._nextMaskId = 0;
        this._snapshots = new WeakMap();
    }

    touch(mask) {
        mask.revision = (mask.revision || 0) + 1;
    }

    describeMasks() {
        return this.masks.map(mask => {
            mask.id ??= ++this._nextMaskId;
            return {
                id: mask.id, revision: mask.revision || 0,
                size: [mask.canvas.width, mask.canvas.height],
                type: mask.type, visible: mask.visible, inverted: mask.inverted,
                adjustments: { ...mask.adjustments }, params: mask.params,
                name: mask.name, reason: mask.reason, blend: mask.blend
            };
        });
    }

    captureMasks() {
        const descriptions = this.describeMasks();
        return this.masks.map((mask, i) => {
            let cached = this._snapshots.get(mask);
            if (!cached || cached.revision !== descriptions[i].revision) {
                const canvas = document.createElement('canvas');
                canvas.width = mask.canvas.width;
                canvas.height = mask.canvas.height;
                canvas.getContext('2d').drawImage(mask.canvas, 0, 0);
                cached = { revision: descriptions[i].revision, canvas };
                this._snapshots.set(mask, cached);
            }
            // Unchanged mask pixels are shared across slider-only history entries.
            return { ...JSON.parse(JSON.stringify(descriptions[i])), canvas: cached.canvas };
        });
    }

    restoreMasks(snapshots) {
        this.masks = snapshots.map(saved => {
            const { canvas: source, ...metadata } = saved;
            const canvas = document.createElement('canvas');
            canvas.width = source.width;
            canvas.height = source.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(source, 0, 0);
            const mask = { ...JSON.parse(JSON.stringify(metadata)), canvas, ctx };
            this._snapshots.set(mask, { revision: mask.revision, canvas: source });
            return mask;
        });
        this.activeMaskIndex = this.masks.length ? Math.min(Math.max(0, this.activeMaskIndex), this.masks.length - 1) : -1;
        this.tool = this.getActiveMask()?.type || 'brush';
    }

    buildReviewMasks(regions) {
        // Stage on a separate engine: a failed allocation cannot partially change the edit.
        const staging = new MaskEngine(this.app);
        staging._nextMaskId = this._nextMaskId;
        for (const region of regions) {
            const g = region.geometry;
            const mask = staging.createMask(g.type);
            if (!mask) throw new Error('No photo available for adaptive masks.');
            const w = mask.canvas.width, h = mask.canvas.height;
            if (g.type === 'radial') staging.createRadialMask(g.x * w, g.y * h, g.width * w, g.height * h, g.feather * 100);
            else staging.createLinearMask(g.x * w, g.y * h, g.endX * w, g.endY * h, true);
            mask.name = region.name;
            mask.reason = region.reason;
            mask.blend = 'additive';
            for (const change of region.adjustments) mask.adjustments[change.key] = change.value;
        }
        this._nextMaskId = staging._nextMaskId;
        return staging.masks;
    }

    createMask(type) {
        const w = this.app.imageWidth;
        const h = this.app.imageHeight;
        if (!w || !h) return null;

        // Cap mask canvas for performance on huge images
        const maxDim = 4096;
        let mw = w, mh = h;
        if (mw > maxDim || mh > maxDim) {
            const s = maxDim / Math.max(mw, mh);
            mw = Math.round(mw * s);
            mh = Math.round(mh * s);
        }

        const canvas = document.createElement('canvas');
        canvas.width = mw;
        canvas.height = mh;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = (type === 'brush' || type === 'wand') ? 'black' : 'white';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const mask = {
            id: ++this._nextMaskId,
            revision: 0,
            type,
            canvas,
            ctx,
            inverted: false,
            adjustments: this._defaultMaskAdjustments(),
            visible: true,
            // For radial/gradient
            params: null,
        };

        this.masks.push(mask);
        this.activeMaskIndex = this.masks.length - 1;
        this.tool = type;
        return mask;
    }

    _defaultMaskAdjustments() {
        return {
            exposure: 0, contrast: 0, highlights: 0, shadows: 0,
            whites: 0, blacks: 0, temperature: 0, tint: 0,
            vibrance: 0, saturation: 0, clarity: 0, dehaze: 0,
            sharpenAmount: 0,
        };
    }

    getActiveMask() {
        if (this.activeMaskIndex >= 0 && this.activeMaskIndex < this.masks.length) {
            return this.masks[this.activeMaskIndex];
        }
        return null;
    }

    deleteMask(index) {
        this.masks.splice(index, 1);
        if (this.activeMaskIndex >= this.masks.length) {
            this.activeMaskIndex = this.masks.length - 1;
        }
    }

    // Brush painting
    brushStart(x, y) {
        const mask = this.getActiveMask();
        if (!mask || mask.type !== 'brush') return;
        this.isDrawing = true;
        this._brushStroke(mask, x, y);
    }

    brushMove(x, y) {
        if (!this.isDrawing) return;
        const mask = this.getActiveMask();
        if (!mask) return;
        this._brushStroke(mask, x, y);
    }

    brushEnd() {
        this.isDrawing = false;
    }

    _brushStroke(mask, x, y) {
        this.touch(mask);
        const ctx = mask.ctx;
        const size = this.brushSize;
        const feather = this.brushFeather / 100;
        const flow = this.brushFlow / 100;

        const gradient = ctx.createRadialGradient(x, y, size * (1 - feather) * 0.5, x, y, size * 0.5);
        if (this.eraseMode) {
            gradient.addColorStop(0, `rgba(0, 0, 0, ${flow})`);
            gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
        } else {
            gradient.addColorStop(0, `rgba(255, 255, 255, ${flow})`);
            gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
        }

        ctx.fillStyle = gradient;
        ctx.fillRect(x - size / 2, y - size / 2, size, size);
    }

    // Radial gradient mask
    createRadialMask(cx, cy, rx, ry, feather) {
        const mask = this.getActiveMask();
        if (!mask || mask.type !== 'radial') return;
        this.touch(mask);

        const ctx = mask.ctx;
        const w = mask.canvas.width;
        const h = mask.canvas.height;
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = 'black';
        ctx.fillRect(0, 0, w, h);

        mask.params = { cx, cy, rx, ry, feather };

        // Draw radial gradient
        const maxR = Math.max(rx, ry);
        const gradient = ctx.createRadialGradient(cx, cy, maxR * (1 - feather / 100), cx, cy, maxR);
        gradient.addColorStop(0, 'white');
        gradient.addColorStop(1, 'black');

        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(rx / maxR, ry / maxR);
        ctx.translate(-cx, -cy);
        ctx.fillStyle = gradient;
        ctx.fillRect(cx - maxR, cy - maxR, maxR * 2, maxR * 2);
        ctx.restore();
    }

    // Linear gradient mask
    createLinearMask(x1, y1, x2, y2, soft = false) {
        const mask = this.getActiveMask();
        if (!mask || mask.type !== 'gradient') return;
        this.touch(mask);

        const ctx = mask.ctx;
        const w = mask.canvas.width;
        const h = mask.canvas.height;
        ctx.clearRect(0, 0, w, h);

        mask.params = { x1, y1, x2, y2, soft };

        const gradient = ctx.createLinearGradient(x1, y1, x2, y2);
        gradient.addColorStop(0, 'black');
        if (!soft) {
            gradient.addColorStop(0.3, 'black');
            gradient.addColorStop(0.7, 'white');
        }
        gradient.addColorStop(1, 'white');

        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, w, h);
    }

    // Smart Select: edge-aware flood-fill for object/person/sky segmentation
    magicWandSelect(imgX, imgY, addMode) {
        const mask = this.getActiveMask();
        if (!mask || mask.type !== 'wand') return;
        this.touch(mask);

        const mw = mask.canvas.width;
        const mh = mask.canvas.height;

        // Work at reduced resolution for performance
        const maxAnalysis = 1200;
        let aw = mw, ah = mh;
        if (aw > maxAnalysis || ah > maxAnalysis) {
            const s = maxAnalysis / Math.max(aw, ah);
            aw = Math.round(aw * s);
            ah = Math.round(ah * s);
        }

        // Scale click coordinates
        const scaleToMask = mw / this.app.imageWidth;
        const scaleToAnalysis = aw / mw;
        const ax = Math.min(aw - 1, Math.max(0, Math.round(imgX * scaleToMask * scaleToAnalysis)));
        const ay = Math.min(ah - 1, Math.max(0, Math.round(imgY * scaleToMask * scaleToAnalysis)));

        // Get source pixel data
        const srcCanvas = document.createElement('canvas');
        srcCanvas.width = aw;
        srcCanvas.height = ah;
        const srcCtx = srcCanvas.getContext('2d');
        srcCtx.drawImage(this.app.image, 0, 0, aw, ah);
        const srcData = srcCtx.getImageData(0, 0, aw, ah);
        const src = srcData.data;

        // 1. Compute luminance array
        const lum = new Float32Array(aw * ah);
        for (let i = 0; i < aw * ah; i++) {
            lum[i] = 0.299 * src[i * 4] + 0.587 * src[i * 4 + 1] + 0.114 * src[i * 4 + 2];
        }

        // 2. Compute Sobel edge magnitude
        const edges = new Float32Array(aw * ah);
        let maxEdge = 0;
        for (let y = 1; y < ah - 1; y++) {
            for (let x = 1; x < aw - 1; x++) {
                const i = y * aw + x;
                // Sobel X
                const gx = -lum[i - aw - 1] - 2 * lum[i - 1] - lum[i + aw - 1]
                          + lum[i - aw + 1] + 2 * lum[i + 1] + lum[i + aw + 1];
                // Sobel Y
                const gy = -lum[i - aw - 1] - 2 * lum[i - aw] - lum[i - aw + 1]
                          + lum[i + aw - 1] + 2 * lum[i + aw] + lum[i + aw + 1];
                edges[i] = Math.sqrt(gx * gx + gy * gy);
                if (edges[i] > maxEdge) maxEdge = edges[i];
            }
        }
        // Normalize edges to 0-1
        if (maxEdge > 0) {
            for (let i = 0; i < edges.length; i++) edges[i] /= maxEdge;
        }

        // Target color
        const ti = (ay * aw + ax) * 4;
        const tr = src[ti], tg = src[ti + 1], tb = src[ti + 2];
        const tol = this.wandTolerance;
        // Edge weight: how much edges block the selection (higher = sharper boundaries)
        const edgeWeight = tol * 1.5;

        const selected = new Uint8Array(aw * ah);

        if (this.wandContiguous) {
            // Edge-aware flood fill: cost = colorDist + edge * edgeWeight
            const visited = new Uint8Array(aw * ah);
            const stack = [ax + ay * aw];
            visited[ax + ay * aw] = 1;

            while (stack.length > 0) {
                const pos = stack.pop();
                const px = pos % aw;
                const py = (pos - px) / aw;
                const pi = pos * 4;

                const dr = src[pi] - tr, dg = src[pi + 1] - tg, db = src[pi + 2] - tb;
                const colorD = Math.sqrt(dr * dr + dg * dg + db * db);
                const edgeCost = edges[pos] * edgeWeight;
                const totalCost = colorD + edgeCost;

                if (totalCost <= tol) {
                    selected[pos] = 255;
                    const neighbors = [];
                    if (px > 0) neighbors.push(pos - 1);
                    if (px < aw - 1) neighbors.push(pos + 1);
                    if (py > 0) neighbors.push(pos - aw);
                    if (py < ah - 1) neighbors.push(pos + aw);
                    // 8-connected for smoother edges
                    if (px > 0 && py > 0) neighbors.push(pos - aw - 1);
                    if (px < aw - 1 && py > 0) neighbors.push(pos - aw + 1);
                    if (px > 0 && py < ah - 1) neighbors.push(pos + aw - 1);
                    if (px < aw - 1 && py < ah - 1) neighbors.push(pos + aw + 1);
                    for (const n of neighbors) {
                        if (!visited[n]) { visited[n] = 1; stack.push(n); }
                    }
                }
            }
        } else {
            // Color range: all similar pixels (still edge-weighted)
            for (let i = 0; i < aw * ah; i++) {
                const pi = i * 4;
                const dr = src[pi] - tr, dg = src[pi + 1] - tg, db = src[pi + 2] - tb;
                const colorD = Math.sqrt(dr * dr + dg * dg + db * db);
                if (colorD <= tol) selected[i] = 255;
            }
        }

        // 3. Smooth selection edges (morphological close + blur)
        // Dilate then erode to fill small holes
        const dilated = new Uint8Array(aw * ah);
        for (let y = 1; y < ah - 1; y++) {
            for (let x = 1; x < aw - 1; x++) {
                const i = y * aw + x;
                dilated[i] = Math.max(
                    selected[i], selected[i - 1], selected[i + 1],
                    selected[i - aw], selected[i + aw]
                );
            }
        }
        const closed = new Uint8Array(aw * ah);
        for (let y = 1; y < ah - 1; y++) {
            for (let x = 1; x < aw - 1; x++) {
                const i = y * aw + x;
                closed[i] = Math.min(
                    dilated[i], dilated[i - 1], dilated[i + 1],
                    dilated[i - aw], dilated[i + aw]
                );
            }
        }
        // Gaussian-ish blur for soft edges
        const smooth = new Uint8Array(aw * ah);
        for (let y = 2; y < ah - 2; y++) {
            for (let x = 2; x < aw - 2; x++) {
                const i = y * aw + x;
                let sum = closed[i] * 4;
                sum += (closed[i - 1] + closed[i + 1] + closed[i - aw] + closed[i + aw]) * 2;
                sum += closed[i - aw - 1] + closed[i - aw + 1] + closed[i + aw - 1] + closed[i + aw + 1];
                smooth[i] = Math.round(sum / 16);
            }
        }

        // 4. Upscale and apply to mask
        const selCanvas = document.createElement('canvas');
        selCanvas.width = aw;
        selCanvas.height = ah;
        const selCtx = selCanvas.getContext('2d');
        const selData = selCtx.createImageData(aw, ah);
        for (let i = 0; i < aw * ah; i++) {
            const v = smooth[i] || closed[i] || selected[i];
            selData.data[i * 4] = v;
            selData.data[i * 4 + 1] = v;
            selData.data[i * 4 + 2] = v;
            selData.data[i * 4 + 3] = 255;
        }
        selCtx.putImageData(selData, 0, 0);

        const ctx = mask.ctx;
        if (addMode) {
            ctx.globalCompositeOperation = 'lighter';
            ctx.drawImage(selCanvas, 0, 0, mw, mh);
            ctx.globalCompositeOperation = 'source-over';
        } else if (this.eraseMode) {
            const tmpCanvas = document.createElement('canvas');
            tmpCanvas.width = mw;
            tmpCanvas.height = mh;
            const tmpCtx = tmpCanvas.getContext('2d');
            tmpCtx.drawImage(selCanvas, 0, 0, mw, mh);
            ctx.globalCompositeOperation = 'destination-out';
            ctx.drawImage(tmpCanvas, 0, 0);
            ctx.globalCompositeOperation = 'source-over';
        } else {
            ctx.clearRect(0, 0, mw, mh);
            ctx.drawImage(selCanvas, 0, 0, mw, mh);
        }
    }

    // Get combined mask canvas (all visible masks OR'd together)
    getCombinedMask() {
        const visible = this.masks.filter(m => m.visible);
        if (visible.length === 0) return null;

        const w = visible[0].canvas.width;
        const h = visible[0].canvas.height;
        const combined = document.createElement('canvas');
        combined.width = w;
        combined.height = h;
        const ctx = combined.getContext('2d');

        ctx.fillStyle = 'black';
        ctx.fillRect(0, 0, w, h);

        for (const mask of visible) {
            ctx.globalCompositeOperation = 'lighter';
            if (mask.inverted) {
                // Draw inverted
                const tempCanvas = document.createElement('canvas');
                tempCanvas.width = w;
                tempCanvas.height = h;
                const tempCtx = tempCanvas.getContext('2d');
                tempCtx.fillStyle = 'white';
                tempCtx.fillRect(0, 0, w, h);
                tempCtx.globalCompositeOperation = 'difference';
                tempCtx.drawImage(mask.canvas, 0, 0);
                ctx.drawImage(tempCanvas, 0, 0);
            } else {
                ctx.drawImage(mask.canvas, 0, 0);
            }
        }

        ctx.globalCompositeOperation = 'source-over';
        return combined;
    }

    // Handle canvas interaction
    handlePointerDown(canvasX, canvasY, imgX, imgY, shiftKey) {
        const mask = this.getActiveMask();
        if (!mask) return;
        if (mask.type !== 'wand') {
            imgX *= mask.canvas.width / this.app.imageWidth;
            imgY *= mask.canvas.height / this.app.imageHeight;
        }

        if (mask.type === 'brush') {
            this.brushStart(imgX, imgY);
        } else if (mask.type === 'wand') {
            this.magicWandSelect(imgX, imgY, shiftKey);
        } else if (mask.type === 'radial' || mask.type === 'gradient') {
            this._startPos = { x: imgX, y: imgY };
            this._creating = true;
        }
    }

    handlePointerMove(canvasX, canvasY, imgX, imgY) {
        const mask = this.getActiveMask();
        if (!mask) return;
        if (mask.type !== 'wand') {
            imgX *= mask.canvas.width / this.app.imageWidth;
            imgY *= mask.canvas.height / this.app.imageHeight;
        }

        if (mask.type === 'brush') {
            this.brushMove(imgX, imgY);
        } else if (this._creating) {
            this._endPos = { x: imgX, y: imgY };
            if (mask.type === 'radial') {
                const cx = (this._startPos.x + imgX) / 2;
                const cy = (this._startPos.y + imgY) / 2;
                const rx = Math.abs(imgX - this._startPos.x) / 2;
                const ry = Math.abs(imgY - this._startPos.y) / 2;
                this.createRadialMask(cx, cy, Math.max(rx, 10), Math.max(ry, 10), 50);
            } else if (mask.type === 'gradient') {
                this.createLinearMask(this._startPos.x, this._startPos.y, imgX, imgY, mask.blend === 'additive');
            }
        }
    }

    handlePointerUp() {
        this.brushEnd();
        this._creating = false;
        this._startPos = null;
        this._endPos = null;
    }

    // Get mask overlay for display
    getMaskOverlay(displayWidth, displayHeight) {
        const mask = this.getActiveMask();
        if (!mask) return null;

        const overlay = document.createElement('canvas');
        overlay.width = displayWidth;
        overlay.height = displayHeight;
        const ctx = overlay.getContext('2d');

        ctx.drawImage(mask.canvas, 0, 0, displayWidth, displayHeight);

        // Colorize: show red tint for selected areas
        const imgData = ctx.getImageData(0, 0, displayWidth, displayHeight);
        const d = imgData.data;
        for (let i = 0; i < d.length; i += 4) {
            const val = mask.inverted ? (255 - d[i]) : d[i];
            d[i] = 255;       // R
            d[i + 1] = 0;     // G
            d[i + 2] = 0;     // B
            d[i + 3] = val * 0.3; // A
        }
        ctx.putImageData(imgData, 0, 0);
        return overlay;
    }
}
