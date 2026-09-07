// Clipped stack reconstruction planning for spec 016 (Editor Performance),
// phase 4.4, design §3.3/§4.
//
// Given a layer stack and a damage rectangle, decide HOW to repaint just that region
// correctly. The rule the design insists on: redraw the relevant stack clipped to the
// damage from a CLEARED target — never paint an eraser's latest layer over stale
// composite pixels (design §3.3). Optimisations must not change that result:
//
//   - Opaque-cover shortcut: if some layer fully and opaquely covers the damage with a
//     normal blend and full opacity, layers BELOW it cannot contribute, so the plan
//     starts at that layer. A non-normal blend / <100% opacity / a layer that does not
//     fully cover the damage is backdrop-dependent and disables the shortcut (we must
//     include everything below).
//   - Opaque bounds are cached by content revision; edge erasure/shrink invalidates the
//     cache so the next query rescans. Expansion may update incrementally.
//   - Adaptive full redraw: when the damage area is a large fraction of the document,
//     a full redraw is cheaper than clipped bookkeeping — chosen by area only, never
//     changing correctness (design §4: "Dense damage can choose a full redraw").
//
// Pure and injectable. Layers are plain descriptors:
//   { id, visible, opacity (0..100), blendMode, contentRevision, opaqueBounds?, bounds? }
// opaqueBounds/bounds are half-open rects in document space (or omitted/null when
// unknown -> treated as not-covering / unknown).

const DEFAULT_FULL_REDRAW_FRACTION = 0.6;

// True when a layer, on its own, fully and opaquely covers `rect` with a normal blend.
export function coversOpaque(layer, rect) {
    if (!layer || !layer.visible) return false;
    if ((layer.opacity == null ? 100 : layer.opacity) < 100) return false;
    if (layer.blendMode && layer.blendMode !== "normal") return false;
    const ob = layer.opaqueBounds;
    if (!ob) return false;
    return ob.x <= rect.x && ob.y <= rect.y &&
        ob.x + ob.width >= rect.x + rect.width &&
        ob.y + ob.height >= rect.y + rect.height;
}

// Plan the reconstruction of `damageRect` over `layers` (bottom-to-top order, index 0 is
// the bottom). Returns:
//   { mode: 'clip'|'full', clip: rect|null, startIndex, layers:[indices], fullRedraw }
// startIndex is the lowest layer that can contribute; layers below an opaque cover are
// dropped. Backdrop-dependent layers keep everything below them.
export function planReconstruction(layers, damageRect, options) {
    options = options || {};
    const docWidth = options.docWidth || 0;
    const docHeight = options.docHeight || 0;
    const fullFraction = options.fullRedrawFraction != null ? options.fullRedrawFraction : DEFAULT_FULL_REDRAW_FRACTION;

    // Adaptive full redraw by area (correctness-neutral).
    if (docWidth > 0 && docHeight > 0 && damageRect) {
        const damageArea = damageRect.width * damageRect.height;
        const docArea = docWidth * docHeight;
        if (docArea > 0 && damageArea / docArea >= fullFraction) {
            return { mode: "full", clip: null, startIndex: 0, layers: layers.map((_, i) => i), fullRedraw: true, damageArea, docArea };
        }
    }

    // Find the highest opaque cover; layers below it are invisible through the damage.
    let startIndex = 0;
    for (let i = layers.length - 1; i >= 0; i--) {
        if (coversOpaque(layers[i], damageRect)) { startIndex = i; break; }
    }

    const visibleIndices = [];
    for (let i = startIndex; i < layers.length; i++) {
        if (layers[i] && layers[i].visible) visibleIndices.push(i);
    }

    return {
        mode: "clip",
        clip: damageRect ? { x: damageRect.x, y: damageRect.y, width: damageRect.width, height: damageRect.height } : null,
        startIndex,
        layers: visibleIndices,
        fullRedraw: false,
        damageArea: damageRect ? damageRect.width * damageRect.height : 0,
        docArea: docWidth * docHeight,
    };
}

// An opaque-bounds cache keyed by layer identity + content revision. A query returns the
// cached bounds when the revision matches, otherwise it calls `rescan(layer)` to recompute
// and stores the result. Edge erasure/shrink is signalled by `invalidate` (e.g. the tool
// erased at the layer edge), forcing the next query to rescan even at the same revision.
export function createOpaqueBoundsCache(rescan) {
    const byId = new Map(); // id -> { revision, bounds, dirty }

    function get(layer) {
        const id = layer.id;
        const rev = layer.contentRevision || 0;
        const entry = byId.get(id);
        if (entry && !entry.dirty && entry.revision === rev) return entry.bounds;
        const bounds = rescan ? rescan(layer) : (layer.opaqueBounds || null);
        byId.set(id, { revision: rev, bounds, dirty: false });
        return bounds;
    }

    // Growth can extend cached bounds without a rescan (design §4: "Expansion can update
    // incrementally"). Only unions; never shrinks (shrink must invalidate).
    function expand(layer, rect) {
        const id = layer.id;
        const entry = byId.get(id);
        if (!entry || entry.dirty) return get(layer);
        entry.bounds = entry.bounds ? unionRect(entry.bounds, rect) : { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        entry.revision = layer.contentRevision || 0;
        return entry.bounds;
    }

    // Edge erasure / shrink: the cached bounds may now be too large, so mark for rescan.
    function invalidate(layer) {
        const entry = byId.get(layer.id || layer);
        if (entry) entry.dirty = true;
    }

    function invalidateAll() { for (const e of byId.values()) e.dirty = true; }

    return { get, expand, invalidate, invalidateAll, size: () => byId.size };
}

function unionRect(a, b) {
    const x0 = Math.min(a.x, b.x);
    const y0 = Math.min(a.y, b.y);
    const x1 = Math.max(a.x + a.width, b.x + b.width);
    const y1 = Math.max(a.y + a.height, b.y + b.height);
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

// Total painted-pixel accounting for a plan: the clipped damage area times the number of
// contributing layers (design §13: "damage-area accounting"). Full mode counts the whole
// document once per layer.
export function accountDamageArea(plan, docWidth, docHeight) {
    if (!plan) return 0;
    if (plan.mode === "full") return (docWidth * docHeight) * plan.layers.length;
    const area = plan.clip ? plan.clip.width * plan.clip.height : 0;
    return area * plan.layers.length;
}
