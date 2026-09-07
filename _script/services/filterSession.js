// Immutable filter session state machine for spec 016 (Editor Performance),
// phase 6.2, design §7.
//
// A live filter (brightness, blur, dither, colour reduce…) previews on a large selection
// while the user drags sliders, then commits exactly on Apply. The hard requirement is that
// a preview is NEVER authoritative and a stale/late worker result can NEVER overwrite the
// document. This state machine enforces:
//
//   open -> previewing -> applying -> committed -> closed
//   open/previewing -> cancelling -> closed
//   previewing/applying -> failed -> previewing | closed
//
//   - `open` captures an immutable source + target/revisions WITHOUT touching layer pixels;
//   - each parameter change bumps a monotonic session VERSION;
//   - exactly ONE preview runs and ONE (replaceable) preview is pending;
//   - a result is accepted only if job id, session version, document generation, source,
//     palette, mask, AND parameters all still match — otherwise it is rejected and released;
//   - Apply snapshots the latest parameters, stops previews, evaluates exact output,
//     RESERVES history, and commits ATOMICALLY; a commit cannot be interrupted half-way;
//   - Apply failure leaves the source unchanged; Cancel during Apply cancels BEFORE commit
//     and releases the temporary output.
//
// Pure and injectable. `submitJob(request) -> { id, cancel() }` runs preview/apply work
// (backed by pixelJobs.js live); `commit(output)` performs the atomic history commit;
// `reserveHistory(bytes)` gates the commit against the history budget. No DOM, no renderer.

