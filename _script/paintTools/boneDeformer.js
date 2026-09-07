import EventBus from "../util/eventbus.js";
import { EVENT } from "../enum.js";
import { duplicateCanvas, releaseCanvas } from "../util/canvasUtils.js";
import { restWorld, poseWorld, skinMatrix, segmentDistance, falloff, applyMatrix } from "../util/boneUtils.js";

// Bone deformation engine (spec 005, design §3). The performance-critical core.
//
// Non-destructive: it never touches a governed layer's own pixels. Given a governed node, the
// node's effective scope offset, and the armature (bones + poses), it returns a DEFORMED canvas
// the compositor draws in place of node.render(). At rest it returns null so the compositor draws
// the original content untouched (R22 — pixel-identical to no bone layer).
//
// Technique (shared with meshWarp.js): a uniform GRID×GRID mesh over the node's canvas. Weights
// (how strongly each vertex follows each bone) are precomputed once at BIND time from the rest
// pose — the amortized, expensive step. Per frame the mesh is re-SKINNED (linear blend skinning,
// O(vertices·K)) and rendered as two affine-textured triangles per cell, mapping an immutable
// source snapshot onto the deformed mesh. K = 4 bones per vertex keeps the inner loop tiny.
//
// Coordinate spaces: bones live in SCOPE coords (the space of the layers[] array they sit in);
// a node's canvas-local pixel (cx,cy) sits at scope coord (cx + offset.x, cy + offset.y). The
// mesh is built in canvas-local coords and skinned in scope coords, then mapped back.
let BoneDeformer = function () {
    let me = {};

    const K = 4;                 // max bones influencing a vertex
    const SEAM_EXPAND = 0.6;     // px each triangle grows outward to hide anti-alias seams
    const DEFAULT_GRID = 16;

    // node -> bind/cache entry. Cleared wholesale on content/structure/size changes (cheap to
    // rebuild); pose changes keep the entry and only re-skin. Keyed by node identity.
    let cache = new Map();

    // ── public: does this armature deform anything (any non-rest pose)? ──────────────
    // A rest armature composites identically to no bones, so the compositor can skip it entirely.
    me.hasDeformation = function (bones) {
        if (!bones || !bones.length) return false;
        for (let i = 0; i < bones.length; i++) {
            let p = bones[i].pose;
            if (p && (p.angle || p.x || p.y || (p.scale && p.scale !== 1))) return true;
        }
        return false;
    };

    // ── public: the deformed canvas for one governed node, or null (draw original) ───
    // `offset` is the node's effective {x,y} in scope coords (from the compositor).
    // `bones` is the armature's bones array (each carrying its current `pose`).
    me.getDeformedCanvas = function (node, offset, bones, gridQuality) {
        if (!node || !me.hasDeformation(bones)) return null;

        let source = node.render();
        if (!source || !source.width || !source.height) return null;

        let grid = gridQuality || DEFAULT_GRID;
        let bindSig = signature(bones, offset, grid, source.width, source.height, true);
        let poseSig = signature(bones, offset, grid, source.width, source.height, false);

        let entry = cache.get(node);
        if (!entry || entry.bindSig !== bindSig) {
            entry = bind(node, source, offset, bones, grid);
            entry.bindSig = bindSig;
            entry.poseSig = null;
            cache.set(node, entry);
        }
        if (entry.poseSig !== poseSig) {
            skinAndRender(entry, bones);
            entry.poseSig = poseSig;
        }
        return entry.deformed;
    };

    // A cheap change-signature. Bones are few, so JSON per composite is negligible next to the
    // render. `bind=true` covers everything that invalidates the WEIGHTS (rest geometry, radius,
    // hierarchy, offset, grid, canvas size); `bind=false` covers only the POSES (re-skin only).
    function signature(bones, offset, grid, w, h, bindPart) {
        if (bindPart) {
            let parts = bones.map(b => b.id + ":" + b.parentId + ":" + b.rest.x + "," + b.rest.y +
                "," + b.rest.angle + "," + b.rest.length + ":" + b.actionRadius);
            return grid + "|" + w + "x" + h + "|" + offset.x + "," + offset.y + "|" + parts.join(";");
        }
        return bones.map(b => {
            let p = b.pose || {};
            return (p.angle || 0) + "," + (p.x || 0) + "," + (p.y || 0) + "," + (p.scale || 1);
        }).join(";");
    }

    // ── bind: snapshot + mesh + per-vertex weights (amortized; NOT per frame) ─────────
    function bind(node, source, offset, bones, grid) {
        let w = source.width;
        let h = source.height;

        // Immutable source texture — sampled every frame, never re-read.
        let snapshot = duplicateCanvas(source, true);

        let cols = grid + 1;
        let rows = grid + 1;
        let verts = [];
        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
                let cx = col * w / grid;
                let cy = row * h / grid;
                // Scope-space rest position (the skinning input).
                let sx = cx + offset.x;
                let sy = cy + offset.y;
                verts.push({ cx, cy, sx, sy, weights: computeWeights(sx, sy, bones) });
            }
        }

        return { cols, rows, grid, w, h, offset: { x: offset.x, y: offset.y }, snapshot, verts, deformed: null };
    }

    // Top-K normalized falloff weights for a scope-space point against every bone. A point that
    // no bone reaches gets an empty list ⇒ it is pinned (identity), so untouched regions stay put.
    function computeWeights(sx, sy, bones) {
        let all = [];
        for (let i = 0; i < bones.length; i++) {
            let d = segmentDistance(sx, sy, bones[i]);
            let wgt = falloff(d, bones[i].actionRadius);
            if (wgt > 0) all.push({ boneIndex: i, w: wgt });
        }
        if (!all.length) return all;
        all.sort((a, b) => b.w - a.w);
        if (all.length > K) all.length = K;
        let sum = 0;
        for (let i = 0; i < all.length; i++) sum += all[i].w;
        if (sum > 0) for (let i = 0; i < all.length; i++) all[i].w /= sum;
        return all;
    }

    // ── skin + render (per frame, cheap) ─────────────────────────────────────────────
    function skinAndRender(entry, bones) {
        let restW = restWorld(bones);
        let poseW = poseWorld(bones);
        // One skinning matrix per bone (O(bones)), reused across all vertices.
        let S = bones.map(b => skinMatrix(b.id, restW, poseW));

        // Deform every vertex: v' = Σ wᵢ · Sᵢ·vRest (linear blend skinning). The skinned point is
        // in SCOPE coords; subtract the node's offset to land back in the deformed canvas.
        let offX = entry.offset.x;
        let offY = entry.offset.y;
        let verts = entry.verts;
        for (let i = 0; i < verts.length; i++) {
            let v = verts[i];
            let ws = v.weights;
            if (!ws.length) { v.dx = v.cx; v.dy = v.cy; continue; } // pinned (no bone reaches it)
            let ox = 0, oy = 0;
            for (let k = 0; k < ws.length; k++) {
                let p = applyMatrix(S[ws[k].boneIndex], v.sx, v.sy);
                ox += ws[k].w * p.x;
                oy += ws[k].w * p.y;
            }
            v.dx = ox - offX;
            v.dy = oy - offY;
        }
        renderMesh(entry);
    }

    // ── render the deformed mesh into entry.deformed ─────────────────────────────────
    function renderMesh(entry) {
        if (!entry.deformed || entry.deformed.width !== entry.w || entry.deformed.height !== entry.h) {
            if (entry.deformed) releaseCanvas(entry.deformed);
            entry.deformed = document.createElement("canvas");
            entry.deformed.width = entry.w;
            entry.deformed.height = entry.h;
        }
        let ctx = entry.deformed.getContext("2d");
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, entry.w, entry.h);

        let cols = entry.cols;
        let verts = entry.verts;
        let idx = (col, row) => row * cols + col;
        for (let row = 0; row < entry.grid; row++) {
            for (let col = 0; col < entry.grid; col++) {
                let a = idx(col, row);
                let b = idx(col + 1, row);
                let c = idx(col, row + 1);
                let d = idx(col + 1, row + 1);
                drawTriangle(ctx, entry.snapshot, verts[a], verts[b], verts[d]);
                drawTriangle(ctx, entry.snapshot, verts[a], verts[d], verts[c]);
            }
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    // Texture-map the source triangle (v.cx,v.cy in snapshot coords) onto the deformed triangle
    // (v.dx,v.dy in the deformed canvas) via a clipped affine draw. Same math as meshWarp.
    function drawTriangle(ctx, snapshot, v0, v1, v2) {
        let s0x = v0.cx, s0y = v0.cy, s1x = v1.cx, s1y = v1.cy, s2x = v2.cx, s2y = v2.cy;
        let ax = v0.dx, ay = v0.dy, bx = v1.dx, by = v1.dy, cx = v2.dx, cy = v2.dy;

        let dx1 = s1x - s0x, dy1 = s1y - s0y;
        let dx2 = s2x - s0x, dy2 = s2y - s0y;
        let det = dx1 * dy2 - dx2 * dy1;
        if (det > -1e-6 && det < 1e-6) return; // degenerate source

        ctx.save();

        let mx = (ax + bx + cx) / 3, my = (ay + by + cy) / 3;
        let e0 = expand(ax, ay, mx, my);
        let e1 = expand(bx, by, mx, my);
        let e2 = expand(cx, cy, mx, my);
        ctx.beginPath();
        ctx.moveTo(e0.x, e0.y);
        ctx.lineTo(e1.x, e1.y);
        ctx.lineTo(e2.x, e2.y);
        ctx.closePath();
        ctx.clip();

        let ex1 = bx - ax, ey1 = by - ay;
        let ex2 = cx - ax, ey2 = cy - ay;
        let ma = (ex1 * dy2 - ex2 * dy1) / det;
        let mb = (ey1 * dy2 - ey2 * dy1) / det;
        let mc = (ex2 * dx1 - ex1 * dx2) / det;
        let md = (ey2 * dx1 - ey1 * dx2) / det;
        let me_ = ax - ma * s0x - mc * s0y;
        let mf = ay - mb * s0x - md * s0y;

        ctx.setTransform(ma, mb, mc, md, me_, mf);
        ctx.drawImage(snapshot, 0, 0);
        ctx.restore();
    }

    function expand(x, y, mx, my) {
        let dx = x - mx, dy = y - my;
        let len = Math.sqrt(dx * dx + dy * dy) || 1;
        return { x: x + dx / len * SEAM_EXPAND, y: y + dy / len * SEAM_EXPAND };
    }

    // ── invalidation ─────────────────────────────────────────────────────────────────
    me.invalidate = function () {
        cache.forEach(entry => { if (entry.snapshot) releaseCanvas(entry.snapshot); if (entry.deformed) releaseCanvas(entry.deformed); });
        cache.clear();
    };
    me.invalidateNode = function (node) {
        let entry = cache.get(node);
        if (!entry) return;
        if (entry.snapshot) releaseCanvas(entry.snapshot);
        if (entry.deformed) releaseCanvas(entry.deformed);
        cache.delete(node);
    };

    // Content/structure/size changes rebind (weights + snapshot); pose changes do not (they only
    // re-skin, handled by the poseSig check). Painting a governed layer fires layerContentChanged.
    EventBus.on(EVENT.layerContentChanged, me.invalidate);
    EventBus.on(EVENT.layersChanged, me.invalidate);
    EventBus.on(EVENT.imageContentChanged, me.invalidate);
    EventBus.on(EVENT.imageSizeChanged, me.invalidate);

    return me;
}();

export default BoneDeformer;
