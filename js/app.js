// ABEL — Main Application
class App {
    constructor() {
        this.image = null;
        this.imageWidth = 0;
        this.imageHeight = 0;
        this.glEngine = null;
        this.histogram = null;
        this.curveEditor = null;
        this.maskEngine = null;

        this.state = this._defaultState();
        this.history = [];
        this.historyIndex = -1;
        this.showingOriginal = false;
        this.maskMode = false;
        this.sliders = {};
        this.zoom = 'fit';

        this._initUI();
        this._bindEvents();
    }

    _defaultState() {
        return {
            exposure: 0, contrast: 0, highlights: 0, shadows: 0,
            whites: 0, blacks: 0, temperature: 0, tint: 0,
            vibrance: 0, saturation: 0, clarity: 0, dehaze: 0,
            sharpenAmount: 0,
            vignetteAmount: 0, vignetteMidpoint: 50, vignetteFeather: 50,
            grainAmount: 0,
            hslHue: [0, 0, 0, 0, 0, 0, 0, 0],
            hslSat: [0, 0, 0, 0, 0, 0, 0, 0],
            hslLum: [0, 0, 0, 0, 0, 0, 0, 0],
            colorGrading: {
                shadows: { r: 1, g: 1, b: 1, blend: 0 },
                midtones: { r: 1, g: 1, b: 1, blend: 0 },
                highlights: { r: 1, g: 1, b: 1, blend: 0 },
            },
        };
    }

    // ======================== UI Init ========================

