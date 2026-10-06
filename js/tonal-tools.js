(function (root, factory) {
    const tools = factory();
    if (typeof module === 'object' && module.exports) module.exports = tools;
    root.TonalTools = tools;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    const bands = ['shadows', 'midtones', 'highlights'];
    const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
    const copy = value => JSON.parse(JSON.stringify(value));
    const defaults = () => ({ enabled: true, blending: 50, balance: 0,
        ...Object.fromEntries(bands.map(band => [band, { hue: 0, saturation: 0 }])) });
    function hueRGB(hue) {
        const h = ((hue % 360) + 360) % 360 / 60;
        return [0, 4, 2].map(offset => clamp(Math.abs((h + offset) % 6 - 3) - 1));
    }
    function tint(band) {
        const rgb = hueRGB(band.hue);
        const y = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
        return rgb.map(v => (v - y) * band.saturation / 100);
    }
    function weights(luminance, blending, balance) {
        const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
        const x = clamp(luminance - balance / 100 * 0.25);
        const width = 0.08 + blending / 100 * 0.30;
        const s = 1 - smooth(0.30 - width, 0.30 + width, x);
        const h = smooth(0.70 - width, 0.70 + width, x);
        const m = Math.max(0, 1 - s - h), sum = s + m + h;
        return [s / sum, m / sum, h / sum];
    }
    // Reference for the pointwise GPU stage: zero-luminance chroma, limited to gamut.
    function gradePixel(color, grade) {
        if (!grade.enabled) return [...color];
        const y = color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722;
        const w = weights(y, grade.blending, grade.balance);
        const tints = bands.map(band => tint(grade[band]));
        const delta = color.map((_, i) => tints.reduce((sum, t, j) => sum + t[i] * w[j], 0) *
            Math.min(y, 1 - y) * 0.75);
        let scale = 1;
        delta.forEach((d, i) => {
            if (d > 0) scale = Math.min(scale, (1 - color[i]) / d);
            else if (d < 0) scale = Math.min(scale, -color[i] / d);
        });
        return color.map((v, i) => v + delta[i] * scale);
    }
    function blendGrade(baseline, target, amount) {
        if (!target || !amount) return copy(baseline);
        const result = copy(target);
        const base = baseline.enabled ? baseline : { ...baseline,
            ...Object.fromEntries(bands.map(b => [b, { ...baseline[b], saturation: 0 }])) };
        result.enabled = true;
        for (const key of ['balance', 'blending']) result[key] = base[key] + (target[key] - base[key]) * amount;
        for (const band of bands) {
            const a = base[band], b = target[band];
            const delta = ((b.hue - a.hue + 540) % 360) - 180;
            result[band] = { hue: a.saturation === 0 ? b.hue : (a.hue + delta * amount + 360) % 360,
                saturation: a.saturation + (b.saturation - a.saturation) * amount };
        }
        return result;
    }
    // Shared with the existing manual curve editor; validation checks actual rendered samples.
    function interpolate(points) {
        const lut = new Uint8Array(256);
        if (points.length < 2 || (points.length === 2 && points[0].x === 0 && points[0].y === 0 &&
            points[1].x === 255 && points[1].y === 255)) return Uint8Array.from({ length: 256 }, (_, i) => i);
        for (let i = 0; i < 256; i++) {
            if (i <= points[0].x) { lut[i] = clamp(points[0].y, 0, 255); continue; }
            if (i >= points[points.length - 1].x) { lut[i] = clamp(points.at(-1).y, 0, 255); continue; }
            let seg = 0;
            for (let j = 0; j < points.length - 1; j++) {
                if (i >= points[j].x && i <= points[j + 1].x) { seg = j; break; }
            }
            const p0 = points[Math.max(0, seg - 1)], p1 = points[seg];
            const p2 = points[seg + 1], p3 = points[Math.min(points.length - 1, seg + 2)];
            const t = (i - p1.x) / (p2.x - p1.x), t2 = t * t, t3 = t2 * t;
            lut[i] = clamp(Math.round(0.5 * (2 * p1.y + (-p0.y + p2.y) * t +
                (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
                (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3)), 0, 255);
        }
        return lut;
    }
    function blendCurve(baseline, target, amount) {
        if (!target?.length || !amount) return copy(baseline);
        const points = target.map(p => ({ x: p.x * 255, y: p.y * 255 }));
        if (amount === 1) return points;
        const a = interpolate(baseline), b = interpolate(points);
        return Array.from(a, (v, x) => ({ x, y: Math.round(v + (b[x] - v) * amount) }));
    }
    return Object.freeze({ bands, defaults, hueRGB, tint, weights, gradePixel, blendGrade, interpolate, blendCurve });
});
