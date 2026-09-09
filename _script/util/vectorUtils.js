// Pure geometry + data-model helpers for vector layers (spec 008).
//
// A vector layer stores its content as `layer.vector`: id-keyed maps of nodes, edges and regions
// (see the shape produced by emptyVectorData below). Keeping nodes/edges in id-keyed maps — rather
// than arrays — lets the "sticky" edge-splitting reference a shared intersection node without index
// churn, and lets a future animation overlay (spec 009) address a node by stable id, exactly the
// way bone poses overlay onto an armature.
//
// This module is DOM-light: everything except rasterizeVector() is pure math and is unit-testable.
// Coordinates are document-space pixels (the same space the layer canvas is rasterized in).

// ── data model ────────────────────────────────────────────────────────────────────

// A fresh, empty vector document. `style` holds the current tool defaults new edges/regions copy.
export function emptyVectorData(){
    return {
        version: 1,
        nextNodeId: 1,
        nextEdgeId: 1,
        nextRegionId: 1,
        nextTextId: 1,
        // How the layer is rendered / edited (Properties panel "Display" selector). One of
        // VECTOR_DISPLAY_MODES — see getDisplayMode() for the legacy `snapToPixel` migration:
        //   "sharp"  — pixel-art: nodes snap to the grid, raster is 1-bit (no anti-aliasing).
        //   "smooth" — anti-aliased raster at document resolution.
        //   "vector" — drawn on screen as TRUE SVG shapes (getVectorSvgShapes), so it stays crisp at
        //              any zoom like a vector program; only rasterized (anti-aliased) on export/save.
        //              This is the default for a new vector layer (and for SVG import).
        displayMode: "vector",
        nodes: {},
        edges: {},
        regions: {},
        texts: {},
        style: {
            stroke: { color: "#000000", width: 1, smooth: false },
            fill: { color: "#000000" }
        }
    };
}

// The three per-layer render/edit modes offered by the Properties panel "Display" selector.
export const VECTOR_DISPLAY_MODES = ["sharp", "smooth", "vector"];

// Normalised display mode of a vector document. New docs carry `displayMode`; documents saved
// before the 3-way selector only have the legacy boolean `snapToPixel` (true = pixel-art), so we
// migrate on read: snapToPixel → "sharp", otherwise → "smooth" (the old anti-aliased default).
export function getDisplayMode(vector){
    if (!vector) return "smooth";
    if (VECTOR_DISPLAY_MODES.indexOf(vector.displayMode) >= 0) return vector.displayMode;
    return vector.snapToPixel ? "sharp" : "smooth";
}

export function newNodeId(v){ return "N" + (v.nextNodeId++); }
export function newEdgeId(v){ return "E" + (v.nextEdgeId++); }
export function newRegionId(v){ return "R" + (v.nextRegionId++); }
export function newTextId(v){ return "T" + (v.nextTextId++); }

// Adds a node at (x,y) and returns it. Callers that want snap-merging should call snapNode first.
export function addNode(v, x, y){
    let id = newNodeId(v);
    let node = { id: id, x: x, y: y };
    v.nodes[id] = node;
    return node;
}

// Adds an edge between two existing node ids. `opts.curve` (null=straight) and `opts.stroke` are
// copied as given; a missing stroke falls back to the current style stroke.
export function addEdge(v, aId, bId, opts){
    opts = opts || {};
    let id = newEdgeId(v);
    let edge = {
        id: id,
        a: aId,
        b: bId,
        curve: opts.curve || null,
        stroke: opts.stroke === null ? null : (opts.stroke || cloneStroke(v.style.stroke))
    };
    v.edges[id] = edge;
    return edge;
}

function cloneStroke(s){
    if (!s) return null;
    return { color: s.color, width: s.width, smooth: !!s.smooth };
}

function cloneTextEntry(text){
    if (!text) return null;
    return {
        id: text.id,
        x: text.x,
        y: text.y,
        text: text.text || "",
        font: text.font || "Arial",
        fontSize: text.fontSize == null ? 32 : text.fontSize,
        scale: text.scale == null ? 1 : text.scale,
        fill: text.fill === undefined ? "#000000" : text.fill,
        strokeColor: text.strokeColor || null,
        strokeWidth: text.strokeWidth == null ? 0 : text.strokeWidth,
        align: text.align || "left"
    };
}

// Deep-clones a vector document. Sibling of cloneArmature() in ui/layer.js — used by the layer's
// clone()/restore() (so undo + native save round-trip the geometry) and by the tool for a
// cancel-snapshot. Everything here is plain data; no canvases are copied.
export function cloneVector(v){
    if (!v) return emptyVectorData();
    let out = {
        version: v.version || 1,
        nextNodeId: v.nextNodeId || 1,
        nextEdgeId: v.nextEdgeId || 1,
        nextRegionId: v.nextRegionId || 1,
        nextTextId: v.nextTextId || 1,
        displayMode: getDisplayMode(v),
        nodes: {},
        edges: {},
        regions: {},
        texts: {},
        style: {
            stroke: cloneStroke((v.style && v.style.stroke) || {}),
            fill: { color: (v.style && v.style.fill && v.style.fill.color) || "#000000" }
        }
    };
    for (let id in v.nodes){
        let n = v.nodes[id];
        out.nodes[id] = { id: n.id, x: n.x, y: n.y };
        if (n.type) out.nodes[id].type = n.type;
    }
    for (let id in v.edges){
        let e = v.edges[id];
        out.edges[id] = {
            id: e.id,
            a: e.a,
            b: e.b,
            curve: e.curve ? { h1: { x: e.curve.h1.x, y: e.curve.h1.y }, h2: { x: e.curve.h2.x, y: e.curve.h2.y } } : null,
            stroke: cloneStroke(e.stroke)
        };
    }
    for (let id in v.regions){
        let r = v.regions[id];
        out.regions[id] = {
            id: r.id,
            boundary: (r.boundary || []).slice(),
            // Compound regions (e.g. an SVG evenodd path) carry extra closed loops as holes and a
            // fill rule; both are optional so single-loop regions clone exactly as before.
            holes: (r.holes || []).map(loop=>loop.slice()),
            fillRule: r.fillRule || "nonzero",
            fill: r.fill ? { color: r.fill.color, smooth: !!r.fill.smooth } : null
        };
    }
    for (let id in v.texts || {}){
        out.texts[id] = cloneTextEntry(v.texts[id]);
    }
    return out;
}

// An edge's bezier tangent handles as OFFSETS from their endpoints (spec 012): h1 relative to the
// edge's `a` node, h2 relative to `b`. A curved edge yields its real handle offsets; a STRAIGHT edge
// yields the collinear "thirds" (h1 = +Δ/3, h2 = −Δ/3 of the chord), i.e. the degenerate cubic that
// renders identically to the straight line. Offsets are the animatable unit for a curve: they follow
// a moved endpoint automatically and their shape tweens independently of point motion. Returns null
// when an endpoint is missing.
export function edgeHandleOffsets(v, edge){
    if (!v || !edge) return null;
    let a = v.nodes[edge.a], b = v.nodes[edge.b];
    if (!a || !b) return null;
    if (edge.curve && edge.curve.h1 && edge.curve.h2){
        return { h1: { x: edge.curve.h1.x - a.x, y: edge.curve.h1.y - a.y },
                 h2: { x: edge.curve.h2.x - b.x, y: edge.curve.h2.y - b.y } };
    }
    let dx = (b.x - a.x) / 3, dy = (b.y - a.y) / 3;
    return { h1: { x: dx, y: dy }, h2: { x: -dx, y: -dy } };
}

const POSE_EPS = 1e-6;
function offsetsDiffer(o, base){
    if (!o || !base) return false;
    return Math.abs(o.h1.x - base.h1.x) > POSE_EPS || Math.abs(o.h1.y - base.h1.y) > POSE_EPS ||
           Math.abs(o.h2.x - base.h2.x) > POSE_EPS || Math.abs(o.h2.y - base.h2.y) > POSE_EPS;
}

// Applies a timeline pose (spec 012) to a vector document:
//   nodeMap  — absolute `{id:{x,y}}` of the points displaced on the current frame.
//   curveMap — per-edge handle OFFSETS `{edgeId:{h1:{x,y},h2:{x,y}}}` (relative to endpoints, see
//              edgeHandleOffsets) for edges whose curvature is animated.
// Returns `v` UNCHANGED when nothing actually differs from the base (empty maps, unmoved points, or
// curve offsets equal to the edge's own base offsets) — so the non-animated composite path never
// clones. Otherwise deep-clones and applies, per edge:
//   • a moved endpoint drags the edge's own handles along (offset kept constant), the "follow" rule;
//   • an overridden curve places its handles at endpoint + the overlay offset, so the animated shape
//     rides on top of the (possibly also moved) endpoints.
// Both are the same offset math, so a moved point and a reshaped curve compose exactly.
export function poseVector(v, nodeMap, curveMap){
    if (!v) return v;
    nodeMap = nodeMap || {};
    curveMap = curveMap || {};
    let nodeIds = Object.keys(nodeMap);
    let curveIds = Object.keys(curveMap);

    // Detect any real change up front so a no-op overlay returns the shared base untouched.
    let changed = false;
    for (let i = 0; i < nodeIds.length && !changed; i++){
        let id = nodeIds[i], np = nodeMap[id], n = v.nodes[id];
        if (n && np && typeof np.x === "number" && typeof np.y === "number" && (np.x !== n.x || np.y !== n.y)) changed = true;
    }
    for (let i = 0; i < curveIds.length && !changed; i++){
        let eid = curveIds[i], e = v.edges[eid];
        if (e && offsetsDiffer(curveMap[eid], edgeHandleOffsets(v, e))) changed = true;
    }
    if (!changed) return v;

    let clone = cloneVector(v);
    // 1. move the listed nodes to their absolute overlay positions
    nodeIds.forEach(id=>{
        let n = clone.nodes[id], np = nodeMap[id];
        if (n && np && typeof np.x === "number" && typeof np.y === "number"){ n.x = np.x; n.y = np.y; }
    });
    // 2. resolve each edge's handles against the (possibly moved) endpoints
    for (let eid in clone.edges){
        let e = clone.edges[eid], base = v.edges[eid];
        let a = clone.nodes[e.a], b = clone.nodes[e.b];
        if (!a || !b) continue;
        let over = curveMap[eid];
        let baseOff = edgeHandleOffsets(v, base);
        if (over && baseOff && offsetsDiffer(over, baseOff)){
            // animated curve — place handles at endpoint + overlay offset (creates a curve if the
            // base edge was straight; a straight-thirds override stays straight via the diff check)
            e.curve = { h1: { x: a.x + over.h1.x, y: a.y + over.h1.y },
                        h2: { x: b.x + over.h2.x, y: b.y + over.h2.y } };
        } else if (base.curve && base.curve.h1 && base.curve.h2){
            // not animated but curved in the base — keep its shape, following the moved endpoints
            e.curve = { h1: { x: a.x + baseOff.h1.x, y: a.y + baseOff.h1.y },
                        h2: { x: b.x + baseOff.h2.x, y: b.y + baseOff.h2.y } };
        }
        // else: straight, un-animated — endpoints already moved above, stays straight
    }
    return clone;
}

// Back-compat / node-only convenience: apply just a node overlay (curve handles follow their points).
export function poseVectorNodes(v, nodeMap){
    return poseVector(v, nodeMap, null);
}

function normalizeTextAlign(align){
    return (align === "center" || align === "right") ? align : "left";
}

// The rendered/measured size is fontSize × scale: fontSize is the user-set property-panel value,
// scale is a separate multiplier applied only by the free-transform tool (so resizing the text's
// on-canvas box via the transform handles never rewrites the fontSize field).
export function effectiveFontSize(text){
    let size = (text && text.fontSize != null) ? +text.fontSize : 32;
    let scale = (text && text.scale != null) ? +text.scale : 1;
    return Math.max(1, size * (isFinite(scale) && scale > 0 ? scale : 1));
}

export function vectorTextFont(text){
    let size = Math.max(1, Math.round(effectiveFontSize(text)));
    let font = (text && text.font) || "Arial";
    return size + "px " + font;
}

let textMeasureCtx = (typeof document !== "undefined")
    ? document.createElement("canvas").getContext("2d")
    : null;

// `caretIndex` (character offset into text.text) is optional; when given, `caretX` is measured at
// that offset instead of at the end of the string, so an editing caret can sit mid-word.
export function measureVectorText(text, ctx, caretIndex){
    text = text || {};
    let fontSize = Math.max(1, effectiveFontSize(text));
    let value = text.text || "";
    let align = normalizeTextAlign(text.align);
    ctx = ctx || textMeasureCtx;
    let width = 0;
    let caretOffset = null;
    let ascent = fontSize * 0.8;
    let descent = fontSize * 0.2;
    if (ctx){
        ctx.save();
        ctx.font = vectorTextFont(text);
        ctx.textBaseline = "alphabetic";
        let m = ctx.measureText(value || "M");
        width = value ? m.width : 0;
        if (typeof m.actualBoundingBoxAscent === "number" && m.actualBoundingBoxAscent > 0) ascent = m.actualBoundingBoxAscent;
        if (typeof m.actualBoundingBoxDescent === "number" && m.actualBoundingBoxDescent >= 0) descent = m.actualBoundingBoxDescent;
        if (caretIndex != null){
            let idx = Math.max(0, Math.min(value.length, caretIndex));
            caretOffset = idx > 0 ? ctx.measureText(value.slice(0, idx)).width : 0;
        }
        ctx.restore();
    }
    let startX = text.x || 0;
    if (align === "center") startX -= width / 2;
    if (align === "right") startX -= width;
    let minWidth = Math.max(4, fontSize * 0.2);
    return {
        width: width,
        ascent: ascent,
        descent: descent,
        boxX: startX,
        boxY: (text.y || 0) - ascent,
        boxWidth: Math.max(width, minWidth),
        boxHeight: ascent + descent,
        caretX: startX + (caretOffset == null ? width : caretOffset),
        align: align
    };
}

