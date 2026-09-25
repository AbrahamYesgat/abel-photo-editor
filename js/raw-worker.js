import './raw-policy.js';
import LibRawModule from './vendor/libraw/libraw.js';

self.onmessage = async ({ data: { buffer, mobile, halfSize, thumbnail } }) => {
    let raw;
    try {
        const bytes = new Uint8Array(buffer);
        RawPolicy.checkSize(bytes.byteLength, mobile);
        if (!RawPolicy.isCR3(bytes.subarray(0, 4096))) throw new Error('Not a Canon CR3 container, or its header is damaged.');
        self.postMessage({ status: 'Loading local RAW decoder…' });
        const wasmMemory = new WebAssembly.Memory({ initial: 1024, maximum: RawPolicy.limits(mobile).heap / 65536 });
        const codec = await LibRawModule({ wasmMemory });
        raw = new codec.LibRaw();
        self.postMessage({ status: 'Reading CR3 sensor metadata…' });
        raw.open(bytes, { halfSize, useCameraWb: true, useAutoWb: false, outputColor: 1,
            outputBps: 8, userQual: 3, userFlip: -1, gamm: [1 / 2.4, 12.92],
            noAutoBright: false, bright: 1 });
        const meta = raw.metadata(false);
        RawPolicy.checkDimensions(meta, bytes.byteLength, mobile, halfSize);
        self.postMessage({ status: 'Developing CR3 sensor data locally…' });
        // This calls LibRaw unpack + dcraw_process, never thumbnailData.
        const image = raw.imageData();
        const { width, height, colors, bits, data } = image || {};
        if (bits !== 8 || colors !== 3 || !data || data.length !== width * height * 3 ||
            !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width * height > 64e6) {
            throw new Error('The RAW decoder returned invalid RGB pixels.');
        }
        const rgba = new Uint8ClampedArray(width * height * 4);
        for (let src = 0, dst = 0; src < data.length; src += 3, dst += 4) {
            rgba[dst] = data[src]; rgba[dst + 1] = data[src + 1]; rgba[dst + 2] = data[src + 2]; rgba[dst + 3] = 255;
        }
        let bitmap = await createImageBitmap(new ImageData(rgba, width, height));
        if (thumbnail) {
            const canvas = new OffscreenCanvas(200, 200);
            const scale = Math.max(200 / width, 200 / height);
            canvas.getContext('2d').drawImage(bitmap, (200 - width * scale) / 2, (200 - height * scale) / 2, width * scale, height * scale);
            bitmap.close();
            bitmap = canvas.transferToImageBitmap();
        }
        // Deliberately omit EXIF, GPS, serial numbers and artist information.
        const info = { camera: `${meta.camera_make} ${meta.camera_model}`.trim(), width, height,
            sensorWidth: meta.raw_width, sensorHeight: meta.raw_height, orientation: meta.flip,
            halfSize, decoder: 'LibRaw 0.22.1', colorSpace: 'sRGB', bits: 8 };
        self.postMessage({ bitmap, info }, [bitmap]);
    } catch (error) {
        self.postMessage({ error: `Cannot develop this CR3. ${error?.message || 'Unsupported camera, damaged data or insufficient browser memory.'} LibRaw 0.22.1 does not support every Canon camera/CR3 variant.` });
    } finally {
        raw?.delete();
        self.close();
    }
};
