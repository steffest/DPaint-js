// Bounded streaming video encoder for spec 016 (Editor Performance), phases 10.2 + 10.4,
// design §9.
//
// Drives an owned-frame iterator into a WebCodecs-shaped encoder under strict backpressure:
// production stops while the encoder queue is at the threshold (initially two), the loop waits
// for a `dequeue` event without busy-polling and RECHECKS the queue on wake (no missed wakeups),
// frames are closed immediately after enqueue, `flush` happens only at final completion, and a
// `finally` releases the encoder, frame, iterator, snapshot, and sink. Timestamps are
// `round(i * 1e6 / fps)` and durations are adjacent-timestamp differences. Any encoder/sink error
// or abort stops the producer, discards incomplete output, and reports failure exactly once —
// there is no successful partial result.
//
// The encoder/sink are injected so the whole pipeline is deterministic against fakes.

export function createExportEncoder(deps) {
    deps = deps || {};
    const encoder = deps.encoder;
    const sink = deps.sink;
    const queueThreshold = deps.queueThreshold != null ? deps.queueThreshold : 2;

    // Probe the actual selected codec configuration, recording every fallback tried. Returns the
    // first supported config, or throws if none is supported.
    async function probe(configs) {
        const tried = [];
        for (const cfg of configs) {
            let res;
            try { res = await encoder.isConfigSupported(cfg); } catch (e) { res = { supported: false }; }
            tried.push({ config: cfg, supported: !!(res && res.supported) });
            if (res && res.supported) return { config: cfg, tried };
        }
        const err = new Error("no supported codec configuration");
        err.kind = "codec-unsupported";
        err.tried = tried;
        throw err;
    }

    function timestampFor(i, fps) { return Math.round(i * 1e6 / fps); }

    // Encode all frames from `iterator`. Returns { ok, frameCount, timestamps, durations,
    // encodedBytes, maxQueueDepth, errored, aborted }.
    async function encode(iterator, opts) {
        opts = opts || {};
        const fps = opts.fps || 12;
        const signal = opts.signal;
        const config = opts.config;

        const timestamps = [];
        let frameCount = 0;
        let maxQueueDepth = 0;
        let errored = null;
        let aborted = false;
        let reportedFailure = false;

        // Backpressure: a single pending waiter resolved by the encoder's dequeue event.
        let pendingResolve = null;
        const wake = () => { const r = pendingResolve; pendingResolve = null; if (r) r(); };
        encoder.ondequeue = wake;
        if (typeof encoder.addEventListener === "function") encoder.addEventListener("dequeue", wake);

        const waitForDequeue = () => new Promise((res) => { pendingResolve = res; });

        const fail = (e, kind) => {
            if (!reportedFailure) { reportedFailure = true; errored = e; if (deps.onError) deps.onError(e); }
            if (kind === "abort") aborted = true;
        };

        try {
            if (config) encoder.configure(config);

            for await (const owned of iterator) {
                if (signal && signal.aborted) { fail(makeAbort(), "abort"); throw errored; }

                // Stop producing while the encoder queue is at/over the threshold; recheck on wake.
                while ((encoder.encodeQueueSize | 0) >= queueThreshold) {
                    await waitForDequeue();
                    if (signal && signal.aborted) { fail(makeAbort(), "abort"); throw errored; }
                }

                const ts = timestampFor(frameCount, fps);
                try {
                    encoder.encode(owned.frame, { timestamp: ts });
                } catch (e) {
                    fail(e, "encode");
                    throw e;
                } finally {
                    if (typeof owned.release === "function") owned.release(); // close frame immediately
                }
                timestamps.push(ts);
                frameCount++;
                const depth = encoder.encodeQueueSize | 0;
                if (depth > maxQueueDepth) maxQueueDepth = depth;
            }

            // Flush ONLY at final completion.
            await encoder.flush();
        } catch (e) {
            if (!reportedFailure) fail(e, e && e.name === "AbortError" ? "abort" : "error");
        } finally {
            // Release every owned resource regardless of outcome.
            try { if (typeof iterator.return === "function") await iterator.return(); } catch (_) {}
            try { encoder.close(); } catch (_) {}
            if (opts.snapshot && typeof opts.snapshot.release === "function") opts.snapshot.release();
            try { if (sink && typeof sink.close === "function") sink.close(); } catch (_) {}
            encoder.ondequeue = null;
        }

        // Durations are differences of adjacent timestamps; the last repeats the nominal step.
        const durations = timestamps.map((t, i) => (i + 1 < timestamps.length ? timestamps[i + 1] - t : Math.round(1e6 / fps)));

        const ok = !errored && !aborted;
        return {
            ok,
            frameCount: ok ? frameCount : 0,   // no successful partial result
            timestamps: ok ? timestamps : [],
            durations: ok ? durations : [],
            encodedBytes: sink && typeof sink.getEncodedBytes === "function" ? sink.getEncodedBytes() : 0,
            maxQueueDepth,
            errored: !!errored,
            aborted,
        };
    }

    return { probe, encode, timestampFor };
}

// Streaming vs Blob sink: exposes streaming when the sink supports it, otherwise accumulates a
// Blob-equivalent, accounting encoded-output bytes honestly (separate from working memory).
export function createExportSink(target) {
    target = target || {};
    const streaming = !!target.supportsStreaming;
    let encodedBytes = 0;
    const chunks = [];
    let closed = false;
    let failed = false;

    return {
        supportsStreaming: streaming,
        write(chunk) {
            if (closed || failed) return false;
            if (target.failOnWrite) { failed = true; if (target.onError) target.onError(new Error("sink write failed")); return false; }
            if (streaming && target.stream) target.stream.write(chunk);
            else chunks.push(chunk);              // Blob fallback accumulation
            encodedBytes += chunk.byteLength | 0;  // encoded output growth, accounted separately
            return true;
        },
        getEncodedBytes: () => encodedBytes,
        isStreaming: () => streaming,
        hasFailed: () => failed,
        result() { return failed ? null : (streaming ? { streamed: true } : { blob: chunks.slice() }); },
        close() { closed = true; },
    };
}

function makeAbort() { const e = new Error("export aborted"); e.name = "AbortError"; return e; }