    _initUI() {
        // GL canvas
        const mainCanvas = document.getElementById('main-canvas');
        try {
            this.glEngine = new GLEngine(mainCanvas);
        } catch (e) {
            alert('WebGL is required. Please use a modern browser.');
            return;
        }

        // Histogram
        this.histogram = new Histogram(document.getElementById('histogram-canvas'));

        // Curve editor
        const curveContainer = document.getElementById('curve-container');
        this.curveEditor = new CurveEditor(curveContainer);
        this.curveEditor.onChange = (lut) => {
            this.glEngine.updateCurveLUT(lut);
            this._render();
        };

        // Mask engine
        this.maskEngine = new MaskEngine(this);

        // Build panels
        this._buildBasicPanel();
        this._buildHSLPanel();
        this._buildColorPanel();
        this._buildDetailPanel();
        this._buildEffectsPanel();
        this._buildMaskPanel();
        this._buildPresets();

        // Crop tool
        this.cropTool = new CropTool(this);

        // Panel tab switching (vertical tabs + old horizontal tabs for compatibility)
        const switchPanel = (panel, clickedTab) => {
            // Update vtabs
            document.querySelectorAll('.vtab').forEach(t => t.classList.remove('active'));
            // Update panel-tabs (mobile compat)
            document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
            if (clickedTab) clickedTab.classList.add('active');
            // Also mark matching vtab/panel-tab
            document.querySelectorAll(`.vtab[data-panel="${panel}"], .panel-tab[data-panel="${panel}"]`).forEach(t => t.classList.add('active'));

            document.querySelectorAll('.edit-panel').forEach(p => p.classList.remove('active'));
            document.getElementById(`panel-${panel}`).classList.add('active');
            if (panel !== 'masks') this._exitMaskMode();
            if (panel === 'crop') {
                this.cropTool.activate();
            } else if (this.cropTool && this.cropTool.active) {
                this.cropTool.deactivate();
            }
        };

        document.querySelectorAll('.vtab').forEach(tab => {
            tab.addEventListener('click', () => switchPanel(tab.dataset.panel, tab));
        });
        document.querySelectorAll('.panel-tab').forEach(tab => {
            tab.addEventListener('click', () => switchPanel(tab.dataset.panel, tab));
        });

        // Mobile tab bar
        document.querySelectorAll('.mobile-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const panel = tab.dataset.panel;
                document.querySelectorAll('.mobile-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                switchPanel(panel, null);
                document.querySelector('.sidebar-right').classList.add('mobile-open');
                document.getElementById('mobile-backdrop')?.classList.add('visible');
            });
        });
    }

    _createSlider(parent, label, key, min, max, step, defaultVal, category) {
        const wrap = document.createElement('div');
        wrap.className = 'slider-row';

        const header = document.createElement('div');
        header.className = 'slider-header';

        const lbl = document.createElement('span');
        lbl.className = 'slider-label';
        lbl.textContent = label;

        const val = document.createElement('span');
        val.className = 'slider-value';
        val.textContent = defaultVal;

        header.appendChild(lbl);
        header.appendChild(val);

        const input = document.createElement('input');
        input.type = 'range';
        input.min = min;
        input.max = max;
        input.step = step;
        input.value = defaultVal;
        input.className = 'slider-input';

        // Double-click to reset
        input.addEventListener('dblclick', () => {
            input.value = defaultVal;
            val.textContent = this._formatVal(defaultVal, step);
            this._onSliderChange(key, parseFloat(defaultVal), category);
        });

        input.addEventListener('input', () => {
            const v = parseFloat(input.value);
            val.textContent = this._formatVal(v, step);
            this._onSliderChange(key, v, category);
        });

        wrap.appendChild(header);
        wrap.appendChild(input);
        parent.appendChild(wrap);

        this.sliders[key] = { input, val, defaultVal };
        return wrap;
    }

    _formatVal(v, step) {
        return step < 1 ? v.toFixed(2) : Math.round(v).toString();
    }

    _onSliderChange(key, value, category) {
        if (category === 'hslHue' || category === 'hslSat' || category === 'hslLum') {
            const idx = parseInt(key.split('_')[1]);
            this.state[category][idx] = value;
        } else if (category === 'mask') {
            const mask = this.maskEngine.getActiveMask();
            const realKey = key.replace('mask_', '');
            if (mask) mask.adjustments[realKey] = value;
        } else if (category === 'brush') {
            this.maskEngine[key] = value;
            return;
        } else if (category === 'wand') {
            this.maskEngine[key] = value;
            return;
        } else {
            this.state[key] = value;
        }
        this._render();
        this._debouncedHistoryPush();
    }

    _historyDebounce = null;
    _debouncedHistoryPush() {
        clearTimeout(this._historyDebounce);
        this._historyDebounce = setTimeout(() => this._pushHistory(), 500);
    }

    _buildBasicPanel() {
        const panel = document.getElementById('panel-basic');
        const sliders = [
            ['Exposure', 'exposure', -5, 5, 0.01, 0],
            ['Contrast', 'contrast', -100, 100, 1, 0],
            ['Highlights', 'highlights', -100, 100, 1, 0],
            ['Shadows', 'shadows', -100, 100, 1, 0],
            ['Whites', 'whites', -100, 100, 1, 0],
            ['Blacks', 'blacks', -100, 100, 1, 0],
            ['Temperature', 'temperature', -100, 100, 1, 0],
            ['Tint', 'tint', -100, 100, 1, 0],
            ['Vibrance', 'vibrance', -100, 100, 1, 0],
            ['Saturation', 'saturation', -100, 100, 1, 0],
            ['Clarity', 'clarity', -100, 100, 1, 0],
            ['Dehaze', 'dehaze', -100, 100, 1, 0],
        ];
        sliders.forEach(([l, k, mn, mx, s, d]) => this._createSlider(panel, l, k, mn, mx, s, d));
    }

    _buildHSLPanel() {
        const panel = document.getElementById('panel-hsl');
        const colors = ['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta'];

        // Sub-tabs for H/S/L
        const subTabs = document.createElement('div');
        subTabs.className = 'hsl-subtabs';
        ['Hue', 'Saturation', 'Luminance'].forEach((name, ti) => {
            const btn = document.createElement('button');
            btn.textContent = name;
            btn.className = `hsl-subtab ${ti === 0 ? 'active' : ''}`;
            btn.addEventListener('click', () => {
                subTabs.querySelectorAll('.hsl-subtab').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                panel.querySelectorAll('.hsl-group').forEach((g, gi) => {
                    g.style.display = gi === ti ? 'block' : 'none';
                });
            });
            subTabs.appendChild(btn);
        });
        panel.appendChild(subTabs);

        const categories = ['hslHue', 'hslSat', 'hslLum'];
        categories.forEach((cat, ci) => {
            const group = document.createElement('div');
            group.className = 'hsl-group';
            group.style.display = ci === 0 ? 'block' : 'none';

            colors.forEach((color, i) => {
                this._createSlider(group, color, `${cat}_${i}`, -100, 100, 1, 0, cat);
            });

            panel.appendChild(group);
        });
    }

    _buildColorPanel() {
        const panel = document.getElementById('panel-color');
        const zones = ['shadows', 'midtones', 'highlights'];

        zones.forEach(zone => {
            const section = document.createElement('div');
            section.className = 'color-grade-section';

            const title = document.createElement('h4');
            title.textContent = zone.charAt(0).toUpperCase() + zone.slice(1);
            section.appendChild(title);

            const colorRow = document.createElement('div');
            colorRow.className = 'color-grade-row';

            const colorInput = document.createElement('input');
            colorInput.type = 'color';
            colorInput.value = '#808080';
            colorInput.className = 'color-grade-picker';

            const blendSlider = document.createElement('input');
            blendSlider.type = 'range';
            blendSlider.min = 0;
            blendSlider.max = 100;
            blendSlider.value = 0;
            blendSlider.className = 'slider-input color-blend-slider';

            const blendVal = document.createElement('span');
            blendVal.className = 'slider-value';
            blendVal.textContent = '0';

            const updateColorGrade = () => {
                const hex = colorInput.value;
                const r = parseInt(hex.slice(1, 3), 16) / 128;
                const g = parseInt(hex.slice(3, 5), 16) / 128;
                const b = parseInt(hex.slice(5, 7), 16) / 128;
                const blend = parseFloat(blendSlider.value) / 100;
                blendVal.textContent = blendSlider.value;
                this.state.colorGrading[zone] = { r, g, b, blend };
                this._render();
            };

            colorInput.addEventListener('input', updateColorGrade);
            blendSlider.addEventListener('input', updateColorGrade);

            const blendLabel = document.createElement('span');
            blendLabel.className = 'slider-label';
            blendLabel.textContent = 'Blend';

            colorRow.appendChild(colorInput);
            const blendRow = document.createElement('div');
            blendRow.className = 'slider-row';
            const blendHeader = document.createElement('div');
            blendHeader.className = 'slider-header';
            blendHeader.appendChild(blendLabel);
            blendHeader.appendChild(blendVal);
            blendRow.appendChild(blendHeader);
            blendRow.appendChild(blendSlider);

            section.appendChild(colorRow);
            section.appendChild(blendRow);
            panel.appendChild(section);
        });
    }

    _buildDetailPanel() {
        const panel = document.getElementById('panel-detail');
        this._createSlider(panel, 'Sharpening', 'sharpenAmount', 0, 150, 1, 0);
    }

    _buildEffectsPanel() {
        const panel = document.getElementById('panel-effects');
        this._createSlider(panel, 'Vignette Amount', 'vignetteAmount', -100, 100, 1, 0);
        this._createSlider(panel, 'Vignette Midpoint', 'vignetteMidpoint', 0, 100, 1, 50);
        this._createSlider(panel, 'Vignette Feather', 'vignetteFeather', 0, 100, 1, 50);

        const sep = document.createElement('div');
        sep.className = 'panel-separator';
        panel.appendChild(sep);

        this._createSlider(panel, 'Grain Amount', 'grainAmount', 0, 100, 1, 0);
    }

    _buildMaskPanel() {
        const panel = document.getElementById('panel-masks');

        // Mask tools
        const tools = document.createElement('div');
        tools.className = 'mask-tools';

        const addBrush = this._btn('🖌️ Brush', () => this._addMask('brush'));
        const addRadial = this._btn('⭕ Radial', () => this._addMask('radial'));
        const addGradient = this._btn('↕️ Gradient', () => this._addMask('gradient'));
        const addWand = this._btn('🪄 Select', () => this._addMask('wand'));
        tools.appendChild(addBrush);
        tools.appendChild(addRadial);
        tools.appendChild(addGradient);
        tools.appendChild(addWand);
        panel.appendChild(tools);

        // AI segmentation tools
        const aiTools = document.createElement('div');
        aiTools.className = 'mask-tools';
        aiTools.style.marginBottom = '8px';

        const aiSubject = this._btn('🧠 AI Subject', () => this._aiSelectSubject(false));
        const aiBg = this._btn('🧠 AI Background', () => this._aiSelectSubject(true));
        aiTools.appendChild(aiSubject);
        aiTools.appendChild(aiBg);
        panel.appendChild(aiTools);

        const aiStatus = document.createElement('div');
        aiStatus.id = 'ai-status';
        aiStatus.className = 'panel-info';
        aiStatus.style.display = 'none';
        panel.appendChild(aiStatus);

        // Mask list
        const maskList = document.createElement('div');
        maskList.id = 'mask-list';
        maskList.className = 'mask-list';
        panel.appendChild(maskList);

        // Brush settings
        const brushSettings = document.createElement('div');
        brushSettings.id = 'brush-settings';
        brushSettings.className = 'brush-settings';
        brushSettings.style.display = 'none';

        this._createSlider(brushSettings, 'Size', 'brushSize', 5, 300, 1, 50, 'brush');
        this._createSlider(brushSettings, 'Feather', 'brushFeather', 0, 100, 1, 50, 'brush');
        this._createSlider(brushSettings, 'Flow', 'brushFlow', 1, 100, 1, 80, 'brush');

        const eraseBtn = this._btn('Toggle Erase', () => {
            this.maskEngine.eraseMode = !this.maskEngine.eraseMode;
            eraseBtn.classList.toggle('active', this.maskEngine.eraseMode);
        });
        eraseBtn.className = 'btn btn-small';
        brushSettings.appendChild(eraseBtn);

        const invertBtn = this._btn('Invert Mask', () => {
            const mask = this.maskEngine.getActiveMask();
            if (mask) { mask.inverted = !mask.inverted; this._render(); }
        });
        invertBtn.className = 'btn btn-small';
        brushSettings.appendChild(invertBtn);

        panel.appendChild(brushSettings);

        // Wand settings
        const wandSettings = document.createElement('div');
        wandSettings.id = 'wand-settings';
        wandSettings.style.display = 'none';

        this._createSlider(wandSettings, 'Tolerance', 'wandTolerance', 1, 100, 1, 32, 'wand');

        const contiguousBtn = this._btn('Contiguous', () => {
            this.maskEngine.wandContiguous = !this.maskEngine.wandContiguous;
            contiguousBtn.classList.toggle('active', this.maskEngine.wandContiguous);
            contiguousBtn.textContent = this.maskEngine.wandContiguous ? 'Contiguous ✓' : 'All Similar';
        });
        contiguousBtn.className = 'btn btn-sm btn-outline active';
        wandSettings.appendChild(contiguousBtn);

        const wandEraseBtn = this._btn('Subtract Mode', () => {
            this.maskEngine.eraseMode = !this.maskEngine.eraseMode;
            wandEraseBtn.classList.toggle('active', this.maskEngine.eraseMode);
        });
        wandEraseBtn.className = 'btn btn-sm btn-outline';
        wandSettings.appendChild(wandEraseBtn);

        const wandInvertBtn = this._btn('Invert Mask', () => {
            const mask = this.maskEngine.getActiveMask();
            if (mask) { mask.inverted = !mask.inverted; this._render(); }
        });
        wandInvertBtn.className = 'btn btn-sm btn-outline';
        wandSettings.appendChild(wandInvertBtn);

        const wandInfo = document.createElement('p');
        wandInfo.className = 'panel-info';
        wandInfo.textContent = 'Click to select. Shift+click to add. Toggle Subtract to remove areas.';
        wandSettings.appendChild(wandInfo);

        panel.appendChild(wandSettings);

        // Mask adjustments
        const maskAdj = document.createElement('div');
        maskAdj.id = 'mask-adjustments';
        maskAdj.className = 'mask-adjustments';
        maskAdj.style.display = 'none';

        const maskTitle = document.createElement('h4');
        maskTitle.textContent = 'Mask Adjustments';
        maskAdj.appendChild(maskTitle);

        const maskSliders = [
            ['Exposure', 'mask_exposure', -5, 5, 0.01, 0],
            ['Contrast', 'mask_contrast', -100, 100, 1, 0],
            ['Highlights', 'mask_highlights', -100, 100, 1, 0],
            ['Shadows', 'mask_shadows', -100, 100, 1, 0],
            ['Temperature', 'mask_temperature', -100, 100, 1, 0],
            ['Tint', 'mask_tint', -100, 100, 1, 0],
            ['Saturation', 'mask_saturation', -100, 100, 1, 0],
            ['Clarity', 'mask_clarity', -100, 100, 1, 0],
        ];
        maskSliders.forEach(([l, k, mn, mx, s, d]) => this._createSlider(maskAdj, l, k, mn, mx, s, d, 'mask'));
        panel.appendChild(maskAdj);

        // Delete mask button
        const deleteBtn = this._btn('🗑️ Delete Mask', () => {
            if (this.maskEngine.activeMaskIndex >= 0) {
                this.maskEngine.deleteMask(this.maskEngine.activeMaskIndex);
                this._updateMaskList();
                if (this.maskEngine.masks.length === 0) this._exitMaskMode();
                this._render();
            }
        });
        deleteBtn.className = 'btn btn-small btn-danger';
        deleteBtn.id = 'delete-mask-btn';
        deleteBtn.style.display = 'none';
        panel.appendChild(deleteBtn);

        // Toggle mask overlay visibility
        const toggleOverlay = this._btn('👁 Toggle Overlay', () => {
            this.showMaskOverlay = !this.showMaskOverlay;
            const overlay = document.getElementById('mask-overlay');
            if (!this.showMaskOverlay && overlay) overlay.style.display = 'none';
            else if (this.showMaskOverlay) this._renderMaskOverlay();
            toggleOverlay.classList.toggle('active', this.showMaskOverlay);
        });
        toggleOverlay.className = 'btn btn-small active';
        toggleOverlay.id = 'mask-toggle-overlay';
        toggleOverlay.style.display = 'none';
        panel.appendChild(toggleOverlay);

        // Done button - exit mask editing mode
        const doneBtn = this._btn('✅ Done Masking', () => {
            this._exitMaskMode();
        });
        doneBtn.className = 'btn btn-small btn-primary';
        doneBtn.id = 'mask-done-btn';
        doneBtn.style.display = 'none';
        panel.appendChild(doneBtn);
    }

    _addMask(type) {
        if (!this.image) return;
        this.maskEngine.createMask(type);
        this.maskMode = true;
        this.showMaskOverlay = true;
        this._updateMaskList();
        this._syncMaskSliders();

        const brushSettings = document.getElementById('brush-settings');
        brushSettings.style.display = type === 'brush' ? 'block' : 'none';
        document.getElementById('wand-settings').style.display = type === 'wand' ? 'block' : 'none';
        document.getElementById('mask-adjustments').style.display = 'block';
        document.getElementById('delete-mask-btn').style.display = 'block';
        document.getElementById('mask-done-btn').style.display = 'block';
        document.getElementById('mask-toggle-overlay').style.display = '';

        document.getElementById('canvas-container').classList.add('mask-mode');
        if (type === 'brush' || type === 'wand') {
            document.getElementById('main-canvas').style.cursor = 'crosshair';
        }
    }

    _exitMaskMode() {
        this.maskMode = false;
        this.showMaskOverlay = false;
        document.getElementById('canvas-container').classList.remove('mask-mode');
        document.getElementById('main-canvas').style.cursor = 'default';

        // Hide mask overlay
        const overlay = document.getElementById('mask-overlay');
        if (overlay) overlay.style.display = 'none';

        // Hide brush cursor
        const cursor = document.getElementById('brush-cursor');
        if (cursor) cursor.style.display = 'none';
    }

    _updateMaskList() {
        const list = document.getElementById('mask-list');
        list.innerHTML = '';
        this.maskEngine.masks.forEach((mask, i) => {
            const item = document.createElement('div');
            item.className = `mask-item ${i === this.maskEngine.activeMaskIndex ? 'active' : ''}`;
            item.textContent = `${mask.type.charAt(0).toUpperCase() + mask.type.slice(1)} Mask ${i + 1}`;
            item.addEventListener('click', () => {
                this.maskEngine.activeMaskIndex = i;
                this.maskMode = true;
                this.showMaskOverlay = true;
                this._updateMaskList();
                this._syncMaskSliders();
                document.getElementById('mask-adjustments').style.display = 'block';
                document.getElementById('delete-mask-btn').style.display = 'block';
                document.getElementById('mask-done-btn').style.display = 'block';
                document.getElementById('mask-toggle-overlay').style.display = '';
                document.getElementById('brush-settings').style.display = mask.type === 'brush' ? 'block' : 'none';
                document.getElementById('wand-settings').style.display = mask.type === 'wand' ? 'block' : 'none';
                document.getElementById('canvas-container').classList.add('mask-mode');
                if (this.showMaskOverlay) this._renderMaskOverlay();
                this._render();
            });
            list.appendChild(item);
        });
    }

    _syncMaskSliders() {
        const mask = this.maskEngine.getActiveMask();
        const adj = mask ? mask.adjustments : {};
        const maskKeys = ['exposure', 'contrast', 'highlights', 'shadows', 'temperature', 'tint', 'saturation', 'clarity'];
        for (const key of maskKeys) {
            const sliderKey = 'mask_' + key;
            const slider = this.sliders[sliderKey];
            if (slider) {
                const val = adj[key] || 0;
                slider.input.value = val;
                slider.val.textContent = this._formatVal(val, parseFloat(slider.input.step));
            }
        }
    }

    _buildPresets() {
        // Build presets for both desktop sidebar and mobile panel
        const grids = [document.getElementById('presets-list'), document.getElementById('presets-list-mobile')];
        for (const grid of grids) {
            if (!grid) continue;
            PRESETS.forEach(preset => {
                const card = document.createElement('div');
                card.className = 'preset-card';
                card.innerHTML = `<span class="preset-icon">${preset.icon}</span><span class="preset-name">${preset.name}</span>`;
                card.addEventListener('click', () => this._applyPreset(preset));
                grid.appendChild(card);
            });
        }
    }

    _btn(text, onClick) {
        const btn = document.createElement('button');
        btn.textContent = text;
        btn.className = 'btn';
        btn.addEventListener('click', onClick);
        return btn;
    }

    // ======================== Events ========================

    _bindEvents() {
        // File import
        document.getElementById('btn-import').addEventListener('click', () => {
            document.getElementById('file-input').click();
        });
        document.getElementById('file-input').addEventListener('change', (e) => {
            if (e.target.files[0]) {
                this._loadFile(e.target.files[0]);
                if (window.library) window.library.addFiles(Array.from(e.target.files));
            }
        });

        // Drag & drop
        const dropZone = document.getElementById('drop-zone');
        const container = document.getElementById('canvas-container');

        // Tap drop zone to open file picker
        dropZone.addEventListener('click', () => {
            document.getElementById('file-input').click();
        });

        ['dragenter', 'dragover'].forEach(evt => {
            container.addEventListener(evt, (e) => {
                e.preventDefault();
                dropZone.classList.add('drag-over');
            });
        });
        ['dragleave', 'drop'].forEach(evt => {
            container.addEventListener(evt, (e) => {
                e.preventDefault();
                dropZone.classList.remove('drag-over');
            });
        });
        container.addEventListener('drop', (e) => {
            const file = e.dataTransfer.files[0];
            if (file && file.type.startsWith('image/')) this._loadFile(file);
        });

        // Toolbar buttons
        document.getElementById('btn-undo').addEventListener('click', () => this._undo());
        document.getElementById('btn-redo').addEventListener('click', () => this._redo());
        document.getElementById('btn-reset').addEventListener('click', () => this._reset());
        document.getElementById('btn-export').addEventListener('click', () => this._showExportModal());
        document.getElementById('btn-auto').addEventListener('click', () => this._autoEdit());

        // Before/After
        const baBtn = document.getElementById('btn-before-after');
        baBtn.addEventListener('mousedown', () => { this.showingOriginal = true; this._render(); });
        baBtn.addEventListener('mouseup', () => { this.showingOriginal = false; this._render(); });
        baBtn.addEventListener('mouseleave', () => { if (this.showingOriginal) { this.showingOriginal = false; this._render(); } });
        baBtn.addEventListener('touchstart', (e) => { e.preventDefault(); this.showingOriginal = true; this._render(); });
        baBtn.addEventListener('touchend', () => { this.showingOriginal = false; this._render(); });

        // Canvas interactions (for masks)
        const canvas = document.getElementById('main-canvas');
        canvas.addEventListener('mousedown', (e) => this._canvasPointerDown(e));
        canvas.addEventListener('mousemove', (e) => this._canvasPointerMove(e));
        canvas.addEventListener('mouseup', () => this._canvasPointerUp());
        canvas.addEventListener('touchstart', (e) => { e.preventDefault(); this._canvasPointerDown(e.touches[0]); }, { passive: false });
        canvas.addEventListener('touchmove', (e) => { e.preventDefault(); this._canvasPointerMove(e.touches[0]); }, { passive: false });
        canvas.addEventListener('touchend', () => this._canvasPointerUp());

        // Export modal
        document.getElementById('export-cancel').addEventListener('click', () => this._hideExportModal());
        document.getElementById('export-confirm').addEventListener('click', () => this._doExport());
        document.getElementById('export-format').addEventListener('change', (e) => {
            const isPng = e.target.value === 'png' || e.target.value === 'tiff-png';
            document.getElementById('quality-row').style.display = isPng ? 'none' : 'flex';
        });
        document.getElementById('export-scale').addEventListener('change', () => this._updateExportInfo());
        document.getElementById('export-dpi').addEventListener('change', () => this._updateExportInfo());
        document.getElementById('calc-scale-btn').addEventListener('click', () => this._calcScaleForPrint());

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey || e.metaKey) {
                if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); this._undo(); }
                if ((e.key === 'z' && e.shiftKey) || e.key === 'y') { e.preventDefault(); this._redo(); }
                if (e.key === 'e') { e.preventDefault(); this._showExportModal(); }
            }
            if (e.key === '\\') { this.showingOriginal = true; this._render(); }
        });
        document.addEventListener('keyup', (e) => {
            if (e.key === '\\') { this.showingOriginal = false; this._render(); }
        });

        // Close mobile panel
        document.getElementById('close-sidebar')?.addEventListener('click', () => {
            document.querySelector('.sidebar-right').classList.remove('mobile-open');
            document.getElementById('mobile-backdrop')?.classList.remove('visible');
        });

        // Mobile backdrop: tap outside panel to close
        const backdrop = document.createElement('div');
        backdrop.id = 'mobile-backdrop';
        backdrop.className = 'mobile-backdrop';
        document.body.appendChild(backdrop);
        backdrop.addEventListener('click', () => {
            document.querySelector('.sidebar-right').classList.remove('mobile-open');
            backdrop.classList.remove('visible');
        });

        // Resizable sidebar
        this._initResizeHandle();

        // Presets sidebar toggle
        document.getElementById('toggle-presets')?.addEventListener('click', () => {
            document.getElementById('sidebar-left').classList.toggle('collapsed');
            setTimeout(() => this._fitCanvas(), 250);
        });

        // Window resize
        window.addEventListener('resize', () => this._fitCanvas());
    }

    _canvasToImage(e) {
        const canvas = document.getElementById('main-canvas');
        const rect = canvas.getBoundingClientRect();
        const scaleX = this.imageWidth / rect.width;
        const scaleY = this.imageHeight / rect.height;
        return {
            canvasX: e.clientX - rect.left,
            canvasY: e.clientY - rect.top,
            imgX: (e.clientX - rect.left) * scaleX,
            imgY: (e.clientY - rect.top) * scaleY,
        };
    }

    _canvasPointerDown(e) {
        if (!this.maskMode || !this.image) return;
        const pos = this._canvasToImage(e);
        this.maskEngine.handlePointerDown(pos.canvasX, pos.canvasY, pos.imgX, pos.imgY, e.shiftKey);
        // For wand: immediately render after click
        if (this.maskEngine.tool === 'wand') {
            if (this.showMaskOverlay) this._renderMaskOverlay();
            this._render();
            this._pushHistory();
        }
    }

    _canvasPointerMove(e) {
        if (!this.maskMode || !this.image) return;
        const pos = this._canvasToImage(e);
        this.maskEngine.handlePointerMove(pos.canvasX, pos.canvasY, pos.imgX, pos.imgY);
        if (this.maskEngine.isDrawing || this.maskEngine._creating) {
            if (this.showMaskOverlay) this._renderMaskOverlay();
            this._render();
        }

        // Update brush cursor
        if (this.maskEngine.tool === 'brush') {
            const canvas = document.getElementById('main-canvas');
            const rect = canvas.getBoundingClientRect();
            const scaleX = rect.width / this.imageWidth;
            const cursorSize = this.maskEngine.brushSize * scaleX;
            this._updateBrushCursor(pos.canvasX, pos.canvasY, cursorSize);
        }
    }

    _canvasPointerUp() {
        if (!this.maskMode) return;
        this.maskEngine.handlePointerUp();
        if (this.showMaskOverlay) this._renderMaskOverlay();
        this._render();
        this._pushHistory();
    }

    _updateBrushCursor(x, y, size) {
        let cursor = document.getElementById('brush-cursor');
        if (!cursor) {
            cursor = document.createElement('div');
            cursor.id = 'brush-cursor';
            document.getElementById('canvas-container').appendChild(cursor);
        }
        cursor.style.display = 'block';
        cursor.style.width = size + 'px';
        cursor.style.height = size + 'px';
        cursor.style.left = (x - size / 2) + 'px';
        cursor.style.top = (y - size / 2) + 'px';
    }

    // ======================== File I/O ========================

    _loadFile(file) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    this.image = img;
                    this.imageWidth = img.naturalWidth;
                    this.imageHeight = img.naturalHeight;

                    document.getElementById('drop-zone').style.display = 'none';
                    document.getElementById('main-canvas').style.display = 'block';

                    document.querySelectorAll('.toolbar button').forEach(b => b.disabled = false);

                    this.glEngine.loadImage(img);
                    this._fitCanvas();
                    this._reset();
                    this._render();

                    document.querySelector('.editor-layout').classList.add('has-image');
                    resolve();
                };
                img.src = e.target.result;
            };
            reader.readAsDataURL(file);
        });
    }

    _fitCanvas() {
        if (!this.image || !this.glEngine) return;
        const container = document.getElementById('canvas-container');
        const canvas = document.getElementById('main-canvas');
        const cw = container.clientWidth - 32;
        const ch = container.clientHeight - 32;
        const iw = this.imageWidth;
        const ih = this.imageHeight;

        if (!cw || !ch || !iw || !ih) return;

        const scale = Math.min(cw / iw, ch / ih);
        canvas.style.width = Math.round(iw * scale) + 'px';
        canvas.style.height = Math.round(ih * scale) + 'px';
    }

    _initResizeHandle() {
        const handle = document.getElementById('resize-handle');
        const sidebar = document.getElementById('sidebar-right');
        if (!handle || !sidebar) return;

        let startX, startWidth, dragging = false;

        const onMouseDown = (e) => {
            e.preventDefault();
            dragging = true;
            startX = e.clientX || (e.touches && e.touches[0].clientX);
            startWidth = sidebar.offsetWidth;
            handle.classList.add('dragging');
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
        };

        const onMouseMove = (e) => {
            if (!dragging) return;
            const clientX = e.clientX || (e.touches && e.touches[0].clientX);
            const delta = startX - clientX;
            const newWidth = Math.max(200, Math.min(600, startWidth + delta));
            sidebar.style.width = newWidth + 'px';
            sidebar.style.flexBasis = newWidth + 'px';
            this._fitCanvas();
        };

        const onMouseUp = () => {
            if (!dragging) return;
            dragging = false;
            handle.classList.remove('dragging');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };

        handle.addEventListener('mousedown', onMouseDown);
        handle.addEventListener('touchstart', (e) => { e.preventDefault(); onMouseDown(e); }, { passive: false });
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('touchmove', onMouseMove, { passive: false });
        window.addEventListener('mouseup', onMouseUp);
        window.addEventListener('touchend', onMouseUp);

        // Double-click to reset width
        handle.addEventListener('dblclick', () => {
            sidebar.style.width = '';
            sidebar.style.flexBasis = '';
            this._fitCanvas();
        });
    }

    // ======================== Render ========================

    _render() {
        if (!this.image || !this.glEngine) return;

        const adj = { ...this.state, showOriginal: this.showingOriginal };
        const lut = this.curveEditor.getLUT();
        this.glEngine.updateCurveLUT(lut);

        // Collect masks with non-zero adjustments
        const masksWithAdj = this.maskEngine.masks.filter(m =>
            m.visible && Object.values(m.adjustments).some(v => v !== 0)
        );

        // Step 1: Render base image (global adjustments only)
        this.glEngine.setAdjustments(adj);
        this.glEngine.render();

        // If showing original, hide overlay and skip mask compositing
        if (this.showingOriginal) {
            this._hideCompositeOverlay();
            this._scheduleHistogramUpdate();
            return;
        }

        if (masksWithAdj.length === 0) {
            this._hideCompositeOverlay();
            this._scheduleHistogramUpdate();
            return;
        }

        // Step 2: Composite masks via 2D canvas
        const glCanvas = document.getElementById('main-canvas');
        const rw = glCanvas.width;
        const rh = glCanvas.height;

        // Read base render into result canvas
        const resultCanvas = document.createElement('canvas');
        resultCanvas.width = rw;
        resultCanvas.height = rh;
        const rCtx = resultCanvas.getContext('2d');
        rCtx.drawImage(glCanvas, 0, 0);

        // For each mask: render with global+mask adjustments merged, then composite
        for (const mask of masksWithAdj) {
            // Merge global + mask adjustments
            const mergedAdj = { ...adj };
            for (const [key, val] of Object.entries(mask.adjustments)) {
                if (typeof mergedAdj[key] === 'number') {
                    mergedAdj[key] = (mergedAdj[key] || 0) + val;
                }
            }
            mergedAdj.showOriginal = false;

            // Render with merged adjustments
            this.glEngine.setAdjustments(mergedAdj);
            this.glEngine.render();

            // Get mask selection scaled to render size
            const maskSrc = mask.inverted ? this._invertMaskCanvas(mask.canvas) : mask.canvas;
            const maskScaled = document.createElement('canvas');
            maskScaled.width = rw;
            maskScaled.height = rh;
            const mCtx = maskScaled.getContext('2d');
            mCtx.drawImage(maskSrc, 0, 0, rw, rh);

            // Create masked version: draw adjusted image, then set alpha from mask
            const layerCanvas = document.createElement('canvas');
            layerCanvas.width = rw;
            layerCanvas.height = rh;
            const lCtx = layerCanvas.getContext('2d');
            lCtx.drawImage(glCanvas, 0, 0);

            const layerData = lCtx.getImageData(0, 0, rw, rh);
            const maskData = mCtx.getImageData(0, 0, rw, rh).data;
            const ld = layerData.data;
            for (let i = 0; i < rw * rh; i++) {
                ld[i * 4 + 3] = maskData[i * 4]; // mask R channel → alpha
            }
            lCtx.putImageData(layerData, 0, 0);

            // Composite onto result
            rCtx.drawImage(layerCanvas, 0, 0);
        }

        // Restore global adjustments for the visible GL canvas
        this.glEngine.setAdjustments(adj);
        this.glEngine.render();

        // Show composite overlay
        this._compositeToDisplay(resultCanvas);
        this._scheduleHistogramUpdate();
    }

    _compositeToDisplay(resultCanvas) {
        let overlay = document.getElementById('composite-overlay');
        if (!overlay) {
            overlay = document.createElement('canvas');
            overlay.id = 'composite-overlay';
            overlay.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);pointer-events:none;';
            document.getElementById('canvas-container').appendChild(overlay);
        }
        const glCanvas = document.getElementById('main-canvas');
        overlay.width = resultCanvas.width;
        overlay.height = resultCanvas.height;
        overlay.style.width = glCanvas.style.width;
        overlay.style.height = glCanvas.style.height;
        overlay.style.display = 'block';
        const ctx = overlay.getContext('2d');
        ctx.clearRect(0, 0, overlay.width, overlay.height);
        ctx.drawImage(resultCanvas, 0, 0);
    }

    _hideCompositeOverlay() {
        const overlay = document.getElementById('composite-overlay');
        if (overlay) overlay.style.display = 'none';
    }

    _invertMaskCanvas(canvas) {
        const w = canvas.width, h = canvas.height;
        const tmp = document.createElement('canvas');
        tmp.width = w;
        tmp.height = h;
        const ctx = tmp.getContext('2d');
        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = 'difference';
        ctx.drawImage(canvas, 0, 0);
        ctx.globalCompositeOperation = 'source-over';
        return tmp;
    }

    _histogramTimer = null;
    _scheduleHistogramUpdate() {
        if (this._histogramTimer) return;
        this._histogramTimer = setTimeout(() => {
            this._histogramTimer = null;
            try {
                // Sample at reduced resolution for performance
                const maxDim = 400;
                const scale = Math.min(1, maxDim / Math.max(this.imageWidth, this.imageHeight));
                const sw = Math.round(this.imageWidth * scale);
                const sh = Math.round(this.imageHeight * scale);
                const tmp = document.createElement('canvas');
                tmp.width = sw;
                tmp.height = sh;
                const ctx = tmp.getContext('2d');
                ctx.drawImage(document.getElementById('main-canvas'), 0, 0, sw, sh);
                const imgData = ctx.getImageData(0, 0, sw, sh);
                this.histogram.update(imgData);
            } catch (e) { /* ignore */ }
        }, 200);
    }

    _renderMaskOverlay() {
        const overlay = document.getElementById('mask-overlay');
        if (!overlay) return;
        const mask = this.maskEngine.getActiveMask();
        if (!mask) { overlay.style.display = 'none'; return; }

        const canvas = document.getElementById('main-canvas');
        const rect = canvas.getBoundingClientRect();
        const maskOverlay = this.maskEngine.getMaskOverlay(Math.round(rect.width), Math.round(rect.height));
        if (maskOverlay) {
            const ctx = overlay.getContext('2d');
            overlay.width = rect.width;
            overlay.height = rect.height;
            overlay.style.display = 'block';
            ctx.clearRect(0, 0, overlay.width, overlay.height);
            ctx.drawImage(maskOverlay, 0, 0);
        }
    }

    // ======================== History ========================

    _pushHistory() {
        const snap = JSON.stringify(this.state);
        // Don't push if same as current
        if (this.historyIndex >= 0 && this.history[this.historyIndex] === snap) return;

        this.history = this.history.slice(0, this.historyIndex + 1);
        this.history.push(snap);
        this.historyIndex = this.history.length - 1;

        // Limit history
        if (this.history.length > 100) {
            this.history.shift();
            this.historyIndex--;
        }

        this._updateHistoryButtons();
    }

    _undo() {
        if (this.historyIndex <= 0) return;
        this.historyIndex--;
        this.state = JSON.parse(this.history[this.historyIndex]);
        this._syncSlidersFromState();
        this._render();
        this._updateHistoryButtons();
    }

    _redo() {
        if (this.historyIndex >= this.history.length - 1) return;
        this.historyIndex++;
        this.state = JSON.parse(this.history[this.historyIndex]);
        this._syncSlidersFromState();
        this._render();
        this._updateHistoryButtons();
    }

    _updateHistoryButtons() {
        document.getElementById('btn-undo').disabled = this.historyIndex <= 0;
        document.getElementById('btn-redo').disabled = this.historyIndex >= this.history.length - 1;
    }

    _syncSlidersFromState() {
        for (const [key, slider] of Object.entries(this.sliders)) {
            if (key.startsWith('hslHue_') || key.startsWith('hslSat_') || key.startsWith('hslLum_')) {
                const parts = key.split('_');
                const cat = parts[0];
                const idx = parseInt(parts[1]);
                const val = this.state[cat]?.[idx] ?? slider.defaultVal;
                slider.input.value = val;
                slider.val.textContent = this._formatVal(val, parseFloat(slider.input.step));
            } else if (this.state[key] !== undefined) {
                slider.input.value = this.state[key];
                slider.val.textContent = this._formatVal(this.state[key], parseFloat(slider.input.step));
            }
        }
    }

    // ======================== Actions ========================

    _reset() {
        this.state = this._defaultState();
        this.maskEngine.masks = [];
        this.maskEngine.activeMaskIndex = -1;
        this.maskMode = false;
        this.curveEditor.reset();

        this._syncSlidersFromState();
        this.history = [JSON.stringify(this.state)];
        this.historyIndex = 0;
        this._updateHistoryButtons();
        this._updateMaskList();

        document.getElementById('mask-adjustments').style.display = 'none';
        document.getElementById('brush-settings').style.display = 'none';
        document.getElementById('wand-settings').style.display = 'none';
        document.getElementById('delete-mask-btn').style.display = 'none';
        document.getElementById('mask-done-btn').style.display = 'none';
        document.getElementById('mask-toggle-overlay').style.display = 'none';
        document.getElementById('canvas-container').classList.remove('mask-mode');
        document.getElementById('main-canvas').style.cursor = 'default';
        const overlay = document.getElementById('mask-overlay');
        if (overlay) overlay.style.display = 'none';
        const cursor = document.getElementById('brush-cursor');
        if (cursor) cursor.style.display = 'none';

        this._hideCompositeOverlay();
        this._render();
    }

    _autoEdit() {
        if (!this.image) return;

        // Downsample for analysis performance
        const maxDim = 600;
        const scale = Math.min(1, maxDim / Math.max(this.imageWidth, this.imageHeight));
        const sw = Math.round(this.imageWidth * scale);
        const sh = Math.round(this.imageHeight * scale);
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = sw;
        tempCanvas.height = sh;
        const ctx = tempCanvas.getContext('2d');
        ctx.drawImage(this.image, 0, 0, sw, sh);
        const imageData = ctx.getImageData(0, 0, sw, sh);

        const auto = AutoEdit.autoAll(imageData);

        // Apply auto adjustments
        for (const [key, value] of Object.entries(auto)) {
            if (this.state[key] !== undefined) {
                this.state[key] = value;
            }
        }

        // Also hide composite overlay so re-render shows fresh result
        this._hideCompositeOverlay();
        this._syncSlidersFromState();
        this._pushHistory();
        this._render();
    }

    _applyPreset(preset) {
        if (!this.image) return;

        // Reset first
        this.state = this._defaultState();

        // Apply preset adjustments
        for (const [key, value] of Object.entries(preset.adjustments)) {
            if (this.state[key] !== undefined) {
                this.state[key] = value;
            }
        }

        this._syncSlidersFromState();
        this._pushHistory();
        this._render();
    }

    // ======================== AI Segmentation ========================

    async _aiSelectSubject(invert) {
        if (!this.image) return;
        if (this._aiRunning) return;
        this._aiRunning = true;
        const statusEl = document.getElementById('ai-status');
        statusEl.style.display = 'block';
        statusEl.style.color = 'var(--accent)';

        try {
            // Load Transformers.js (promise cached to prevent double downloads)
            if (!this._transformersPromise) {
                statusEl.textContent = '⏳ Loading AI engine...';
                this._transformersPromise = import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3');
            }
            window._transformers = await this._transformersPromise;

            // Create pipeline (promise cached)
            if (!this._segPipelinePromise) {
                statusEl.textContent = '⏳ Downloading AI model (~40MB, cached after first use)...';
                const { pipeline } = window._transformers;
                this._segPipelinePromise = pipeline('background-removal', 'briaai/RMBG-1.4', { dtype: 'fp32' });
            }
            this._segPipeline = await this._segPipelinePromise;

            statusEl.textContent = '⏳ Analyzing image...';
            await new Promise(r => setTimeout(r, 50));

            // Prepare image blob
            const maxDim = 1024;
            let sw = this.imageWidth, sh = this.imageHeight;
            if (sw > maxDim || sh > maxDim) {
                const s = maxDim / Math.max(sw, sh);
                sw = Math.round(sw * s);
                sh = Math.round(sh * s);
            }
            const tmpCanvas = document.createElement('canvas');
            tmpCanvas.width = sw;
            tmpCanvas.height = sh;
            tmpCanvas.getContext('2d').drawImage(this.image, 0, 0, sw, sh);
            const blob = await new Promise(r => tmpCanvas.toBlob(r, 'image/png'));
            const url = URL.createObjectURL(blob);

            // Run model
            const result = await this._segPipeline(url);
            URL.revokeObjectURL(url);

            // Extract: result is an array with one RawImage
            const img = Array.isArray(result) ? result[0] : result;

            // Draw to canvas to get RGBA pixels
            let rawCanvas;
            if (img.toCanvas) {
                rawCanvas = img.toCanvas();
            } else if (img.width && img.data) {
                rawCanvas = document.createElement('canvas');
                rawCanvas.width = img.width;
                rawCanvas.height = img.height;
                const ctx = rawCanvas.getContext('2d');
                const id = ctx.createImageData(img.width, img.height);
                const ch = img.channels || 4;
                if (ch === 4) {
                    id.data.set(new Uint8ClampedArray(img.data.buffer || img.data));
                } else {
                    for (let i = 0; i < img.width * img.height; i++) {
                        for (let c = 0; c < Math.min(ch, 3); c++) id.data[i*4+c] = img.data[i*ch+c];
                        id.data[i*4+3] = ch >= 4 ? img.data[i*ch+3] : 255;
                    }
                }
                ctx.putImageData(id, 0, 0);
            } else {
                throw new Error('Cannot read model output');
            }

            const rw = rawCanvas.width, rh = rawCanvas.height;
            const rawCtx = rawCanvas.getContext('2d');
            const rawData = rawCtx.getImageData(0, 0, rw, rh).data;

            // Detect if mask is in alpha or RGB
            let useAlpha = false;
            for (let i = 0; i < Math.min(rw * rh, 500); i++) {
                if (rawData[i * 4 + 3] < 250) { useAlpha = true; break; }
            }

            // Build grayscale mask canvas
            const maskCanvas = document.createElement('canvas');
            maskCanvas.width = rw;
            maskCanvas.height = rh;
            const maskCtx = maskCanvas.getContext('2d');
            const maskImgData = maskCtx.createImageData(rw, rh);

            for (let i = 0; i < rw * rh; i++) {
                let val = useAlpha ? rawData[i*4+3] : Math.round(0.299*rawData[i*4] + 0.587*rawData[i*4+1] + 0.114*rawData[i*4+2]);
                if (invert) val = 255 - val;
                maskImgData.data[i*4] = val;
                maskImgData.data[i*4+1] = val;
                maskImgData.data[i*4+2] = val;
                maskImgData.data[i*4+3] = 255;
            }
            maskCtx.putImageData(maskImgData, 0, 0);

            // Create mask and draw AI result onto it
            this.maskEngine.createMask('wand');
            const newMask = this.maskEngine.getActiveMask();
            if (newMask) {
                newMask.ctx.drawImage(maskCanvas, 0, 0, newMask.canvas.width, newMask.canvas.height);
            }

            // Enter mask editing mode
            this.maskMode = true;
            this.showMaskOverlay = true;
            this._updateMaskList();
            this._syncMaskSliders();
            document.getElementById('wand-settings').style.display = 'none';
            document.getElementById('brush-settings').style.display = 'none';
            document.getElementById('mask-adjustments').style.display = 'block';
            document.getElementById('delete-mask-btn').style.display = 'block';
            document.getElementById('mask-done-btn').style.display = 'block';
            document.getElementById('mask-toggle-overlay').style.display = '';
            document.getElementById('canvas-container').classList.add('mask-mode');

            if (this.showMaskOverlay) this._renderMaskOverlay();
            this._render();
            this._pushHistory();

            statusEl.textContent = invert ? '✅ Background selected' : '✅ Subject selected';
            statusEl.style.color = '#22c55e';
            setTimeout(() => { statusEl.style.display = 'none'; }, 3000);
        } catch (e) {
            console.error('AI segmentation error:', e);
            statusEl.textContent = '❌ ' + (e.message || 'AI model failed');
            statusEl.style.color = '#ef4444';
            setTimeout(() => { statusEl.style.display = 'none'; }, 5000);
        } finally {
            this._aiRunning = false;
        }
    }

    _showExportModal() {
        if (!this.image) return;
        document.getElementById('export-modal').classList.add('visible');
        // Small delay to ensure DOM is rendered before calculating
        requestAnimationFrame(() => this._updateExportInfo());
    }

    _hideExportModal() {
        document.getElementById('export-modal').classList.remove('visible');
    }

    _updateExportInfo() {
        const w0 = this.imageWidth || 0;
        const h0 = this.imageHeight || 0;
        if (!w0 || !h0) {
            document.getElementById('export-dimensions').textContent = 'No image loaded';
            document.getElementById('export-print-size').textContent = '—';
            return;
        }
        const scaleVal = document.getElementById('export-scale').value;
        const scale = scaleVal.startsWith('ai') ? parseInt(scaleVal.replace('ai', '')) : (parseFloat(scaleVal) || 1);
        const dpi = parseInt(document.getElementById('export-dpi').value) || 300;
        const w = Math.round(w0 * scale);
        const h = Math.round(h0 * scale);

        document.getElementById('export-dimensions').textContent = w.toLocaleString() + ' × ' + h.toLocaleString() + ' px';

        const printW = w / dpi;
        const printH = h / dpi;
        const cmW = (printW * 2.54).toFixed(1);
        const cmH = (printH * 2.54).toFixed(1);
        document.getElementById('export-print-size').textContent =
            printW.toFixed(1) + ' × ' + printH.toFixed(1) + ' in  (' + cmW + ' × ' + cmH + ' cm)';

        // Show/hide AI upscale note
        const noteEl = document.getElementById('ai-upscale-note');
        if (noteEl) noteEl.style.display = scaleVal.startsWith('ai') ? 'block' : 'none';
    }

    _calcScaleForPrint() {
        if (!this.imageWidth || !this.imageHeight) return;
        const tw = parseFloat(document.getElementById('target-width').value);
        const th = parseFloat(document.getElementById('target-height').value);
        const dpi = parseInt(document.getElementById('export-dpi').value) || 300;

        if (!tw && !th) {
            alert('Enter a target width or height in inches.');
            return;
        }

        // Calculate required scale
        let needed = 1;
        if (tw) needed = Math.max(needed, (tw * dpi) / this.imageWidth);
        if (th) needed = Math.max(needed, (th * dpi) / this.imageHeight);

        // Pick the smallest available scale option >= needed
        const scaleSelect = document.getElementById('export-scale');
        let bestIdx = scaleSelect.options.length - 1;
        for (let i = 0; i < scaleSelect.options.length; i++) {
            const val = scaleSelect.options[i].value;
            const num = val.startsWith('ai') ? parseInt(val.replace('ai', '')) : parseFloat(val);
            if (num >= needed) {
                bestIdx = i;
                break;
            }
        }
        scaleSelect.selectedIndex = bestIdx;
        this._updateExportInfo();

        // Show result feedback
        const actualScale = parseFloat(scaleSelect.value);
        const actualW = Math.round(this.imageWidth * actualScale);
        const actualH = Math.round(this.imageHeight * actualScale);
        const printResult = document.getElementById('export-print-size');
        if (actualScale < needed) {
            printResult.style.color = '#f59e0b';
            printResult.textContent += '  ⚠ Max upscale reached';
        } else {
            printResult.style.color = '';
        }
    }

    _doExport() {
        if (this._exporting) return;
        this._exporting = true;
        const btn = document.getElementById('export-confirm');
        btn.disabled = true;
        btn.textContent = 'Exporting...';

        const formatVal = document.getElementById('export-format').value;
        const quality = parseInt(document.getElementById('export-quality').value) / 100;
        const scaleVal = document.getElementById('export-scale').value;

        const format = formatVal === 'tiff-png' ? 'png' : formatVal;
        const mimeType = format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : 'image/jpeg';

        const onBlob = (blob) => {
            this._exporting = false;
            btn.disabled = false;
            btn.textContent = 'Download';
            if (!blob) {
                alert('Export failed — could not generate image.');
                return;
            }
            this._downloadBlob(blob, format);
        };

        const isAI = scaleVal.startsWith('ai');
        const scale = isAI ? parseInt(scaleVal.replace('ai', '')) : (parseFloat(scaleVal) || 1);

        if (isAI) {
            // AI super-resolution export
            this._aiUpscaleExport(scale, mimeType, quality, onBlob, btn);
        } else if (scale === 1) {
            this._render();
            document.getElementById('main-canvas').toBlob(onBlob, mimeType, quality);
        } else {
            this._render();
            const srcCanvas = document.getElementById('main-canvas');
            const outW = Math.round(this.imageWidth * scale);
            const outH = Math.round(this.imageHeight * scale);
            const outCanvas = document.createElement('canvas');
            outCanvas.width = outW;
            outCanvas.height = outH;
            const ctx = outCanvas.getContext('2d');
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(srcCanvas, 0, 0, outW, outH);
            outCanvas.toBlob(onBlob, mimeType, quality);
        }
    }

    async _aiUpscaleExport(scale, mimeType, quality, onBlob, btn) {
        try {
            btn.textContent = '⏳ Loading AI model...';
            console.log('[AI Upscale] Step 1: Loading Transformers.js');

            if (!this._transformersPromise) {
                this._transformersPromise = import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3');
            }
            const transformers = await this._transformersPromise;
            console.log('[AI Upscale] Step 2: Transformers loaded, creating pipeline');

            if (!this._upscalePipeline) {
                btn.textContent = '⏳ Downloading SR model (~5MB)...';
                this._upscalePipeline = await transformers.pipeline(
                    'image-to-image',
                    'Xenova/swin2SR-classical-sr-x2-64',
                    { dtype: 'fp32' }
                );
            }
            console.log('[AI Upscale] Step 3: Pipeline ready');

            this._render();
            const srcCanvas = document.getElementById('main-canvas');

            // Downsize for model (max ~800px per side)
            const maxModelInput = 800;
            let inputCanvas = srcCanvas;
            if (srcCanvas.width > maxModelInput || srcCanvas.height > maxModelInput) {
                const s = maxModelInput / Math.max(srcCanvas.width, srcCanvas.height);
                inputCanvas = document.createElement('canvas');
                inputCanvas.width = Math.round(srcCanvas.width * s);
                inputCanvas.height = Math.round(srcCanvas.height * s);
                const ctx = inputCanvas.getContext('2d');
                ctx.drawImage(srcCanvas, 0, 0, inputCanvas.width, inputCanvas.height);
            }
            console.log('[AI Upscale] Step 4: Input prepared', inputCanvas.width, 'x', inputCanvas.height);

            btn.textContent = '⏳ Upscaling with AI (tile processing)...';
            await new Promise(r => setTimeout(r, 50));

            // Process in tiles — model can only handle small patches
            const tileSize = 128; // input tile size
            const overlap = 8;    // overlap to avoid seam artifacts
            const iw = inputCanvas.width;
            const ih = inputCanvas.height;
            const inputCtx = inputCanvas.getContext('2d');

            // Output canvas at 2× input size
            const resultCanvas = document.createElement('canvas');
            resultCanvas.width = iw * 2;
            resultCanvas.height = ih * 2;
            const outCtx = resultCanvas.getContext('2d');

            const tilesX = Math.ceil(iw / (tileSize - overlap));
            const tilesY = Math.ceil(ih / (tileSize - overlap));
            const totalTiles = tilesX * tilesY;
            let tilesDone = 0;

            console.log('[AI Upscale] Step 5: Processing', totalTiles, 'tiles at', tileSize + 'px');

            for (let ty = 0; ty < tilesY; ty++) {
                for (let tx = 0; tx < tilesX; tx++) {
                    const sx = Math.min(tx * (tileSize - overlap), iw - tileSize);
                    const sy = Math.min(ty * (tileSize - overlap), ih - tileSize);
                    const tw = Math.min(tileSize, iw - sx);
                    const th = Math.min(tileSize, ih - sy);

                    // Extract tile
                    const tileCanvas = document.createElement('canvas');
                    tileCanvas.width = tw;
                    tileCanvas.height = th;
                    tileCanvas.getContext('2d').drawImage(inputCanvas, sx, sy, tw, th, 0, 0, tw, th);
                    const tileUrl = tileCanvas.toDataURL('image/png');

                    // Run model on tile
                    const result = await this._upscalePipeline(tileUrl);
                    const img = Array.isArray(result) ? result[0] : result;

                    // Draw result tile to output (at 2× position)
                    if (img && img.toCanvas) {
                        outCtx.drawImage(img.toCanvas(), 0, 0, tw * 2, th * 2, sx * 2, sy * 2, tw * 2, th * 2);
                    } else if (img && img.width && img.data) {
                        const tc = document.createElement('canvas');
                        tc.width = img.width;
                        tc.height = img.height;
                        const tctx = tc.getContext('2d');
                        const id = tctx.createImageData(img.width, img.height);
                        const ch = img.channels || 3;
                        for (let i = 0; i < img.width * img.height; i++) {
                            for (let c = 0; c < Math.min(ch, 3); c++) id.data[i*4+c] = img.data[i*ch+c];
                            id.data[i*4+3] = 255;
                        }
                        tctx.putImageData(id, 0, 0);
                        outCtx.drawImage(tc, 0, 0, tw * 2, th * 2, sx * 2, sy * 2, tw * 2, th * 2);
                    }

                    tilesDone++;
                    btn.textContent = `⏳ AI Upscaling ${Math.round(tilesDone / totalTiles * 100)}%`;
                    await new Promise(r => setTimeout(r, 10)); // Let UI update
                }
            }

            console.log('[AI Upscale] Step 6: All tiles done, result:', resultCanvas.width, 'x', resultCanvas.height);

            // Scale to final target
            const targetW = Math.round(this.imageWidth * scale);
            const targetH = Math.round(this.imageHeight * scale);
            const finalCanvas = document.createElement('canvas');
            finalCanvas.width = targetW;
            finalCanvas.height = targetH;
            const fCtx = finalCanvas.getContext('2d');
            fCtx.imageSmoothingEnabled = true;
            fCtx.imageSmoothingQuality = 'high';
            fCtx.drawImage(resultCanvas, 0, 0, targetW, targetH);

            console.log('[AI Upscale] Done! Output:', targetW, 'x', targetH);
            finalCanvas.toBlob(onBlob, mimeType, quality);

        } catch (e) {
            console.error('AI upscale full error:', e);
            const msg = (e && e.message) ? e.message : String(e);
            alert('AI upscaling failed: ' + msg + '\nFalling back to bicubic. Check browser console for details.');
            this._render();
            const srcCanvas = document.getElementById('main-canvas');
            const outW = Math.round(this.imageWidth * scale);
            const outH = Math.round(this.imageHeight * scale);
            const outCanvas = document.createElement('canvas');
            outCanvas.width = outW;
            outCanvas.height = outH;
            const ctx = outCanvas.getContext('2d');
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(srcCanvas, 0, 0, outW, outH);
            outCanvas.toBlob(onBlob, mimeType, quality);
        }
    }

    _downloadBlob(blob, format) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `ABEL_photo.${format}`;
        a.click();
        URL.revokeObjectURL(url);
        this._hideExportModal();
    }
}

