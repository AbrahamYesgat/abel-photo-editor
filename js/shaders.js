// ABEL — GLSL Shader Sources
// WebGL 1.0 compatible vertex + fragment shaders

const VERTEX_SHADER = `
attribute vec2 a_position;
attribute vec2 a_texCoord;
varying vec2 v_texCoord;

void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
    v_texCoord = a_texCoord;
}
`;

const FRAGMENT_SHADER = `
precision highp float;

varying vec2 v_texCoord;

uniform sampler2D u_image;
uniform sampler2D u_curveLUT;
uniform vec2 u_resolution;
uniform vec2 u_texelSize;

// Basic adjustments
uniform float u_exposure;
uniform float u_contrast;
uniform float u_highlights;
uniform float u_shadows;
uniform float u_whites;
uniform float u_blacks;
uniform float u_temperature;
uniform float u_tint;
uniform float u_vibrance;
uniform float u_saturation;
uniform float u_clarity;
uniform float u_dehaze;

// HSL — 8 color ranges
uniform float u_hslHue[8];
uniform float u_hslSat[8];
uniform float u_hslLum[8];

// Color grading
uniform vec3 u_cgShadowsCol;
uniform float u_cgShadowsBlend;
uniform vec3 u_cgMidtonesCol;
uniform float u_cgMidtonesBlend;
uniform vec3 u_cgHighlightsCol;
uniform float u_cgHighlightsBlend;

// Sharpening
uniform float u_sharpenAmount;

// Effects
uniform float u_vignetteAmount;
uniform float u_vignetteMidpoint;
uniform float u_vignetteFeather;
uniform float u_grainAmount;

// Flags
uniform int u_useCurve;
uniform int u_showOriginal;

// ======== Color space helpers ========

float luminance(vec3 c) {
    return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

vec3 rgb2hsl(vec3 c) {
    float maxC = max(c.r, max(c.g, c.b));
    float minC = min(c.r, min(c.g, c.b));
    float l = (maxC + minC) * 0.5;

    if (maxC == minC) return vec3(0.0, 0.0, l);

    float d = maxC - minC;
    float s = l > 0.5 ? d / (2.0 - maxC - minC) : d / (maxC + minC);
    float h;

    if (maxC == c.r) {
        h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
    } else if (maxC == c.g) {
        h = (c.b - c.r) / d + 2.0;
    } else {
        h = (c.r - c.g) / d + 4.0;
    }
    h /= 6.0;

    return vec3(h, s, l);
}

float hue2rgb(float p, float q, float t) {
    if (t < 0.0) t += 1.0;
    if (t > 1.0) t -= 1.0;
    if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
    if (t < 0.5) return q;
    if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
    return p;
}

vec3 hsl2rgb(vec3 hsl) {
    if (hsl.y == 0.0) return vec3(hsl.z);

    float q = hsl.z < 0.5 ? hsl.z * (1.0 + hsl.y) : hsl.z + hsl.y - hsl.z * hsl.y;
    float p = 2.0 * hsl.z - q;

    return vec3(
        hue2rgb(p, q, hsl.x + 1.0 / 3.0),
        hue2rgb(p, q, hsl.x),
        hue2rgb(p, q, hsl.x - 1.0 / 3.0)
    );
}

// ======== HSL channel weight ========
// Returns weight for each of the 8 color ranges based on hue (0-1)
// Ranges: 0=Red(0), 1=Orange(30), 2=Yellow(60), 3=Green(120), 4=Aqua(180), 5=Blue(240), 6=Purple(280), 7=Magenta(320)

float hslWeight(float hue360, float center, float width) {
    float dist = abs(hue360 - center);
    if (dist > 180.0) dist = 360.0 - dist;
    return max(0.0, 1.0 - dist / width);
}

// ======== Pseudo-random for grain ========
float rand(vec2 co) {
    return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
}

// ======== Main ========
void main() {
    vec4 texColor = texture2D(u_image, v_texCoord);
    vec3 color = texColor.rgb;
    vec3 original = color;

    if (u_showOriginal == 1) {
        gl_FragColor = vec4(original, texColor.a);
        return;
    }

    // ---- 1. White Balance (Temperature & Tint) ----
    float temp = u_temperature / 100.0;
    float tnt = u_tint / 100.0;
    color.r *= 1.0 + temp * 0.15;
    color.b *= 1.0 - temp * 0.15;
    color.g *= 1.0 + tnt * 0.1;
    color.r *= 1.0 - tnt * 0.05;
    color = clamp(color, 0.0, 1.0);

    // ---- 2. Exposure ----
    color *= pow(2.0, u_exposure);
    color = clamp(color, 0.0, 1.0);

    // ---- 3. Highlights / Shadows / Whites / Blacks ----
    float lum = luminance(color);

    float hlW = smoothstep(0.55, 1.0, lum);
    color += color * hlW * (u_highlights / 100.0) * 0.6;

    float shW = 1.0 - smoothstep(0.0, 0.45, lum);
    color += color * shW * (u_shadows / 100.0) * 0.6;

    float whW = smoothstep(0.8, 1.0, lum);
    color += color * whW * (u_whites / 100.0) * 0.4;

    float blW = 1.0 - smoothstep(0.0, 0.2, lum);
    color += color * blW * (u_blacks / 100.0) * 0.4;
    color = clamp(color, 0.0, 1.0);

    // ---- 4. Contrast ----
    float cont = u_contrast / 100.0;
    vec3 mid = vec3(0.5);
    color = mid + (color - mid) * (1.0 + cont);
    color = clamp(color, 0.0, 1.0);

    // ---- 5. Dehaze ----
    if (u_dehaze != 0.0) {
        float dh = u_dehaze / 100.0;
        float minRGB = min(color.r, min(color.g, color.b));
        color = color - minRGB * dh * 0.5 + dh * 0.05;
        color = mix(vec3(luminance(color)), color, 1.0 + dh * 0.3);
        color = clamp(color, 0.0, 1.0);
    }

    // ---- 6. Clarity (simplified local contrast) ----
    if (u_clarity != 0.0) {
        vec3 neighbors = vec3(0.0);
        neighbors += texture2D(u_image, v_texCoord + vec2(-u_texelSize.x, 0.0)).rgb;
        neighbors += texture2D(u_image, v_texCoord + vec2(u_texelSize.x, 0.0)).rgb;
        neighbors += texture2D(u_image, v_texCoord + vec2(0.0, -u_texelSize.y)).rgb;
        neighbors += texture2D(u_image, v_texCoord + vec2(0.0, u_texelSize.y)).rgb;
        neighbors *= 0.25;
        float localContrast = luminance(color) - luminance(neighbors);
        float clarityFactor = u_clarity / 100.0;
        color += localContrast * clarityFactor * 0.8;
        color = clamp(color, 0.0, 1.0);
    }

    // ---- 7. Vibrance ----
    if (u_vibrance != 0.0) {
        float vib = u_vibrance / 100.0;
        float maxCh = max(color.r, max(color.g, color.b));
        float minCh = min(color.r, min(color.g, color.b));
        float curSat = (maxCh - minCh) / (maxCh + 0.001);
        float vibW = (1.0 - curSat) * (1.0 - curSat);
        vec3 lumVec = vec3(luminance(color));
        color = mix(color, mix(lumVec, color, 1.0 + vib * 1.5), vibW);
        color = clamp(color, 0.0, 1.0);
    }

    // ---- 8. Saturation ----
    if (u_saturation != 0.0) {
        float satF = u_saturation / 100.0;
        vec3 lumVec = vec3(luminance(color));
        color = mix(lumVec, color, 1.0 + satF);
        color = clamp(color, 0.0, 1.0);
    }

    // ---- 9. HSL Adjustments ----
    vec3 hsl = rgb2hsl(clamp(color, 0.0, 1.0));
    float hue360 = hsl.x * 360.0;

    float centers[8];
    centers[0] = 0.0;   centers[1] = 30.0;  centers[2] = 60.0;
    centers[3] = 120.0;  centers[4] = 180.0; centers[5] = 240.0;
    centers[6] = 280.0;  centers[7] = 320.0;

    float widths[8];
    widths[0] = 30.0;  widths[1] = 25.0;  widths[2] = 30.0;
    widths[3] = 40.0;  widths[4] = 40.0;  widths[5] = 40.0;
    widths[6] = 30.0;  widths[7] = 30.0;

    float totalHueShift = 0.0;
    float totalSatShift = 0.0;
    float totalLumShift = 0.0;
    float totalWeight = 0.0;

    for (int i = 0; i < 8; i++) {
        float w = hslWeight(hue360, centers[i], widths[i]);
        if (i == 0) {
            w = max(w, hslWeight(hue360, 360.0, widths[0]));
        }
        if (w > 0.0) {
            totalHueShift += u_hslHue[i] * w;
            totalSatShift += u_hslSat[i] * w;
            totalLumShift += u_hslLum[i] * w;
            totalWeight += w;
        }
    }

    if (totalWeight > 0.0) {
        hsl.x += (totalHueShift / totalWeight) / 360.0;
        hsl.x = fract(hsl.x);
        hsl.y *= 1.0 + (totalSatShift / totalWeight) / 100.0;
        hsl.y = clamp(hsl.y, 0.0, 1.0);
        hsl.z += (totalLumShift / totalWeight) / 100.0 * 0.5;
        hsl.z = clamp(hsl.z, 0.0, 1.0);
    }

    color = hsl2rgb(hsl);

    // ---- 10. Tone Curve ----
    if (u_useCurve == 1) {
        // LUT layout: row 0 = RGB master, row 0.25 = R, row 0.5 = G, row 0.75 = B
        float rc = texture2D(u_curveLUT, vec2(clamp(color.r, 0.0, 1.0), 0.75)).r;
        float gc = texture2D(u_curveLUT, vec2(clamp(color.g, 0.0, 1.0), 0.5)).g;
        float bc = texture2D(u_curveLUT, vec2(clamp(color.b, 0.0, 1.0), 0.25)).b;
        // Apply master curve on top
        color.r = texture2D(u_curveLUT, vec2(rc, 0.0)).r;
        color.g = texture2D(u_curveLUT, vec2(gc, 0.0)).g;
        color.b = texture2D(u_curveLUT, vec2(bc, 0.0)).b;
    }

    // ---- 11. Color Grading ----
    lum = luminance(clamp(color, 0.0, 1.0));
    float cgSW = pow(1.0 - smoothstep(0.0, 0.4, lum), 1.5);
    float cgMW = 1.0 - pow(abs(lum - 0.5) * 2.0, 1.5);
    cgMW = max(cgMW, 0.0);
    float cgHW = pow(smoothstep(0.6, 1.0, lum), 1.5);

    if (u_cgShadowsBlend > 0.0) {
        color = mix(color, color * u_cgShadowsCol, cgSW * u_cgShadowsBlend);
    }
    if (u_cgMidtonesBlend > 0.0) {
        color = mix(color, color * u_cgMidtonesCol, cgMW * u_cgMidtonesBlend);
    }
    if (u_cgHighlightsBlend > 0.0) {
        color = mix(color, color * u_cgHighlightsCol, cgHW * u_cgHighlightsBlend);
    }

    // ---- 12. Sharpening (unsharp mask) ----
    if (u_sharpenAmount > 0.0) {
        vec3 blur = vec3(0.0);
        float s = 1.0;
        blur += texture2D(u_image, v_texCoord + vec2(-u_texelSize.x * s, 0.0)).rgb;
        blur += texture2D(u_image, v_texCoord + vec2(u_texelSize.x * s, 0.0)).rgb;
        blur += texture2D(u_image, v_texCoord + vec2(0.0, -u_texelSize.y * s)).rgb;
        blur += texture2D(u_image, v_texCoord + vec2(0.0, u_texelSize.y * s)).rgb;
        blur += texture2D(u_image, v_texCoord + vec2(-u_texelSize.x * s, -u_texelSize.y * s)).rgb;
        blur += texture2D(u_image, v_texCoord + vec2(u_texelSize.x * s, -u_texelSize.y * s)).rgb;
        blur += texture2D(u_image, v_texCoord + vec2(-u_texelSize.x * s, u_texelSize.y * s)).rgb;
        blur += texture2D(u_image, v_texCoord + vec2(u_texelSize.x * s, u_texelSize.y * s)).rgb;
        blur /= 8.0;
        float sharpStr = u_sharpenAmount / 100.0 * 2.0;
        color += (color - blur) * sharpStr;
    }

    // ---- 13. Vignette ----
    if (u_vignetteAmount != 0.0) {
        vec2 uv = v_texCoord - 0.5;
        float aspect = u_resolution.x / u_resolution.y;
        uv.x *= aspect;
        float dist = length(uv);
        float mid = u_vignetteMidpoint / 100.0 * 0.7 + 0.2;
        float feath = max(u_vignetteFeather / 100.0, 0.05);
        float vig = smoothstep(mid - feath * 0.5, mid + feath * 0.5, dist);
        float va = u_vignetteAmount / 100.0;
        color *= 1.0 - vig * va;
    }

    // ---- 14. Grain ----
    if (u_grainAmount > 0.0) {
        float ga = u_grainAmount / 100.0;
        float n = rand(v_texCoord * u_resolution * 0.01 + vec2(0.07, 0.13)) - 0.5;
        color += n * ga * 0.25;
    }

    gl_FragColor = vec4(clamp(color, 0.0, 1.0), texColor.a);
}
`;

