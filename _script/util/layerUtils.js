import {duplicateCanvas, releaseCanvas} from "./canvasUtils.js";
import {applyDissolve, applyIfLighter, isDissolveComparison, dissolveFollowsOpacity} from "./dissolveUtils.js";
import BoneDeformer from "../paintTools/boneDeformer.js";
import {getDisplayMode} from "./vectorUtils.js";

// Tree helpers for the layer model.
// A node is a "group" iff node.type === "group"; group nodes carry a layers[] array.
// frame.layers is the root array of nodes. A "path" is an array of indices into the
// tree, e.g. [2] = root[2], [2,1] = root[2].layers[1]. The empty path [] addresses
// no node (resolveLayerPath returns undefined) — root itself is the `nodes` argument.

export function isGroup(node) {
    return !!node && node.type === "group";
}

// A node is a "bone" layer iff node.type === "bone"; bone nodes carry an `armature` (a tree of
// bones) and paint no pixels of their own — they deform their younger siblings at composite time.
export function isBones(node) {
    return !!node && node.type === "bone";
}

// A node is a "vector" layer iff node.type === "vector"; vector nodes carry a `vector` object
// (id-keyed nodes/edges/regions — see util/vectorUtils.js) instead of a static bitmap. Unlike a
// bone layer it DOES paint pixels: render() rasterizes its geometry into its own canvas, so at
// composite time it behaves exactly like a pixel layer. (Exception: with the "vector" display mode,
// compositeNodes skips it on screen when the skipVectorDisplay option is set — it is drawn as a true
// SVG overlay instead; export/bake never sets the flag, so the raster always includes it.)
export function isVector(node) {
    return !!node && node.type === "vector";
}

// The effective x/y/opacity of a node: the timeline property overlay REPLACES the node's
// own base values per layer id (never added, never multiplied — see spec 004 design 3.3).
// Without a matching override the node's own base values apply, so a plain
// compositeNodes(nodes, ctx) call keeps the pre-timeline behaviour.
//
// A GROUP node additionally carries a runtime transform (spec 007): scaleX/scaleY/rotation,
// applied about its content-bounds centre at composite time. These are NON-destructive (the
// child pixels are never resampled — only the composited group canvas is) and animate through
// the same property overlay as x/y/opacity. Identity (1,1,0) reproduces the pre-007 behaviour.
export function effectiveProps(node, props) {
    let group = isGroup(node);
    let base = {
        x: (node && node.x) || 0,
        y: (node && node.y) || 0,
        opacity: (node && typeof node.opacity === "number") ? node.opacity : 100
    };
    if (group) {
        base.scaleX = (node && typeof node.scaleX === "number") ? node.scaleX : 1;
        base.scaleY = (node && typeof node.scaleY === "number") ? node.scaleY : 1;
        base.rotation = (node && typeof node.rotation === "number") ? node.rotation : 0;
    }
    let override = (props && node && node.id) ? props[node.id] : undefined;
    if (!override) return base;
    let out = {
        x: typeof override.x === "number" ? override.x : base.x,
        y: typeof override.y === "number" ? override.y : base.y,
        opacity: typeof override.opacity === "number" ? override.opacity : base.opacity
    };
    if (group) {
        out.scaleX = typeof override.scaleX === "number" ? override.scaleX : base.scaleX;
        out.scaleY = typeof override.scaleY === "number" ? override.scaleY : base.scaleY;
        out.rotation = typeof override.rotation === "number" ? override.rotation : base.rotation;
    }
    return out;
}

// True when a group's effective transform is anything other than identity (needs the matrix
// path). Cheap guard so the untransformed common case stays a plain drawImage.
export function hasGroupTransform(effective) {
    return !!effective && (effective.scaleX !== 1 || effective.scaleY !== 1 || (effective.rotation || 0) !== 0);
}

// ── 2D affine matrix helpers (group transform, spec 007) ───────────────────────────
// A matrix m = {a,b,c,d,e,f} maps (x,y) → (a*x + c*y + e, b*x + d*y + f) — the same
// component order as CanvasRenderingContext2D.setTransform(a,b,c,d,e,f).
export function matIdentity() { return {a: 1, b: 0, c: 0, d: 1, e: 0, f: 0}; }

