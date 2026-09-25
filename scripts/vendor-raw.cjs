'use strict';
const { readFileSync, copyFileSync, mkdirSync } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'node_modules/libraw-wasm-nothread');
const target = path.join(root, 'js/vendor/libraw');
const manifest = require('../js/vendor/libraw/integrity.json');
if (JSON.parse(readFileSync(path.join(source, 'package.json'))).version !== manifest.version) throw new Error('Unexpected RAW decoder version');
mkdirSync(target, { recursive: true });
for (const [name, checksum] of Object.entries(manifest.files)) {
    const file = path.join(source, name === 'LICENSE' ? name : `dist/${name}`);
    if (createHash('sha256').update(readFileSync(file)).digest('hex') !== checksum) throw new Error(`RAW asset checksum mismatch: ${name}`);
    copyFileSync(file, path.join(target, name));
}
console.log(`Verified and vendored ${manifest.package}@${manifest.version}`);
