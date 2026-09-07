// Benchmark execution and reporting for spec 016 (Editor Performance), R1.3.
// Pure ES module. The clock is injected so runs are deterministic under test;
// production callers pass performance.now. Timing runs are intended to be serial
// and separate from correctness CI (design §12), so this module only produces
// data — it makes no assertions of its own.

import { percentile } from "./performanceMetrics.js";

// Upper bound on retained per-iteration samples, so a long benchmark cannot grow
// memory without limit (R1.1 "does not retain unbounded samples"). Excess
// iterations still run and count toward summary statistics computed incrementally.
const DEFAULT_MAX_SAMPLES = 1000;

function defaultClock() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

// Run `fn(iterationIndex)` `iterations` times after `warmup` un-recorded
// iterations, timing each with the injected clock. Returns a report with a
// bounded sample list, a full summary, and recorded environment/settings.
export function runBenchmark(options = {}) {
    const {
        name = 'benchmark',
        iterations = 30,
        warmup = 0,
        clock = defaultClock,
        fn,
        env = {},
        settings = {},
        maxSamples = DEFAULT_MAX_SAMPLES,
    } = options;

    if (typeof fn !== 'function') throw new Error('runBenchmark requires a fn');
    if (!Number.isInteger(iterations) || iterations <= 0) throw new RangeError('iterations must be a positive integer');

    for (let w = 0; w < warmup; w++) fn(-1 - w);

    const samples = [];
    let count = 0;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;

    for (let i = 0; i < iterations; i++) {
        const t0 = clock();
        fn(i);
        const dt = clock() - t0;
        count++;
        sum += dt;
        if (dt < min) min = dt;
        if (dt > max) max = dt;
        if (samples.length < maxSamples) samples.push(dt);
    }

    return {
        name,
        iterations: count,
        warmup,
        truncatedSamples: count > samples.length,
        samples,
        summary: summarize(samples, { count, sum, min, max }),
        env: Object.assign({}, env),
        settings: Object.assign({}, settings),
    };
}

// Build a summary from the retained samples for percentiles, but take
// count/mean/min/max from the full running totals so truncation does not skew
// the reported bounds.
function summarize(samples, totals) {
    if (!totals.count) {
        return { count: 0, min: null, max: null, mean: null, p50: null, p95: null, p99: null };
    }
    const sorted = samples.slice().sort((a, b) => a - b);
    return {
        count: totals.count,
        min: totals.min,
        max: totals.max,
        mean: totals.sum / totals.count,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
    };
}

// Regression tolerance from requirements §5: max(1 ms, 10% of baseline).
export function regressionLimitMs(baselineMs) {
    return Math.max(1, 0.1 * baselineMs);
}

// Compare a before/after report on a chosen metric (default p95). Reports the
// signed delta, the percentage change, the allowed limit, and whether the
// after-run regressed beyond it.
export function compareReports(before, after, options = {}) {
    const metric = options.metric || 'p95';
    const b = before && before.summary ? before.summary[metric] : null;
    const a = after && after.summary ? after.summary[metric] : null;
    if (b == null || a == null) {
        return { metric, before: b, after: a, deltaMs: null, deltaPct: null, regressionLimitMs: null, regressed: false, comparable: false };
    }
    const deltaMs = a - b;
    const limit = regressionLimitMs(b);
    return {
        metric,
        before: b,
        after: a,
        deltaMs,
        deltaPct: b === 0 ? null : (deltaMs / b) * 100,
        regressionLimitMs: limit,
        regressed: deltaMs > limit,
        comparable: true,
    };
}
