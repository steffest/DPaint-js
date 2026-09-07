// Bounded owned-frame cache for spec 016 (Editor Performance), phases 8.1 + 8.2, design §4/§5/§8.
//
// Warm playback reuses correct rendered frames within a fixed byte budget. The cache stores
// ONLY owned frames (idempotent `release()`), never a borrowed/live/mutable layer alias — a
// borrowed source that can change must be copied before it is admitted. Identity is the full
// render key (generation + frame + variant + dimensions + revisions + backend), so an
// editor-raster frame and a baked frame of the same index are distinct entries and a stale
// revision never returns.
//
// Admission: pinned frames count against the budget; a frame larger than the whole budget
// BYPASSES caching (owned by the presenter, not an oversized cache exception); otherwise evict
// unpinned LRU until it fits. Active document sources are never destroyed by the cache.

export const RENDER_VARIANT = {
    EDITOR_RASTER: "editor-raster", // excludes SVG-overlay vector-display layers
    BAKED: "baked",                 // includes them
    THUMBNAIL: "thumbnail",
    FILTER_PREVIEW: "filter-preview",
};

// Deterministic string identity for a frame. Zoom is deliberately absent — this is a
// document-resolution key; viewport-rasterized output includes its own dimensions instead.
export function makeFrameKey(k) {
    const dim = k.dimensions ? (k.dimensions.w + "x" + k.dimensions.h) : "?";
    return [
        "g" + (k.documentGeneration | 0),
        "f" + (k.frameIndex | 0),
        (k.variant || RENDER_VARIANT.BAKED),
        dim,
        "d" + (k.dependencyRevision != null ? k.dependencyRevision : "?"),
        "p" + (k.paletteRevision != null ? k.paletteRevision : "?"),
        "x" + (k.filterRevision != null ? k.filterRevision : "?"),
        (k.backend || "reference"),
    ].join("|");
}

const MiB = 1024 * 1024;

export function createFrameCache(options) {
    options = options || {};
    const budgetBytes = options.budgetBytes != null ? options.budgetBytes : 64 * MiB;

    const entries = new Map(); // key -> { key, frame, byteSize, pinCount, lastUsed }
    let usedBytes = 0;
    let clock = 0;             // monotonic LRU stamp
    let prefetchGen = 0;       // bumped on scrub/stop/open to cancel in-flight prefetch admits
    const counters = { hits: 0, misses: 0, admitted: 0, evicted: 0, bypassed: 0, rejected: 0, invalidated: 0 };

    function releaseFrame(frame) { if (frame && typeof frame.release === "function") frame.release(); }

    // Look up a cached frame; a hit bumps its recency. Never returns a stale key by construction
    // (revisions are part of the key).
    function get(key) {
        const e = entries.get(key);
        if (!e) { counters.misses++; return null; }
        e.lastUsed = ++clock;
        counters.hits++;
        return e.frame;
    }

    function has(key) { return entries.has(key); }

    function evictOne() {
        let victim = null;
        for (const e of entries.values()) {
            if (e.pinCount > 0) continue;            // pinned frames are never evicted
            if (!victim || e.lastUsed < victim.lastUsed) victim = e;
        }
        if (!victim) return false;
        entries.delete(victim.key);
        usedBytes -= victim.byteSize;
        counters.evicted++;
        releaseFrame(victim.frame);
        if (options.onEvict) options.onEvict(victim.key);
        return true;
    }

    // Admit an OWNED frame. `frame` must be a copy: a borrowed/live alias is refused so the
    // cache can never destroy a document source or return a mutated buffer.
    // Returns { cached, frame } — when not cached the presenter owns `frame`.
    function admit(key, frame, opts) {
        opts = opts || {};
        const byteSize = frame.byteSize | 0;
        if (frame.borrowed) { counters.rejected++; return { cached: false, frame }; } // never cache a fast-path alias
        if (byteSize > budgetBytes) { counters.bypassed++; return { cached: false, frame }; } // oversized bypass

        if (entries.has(key)) {                       // replace an existing entry in place
            const prev = entries.get(key);
            usedBytes -= prev.byteSize;
            if (prev.frame !== frame) releaseFrame(prev.frame);
            entries.delete(key);
        }
        while (usedBytes + byteSize > budgetBytes) {
            if (!evictOne()) {                        // everything left is pinned
                counters.rejected++;
                return { cached: false, frame };       // presenter keeps ownership; nothing destroyed
            }
        }
        entries.set(key, { key, frame, byteSize, pinCount: opts.pin ? 1 : 0, lastUsed: ++clock });
        usedBytes += byteSize;
        counters.admitted++;
        return { cached: true, frame };
    }

    function pin(key) { const e = entries.get(key); if (e) { e.pinCount++; return true; } return false; }
    function unpin(key) { const e = entries.get(key); if (e && e.pinCount > 0) { e.pinCount--; return true; } return false; }

    // Stale invalidation: release and drop every entry whose key matches `predicate` (pinned or
    // not — a stale frame must not survive). `pred === true` clears the whole cache.
    function invalidate(predicate) {
        const drop = [];
        for (const e of entries.values()) {
            if (predicate === true || predicate(e.key, e)) drop.push(e);
        }
        for (const e of drop) {
            entries.delete(e.key);
            usedBytes -= e.byteSize;
            counters.invalidated++;
            releaseFrame(e.frame);
        }
        return drop.length;
    }

    // Prefetch generation: a scrub/stop/open bumps it so any not-yet-admitted prefetch result is
    // rejected + released instead of polluting the cache with now-irrelevant frames.
    function startPrefetch() { return ++prefetchGen; }
    function admitPrefetched(key, frame, gen, opts) {
        if (gen !== prefetchGen) { counters.rejected++; releaseFrame(frame); return { cached: false, frame: null }; }
        return admit(key, frame, opts);
    }

    function disposeAll() { invalidate(true); usedBytes = 0; }

    return {
        get, has, admit, pin, unpin, invalidate,
        startPrefetch, admitPrefetched, disposeAll,
        getUsedBytes: () => usedBytes,
        getBudgetBytes: () => budgetBytes,
        size: () => entries.size,
        getPrefetchGeneration: () => prefetchGen,
        getCounters: () => Object.assign({}, counters),
    };
}

// Bounded forward prefetch plan: up to `windowSize` frames after `currentFrame`, wrapping the
// inclusive loop, excluding the current frame. Obeys the caller's byte/job limits externally.
export function planPrefetch(currentFrame, loopStart, loopEnd, windowSize) {
    windowSize = windowSize != null ? windowSize : 2;
    const len = loopEnd - loopStart + 1;
    if (len <= 1 || windowSize <= 0) return [];
    const out = [];
    for (let i = 1; i <= windowSize && i < len; i++) {
        out.push(loopStart + (((currentFrame - loopStart) + i) % len));
    }
    return out;
}