// ======================== Crop & Straighten Tool ========================
class CropTool {
    constructor(app) {
        this.app = app;
        this.active = false;
        this.rotation = 0;
        this.aspectRatio = null;

        // Crop region in normalized coords (0-1)
        this.cropX = 0;
        this.cropY = 0;
        this.cropW = 1;
        this.cropH = 1;

        this.dragging = null;
        this.dragStart = null;

        this.overlay = document.getElementById('crop-overlay');
        this.overlayCtx = this.overlay.getContext('2d');

        this._buildUI();
        this._bindEvents();
    }

    _buildUI() {
        const ratios = [
            { label: 'Free', value: null },
            { label: '1:1', value: 1 },
            { label: '4:3', value: 4/3 },
            { label: '3:2', value: 3/2 },
            { label: '16:9', value: 16/9 },
            { label: '5:4', value: 5/4 },
            { label: '2:3', value: 2/3 },
            { label: '9:16', value: 9/16 },
        ];

        const container = document.getElementById('crop-ratios');
        ratios.forEach(r => {
            const btn = document.createElement('button');
            btn.className = 'crop-ratio-btn' + (r.value === null ? ' active' : '');
            btn.textContent = r.label;
            btn.addEventListener('click', () => {
                container.querySelectorAll('.crop-ratio-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.setAspectRatio(r.value);
            });
            container.appendChild(btn);
        });

        // Rotation slider
        const row = document.getElementById('crop-rotation-row');
        const header = document.createElement('div');
        header.className = 'slider-header';
        const lbl = document.createElement('span');
        lbl.className = 'slider-label';
        lbl.textContent = 'Angle';
        const val = document.createElement('span');
        val.className = 'slider-value';
        val.textContent = '0°';
        this._rotVal = val;
        header.appendChild(lbl);
        header.appendChild(val);

        const input = document.createElement('input');
        input.type = 'range';
        input.min = -45;
        input.max = 45;
        input.step = 0.1;
        input.value = 0;
        input.className = 'slider-input';
        this._rotSlider = input;

        input.addEventListener('input', () => {
            this.rotation = parseFloat(input.value);
            val.textContent = this.rotation.toFixed(1) + '°';
            this._drawOverlay();
        });
        input.addEventListener('dblclick', () => {
            input.value = 0;
            this.rotation = 0;
            val.textContent = '0°';
            this._drawOverlay();
        });

        row.appendChild(header);
        row.appendChild(input);
    }

    _bindEvents() {
        document.getElementById('crop-apply').addEventListener('click', () => this.apply());
        document.getElementById('crop-cancel').addEventListener('click', () => this.cancel());
        document.getElementById('crop-auto-straighten').addEventListener('click', () => this.autoStraighten());

        this.overlay.addEventListener('mousedown', (e) => this._onPointerDown(e));
        window.addEventListener('mousemove', (e) => this._onPointerMove(e));
        window.addEventListener('mouseup', () => this._onPointerUp());
        this.overlay.addEventListener('touchstart', (e) => { e.preventDefault(); this._onPointerDown(e.touches[0]); }, { passive: false });
        window.addEventListener('touchmove', (e) => { if (this.dragging) this._onPointerMove(e.touches[0]); }, { passive: false });
        window.addEventListener('touchend', () => this._onPointerUp());
    }

    activate() {
        if (!this.app.image) return;
        this.active = true;
        this.rotation = 0;
        this.cropX = 0; this.cropY = 0;
        this.cropW = 1; this.cropH = 1;
        this.aspectRatio = null;
        this._rotSlider.value = 0;
        this._rotVal.textContent = '0°';

        // Reset aspect ratio buttons
        const container = document.getElementById('crop-ratios');
        container.querySelectorAll('.crop-ratio-btn').forEach((b, i) => {
            b.classList.toggle('active', i === 0);
        });

        // Size overlay to match the container
        const canvas = document.getElementById('main-canvas');
        const rect = canvas.getBoundingClientRect();
        const containerEl = document.getElementById('canvas-container');
        const cRect = containerEl.getBoundingClientRect();
        this.overlay.width = cRect.width;
        this.overlay.height = cRect.height;
        this.overlay.classList.add('active');

        this._canvasRect = {
            x: rect.left - cRect.left,
            y: rect.top - cRect.top,
            w: rect.width,
            h: rect.height,
        };

        this._drawOverlay();
    }

    deactivate() {
        this.active = false;
        this.overlay.classList.remove('active');
        document.getElementById('main-canvas').style.transform = '';
    }

    setAspectRatio(ratio) {
        this.aspectRatio = ratio;
        if (ratio !== null) {
            const imgAspect = this.app.imageWidth / this.app.imageHeight;
            let newW = this.cropW;
            let newH = this.cropH;
            const cropAspect = (newW * imgAspect) / newH;

            if (cropAspect > ratio) {
                newW = (ratio * newH) / imgAspect;
            } else {
                newH = (newW * imgAspect) / ratio;
            }

            this.cropX = this.cropX + (this.cropW - newW) / 2;
            this.cropY = this.cropY + (this.cropH - newH) / 2;
            this.cropW = newW;
            this.cropH = newH;
            this._clampCrop();
        }
        this._drawOverlay();
    }

    _clampCrop() {
        this.cropW = Math.max(0.05, Math.min(1, this.cropW));
        this.cropH = Math.max(0.05, Math.min(1, this.cropH));
        this.cropX = Math.max(0, Math.min(1 - this.cropW, this.cropX));
        this.cropY = Math.max(0, Math.min(1 - this.cropH, this.cropY));
    }

    _drawOverlay() {
        if (!this.active) return;
        const ctx = this.overlayCtx;
        const ow = this.overlay.width;
        const oh = this.overlay.height;
        const cr = this._canvasRect;

        ctx.clearRect(0, 0, ow, oh);

        // Apply CSS rotation to the main canvas for live preview
        const mainCanvas = document.getElementById('main-canvas');
        if (Math.abs(this.rotation) > 0.05) {
            mainCanvas.style.transform = `rotate(${this.rotation}deg)`;
        } else {
            mainCanvas.style.transform = '';
        }

        // Dark overlay outside crop
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.fillRect(0, 0, ow, oh);

        // Crop rect in pixel coords
        const cx = cr.x + this.cropX * cr.w;
        const cy = cr.y + this.cropY * cr.h;
        const cw = this.cropW * cr.w;
        const ch = this.cropH * cr.h;

        // Clear the crop area
        ctx.clearRect(cx, cy, cw, ch);

        // Crop border
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(cx, cy, cw, ch);

        // Rule of thirds grid
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.lineWidth = 0.5;
        for (let i = 1; i <= 2; i++) {
            const gx = cx + (cw * i) / 3;
            const gy = cy + (ch * i) / 3;
            ctx.beginPath(); ctx.moveTo(gx, cy); ctx.lineTo(gx, cy + ch); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(cx, gy); ctx.lineTo(cx + cw, gy); ctx.stroke();
        }

        // Corner handles
        const hs = 12;
        ctx.fillStyle = '#fff';
        const corners = [
            [cx, cy], [cx + cw, cy], [cx, cy + ch], [cx + cw, cy + ch]
        ];
        corners.forEach(([hx, hy]) => {
            ctx.fillRect(hx - hs/2, hy - hs/2, hs, hs);
        });

        // Show rotation angle
        if (Math.abs(this.rotation) > 0.1) {
            ctx.save();
            ctx.fillStyle = 'rgba(255,255,255,0.9)';
            ctx.font = 'bold 12px -apple-system, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(this.rotation.toFixed(1) + '°', cx + cw/2, cy - 10);
            ctx.restore();
        }
    }

    _overlayToNorm(clientX, clientY) {
        const rect = this.overlay.getBoundingClientRect();
        const cr = this._canvasRect;
        return {
            nx: (clientX - rect.left - cr.x) / cr.w,
            ny: (clientY - rect.top - cr.y) / cr.h,
        };
    }

    _getHandle(nx, ny) {
        const t = 0.03;
        const cx = this.cropX, cy = this.cropY;
        const cw = this.cropW, ch = this.cropH;

        if (Math.abs(nx - cx) < t && Math.abs(ny - cy) < t) return 'tl';
        if (Math.abs(nx - (cx+cw)) < t && Math.abs(ny - cy) < t) return 'tr';
        if (Math.abs(nx - cx) < t && Math.abs(ny - (cy+ch)) < t) return 'bl';
        if (Math.abs(nx - (cx+cw)) < t && Math.abs(ny - (cy+ch)) < t) return 'br';

        if (Math.abs(ny - cy) < t && nx > cx && nx < cx+cw) return 't';
        if (Math.abs(ny - (cy+ch)) < t && nx > cx && nx < cx+cw) return 'b';
        if (Math.abs(nx - cx) < t && ny > cy && ny < cy+ch) return 'l';
        if (Math.abs(nx - (cx+cw)) < t && ny > cy && ny < cy+ch) return 'r';

        if (nx >= cx && nx <= cx+cw && ny >= cy && ny <= cy+ch) return 'move';

        return null;
    }

    _onPointerDown(e) {
        if (!this.active) return;
        const { nx, ny } = this._overlayToNorm(e.clientX, e.clientY);
        this.dragging = this._getHandle(nx, ny);
        this.dragStart = { nx, ny, cx: this.cropX, cy: this.cropY, cw: this.cropW, ch: this.cropH };
    }

    _onPointerMove(e) {
        if (!this.active || !this.dragging) return;
        const { nx, ny } = this._overlayToNorm(e.clientX, e.clientY);
        const dx = nx - this.dragStart.nx;
        const dy = ny - this.dragStart.ny;
        const s = this.dragStart;

        if (this.dragging === 'move') {
            this.cropX = s.cx + dx;
            this.cropY = s.cy + dy;
        } else {
            let newX = s.cx, newY = s.cy, newW = s.cw, newH = s.ch;

            if (this.dragging.includes('l')) { newX = s.cx + dx; newW = s.cw - dx; }
            if (this.dragging.includes('r')) { newW = s.cw + dx; }
            if (this.dragging.includes('t')) { newY = s.cy + dy; newH = s.ch - dy; }
            if (this.dragging.includes('b')) { newH = s.ch + dy; }

            // Enforce aspect ratio on corner drags
            if (this.aspectRatio !== null && this.dragging.length === 2) {
                const imgAspect = this.app.imageWidth / this.app.imageHeight;
                const targetAspect = this.aspectRatio / imgAspect;
                newH = newW / targetAspect;
            }

            if (newW > 0.05 && newH > 0.05) {
                this.cropX = newX; this.cropY = newY;
                this.cropW = newW; this.cropH = newH;
            }
        }

        this._clampCrop();
        this._drawOverlay();

        const cursors = { tl: 'nw-resize', tr: 'ne-resize', bl: 'sw-resize', br: 'se-resize',
                          t: 'n-resize', b: 's-resize', l: 'w-resize', r: 'e-resize', move: 'move' };
        this.overlay.style.cursor = cursors[this.dragging] || 'crosshair';
    }

    _onPointerUp() {
        this.dragging = null;
        if (this.active) this.overlay.style.cursor = 'crosshair';
    }

    autoStraighten() {
        if (!this.app.image) return;

        const maxDim = 400;
        let sw = this.app.imageWidth, sh = this.app.imageHeight;
        const scale = Math.min(1, maxDim / Math.max(sw, sh));
        sw = Math.round(sw * scale);
        sh = Math.round(sh * scale);

        const c = document.createElement('canvas');
        c.width = sw; c.height = sh;
        const ctx = c.getContext('2d');
        ctx.drawImage(this.app.image, 0, 0, sw, sh);
        const data = ctx.getImageData(0, 0, sw, sh).data;

        // Grayscale
        const gray = new Float32Array(sw * sh);
        for (let i = 0; i < sw * sh; i++) {
            gray[i] = 0.299 * data[i*4] + 0.587 * data[i*4+1] + 0.114 * data[i*4+2];
        }

        // Sobel
        const gx = new Float32Array(sw * sh);
        const gy = new Float32Array(sw * sh);
        for (let y = 1; y < sh - 1; y++) {
            for (let x = 1; x < sw - 1; x++) {
                const i = y * sw + x;
                gx[i] = -gray[i-sw-1] + gray[i-sw+1] - 2*gray[i-1] + 2*gray[i+1] - gray[i+sw-1] + gray[i+sw+1];
                gy[i] = -gray[i-sw-1] - 2*gray[i-sw] - gray[i-sw+1] + gray[i+sw-1] + 2*gray[i+sw] + gray[i+sw+1];
            }
        }

        // Accumulate angles of strong edges
        const angleBins = new Float32Array(900); // -45 to +45 in 0.1° steps
        let totalWeight = 0;

        for (let y = 2; y < sh - 2; y++) {
            for (let x = 2; x < sw - 2; x++) {
                const i = y * sw + x;
                const mag = Math.sqrt(gx[i]*gx[i] + gy[i]*gy[i]);
                if (mag < 30) continue;

                const angle = Math.atan2(gy[i], gx[i]) * 180 / Math.PI;

                let deviation;
                if (Math.abs(angle) < 45 || Math.abs(angle) > 135) {
                    deviation = angle > 90 ? angle - 180 : (angle < -90 ? angle + 180 : angle);
                } else {
                    deviation = angle > 0 ? angle - 90 : angle + 90;
                }

                if (Math.abs(deviation) <= 45) {
                    const bin = Math.round((deviation + 45) * 10);
                    if (bin >= 0 && bin < 900) {
                        angleBins[bin] += mag;
                        totalWeight += mag;
                    }
                }
            }
        }

        if (totalWeight < 100) return;

        // Smooth histogram
        const smoothed = new Float32Array(900);
        for (let i = 5; i < 895; i++) {
            let sum = 0;
            for (let j = -5; j <= 5; j++) sum += angleBins[i + j];
            smoothed[i] = sum;
        }

        let peakBin = 450;
        let peakVal = 0;
        for (let i = 0; i < 900; i++) {
            if (smoothed[i] > peakVal) { peakVal = smoothed[i]; peakBin = i; }
        }

        const detectedAngle = (peakBin - 450) / 10;

        if (Math.abs(detectedAngle) < 10 && Math.abs(detectedAngle) > 0.2) {
            this.rotation = -detectedAngle;
            this._rotSlider.value = this.rotation;
            this._rotVal.textContent = this.rotation.toFixed(1) + '°';
            this._drawOverlay();
        }
    }

    apply() {
        if (!this.app.image) return;

        const iw = this.app.imageWidth;
        const ih = this.app.imageHeight;

        // Cap working resolution to avoid canvas size limits
        const maxDim = 4096;
        let workW = iw, workH = ih;
        if (workW > maxDim || workH > maxDim) {
            const s = maxDim / Math.max(workW, workH);
            workW = Math.round(workW * s);
            workH = Math.round(workH * s);
        }

        const sx = Math.round(this.cropX * workW);
        const sy = Math.round(this.cropY * workH);
        const sw = Math.round(this.cropW * workW);
        const sh = Math.round(this.cropH * workH);

        const out = document.createElement('canvas');
        out.width = sw;
        out.height = sh;
        const ctx = out.getContext('2d');

        if (Math.abs(this.rotation) < 0.1) {
            // Simple crop, no rotation
            ctx.drawImage(this.app.image, sx, sy, sw, sh, 0, 0, sw, sh);
        } else {
            // Draw the full image rotated at working resolution, then crop from it
            const rad = this.rotation * Math.PI / 180;
            const rotCanvas = document.createElement('canvas');
            rotCanvas.width = workW;
            rotCanvas.height = workH;
            const rCtx = rotCanvas.getContext('2d');
            rCtx.translate(workW / 2, workH / 2);
            rCtx.rotate(rad);
            rCtx.translate(-workW / 2, -workH / 2);
            rCtx.drawImage(this.app.image, 0, 0, workW, workH);

            ctx.drawImage(rotCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
        }

        // Clear CSS rotation preview
        document.getElementById('main-canvas').style.transform = '';

        // Replace the app's source image
        const newImg = new Image();
        newImg.onload = () => {
            this.app.image = newImg;
            this.app.imageWidth = newImg.width;
            this.app.imageHeight = newImg.height;
            this.app.glEngine.loadImage(newImg);
            this.app._fitCanvas();
            this.app._hideCompositeOverlay();
            this.app._render();
            this.app._pushHistory();

            // Clear masks since dimensions changed
            this.app.maskEngine.masks = [];
            this.app.maskEngine.activeMaskIndex = -1;
            this.app._updateMaskList();

            this.deactivate();
        };
        newImg.src = out.toDataURL('image/png');
    }

    cancel() {
        this.deactivate();
        // Switch to basic panel
        document.querySelectorAll('.panel-tab').forEach(t => {
            const isBasic = t.dataset.panel === 'basic';
            t.classList.toggle('active', isBasic);
        });
        document.querySelectorAll('.edit-panel').forEach(p => p.classList.remove('active'));
        document.getElementById('panel-basic').classList.add('active');
    }
}

// ======================== Init ========================
document.addEventListener('DOMContentLoaded', () => {
    window.app = new App();
    window.library = new Library(window.app);
});

// ======================== Photo Library ========================
class Library {
    constructor(app) {
        this.app = app;
        this.photos = []; // [{id, name, file?, fileHandle?, thumbUrl, hasEdits}]
        this.activeIndex = -1;
        this.db = null;
        this.isOpen = false;
        this.dirHandle = null;
        this.hasFSAccess = !!window.showDirectoryPicker;
        this._initDB().then(() => this._tryRestoreFolder());
        this._bindEvents();
        // Update button text based on FS Access support
        const importBtn = document.getElementById('lib-import-btn');
        if (importBtn) {
            importBtn.textContent = this.hasFSAccess ? 'Open Folder' : 'Import Photos';
        }
        // Hide refresh button if no FS Access
        const refreshBtn = document.getElementById('lib-refresh-btn');
        if (refreshBtn && !this.hasFSAccess) {
            refreshBtn.style.display = 'none';
        }
    }

    async _initDB() {
        return new Promise((resolve) => {
            const req = indexedDB.open('ABEL-library', 2);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('edits')) db.createObjectStore('edits', { keyPath: 'id' });
                if (!db.objectStoreNames.contains('thumbs')) db.createObjectStore('thumbs', { keyPath: 'id' });
                if (!db.objectStoreNames.contains('config')) db.createObjectStore('config', { keyPath: 'key' });
            };
            req.onsuccess = (e) => { this.db = e.target.result; resolve(); };
            req.onerror = () => resolve();
        });
    }

