// Viewport exposure + source-aware hover/pick caching for spec 016
// (Editor Performance), phase 4.5, design §3.2/§3.3/§4.
//
// Two related concerns:
//
//   1. Viewport exposure — when the user pans/zooms, pixels that were off-screen become
//      visible and must be invalidated even though their content did not change. Given
//      the previous and current visible document rectangles, `exposedDamage` returns the
//      L-shaped (or full) region newly brought into view. A zoom-in exposes nothing new
//      (the new view is a subset); a zoom-out or pan can expose bands on any side.
//
//   2. Hover/pick sampling cache — status-bar colour sampling is throttled and keyed by
//      the document coordinate PLUS the revision of the source it sampled, and by whether
//      it sampled the active layer or the merged/display composite (design §3.2/§3.3:
//      "resolves either layer-local or merged/display content explicitly" and "caches
//      document coordinate plus sampled-source revision"). A change to that source's
//      revision, or a live filter preview appearing/updating, invalidates the entry.
//
// Pure and injectable. Rects are half-open integer document bounds.

import { intersectRect, roundOut } from "./damagePropagation.js";
import { rectDamage, fullDamage, emptyDamage, mergeDamage } from "./damage.js";

// The region of `next` (the new visible doc rect) that was NOT visible in `prev`.
// Returns a Damage. If prev is missing/does-not-overlap, the whole next view is exposed.
// The exposed area is the set difference next \ prev, expressed as up to four bands so
// the renderer repaints only the strips that scrolled in.
export function exposedDamage(prev, next) {
    const n = roundOut(next);
    if (!n) return emptyDamage();
    const p = roundOut(prev);
    if (!p) return rectDamage(n);
    const overlap = intersectRect(p, n);
    if (!overlap) return rectDamage(n); // scrolled entirely to new content
    let damage = emptyDamage();
    // left band
    if (overlap.x > n.x) damage = mergeDamage(damage, rectDamage({ x: n.x, y: n.y, width: overlap.x - n.x, height: n.height }));
    // right band
    const nRight = n.x + n.width, oRight = overlap.x + overlap.width;
    if (nRight > oRight) damage = mergeDamage(damage, rectDamage({ x: oRight, y: n.y, width: nRight - oRight, height: n.height }));
    // top band (within the horizontal overlap only, to avoid double-counting corners)
    if (overlap.y > n.y) damage = mergeDamage(damage, rectDamage({ x: overlap.x, y: n.y, width: overlap.width, height: overlap.y - n.y }));
    // bottom band
    const nBottom = n.y + n.height, oBottom = overlap.y + overlap.height;
    if (nBottom > oBottom) damage = mergeDamage(damage, rectDamage({ x: overlap.x, y: oBottom, width: overlap.width, height: nBottom - oBottom }));
    return damage;
}

// A single-entry hover/pick sample cache. The key is (x, y, source, sourceRevision,
// previewRevision); a hit returns the cached sample, a miss calls `sampler` and stores
// it. `source` is 'active' (layer-local) or 'merged' (display composite) and is part of
// the key so switching pick mode never returns the other mode's colour.
export function createHoverCache(options) {
    options = options || {};
    const sampler = options.sampler; // (x,y,source) -> sample value
    let entry = null; // { x, y, source, sourceRevision, previewRevision, value }
    const counters = { hits: 0, misses: 0, invalidations: 0 };

    // revisions: { sourceRevision, previewRevision } captured at sample time.
    function sample(x, y, source, revisions) {
        source = source || "merged";
        const sourceRevision = (revisions && revisions.sourceRevision) || 0;
        const previewRevision = (revisions && revisions.previewRevision) || 0;
        if (entry &&
            entry.x === x && entry.y === y && entry.source === source &&
            entry.sourceRevision === sourceRevision && entry.previewRevision === previewRevision) {
            counters.hits++;
            return entry.value;
        }
        counters.misses++;
        const value = sampler ? sampler(x, y, source) : undefined;
        entry = { x, y, source, sourceRevision, previewRevision, value };
        return value;
    }

    // Explicitly drop the cache (e.g. document generation change or preview closed).
    function invalidate() { if (entry) { entry = null; counters.invalidations++; } }

    function getCounters() { return Object.assign({}, counters); }
    function hasEntry() { return !!entry; }

    return { sample, invalidate, getCounters, hasEntry };
}