export function createFilterSession(options) {
    options = options || {};
    const submitJob = options.submitJob;
    if (typeof submitJob !== "function") throw new Error("filterSession: submitJob is required");
    const commit = options.commit || (() => {});
    const reserveHistory = options.reserveHistory || (() => true);
    const releaseHistory = options.releaseHistory || (() => {});
    const onError = options.onError || (() => {});
    const hashParams = options.hashParams || ((p) => JSON.stringify(p || null));

    let state = "idle";
    let version = 0;             // monotonic parameter version
    let generation = 0;          // document generation captured at open
    let sourceId = null;         // immutable source identity
    let paletteRev = 0;
    let maskRev = 0;
    let lastParams = null;

    let runningPreview = null;   // { handle, descriptor, params }
    let pendingPreview = null;   // { params, version } — replaceable, at most one
    let previewOutput = null;    // { output, version } — the accepted, displayed preview
    let previewRevision = 0;     // bumps when previewOutput changes (renderer substitution key)
    let applyJob = null;         // { handle, descriptor }
    let lastError = null;

    const counters = { previews: 0, previewAccepted: 0, rejected: 0, applied: 0, failed: 0, cancelled: 0, released: 0 };

    function releaseOutput(output) {
        if (output && typeof output.close === "function") { try { output.close(); } catch (e) {} }
        else if (output && typeof output.dispose === "function") { try { output.dispose(); } catch (e) {} }
        counters.released++;
    }

    function descriptorNow(v) {
        return { version: v, generation, sourceId, paletteRev, maskRev, paramsHash: hashParams(lastParams) };
    }

    // Capture the immutable source/target and enter previewing. Does not modify pixels.
    function open(spec) {
        spec = spec || {};
        // Reopening a session drops any prior preview state; a late result from the previous
        // session is rejected by the acceptance checks (its descriptor no longer matches).
        runningPreview = null;
        pendingPreview = null;
        if (previewOutput) { releaseOutput(previewOutput.output); previewOutput = null; }
        applyJob = null;
        generation = spec.generation || 0;
        sourceId = spec.sourceId != null ? spec.sourceId : null;
        paletteRev = spec.paletteRev || 0;
        maskRev = spec.maskRev || 0;
        lastParams = spec.params || null;
        version = 0;
        state = "open";
        lastError = null;
        return true;
    }

    // A parameter change: bump version, keep one running + one pending preview.
    function setParams(params) {
        if (state !== "open" && state !== "previewing" && state !== "failed") return false;
        lastParams = params;
        version++;
        state = "previewing";
        if (runningPreview) { pendingPreview = { params, version }; return true; } // replace pending
        dispatchPreview(params, version);
        return true;
    }

    function dispatchPreview(params, v) {
        const descriptor = descriptorNow(v);
        counters.previews++;
        const handle = submitJob({ kind: "preview", version: v, generation, sourceId, paletteRev, maskRev, params, descriptor });
        runningPreview = { handle, descriptor, params };
    }

    // Whether an incoming preview descriptor still matches the live session.
    function previewAcceptable(d) {
        if (state === "closed" || state === "cancelling") return false;
        if (d.generation !== generation) return false;
        if (d.sourceId !== sourceId) return false;
        if (d.paletteRev !== paletteRev) return false;
        if (d.maskRev !== maskRev) return false;
        // Don't regress to an older version than one already shown (out-of-order results).
        if (previewOutput && d.version < previewOutput.version) return false;
        // Stale parameters: a newer preview has since been dispatched/queued.
        if (pendingPreview && d.version < pendingPreview.version) return false;
        if (runningPreview && runningPreview.descriptor.version > d.version) return false;
        return true;
    }

    // A preview job completed. Accept (substitute in the renderer) or reject+release, then
    // launch the pending preview if any.
    function onPreviewResult(jobId, output) {
        if (!runningPreview || runningPreview.handle.id !== jobId) { releaseOutput(output); counters.rejected++; return false; }
        const d = runningPreview.descriptor;
        runningPreview = null;
        let accepted = false;
        if (previewAcceptable(d)) {
            if (previewOutput) releaseOutput(previewOutput.output);
            previewOutput = { output, version: d.version };
            previewRevision++;
            counters.previewAccepted++;
            accepted = true;
        } else {
            releaseOutput(output);
            counters.rejected++;
        }
        if (pendingPreview) { const p = pendingPreview; pendingPreview = null; dispatchPreview(p.params, p.version); }
        return accepted;
    }

    function stopPreviews() {
        if (runningPreview) { try { runningPreview.handle.cancel(); } catch (e) {} runningPreview = null; }
        pendingPreview = null;
        if (previewOutput) { releaseOutput(previewOutput.output); previewOutput = null; }
    }

    // Snapshot the latest parameters, stop previews, and run the exact Apply job.
    function apply() {
        if (state !== "previewing" && state !== "open") { onError({ kind: "state", op: "apply", state }); return false; }
        stopPreviews();
        state = "applying";
        version++;
        const descriptor = descriptorNow(version);
        const handle = submitJob({ kind: "apply", version, generation, sourceId, paletteRev, maskRev, params: lastParams, descriptor });
        applyJob = { handle, descriptor };
        return true;
    }

    function applyAcceptable(d) {
        if (state !== "applying") return false; // cancelled/closed while running
        if (d.generation !== generation) return false;
        if (d.sourceId !== sourceId) return false;
        if (d.paletteRev !== paletteRev) return false;
        if (d.maskRev !== maskRev) return false;
        return true;
    }

    // The exact Apply job completed. Reserve history, then commit atomically. A cancelled /
    // stale Apply is rejected and released; a history-budget or commit failure leaves the
    // source unchanged (state -> failed, editing may resume).
    function onApplyResult(jobId, output) {
        if (!applyJob || applyJob.handle.id !== jobId) { releaseOutput(output); counters.rejected++; return false; }
        const d = applyJob.descriptor;
        applyJob = null;
        if (state === "cancelling") { releaseOutput(output); counters.rejected++; finishClose(); return false; }
        if (!applyAcceptable(d)) { releaseOutput(output); counters.rejected++; return false; }
        const bytes = (output && output.byteSize) || 0;
        if (!reserveHistory(bytes)) {
            releaseOutput(output);
            state = "failed";
            lastError = { kind: "history-budget", requested: bytes };
            onError(lastError);
            return false;
        }
        try {
            commit(output);           // atomic: applies pixels + pushes the history record
            counters.applied++;
            state = "committed";
            close();
            return true;
        } catch (e) {
            releaseHistory(bytes);
            releaseOutput(output);
            counters.failed++;
            state = "failed";
            lastError = { kind: "commit", error: e };
            onError(lastError);
            return false;
        }
    }

    // A job reported an error (worker crash, kernel failure). Source is unchanged.
    function onJobError(jobId, error) {
        if (runningPreview && runningPreview.handle.id === jobId) {
            runningPreview = null;
            counters.failed++;
            if (pendingPreview) { const p = pendingPreview; pendingPreview = null; dispatchPreview(p.params, p.version); }
            return;
        }
        if (applyJob && applyJob.handle.id === jobId) {
            applyJob = null;
            counters.failed++;
            state = "failed";
            lastError = { kind: "job", error };
            onError(lastError);
        }
    }

    // Cancel the session. During Apply this cancels BEFORE commit; a result in flight will be
    // rejected and released when it arrives (then the session finishes closing).
    function cancel() {
        counters.cancelled++;
        if (state === "applying" && applyJob) {
            state = "cancelling";
            try { applyJob.handle.cancel(); } catch (e) {}
            return true; // finishClose() runs when the (rejected) result returns
        }
        stopPreviews();
        finishClose();
        return true;
    }

    function finishClose() {
        stopPreviews();
        state = "closed";
        // Closing invalidates all prior ids by advancing generation so any late result is
        // rejected by the acceptance checks above.
        generation = generation + 1;
    }

    function close() { if (state !== "closed") finishClose(); }

    return {
        open,
        setParams,
        apply,
        cancel,
        close,
        onPreviewResult,
        onApplyResult,
        onJobError,
        // renderer substitution: the currently displayed preview output (never authoritative)
        getPreviewOutput: () => (previewOutput ? previewOutput.output : null),
        getPreviewRevision: () => previewRevision,
        hasPendingPreview: () => !!pendingPreview,
        hasRunningPreview: () => !!runningPreview,
        getState: () => state,
        getVersion: () => version,
        getGeneration: () => generation,
        getLastError: () => lastError,
        getCounters: () => Object.assign({}, counters),
    };
}
