// Budgeted transactional raster history for spec 016 (Editor Performance),
// phase 5.2/5.3, design §5.
//
// Sits alongside the existing HistoryService (services/historyservice.js), which keeps
// its structural/vector/property/timeline branches untouched. This module owns the
// RASTER branch as tile-patch records (util/tilePatch.js) with an explicit byte budget:
//
//   - records are resolved by OWNING cel/layer IDENTITY, not by an index that structural
//     edits shuffle (design §5 / §3.1) — the same reason the existing code resolves
//     through getLayerInTarget;
//   - a byte budget (128 MiB default, INCLUDING redo) admits new bytes by evicting the
//     OLDEST complete unpinned records chronologically, never splitting a record;
//   - a transaction reserves before/after capacity as its damage grows; if it cannot fit
//     even after eviction it ROLLS BACK (restores before-images) and reports an
//     actionable error — an oversized edit is never silently committed non-undoably;
//   - legacy structural/vector/property records pass through as opaque entries so the two
//     history layers interleave in one chronological order.
//
// Pure and injectable: no DOM, no EventBus. The live wiring (routing raster tools through
// beginTransaction and applying patches on undo/redo) is layered on separately; these
// semantics are unit-tested with plain buffers and a fake clock.

import { applyPatches } from "../util/tilePatch.js";

export const DEFAULT_HISTORY_BUDGET = 128 * 1024 * 1024;

