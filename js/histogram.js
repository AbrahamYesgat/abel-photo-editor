// ABEL — Histogram
class Histogram {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.width = 256;
        this.height = 48;
        canvas.width = this.width;
        canvas.height = this.height;
    }

    compute(imageData) {
        const data = imageData.data;
        const r = new Uint32Array(256);
        const g = new Uint32Array(256);
        const b = new Uint32Array(256);
        const l = new Uint32Array(256);

        for (let i = 0; i < data.length; i += 4) {
            const ri = data[i], gi = data[i + 1], bi = data[i + 2];
            r[ri]++;
            g[gi]++;
            b[bi]++;
            const lum = Math.round(0.2126 * ri + 0.7152 * gi + 0.0722 * bi);
            l[Math.min(255, lum)]++;
        }

        return { r, g, b, l };
    }

    draw(histData) {
        if (!histData) return;
        const { r, g, b, l } = histData;
        const ctx = this.ctx;
        const w = this.width;
        const h = this.height;

        ctx.clearRect(0, 0, w, h);

        // Smooth max (exclude extremes)
        const maxVal = Math.max(
            ...Array.from(l).slice(2, 253)
        ) || 1;

        const drawChannel = (data, color, alpha) => {
            ctx.fillStyle = color;
            ctx.globalAlpha = alpha;
            ctx.beginPath();
            ctx.moveTo(0, h);
            for (let i = 0; i < 256; i++) {
                const val = Math.min(data[i] / maxVal, 1.0);
                ctx.lineTo(i, h - val * (h - 2));
            }
            ctx.lineTo(255, h);
            ctx.closePath();
            ctx.fill();
        };

        drawChannel(l, '#555555', 0.5);
        drawChannel(r, '#ef4444', 0.25);
        drawChannel(g, '#22c55e', 0.25);
        drawChannel(b, '#3b82f6', 0.25);
        ctx.globalAlpha = 1.0;
    }

    update(imageData) {
        const histData = this.compute(imageData);
        this.draw(histData);
        return histData;
    }
}