// m ∘ n — the transform that applies n FIRST, then m.
export function matMultiply(m, n) {
    return {
        a: m.a * n.a + m.c * n.b,
        b: m.b * n.a + m.d * n.b,
        c: m.a * n.c + m.c * n.d,
        d: m.b * n.c + m.d * n.d,
        e: m.a * n.e + m.c * n.f + m.e,
        f: m.b * n.e + m.d * n.f + m.f
    };
}

export function matTranslate(x, y) { return {a: 1, b: 0, c: 0, d: 1, e: x, f: y}; }
export function matScale(sx, sy) { return {a: sx, b: 0, c: 0, d: sy, e: 0, f: 0}; }
export function matRotate(deg) {
    let r = deg * Math.PI / 180, cos = Math.cos(r), sin = Math.sin(r);
    return {a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0};
}
export function matApply(m, p) {
    return {x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f};
}
export function matInvert(m) {
    let det = m.a * m.d - m.b * m.c;
    if (!det) return matIdentity();
    let ia = m.d / det, ib = -m.b / det, ic = -m.c / det, id = m.a / det;
    return {a: ia, b: ib, c: ic, d: id, e: -(ia * m.e + ic * m.f), f: -(ib * m.e + id * m.f)};
}

// The group's local (group-canvas) → transformed coordinate matrix: rotate+scale ABOUT the
// centre of its content bounds (decision 1 — "fit bbox, centre pivot"). `bounds` is the opaque
// bounding box of the composited group canvas, in group-canvas coordinates.
export function groupTransformMatrix(effective, bounds) {
    let cx = bounds.x + bounds.w / 2;
    let cy = bounds.y + bounds.h / 2;
    let m = matTranslate(cx, cy);
    m = matMultiply(m, matRotate(effective.rotation || 0));
    m = matMultiply(m, matScale(effective.scaleX, effective.scaleY));
    m = matMultiply(m, matTranslate(-cx, -cy));
    return m;
}

// Opaque bounding box of a canvas, in its own pixel coordinates, or null when fully
// transparent. Used to find a group's content centre (the transform pivot) and extent.
export function getOpaqueBounds(canvas) {
    if (!canvas || !canvas.width || !canvas.height) return null;
    let ctx = canvas.getContext("2d", {willReadFrequently: true});
    let w = canvas.width, h = canvas.height;
    let data = ctx.getImageData(0, 0, w, h).data;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (data[(y * w + x) * 4 + 3] > 0) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
    }
    if (maxX < 0) return null;
    return {x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1};
}

