// Shared, bounded pixel/tensor operations. No network or editor state.
(function (root) {
    'use strict';
    const models = Object.freeze({
        sky: Object.freeze({
            url: 'https://huggingface.co/Xenova/detr-resnet-50-panoptic/resolve/ea24b2d4e0bfae31f0a1299ba3fb892a2df064de/onnx/model_fp16.onnx',
            bytes: 86559030, sha256: 'afd9f02d864302d690356fd4bfcb2feed2397a1190bf46a7306cb430464d734a',
            // COCO panoptic merged taxonomy; the converted config's LABEL_187 is incomplete.
            label: 'DETR-ResNet50 panoptic', skyClass: 187,
        }),
        subject: Object.freeze({
            url: 'https://huggingface.co/edgetools/u2netp/resolve/25dee37ab19c5b6ad64ba6578eba63f1ae07720c/u2netp.onnx',
            bytes: 4574861, sha256: '309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8',
            label: 'U²-Netp',
        }),
    });
    const presets = Object.freeze({
        natural: { name: 'Natural definition', adjustments: { contrast: 8, highlights: -15, saturation: 5, clarity: 8 } },
        recover: { name: 'Recover bright sky', adjustments: { exposure: -.2, highlights: -40, contrast: 5 } },
        sunset: { name: 'Warm sunset', adjustments: { temperature: 18, tint: 4, highlights: -18, saturation: 10 } },
        blue: { name: 'Cool blue hour', adjustments: { temperature: -15, exposure: -.12, saturation: 8, highlights: -12 } },
        soft: { name: 'Soft atmosphere', adjustments: { contrast: -8, clarity: -12, saturation: -5, highlights: -10 } },
        reset: { name: 'Reset sky adjustments', adjustments: {} },
    });
    function sizeFor(kind, width, height) {
        if (!models[kind] || !Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1)
            throw new Error('Invalid detection image.');
        // U²-Net's training contract is a square stretch, not letterboxing.
        if (kind === 'subject') return { width: 320, height: 320 };
        const scale = Math.min(512 / Math.min(width, height), 768 / Math.max(width, height));
        return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
    }
    function normalize(rgba, kind) {
        if (!models[kind] || rgba.length % 4) throw new Error('Invalid detection pixels.');
        const count = rgba.length / 4, data = new Float32Array(count * 3);
        let divisor = 255;
        if (kind === 'subject') {
            divisor = 1;
            for (let i = 0; i < rgba.length; i += 4) divisor = Math.max(divisor, rgba[i], rgba[i + 1], rgba[i + 2]);
        }
        const mean = [.485, .456, .406], std = [.229, .224, .225];
        for (let i = 0; i < count; i++) for (let c = 0; c < 3; c++)
            data[c * count + i] = (rgba[i * 4 + c] / divisor - mean[c]) / std[c];
        return data;
    }
    function skyMask(logits, masks) {
        if (logits?.dims?.length !== 3 || masks?.dims?.length !== 4 ||
            logits.dims[0] !== 1 || masks.dims[0] !== 1 || logits.dims[1] !== masks.dims[1] ||
            logits.dims[2] <= models.sky.skyClass + 1) throw new Error('Unsupported sky model output.');
        const [, queries, classes] = logits.dims, [, , height, width] = masks.dims;
        const count = width * height;
        if (count < 1 || count > 1024 * 1024 || queries > 300 ||
            logits.data.length !== queries * classes || masks.data.length !== queries * count)
            throw new Error('Invalid sky model dimensions.');
        const candidates = [];
        for (let q = 0; q < queries; q++) {
            let best = 0, max = -Infinity, total = 0;
            for (let c = 0; c < classes; c++) {
                const value = logits.data[q * classes + c];
                if (!Number.isFinite(value)) throw new Error('Invalid sky model values.');
                if (value > max) { max = value; best = c; }
            }
            for (let c = 0; c < classes; c++) total += Math.exp(logits.data[q * classes + c] - max);
            const score = 1 / total;
            if (best !== classes - 1 && score >= .85) candidates.push({ q, sky: best === models.sky.skyClass });
        }
        const alpha = new Uint8ClampedArray(count);
        for (let i = 0; i < count; i++) {
            let best = -Infinity, sky = false;
            for (const candidate of candidates) {
                const value = masks.data[candidate.q * count + i];
                if (!Number.isFinite(value)) throw new Error('Invalid sky mask values.');
                if (value > best) { best = value; sky = candidate.sky; }
            }
            // Competing semantic classes protect buildings, trees and mountains.
            // Original DETR panoptic uses softmax across query masks, then argmax
            // (equivalently raw-logit argmax), not sigmoid × class probability.
            if (sky) alpha[i] = 255;
        }
        return { alpha, width, height };
    }
    function subjectMask(tensor) {
        const dims = tensor?.dims;
        if (dims?.length !== 4 || dims[0] !== 1 || dims[1] !== 1 ||
            dims[2] !== 320 || dims[3] !== 320 || tensor.data.length !== 320 * 320)
            throw new Error('Unsupported subject model output.');
        const alpha = new Uint8ClampedArray(tensor.data.length);
        let min = Infinity, max = -Infinity;
        for (const v of tensor.data) {
            if (!Number.isFinite(v) || v < -.001 || v > 1.001) throw new Error('Invalid subject probabilities.');
            min = Math.min(min, v); max = Math.max(max, v);
        }
        // Do not amplify an uncertain/constant prediction into a fake cutout.
        if (max >= .6 && max - min >= .25) for (let i = 0; i < alpha.length; i++)
            alpha[i] = Math.round(255 * Math.max(0, Math.min(1, (tensor.data[i] - .2) / .6)));
        return { alpha, width: 320, height: 320 };
    }
    function reliable({ alpha, width, height }) {
        if (!(alpha instanceof Uint8ClampedArray) || alpha.length !== width * height ||
            width < 1 || height < 1 || width > 2048 || height > 2048) return false;
        let strong = 0, empty = 0;
        for (const value of alpha) { if (value >= 192) strong++; if (value < 64) empty++; }
        return strong >= Math.max(12, alpha.length * .002) && empty >= alpha.length * .005;
    }
    function rgbaMask(alpha) {
        const rgba = new Uint8ClampedArray(alpha.length * 4);
        for (let i = 0; i < alpha.length; i++) {
            rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = alpha[i];
            rgba[i * 4 + 3] = 255;
        }
        return rgba;
    }
    const api = { models, presets, sizeFor, normalize, skyMask, subjectMask, reliable, rgbaMask };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.SemanticMasks = api;
})(globalThis);