export function vectorTextBounds(text, pad, ctx, caretIndex){
    let m = measureVectorText(text, ctx, caretIndex);
    pad = pad || 0;
    return {
        x: m.boxX - pad,
        y: m.boxY - pad,
        width: m.boxWidth + pad * 2,
        height: m.boxHeight + pad * 2,
        caretX: m.caretX,
        ascent: m.ascent,
        descent: m.descent
    };
}

export function drawVectorText(ctx, text){
    if (!ctx || !text) return;
    ctx.save();
    ctx.font = vectorTextFont(text);
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = normalizeTextAlign(text.align);
    if (text.fill) {
        ctx.fillStyle = text.fill;
        ctx.fillText(text.text || "", text.x, text.y);
    }
    if (text.strokeColor && (text.strokeWidth || 0) > 0){
        ctx.strokeStyle = text.strokeColor;
        ctx.lineWidth = text.strokeWidth * ((text.scale == null ? 1 : text.scale) || 1);
        ctx.strokeText(text.text || "", text.x, text.y);
    }
    ctx.restore();
}

// ── basic geometry ───────────────────────────────────────────────────────────────

export function dist(ax, ay, bx, by){
    let dx = ax - bx, dy = ay - by;
    return Math.sqrt(dx*dx + dy*dy);
}

// Endpoints (and control handles) of an edge in absolute doc coords.
// Returns {p0,p3, h1,h2, isCurve}. For a straight edge h1/h2 mirror the endpoints.
export function edgeGeometry(v, edge){
    let a = v.nodes[edge.a];
    let b = v.nodes[edge.b];
    let p0 = { x: a.x, y: a.y };
    let p3 = { x: b.x, y: b.y };
    if (edge.curve){
        return { p0: p0, p3: p3, h1: { x: edge.curve.h1.x, y: edge.curve.h1.y }, h2: { x: edge.curve.h2.x, y: edge.curve.h2.y }, isCurve: true };
    }
    return { p0: p0, p3: p3, h1: p0, h2: p3, isCurve: false };
}

// Cubic bezier point at parameter t.
export function cubicAt(p0, h1, h2, p3, t){
    let mt = 1 - t;
    let a = mt*mt*mt;
    let b = 3*mt*mt*t;
    let c = 3*mt*t*t;
    let d = t*t*t;
    return {
        x: a*p0.x + b*h1.x + c*h2.x + d*p3.x,
        y: a*p0.y + b*h1.y + c*h2.y + d*p3.y
    };
}

// Splits a cubic bezier at t via de Casteljau. Returns {left:{p0,h1,h2,p3}, right:{p0,h1,h2,p3}}.
export function splitCubic(p0, h1, h2, p3, t){
    let ab = lerp(p0, h1, t);
    let bc = lerp(h1, h2, t);
    let cd = lerp(h2, p3, t);
    let abbc = lerp(ab, bc, t);
    let bccd = lerp(bc, cd, t);
    let mid = lerp(abbc, bccd, t);
    return {
        left: { p0: p0, h1: ab, h2: abbc, p3: mid },
        right: { p0: mid, h1: bccd, h2: cd, p3: p3 }
    };
}

function lerp(a, b, t){
    return { x: a.x + (b.x - a.x)*t, y: a.y + (b.y - a.y)*t };
}

// ── stroke → fill offsetting (curve-preserving) ─────────────────────────────────────
// Builds ONE closed ring of arcs — {p0,p3,h1,h2,isCurve}, the same shape vectorBoolean.js's rings
// use — that is the exact analytic outline of `edge` stroked at width 2*radius with round caps:
// the edge offset to each side, closed with two semicircular caps. Used by "Lines to Fills"
// (vectorTool.js) instead of a rasterize-then-trace pass, so the result keeps real bezier arcs
// instead of flattening everything into a polygon.
//
// A round cap at one end is exactly "the disc of radius `radius` centered at that endpoint", and
// the offset band + its two end caps together are exactly the Minkowski sum of the edge with that
// disc (a "stadium" shape) — the standard technique for dilating a curve by a disc.
//
// A cubic edge has no exact offset curve in general — each recursively-subdivided piece (via
// splitCubic, stopping once its own tangent doesn't turn more than `tolDeg` end to end) is offset
// with the Tiller–Hanson approximation (move each control point along the LOCAL normal at its own
// parameter), which stays visually indistinguishable from the true offset at that piece size.
// Returns null for a degenerate (zero-length straight) edge.
export function edgeStrokeRing(v, edge, radius, tolDeg){
    let g = edgeGeometry(v, edge);
    let p = offsetEdgePieces(g, radius, tolDeg);
    if (!p) return null;
    let ring = [];
    p.leftPieces.forEach(a=>ring.push(a));
    buildCapArcs(p.trueEnd, p.tEnd, radius).forEach(a=>ring.push(a));
    for (let i = p.rightPieces.length - 1; i >= 0; i--) ring.push(reverseStrokeArc(p.rightPieces[i]));
    buildCapArcs(p.trueStart, { x: -p.tStart.x, y: -p.tStart.y }, radius).forEach(a=>ring.push(a));
    return ring;
}

// The offset-to-each-side pieces of one (already oriented) edge geometry `g` — shared by
// edgeStrokeRing (a single edge, capped at both its own ends) and strokeChainRing (many edges in a
// row, joined at each shared vertex instead). Returns null for a degenerate (zero-length straight)
// edge. `tStart`/`tEnd` are g's own unit tangents; `trueStart`/`trueEnd` are g's own (un-offset)
// endpoints, needed as the centre of a cap or join arc at that vertex.
function offsetEdgePieces(g, radius, tolDeg){
    tolDeg = tolDeg || 12;
    let leftPieces = [], rightPieces = [], tStart, tEnd;
    if (g.isCurve){
        tStart = cubicStartTangent(g.p0, g.h1, g.h2, g.p3);
        tEnd = cubicEndTangent(g.p0, g.h1, g.h2, g.p3);
        subdivideAndOffset(g.p0, g.h1, g.h2, g.p3, radius, tolDeg, leftPieces, 0);
        subdivideAndOffset(g.p0, g.h1, g.h2, g.p3, -radius, tolDeg, rightPieces, 0);
    } else {
        let dx = g.p3.x - g.p0.x, dy = g.p3.y - g.p0.y, len = Math.hypot(dx, dy);
        if (len < 1e-9) return null;
        tStart = tEnd = { x: dx/len, y: dy/len };
        let n = { x: -tStart.y, y: tStart.x };
        leftPieces.push({ p0: addVec(g.p0, scaleVec(n, radius)), p3: addVec(g.p3, scaleVec(n, radius)), h1: null, h2: null, isCurve: false });
        rightPieces.push({ p0: addVec(g.p0, scaleVec(n, -radius)), p3: addVec(g.p3, scaleVec(n, -radius)), h1: null, h2: null, isCurve: false });
    }
    return { leftPieces, rightPieces, tStart, tEnd, trueStart: g.p0, trueEnd: g.p3 };
}

// Orients edge `e` so its geometry runs a→b (forward=true) or b→a (forward=false).
export function orientedEdgeGeometry(v, e, forward){
    let g = edgeGeometry(v, e);
    if (forward) return g;
    return { p0: g.p3, p3: g.p0, h1: g.isCurve ? g.h2 : null, h2: g.isCurve ? g.h1 : null, isCurve: g.isCurve };
}

// A circular arc of radius `radius` about `center`, from the point at unit-direction u0 to the one
// at unit-direction u1 — ANY sweep angle (unlike quarterArc's fixed 90°), via the standard one-cubic
// approximation (K = 4/3·tan(sweep/4), sweep taken the SHORT rotational way from u0 to u1). Used for
// the round JOIN between two consecutive edges of a stroked chain (strokeChainRing) at a bend of
// whatever angle that bend actually is — including near-zero, where it correctly degenerates to a
// near-zero-length connector instead of the ambiguous "two independent semicircles that merely
// touch" a fixed-180° cap on each of two SEPARATE edges would produce at a (near-)continuous
// tangent (a touch a boolean union can't reliably merge — vectorBoolean's own documented
// tangential-touch limitation).
function arcOfAngle(center, radius, u0, u1){
    let cross = u0.x*u1.y - u0.y*u1.x, dotp = u0.x*u1.x + u0.y*u1.y;
    let theta = Math.atan2(cross, dotp);
    let k = (4/3) * Math.tan(Math.abs(theta)/4);
    let sense = theta >= 0 ? 1 : -1;
    let rot = (p)=> sense > 0 ? { x: -p.y, y: p.x } : { x: p.y, y: -p.x };
    let tan0 = rot(u0), tan1 = rot(u1);
    return {
        p0: { x: center.x + u0.x*radius, y: center.y + u0.y*radius },
        p3: { x: center.x + u1.x*radius, y: center.y + u1.y*radius },
        h1: { x: center.x + radius*u0.x + k*radius*tan0.x, y: center.y + radius*u0.y + k*radius*tan0.y },
        h2: { x: center.x + radius*u1.x - k*radius*tan1.x, y: center.y + radius*u1.y - k*radius*tan1.y },
        isCurve: true
    };
}

// Offsets a whole connected CHAIN of edges — `steps`: [{edge, forward}], already grouped by the
// caller into one same-colour, same-width, maximally-connected run — into its stroked outline, with
// a proper round JOIN (arcOfAngle, sized to each bend's own turn angle) at every internal vertex
// instead of independent per-edge end caps meeting there. An OPEN chain (a path with two loose
// ends) offsets into ONE closed ring (a round cap, buildCapArcs, at each true end). A CLOSED chain
// (a loop) has no open end to cap — its stroke is an annulus, so this returns TWO independent closed
// rings (the two offset sides), each already closed via its own wrap-around join; a downstream union
// with the shape's own fill (same colour) turns that hole solid, same as it would for a real pen.
// Returns an array of rings (1 for an open chain, 2 for a closed one), or null if every step in the
// chain was degenerate.
export function strokeChainRing(v, steps, radius, closed, tolDeg){
    let per = steps.map(s=>offsetEdgePieces(orientedEdgeGeometry(v, s.edge, s.forward), radius, tolDeg)).filter(Boolean);
    if (!per.length) return null;

    let left = [], right = [];
    for (let i = 0; i < per.length; i++){
        left.push.apply(left, per[i].leftPieces);
        right.push.apply(right, per[i].rightPieces);
        if (!closed && i === per.length - 1) continue;
        let next = per[(i + 1) % per.length];
        let node = per[i].trueEnd;
        let nL0 = { x: -per[i].tEnd.y, y: per[i].tEnd.x };
        let nL1 = { x: -next.tStart.y, y: next.tStart.x };
        if (dist(nL0.x, nL0.y, nL1.x, nL1.y) > 1e-6) left.push(arcOfAngle(node, radius, nL0, nL1));
        let nR0 = { x: -nL0.x, y: -nL0.y }, nR1 = { x: -nL1.x, y: -nL1.y };
        if (dist(nR0.x, nR0.y, nR1.x, nR1.y) > 1e-6) right.push(arcOfAngle(node, radius, nR0, nR1));
    }

    let reversedRight = [];
    for (let i = right.length - 1; i >= 0; i--) reversedRight.push(reverseStrokeArc(right[i]));

    if (closed) return [ left, reversedRight ];

    let ring = left.slice();
    let lastEnd = per[per.length - 1];
    ring.push.apply(ring, buildCapArcs(lastEnd.trueEnd, lastEnd.tEnd, radius));
    ring.push.apply(ring, reversedRight);
    let firstStart = per[0];
    ring.push.apply(ring, buildCapArcs(firstStart.trueStart, { x: -firstStart.tStart.x, y: -firstStart.tStart.y }, radius));
    return [ ring ];
}

function addVec(a, b){ return { x: a.x + b.x, y: a.y + b.y }; }
function scaleVec(a, s){ return { x: a.x * s, y: a.y * s }; }

// Unit tangent at a cubic's own t=0 / t=1, falling back through the remaining control points for
// a degenerate (coincident) handle so a tangent is always produced for a non-degenerate edge.
function cubicStartTangent(p0, h1, h2, p3){
    let d = { x: h1.x - p0.x, y: h1.y - p0.y };
    if (Math.hypot(d.x, d.y) < 1e-9) d = { x: h2.x - p0.x, y: h2.y - p0.y };
    if (Math.hypot(d.x, d.y) < 1e-9) d = { x: p3.x - p0.x, y: p3.y - p0.y };
    let len = Math.hypot(d.x, d.y) || 1;
    return { x: d.x/len, y: d.y/len };
}
function cubicEndTangent(p0, h1, h2, p3){
    let d = { x: p3.x - h2.x, y: p3.y - h2.y };
    if (Math.hypot(d.x, d.y) < 1e-9) d = { x: p3.x - h1.x, y: p3.y - h1.y };
    if (Math.hypot(d.x, d.y) < 1e-9) d = { x: p3.x - p0.x, y: p3.y - p0.y };
    let len = Math.hypot(d.x, d.y) || 1;
    return { x: d.x/len, y: d.y/len };
}

