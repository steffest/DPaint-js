// Render target ownership & pooling for spec 016 (Editor Performance),
// phase 4.2, design §3.3/§4/§5.
//
// The renderer hands out two kinds of surfaces with deliberately different contracts:
//
//   BorrowedView  — valid ONLY until the next render on that view. The caller must not
//                   retain or release it. It may alias a live/reused target, so caching
//                   it requires copying first. Using it after it is superseded throws.
//
//   OwnedFrame    — stable until the caller calls release() (idempotent). Caches store
//                   OwnedFrames. It never aliases a live document/layer canvas; obtaining
//                   one from a borrowed/live source copies.
//
// Persistent targets are pooled per {width,height,backend,variant}: same-size renders
// reuse storage, a different size allocates a new target (the old one returns to the
// pool for its own key). Allocation is admitted against a byte budget; when full, idle
// pooled targets are evicted (LRU) before allocating, and if it still does not fit the
// request fails safely (returns null) rather than overcommitting. Releasing a target
// NEVER resizes or deletes a borrowed document canvas — that belongs to the caller
// (design §5: "never resizes borrowed document canvases").
//
// The surface factory is injected (`createSurface({width,height})` -> surface with a
// `.byteSize`), so this is unit-testable with a fake surface counting allocate/free.

const DEFAULT_BUDGET = 64 * 1024 * 1024; // engineering starting value; see design §5

export function createRenderTargets(options) {
    options = options || {};
    const createSurface = options.createSurface || defaultCreateSurface;
    const destroySurface = options.destroySurface || defaultDestroySurface;
    const budgetBytes = options.budgetBytes || DEFAULT_BUDGET;

    let usedBytes = 0;
    let clock = 0; // monotonic tick for LRU
    const pool = new Map();        // key -> { surface, inUse, lastUsed, byteSize }
    const borrowedByView = new Map(); // viewId -> current borrowed token (generation)

    const counters = { allocations: 0, reuses: 0, evictions: 0, frees: 0, admissionFailures: 0, sourceCopies: 0 };

    function key(width, height, backend, variant) {
        return (backend || "canvas") + "|" + (variant || "editor-raster") + "|" + width + "x" + height;
    }

    function estimateBytes(width, height) { return width * height * 4; }

    // Evict idle (not in-use) pooled targets, oldest first, until `need` bytes fit or
    // there is nothing left to evict. Returns true if enough room was freed.
    function evictUntilFits(need) {
        if (usedBytes + need <= budgetBytes) return true;
        const idle = [];
        for (const [k, entry] of pool) if (!entry.inUse) idle.push([k, entry]);
        idle.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
        for (const [k, entry] of idle) {
            if (usedBytes + need <= budgetBytes) break;
            pool.delete(k);
            usedBytes -= entry.byteSize;
            destroySurface(entry.surface);
            counters.evictions++;
            counters.frees++;
        }
        return usedBytes + need <= budgetBytes;
    }

    // Acquire a pooled persistent target. Returns a surface (marked in-use) or null if it
    // cannot be admitted. Same-key idle targets are reused without reallocating.
    function acquireTarget(width, height, backend, variant) {
        if (!(width > 0) || !(height > 0)) return null;
        const k = key(width, height, backend, variant);
        const existing = pool.get(k);
        if (existing && !existing.inUse) {
            existing.inUse = true;
            existing.lastUsed = ++clock;
            counters.reuses++;
            return existing.surface;
        }
        const need = estimateBytes(width, height);
        if (!evictUntilFits(need)) { counters.admissionFailures++; return null; }
        const surface = createSurface({ width, height, backend, variant });
        const byteSize = (surface && surface.byteSize) || need;
        pool.set(k, { surface, inUse: true, lastUsed: ++clock, byteSize });
        usedBytes += byteSize;
        counters.allocations++;
        return surface;
    }

    // Return a pooled target to the idle set (available for same-key reuse). Idempotent.
    function releaseTarget(width, height, backend, variant) {
        const entry = pool.get(key(width, height, backend, variant));
        if (entry && entry.inUse) { entry.inUse = false; entry.lastUsed = ++clock; }
    }

    // Produce a BorrowedView for a view. Any previously outstanding borrowed token for
    // this view is invalidated: touching it after this throws, catching retain-after-render
    // bugs. The view's payload (a surface) is supplied by the caller's render.
    function makeBorrowedView(viewId, surface, meta) {
        const token = (borrowedByView.get(viewId) || 0) + 1;
        borrowedByView.set(viewId, token);
        const self = {
            viewId,
            surface,
            meta: meta || {},
            get valid() { return borrowedByView.get(viewId) === token; },
            read() {
                if (borrowedByView.get(viewId) !== token) {
                    throw new Error("renderTargets: BorrowedView used after it was superseded (copy it before caching)");
                }
                return surface;
            },
            // Borrowed views must NOT be released by the caller; calling it is a no-op that
            // flags the misuse rather than freeing shared storage.
            release() { self._misusedRelease = true; },
        };
        return self;
    }

    // Copy a borrowed/live source into a freshly owned frame so it can be cached safely
    // (design §3.3: "copying a borrowed/live source is mandatory before caching").
    // `copyInto(dst, src)` is injected; the OwnedFrame owns its surface and frees it once.
    function makeOwnedFrameFromSource(width, height, source, copyInto, backend, variant) {
        const surface = acquireTarget(width, height, backend, variant || "baked");
        if (!surface) return null;
        if (copyInto) { copyInto(surface, source); counters.sourceCopies++; }
        return wrapOwned(surface, width, height, backend, variant || "baked");
    }

    function wrapOwned(surface, width, height, backend, variant) {
        let released = false;
        const frame = {
            surface, width, height, backend, variant,
            get released() { return released; },
            release() {
                if (released) return; // idempotent
                released = true;
                releaseTarget(width, height, backend, variant);
            },
        };
        return frame;
    }

    function getUsedBytes() { return usedBytes; }
    function getCounters() { return Object.assign({}, counters); }
    function stats() {
        let inUse = 0, idle = 0;
        for (const e of pool.values()) (e.inUse ? inUse++ : idle++);
        return { poolSize: pool.size, inUse, idle, usedBytes, budgetBytes };
    }

    function disposeAll() {
        for (const entry of pool.values()) { destroySurface(entry.surface); counters.frees++; }
        pool.clear();
        usedBytes = 0;
        borrowedByView.clear();
    }

    return {
        acquireTarget,
        releaseTarget,
        makeBorrowedView,
        makeOwnedFrameFromSource,
        wrapOwned,
        getUsedBytes,
        getCounters,
        stats,
        disposeAll,
    };
}

function defaultCreateSurface(spec) {
    if (typeof document === "undefined") {
        return { width: spec.width, height: spec.height, byteSize: spec.width * spec.height * 4 };
    }
    const canvas = document.createElement("canvas");
    canvas.width = spec.width;
    canvas.height = spec.height;
    canvas.byteSize = spec.width * spec.height * 4;
    return canvas;
}
function defaultDestroySurface(surface) {
    // Match releaseCanvas' Safari workaround without importing it (avoid a Palette dep).
    if (surface && typeof surface.width === "number") { try { surface.width = 1; surface.height = 1; } catch (e) {} }
}
