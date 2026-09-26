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
        gl.bindAttribLocation(this.program, 0, 'a_position');
        gl.bindAttribLocation(this.program, 1, 'a_texCoord');
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
            gl.deleteShader(shader);
            console.error('Shader compile error:', err);
            throw new Error('Shader compilation failed: ' + err);
        }
        return shader;
    }

    _cacheUniforms() {
        const gl = this.gl;
        const p = this.program;
        const names = [
            'u_image', 'u_curveLUT', 'u_resolution', 'u_texelSize', 'u_region', 'u_sourceRegion',
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
        this._releaseNight();
        this._releaseComposite();
        gl.useProgram(this.program);
        this.imageWidth = img.naturalWidth || img.width;
        this.imageHeight = img.naturalHeight || img.height;

        const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
        const displaySize = Math.ceil(Math.max(window.innerWidth || 1200, window.innerHeight || 900)
            * Math.min(window.devicePixelRatio || 1, 1.5));
        const maxDim = Math.min(maxSize, 1600, displaySize);
        let renderW = this.imageWidth;
        let renderH = this.imageHeight;
        if (renderW > maxDim || renderH > maxDim) {
            const scale = maxDim / Math.max(renderW, renderH);
            renderW = Math.max(1, Math.round(renderW * scale));
            renderH = Math.max(1, Math.round(renderH * scale));
        }
        // The preview texture, not just the framebuffer, must be bounded on phones.
        let source = img;
        if (renderW !== this.imageWidth || renderH !== this.imageHeight) {
            source = document.createElement('canvas');
            source.width = renderW; source.height = renderH;
            source.getContext('2d').drawImage(img, 0, 0, renderW, renderH);
        }
        if (this.imageTexture) gl.deleteTexture(this.imageTexture);
        this.imageTexture = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.imageTexture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        this._sourceSize = [renderW, renderH];
        this._sourceScale = [renderW / this.imageWidth, renderH / this.imageHeight];
        if (source !== img) source.width = source.height = 1;

        gl.uniform1i(this.uniforms.u_image, 0);
        this.setRenderSize(renderW, renderH);
        this.previewWidth = renderW;
        this.previewHeight = renderH;
        gl.uniform2f(this.uniforms.u_resolution, this.imageWidth, this.imageHeight);
        gl.uniform2f(this.uniforms.u_texelSize, 1 / renderW, 1 / renderH);
        gl.uniform4f(this.uniforms.u_sourceRegion, 0, 0, 1, 1);
        this.setRegion(0, 0, 1, 1);
    }

    loadExportTile(img, adjustments = {}) {
        const gl = this.gl;
        this._releaseNight();
        const [x, y, w, h] = this.region;
        const iw = this.imageWidth, ih = this.imageHeight;
        // The finite inverse support + denoise + downstream detail taps, not
        // just the forward blur length, determines the seam-free halo.
        const night = NightTools.settings(adjustments);
        const pad = 4 + (night.noiseLuma || night.noiseColor ? 2 : 0) +
            (night.motionAmount ? NightTools.radius : 0);
        const sx = Math.max(0, Math.floor(x * iw) - pad), sy = Math.max(0, Math.floor(y * ih) - pad);
        const sw = Math.min(iw, Math.ceil((x + w) * iw) + pad) - sx;
        const sh = Math.min(ih, Math.ceil((y + h) * ih) + pad) - sy;
        const tile = this._exportSource ||= document.createElement('canvas');
        const scale = Math.min(1, 2048 / Math.max(sw, sh), gl.getParameter(gl.MAX_TEXTURE_SIZE) / Math.max(sw, sh));
        tile.width = Math.max(1, Math.round(sw * scale)); tile.height = Math.max(1, Math.round(sh * scale));
        tile.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, tile.width, tile.height);
        gl.useProgram(this.program);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.imageTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tile);
        this._sourceSize = [tile.width, tile.height];
        this._sourceScale = [tile.width / sw, tile.height / sh];
        gl.uniform4f(this.uniforms.u_sourceRegion, sx / iw, sy / ih, sw / iw, sh / ih);
        gl.uniform2f(this.uniforms.u_texelSize, 1 / iw, 1 / ih);
    }

    exportImage(img, adjustments, masks = [], scale = 1) {
        const tiles = this._exportTiles(img, adjustments, masks, scale, 1024);
        let result;
        do { result = tiles.next(); } while (!result.done);
        return result.value;
    }

    async exportImageAsync(img, adjustments, masks = [], scale = 1, { signal, onProgress } = {}) {
        const tiles = this._exportTiles(img, adjustments, masks, scale, 512);
        try {
            while (true) {
                if (signal?.aborted) throw new DOMException('Export cancelled.', 'AbortError');
                const result = tiles.next();
                if (result.done) return result.value;
                onProgress?.(result.value);
                // Yield between bounded native tiles so cancellation and progress
                // remain usable, even with software graphics and several masks.
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        } finally {
            tiles.return();
        }
    }

    *_exportTiles(img, adjustments, masks, scale, tileSize) {
        const width = Math.round((img.naturalWidth || img.width) * scale);
        const height = Math.round((img.naturalHeight || img.height) * scale);
        if (width < 1 || height < 1 || width > 32767 || height > 32767 || width * height > 128 * 1024 * 1024) {
            throw new Error('This export is too large. Choose a smaller export scale.');
        }
        const output = document.createElement('canvas');
        output.width = width; output.height = height;
        const ctx = output.getContext('2d');
        let complete = false;
        try {
            this.loadImage(img);
            const tileWidth = Math.min(tileSize, width), tileHeight = Math.min(tileSize, height);
            const total = Math.ceil(width / tileWidth) * Math.ceil(height / tileHeight);
            let done = 0;
            this.setRenderSize(tileWidth, tileHeight);
            for (let y = 0; y < height; y += tileHeight) {
                for (let x = 0; x < width; x += tileWidth) {
                    this.setRegion(x / width, y / height, tileWidth / width, tileHeight / height);
                    this.loadExportTile(img, adjustments);
                    this.renderComposite(adjustments, masks);
                    const w = Math.min(tileWidth, width - x), h = Math.min(tileHeight, height - y);
                    ctx.drawImage(this.canvas, 0, 0, w, h, x, y, w, h);
                    yield ++done / total;
                }
            }
            if (this.gl.isContextLost()) throw new Error('Graphics memory was exhausted. Try a smaller photo.');
            complete = true;
            return output;
        } finally {
            if (!complete) output.width = output.height = 1;
            if (this._exportSource) this._exportSource.width = this._exportSource.height = 1;
        }
    }

    setRenderSize(width, height) {
        if (this.canvas.width !== width || this.canvas.height !== height) {
            this._releaseComposite(true);
            this.canvas.width = width;
            this.canvas.height = height;
        }
        this.renderWidth = width; this.renderHeight = height;
    }

    setRegion(x, y, width, height) {
        this.region = [x, y, width, height];
        this.gl.useProgram(this.program);
        this.gl.uniform4fv(this.uniforms.u_region, this.region);
    }

    setAdjustments(adj) {
        const gl = this.gl;
        gl.useProgram(this.program);
        const u = this.uniforms;
        this._showOriginal = !!adj.showOriginal;

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
        const signature = `${lutData.isIdentity}:${Array.from(lutData.data)}`;
        if (signature === this._curveSignature) return;
        this._curveSignature = signature;
        this._curveRevision = (this._curveRevision || 0) + 1;
        const gl = this.gl;
        gl.useProgram(this.program);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.curveTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, lutData.width, lutData.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, lutData.data);
        gl.uniform1i(this.uniforms.u_useCurve, lutData.isIdentity ? 0 : 1);
    }

    render() {
        const gl = this.gl;
        gl.useProgram(this.program);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        this._bindPhotoTextures();
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    _bindPhotoTextures() {
        const gl = this.gl;
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this._showOriginal ? this.imageTexture :
            this._nightTexture || this.imageTexture);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.curveTexture);
    }

    _target(width = this.canvas.width, height = this.canvas.height) {
        const gl = this.gl;
        const texture = this._createTexture(gl.TEXTURE4, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height,
            0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        const framebuffer = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
            gl.deleteFramebuffer(framebuffer); gl.deleteTexture(texture);
            throw new Error('Not enough graphics memory to render this photo.');
        }
        return { texture, framebuffer };
    }

    _releaseNight() {
        for (const target of this._nightTargets || []) {
            this.gl.deleteFramebuffer(target.framebuffer);
            this.gl.deleteTexture(target.texture);
        }
        this._nightTargets = [];
        this._nightTexture = null;
        this._nightKey = null;
    }

    _prepareNight(adj) {
        if (adj.showOriginal) return;
        const settings = NightTools.settings(adj);
        const key = JSON.stringify(settings);
        if (key === this._nightKey) return;
        const gl = this.gl;
        if (!settings.noiseLuma && !settings.noiseColor && !settings.motionAmount) {
            this._releaseNight();
            this._nightKey = key;
            return;
        }
        try {
            if (!this._nightProgram) {
                const program = gl.createProgram();
                const vs = this._compileShader(gl.VERTEX_SHADER, NightTools.vertex);
                const fs = this._compileShader(gl.FRAGMENT_SHADER, NightTools.fragment);
                gl.attachShader(program, vs); gl.attachShader(program, fs);
                gl.bindAttribLocation(program, 0, 'a_position');
                gl.bindAttribLocation(program, 1, 'a_texCoord');
                gl.linkProgram(program);
                gl.deleteShader(vs); gl.deleteShader(fs);
                if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
                    gl.deleteProgram(program);
                    throw new Error('Night tools are not supported by this graphics device.');
                }
                this._nightProgram = { program };
                for (const name of ['source', 'step', 'noise', 'amount', 'kernel[0]', 'mode']) {
                    this._nightProgram[name] = gl.getUniformLocation(program, `u_${name}`);
                }
            }
            const [width, height] = this._sourceSize;
            const [scaleX, scaleY] = this._sourceScale;
            const p = this._nightProgram;
            let input = this.imageTexture, pass = 0;
            const draw = (mode, step) => {
                const target = this._nightTargets[pass] ||= this._target(width, height);
                pass++;
                gl.useProgram(p.program);
                gl.uniform1i(p.source, 0); gl.uniform1i(p.mode, mode);
                gl.uniform2fv(p.step, step);
                gl.uniform2f(p.noise, settings.noiseLuma / 100, settings.noiseColor / 100);
                gl.uniform1f(p.amount, settings.motionAmount / 100);
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, input);
                gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
                gl.viewport(0, 0, width, height);
                gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
                input = target.texture;
            };
            if (settings.noiseLuma || settings.noiseColor) draw(0, [scaleX / width, scaleY / height]);
            if (settings.motionAmount) {
                const scale = Math.min(scaleX, scaleY);
                const angle = settings.motionAngle * Math.PI / 180;
                gl.useProgram(p.program);
                gl.uniform1fv(p['kernel[0]'], NightTools.kernel(settings.motionLength * scale));
                draw(1, [Math.cos(angle) * scaleX / scale / width,
                    Math.sin(angle) * scaleY / scale / height]);
            }
            if (gl.isContextLost() || gl.getError() !== gl.NO_ERROR) {
                throw new Error('Night tools ran out of graphics resources. Try a smaller photo.');
            }
            this._nightTexture = input;
            this._nightKey = key;
        } catch (error) {
            this._releaseNight();
            throw error;
        } finally {
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.useProgram(this.program);
        }
    }

    _releaseComposite(keepMasks = false) {
        const gl = this.gl;
        for (const target of [...(this._layers || []), ...(this._mixTargets || [])]) {
            gl.deleteFramebuffer(target.framebuffer);
            gl.deleteTexture(target.texture);
        }
        if (!keepMasks) {
            for (const entry of this._maskTextures?.values() || []) gl.deleteTexture(entry.texture);
            this._maskTextures = new Map();
        }
        this._layers = [];
        this._mixTargets = [];
        this._prefixKey = null;
        this._prefixMasks = null;
        this._prefixTarget = null;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    _initMixer() {
        if (this._mixer) return;
        const gl = this.gl;
        const program = gl.createProgram();
        const vs = this._compileShader(gl.VERTEX_SHADER, `
            attribute vec2 a_position; attribute vec2 a_texCoord;
            varying vec2 v_uv;
            void main() { gl_Position = vec4(a_position, 0., 1.); v_uv = a_texCoord; }
        `);
        const fs = this._compileShader(gl.FRAGMENT_SHADER, `
            precision highp float;
            varying vec2 v_uv;
            uniform sampler2D u_base, u_layer, u_previous, u_mask;
            uniform vec4 u_region;
            uniform int u_mode;
            uniform bool u_inverted;
            uniform float u_opacity;
            void main() {
                vec2 uv = vec2(v_uv.x, 1. - v_uv.y);
                vec4 previous = texture2D(u_previous, uv);
                if (previous.a == 0.) previous.rgb = vec3(0.);
                if (u_mode == 2) { gl_FragColor = previous; return; }
                vec4 layer = texture2D(u_layer, uv);
                if (layer.a == 0.) layer.rgb = vec3(0.);
                float weight = texture2D(u_mask, u_region.xy + v_uv * u_region.zw).r;
                if (u_inverted) weight = 1. - weight;
                weight *= u_opacity;
                if (u_mode == 1) {
                    vec4 base = texture2D(u_base, uv);
                    if (base.a == 0.) base.rgb = vec3(0.);
                    gl_FragColor = vec4(clamp(previous.rgb +
                        (layer.rgb - base.rgb) * weight, 0., 1.), previous.a);
                } else {
                    float alpha = weight + previous.a * (1. - weight);
                    gl_FragColor = vec4((layer.rgb * weight + previous.rgb * previous.a *
                        (1. - weight)) / max(alpha, .00001), alpha);
                }
            }
        `);
        gl.attachShader(program, vs); gl.attachShader(program, fs);
        gl.bindAttribLocation(program, 0, 'a_position');
        gl.bindAttribLocation(program, 1, 'a_texCoord');
        gl.linkProgram(program);
        gl.deleteShader(vs); gl.deleteShader(fs);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Mask compositor failed to initialize.');
        this._mixer = { program };
        for (const name of ['base', 'layer', 'previous', 'mask', 'mode', 'inverted', 'region', 'opacity']) {
            this._mixer[name] = gl.getUniformLocation(program, `u_${name}`);
        }
    }

    renderComposite(adj, masks) {
        const gl = this.gl;
        if (gl.isContextLost()) throw new Error('Graphics context was lost. Reload the photo or use a smaller image.');
        // Restore once per source/settings change, shared by every mask layer.
        this._prepareNight(adj);
        if (!masks.length || adj.showOriginal) {
            if (!masks.length && this._layers?.length) this._releaseComposite();
            this.setAdjustments(adj);
            this.render();
            return;
        }
        this._initMixer();
        const adjustments = [adj, ...masks.map(mask => {
            const merged = { ...adj, showOriginal: false };
            for (const [key, value] of Object.entries(mask.adjustments)) {
                if (typeof merged[key] !== 'number') continue;
                merged[key] += value;
                const control = ReviewContract.controls[key] || ReviewContract.detailControls[key];
                if (mask.blend === 'additive' && control) {
                    merged[key] = Math.max(control.min, Math.min(control.max, merged[key]));
                }
            }
            return merged;
        })];
        // Reuse unchanged adjusted layers during brush strokes and local slider drags.
        const keys = adjustments.map(value => `${this.region}:${this._curveRevision}:${JSON.stringify(value)}`);
        const targets = [];
        const retained = new Set();
        const cacheLayers = masks.length <= 6;
        for (let i = 0; i < (cacheLayers ? adjustments.length : 1); i++) {
            let target = this._layers.find(item => item.key === keys[i]);
            if (!target) {
                target = this._layers.find(item => !keys.includes(item.key) && !retained.has(item))
                    || this._target();
                if (!this._layers.includes(target)) this._layers.push(target);
                this.setAdjustments(adjustments[i]);
                this._bindPhotoTextures();
                gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
                gl.viewport(0, 0, this.canvas.width, this.canvas.height);
                gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
                target.key = keys[i];
            }
            targets.push(target);
            retained.add(target);
        }
        for (const target of this._layers) {
            if (!retained.has(target)) {
                gl.deleteFramebuffer(target.framebuffer); gl.deleteTexture(target.texture);
            }
        }
        this._layers = [...retained];
        if (!this._mixTargets.length) this._mixTargets = [this._target(), this._target()];
        if (!cacheLayers && this._mixTargets.length < 3) this._mixTargets.push(this._target());
        const active = new Set(masks.map(mask => mask.canvas));
        for (const [canvas, entry] of this._maskTextures) {
            if (!active.has(canvas)) { gl.deleteTexture(entry.texture); this._maskTextures.delete(canvas); }
        }
        const mixer = this._mixer;
        const bind = (unit, texture) => {
            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(gl.TEXTURE_2D, texture);
        };
        const prefixMasks = masks.slice(0, -1);
        const prefixKey = JSON.stringify([keys.slice(0, -1),
            prefixMasks.map(mask => [mask.revision || 0, mask.inverted, mask.blend, mask.opacity ?? 1])]);
        const reusePrefix = masks.length > 1 && this._prefixKey === prefixKey &&
            prefixMasks.every((mask, index) => mask.canvas === this._prefixMasks?.[index]);
        let previous = reusePrefix ? this._prefixTarget : targets[0];
        for (let i = reusePrefix ? masks.length - 1 : 0; i < masks.length; i++) {
            const mask = masks[i];
            let entry = this._maskTextures.get(mask.canvas);
            if (!entry) {
                entry = { texture: this._createTexture(gl.TEXTURE3, false), revision: -1 };
                this._maskTextures.set(mask.canvas, entry);
            }
            if (entry.revision !== (mask.revision || 0)) {
                bind(3, entry.texture);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mask.canvas);
                entry.revision = mask.revision || 0;
            }
            const layer = cacheLayers ? targets[i + 1] : this._mixTargets[2];
            if (!cacheLayers) {
                this.setAdjustments(adjustments[i + 1]);
                this._bindPhotoTextures();
                gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
                gl.viewport(0, 0, this.canvas.width, this.canvas.height);
                gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            }
            gl.useProgram(mixer.program);
            for (const [unit, name] of ['base', 'layer', 'previous', 'mask'].entries()) {
                gl.uniform1i(mixer[name], unit);
            }
            gl.uniform4fv(mixer.region, this.region);
            gl.uniform1i(mixer.mode, mask.blend === 'additive' ? 1 : 0);
            gl.uniform1i(mixer.inverted, mask.inverted ? 1 : 0);
            gl.uniform1f(mixer.opacity, mask.opacity ?? 1);
            bind(0, targets[0].texture); bind(1, layer.texture);
            bind(2, previous.texture); bind(3, entry.texture);
            // Only the completed composite is ever drawn to the visible canvas.
            const output = i === masks.length - 1 ? null : this._mixTargets[i % 2];
            gl.bindFramebuffer(gl.FRAMEBUFFER, output?.framebuffer || null);
            gl.viewport(0, 0, this.canvas.width, this.canvas.height);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            if (i === masks.length - 2) this._prefixTarget = output;
            previous = output;
        }
        this._prefixKey = prefixKey;
        this._prefixMasks = prefixMasks.map(mask => mask.canvas);
        gl.useProgram(this.program);
        this._bindPhotoTextures();
        this.setAdjustments(adj);
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
        this._releaseComposite();
        this._releaseNight();
        if (this._nightProgram) gl.deleteProgram(this._nightProgram.program);
        if (this._mixer) gl.deleteProgram(this._mixer.program);
        if (this.imageTexture) gl.deleteTexture(this.imageTexture);
        if (this.curveTexture) gl.deleteTexture(this.curveTexture);
        if (this.program) gl.deleteProgram(this.program);
    }
}
