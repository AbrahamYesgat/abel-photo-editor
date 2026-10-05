'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

(async () => {
    const dir = path.join(__dirname, '../js/vendor/segmentation');
    await fs.mkdir(dir, { recursive: true });
    const pkg = JSON.parse(await fs.readFile(path.join(__dirname, '../node_modules/onnxruntime-web/package.json'), 'utf8'));
    if (pkg.version !== '1.22.0') throw new Error('Unexpected ONNX Runtime version');
    const files = ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];
    const hashes = {};
    for (const name of files) {
        const bytes = await fs.readFile(path.join(__dirname, '../node_modules/onnxruntime-web/dist', name));
        await fs.writeFile(path.join(dir, name), bytes);
        hashes[name] = createHash('sha256').update(bytes).digest('hex');
    }
    const sources = {
        'LICENSE-ONNX.txt': 'https://raw.githubusercontent.com/microsoft/onnxruntime/v1.22.0/LICENSE',
        'ThirdPartyNotices.txt': 'https://raw.githubusercontent.com/microsoft/onnxruntime/v1.22.0/ThirdPartyNotices.txt',
        'LICENSE-MODELS.txt': 'https://raw.githubusercontent.com/facebookresearch/detr/29901c51d7fe8712168b8d0d64351170bc0f83e0/LICENSE',
    };
    for (const [name, url] of Object.entries(sources)) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Cannot download ${name}: ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        await fs.writeFile(path.join(dir, name), bytes);
        hashes[name] = createHash('sha256').update(bytes).digest('hex');
    }
    await fs.writeFile(path.join(dir, 'integrity.json'), JSON.stringify({ version: pkg.version, hashes }, null, 2) + '\n');
})().catch(error => { console.error(error); process.exitCode = 1; });
