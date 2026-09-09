import EventBus from "../util/eventbus.js";
import { ANIMATION, EVENT } from "../enum.js";
import ImageFile from "../image.js";
import HistoryService from "../services/historyservice.js";
import Palette from "../ui/palette.js";
import Color from "../util/color.js";
import ToolOptions from "../ui/components/toolOptions.js";
import Brush from "../ui/brush.js";
import Input from "../ui/input.js";
import StatusBar from "../ui/statusbar.js";
import Animator from "../util/animator.js";
import { isVector } from "../util/layerUtils.js";
import {
    cloneVector, addNode, addEdge, insertConnectedEdge, nodeOrSplitAt, reResolveEdges,
    splitEdgeAt, deleteEdge, deleteNode, edgeAtPoint, nodeAtPoint, regionAtPoint,
    enclosingCycle, closeGaps, edgeGeometry, edgeNearest, flattenEdge, cubicAt, newRegionId, dist, edgesAtNode,
    getNodeCurveMode, setNodeCurveMode, enforceSmoothNode, splitNodeAt, joinNodes,
    getDisplayMode, regionPathData, traceMaskContours, simplifyLoop, loopAbsArea,
    regionPolygons, regionPolygonBounds, deleteRegionGeometry, strokeChainRing, strokeJointDisc,
    orientedEdgeGeometry, poseVector, edgeHandleOffsets,
    vectorSelectionIds, isEmptyVectorSelection, subsetVector, appendVector,
    newTextId, vectorTextBounds, effectiveFontSize
} from "../util/vectorUtils.js";
import { booleanCombineRings, extractShapeRings } from "../util/vectorBoolean.js";
import {getDefaultFontName, getFontDefinition, loadFont} from "../util/fonts.js";
import SVG from "../fileformats/svg.js";

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
    // handle = {edgeId, which:"h1"|"h2"}. `path` (spec 019): which layer this single-target selection
    // lives on — the active layer by default, or an eligible sibling's path when the last node/edge/
    // region/text pick landed there. Every reader that used to blindly resolve vec() for sel.* now
    // resolves through vecFor(sel.path) instead.
    let sel = { path: null, edgeId: null, nodeId: null, handle: null, regionId: null, textId: null };
    let selectedNodes = new Set();  // node mode multi-selection (marquee / shift-click) ON THE ACTIVE LAYER; moved together
    let selectedEdges = new Set();  // multi-line selection ON THE ACTIVE LAYER; moved & styled together
    let hover = null;               // point/handle under the cursor: {path,kind:"node",nodeId} | {path,kind:"handle",edgeId,which}
    let hoverKind = null;           // full kind under the cursor (node/handle/edge/region/null) — drives the action cursor
    let drag = null;
    let touchedSnapshots = null; // Map<pathKey, clonedVector> — every layer THIS gesture touches
                                  // (one entry for a plain single-layer edit; several for a
                                  // cross-layer move/delete) — for local rollback on cancel/discard
    let historyOpen = false;
    let lastScale = 1;
    let hitCtx = (typeof document !== "undefined") ? document.createElement("canvas").getContext("2d") : null;
    let expandFill = null;   // {regionId, boundarySnap, holeSnaps:[snap], amount} — see "Expand Fill" below


    // ── cross-layer selection (spec 018) ────────────────────────────────────────────────
    // Node/edge ids selected on ELIGIBLE SIBLING layers (same group, visible, unlocked) — the active
    // layer's own selection stays exactly `selectedNodes`/`selectedEdges`/`sel`, unchanged. Keyed by
    // pathKey(path); never includes the active layer's own path. A sibling may have entries in BOTH
    // maps at once (e.g. after Ctrl-A, or a point selected plus a separate line shift-clicked) — every
    // consumer resolves the two into one deduped node-id set (see siblingSelectedNodeIds), so there is
    // no double-application risk and no need to keep them mutually exclusive the way the active
    // layer's own selectedNodes/selectedEdges are.
    let crossSel = new Map();       // pathKey -> Set<nodeId>
    let crossEdgeSel = new Map();   // pathKey -> Set<edgeId>
    function pathKey(path){ return path.join(","); }
    function unpathKey(key){ return key.split(",").map(Number); }
    function clearCrossSelection(){ crossSel.clear(); crossEdgeSel.clear(); }
    // The node ids to translate/transform for one sibling: its own directly-selected nodes, plus the
    // endpoints of its directly-selected edges (so a selected LINE moves as a whole — both endpoints,
    // and via incidentHandleBases below, both its curve handles).
    function siblingSelectedNodeIds(sv, key){
        let nodeSet = new Set(crossSel.get(key) || []);
        let eids = crossEdgeSel.get(key);
        if (eids) eids.forEach(eid=>{ let e = sv.edges[eid]; if (e){ nodeSet.add(e.a); nodeSet.add(e.b); } });
        return Array.from(nodeSet).filter(id=>sv.nodes[id]);
    }

    let clipboard = null;        // a subsetVector document, or null
    let pendingPaste = null;     // { nodeIds:Set, edgeIds:Set } while a paste is uncommitted
    const PASTE_OFFSET = 8;      // px shift so the copy doesn't sit exactly on the original
    let animKey = null;          // the property key being posed, or null (base editing / display)
    let editVec = null;          // resolved working copy while animating; null = edit layer.vector
    let readOnly = false;        // derived frame: display the tween, block geometry edits
    let poseSnapshot;            // node+curve overlay snapshot for gesture cancel
    let textEdit = null;         // { id, existed, original }
    let caretOn = false;
    let noticeTimer = 0;
    let fontOutlineCache = new Map();

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
    function isTextMode(){ return mode === "text"; }
    function scopeOffset(){ return ImageFile.getLayerOffset(); }

    // Locked or hidden layers are excluded from the multi-layer point/line/shape selection — even
    // the ACTIVE layer itself (mirrors the same two conditions eligibleVectorSiblings already applies
    // to siblings). This does not stop you from drawing NEW geometry on a locked/hidden active layer
    // (placement tools don't read scopeLayers()); it only keeps its EXISTING geometry out of
    // select/marquee/Ctrl-A/Free-Transform-scope.
    function activeLayerEligible(){
        return !!layer && layer.visible && !layer.locked;
    }

    // ── unified multi-layer editing scope (spec 019) ────────────────────────────────────
    // Cross-layer editing reaches every ELIGIBLE SIBLING (same group, visible, unlocked) exactly as
    // if its geometry lived on the active layer — hover, node/handle drag, curve editing, edge bend/
    // move, whole-shape select+drag, and text click/drag/type all resolve through whichever layer a
    // hit actually lands on. Base-editing only: while posing (onProperty()), scopeLayers() collapses
    // to just the active layer, so every downstream function here automatically falls back to the
    // pre-019 single-layer behaviour with no extra guard needed at each call site.
    function activeKey(){ return pathKey(ImageFile.getActiveLayerPath()); }
    function isActivePath(path){ return !path || pathKey(path) === activeKey(); }
    function layerFor(path){
        if (!path || isActivePath(path)) return layer;
        return ImageFile.getLayerInTarget(ImageFile.getHistoryTarget(), path);
    }
    // Resolves a path to its vector document. The active layer stays pose-aware (vec(), which may be
    // a posed working copy); a sibling is always its plain base .vector (cross-layer editing never
    // touches pose/property-key overlays).
    function vecFor(path){
        if (!path || isActivePath(path)) return vec();
        let l = layerFor(path);
        return l && l.vector;
    }
    // Every layer participating in the current hit-test/gesture: the active layer first, then every
    // eligible sibling, each resolved fresh against the current history target.
    function scopeLayers(){
        let out = activeLayerEligible() ? [{ path: ImageFile.getActiveLayerPath(), layer: layer, v: vec() }] : [];
        if (!onProperty()) ImageFile.getEligibleVectorSiblings().forEach(s=>{
            let l = ImageFile.getLayerInTarget(ImageFile.getHistoryTarget(), s.path);
            if (l && l.vector) out.push({ path: s.path, layer: l, v: l.vector });
        });
        return out;
    }
    function docToGeoAt(path, p){
        let o = ImageFile.getLayerOffset(path);
        let g = { x: p.x - o.x, y: p.y - o.y };
        let v = vecFor(path);
        // Only pixel-art ("sharp") mode snaps nodes to the grid; smooth/vector stay fractional.
        if (v && getDisplayMode(v) === "sharp"){ g.x = Math.round(g.x); g.y = Math.round(g.y); }
        return g;
    }
    function docToGeo(p){ return docToGeoAt(ImageFile.getActiveLayerPath(), p); }

    function currentStroke(){
        return {
            color: Color.toHex(Palette.getDrawColor()),
            width: (ToolOptions.getLineSize && ToolOptions.getLineSize()) || 1,
            smooth: !!(ToolOptions.isSmooth && ToolOptions.isSmooth())
        };
    }
    function currentFillColor(){ return Color.toHex(Palette.getDrawColor()); }
    function wantsFill(){ return !!(ToolOptions.isFill && ToolOptions.isFill()); }
    function selectedText(v){
        v = v || vecFor(sel.path);
        return (v && sel.textId && v.texts && v.texts[sel.textId]) ? v.texts[sel.textId] : null;
    }
    function clearTextUi(){
        Input.setActiveKeyHandler(null);
        Animator.stop(ANIMATION.TEXT);
        textEdit = null;
        caretOn = false;
    }
    function textEquals(a, b){
        if (!a || !b) return false;
        return a.x === b.x && a.y === b.y && (a.text || "") === (b.text || "")
            && (a.font || "") === (b.font || "") && (+a.fontSize || 0) === (+b.fontSize || 0)
            && (a.fill || null) === (b.fill || null)
            && (a.strokeColor || null) === (b.strokeColor || null)
            && (+a.strokeWidth || 0) === (+b.strokeWidth || 0)
            && (a.align || "left") === (b.align || "left");
    }
    function showTextNotice(text){
        StatusBar.setToolTip(text);
        clearTimeout(noticeTimer);
        noticeTimer = setTimeout(()=>StatusBar.setToolTip(""), 2600);
    }
    function defaultTextObject(x, y){
        return {
            id: newTextId(vec()),
            x: x,
            y: y,
            text: "",
            font: ToolOptions.getFont ? (ToolOptions.getFont() || getDefaultFontName()) : getDefaultFontName(),
            fontSize: ToolOptions.getFontSize ? (+ToolOptions.getFontSize() || 32) : 32,
            fill: currentFillColor(),
            strokeColor: null,
            strokeWidth: 0,
            align: "left"
        };
    }
    // `path` (spec 019): which layer this text object lives on — the active layer, or an eligible
    // sibling. Every mutation below writes into vecFor(textEdit.path), and changed() is targeted at
    // that layer, so typing into a sibling's text object works exactly like typing into the active
    // layer's.
    function beginTextEdit(path, id, existed){
        let v = vecFor(path);
        if (!v || !v.texts || !v.texts[id]) return;
        let text = v.texts[id];
        if (!historyOpen) beginHistory(isActivePath(path) ? null : [path]);
        textEdit = {
            path: path,
            id: id,
            existed: !!existed,
            original: existed ? JSON.parse(JSON.stringify(text)) : null,
            caretIndex: (text.text || "").length
        };
        sel = { path: path, edgeId: null, nodeId: null, handle: null, regionId: null, textId: id };
        selectedNodes.clear();
        clearCrossSelection();
        selectedEdges.clear();
        caretOn = true;
        loadFont(text.font).then(()=>changedFor(path));
        Input.setActiveKeyHandler((code, key, rawKey)=>{
            let activeText = selectedText();
            if (!activeText) return false;
            let value = activeText.text || "";
            let caret = Math.max(0, Math.min(value.length, textEdit.caretIndex));
            switch (code){
                case "enter":
                case "escape":
                    finishTextEdit(true);
                    return true;
                case "backspace":
                    if (caret > 0){
                        activeText.text = value.slice(0, caret - 1) + value.slice(caret);
                        textEdit.caretIndex = caret - 1;
                        caretOn = true;
                        changedFor(textEdit.path);
                    }
                    return true;
                case "delete":
                    if (caret < value.length){
                        activeText.text = value.slice(0, caret) + value.slice(caret + 1);
                        changedFor(textEdit.path);
                    }
                    return true;
                case "arrowleft":
                    textEdit.caretIndex = Math.max(0, caret - 1);
                    caretOn = true;
                    EventBus.trigger(EVENT.vectorChanged);
                    return true;
                case "arrowright":
                    textEdit.caretIndex = Math.min(value.length, caret + 1);
                    caretOn = true;
                    EventBus.trigger(EVENT.vectorChanged);
                    return true;
                case "home":
                    textEdit.caretIndex = 0;
                    caretOn = true;
                    EventBus.trigger(EVENT.vectorChanged);
                    return true;
                case "end":
                    textEdit.caretIndex = value.length;
                    caretOn = true;
                    EventBus.trigger(EVENT.vectorChanged);
                    return true;
                default:
                    if (key.length > 1) return false;
                    // rawKey preserves the actual Shift/CapsLock-resolved character (e.g. Shift+C ->
                    // "C") — `key` has already been lowercased by input.js for the tool-shortcut
                    // switches, which don't care about case.
                    let char = rawKey;
                    activeText.text = value.slice(0, caret) + char + value.slice(caret);
                    textEdit.caretIndex = caret + 1;
                    caretOn = true;
                    changedFor(textEdit.path);
                    return true;
            }
        });
        Animator.start(ANIMATION.TEXT, ()=>{
            caretOn = !caretOn;
            EventBus.trigger(EVENT.vectorChanged);
        }, 2);
        EventBus.trigger(EVENT.vectorChanged);
    }
    function finishTextEdit(keep){
        let edit = textEdit;
        let path = edit ? edit.path : null;
        let v = edit ? vecFor(edit.path) : null;
        let text = edit ? (v && v.texts ? v.texts[edit.id] : null) : null;
        clearTextUi();
        if (!edit) return;
        let changedText = false;
        if (text && !text.text) delete v.texts[edit.id];
        text = edit ? (v && v.texts ? v.texts[edit.id] : null) : null;
        if (edit.existed){
            changedText = !text || !textEquals(text, edit.original);
        } else {
            changedText = !!text;
        }
        if (text){
            sel = { path: path, edgeId: null, nodeId: null, handle: null, regionId: null, textId: text.id };
            loadFont(text.font).then(()=>changedFor(path));
        }else{
            sel = { path: null, edgeId: null, nodeId: null, handle: null, regionId: null, textId: null };
        }
        selectedNodes.clear();
        clearCrossSelection();
        selectedEdges.clear();
        if (historyOpen){
            endGesture(keep && changedText);
            if (keep || changedText) changedFor(path);
            else EventBus.trigger(EVENT.vectorChanged);
        }else{
            EventBus.trigger(EVENT.vectorChanged);
        }
    }
    function textAtPoint(v, gp, tol){
        if (!v || !gp) return null;
        let ids = Object.keys(v.texts || {});
        for (let i = ids.length - 1; i >= 0; i--){
            let text = v.texts[ids[i]];
            let box = vectorTextBounds(text, tol);
            if (gp.x >= box.x && gp.x <= box.x + box.width && gp.y >= box.y && gp.y <= box.y + box.height){
                return text.id;
            }
        }
        return null;
    }

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

    // ── cross-layer helpers (spec 018/019) ───────────────────────────────────────────────
    // One drag group per touched layer for a cross-layer node drag ("nodesMulti"): the active layer
    // (same orig/origH the single-layer "nodes" drag already computes) plus one entry per sibling with
    // ANY cross-layer selection (points and/or lines — siblingSelectedNodeIds resolves both into one
    // node-id set), resolved fresh against the current history target.
    function buildNodeDragGroups(v, nodeIds){
        let activeGroup = { path: ImageFile.getActiveLayerPath(), v: v, nodeIds: nodeIds.slice(), orig: {} };
        activeGroup.nodeIds.forEach(id=>{ let n = v.nodes[id]; if (n) activeGroup.orig[id] = { x: n.x, y: n.y }; });
        activeGroup.origH = incidentHandleBases(v, activeGroup.nodeIds);
        let groups = [activeGroup];
        let siblingKeys = new Set([...crossSel.keys(), ...crossEdgeSel.keys()]);
        if (siblingKeys.size){
            let target = ImageFile.getHistoryTarget();
            siblingKeys.forEach(key=>{
                let path = unpathKey(key);
                let l = ImageFile.getLayerInTarget(target, path);
                let sv = l && l.vector;
                if (!sv) return;
                let list = siblingSelectedNodeIds(sv, key);
                if (!list.length) return;
                let orig = {};
                list.forEach(id=>{ let n = sv.nodes[id]; if (n) orig[id] = { x: n.x, y: n.y }; });
                groups.push({ path: path, v: sv, nodeIds: list, orig: orig, origH: incidentHandleBases(sv, list) });
            });
        }
        return groups;
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
    // `targetLayer` (spec 019): the layer object actually edited, when it's a SIBLING rather than the
    // active layer — pass via changedFor(path) below. Defaults to the active layer, so every existing
    // call site (which never passes an argument) is unchanged.
    function changed(targetLayer){
        let l = targetLayer || layer;
        if (l){
            // On a property key a geometry change is a node MOVE — push the displaced points into
            // the key's overlay first, so the compositor (which reads base + overlay) repaints the
            // posed shape rather than the untouched base. Pose overlays only ever apply to the
            // active layer — a sibling edit is always base-editing (scopeLayers() guarantees this).
            if (l === layer && onProperty()) syncPoseToOverlay();
            l.vectorDirty = true;
            l.vectorRasterized = false;
            if (l.markVectorDirty) l.markVectorDirty();
        }
        EventBus.trigger(EVENT.vectorChanged);
    }
    // changed(), resolved from a PATH instead of a layer object — the common case for a single-target
    // gesture (handle/edge/region/text) that may be editing a sibling.
    function changedFor(path){ changed(isActivePath(path) ? undefined : layerFor(path)); }
    // Same raster-cache-stale flagging as changed(), for a layer OTHER than the active one (spec 018
    // cross-layer move/delete touches several layers per gesture; the caller triggers vectorChanged
    // once itself after marking every touched layer).
    function markLayerDirty(l){
        if (!l) return;
        l.vectorDirty = true;
        l.vectorRasterized = false;
        if (l.markVectorDirty) l.markVectorDirty();
    }

    me.isActive = function(){ return active; };
    me.getMode = function(){ return mode; };
    me.getSelection = function(){ return sel; };

    me.setMode = function(m){
        stopExpandFill(true);   // switching vector sub-tool applies any pending Expand Fill
        if (m === mode) return;
        if (textEdit) finishTextEdit(true);
        commitPendingPaste(); // switching sub-tool finalises a floating paste (spec 014)
        mode = m;
        drag = null;
        selectedNodes.clear();
        clearCrossSelection();
        selectedEdges.clear();
        EventBus.trigger(EVENT.vectorChanged);
    };
    me.getSelectedNodes = function(){ return Array.from(selectedNodes); };
    // Spec 018: sibling-layer node selection, as [{path, nodeIds}] — for the overlay renderer / any
    // future UI that wants a cross-layer selection count. The active layer's own selection stays
    // exactly what me.getSelection()/me.getSelectedNodes() already return.
    me.getCrossLayerSelection = function(){
        return Array.from(crossSel, ([key, ids])=>({ path: unpathKey(key), nodeIds: Array.from(ids) }));
    };
    // Spec 018 extension: sibling-layer LINE (edge) selection, as [{path, edgeIds}] — built by
    // shift-clicking a line on an eligible sibling. Mirrors getCrossLayerSelection for points.
    me.getCrossLayerEdgeSelection = function(){
        return Array.from(crossEdgeSel, ([key, ids])=>({ path: unpathKey(key), edgeIds: Array.from(ids) }));
    };

    // Spec 018 extension: the current selection's scope for Free Transform (V), possibly spanning
    // several layers — {bounds: DOCUMENT-space {x,y,width,height}, groups: [{path, nodeIds}]}, or null
    // when nothing is selected (the caller then falls back to the whole-document transform). Base
    // editing only (no pose/property-key support, matching the rest of cross-layer selection).
    // `nodeIds` per group already folds in the endpoints of any selected line and a selected shape's
    // boundary/hole nodes, so editor.js only ever has to move plain points.
    me.getFreeTransformScope = function(){
        if (!active) return null;
        syncEditContext();
        if (readOnly || onProperty()) return null;
        let v = vec();
        if (!v) return null;

        let activeSet = new Set(selectedNodes);
        if (sel.nodeId && v.nodes[sel.nodeId]) activeSet.add(sel.nodeId);
        let activeEdgeIds = new Set(Array.from(selectedEdges).filter(id=>v.edges[id]));
        if (sel.edgeId && v.edges[sel.edgeId]) activeEdgeIds.add(sel.edgeId);
        if (sel.regionId && v.regions[sel.regionId]) regionEdgeIds(v.regions[sel.regionId]).forEach(id=>{ if (v.edges[id]) activeEdgeIds.add(id); });
        activeEdgeIds.forEach(eid=>{ let e = v.edges[eid]; if (e){ activeSet.add(e.a); activeSet.add(e.b); } });
        let activeIds = Array.from(activeSet).filter(id=>v.nodes[id]);

        let groups = [];
        if (activeIds.length) groups.push({ path: ImageFile.getActiveLayerPath(), nodeIds: activeIds });

        let target = ImageFile.getHistoryTarget();
        let siblingKeys = new Set([...crossSel.keys(), ...crossEdgeSel.keys()]);
        // A sibling-selected whole shape (region) has no cross-layer secondary map of its own — fold
        // its boundary/hole nodes in here too, so Free Transform can wrap it even with nothing else
        // cross-selected (spec 019).
        if (sel.path && !isActivePath(sel.path) && sel.regionId) siblingKeys.add(pathKey(sel.path));
        siblingKeys.forEach(key=>{
            let l = ImageFile.getLayerInTarget(target, unpathKey(key));
            let sv = l && l.vector;
            if (!sv) return;
            let idSet = new Set(siblingSelectedNodeIds(sv, key));
            if (sel.path && pathKey(sel.path) === key && sel.regionId && sv.regions[sel.regionId]){
                regionEdgeIds(sv.regions[sel.regionId]).forEach(eid=>{ let e = sv.edges[eid]; if (e){ idSet.add(e.a); idSet.add(e.b); } });
            }
            let ids = Array.from(idSet).filter(id=>sv.nodes[id]);
            if (ids.length) groups.push({ path: unpathKey(key), nodeIds: ids });
        });

        if (!groups.length) return null;

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        groups.forEach(g=>{
            let off = ImageFile.getLayerOffset(g.path);
            let l = ImageFile.getLayerInTarget(target, g.path);
            let gv = l && l.vector;
            if (!gv) return;
            g.nodeIds.forEach(id=>{
                let n = gv.nodes[id];
                if (!n) return;
                let dx = n.x + off.x, dy = n.y + off.y;
                if (dx < minX) minX = dx; if (dy < minY) minY = dy;
                if (dx > maxX) maxX = dx; if (dy > maxY) maxY = dy;
            });
        });
        if (!isFinite(minX)) return null;
        return { bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY }, groups: groups };
    };

    // Select every point and line of the layer (Cmd/Ctrl-A on a vector layer). Selection-only, so no
    // history — just repaint the overlay. Switches to the select sub-tool if a draw mode is active so
    // the selected points are visible and grabbable. Returns true when there was geometry to select,
    // so the caller (input.js) can skip the raster select-all.
    me.selectAll = function(){
        if (!active) return false;
        commitPendingPaste();               // finalise any floating paste before re-selecting
        let v = vec();
        if (!v) return false;
        // A locked/hidden active layer contributes nothing of its own (mirrors the eligible-sibling
        // filter below) — but Ctrl-A can still pick up an eligible sibling's geometry.
        let eligible = activeLayerEligible();
        let nodeIds = eligible ? Object.keys(v.nodes) : [];
        let edgeIds = eligible ? Object.keys(v.edges) : [];
        if (!isEditMode()) me.setMode("select"); // points must be visible + directly grabbable (setMode doesn't touch vec())
        sel = { path: ImageFile.getActiveLayerPath(), edgeId: null, nodeId: null, handle: null, regionId: null, textId: null };
        selectedNodes = new Set(nodeIds);
        selectedEdges = new Set(edgeIds);
        clearCrossSelection();
        // spec 018: also select every point AND line on every eligible sibling layer — base-editing
        // only. Mirrors the active layer's own selectAll, which populates selectedNodes AND
        // selectedEdges together (used for bulk restyling as well as bulk move/delete).
        let anySibling = false;
        if (!onProperty()) ImageFile.getEligibleVectorSiblings().forEach(s=>{
            let l = ImageFile.getLayerInTarget(ImageFile.getHistoryTarget(), s.path);
            let sv = l && l.vector;
            if (!sv) return;
            let ids = Object.keys(sv.nodes);
            if (ids.length){ crossSel.set(pathKey(s.path), new Set(ids)); anySibling = true; }
            let eids = Object.keys(sv.edges);
            if (eids.length){ crossEdgeSel.set(pathKey(s.path), new Set(eids)); anySibling = true; }
        });
        if (!nodeIds.length && !edgeIds.length && !anySibling) return false;
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
    me.hasClipboard = function(){
        return !!(clipboard && (
            Object.keys(clipboard.nodes || {}).length ||
            Object.keys(clipboard.edges || {}).length ||
            Object.keys(clipboard.regions || {}).length ||
            Object.keys(clipboard.texts || {}).length
        ));
    };

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
        let textIds = new Set(Object.values(maps.textMap || {}));
        pendingPaste = { nodeIds: nodeIds, edgeIds: new Set(Object.values(maps.edgeMap)), textIds: textIds };
        // select just the pasted points so the copy can be moved straight away
        sel = { path: ImageFile.getActiveLayerPath(), edgeId: null, nodeId: null, handle: null, regionId: null, textId: textIds.size ? textIds.values().next().value : null };
        selectedNodes.clear(); nodeIds.forEach(id=>selectedNodes.add(id));
        clearCrossSelection();
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
        expandFill = null;   // a genuine layer switch always leaves any pending Expand Fill behind
        layer = l;
        active = true;
        sel = { path: null, edgeId: null, nodeId: null, handle: null, regionId: null, textId: null };
        selectedNodes.clear();
        clearCrossSelection();
        selectedEdges.clear();
        drag = null;
        EventBus.trigger(EVENT.vectorChanged);
        return true;
    };

    me.commit = function(){
        if (!active) return;
        stopExpandFill(true);   // Enter / leaving vector mode applies any pending Expand Fill
        if (textEdit) finishTextEdit(true);
        commitPendingPaste(); // Enter / leaving vector mode welds a floating paste (spec 014)
        endGesture(true);
        cleanup();
    };

    me.cancel = function(){
        if (!active) return;
        stopExpandFill(false);   // Esc cancels any pending Expand Fill (restores the original shape)
        clearTextUi();
        if (historyOpen){
            restoreSnapshots();
            if (poseSnapshot && ImageFile.restoreVectorOverlayState) ImageFile.restoreVectorOverlayState(poseSnapshot);
            HistoryService.neverMind();
            historyOpen = false;
            touchedSnapshots = null;
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
        clearTextUi();
        active = false;
        layer = undefined;
        drag = null;
        hover = null;
        hoverKind = null;
        touchedSnapshots = null;
        clearCrossSelection();
        EventBus.trigger(EVENT.vectorChanged);
    }

    // ── history bracketing (one undo step per gesture) ─────────────────────────────────
    // `refs` (spec 018/019): the FULL list of layer paths this gesture touches. Omitted (the common
    // case) defaults to just the active layer, so every pre-existing call site (line/rect/blob/text/
    // handle/edge/region/nodes — none of which pass anything) is unchanged: a plain EVENT.vectorHistory
    // against the active layer path. A gesture whose ONLY target is a sibling (dragging a sibling's
    // curve handle, say) passes [siblingPath] with no active path at all; one spanning several layers
    // (a cross-layer node/line move or delete) passes the full set — one vectorGroupHistory step.
    function beginHistory(refs){
        if (historyOpen) return;
        refs = (refs && refs.length) ? refs : [ImageFile.getActiveLayerPath()];
        let target = ImageFile.getHistoryTarget();
        touchedSnapshots = new Map();
        refs.forEach(ref=>{
            let l = ImageFile.getLayerInTarget(target, ref);
            if (l && l.vector) touchedSnapshots.set(pathKey(ref), cloneVector(l.vector));
        });
        // On a property key the edit changes the node overlay, not the base geometry — snapshot the
        // overlay too so a cancelled/rolled-back gesture restores it locally (neverMind path below).
        // Pose overlays only ever apply to the active layer, and only when the gesture targets it
        // alone (cross-layer editing is base-editing only — scopeLayers() already guarantees a
        // sibling is never reachable while posing).
        poseSnapshot = (onProperty() && refs.length === 1 && isActivePath(refs[0]) && ImageFile.cloneVectorOverlayState)
            ? ImageFile.cloneVectorOverlayState(layer) : undefined;
        // spec 015: a vector gesture only touches one layer's geometry (+ its pose overlays), so the
        // KEPT step captures just that — not the whole document like the old imageHistory bracket did.
        // spec 018: a gesture spanning several layers records ONE vectorGroupHistory step instead.
        if (refs.length > 1){
            HistoryService.start(EVENT.vectorGroupHistory, refs);
        } else {
            HistoryService.start(EVENT.vectorHistory, refs[0]);
        }
        historyOpen = true;
    }
    // Roll every layer this gesture touched back to its pre-gesture geometry (cancel / discard).
    function restoreSnapshots(){
        if (!touchedSnapshots) return;
        let target = ImageFile.getHistoryTarget();
        touchedSnapshots.forEach((clone, key)=>{
            let l = ImageFile.getLayerInTarget(target, unpathKey(key));
            if (l){
                l.vector = cloneVector(clone);
                l.vectorDirty = true;
                l.vectorRasterized = false;
                if (l.markVectorDirty) l.markVectorDirty();
            }
        });
    }
    function endGesture(keep){
        if (!historyOpen) return;
        if (keep) HistoryService.end();
        else {
            restoreSnapshots();
            if (poseSnapshot && ImageFile.restoreVectorOverlayState) ImageFile.restoreVectorOverlayState(poseSnapshot);
            HistoryService.neverMind();
            editVec = null; // rebuild the working copy from the restored overlay on the next entry
        }
        historyOpen = false;
        touchedSnapshots = null;
        poseSnapshot = undefined;
    }

    // Bezier tangent handles that are currently editable (node mode only): both handles of a
    // selected edge, plus — for each selected node — the near handle of every curved edge that
    // meets at that node, so grabbing a node reveals and lets you refine its curves. Deduped by
    // edge+side. Each entry: { edgeId, which:"h1"|"h2", p, anchor } in GEOMETRY coords.
    // The multi-select node ids that apply to layer `L` for handle/overlay purposes: the active
    // layer's own selectedNodes, or a sibling's crossSel entry (spec 018).
    function nodeSetForLayer(L){
        return isActivePath(L.path) ? selectedNodes : (crossSel.get(pathKey(L.path)) || new Set());
    }
    // Handles for ONE layer (spec 019: activeHandles() below scans every scope layer this way). Each
    // entry additionally carries `path` so the caller (me.pick / drawOverlay) knows which layer's
    // offset/document it belongs to.
    function activeHandlesFor(L){
        let v = L.v;
        if (!v) return [];
        let out = [], seen = {};
        let onThisLayer = sel.path && pathKey(sel.path) === pathKey(L.path);
        function add(edgeId, which){
            let e = v.edges[edgeId];
            if (!e || !e.curve) return;
            let k = edgeId + which;
            if (seen[k]) return;
            seen[k] = 1;
            out.push({
                path: L.path, edgeId: edgeId, which: which,
                p: which === "h1" ? e.curve.h1 : e.curve.h2,
                anchor: which === "h1" ? v.nodes[e.a] : v.nodes[e.b]
            });
        }
        if (onThisLayer && sel.edgeId && v.edges[sel.edgeId] && v.edges[sel.edgeId].curve){
            add(sel.edgeId, "h1");
            add(sel.edgeId, "h2");
        }
        let nodeIds = new Set(nodeSetForLayer(L));
        if (onThisLayer && sel.nodeId) nodeIds.add(sel.nodeId);
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
    // Bezier tangent handles across EVERY eligible layer (spec 019) — both handles of a selected edge,
    // plus the near handle of every curved edge meeting a selected node, on whichever layer(s) currently
    // have a selection. A derived (in-between) frame is display-only — no handles to grab. On a
    // property key, handles ARE shown on the active layer (bezier shaping is animatable there, spec
    // 012) — scopeLayers() already excludes siblings in that case.
    function activeHandles(){
        if (!isEditMode() || readOnly) return [];
        let out = [];
        scopeLayers().forEach(L=> out.push.apply(out, activeHandlesFor(L)));
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
    // Precedence: active bezier handles → nodes → edge interiors → text → region fill. Scans EVERY
    // eligible layer (spec 019) within each kind, active layer first — so a handle/node/edge/text/
    // region on the active layer always wins a tie against the same kind on a sibling, but a sibling
    // hit of a HIGHER-precedence kind (e.g. its node) still beats a lower-precedence active-layer hit
    // (e.g. the active layer's region fill), matching the original single-layer precedence exactly.
    // `point` is DOCUMENT coords (each layer's own offset is resolved internally). Returns
    // {path, kind:"handle"|"node"|"edge"|"text"|"region", ...} in that layer's GEOMETRY coords, or null.
    me.pick = function(point, tol){
        let layers = scopeLayers();
        if (isEditMode()){
            for (let L of layers){
                if (!L.v) continue;
                let gp = docToGeoAt(L.path, point);
                for (let h of activeHandlesFor(L)){
                    if (h.p && dist(gp.x, gp.y, h.p.x, h.p.y) <= tol) return { path: L.path, kind: "handle", edgeId: h.edgeId, which: h.which };
                }
            }
        }
        // nodes take priority and get a roomier hit radius, so points are easy to grab
        let nodeTol = isEditMode() ? tol * 1.8 : tol;
        for (let L of layers){
            if (!L.v) continue;
            let gp = docToGeoAt(L.path, point);
            let n = nodeAtPoint(L.v, gp.x, gp.y, nodeTol);
            if (n) return { path: L.path, kind: "node", nodeId: n };
        }
        for (let L of layers){
            if (!L.v) continue;
            let gp = docToGeoAt(L.path, point);
            let e = edgeAtPoint(L.v, gp.x, gp.y, tol);
            if (e) return { path: L.path, kind: "edge", edgeId: e.edgeId, t: e.t };
        }
        for (let L of layers){
            if (!L.v) continue;
            let gp = docToGeoAt(L.path, point);
            let textId = textAtPoint(L.v, gp, tol);
            if (textId) return { path: L.path, kind: "text", textId: textId };
        }
        // a click on a shape's fill (interior, away from any edge/point) picks the whole region
        if (isEditMode() && hitCtx){
            for (let L of layers){
                if (!L.v) continue;
                let gp = docToGeoAt(L.path, point);
                let r = regionAtPoint(L.v, hitCtx, gp.x, gp.y);
                if (r) return { path: L.path, kind: "region", regionId: r };
            }
        }
        return null;
    };

    me.handleDown = function(point, tolerance, opts){
        if (!active) return;
        stopExpandFill(true);   // starting a new canvas gesture applies any pending Expand Fill
        if (textEdit) finishTextEdit(true);
        syncEditContext();
        let v = vec();
        if (!v) return;
        // A derived (in-between) frame shows the tween read-only — geometry editing happens on a
        // keyframe (spec 012). Ignore the press so nothing is mutated on a non-key frame.
        if (readOnly) { drag = null; return; }
        // Cross-layer selection (spec 018/019) is base-editing only — a property/pose key never
        // populates it, but drop any leftover from before the playhead moved onto one.
        if (onProperty() && (crossSel.size || crossEdgeSel.size)) clearCrossSelection();
        let gp = docToGeo(point);
        let tol = tolerance || HANDLE;
        let shift = !!(opts && opts.shift);
        // path/v/layer default to the active layer — every draw sub-mode (line/rect/circle/blob/
        // fill/outline/new text) stays scoped there; the unified hit-testing block below overrides
        // these per gesture when a hit resolves to an eligible sibling instead (spec 019).
        drag = { downGeo: gp, curGeo: gp, downDoc: point, curDoc: point, tol: tol, moved: false,
                 path: ImageFile.getActiveLayerPath(), v: v, layer: layer };

        // On a property key only point translation is a pose — the draw sub-modes (which add new
        // geometry to the base drawing) are disabled; draw them on the shape's content keyframe.
        if (poseEditing() && !isEditMode()) { drag = null; return; }

        // A pending floating paste (spec 014) commits the moment you act anywhere that isn't the
        // pasted geometry itself — an empty click, another point, or a draw mode. Pressing one of the
        // pasted points keeps it floating so you can keep repositioning the copy.
        if (pendingPaste){
            let hitId = isEditMode() ? nodeAtPoint(v, gp.x, gp.y, tol * 1.8) : null;
            let textId = textAtPoint(v, gp, tol);
            let keepPaste = (hitId && pendingPaste.nodeIds.has(hitId)) || (textId && pendingPaste.textIds && pendingPaste.textIds.has(textId));
            if (!keepPaste){ commitPendingPaste(); v = vec(); drag.v = v; }
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
        if (mode === "text"){
            if (poseEditing()) { drag = null; return; }
            // An EXISTING text object is reachable on any eligible layer (spec 019); a NEW one is
            // always created on the active layer — that's simply "where you're drawing".
            let textHit = null;
            for (let L of scopeLayers()){
                if (!L.v) continue;
                let lgp = docToGeoAt(L.path, point);
                let tid = textAtPoint(L.v, lgp, tol);
                if (tid){ textHit = { path: L.path, textId: tid }; break; }
            }
            if (textHit){
                let hitV = vecFor(textHit.path), hitLayer = layerFor(textHit.path);
                beginHistory(isActivePath(textHit.path) ? null : [textHit.path]);
                sel = { path: textHit.path, edgeId: null, nodeId: null, handle: null, regionId: null, textId: textHit.textId };
                selectedNodes.clear();
                clearCrossSelection();
                selectedEdges.clear();
                drag.kind = "text"; drag.path = textHit.path; drag.v = hitV; drag.layer = hitLayer;
                drag.textId = textHit.textId;
                drag.creating = false;
                drag.orig = { x: hitV.texts[textHit.textId].x, y: hitV.texts[textHit.textId].y };
                EventBus.trigger(EVENT.vectorChanged);
                return;
            }
            beginHistory();
            let text = defaultTextObject(gp.x, gp.y);
            v.texts[text.id] = text;
            sel = { path: ImageFile.getActiveLayerPath(), edgeId: null, nodeId: null, handle: null, regionId: null, textId: text.id };
            drag.kind = "text";
            drag.textId = text.id;
            drag.creating = true;
            drag.orig = { x: gp.x, y: gp.y };
            selectedNodes.clear();
            clearCrossSelection();
            selectedEdges.clear();
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
        // individual points/edges. me.pick scans every eligible layer (spec 019), so all of this
        // works identically on a sibling layer's geometry.
        let hit = me.pick(point, tol);

        if (hit && hit.kind === "text"){
            let hitV = vecFor(hit.path), hitLayer = layerFor(hit.path);
            if (isActivePath(hit.path) && poseEditing()){
                sel = { path: hit.path, edgeId: null, nodeId: null, handle: null, regionId: null, textId: hit.textId };
                selectedNodes.clear();
                clearCrossSelection();
                selectedEdges.clear();
                drag = null;
                EventBus.trigger(EVENT.vectorChanged);
                return;
            }
            beginHistory(isActivePath(hit.path) ? null : [hit.path]);
            sel = { path: hit.path, edgeId: null, nodeId: null, handle: null, regionId: null, textId: hit.textId };
            selectedNodes.clear();
            clearCrossSelection();
            selectedEdges.clear();
            drag.kind = "text"; drag.path = hit.path; drag.v = hitV; drag.layer = hitLayer;
            drag.textId = hit.textId;
            drag.creating = false;
            drag.orig = { x: hitV.texts[hit.textId].x, y: hitV.texts[hit.textId].y };
            EventBus.trigger(EVENT.vectorChanged);
            return;
        }

        if (hit && hit.kind === "handle"){
            let hitV = vecFor(hit.path), hitLayer = layerFor(hit.path);
            beginHistory(isActivePath(hit.path) ? null : [hit.path]);
            drag.kind = "handle"; drag.path = hit.path; drag.v = hitV; drag.layer = hitLayer;
            drag.edgeId = hit.edgeId; drag.which = hit.which;
            drag.snapping = false; drag.snapNodeId = null;
            EventBus.trigger(EVENT.vectorChanged);
            return;
        }

        if (hit && hit.kind === "node"){
            let onActive = isActivePath(hit.path);
            let key = pathKey(hit.path);
            if (shift){
                // toggle this point's membership in the selection; no move gesture
                if (onActive){
                    if (selectedNodes.has(hit.nodeId)) selectedNodes.delete(hit.nodeId);
                    else selectedNodes.add(hit.nodeId);
                    selectedEdges.clear(); // node selection and multi-line selection are mutually exclusive
                } else {
                    let set = crossSel.get(key);
                    if (!set){ set = new Set(); crossSel.set(key, set); }
                    if (set.has(hit.nodeId)) set.delete(hit.nodeId); else set.add(hit.nodeId);
                    if (!set.size) crossSel.delete(key);
                }
                drag = null;
                EventBus.trigger(EVENT.vectorChanged);
                return;
            }
            // clicking a point already part of the current (possibly cross-layer) selection keeps
            // the WHOLE set, so it moves together; clicking one outside it re-selects just this one
            // (dropping any other selection, spec 018 R2 — now symmetric for a sibling's point too).
            let already = onActive ? selectedNodes.has(hit.nodeId) : !!(crossSel.get(key) && crossSel.get(key).has(hit.nodeId));
            if (!already){
                selectedNodes.clear();
                clearCrossSelection();
                if (onActive) selectedNodes.add(hit.nodeId);
                else crossSel.set(key, new Set([hit.nodeId]));
            }
            selectedEdges.clear();
            sel = { path: hit.path, edgeId: null, nodeId: hit.nodeId, handle: null,
                    regionId: onActive ? sel.regionId : null, textId: null }; // keep shape context only on the same layer
            if (crossSel.size || crossEdgeSel.size){
                let refs = [ImageFile.getActiveLayerPath()];
                new Set([...crossSel.keys(), ...crossEdgeSel.keys()]).forEach(k=> refs.push(unpathKey(k)));
                beginHistory(refs);
                drag.kind = "nodesMulti";
                drag.clickedNode = hit.nodeId;
                drag.clickedPath = hit.path;
                drag.groups = buildNodeDragGroups(v, Array.from(selectedNodes));
            } else {
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
            let onActive = isActivePath(hit.path);
            let hitV = vecFor(hit.path), hitLayer = layerFor(hit.path);
            // click → select the line; ctrl-click → insert a point; shift-click → add/remove the line
            // from the multi-line selection; drag → bend into a curve (all decided in handleUp /
            // handleMove) — on whichever eligible layer the line lives on (spec 019). Keep the shape
            // context if this edge is part of it and we're staying on the same layer.
            // ctrl-insert (a topology edit) is a base-drawing operation — disabled on a property key
            // (only ever relevant on the active layer: scopeLayers() excludes siblings while posing).
            let ctrl = (onActive && poseEditing()) ? false : !!(opts && opts.ctrl);
            if (shift){
                // toggle this line's membership in the multi-line selection; no drag / bend / history.
                // A multi-line selection is a pure line selection, so drop any node/shape context ON
                // THAT LAYER (an active-layer multi-line selection and a sibling one are independent).
                if (onActive){
                    selectedNodes.clear();
                    if (selectedEdges.has(hit.edgeId)) selectedEdges.delete(hit.edgeId);
                    else selectedEdges.add(hit.edgeId);
                    sel = { path: hit.path,
                            edgeId: (selectedEdges.has(hit.edgeId) ? hit.edgeId : (selectedEdges.size ? selectedEdges.values().next().value : null)),
                            nodeId: null, handle: null, regionId: null, textId: null };
                } else {
                    let key = pathKey(hit.path);
                    let set = crossEdgeSel.get(key);
                    if (!set){ set = new Set(); crossEdgeSel.set(key, set); }
                    if (set.has(hit.edgeId)) set.delete(hit.edgeId); else set.add(hit.edgeId);
                    if (!set.size) crossEdgeSel.delete(key);
                }
                drag = null;
                EventBus.trigger(EVENT.vectorChanged);
                return;
            }
            // plain click: replace the whole selection with just this line, then start a drag — a free
            // drag bends the segment into a curve, alt/right-drag translates it rigidly, exactly as on
            // the active layer (spec 019 — this now works on a sibling's line too).
            selectedNodes.clear();
            selectedEdges.clear();
            clearCrossSelection();
            if (onActive) selectedEdges.add(hit.edgeId);
            else crossEdgeSel.set(pathKey(hit.path), new Set([hit.edgeId]));
            sel = { path: hit.path, edgeId: hit.edgeId, nodeId: null, handle: null,
                    regionId: (onActive && sel.regionId && hitV.regions[sel.regionId] && regionEdgeIds(hitV.regions[sel.regionId]).indexOf(hit.edgeId) >= 0) ? sel.regionId : null,
                    textId: null };
            beginHistory(onActive ? null : [hit.path]);
            drag.kind = "edge"; drag.path = hit.path; drag.v = hitV; drag.layer = hitLayer;
            drag.edgeId = hit.edgeId; drag.t = hit.t; drag.ctrl = ctrl;
            // alt-drag / right-drag translate the whole line rigidly (both endpoints + this edge's own
            // curve handles) instead of bending it — mirrors how me.nudge moves a selected line. A plain
            // drag bends the segment into a curve; on a property key that bend commits to the `curves`
            // overlay (spec 012), so bending stays enabled there just like on the base drawing.
            drag.move = !!(opts && (opts.alt || opts.right));
            if (drag.move){
                let e = hitV.edges[hit.edgeId];
                drag.orig = {};
                [e.a, e.b].forEach(id=>{ let n = hitV.nodes[id]; if (n) drag.orig[id] = { x: n.x, y: n.y }; });
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
            // curve handles), a plain click just selects it (history discarded in handleUp). Works on
            // any eligible layer's shape, not just the active one (spec 019).
            let hitV = vecFor(hit.path), hitLayer = layerFor(hit.path);
            sel = { path: hit.path, edgeId: null, nodeId: null, handle: null, regionId: hit.regionId, textId: null };
            selectedNodes.clear();
            clearCrossSelection();
            selectedEdges.clear();
            beginHistory(isActivePath(hit.path) ? null : [hit.path]);
            drag.kind = "region"; drag.path = hit.path; drag.v = hitV; drag.layer = hitLayer;
            drag.regionId = hit.regionId;
            drag.orig = {}; drag.origH = {};
            let eids = regionEdgeIds(hitV.regions[hit.regionId]);
            let nset = new Set();
            eids.forEach(eid=>{
                let e = hitV.edges[eid]; if (!e) return;
                nset.add(e.a); nset.add(e.b);
                if (e.curve) drag.origH[eid] = {
                    h1: e.curve.h1 ? { x: e.curve.h1.x, y: e.curve.h1.y } : null,
                    h2: e.curve.h2 ? { x: e.curve.h2.x, y: e.curve.h2.y } : null
                };
            });
            nset.forEach(id=>{ let n = hitV.nodes[id]; if (n) drag.orig[id] = { x: n.x, y: n.y }; });
            EventBus.trigger(EVENT.vectorChanged);
            return;
        }

        // empty space → clear the selection and rubber-band a marquee (selects points inside it,
        // on the active layer AND every eligible sibling — spec 018)
        sel = { path: null, edgeId: null, nodeId: null, handle: null, regionId: null, textId: null };
        selectedEdges.clear(); // a marquee builds a node selection; drop any multi-line selection
        if (!shift){ selectedNodes.clear(); clearCrossSelection(); }
        drag.kind = "marquee";
        drag.additive = shift;
        EventBus.trigger(EVENT.vectorChanged);
    };

    me.handleMove = function(point, opts){
        if (!active || !drag) return;
        let v = vec();
        let gp = docToGeo(point);
        // spec 019: the cursor (and the gesture's down-point) converted into whichever layer
        // drag.path names (siblings need their own offset) — identical to gp/drag.downGeo when the
        // gesture is on the active layer, as it usually is.
        let gpFor = docToGeoAt(drag.path, point);
        let downFor = docToGeoAt(drag.path, drag.downDoc);
        drag.curGeo = gp;
        drag.curDoc = point;
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
        if (drag.kind === "text"){
            let text = drag.v && drag.v.texts && drag.v.texts[drag.textId];
            if (!text) return;
            text.x = gpFor.x;
            text.y = gpFor.y;
            changed(drag.layer);
            return;
        }
        if (drag.kind === "handle"){
            let dv = drag.v;
            let e = dv.edges[drag.edgeId];
            if (e && e.curve){
                let nodeId = drag.which === "h1" ? e.a : e.b;
                let node = dv.nodes[nodeId];
                // on a property key, handle shaping is a per-key CURVE pose (spec 012) — but a
                // gesture only ever reaches a property-key path on the ACTIVE layer (scopeLayers()
                // excludes siblings while posing), so onProperty() here always means "this handle
                // IS on the active layer".
                if (node && node.type === "smooth"){
                    // already a locked/smooth point → free drag, the other handle mirrors it
                    e.curve[drag.which] = { x: gpFor.x, y: gpFor.y };
                    enforceSmoothNode(dv, drag.edgeId, drag.which);
                    drag.snapping = false; drag.snapNodeId = null;
                } else if (onProperty()){
                    // never engage the tangent-snap that would flip the point's smooth/corner TYPE —
                    // the type belongs to the base drawing, not the pose (spec 012).
                    e.curve[drag.which] = { x: gpFor.x, y: gpFor.y };
                    drag.snapping = false; drag.snapNodeId = null;
                } else {
                    // not locked → offer to snap collinear (and, on release, lock it smooth)
                    let snap = tangentSnapHandle(dv, drag, gpFor, nodeId);
                    e.curve[drag.which] = snap.point;
                    drag.snapping = snap.snapping;
                    drag.snapNodeId = snap.snapping ? nodeId : null;
                }
                changed(drag.layer);
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
        if (drag.kind === "nodesMulti"){
            // spec 018: each touched layer computes its OWN document→local delta (docToGeoAt resolves
            // that layer's own offset), then applies the exact same per-node/per-handle update the
            // single-layer "nodes" branch above uses.
            drag.groups.forEach(g=>{
                let down = docToGeoAt(g.path, drag.downDoc), cur = docToGeoAt(g.path, drag.curDoc);
                let dx = cur.x - down.x, dy = cur.y - down.y;
                if (opts && opts.shift){ let c = constrainDelta(dx, dy); dx = c.dx; dy = c.dy; }
                g.nodeIds.forEach(id=>{
                    let n = g.v.nodes[id], o0 = g.orig[id];
                    if (n && o0){ n.x = o0.x + dx; n.y = o0.y + dy; }
                });
                if (g.origH) for (let k in g.origH){
                    let h = g.origH[k], e = g.v.edges[h.edgeId];
                    if (e && e.curve && e.curve[h.which]){ e.curve[h.which].x = h.x + dx; e.curve[h.which].y = h.y + dy; }
                }
                markLayerDirty(g.layer || (g.layer = ImageFile.getLayerInTarget(ImageFile.getHistoryTarget(), g.path)));
            });
            EventBus.trigger(EVENT.vectorChanged);
            return;
        }
        if (drag.kind === "region"){
            // rigid translation of the whole shape: every node and every curve handle by the same delta
            let dv = drag.v;
            let dx = gpFor.x - downFor.x, dy = gpFor.y - downFor.y;
            for (let id in drag.orig){ let n = dv.nodes[id], o0 = drag.orig[id]; if (n && o0){ n.x = o0.x + dx; n.y = o0.y + dy; } }
            for (let eid in drag.origH){
                let e = dv.edges[eid], oh = drag.origH[eid];
                if (e && e.curve && oh){
                    if (oh.h1 && e.curve.h1){ e.curve.h1.x = oh.h1.x + dx; e.curve.h1.y = oh.h1.y + dy; }
                    if (oh.h2 && e.curve.h2){ e.curve.h2.x = oh.h2.x + dx; e.curve.h2.y = oh.h2.y + dy; }
                }
            }
            changed(drag.layer);
            return;
        }
        if (drag.kind === "marquee"){
            EventBus.trigger(EVENT.vectorChanged);
            return;
        }
        if (drag.kind === "edge" && drag.moved){
            let dv = drag.v;
            if (drag.move){
                // alt/right drag: translate the whole line (both endpoints + its curve handles)
                let dx = gpFor.x - downFor.x, dy = gpFor.y - downFor.y;
                let e = dv.edges[drag.edgeId];
                for (let id in drag.orig){ let n = dv.nodes[id], o0 = drag.orig[id]; if (n && o0){ n.x = o0.x + dx; n.y = o0.y + dy; } }
                if (drag.origH && e && e.curve){
                    if (drag.origH.h1 && e.curve.h1){ e.curve.h1.x = drag.origH.h1.x + dx; e.curve.h1.y = drag.origH.h1.y + dy; }
                    if (drag.origH.h2 && e.curve.h2){ e.curve.h2.x = drag.origH.h2.x + dx; e.curve.h2.y = drag.origH.h2.y + dy; }
                }
                changed(drag.layer);
                return;
            }
            // drag a segment into a curve passing through the cursor at parameter t
            promoteToCurveThrough(dv, drag.edgeId, drag.t, gpFor);
            changed(drag.layer);
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
        let hit;
        if (isTextMode()){
            // an existing text object is reachable on any eligible layer (spec 019)
            hit = null;
            for (let L of scopeLayers()){
                if (!L.v) continue;
                let lgp = docToGeoAt(L.path, point);
                let textId = textAtPoint(L.v, lgp, tolerance || HANDLE);
                if (textId){ hit = { path: L.path, kind: "text", textId: textId }; break; }
            }
        }else{
            hit = me.pick(point, tolerance || HANDLE);
        }
        hoverKind = hit ? hit.kind : null; // remember what's under the cursor for the action cursor
        // Remember which point / handle is under the cursor (and on which layer, spec 019) so the
        // overlay can enlarge it — makes it obvious you're on the right spot before you press.
        // Repaint only when the hover target actually changes (this fires on every mouse move).
        let next = null;
        if (hit && hit.kind === "node") next = { path: hit.path, kind: "node", nodeId: hit.nodeId };
        else if (hit && hit.kind === "handle") next = { path: hit.path, kind: "handle", edgeId: hit.edgeId, which: hit.which };
        let a = hover, b = next;
        let changedHover = (!a !== !b) || (a && b && (a.kind !== b.kind || a.nodeId !== b.nodeId || a.edgeId !== b.edgeId || a.which !== b.which || pathKey(a.path||[]) !== pathKey(b.path||[])));
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
        if (isTextMode()) return hoverKind === "text" ? "vectormove" : "text";
        // draw sub-modes get a precise crosshair, like the pixel tools: placement modes drop geometry
        // at the pointer; fill/outline click a target (still a crosshair, matching the pixel fill tool).
        if (isPlacementMode() || mode === "fill" || mode === "outline") return "draw";
        // select / edit mode: reflect the action the hovered target will trigger
        switch (hoverKind){
            case "node":   return "vectormove";                 // drag the point
            case "handle": return "vectormove";                 // drag the bezier tangent handle
            case "region": return "vectormove";                 // drag the whole shape
            case "text":   return "vectormove";                 // drag the text object
            case "edge":   return ctrl ? "vectoradd" : "vectorcurve"; // ctrl = insert a point, else bend into a curve
            default:       return "vector";                     // empty space → plain pointer (marquee select)
        }
    };

    function isHoverNode(id, path){ return hover && hover.kind === "node" && hover.nodeId === id && pathKey(hover.path||[]) === pathKey(path||[]); }
    function isHoverHandle(edgeId, which, path){ return hover && hover.kind === "handle" && hover.edgeId === edgeId && hover.which === which && pathKey(hover.path||[]) === pathKey(path||[]); }

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
        if (d.kind === "text"){
            let dv = d.v;
            let text = dv && dv.texts && dv.texts[d.textId];
            if (!text){ endGesture(false); EventBus.trigger(EVENT.vectorChanged); return; }
            if (d.creating){
                beginTextEdit(d.path, d.textId, false);
                changed(d.layer);
                return;
            }
            if (d.moved){
                endGesture(true);
                changed(d.layer);
            }else{
                endGesture(false);
                beginTextEdit(d.path, d.textId, true);
            }
            return;
        }
        if (d.kind === "nodes"){
            if (d.moved){ reResolveAfterMove(v, d.nodeIds); endGesture(true); changed(); }
            else {
                // a plain click (no drag) on a node collapses the selection to just that node
                endGesture(false);
                selectedNodes.clear(); selectedNodes.add(d.clickedNode);
                sel.path = d.path; sel.nodeId = d.clickedNode;
                sel.textId = null;
                EventBus.trigger(EVENT.vectorChanged);
            }
            return;
        }
        if (d.kind === "nodesMulti"){
            if (d.moved){
                d.groups.forEach(g=> reResolveAfterMove(g.v, g.nodeIds));
                endGesture(true);
                changed();
            } else {
                // a plain click (no drag) collapses the WHOLE cross-layer selection to just the one
                // clicked point, on whichever layer it lives on (mirrors the single-layer "nodes" case)
                endGesture(false);
                selectedNodes.clear();
                clearCrossSelection();
                sel.path = d.clickedPath;
                sel.nodeId = d.clickedNode;
                if (isActivePath(d.clickedPath)) selectedNodes.add(d.clickedNode);
                else crossSel.set(pathKey(d.clickedPath), new Set([d.clickedNode]));
                sel.textId = null;
                EventBus.trigger(EVENT.vectorChanged);
            }
            return;
        }
        if (d.kind === "region"){
            // moved → the shape was translated (keep it); plain click → selection only (no history)
            if (d.moved){ reResolveAfterMove(d.v, Object.keys(d.orig || {})); endGesture(true); changed(d.layer); }
            else { endGesture(false); EventBus.trigger(EVENT.vectorChanged); }
            return;
        }
        if (d.kind === "marquee"){
            if (d.moved){
                let x0 = Math.min(d.downGeo.x, d.curGeo.x), y0 = Math.min(d.downGeo.y, d.curGeo.y);
                let x1 = Math.max(d.downGeo.x, d.curGeo.x), y1 = Math.max(d.downGeo.y, d.curGeo.y);
                // A locked/hidden active layer is excluded here too (mirrors the eligible-sibling
                // filter just below) — the marquee still reaches every eligible sibling.
                if (activeLayerEligible()) for (let id in v.nodes){
                    let n = v.nodes[id];
                    if (n.x >= x0 && n.x <= x1 && n.y >= y0 && n.y <= y1) selectedNodes.add(id);
                }
                // spec 018: repeat the rectangle test against every eligible sibling layer, in ITS OWN
                // local geometry space (a sibling's offset can differ from the active layer's).
                // Base-editing only, mirroring the click/shift-click path.
                if (!onProperty()) ImageFile.getEligibleVectorSiblings().forEach(s=>{
                    let l = ImageFile.getLayerInTarget(ImageFile.getHistoryTarget(), s.path);
                    let sv = l && l.vector;
                    if (!sv) return;
                    let a = docToGeoAt(s.path, d.downDoc), b = docToGeoAt(s.path, d.curDoc);
                    let sx0 = Math.min(a.x, b.x), sy0 = Math.min(a.y, b.y);
                    let sx1 = Math.max(a.x, b.x), sy1 = Math.max(a.y, b.y);
                    let key = pathKey(s.path);
                    let set = crossSel.get(key);
                    for (let id in sv.nodes){
                        let n = sv.nodes[id];
                        if (n.x >= sx0 && n.x <= sx1 && n.y >= sy0 && n.y <= sy1){
                            if (!set){ set = new Set(); crossSel.set(key, set); }
                            set.add(id);
                        }
                    }
                });
            }
            sel.textId = null;
            EventBus.trigger(EVENT.vectorChanged); // selection-only, no geometry change / history
            return;
        }
        if (d.kind === "edge" && !d.moved){
            if (d.ctrl){
                // ctrl-click on a segment interior → insert a point there
                let r = splitEdgeAt(d.v, d.edgeId, d.t);
                sel = { path: d.path, edgeId: null, nodeId: r.midNodeId, handle: null, regionId: null, textId: null };
                selectedNodes.clear(); selectedEdges.clear();
                if (isActivePath(d.path)) selectedNodes.add(r.midNodeId);
                else { clearCrossSelection(); crossSel.set(pathKey(d.path), new Set([r.midNodeId])); }
                endGesture(true); changed(d.layer); return;
            }
            // plain click just selects the line (already set on down); no geometry change
            endGesture(false); EventBus.trigger(EVENT.vectorChanged); return;
        }
        if (d.kind === "edge" && d.moved && d.move){
            // alt/right-drag translated the whole line → weld any new crossing it created (spec 013
            // R1). A plain bend (d.move false) is a reshape, not a move, so it is left to fall through.
            reResolveAfterMove(d.v, Object.keys(d.orig || {}));
            endGesture(true); changed(d.layer); return;
        }
        if (d.kind === "handle"){
            // released while snapped collinear → lock the point smooth. The two handles are already
            // collinear from the snap, so just flag the type (don't re-align via setNodeCurveMode,
            // which would swing them to the endpoint tangent and jump away from where you let go).
            if (d.snapping){
                let e = d.v.edges[d.edgeId];
                if (e){ let n = d.v.nodes[d.which === "h1" ? e.a : e.b]; if (n) n.type = "smooth"; }
            }
            endGesture(true); changed(d.layer); return;
        }
        // handle / curve drags already mutated the model
        endGesture(true);
        changed(d.layer);
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
        let hit = me.pick(point, tolerance || HANDLE);
        if (!hit || hit.kind !== "edge") return;
        let hitV = vecFor(hit.path);
        if (!hitV) return;
        selectedNodes.clear();
        clearCrossSelection();
        if (isActivePath(hit.path)) selectedEdges = new Set(connectedEdges(hitV, hit.edgeId));
        else { selectedEdges.clear(); crossEdgeSel.set(pathKey(hit.path), new Set(connectedEdges(hitV, hit.edgeId))); }
        sel = { path: hit.path, edgeId: hit.edgeId, nodeId: null, handle: null, regionId: null, textId: null };
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
        // spec 018: resolve everything selected — the active layer's own points/lines (including the
        // single-item sel.nodeId/sel.edgeId context) plus every cross-layer point/line — into one
        // combined delete, under one undo step (deleteNode/deleteEdge already cascade to incident
        // edges/regions, so a fully-selected shape disappears whole either way).
        let nodeIds = new Set(selectedNodes);
        if (sel.nodeId) nodeIds.add(sel.nodeId);
        let edgeIds = new Set(selectedEdges);
        if (sel.edgeId) edgeIds.add(sel.edgeId);
        let crossRefs = new Set([...crossSel.keys(), ...crossEdgeSel.keys()]);
        if (nodeIds.size || edgeIds.size || crossRefs.size){
            let refs = [ImageFile.getActiveLayerPath()];
            crossRefs.forEach(k=> refs.push(unpathKey(k)));
            beginHistory(refs);
            nodeIds.forEach(id=>{ if (v.nodes[id]) deleteNode(v, id); });
            edgeIds.forEach(id=>{ if (v.edges[id]) deleteEdge(v, id); });
            if (crossRefs.size){
                let target = ImageFile.getHistoryTarget();
                crossRefs.forEach(key=>{
                    let l = ImageFile.getLayerInTarget(target, unpathKey(key));
                    let sv = l && l.vector;
                    if (!sv) return;
                    let nids = crossSel.get(key); if (nids) nids.forEach(id=>{ if (sv.nodes[id]) deleteNode(sv, id); });
                    let eids = crossEdgeSel.get(key); if (eids) eids.forEach(id=>{ if (sv.edges[id]) deleteEdge(sv, id); });
                    markLayerDirty(l);
                });
            }
            selectedNodes.clear(); selectedEdges.clear();
            clearCrossSelection();
            sel = { path: null, edgeId: null, nodeId: null, handle: null, regionId: null, textId: null };
            endGesture(true); changed(); return;
        }
        // A selected region/text has no cross-layer secondary map (regions/text stay single-target),
        // so it may still live on a SIBLING via sel.path (spec 019) — resolve through vecFor, not v.
        if (sel.regionId){
            let rPath = sel.path, rv = vecFor(rPath);
            if (rv && rv.regions[sel.regionId]){
                beginHistory(isActivePath(rPath) ? null : [rPath]);
                let ids = regionEdgeIds(rv.regions[sel.regionId]);
                delete rv.regions[sel.regionId];       // drop the fill, then its boundary + hole edges
                ids.forEach(eid=>{ if (rv.edges[eid]) deleteEdge(rv, eid); });
                sel = { path: null, edgeId: null, nodeId: null, handle: null, regionId: null, textId: null };
                endGesture(true); changedFor(rPath); return;
            }
        }
        if (sel.textId){
            let tPath = sel.path, tv = vecFor(tPath);
            if (tv && tv.texts && tv.texts[sel.textId]){
                beginHistory(isActivePath(tPath) ? null : [tPath]);
                delete tv.texts[sel.textId];
                sel = { path: null, edgeId: null, nodeId: null, handle: null, regionId: null, textId: null };
                endGesture(true); changedFor(tPath); return;
            }
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

        // spec 019: a single region/text selected on a SIBLING has no cross-layer secondary map
        // (regions/text stay single-target) — handle it as its own standalone rigid move/nudge here,
        // before the active-layer priority chain below (which only ever resolves through `v`, the
        // active document, so it can never see a sibling's region/text).
        if (sel.path && !isActivePath(sel.path)){
            let rv = vecFor(sel.path);
            if (sel.textId && rv && rv.texts && rv.texts[sel.textId]){
                beginHistory([sel.path]);
                rv.texts[sel.textId].x += dx;
                rv.texts[sel.textId].y += dy;
                endGesture(true); changedFor(sel.path);
                return true;
            }
            if (sel.regionId && rv && rv.regions[sel.regionId]){
                beginHistory([sel.path]);
                let eids = regionEdgeIds(rv.regions[sel.regionId]);
                let s = new Set();
                eids.forEach(eid=>{ let e = rv.edges[eid]; if (e){ s.add(e.a); s.add(e.b); } });
                s.forEach(id=>{ let n = rv.nodes[id]; if (n){ n.x += dx; n.y += dy; } });
                eids.forEach(eid=>{
                    let e = rv.edges[eid];
                    if (e && e.curve){
                        if (e.curve.h1){ e.curve.h1.x += dx; e.curve.h1.y += dy; }
                        if (e.curve.h2){ e.curve.h2.x += dx; e.curve.h2.y += dy; }
                    }
                });
                endGesture(true); changedFor(sel.path);
                return true;
            }
        }

        let nodeIds = null;   // node ids to translate
        let edgeIds = null;   // edges whose curve handles also translate (rigid move)

        if (selectedNodes.size){
            nodeIds = Array.from(selectedNodes);
        } else if (sel.textId && v.texts && v.texts[sel.textId]){
            beginHistory();
            v.texts[sel.textId].x += dx;
            v.texts[sel.textId].y += dy;
            endGesture(true);
            changed();
            return true;
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
        // spec 018: a sibling-only selection (no active-layer node/edge/region/text targeted) still
        // has something to nudge, as long as crossSel/crossEdgeSel holds points/lines.
        let crossRefs = new Set([...crossSel.keys(), ...crossEdgeSel.keys()]);
        if ((!nodeIds || !nodeIds.length) && !crossRefs.size) return false;
        nodeIds = nodeIds || [];

        let refs = [ImageFile.getActiveLayerPath()];
        crossRefs.forEach(k=> refs.push(unpathKey(k)));
        beginHistory(refs);
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
        // spec 018: translate every eligible sibling's selected points AND lines (+ their own curve
        // handles) by the same document-space delta — unlike a drag, a nudge is already a plain axis
        // delta with no per-layer coordinate conversion needed. siblingSelectedNodeIds resolves a
        // sibling's point selection and line selection into one deduped node-id set, so a selected
        // line's endpoints move (and, via incidentHandleBases, both its curve handles) exactly like a
        // selected point does.
        if (crossRefs.size){
            let target = ImageFile.getHistoryTarget();
            crossRefs.forEach(key=>{
                let l = ImageFile.getLayerInTarget(target, unpathKey(key));
                let sv = l && l.vector;
                if (!sv) return;
                let list = siblingSelectedNodeIds(sv, key);
                if (!list.length) return;
                list.forEach(id=>{ let n = sv.nodes[id]; n.x += dx; n.y += dy; });
                let hb = incidentHandleBases(sv, list);
                for (let k in hb){ let h = hb[k], e = sv.edges[h.edgeId]; if (e && e.curve && e.curve[h.which]){ e.curve[h.which].x += dx; e.curve[h.which].y += dy; } }
                markLayerDirty(l);
            });
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
            sel = { path: ImageFile.getActiveLayerPath(), edgeId: null, nodeId: keep, handle: null, regionId: null, textId: null };
            endGesture(true); changed();
        } else {
            endGesture(false);
        }
    };

    // The selected edges eligible for "Lines to Fills": any selected stroked edge — a standalone
    // line, or a stroked outline edge of an already-filled shape (a "thick outline" — its stroke gets
    // converted to fill too, merging into that same shape's fill when the colours match).
    function candidateLineEdgeIds(v){
        let ids = new Set(selectedEdges);
        if (sel.edgeId) ids.add(sel.edgeId);
        return Array.from(ids).filter(id=> v.edges[id] && v.edges[id].stroke);
    }

    // Removes a region being absorbed into a "Lines to Fills" merge. Unlike deleteRegionGeometry, this
    // always drops the region's boundary/hole edges even when they still carry a stroke — that stroke
    // is exactly what's being converted to fill — UNLESS another surviving region still references
    // the same edge (a shared boundary), in which case the edge is kept but un-stroked.
    function purgeMergedRegion(v, regionId){
        let region = v.regions[regionId];
        if (!region) return;
        let ids = regionEdgeIds(region);
        delete v.regions[regionId];
        ids.forEach(eid=>{
            if (!v.edges[eid]) return;
            let stillUsed = false;
            for (let rid in v.regions){ if (regionEdgeIds(v.regions[rid]).indexOf(eid) >= 0){ stillUsed = true; break; } }
            if (stillUsed) v.edges[eid].stroke = null;
            else delete v.edges[eid];
        });
    }

    function dropOrphanNodesLocal(v){
        for (let id in v.nodes){
            if (edgesAtNode(v, id).length === 0) delete v.nodes[id];
        }
    }

    me.getSelectedEdges = function(){ return Array.from(selectedEdges); };

    // Whether "Lines to Fills" has anything to do right now — drives the option-bar button's
    // enabled state without mutating anything.
    me.canLinesToFills = function(){
        if (!active) return false;
        let v = vec();
        return !!(v && candidateLineEdgeIds(v).length);
    };

    // Converts every selected line (a stroked edge — a standalone line, or a stroked outline edge of
    // an already-filled shape) into a filled shape — the stroke's own width, offset with round caps.
    // Lines are grouped by stroke colour (a colour change never merges); within a group, any EXISTING
    // fill of that same colour the stroked area touches is absorbed into the result — including the
    // very shape a converted outline edge belongs to — so the line reads as an expansion of that fill
    // rather than a separate overlapping shape. A converted edge that still belongs to some OTHER
    // (differently-coloured) shape's outline keeps its place there — un-stroked, but still shaping
    // that region — everything else is fully replaced by the new fill.
    //
    // Geometry comes from analyticStrokeRegions — a curve-preserving per-chain offset (strokeChainRing)
    // unioned with vectorBoolean's real curve-clipping boolean combine, so a curved line stays curved
    // instead of being flattened into a polygon. rasterStrokeRegions (the mask/trace/simplify pipeline
    // the blob brush also uses — always straight-segment output) is a fallback for when that fails: a
    // rare, documented limitation of the boolean-clip implementation (a tangential touch or exactly
    // coincident overlapping edge), never for an everyday shape.
    me.linesToFills = function(){
        if (!active) return;
        syncEditContext();
        if (poseEditing() || readOnly) return;
        let v = vec();
        if (!v) return;
        let edgeIds = candidateLineEdgeIds(v);
        if (!edgeIds.length) return;

        let groups = {};
        edgeIds.forEach(id=>{
            let color = v.edges[id].stroke.color;
            (groups[color] = groups[color] || []).push(id);
        });

        beginHistory();
        let sharp = getDisplayMode(v) === "sharp";
        let newRegionIds = [];
        let touchedAny = false;

        Object.keys(groups).forEach(color=>{
            let ids = groups[color];
            let maxWidth = ids.reduce((m, id)=>Math.max(m, (v.edges[id].stroke.width || 1)), 1);
            let pts = [];
            ids.forEach(id=>{ pts = pts.concat(flattenEdge(v, v.edges[id], 0.3)); });
            if (!pts.length) return;
            let merge = mergeableRegions(v, pts, { size: maxWidth }, color);

            let regions = analyticStrokeRegions(v, ids, merge.map(x=>x.id))
                || rasterStrokeRegions(v, ids, merge, sharp);
            if (!regions || !regions.length) return;

            // Absorbed (same-colour) regions are fully replaced by the union above — drop them and
            // every edge they owned, stroke or not (purgeMergedRegion). A candidate edge that still
            // belongs to some OTHER, un-merged region (a differently-coloured shape's outline) keeps
            // its place in that region's boundary — only its stroke is cleared, since it's now
            // represented by the new fill sitting over/beside it. A candidate edge that belonged to
            // no region at all is simply gone, fully replaced by the new fill.
            merge.forEach(x=> purgeMergedRegion(v, x.id));
            ids.forEach(id=>{
                let e = v.edges[id];
                if (!e) return;   // already removed as part of an absorbed region above
                let stillInRegion = false;
                for (let rid in v.regions){ if (regionEdgeIds(v.regions[rid]).indexOf(id) >= 0){ stillInRegion = true; break; } }
                if (stillInRegion) e.stroke = null;
                else deleteEdge(v, id);
            });
            dropOrphanNodesLocal(v);

            regions.forEach(rgn=>{
                let id = newRegionId(v);
                v.regions[id] = {
                    id: id,
                    boundary: materializeArcLoop(v, rgn.boundary),
                    holes: (rgn.holes || []).map(h=>materializeArcLoop(v, h)),
                    fillRule: "evenodd",
                    fill: { color: color, smooth: !sharp }
                };
                newRegionIds.push(id);
            });
            touchedAny = true;
        });

        if (!touchedAny){ endGesture(false); return; }

        selectedEdges.clear();
        selectedNodes.clear();
        sel = { path: ImageFile.getActiveLayerPath(), edgeId: null, nodeId: null, handle: null, regionId: newRegionIds[0] || null, textId: null };
        endGesture(true); changed();
    };

    // ── "Expand Fill" (Shape menu) ──────────────────────────────────────────────────────────
    // Grows (or insets) the selected shape's own fill by a signed pixel amount — live-previewed via a
    // -20..20 toolOptions slider (0.1px steps) with Apply/Cancel — while shrinking (or growing) every
    // hole in it the opposite way, so a donut's hole shrinks as the ring around it grows.
    //
    // Each loop (the boundary, and each hole) is offset independently, and each one picks whichever
    // technique is valid for the DIRECTION it needs to move:
    //  - OUTWARD (the boundary when amount>0, a hole when amount<0) uses the same curve-preserving
    //    analytic offset "Lines to Fills" uses to convert a stroke to fill (strokeChainRing's
    //    closed-chain path — extend each edge, round-join at the original vertex): a real, continuous,
    //    exact Minkowski dilation, so this is genuinely "stroke the shape with that width, then Lines
    //    to Fills it" — no rasterizing, no fixed step size, dead smooth as the slider drags. See
    //    offsetLoopOutward.
    //  - INWARD (the boundary when amount<0, a hole when amount>0) has no equivalent closed-form: an
    //    eroded convex corner is a plain miter, not an arc through the original vertex, so
    //    strokeChainRing's OTHER ring is only meaningful together with its outward twin (as a stroke's
    //    two edges), never picked out in isolation. This direction instead rasterizes just that one
    //    loop's own fill, erodes it (a separable square erode — an exact, O(w·h) running-window sum,
    //    independent of radius, supersampled a little for sub-pixel response), and traces the result
    //    back the usual rasterize→marching-squares→simplify way ("Lines to Fills"' own raster fallback
    //    / the Blob brush). See morphSingleLoop. Slightly squared-off corners and straight-segment
    //    (not curved) output only ever show up on this INWARD side, and only where it's actually used.
    //
    // Every slider tick recomputes the boundary/holes from a frozen SNAPSHOT of the ORIGINAL geometry
    // (taken once, when the gesture starts) rather than re-offsetting the already-offset previous
    // preview, so scrubbing the slider back and forth never compounds or drifts. The one open history
    // bracket (beginHistory/endGesture, same bracket every other vector gesture uses) means Cancel
    // restores the untouched original in one step via its existing restoreSnapshots() rollback.

    // A frozen, standalone {v,steps} view of one already-ordered edge loop (a region's boundary or one
    // hole) that strokeChainRing can read — decoupled from the live document (a throwaway {nodes,edges}
    // it only ever reads) so recomputing from it on every slider tick is cheap and never touches
    // whatever the live v.edges/v.nodes currently hold.
    function snapshotLoopSteps(v, edgeIds){
        if (!edgeIds || !edgeIds.length) return null;
        let n = edgeIds.length;
        let realEdges = edgeIds.map(id=>v.edges[id]);
        if (realEdges.some(e=>!e)) return null;
        let fakeV = { nodes: {}, edges: {} };
        let nodeIds = new Set();
        realEdges.forEach(e=>{ nodeIds.add(e.a); nodeIds.add(e.b); });
        nodeIds.forEach(id=>{ let nd = v.nodes[id]; if (nd) fakeV.nodes[id] = { x: nd.x, y: nd.y }; });
        let cloneEdges = realEdges.map(e=>{
            let ce = { a: e.a, b: e.b };
            if (e.curve) ce.curve = { h1: { x: e.curve.h1.x, y: e.curve.h1.y }, h2: { x: e.curve.h2.x, y: e.curve.h2.y } };
            return ce;
        });
        // The loop's own edge array already runs head-to-tail (materializeArcLoop built it that way);
        // recover each edge's traversal direction from the node it shares with its neighbour — same
        // technique buildStrokeChains' walkClosed uses to DISCOVER a loop, but here the order is
        // already known, so this just reconstructs the forward/backward flag for each edge in turn.
        function sharedNode(e1, e2){
            if (e1.a === e2.a || e1.a === e2.b) return e1.a;
            if (e1.b === e2.a || e1.b === e2.b) return e1.b;
            return null;
        }
        let from = n > 1 ? sharedNode(cloneEdges[0], cloneEdges[n - 1]) : cloneEdges[0].a;
        if (from == null) return null;
        let steps = [];
        for (let i = 0; i < n; i++){
            let e = cloneEdges[i];
            let forward = e.a === from;
            steps.push({ edge: e, forward: forward });
            from = forward ? e.b : e.a;
        }
        return { v: fakeV, steps: steps };
    }

    // The snapshotted loop's arcs at their ORIGINAL (unoffset) geometry.
    function loopArcsFromSnap(snap){
        return snap.steps.map(s=>orientedEdgeGeometry(snap.v, s.edge, s.forward));
    }

    // A plain {x,y} point loop of one snapshotted, already-ordered/oriented loop — flattened the same
    // way flattenLoopIds (vectorUtils.js) flattens a real region loop, just reading the snapshot's own
    // throwaway {v,steps} instead of live document edges.
    function snapshotLoopPoints(snap, tol){
        let pts = [];
        snap.steps.forEach(s=>{
            let fp = flattenEdge(snap.v, s.edge, tol);
            if (!s.forward) fp = fp.slice().reverse();
            for (let k = pts.length ? 1 : 0; k < fp.length; k++) pts.push({ x: fp[k].x, y: fp[k].y });
        });
        if (pts.length >= 2){
            let a = pts[0], b = pts[pts.length - 1];
            if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) pts.pop();
        }
        return pts;
    }

    // The OUTWARD offset of one snapshotted loop by `radius` px (radius > 0) — a real, continuous
    // Minkowski dilation: extend each edge, round-join at every original vertex, exactly as if the
    // loop had a real stroke of width 2*radius and that stroke were converted to fill ("Lines to
    // Fills"). strokeChainRing's closed-chain path returns both offset sides at once; the bigger one
    // by enclosed area is always the outward one, regardless of the loop's own winding direction.
    // ONLY valid for growing this exact loop outward — see the "Expand Fill" header for why the other
    // (inward) side isn't a valid standalone offset shape.
    function offsetLoopOutward(snap, radius, tolDeg){
        if (!snap || !(radius > 1e-6)) return null;
        let rings = strokeChainRing(snap.v, snap.steps, radius, true, tolDeg);
        if (!rings || rings.length < 2) return null;
        let a0 = loopAbsArea(rings[0].map(a=>a.p0));
        let a1 = loopAbsArea(rings[1].map(a=>a.p0));
        return a0 >= a1 ? rings[0] : rings[1];
    }

    // Separable binary square dilate (`grow` true) / erode (`grow` false) of `radius` px: a running
    // in/out window SUM per row, then per column (out-of-bounds reads as background/0) — exact for a
    // square structuring element, and O(w·h) total regardless of radius (unlike a naive per-pixel
    // disk-kernel scan), which is what keeps a live slider-drag preview cheap. The trade-off is a
    // square (Chebyshev-distance) grow/shrink rather than a round one — see the "Expand Fill" header.
    function morphMask(mask, w, h, radius, grow){
        return morphPass(morphPass(mask, w, h, radius, grow, true), w, h, radius, grow, false);
    }
    function morphPass(src, w, h, radius, grow, rowMajor){
        let r = Math.round(radius);
        if (r <= 0) return src;
        let k = 2 * r + 1;
        let out = new Uint8Array(src.length);
        let lineCount = rowMajor ? h : w;
        let lineLen = rowMajor ? w : h;
        let idxOf = rowMajor ? (line, i)=>line * w + i : (line, i)=>i * w + line;
        for (let line = 0; line < lineCount; line++){
            let count = 0;
            for (let i = 0; i <= r && i < lineLen; i++) count += src[idxOf(line, i)];
            for (let i = 0; i < lineLen; i++){
                out[idxOf(line, i)] = grow ? (count > 0 ? 1 : 0) : (count === k ? 1 : 0);
                let addIdx = i + r + 1, removeIdx = i - r;
                if (addIdx < lineLen) count += src[idxOf(line, addIdx)];
                if (removeIdx >= 0) count -= src[idxOf(line, removeIdx)];
            }
        }
        return out;
    }

    // Supersample factor for morphSingleLoop's mask — gives the separable square erode roughly
    // 1/EXPANDFILL_SUPERSAMPLE px response instead of a full 1px step, closer to the slider's own
    // 0.1px granularity, at a bounded quadratic cost (capped below by the mask-size guard).
    const EXPANDFILL_SUPERSAMPLE = 4;

    // The INWARD offset (erode `radius` px, or dilate if `grow`) of ONE snapshotted loop, in
    // isolation — rasterize→erode/dilate→marching-squares trace→simplify→keep the biggest resulting
    // loop. Used only for the direction strokeChainRing has no valid standalone offset for (see the
    // "Expand Fill" header): a boundary shrinking, or a hole growing via this SAME path when dilating
    // it would otherwise need to know about the shape's own fill (it doesn't here — a hole is always
    // grown in isolation, same as a boundary is always shrunk in isolation). Returns null when
    // there's nothing left to trace (fully eroded away, or a documented raster-fallback limitation).
    function morphSingleLoop(snap, radius, grow){
        if (typeof document === "undefined" || !(radius > 1e-6)) return null;
        let pts = snapshotLoopPoints(snap, 0.3);
        if (pts.length < 3) return null;

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        pts.forEach(p=>{ if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; });
        let pad = Math.ceil(radius) + 2;
        let ox = Math.floor(minX) - pad;
        let oy = Math.floor(minY) - pad;
        let dw = Math.ceil(maxX) + pad - ox;
        let dh = Math.ceil(maxY) + pad - oy;
        if (dw <= 0 || dh <= 0) return null;

        let scale = EXPANDFILL_SUPERSAMPLE;
        while (scale > 1 && dw * scale * dh * scale > 4e6) scale--;
        let w = dw * scale, h = dh * scale;
        if (w * h > 4e6) return null;

        let cv = document.createElement("canvas");
        cv.width = w; cv.height = h;
        let ctx = cv.getContext("2d");
        ctx.setTransform(scale, 0, 0, scale, -ox * scale, -oy * scale);
        ctx.fillStyle = "#000";
        let path = new Path2D();
        path.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) path.lineTo(pts[i].x, pts[i].y);
        path.closePath();
        ctx.fill(path);

        let data = ctx.getImageData(0, 0, w, h).data;
        let mask = new Uint8Array(w * h);
        for (let i = 3, j = 0; i < data.length; i += 4, j++) mask[j] = data[i] >= 128 ? 1 : 0;

        let morphed = morphMask(mask, w, h, radius * scale, grow);
        let loops = traceMaskContours(morphed, w, h);
        if (!loops.length) return null;

        let best = null, bestArea = 0;
        loops.forEach(loop=>{
            let simp = simplifyLoop(loop, 0.6 * scale);
            if (simp.length < 3) return;
            let g = simp.map(p=>({ x: ox + (p.x + 0.5) / scale, y: oy + (p.y + 0.5) / scale }));
            let area = loopAbsArea(g);
            if (area > bestArea){ bestArea = area; best = g; }
        });
        return best ? loopPointsToArcs(best) : null;
    }

    // Drops the region's CURRENT boundary/hole edges before replacing them with a freshly-offset loop
    // — but only the ones no other surviving region still shares (a sticky boundary two shapes meet
    // along) — mirroring purgeMergedRegion's own safety check for "Lines to Fills".
    function releaseRegionOwnEdges(v, regionId, edgeIds){
        edgeIds.forEach(eid=>{
            if (!v.edges[eid]) return;
            let stillUsed = false;
            for (let rid in v.regions){
                if (rid === regionId) continue;
                if (regionEdgeIds(v.regions[rid]).indexOf(eid) >= 0){ stillUsed = true; break; }
            }
            if (!stillUsed) delete v.edges[eid];
        });
    }

    me.isExpandFillActive = function(){ return !!expandFill; };
    me.getExpandFillAmount = function(){ return expandFill ? expandFill.amount : 0; };

    // Engages Expand Fill on the selected region: snapshots its boundary + holes and opens the history
    // bracket the live preview mutates into. No-op (false) unless a whole shape is currently selected.
    me.startExpandFill = function(){
        if (expandFill) return true;   // already engaged — the toolOptions slider just re-shows it
        if (!active) return false;
        syncEditContext();
        if (poseEditing() || readOnly) return false;
        let v = vec();
        if (!v || !sel.regionId) return false;
        let region = v.regions[sel.regionId];
        if (!region || !region.boundary || !region.boundary.length) return false;
        let boundarySnap = snapshotLoopSteps(v, region.boundary);
        if (!boundarySnap) return false;
        let holeSnaps = (region.holes || []).map(h=>snapshotLoopSteps(v, h)).filter(Boolean);
        expandFill = { regionId: sel.regionId, boundarySnap: boundarySnap, holeSnaps: holeSnaps, amount: 0 };
        beginHistory();
        changed();
        return true;
    };

    // Recomputes the region's boundary + holes from the ORIGINAL snapshot at the given signed pixel
    // amount (clamped to the slider's own -20..20 range) and repaints. Called on every slider tick —
    // bounded by the shape's own bounding box, not by radius, so it stays cheap while dragging.
    me.previewExpandFill = function(amount){
        if (!expandFill) return;
        syncEditContext();
        if (poseEditing() || readOnly) return;
        let v = vec();
        let region = v && v.regions[expandFill.regionId];
        if (!region) return;
        amount = Math.max(-20, Math.min(20, Math.round((+amount || 0) * 10) / 10));
        expandFill.amount = amount;

        // Boundary: outward (analytic, smooth) when growing, inward (raster erode) when insetting.
        let boundaryArcs = amount > 0 ? offsetLoopOutward(expandFill.boundarySnap, amount, 8)
            : amount < 0 ? morphSingleLoop(expandFill.boundarySnap, -amount, false)
            : null;
        if (!boundaryArcs) boundaryArcs = loopArcsFromSnap(expandFill.boundarySnap);

        // Each hole moves the OPPOSITE way: it grows (outward, analytic) when the fill insets, and
        // shrinks (inward, raster erode) when the fill expands.
        let holeArcsList = expandFill.holeSnaps.map(hs=>{
            let arcs = amount < 0 ? offsetLoopOutward(hs, -amount, 8)
                : amount > 0 ? morphSingleLoop(hs, amount, false)
                : null;
            return arcs || loopArcsFromSnap(hs);
        });

        let oldIds = regionEdgeIds(region);
        releaseRegionOwnEdges(v, expandFill.regionId, oldIds);
        dropOrphanNodesLocal(v);

        region.boundary = materializeArcLoop(v, boundaryArcs);
        region.holes = holeArcsList.map(arcs=>materializeArcLoop(v, arcs));

        changed();
    };

    // Ends the Expand Fill gesture, `keep` true to apply (close the history bracket keeping whatever
    // geometry is currently in place) or false to cancel (roll the whole layer back to its pre-gesture
    // snapshot). This is the ONE choke point every way of leaving the gesture routes through: the
    // toolOptions Apply/Cancel buttons below, but also Enter/Esc (me.commit()/me.cancel()), switching
    // vector sub-tool (me.setMode()), or starting a new canvas gesture (me.handleDown()) — so "select
    // another tool or another layer" auto-applies exactly like the toolOptions Apply button would.
    function stopExpandFill(keep){
        if (!expandFill) return;
        expandFill = null;
        endGesture(keep);
        changed();
    }
    me.commitExpandFill = function(){ stopExpandFill(true); };
    me.cancelExpandFill = function(){ stopExpandFill(false); };

    // Builds real node/edge geometry for one closed ring of arcs ({p0,p3,h1,h2,isCurve} — the shape
    // vectorBoolean.js's rings and edgeStrokeRing's offset both use), preserving curve data. The
    // curve-preserving counterpart of the old point-loop-only makeLoopEdges; also used by
    // rasterStrokeRegions below (via loopPointsToArcs) so both paths share one materialization step.
    function materializeArcLoop(v, arcs){
        if (!arcs || !arcs.length) return [];
        let nodes = arcs.map(a=>addNode(v, a.p0.x, a.p0.y));
        let ids = [];
        for (let i = 0; i < arcs.length; i++){
            let a = arcs[i];
            let opts = { stroke: null };
            if (a.isCurve) opts.curve = { h1: { x: a.h1.x, y: a.h1.y }, h2: { x: a.h2.x, y: a.h2.y } };
            ids.push(addEdge(v, nodes[i].id, nodes[(i+1) % nodes.length].id, opts).id);
        }
        return ids;
    }

    // A plain {x,y} point loop (the raster mask/trace fallback's output) as straight-only arcs, so
    // it can feed the same materializeArcLoop as the curve-preserving analytic path.
    function loopPointsToArcs(loop){
        return loop.map((p, i)=>({ p0: p, p3: loop[(i+1) % loop.length], h1: null, h2: null, isCurve: false }));
    }

    // Every ring (boundary + holes) of the given v.regions ids, as arcs in this layer's own geometry
    // space (no cross-layer offset — "Lines to Fills" only ever touches the active layer).
    function regionsToRings(v, regionIds){
        let subset = {};
        regionIds.forEach(id=>{ if (v.regions[id]) subset[id] = v.regions[id]; });
        return extractShapeRings({ regions: subset, edges: v.edges, nodes: v.nodes }, { x: 0, y: 0 });
    }
    function regionsSpecToRings(regions){
        let rings = [];
        regions.forEach(r=>{ rings.push(r.boundary); (r.holes || []).forEach(h=>rings.push(h)); });
        return rings;
    }

    // Splits candidate edges `ids` into maximal same-width CHAINS — connected runs through nodes of
    // degree exactly 2 (within this same-width subset), each either an open path (two loose ends) or
    // a closed loop — plus the set of node ids where 2+ *different* chains meet (a branch, or a
    // width change at that vertex): those aren't covered by any one chain's own internal join math,
    // so the caller folds in an explicit round-join disc (strokeJointDisc) there instead. A run of
    // edges through a smooth bend (no real branch, same width throughout — e.g. an ellipse's 4
    // quadrant edges, or a rectangle's 4 sides) becomes ONE chain, offset as a whole by
    // strokeChainRing with a proper per-vertex join sized to that bend's own turn angle — never the
    // fragile "two independent per-edge caps meeting at a (near-)continuous tangent" case a boolean
    // union can't reliably merge (vectorBoolean's own documented tangential-touch limitation).
    function buildStrokeChains(v, ids){
        let byWidth = {};
        ids.forEach(id=>{
            let w = v.edges[id].stroke.width || 1;
            (byWidth[w] = byWidth[w] || []).push(id);
        });

        let chains = [];
        let branchNodeHits = {};   // nodeId -> count of DIFFERENT chain ends landing there

        Object.keys(byWidth).forEach(width=>{
            let widthIds = byWidth[width];
            let adjacency = {};
            widthIds.forEach(id=>{
                let e = v.edges[id];
                (adjacency[e.a] = adjacency[e.a] || []).push(id);
                (adjacency[e.b] = adjacency[e.b] || []).push(id);
            });
            let visited = new Set();
            let otherNode = (edgeId, fromNode)=>{ let e = v.edges[edgeId]; return e.a === fromNode ? e.b : e.a; };
            let stepAt = (edgeId, fromNode)=>({ edge: v.edges[edgeId], forward: v.edges[edgeId].a === fromNode });

            function walkOpen(startNode, startEdgeId){
                let steps = [];
                let cur = startEdgeId, from = startNode;
                while (cur && !visited.has(cur)){
                    visited.add(cur);
                    steps.push(stepAt(cur, from));
                    let to = otherNode(cur, from);
                    let atNode = adjacency[to] || [];
                    if (atNode.length !== 2){ branchNodeHits[to] = (branchNodeHits[to]||0) + 1; break; }
                    let next = atNode.find(eid=>!visited.has(eid));
                    if (!next) break;
                    cur = next; from = to;
                }
                return steps;
            }
            function walkClosed(startEdgeId){
                let startNode = v.edges[startEdgeId].a;
                let steps = [];
                let cur = startEdgeId, from = startNode;
                while (true){
                    visited.add(cur);
                    steps.push(stepAt(cur, from));
                    let to = otherNode(cur, from);
                    if (to === startNode) break;
                    let atNode = adjacency[to] || [];
                    let next = atNode.find(eid=>!visited.has(eid));
                    if (!next) break;
                    cur = next; from = to;
                }
                return steps;
            }

            // open paths: every node whose candidate-degree != 2 is a true chain end (or a branch)
            Object.keys(adjacency).forEach(nodeId=>{
                if (adjacency[nodeId].length === 2) return;
                adjacency[nodeId].forEach(edgeId=>{
                    if (visited.has(edgeId)) return;
                    branchNodeHits[nodeId] = (branchNodeHits[nodeId]||0) + 1;
                    let steps = walkOpen(nodeId, edgeId);
                    if (steps.length) chains.push({ steps: steps, closed: false });
                });
            });
            // whatever's left is made of nodes that are ALL degree 2 — closed loops
            widthIds.forEach(id=>{
                if (visited.has(id)) return;
                let steps = walkClosed(id);
                if (steps.length) chains.push({ steps: steps, closed: true });
            });
        });

        let branchNodeIds = Object.keys(branchNodeHits).filter(nid=>branchNodeHits[nid] >= 2);
        return { chains: chains, branchNodeIds: branchNodeIds };
    }

    // The curve-preserving "Lines to Fills" attempt for one colour group: candidate edges are split
    // into chains (buildStrokeChains) and each offset as a whole (strokeChainRing) with proper
    // per-vertex joins; a genuine branch or width-change node gets an explicit round-join disc
    // instead (strokeJointDisc). All of that, plus every same-colour region being merged, is folded
    // together via vectorBoolean's curve-preserving union — needed only for genuinely separate
    // pieces (disjoint chains, or a chain meeting an existing fill), a well-behaved case for a real
    // transversal crossing. Returns an array of {boundary:[arc],holes:[[arc]]}, or null when there
    // was nothing to offset (every candidate edge degenerate) or every fold failed.
    function analyticStrokeRegions(v, ids, mergeRegionIds){
        let shapeRings = null;
        function foldIn(newRings){
            if (!newRings || !newRings.length) return;
            if (!shapeRings){ shapeRings = newRings; return; }
            let combined = booleanCombineRings(shapeRings, newRings, "union");
            if (combined) shapeRings = regionsSpecToRings(combined.regions);
            // a failed fold (a documented boolean-clip limitation) just keeps the shape as it was —
            // that piece is lost, but the rest of the conversion still proceeds.
        }

        let built = buildStrokeChains(v, ids);
        built.chains.forEach(chain=>{
            let width = chain.steps[0].edge.stroke.width || 1;
            let rings = strokeChainRing(v, chain.steps, width / 2, chain.closed);
            if (rings) foldIn(rings);
        });
        built.branchNodeIds.forEach(nodeId=>{
            let touching = ids.filter(id=> v.edges[id].a === nodeId || v.edges[id].b === nodeId);
            let radius = touching.reduce((m, id)=>Math.max(m, (v.edges[id].stroke.width || 1) / 2), 0);
            let node = v.nodes[nodeId];
            if (node && radius > 0) foldIn([ strokeJointDisc(node, radius) ]);
        });
        if (!shapeRings) return null;

        mergeRegionIds.forEach(rid=> foldIn(regionsToRings(v, [rid])));
        // one last self-union re-derives the final boundary/hole nesting for the accumulated rings
        // (a plain, always-safe "regroup" — see booleanCombineRings with an empty other shape).
        let settled = booleanCombineRings(shapeRings, [], "union");
        return settled ? settled.regions : null;
    }

    // The pre-existing rasterize → marching-squares → simplify pipeline (shared with the blob brush)
    // as a fallback for when analyticStrokeRegions can't produce a result. Always straight-segment
    // output (a rasterized mask has no way to know a boundary was originally a bezier).
    function rasterStrokeRegions(v, ids, merge, sharp){
        let m = buildEdgesMask(v, ids, merge.map(x=>x.polys));
        if (!m) return null;
        let loops = traceMaskContours(m.mask, m.w, m.h);
        if (!loops.length) return null;

        let eps = blobSimplifyEps() * m.scale;
        let geoLoops = [];
        loops.forEach(loop=>{
            let simp = simplifyLoop(loop, eps);
            if (simp.length < 3) return;
            let g = simp.map(p=>{
                let x = m.ox + (p.x + 0.5) / m.scale, y = m.oy + (p.y + 0.5) / m.scale;
                if (sharp){ x = Math.round(x); y = Math.round(y); }
                return { x: x, y: y };
            });
            if (loopAbsArea(g) < 1) return;
            geoLoops.push(g);
        });
        if (!geoLoops.length) return null;

        geoLoops.sort((a, b)=>loopAbsArea(b) - loopAbsArea(a));
        let info = geoLoops.map(l=>({ loop: l, parent: -1, depth: 0, region: -1 }));
        for (let i = 0; i < info.length; i++){
            let rep = info[i].loop[0];
            for (let j = 0; j < i; j++){ if (pointInLoop(rep, info[j].loop)) info[i].parent = j; }
            info[i].depth = info[i].parent < 0 ? 0 : info[info[i].parent].depth + 1;
        }

        let regions = [];
        info.forEach(node=>{
            if (node.depth % 2 === 0){
                node.region = regions.length;
                regions.push({ boundary: loopPointsToArcs(node.loop), holes: [] });
            }
        });
        info.forEach(node=>{
            if (node.depth % 2 === 1 && node.parent >= 0){
                let parentRegion = info[node.parent].region;
                if (parentRegion >= 0) regions[parentRegion].holes.push(loopPointsToArcs(node.loop));
            }
        });
        return regions;
    }

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
        if (sel.textId && v.texts && v.texts[sel.textId]){
            let text = v.texts[sel.textId];
            let box = vectorTextBounds(text);
            return {
                kind: "text",
                id: text.id,
                x: text.x + o.x,
                y: text.y + o.y,
                w: box.width,
                h: box.height,
                text: text.text || "",
                font: text.font || getDefaultFontName(),
                fontSize: text.fontSize == null ? 32 : text.fontSize,
                scale: text.scale == null ? 1 : text.scale,
                fill: text.fill || null,
                strokeColor: text.strokeColor || null,
                strokeWidth: text.strokeWidth == null ? 0 : text.strokeWidth,
                align: text.align || "left",
                editing: !!(textEdit && textEdit.id === text.id)
            };
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
    function updateSelectedText(props){
        syncEditContext();
        if (poseEditing() || readOnly) return false;
        let v = vec();
        let text = selectedText(v);
        if (!active || !v || !text || !props) return false;
        let close = !historyOpen;
        if (close) beginHistory();
        Object.assign(text, props);
        if (props.font) loadFont(props.font).then(()=>changed());
        if (close) endGesture(true);
        changed();
        return true;
    }
    me.isTextEditing = function(){
        return !!textEdit;
    };
    me.setSelectedTextFont = function(font){
        if (!font) return false;
        return updateSelectedText({ font: font });
    };
    me.setSelectedTextFontSize = function(size){
        size = Math.max(1, +size || 1);
        return updateSelectedText({ fontSize: size });
    };
    me.setSelectedTextFill = function(hex){
        if (!hex) return false;
        return updateSelectedText({ fill: hex });
    };
    me.setSelectedTextStrokeColor = function(hex){
        return updateSelectedText({ strokeColor: hex || null });
    };
    me.setSelectedTextStrokeWidth = function(width){
        width = Math.max(0, +width || 0);
        return updateSelectedText({ strokeWidth: width });
    };
    async function loadOutlineFont(fontName){
        let def = getFontDefinition(fontName);
        if (!def || !def.url) return null;
        if (fontOutlineCache.has(def.url)) return fontOutlineCache.get(def.url);
        // opentype.js is ~500KB and only needed by Convert to Shape, so it is dynamically
        // imported here instead of being part of the vector tool's own bundle.
        let [opentype, response] = await Promise.all([
            import("../lib/opentype.mjs"),
            fetch(def.url)
        ]);
        if (!response.ok) return null;
        let buffer = await response.arrayBuffer();
        let parsed = opentype.parse(buffer);
        fontOutlineCache.set(def.url, parsed);
        return parsed;
    }
    function glyphPathSvg(text, fill, stroke, width){
        let fillAttr = fill || "none";
        let strokeAttr = stroke ? ' stroke="' + stroke + '"' : "";
        let widthAttr = stroke ? ' stroke-width="' + width + '"' : "";
        let safePath = text.toPathData ? text.toPathData(5) : "";
        return '<svg xmlns="http://www.w3.org/2000/svg"><path d="' + safePath + '" fill="' + fillAttr + '"' + strokeAttr + widthAttr + '/></svg>';
    }
    me.convertSelectedTextToShape = async function(){
        syncEditContext();
        if (poseEditing() || readOnly) return false;
        let v = vec();
        let text = selectedText(v);
        if (!active || !v || !text) return false;
        let fontDef = getFontDefinition(text.font);
        if (!fontDef || !fontDef.url){
            showTextNotice("Convert to Shape needs an embeddable font file; this font has none available.");
            return false;
        }
        let font = await loadOutlineFont(text.font);
        if (!font) return false;
        if (textEdit && textEdit.id === text.id) clearTextUi();
        let renderSize = effectiveFontSize(text);
        let renderStrokeWidth = (text.strokeWidth || 0) * ((text.scale == null ? 1 : text.scale) || 1);
        let path = font.getPath(text.text || "", text.x, text.y, renderSize);
        let parsed = SVG.parse(glyphPathSvg(path, text.fill, text.strokeColor, renderStrokeWidth));
        let shapeLayer = (parsed.layers || []).find(layer=>layer.kind === "vector" && layer.vector);
        if (!shapeLayer){
            showTextNotice("Could not convert this text to vector shapes.");
            return false;
        }
        beginHistory();
        let maps = appendVector(v, shapeLayer.vector, 0, 0);
        delete v.texts[text.id];
        sel = {
            edgeId: Object.values(maps.edgeMap)[0] || null,
            nodeId: null,
            handle: null,
            regionId: Object.values(maps.regionMap)[0] || null,
            textId: null
        };
        selectedNodes.clear();
        selectedEdges = new Set(Object.values(maps.edgeMap));
        endGesture(true);
        changed();
        return true;
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

    // Rasterizes a set of stroked edges (their own widths, round caps/joins — matching strokeEdge's
    // on-screen look) into the same kind of 1-bit mask buildBlobMask produces, so "Lines to Fills"
    // (below) can trace it with the exact same contour→region pipeline the blob tool uses. `extraPolys`
    // (regions being merged into) are stamped first, exactly as buildBlobMask does for the blob brush.
    function buildEdgesMask(v, edgeIds, extraPolys){
        if (typeof document === "undefined" || !edgeIds.length) return null;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, maxR = 0.5;
        let flatByEdge = {};
        edgeIds.forEach(eid=>{
            let e = v.edges[eid];
            if (!e) return;
            let pts = flattenEdge(v, e, 0.3);
            flatByEdge[eid] = pts;
            let r = ((e.stroke && e.stroke.width) || 1) / 2;
            if (r > maxR) maxR = r;
            pts.forEach(p=>{ if (p.x<minX) minX=p.x; if (p.y<minY) minY=p.y; if (p.x>maxX) maxX=p.x; if (p.y>maxY) maxY=p.y; });
        });
        (extraPolys || []).forEach(poly=>{
            (poly.boundary || []).concat(...(poly.holes || [])).forEach(p=>{
                if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
                if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
            });
        });
        if (!isFinite(minX)) return null;
        let pad = Math.ceil(maxR) + 2;
        let ox = Math.floor(minX) - pad;
        let oy = Math.floor(minY) - pad;
        let dw = Math.ceil(maxX) + pad - ox;
        let dh = Math.ceil(maxY) + pad - oy;
        if (dw <= 0 || dh <= 0) return null;

        let scale = BLOB_SUPERSAMPLE;
        while (scale > 1 && dw * scale * dh * scale > 1.6e7) scale--;
        let w = dw * scale, h = dh * scale;
        if (w * h > 1.6e7) return null;

        let cv = document.createElement("canvas");
        cv.width = w; cv.height = h;
        let ctx = cv.getContext("2d");
        ctx.fillStyle = "#000";
        ctx.strokeStyle = "#000";
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.setTransform(scale, 0, 0, scale, -ox * scale, -oy * scale);

        (extraPolys || []).forEach(poly=>{
            if (!poly.boundary || poly.boundary.length < 3) return;
            let path = new Path2D();
            let addLoop = (loop)=>{
                path.moveTo(loop[0].x, loop[0].y);
                for (let i = 1; i < loop.length; i++) path.lineTo(loop[i].x, loop[i].y);
                path.closePath();
            };
            addLoop(poly.boundary);
            (poly.holes || []).forEach(hl=>{ if (hl.length >= 3) addLoop(hl); });
            ctx.fill(path, "evenodd");
        });

        edgeIds.forEach(eid=>{
            let pts = flatByEdge[eid];
            let e = v.edges[eid];
            if (!pts || pts.length < 2 || !e) return;
            ctx.lineWidth = Math.max((e.stroke && e.stroke.width) || 1, 1);
            ctx.beginPath();
            ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
            ctx.stroke();
        });

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

    // Everything me.drawOverlay used to draw for "the" (active) layer, generalized to ONE layer `L`
    // of scopeLayers() (spec 019) — called once per eligible layer, so a sibling's selected text/
    // region/edges/nodes/handles render exactly like the active layer's own. `isActive`/`onThisLayer`
    // pick the right selection source (selectedNodes/selectedEdges/sel vs crossSel/crossEdgeSel) and a
    // distinct highlight colour for a sibling, so it's clear which layer a drag/nudge/transform/type
    // will affect.
    function drawLayerOverlay(svg, L, s, nodeMode){
        let v = L.v;
        if (!v) return;
        let o = ImageFile.getLayerOffset(L.path);
        let isActive = isActivePath(L.path);
        let onThisLayer = sel.path && pathKey(sel.path) === pathKey(L.path);
        let accent = isActive ? "#ff5a00" : "#7fffb0";      // selected line / region tint
        let selNodeColor = isActive ? "#ffffff" : "#7fffb0"; // selected point fill

        let selectedVectorText = onThisLayer ? selectedText(v) : null;
        if (selectedVectorText){
            let box = vectorTextBounds(selectedVectorText);
            let rect = { x: box.x + o.x, y: box.y + o.y, width: box.width, height: box.height };
            svg.appendChild(svgEl("rect", {
                x: rect.x, y: rect.y, width: rect.width, height: rect.height,
                fill: "none", stroke: accent, "stroke-width": 1.4,
                "stroke-dasharray": "4 3", "vector-effect": "non-scaling-stroke"
            }));
            if (textEdit && textEdit.id === selectedVectorText.id && caretOn){
                let caretBox = vectorTextBounds(selectedVectorText, 0, null, textEdit.caretIndex);
                svg.appendChild(svgEl("line", {
                    x1: caretBox.caretX + o.x, y1: selectedVectorText.y - box.ascent + o.y,
                    x2: caretBox.caretX + o.x, y2: selectedVectorText.y + box.descent + o.y,
                    stroke: "#ffffff", "stroke-width": 1.5, "vector-effect": "non-scaling-stroke"
                }));
            }
        }

        // Selected line(s) (edge) also show their endpoint nodes, so they're visible and can be
        // grabbed/dragged individually (pick already hit-tests any node; this makes them appear).
        let edgeMultiSel = isActive ? selectedEdges : (crossEdgeSel.get(pathKey(L.path)) || new Set());
        let selEdgeSet = new Set(Array.from(edgeMultiSel).filter(id=>v.edges[id]));
        if (onThisLayer && sel.edgeId && v.edges[sel.edgeId]) selEdgeSet.add(sel.edgeId);
        let selEdgeNodeSet = null;
        if (selEdgeSet.size){
            selEdgeNodeSet = new Set();
            selEdgeSet.forEach(eid=>{ let e = v.edges[eid]; if (e){ selEdgeNodeSet.add(e.a); selEdgeNodeSet.add(e.b); } });
        }

        // A selected whole shape (region) highlights every one of its boundary + hole edges and all
        // their nodes — collect them up front so the edge/node loops below light them too.
        let regionEdgeSet = null, regionNodeSet = null;
        if (onThisLayer && sel.regionId && v.regions[sel.regionId]){
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
            strokeGuide(svg, v, e, o, selected ? accent : "rgba(0,150,255,0.7)", selected ? 1.6 : 1.0);
        }

        // bezier tangent handles: both handles of a selected edge, plus the near handle of every
        // curved edge meeting at a selected node — so clicking a curve endpoint reveals its handles
        // too. Shown whenever the edit tool has a sub-selection, never merely on layer-select.
        if (isEditMode() && !readOnly){
            activeHandlesFor(L).forEach(h=>{
                if (!h.p || !h.anchor) return;
                handleLine(svg, h.anchor, h.p, o);
                dot(svg, h.p, o, (isHoverHandle(h.edgeId, h.which, L.path) ? 5 : 3) * s, "#ffcc00");
            });
        }

        let nodeMultiSel = isActive ? selectedNodes : (crossSel.get(pathKey(L.path)) || new Set());
        for (let id in v.nodes){
            let n = v.nodes[id];
            let selected = nodeMultiSel.has(id) || (onThisLayer && id === sel.nodeId) ||
                (regionNodeSet && regionNodeSet.has(id)) || (selEdgeNodeSet && selEdgeNodeSet.has(id));
            if (!selected && !nodeMode) continue;
            let r = (selected ? (nodeMode?4:3.5) : (nodeMode?3:2.5)) * s;
            if (isHoverNode(id, L.path)) r += 2.5 * s; // enlarge the point under the cursor
            // a locked/"smooth" point (collinear handles) draws as a round dot; every other point
            // (corner / cusp) draws as a square. While a handle-drag is snapped collinear the point
            // flashes as a RED filled dot to signal "release now to lock it smooth".
            let snapping = drag && drag.kind === "handle" && drag.snapping && drag.snapNodeId === id
                && pathKey(drag.path || []) === pathKey(L.path);
            if (snapping){
                dot(svg, n, o, r + 0.5*s, "#ff2a2a");
            } else if (getNodeCurveMode(v, id) === "smooth"){
                dot(svg, n, o, r, selected ? selNodeColor : "rgba(0,150,255,0.9)");
            } else {
                square(svg, n, o, r, selected ? selNodeColor : "rgba(0,150,255,0.9)");
            }
        }
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

        // spec 019: the active layer plus every eligible sibling, each drawn exactly the same way —
        // selected text/region/edges/handles/nodes on whichever layer(s) currently hold a selection.
        scopeLayers().forEach(L=> drawLayerOverlay(svg, L, s, nodeMode));

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
            (pendingPaste.textIds || new Set()).forEach(tid=>{
                let text = v.texts && v.texts[tid];
                if (!text) return;
                let box = vectorTextBounds(text);
                svg.appendChild(svgEl("rect", {
                    x: box.x + o.x, y: box.y + o.y, width: box.width, height: box.height,
                    fill: "none", stroke: "#ff5a00", "stroke-width": 1.4,
                    "stroke-dasharray": "4 3", "vector-effect": "non-scaling-stroke"
                }));
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

    EventBus.on(EVENT.fontStyleChanged, font=>{
        if (!active || !font || !sel.textId) return;
        let props = {};
        if (font.name) props.font = font.name;
        if (font.size) props.fontSize = +font.size;
        if (Object.keys(props).length) updateSelectedText(props);
    });

    return me;
}();

export default VectorTool;