// Composites `nodes` onto ctx, bottom of the array first. This is the ONE place a node's
// own offset is applied; node.render() returns unshifted content. `props` (optional) is
// the resolved timeline overlay and is forwarded into group children so a node nested in
// a group can be animated too.
//
// `options` (optional):
//   dissolve         render transparency as a 1-bit stencil instead of alpha blending, and
//                    ignore blend modes (palette-locked mode — see dissolveUtils)
//   originX/originY  DOCUMENT coordinates of this context's (0,0). Only needed for dissolve,
//                    which anchors its pattern to the document rather than to the layer.
export function compositeNodes(nodes, ctx, props, options) {
    let dissolve = !!(options && options.dissolve);
    let originX = (options && options.originX) || 0;
    let originY = (options && options.originY) || 0;
    // On-screen only: a "vector"-display-mode layer is drawn as a true SVG overlay instead (canvas.js),
    // so the raster composite must NOT also paint it — otherwise it would double up under the crisp
    // SVG. Export/bake never sets this flag, so the rasterized geometry is always included there.
    let skipVectorDisplay = !!(options && options.skipVectorDisplay);

    // Bone pre-pass (spec 005 §4): a visible bone layer deforms the pixel layers below it in THIS
    // scope (its younger siblings = lower indices, drawn before it). The deformer returns a
    // deformed canvas per governed node, which we draw instead of node.render() in the loop below.
    // At rest it returns nothing, so the composite is pixel-identical to no bone layer (R22).
    let deformMap = buildDeformMap(nodes, props);

    nodes.forEach(node => {
        if (!node.visible) return;
        // A bone layer paints nothing of its own — it only governs the layers below it.
        if (isBones(node)) return;
        // A "vector"-display layer is painted by the SVG overlay on screen — skip it here (screen only).
        if (skipVectorDisplay && isVector(node) && getDisplayMode(node.vector) === "vector") return;
        let deformed = deformMap && deformMap.get(node);
        let effective = effectiveProps(node, props);
        // Where this node's own content sits in document space — the anchor for its stencil
        // and the origin its children inherit.
        let nodeOriginX = originX + effective.x;
        let nodeOriginY = originY + effective.y;
        let childOptions = dissolve
            ? {dissolve: true, originX: nodeOriginX, originY: nodeOriginY}
            : undefined;
        // skipVectorDisplay propagates into nested UNTRANSFORMED groups (the SVG walker descends
        // those), but NOT into a transformed group — getVectorDisplayLayers leaves vector layers
        // inside a transformed group in the raster, so the composite must keep rasterizing them there.
        let renderOptions = skipVectorDisplay
            ? Object.assign({}, childOptions, {skipVectorDisplay: true})
            : childOptions;

        // A transformed group (spec 007): composite its children to the group canvas as usual,
        // then draw that canvas through a scale/rotation about its content centre. The child
        // pixels are never resampled — only the finished group canvas is — so the transform is
        // non-destructive and reversible. Palette-locked dissolve of a transformed group draws
        // straight (no stencil): a rotated/scaled group cannot preserve the locked palette
        // anyway, so the dither would be meaningless (accepted v1 limitation).
        if (isGroup(node) && hasGroupTransform(effective)) {
            if (dissolve && effective.opacity <= 0) return;
            let rendered = deformed || node.render(props, childOptions);
            let bounds = getOpaqueBounds(rendered);
            if (bounds) {
                let cx = bounds.x + bounds.w / 2;
                let cy = bounds.y + bounds.h / 2;
                let blend = node.blendMode || "normal";
                ctx.save();
                ctx.globalAlpha = dissolve ? 1 : effective.opacity / 100;
                ctx.globalCompositeOperation = (dissolve || blend === "normal") ? "source-over" : blend;
                // Timeline-wide "smooth" toggle (spec 007): off = crisp nearest-neighbour pixels
                // (the pixel-art default), on = bilinear resampling. Not animatable — read straight
                // off the node (ImageFile keeps it consistent across every cel).
                ctx.imageSmoothingEnabled = !!node.smooth;
                // Multiplicative ops (not setTransform) so this composes with any transform the
                // ctx already carries. Order = translate(offset) → about-centre rotate+scale.
                ctx.translate(effective.x, effective.y);
                ctx.translate(cx, cy);
                ctx.rotate((effective.rotation || 0) * Math.PI / 180);
                ctx.scale(effective.scaleX, effective.scaleY);
                ctx.translate(-cx, -cy);
                ctx.drawImage(rendered, 0, 0);
                ctx.restore();
                ctx.globalAlpha = 1;
                ctx.globalCompositeOperation = "source-over";
            }
            return;
        }

        if (dissolve) {
            if (effective.opacity <= 0) return;
            let rendered = deformed || node.render(props, renderOptions);
            // Blend modes are deliberately ignored here: anything but source-over produces
            // colours outside the locked palette, which is the problem dissolve exists to fix.
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = "source-over";
            // Two kinds of pattern have work to do even at full opacity: "if lighter" (it
            // compares against what is already in ctx) and a fixed-density one like voronoi
            // (its holes do not come from the opacity at all).
            let comparison = isDissolveComparison(node.dissolve);
            if (effective.opacity >= 100 && dissolveFollowsOpacity(node.dissolve)) {
                ctx.drawImage(rendered, effective.x, effective.y);
            } else {
                // The stencil has to be punched into the node in isolation, before it meets
                // the layers below — otherwise the holes would cut through those too.
                let stencilled = duplicateCanvas(rendered, true);
                let stencilCtx = stencilled.getContext("2d");
                // Resolved here, and in this order: the comparison picks the candidate pixels
                // against the layers below, then the opacity stencil thins them out.
                if (comparison) applyIfLighter(stencilCtx, ctx, effective.x, effective.y);
                applyDissolve(stencilCtx, effective.opacity, node.dissolve,
                    nodeOriginX, nodeOriginY);
                ctx.drawImage(stencilled, effective.x, effective.y);
                releaseCanvas(stencilled);
            }
            return;
        }

        ctx.globalAlpha = effective.opacity / 100;
        let blend = node.blendMode || "normal";
        ctx.globalCompositeOperation = blend === "normal" ? "source-over" : blend;
        ctx.drawImage(deformed || node.render(props, renderOptions), effective.x, effective.y);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
    });
}

