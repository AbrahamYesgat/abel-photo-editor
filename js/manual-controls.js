// Manual editing capabilities are independent of AI review permissions.
(function (root) {
    'use strict';
    const controls = Object.freeze(Object.fromEntries([
        ['exposure', 'Exposure (EV)', 'Light', -5, 5, .01],
        ['contrast', 'Contrast', 'Light'],
        ['highlights', 'Highlights', 'Light'],
        ['shadows', 'Shadows', 'Light'],
        ['whites', 'Whites', 'Light'],
        ['blacks', 'Blacks', 'Light'],
        ['temperature', 'Temperature', 'Color'],
        ['tint', 'Tint', 'Color'],
        ['vibrance', 'Vibrance', 'Color'],
        ['saturation', 'Saturation', 'Color'],
        ['texture', 'Texture', 'Detail'],
        ['clarity', 'Clarity', 'Detail'],
        ['dehaze', 'Dehaze', 'Detail'],
        ['sharpenAmount', 'Sharpening', 'Detail', 0, 150]
    ].map(([key, label, group, min = -100, max = 100, step = 1]) =>
        [key, Object.freeze({ label, group, min, max, step, defaultValue: 0 })])));
    const defaults = () => Object.fromEntries(Object.keys(controls).map(key => [key, 0]));
    const normalize = values => Object.fromEntries(Object.entries(controls).map(([key, control]) =>
        [key, Number.isFinite(values?.[key])
            ? Math.max(control.min, Math.min(control.max, values[key])) : 0]));
    const merge = (base, offsets, bounded = true) => {
        const result = { ...base };
        const safe = normalize(offsets);
        for (const [key, control] of Object.entries(controls)) {
            const value = (Number.isFinite(base[key]) ? base[key] : 0) + safe[key];
            result[key] = bounded ? Math.max(control.min, Math.min(control.max, value)) : value;
        }
        return result;
    };
    const api = Object.freeze({ controls, defaults, normalize, merge });
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.ManualControls = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
