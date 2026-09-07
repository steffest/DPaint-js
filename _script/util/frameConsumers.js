// GIF / IFF frame-consumer state for spec 016 (Editor Performance), phase 10.3, design §9.
//
// The streaming iterator (phase 10.1) feeds indexed animation encoders one owned frame at a
// time. These pure helpers carry the per-frame ENCODER state those formats need while retaining
// their existing semantics: GIF inter-frame delta rectangles + disposal + palette-change
// detection, a bounded two-pass color histogram for palette optimization over the immutable
// snapshot, and HAM scanline base-color state. No DOM, no canvas — arrays in, state out.

// GIF frame consumer: diff each incoming indexed frame against the previous to emit the minimal
// changed rectangle + a disposal method, and flag palette changes.
export function createGifFrameConsumer(options) {
    options = options || {};
    let prev = null;         // previous frame's indices (Uint8-like array)
    let prevPalette = null;
    const width = options.width | 0;
    const height = options.height | 0;

    // Returns { rect, disposal, paletteChanged, isKeyFrame }.
    // rect is the changed bounding box {x,y,width,height}, or null when nothing changed.
    function consume(indices, palette) {
        const paletteChanged = prevPalette != null && !palettesEqual(prevPalette, palette);
        let rect;
        let isKeyFrame = false;
        if (!prev || paletteChanged) {
            // First frame, or a palette change forces a full frame (indices remap meaning).
            rect = { x: 0, y: 0, width, height };
            isKeyFrame = true;
        } else {
            rect = changedRect(prev, indices, width, height);
        }
        // Disposal: a frame that fully covers the canvas can be replaced; a partial delta keeps
        // the previous pixels (do-not-dispose) so the unchanged region shows through.
        const disposal = isKeyFrame ? "restore-background" : "none";
        prev = indices.slice ? indices.slice() : Array.prototype.slice.call(indices);
        prevPalette = palette ? palette.slice() : null;
        return { rect, disposal, paletteChanged, isKeyFrame };
    }

    return { consume, reset() { prev = null; prevPalette = null; } };
}

function palettesEqual(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

// Minimal bounding box of differing indices between two equal-size frames, or null if identical.
export function changedRect(prev, curr, width, height) {
    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y++) {
        const row = y * width;
        for (let x = 0; x < width; x++) {
            if (prev[row + x] !== curr[row + x]) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
    }
    if (maxX < 0) return null; // identical
    return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

// Bounded two-pass color histogram for palette optimization over the immutable snapshot. The
// distinct-color map is capped at `maxColors`; once full, further new colors increment an
// overflow counter (count-frequency callers keep their exact counts for retained colors).
export function createBoundedHistogram(maxColors) {
    maxColors = maxColors || 256;
    const counts = new Map(); // packed RGB -> count
    let overflow = 0;

    function add(packedRGB, n) {
        n = n || 1;
        if (counts.has(packedRGB)) { counts.set(packedRGB, counts.get(packedRGB) + n); return true; }
        if (counts.size >= maxColors) { overflow += n; return false; } // bounded — do not grow past cap
        counts.set(packedRGB, n);
        return true;
    }

    return {
        add,
        distinctCount: () => counts.size,
        getOverflow: () => overflow,
        // Sorted by frequency (descending) — the input to palette selection.
        topColors(limit) {
            const arr = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
            return (limit ? arr.slice(0, limit) : arr).map((e) => ({ color: e[0], count: e[1] }));
        },
        reset() { counts.clear(); overflow = 0; },
    };
}

// HAM scanline state: HAM encodes each pixel relative to the pixel to its LEFT (or a base color
// at the start of a scanline), choosing to set a full palette color or modify one of R/G/B. This
// tracks the running color per scanline so the encoder resets at each new row.
export function createHamScanlineState(baseColor) {
    baseColor = baseColor || { r: 0, g: 0, b: 0 };
    let running = { r: baseColor.r, g: baseColor.g, b: baseColor.b };

    return {
        // Start a new scanline: HAM begins each row from the base color, not the previous row's
        // trailing pixel.
        startScanline() { running = { r: baseColor.r, g: baseColor.g, b: baseColor.b }; },
        // Advance one pixel. `mode` is 'set' (full palette color) or 'modR'/'modG'/'modB'.
        step(mode, value) {
            if (mode === "set") running = { r: value.r, g: value.g, b: value.b };
            else if (mode === "modR") running = { r: value, g: running.g, b: running.b };
            else if (mode === "modG") running = { r: running.r, g: value, b: running.b };
            else if (mode === "modB") running = { r: running.r, g: running.g, b: value };
            return { r: running.r, g: running.g, b: running.b };
        },
        current: () => ({ r: running.r, g: running.g, b: running.b }),
    };
}
