/* Shared by the browser, decoding worker and tests. */
(function (root) {
    'use strict';
    const MiB = 1024 * 1024;
    function isCandidate(file) {
        return /\.cr3$/i.test(file.name || '') || /^image\/(x-)?canon-cr3$/i.test(file.type || '');
    }
    function isImage(file) {
        return isCandidate(file) || (file.type || '').startsWith('image/') ||
            /\.(jpe?g|png|webp|heic|tiff?|bmp|gif)$/i.test(file.name || '');
    }
    function isCR3(bytes) {
        if (bytes.length < 16) return false;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const size = view.getUint32(0);
        const text = (offset) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
        if (text(4) !== 'ftyp' || size < 16 || size > bytes.length || size % 4) return false;
        if (text(8) === 'crx ') return true;
        for (let offset = 16; offset < size; offset += 4) if (text(offset) === 'crx ') return true;
        return false;
    }
    function limits(mobile) {
        return { maxFile: (mobile ? 60 : 100) * MiB, maxPixels: 64e6,
            maxWorking: (mobile ? 512 : 1536) * MiB, heap: (mobile ? 384 : 1024) * MiB };
    }
    function checkSize(size, mobile) {
        if (!Number.isSafeInteger(size) || size < 24) throw new Error('The CR3 file is empty or truncated.');
        if (size > limits(mobile).maxFile) throw new Error(`CR3 file exceeds the ${mobile ? 60 : 100} MiB ${mobile ? 'mobile' : 'desktop'} limit. Use a smaller file or a desktop RAW developer.`);
    }
    function checkDimensions(meta, size, mobile, halfSize) {
        const { raw_width: rw, raw_height: rh, width: w, height: h } = meta;
        const values = [rw, rh, w, h];
        const policy = limits(mobile);
        if (values.some(n => !Number.isSafeInteger(n) || n < 1 || n > 32768) ||
            rw * rh > policy.maxPixels || w * h > policy.maxPixels) {
            throw new Error('CR3 dimensions are invalid or exceed the 64-megapixel sensor limit.');
        }
        const pixels = Math.ceil(w / (halfSize ? 2 : 1)) * Math.ceil(h / (halfSize ? 2 : 1));
        // Sensor, demosaic/output copies, original file and editor working headroom.
        const estimate = rw * rh * 2 + pixels * 32 + size * 2 + 64 * MiB;
        if (estimate > policy.maxWorking) throw new Error('This CR3 needs too much memory on this device. Enable “Smaller RAW” before importing, or use a desktop RAW developer.');
    }
    const api = { isCandidate, isImage, isCR3, limits, checkSize, checkDimensions };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.RawPolicy = api;
})(globalThis);
