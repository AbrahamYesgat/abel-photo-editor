// Normalized simple polygons; rasterization never depends on source-photo size.
const PolygonGeometry = (() => {
    const MAX_POINTS = 64, EPSILON = 1e-10;
    const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    function intersects(a, b, c, d) {
        const abC = cross(a, b, c), abD = cross(a, b, d);
        const cdA = cross(c, d, a), cdB = cross(c, d, b);
        const on = (p, q, r) => Math.abs(cross(p, q, r)) <= EPSILON &&
            r.x >= Math.min(p.x, q.x) - EPSILON && r.x <= Math.max(p.x, q.x) + EPSILON &&
            r.y >= Math.min(p.y, q.y) - EPSILON && r.y <= Math.max(p.y, q.y) + EPSILON;
        return ((abC > EPSILON && abD < -EPSILON || abC < -EPSILON && abD > EPSILON) &&
            (cdA > EPSILON && cdB < -EPSILON || cdA < -EPSILON && cdB > EPSILON)) ||
            on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b);
    }
    function error(points) {
        if (!Array.isArray(points) || points.length < 3) return 'Place at least 3 corners.';
        if (points.length > MAX_POINTS) return `Use at most ${MAX_POINTS} corners.`;
        for (const p of points) {
            if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) ||
                p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return 'Keep corners inside the photo.';
        }
        const n = points.length;
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                if (Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y) < 1e-6)
                    return 'Corners must be distinct. Undo a point and try again.';
            }
            const a = points[(i + n - 1) % n], b = points[i], c = points[(i + 1) % n];
            if (Math.abs(cross(a, b, c)) <= EPSILON &&
                (a.x - b.x) * (c.x - b.x) + (a.y - b.y) * (c.y - b.y) > 0)
                return 'Edges cannot double back over each other.';
            for (let j = i + 2; j < n; j++) {
                if (i === 0 && j === n - 1) continue;
                if (intersects(points[i], points[(i + 1) % n], points[j], points[(j + 1) % n]))
                    return 'Edges cannot cross or touch. Move a corner or undo a point.';
            }
        }
        const area = points.reduce((sum, p, i) => {
            const q = points[(i + 1) % n];
            return sum + p.x * q.y - q.x * p.y;
        }, 0);
        if (Math.abs(area) < 1e-8) return 'The shape needs an area, not just a line.';
        return '';
    }
    const validParams = params => params && !error(params.points) &&
        Number.isFinite(params.feather) && params.feather >= 0 && params.feather <= 100;

    function rasterize(ctx, width, height, points, feather) {
        if (!validParams({ points, feather })) throw new Error(error(points) || 'Invalid polygon feather.');
        const vertices = points.map(p => ({ x: p.x * width, y: p.y * height }));
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = 'black';
        ctx.fillRect(0, 0, width, height);
        ctx.beginPath();
        ctx.moveTo(vertices[0].x, vertices[0].y);
        for (const p of vertices.slice(1)) ctx.lineTo(p.x, p.y);
        ctx.closePath();
        ctx.fillStyle = 'white';
        ctx.fill();
        const radius = feather / 100 * Math.min(width, height) / 4;
        if (radius > 0) {
            ctx.clip();
            // Minimum distance to any edge = darken of opaque grayscale strips
            // and endpoint discs. Clipping selects the inward side, including
            // concave corners. No Canvas filter, readback or per-pixel JS loop.
            ctx.globalCompositeOperation = 'darken';
            for (let i = 0; i < vertices.length; i++) {
                const a = vertices[i], b = vertices[(i + 1) % vertices.length];
                const length = Math.hypot(b.x - a.x, b.y - a.y);
                ctx.save();
                ctx.translate(a.x, a.y);
                ctx.rotate(Math.atan2(b.y - a.y, b.x - a.x));
                const strip = ctx.createLinearGradient(0, -radius, 0, radius);
                strip.addColorStop(0, 'white');
                strip.addColorStop(.5, 'black');
                strip.addColorStop(1, 'white');
                ctx.fillStyle = strip;
                ctx.fillRect(0, -radius, length, radius * 2);
                ctx.restore();
                const disc = ctx.createRadialGradient(a.x, a.y, 0, a.x, a.y, radius);
                disc.addColorStop(0, 'black');
                disc.addColorStop(1, 'white');
                ctx.fillStyle = disc;
                ctx.beginPath();
                ctx.arc(a.x, a.y, radius, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        ctx.restore();
    }
    return { MAX_POINTS, error, validParams, rasterize };
})();

if (typeof module !== 'undefined') module.exports = PolygonGeometry;
