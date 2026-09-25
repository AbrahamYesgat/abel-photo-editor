(function (root) {
    'use strict';
    const scriptURL = document.currentScript.src;
    const workerURL = new URL('raw-worker.js?v=cr3-1', scriptURL);
    const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ||
        (navigator.deviceMemory && navigator.deviceMemory <= 4);
    let tail = Promise.resolve();
    let generation = 0;
    const controllers = new Set();
    const abortError = () => new DOMException('Photo import cancelled.', 'AbortError');
    function decodeRaw(file, { signal, onStatus = () => {}, halfSize = false, thumbnail = false } = {}) {
        const requestGeneration = generation;
        const run = async () => {
            if (signal?.aborted || requestGeneration !== generation) throw abortError();
            RawPolicy.checkSize(file.size, mobile);
            if (!root.Worker || !root.WebAssembly || !root.createImageBitmap) throw new Error('CR3 requires a current browser with WebAssembly, Workers and ImageBitmap support.');
            onStatus('Preparing local RAW decoder…');
            return new Promise((resolve, reject) => {
                let worker, timer;
                const stop = () => {
                    clearTimeout(timer);
                    worker?.terminate();
                    signal?.removeEventListener('abort', cancel);
                    controllers.delete(cancel);
                };
                const fail = error => { stop(); reject(error); };
                const cancel = () => fail(abortError());
                controllers.add(cancel);
                signal?.addEventListener('abort', cancel, { once: true });
                if (signal?.aborted) return cancel();
                timer = setTimeout(() => fail(new Error('CR3 decoding timed out. Try Smaller RAW or a desktop RAW developer.')), 120000);
                try {
                    worker = new Worker(workerURL, { type: 'module' });
                    worker.onerror = () => fail(new Error('The local RAW decoder could not load or ran out of memory. Try Smaller RAW, reload, or update your browser.'));
                    worker.onmessageerror = () => fail(new Error('The browser could not receive the decoded RAW image.'));
                    worker.onmessage = ({ data }) => {
                        if (data.status) return onStatus(data.status);
                        if (data.error) return fail(new Error(data.error));
                        if (!data.bitmap) return fail(new Error('The RAW decoder returned no image.'));
                        stop(); resolve({ image: data.bitmap, raw: data.info });
                    };
                    file.arrayBuffer().then(buffer => {
                        if (!signal?.aborted && controllers.has(cancel)) worker.postMessage({ buffer, mobile, halfSize, thumbnail }, [buffer]);
                    }).catch(fail);
                } catch (error) { fail(error); }
            });
        };
        onStatus('Waiting for local RAW import…');
        const result = tail.then(run, run);
        tail = result.catch(() => {});
        return result;
    }
    async function decode(file, options = {}) {
        const header = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
        if (options.signal?.aborted) throw abortError();
        if (RawPolicy.isCR3(header) || RawPolicy.isCandidate(file)) return decodeRaw(file, options);
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(file);
            const image = new Image();
            const clean = () => { URL.revokeObjectURL(url); options.signal?.removeEventListener('abort', cancel); };
            const cancel = () => { image.src = ''; clean(); reject(abortError()); };
            image.onload = () => { clean(); resolve({ image, raw: null }); };
            image.onerror = () => { clean(); reject(new Error('This image is damaged or its format is not supported by this browser.')); };
            options.signal?.addEventListener('abort', cancel, { once: true });
            if (options.signal?.aborted) return cancel();
            image.src = url;
        });
    }
    function release(image) { image?.close?.(); }
    function thumb(image) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 200;
        const width = image.naturalWidth || image.width, height = image.naturalHeight || image.height;
        const scale = Math.max(200 / width, 200 / height);
        canvas.getContext('2d').drawImage(image, (200 - width * scale) / 2, (200 - height * scale) / 2, width * scale, height * scale);
        return canvas.toDataURL('image/jpeg', 0.7);
    }
    root.addEventListener('pagehide', () => { generation++; for (const cancel of controllers) cancel(); });
    root.ImageImport = { decode, release, thumb, mobile };
})(window);