    async _saveDirHandle(handle) {
        if (!this.db) return;
        try {
            const tx = this.db.transaction('config', 'readwrite');
            tx.objectStore('config').put({ key: 'dirHandle', value: handle });
        } catch (e) { /* ignore */ }
    }

    async _tryRestoreFolder() {
        if (!this.hasFSAccess || !this.db) return;
        try {
            const tx = this.db.transaction('config', 'readonly');
            const req = tx.objectStore('config').get('dirHandle');
            req.onsuccess = async () => {
                if (!req.result || !req.result.value) return;
                const handle = req.result.value;
                try {
                    const perm = await handle.queryPermission({ mode: 'readwrite' });
                    if (perm === 'granted') {
                        this.dirHandle = handle;
                        await this._scanFolder();
                    }
                    // If perm is 'prompt', we'll request when user clicks Library or Refresh
                } catch (e) { /* permission check failed */ }
            };
        } catch (e) { /* ignore */ }
    }

    _photoId(nameOrFile) {
        if (typeof nameOrFile === 'string') {
            return 'fs_' + nameOrFile;
        }
        return nameOrFile.name + '_' + nameOrFile.size + '_' + nameOrFile.lastModified;
    }

    _isImageFile(name) {
        const ext = name.split('.').pop().toLowerCase();
        return ['jpg','jpeg','png','webp','heic','tiff','tif','bmp','gif'].includes(ext) && !name.startsWith('.');
    }