// Returns a bones array whose poses are the RESOLVED poses for this frame, built from the timeline
// overlay `props[boneLayerId].bones` (spec 006). It shallow-copies each bone, replacing only its
// `pose` (falling back per component to the bone's own base pose); every rig field (rest,
// actionRadius, parentId, id) is shared BY REFERENCE, so the deformer's BIND signature is
// unchanged and it re-skins without re-binding. Missing overlay ⇒ the original array is returned
// untouched (zero cost, exactly the Phase-1 path).
function applyPoseOverlay(bones, overlay) {
    if (!overlay) return bones;
    return bones.map(b => {
        let o = overlay[b.id];
        if (!o) return b;
        let base = b.pose || {};
        return {
            id: b.id, name: b.name, parentId: b.parentId,
            rest: b.rest, actionRadius: b.actionRadius,
            pose: {
                angle: typeof o.angle === "number" ? o.angle : (base.angle || 0),
                x: typeof o.x === "number" ? o.x : (base.x || 0),
                y: typeof o.y === "number" ? o.y : (base.y || 0),
                scale: typeof o.scale === "number" ? o.scale : (typeof base.scale === "number" ? base.scale : 1)
            }
        };
    });
}

// Builds { governedNode -> deformedCanvas } for one scope's `nodes`. For each visible bone layer,
// every node at a LOWER index (drawn below it) is a candidate; the deformer decides per node
// whether it produces a deformed canvas (null at rest, or when the node is out of every bone's
// reach). When several bone layers stack, the topmost one processed wins for a shared node —
// chained deformation is out of scope for v1. Returns undefined when there is nothing to deform.
//
// The pose fed to the deformer is the RESOLVED pose at this frame (base pose overlaid by any
// timeline pose keyframe carried in `props`), so a tweened armature deforms exactly like a live
// pose — the compositor is the single source of truth (spec 006 §4).
function buildDeformMap(nodes, props) {
    let boneLayers = null;
    for (let i = 0; i < nodes.length; i++) {
        let n = nodes[i];
        if (n.visible && isBones(n) && n.armature) {
            let overlay = (props && n.id && props[n.id]) ? props[n.id].bones : undefined;
            let posedBones = applyPoseOverlay(n.armature.bones, overlay);
            if (BoneDeformer.hasDeformation(posedBones)) {
                (boneLayers || (boneLayers = [])).push({index: i, bones: posedBones});
            }
        }
    }
    if (!boneLayers) return undefined;

    let map = new Map();
    boneLayers.forEach(entry => {
        let bi = entry.index;
        let boneLayer = nodes[bi];
        for (let j = 0; j < bi; j++) {
            let node = nodes[j];
            if (!node.visible || isBones(node)) continue;
            let effective = effectiveProps(node, props);
            let deformed = BoneDeformer.getDeformedCanvas(
                node, {x: effective.x, y: effective.y}, entry.bones, boneLayer.gridQuality);
            if (deformed) map.set(node, deformed);
        }
    });
    return map.size ? map : undefined;
}

// Cumulative offset of the node at `path` including every ancestor group's offset.
// Needed to map document coordinates to layer-local pixels (design 3.6).
export function resolvedOffset(nodes, path, props) {
    let x = 0;
    let y = 0;
    if (!path || !path.length) return {x, y};
    let current = nodes;
    for (let i = 0; i < path.length; i++) {
        let node = current && current[path[i]];
        if (!node) break;
        let effective = effectiveProps(node, props);
        x += effective.x;
        y += effective.y;
        if (isGroup(node)) {
            current = node.layers;
        } else {
            break;
        }
    }
    return {x, y};
}

export function flatLayers(nodes) {
    let result = [];
    nodes.forEach(node => {
        if (isGroup(node)) {
            result = result.concat(flatLayers(node.layers));
        } else {
            result.push(node);
        }
    });
    return result;
}

