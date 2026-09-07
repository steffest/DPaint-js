// Visual scheduler for spec 016 (Editor Performance), design §3.2, R2.
//
// One pending frame services every registered view. Repeated invalidations before
// a frame collapse into at most one composite per affected view in that frame;
// unchanged views do not composite. Model/history events stay synchronous — this
// scheduler only coalesces *display* work, never ordered document mutations.
//
// Everything external is injected (frame scheduler, timer, clock) so the whole
// state machine is unit-testable without a real rAF. A default singleton wired to
// requestAnimationFrame is exported for the app; createVisualScheduler() builds
// isolated instances for tests.

import defaultMetrics from "../util/performanceMetrics.js";
import { emptyDamage, fullDamage, mergeDamage, cloneDamage } from "../util/damage.js";

const DEFAULT_SECONDARY_INTERVAL_MS = 250; // design §3.2 initial throttle during gestures

function defaultScheduleFrame(cb) {
    if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(cb);
    return setTimeout(() => cb(Date.now()), 16);
}
function defaultCancelFrame(handle) {
    if (typeof cancelAnimationFrame === 'function') { cancelAnimationFrame(handle); return; }
    clearTimeout(handle);
}
function defaultNow() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}
function defaultTimer(cb, ms) { return setTimeout(cb, ms); }
function defaultClearTimer(h) { clearTimeout(h); }