    _bindEvents() {
        document.getElementById('btn-library').addEventListener('click', () => this.toggle());

        document.getElementById('lib-import-btn').addEventListener('click', async () => {
            if (this.hasFSAccess) {
                await this.openFolder();
            } else {
                document.getElementById('lib-file-input').click();
            }
        });

        document.getElementById('lib-file-input').addEventListener('change', (e) => {
            this.addFiles(Array.from(e.target.files));
            e.target.value = '';
        });

        const refreshBtn = document.getElementById('lib-refresh-btn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => this._scanFolder());
        }

        document.getElementById('lib-clear-btn').addEventListener('click', () => this.clearAll());
    }

    async openFolder() {
        try {
            this.dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
            await this._saveDirHandle(this.dirHandle);
            // Clear previous folder photos before scanning new folder
            this.photos = this.photos.filter(p => !p.fileHandle);
            this.activeIndex = -1;
            await this._scanFolder();
        } catch (e) {
            if (e.name !== 'AbortError') console.error('Folder open failed:', e);
        }
    }

    async _scanFolder() {
        if (!this.dirHandle) return;

        try {
            const perm = await this.dirHandle.requestPermission({ mode: 'readwrite' });
            if (perm !== 'granted') return;
        } catch (e) { return; }

        const existing = new Set(this.photos.map(p => p.name));

        for await (const entry of this.dirHandle.values()) {
            if (entry.kind !== 'file') continue;
            if (!this._isImageFile(entry.name)) continue;
            if (entry.name.endsWith('.ABEL.json')) continue;
            if (existing.has(entry.name)) continue;

            const id = this._photoId(entry.name);
            const fileHandle = entry;

            // Check if sidecar edit file exists
            let hasEdits = false;
            try {
                await this.dirHandle.getFileHandle(entry.name + '.ABEL.json');
                hasEdits = true;
            } catch (e) { /* no sidecar */ }

            // Generate thumbnail
            let thumbUrl = '';
            try {
                const file = await fileHandle.getFile();
                thumbUrl = await this._generateThumb(file);
            } catch (e) { continue; }

            this.photos.push({ id, name: entry.name, fileHandle, thumbUrl, hasEdits });
        }

        // Sort alphabetically
        this.photos.sort((a, b) => a.name.localeCompare(b.name));

        // Show folder name
        const pathEl = document.getElementById('lib-folder-path');
        if (pathEl) {
            pathEl.textContent = this.dirHandle.name;
            pathEl.style.display = '';
        }

        this._renderGrid();
        this._renderFilmstrip();

        if (this.photos.length > 1 && !this.isOpen) {
            document.getElementById('filmstrip').style.display = '';
        }
    }

