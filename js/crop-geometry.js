// Crop coordinates are pixels in the source-sized, rotated plane. Source pixels
// and mask vertices never move; only the viewport-to-source transform changes.
const CropGeometry = (() => {
    const size = image => [image.naturalWidth || image.width, image.naturalHeight || image.height];
    function validate(crop, width, height) {
        if (crop == null) return null;
        const reach = Math.ceil(Math.hypot(width, height));
        if (crop.version !== 1 || crop.sourceWidth !== width || crop.sourceHeight !== height ||
            !['x', 'y', 'width', 'height', 'rotation'].every(k => Number.isFinite(crop[k])) ||
            !['x', 'y', 'width', 'height'].every(k => Number.isInteger(crop[k])) ||
            crop.width < 1 || crop.height < 1 || crop.width > width || crop.height > height ||
            crop.x < -reach || crop.y < -reach || crop.x + crop.width > width + reach ||
            crop.y + crop.height > height + reach || Math.abs(crop.rotation) > 180)
            throw new Error('Saved crop does not match this photo’s dimensions.');
        const result = { version: 1, sourceWidth: width, sourceHeight: height,
            x: crop.x, y: crop.y, width: crop.width, height: crop.height, rotation: crop.rotation };
        // Composed legacy rotations may extend beyond the unrotated plane, but
        // must remain bounded and overlap the original rather than allocate an empty off-photo frame.
        const m = matrix(result, width, height);
        const corners = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }].map(p => point(m, p));
        if (Math.max(...corners.map(p => p.x)) <= 0 || Math.min(...corners.map(p => p.x)) >= 1 ||
            Math.max(...corners.map(p => p.y)) <= 0 || Math.min(...corners.map(p => p.y)) >= 1)
            throw new Error('Saved crop is outside the original photo.');
        return result.x === 0 && result.y === 0 && result.width === width &&
            result.height === height && result.rotation === 0 ? null : result;
    }
    function matrix(crop, width, height) {
        if (!crop) return [1, 0, 0, 1, 0, 0];
        const { x, y, width: w, height: h, rotation } = crop;
        const c = Math.cos(rotation * Math.PI / 180), s = Math.sin(rotation * Math.PI / 180);
        return [c * w / width, -s * w / height, s * h / width, c * h / height,
            (c * (x - width / 2) + s * (y - height / 2)) / width + .5,
            (-s * (x - width / 2) + c * (y - height / 2)) / height + .5];
    }
    function point(m, p) {
        return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
    }
    function inverse(m) {
        const d = m[0] * m[3] - m[1] * m[2];
        return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d,
            (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d];
    }
    const uniform = m => [m[0], m[1], 0, m[2], m[3], 0, m[4], m[5], 1];
    function draw(ctx, image, m, width, height) {
        const [iw, ih] = size(image);
        ctx.save();
        ctx.transform(m[0] * width / iw, m[1] * height / iw,
            m[2] * width / ih, m[3] * height / ih, m[4] * width, m[5] * height);
        ctx.drawImage(image, 0, 0);
        ctx.restore();
    }
    function legacy(crops, width, height) {
        if (!Array.isArray(crops) || crops.length > 100) throw new Error('Invalid saved crop geometry.');
        let m = [1, 0, 0, 1, 0, 0], sw = width, sh = height, rotation = 0;
        for (const old of crops) {
            if (!old || old.x < 0 || old.y < 0 || old.x + old.width > sw ||
                old.y + old.height > sh || Math.abs(old.rotation) > 45)
                throw new Error('Invalid saved crop geometry.');
            const crop = validate({ ...old, version: 1 }, sw, sh);
            const next = matrix(crop, sw, sh);
            const origin = point(m, { x: next[4], y: next[5] });
            m = [m[0] * next[0] + m[2] * next[1], m[1] * next[0] + m[3] * next[1],
                m[0] * next[2] + m[2] * next[3], m[1] * next[2] + m[3] * next[3], origin.x, origin.y];
            sw = old.width; sh = old.height; rotation += old.rotation;
        }
        if (!crops.length) return null;
        rotation = ((rotation + 180) % 360 + 360) % 360 - 180;
        const c = Math.cos(rotation * Math.PI / 180), s = Math.sin(rotation * Math.PI / 180);
        const dx = (m[4] - .5) * width, dy = (m[5] - .5) * height;
        return validate({ version: 1, sourceWidth: width, sourceHeight: height,
            x: Math.round(c * dx - s * dy + width / 2),
            y: Math.round(s * dx + c * dy + height / 2), width: sw, height: sh, rotation }, width, height);
    }
    return { size, validate, matrix, point, inverse, uniform, draw, legacy };
})();
if (typeof module !== 'undefined') module.exports = CropGeometry;