// Tiller–Hanson offset of one cubic piece: each control point moves along the normal AT ITS OWN
// end of the piece (p0/h1 use the start normal, h2/p3 use the end normal).
function offsetCubicPiece(p0, h1, h2, p3, radius){
    let t0 = cubicStartTangent(p0, h1, h2, p3), t1 = cubicEndTangent(p0, h1, h2, p3);
    let n0 = scaleVec({ x: -t0.y, y: t0.x }, radius), n1 = scaleVec({ x: -t1.y, y: t1.x }, radius);
    return { p0: addVec(p0, n0), h1: addVec(h1, n0), h2: addVec(h2, n1), p3: addVec(p3, n1), isCurve: true };
}

// Recursively halves (p0,h1,h2,p3) via splitCubic until each piece's own start/end tangent doesn't
// turn more than tolDeg, then pushes its Tiller–Hanson offset (at `radius`, negative for the other
// side) into `out`, in forward (p0→p3) order. Depth-capped like the sibling flatten routines.
function subdivideAndOffset(p0, h1, h2, p3, radius, tolDeg, out, depth){
    let t0 = cubicStartTangent(p0, h1, h2, p3), t1 = cubicEndTangent(p0, h1, h2, p3);
    let cos = Math.max(-1, Math.min(1, t0.x*t1.x + t0.y*t1.y));
    let turn = Math.acos(cos) * 180 / Math.PI;
    if (turn <= tolDeg || depth > 12){
        out.push(offsetCubicPiece(p0, h1, h2, p3, radius));
        return;
    }
    let s = splitCubic(p0, h1, h2, p3, 0.5);
    subdivideAndOffset(s.left.p0, s.left.h1, s.left.h2, s.left.p3, radius, tolDeg, out, depth+1);
    subdivideAndOffset(s.right.p0, s.right.h1, s.right.h2, s.right.p3, radius, tolDeg, out, depth+1);
}

// A 90° bezier arc of `radius` about `center`, from the point at unit-direction u0 to the point at
// unit-direction u1 = rotate90(u0) — the same magic-constant construction buildEllipse (in
// vectorTool.js) uses per quadrant of a full circle, generalised to an arbitrary starting angle.
const ARC_K = 0.5522847498307936;
function quarterArc(center, radius, u0, u1){
    return {
        p0: { x: center.x + u0.x*radius, y: center.y + u0.y*radius },
        p3: { x: center.x + u1.x*radius, y: center.y + u1.y*radius },
        h1: { x: center.x + radius*(u0.x + ARC_K*u1.x), y: center.y + radius*(u0.y + ARC_K*u1.y) },
        h2: { x: center.x + radius*(u1.x + ARC_K*u0.x), y: center.y + radius*(u1.y + ARC_K*u0.y) },
        isCurve: true
    };
}

// A round cap at `center`, bulging outward toward unit direction `dir` (the direction of travel
// continuing PAST that end of the edge) — two quarter-arcs forming a semicircle from the "left"
// offset point (center + radius·leftNormal(dir)) to the "right" one (center − radius·leftNormal),
// passing through the outward point (center + radius·dir).
function buildCapArcs(center, dir, radius){
    let n = { x: -dir.y, y: dir.x };
    let negN = { x: -n.x, y: -n.y };
    return [ quarterArc(center, radius, n, dir), quarterArc(center, radius, dir, negN) ];
}

// A full-circle disc of `radius` about `center`, as 4 quarter-arcs (the same construction, one full
// turn instead of half) — the round JOIN at a node where two or more stroked edges meet. Used by
// "Lines to Fills" (vectorTool.js) alongside edgeStrokeRing's per-edge capsules: two edges that meet
// with a (near-)continuous tangent — e.g. adjacent quadrant edges of a circle — offset into caps
// that only TOUCH there rather than genuinely overlap (a degenerate case vectorBoolean's boolean
// clip doesn't merge, per its documented tangential-touch limitation); this disc, folded into the
// same union, guarantees a real 2-D overlap at every shared node regardless of the turn angle — and
// is exactly the standard definition of a round join (a disc of radius = half the stroke width,
// centred on the joint) even where the natural per-edge overlap would have been enough on its own.
export function strokeJointDisc(center, radius){
    let dirs = [ {x:1,y:0}, {x:0,y:1}, {x:-1,y:0}, {x:0,y:-1} ];
    let arcs = [];
    for (let i = 0; i < 4; i++) arcs.push(quarterArc(center, radius, dirs[i], dirs[(i+1)%4]));
    return arcs;
}

function reverseStrokeArc(arc){
    return arc.isCurve
        ? { p0: arc.p3, p3: arc.p0, h1: arc.h2, h2: arc.h1, isCurve: true }
        : { p0: arc.p3, p3: arc.p0, h1: null, h2: null, isCurve: false };
}

// Flattens an edge to a polyline of {x,y,t} vertices (t = parameter along the edge in [0,1]).
// A straight edge yields its two endpoints. A curve is subdivided until each chord is within
// `tol` of the true curve (recursive; capped depth). t is carried so callers can map an
// intersection back to a split parameter.
export function flattenEdge(v, edge, tol){
    let g = edgeGeometry(v, edge);
    if (!g.isCurve){
        return [ { x: g.p0.x, y: g.p0.y, t: 0 }, { x: g.p3.x, y: g.p3.y, t: 1 } ];
    }
    tol = tol || 0.3;
    let out = [ { x: g.p0.x, y: g.p0.y, t: 0 } ];
    subdivide(g.p0, g.h1, g.h2, g.p3, 0, 1, tol, out, 0);
    out.push({ x: g.p3.x, y: g.p3.y, t: 1 });
    return out;
}

function subdivide(p0, h1, h2, p3, t0, t1, tol, out, depth){
    if (depth > 18){ return; }
    // flatness: max distance of the two control points to the chord p0-p3
    let d1 = pointLineDistance(h1, p0, p3);
    let d2 = pointLineDistance(h2, p0, p3);
    if (d1 <= tol && d2 <= tol) return;
    let tm = (t0 + t1) / 2;
    let s = splitCubic(p0, h1, h2, p3, 0.5);
    subdivide(s.left.p0, s.left.h1, s.left.h2, s.left.p3, t0, tm, tol, out, depth+1);
    out.push({ x: s.left.p3.x, y: s.left.p3.y, t: tm });
    subdivide(s.right.p0, s.right.h1, s.right.h2, s.right.p3, tm, t1, tol, out, depth+1);
}

function pointLineDistance(p, a, b){
    let dx = b.x - a.x, dy = b.y - a.y;
    let len = Math.sqrt(dx*dx + dy*dy);
    if (len < 1e-9) return dist(p.x, p.y, a.x, a.y);
    return Math.abs((p.x - a.x)*dy - (p.y - a.y)*dx) / len;
}

// Nearest point on an edge to `point`. Returns {dist, t, x, y}. Uses the flattened polyline and
// then refines t within the containing segment; good enough for hit-testing and node insertion.
export function edgeNearest(v, edge, point){
    let pts = flattenEdge(v, edge, 0.3);
    let best = { dist: Infinity, t: 0, x: pts[0].x, y: pts[0].y };
    for (let i = 0; i < pts.length - 1; i++){
        let seg = nearestOnSegment(point, pts[i], pts[i+1]);
        if (seg.dist < best.dist){
            best.dist = seg.dist;
            best.x = seg.x;
            best.y = seg.y;
            best.t = pts[i].t + (pts[i+1].t - pts[i].t) * seg.u;
        }
    }
    return best;
}

function nearestOnSegment(p, a, b){
    let dx = b.x - a.x, dy = b.y - a.y;
    let len2 = dx*dx + dy*dy;
    let u = len2 < 1e-9 ? 0 : ((p.x - a.x)*dx + (p.y - a.y)*dy) / len2;
    u = Math.max(0, Math.min(1, u));
    let x = a.x + dx*u, y = a.y + dy*u;
    return { dist: dist(p.x, p.y, x, y), u: u, x: x, y: y };
}

// Segment-segment intersection. Returns {point:{x,y}, t, u} where t is along a1->a2 and u along
// b1->b2, both strictly inside (0,1) beyond `eps` so shared endpoints are NOT reported as crossings
// (those are handled by node snapping). null when parallel or no interior crossing.
export function segSegIntersect(a1, a2, b1, b2, eps){
    eps = eps == null ? 1e-6 : eps;
    let r = { x: a2.x - a1.x, y: a2.y - a1.y };
    let s = { x: b2.x - b1.x, y: b2.y - b1.y };
    let denom = r.x*s.y - r.y*s.x;
    if (Math.abs(denom) < 1e-12) return null; // parallel / collinear
    let qp = { x: b1.x - a1.x, y: b1.y - a1.y };
    let t = (qp.x*s.y - qp.y*s.x) / denom;
    let u = (qp.x*r.y - qp.y*r.x) / denom;
    if (t <= eps || t >= 1 - eps || u <= eps || u >= 1 - eps) return null;
    return { point: { x: a1.x + r.x*t, y: a1.y + r.y*t }, t: t, u: u };
}

// All interior intersections of two edges. Works for straight AND curved edges by intersecting
// their flattened polylines, mapping each hit back to the parametric t of each edge. O(m*n) in the
// flattened vertex counts — fine for hand-drawn edge counts.
export function edgeIntersections(v, e1, e2){
    let p = flattenEdge(v, e1, 0.3);
    let q = flattenEdge(v, e2, 0.3);
    let hits = [];
    for (let i = 0; i < p.length - 1; i++){
        for (let j = 0; j < q.length - 1; j++){
            let x = segSegIntersect(p[i], p[i+1], q[j], q[j+1]);
            if (x){
                let t1 = p[i].t + (p[i+1].t - p[i].t) * x.t;
                let t2 = q[j].t + (q[j+1].t - q[j].t) * x.u;
                hits.push({ point: x.point, t1: t1, t2: t2 });
            }
        }
    }
    return hits;
}

// ── the "sticky" planar graph (spec 008 §2) ───────────────────────────────────────
//
// Drawing behaves like Adobe Animate's merge model: a new edge is cut at every crossing with an
// existing edge (and existing edges are cut too), so each resulting segment between crossings is an
// independently selectable edge. The operations below keep the node/edge maps a valid planar graph.

// nodeId of an existing node within `tol` of (x,y), or null.
export function snapNode(v, x, y, tol){
    let best = null, bestD = tol;
    for (let id in v.nodes){
        let n = v.nodes[id];
        let d = dist(x, y, n.x, n.y);
        if (d <= bestD){ bestD = d; best = id; }
    }
    return best;
}

// Resolves a point to a node id, reusing/creating as needed:
//   1. snap to an existing node within tol;
//   2. else if the point lies on an existing edge interior, split that edge there (T-junction);
//   3. else create a fresh node.
export function nodeOrSplitAt(v, x, y, tol){
    let snapped = snapNode(v, x, y, tol);
    if (snapped) return snapped;
    // nearest edge interior
    let bestEdge = null, bestT = 0, bestD = tol;
    for (let id in v.edges){
        let near = edgeNearest(v, v.edges[id], { x: x, y: y });
        if (near.dist <= bestD && near.t > 1e-3 && near.t < 1 - 1e-3){
            bestD = near.dist; bestEdge = id; bestT = near.t;
        }
    }
    if (bestEdge){
        return splitEdgeAt(v, bestEdge, bestT).midNodeId;
    }
    return addNode(v, x, y).id;
}

// Splits edge `edgeId` at parameter t into two edges sharing a new middle node. Straight edges
// split linearly; curves via de Casteljau (shape preserved). Removes the old edge and rewires any
// region boundary that referenced it. Returns {midNodeId, edges:[leftId,rightId]}.
export function splitEdgeAt(v, edgeId, t){
    let edge = v.edges[edgeId];
    let g = edgeGeometry(v, edge);
    let mid, leftCurve = null, rightCurve = null;
    if (g.isCurve){
        let s = splitCubic(g.p0, g.h1, g.h2, g.p3, t);
        mid = s.left.p3;
        leftCurve = { h1: s.left.h1, h2: s.left.h2 };
        rightCurve = { h1: s.right.h1, h2: s.right.h2 };
    } else {
        mid = { x: g.p0.x + (g.p3.x - g.p0.x)*t, y: g.p0.y + (g.p3.y - g.p0.y)*t };
    }
    let midNode = addNode(v, mid.x, mid.y);
    let left = addEdge(v, edge.a, midNode.id, { curve: leftCurve, stroke: cloneStroke(edge.stroke) });
    let right = addEdge(v, midNode.id, edge.b, { curve: rightCurve, stroke: cloneStroke(edge.stroke) });
    delete v.edges[edgeId];
    replaceEdgeInRegions(v, edgeId, [left.id, right.id]);
    return { midNodeId: midNode.id, edges: [left.id, right.id] };
}

// Splices the two halves in place of a split edge in every region boundary. Explicit shapes build
// their boundary head-to-tail forward, so [left,right] (a→mid→b) preserves the traversal order.
function replaceEdgeInRegions(v, oldId, newIds){
    for (let id in v.regions){
        let region = v.regions[id];
        let loops = [region.boundary].concat(region.holes || []);
        loops.forEach(b=>{
            if (!b) return;
            let i = b.indexOf(oldId);
            if (i >= 0) b.splice(i, 1, ...newIds);
        });
    }
}

// Welds node `fromId` onto `intoId`: every edge referencing fromId now references intoId, the node
// is removed, and any edge that became zero-length (a===b) is dropped.
export function mergeNodes(v, fromId, intoId){
    if (fromId === intoId) return;
    for (let id in v.edges){
        let e = v.edges[id];
        if (e.a === fromId) e.a = intoId;
        if (e.b === fromId) e.b = intoId;
    }
    delete v.nodes[fromId];
    removeDegenerateEdges(v);
}

