// Minimal damage-region model for spec 016 (Editor Performance), design §4.
//
// A Damage is one of:
//   { kind: 'none' }
//   { kind: 'rects', rects: [{x,y,width,height}, ...] }   // integer half-open bounds
//   { kind: 'full' }
//
// Phase 2 only needs merge + bounds so the visual scheduler can coalesce repeated
// invalidations into one region per view. Phase 4 extends this with transform
// propagation, halos, and tile clipping — keep additions backward compatible.

export const NONE = 'none';
export const RECTS = 'rects';
export const FULL = 'full';

export function emptyDamage() { return { kind: NONE }; }
export function fullDamage() { return { kind: FULL }; }

// Normalise to integer half-open bounds; a zero/negative-area rect collapses to none.
export function rectDamage(rect) {
    const r = normalizeRect(rect);
    return r ? { kind: RECTS, rects: [r] } : emptyDamage();
}

function normalizeRect(rect) {
    if (!rect) return null;
    const x = Math.floor(rect.x);
    const y = Math.floor(rect.y);
    const width = Math.ceil(rect.x + rect.width) - x;
    const height = Math.ceil(rect.y + rect.height) - y;
    if (!(width > 0) || !(height > 0)) return null;
    if (![x, y, width, height].every(Number.isFinite)) return null;
    return { x, y, width, height };
}

// Merge two damages. none is the identity; full absorbs everything; otherwise the
// rect lists concatenate (the scheduler works with the union, not the individual
// rects, so we keep them cheap rather than deduplicating here).
export function mergeDamage(a, b) {
    if (!a || a.kind === NONE) return cloneDamage(b) || emptyDamage();
    if (!b || b.kind === NONE) return cloneDamage(a);
    if (a.kind === FULL || b.kind === FULL) return fullDamage();
    return { kind: RECTS, rects: a.rects.concat(b.rects) };
}

export function cloneDamage(d) {
    if (!d) return null;
    if (d.kind === FULL) return fullDamage();
    if (d.kind === NONE) return emptyDamage();
    return { kind: RECTS, rects: d.rects.map(r => ({ x: r.x, y: r.y, width: r.width, height: r.height })) };
}

// The bounding rectangle of a damage, or null for none, or the string 'full'.
export function damageBounds(d) {
    if (!d || d.kind === NONE) return null;
    if (d.kind === FULL) return FULL;
    if (!d.rects.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const r of d.rects) {
        if (r.x < minX) minX = r.x;
        if (r.y < minY) minY = r.y;
        if (r.x + r.width > maxX) maxX = r.x + r.width;
        if (r.y + r.height > maxY) maxY = r.y + r.height;
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function isEmpty(d) { return !d || d.kind === NONE; }
