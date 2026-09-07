// Opt-in performance instrumentation for spec 016 (Editor Performance), design §13, R1.1.
//
// Pure ES module: no DOM access, no other singletons imported, so it can be unit
// tested inside page.evaluate without a running editor. A default *disabled*
// instance is exported for app wiring; createMetrics() builds isolated instances
// for tests and for injected-clock benchmarks.
//
// Two things are deliberately separated:
//   * Timing samples + event counters are diagnostic only and are retained
//     *only while enabled*. Disabled mode keeps nothing and emits no per-frame
//     logs (R1.1: "Normal mode does not emit per-frame logs or retain unbounded
//     samples").
//   * Resource byte accounting is a correctness primitive (budgets in later
//     phases depend on it) and is therefore always active, but stays bounded by
//     the number of live reservations.

// Fixed stage ids from design §13. Timing samples are keyed by these.
export const STAGES = Object.freeze([
    'input', 'raster', 'mask', 'bounds', 'composite',
    'quantize', 'preview', 'history', 'evaluate', 'encode',
]);

// Resource categories from design §13/§5: kept distinct so a report never hides
// active job / export / GPU bytes inside the retained cache budget.
export const RESOURCE_CATEGORIES = Object.freeze([
    'cpuPayload', 'gpu', 'retainedCache', 'activeJobs', 'exportSnapshots', 'encodedOutput',
]);

// Fixed ring capacity per stage. Bounded so a long session cannot grow samples
// without limit; benchmark alternative sizes before changing.
const DEFAULT_CAPACITY = 240;

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

// Validate a byte count is a finite, non-negative safe integer before it is used
// in an allocation/accounting sum (design §11: "Validate finite safe integer byte
// calculations"). Throws rather than silently accepting NaN/Infinity/negatives.
function validateBytes(bytes) {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0 || bytes > MAX_SAFE || Math.floor(bytes) !== bytes) {
        throw new RangeError('invalid byte count: ' + bytes);
    }
    return bytes;
}

// Nearest-rank percentile over an ascending-sorted array. Returns null for an
// empty sample. p is a percentage in [0,100].
export function percentile(sorted, p) {
    if (!sorted || !sorted.length) return null;
    if (p <= 0) return sorted[0];
    if (p >= 100) return sorted[sorted.length - 1];
    const rank = Math.ceil((p / 100) * sorted.length);
    const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
    return sorted[idx];
}

// Summarise a set of timing samples. Empty -> a zero-count record with null stats.
function summarize(values) {
    if (!values.length) {
        return { count: 0, min: null, max: null, mean: null, p50: null, p95: null, p99: null };
    }
    const sorted = values.slice().sort((a, b) => a - b);
    let sum = 0;
    for (let i = 0; i < sorted.length; i++) sum += sorted[i];
    return {
        count: sorted.length,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        mean: sum / sorted.length,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
    };
}

function makeRing(capacity) {
    return { buf: new Float64Array(capacity), count: 0, head: 0 };
}

