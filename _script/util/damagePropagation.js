// Damage propagation for spec 016 (Editor Performance), phase 4.3, design §3.3/§4.
//
// Phase 2's util/damage.js gave us the {none|rects|full} model plus merge/bounds.
// The incremental renderer needs to move a *local* damage rectangle up through the
// transforms that sit between a layer's own pixels and the document/composite:
//   - a layer offset (x,y) applied by its parent at composite time,
//   - a runtime affine transform on a group,
//   - conservative expansion by a sampling/kernel halo,
//   - the union of a move's OLD and NEW coverage,
//   - intersection with a mask's coverage,
//   - and a conservative FULL fallback for unknown/global dependencies.
//
// Everything works in integer half-open pixel bounds (Rect = {x,y,width,height}) and
// rounds outward so a propagated region never under-covers the pixels that changed.
// Unknown / non-finite / global inputs collapse to full damage — never to none — so
// the renderer errs toward repainting too much, not too little (design §4:
// "Unknown/global dependency uses full damage").

import { NONE, RECTS, FULL, emptyDamage, fullDamage, rectDamage, mergeDamage, cloneDamage } from "./damage.js";

// Round a floating rect OUTWARD to integer half-open bounds; null for empty/non-finite.
export function roundOut(rect) {
    if (!rect) return null;
    const x0 = Math.floor(rect.x);
    const y0 = Math.floor(rect.y);
    const x1 = Math.ceil(rect.x + rect.width);
    const y1 = Math.ceil(rect.y + rect.height);
    if (![x0, y0, x1, y1].every(Number.isFinite)) return null;
    const width = x1 - x0;
    const height = y1 - y0;
    if (!(width > 0) || !(height > 0)) return null;
    return { x: x0, y: y0, width, height };
}

// Intersect two half-open rects; null if they do not overlap.
export function intersectRect(a, b) {
    if (!a || !b) return null;
    const ax1 = a.x + a.width, ay1 = a.y + a.height;
    const bx1 = b.x + b.width, by1 = b.y + b.height;
    const ix0 = Math.max(a.x, b.x);
    const iy0 = Math.max(a.y, b.y);
    const ix1 = Math.min(ax1, bx1);
    const iy1 = Math.min(ay1, by1);
    if (ix1 <= ix0 || iy1 <= iy0) return null;
    return { x: ix0, y: iy0, width: ix1 - ix0, height: iy1 - iy0 };
}

// Expand a rect by `halo` pixels on every side (sampling/kernel support). halo<=0 is
// a no-op; a non-finite halo yields null so the caller falls back to full damage.
export function expandRect(rect, halo) {
    if (!rect) return null;
    const h = halo || 0;
    if (!Number.isFinite(h)) return null;
    if (h <= 0) return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    return roundOut({ x: rect.x - h, y: rect.y - h, width: rect.width + 2 * h, height: rect.height + 2 * h });
}

// Translate a rect by an integer/float offset, rounding outward.
export function translateRect(rect, dx, dy) {
    if (!rect) return null;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
    return roundOut({ x: rect.x + dx, y: rect.y + dy, width: rect.width, height: rect.height });
}

// Transform a rect's four corners by a 2x3 affine matrix {a,b,c,d,e,f} where
// x' = a*x + c*y + e, y' = b*x + d*y + f, then take the outward-rounded bounding box.
// A non-finite matrix entry yields null (caller falls back to full). This is the
// conservative axis-aligned cover of a rotated/scaled rect (design §3.3: "Clamp after
// transforming all corners").
export function transformRectBounds(rect, m) {
    if (!rect || !m) return null;
    const vals = [m.a, m.b, m.c, m.d, m.e, m.f];
    if (!vals.every(Number.isFinite)) return null;
    const x0 = rect.x, y0 = rect.y, x1 = rect.x + rect.width, y1 = rect.y + rect.height;
    const corners = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [px, py] of corners) {
        const tx = m.a * px + m.c * py + m.e;
        const ty = m.b * px + m.d * py + m.f;
        if (tx < minX) minX = tx;
        if (ty < minY) minY = ty;
        if (tx > maxX) maxX = tx;
        if (ty > maxY) maxY = ty;
    }
    return roundOut({ x: minX, y: minY, width: maxX - minX, height: maxY - minY });
}

// Map every rect of a damage through `fn(rect) -> rect|null`. If any rect maps to
// null (a non-finite / unknown transform), the whole damage becomes FULL — we never
// silently drop a region we could not map. none/full pass through unchanged.
export function mapDamageRects(damage, fn) {
    if (!damage || damage.kind === NONE) return emptyDamage();
    if (damage.kind === FULL) return fullDamage();
    const out = [];
    for (const r of damage.rects) {
        const mapped = fn(r);
        if (!mapped) return fullDamage();
        out.push(mapped);
    }
    return out.length ? { kind: RECTS, rects: out } : emptyDamage();
}

// Propagate a layer-local damage up to its parent scope, applying (in order):
//   offset {dx,dy}, then optional affine transform, then optional halo expansion,
//   then optional clip rect (e.g. the parent/document bounds or a mask coverage).
// Returns a Damage. Any un-mappable step yields full damage.
export function propagateDamage(damage, options) {
    options = options || {};
    let result = damage;
    if (options.dx || options.dy) {
        const dx = options.dx || 0, dy = options.dy || 0;
        result = mapDamageRects(result, r => translateRect(r, dx, dy));
    }
    if (options.transform) {
        result = mapDamageRects(result, r => transformRectBounds(r, options.transform));
    }
    if (options.halo) {
        result = mapDamageRects(result, r => expandRect(r, options.halo));
    }
    if (options.clip) {
        // A clip that removes a rect entirely drops it (it is genuinely outside the
        // clip), so mapDamageRects' null-means-full rule is bypassed here.
        if (result.kind === RECTS) {
            const out = [];
            for (const r of result.rects) {
                const c = intersectRect(r, options.clip);
                if (c) out.push(c);
            }
            result = out.length ? { kind: RECTS, rects: out } : emptyDamage();
        }
    }
    return result;
}

// The combined OLD+NEW coverage of a move/transform (design §3.3: "Include old and
// new coverage for moves"). Both are damages already in the destination space.
export function moveDamage(oldDamage, newDamage) {
    return mergeDamage(oldDamage, newDamage);
}

// A group/composite dependency that cannot be expressed as local rects — an unknown
// legacy write, a global palette/dissolve change, a backdrop-dependent blend against
// unknown content — is conservatively full. Exposed as a named helper so callers read
// intent, and so the diagnostic fallback counter has a single choke point.
export function conservativeFull() { return fullDamage(); }

// Re-export the base damage.js constructors so callers of the propagation layer have a
// single import surface (rectDamage/mergeDamage/etc. build the inputs these functions map).
export { NONE, RECTS, FULL, emptyDamage, fullDamage, rectDamage, mergeDamage, cloneDamage };