export function createVisualScheduler(options = {}) {
    const scheduleFrame = options.scheduleFrame || defaultScheduleFrame;
    const cancelFrame = options.cancelFrame || defaultCancelFrame;
    const now = options.now || defaultNow;
    const timer = options.timer || defaultTimer;
    const clearTimer = options.clearTimer || defaultClearTimer;
    const metrics = options.metrics || defaultMetrics;

    // viewId -> { render, secondary, minIntervalMs, visible, lastRender, generation }
    const views = new Map();
    // viewId -> { damage, flags, revision } pending for the next frame
    let dirty = new Map();

    let frameHandle = null;
    let throttleHandle = null;
    let generation = 0;

    // Behaviour counters that must be observable regardless of whether the
    // diagnostic metrics instance is enabled (task 2.2: "separate counters for
    // scheduled/explicit flushes"). Mirrored into metrics as well.
    const counters = {
        scheduledTicks: 0,
        scheduledPresentations: 0,
        explicitFlushes: 0,
        explicitPresentations: 0,
        skippedPresentations: 0,
        coalescedInvalidations: 0,
    };

    function bump(name, delta = 1) {
        counters[name] += delta;
        metrics.count(name, delta);
    }

    function registerView(viewId, opts = {}) {
        views.set(viewId, {
            render: opts.render || (() => {}),
            secondary: !!opts.secondary,
            minIntervalMs: typeof opts.minIntervalMs === 'number' ? opts.minIntervalMs : DEFAULT_SECONDARY_INTERVAL_MS,
            visible: opts.visible !== false,
            lastRender: -Infinity,
        });
        return () => views.delete(viewId);
    }

    function ensureFrame() {
        if (frameHandle == null) frameHandle = scheduleFrame(tick);
    }

    function mergeIntoDirty(viewId, entry) {
        const existing = dirty.get(viewId);
        if (existing) {
            existing.damage = mergeDamage(existing.damage, entry.damage);
            existing.flags = Object.assign({}, existing.flags, entry.flags);
            if (entry.revision != null) existing.revision = entry.revision;
            bump('coalescedInvalidations');
        } else {
            dirty.set(viewId, {
                damage: cloneDamage(entry.damage) || fullDamage(),
                flags: Object.assign({}, entry.flags),
                revision: entry.revision,
            });
        }
    }

    // Mark a view dirty and ensure a single frame is pending. Damage merges;
    // ordered mutations are NOT this scheduler's concern.
    function invalidate(req = {}) {
        const viewId = req.viewId;
        if (viewId == null) throw new Error('invalidate requires a viewId');
        if (req.generation != null && req.generation < generation) return; // stale document
        mergeIntoDirty(viewId, {
            damage: req.damage || fullDamage(),
            flags: req.flags || {},
            revision: req.revision,
        });
        ensureFrame();
    }

    function renderView(view, entry, tickNow, scheduled) {
        view.lastRender = tickNow;
        view.render({
            viewId: entry.viewId,
            damage: entry.damage || fullDamage(),
            flags: entry.flags || {},
            revision: entry.revision,
            scheduled: !!scheduled,
        });
        if (scheduled) bump('scheduledPresentations'); else bump('explicitPresentations');
    }

    function tick() {
        frameHandle = null;
        // Swap the dirty set first: invalidations arriving *during* rendering land
        // in the fresh map and are serviced by a later frame, never this one.
        const batch = dirty;
        dirty = new Map();
        const tickNow = now();
        let deferredSecondary = false;

        for (const [viewId, entry] of batch) {
            entry.viewId = viewId;
            const view = views.get(viewId);
            if (!view) continue;
            if (!view.visible) {
                // Hidden views perform no refresh; keep the damage for when shown.
                mergeIntoDirty(viewId, entry);
                bump('skippedPresentations');
                continue;
            }
            const forced = entry.flags && (entry.flags.commit || entry.flags.force);
            if (view.secondary && !forced && (tickNow - view.lastRender) < view.minIntervalMs) {
                // Throttled secondary view (thumbnails/bitplanes): defer, keep dirty,
                // and make sure a later frame fires even without new invalidations.
                mergeIntoDirty(viewId, entry);
                deferredSecondary = true;
                bump('skippedPresentations');
                continue;
            }
            renderView(view, entry, tickNow, true);
        }

        bump('scheduledTicks');

        if (dirty.size) ensureFrame();
        if (deferredSecondary) scheduleThrottleCheck();
    }

    function scheduleThrottleCheck() {
        if (throttleHandle != null) return;
        throttleHandle = timer(() => {
            throttleHandle = null;
            if (dirty.size) ensureFrame();
        }, DEFAULT_SECONDARY_INTERVAL_MS);
    }

    // Synchronous compatibility/snapshot barrier (design §3.2). NOT used per pointer
    // event; counted separately from scheduled presentation. Renders the target
    // view(s) now regardless of throttle/visibility so a save/export/snapshot sees
    // current content.
    function flushNow(req = {}) {
        const tickNow = now();
        const targets = req.viewId != null ? [req.viewId] : Array.from(views.keys());
        for (const viewId of targets) {
            const view = views.get(viewId);
            if (!view) continue;
            const entry = dirty.get(viewId) || { damage: fullDamage(), flags: {} };
            entry.viewId = viewId;
            dirty.delete(viewId);
            renderView(view, entry, tickNow, false);
        }
        bump('explicitFlushes');
    }

    function setVisible(viewId, visible) {
        const view = views.get(viewId);
        if (!view) return;
        const wasVisible = view.visible;
        view.visible = !!visible;
        // Becoming visible with pending damage: refresh on a frame (design §2.4).
        if (!wasVisible && view.visible && dirty.has(viewId)) ensureFrame();
    }

    // Whole-document teardown (design §3.1/§3.2): cancel pending work, drop dirty
    // state, and advance the generation so late stale invalidations are ignored.
    function disposeDocument(documentGeneration) {
        if (documentGeneration != null) generation = documentGeneration;
        else generation++;
        dirty = new Map();
        if (frameHandle != null) { cancelFrame(frameHandle); frameHandle = null; }
        if (throttleHandle != null) { clearTimer(throttleHandle); throttleHandle = null; }
        views.forEach(v => { v.lastRender = -Infinity; });
    }

    return {
        registerView,
        invalidate,
        flushNow,
        setVisible,
        disposeDocument,
        // introspection for tests / diagnostics
        getCounters: () => Object.assign({}, counters),
        hasPendingFrame: () => frameHandle != null,
        pendingViews: () => Array.from(dirty.keys()),
        getGeneration: () => generation,
    };
}

const visualScheduler = createVisualScheduler();
export default visualScheduler;