function removeDegenerateEdges(v){
    for (let id in v.edges){
        if (v.edges[id].a === v.edges[id].b){
            replaceEdgeInRegions(v, id, []);
            delete v.edges[id];
        }
    }
}

// Adds an edge between two node ids and then cuts it (and every edge it crosses) at all interior
// intersections — the core sticky operation. Adjacent edges (sharing a node) are never treated as
// crossings; they meet at endpoints. Returns nothing (mutates v).
export function insertConnectedEdge(v, aId, bId, opts){
    let newEdge = addEdge(v, aId, bId, opts);
    resolveEdgeIntersections(v, newEdge.id);
    // spec 013 R2: a line drawn across a filled area divides the fill into pieces.
    splitFilledRegions(v);
}

// spec 013 R1: re-settle the planar graph after an EDIT (a move). Welds every new crossing the edit
// created for the given edges, then re-splits any fill a moved line now divides. Ids that were split
// away (deleted + replaced) during resolution are simply skipped. Additive only — nothing un-welds.
export function reResolveEdges(v, edgeIds){
    (edgeIds || []).forEach(id=>{ if (v.edges[id]) resolveEdgeIntersections(v, id); });
    splitFilledRegions(v);
}

function shareNode(e1, e2){
    return e1.a === e2.a || e1.a === e2.b || e1.b === e2.a || e1.b === e2.b;
}

// Repeatedly finds one interior crossing involving `edgeId` (or the sub-edges it was split into)
// and any other edge, splits both at the crossing and welds the two new mid-nodes into one shared
// node, until no interior crossings remain. Bounded by a guard against pathological input.
function resolveEdgeIntersections(v, edgeId){
    let pending = [edgeId];
    let guard = 0;
    while (pending.length && guard++ < 10000){
        let id = pending.pop();
        let edge = v.edges[id];
        if (!edge) continue;
        let found = null;
        for (let otherId in v.edges){
            if (otherId === id) continue;
            let other = v.edges[otherId];
            if (shareNode(edge, other)) continue;
            let hits = edgeIntersections(v, edge, other);
            if (hits.length){ found = { otherId: otherId, hit: hits[0] }; break; }
        }
        if (!found) continue;
        let s2 = splitEdgeAt(v, found.otherId, found.hit.t2);
        let s1 = splitEdgeAt(v, id, found.hit.t1);
        mergeNodes(v, s1.midNodeId, s2.midNodeId);
        pending.push(s1.edges[0], s1.edges[1], s2.edges[0], s2.edges[1]);
    }
}

// spec 013 R2 ── fill splitting ─────────────────────────────────────────────────────
//
// When resolution leaves a chord crossing the interior of a filled region, the region is replaced by
// one region per resulting face, each inheriting the fill. Idempotent: an already-split piece has no
// interior chord (a shared boundary edge's midpoint lies ON the outline, not strictly inside), so a
// second sweep is a no-op. Only the SAFE case is handled — a single boundary loop, no holes, default
// nonzero rule; anything more complex (holed / evenodd / compound) is left untouched so a fancy fill
// can never be corrupted.

// Flattened polygon of a region's single boundary loop (curves subdivided), for point-in tests.
function regionLoopPolygon(v, loop){
    let poly = [];
    let prevNode = null;
    (loop || []).forEach(eid=>{
        let e = v.edges[eid];
        if (!e) return;
        // orient each edge to continue from the running cursor node so the outline stitches in order
        let from = prevNode == null ? e.a : (e.a === prevNode ? e.a : e.b);
        let pts = flattenEdge(v, e, 0.5);
        if (e.a !== from) pts = pts.slice().reverse();
        for (let i = 0; i < pts.length - 1; i++) poly.push({ x: pts[i].x, y: pts[i].y });
        prevNode = (from === e.a) ? e.b : e.a;
    });
    return poly;
}

// Geometric midpoint of an edge (t=0.5) — the strong "is this edge inside the region" signal. Uses
// the real geometry (not flattenEdge, which returns only the two endpoints for a straight edge).
function edgeMidpoint(v, edge){
    let g = edgeGeometry(v, edge);
    if (g.isCurve) return cubicAt(g.p0, g.h1, g.h2, g.p3, 0.5);
    return { x: (g.p0.x + g.p3.x) / 2, y: (g.p0.y + g.p3.y) / 2 };
}

// Every bounded face of the planar subgraph formed by `edgeIds`, as {loop, poly, area}. Same
// half-edge face-tracing rule as enclosingCycle (next = clockwise neighbour of the incoming twin),
// but scoped to a subset of edges and returning ALL faces rather than the smallest around a point.
function traceAllFaces(v, edgeIds){
    let set = {}; edgeIds.forEach(id=>{ set[id] = true; });
    let outByNode = {};
    let halfEdges = {};
    function addHalf(edgeId, from, to){
        let e = v.edges[edgeId];
        let dir = edgeDirFrom(v, e, from);
        let key = edgeId + (e.a === from ? ">" : "<");
        let he = { key: key, edgeId: edgeId, from: from, to: to, angle: Math.atan2(dir.y, dir.x) };
        halfEdges[key] = he;
        (outByNode[from] = outByNode[from] || []).push(he);
    }
    for (let id in set){
        let e = v.edges[id];
        if (!e || e.a === e.b || !v.nodes[e.a] || !v.nodes[e.b]) continue;
        addHalf(id, e.a, e.b);
        addHalf(id, e.b, e.a);
    }
    for (let nid in outByNode) outByNode[nid].sort((p, q)=>p.angle - q.angle);
    function twinOf(he){
        let e = v.edges[he.edgeId];
        return halfEdges[he.edgeId + (e.a === he.from ? "<" : ">")];
    }
    function nextHalf(he){
        let list = outByNode[he.to];
        if (!list || !list.length) return null;
        let i = list.indexOf(twinOf(he));
        if (i < 0) return null;
        return list[(i - 1 + list.length) % list.length];
    }
    let visited = {};
    let faces = [];
    for (let startKey in halfEdges){
        if (visited[startKey]) continue;
        let cycle = [];
        let h = halfEdges[startKey];
        let guard = 0;
        while (h && !visited[h.key] && guard++ < 1e6){
            visited[h.key] = true;
            cycle.push(h);
            h = nextHalf(h);
            if (h && h.key === startKey) break;
        }
        if (cycle.length < 2) continue;
        let poly = [];
        cycle.forEach(he=>{
            let seq = edgePolylineFrom(v, v.edges[he.edgeId], he.from);
            for (let i = 0; i < seq.length - 1; i++) poly.push(seq[i]);
        });
        if (poly.length < 3) continue;
        let signed = polygonSignedArea(poly);
        if (Math.abs(signed) < 1e-6) continue;                // spur-only / collinear face
        // ordered edge-id loop with out-and-straight-back spurs removed (same as enclosingCycle)
        let ids = cycle.map(he=>he.edgeId);
        let loop = [];
        for (let i = 0; i < ids.length; i++){
            if (loop.length && loop[loop.length-1] === ids[i]){ loop.pop(); continue; }
            loop.push(ids[i]);
        }
        if (loop.length > 1 && loop[0] === loop[loop.length-1]) loop.pop();
        if (!loop.length) continue;
        faces.push({ loop: loop, poly: poly, area: Math.abs(signed) });
    }
    return faces;
}

// Idempotent sweep: split every filled region a chord now divides into one region per face.
export function splitFilledRegions(v){
    // snapshot ids — we mutate v.regions while iterating
    let regionIds = Object.keys(v.regions);
    regionIds.forEach(rid=>{
        let R = v.regions[rid];
        if (!R || !R.fill) return;
        // safe case only: a single boundary loop, no holes, default winding rule
        if (!R.boundary || !R.boundary.length) return;
        if (R.holes && R.holes.length) return;
        if (R.fillRule && R.fillRule !== "nonzero") return;

        let rpoly = regionLoopPolygon(v, R.boundary);
        if (rpoly.length < 3) return;

        // interior chords: edges NOT on the outline whose midpoint is strictly inside the region
        let boundarySet = {}; R.boundary.forEach(id=>{ boundarySet[id] = true; });
        let chords = [];
        for (let id in v.edges){
            if (boundarySet[id]) continue;
            let m = edgeMidpoint(v, v.edges[id]);
            if (pointInPoly(m.x, m.y, rpoly)) chords.push(id);
        }
        if (!chords.length) return;                            // nothing divides it

        let faces = traceAllFaces(v, R.boundary.concat(chords));
        if (faces.length < 2) return;
        // drop the outer face (its polygon retraces the whole outline → largest area)
        let outer = 0;
        for (let i = 1; i < faces.length; i++) if (faces[i].area > faces[outer].area) outer = i;
        let inner = faces.filter((_, i)=>i !== outer);
        // keep only faces that actually sit inside the original fill (guards concave outlines)
        inner = inner.filter(f=>{
            let c = polygonCentroid(f.poly);
            return pointInPoly(c.x, c.y, rpoly);
        });
        if (inner.length < 2) return;                          // no real division (spur / touch)

        // replace the region with one per inner face, all inheriting the fill
        delete v.regions[rid];
        inner.forEach(f=>{
            let id = newRegionId(v);
            v.regions[id] = {
                id: id,
                boundary: f.loop.slice(),
                holes: [],
                fillRule: "nonzero",
                fill: { color: R.fill.color, smooth: !!R.fill.smooth }
            };
        });
    });
}

// Area-weighted centroid of a simple polygon (lies inside for convex faces; used only as a sample
// point to test face-in-region membership).
function polygonCentroid(poly){
    let a = 0, cx = 0, cy = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++){
        let cross = poly[j].x * poly[i].y - poly[i].x * poly[j].y;
        a += cross;
        cx += (poly[j].x + poly[i].x) * cross;
        cy += (poly[j].y + poly[i].y) * cross;
    }
    if (Math.abs(a) < 1e-9){ // degenerate → fall back to vertex average
        let sx = 0, sy = 0; poly.forEach(p=>{ sx += p.x; sy += p.y; });
        return { x: sx / poly.length, y: sy / poly.length };
    }
    a *= 0.5;
    return { x: cx / (6 * a), y: cy / (6 * a) };
}

// ── deletion / hit-testing used by the tool ────────────────────────────────────────

export function deleteEdge(v, edgeId){
    replaceEdgeInRegions(v, edgeId, []);
    delete v.edges[edgeId];
    dropOrphanNodes(v);
    dropEmptyRegions(v);
}

// Removes a node. Its incident edges are removed; if it has exactly two collinear-ish incident
// edges the caller may prefer merging — kept simple here: incident edges are deleted.
export function deleteNode(v, nodeId){
    let incident = edgesAtNode(v, nodeId);
    // Exactly two incident edges → dissolve the node, merging the two edges into one straight edge
    // between their far endpoints (keeps a chain continuous when you remove an interior point).
    if (incident.length === 2){
        let e1 = v.edges[incident[0]];
        let e2 = v.edges[incident[1]];
        let far1 = e1.a === nodeId ? e1.b : e1.a;
        let far2 = e2.a === nodeId ? e2.b : e2.a;
        if (far1 !== far2){
            // Bridge the two far endpoints, then swap the two dissolved edges for that single bridge
            // wherever they appear in a region boundary / hole loop — so removing an interior point of
            // a filled shape keeps the shape intact (dropEmptyRegions would otherwise nuke the whole
            // region because it still referenced the now-deleted edge ids).
            let bridge = addEdge(v, far1, far2, { stroke: cloneStroke(e1.stroke) });
            replaceEdgeInRegions(v, incident[0], [bridge.id]);
            replaceEdgeInRegions(v, incident[1], []);
        } else {
            replaceEdgeInRegions(v, incident[0], []);
            replaceEdgeInRegions(v, incident[1], []);
        }
        delete v.edges[incident[0]];
        delete v.edges[incident[1]];
    } else {
        // 1 or 3+ incident edges: no clean dissolve, so drop each edge and let dropEmptyRegions decide
        // (a broken outer boundary legitimately removes the fill; a broken hole loop just drops).
        incident.forEach(id=>{ replaceEdgeInRegions(v, id, []); delete v.edges[id]; });
    }
    delete v.nodes[nodeId];
    dropEmptyRegions(v);
    dropOrphanNodes(v);
}

// Removes every node for which inside(x,y) is true (coordinates in GEOMETRY space) together with
// every edge incident to a removed node — a hard "cut", NOT a dissolve: no bridging edge is created
// between the surviving endpoints, so the selected area is genuinely emptied. Empty regions and any
// nodes left orphaned are cleaned up. Returns the number of nodes removed. Used by a selection cut
// on a vector layer (the layer stays a vector layer; only the geometry inside the region is gone).
export function deleteNodesWhere(v, inside){
    let remove = new Set();
    for (let id in v.nodes){
        let n = v.nodes[id];
        if (inside(n.x, n.y)) remove.add(id);
    }
    if (!remove.size) return 0;
    // snapshot edge ids: deleteEdge mutates v.edges (and prunes nodes/regions) as we go
    Object.keys(v.edges).forEach(id=>{
        let e = v.edges[id];
        if (e && (remove.has(e.a) || remove.has(e.b))) deleteEdge(v, id);
    });
    remove.forEach(id=>{ delete v.nodes[id]; }); // drop any that were isolated (no incident edge)
    dropEmptyRegions(v);
    dropOrphanNodes(v);
    return remove.size;
}