export function resolveLayerPath(nodes, path) {
    if (!path || path.length === 0) return undefined;
    let node = nodes[path[0]];
    if (node === undefined) {
        console.warn("resolveLayerPath: no node at path", path);
        return undefined;
    }
    if (path.length === 1) return node;
    if (!isGroup(node)) return undefined;
    return resolveLayerPath(node.layers, path.slice(1));
}

export function parentOf(nodes, path) {
    if (!path || path.length === 0) return undefined;
    if (path.length === 1) return { parent: nodes, index: path[0] };
    let node = nodes[path[0]];
    if (!isGroup(node)) return undefined;
    return parentOf(node.layers, path.slice(1));
}

export function insertAtPath(nodes, path, node) {
    let p = parentOf(nodes, path);
    if (!p) return;
    p.parent.splice(p.index, 0, node);
}

export function removeAtPath(nodes, path) {
    let p = parentOf(nodes, path);
    if (!p) return undefined;
    return p.parent.splice(p.index, 1)[0];
}

// true if `candidate` is `ancestor` itself or nested inside it
function isSelfOrDescendant(ancestor, candidate) {
    if (candidate.length < ancestor.length) return false;
    for (let i = 0; i < ancestor.length; i++) {
        if (candidate[i] !== ancestor[i]) return false;
    }
    return true;
}

// After removing the node at `fromPath`, indices shift for any path that runs through
// the same parent at a position after fromPath's index at that depth. Adjust `toPath`
// (expressed against the original tree) so it still points to the intended slot.
// Covers both the same-parent sibling case and the ancestor-shift case.
function adjustPathAfterRemoval(toPath, fromPath) {
    let adjusted = toPath.slice();
    let depth = fromPath.length - 1;
    if (adjusted.length <= depth) return adjusted;
    for (let i = 0; i < depth; i++) {
        if (adjusted[i] !== fromPath[i]) return adjusted; // different parent branch
    }
    if (adjusted[depth] > fromPath[depth]) adjusted[depth]--;
    return adjusted;
}

export function moveAtPath(nodes, fromPath, toPath) {
    if (!fromPath || !toPath || !fromPath.length || !toPath.length) return;
    // Reject moving a node into itself or its own subtree.
    if (isSelfOrDescendant(fromPath, toPath)) return;
    let node = removeAtPath(nodes, fromPath);
    if (!node) return;
    insertAtPath(nodes, adjustPathAfterRemoval(toPath, fromPath), node);
}

// path → flat leaf index (matches flatLayers order); -1 if path is not a leaf
export function flatIndex(nodes, path) {
    let target = resolveLayerPath(nodes, path);
    if (!target) return -1;
    return flatLayers(nodes).indexOf(target);
}

// inverse of flatIndex: flat leaf index → path; undefined if out of bounds
export function pathFromFlatIndex(nodes, index) {
    let count = 0;
    let result;
    function walk(arr, prefix) {
        for (let i = 0; i < arr.length && !result; i++) {
            let node = arr[i];
            let p = prefix.concat(i);
            if (isGroup(node)) {
                walk(node.layers, p);
            } else {
                if (count === index) result = p;
                count++;
            }
        }
    }
    walk(nodes, []);
    return result;
}