    toggle() {
        this.isOpen ? this.close() : this.open();
    }

    open() {
        this.isOpen = true;
        this._saveCurrentEdits();
        document.getElementById('library-view').style.display = '';
        document.getElementById('filmstrip').style.display = 'none';
        document.getElementById('btn-library').style.color = 'var(--accent)';
        this._renderGrid();
    }

    close() {
        this.isOpen = false;
        document.getElementById('library-view').style.display = 'none';
        if (this.photos.length > 1) {
            document.getElementById('filmstrip').style.display = '';
        }
        document.getElementById('btn-library').style.color = '';
    }

    async addFiles(files) {
        for (const file of files) {
            if (!file.type.startsWith('image/')) continue;
            const id = this._photoId(file);
            if (this.photos.find(p => p.id === id)) continue;

            const thumbUrl = await this._generateThumb(file);
            this.photos.push({ id, name: file.name, file, thumbUrl, hasEdits: false });

            if (this.db) {
                try {
                    const tx = this.db.transaction('edits', 'readonly');
                    const store = tx.objectStore('edits');
                    const req = store.get(id);
                    req.onsuccess = () => {
                        const photo = this.photos.find(p => p.id === id);
                        if (photo && req.result) photo.hasEdits = true;
                        this._renderGrid();
                        this._renderFilmstrip();
                    };
                } catch (e) { /* ignore */ }
            }
        }

        this._renderGrid();
        this._renderFilmstrip();

        if (this.photos.length === 1 && !this.app.image) {
            this.openPhoto(0);
        }

        if (this.photos.length > 1) {
            document.getElementById('filmstrip').style.display = this.isOpen ? 'none' : '';
        }
    }

