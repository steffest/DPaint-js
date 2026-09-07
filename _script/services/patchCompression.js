// Idle raster-patch compression for spec 016 (Editor Performance),
// phase 5.4, design §5. OPTIONAL and gated on phase 6's worker interface.
//
// Older history records (the tile patches from rasterHistory.js) can be compressed off
// the main thread to stretch the history budget. The constraints the design fixes:
//
//   - the ORIGINAL patches are retained until a compressed replacement SUCCEEDS, and both
//     copies are counted during the transition (no accounting gap that hides bytes);
//   - a result that arrives after its record was evicted / redo-cleared / its document
//     generation changed is REJECTED and released (never applied to a dead record);
//   - decompression on undo can FAIL; that is a controlled recovery (report, leave the
//     model unchanged), because pixel operations are not assumed invertible.
//
// Pure and injectable: `compress`, `decompress`, and `schedule` (an idle scheduler) are
// all supplied. Live wiring to the real worker lands with phase 6; here the interface is
// unit-tested with a fake compressor. No record is compressed unless the owner enqueues
// it, so recent history stays uncompressed and instantly restorable.

export function createPatchCompression(options) {
    options = options || {};
    const compress = options.compress;     // (record) -> result | Promise<result>; result = {data, byteSize, dispose?}
    const decompress = options.decompress; // (record) -> {patches} | Promise<{patches}>
    const schedule = options.schedule || ((fn) => { fn(); return null; }); // idle scheduler

    const jobs = new Map(); // recordId -> { record, state, result }
    let accountedBytes = 0; // original + any transiently-held compressed bytes
    let highWaterBytes = 0; // peak accountedBytes (proves "both counted during transition")
    const counters = { scheduled: 0, completed: 0, applied: 0, rejected: 0, released: 0, decompressFailures: 0 };

    function account(delta) {
        accountedBytes += delta;
        if (accountedBytes > highWaterBytes) highWaterBytes = accountedBytes;
    }

    function releaseResult(result) {
        if (result && typeof result.dispose === "function") { try { result.dispose(); } catch (e) {} }
        counters.released++;
    }

    // Enqueue a record for idle compression. Its original bytes are counted from now.
    function enqueue(record) {
        if (!compress || jobs.has(record.id)) return false;
        jobs.set(record.id, { record, state: "queued", result: null });
        account(record.byteSize || 0);
        counters.scheduled++;
        schedule(() => run(record.id));
        return true;
    }

    function run(recordId) {
        const job = jobs.get(recordId);
        if (!job || job.state === "cancelled") return;
        job.state = "running";
        Promise.resolve(compress(job.record)).then(
            (result) => onResult(recordId, result),
            () => { // compression itself failed: leave the original in place, drop the job
                const j = jobs.get(recordId);
                if (j && j.state !== "cancelled") { account(-(j.record.byteSize || 0)); jobs.delete(recordId); }
            }
        );
    }

    function onResult(recordId, result) {
        const job = jobs.get(recordId);
        // Late rejection: the record was cancelled/evicted while compressing.
        if (!job || job.state === "cancelled") { releaseResult(result); counters.rejected++; return; }
        counters.completed++;
        const originalBytes = job.record.byteSize || 0;
        const compressedBytes = (result && result.byteSize) || 0;
        // Transition: both copies exist and are counted (peak captured by account()).
        account(compressedBytes);
        // Replacement ownership: the record now owns the compressed data; original patches
        // are released only AFTER the replacement is in place.
        const record = job.record;
        record.uncompressedPatches = null; // ownership moved; the original buffers are freed
        record.compressed = true;
        record.compressedData = result ? result.data : null;
        record.byteSize = compressedBytes;
        account(-originalBytes); // release the original now that the replacement succeeded
        job.state = "compressed";
        job.result = result;
        counters.applied++;
        return record;
    }

    // Cancel a record's compression (eviction / redo-clear / document close). Idempotent.
    // If a result already arrived it is released; a not-yet-applied job stops counting the
    // original bytes it reserved.
    function cancel(recordId) {
        const job = jobs.get(recordId);
        if (!job) return false;
        if (job.state === "compressed") {
            // already applied; releasing means giving the compressed data back
            releaseResult(job.result);
            jobs.delete(recordId);
            return true;
        }
        if (job.state !== "cancelled") account(-(job.record.byteSize || 0));
        job.state = "cancelled";
        if (job.result) releaseResult(job.result);
        jobs.delete(recordId);
        return true;
    }

    function cancelAll() { for (const id of Array.from(jobs.keys())) cancel(id); }

    // Restore a record's patches for undo/redo. Async because decompression may run in a
    // worker. Returns { ok, patches } or { ok:false, error } on a controlled failure —
    // the caller then leaves the model unchanged and reports it (design §5 / §11 table).
    function restore(record) {
        if (!record || !record.compressed) return Promise.resolve({ ok: true, patches: record ? record.patches : null });
        if (!decompress) return Promise.resolve({ ok: false, error: new Error("no decompressor") });
        return Promise.resolve()
            .then(() => decompress(record))
            .then((r) => ({ ok: true, patches: r.patches }))
            .catch((error) => { counters.decompressFailures++; return { ok: false, error }; });
    }

    return {
        enqueue,
        cancel,
        cancelAll,
        restore,
        getAccountedBytes: () => accountedBytes,
        getHighWaterBytes: () => highWaterBytes,
        getCounters: () => Object.assign({}, counters),
        jobState: (id) => { const j = jobs.get(id); return j ? j.state : null; },
        activeJobs: () => jobs.size,
    };
}
