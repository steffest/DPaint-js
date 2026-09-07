import EventBus from "../util/eventbus.js";
import { EVENT } from "../enum.js";
import ImageFile from "../image.js";
import HistoryService from "../services/historyservice.js";
import Palette from "../ui/palette.js";
import Color from "../util/color.js";
import ToolOptions from "../ui/components/toolOptions.js";
import Brush from "../ui/brush.js";
import { isVector } from "../util/layerUtils.js";
import {
    cloneVector, addNode, addEdge, insertConnectedEdge, nodeOrSplitAt, reResolveEdges,
    splitEdgeAt, deleteEdge, deleteNode, edgeAtPoint, nodeAtPoint, regionAtPoint,
    enclosingCycle, closeGaps, edgeGeometry, edgeNearest, cubicAt, newRegionId, dist, edgesAtNode,
    getNodeCurveMode, setNodeCurveMode, enforceSmoothNode, splitNodeAt, joinNodes,
    getDisplayMode, regionPathData, traceMaskContours, simplifyLoop, loopAbsArea,
    regionPolygons, regionPolygonBounds, deleteRegionGeometry,
    poseVector, edgeHandleOffsets,
    vectorSelectionIds, isEmptyVectorSelection, subsetVector, appendVector
} from "../util/vectorUtils.js";