    async _generateThumb(file) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    const size = 200;
                    const canvas = document.createElement('canvas');
                    canvas.width = size;
                    canvas.height = size;
                    const ctx = canvas.getContext('2d');
                    const scale = Math.max(size / img.width, size / img.height);
                    const w = img.width * scale;
                    const h = img.height * scale;
                    ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
                    resolve(canvas.toDataURL('image/jpeg', 0.7));
                };
                img.src = e.target.result;
            };
            reader.readAsDataURL(file);
        });
    }

    async openPhoto(index) {
        if (index < 0 || index >= this.photos.length) return;

        await this._saveCurrentEdits();

        this.activeIndex = index;
        const photo = this.photos[index];

        this.close();

        // Get the actual File object
        let file;
        if (photo.fileHandle) {
            file = await photo.fileHandle.getFile();
        } else {
            file = photo.file;
        }

        await this.app._loadFile(file);
        await this._restoreEdits(photo);
        this._renderFilmstrip();
        this._renderGrid();
    }

    async _saveCurrentEdits() {
        if (this.activeIndex < 0 || !this.app.image) return;
        const photo = this.photos[this.activeIndex];
        if (!photo) return;

        const editData = {
            state: JSON.parse(JSON.stringify(this.app.state)),
            masks: this.app.maskEngine.masks.map(m => ({
                type: m.type,
                inverted: m.inverted,
                adjustments: { ...m.adjustments },
                visible: m.visible,
                canvasData: m.canvas.toDataURL('image/png'),
            })),
            timestamp: Date.now(),
        };

        const defaultState = this.app._defaultState();
        const isEdited = JSON.stringify(editData.state) !== JSON.stringify(defaultState) || editData.masks.length > 0;
        photo.hasEdits = isEdited;

        if (isEdited) {
            // If we have FS access and this photo came from a folder, write sidecar file
            if (this.dirHandle && photo.fileHandle) {
                try {
                    const sidecarHandle = await this.dirHandle.getFileHandle(
                        photo.name + '.ABEL.json', { create: true }
                    );
                    const writable = await sidecarHandle.createWritable();
                    await writable.write(JSON.stringify(editData, null, 2));
                    await writable.close();
                } catch (e) { console.error('Save sidecar failed:', e); }
            }
            // Also save to IndexedDB as backup
            if (this.db) {
                try {
                    const tx = this.db.transaction('edits', 'readwrite');
                    tx.objectStore('edits').put({ id: photo.id, ...editData });
                } catch (e) { /* ignore */ }
            }
        }
    }

    async _restoreEdits(photo) {
        let editData = null;

        // Try loading from sidecar file first (FS Access)
        if (this.dirHandle && photo.fileHandle) {
            try {
                const sidecarHandle = await this.dirHandle.getFileHandle(photo.name + '.ABEL.json');
                const sidecarFile = await sidecarHandle.getFile();
                const text = await sidecarFile.text();
                editData = JSON.parse(text);
            } catch (e) { /* file doesn't exist = no edits */ }
        }

        // Fallback to IndexedDB
        if (!editData && this.db) {
            editData = await new Promise((resolve) => {
                try {
                    const tx = this.db.transaction('edits', 'readonly');
                    const req = tx.objectStore('edits').get(photo.id);
                    req.onsuccess = () => resolve(req.result || null);
                    req.onerror = () => resolve(null);
                } catch (e) { resolve(null); }
            });
        }

        if (editData && editData.state) {
            this.app.state = { ...this.app._defaultState(), ...editData.state };
            this.app._syncSlidersFromState();

            // Restore masks
            this.app.maskEngine.masks = [];
            this.app.maskEngine.activeMaskIndex = -1;
            if (editData.masks && editData.masks.length > 0) {
                const maskPromises = editData.masks.map(savedMask => {
                    return new Promise((resolve) => {
                        this.app.maskEngine.createMask(savedMask.type);
                        const mask = this.app.maskEngine.getActiveMask();
                        if (!mask) { resolve(); return; }
                        mask.adjustments = { ...mask.adjustments, ...savedMask.adjustments };
                        mask.inverted = savedMask.inverted;
                        mask.visible = savedMask.visible;

                        // Restore the mask canvas image data
                        if (savedMask.canvasData) {
                            const img = new Image();
                            img.onload = () => {
                                mask.ctx.drawImage(img, 0, 0, mask.canvas.width, mask.canvas.height);
                                resolve();
                            };
                            img.onerror = () => resolve();
                            img.src = savedMask.canvasData;
                        } else {
                            resolve();
                        }
                    });
                });
                await Promise.all(maskPromises);
            }

            // Update mask UI so they appear in the list and are editable
            this.app._updateMaskList();
            this.app._syncMaskSliders();
            this.app._hideCompositeOverlay();
            this.app._render();
        }
    }

    clearAll() {
        this.photos = [];
        this.activeIndex = -1;
        this.dirHandle = null;
        document.getElementById('filmstrip').style.display = 'none';
        const pathEl = document.getElementById('lib-folder-path');
        if (pathEl) pathEl.style.display = 'none';
        this._renderGrid();
        this._renderFilmstrip();
        if (this.db) {
            try {
                const tx = this.db.transaction(['edits', 'thumbs', 'config'], 'readwrite');
                tx.objectStore('edits').clear();
                tx.objectStore('thumbs').clear();
                tx.objectStore('config').delete('dirHandle');
            } catch (e) { /* ignore */ }
        }
    }

    _renderGrid() {
        const grid = document.getElementById('library-grid');
        if (!grid) return;
        grid.innerHTML = '';

        if (this.photos.length === 0) {
            const hint = this.hasFSAccess ? 'Open Folder' : 'Import Photos';
            grid.innerHTML = '<p style="color:var(--text-muted);grid-column:1/-1;text-align:center;padding:40px;">No photos yet. Click ' + hint + ' to get started.</p>';
            return;
        }

        this.photos.forEach((photo, i) => {
            const div = document.createElement('div');
            div.className = 'lib-thumb' + (i === this.activeIndex ? ' active' : '');

            const img = document.createElement('img');
            img.src = photo.thumbUrl;
            img.alt = photo.name;
            div.appendChild(img);

            if (photo.hasEdits) {
                const dot = document.createElement('div');
                dot.className = 'lib-thumb-edited';
                div.appendChild(dot);
            }

            const name = document.createElement('div');
            name.className = 'lib-thumb-name';
            name.textContent = photo.name;
            div.appendChild(name);

            div.addEventListener('click', () => this.openPhoto(i));
            grid.appendChild(div);
        });
    }

    _renderFilmstrip() {
        const strip = document.getElementById('filmstrip-inner');
        if (!strip) return;
        strip.innerHTML = '';

        this.photos.forEach((photo, i) => {
            const img = document.createElement('img');
            img.className = 'filmstrip-thumb' + (i === this.activeIndex ? ' active' : '');
            img.src = photo.thumbUrl;
            img.alt = photo.name;
            img.title = photo.name;
            img.addEventListener('click', () => this.openPhoto(i));
            strip.appendChild(img);
        });
    }
}

