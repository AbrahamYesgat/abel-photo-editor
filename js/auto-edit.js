// ABEL — Auto Edit (Lightroom-inspired)
// Analyzes histogram shape, per-channel balance, saturation distribution,
// and applies corrections that enhance without destroying the image's character.
class AutoEdit {

    static analyze(imageData) {
        const data = imageData.data;
        const n = data.length / 4;

        // Per-channel histograms + luminance histogram
        const histR = new Uint32Array(256);
        const histG = new Uint32Array(256);
        const histB = new Uint32Array(256);
        const histL = new Uint32Array(256);

        let totalR = 0, totalG = 0, totalB = 0, totalL = 0;
        let satSum = 0, satCount = 0;
        let darkPixels = 0, midPixels = 0, brightPixels = 0;

        for (let i = 0; i < data.length; i += 4) {
            const r = data[i], g = data[i + 1], b = data[i + 2];
            const lum = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);

            histR[r]++; histG[g]++; histB[b]++;
            histL[Math.min(255, lum)]++;
            totalR += r; totalG += g; totalB += b; totalL += lum;

            // Saturation (HSV model)
            const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
            if (mx > 10) { satSum += (mx - mn) / mx; satCount++; }

            // Zone counts
            if (lum < 60) darkPixels++;
            else if (lum > 200) brightPixels++;
            else midPixels++;
        }

        const pct = (hist, p) => {
            let cum = 0;
            for (let i = 0; i < 256; i++) {
                cum += hist[i];
                if (cum / n >= p) return i;
            }
            return 255;
        };

        return {
            n,
            avgR: totalR / n, avgG: totalG / n, avgB: totalB / n,
            avgL: totalL / n,
            avgSat: satCount > 0 ? satSum / satCount : 0,
            // Luminance percentiles
            p1: pct(histL, 0.01), p5: pct(histL, 0.05),
            p25: pct(histL, 0.25), p50: pct(histL, 0.50),
            p75: pct(histL, 0.75), p95: pct(histL, 0.95),
            p99: pct(histL, 0.99),
            // Per-channel percentiles (for white balance)
            rP50: pct(histR, 0.50), gP50: pct(histG, 0.50), bP50: pct(histB, 0.50),
            // Zone distribution
            darkRatio: darkPixels / n,
            midRatio: midPixels / n,
            brightRatio: brightPixels / n,
            histL,
        };
    }

    static autoAll(imageData) {
        const a = this.analyze(imageData);
        const r = {};

        // ================================================================
        // 1. EXPOSURE — never darken, only lift underexposed images
        // ================================================================
        // Rule: if median is below 100, the image is genuinely underexposed.
        // If median is 100+, leave exposure alone — the photographer chose it.
        if (a.p50 < 95) {
            const target = 110;
            r.exposure = Math.min(1.5, Math.log2((target + 1) / (a.p50 + 1)) * 0.7);
        } else {
            r.exposure = 0;
        }
        r.exposure = Math.round(r.exposure * 100) / 100;

        // ================================================================
        // 2. WHITE BALANCE — correct only obvious color casts
        // ================================================================
        // Compare per-channel medians. A neutral scene has them roughly equal.
        const chanAvg = (a.rP50 + a.gP50 + a.bP50) / 3;
        const rDev = (a.rP50 - chanAvg) / (chanAvg + 1);
        const bDev = (a.bP50 - chanAvg) / (chanAvg + 1);
        const gDev = (a.gP50 - chanAvg) / (chanAvg + 1);

        // Only correct if deviation > 6%
        if (Math.abs(rDev - bDev) > 0.06) {
            r.temperature = Math.round(Math.max(-25, Math.min(25, (bDev - rDev) * 70)));
        } else {
            r.temperature = 0;
        }
        if (Math.abs(gDev) > 0.06) {
            r.tint = Math.round(Math.max(-15, Math.min(15, -gDev * 50)));
        } else {
            r.tint = 0;
        }

        // ================================================================
        // 3. TONE — shape the histogram without crushing anything
        // ================================================================
        const range = a.p95 - a.p5;

        // Contrast: open up flat histograms, calm down harsh ones
        if (range < 130) {
            r.contrast = Math.round(Math.min(20, (130 - range) * 0.18));
        } else if (range > 210) {
            r.contrast = -Math.round(Math.min(8, (range - 210) * 0.15));
        } else {
            r.contrast = 5;
        }

        // Highlights: recover if bright end is clipping
        if (a.p95 > 235) {
            r.highlights = -Math.round(Math.min(35, (a.p95 - 230) * 2.5));
        } else {
            r.highlights = -5; // slight pull always helps
        }

        // Shadows: lift if bottom end is crushed
        if (a.p5 < 25) {
            r.shadows = Math.round(Math.min(35, (28 - a.p5) * 1.2));
        } else {
            r.shadows = 5; // slight lift opens up detail
        }

        // Whites: push if image lacks bright tones
        if (a.p99 < 235) {
            r.whites = Math.round(Math.min(18, (235 - a.p99) * 0.25));
        } else {
            r.whites = 0;
        }

        // Blacks: deepen only if image lacks dark anchor
        if (a.p1 > 18) {
            r.blacks = -Math.round(Math.min(12, (a.p1 - 12) * 0.35));
        } else {
            r.blacks = 0;
        }

        // ================================================================
        // 4. COLOR — adaptive vibrance, never oversaturate
        // ================================================================
        if (a.avgSat < 0.20) {
            // Very desaturated — boost more
            r.vibrance = Math.round(Math.min(22, (0.25 - a.avgSat) * 90));
        } else if (a.avgSat < 0.35) {
            // Normal — gentle boost
            r.vibrance = 10;
        } else if (a.avgSat > 0.55) {
            // Oversaturated — pull back
            r.vibrance = -Math.round(Math.min(10, (a.avgSat - 0.50) * 30));
        } else {
            r.vibrance = 5;
        }

        // ================================================================
        // 5. DETAIL — clarity for perceived sharpness
        // ================================================================
        r.clarity = 8;

        return r;
    }
}
