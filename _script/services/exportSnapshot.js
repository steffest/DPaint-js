// Immutable export snapshot + owned-frame iterator for spec 016 (Editor Performance), phase 10.1,
// design §9.
//
// Animation export must consume a BOUNDED number of rendered frames from ONE frozen revision,
// while the user keeps editing the live document. The snapshot captures immutable source cels/
// properties/palette once — copying each UNIQUE mutable source a single time (frames that share
// a cel do not copy it twice) — and reserves that memory up front: if admission fails, it rejects
// before any encoding so there is never a partially mixed export. The iterator yields OWNED
// frames with an explicit `release()`; early return / abort / a per-frame allocation failure all
// release every owned resource.

// `options`:
//   frames: [{ index, celIds: [...] }]      the frames to export, in order
//   cels:   { [celId]: { source, byteSize } } mutable live sources
//   palette, properties                      immutable metadata (captured by reference-copy)
//   documentRevision                         frozen; later live edits do not affect the snapshot
//   reserve(bytes) -> boolean                budget admission (returns false if it cannot fit)
//   copySource(source) -> ownedCopy          deep copy of a mutable source
//   releaseSource(ownedCopy)                 free a copied source (idempotent)
export function createExportSnapshot(options) {
    options = options || {};
    const reserve = options.reserve || (() => true);
    const copySource = options.copySource || ((s) => s);
    const releaseSource = options.releaseSource || (() => {});
    const cels = options.cels || {};

    const copies = new Map();  // celId -> owned copy (unique sources only)
    let reservedBytes = 0;
    let released = false;

    // Copy each unique referenced cel exactly once, reserving its bytes first. On any admission
    // failure, roll back everything copied so far and signal rejection (no partial snapshot).
    const uniqueCelIds = new Set();
    for (const f of (options.frames || [])) for (const id of (f.celIds || [])) uniqueCelIds.add(id);

    let admitted = true;
    for (const id of uniqueCelIds) {
        const cel = cels[id];
        if (!cel) continue;
        const bytes = cel.byteSize | 0;
        if (!reserve(bytes)) { admitted = false; break; }
        reservedBytes += bytes;
        copies.set(id, copySource(cel.source));
    }
    if (!admitted) {
        for (const copy of copies.values()) releaseSource(copy);
        copies.clear();
        reservedBytes = 0;
        return null; // reject before encoding
    }

    const frames = (options.frames || []).map((f) => ({ index: f.index, celIds: (f.celIds || []).slice() }));

    return {
        revision: options.documentRevision,          // frozen snapshot identity
        palette: options.palette,
        properties: options.properties,
        frameCount: frames.length,
        getReservedBytes: () => reservedBytes,        // measured separately from encoded output
        // Copied (immutable) sources for a frame — the same copy object for a shared cel.
        getFrameSources(index) {
            const f = frames.find((x) => x.index === index);
            if (!f) return null;
            return f.celIds.map((id) => copies.get(id));
        },
        frames: () => frames.slice(),
        isReleased: () => released,
        release() {
            if (released) return;
            released = true;
            for (const copy of copies.values()) releaseSource(copy);
            copies.clear();
            reservedBytes = 0;
        },
    };
}

// Async iterator over baked owned frames of a snapshot. `evaluate(index, snapshot)` produces an
// OWNED frame ({ index, frame, byteSize, release() }). Explicit per-frame release; early `return`
// or an aborted `signal` releases the in-hand frame and (if `releaseSnapshotOnDone`) the snapshot;
// a per-frame allocation failure cleans up then rethrows.
export async function* iterateFrames(snapshot, opts) {
    opts = opts || {};
    const evaluate = opts.evaluate;
    const signal = opts.signal;
    const range = opts.range || { start: 0, end: snapshot.frameCount - 1 };
    let current = null;

    const releaseCurrent = () => { if (current && typeof current.release === "function") current.release(); current = null; };

    try {
        const list = snapshot.frames();
        for (let i = range.start; i <= range.end; i++) {
            if (signal && signal.aborted) throw makeAbort();
            const entry = list[i];
            if (!entry) continue;
            let owned;
            try {
                owned = await evaluate(entry.index, snapshot); // may throw on allocation failure
            } catch (e) {
                releaseCurrent();
                throw e; // caller stops the export; finally releases the snapshot
            }
            current = owned;
            yield owned;                 // ownership moves to the consumer, which releases it
            current = null;              // consumed: on a normal resume it is no longer ours
        }
    } finally {
        releaseCurrent();                // early return / throw / abort: release the in-hand frame
        if (opts.releaseSnapshotOnDone) snapshot.release();
    }
}

function makeAbort() {
    const e = new Error("export aborted");
    e.name = "AbortError";
    return e;
}
