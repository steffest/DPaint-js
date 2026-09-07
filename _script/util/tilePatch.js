// Transactional raster tile patches for spec 016 (Editor Performance),
// phase 5.1, design §5.
//
// Today a raster undo step duplicates the WHOLE layer canvas twice (from + to). For a
// sparse stroke on a large image that is enormous and mostly unchanged. This module
// records only the 128×128 tiles a gesture actually touches:
//
//   - the FIRST write to a tile captures its before-image once (repeated writes to the
//     same tile during the drag do not re-capture),
//   - at commit we read each touched tile's after-image and keep ONLY the tiles that
//     actually changed (a draw-then-erase-back gesture retains nothing),
//   - an unknown-bounds operation falls back to a single full-layer patch.
//
// Everything is byte-accounted so the history budget (rasterHistory.js) can reserve
// before it grows. It is pure and injectable: pixel access goes through a `readRegion`
// callback returning a comparable pixel buffer (a Uint8ClampedArray in the live app, any
// array in tests), so this records and diffs tiles without touching a canvas.
//
// A RasterHistoryEntry patch is:
//   { tileX, tileY, x, y, width, height, before, after, byteSize }
// where x/y/width/height are the tile's clipped half-open bounds in layer pixels and
// tileX/tileY are its grid indices (design §4 PixelPatch, with explicit layer bounds).

export const DEFAULT_TILE_SIZE = 128;

// The clipped half-open tiles that overlap `rect` within a layer of width×height.
// Edge tiles are clipped to the layer, so their width/height can be < tileSize.
export function tilesForRect(rect, width, height, tileSize) {
    tileSize = tileSize || DEFAULT_TILE_SIZE;
    const clip = clampRect(rect, width, height);
    if (!clip) return [];
    const tx0 = Math.floor(clip.x / tileSize);
    const ty0 = Math.floor(clip.y / tileSize);
    const tx1 = Math.floor((clip.x + clip.width - 1) / tileSize);
    const ty1 = Math.floor((clip.y + clip.height - 1) / tileSize);
    const tiles = [];
    for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
            const x0 = tx * tileSize;
            const y0 = ty * tileSize;
            const x1 = Math.min(x0 + tileSize, width);
            const y1 = Math.min(y0 + tileSize, height);
            if (x1 > x0 && y1 > y0) tiles.push({ tileX: tx, tileY: ty, x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
        }
    }
    return tiles;
}

function clampRect(rect, width, height) {
    if (!rect) return null;
    const x = Math.max(0, Math.floor(rect.x));
    const y = Math.max(0, Math.floor(rect.y));
    const x1 = Math.min(width, Math.ceil(rect.x + rect.width));
    const y1 = Math.min(height, Math.ceil(rect.y + rect.height));
    if (x1 <= x || y1 <= y) return null;
    return { x, y, width: x1 - x, height: y1 - y };
}

// Compare two pixel buffers for exact byte equality (used to drop unchanged tiles).
export function buffersEqual(a, b) {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

function bufferBytes(buf) {
    if (!buf) return 0;
    // A typed array reports byteLength; a plain test array falls back to length.
    return buf.byteLength != null ? buf.byteLength : buf.length;
}

// Create a transaction-scoped tile-patch recorder for one layer.
// options: { width, height, readRegion(x,y,w,h) -> pixelBuffer, tileSize }
export function createPatchRecorder(options) {
    options = options || {};
    const width = options.width | 0;
    const height = options.height | 0;
    const tileSize = options.tileSize || DEFAULT_TILE_SIZE;
    const readRegion = options.readRegion;
    if (typeof readRegion !== "function") throw new Error("tilePatch: readRegion is required");

    const captured = new Map(); // "tx,ty" -> { tile, before, byteSize }
    let fullFallback = null;    // { x,y,width,height, before, byteSize } when bounds unknown
    let beforeBytes = 0;

    // Capture before-images for every tile `rect` touches that has not been captured yet.
    // Returns the number of NEW before bytes captured (so the caller can reserve budget).
    function beforeWrite(rect) {
        if (fullFallback) return 0; // already whole-layer; nothing finer to add
        const tiles = tilesForRect(rect, width, height, tileSize);
        let added = 0;
        for (const tile of tiles) {
            const key = tile.tileX + "," + tile.tileY;
            if (captured.has(key)) continue;
            const before = readRegion(tile.x, tile.y, tile.width, tile.height);
            const byteSize = bufferBytes(before);
            captured.set(key, { tile, before, byteSize });
            beforeBytes += byteSize;
            added += byteSize;
        }
        return added;
    }

    // Unknown-bounds operation: capture the whole layer once as a single patch. Any
    // tile-level captures are superseded. Returns the before bytes reserved.
    function beforeWriteFullLayer() {
        if (fullFallback) return 0;
        captured.clear();
        const before = readRegion(0, 0, width, height);
        const byteSize = bufferBytes(before);
        fullFallback = { x: 0, y: 0, width, height, before, byteSize };
        beforeBytes = byteSize;
        return byteSize;
    }

    // At commit: read after-images and keep only changed tiles. Returns
    //   { patches:[...], byteSize, changedTiles, full:boolean }
    // An empty patches array means the gesture was a net no-op (design §5: no-op/cancel).
    function captureAfter() {
        if (fullFallback) {
            const after = readRegion(0, 0, width, height);
            const changed = !buffersEqual(fullFallback.before, after);
            if (!changed) return { patches: [], byteSize: 0, changedTiles: 0, full: true };
            const afterBytes = bufferBytes(after);
            const patch = {
                tileX: 0, tileY: 0, x: 0, y: 0, width, height,
                before: fullFallback.before, after,
                byteSize: fullFallback.byteSize + afterBytes,
            };
            return { patches: [patch], byteSize: patch.byteSize, changedTiles: 1, full: true };
        }
        const patches = [];
        let byteSize = 0;
        for (const entry of captured.values()) {
            const t = entry.tile;
            const after = readRegion(t.x, t.y, t.width, t.height);
            if (buffersEqual(entry.before, after)) continue; // unchanged -> drop
            const afterBytes = bufferBytes(after);
            const patch = {
                tileX: t.tileX, tileY: t.tileY, x: t.x, y: t.y, width: t.width, height: t.height,
                before: entry.before, after, byteSize: entry.byteSize + afterBytes,
            };
            patches.push(patch);
            byteSize += patch.byteSize;
        }
        return { patches, byteSize, changedTiles: patches.length, full: false };
    }

    return {
        beforeWrite,
        beforeWriteFullLayer,
        captureAfter,
        getReservedBeforeBytes: () => beforeBytes,
        capturedTileCount: () => (fullFallback ? 1 : captured.size),
        isFullFallback: () => !!fullFallback,
    };
}

// Apply a patch's before (undo) or after (redo) image via an injected writer.
// writeRegion(x,y,w,h,buffer) puts the pixels back. Order within a record is preserved
// (design §5: "do not skip dependencies within a record").
export function applyPatches(patches, direction, writeRegion) {
    if (!patches) return 0;
    let applied = 0;
    for (const p of patches) {
        const buffer = direction === "redo" ? p.after : p.before;
        writeRegion(p.x, p.y, p.width, p.height, buffer);
        applied++;
    }
    return applied;
}