export function createMetrics(options = {}) {
    const capacity = options.capacity && options.capacity > 0 ? (options.capacity | 0) : DEFAULT_CAPACITY;
    const now = options.now || (() => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()));
    let enabled = !!options.enabled;

    const rings = {};
    STAGES.forEach(s => { rings[s] = makeRing(capacity); });

    const counters = Object.create(null);
    const gauges = Object.create(null);

    const resourceBytes = Object.create(null);
    RESOURCE_CATEGORIES.forEach(c => { resourceBytes[c] = 0; });

    let nextResourceId = 1;
    const liveResources = new Map(); // id -> { category, bytes }

    // ── timing ────────────────────────────────────────────────────────────────
    function push(ring, value) {
        ring.buf[ring.head] = value;
        ring.head = (ring.head + 1) % ring.buf.length;
        if (ring.count < ring.buf.length) ring.count++;
    }

    // Record a measured duration (ms) for a stage. No-op when disabled.
    function record(stage, ms) {
        if (!enabled) return;
        const ring = rings[stage];
        if (!ring) throw new Error('unknown stage: ' + stage);
        push(ring, ms);
    }

    // Time a synchronous function against a stage. Always runs fn; only retains
    // the sample when enabled. Returns fn's result.
    function time(stage, fn) {
        if (!enabled) return fn();
        const t0 = now();
        try {
            return fn();
        } finally {
            record(stage, now() - t0);
        }
    }

    // Manual span for asynchronous / interleaved work. token.end() records once;
    // repeated end() calls are ignored.
    function begin(stage) {
        if (!enabled) return { end() {} };
        const t0 = now();
        let done = false;
        return {
            end() {
                if (done) return;
                done = true;
                record(stage, now() - t0);
            },
        };
    }

    // Retained samples for a stage, oldest -> newest.
    function samples(stage) {
        const ring = rings[stage];
        if (!ring) throw new Error('unknown stage: ' + stage);
        const out = new Array(ring.count);
        // The oldest retained entry is head - count (mod capacity) once wrapped.
        const start = (ring.head - ring.count + ring.buf.length) % ring.buf.length;
        for (let i = 0; i < ring.count; i++) {
            out[i] = ring.buf[(start + i) % ring.buf.length];
        }
        return out;
    }

    // ── counters & gauges ───────────────────────────────────────────────────────
    function count(name, delta = 1) {
        if (!enabled) return;
        counters[name] = (counters[name] || 0) + delta;
    }

    // A gauge holds a current value and separately tracks its observed maximum
    // (e.g. queue depth peak). No-op when disabled.
    function gauge(name, value) {
        if (!enabled) return;
        gauges[name] = value;
        const maxKey = name + 'Max';
        if (gauges[maxKey] === undefined || value > gauges[maxKey]) gauges[maxKey] = value;
    }

    // ── resource accounting (always active) ─────────────────────────────────────
    // Reserve bytes in a category. Returns a handle whose release() is idempotent:
    // releasing twice never double-subtracts (R8.2: "Resource release is idempotent").
    function reserve(category, bytes) {
        if (!(category in resourceBytes)) throw new Error('unknown resource category: ' + category);
        const size = validateBytes(bytes);
        const id = nextResourceId++;
        liveResources.set(id, { category, bytes: size });
        resourceBytes[category] += size;
        let released = false;
        return {
            id,
            category,
            bytes: size,
            release() {
                if (released) return false;
                released = true;
                resourceBytes[category] -= size;
                liveResources.delete(id);
                return true;
            },
        };
    }

    function resourceBytesFor(category) {
        if (!(category in resourceBytes)) throw new Error('unknown resource category: ' + category);
        return resourceBytes[category];
    }

    // ── lifecycle ────────────────────────────────────────────────────────────────
    function setEnabled(value) {
        enabled = !!value;
        if (!enabled) clearSamples();
    }
    function isEnabled() { return enabled; }

    // Drop retained diagnostic samples/counters. Does NOT touch live resource
    // reservations (those are owned elsewhere and released by their owners).
    function clearSamples() {
        STAGES.forEach(s => { rings[s] = makeRing(capacity); });
        for (const k in counters) delete counters[k];
        for (const k in gauges) delete gauges[k];
    }

    function report() {
        const stages = {};
        STAGES.forEach(s => { stages[s] = summarize(samples(s)); });
        const resources = {};
        let total = 0;
        RESOURCE_CATEGORIES.forEach(c => { resources[c] = resourceBytes[c]; total += resourceBytes[c]; });
        return {
            enabled,
            capacity,
            stages,
            counters: Object.assign({}, counters),
            gauges: Object.assign({}, gauges),
            resources,
            resourceTotal: total,
            liveResourceCount: liveResources.size,
        };
    }

    return {
        record, time, begin, samples,
        count, gauge,
        reserve, resourceBytesFor,
        setEnabled, isEnabled, clearSamples, report,
        get enabled() { return enabled; },
    };
}

// Default app-wide instance, disabled by default (opt-in diagnostics).
const metrics = createMetrics({ enabled: false });
export default metrics;
