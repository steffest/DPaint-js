// Revisioned filter intermediates and reuse helpers for spec 016 (Editor Performance),
// phase 6.5, design §7.
//
// A filter graph recomputes far too much while a slider drags. These pure helpers let the
// session reuse work WITHOUT changing any algorithm's output:
//
//   - an intermediate cache keyed by INPUT and PARAMETER revisions, so a pointwise node is
//     not recomputed when only a downstream parameter changed;
//   - an EXACT used-colour mapping: map each DISTINCT colour to its nearest palette index
//     once, then apply — byte-identical to the per-pixel exact remap, just cheaper;
//   - an optional coarse preview LUT that samples by cell centre (nearest/integer) and is
//     explicitly NOT exact — every entry is still a valid palette index (nearest membership);
//   - a scratch pool for reusable multi-pass buffers with early-exit return and blur
//     intermediate reuse.
//
// Clamping, channel order, and alpha handling match the existing pointwise adjustments.

import { nearestIndex } from "./filterKernels.js";

export const FILTER_DEPENDENCY = { POINTWISE: "pointwise", LOCAL: "local", GLOBAL: "global" };

// Revision-keyed intermediate cache. A node result is reused only when BOTH its input
// revision and its parameter revision are unchanged (design §7: cache by input/parameter
// revisions). Byte-budgeted with simple LRU eviction; recording dependency kind for
// diagnostics.
export function createIntermediateCache(options) {
    options = options || {};
    const budgetBytes = options.budgetBytes || 64 * 1024 * 1024;
    const entries = new Map(); // nodeId -> { value, byteSize, inputRevision, paramRevision, dependency, seq }
    let usedBytes = 0;
    let seq = 0;
    const counters = { hits: 0, misses: 0, evictions: 0 };

    function evictUntilFits(need) {
        if (usedBytes + need <= budgetBytes) return;
        // Evict least-recently-used entries.
        const ordered = Array.from(entries.entries()).sort((a, b) => a[1].seq - b[1].seq);
        for (const [key, e] of ordered) {
            if (usedBytes + need <= budgetBytes) break;
            entries.delete(key);
            usedBytes -= e.byteSize;
            counters.evictions++;
        }
    }

    function getOrCompute(nodeId, keys, compute) {
        keys = keys || {};
        const existing = entries.get(nodeId);
        if (existing && existing.inputRevision === keys.inputRevision && existing.paramRevision === keys.paramRevision) {
            existing.seq = ++seq; // touch for LRU
            counters.hits++;
            return { value: existing.value, hit: true };
        }
        counters.misses++;
        const value = compute();
        const byteSize = keys.byteSize || 0;
        if (existing) usedBytes -= existing.byteSize;
        evictUntilFits(byteSize);
        entries.set(nodeId, {
            value, byteSize,
            inputRevision: keys.inputRevision,
            paramRevision: keys.paramRevision,
            dependency: keys.dependency || FILTER_DEPENDENCY.POINTWISE,
            seq: ++seq,
        });
        usedBytes += byteSize;
        return { value, hit: false };
    }

    function invalidate(nodeId) { const e = entries.get(nodeId); if (e) { usedBytes -= e.byteSize; entries.delete(nodeId); } }
    function clear() { entries.clear(); usedBytes = 0; }

    return {
        getOrCompute,
        invalidate,
        clear,
        has: (nodeId) => entries.has(nodeId),
        getUsedBytes: () => usedBytes,
        size: () => entries.size,
        getCounters: () => Object.assign({}, counters),
    };
}

// Exact used-colour remap: compute the nearest palette index for each DISTINCT source colour
// exactly once, then map every pixel through it. Byte-identical to a per-pixel exact remap.
export function remapWithUsedColors(pixels, palette) {
    const n = pixels.length >> 2;
    const out = new Uint8Array(n);
    const cache = new Map(); // packed rgb -> index
    for (let i = 0; i < n; i++) {
        const b = i << 2;
        const r = pixels[b], g = pixels[b + 1], bl = pixels[b + 2];
        const key = (r << 16) | (g << 8) | bl;
        let idx = cache.get(key);
        if (idx === undefined) { idx = nearestIndex(r, g, bl, palette); cache.set(key, idx); }
        out[i] = idx;
    }
    return out;
}

// Optional coarse preview LUT. Cells per channel = 1 << bits; each cell maps to the nearest
// palette index of its CENTRE colour. Fast but explicitly approximate — never exact.
export function createPreviewLUT(palette, options) {
    options = options || {};
    const bits = options.bits || 4;
    const cells = 1 << bits;                 // per channel
    const shift = 8 - bits;
    const step = 256 / cells;
    const table = new Uint8Array(cells * cells * cells);
    const members = new Set();
    for (let ci = 0; ci < cells; ci++) {
        const r = Math.min(255, Math.round(ci * step + step / 2));
        for (let cj = 0; cj < cells; cj++) {
            const g = Math.min(255, Math.round(cj * step + step / 2));
            for (let ck = 0; ck < cells; ck++) {
                const b = Math.min(255, Math.round(ck * step + step / 2));
                const idx = nearestIndex(r, g, b, palette);
                table[(ci * cells + cj) * cells + ck] = idx;
                members.add(idx);
            }
        }
    }
    function sample(r, g, b) {
        const ci = r >> shift, cj = g >> shift, ck = b >> shift;
        return table[(ci * cells + cj) * cells + ck];
    }
    return {
        sample,
        isExact: () => false,
        members: () => new Set(members),   // palette indices reachable through this LUT
        cellsPerChannel: () => cells,
    };
}

// Build a per-channel 256-entry brightness LUT (clamped). Applied to RGB, alpha untouched.
export function brightnessLUT(delta) {
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) lut[i] = i + delta; // Uint8ClampedArray clamps to [0,255]
    return lut;
}

// Apply a per-channel LUT to RGB, preserving alpha exactly. Returns a NEW buffer.
export function applyChannelLUT(pixels, lut) {
    const out = new Uint8ClampedArray(pixels.length);
    for (let i = 0; i < pixels.length; i += 4) {
        out[i] = lut[pixels[i]];
        out[i + 1] = lut[pixels[i + 1]];
        out[i + 2] = lut[pixels[i + 2]];
        out[i + 3] = pixels[i + 3]; // alpha preserved
    }
    return out;
}

// A scratch buffer pool for reusable multi-pass work. acquire returns a buffer of at least
// the requested length (reused when possible); release returns it for the next pass. Reuse
// never changes results — buffers are always fully overwritten by their consumer.
export function createScratchPool(options) {
    options = options || {};
    const free = []; // { ctor, buf }
    const counters = { allocations: 0, reuses: 0, released: 0 };

    function acquire(ctor, length) {
        for (let i = 0; i < free.length; i++) {
            const slot = free[i];
            if (slot.ctor === ctor && slot.buf.length >= length) {
                free.splice(i, 1);
                counters.reuses++;
                return slot.buf;
            }
        }
        counters.allocations++;
        return new ctor(length);
    }
    function release(buf) {
        if (!buf) return;
        counters.released++;
        free.push({ ctor: buf.constructor, buf });
    }
    // Run `fn(buf)` with a scratch buffer, returning it even if fn throws or early-exits.
    function withScratch(ctor, length, fn) {
        const buf = acquire(ctor, length);
        try { return fn(buf); }
        finally { release(buf); }
    }
    return { acquire, release, withScratch, freeCount: () => free.length, getCounters: () => Object.assign({}, counters) };
}