// Reduces v IN PLACE to the geometry "inside" the selection — the copy that Copy/Cut-To-Layer puts
// on a new vector layer (spec 008). A node is kept when inside(x,y) is true, OR it is the far
// endpoint of an edge whose OTHER endpoint is inside, so an edge straddling the selection border is
// copied WHOLE (with the outside endpoint it needs to render) rather than lost — the useful "copy"
// semantic, in contrast to the hard cut deleteNodesWhere applies to the source. Every other node,
// and every edge with a dropped endpoint, is removed; empty regions and orphaned nodes are cleaned
// up. Coordinates are in GEOMETRY space. Returns the number of nodes kept.
export function keepNodesInside(v, inside){
    // Which nodes are literally inside the selection — computed up front so the edge pass below
    // grows ONLY off these, never off already-grown nodes (otherwise a chain of edges would keep
    // dragging in ever-further endpoints, one hop per edge).
    let within = {};
    for (let id in v.nodes){
        let n = v.nodes[id];
        if (inside(n.x, n.y)) within[id] = true;
    }
    let keep = Object.assign({}, within);
    // an edge with an inside endpoint is copied whole, so its far (outside) endpoint survives too
    for (let id in v.edges){
        let e = v.edges[id];
        if (within[e.a] || within[e.b]){ keep[e.a] = true; keep[e.b] = true; }
    }
    // snapshot edge ids: deleteEdge mutates v.edges (and prunes nodes/regions) as we go
    Object.keys(v.edges).forEach(id=>{
        let e = v.edges[id];
        if (e && (!keep[e.a] || !keep[e.b])) deleteEdge(v, id);
    });
    for (let id in v.nodes){ if (!keep[id]) delete v.nodes[id]; }
    dropEmptyRegions(v);
    dropOrphanNodes(v);
    return Object.keys(v.nodes).length;
}

export function edgesAtNode(v, nodeId){
    let out = [];
    for (let id in v.edges){
        if (v.edges[id].a === nodeId || v.edges[id].b === nodeId) out.push(id);
    }
    return out;
}

// ── vector-tool selection → id sets (Copy/Cut-To-Layer on a vector layer) ──────────
// On a vector layer you cannot draw a pixel marquee (the vector tool owns all pointer input), so the
// "selection" Copy/Cut-To-Layer acts on is the vector tool's own pick. This resolves that pick — a
// picked region, a picked edge, and/or a set of picked nodes — into concrete id sets.
//   `sel`           = VectorTool.getSelection()      → { regionId, edgeId, nodeId } (any may be null)
//   `selectedNodes` = VectorTool.getSelectedNodes()  → array of node ids
// Returns:
//   primaryNodeIds — nodes the user explicitly picked (a cut removes these outright)
//   nodeIds        — every node the copy needs (primary + both endpoints of every kept edge)
//   edgeIds        — the picked edge, a picked region's boundary + hole loops, and any edge whose
//                    BOTH endpoints are picked (so a selected node-chain keeps its connecting edges)
//   regionIds      — a picked region (carries its fill)
// Ids no longer present in v are dropped, so a stale pick can't reference missing geometry.
export function vectorSelectionIds(v, sel, selectedNodes){
    sel = sel || {};
    let primary = new Set();
    (selectedNodes || []).forEach(id=>{ if (v.nodes[id]) primary.add(id); });
    if (sel.nodeId && v.nodes[sel.nodeId]) primary.add(sel.nodeId);

    let edgeIds = new Set();
    if (sel.edgeId && v.edges[sel.edgeId]) edgeIds.add(sel.edgeId);

    let regionIds = new Set();
    if (sel.regionId && v.regions[sel.regionId]){
        regionIds.add(sel.regionId);
        let r = v.regions[sel.regionId];
        [r.boundary || []].concat(r.holes || []).forEach(loop=>{
            (loop || []).forEach(eid=>{ if (v.edges[eid]) edgeIds.add(eid); });
        });
    }

    // an edge whose both endpoints are picked belongs to the selection (a picked open chain)
    for (let id in v.edges){
        let e = v.edges[id];
        if (primary.has(e.a) && primary.has(e.b)) edgeIds.add(id);
    }

    let nodeIds = new Set(primary);
    edgeIds.forEach(eid=>{ let e = v.edges[eid]; if (e){ nodeIds.add(e.a); nodeIds.add(e.b); } });
    let textIds = new Set();
    if (sel.textId && v.texts && v.texts[sel.textId]) textIds.add(sel.textId);

    return { primaryNodeIds: primary, nodeIds: nodeIds, edgeIds: edgeIds, regionIds: regionIds, textIds: textIds };
}

// True when a resolved selection (from vectorSelectionIds) references no geometry at all.
export function isEmptyVectorSelection(ids){
    return !ids || (!ids.nodeIds.size && !ids.edgeIds.size && !ids.regionIds.size && !(ids.textIds && ids.textIds.size));
}

// Builds a NEW vector document holding only the given nodes/edges/regions (deep-cloned) — the copy
// Copy/Cut-To-Layer drops on a fresh vector layer. Counters, style and displayMode are carried so
// the copy keeps the source's look and stays id-stable. A region is kept only when every edge of its
// boundary/hole loops is in the copy (otherwise its fill would reference missing edges).
export function subsetVector(v, ids){
    let src = cloneVector(v);
    let out = {
        version: src.version,
        nextNodeId: src.nextNodeId,
        nextEdgeId: src.nextEdgeId,
        nextRegionId: src.nextRegionId,
        nextTextId: src.nextTextId,
        displayMode: src.displayMode,
        nodes: {},
        edges: {},
        regions: {},
        texts: {},
        style: src.style
    };
    ids.nodeIds.forEach(id=>{ if (src.nodes[id]) out.nodes[id] = src.nodes[id]; });
    ids.edgeIds.forEach(id=>{
        let e = src.edges[id];
        if (e && out.nodes[e.a] && out.nodes[e.b]) out.edges[id] = e;
    });
    ids.regionIds.forEach(id=>{
        let r = src.regions[id];
        if (!r) return;
        let loops = [r.boundary || []].concat(r.holes || []);
        if (loops.every(loop=>loop.every(eid=>out.edges[eid]))) out.regions[id] = r;
    });
    (ids.textIds || new Set()).forEach(id=>{ if (src.texts && src.texts[id]) out.texts[id] = src.texts[id]; });
    return out;
}

// Appends every node/edge/region of `src` into `dst` IN PLACE, giving them fresh ids (so the two
// documents' id spaces can't collide) and shifting node/handle coordinates by (dx,dy) — the offset
// difference between the two layers, since geometry is stored in layer-local space. Appended content
// is added AFTER dst's existing content, so it draws on top — used by Merge Down when both layers are
// vector, preserving the top layer's z-order. dst's own style/displayMode are kept unchanged.
// Returns { nodeMap, edgeMap, regionMap } mapping each src id to the fresh dst id it became, so a
// caller (e.g. floating paste) can select/track exactly the geometry it just added.
export function appendVector(dst, src, dx, dy){
    if (!src) return { nodeMap: {}, edgeMap: {}, regionMap: {}, textMap: {} };
    dx = dx || 0; dy = dy || 0;
    let nodeMap = {}, edgeMap = {};
    for (let id in src.nodes){
        let n = src.nodes[id];
        let nn = addNode(dst, n.x + dx, n.y + dy);
        if (n.type) nn.type = n.type;
        nodeMap[id] = nn.id;
    }
    for (let id in src.edges){
        let e = src.edges[id];
        let a = nodeMap[e.a], b = nodeMap[e.b];
        if (!a || !b) continue;
        let curve = e.curve ? {
            h1: { x: e.curve.h1.x + dx, y: e.curve.h1.y + dy },
            h2: { x: e.curve.h2.x + dx, y: e.curve.h2.y + dy }
        } : null;
        let stroke = e.stroke ? { color: e.stroke.color, width: e.stroke.width, smooth: !!e.stroke.smooth } : null;
        let ne = addEdge(dst, a, b, { curve: curve, stroke: stroke });
        edgeMap[id] = ne.id;
    }
    let mapLoop = loop => (loop || []).map(eid=>edgeMap[eid]).filter(Boolean);
    let regionMap = {};
    for (let id in src.regions){
        let r = src.regions[id];
        let rid = newRegionId(dst);
        dst.regions[rid] = {
            id: rid,
            boundary: mapLoop(r.boundary),
            holes: (r.holes || []).map(mapLoop),
            fillRule: r.fillRule || "nonzero",
            fill: r.fill ? { color: r.fill.color, smooth: !!r.fill.smooth } : null
        };
        regionMap[id] = rid;
    }
    let textMap = {};
    for (let id in src.texts || {}){
        let text = src.texts[id];
        let tid = newTextId(dst);
        dst.texts[tid] = cloneTextEntry(Object.assign({}, text, { id: tid, x: text.x + dx, y: text.y + dy }));
        textMap[id] = tid;
    }
    return { nodeMap: nodeMap, edgeMap: edgeMap, regionMap: regionMap, textMap: textMap };
}

// An edge about to be deleted can also bound a NEIGHBOURING region that stays behind (e.g. a line
// drawn across a fill splits it into two faces sharing that edge, per `splitFilledRegions`). Simply
// deleting it would tear that surviving region's loop open — same fill, missing outline segment. So
// before deleting, any such edge is cloned in place and the clone swapped into the surviving
// region's loop(s), auto-closing it along the old seam. `excludeRegionIds` are the regions being cut
// alongside it, so their own (about-to-vanish) use of the edge doesn't count as "surviving".
function discloseSharedEdge(v, eid, excludeRegionIds){
    let e = v.edges[eid];
    if (!e) return;
    let survivorLoops = [];
    for (let rid in v.regions){
        if (excludeRegionIds.has(rid)) continue;
        let region = v.regions[rid];
        [region.boundary].concat(region.holes || []).forEach(loop=>{
            if (loop && loop.includes(eid)) survivorLoops.push(loop);
        });
    }
    if (!survivorLoops.length) return;
    let clone = addEdge(v, e.a, e.b, {
        curve: e.curve ? { h1: { x: e.curve.h1.x, y: e.curve.h1.y }, h2: { x: e.curve.h2.x, y: e.curve.h2.y } } : null,
        stroke: cloneStroke(e.stroke)
    });
    survivorLoops.forEach(loop=>{ loop.splice(loop.indexOf(eid), 1, clone.id); });
}

// Removes the selected geometry from v IN PLACE — the source side of Cut-To-Layer on a vector layer.
// Every picked edge (including a region's boundary/hole edges) is deleted, and every explicitly
// picked node is removed together with its remaining incident edges (a hard cut — no dissolve/bridge
// like deleteNode does). Shared endpoint nodes that other geometry still uses survive; ones left
// orphaned, and any now-empty regions, are pruned.
export function removeVectorSelection(v, ids){
    ids.edgeIds.forEach(eid=> discloseSharedEdge(v, eid, ids.regionIds));
    ids.edgeIds.forEach(eid=>{ if (v.edges[eid]) deleteEdge(v, eid); });
    ids.primaryNodeIds.forEach(nid=>{
        edgesAtNode(v, nid).forEach(eid=> discloseSharedEdge(v, eid, ids.regionIds));
        edgesAtNode(v, nid).forEach(eid=>{ if (v.edges[eid]) deleteEdge(v, eid); });
        delete v.nodes[nid];
    });
    ids.regionIds.forEach(id=>{ delete v.regions[id]; });
    (ids.textIds || new Set()).forEach(id=>{ if (v.texts) delete v.texts[id]; });
    dropOrphanNodes(v);
    dropEmptyRegions(v);
}

// ── node curve mode (Node-tool option buttons) ─────────────────────────────────────
// A node is one of three modes, derived from its incident edges + its persisted `type`:
//   "square" — corner: every incident edge is straight (no curve).
//   "sharp"  — a curved point whose two tangent handles are independent (a cusp). type:"corner".
//   "smooth" — a curved point whose two handles are kept collinear (continuous tangent). type:"smooth".

// Which handle of an edge sits at the given node ("h1" at endpoint a, "h2" at endpoint b).
function handleSideAt(edge, nodeId){ return edge.a === nodeId ? "h1" : "h2"; }
function farNodeId(edge, nodeId){ return edge.a === nodeId ? edge.b : edge.a; }

// A gentle default cubic for a straight edge: handles placed on the line at 1/3 and 2/3, so the
// edge looks unchanged but is now a curve the user can bend.
function defaultCurveFor(v, edge){
    let a = v.nodes[edge.a], b = v.nodes[edge.b];
    return {
        h1: { x: a.x + (b.x - a.x) / 3, y: a.y + (b.y - a.y) / 3 },
        h2: { x: b.x - (b.x - a.x) / 3, y: b.y - (b.y - a.y) / 3 }
    };
}

export function getNodeCurveMode(v, nodeId){
    let incident = edgesAtNode(v, nodeId);
    if (!incident.length) return "square";
    let anyCurve = incident.some(eid=>v.edges[eid].curve);
    if (!anyCurve) return "square";
    let n = v.nodes[nodeId];
    if (n && n.type === "smooth") return "smooth";
    return "sharp";
}

