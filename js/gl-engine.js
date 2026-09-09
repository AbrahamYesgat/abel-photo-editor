// ABEL — WebGL Engine
class GLEngine {
    constructor(canvas) {
        this.canvas = canvas;
        this.gl = canvas.getContext('webgl', {
            premultipliedAlpha: false,
            preserveDrawingBuffer: true,
            antialias: false,
        });
        if (!this.gl) throw new Error('WebGL not supported');

        this.program = null;
        this.uniforms = {};
        this.imageTexture = null;
        this.curveTexture = null;
        this.imageWidth = 0;
        this.imageHeight = 0;

        this._init();
    }

    _init() {
        const gl = this.gl;

        // Compile shaders
        const vs = this._compileShader(gl.VERTEX_SHADER, VERTEX_SHADER);
        const fs = this._compileShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
        this.program = gl.createProgram();
        gl.attachShader(this.program, vs);
        gl.attachShader(this.program, fs);
        gl.linkProgram(this.program);

        if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
            console.error('Shader link error:', gl.getProgramInfoLog(this.program));
            return;
        }

        gl.useProgram(this.program);

        // Setup geometry (full-screen quad)
        const positions = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
        const texCoords = new Float32Array([0, 1, 1, 1, 0, 0, 1, 0]);

        const posBuf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
        const posLoc = gl.getAttribLocation(this.program, 'a_position');
        gl.enableVertexAttribArray(posLoc);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

