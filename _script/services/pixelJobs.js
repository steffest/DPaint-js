// Bounded worker job queue for spec 016 (Editor Performance), phase 6.1, design §7.
//
// Heavy pixel work (exact filters, quantization, contour tracing, codec passes) must run
// off the main thread without letting stale results overwrite the authoritative document.
// This module owns the queue/priority/reservation/ownership/cancellation protocol; the
// worker itself and its kernels are injected, so the whole protocol is unit-testable with a
// fake worker and a fake clock. The design constraints it enforces (design §7 worker
// protocol):
//
//   - at most ONE job runs per worker; start with one persistent worker, allow more only by
//     explicit configuration;
//   - before dispatch, RESERVE payload+output+scratch bytes against a budget; a job that can
//     never fit is rejected (controlled resource error), never dispatched silently;
//   - snapshot buffers are TRANSFERRED in; a returned buffer's ownership MOVES to the
//     accepting consumer; a stale/rejected output is released immediately;
//   - result acceptance compares job id AND generation — an out-of-order or superseded
//     completion is rejected and released, never applied;
//   - a queued job cancels by removal; a running job cancels cooperatively (chunked kernels
//     yield) or, for a non-yielding kernel, by terminating a disposable worker and spinning a
//     replacement — a crash/restart is the same recovery path.
//
// Pure and injectable: no DOM, no real Worker. `createWorker()` returns a handle shaped like
// the structured-clone Worker contract ({ postMessage(msg, transfer), terminate(), settable
// onmessage/onerror }). Live wiring to the real worker + OffscreenCanvas is a later step.

export const JOB_PRIORITY = { apply: 0, interactive: 0, preview: 1, export: 2, background: 3 };

const DEFAULT_BUDGET = 256 * 1024 * 1024;