// ======================== Batch Auto-Edit ========================
class BatchProcessor {
    constructor() {
        this.files = [];
        this.processedBlobs = [];
        this.processing = false;
        this._bindEvents();
    }

    _bindEvents() {
        document.getElementById('btn-batch').addEventListener('click', () => this.show());
        document.getElementById('batch-close').addEventListener('click', () => this.hide());
        document.getElementById('batch-cancel').addEventListener('click', () => this.hide());
        document.getElementById('batch-select-btn').addEventListener('click', () => {
            document.getElementById('batch-file-input').click();
        });
        document.getElementById('batch-file-input').addEventListener('change', (e) => {
            this.addFiles(Array.from(e.target.files));
        });
        document.getElementById('batch-start').addEventListener('click', () => this.processAll());
        document.getElementById('batch-download').addEventListener('click', () => this.downloadZip());

        // Format change hides/shows quality
        document.getElementById('batch-format').addEventListener('change', (e) => {
            document.getElementById('batch-quality-row').style.display = e.target.value === 'png' ? 'none' : 'flex';
        });
        document.getElementById('batch-quality').addEventListener('input', function () {
            document.getElementById('batch-quality-value').textContent = this.value + '%';
        });

        // Drag & drop
        const dropArea = document.getElementById('batch-drop');
        ['dragenter', 'dragover'].forEach(evt => {
            dropArea.addEventListener(evt, (e) => { e.preventDefault(); dropArea.classList.add('drag-over'); });
        });
        ['dragleave', 'drop'].forEach(evt => {
            dropArea.addEventListener(evt, (e) => { e.preventDefault(); dropArea.classList.remove('drag-over'); });
        });
        dropArea.addEventListener('drop', (e) => {
            const imageFiles = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
            if (imageFiles.length) this.addFiles(imageFiles);
        });
    }

    show() {
        this.files = [];
        this.processedBlobs = [];
        this.processing = false;
        this._renderList();
        this._setStatus('');
        document.getElementById('batch-progress-wrap').style.display = 'none';
        document.getElementById('batch-start').style.display = '';
        document.getElementById('batch-start').disabled = true;
        document.getElementById('batch-download').style.display = 'none';
        document.getElementById('batch-modal').classList.add('visible');
        document.getElementById('batch-file-input').value = '';
    }

    hide() {
        if (this.processing) return; // don't close while processing
        document.getElementById('batch-modal').classList.remove('visible');
    }

    addFiles(newFiles) {
        for (const file of newFiles) {
            if (!file.type.startsWith('image/')) continue;
            if (this.files.find(f => f.file.name === file.name && f.file.size === file.size)) continue;
            this.files.push({
                file,
                status: 'pending', // pending | processing | done | error
                thumb: null,
            });
            // Generate thumbnail
            const idx = this.files.length - 1;
            const reader = new FileReader();
            reader.onload = (e) => {
                this.files[idx].thumb = e.target.result;
                this._renderList();
            };
            reader.readAsDataURL(file);
        }
        document.getElementById('batch-start').disabled = this.files.length === 0;
        this._renderList();
    }

    removeFile(index) {
        if (this.processing) return;
        this.files.splice(index, 1);
        document.getElementById('batch-start').disabled = this.files.length === 0;
        this._renderList();
    }

    _renderList() {
        const list = document.getElementById('batch-list');
        list.innerHTML = '';
        this.files.forEach((item, i) => {
            const div = document.createElement('div');
            div.className = 'batch-item';

            const thumb = document.createElement('img');
            thumb.className = 'batch-item-thumb';
            thumb.src = item.thumb || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

            const name = document.createElement('span');
            name.className = 'batch-item-name';
            name.textContent = item.file.name;

            const size = document.createElement('span');
            size.className = 'batch-item-size';
            size.textContent = this._formatSize(item.file.size);

            const status = document.createElement('span');
            status.className = 'batch-item-status';
            if (item.status === 'pending') status.textContent = '⏳';
            else if (item.status === 'processing') status.textContent = '⚙️';
            else if (item.status === 'done') status.textContent = '✅';
            else if (item.status === 'error') status.textContent = '❌';

            const removeBtn = document.createElement('button');
            removeBtn.className = 'batch-item-remove';
            removeBtn.textContent = '✕';
            removeBtn.title = 'Remove';
            removeBtn.style.display = this.processing ? 'none' : '';
            removeBtn.addEventListener('click', () => this.removeFile(i));

            div.appendChild(thumb);
            div.appendChild(name);
            div.appendChild(size);
            div.appendChild(status);
            div.appendChild(removeBtn);
            list.appendChild(div);
        });
    }

    _formatSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1048576).toFixed(1) + ' MB';
    }

    _setStatus(text) {
        document.getElementById('batch-status').textContent = text;
    }

    _setProgress(pct) {
        document.getElementById('batch-progress-fill').style.width = pct + '%';
    }

    async processAll() {
        if (this.files.length === 0 || this.processing) return;
        this.processing = true;
        this.processedBlobs = [];

        const startBtn = document.getElementById('batch-start');
        startBtn.disabled = true;
        startBtn.textContent = '⏳ Processing...';
        document.getElementById('batch-progress-wrap').style.display = 'block';
        this._setProgress(0);

        const format = document.getElementById('batch-format').value;
        const quality = parseInt(document.getElementById('batch-quality').value) / 100;
        const mimeType = format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : 'image/jpeg';

        // Create offscreen canvas + GL engine for batch processing
        const offCanvas = document.createElement('canvas');
        let batchGL;
        try {
            batchGL = new GLEngine(offCanvas);
        } catch (e) {
            this._setStatus('Error: WebGL not available');
            this.processing = false;
            startBtn.textContent = '🚀 Process All';
            startBtn.disabled = false;
            return;
        }

        for (let i = 0; i < this.files.length; i++) {
            const item = this.files[i];
            item.status = 'processing';
            this._renderList();
            this._setStatus(`Processing ${i + 1} of ${this.files.length}: ${item.file.name}`);
            this._setProgress(((i) / this.files.length) * 100);

            try {
                const blob = await this._processOneImage(item.file, batchGL, offCanvas, mimeType, quality, format);
                this.processedBlobs.push({ name: this._outputName(item.file.name, format), blob });
                item.status = 'done';
            } catch (e) {
                console.error('Batch error:', item.file.name, e);
                item.status = 'error';
            }
            this._renderList();
        }

        batchGL.destroy();
        this._setProgress(100);

        const doneCount = this.files.filter(f => f.status === 'done').length;
        const errCount = this.files.filter(f => f.status === 'error').length;
        this._setStatus(`Done! ${doneCount} photos processed${errCount ? `, ${errCount} errors` : ''}.`);

        this.processing = false;
        startBtn.style.display = 'none';
        document.getElementById('batch-download').style.display = '';
    }

    _outputName(originalName, format) {
        const base = originalName.replace(/\.[^.]+$/, '');
        return `${base}_ABEL.${format}`;
    }

    _processOneImage(file, batchGL, offCanvas, mimeType, quality, format) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = reject;
            reader.onload = (e) => {
                const img = new Image();
                img.onerror = reject;
                img.onload = () => {
                    try {
                        // Load into GL
                        batchGL.loadImage(img);

                        // Analyze and auto-edit
                        const maxDim = 600;
                        const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
                        const sw = Math.round(img.naturalWidth * scale);
                        const sh = Math.round(img.naturalHeight * scale);
                        const tmpCanvas = document.createElement('canvas');
                        tmpCanvas.width = sw;
                        tmpCanvas.height = sh;
                        const ctx = tmpCanvas.getContext('2d');
                        ctx.drawImage(img, 0, 0, sw, sh);
                        const imageData = ctx.getImageData(0, 0, sw, sh);

                        const autoAdj = AutoEdit.autoAll(imageData);

                        // Build full adjustments object
                        const adj = {
                            exposure: autoAdj.exposure || 0,
                            contrast: autoAdj.contrast || 0,
                            highlights: autoAdj.highlights || 0,
                            shadows: autoAdj.shadows || 0,
                            whites: autoAdj.whites || 0,
                            blacks: autoAdj.blacks || 0,
                            temperature: autoAdj.temperature || 0,
                            tint: autoAdj.tint || 0,
                            vibrance: autoAdj.vibrance || 0,
                            saturation: 0,
                            clarity: 0,
                            dehaze: 0,
                            sharpenAmount: 0,
                            vignetteAmount: 0,
                            vignetteMidpoint: 50,
                            vignetteFeather: 50,
                            grainAmount: 0,
                            hslHue: [0,0,0,0,0,0,0,0],
                            hslSat: [0,0,0,0,0,0,0,0],
                            hslLum: [0,0,0,0,0,0,0,0],
                            colorGrading: {
                                shadows: { r: 1, g: 1, b: 1, blend: 0 },
                                midtones: { r: 1, g: 1, b: 1, blend: 0 },
                                highlights: { r: 1, g: 1, b: 1, blend: 0 },
                            },
                            showOriginal: false,
                        };

                        batchGL.setAdjustments(adj);

                        // Identity curve LUT
                        const lutData = new Uint8Array(256 * 4 * 4);
                        for (let i = 0; i < 256; i++) {
                            for (let row = 0; row < 4; row++) {
                                lutData[(row * 256 + i) * 4 + 0] = i;
                                lutData[(row * 256 + i) * 4 + 1] = i;
                                lutData[(row * 256 + i) * 4 + 2] = i;
                                lutData[(row * 256 + i) * 4 + 3] = 255;
                            }
                        }
                        batchGL.updateCurveLUT({ data: lutData, width: 256, height: 4, isIdentity: true });
                        batchGL.render();

                        // Export
                        offCanvas.toBlob((blob) => {
                            if (blob) resolve(blob);
                            else reject(new Error('toBlob failed'));
                        }, mimeType, quality);
                    } catch (err) {
                        reject(err);
                    }
                };
                img.src = e.target.result;
            };
            reader.readAsDataURL(file);
        });
    }

    async downloadZip() {
        if (this.processedBlobs.length === 0) return;

        this._setStatus('Creating ZIP file...');
        document.getElementById('batch-download').disabled = true;

        try {
            const zip = new JSZip();
            for (const item of this.processedBlobs) {
                zip.file(item.name, item.blob);
            }

            const content = await zip.generateAsync({
                type: 'blob',
                compression: 'DEFLATE',
                compressionOptions: { level: 1 }, // fast compression
            }, (metadata) => {
                this._setProgress(metadata.percent);
                this._setStatus(`Compressing... ${Math.round(metadata.percent)}%`);
            });

            const url = URL.createObjectURL(content);
            const a = document.createElement('a');
            a.href = url;
            a.download = `ABEL_batch_${this.processedBlobs.length}_photos.zip`;
            a.click();
            URL.revokeObjectURL(url);

            this._setStatus(`Downloaded ${this.processedBlobs.length} photos as ZIP.`);
        } catch (e) {
            this._setStatus('Error creating ZIP: ' + e.message);
        }

        document.getElementById('batch-download').disabled = false;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.batchProcessor = new BatchProcessor();
});