// Modal vector tool (spec 008 §4). One singleton owning all vector interaction, mirroring the
// boneTool.js modal contract (start/commit/cancel, handleDown/Move/Hover/Up, pick, drawOverlay).
// Sub-modes:
//   select   — pick a whole edge/shape; Delete removes it
//   node     — move nodes, insert a node on a segment (click), drag a segment into a curve, edit
//              bezier tangent handles; Delete removes the selected node (dissolving a 2-edge chain)
//   line     — drag a straight edge; it is cut ("sticky") at every crossing with existing edges
//   rect     — drag a rectangle (closed shape, fillable)
//   circle   — drag an ellipse (4 cubic beziers, closed shape, fillable)
//   blob     — freehand filled shape (a dot-brush outline → closed region)
//   fill     — click a closed shape to (re)fill it with the current colour
//   outline  — click an edge/shape to stroke it with the current colour + width
//
// Geometry is stored in the layer's own canvas coordinate space. The tool receives DOCUMENT coords
// and maps them through the layer's resolved offset (the same mapping the compositor applies when
// it draws the rasterized canvas), so overlay handles sit exactly on the pixels the layer paints.
let VectorTool = function () {
    let me = {};

    const HANDLE = 6;            // on-screen px tolerance for node/handle hit-testing (÷ zoom)
    const CLICK_SLOP = 3;        // on-screen px movement under which a gesture counts as a click (÷ zoom)

    let active = false;
    let layer;
    let mode = "select";
    let sel = { edgeId: null, nodeId: null, handle: null }; // handle = {edgeId, which:"h1"|"h2"}
    let selectedNodes = new Set();  // node mode multi-selection (marquee / shift-click); moved together
    let selectedEdges = new Set();  // multi-line selection (shift-click / double-click a line); moved & styled together
    let hover = null;               // point/handle under the cursor: {kind:"node",nodeId} | {kind:"handle",edgeId,which}
    let hoverKind = null;           // full kind under the cursor (node/handle/edge/region/null) — drives the action cursor
    let drag = null;
    let snapshot;                // cloneVector for cancel
    let historyOpen = false;
    let lastScale = 1;
    let hitCtx = (typeof document !== "undefined") ? document.createElement("canvas").getContext("2d") : null;


    let clipboard = null;        // a subsetVector document, or null
    let pendingPaste = null;     // { nodeIds:Set, edgeIds:Set } while a paste is uncommitted
    const PASTE_OFFSET = 8;      // px shift so the copy doesn't sit exactly on the original
    let animKey = null;          // the property key being posed, or null (base editing / display)
    let editVec = null;          // resolved working copy while animating; null = edit layer.vector
    let readOnly = false;        // derived frame: display the tween, block geometry edits
    let poseSnapshot;            // node+curve overlay snapshot for gesture cancel

    function vec(){ return editVec || (layer && layer.vector); }
    function onProperty(){ return !!(animKey && editVec); }
    function poseEditing(){ return onProperty() && !readOnly; }

    function syncEditContext(){
        if (drag) return;
        if (!active || !layer){ animKey = null; editVec = null; readOnly = false; return; }
        let t = ImageFile.getVectorEditTarget ? ImageFile.getVectorEditTarget(layer) : null;
        if (!t || t.mode === "base"){ animKey = null; editVec = null; readOnly = false; return; }
        animKey = (t.mode === "pose") ? t.key : null;
        readOnly = (t.mode === "display");
        let posed = poseVector(layer.vector, t.nodes || {}, t.curves || {});
        // Force a real clone even when nothing is posed, so gestures can mutate the working copy
        // without touching the shared base geometry.
        editVec = (posed === layer.vector) ? cloneVector(layer.vector) : posed;
    }

    function syncPoseToOverlay(){
        if (!animKey || !editVec || !layer || !layer.vector) return;
        let base = layer.vector, map = {};
        for (let id in editVec.nodes){
            let n = editVec.nodes[id], b = base.nodes[id];
            if (!b) continue;
            if (n.x !== b.x || n.y !== b.y) map[id] = { x: n.x, y: n.y };
        }
        if (ImageFile.setVectorNodes) ImageFile.setVectorNodes(layer, animKey, map);

        let curves = {};
        for (let eid in editVec.edges){
            let ee = editVec.edges[eid], be = base.edges[eid];
            if (!be) continue;
            let editCurved = !!(ee.curve && ee.curve.h1 && ee.curve.h2);
            let baseCurved = !!(be.curve && be.curve.h1 && be.curve.h2);
            if (!editCurved && !baseCurved) continue;   // straight→straight: a pure move, no bend
            let over = edgeHandleOffsets(editVec, ee);
            let baseOff = edgeHandleOffsets(base, be);
            if (!over || !baseOff) continue;
            if (Math.abs(over.h1.x - baseOff.h1.x) > 1e-6 || Math.abs(over.h1.y - baseOff.h1.y) > 1e-6 ||
                Math.abs(over.h2.x - baseOff.h2.x) > 1e-6 || Math.abs(over.h2.y - baseOff.h2.y) > 1e-6){
                curves[eid] = over;
            }
        }
        if (ImageFile.setVectorCurves) ImageFile.setVectorCurves(layer, animKey, curves);
    }
    function isEditMode(){ return mode === "select" || mode === "node"; }
    function isPlacementMode(){ return mode === "line" || mode === "rect" || mode === "circle" || mode === "blob"; }
    function scopeOffset(){ return ImageFile.getLayerOffset(); }
    function docToGeo(p){
        let o = scopeOffset();
        let g = { x: p.x - o.x, y: p.y - o.y };
        let v = vec();
        // Only pixel-art ("sharp") mode snaps nodes to the grid; smooth/vector stay fractional.
        if (v && getDisplayMode(v) === "sharp"){ g.x = Math.round(g.x); g.y = Math.round(g.y); }
        return g;
    }

    function currentStroke(){
        return {
            color: Color.toHex(Palette.getDrawColor()),
            width: (ToolOptions.getLineSize && ToolOptions.getLineSize()) || 1,
            smooth: !!(ToolOptions.isSmooth && ToolOptions.isSmooth())
        };
    }
    function currentFillColor(){ return Color.toHex(Palette.getDrawColor()); }
    function wantsFill(){ return !!(ToolOptions.isFill && ToolOptions.isFill()); }

    // Every edge id of a region — its outer boundary plus each inner hole loop.
    function regionEdgeIds(region){
        if (!region) return [];
        let ids = region.boundary ? region.boundary.slice() : [];
        if (region.holes) region.holes.forEach(loop=>{ ids = ids.concat(loop); });
        return ids;
    }
    function incidentHandleBases(v, nodeIds){
        let out = {};
        nodeIds.forEach(nid=>{
            edgesAtNode(v, nid).forEach(eid=>{
                let e = v.edges[eid];
                if (!e || !e.curve) return;
                if (e.a === nid && e.curve.h1) out[eid + "h1"] = { edgeId: eid, which: "h1", x: e.curve.h1.x, y: e.curve.h1.y };
                if (e.b === nid && e.curve.h2) out[eid + "h2"] = { edgeId: eid, which: "h2", x: e.curve.h2.x, y: e.curve.h2.y };
            });
        });
        return out;
    }
    // Snap a translation delta to a fixed angle (horizontal / vertical / 45° diagonal), matching
    // the pixel Line/move tools' Shift constraint. Used for the line endpoint and node dragging.
    function constrainDelta(dx, dy){
        let w = Math.abs(dx), h = Math.abs(dy);
        let ratio = Math.min(w / h, h / w);
        if (ratio <= 1 && ratio > 0.5){
            let d = Math.min(w, h);
            return { dx: d * (dx < 0 ? -1 : 1), dy: d * (dy < 0 ? -1 : 1) };
        }
        return w < h ? { dx: 0, dy: dy } : { dx: dx, dy: 0 };
    }
    // The region (if any) that an edge belongs to — so clicking a filled shape's outline selects
    // the whole shape, not just that one edge.
    function regionOfEdge(v, edgeId){
        for (let id in v.regions){
            if (regionEdgeIds(v.regions[id]).indexOf(edgeId) >= 0) return id;
        }
        return null;
    }

    // notify the view (canvas listens on vectorChanged) + mark the raster cache stale. Set the flag
    // directly rather than relying on layer.markVectorDirty(): the compositor renders the cel's
    // layer instance, which may be a clone()/restore() copy that never got the method re-attached.
    function changed(){
        if (layer){
            // On a property key a geometry change is a node MOVE — push the displaced points into
            // the key's overlay first, so the compositor (which reads base + overlay) repaints the
            // posed shape rather than the untouched base.
            if (onProperty()) syncPoseToOverlay();
            layer.vectorDirty = true;
            layer.vectorRasterized = false;
            if (layer.markVectorDirty) layer.markVectorDirty();
        }
        EventBus.trigger(EVENT.vectorChanged);
    }

    me.isActive = function(){ return active; };
    me.getMode = function(){ return mode; };
    me.getSelection = function(){ return sel; };

    me.setMode = function(m){
        if (m === mode) return;
        commitPendingPaste(); // switching sub-tool finalises a floating paste (spec 014)
        mode = m;
        drag = null;
        selectedNodes.clear();
        selectedEdges.clear();
        EventBus.trigger(EVENT.vectorChanged);
    };
    me.getSelectedNodes = function(){ return Array.from(selectedNodes); };

    // Select every point and line of the layer (Cmd/Ctrl-A on a vector layer). Selection-only, so no
    // history — just repaint the overlay. Switches to the select sub-tool if a draw mode is active so
    // the selected points are visible and grabbable. Returns true when there was geometry to select,
    // so the caller (input.js) can skip the raster select-all.
    me.selectAll = function(){
        if (!active) return false;
        commitPendingPaste();               // finalise any floating paste before re-selecting
        let v = vec();
        if (!v) return false;
        let nodeIds = Object.keys(v.nodes);
        let edgeIds = Object.keys(v.edges);
        if (!nodeIds.length && !edgeIds.length) return false;
        if (!isEditMode()) me.setMode("select"); // points must be visible + directly grabbable (setMode doesn't touch vec())
        sel = { edgeId: null, nodeId: null, handle: null, regionId: null };
        selectedNodes = new Set(nodeIds);
        selectedEdges = new Set(edgeIds);
        EventBus.trigger(EVENT.vectorChanged);
        return true;
    };

    // ── floating paste (spec 014) ───────────────────────────────────────────────────────
    // Copy the current selection into the internal vector clipboard. Returns true when something was
    // captured, so the caller (input.js) can skip the raster-canvas copy. Reads only, so it works on
    // the base drawing and on an animation key alike.
    me.copySelection = function(){
        if (!active) return false;
        let v = vec();
        if (!v) return false;
        let ids = vectorSelectionIds(v, sel, Array.from(selectedNodes));
        if (isEmptyVectorSelection(ids)) return false;
        clipboard = subsetVector(v, ids);
        return true;
    };
    me.hasClipboard = function(){ return !!(clipboard && Object.keys(clipboard.nodes).length); };

    // Drop a detached copy of the clipboard onto the active layer and select it, ready to drag.
    // Returns true when a paste happened (so the caller skips the raster paste). Blocked on a derived
    // frame and on a property key: paste adds BASE geometry (new nodes/edges), which a pose key can't
    // hold — animate the existing points instead.
    me.pasteFloating = function(){
        if (!active || !me.hasClipboard()) return false;
        syncEditContext();
        if (readOnly || poseEditing()) return false;
        let v = vec();
        if (!v) return false;
        commitPendingPaste();               // an earlier pending paste finalises before a new one
        v = vec();
        if (!isEditMode()) me.setMode("select"); // pasted points must be directly grabbable
        beginHistory();
        let maps = appendVector(v, clipboard, PASTE_OFFSET, PASTE_OFFSET);
        endGesture(true);
        let nodeIds = new Set(Object.values(maps.nodeMap));
        pendingPaste = { nodeIds: nodeIds, edgeIds: new Set(Object.values(maps.edgeMap)) };
        // select just the pasted points so the copy can be moved straight away
        sel = { edgeId: null, nodeId: null, handle: null, regionId: null };
        selectedNodes.clear(); nodeIds.forEach(id=>selectedNodes.add(id));
        selectedEdges.clear();
        changed();
        return true;
    };

    // Weld a pending floating paste into the drawing: re-resolve its edges' crossings and split any
    // fill they now divide (spec 013), then clear the pending flag. A no-op when nothing is pending.
    function commitPendingPaste(){
        if (!pendingPaste) return;
        let v = vec();
        let ids = v ? Array.from(pendingPaste.edgeIds).filter(id=>v.edges[id]) : [];
        pendingPaste = null;
        if (!v || !ids.length) return;
        beginHistory();
        reResolveEdges(v, ids);
        endGesture(true);
        changed();
    }
    me.hasPendingPaste = function(){ return !!pendingPaste; };

    // Engage on a vector layer (defaults to the active layer). Returns false if that layer is not a
    // vector layer. Idempotent: re-starting on the same layer keeps the selection.
    me.start = function(vectorLayer){
        let l = vectorLayer || ImageFile.getActiveLayer();
        if (!isVector(l)) return false;
        if (active && l === layer) return true;
        layer = l;
        active = true;
        sel = { edgeId: null, nodeId: null, handle: null };
        selectedNodes.clear();
        selectedEdges.clear();
        drag = null;
        EventBus.trigger(EVENT.vectorChanged);
        return true;
    };

    me.commit = function(){
        if (!active) return;
        commitPendingPaste(); // Enter / leaving vector mode welds a floating paste (spec 014)
        endGesture(true);
        cleanup();
    };

    me.cancel = function(){
        if (!active) return;
        if (historyOpen){
            if (snapshot) layer.vector = snapshot;
            if (poseSnapshot && ImageFile.restoreVectorOverlayState) ImageFile.restoreVectorOverlayState(poseSnapshot);
            HistoryService.neverMind();
            historyOpen = false;
            poseSnapshot = undefined;
            // force the working copy to rebuild from the restored overlay before we repaint
            editVec = null; animKey = null;
            if (layer){ layer.vectorDirty = true; layer.vectorRasterized = false; }
            EventBus.trigger(EVENT.vectorChanged);
        }
        // Escape leaves a floating paste where it is (it is already its own committed step, just not
        // welded) — drop the pending flag without re-resolving. Cmd-Z removes the paste if unwanted.
        pendingPaste = null;
        drag = null;
        cleanup();
    };

    function cleanup(){
        active = false;
        layer = undefined;
        drag = null;
        hover = null;
        hoverKind = null;
        snapshot = undefined;
        EventBus.trigger(EVENT.vectorChanged);
    }

    // ── history bracketing (one undo step per gesture) ─────────────────────────────────
    function beginHistory(){
        if (historyOpen) return;
        snapshot = cloneVector(layer.vector);
        // On a property key the edit changes the node overlay, not the base geometry — snapshot the
        // overlay too so a cancelled/rolled-back gesture restores it locally (neverMind path below).
        poseSnapshot = onProperty() && ImageFile.cloneVectorOverlayState
            ? ImageFile.cloneVectorOverlayState(layer) : undefined;
        // spec 015: a vector gesture only touches one layer's geometry (+ its pose overlays), so the
        // KEPT step captures just that — not the whole document like the old imageHistory bracket did.
        // Pass the active layer path so a grouped vector layer resolves to the right node on undo.
        HistoryService.start(EVENT.vectorHistory, ImageFile.getActiveLayerPath());
        historyOpen = true;
    }
    function endGesture(keep){
        if (!historyOpen) return;
        if (keep) HistoryService.end();
        else {
            layer.vector = snapshot;
            if (poseSnapshot && ImageFile.restoreVectorOverlayState) ImageFile.restoreVectorOverlayState(poseSnapshot);
            HistoryService.neverMind();
            editVec = null; // rebuild the working copy from the restored overlay on the next entry
        }
        historyOpen = false;
        snapshot = undefined;
        poseSnapshot = undefined;
    }

    // Bezier tangent handles that are currently editable (node mode only): both handles of a
    // selected edge, plus — for each selected node — the near handle of every curved edge that
    // meets at that node, so grabbing a node reveals and lets you refine its curves. Deduped by
    // edge+side. Each entry: { edgeId, which:"h1"|"h2", p, anchor } in GEOMETRY coords.
    function activeHandles(v){
        if (!isEditMode()) return [];
        // A derived (in-between) frame is display-only — no handles to grab. On a property key,
        // handles ARE shown: bezier shaping is animatable there and commits to the `curves` overlay
        // (spec 012). On a content key / base editing they show as normal.
        if (readOnly) return [];
        let out = [], seen = {};
        function add(edgeId, which){
            let e = v.edges[edgeId];
            if (!e || !e.curve) return;
            let k = edgeId + which;
            if (seen[k]) return;
            seen[k] = 1;
            out.push({
                edgeId: edgeId, which: which,
                p: which === "h1" ? e.curve.h1 : e.curve.h2,
                anchor: which === "h1" ? v.nodes[e.a] : v.nodes[e.b]
            });
        }
        if (sel.edgeId && v.edges[sel.edgeId] && v.edges[sel.edgeId].curve){
            add(sel.edgeId, "h1");
            add(sel.edgeId, "h2");
        }
        let nodeIds = new Set(selectedNodes);
        if (sel.nodeId) nodeIds.add(sel.nodeId);
        nodeIds.forEach(nid=>{
            edgesAtNode(v, nid).forEach(eid=>{
                let e = v.edges[eid];
                if (!e || !e.curve) return;
                if (e.a === nid) add(eid, "h1");
                if (e.b === nid) add(eid, "h2");
            });
        });
        return out;
    }

    // ── tangent-snap (drag a handle collinear to LOCK a point smooth) ────────────────────
    // Affinity-style: while dragging one handle of a not-yet-smooth point, when it lines up straight
    // (collinear-opposite) with the point's one other curved edge, snap it onto that line. Engage
    // within ENTER° of straight, release only past EXIT° — the hysteresis gives the "snaps for a
    // while, wiggle further to break out" feel. Releasing while snapped locks the point smooth.
    const TANGENT_SNAP_ENTER = 7;   // degrees to snap in
    const TANGENT_SNAP_EXIT  = 16;  // degrees to break back out (must be > ENTER)

    // While dragging handle `drag.which` of `drag.edgeId` at `nodeId`, decide the (possibly snapped)
    // handle position for cursor `gp`. Returns { point, snapping }. Never snaps at an endpoint (no
    // other handle) or a 3+-edge junction (ambiguous). Uses drag.snapping for hysteresis.
    function tangentSnapHandle(v, drag, gp, nodeId){
        let e = v.edges[drag.edgeId];
        let node = v.nodes[nodeId];
        let free = { point: { x: gp.x, y: gp.y }, snapping: false };
        if (!e || !node) return free;
        let others = edgesAtNode(v, nodeId).filter(id=> id !== drag.edgeId && v.edges[id] && v.edges[id].curve);
        if (others.length !== 1) return free;
        let o = v.edges[others[0]];
        let oh = o.curve[o.a === nodeId ? "h1" : "h2"];
        let ox = oh.x - node.x, oy = oh.y - node.y;
        let ol = Math.hypot(ox, oy);
        if (ol < 1e-6) return free;
        ox /= ol; oy /= ol;                                 // other handle direction (unit)
        let dx = gp.x - node.x, dy = gp.y - node.y;
        let dl = Math.hypot(dx, dy);
        if (dl < 1e-6) return free;
        // collinear = dragged handle points opposite the other one (along -o)
        let cos = -(dx*ox + dy*oy) / dl;
        let ang = Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
        if (ang > (drag.snapping ? TANGENT_SNAP_EXIT : TANGENT_SNAP_ENTER)) return free;
        // snap: project the cursor onto the straight tangent line (direction -o), keep a sane length
        let proj = dx*(-ox) + dy*(-oy);
        if (proj < 1e-3) proj = dl;
        return { point: { x: node.x - ox*proj, y: node.y - oy*proj }, snapping: true };
    }

    // ── hit-testing ────────────────────────────────────────────────────────────────────
    // Precedence: active bezier handles → nodes → edge interiors. Returns
    // {kind:"handle"|"node"|"edge", ...} in GEOMETRY coords, or null.
    me.pick = function(gp, tol){
        let v = vec();
        if (!v) return null;
        // tangent handles of the selected edge / any selected node's curved edges
        if (isEditMode()){
            let handles = activeHandles(v);
            for (let h of handles){
                if (h.p && dist(gp.x, gp.y, h.p.x, h.p.y) <= tol) return { kind: "handle", edgeId: h.edgeId, which: h.which };
            }
        }
        // nodes take priority and get a roomier hit radius, so points are easy to grab
        let nodeTol = isEditMode() ? tol * 1.8 : tol;
        let n = nodeAtPoint(v, gp.x, gp.y, nodeTol);
        if (n) return { kind: "node", nodeId: n };
        let e = edgeAtPoint(v, gp.x, gp.y, tol);
        if (e) return { kind: "edge", edgeId: e.edgeId, t: e.t };
        // a click on a shape's fill (interior, away from any edge/point) picks the whole region
        if (isEditMode() && hitCtx){
            let r = regionAtPoint(v, hitCtx, gp.x, gp.y);
            if (r) return { kind: "region", regionId: r };
        }
        return null;
    };

    me.handleDown = function(point, tolerance, opts){
        if (!active) return;
        syncEditContext();
        let v = vec();
        if (!v) return;
        // A derived (in-between) frame shows the tween read-only — geometry editing happens on a
        // keyframe (spec 012). Ignore the press so nothing is mutated on a non-key frame.
        if (readOnly) { drag = null; return; }
        let gp = docToGeo(point);
        let tol = tolerance || HANDLE;
        let shift = !!(opts && opts.shift);
        drag = { downGeo: gp, curGeo: gp, tol: tol, moved: false };

        // On a property key only point translation is a pose — the draw sub-modes (which add new
        // geometry to the base drawing) are disabled; draw them on the shape's content keyframe.
        if (poseEditing() && !isEditMode()) { drag = null; return; }

        // A pending floating paste (spec 014) commits the moment you act anywhere that isn't the
        // pasted geometry itself — an empty click, another point, or a draw mode. Pressing one of the
        // pasted points keeps it floating so you can keep repositioning the copy.
        if (pendingPaste){
            let hitId = isEditMode() ? nodeAtPoint(v, gp.x, gp.y, tol * 1.8) : null;
            if (!(hitId && pendingPaste.nodeIds.has(hitId))){ commitPendingPaste(); v = vec(); }
        }

        if (mode === "line"){
            beginHistory();
            drag.kind = "line";
            drag.startNode = nodeOrSplitAt(v, gp.x, gp.y, tol);
            changed();
            return;
        }
        if (mode === "rect" || mode === "circle"){
            beginHistory();
            drag.kind = mode;
            changed();
            return;
        }
        if (mode === "blob"){
            beginHistory();
            drag.kind = "blob";
            drag.points = [gp];
            changed();
            return;
        }
        if (mode === "fill"){
            fillAt(gp, tol);
            drag = null;
            return;
        }
        if (mode === "outline"){
            outlineAt(gp, tol);
            drag = null;
            return;
        }

        // ── unified direct-selection / edit tool ("select") ──────────────────────────────
        // One tool that does it all: click a shape's fill to select the whole shape (and drag it to
        // move it), click/drag its points to edit them, click a point to reveal + drag its bezier
        // handles, click a line to select it, drag a line to bend it, ctrl-click a line to insert a
        // point, shift-click lines to multi-select them, double-click a line to grab its whole path.
        // The selected shape stays the "context" (its points remain visible) while you edit its
        // individual points/edges.
        let hit = me.pick(gp, tol);

        if (hit && hit.kind === "handle"){
            beginHistory();
            drag.kind = "handle"; drag.edgeId = hit.edgeId; drag.which = hit.which;
            drag.snapping = false; drag.snapNodeId = null;
            EventBus.trigger(EVENT.vectorChanged);
            return;
        }

        if (hit && hit.kind === "node"){
            sel.edgeId = null; sel.handle = null; sel.nodeId = hit.nodeId; // keep sel.regionId as context
            selectedEdges.clear(); // node selection and multi-line selection are mutually exclusive
            if (shift){
                // toggle this node's membership in the selection; no move gesture
                if (selectedNodes.has(hit.nodeId)) selectedNodes.delete(hit.nodeId);
                else selectedNodes.add(hit.nodeId);
                drag = null;
            } else {
                // clicking a node outside the current selection re-selects just it; clicking one
                // already in the selection keeps the whole set so the group moves together
                if (!selectedNodes.has(hit.nodeId)){ selectedNodes.clear(); selectedNodes.add(hit.nodeId); }
                beginHistory();
                drag.kind = "nodes";
                drag.clickedNode = hit.nodeId;
                drag.nodeIds = Array.from(selectedNodes);
                drag.orig = {};
                drag.nodeIds.forEach(id=>{ let n = v.nodes[id]; if (n) drag.orig[id] = { x: n.x, y: n.y }; });
                drag.origH = incidentHandleBases(v, drag.nodeIds); // curve handles follow their point
            }
            EventBus.trigger(EVENT.vectorChanged);
            return;
        }

        if (hit && hit.kind === "edge"){
            // click → select the line; ctrl-click → insert a point; shift-click → add/remove the line
            // from the multi-line selection; drag → bend into a curve (all decided in handleUp /
            // handleMove). Keep the shape context if this edge is part of it.
            // ctrl-insert (a topology edit) is a base-drawing operation — disabled on a property key.
            let ctrl = poseEditing() ? false : !!(opts && opts.ctrl);
            selectedNodes.clear();
            if (shift){
                // toggle this line's membership in the multi-line selection; no drag / bend / history.
                // A multi-line selection is a pure line selection, so drop any shape context.
                if (selectedEdges.has(hit.edgeId)) selectedEdges.delete(hit.edgeId);
                else selectedEdges.add(hit.edgeId);
                sel = { edgeId: (selectedEdges.has(hit.edgeId) ? hit.edgeId : (selectedEdges.size ? selectedEdges.values().next().value : null)),
                        nodeId: null, handle: null, regionId: null };
                drag = null;
                EventBus.trigger(EVENT.vectorChanged);
                return;
            }
            beginHistory();
            sel = { edgeId: hit.edgeId, nodeId: null, handle: null,
                    regionId: (sel.regionId && regionEdgeIds(v.regions[sel.regionId]).indexOf(hit.edgeId) >= 0) ? sel.regionId : null };
            selectedEdges.clear(); selectedEdges.add(hit.edgeId);
            drag.kind = "edge"; drag.edgeId = hit.edgeId; drag.t = hit.t; drag.ctrl = ctrl;
            // alt-drag / right-drag translate the whole line rigidly (both endpoints + this edge's own
            // curve handles) instead of bending it — mirrors how me.nudge moves a selected line. A plain
            // drag bends the segment into a curve; on a property key that bend commits to the `curves`
            // overlay (spec 012), so bending stays enabled there just like on the base drawing.
            drag.move = !!(opts && (opts.alt || opts.right));
            if (drag.move){
                let e = v.edges[hit.edgeId];
                drag.orig = {};
                [e.a, e.b].forEach(id=>{ let n = v.nodes[id]; if (n) drag.orig[id] = { x: n.x, y: n.y }; });
                drag.origH = e.curve ? {
                    h1: e.curve.h1 ? { x: e.curve.h1.x, y: e.curve.h1.y } : null,
                    h2: e.curve.h2 ? { x: e.curve.h2.x, y: e.curve.h2.y } : null
                } : null;
            }
            EventBus.trigger(EVENT.vectorChanged);
            return;
        }

        if (hit && hit.kind === "region"){
            // select the whole shape and prepare a move — a drag translates it rigidly (points AND
            // curve handles), a plain click just selects it (history discarded in handleUp).
            sel = { edgeId: null, nodeId: null, handle: null, regionId: hit.regionId };
            selectedNodes.clear();
            selectedEdges.clear();
            beginHistory();
            drag.kind = "region"; drag.regionId = hit.regionId;
            drag.orig = {}; drag.origH = {};
            let eids = regionEdgeIds(v.regions[hit.regionId]);
            let nset = new Set();
            eids.forEach(eid=>{
                let e = v.edges[eid]; if (!e) return;
                nset.add(e.a); nset.add(e.b);
                if (e.curve) drag.origH[eid] = {
                    h1: e.curve.h1 ? { x: e.curve.h1.x, y: e.curve.h1.y } : null,
                    h2: e.curve.h2 ? { x: e.curve.h2.x, y: e.curve.h2.y } : null
                };
            });
            nset.forEach(id=>{ let n = v.nodes[id]; if (n) drag.orig[id] = { x: n.x, y: n.y }; });
            EventBus.trigger(EVENT.vectorChanged);
            return;
        }

        // empty space → clear the selection and rubber-band a marquee (selects points inside it)
        sel = { edgeId: null, nodeId: null, handle: null, regionId: null };
        selectedEdges.clear(); // a marquee builds a node selection; drop any multi-line selection
        if (!shift) selectedNodes.clear();
        drag.kind = "marquee";
        drag.additive = shift;
        EventBus.trigger(EVENT.vectorChanged);
    };

    me.handleMove = function(point, opts){
        if (!active || !drag) return;
        let v = vec();
        let gp = docToGeo(point);
        drag.curGeo = gp;
        // click-vs-drag threshold in SCREEN space (drag.tol is HANDLE/zoom), so it stays ~constant
        // on screen at any zoom. A doc-space constant would demand ever-larger drags when zoomed in
        // and revert short moves back to the node's original position.
        let slop = (drag.tol || HANDLE) * (CLICK_SLOP / HANDLE);
        if (dist(gp.x, gp.y, drag.downGeo.x, drag.downGeo.y) > slop) drag.moved = true;

        // rect/circle: holding Shift locks the drag to a square / perfect circle, exactly like the
        // pixel Rectangle/Ellipse tools. Constrain drag.curGeo itself so the live preview
        // (drawOverlay) and the committed shape (buildRect/buildEllipse read d.curGeo) both match.
        // It's re-read fresh from gp each move, so releasing Shift reverts to a free drag.
        if ((drag.kind === "rect" || drag.kind === "circle") && opts && opts.shift){
            let dx = gp.x - drag.downGeo.x, dy = gp.y - drag.downGeo.y;
            let sz = Math.max(Math.abs(dx), Math.abs(dy));
            drag.curGeo = { x: drag.downGeo.x + (dx < 0 ? -sz : sz), y: drag.downGeo.y + (dy < 0 ? -sz : sz) };
        }

        // line: holding Shift snaps the endpoint to a fixed angle (horizontal / vertical / 45°),
        // exactly like the pixel Line tool. Constrain drag.curGeo so the live preview (drawOverlay)
        // and the committed edge (handleUp reads d.curGeo) both match. Re-read fresh from gp each
        // move, so releasing Shift reverts to a free drag.
        if (drag.kind === "line" && opts && opts.shift){
            let c = constrainDelta(gp.x - drag.downGeo.x, gp.y - drag.downGeo.y);
            drag.curGeo = { x: drag.downGeo.x + c.dx, y: drag.downGeo.y + c.dy };
        }

        if (drag.kind === "blob"){
            let last = drag.points[drag.points.length - 1];
            if (dist(gp.x, gp.y, last.x, last.y) >= 1) drag.points.push(gp);
            EventBus.trigger(EVENT.vectorChanged);
            return;
        }
        if (drag.kind === "handle"){
            let e = v.edges[drag.edgeId];
            if (e && e.curve){
                let nodeId = drag.which === "h1" ? e.a : e.b;
                let node = v.nodes[nodeId];
                if (node && node.type === "smooth"){
                    // already a locked/smooth point → free drag, the other handle mirrors it
                    e.curve[drag.which] = { x: gp.x, y: gp.y };
                    enforceSmoothNode(v, drag.edgeId, drag.which);
                    drag.snapping = false; drag.snapNodeId = null;
                } else if (onProperty()){
                    // on a property key, handle shaping is a per-key CURVE pose: move the handle
                    // freely, but never engage the tangent-snap that would flip the point's
                    // smooth/corner TYPE — the type belongs to the base drawing, not the pose (spec 012).
                    e.curve[drag.which] = { x: gp.x, y: gp.y };
                    drag.snapping = false; drag.snapNodeId = null;
                } else {
                    // not locked → offer to snap collinear (and, on release, lock it smooth)
                    let snap = tangentSnapHandle(v, drag, gp, nodeId);
                    e.curve[drag.which] = snap.point;
                    drag.snapping = snap.snapping;
                    drag.snapNodeId = snap.snapping ? nodeId : null;
                }
                changed();
            }
            return;
        }
        if (drag.kind === "nodes"){
            let dx = gp.x - drag.downGeo.x, dy = gp.y - drag.downGeo.y;
            // holding Shift snaps the move to a fixed angle (horizontal / vertical / 45°), exactly
            // like the pixel Line tool — constrain the translation delta so a single point (and a
            // rigidly-moved group) both track a fixed direction. Re-read each move, so releasing
            // Shift reverts to a free drag.
            if (opts && opts.shift){ let c = constrainDelta(dx, dy); dx = c.dx; dy = c.dy; }
            drag.nodeIds.forEach(id=>{
                let n = v.nodes[id], o0 = drag.orig[id];
                if (n && o0){ n.x = o0.x + dx; n.y = o0.y + dy; }
            });
            // drag each moving point's own curve handles along so the curve stays attached to it
            if (drag.origH) for (let k in drag.origH){
                let h = drag.origH[k], e = v.edges[h.edgeId];
                if (e && e.curve && e.curve[h.which]){ e.curve[h.which].x = h.x + dx; e.curve[h.which].y = h.y + dy; }
            }
            changed();
            return;
        }
        if (drag.kind === "region"){
            // rigid translation of the whole shape: every node and every curve handle by the same delta
            let dx = gp.x - drag.downGeo.x, dy = gp.y - drag.downGeo.y;
            for (let id in drag.orig){ let n = v.nodes[id], o0 = drag.orig[id]; if (n && o0){ n.x = o0.x + dx; n.y = o0.y + dy; } }
            for (let eid in drag.origH){
                let e = v.edges[eid], oh = drag.origH[eid];
                if (e && e.curve && oh){
                    if (oh.h1 && e.curve.h1){ e.curve.h1.x = oh.h1.x + dx; e.curve.h1.y = oh.h1.y + dy; }
                    if (oh.h2 && e.curve.h2){ e.curve.h2.x = oh.h2.x + dx; e.curve.h2.y = oh.h2.y + dy; }
                }
            }
            changed();
            return;
        }
        if (drag.kind === "marquee"){
            EventBus.trigger(EVENT.vectorChanged);
            return;
        }
        if (drag.kind === "edge" && drag.moved){
            if (drag.move){
                // alt/right drag: translate the whole line (both endpoints + its curve handles)
                let dx = gp.x - drag.downGeo.x, dy = gp.y - drag.downGeo.y;
                let e = v.edges[drag.edgeId];
                for (let id in drag.orig){ let n = v.nodes[id], o0 = drag.orig[id]; if (n && o0){ n.x = o0.x + dx; n.y = o0.y + dy; } }
                if (drag.origH && e && e.curve){
                    if (drag.origH.h1 && e.curve.h1){ e.curve.h1.x = drag.origH.h1.x + dx; e.curve.h1.y = drag.origH.h1.y + dy; }
                    if (drag.origH.h2 && e.curve.h2){ e.curve.h2.x = drag.origH.h2.x + dx; e.curve.h2.y = drag.origH.h2.y + dy; }
                }
                changed();
                return;
            }
            // drag a segment into a curve passing through the cursor at parameter t
            promoteToCurveThrough(v, drag.edgeId, drag.t, gp);
            changed();
            return;
        }
        // line/rect/circle: live preview only (built on up) — just repaint the overlay
        if (drag.kind === "line" || drag.kind === "rect" || drag.kind === "circle"){
            EventBus.trigger(EVENT.vectorChanged);
        }
    };

    me.handleHover = function(point, tolerance){
        if (!active) { hoverKind = null; return null; }
        syncEditContext(); // hit-test against the resolved (posed/tweened) geometry the user sees
        if (isPlacementMode()){ hoverKind = null; return mode; }
        let hit = me.pick(docToGeo(point), tolerance || HANDLE);
        hoverKind = hit ? hit.kind : null; // remember what's under the cursor for the action cursor
        // Remember which point / handle is under the cursor so the overlay can enlarge it — makes it
        // obvious you're on the right spot before you press. Repaint only when the hover target
        // actually changes (this fires on every mouse move).
        let next = null;
        if (hit && hit.kind === "node") next = { kind: "node", nodeId: hit.nodeId };
        else if (hit && hit.kind === "handle") next = { kind: "handle", edgeId: hit.edgeId, which: hit.which };
        let a = hover, b = next;
        let changedHover = (!a !== !b) || (a && b && (a.kind !== b.kind || a.nodeId !== b.nodeId || a.edgeId !== b.edgeId || a.which !== b.which));
        if (changedHover) hover = next;
        // hover only resizes overlay dots — the caller repaints just the overlay (not the whole
        // composite) when this returns true, keeping hover cheap on every mouse move.
        me.hoverChanged = changedHover;
        return hit ? hit.kind : null;
    };

    // The action cursor for what's currently under the pointer — a base pointer with a small glyph
    // hinting the gesture the target will invoke (canvas.js maps the returned name to a `cursor-*`
    // class; the glyphs live in _cursor.scss). `ctrl` is the live Control-key state (ctrl-clicking a
    // segment inserts a point). Re-queried on every hover move and on modifier changes.
    me.getHoverCursor = function(ctrl){
        if (!active) return null;
        // draw sub-modes get a precise crosshair, like the pixel tools: placement modes drop geometry
        // at the pointer; fill/outline click a target (still a crosshair, matching the pixel fill tool).
        if (isPlacementMode() || mode === "fill" || mode === "outline") return "draw";
        // select / edit mode: reflect the action the hovered target will trigger
        switch (hoverKind){
            case "node":   return "vectormove";                 // drag the point
            case "handle": return "vectormove";                 // drag the bezier tangent handle
            case "region": return "vectormove";                 // drag the whole shape
            case "edge":   return ctrl ? "vectoradd" : "vectorcurve"; // ctrl = insert a point, else bend into a curve
            default:       return "vector";                     // empty space → plain pointer (marquee select)
        }
    };

    function isHoverNode(id){ return hover && hover.kind === "node" && hover.nodeId === id; }
    function isHoverHandle(edgeId, which){ return hover && hover.kind === "handle" && hover.edgeId === edgeId && hover.which === which; }

    // All edge ids incident to any of `nodeIds` — the edges a move may have dragged across others.
    function edgesAroundNodes(v, nodeIds){
        let set = new Set();
        (nodeIds || []).forEach(nid=>{ edgesAtNode(v, nid).forEach(eid=>set.add(eid)); });
        return Array.from(set);
    }
    // spec 013 R1: after a MOVE commits, weld any new crossings the move created and split any fill it
    // now divides. Skipped on a property key, where a move is a pose overlay, not a base-geometry edit.
    function reResolveAfterMove(v, nodeIds){
        if (onProperty()) return;
        if (pendingPaste) return; // a floating paste stays detached until it loses focus (spec 014)
        reResolveEdges(v, edgesAroundNodes(v, nodeIds));
    }

    me.handleUp = function(){
        if (!active || !drag) return;
        let v = vec();
        let d = drag;
        drag = null;

        if (d.kind === "line"){
            if (d.moved){
                let endNode = nodeOrSplitAt(v, d.curGeo.x, d.curGeo.y, d.tol);
                if (endNode !== d.startNode){
                    insertConnectedEdge(v, d.startNode, endNode, { stroke: currentStroke() });
                    endGesture(true); changed(); return;
                }
            }
            endGesture(false); changed(); return;
        }
        if (d.kind === "rect"){
            if (d.moved){ buildRect(v, d.downGeo, d.curGeo); endGesture(true); changed(); return; }
            endGesture(false); changed(); return;
        }
        if (d.kind === "circle"){
            if (d.moved){ buildEllipse(v, d.downGeo, d.curGeo); endGesture(true); changed(); return; }
            endGesture(false); changed(); return;
        }
        if (d.kind === "blob"){
            // a brushed blob commits for any non-empty stroke — even a single click stamps a dot
            if (d.points.length && buildBlob(v, d.points)){ endGesture(true); changed(); return; }
            endGesture(false); changed(); return;
        }
        if (d.kind === "nodes"){
            if (d.moved){ reResolveAfterMove(v, d.nodeIds); endGesture(true); changed(); }
            else {
                // a plain click (no drag) on a node collapses the selection to just that node
                endGesture(false);
                selectedNodes.clear(); selectedNodes.add(d.clickedNode);
                sel.nodeId = d.clickedNode;
                EventBus.trigger(EVENT.vectorChanged);
            }
            return;
        }
        if (d.kind === "region"){
            // moved → the shape was translated (keep it); plain click → selection only (no history)
            if (d.moved){ reResolveAfterMove(v, Object.keys(d.orig || {})); endGesture(true); changed(); }
            else { endGesture(false); EventBus.trigger(EVENT.vectorChanged); }
            return;
        }
        if (d.kind === "marquee"){
            if (d.moved){
                let x0 = Math.min(d.downGeo.x, d.curGeo.x), y0 = Math.min(d.downGeo.y, d.curGeo.y);
                let x1 = Math.max(d.downGeo.x, d.curGeo.x), y1 = Math.max(d.downGeo.y, d.curGeo.y);
                for (let id in v.nodes){
                    let n = v.nodes[id];
                    if (n.x >= x0 && n.x <= x1 && n.y >= y0 && n.y <= y1) selectedNodes.add(id);
                }
            }
            EventBus.trigger(EVENT.vectorChanged); // selection-only, no geometry change / history
            return;
        }
        if (d.kind === "edge" && !d.moved){
            if (d.ctrl){
                // ctrl-click on a segment interior → insert a point there
                let r = splitEdgeAt(v, d.edgeId, d.t);
                sel = { edgeId: null, nodeId: r.midNodeId, handle: null, regionId: null };
                selectedNodes.clear(); selectedEdges.clear(); selectedNodes.add(r.midNodeId);
                endGesture(true); changed(); return;
            }
            // plain click just selects the line (already set on down); no geometry change
            endGesture(false); EventBus.trigger(EVENT.vectorChanged); return;
        }
        if (d.kind === "edge" && d.moved && d.move){
            // alt/right-drag translated the whole line → weld any new crossing it created (spec 013
            // R1). A plain bend (d.move false) is a reshape, not a move, so it is left to fall through.
            reResolveAfterMove(v, Object.keys(d.orig || {}));
            endGesture(true); changed(); return;
        }
        if (d.kind === "handle"){
            // released while snapped collinear → lock the point smooth. The two handles are already
            // collinear from the snap, so just flag the type (don't re-align via setNodeCurveMode,
            // which would swing them to the endpoint tangent and jump away from where you let go).
            if (d.snapping){
                let e = v.edges[d.edgeId];
                if (e){ let n = v.nodes[d.which === "h1" ? e.a : e.b]; if (n) n.type = "smooth"; }
            }
            endGesture(true); changed(); return;
        }
        // handle / curve drags already mutated the model
        endGesture(true);
        changed();
    };

    // Every edge reachable from `startEdgeId` by walking shared endpoints — the connected component of
    // the line graph the clicked line belongs to (its whole open path or closed shape outline).
    function connectedEdges(v, startEdgeId){
        let adj = {};   // node id → incident edge ids
        for (let id in v.edges){
            let e = v.edges[id];
            (adj[e.a] = adj[e.a] || []).push(id);
            (adj[e.b] = adj[e.b] || []).push(id);
        }
        let seen = new Set([startEdgeId]);
        let stack = [startEdgeId];
        while (stack.length){
            let e = v.edges[stack.pop()]; if (!e) continue;
            [e.a, e.b].forEach(nid=>{
                (adj[nid] || []).forEach(nb=>{ if (!seen.has(nb)){ seen.add(nb); stack.push(nb); } });
            });
        }
        return Array.from(seen);
    }

    // Double-click a line → select every line connected to it (all adjacent lines, transitively). No
    // geometry change, so no history; a plain-click's selection/history was already resolved by the
    // preceding handleUp. Ignores double-clicks that don't land on a line.
    me.handleDoubleClick = function(point, tolerance){
        if (!active) return;
        let v = vec();
        if (!v) return;
        let hit = me.pick(docToGeo(point), tolerance || HANDLE);
        if (!hit || hit.kind !== "edge") return;
        selectedNodes.clear();
        selectedEdges = new Set(connectedEdges(v, hit.edgeId));
        sel = { edgeId: hit.edgeId, nodeId: null, handle: null, regionId: null };
        EventBus.trigger(EVENT.vectorChanged);
    };

    // Delete the current selection (node or edge). Bound to COMMAND.VECTORDELETE / Delete key.
    me.deleteSelected = function(){
        if (!active) return;
        syncEditContext();
        // Deleting points/edges/shapes is a topology edit on the base drawing — not animatable per
        // key (spec 012). On a property key or a derived frame it's a no-op; delete on the content key.
        if (poseEditing() || readOnly) return;
        let v = vec();
        if (selectedNodes.size){
            beginHistory();
            Array.from(selectedNodes).forEach(id=>{ if (v.nodes[id]) deleteNode(v, id); });
            selectedNodes.clear();
            sel = { edgeId: null, nodeId: null, handle: null };
            endGesture(true); changed(); return;
        }
        if (sel.nodeId && v.nodes[sel.nodeId]){
            beginHistory();
            deleteNode(v, sel.nodeId);
            sel = { edgeId: null, nodeId: null, handle: null };
            endGesture(true); changed(); return;
        }
        if (selectedEdges.size){
            beginHistory();
            Array.from(selectedEdges).forEach(id=>{ if (v.edges[id]) deleteEdge(v, id); });
            selectedEdges.clear();
            sel = { edgeId: null, nodeId: null, handle: null };
            endGesture(true); changed(); return;
        }
        if (sel.edgeId && v.edges[sel.edgeId]){
            beginHistory();
            deleteEdge(v, sel.edgeId);
            sel = { edgeId: null, nodeId: null, handle: null };
            endGesture(true); changed(); return;
        }
        if (sel.regionId && v.regions[sel.regionId]){
            beginHistory();
            let ids = regionEdgeIds(v.regions[sel.regionId]);
            delete v.regions[sel.regionId];       // drop the fill, then its boundary + hole edges
            ids.forEach(eid=>{ if (v.edges[eid]) deleteEdge(v, eid); });
            sel = { edgeId: null, nodeId: null, handle: null, regionId: null };
            endGesture(true); changed(); return;
        }
    };

    // Arrow-key nudge (Meta = coarse 10px step). Returns true when it consumed the keystroke so the
    // caller stops propagation. A point sub-selection (one or more selected nodes) moves just those
    // points (their curve handles stay, as when dragging a node); otherwise the selected entity moves
    // as a whole — a shape (region), a line (edge) or a single point — rigidly, so curve handles
    // travel with their endpoints and the shape keeps its form.
    me.nudge = function(dx, dy){
        if (!active) return false;
        syncEditContext();
        // A derived (in-between) frame is display-only — nudging edits geometry, so ignore it there.
        // On a property key nudging IS allowed: it translates points, which is exactly a pose edit
        // (changed() commits the displaced points to the key's node overlay).
        if (readOnly) return false;
        let v = vec();
        if (!v) return false;

        let nodeIds = null;   // node ids to translate
        let edgeIds = null;   // edges whose curve handles also translate (rigid move)

        if (selectedNodes.size){
            nodeIds = Array.from(selectedNodes);
        } else if (sel.regionId && v.regions[sel.regionId]){
            edgeIds = regionEdgeIds(v.regions[sel.regionId]);
            let s = new Set();
            edgeIds.forEach(eid=>{ let e = v.edges[eid]; if (e){ s.add(e.a); s.add(e.b); } });
            nodeIds = Array.from(s);
        } else if (selectedEdges.size || (sel.edgeId && v.edges[sel.edgeId])){
            edgeIds = Array.from(selectedEdges).filter(id=>v.edges[id]);
            if (!edgeIds.length && sel.edgeId) edgeIds = [sel.edgeId];
            let s = new Set();
            edgeIds.forEach(eid=>{ let e = v.edges[eid]; if (e){ s.add(e.a); s.add(e.b); } });
            nodeIds = Array.from(s);
        } else if (sel.nodeId && v.nodes[sel.nodeId]){
            nodeIds = [sel.nodeId];
        }
        if (!nodeIds || !nodeIds.length) return false;

        beginHistory();
        nodeIds.forEach(id=>{ let n = v.nodes[id]; if (n){ n.x += dx; n.y += dy; } });
        if (edgeIds) edgeIds.forEach(eid=>{
            // a shape/line moves rigidly: both handles of every one of its edges travel too
            let e = v.edges[eid];
            if (e && e.curve){
                if (e.curve.h1){ e.curve.h1.x += dx; e.curve.h1.y += dy; }
                if (e.curve.h2){ e.curve.h2.x += dx; e.curve.h2.y += dy; }
            }
        });
        else {
            // moving loose point(s): drag each point's own curve handles along so the curve stays
            // attached to it (the far endpoint's handle stays put)
            let hb = incidentHandleBases(v, nodeIds);
            for (let k in hb){ let h = hb[k], e = v.edges[h.edgeId]; if (e && e.curve && e.curve[h.which]){ e.curve[h.which].x += dx; e.curve[h.which].y += dy; } }
        }
        endGesture(true); changed();
        return true;
    };

    // ── node-tool option-bar operations (curve mode / split / join) ────────────────────
    // The currently addressed nodes: the multi-selection, or the singly-selected node.
    function selectedIds(){
        let ids = Array.from(selectedNodes);
        if (!ids.length && sel.nodeId) ids = [sel.nodeId];
        return ids;
    }

    // Shared curve mode ("square"|"sharp"|"smooth") of the selected nodes, or null if they differ
    // or nothing is selected — drives the highlighted button in the tool options.
    me.getSelectedNodeMode = function(){
        let v = vec();
        if (!v) return null;
        let ids = selectedIds();
        if (!ids.length) return null;
        let m = getNodeCurveMode(v, ids[0]);
        for (let i = 1; i < ids.length; i++){ if (getNodeCurveMode(v, ids[i]) !== m) return null; }
        return m;
    };

    me.setSelectedNodeMode = function(nodeMode){
        if (!active || !nodeMode) return;
        syncEditContext();
        // Point curve mode (corner/smooth) reshapes the base drawing — not a per-key pose (spec 012).
        if (poseEditing() || readOnly) return;
        let v = vec();
        if (!v) return;
        let ids = selectedIds();
        if (!ids.length) return;
        beginHistory();
        ids.forEach(id=>{ if (v.nodes[id]) setNodeCurveMode(v, id, nodeMode); });
        endGesture(true); changed();
    };

    // Split the path at the single selected node (its overlapping copies land selected so they can
    // be dragged apart). No-op unless exactly one node — with ≥2 incident edges — is selected.
    me.splitSelectedNode = function(){
        if (!active) return;
        syncEditContext();
        // Splitting a node changes topology — a base-drawing edit, not a per-key pose (spec 012).
        if (poseEditing() || readOnly) return;
        let v = vec();
        if (!v) return;
        let ids = selectedIds();
        if (ids.length !== 1) return;
        beginHistory();
        let created = splitNodeAt(v, ids[0]);
        if (created && created.length){
            created.forEach(id=>selectedNodes.add(id));
            endGesture(true); changed();
        } else {
            endGesture(false);
        }
    };

    // Join all selected nodes into one at their average position. No-op with fewer than two.
    me.joinSelectedNodes = function(){
        if (!active) return;
        syncEditContext();
        // Joining nodes changes topology — a base-drawing edit, not a per-key pose (spec 012).
        if (poseEditing() || readOnly) return;
        let v = vec();
        if (!v) return;
        let ids = selectedIds();
        if (ids.length < 2) return;
        beginHistory();
        let keep = joinNodes(v, ids);
        if (keep){
            selectedNodes.clear();
            selectedNodes.add(keep);
            sel = { edgeId: null, nodeId: keep, handle: null };
            endGesture(true); changed();
        } else {
            endGesture(false);
        }
    };

    // ── selection properties (Properties panel) ─────────────────────────────────────────
    // A read-only description of what is currently addressed for property editing, in priority
    // order: a multi-point selection ("a group of points") → a single point → a whole shape
    // (region) → a line (edge). Coordinates are DOCUMENT coords (geometry + the layer offset), so
    // they match the ruler/canvas; the setters below take document coords and map back to geometry.
    me.getSelectionInfo = function(){
        syncEditContext();
        let v = vec();
        if (!active || !v) return { kind: "none" };
        let o = scopeOffset();
        let ids = Array.from(selectedNodes).filter(id=>v.nodes[id]);
        if (!ids.length && sel.nodeId && v.nodes[sel.nodeId]) ids = [sel.nodeId];

        if (ids.length > 1){
            let xs = ids.map(id=>v.nodes[id].x), ys = ids.map(id=>v.nodes[id].y);
            let x0 = Math.min.apply(null, xs), y0 = Math.min.apply(null, ys);
            let x1 = Math.max.apply(null, xs), y1 = Math.max.apply(null, ys);
            let out = { kind: "nodes", id: ids.slice().sort().join(","), count: ids.length,
                        x: x0 + o.x, y: y0 + o.y, w: x1 - x0, h: y1 - y0 };
            // When lines are selected too (e.g. Select-All grabs points AND lines), expose their
            // shared stroke so the panel can offer a line colour + width control beside the bbox.
            let seids = Array.from(selectedEdges).filter(id=>v.edges[id]);
            if (seids.length){
                let stroke = v.edges[seids[0]].stroke || {};
                out.edgeCount = seids.length;
                out.strokeColor = stroke.color || null;
                out.strokeWidth = stroke.width == null ? 1 : stroke.width;
            }
            return out;
        }
        if (ids.length === 1){
            let n = v.nodes[ids[0]];
            return { kind: "node", id: ids[0], x: n.x + o.x, y: n.y + o.y };
        }
        if (sel.regionId && v.regions[sel.regionId]){
            let region = v.regions[sel.regionId];
            let stroke = null;
            regionEdgeIds(region).some(eid=>{ let e = v.edges[eid]; if (e && e.stroke){ stroke = e.stroke; return true; } return false; });
            return { kind: "region", id: sel.regionId,
                     fill: (region.fill && region.fill.color) || null,
                     strokeColor: stroke ? (stroke.color || null) : null,
                     strokeWidth: stroke ? (stroke.width == null ? 1 : stroke.width) : 1 };
        }
        let eids = Array.from(selectedEdges).filter(id=>v.edges[id]);
        if (!eids.length && sel.edgeId && v.edges[sel.edgeId]) eids = [sel.edgeId];
        if (eids.length){
            let stroke = v.edges[eids[0]].stroke || {};
            return { kind: "edge", id: eids.join(","), count: eids.length,
                     strokeColor: stroke.color || null,
                     strokeWidth: stroke.width == null ? 1 : stroke.width };
        }
        return { kind: "none" };
    };

    // Move the single selected point to a document coordinate (its own curve handles follow, as
    // when dragging it). No-op unless exactly one point is selected.
    me.setSelectedNodePosition = function(docX, docY){
        syncEditContext();
        // Moving a point is a pose edit — allowed on a property key (changed() writes the node
        // overlay). Blocked on a derived frame, which is display-only (spec 012).
        if (readOnly) return;
        let v = vec();
        if (!active || !v) return;
        let ids = Array.from(selectedNodes).filter(id=>v.nodes[id]);
        if (!ids.length && sel.nodeId && v.nodes[sel.nodeId]) ids = [sel.nodeId];
        if (ids.length !== 1) return;
        let n = v.nodes[ids[0]];
        let o = scopeOffset();
        let nx = docX - o.x, ny = docY - o.y;
        if (getDisplayMode(v) === "sharp"){ nx = Math.round(nx); ny = Math.round(ny); }
        let dx = nx - n.x, dy = ny - n.y;
        if (!dx && !dy) return;
        beginHistory();
        n.x = nx; n.y = ny;
        let hb = incidentHandleBases(v, [ids[0]]);
        for (let k in hb){ let h = hb[k], e = v.edges[h.edgeId]; if (e && e.curve && e.curve[h.which]){ e.curve[h.which].x += dx; e.curve[h.which].y += dy; } }
        endGesture(true); changed();
    };

    // Reshape the bounding box of the multi-point selection. `props` may carry any of {x,y} (new
    // top-left, document coords), {w,h} (new size, px) and {rot} (rotate the group this many degrees
    // about the box centre). Omitted components keep their current value. Curve handles of edges
    // internal to the selection transform with it; boundary edges keep their far handle. Rotation is
    // not stored — it is applied immediately — so the Rot field always reads back 0.
    me.setSelectionBBox = function(props){
        syncEditContext();
        // Scaling/rotating a group of points repositions them — a pose edit, allowed on a property
        // key (changed() writes the node overlay). Blocked on a display-only derived frame (spec 012).
        if (readOnly) return;
        let v = vec();
        if (!active || !v || !props) return;
        let ids = Array.from(selectedNodes).filter(id=>v.nodes[id]);
        if (ids.length < 2) return;
        let xs = ids.map(id=>v.nodes[id].x), ys = ids.map(id=>v.nodes[id].y);
        let x0 = Math.min.apply(null, xs), y0 = Math.min.apply(null, ys);
        let x1 = Math.max.apply(null, xs), y1 = Math.max.apply(null, ys);
        let w = x1 - x0, h = y1 - y0;
        let o = scopeOffset();

        let tx = (props.x == null ? x0 + o.x : props.x) - o.x;   // new local top-left
        let ty = (props.y == null ? y0 + o.y : props.y) - o.y;
        let tw = props.w == null ? w : Math.max(0, props.w);
        let th = props.h == null ? h : Math.max(0, props.h);
        let rot = props.rot == null ? 0 : props.rot;
        if (tx === x0 && ty === y0 && tw === w && th === h && !rot) return;

        let sx = w ? tw / w : 1, sy = h ? th / h : 1;
        let cx = tx + tw / 2, cy = ty + th / 2;      // rotate about the new box centre
        let ang = rot * Math.PI / 180, cos = Math.cos(ang), sin = Math.sin(ang);
        let snap = getDisplayMode(v) === "sharp";
        function tf(px, py){
            let lx = tx + (px - x0) * sx;            // scale into the new box (about the old top-left)
            let ly = ty + (py - y0) * sy;
            let rx = cx + (lx - cx) * cos - (ly - cy) * sin;   // then rotate about the centre
            let ry = cy + (lx - cx) * sin + (ly - cy) * cos;
            if (snap){ rx = Math.round(rx); ry = Math.round(ry); }
            return { x: rx, y: ry };
        }

        beginHistory();
        let selSet = new Set(ids);
        let doneH = {};
        ids.forEach(id=>{
            edgesAtNode(v, id).forEach(eid=>{
                let e = v.edges[eid];
                if (!e || !e.curve) return;
                if (!(selSet.has(e.a) && selSet.has(e.b))) return;    // only edges internal to the group
                if (!doneH[eid + "h1"] && e.curve.h1){ e.curve.h1 = tf(e.curve.h1.x, e.curve.h1.y); doneH[eid + "h1"] = 1; }
                if (!doneH[eid + "h2"] && e.curve.h2){ e.curve.h2 = tf(e.curve.h2.x, e.curve.h2.y); doneH[eid + "h2"] = 1; }
            });
        });
        ids.forEach(id=>{ let n = v.nodes[id]; let p = tf(n.x, n.y); n.x = p.x; n.y = p.y; });
        endGesture(true); changed();
    };

    // The edges whose stroke a "line/shape colour + width" edit targets: a selected line is just
    // that edge; a selected shape (region) is its whole boundary + hole loops.
    function strokeTargetEdges(v){
        if (sel.regionId && v.regions[sel.regionId]) return regionEdgeIds(v.regions[sel.regionId]);
        let multi = Array.from(selectedEdges).filter(id=>v.edges[id]);
        if (multi.length) return multi;
        if (sel.edgeId && v.edges[sel.edgeId]) return [sel.edgeId];
        return [];
    }
    me.setSelectedStrokeColor = function(hex){
        syncEditContext();
        // Stroke/fill styling lives on the base drawing — not a per-key pose (spec 012).
        if (poseEditing() || readOnly) return;
        let v = vec();
        if (!active || !v || !hex) return;
        let eids = strokeTargetEdges(v);
        if (!eids.length) return;
        beginHistory();
        eids.forEach(eid=>{ let e = v.edges[eid]; if (e) e.stroke = Object.assign({}, e.stroke || {}, { color: hex }); });
        endGesture(true); changed();
    };
    // Set the stroke width of the selected line(s) / shape. `live` keeps the single history step
    // open so a slider drag applies in realtime (each move mutates + repaints, no new undo step);
    // the caller must finalize with commitSelectedStroke() on release. Without `live` it is a
    // standalone one-step edit (a plain click / keyboard change).
    me.setSelectedStrokeWidth = function(width, live){
        syncEditContext();
        // Stroke width lives on the base drawing — not a per-key pose (spec 012).
        if (poseEditing() || readOnly) return;
        let v = vec();
        if (!active || !v) return;
        width = Math.max(0, +width || 0);
        let eids = strokeTargetEdges(v);
        if (!eids.length) return;
        beginHistory();
        eids.forEach(eid=>{ let e = v.edges[eid]; if (e) e.stroke = Object.assign({}, e.stroke || {}, { width: width }); });
        if (live){ changed(); return; }   // keep the history step open for the ongoing drag
        endGesture(true); changed();
    };
    // Close the history step opened by a run of live setSelectedStrokeWidth(..., true) calls, so the
    // whole slider drag lands as a single undoable edit. Safe to call even if nothing is open.
    me.commitSelectedStroke = function(){
        if (!active) return;
        endGesture(true); changed();
    };
    me.setSelectedFillColor = function(hex){
        syncEditContext();
        // Fill colour lives on the base drawing — not a per-key pose (spec 012).
        if (poseEditing() || readOnly) return;
        let v = vec();
        if (!active || !v || !hex) return;
        if (!(sel.regionId && v.regions[sel.regionId])) return;
        beginHistory();
        let r = v.regions[sel.regionId];
        r.fill = Object.assign({}, r.fill || {}, { color: hex });
        endGesture(true); changed();
    };

    // ── shape builders ───────────────────────────────────────────────────────────────
    function makeRegion(v, edgeIds){
        if (!wantsFill()) return;
        let id = newRegionId(v);
        v.regions[id] = { id: id, boundary: edgeIds.slice(), fill: { color: currentFillColor(), smooth: !!(ToolOptions.isSmooth && ToolOptions.isSmooth()) } };
    }

    function buildRect(v, a, b){
        let x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
        let x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
        let n = [ addNode(v,x0,y0), addNode(v,x1,y0), addNode(v,x1,y1), addNode(v,x0,y1) ];
        let stroke = currentStroke();
        let e = [];
        for (let i = 0; i < 4; i++){
            e.push(addEdge(v, n[i].id, n[(i+1)%4].id, { stroke: stroke }).id);
        }
        makeRegion(v, e);
    }

    function buildEllipse(v, a, b){
        let cx = (a.x + b.x)/2, cy = (a.y + b.y)/2;
        let rx = Math.abs(a.x - b.x)/2, ry = Math.abs(a.y - b.y)/2;
        const K = 0.5522847498307936;
        // four quadrant nodes: right, bottom, left, top
        let right = addNode(v, cx+rx, cy);
        let bottom = addNode(v, cx, cy+ry);
        let left = addNode(v, cx-rx, cy);
        let top = addNode(v, cx, cy-ry);
        let stroke = currentStroke();
        let e = [];
        // right→bottom, bottom→left, left→top, top→right, each a cubic arc
        e.push(addEdge(v, right.id, bottom.id, { stroke: stroke, curve: { h1:{x:cx+rx, y:cy+ry*K}, h2:{x:cx+rx*K, y:cy+ry} } }).id);
        e.push(addEdge(v, bottom.id, left.id, { stroke: stroke, curve: { h1:{x:cx-rx*K, y:cy+ry}, h2:{x:cx-rx, y:cy+ry*K} } }).id);
        e.push(addEdge(v, left.id, top.id, { stroke: stroke, curve: { h1:{x:cx-rx, y:cy-ry*K}, h2:{x:cx-rx*K, y:cy-ry} } }).id);
        e.push(addEdge(v, top.id, right.id, { stroke: stroke, curve: { h1:{x:cx+rx*K, y:cy-ry}, h2:{x:cx+rx, y:cy-ry*K} } }).id);
        makeRegion(v, e);
    }

    // The brush the blob tool stamps along the stroke: shape + diameter taken from the global Brush
    // (the toolbar presets / the Blob option-bar drive it). Only the two geometric shapes make sense
    // for a filled blob — anything else (cross / image / canvas "dithered" brushes) falls back to a
    // round blob of the same width. Size is clamped to a sane minimum so a 1px brush still traces.
    function blobBrushSpec(){
        let b = (Brush && Brush.get) ? Brush.get() : null;
        let size = b ? Math.max(1, Math.round(b.width || b.height || 1)) : 1;
        let shape = (b && b.type === "square") ? "square" : "circle";
        return { shape: shape, size: size };
    }

    // Rasterizes the union of the brush stamped along the stroke into a small 1-bit mask, padded with
    // an empty border so the contour tracer (which treats out-of-grid as empty) closes cleanly.
    //   • circle — a round-capped/round-joined stroke of width = diameter IS the exact Minkowski sum
    //              of the path with a disc.
    //   • square — axis-aligned squares stamped densely (≤1px apart) along each segment: the exact
    //              Minkowski sum of the path with a square.
    // Returns { mask:Uint8Array, w, h, ox, oy } where (ox,oy) is the geometry-space coord of mask
    // pixel (0,0), or null when the stroke has no extent.
    function buildBlobMask(pts, spec, extraPolys){
        if (typeof document === "undefined" || !pts.length) return null;
        let r = spec.size / 2;
        let pad = Math.ceil(r) + 2;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        pts.forEach(p=>{ if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; });
        // merged regions extend the mask so their full outline is inside the padded border
        (extraPolys || []).forEach(poly=>{
            (poly.boundary || []).concat(...(poly.holes || [])).forEach(p=>{
                if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
            });
        });
        let ox = Math.floor(minX) - pad;
        let oy = Math.floor(minY) - pad;
        let dw = Math.ceil(maxX) + pad - ox;   // mask footprint in document pixels
        let dh = Math.ceil(maxY) + pad - oy;
        if (dw <= 0 || dh <= 0) return null;

        // supersample so the traced contour is sub-pixel accurate (a smooth outline instead of a 1px
        // stair-step); back the factor off, then bail, if the buffer would get too large.
        let scale = BLOB_SUPERSAMPLE;
        while (scale > 1 && dw * scale * dh * scale > 1.6e7) scale--;
        let w = dw * scale, h = dh * scale;
        if (w * h > 1.6e7) return null;

        let cv = document.createElement("canvas");
        cv.width = w; cv.height = h;
        let ctx = cv.getContext("2d");
        ctx.fillStyle = "#000";
        ctx.strokeStyle = "#000";
        // draw in DOCUMENT coordinates; the transform maps them into supersampled pixels
        ctx.setTransform(scale, 0, 0, scale, -ox * scale, -oy * scale);

        // stamp the regions we're merging into FIRST (same colour → one shape); holes stay holes via
        // the even-odd rule, and the new stroke below unions on top (possibly filling a hole).
        (extraPolys || []).forEach(poly=>{
            if (!poly.boundary || poly.boundary.length < 3) return;
            let path = new Path2D();
            let addLoop = (loop)=>{
                path.moveTo(loop[0].x, loop[0].y);
                for (let i = 1; i < loop.length; i++) path.lineTo(loop[i].x, loop[i].y);
                path.closePath();
            };
            addLoop(poly.boundary);
            (poly.holes || []).forEach(h=>{ if (h.length >= 3) addLoop(h); });
            ctx.fill(path, "evenodd");
        });

        if (spec.shape === "circle"){
            ctx.lineWidth = Math.max(spec.size, 1);
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            ctx.beginPath();
            ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
            // a single-point / zero-length stroke still deposits a dot (round cap needs a length)
            if (pts.length === 1) ctx.lineTo(pts[0].x + 0.01, pts[0].y);
            ctx.stroke();
        } else {
            // axis-aligned squares stamped densely along the path — the brush square is NEVER rotated
            let s = Math.max(spec.size, 1), half = s / 2;
            let stamp = (x, y)=>ctx.fillRect(x - half, y - half, s, s);
            stamp(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++){
                let a = pts[i-1], b = pts[i];
                let d = Math.hypot(b.x - a.x, b.y - a.y);
                let steps = Math.max(1, Math.ceil(d * scale));   // ≤1 supersampled px apart → no gaps
                for (let k = 1; k <= steps; k++){ let t = k / steps; stamp(a.x + (b.x-a.x)*t, a.y + (b.y-a.y)*t); }
            }
        }

        let data = ctx.getImageData(0, 0, w, h).data;
        let mask = new Uint8Array(w * h);
        for (let i = 3, j = 0; i < data.length; i += 4, j++) mask[j] = data[i] >= 128 ? 1 : 0;
        return { mask: mask, w: w, h: h, ox: ox, oy: oy, scale: scale };
    }

    // even-odd ray cast — is point p inside the polygon `loop`? (contours never cross, so testing any
    // vertex of an inner loop against an outer loop reliably decides nesting).
    function pointInLoop(p, loop){
        let inside = false;
        for (let i = 0, j = loop.length - 1; i < loop.length; j = i++){
            let xi = loop[i].x, yi = loop[i].y, xj = loop[j].x, yj = loop[j].y;
            let hit = ((yi > p.y) !== (yj > p.y)) && (p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi);
            if (hit) inside = !inside;
        }
        return inside;
    }

    // Same-colour fill regions that the new stroke could touch — the ones the blob merges into so
    // overlapping blobs of the same foreground colour become ONE shape. Bbox pre-filter only (the
    // raster union + contour trace decides actual connectivity); disjoint ones simply re-emerge as
    // their own region. Returns [{ id, polys }].
    function mergeableRegions(v, pts, spec, fill){
        let r = spec.size / 2 + 1;
        let sminX = Infinity, sminY = Infinity, smaxX = -Infinity, smaxY = -Infinity;
        pts.forEach(p=>{ if (p.x<sminX) sminX=p.x; if (p.y<sminY) sminY=p.y; if (p.x>smaxX) smaxX=p.x; if (p.y>smaxY) smaxY=p.y; });
        sminX -= r; sminY -= r; smaxX += r; smaxY += r;
        let out = [];
        for (let id in v.regions){
            let reg = v.regions[id];
            if (!reg.fill || reg.fill.color !== fill) continue;
            let polys = regionPolygons(v, reg);
            let b = regionPolygonBounds(polys);
            if (!b) continue;
            if (b.maxX < sminX || b.minX > smaxX || b.maxY < sminY || b.minY > smaxY) continue;
            out.push({ id: id, polys: polys });
        }
        return out;
    }

    // Blob outline tuning. The brushed stroke is rasterized SUPERSAMPLED so its contour is captured at
    // sub-pixel accuracy, then traced and simplified into a straight-segment polygon that follows the
    // shape closely — a dense polygon reads cleaner than an over-eager curve fit, so we do NOT fit
    // béziers. The "Smooth" tool-option slider sets the Douglas-Peucker tolerance: HIGHER = smoother =
    // MANY more points (tiny tolerance, hugs the contour), lower = fewer points / coarser. Pixel-art
    // ("sharp") mode also snaps to grid.
    const BLOB_SUPERSAMPLE = 3;

    // Douglas-Peucker tolerance in DOCUMENT pixels, from the Smooth slider. Higher slider → smaller
    // tolerance → far more points: s=100 → 0.05 px (keeps nearly the whole traced contour), s=0 → 2.0 px.
    function blobSimplifyEps(){
        let s = (ToolOptions.getBlobSmoothness ? ToolOptions.getBlobSmoothness() : 50);
        s = Math.max(0, Math.min(100, s));
        return 0.05 + ((100 - s) / 100) * 1.95;
    }


    function buildBlob(v, pts){
        let spec = blobBrushSpec();
        let fill = currentFillColor();
        let merge = mergeableRegions(v, pts, spec, fill);
        let m = buildBlobMask(pts, spec, merge.map(x=>x.polys));
        if (!m) return false;
        let loops = traceMaskContours(m.mask, m.w, m.h);
        if (!loops.length) return false;

        let sharp = getDisplayMode(v) === "sharp";
        let eps = blobSimplifyEps() * m.scale;
        let smoothClosed = (loop, passes)=>{
            let cur = loop;
            for (let p = 0; p < passes; p++){
                let n = cur.length, out = new Array(n);
                for (let i = 0; i < n; i++){
                    let a = cur[(i-1+n)%n], b = cur[i], c = cur[(i+1)%n];
                    out[i] = { x: (a.x + 2*b.x + c.x)/4, y: (a.y + 2*b.y + c.y)/4 };
                }
                cur = out;
            }
            return cur;
        };
        let smoothPasses = Math.round(m.scale) + 1;
        // simplify each loop, map back to document space (÷ scale), drop specks
        let geoLoops = [];
        loops.forEach(loop=>{
            if (smoothPasses && loop.length >= 4) loop = smoothClosed(loop, smoothPasses);
            let simp = simplifyLoop(loop, eps);
            if (simp.length < 3) return;
            let g = simp.map(p=>{
                // a mask sample at (p.x,p.y) is the pixel CENTRE, i.e. device (p.x+0.5,p.y+0.5);
                // include the half-pixel so the traced outline lands exactly on the shape (without it
                // every re-trace biases up/left by 0.5/scale doc px, which accumulates across merges).
                let x = m.ox + (p.x + 0.5) / m.scale, y = m.oy + (p.y + 0.5) / m.scale;
                if (sharp){ x = Math.round(x); y = Math.round(y); }
                return { x: x, y: y };
            });
            if (loopAbsArea(g) < 1) return;   // ignore near-degenerate contours
            geoLoops.push(g);
        });
        if (!geoLoops.length) return false;

        // largest first, so the first loop that contains another is its immediate (smallest) parent
        geoLoops.sort((a, b)=>loopAbsArea(b) - loopAbsArea(a));
        let info = geoLoops.map(l=>({ loop: l, parent: -1, depth: 0, region: -1 }));
        for (let i = 0; i < info.length; i++){
            let rep = info[i].loop[0];
            for (let j = 0; j < i; j++){ if (pointInLoop(rep, info[j].loop)) info[i].parent = j; }
            info[i].depth = info[i].parent < 0 ? 0 : info[info[i].parent].depth + 1;
        }

        // now safe to remove the regions we merged (this and the creation below are one history step)
        merge.forEach(x=> deleteRegionGeometry(v, x.id));

        let makeLoopEdges = (loop)=>{
            let nodes = loop.map(p=>addNode(v, p.x, p.y));
            let e = [];
            for (let i = 0; i < nodes.length; i++){
                e.push(addEdge(v, nodes[i].id, nodes[(i+1)%nodes.length].id, { stroke: null }).id);
            }
            return e;
        };

        // even depth → new region boundary; odd depth → hole of its parent's region
        let regions = [];
        info.forEach(node=>{
            if (node.depth % 2 === 0){
                node.region = regions.length;
                regions.push({ boundary: makeLoopEdges(node.loop), holes: [] });
            }
        });
        info.forEach(node=>{
            if (node.depth % 2 === 1 && node.parent >= 0){
                let parentRegion = info[node.parent].region;
                if (parentRegion >= 0) regions[parentRegion].holes.push(makeLoopEdges(node.loop));
            }
        });

        regions.forEach(rgn=>{
            let id = newRegionId(v);
            v.regions[id] = {
                id: id,
                boundary: rgn.boundary,
                holes: rgn.holes,
                fillRule: "evenodd",
                fill: { color: fill, smooth: !sharp }
            };
        });
        return true;
    }

    function fillAt(gp, tol){
        let v = vec();
        let smooth = !!(ToolOptions.isSmooth && ToolOptions.isSmooth());
        // 1. click inside an EXISTING filled region → just recolour it.
        if (hitCtx){
            let id = regionAtPoint(v, hitCtx, gp.x, gp.y);
            if (id){
                beginHistory();
                v.regions[id].fill = { color: currentFillColor(), smooth: smooth };
                endGesture(true); changed();
                return;
            }
        }
        // 2. otherwise flood-fill
        let gap = ToolOptions.getGapClose ? ToolOptions.getGapClose() : "none";
        let gapTol = gap === "small" ? tol * 0.6 : gap === "medium" ? tol * 1.2 : gap === "large" ? tol * 2.2 : 0;

        beginHistory();
        if (gapTol > 0) closeGaps(v, gapTol);
        let loop = enclosingCycle(v, gp.x, gp.y);
        if (!loop){ endGesture(false); return; }   // not enclosed → roll back any gap-welding
        let id = newRegionId(v);
        v.regions[id] = {
            id: id,
            boundary: loop,
            holes: [],
            fillRule: "nonzero",
            fill: { color: currentFillColor(), smooth: smooth }
        };
        endGesture(true); changed();
    }

    function outlineAt(gp, tol){
        let v = vec();
        let e = edgeAtPoint(v, gp.x, gp.y, tol);
        if (e){
            beginHistory();
            v.edges[e.edgeId].stroke = currentStroke();
            endGesture(true); changed(); return;
        }
        // otherwise, stroke a region's whole boundary if the click is inside one
        if (hitCtx){
            let id = regionAtPoint(v, hitCtx, gp.x, gp.y);
            if (id){
                beginHistory();
                let stroke = currentStroke();
                v.regions[id].boundary.forEach(eid=>{ if (v.edges[eid]) v.edges[eid].stroke = Object.assign({}, stroke); });
                endGesture(true); changed();
            }
        }
    }


    function promoteToCurveThrough(v, edgeId, t, target){
        let e = v.edges[edgeId];
        let a = v.nodes[e.a], b = v.nodes[e.b];
        let onLine = { x: a.x + (b.x-a.x)*t, y: a.y + (b.y-a.y)*t };
        let mt = 1 - t;
        let bcoef = 3*mt*mt*t;
        let ccoef = 3*mt*t*t;
        let denom = bcoef + ccoef;
        if (denom < 1e-6) denom = 1e-6;
        let dx = (target.x - onLine.x) / denom;
        let dy = (target.y - onLine.y) / denom;
        let l1 = { x: a.x + (b.x-a.x)/3, y: a.y + (b.y-a.y)/3 };
        let l2 = { x: a.x + (b.x-a.x)*2/3, y: a.y + (b.y-a.y)*2/3 };
        e.curve = { h1: { x: l1.x + dx, y: l1.y + dy }, h2: { x: l2.x + dx, y: l2.y + dy } };
    }


    const SVGNS = "http://www.w3.org/2000/svg";

    function svgEl(name, attrs){
        let el = document.createElementNS(SVGNS, name);
        for (let k in attrs) el.setAttribute(k, attrs[k]);
        return el;
    }

    me.drawOverlay = function(svg, zoom){
        // clear previous frame
        while (svg.firstChild) svg.removeChild(svg.firstChild);
        if (!active) return;
        syncEditContext(); // draw nodes/handles at the resolved (posed/tweened) positions
        let v = vec();
        if (!v) return;
        let s = 1 / (zoom || 1);
        lastScale = s;
        let o = scopeOffset();
        let nodeMode = mode === "node";

        // Selected line(s) (edge) also show their endpoint nodes, so they're visible and can be
        // grabbed/dragged individually (pick already hit-tests any node; this makes them appear).
        let selEdgeSet = new Set(Array.from(selectedEdges).filter(id=>v.edges[id]));
        if (sel.edgeId && v.edges[sel.edgeId]) selEdgeSet.add(sel.edgeId);
        let selEdgeNodeSet = null;
        if (selEdgeSet.size){
            selEdgeNodeSet = new Set();
            selEdgeSet.forEach(eid=>{ let e = v.edges[eid]; if (e){ selEdgeNodeSet.add(e.a); selEdgeNodeSet.add(e.b); } });
        }

        // A selected whole shape (region) highlights every one of its boundary + hole edges and all
        // their nodes — collect them up front so the edge/node loops below light them too.
        let regionEdgeSet = null, regionNodeSet = null;
        if (sel.regionId && v.regions[sel.regionId]){
            let region = v.regions[sel.regionId];
            regionEdgeSet = new Set(regionEdgeIds(region));
            regionNodeSet = new Set();
            regionEdgeSet.forEach(eid=>{ let e = v.edges[eid]; if (e){ regionNodeSet.add(e.a); regionNodeSet.add(e.b); } });
            // Tint the selected shape's fill so it's obvious the whole shape (not just its outline)
            // is selected. Drawn first, under the edge/node highlights, offset into document space.
            let d = regionPathData(v, region);
            if (d){
                svg.appendChild(svgEl("path", {
                    d: d, transform: "translate(" + o.x + " " + o.y + ")",
                    fill: "rgba(255,90,0,0.28)", stroke: "none",
                    "fill-rule": region.fillRule || "nonzero"
                }));
            }
        }

        // Edges: by default only the *selected* edge (or the edges of a selected shape) are
        // highlighted — selecting the layer must not light up the whole drawing. The Node tool is the
        // exception: there we draw every edge as a thin guide (so geometry is visible/grabbable even
        // where the stroke is off) while editing.
        for (let id in v.edges){
            let e = v.edges[id];
            let selected = selEdgeSet.has(id) || (regionEdgeSet && regionEdgeSet.has(id));
            if (!selected && !nodeMode) continue;
            strokeGuide(svg, v, e, o, selected ? "#ff5a00" : "rgba(0,150,255,0.7)", selected ? 1.6 : 1.0);
        }

        // bezier tangent handles: both handles of a selected edge, plus the near handle of every
        // curved edge meeting at a selected node — so clicking a curve endpoint reveals its handles
        // too. Shown whenever the edit tool has a sub-selection (activeHandles is already gated on
        // isEditMode + what's selected), never merely on layer-select.
        if (isEditMode()){
            activeHandles(v).forEach(h=>{
                if (!h.p || !h.anchor) return;
                handleLine(svg, h.anchor, h.p, o);
                dot(svg, h.p, o, (isHoverHandle(h.edgeId, h.which) ? 5 : 3) * s, "#ffcc00");
            });
        }


        for (let id in v.nodes){
            let n = v.nodes[id];
            let selected = selectedNodes.has(id) || id === sel.nodeId || (regionNodeSet && regionNodeSet.has(id)) || (selEdgeNodeSet && selEdgeNodeSet.has(id));
            if (!selected && !nodeMode) continue;
            let r = (selected ? (nodeMode?4:3.5) : (nodeMode?3:2.5)) * s;
            if (isHoverNode(id)) r += 2.5 * s; // enlarge the point under the cursor so it's clear you're on it
            // a locked/"smooth" point (collinear handles) draws as a round dot; every other point
            // (corner / cusp) draws as a square. While a handle-drag is snapped collinear the point
            // flashes as a RED filled dot to signal "release now to lock it smooth".
            let snapping = drag && drag.kind === "handle" && drag.snapping && drag.snapNodeId === id;
            if (snapping){
                dot(svg, n, o, r + 0.5*s, "#ff2a2a");
            } else if (getNodeCurveMode(v, id) === "smooth"){
                dot(svg, n, o, r, selected ? "#ffffff" : "rgba(0,150,255,0.9)");
            } else {
                square(svg, n, o, r, selected ? "#ffffff" : "rgba(0,150,255,0.9)");
            }
        }

        if (pendingPaste){
            pendingPaste.edgeIds.forEach(eid=>{
                let e = v.edges[eid];
                if (!e) return;
                let g = edgeGeometry(v, e);
                let d = "M" + (g.p0.x+o.x) + " " + (g.p0.y+o.y);
                if (g.isCurve) d += " C" + (g.h1.x+o.x)+" "+(g.h1.y+o.y)+" "+(g.h2.x+o.x)+" "+(g.h2.y+o.y)+" "+(g.p3.x+o.x)+" "+(g.p3.y+o.y);
                else d += " L" + (g.p3.x+o.x)+" "+(g.p3.y+o.y);
                svg.appendChild(svgEl("path", { d: d, fill: "none", stroke: "#ff5a00", "stroke-width": 1.4,
                    "stroke-dasharray": "4 3", "vector-effect": "non-scaling-stroke" }));
            });
        }

        if (drag){
            let st = currentStroke();
            if (drag.kind === "line"){
                previewLine(svg, drag.downGeo, drag.curGeo, o, st);
            } else if (drag.kind === "rect"){
                previewRect(svg, drag.downGeo, drag.curGeo, o, st, wantsFill() ? currentFillColor() : null);
            } else if (drag.kind === "circle"){
                previewEllipse(svg, drag.downGeo, drag.curGeo, o, st, wantsFill() ? currentFillColor() : null);
            } else if (drag.kind === "blob" && drag.points){
                previewBlob(svg, drag.points, o, blobBrushSpec(), currentFillColor()); // fat brushed blob, grows as you paint
            } else if (drag.kind === "marquee" && drag.moved){
                marqueeRect(svg, drag.downGeo, drag.curGeo, o);
            }
        }
    };

    function marqueeRect(svg, a, b, o){
        let box = { x: Math.min(a.x,b.x)+o.x, y: Math.min(a.y,b.y)+o.y, width: Math.abs(b.x-a.x), height: Math.abs(b.y-a.y) };
        svg.appendChild(svgEl("rect", Object.assign({}, box, { "class": "marquee-white" })));
        svg.appendChild(svgEl("rect", Object.assign({}, box, { "class": "marquee-ants" })));
    }

    function strokeGuide(svg, v, edge, o, color, lw){
        let g = edgeGeometry(v, edge);
        let d = "M" + (g.p0.x+o.x) + " " + (g.p0.y+o.y);
        if (g.isCurve) d += " C" + (g.h1.x+o.x) + " " + (g.h1.y+o.y) + " " + (g.h2.x+o.x) + " " + (g.h2.y+o.y) + " " + (g.p3.x+o.x) + " " + (g.p3.y+o.y);
        else d += " L" + (g.p3.x+o.x) + " " + (g.p3.y+o.y);
        svg.appendChild(svgEl("path", { d: d, fill: "none", stroke: color, "stroke-width": lw, "vector-effect": "non-scaling-stroke" }));
    }
    function handleLine(svg, from, to, o){
        svg.appendChild(svgEl("line", {
            x1: from.x+o.x, y1: from.y+o.y, x2: to.x+o.x, y2: to.y+o.y,
            stroke: "rgba(255,204,0,0.7)", "stroke-width": 1, "vector-effect": "non-scaling-stroke"
        }));
    }
    function previewLine(svg, a, b, o, st){
        svg.appendChild(svgEl("line", {
            x1: a.x+o.x, y1: a.y+o.y, x2: b.x+o.x, y2: b.y+o.y,
            stroke: st.color, "stroke-width": st.width, "stroke-linecap": "round", "stroke-linejoin": "round"
        }));
    }
    function previewRect(svg, a, b, o, st, fill){
        svg.appendChild(svgEl("rect", {
            x: Math.min(a.x,b.x)+o.x, y: Math.min(a.y,b.y)+o.y, width: Math.abs(b.x-a.x), height: Math.abs(b.y-a.y),
            fill: fill || "none", stroke: st.color, "stroke-width": st.width, "stroke-linejoin": "round"
        }));
    }
    function previewEllipse(svg, a, b, o, st, fill){
        svg.appendChild(svgEl("ellipse", {
            cx: (a.x+b.x)/2+o.x, cy: (a.y+b.y)/2+o.y, rx: Math.abs(a.x-b.x)/2, ry: Math.abs(a.y-b.y)/2,
            fill: fill || "none", stroke: st.color, "stroke-width": st.width
        }));
    }
    function previewPolyline(svg, pts, o, st, fill){
        let d = "M" + (pts[0].x+o.x) + " " + (pts[0].y+o.y);
        for (let i=1;i<pts.length;i++) d += " L" + (pts[i].x+o.x) + " " + (pts[i].y+o.y);
        d += " Z"; // close the loop so the freehand preview fills like the committed blob
        svg.appendChild(svgEl("path", { d: d, fill: fill || "none", stroke: st.color, "stroke-width": st.width, "stroke-linecap": "round", "stroke-linejoin": "round" }));
    }

    function previewBlob(svg, pts, o, spec, fill){
        let size = Math.max(spec.size, 1);
        if (spec.shape === "square"){
            let half = size / 2;
            let g = svgEl("g", {});
            let stamp = (x, y)=> g.appendChild(svgEl("rect", { x: x+o.x-half, y: y+o.y-half, width: size, height: size, fill: fill || "#000" }));
            stamp(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++){
                let a = pts[i-1], b = pts[i];
                let d = Math.hypot(b.x-a.x, b.y-a.y);
                let step = Math.max(1, size / 3);
                let steps = Math.max(1, Math.ceil(d / step));
                for (let k = 1; k <= steps; k++){ let t = k / steps; stamp(a.x+(b.x-a.x)*t, a.y+(b.y-a.y)*t); }
            }
            svg.appendChild(g);
            return;
        }
        let d = "M" + (pts[0].x+o.x) + " " + (pts[0].y+o.y);
        for (let i=1;i<pts.length;i++) d += " L" + (pts[i].x+o.x) + " " + (pts[i].y+o.y);
        if (pts.length === 1) d += " L" + (pts[0].x+o.x+0.01) + " " + (pts[0].y+o.y); // a dot needs length
        svg.appendChild(svgEl("path", {
            d: d, fill: "none", stroke: fill || "#000", "stroke-width": size,
            "stroke-linecap": "round", "stroke-linejoin": "round"
        }));
    }
    function dot(svg, p, o, r, color){
        svg.appendChild(svgEl("circle", {
            cx: p.x+o.x, cy: p.y+o.y, r: r,
            fill: color, stroke: "rgba(0,0,40,0.9)", "stroke-width": 1, "vector-effect": "non-scaling-stroke"
        }));
    }

    function square(svg, p, o, r, color){
        svg.appendChild(svgEl("rect", {
            x: p.x+o.x-r, y: p.y+o.y-r, width: r*2, height: r*2,
            fill: color, stroke: "rgba(0,0,40,0.9)", "stroke-width": 1, "vector-effect": "non-scaling-stroke"
        }));
    }


    EventBus.on(EVENT.imageSizeChanged, function(){
        if (!active) return;
        if (layer !== ImageFile.getActiveLayer()) cleanup();
    });

    return me;
}();

export default VectorTool;