export function createPixelJobQueue(options) {
    options = options || {};
    const createWorker = options.createWorker;
    if (typeof createWorker !== "function") throw new Error("pixelJobs: createWorker is required");
    const maxWorkers = Math.max(1, options.maxWorkers || 1);
    const budgetBytes = options.budgetBytes || DEFAULT_BUDGET;
    const onError = options.onError || (() => {});

    let seq = 0;
    let generation = 1;              // global generation; bump to stale every outstanding job
    let reservedBytes = 0;
    const queue = [];                // queued jobs, not yet dispatched
    const workers = [];              // { worker, job|null, id }
    const running = new Map();       // jobId -> job (dispatched, awaiting result)
    const counters = {
        submitted: 0, dispatched: 0, completed: 0, rejected: 0, cancelled: 0,
        failed: 0, released: 0, workerRestarts: 0, resourceRejections: 0,
    };

    function bumpGeneration() { return ++generation; }

    function releaseOutput(output) {
        if (output && typeof output.close === "function") { try { output.close(); } catch (e) {} }
        else if (output && typeof output.dispose === "function") { try { output.dispose(); } catch (e) {} }
        counters.released++;
    }

    function releaseReservation(job) {
        if (job && job._reserved) { reservedBytes -= job._reserved; job._reserved = 0; if (reservedBytes < 0) reservedBytes = 0; }
    }

    function spawnWorker() {
        const raw = createWorker();
        const slot = { worker: raw, job: null, id: ++seq };
        raw.onmessage = (ev) => handleMessage(slot, ev && ev.data !== undefined ? ev.data : ev);
        raw.onerror = (err) => handleWorkerError(slot, err);
        workers.push(slot);
        return slot;
    }

    function idleWorker() {
        for (const slot of workers) if (!slot.job) return slot;
        if (workers.length < maxWorkers) return spawnWorker();
        return null;
    }

    // Sorted insert by priority (lower value = higher priority), FIFO within a priority.
    function enqueue(job) {
        let i = queue.length;
        while (i > 0 && queue[i - 1].priority > job.priority) i--;
        queue.splice(i, 0, job);
    }

    function submit(spec) {
        spec = spec || {};
        const reserve = spec.reserveBytes || 0;
        counters.submitted++;
        // A job whose reservation can never fit the whole budget is a controlled resource
        // error — reject up front rather than blocking the queue forever.
        if (reserve > budgetBytes) {
            counters.resourceRejections++;
            const err = { kind: "resource", reason: "over-budget", requested: reserve, budget: budgetBytes };
            onError(err);
            if (typeof spec.onError === "function") spec.onError(err);
            return { id: null, rejected: true, cancel() {} };
        }
        const job = {
            id: ++seq,
            kind: spec.kind,
            priority: spec.priority != null ? spec.priority : JOB_PRIORITY.background,
            payload: spec.payload,
            transfer: spec.transfer || [],
            reserveBytes: reserve,
            generation: spec.generation != null ? spec.generation : generation,
            sessionId: spec.sessionId,
            meta: spec.meta,
            onResult: spec.onResult,
            onErrorCb: spec.onError,
            state: "queued",
            _reserved: 0,
            terminateOnCancel: !!spec.terminateOnCancel, // non-yielding kernel
        };
        enqueue(job);
        pump();
        return {
            id: job.id,
            get state() { return job.state; },
            cancel: (opts) => cancel(job.id, opts),
        };
    }

    // Try to dispatch as many queued jobs as workers/budget allow.
    function pump() {
        for (let i = 0; i < queue.length;) {
            const job = queue[i];
            // Reserve budget before we commit a worker to it.
            if (reservedBytes + job.reserveBytes > budgetBytes) { i++; continue; } // try lower-priority jobs that fit
            const slot = idleWorker();
            if (!slot) break; // no capacity right now
            queue.splice(i, 1);
            dispatch(slot, job);
            // do not advance i; queue shifted left
        }
    }

    function dispatch(slot, job) {
        job._reserved = job.reserveBytes;
        reservedBytes += job._reserved;
        job.state = "running";
        slot.job = job;
        running.set(job.id, job);
        counters.dispatched++;
        slot.worker.postMessage(
            { type: "run", jobId: job.id, generation: job.generation, kind: job.kind, payload: job.payload },
            job.transfer
        );
    }

    function slotForJob(jobId) { for (const slot of workers) if (slot.job && slot.job.id === jobId) return slot; return null; }

    function finishSlot(slot) {
        slot.job = null;
        pump();
    }

    // Whether a completion is still wanted: the job must be the running instance and its
    // generation must still be current for its identity (global bump or per-job stale flag).
    function isAcceptable(job, msgGeneration) {
        if (!job) return false;
        if (job.state !== "running") return false;      // cancelled/superseded
        if (job.generation !== msgGeneration) return false; // out-of-order/stale echo
        if (job._stale) return false;
        return true;
    }

    function handleMessage(slot, data) {
        if (!data || !data.type) return;
        if (data.type === "progress") return; // heartbeat; used by tests to observe running state
        const job = running.get(data.jobId);
        if (data.type === "result") {
            running.delete(data.jobId);
            if (!isAcceptable(job, data.generation)) {
                // Superseded / cancelled / stale: ownership does not move; release now.
                releaseOutput(data.output);
                releaseReservation(job);
                counters.rejected++;
                if (slot.job && slot.job.id === data.jobId) finishSlot(slot); else pump();
                return;
            }
            job.state = "done";
            releaseReservation(job);
            counters.completed++;
            // Ownership of data.output moves to the consumer.
            if (typeof job.onResult === "function") job.onResult(data.output, { byteSize: data.byteSize, meta: job.meta });
            if (slot.job && slot.job.id === data.jobId) finishSlot(slot); else pump();
            return;
        }
        if (data.type === "error") {
            running.delete(data.jobId);
            releaseReservation(job);
            counters.failed++;
            const err = { kind: "job", jobId: data.jobId, error: data.error };
            if (job && typeof job.onErrorCb === "function") job.onErrorCb(err); else onError(err);
            if (slot.job && slot.job.id === data.jobId) finishSlot(slot); else pump();
            return;
        }
    }

    // A worker crash fails its running job and replaces the worker (design §7 crash/restart).
    function handleWorkerError(slot, err) {
        const job = slot.job;
        try { slot.worker.terminate(); } catch (e) {}
        const idx = workers.indexOf(slot);
        if (idx >= 0) workers.splice(idx, 1);
        counters.workerRestarts++;
        if (job) {
            running.delete(job.id);
            releaseReservation(job);
            job.state = "failed";
            counters.failed++;
            const e = { kind: "worker-crash", jobId: job.id, error: err };
            if (typeof job.onErrorCb === "function") job.onErrorCb(e); else onError(e);
        }
        pump(); // idleWorker() will spawn a replacement on demand
    }

    // Cancel a job by id. Queued -> removed (no reservation held). Running -> cooperative
    // cancel message, or terminate+replace for a non-yielding kernel. Any later result is
    // rejected and released by isAcceptable().
    function cancel(jobId, opts) {
        opts = opts || {};
        const qi = queue.findIndex((j) => j.id === jobId);
        if (qi >= 0) {
            const job = queue[qi];
            queue.splice(qi, 1);
            job.state = "cancelled";
            counters.cancelled++;
            return true;
        }
        const job = running.get(jobId);
        if (!job) return false;
        job.state = "cancelled";
        job._stale = true;
        counters.cancelled++;
        const slot = slotForJob(jobId);
        if (job.terminateOnCancel || opts.terminate) {
            // Non-yielding kernel: terminate the disposable worker and free the slot now.
            if (slot) {
                try { slot.worker.terminate(); } catch (e) {}
                const idx = workers.indexOf(slot); if (idx >= 0) workers.splice(idx, 1);
                counters.workerRestarts++;
            }
            running.delete(jobId);
            releaseReservation(job);
            pump();
        } else if (slot) {
            // Cooperative: ask the worker to stop; keep the reservation until it acks/returns
            // so a replacement is not admitted over budget mid-flight.
            slot.worker.postMessage({ type: "cancel", jobId });
        }
        return true;
    }

    // Stale every outstanding job (document close / generation change). Their results, if
    // they still arrive, are rejected and released.
    function invalidateGeneration() {
        const g = bumpGeneration();
        for (const job of running.values()) job._stale = true;
        for (const job of queue) job._stale = true;
        return g;
    }

    function disposeAll() {
        for (const slot of workers) { try { slot.worker.terminate(); } catch (e) {} }
        workers.length = 0;
        queue.length = 0;
        running.clear();
        reservedBytes = 0;
    }

    return {
        submit,
        cancel,
        bumpGeneration,
        invalidateGeneration,
        disposeAll,
        getGeneration: () => generation,
        getReservedBytes: () => reservedBytes,
        getBudgetBytes: () => budgetBytes,
        queueLength: () => queue.length,
        runningCount: () => running.size,
        workerCount: () => workers.length,
        getCounters: () => Object.assign({}, counters),
    };
}