// Resolves a drag-drop gesture to a destination path in the tree.
//
// IMPORTANT — display is inverted vs storage. The panel renders highest storage index
// at the TOP; within any sibling group "lower in the panel" means LOWER storage index.
// Groups render header-first, children below. So "insert just below display-row R"
// means "take R's storage slot" (R shifts up), NOT R.index+1.
//
// Pure / side-effect-free so it can be unit-tested independently of the panel.
//  - rest:        the visible display rows with the dragged block already excluded,
//                 top-down. Each entry is either a real row {path, depth, isGroup,
//                 collapsed} or an end-group marker {endGroup:true, groupPath, depth}.
//                 `path`/`groupPath` are paths in the ORIGINAL tree (rest is NOT renumbered).
//  - gap:         insertion gap among `rest`, 0..rest.length. prev = rest[gap-1] sits
//                 visually ABOVE the gap; next = rest[gap] sits BELOW it.
//  - desiredDepth: indent level the pointer hovers at (from pointer X), disambiguating
//                 reparenting when the gap straddles several nesting levels (only used
//                 when no end-group marker borders the gap).
//
// Returns { parentPath, index, depth }:
//   parentPath — path of the parent array the dragged node should land in,
//   index      — insertion index WITHIN that parent, in POST-REMOVAL coordinates
//                (i.e. after the dragged node has been spliced out). Feed straight to
//                a remove-then-insert move (ImageFile.moveLayer handles this). NOT the
//                moveAtPath "original coordinates" convention.
//   depth      — nesting depth, for the live preview indent.
//
// Core rule (display is storage-reversed): the block's index within its target parent
// equals the number of that parent's DIRECT children that sit BELOW the block in the
// final display (rest[gap..]). Display-below ⇒ lower storage index, so counting them
// gives the storage slot directly. This makes the rendered preview and the committed
// result identical by construction.
export function resolveDropPath(rest, gap, desiredDepth) {
    let prev = rest[gap - 1];
    let next = rest[gap];

    // End-group markers make inside-vs-outside deterministic from the vertical gap alone:
    //   - gap just ABOVE a marker (next is a marker) ⇒ inside that group, at its bottom.
    //   - gap just BELOW a marker (prev is a marker) ⇒ outside, in the group's parent scope.
    // Stacked markers (nested groups closing together) encode each scope-exit going
    // inner→outer downward, so prev being the relevant marker picks the right level.
    let pp;
    if (next && next.endGroup) {
        // dropping above the end-group marker → into that group (bottom of its children)
        pp = next.groupPath.slice();
    } else if (prev && prev.endGroup) {
        // dropping below an end-group marker → into the group's parent scope (one level up)
        pp = prev.groupPath.slice(0, -1);
    } else {
        // No marker borders the gap: fall back to pointer-X depth disambiguation.
        let candidates = [];
        if (prev) {
            // Drop INTO prev only when it is an EXPANDED group. A collapsed group has no
            // visible interior (and no end-marker), so dropping on/just-below it must land
            // beside it — never inside — matching what the drag preview shows.
            if (prev.isGroup && !prev.collapsed) {
                candidates.push({ parentPath: prev.path.slice(), depth: prev.depth + 1 });
            }
            let lowerBound = next ? next.depth : 0;
            let d = prev.depth;
            while (d >= lowerBound) {
                candidates.push({ parentPath: prev.path.slice(0, d), depth: d });
                if (d === 0) break;
                d--;
            }
        } else if (next) {
            candidates.push({ parentPath: next.path.slice(0, -1), depth: next.depth });
        } else {
            return { parentPath: [], index: 0, depth: 0 };
        }

        let best = candidates[0];
        let bestDist = Math.abs(best.depth - desiredDepth);
        for (let i = 1; i < candidates.length; i++) {
            let dist = Math.abs(candidates[i].depth - desiredDepth);
            if (dist < bestDist || (dist === bestDist && candidates[i].depth > best.depth)) {
                best = candidates[i];
                bestDist = dist;
            }
        }
        pp = best.parentPath;
    }

    // Insertion index = count of the target parent's direct children appearing below the
    // block in the final display (rest[gap..]). Markers are not storage nodes — skip them.
    let index = 0;
    for (let i = gap; i < rest.length; i++) {
        let row = rest[i];
        if (row.endGroup) continue;
        if (row.path.length === pp.length + 1 && pathHasPrefix(row.path, pp)) index++;
    }
    return { parentPath: pp, index: index, depth: pp.length };
}

function pathHasPrefix(path, prefix) {
    if (path.length < prefix.length) return false;
    for (let i = 0; i < prefix.length; i++) {
        if (path[i] !== prefix[i]) return false;
    }
    return true;
}

// true if the node at `path` or any ancestor group along the way is locked
export function isLockedInTree(nodes, path) {
    if (!path || !path.length) return false;
    let current = nodes;
    for (let i = 0; i < path.length; i++) {
        let node = current[path[i]];
        if (!node) return false;
        if (node.locked) return true;
        if (isGroup(node)) {
            current = node.layers;
        } else {
            break;
        }
    }
    return false;
}