export function createRasterHistory(options) {
    options = options || {};
    const budgetBytes = options.budgetBytes || DEFAULT_HISTORY_BUDGET;
    const onError = options.onError || (() => {});
    const writeRegion = options.writeRegion; // (x,y,w,h,buffer) for undo/redo application

    let history = []; // most-recent-LAST (chronological); undo pops the end
    let future = [];  // redo stack, most-recent-first
    let usedBytes = 0;
    let reservedBytes = 0; // bytes reserved by the active transaction, not yet committed
    let seq = 0;

    function totalBytes() { return usedBytes + reservedBytes; }

    // Evict oldest complete unpinned records until `need` free bytes exist (excluding the
    // active reservation), or nothing is left to evict. A record is atomic — we evict the
    // whole thing (design §5: "do not skip dependencies within a record"). Returns true if
    // enough room was freed. Redo entries count toward the budget and are evicted first
    // (oldest overall), matching "128 MiB including redo".
    function evictUntilFits(need) {
        if (totalBytes() + need <= budgetBytes) return true;
        // Build a chronological, evictable view: redo (future) is discardable first as it
        // is not part of the linear past; then oldest history records.
        while (totalBytes() + need > budgetBytes && future.length) {
            const rec = future.pop(); // oldest redo (future is most-recent-first, tail = oldest)
            if (rec.pinned) { future.unshift(rec); break; }
            usedBytes -= rec.byteSize;
        }
        while (totalBytes() + need > budgetBytes && history.length) {
            const rec = history[0];
            if (rec.pinned) break; // cannot evict a pinned record; stop (fail safe)
            history.shift();
            usedBytes -= rec.byteSize;
        }
        return totalBytes() + need <= budgetBytes;
    }

    // Reserve `bytes` for the active transaction as its damage grows. Evicts if needed.
    // Returns true if reserved, false if it will not fit even after eviction.
    function reserve(bytes) {
        if (!(bytes > 0)) return true;
        if (!evictUntilFits(bytes)) return false;
        reservedBytes += bytes;
        return true;
    }

    function releaseReservation() { reservedBytes = 0; }

    // Begin a raster transaction for a target identity. `estimateBytes` is a conservative
    // preflight reservation (design §5: "An unknown-size operation reserves a conservative
    // full result before it mutates"). Returns null if even the preflight cannot fit — the
    // caller must not begin mutating.
    function beginTransaction(spec) {
        spec = spec || {};
        const identity = spec.identity;
        const preflight = spec.estimateBytes || 0;
        if (preflight > 0 && !reserve(preflight)) {
            onError({ kind: "budget", phase: "preflight", identity, requested: preflight });
            return null;
        }
        let committed = false;
        let rolledBack = false;
        let reservedForTx = preflight;

        const tx = {
            identity,
            operation: spec.operation,
            // Grow the reservation as more tiles are captured. Returns false on failure;
            // the caller then rolls back and restores before-images.
            grow(bytes) {
                if (committed || rolledBack) throw new Error("rasterHistory: grow after end");
                if (!reserve(bytes)) return false;
                reservedForTx += bytes;
                return true;
            },
            // Finalize with the actual patches captured at commit. Reserved bytes become
            // used bytes sized to the real result. Clears the redo stack (a new edit
            // invalidates redo). Returns the stored record, or null for a net no-op.
            commit(result, metadata) {
                if (committed || rolledBack) throw new Error("rasterHistory: commit after end");
                committed = true;
                releaseReservationForTx();
                const patches = (result && result.patches) || [];
                if (!patches.length) { future = []; return null; } // no-op gesture: nothing to record
                const byteSize = result.byteSize || 0;
                // The reservation already guaranteed room; account the real bytes.
                usedBytes += byteSize;
                const record = {
                    id: ++seq,
                    type: "raster",
                    identity,
                    operation: spec.operation,
                    patches,
                    metadataBefore: metadata && metadata.before,
                    metadataAfter: metadata && metadata.after,
                    byteSize,
                    pinned: !!(metadata && metadata.pinned),
                    full: !!result.full,
                };
                history.push(record);
                future = []; // redo-clear
                return record;
            },
            rollback() {
                if (committed) return;
                rolledBack = true;
                releaseReservationForTx();
                if (typeof spec.restore === "function") spec.restore();
            },
        };

        function releaseReservationForTx() {
            reservedBytes -= reservedForTx;
            if (reservedBytes < 0) reservedBytes = 0;
            reservedForTx = 0;
        }

        return tx;
    }

    // Record a legacy (non-raster) history step as an opaque entry so both layers share
    // one chronological order. byteSize defaults to 0 (the existing service owns its own
    // 20-entry cap); pass one to have it participate in the byte budget.
    function pushLegacy(entry) {
        const record = {
            id: ++seq,
            type: entry.type || "legacy",
            identity: entry.identity,
            legacy: true,
            payload: entry.payload,
            byteSize: entry.byteSize || 0,
            pinned: !!entry.pinned,
        };
        if (record.byteSize > 0) { evictUntilFits(record.byteSize); usedBytes += record.byteSize; }
        history.push(record);
        future = [];
        return record;
    }

    // Undo the most recent record. For raster records this applies before-images through
    // writeRegion; legacy records are handed back to the caller to apply. Bytes stay
    // counted (the record moves to the redo stack).
    function undo() {
        if (!history.length) return null;
        const record = history.pop();
        if (record.type === "raster" && writeRegion) applyPatches(record.patches, "undo", writeRegion);
        future.unshift(record);
        return record;
    }

    function redo() {
        if (!future.length) return null;
        const record = future.shift();
        if (record.type === "raster" && writeRegion) applyPatches(record.patches, "redo", writeRegion);
        history.push(record);
        return record;
    }

    // Whole-document restore/open boundary (design §5 / §3.1): drop everything.
    function clear() {
        history = [];
        future = [];
        usedBytes = 0;
        reservedBytes = 0;
    }

    // Resolve the newest record for a target identity (undo targets by identity, not index).
    function newestForIdentity(identity) {
        for (let i = history.length - 1; i >= 0; i--) if (history[i].identity === identity) return history[i];
        return null;
    }

    return {
        beginTransaction,
        pushLegacy,
        undo,
        redo,
        clear,
        reserve,       // exposed for unknown-region preflight callers
        newestForIdentity,
        getUsedBytes: () => usedBytes,
        getReservedBytes: () => reservedBytes,
        getBudgetBytes: () => budgetBytes,
        historyLength: () => history.length,
        futureLength: () => future.length,
        // shallow copy for inspection/tests
        peekHistory: () => history.slice(),
        peekFuture: () => future.slice(),
    };
}
