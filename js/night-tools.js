// Local, non-generative restoration of the developed sRGB image.
(function(root) {
    'use strict';
    const radius = 24;
    const clamp = (value, min, max, fallback = min) =>
        Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;

    function settings(state = {}) {
        return {
            noiseLuma: clamp(state.noiseLuma, 0, 100),
            noiseColor: clamp(state.noiseColor, 0, 100),
            motionAmount: clamp(state.motionAmount, 0, 100),
            motionLength: clamp(state.motionLength, 1, 12, 4),
            motionAngle: clamp(state.motionAngle, 0, 180),
        };
    }

    // Pixel-integrated straight-line PSF. The finite Wiener inverse is windowed
    // to ±24 samples; regularization bounds amplification near transfer zeros.
    function kernel(length) {
        length = clamp(length, 1, 12, 1);
        const n = 256, lambda = 0.08;
        const psf = [];
        for (let x = -6; x <= 6; x++) {
            psf.push(Math.max(0, Math.min(x + 0.5, length / 2) -
                Math.max(x - 0.5, -length / 2)) / length);
        }
        const spectrum = Array.from({ length: n }, (_, f) => {
            let h = 0;
            for (let x = -6; x <= 6; x++) h += psf[x + 6] * Math.cos(2 * Math.PI * f * x / n);
            return (1 + lambda) * h / (h * h + lambda);
        });
        const result = new Float32Array(radius * 2 + 1);
        for (let x = -radius; x <= radius; x++) {
            let sum = 0;
            for (let f = 0; f < n; f++) sum += spectrum[f] * Math.cos(2 * Math.PI * f * x / n);
            result[x + radius] = sum / n * (0.5 + 0.5 * Math.cos(Math.PI * x / (radius + 1)));
        }
        const dc = result.reduce((sum, value) => sum + value, 0);
        return Float32Array.from(result, value => value / dc);
    }

    const vertex = `
        attribute vec2 a_position, a_texCoord;
        varying vec2 v_uv;
        void main() {
            gl_Position = vec4(a_position, 0., 1.);
            // FBO storage must have the same orientation as an uploaded photo.
            v_uv = vec2(a_texCoord.x, 1. - a_texCoord.y);
        }
    `;
    const fragment = `
        precision highp float;
        varying vec2 v_uv;
        uniform sampler2D u_source;
        uniform vec2 u_step;
        uniform vec2 u_noise;
        uniform float u_amount;
        uniform float u_kernel[49];
        uniform int u_mode;
        float lum(vec3 c) { return dot(c, vec3(.2126, .7152, .0722)); }
        void main() {
            vec4 center = texture2D(u_source, v_uv);
            vec3 result = vec3(0.);
            if (u_mode == 0) {
                float total = 0.;
                float y = lum(center.rgb);
                vec3 chroma = center.rgb - y;
                for (int j = -2; j <= 2; j++) {
                    for (int i = -2; i <= 2; i++) {
                        vec4 neighbor = texture2D(u_source, v_uv + vec2(float(i), float(j)) * u_step);
                        float dy = lum(neighbor.rgb) - y;
                        vec3 dc = neighbor.rgb - lum(neighbor.rgb) - chroma;
                        float spatial = float(i * i + j * j) / 3.;
                        float weight = exp(-spatial - dy * dy / .0128 - dot(dc, dc) / .04)
                            * neighbor.a;
                        result += neighbor.rgb * weight;
                        total += weight;
                    }
                }
                result = total > .00001 ? result / total : center.rgb;
                float averageY = lum(result);
                result = vec3(mix(y, averageY, u_noise.x)) +
                    mix(chroma, result - averageY, u_noise.y);
            } else {
                for (int i = 0; i < 49; i++) {
                    vec4 neighbor = texture2D(u_source, v_uv + float(i - 24) * u_step);
                    result += mix(center.rgb, neighbor.rgb, neighbor.a) * u_kernel[i];
                }
                result = mix(center.rgb, result, u_amount);
            }
            gl_FragColor = vec4(clamp(result, 0., 1.), center.a);
        }
    `;
    const api = Object.freeze({ radius, settings, kernel, vertex, fragment });
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.NightTools = api;
})(typeof globalThis === 'object' ? globalThis : this);