// Aligns the two handles of a smooth node so they are collinear through the node, along the
// tangent from one far endpoint to the other. Each handle keeps its own length. Only meaningful
// for a clean 2-curved-edge node; a no-op otherwise.
function applySmoothAtNode(v, nodeId){
    let node = v.nodes[nodeId];
    let curved = edgesAtNode(v, nodeId).filter(eid=>v.edges[eid].curve);
    if (!node || curved.length !== 2) return;
    let e1 = v.edges[curved[0]], e2 = v.edges[curved[1]];
    let far1 = v.nodes[farNodeId(e1, nodeId)], far2 = v.nodes[farNodeId(e2, nodeId)];
    let tx = far2.x - far1.x, ty = far2.y - far1.y;
    let tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
    let w1 = handleSideAt(e1, nodeId), w2 = handleSideAt(e2, nodeId);
    let len1 = dist(node.x, node.y, e1.curve[w1].x, e1.curve[w1].y) || dist(node.x, node.y, far1.x, far1.y) / 3;
    let len2 = dist(node.x, node.y, e2.curve[w2].x, e2.curve[w2].y) || dist(node.x, node.y, far2.x, far2.y) / 3;
    // e1 points toward its far endpoint's side (−tangent); e2 toward its side (+tangent)
    e1.curve[w1] = { x: node.x - tx * len1, y: node.y - ty * len1 };
    e2.curve[w2] = { x: node.x + tx * len2, y: node.y + ty * len2 };
}

// Sets a node's curve mode, mutating its incident edges as needed.
export function setNodeCurveMode(v, nodeId, mode){
    let node = v.nodes[nodeId];
    if (!node) return;
    let incident = edgesAtNode(v, nodeId);
    if (mode === "square"){
        incident.forEach(eid=>{ v.edges[eid].curve = null; });
        node.type = "corner";
        return;
    }
    // sharp / smooth both require curved incident edges
    incident.forEach(eid=>{
        let e = v.edges[eid];
        if (!e.curve) e.curve = defaultCurveFor(v, e);
    });
    if (mode === "smooth"){
        node.type = "smooth";
        applySmoothAtNode(v, nodeId);
    } else {
        node.type = "corner";
    }
}

// Live tangent-lock: after a handle is dragged, if it belongs to a smooth node with exactly one
// other curved edge, swing that edge's node-side handle to stay collinear (opposite direction,
// keeping its own length). No-op for corner nodes or junctions.
export function enforceSmoothNode(v, edgeId, which){
    let e = v.edges[edgeId];
    if (!e || !e.curve) return;
    let nodeId = which === "h1" ? e.a : e.b;
    let node = v.nodes[nodeId];
    if (!node || node.type !== "smooth") return;
    let others = edgesAtNode(v, nodeId).filter(id=>id !== edgeId && v.edges[id].curve);
    if (others.length !== 1) return;
    let o = v.edges[others[0]];
    let oWhich = handleSideAt(o, nodeId);
    let dx = e.curve[which].x - node.x, dy = e.curve[which].y - node.y;
    let dl = Math.hypot(dx, dy);
    if (dl < 1e-6) return;
    dx /= dl; dy /= dl;
    let oLen = dist(node.x, node.y, o.curve[oWhich].x, o.curve[oWhich].y) || dl;
    o.curve[oWhich] = { x: node.x - dx * oLen, y: node.y - dy * oLen };
}

// Breaks the path at a node: every incident edge past the first is re-pointed to its own fresh
// coincident node, so a point shared by two segments becomes two overlapping endpoints you can
// pull apart. Returns the array of new node ids (empty/null if the node is an endpoint).
export function splitNodeAt(v, nodeId){
    let incident = edgesAtNode(v, nodeId);
    if (incident.length < 2) return null;
    let orig = v.nodes[nodeId];
    let created = [];
    for (let i = 1; i < incident.length; i++){
        let e = v.edges[incident[i]];
        let nn = addNode(v, orig.x, orig.y);
        if (orig.type) nn.type = orig.type;
        if (e.a === nodeId) e.a = nn.id;
        if (e.b === nodeId) e.b = nn.id;
        created.push(nn.id);
    }
    return created;
}

// Merges several nodes into one placed at their average position. The first id is kept; the rest
// are merged into it (edges rewired, any edge that collapses to zero length removed). Returns the
// surviving node id, or null if fewer than two valid nodes were given.
export function joinNodes(v, nodeIds){
    let ids = (nodeIds || []).filter(id=>v.nodes[id]);
    if (ids.length < 2) return null;
    let sx = 0, sy = 0;
    ids.forEach(id=>{ sx += v.nodes[id].x; sy += v.nodes[id].y; });
    let keep = ids[0];
    v.nodes[keep].x = sx / ids.length;
    v.nodes[keep].y = sy / ids.length;
    for (let i = 1; i < ids.length; i++) mergeNodes(v, ids[i], keep);
    return keep;
}

function dropOrphanNodes(v){
    let used = {};
    for (let id in v.edges){ used[v.edges[id].a] = true; used[v.edges[id].b] = true; }
    for (let id in v.nodes){ if (!used[id]) delete v.nodes[id]; }
}

function dropEmptyRegions(v){
    for (let id in v.regions){
        let region = v.regions[id];
        let b = region.boundary || [];
        // A missing outer-boundary edge drops the whole region; a missing hole edge just drops
        // that hole loop (the region's fill survives).
        if (b.some(eid=>!v.edges[eid])){ delete v.regions[id]; continue; }
        if (region.holes) region.holes = region.holes.filter(loop=>loop.every(eid=>v.edges[eid]));
    }
}

// Nearest node id to a point within tol, or null.
export function nodeAtPoint(v, x, y, tol){
    return snapNode(v, x, y, tol);
}

// Nearest edge to a point. Returns {edgeId, t, dist} or null (within tol).
export function edgeAtPoint(v, x, y, tol){
    let best = null;
    for (let id in v.edges){
        let near = edgeNearest(v, v.edges[id], { x: x, y: y });
        if (near.dist <= tol && (!best || near.dist < best.dist)){
            best = { edgeId: id, t: near.t, dist: near.dist };
        }
    }
    return best;
}

// Region whose filled path contains (x,y), or null. Requires a canvas 2d ctx for isPointInPath.
export function regionAtPoint(v, ctx, x, y){
    for (let id in v.regions){
        let region = v.regions[id];
        let path = regionPath(v, region);
        if (path && ctx.isPointInPath(path, x, y, region.fillRule || "nonzero")) return id;
    }
    return null;
}

// ── flood fill: find the closed edge loop that encloses a point ────────────────────
// The vector Fill tool's "flood fill": given a click at (x,y), find the tightest cycle of edges that
// surrounds it and return its ordered edge-id loop (suitable for a region.boundary), or null when the
// point isn't enclosed. Unlike regionAtPoint this needs NO pre-existing region — it works purely on
// the planar edge graph (nodes are shared at corners/intersections because the draw tools weld
// touching lines), so four separate lines that visually box an area are fillable. It traces the faces
// of the planar subdivision: build both directed half-edges of every edge, and at each node walk to
// the clockwise-neighbour of the incoming twin — the classic face-tracing rule. Each face is a cycle;
// the fill face is the smallest-area one whose (flattened) polygon contains the point. Curves are
// flattened for the geometric tests only; the returned ids still render as their true curves.

// Direction an edge leaves `fromNode` — tangent of a curve, chord of a line.
function edgeDirFrom(v, edge, fromNode){
    let pts = flattenEdge(v, edge, 0.3);
    if (edge.a === fromNode) return { x: pts[1].x - pts[0].x, y: pts[1].y - pts[0].y };
    let n = pts.length;
    return { x: pts[n-2].x - pts[n-1].x, y: pts[n-2].y - pts[n-1].y };
}

// Flattened polyline of an edge oriented from `fromNode` to the other endpoint (both endpoints
// included), for stitching a face into one polygon.
function edgePolylineFrom(v, edge, fromNode){
    let pts = flattenEdge(v, edge, 0.5);
    return edge.a === fromNode ? pts : pts.slice().reverse();
}

function polygonSignedArea(poly){
    let a = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++){
        a += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
    }
    return a / 2;
}

function pointInPoly(x, y, poly){
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++){
        let xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
        if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
}

export function enclosingCycle(v, x, y){
    let outByNode = {};   // nodeId -> [half-edge] outgoing, later sorted CCW by leaving angle
    let halfEdges = {};   // key -> half-edge  (key = edgeId + ">" for a→b, "<" for b→a)
    function addHalf(edgeId, from, to){
        let e = v.edges[edgeId];
        let dir = edgeDirFrom(v, e, from);
        let key = edgeId + (e.a === from ? ">" : "<");
        let he = { key: key, edgeId: edgeId, from: from, to: to, angle: Math.atan2(dir.y, dir.x) };
        halfEdges[key] = he;
        (outByNode[from] = outByNode[from] || []).push(he);
    }
    for (let id in v.edges){
        let e = v.edges[id];
        if (!e || e.a === e.b || !v.nodes[e.a] || !v.nodes[e.b]) continue; // skip degenerate/dangling-ref
        addHalf(id, e.a, e.b);
        addHalf(id, e.b, e.a);
    }
    for (let nid in outByNode) outByNode[nid].sort((p, q)=>p.angle - q.angle);

    function twinOf(he){
        let e = v.edges[he.edgeId];
        return halfEdges[he.edgeId + (e.a === he.from ? "<" : ">")];
    }
    // next half-edge in the face on the left of `he`: at its arrival node, the clockwise neighbour of
    // the twin (the previous entry in the CCW-sorted outgoing list).
    function nextHalf(he){
        let list = outByNode[he.to];
        if (!list || !list.length) return null;
        let i = list.indexOf(twinOf(he));
        if (i < 0) return null;
        return list[(i - 1 + list.length) % list.length];
    }

    // trace every face once
    let visited = {};
    let best = null;
    for (let startKey in halfEdges){
        if (visited[startKey]) continue;
        let cycle = [];
        let h = halfEdges[startKey];
        let guard = 0;
        while (h && !visited[h.key] && guard++ < 1e6){
            visited[h.key] = true;
            cycle.push(h);
            h = nextHalf(h);
            if (h && h.key === startKey) break;
        }
        if (cycle.length < 2) continue;

        // stitch the face polygon (each half-edge contributes its span minus the shared end vertex)
        let poly = [];
        cycle.forEach(he=>{
            let seq = edgePolylineFrom(v, v.edges[he.edgeId], he.from);
            for (let i = 0; i < seq.length - 1; i++) poly.push(seq[i]);
        });
        if (poly.length < 3) continue;
        let area = Math.abs(polygonSignedArea(poly));
        if (area < 1e-6) continue;               // spur-only / collinear face
        if (!pointInPoly(x, y, poly)) continue;  // this face doesn't surround the click
        if (!best || area < best.area) best = { area: area, cycle: cycle };
    }
    if (!best) return null;

    // ordered edge-id loop, dropping any spur where we go out along an edge and straight back
    let ids = best.cycle.map(he=>he.edgeId);
    let loop = [];
    for (let i = 0; i < ids.length; i++){
        if (loop.length && loop[loop.length-1] === ids[i]){ loop.pop(); continue; }
        loop.push(ids[i]);
    }
    if (loop.length > 1 && loop[0] === loop[loop.length-1]) loop.pop();
    return loop.length ? loop : null;
}

// Welds dangling line endpoints that fall within `tol` of other geometry, so a nearly-closed outline
// becomes actually closed and the flood fill can trace it. The Fill tool runs this as an opt-in
// pre-pass (tolerance is zoom-relative — see ToolOptions "Close gaps"). For each degree-1 node it
// snaps to the nearest OTHER node within tol, or failing that onto the nearest non-incident edge
// (splitting it at the closest point) — the target stays fixed and the moved endpoint's edge is
// rewired to it, then the endpoint is dropped. Mutates v in place; returns the number of gaps closed.
export function closeGaps(v, tol){
    if (!(tol > 0)) return 0;
    let closed = 0;

    function degree(id){ return edgesAtNode(v, id).length; }
    function neighborOf(id){
        let inc = edgesAtNode(v, id);
        if (!inc.length) return null;
        let e = v.edges[inc[0]];
        return e.a === id ? e.b : e.a;
    }
    // rewire every edge at `fromId` onto `toId`, then remove the now-unused endpoint
    function weld(fromId, toId){
        edgesAtNode(v, fromId).forEach(eid=>{
            let e = v.edges[eid];
            if (!e) return;
            if (e.a === fromId) e.a = toId;
            if (e.b === fromId) e.b = toId;
            if (e.a === e.b) deleteEdge(v, eid); // collapsed to a point
        });
        delete v.nodes[fromId];
    }

    // snapshot the endpoint ids up front; welding changes degrees as we go
    let ends = Object.keys(v.nodes).filter(id=>degree(id) === 1);
    for (let nid of ends){
        if (!v.nodes[nid] || degree(nid) !== 1) continue;
        let n = v.nodes[nid];
        let skip = neighborOf(nid);

        // (a) nearest OTHER node within tol (not this endpoint's own neighbour)
        let bestNode = null, bestD = tol;
        for (let id in v.nodes){
            if (id === nid || id === skip) continue;
            let m = v.nodes[id];
            let d = dist(n.x, n.y, m.x, m.y);
            if (d <= bestD){ bestD = d; bestNode = id; }
        }
        if (bestNode){ weld(nid, bestNode); closed++; continue; }

        // (b) nearest non-incident EDGE within tol → split it and weld onto the new mid-node
        let incident = edgesAtNode(v, nid);
        let bestEdge = null, bestNear = null, bestED = tol;
        for (let id in v.edges){
            if (incident.indexOf(id) >= 0) continue;
            let e = v.edges[id];
            if (e.a === nid || e.b === nid) continue;
            let near = edgeNearest(v, e, { x: n.x, y: n.y });
            if (near.dist <= bestED){ bestED = near.dist; bestEdge = id; bestNear = near; }
        }
        if (bestEdge){
            let t = Math.max(0.001, Math.min(0.999, bestNear.t));
            let res = splitEdgeAt(v, bestEdge, t);
            let mid = res && res.midNodeId;
            if (mid){ weld(nid, mid); closed++; }
        }
    }
    return closed;
}