        const texBuf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, texBuf);
        gl.bufferData(gl.ARRAY_BUFFER, texCoords, gl.STATIC_DRAW);
        const texLoc = gl.getAttribLocation(this.program, 'a_texCoord');
        gl.enableVertexAttribArray(texLoc);
        gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, 0, 0);

        // Cache uniform locations
        this._cacheUniforms();

        // Create placeholder textures
        this.curveTexture = this._createTexture(gl.TEXTURE1, true);

        // Set texture unit uniforms
        gl.uniform1i(this.uniforms.u_image, 0);
        gl.uniform1i(this.uniforms.u_curveLUT, 1);
    }

    _compileShader(type, source) {
        const gl = this.gl;
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const err = gl.getShaderInfoLog(shader);
            console.error('Shader compile error:', err);
            throw new Error('Shader compilation failed: ' + err);
        }
        return shader;
    }

    _cacheUniforms() {
        const gl = this.gl;
        const p = this.program;
        const names = [
            'u_image', 'u_curveLUT', 'u_resolution', 'u_texelSize',
            'u_exposure', 'u_contrast', 'u_highlights', 'u_shadows',
            'u_whites', 'u_blacks', 'u_temperature', 'u_tint',
            'u_vibrance', 'u_saturation', 'u_clarity', 'u_dehaze',
            'u_cgShadowsCol', 'u_cgShadowsBlend',
            'u_cgMidtonesCol', 'u_cgMidtonesBlend',
            'u_cgHighlightsCol', 'u_cgHighlightsBlend',
            'u_sharpenAmount',
            'u_vignetteAmount', 'u_vignetteMidpoint', 'u_vignetteFeather',
            'u_grainAmount',
            'u_useCurve', 'u_showOriginal',
        ];

        for (const name of names) {
            this.uniforms[name] = gl.getUniformLocation(p, name);
        }

        // HSL arrays
        for (let i = 0; i < 8; i++) {
            this.uniforms[`u_hslHue[${i}]`] = gl.getUniformLocation(p, `u_hslHue[${i}]`);
            this.uniforms[`u_hslSat[${i}]`] = gl.getUniformLocation(p, `u_hslSat[${i}]`);
            this.uniforms[`u_hslLum[${i}]`] = gl.getUniformLocation(p, `u_hslLum[${i}]`);
        }
    }

    _createTexture(unit, useNearest) {
        const gl = this.gl;
        const tex = gl.createTexture();
        gl.activeTexture(unit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        const filter = useNearest ? gl.NEAREST : gl.LINEAR;
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
        return tex;
    }

    loadImage(img) {
        const gl = this.gl;
        this.imageWidth = img.naturalWidth || img.width;
        this.imageHeight = img.naturalHeight || img.height;

        // Cap canvas resolution to GPU max to avoid WebGL failures on huge images
        const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
        const maxDim = Math.min(maxSize, 4096); // practical cap for performance
        let renderW = this.imageWidth;
        let renderH = this.imageHeight;
        if (renderW > maxDim || renderH > maxDim) {
            const scale = maxDim / Math.max(renderW, renderH);
            renderW = Math.round(renderW * scale);
            renderH = Math.round(renderH * scale);
        }
        this.renderWidth = renderW;
        this.renderHeight = renderH;

        this.canvas.width = renderW;
        this.canvas.height = renderH;

        gl.viewport(0, 0, renderW, renderH);

        // Upload image as texture (GPU handles the full resolution)
        if (this.imageTexture) gl.deleteTexture(this.imageTexture);
        this.imageTexture = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.imageTexture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);

        gl.uniform1i(this.uniforms.u_image, 0);
        gl.uniform2f(this.uniforms.u_resolution, renderW, renderH);
        gl.uniform2f(this.uniforms.u_texelSize, 1.0 / renderW, 1.0 / renderH);
    }

    setAdjustments(adj) {
        const gl = this.gl;
        const u = this.uniforms;

        gl.uniform1f(u.u_exposure, adj.exposure || 0);
        gl.uniform1f(u.u_contrast, adj.contrast || 0);
        gl.uniform1f(u.u_highlights, adj.highlights || 0);
        gl.uniform1f(u.u_shadows, adj.shadows || 0);
        gl.uniform1f(u.u_whites, adj.whites || 0);
        gl.uniform1f(u.u_blacks, adj.blacks || 0);
        gl.uniform1f(u.u_temperature, adj.temperature || 0);
        gl.uniform1f(u.u_tint, adj.tint || 0);
        gl.uniform1f(u.u_vibrance, adj.vibrance || 0);
        gl.uniform1f(u.u_saturation, adj.saturation || 0);
        gl.uniform1f(u.u_clarity, adj.clarity || 0);
        gl.uniform1f(u.u_dehaze, adj.dehaze || 0);

        gl.uniform1f(u.u_sharpenAmount, adj.sharpenAmount || 0);

        gl.uniform1f(u.u_vignetteAmount, adj.vignetteAmount || 0);
        gl.uniform1f(u.u_vignetteMidpoint, adj.vignetteMidpoint || 50);
        gl.uniform1f(u.u_vignetteFeather, adj.vignetteFeather || 50);
        gl.uniform1f(u.u_grainAmount, adj.grainAmount || 0);

        // HSL
        const hslHue = adj.hslHue || [0, 0, 0, 0, 0, 0, 0, 0];
        const hslSat = adj.hslSat || [0, 0, 0, 0, 0, 0, 0, 0];
        const hslLum = adj.hslLum || [0, 0, 0, 0, 0, 0, 0, 0];
        for (let i = 0; i < 8; i++) {
            gl.uniform1f(u[`u_hslHue[${i}]`], hslHue[i]);
            gl.uniform1f(u[`u_hslSat[${i}]`], hslSat[i]);
            gl.uniform1f(u[`u_hslLum[${i}]`], hslLum[i]);
        }

        // Color grading
        const cg = adj.colorGrading || {};
        const cgS = cg.shadows || { r: 1, g: 1, b: 1, blend: 0 };
        const cgM = cg.midtones || { r: 1, g: 1, b: 1, blend: 0 };
        const cgH = cg.highlights || { r: 1, g: 1, b: 1, blend: 0 };
        gl.uniform3f(u.u_cgShadowsCol, cgS.r, cgS.g, cgS.b);
        gl.uniform1f(u.u_cgShadowsBlend, cgS.blend);
        gl.uniform3f(u.u_cgMidtonesCol, cgM.r, cgM.g, cgM.b);
        gl.uniform1f(u.u_cgMidtonesBlend, cgM.blend);
        gl.uniform3f(u.u_cgHighlightsCol, cgH.r, cgH.g, cgH.b);
        gl.uniform1f(u.u_cgHighlightsBlend, cgH.blend);

        gl.uniform1i(u.u_showOriginal, adj.showOriginal ? 1 : 0);
    }

    updateCurveLUT(lutData) {
        const gl = this.gl;
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.curveTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, lutData.width, lutData.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, lutData.data);
        gl.uniform1i(this.uniforms.u_useCurve, lutData.isIdentity ? 0 : 1);
    }

    render() {
        const gl = this.gl;
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    getImageData() {
        const gl = this.gl;
        this.render();
        const pixels = new Uint8Array(this.canvas.width * this.canvas.height * 4);
        gl.readPixels(0, 0, this.canvas.width, this.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

        // WebGL reads bottom-to-top, flip vertically
        const w = this.canvas.width;
        const h = this.canvas.height;
        const flipped = new Uint8ClampedArray(pixels.length);
        for (let y = 0; y < h; y++) {
            const srcRow = (h - 1 - y) * w * 4;
            const dstRow = y * w * 4;
            flipped.set(pixels.subarray(srcRow, srcRow + w * 4), dstRow);
        }

        return new ImageData(flipped, w, h);
    }

    // For histogram: read a downscaled version for performance
    getImageDataForHistogram() {
        // Read from the current canvas state
        return this.getImageData();
    }

    destroy() {
        const gl = this.gl;
        if (this.imageTexture) gl.deleteTexture(this.imageTexture);
        if (this.curveTexture) gl.deleteTexture(this.curveTexture);
        if (this.program) gl.deleteProgram(this.program);
    }
}