// ── whole-document transform (free-transform tool) ─────────────────────────────────

// Tight bounding box of the geometry in LAYER coords, {x,y,width,height} — nodes plus the
// flattened extent of every curve (so a bezier that bulges past its endpoints is included), plus
// every text object's on-canvas box (so Free Transform's resizer wraps text too).
// Returns null for an empty document.
export function vectorBounds(v){
    if (!v) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, has = false;
    function acc(x, y){
        if (x < minX) minX = x; if (y < minY) minY = y;
        if (x > maxX) maxX = x; if (y > maxY) maxY = y;
        has = true;
    }
    for (let id in v.nodes){ let n = v.nodes[id]; acc(n.x, n.y); }
    for (let id in v.edges){
        let e = v.edges[id];
        if (e.curve){ flattenEdge(v, e, 0.5).forEach(p=>acc(p.x, p.y)); }
    }
    for (let id in v.texts || {}){
        let box = vectorTextBounds(v.texts[id]);
        acc(box.x, box.y);
        acc(box.x + box.width, box.y + box.height);
    }
    if (!has) return null;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// Applies a point-mapping function fn(x,y)->{x,y} to every mutable coordinate of the geometry:
// each node and each curve's two tangent handles, plus every text object's anchor + a uniform
// `scale` multiplier (kept separate from `fontSize` — see effectiveFontSize). The local scale is
// recovered by sampling fn's Jacobian magnitude at the anchor, so it works for the resizer's
// scale-about-box-plus-rotate mapping without the caller having to pass the factor explicitly.
// Regions reference edges/nodes so they follow for free. Mutates v in place — callers pass a fresh
// clone when they need an undoable snapshot.
export function transformVector(v, fn){
    if (!v) return;
    for (let id in v.nodes){
        let n = v.nodes[id];
        let p = fn(n.x, n.y);
        n.x = p.x; n.y = p.y;
    }
    for (let id in v.edges){
        let e = v.edges[id];
        if (e.curve){
            e.curve.h1 = fn(e.curve.h1.x, e.curve.h1.y);
            e.curve.h2 = fn(e.curve.h2.x, e.curve.h2.y);
        }
    }
    for (let id in v.texts || {}){
        let t = v.texts[id];
        let eps = 1;
        let p0 = fn(t.x, t.y);
        let px = fn(t.x + eps, t.y);
        let py = fn(t.x, t.y + eps);
        let dx = Math.hypot(px.x - p0.x, px.y - p0.y);
        let dy = Math.hypot(py.x - p0.x, py.y - p0.y);
        let localScale = (dx + dy) / (2 * eps);
        t.x = p0.x; t.y = p0.y;
        if (isFinite(localScale) && localScale > 0){
            t.scale = (t.scale == null ? 1 : t.scale) * localScale;
        }
    }
}

// Spec 018: like transformVector, but restricted to a SUBSET of nodes (a Free Transform scoped to
// the current vector-tool selection, possibly spanning several layers) — only the listed node ids and
// the near handle of every curved edge incident to one of them are remapped through fn; every other
// node/edge/text is left untouched. No text handling (cross-layer selection never includes text).
export function transformVectorSubset(v, nodeIds, fn){
    if (!v || !nodeIds || !nodeIds.length) return;
    let idSet = new Set(nodeIds);
    idSet.forEach(id=>{
        let n = v.nodes[id];
        if (!n) return;
        let p = fn(n.x, n.y);
        n.x = p.x; n.y = p.y;
    });
    for (let id in v.edges){
        let e = v.edges[id];
        if (!e || !e.curve) continue;
        if (idSet.has(e.a) && e.curve.h1) e.curve.h1 = fn(e.curve.h1.x, e.curve.h1.y);
        if (idSet.has(e.b) && e.curve.h2) e.curve.h2 = fn(e.curve.h2.x, e.curve.h2.y);
    }
}

// ── blob-brush contour tracing (spec 011) ─────────────────────────────────────────
//
// The freehand "blob" tool stamps a brush shape (a disc or square) along the stroke and fills the
// UNION of those stamps — a fat filled shape whose vector points sit only on its outer contour (and
// on the contour of any hole, e.g. when you scribble a closed ring). vectorTool.js rasterizes that
// union into a small 1-bit mask (a canvas fill — exact and fast); the pure helpers below turn the
// mask back into vector loops: traceMaskContours walks the mask border, simplifyLoop drops the
// pixel-staircase down to a handful of points. Kept here (DOM-light, unit-testable) so the tool only
// owns the canvas rasterization.

// Perpendicular distance of point p to the line through a,b (used by Douglas–Peucker).
function perpDistance(p, a, b){
    let dx = b.x - a.x, dy = b.y - a.y;
    let len = Math.sqrt(dx*dx + dy*dy);
    if (len < 1e-9) return dist(p.x, p.y, a.x, a.y);
    return Math.abs((p.x - a.x)*dy - (p.y - a.y)*dx) / len;
}

// Douglas–Peucker simplification of an OPEN polyline (keeps both endpoints). Returns a new array.
function simplifyOpen(pts, eps){
    if (pts.length < 3) return pts.slice();
    let dmax = 0, idx = 0, last = pts.length - 1;
    for (let i = 1; i < last; i++){
        let d = perpDistance(pts[i], pts[0], pts[last]);
        if (d > dmax){ dmax = d; idx = i; }
    }
    if (dmax > eps){
        let left = simplifyOpen(pts.slice(0, idx + 1), eps);
        let right = simplifyOpen(pts.slice(idx), eps);
        return left.slice(0, -1).concat(right);
    }
    return [pts[0], pts[last]];
}

// Douglas–Peucker for a CLOSED loop of {x,y} (given open — first point not repeated at the end).
// Splits the ring at its two most-distant vertices so the simplification is rotation-stable, runs
// open DP on each arc, and stitches the result back into an open loop. Returns a new array.
export function simplifyLoop(loop, eps){
    eps = eps == null ? 1.0 : eps;
    if (loop.length < 4) return loop.slice();
    // farthest vertex from loop[0] → a stable split so DP never anchors on two near-coincident points
    let fi = 0, fd = -1;
    for (let i = 1; i < loop.length; i++){
        let d = dist(loop[0].x, loop[0].y, loop[i].x, loop[i].y);
        if (d > fd){ fd = d; fi = i; }
    }
    let arc1 = loop.slice(0, fi + 1);
    let arc2 = loop.slice(fi).concat([loop[0]]);
    let s1 = simplifyOpen(arc1, eps);
    let s2 = simplifyOpen(arc2, eps);
    // each simplified arc repeats the shared split/first vertex at its end — drop those to re-open
    return s1.slice(0, -1).concat(s2.slice(0, -1));
}

// Signed area (shoelace) of a loop of {x,y} — magnitude is the enclosed area.
function loopArea(loop){
    let a = 0;
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++){
        a += (loop[j].x + loop[i].x) * (loop[j].y - loop[i].y);
    }
    return a / 2;
}
export function loopAbsArea(loop){ return Math.abs(loopArea(loop)); }

// Marching-squares contour trace of a binary mask (Uint8Array of length w*h, 1 = inside, row-major).
// Returns an array of loops; each loop is an array of {x,y} vertices in mask-pixel coordinates
// (vertices sit on cell-edge midpoints, so coordinates are multiples of 0.5). CALLERS MUST pad the
// mask with a ≥1px empty border so no inside pixel touches the mask edge (the trace assumes samples
// outside the grid are 0). Multiple disjoint blobs yield multiple loops; a hole inside a blob yields
// its own loop, so an annulus returns two. Orientation is not guaranteed — fill with the evenodd
// rule so nesting resolves regardless of winding.
export function traceMaskContours(mask, w, h){
    function at(x, y){
        if (x < 0 || y < 0 || x >= w || y >= h) return 0;
        return mask[y*w + x] ? 1 : 0;
    }
    // Collect undirected segments per cell (marching squares), then stitch by shared endpoints.
    let segs = [];               // [aKey, bKey]
    let pointOf = {};            // key -> {x,y}
    function key(x, y){ return x + "," + y; }
    function pt(x, y){ let k = key(x, y); if (!pointOf[k]) pointOf[k] = { x: x, y: y }; return k; }
    function seg(x1, y1, x2, y2){ segs.push([pt(x1, y1), pt(x2, y2)]); }

    for (let y = -1; y < h; y++){
        for (let x = -1; x < w; x++){
            let tl = at(x, y), tr = at(x+1, y), br = at(x+1, y+1), bl = at(x, y+1);
            let idx = (tl<<3) | (tr<<2) | (br<<1) | bl;
            if (idx === 0 || idx === 15) continue;
            // edge midpoints of this cell
            let T = [x+0.5, y],   R = [x+1, y+0.5], B = [x+0.5, y+1], L = [x, y+0.5];
            switch (idx){
                case 1:  seg(L[0],L[1], B[0],B[1]); break;
                case 2:  seg(B[0],B[1], R[0],R[1]); break;
                case 3:  seg(L[0],L[1], R[0],R[1]); break;
                case 4:  seg(T[0],T[1], R[0],R[1]); break;
                case 5:  seg(L[0],L[1], T[0],T[1]); seg(B[0],B[1], R[0],R[1]); break; // saddle
                case 6:  seg(T[0],T[1], B[0],B[1]); break;
                case 7:  seg(L[0],L[1], T[0],T[1]); break;
                case 8:  seg(T[0],T[1], L[0],L[1]); break;
                case 9:  seg(T[0],T[1], B[0],B[1]); break;
                case 10: seg(T[0],T[1], R[0],R[1]); seg(L[0],L[1], B[0],B[1]); break; // saddle
                case 11: seg(T[0],T[1], R[0],R[1]); break;
                case 12: seg(L[0],L[1], R[0],R[1]); break;
                case 13: seg(B[0],B[1], R[0],R[1]); break;
                case 14: seg(L[0],L[1], B[0],B[1]); break;
            }
        }
    }
    if (!segs.length) return [];

    // adjacency: point key -> list of {other, segIndex}
    let adj = {};
    segs.forEach((s, i)=>{
        (adj[s[0]] = adj[s[0]] || []).push({ other: s[1], seg: i });
        (adj[s[1]] = adj[s[1]] || []).push({ other: s[0], seg: i });
    });
    let used = new Array(segs.length).fill(false);
    let loops = [];
    for (let start = 0; start < segs.length; start++){
        if (used[start]) continue;
        let loop = [];
        let curKey = segs[start][0];
        let segIdx = start;
        loop.push(pointOf[curKey]);
        while (segIdx >= 0 && !used[segIdx]){
            used[segIdx] = true;
            let s = segs[segIdx];
            let nextKey = s[0] === curKey ? s[1] : s[0];
            loop.push(pointOf[nextKey]);
            curKey = nextKey;
            let nbrs = adj[curKey] || [];
            segIdx = -1;
            for (let e of nbrs){ if (!used[e.seg]){ segIdx = e.seg; break; } }
        }
        // drop the duplicate closing vertex, keep only real rings
        if (loop.length > 2){
            if (loop[0].x === loop[loop.length-1].x && loop[0].y === loop[loop.length-1].y) loop.pop();
            if (loop.length >= 3) loops.push(loop);
        }
    }
    return loops;
}

// Flatten a region into polygon point-loops (document space): { boundary:[{x,y}], holes:[[{x,y}]] }.
// Curved edges are flattened; edges are oriented head-to-tail like regionPath. Used by the blob
// brush to re-rasterize an existing region it is about to merge into.
export function regionPolygons(vector, region){
    let out = { boundary: [], holes: [] };
    if (!region) return out;
    out.boundary = flattenLoopIds(vector, region.boundary || []);
    (region.holes || []).forEach(loop=>{
        let pts = flattenLoopIds(vector, loop);
        if (pts.length >= 3) out.holes.push(pts);
    });
    return out;
}

function flattenLoopIds(vector, ids){
    if (!ids || !ids.length) return [];
    let firstEdge = vector.edges[ids[0]];
    if (!firstEdge) return [];
    let pts = [];
    let curId = firstEdge.a;
    let start = vector.nodes[curId];
    if (start) pts.push({ x: start.x, y: start.y });
    for (let i = 0; i < ids.length; i++){
        let edge = vector.edges[ids[i]];
        if (!edge) continue;
        let forward = edge.a === curId;
        let fp = flattenEdge(vector, edge, 0.3);
        if (!forward) fp = fp.slice().reverse();
        for (let k = 1; k < fp.length; k++) pts.push({ x: fp[k].x, y: fp[k].y });
        curId = forward ? edge.b : edge.a;
    }
    // drop a duplicate closing vertex if present
    if (pts.length >= 2){
        let a = pts[0], b = pts[pts.length-1];
        if (Math.abs(a.x-b.x) < 1e-6 && Math.abs(a.y-b.y) < 1e-6) pts.pop();
    }
    return pts;
}

// Axis-aligned bounding box of a region's flattened boundary+holes, or null if empty.
export function regionPolygonBounds(polys){
    let pts = (polys.boundary || []).concat(...(polys.holes || []));
    if (!pts.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    pts.forEach(p=>{ if (p.x<minX) minX=p.x; if (p.y<minY) minY=p.y; if (p.x>maxX) maxX=p.x; if (p.y>maxY) maxY=p.y; });
    return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
}

// Delete a region together with the edges/nodes only it used. Edges that carry a visible stroke, or
// that another region still references, are kept (the blob brush owns its own strokeless geometry,
// so in practice everything goes). Orphaned nodes are pruned.
export function deleteRegionGeometry(v, regionId){
    let region = v.regions[regionId];
    if (!region) return;
    let ids = (region.boundary || []).slice();
    (region.holes || []).forEach(h=>{ (h||[]).forEach(eid=> ids.push(eid)); });
    delete v.regions[regionId];
    ids.forEach(eid=>{
        let edge = v.edges[eid];
        if (!edge) return;
        if (edge.stroke) return;
        if (edgeUsedByRegion(v, eid)) return;
        delete v.edges[eid];
    });
    dropOrphanNodes(v);
}

function edgeUsedByRegion(v, eid){
    for (let id in v.regions){
        let r = v.regions[id];
        if ((r.boundary || []).indexOf(eid) >= 0) return true;
        if ((r.holes || []).some(h=> (h||[]).indexOf(eid) >= 0)) return true;
    }
    return false;
}

// ── rasterization ────────────────────────────────────────────────────────────────

// Rasterizes the whole vector document into ctx (sized w×h). Called from Layer.render() behind a
// dirty flag, and by the on-screen "vector"-mode display at a scaled resolution. Fills regions
// first, then strokes edges — always with anti-aliased native canvas paths at sub-pixel precision.
//
// The display mode (getDisplayMode) only changes the finish:
//   • "smooth" / "vector" — leave the anti-aliased result as-is (soft, sub-pixel edges).
//   • "sharp" (pixel-art) — harden the alpha to 1-bit afterwards so there is NO anti-aliasing: a
//     7px red line is fully red right to its border, with no blended fringe pixels.
export function rasterizeVector(vector, ctx, w, h){
    ctx.clearRect(0, 0, w, h);
    if (!vector) return;
    let mode = getDisplayMode(vector);
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // fills
    for (let id in vector.regions){
        let region = vector.regions[id];
        if (!region.fill) continue;
        let path = regionPath(vector, region, false);
        if (!path) continue;
        ctx.fillStyle = region.fill.color;
        ctx.fill(path, region.fillRule || "nonzero");
    }

    // strokes
    for (let id in vector.edges){
        let edge = vector.edges[id];
        if (!edge.stroke) continue;
        strokeEdge(vector, ctx, edge);
    }
    for (let id in vector.texts || {}){
        drawVectorText(ctx, vector.texts[id]);
    }
    ctx.restore();

    // pixel-art finish: make every partially-covered edge pixel fully opaque or fully gone, so the
    // render is aliased (no colour blending at the borders). The canvas holds only this layer's own
    // content (it was cleared above), so hardening the whole area is safe.
    if (mode === "sharp") hardenAlpha(ctx, w, h);
}

// Forces alpha to 1-bit (≥ ~50% → opaque, else transparent), turning an anti-aliased render into a
// crisp pixel-art one. RGB is left untouched: an edge pixel drawn over transparency keeps the pure
// stroke/fill colour, so a solid line stays a single flat colour.
function hardenAlpha(ctx, w, h){
    let img;
    try { img = ctx.getImageData(0, 0, w, h); } catch(e){ return; }
    let d = img.data;
    for (let i = 3; i < d.length; i += 4) d[i] = d[i] >= 128 ? 255 : 0;
    ctx.putImageData(img, 0, 0);
}

// Builds a Path2D for a region by walking its boundary edges head-to-tail. Boundary edges are
// stored in connection order (explicit closed shapes control this), so we moveTo the first node
// and append each edge's far endpoint. Returns null if the boundary is degenerate.
function regionPath(vector, region, snap){
    let ids = region.boundary || [];
    if (ids.length < 2) return null;
    // In true-vector mode curves are always kept as beziers (smooth); in pixel mode the region
    // honours its own smooth flag so the fill edge matches the aliased stroke.
    let smooth = !snap || (region.fill && region.fill.smooth);
    let path = new Path2D();
    if (!appendLoopToPath(vector, path, ids, smooth)) return null;
    // Compound regions add each hole/extra sub-loop into the same Path2D; the fill rule
    // (region.fillRule, applied by the caller's ctx.fill/isPointInPath) turns them into holes.
    (region.holes || []).forEach(loop=>{
        if (loop && loop.length >= 2) appendLoopToPath(vector, path, loop, smooth);
    });
    return path;
}

// Walks one closed loop of boundary edge-ids into `path` (moveTo the first node, orient each edge
// to the running cursor, closePath). Returns false if the loop's first edge is missing.
function appendLoopToPath(vector, path, ids, smooth){
    let firstEdge = vector.edges[ids[0]];
    if (!firstEdge) return false;
    let cursor = vector.nodes[firstEdge.a];
    path.moveTo(cursor.x, cursor.y);
    let curId = firstEdge.a;
    for (let i = 0; i < ids.length; i++){
        let edge = vector.edges[ids[i]];
        if (!edge) continue;
        // orient the edge so it starts at the current cursor node
        let forward = edge.a === curId;
        appendEdgeToPath(vector, path, edge, forward, smooth);
        curId = forward ? edge.b : edge.a;
    }
    path.closePath();
    return true;
}

function appendEdgeToPath(vector, path, edge, forward, smooth){
    let g = edgeGeometry(vector, edge);
    let from = forward ? g.p0 : g.p3;
    let to = forward ? g.p3 : g.p0;
    let c1 = forward ? g.h1 : g.h2;
    let c2 = forward ? g.h2 : g.h1;
    if (g.isCurve && smooth){
        path.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, to.x, to.y);
    } else if (g.isCurve){
        // flatten so a non-smooth fill matches the non-smooth stroke
        let pts = flattenEdge(vector, edge, 0.3);
        if (!forward) pts = pts.slice().reverse();
        for (let i = 1; i < pts.length; i++) path.lineTo(pts[i].x, pts[i].y);
    } else {
        path.lineTo(to.x, to.y);
    }
}

// Anti-aliased, sub-pixel stroke of one edge (straight or cubic). The pixel-art finish for "sharp"
// mode is applied globally afterwards (hardenAlpha), so this function is display-mode agnostic.
function strokeEdge(vector, ctx, edge){
    let stroke = edge.stroke;
    let width = stroke.width || 1;
    let g = edgeGeometry(vector, edge);
    ctx.beginPath();
    ctx.moveTo(g.p0.x, g.p0.y);
    if (g.isCurve){
        ctx.bezierCurveTo(g.h1.x, g.h1.y, g.h2.x, g.h2.y, g.p3.x, g.p3.y);
    } else {
        ctx.lineTo(g.p3.x, g.p3.y);
    }
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = width;
    ctx.stroke();
}

// ── SVG rendering ("vector" display mode) ───────────────────────────────────────────
// Builds a display-list of SVG draw ops for a vector document — the TRUE-vector on-screen render
// used by the "vector" display mode (canvas.js paints these as real <path> elements in a zoomed
// SVG overlay, so they stay resolution-independent and crisp at any zoom, exactly like a vector
// drawing program; the raster path — rasterizeVector — is only used for the pixel modes and export).
//
// Same content and z-order as rasterizeVector: region fills first, then edge strokes, all with
// round caps/joins. Each op is { d, fill } or { d, stroke, width }. Coordinates are document-space,
// matching the overlay's viewBox, so callers apply only the layer offset.
export function getVectorSvgShapes(vector){
    let ops = [];
    if (!vector) return ops;
    let absorbed = {};   // edge ids emitted as part of a combined fill+stroke region path (skip below)
    for (let id in vector.regions){
        let region = vector.regions[id];
        if (!region.fill) continue;
        let d = regionPathData(vector, region);
        if (!d) continue;
        // A filled shape whose whole outline shares one stroke is emitted as a SINGLE fill+stroke
        // path, so it survives an SVG round-trip as one shape (see uniformRegionStroke). Otherwise
        // the fill is its own path and the strokes stay per-edge, as before.
        let stroke = uniformRegionStroke(vector, region);
        if (stroke){
            ops.push({ d: d, fill: region.fill.color, fillRule: region.fillRule || "nonzero",
                       stroke: stroke.color, width: stroke.width || 1 });
            regionOutlineEdgeIds(region).forEach(e=>absorbed[e] = 1);
        } else {
            ops.push({ d: d, fill: region.fill.color, fillRule: region.fillRule || "nonzero" });
        }
    }
    for (let id in vector.edges){
        if (absorbed[id]) continue;
        let edge = vector.edges[id];
        if (!edge.stroke) continue;
        ops.push({ d: edgePathData(vector, edge), stroke: edge.stroke.color, width: edge.stroke.width || 1 });
    }
    for (let id in vector.texts || {}){
        let text = vector.texts[id];
        let scale = text.scale == null ? 1 : text.scale;
        ops.push({
            kind: "text",
            id: id,
            x: text.x,
            y: text.y,
            text: text.text || "",
            font: text.font || "Arial",
            fontSize: effectiveFontSize(text),
            fill: text.fill || null,
            stroke: text.strokeColor || null,
            width: (text.strokeWidth == null ? 0 : text.strokeWidth) * scale,
            align: normalizeTextAlign(text.align)
        });
    }
    return ops;
}

// Every outline edge id of a region — its boundary plus each hole loop.
function regionOutlineEdgeIds(region){
    let ids = (region.boundary || []).slice();
    (region.holes || []).forEach(loop=>{ if (loop) loop.forEach(e=>ids.push(e)); });
    return ids;
}

// The single stroke shared by a region's ENTIRE outline (boundary + every hole loop), or null when
// the outline is unstroked or its edges carry different strokes. When non-null the region can be
// written as one <path> with both fill and stroke — which re-imports as a single shape (region +
// its stroked boundary edges) instead of splitting into a detached fill and loose stroke lines.
function uniformRegionStroke(vector, region){
    let ids = regionOutlineEdgeIds(region);
    if (!ids.length) return null;
    let ref = null;
    for (let i = 0; i < ids.length; i++){
        let e = vector.edges[ids[i]];
        if (!e || !e.stroke) return null;              // a gap in the outline → can't be one path
        let s = e.stroke;
        if (!ref){ ref = s; continue; }
        let rw = ref.width == null ? 1 : ref.width, sw = s.width == null ? 1 : s.width;
        if ((s.color || null) !== (ref.color || null) || sw !== rw) return null;
    }
    return ref;
}

// Which source element each shape produced by getVectorSvgShapes came from, in the EXACT same order
// (filled regions first, then stroked edges). Used by the code view to map a rendered <path> line
// back to the region/edge/nodes it represents so a canvas selection can be highlighted in the text.
// Keep the include/skip rules in lock-step with getVectorSvgShapes.
export function getVectorSvgShapeSources(vector){
    let sources = [];
    if (!vector) return sources;
    let absorbed = {};   // mirror getVectorSvgShapes: edges folded into a combined region path
    for (let id in vector.regions){
        let region = vector.regions[id];
        if (!region.fill) continue;
        if (!regionPathData(vector, region)) continue;
        let edgeIds = regionOutlineEdgeIds(region);
        let nodeIds = [];
        edgeIds.forEach(eid=>{ let e = vector.edges[eid]; if (e){ nodeIds.push(e.a); nodeIds.push(e.b); } });
        sources.push({ kind:"region", id: id, edgeIds: edgeIds, nodeIds: nodeIds });
        if (uniformRegionStroke(vector, region)) edgeIds.forEach(e=>absorbed[e] = 1);
    }
    for (let id in vector.edges){
        if (absorbed[id]) continue;
        let edge = vector.edges[id];
        if (!edge.stroke) continue;
        sources.push({ kind:"stroke", id: id, edgeIds: [id], nodeIds: [edge.a, edge.b] });
    }
    return sources;
}

// SVG path `d` for a single stroked edge (straight or cubic) — mirrors strokeEdge.
function edgePathData(vector, edge){
    let g = edgeGeometry(vector, edge);
    let d = "M " + g.p0.x + " " + g.p0.y + " ";
    d += g.isCurve
        ? "C " + g.h1.x + " " + g.h1.y + " " + g.h2.x + " " + g.h2.y + " " + g.p3.x + " " + g.p3.y
        : "L " + g.p3.x + " " + g.p3.y;
    return d;
}

// SVG path `d` for a closed filled region — mirrors regionPath, walking boundary edges head-to-tail
// (in "vector" mode curves are always kept smooth as beziers). Returns "" for a degenerate boundary.
export function regionPathData(vector, region){
    let ids = region.boundary || [];
    if (ids.length < 2) return "";
    let d = loopPathData(vector, ids);
    if (!d) return "";
    // Compound region: append each hole sub-loop as its own M…Z (rendered under fill-rule).
    (region.holes || []).forEach(loop=>{
        if (loop && loop.length >= 2) d += " " + loopPathData(vector, loop);
    });
    return d;
}

// SVG path `d` for one closed loop of boundary edge-ids (M…Z), or "" if degenerate.
function loopPathData(vector, ids){
    let firstEdge = vector.edges[ids[0]];
    if (!firstEdge) return "";
    let start = vector.nodes[firstEdge.a];
    let d = "M " + start.x + " " + start.y + " ";
    let curId = firstEdge.a;
    for (let i = 0; i < ids.length; i++){
        let edge = vector.edges[ids[i]];
        if (!edge) continue;
        let forward = edge.a === curId;
        let g = edgeGeometry(vector, edge);
        let to = forward ? g.p3 : g.p0;
        let c1 = forward ? g.h1 : g.h2;
        let c2 = forward ? g.h2 : g.h1;
        d += g.isCurve
            ? "C " + c1.x + " " + c1.y + " " + c2.x + " " + c2.y + " " + to.x + " " + to.y + " "
            : "L " + to.x + " " + to.y + " ";
        curId = forward ? edge.b : edge.a;
    }
    return d + "Z";
}
