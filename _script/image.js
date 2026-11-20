import {normalizeEasing, easingData} from "./util/easingUtils.js";
import FileDetector from "./fileformats/detect.js";
import AmigaIcon from "./fileformats/amigaIcon.js";
import EventBus from "./util/eventbus.js";
import {COMMAND,EVENT} from "./enum.js";
import Historyservice from "./services/historyservice.js";
import Layer from "./ui/layer.js";
import {normalizeEffects, activeStroke} from "./util/layerEffects.js";
import BoneDeformer from "./paintTools/boneDeformer.js";
import Modal,{DIALOG} from "./ui/modal.js";
import PanelManager from "./ui/panelManager.js";
import NativePanels from "./ui/nativePanels.js";
import {duplicateCanvas, indexPixelsToPalette, releaseCanvas} from "./util/canvasUtils.js";
import Palette from "./ui/palette.js";
import {setCurrentFileHandle, getCurrentFileHandle, getCurrentSaveFormat, getCurrentSaveOptions, hasLocalFileHandle} from "./ui/currentFileHandle.js";
import {rememberFile, rememberPreviousDocument, getPreviousDocument} from "./util/recentFiles.js";
import HistoryService from "./services/historyservice.js";
import ImageProcessing from "./util/imageProcessing.js";
import Brush from "./ui/brush.js";
import storage from "./util/storage.js";
import {DuplicateName} from "./util/textUtils.js";
import {getRecorderIfLoaded} from "./services/recorderLoader.js";
import {createEditService} from "./services/editService.js";
import {runWebGLQuantizer} from "./util/webgl-quantizer.js";
import {compositeNodes, resolveLayerPath, flatIndex, pathFromFlatIndex, isGroup, isBones, isVector, isClip, parentOf, removeAtPath, insertAtPath, moveAtPath, isLockedInTree, resolvedOffset, effectiveProps, hasGroupTransform, getOpaqueBounds, groupTransformMatrix, matIdentity, matMultiply, matTranslate, matRotate, matScale, matApply, matInvert, eligibleVectorSiblings,
    buildAttachMap, boneSkinMatrix, applyPoseOverlay, isVisibleIn} from "./util/layerUtils.js";
import {DISSOLVE_PATTERNS, DEFAULT_DISSOLVE_PATTERN, isDissolvePattern, isDissolveComparison,
    dissolveFollowsOpacity, applyDissolve} from "./util/dissolveUtils.js";
import {getDisplayMode, VECTOR_DISPLAY_MODES, appendVector, emptyVectorData, getVectorSvgShapeSources, poseVector,
    addNode, addEdge, newRegionId} from "./util/vectorUtils.js";
import {booleanCombine as booleanCombineVectors} from "./util/vectorBoolean.js";
import {timelineLength, keyAt, previousKey, nextKey, governingContentKey, contentKeys,
    propertyKeysGovernedBy, resolveTrackState, keyState, celBaseState, canInsertPropertyKey,
    canTween, insertKey, removeKey, moveKey, moveKeys} from "./util/timelineUtils.js";
import {createFrameCache, makeFrameKey, RENDER_VARIANT} from "./services/frameCache.js";
import {createExportSnapshot, iterateFrames} from "./services/exportSnapshot.js";
import {renderTimeline, rootEnv, resolveMaskFor, trackOptionsFor, resolveForRender} from "./util/timelineRender.js";
import {clipNodeIndex} from "./util/clipUtils.js";
import {clipMap, clampLength, clipUsage, validateMarkers, canPlace, forEachClipNode, resolveInstanceTime,
    normalizeCue, normalizeFrame, rangeFor, markerRanges, renameMarkerRefs, MAX_CLIP_DEPTH} from "./util/clipUtils.js";
import {configureClipRendering, clearClipCache, getClipMetrics, getClipWarnings, getClipComposite, getDeformSource, clipBounds, childEnv, instanceMatrix, instanceParts} from "./util/clipRender.js";
import {getCustomFonts, restoreCustomFonts} from "./util/fonts.js";
import {lineageIds, sanitizeLineages, checkLineages} from "./util/lineageUtils.js";
import {resolveNested, nestedTree, nestedPathAtPoint} from "./util/nestedResolve.js";
import {syntheticTracks, paramContribution, lastFrame as paramLastFrame, valueOf as paramValueOf, copyParams,
    normalizeParams, frameOf as paramFrameOf, effectiveValues as paramEffectiveValues, clearDrivenSetMemo} from "./util/paramUtils.js";
import {normalizeEntry, normalizePath, normalizeOverrides, pathSegments, walkPath, resolvedToRaw, mergeRawOuter, resolveSetTimes,
    normalizeParamValues} from "./util/overrideUtils.js";

let ImageFile = function(){
    let me = {};
    let activeLayer;
    let activeLayerIndex = 0;
    let activeLayerPath = [0];
    // The playhead. Frames are no longer physical storage: they are resolved from the
    // timeline, so this is a position in time, not an index into an array (spec 004).
    let activeFrameIndex = 0;
    let activeTrackIndex = 0;
    let cachedImage;
    // Spec 016 phase 11 (live wiring): the revision authority. Bumped at the single
    // universal cache-invalidation chokepoint (clearRenderCache), so any consumer can tell
    // whether a composite it holds is still current without enumerating every event source.
    // Used by the incremental main-display path to validate its retained composite surface.
    const editService = createEditService();
    me.editService = editService;
    // A cheap monotonic "composite inputs changed" counter. Every bumpDocumentRevision
    // increments exactly one kind by one, so the sum strictly increases on any invalidation.
    me.getCompositeRevision = function(){
        const r = editService.getDocumentRevisions();
        return r.content + r.structure + r.palette + r.mask + r.pose + r.filters + r.dimensions;
    };
    let currentFile = {
        name: "Untitled",
        layers: [],
    };
    let autoSaveTimer;

    // Renders that arrive without a timeline env (merge down, thumbnails, hit tests) still find
    // the document library and the timeline-wide smooth flag (spec 024 §3.4).
    configureClipRendering({
        library: ()=>currentFile.library,
        smooth: ()=>!!currentFile.smooth
    });

    me.getCurrentFile = function(){
        return currentFile;
    };

    // ── timeline model access ─────────────────────────────────────────────────────
    // currentFile.timeline = { fps, tracks:[ {name,visible,locked,keys:[...]} ] }
    // Track index 0 is the BOTTOM of the z-order (same convention as cel.layers).
    //
    // Edit context (spec 024 §3.7): the timeline being EDITED is either the root timeline or
    // the clip on top of `editStack`. tracks()/activeTrack()/currentFrame() resolve through
    // editTimeline(), so every editing site works inside a clip unchanged. The baking boundary
    // (getCanvas, getFrameCount, getBakedFrames, export, fps, clone/restore) always addresses
    // the ROOT. activeFrameIndex/activeTrackIndex always refer to the edit timeline.
    let editStack = [];

    function rootTimeline(){
        return currentFile.timeline;
    }

    // The clip with `id` in the document library, or undefined. A parameter context key
    // ("C3#P1", spec 026) resolves to its clip, so history records made inside a parameter
    // timeline find their clip like any other.
    function clipById(id){
        if (typeof id === "string"){
            let i = id.indexOf("#");
            if (i > 0) id = id.slice(0, i);
        }
        return clipMap(currentFile.library).get(id);
    }

    // ── clip parameters: the parameter edit context (spec 026 §3.6) ────────────────
    // Editing a parameter pushes a {kind: "param"} level on the edit stack. tracks() then returns
    // SYNTHETIC tracks (paramUtils.syntheticTracks): each clip track's governing cel pinned at
    // frame −1, then the parameter's keys BY REFERENCE — so the timeline panel, key operations,
    // the Properties panel, Free Transform and the bone tool edit the parameter without knowing it
    // exists. Structural key changes land in the synthetic arrays and are written back into
    // param.tracks by syncParamTracks() (called on every structure change).
    let paramCtx = null;    // {key, clip, param, localFrame, timeline}

    function paramOf(clip, paramId){
        return clip && Array.isArray(clip.params) ? clip.params.find(p=>p.id === paramId) : undefined;
    }

    function editParamEntry(){
        let top = editStack[editStack.length - 1];
        return top && top.kind === "param" ? top : undefined;
    }

    function contextKey(clipId, paramId){
        return paramId ? clipId + "#" + paramId : clipId;
    }

    function parseContextKey(key){
        if (typeof key === "string"){
            let i = key.indexOf("#");
            if (i > 0) return {clipId: key.slice(0, i), paramId: key.slice(i + 1)};
        }
        return {clipId: key};
    }

    // The history / edit-context key of what is being edited: null (root), a clip id, or
    // "clipId#paramId" inside a parameter timeline.
    function editContextKey(){
        let pe = editParamEntry();
        return pe ? contextKey(pe.clipId, pe.paramId) : editClipId();
    }

    function paramTimeline(clipId, paramId, localFrame){
        let clip = clipById(clipId);
        let param = paramOf(clip, paramId);
        if (!clip || !param) return undefined;
        let key = contextKey(clip.id, paramId);
        if (paramCtx && paramCtx.key === key && paramCtx.clip === clip && paramCtx.param === param
            && (typeof localFrame !== "number" || paramCtx.localFrame === localFrame)) return paramCtx.timeline;
        syncParamTracks();
        let lf = typeof localFrame === "number" ? localFrame : 0;
        ensureTrackIds(clip.timeline);
        paramCtx = {key, clip, param, localFrame: lf, timeline: {tracks: syntheticTracks(clip, param, lf), param: true}};
        return paramCtx.timeline;
    }

    function invalidateParamCtx(){
        syncParamTracks();
        paramCtx = null;
    }

    // Writes the synthetic tracks' parameter keys back into param.tracks. Tracks that show no cel
    // at the entry frame (no pinned key) keep their stored keys untouched.
    function syncParamTracks(){
        if (!paramCtx) return;
        let param = paramCtx.param;
        let tracksMap = Object.assign({}, param.tracks || {});
        paramCtx.timeline.tracks.forEach(st=>{
            if (!st.id || !(st.keys || []).some(k=>k.pinned)) return;
            let keys = st.keys.filter(k=>!k.pinned && k.type === "property" && k.frame >= 0);
            keys.forEach(k=>{ k.tween = param.type === "number"; });
            if (keys.length) tracksMap[st.id] = keys; else delete tracksMap[st.id];
        });
        param.tracks = tracksMap;
    }

    // Refuses an edit that would change the clip itself while a parameter is edited (R20, N10).
    function refuseInParam(what){
        if (!editParamEntry()) return false;
        Modal.softAlert(what + " is not available while editing a parameter: it would change the clip itself.", "Parameter");
        return true;
    }

    // A write whose target is the pinned cel (a parameter frame without a key) would edit the
    // clip's own base values: refused (R19).
    function refusePinned(key){
        if (!key || !key.pinned) return false;
        Modal.softAlert("Add a key on this parameter frame first.", "Parameter");
        return true;
    }

    // The timeline a history target / edit-stack entry addresses: null/undefined = the root.
    // A deleted clip resolves to undefined, which callers treat as a no-op (N8).
    function timelineOf(clipId){
        if (clipId === null || typeof clipId === "undefined") return rootTimeline();
        let ctx = parseContextKey(clipId);
        if (ctx.paramId){
            let pe = editParamEntry();
            let lf = pe && contextKey(pe.clipId, pe.paramId) === clipId ? pe.parentFrame : undefined;
            return paramTimeline(ctx.clipId, ctx.paramId, lf);
        }
        let clip = clipById(clipId);
        return clip ? clip.timeline : undefined;
    }

    function editClip(){
        let top = editStack[editStack.length - 1];
        return top ? clipById(top.clipId) : undefined;
    }

    function editTimeline(){
        let pe = editParamEntry();
        if (pe) return paramTimeline(pe.clipId, pe.paramId, pe.parentFrame) || {tracks: []};
        let clip = editClip();
        return clip ? clip.timeline : rootTimeline();
    }

    function tracksOf(timeline){
        return (timeline && timeline.tracks) || [];
    }

    // Stable track ids (spec 026 D10): unique within their timeline, never reused there. Clip
    // parameters store their keys per track id, so they follow a track through reorder, add and
    // delete. Assigned lazily to tracks built without one (every track constructor, restored
    // documents from before 026) and repaired when duplicated.
    function ensureTrackIds(timeline){
        let list = tracksOf(timeline);
        let max = 0;
        list.forEach(t=>{
            let n = t && typeof t.id === "string" ? parseInt(t.id.replace(/^T/, ""), 10) : NaN;
            if (Number.isFinite(n) && n > max) max = n;
        });
        let seen = new Set();
        list.forEach(t=>{
            if (!t) return;
            if (typeof t.id !== "string" || !t.id || seen.has(t.id)) t.id = "T" + (++max);
            seen.add(t.id);
        });
    }

    function ensureAllTrackIds(){
        allTimelines().forEach(ensureTrackIds);
    }

    function tracks(){
        let timeline = editTimeline();
        ensureTrackIds(timeline);
        return tracksOf(timeline);
    }

    function rootLength(){
        return timelineLength(rootTimeline());
    }

    // A clip's editable range also covers keys past its explicit length (shown out of range, R3).
    function clipEditLength(clip){
        return Math.max(clampLength(clip.length), timelineLength(clip.timeline));
    }

    function editLength(){
        let pe = editParamEntry();
        if (pe){
            let param = paramOf(clipById(pe.clipId), pe.paramId);
            return param ? paramLastFrame(param) + 1 : 1;
        }
        let clip = editClip();
        return clip ? clipEditLength(clip) : rootLength();
    }

    // The clip id the current edit context targets (null at the root) — recorded by history steps.
    function editClipId(){
        let clip = editClip();
        return clip ? clip.id : null;
    }

    // ── clip library (spec 024) ───────────────────────────────────────────────────
    // currentFile.library = { nextClipId, rev, clips: [ {id, name, length, pivot, markers,
    //                         timeline: {tracks}, rev} ] }
    // Clip ids ("C1", "C2", …) are never reused within a document. `rev` (per clip and for the
    // library) is a session-monotonic change stamp that keys the clip composite cache; it is not
    // serialized.
    let clipRevCounter = 0;

    function emptyLibrary(){
        return {nextClipId: 1, rev: 0, clips: []};
    }

    function library(){
        if (!currentFile.library) currentFile.library = emptyLibrary();
        return currentFile.library;
    }

    function hasClips(){
        return !!(currentFile.library && Array.isArray(currentFile.library.clips) && currentFile.library.clips.length);
    }

    // Marks a clip's content (or the library structure) as changed: every cached composite of the
    // clip, and of every clip that contains it (revChain), stops matching.
    function touchClip(clip){
        if (clip) clip.rev = ++clipRevCounter;
        library().rev = ++clipRevCounter;
    }

    function uniqueClipName(name, exceptId){
        let base = (typeof name === "string" && name.trim()) ? name.trim() : "Clip";
        let taken = new Set(library().clips.filter(c=>c.id !== exceptId).map(c=>c.name));
        if (!taken.has(base)) return base;
        let n = 2;
        while (taken.has(base + " " + n)) n++;
        return base + " " + n;
    }

    function clipIdNumber(id){
        let m = /^C(\d+)$/.exec(typeof id === "string" ? id : "");
        return m ? parseInt(m[1], 10) : 0;
    }

    function allocateClipId(){
        let lib = library();
        let n = Math.max(1, lib.nextClipId || 1);
        while (clipById("C" + n)) n++;
        lib.nextClipId = n + 1;
        return "C" + n;
    }

    function copyMarkers(markers){
        return (Array.isArray(markers) ? markers : []).map(m=>{
            let out = {frame: m.frame, name: m.name};
            if (typeof m.end === "number") out.end = m.end;
            return out;
        });
    }

    function libraryChanged(){
        clearRenderCache();
        cachedImage = undefined;
        EventBus.trigger(EVENT.libraryChanged);
        EventBus.trigger(EVENT.imageContentChanged);
    }

    // The env a clip's content renders with when composited on its own (thumbnails, bounds).
    function clipRenderEnv(){
        return {library: library(), depth: 0, stack: new Set(), dissolve: false, skipVectorDisplay: false};
    }

    // The track list a history record addresses by its `clipId` (spec 024 §3.13): null = the
    // root, a clip id = that clip's timeline (empty when the clip was deleted → the step is a
    // no-op), undefined (a record from before clip ids existed) = the current edit timeline.
    function trackListFor(clipId){
        if (typeof clipId === "undefined") return tracks();
        return tracksOf(timelineOf(clipId));
    }

    function activeTrack(){
        return tracks()[activeTrackIndex];
    }

    // A cel has exactly the shape of the old frame object, so the ~80 in-file uses of
    // currentFrame().layers keep working unchanged. This is the compatibility trick from
    // design 3.4: "the current frame" now means "the governing cel of the active track at
    // the playhead". Before a track's first key nothing is *rendered* (resolveTrackState
    // returns null), but editing still has to have a target, so we fall back to the
    // track's first content key — every track always has at least one.
    function currentFrame(){
        let track = activeTrack();
        if (!track) return undefined;
        let gov = governingContentKey(track, activeFrameIndex);
        if (!gov) gov = contentKeys(track)[0];
        return gov ? gov.cel : undefined;
    }

    function makeCel(layers){
        return {
            layers: layers || [],
            activeLayerIndex: 0
        };
    }

    function makeContentKey(frame,cel,tween,easing){
        return {frame: frame, type: "content", tween: !!tween, ...easingData(easing), cel: cel || makeCel()};
    }

    function makePropertyKey(frame,props,tween,easing){
        return {frame: frame, type: "property", tween: !!tween, ...easingData(easing), props: props || {}};
    }

    function makeTrack(name,cel){
        return {
            name: name || "Track 1",
            visible: true,
            locked: false,
            // when true this track is a mask for the track directly beneath it (see getCanvas)
            mask: false,
            keys: [makeContentKey(0, cel || makeCel())]
        };
    }

    // A fresh single-track timeline holding one content key per supplied cel — this is both
    // the shape a brand new file gets and the shape a migrated v1 document ends up with.
    function makeTimeline(cels,fps){
        let track = makeTrack("Track 1", cels && cels.length ? cels[0] : makeCel());
        (cels || []).slice(1).forEach((cel,i)=>{
            track.keys.push(makeContentKey(i + 1, cel));
        });
        return {fps: fps || 12, tracks: [track]};
    }

    // Every root and clip timeline of the document (layer ids are document-global, R38).
    function allTimelines(){
        let list = [];
        if (rootTimeline()) list.push(rootTimeline());
        ((currentFile.library && currentFile.library.clips) || []).forEach(clip=>{
            if (clip && clip.timeline) list.push(clip.timeline);
        });
        return list;
    }

    // Every cel of every content key of every track of ONE timeline, each visited once.
    function forEachCelIn(timeline,callback){
        tracksOf(timeline).forEach((track,trackIndex)=>{
            (track.keys || []).forEach(key=>{
                if (key.type === "content" && key.cel) callback(key.cel, key, track, trackIndex);
            });
        });
    }

    function forEachPropertyKeyIn(timeline,callback){
        tracksOf(timeline).forEach((track,trackIndex)=>{
            (track.keys || []).forEach(key=>{
                if (key.type === "property") callback(key, track, trackIndex);
            });
        });
    }

    // Every cel of every content key of every track, each visited exactly once — across the
    // root AND every clip timeline, so document-wide operations (resample, rotate, smooth,
    // id-based pruning) reach clip content too (spec 024 R40). Cels are never shared between
    // content keys (property keys only reference them), so there is no double-processing hazard.
    function forEachCel(callback){
        allTimelines().forEach(timeline=>forEachCelIn(timeline, callback));
    }

    function forEachPropertyKey(callback){
        allTimelines().forEach(timeline=>forEachPropertyKeyIn(timeline, callback));
    }

    // Re-derives activeLayer/activeLayerPath/activeLayerIndex from the governing cel.
    // Called whenever the playhead or the active track moves.
    function resolveActiveLayer(){
        let cel = currentFrame();
        if (!cel || !cel.layers || !cel.layers.length){
            activeLayer = undefined;
            activeLayerPath = [0];
            activeLayerIndex = 0;
            return;
        }
        let index = cel.activeLayerIndex || 0;
        activeLayerPath = pathFromFlatIndex(cel.layers, index) || [index];
        activeLayer = resolveLayerPath(cel.layers, activeLayerPath) || cel.layers[index] || cel.layers[0];
        if (!activeLayer){
            activeLayerPath = [0];
            activeLayer = cel.layers[0];
        }
        activeLayerIndex = flatIndex(cel.layers, activeLayerPath);
        if (activeLayerIndex < 0) activeLayerIndex = activeLayerPath[0] || 0;
    }

    // Crossing a content key: stay on the same layer lineage when the new cel continues it
    // (spec 025 R5). Otherwise the cel's own remembered activeLayerIndex (resolveActiveLayer) wins.
    function followLineage(leftCel, leftId){
        let cel = currentFrame();
        if (!leftId || !cel || cel === leftCel) return;
        let path = findPathById(cel.layers || [], leftId);
        if (!path) return;
        activeLayerPath = path;
        activeLayer = resolveLayerPath(cel.layers, path);
        activeLayerIndex = flatIndex(cel.layers, path);
        cel.activeLayerIndex = activeLayerIndex;
    }

    // Remembers the active layer on the cel we are leaving, so returning to it restores it.
    function rememberActiveLayer(){
        let cel = currentFrame();
        if (cel) cel.activeLayerIndex = activeLayerIndex;
    }

    // Normalises a layer reference to a path array. Accepts a path (number[]) as-is,
    // or a legacy flat top-level integer index → [index]. Used by all path-aware ops
    // so existing integer callers keep working while a flat tree has no groups.
    function toPath(ref){
        if (Array.isArray(ref)) return ref;
        if (typeof ref === "number") return [ref];
        return undefined;
    }

    me.addLayer = addLayer;
    me.removeLayer = removeLayer;

    me.getName = function(withoutExtension){
        let name = currentFile.name || "Untitled";
        if (withoutExtension) {
            let parts = name.split(".");
            if (parts.length > 1) {
                parts.pop();
                name = parts.join(".");
            }
        }
        return name;
    };

    me.setName = function(name){
        currentFile.name = name;
    };

    me.getOriginal = function(){
        if (!cachedImage) {
            console.error("caching image");
            cachedImage = document.createElement("canvas");
            let img = me.getCanvas();
            cachedImage.width = img.width;
            cachedImage.height = img.height;
            cachedImage.getContext("2d").drawImage(img, 0, 0);
        }
        return cachedImage;
    };

    me.restoreOriginal = function(){
        if (cachedImage) {
            // the cache is the DOCUMENT composite, so it goes back through the layer mapping
            me.drawDocCanvasOnLayer(cachedImage);
            clearRenderCache();
            EventBus.trigger(EVENT.imageContentChanged);
        }
    };

    me.getCanvasWithFilters = function(frameIndex){
        let canvas = me.getCanvas(frameIndex);
        if (!canvas) return canvas;
        if (Palette.isLockedGlobal()){
            // getCanvas() can hand back a LIVE layer canvas through the single-layer fast path,
            // and the quantizer rewrites its argument in place (forcing alpha to 255). Filtering
            // it directly would therefore destroy the layer's own transparency, so filter a copy.
            canvas = duplicateCanvas(canvas, true);
            runWebGLQuantizer(canvas, Palette.get(), false, undefined, 0, 0);
        }
        return canvas;
    }

    // The single-layer shortcut (return the layer's own canvas instead of compositing) is
    // only valid while that layer's pixels sit exactly on the document grid: one visible
    // top-level LEAF (a group must be composited so its own opacity/blendMode apply), no
    // x/y offset, full opacity and no timeline property override addressing it.
    function canUseSingleLayerFastPath(nodes, props){
        if (!nodes || nodes.length !== 1) return false;
        let only = nodes[0];
        if (!only || isGroup(only) || !only.visible) return false;
        // A clip instance is composited from its library clip (spec 024) — never a plain canvas.
        if (isClip(only)) return false;
        // A bone layer is not content — it deforms siblings; never hand it back as the whole frame.
        if (isBones(only)) return false;
        if (activeStroke(only)) return false;
        // Compare the EFFECTIVE values, not the base ones: resolveTrackState always returns
        // a full per-layer map (base values included), so the mere presence of an entry says
        // nothing. What matters is whether the layer still lands at the origin, fully opaque.
        let effective = effectiveProps(only, props);
        if (effective.x !== 0 || effective.y !== 0 || effective.opacity !== 100) return false;
        // A layer canvas is no longer guaranteed to match the document size (resize and crop
        // are non-destructive now), and getCanvas() must always hand back a document-sized
        // canvas — so a differently sized layer has to go through the compositor.
        let canvas = only.getCanvasType ? only.getCanvasType() : undefined;
        if (!canvas || canvas.width !== currentFile.width || canvas.height !== currentFile.height) return false;
        return true;
    }

    // Resolves the whole timeline at `frameIndex` (the playhead when omitted) and composites
    // every visible track bottom-to-top with its own resolved property overlay. This is the
    // baking boundary: exporters, thumbnails and the palette quantizer all go through here,
    // so tween baking comes for free and is pixel-identical to the editor preview.
    // Returns undefined for a frame outside the timeline, matching the old out-of-range
    // behaviour that callers like the icon exporters rely on (`getCanvas(1) || canvas1`).
    me.getCanvas = function(frameIndex, displayOptions){
        // The baking boundary always addresses the ROOT timeline, at the root playhead when
        // no frame is given — even while a clip is being edited (spec 024 §3.7).
        let list = tracksOf(rootTimeline());
        if (!list.length) return;
        let f = typeof frameIndex === "number" ? frameIndex : me.getRootFrameIndex();
        if (f < 0 || f >= me.getFrameCount()) return;

        // On-screen callers pass {skipVectorDisplay:true}: a "vector"-display layer is painted as a
        // true SVG overlay (canvas.js), so the raster composite must leave it out to avoid a double
        // draw. Export/thumbnail callers omit this, so the baked bitmap always includes the geometry.
        let skipVectorDisplay = !!(displayOptions && displayOptions.skipVectorDisplay);

        // Spec 016 phase 11 (incremental display): compositing INTO a caller-owned persistent
        // surface, optionally restricted to a clip rect. `target` is a document-sized canvas the
        // caller retains; `clip` (document-space {x,y,width,height}) limits the recomposite to a
        // damaged region. Clipping restricts every draw identically, so pixels inside the clip are
        // byte-for-byte the same as an unclipped composite; pixels outside are left untouched
        // (the caller's surface already holds the last full composite there). External callers
        // pass neither and get the exact previous behaviour (fresh canvas + fast paths).
        let target = displayOptions && displayOptions.target;
        let clip = displayOptions && displayOptions.clip;

        // Fast path: a lone visible track whose resolved cel is a single unshifted,
        // fully opaque leaf with no override — return that layer's canvas directly.
        // A mask track never draws itself, so it can never take this path.
        // Skipped when compositing into a caller target (we must fill that surface, not
        // hand back a live layer canvas).
        if (!target && list.length === 1 && list[0].visible && !list[0].mask){
            let state = resolveTrackState(list[0], f);
            if (state && canUseSingleLayerFastPath(state.cel.layers, state.props)){
                let only = state.cel.layers[0];
                // ...unless we must skip it on screen: then fall through so the composite draws blank.
                if (!(skipVectorDisplay && isVector(only) && getDisplayMode(only.vector) === "vector")){
                    return only.render();
                }
            }
        }

        let canvas = target || document.createElement("canvas");
        if (!target){
            canvas.width = currentFile.width;
            canvas.height = currentFile.height;
        }
        let ctx = canvas.getContext("2d");
        let clipped = false;
        if (target){
            if (clip){
                ctx.save();
                ctx.beginPath();
                ctx.rect(clip.x, clip.y, clip.width, clip.height);
                ctx.clip();
                ctx.clearRect(clip.x, clip.y, clip.width, clip.height);
                clipped = true;
            } else {
                // Full recomposite into the retained surface: clear it entirely first.
                ctx.clearRect(0, 0, canvas.width, canvas.height);
            }
        }
        // While the palette is locked, transparency is a 1-bit stencil rather than an alpha
        // blend, so the composite only ever contains real palette colours (dissolveUtils).
        // The track loop and mask isolation live in the shared renderer (spec 024 §3.3).
        renderTimeline(list, f, ctx, rootEnv({
            // Only a document that has clips pays for the clip plumbing (N7).
            library: hasClips() ? currentFile.library : undefined,
            dissolve: Palette.isLockedGlobal(),
            skipVectorDisplay: skipVectorDisplay
        }));
        if (clipped) ctx.restore();
        return canvas;
    };

    // Compositor options for the current palette state. A mask track's own composite is read
    // as a stencil (its red channel becomes alpha), so it is never dissolved.
    me.getCompositeOptions = function(){
        if (!Palette.isLockedGlobal()) return undefined;
        return {dissolve: true, originX: 0, originY: 0};
    };

    // ── incremental-display support (spec 016 phase 11) ─────────────────────────────
    // True when the current frame contains any "vector"-display layer. The on-screen
    // incremental path can only clip the raster composite safely when no vector-mode layer
    // is present (those are painted as an SVG overlay ON TOP of the raster, so a clipped raster
    // re-blit would break their z-order). When true, the caller falls back to a full present.
    me.hasVectorDisplayLayers = function(){
        let found = false;
        function walk(nodes){
            if (!nodes) return;
            nodes.forEach(n=>{
                if (isGroup(n)){ walk(n.layers); return; }
                if (isVector(n) && getDisplayMode(n.vector) === "vector") found = true;
            });
        }
        tracks().forEach(track=>{
            if (found || !track.visible || track.mask) return;
            let state = resolveTrackState(track, activeFrameIndex);
            if (state) walk(state.cel.layers);
        });
        return found;
    };

    // Map an active-layer-LOCAL damage rect to document space for the incremental clip. Returns
    // null (→ caller does a full present) whenever the mapping is not a plain integer offset:
    // a runtime group transform (rotation/scale) or a bone layer in the cel deforms pixels at
    // composite time, so the naive offset would clip the wrong region. Conservative by design —
    // never returns a rect that could under-cover the changed pixels.
    me.getActiveLayerDocRect = function(localRect){
        if (!localRect) return null;
        let track = tracks()[activeTrackIndex];
        if (!track) return null;
        let state = resolveTrackState(track, activeFrameIndex);
        if (!state) return null;
        let props = state.props;
        let nodes = state.cel.layers;
        let path = activeLayerPath;
        if (!path || !path.length) return null;
        let cur = nodes;
        for (let i=0;i<path.length;i++){
            let node = cur && cur[path[i]];
            if (!node) return null;
            let eff = effectiveProps(node, props);
            if (isGroup(node)){
                if (hasGroupTransform(eff)) return null;
                cur = node.layers;
            }
        }
        // A bone layer anywhere in the cel deforms sibling pixels non-affinely.
        let hasBones = false;
        (function scan(list){ if (!list) return; list.forEach(n=>{ if (isBones(n)) hasBones=true; else if (isGroup(n)) scan(n.layers); }); })(nodes);
        if (hasBones) return null;
        let off = resolvedOffset(nodes, path, props);
        return { x: localRect.x + off.x, y: localRect.y + off.y, width: localRect.width, height: localRect.height };
    };

    // ── mask tracks ───────────────────────────────────────────────────────────────
    // A track flagged `mask` acts exactly like a layer mask (white reveals, black conceals)
    // on the SINGLE track directly beneath it — never on tracks further down, and it is never
    // drawn as content itself. It disables itself when hidden, or on frames where it has no
    // key yet, so an unfinished mask track cannot silently blank the artwork below it.

    // True if the track at `index` is currently being masked by the one above it.
    me.isTrackMasked = function(index){
        let list = tracks();
        let track = list[index];
        if (!track || track.mask) return false;
        let above = list[index + 1];
        return !!(above && above.mask && above.visible !== false);
    };

    // ── baking / frame count ──────────────────────────────────────────────────────

    // Timeline length is implicit: one past the last key over all tracks (decision 5).
    // Always the ROOT timeline: this is what exporters bake (spec 024).
    me.getFrameCount = function(){
        return rootLength();
    };

    // Frame count of the timeline being EDITED (the root, or the clip being edited in place):
    // what the timeline panel shows and playback loops over (spec 024 §3.7).
    me.getEditFrameCount = function(){
        return editLength();
    };

    // The ROOT playhead. At the root it is the edit playhead; inside a clip it is mapped back
    // up the edit stack level by level (linear mapping follows the clip playhead, frozen
    // mapping stays at the entry frame — spec 024 §3.8).
    me.getRootFrameIndex = function(){
        return contextFrames()[0];
    };

    // Length of the timeline at edit level i (0 = the root, i = the clip of editStack[i − 1]).
    function levelLength(i){
        if (i === 0) return rootLength();
        let clip = clipById(editStack[i - 1].clipId);
        return clip ? clipEditLength(clip) : rootLength();
    }

    // The playhead of every level of the edit context: frames[0] is the root, frames[n] the clip
    // being edited (= activeFrameIndex). Mapped up level by level: a linear mapping follows the
    // clip playhead (parentAtEntry + (local − localAtEntry)); a frozen one stays at the entry
    // frame (R19). Clamped to each level's length.
    function contextFrames(){
        let frames = new Array(editStack.length + 1);
        let local = activeFrameIndex;
        frames[editStack.length] = local;
        for (let i = editStack.length - 1; i >= 0; i--){
            let entry = editStack[i];
            let mapping = entry.mapping || {};
            let parent = mapping.kind === "linear"
                ? mapping.parentAtEntry + (local - mapping.localAtEntry)
                : entry.parentFrame;
            local = Math.max(0, Math.min(levelLength(i) - 1, Math.floor(parent || 0)));
            frames[i] = local;
        }
        return frames;
    }

    // The exporter entry point: every timeline frame, fully resolved.
    me.getBakedFrames = function(){
        let result = [];
        let count = me.getFrameCount();
        for (let i = 0; i < count; i++){
            let canvas = me.getCanvas(i);
            if (canvas) result.push(canvas);
        }
        return result;
    };

    // Bounded, revision-isolated export source (spec 016 phase 10, design §9). getBakedFrames()
    // composites EVERY frame and holds the whole array at once; for a long animation that is a
    // lot of memory. This instead freezes the current document revision and hands frames out one
    // at a time through iterateExportFrames — never more than a single composite is alive, and a
    // mid-export edit is caught (revision no longer matches) instead of silently corrupting the
    // output. Returns null if the reservation cannot fit (see createExportSnapshot).
    me.createExportFrameSnapshot = function(range){
        let count = me.getFrameCount();
        let start = range && typeof range.start === "number" ? Math.max(0, range.start) : 0;
        let end = range && typeof range.end === "number" ? Math.min(count - 1, range.end) : count - 1;
        let frames = [];
        for (let i = start; i <= end; i++) frames.push({index: i, celIds: []});
        // No eager source copies: frames are composited lazily in iterateExportFrames, so the
        // snapshot only has to freeze the revision every frame must match.
        return createExportSnapshot({
            frames,
            documentRevision: me.getCompositeRevision(),
            palette: Palette.get().slice()
        });
    };

    // Async iterator of OWNED baked frames for a snapshot. Each frame is composited on demand
    // with getCanvas(), copied so the consumer owns it, and released (release()) after use. If
    // the live document changes (revision no longer matches the frozen snapshot) the iterator
    // throws, so a half-edited export is never produced. By default it releases the snapshot when
    // the iteration finishes or is abandoned.
    me.iterateExportFrames = function(snapshot, opts){
        opts = opts || {};
        let frozen = snapshot.revision;
        return iterateFrames(snapshot, {
            signal: opts.signal,
            releaseSnapshotOnDone: opts.releaseSnapshotOnDone !== false,
            evaluate: function(index){
                if (me.getCompositeRevision() !== frozen){
                    throw new Error("The document changed during export.");
                }
                let source = me.getCanvas(index);
                let copy = duplicateCanvas(source, true);
                return {
                    index,
                    frame: copy,
                    byteSize: (copy.width * copy.height * 4) | 0,
                    release(){ releaseCanvas(copy); }
                };
            }
        });
    };

    me.getFps = function(){
        return (rootTimeline() && rootTimeline().fps) || 12;
    };

    me.setFps = function(value){
        if (editStack.length) return;   // a clip has no fps of its own (D1)
        let fps = parseInt(value,10);
        if (isNaN(fps) || fps < 1) return;
        if (!rootTimeline()) return;
        rootTimeline().fps = fps;
        EventBus.trigger(EVENT.timelineChanged);
    };

    // ── per-frame composite cache ─────────────────────────────────────────────────
    // Playback and the timeline thumbnails ask for the same frames over and over; derived
    // (held/tweened) frames would otherwise be re-composited every time. Invalidated
    // wholesale — correctness first, the cache only has to make playback smooth.
    //
    // Deliberately OPT-IN: getCanvas() always composites fresh, so no exporter, quantizer or
    // script can ever be handed a stale frame just because something wrote layer pixels
    // without firing an event. Only callers that redraw on the invalidating events
    // (layerContentChanged / layersChanged / timelineChanged / imageSizeChanged) use this.
    me.getCachedCanvas = function(frameIndex){
        if (typeof frameIndex !== "number") return me.getCanvas();
        let key = bakedFrameKey(frameIndex);
        let entry = renderCache.get(key);
        if (entry) return entry.canvas;
        let canvas = me.getCanvas(frameIndex);
        if (canvas) renderCache.admit(key, wrapBakedFrame(canvas));
        return canvas;
    };

    // Spec 016 phase 8 (live wiring): the baked-composite cache behind getCachedCanvas is now
    // the bounded, byte-LRU frameCache instead of an unbounded Map. Same opt-in contract, same
    // invalidation points (clearRenderCache drops everything on a real, non-held change), same
    // shared-canvas hand-off (a cached canvas is handed straight to callers, so release() only
    // drops the reference — it must NOT shrink the canvas, matching the old GC-based drop). The
    // win is a fixed memory ceiling: a long export/playback of large frames evicts the LRU entry
    // instead of growing without bound. Frame identity is index + dimensions + variant; palette
    // lock is folded in so a locked vs unlocked composite are distinct entries. The live-display
    // (editor-raster) cache and fine-grained range invalidation stay deferred (they need the
    // per-frame revision plumbing + a present-only compositor path, tracked in the phase 8 spec).
    function bakedFrameKey(frameIndex){
        return makeFrameKey({
            frameIndex,
            variant: RENDER_VARIANT.BAKED,
            dimensions: {w: currentFile.width, h: currentFile.height},
            paletteRevision: Palette.isLockedGlobal() ? 1 : 0
        });
    }
    function wrapBakedFrame(canvas){
        return {
            canvas,
            byteSize: (canvas.width * canvas.height * 4) | 0,
            // Handed straight to callers; invalidation drops the reference and lets GC reclaim it.
            // Shrinking here (releaseCanvas) would corrupt a canvas a caller still holds.
            release(){}
        };
    }
    let renderCache = createFrameCache({budgetBytes: 64 * 1024 * 1024});
    // Moving the playhead is not a content change, but it does fire layersChanged /
    // imageContentChanged (the layer panel and the canvas must refresh). Holding the cache
    // across those keeps playback from re-compositing every derived frame on every loop.
    let cacheHold = 0;
    let contextRootRevision = 0;
    let contextFramesCache = new Map();
    let contextCacheBytes = 0;
    let contextBoundsCache = new Map();
    let contextDependencyMemo;
    const CONTEXT_CACHE_BUDGET = 32*1024*1024;

    function clearContextCache(){
        contextFramesCache.forEach(entry=>releaseCanvas(entry.canvas));
        contextFramesCache.clear();
        contextCacheBytes = 0;
        contextBoundsCache.clear();
        contextDependencyMemo = undefined;
    }

    // Cached canvases are handed straight to callers, so they must not be released here —
    // dropping the references and letting GC reclaim them is the only safe invalidation.
    function clearRenderCache(){
        // Bump the composite revision BEFORE the cacheHold gate so it advances even during
        // playback (a playhead move is a composite-input change too). This is the single
        // signal the incremental display path uses to detect that its retained surface is stale.
        editService.bumpDocumentRevision("structure");
        // Editing inside a clip changes its definition: every cached composite of it (and of
        // every clip containing it, via revChain) must stop matching (spec 024 §3.7).
        if (editStack.length && !cacheHold) touchClip(editClip());
        if (cacheHold) return;
        if (!editStack.length){
            contextRootRevision++;
            clearContextCache();
        }
        renderCache.invalidate(true); // drop every cached baked frame (same as the old Map.clear)
    }
    me.clearRenderCache = clearRenderCache;

    function holdRenderCache(fn){
        cacheHold++;
        try{
            fn();
        }finally{
            cacheHold--;
        }
    }

    me.getContext = function(){
        let active = me.getActiveLayer();
        if (active && canUseSingleLayerFastPath(currentFrame().layers) && currentFrame().layers[0] === active) {
            return active.getContext();
        }else{
            return me.getCanvas().getContext("2d");
        }
    };

    me.getActiveContext = function(){
        // A group has no paintable context; tools must no-op (see editor guard). Neither does a
        // clip instance: its pixels are its library clip's composite (spec 024 R13).
        if (activeLayer && (isGroup(activeLayer) || isClip(activeLayer))) return undefined;
        // A vector layer's pixels are a regenerated raster of its geometry — pixel tools/effects
        // must not draw into it (they would be wiped on the next render()). VectorTool edits the
        // geometry instead. Returning undefined makes the pixel tools no-op, like a group.
        if (activeLayer && isVector(activeLayer)) return undefined;
        if (activeLayer) return activeLayer.getContext();
    };

    me.getActiveLayerIndex = function(){
        return activeLayerIndex;
    };

    me.getActiveLayer = function(){
        return activeLayer;
    };

    // True if the active node is itself locked OR sits inside a locked group, OR is a
    // group (groups have no paintable canvas). Drawing/editing tools no-op when true.
    me.isActiveLayerLocked = function(){
        let frame = currentFrame();
        if (!frame) return false;
        // a parameter timeline only poses the clip's parts: no painting (spec 026 R20)
        if (editParamEntry()) return true;
        if (isGroup(activeLayer)) return true;
        // A clip instance only moves/transforms; pixel tools refuse it (spec 024 R13).
        if (isClip(activeLayer)) return true;
        return isLockedInTree(frame.layers, activeLayerPath);
    };

    me.getLayer = function(ref){
        let frame = currentFrame();
        if (!frame) return undefined;
        let path = toPath(ref);
        if (!path) return undefined;
        // legacy flat integer → top-level index
        if (path.length === 1) return frame.layers[path[0]];
        return resolveLayerPath(frame.layers, path);
    };

    // Returns the path (number[]) of the topmost opaque node at `point`, or undefined.
    // Descends into visible groups to find the topmost opaque leaf; returns a collapsed
    // group's own path when the hit lies inside it.
    // Offset-aware: each candidate's resolved offset chain is subtracted before the alpha
    // probe, and a point that falls outside a layer's own canvas is simply "not opaque
    // here" (decision 4 — nothing outside the document is selectable).
    me.getTopLayerIndexAtPoint = function(point){
        let frame = currentFrame();
        if (!frame || !point) return undefined;
        if (point.x < 0 || point.y < 0 || point.x >= currentFile.width || point.y >= currentFile.height) return undefined;
        let props = me.getResolvedProps();

        // `m` maps this node's local pixels → document space; invert it to find which local
        // pixel the document point lands on (spec 007 full inverse mapping — a click on a
        // scaled/rotated group's child still resolves to the right pixel).
        function opaqueAt(node,m){
            if (!node || !node.visible || !node.opacity) return false;
            let c = node.render(props);
            let cx = c ? c.getContext("2d",{willReadFrequently:true}) : undefined;
            if (!cx) return false;
            let local = matApply(matInvert(m), point);
            let lx = Math.floor(local.x) - (node.canvasX || 0);
            let ly = Math.floor(local.y) - (node.canvasY || 0);
            if (lx < 0 || ly < 0 || lx >= c.width || ly >= c.height) return false;
            return cx.getImageData(lx,ly,1,1).data[3] > 0;
        }

        function search(nodes, prefix, m){
            // bone attachment (spec 024): an attached node sits under its bone's rigid matrix
            let attachMap = buildAttachMap(nodes, props);
            for (let i = nodes.length - 1; i >= 0; i--){
                let node = nodes[i];
                if (!node || !node.visible || !node.opacity) continue;
                let path = prefix.concat(i);
                let effective = effectiveProps(node, props);
                let attached = attachMap && attachMap.get(node);
                let scope = attached ? matMultiply(m, attached) : m;
                let nodeMatrix = matMultiply(scope, matTranslate(effective.x, effective.y));
                if (isGroup(node) && !node.collapsed){
                    let groupMatrix = nodeMatrix;
                    if (hasGroupTransform(effective)){
                        let bounds = getOpaqueBounds(node.render(props));
                        if (bounds) groupMatrix = matMultiply(nodeMatrix, groupTransformMatrix(effective, bounds));
                    }
                    let inner = search(node.layers, path, groupMatrix);
                    if (inner) return inner;
                    // group is expanded but nothing opaque inside at this point
                    continue;
                }
                // A clip instance is a leaf: probe its composite (render() → cached local
                // composite + canvasX/Y) through the full instance matrix about its pivot.
                if (isClip(node)){
                    let clip = clipById(node.clipId);
                    if (clip && opaqueAt(node, matMultiply(scope, instanceMatrix(effective, clip.pivot)))) return path;
                    continue;
                }
                if (opaqueAt(node,nodeMatrix)) return path;
            }
            return undefined;
        }

        return search(frame.layers, [], matIdentity());
    };

    // Returns an array of paths (number[][]) for nodes whose type matches, full-tree depth-first.
    me.getLayerIndexesOfType = function(type){
        let frame = currentFrame();
        let result = [];
        if (frame) {
            (function walk(nodes, prefix){
                nodes.forEach((node, index) => {
                    let path = prefix.concat(index);
                    if (node.type === type) result.push(path);
                    if (isGroup(node)) walk(node.layers, path);
                });
            })(frame.layers, []);
        }
        return result;
    };

    me.getActiveFrameIndex = function(){
        return activeFrameIndex;
    };

    me.getActiveFrame = function(){
        return currentFrame();
    };

    me.render = function(){
        if (currentFrame().layers.length>1){

        }
    }

    me.openLocal = async function(target){
        stop();
        if (typeof window.showOpenFilePicker === "function"){
            try {
                const [handle] = await window.showOpenFilePicker({multiple: false});
                if (handle) await me.openFileHandle(handle, target || "file");
                return;
            } catch (error){
                if (error.name === "AbortError") return;
                if (!["SecurityError", "NotSupportedError"].includes(error.name)){
                    Modal.alert(error.message, "Could not open file");
                    return;
                }
            }
        }
        var input = document.createElement("input");
        input.type = "file";
        input.onchange = function (e) {
            handleUpload(e.target.files, target || "file");
        };
        input.click();
    };

    me.openFileHandle = async function(handle, target = "file"){
        try {
            if (handle.queryPermission && await handle.queryPermission({mode: "read"}) !== "granted"){
                if (await handle.requestPermission({mode: "read"}) !== "granted") return;
            }
            const file = await handle.getFile();
            handleUpload([file], target, format => {
                if (target !== "file") return;
                setCurrentFileHandle(handle, format);
                rememberFile(handle);
            });
        } catch (error){
            if (error.name !== "AbortError") Modal.alert(error.message, "Could not open file");
        }
    };

    me.openUrl = function(url,useProxy){
        stop();
        return new Promise((resolve,reject)=>{
            let fileName = url.substring(url.lastIndexOf("/")+1);
            let extension = fileName.substring(fileName.lastIndexOf(".")+1).toLowerCase();
            fetch(url).then(response=>{
                if (extension === "json"){
                    response.json().then(json=>{
                        me.handleJSON(json);
                        resolve();
                    })
                }else{
                    response.blob().then(blob=>{
                        blob.arrayBuffer().then(buffer=>{
                            me.handleBinary(buffer, fileName, "file",true);
                            resolve();
                        })
                    })
                }
            }).catch(err=>{
                if (!useProxy){
                    // probably a CORS error
                    url = "https://www.stef.be/bassoontracker/api/proxy/?"+encodeURIComponent(url);
                    me.openUrl(url,true).then(resolve).catch(reject);
                }else{
                    console.error(err);
                    reject(err);
                }
            })
        });
    }

    let saving = false;
    me.save = async function(){
        if (!hasLocalFileHandle()) return me.saveAs();
        if (saving) return;
        const handle = getCurrentFileHandle();
        const format = getCurrentSaveFormat();
        if (!format || format === "VIDEO"){
            return me.saveAs();
        }
        saving = true;
        try {
            // Ask while still in the click/key event, before loading the export module.
            if (handle.queryPermission && await handle.queryPermission({mode: "readwrite"}) !== "granted"){
                if (await handle.requestPermission({mode: "readwrite"}) !== "granted") return;
            }
            const document = currentFile;
            const Generate = (await import("./fileformats/generate.js")).default;
            if (currentFile !== document || getCurrentFileHandle() !== handle) return;
            const result = await Generate.file(format, {quality: 90, gifMode: "animation", compression: true, ...getCurrentSaveOptions()});
            if (!result?.file || result.result === "error"){
                throw new Error(result?.messages?.join("\n") || "This image cannot be saved in its original format. Use Save As.");
            }
            if (currentFile !== document || getCurrentFileHandle() !== handle) return;
            const stream = await handle.createWritable();
            try {
                await stream.write(result.file);
                await stream.close();
            } catch (error){
                try { await stream.abort(); } catch {}
                throw error;
            }
            rememberFile(handle);
            Modal.softAlert("File saved: " + handle.name);
        } catch (error){
            if (error.name !== "AbortError") Modal.alert(error.message, "Could not save file");
        } finally {
            saving = false;
        }
    };

    me.saveAs = function(){ Modal.show(DIALOG.SAVE); };

    // Non-destructive: only the document size and the top-level offsets change. Layer
    // canvases keep their pixels, so content pushed outside the new bounds stays alive and
    // is simply clipped at composite time (decision 4). Shrinking then growing restores it.
    me.resize = function(properties){
        if (!properties) {
            Modal.show(DIALOG.RESIZE);
        } else {
            cachedImage = undefined;
            HistoryService.start(EVENT.imageHistory);
            let w = properties.width;
            let h = properties.height;
            let anchor = properties.anchor || "topleft";
            let pW = currentFile.width;
            let pH = currentFile.height;
            currentFile.width = w;
            currentFile.height = h;
            let aX = Math.round((w - pW) / 2);
            let aY = Math.round((h - pH) / 2);
            if (anchor.indexOf("top") >= 0) aY = 0;
            if (anchor.indexOf("bottom") >= 0) aY = h - pH;
            if (anchor.indexOf("left") >= 0) aX = 0;
            if (anchor.indexOf("right") >= 0) aX = w - pW;
            console.log("Resizing image to " +w + "x" + h);
            shiftDocumentContent(aX,aY);
            HistoryService.end();
            clearRenderCache();
            EventBus.trigger(EVENT.imageSizeChanged);
        }
    };

    // Moves every top-level node of every cel, and every property-key x/y, by (dx,dy).
    // Nested children are NOT touched: they are positioned inside their group's scope, which
    // moves with the group.
    function shiftDocumentContent(dx,dy){
        if (!dx && !dy) return;
        // Only the ROOT timeline moves: clip content lives in clip-local space, which a crop of
        // the document does not touch (spec 024 R40) — its instances move with the root.
        forEachCelIn(rootTimeline(), cel=>{
            cel.layers.forEach(node=>{
                node.x = (node.x || 0) + dx;
                node.y = (node.y || 0) + dy;
            });
        });
        forEachPropertyKeyIn(rootTimeline(), (key,track)=>{
            let topLevelIds = new Set();
            let gov = governingContentKey(track, key.frame);
            ((gov && gov.cel && gov.cel.layers) || []).forEach(node=>{ if (node.id) topLevelIds.add(node.id); });
            Object.keys(key.props || {}).forEach(id=>{
                if (!topLevelIds.has(id)) return;
                let entry = key.props[id];
                if (typeof entry.x === "number") entry.x += dx;
                if (typeof entry.y === "number") entry.y += dy;
            });
        });
    }

    // Crop: the same non-destructive shift, with the document origin moving to (x,y).
    me.crop = function(x,y,w,h){
        cachedImage = undefined;
        HistoryService.start(EVENT.imageHistory);
        currentFile.width = w;
        currentFile.height = h;
        shiftDocumentContent(-x,-y);
        HistoryService.end();
        clearRenderCache();
        EventBus.trigger(EVENT.imageSizeChanged);
    };

    me.resample = function(properties){
        if (!properties) {
            Modal.show(DIALOG.RESAMPLE);
        } else {
            cachedImage = undefined;
            let w = properties.width;
            let h = properties.height;
            if (w === currentFile.width && h === currentFile.height) return;
            let quality = properties.quality || "pixelated";
            HistoryService.start(EVENT.imageHistory);
            let scaleX = w / currentFile.width;
            let scaleY = h / currentFile.height;
            currentFile.width = w;
            currentFile.height = h;
            // Offsets live in document space, so they scale with the document. Every cel's
            // layer tree and every property key's x/y follow the same factor.
            forEachCel(cel=>{
                (function walk(nodes){
                    nodes.forEach(node=>{
                        node.x = Math.round((node.x || 0) * scaleX);
                        node.y = Math.round((node.y || 0) * scaleY);
                        // Bone rest coords live in scope space (like the artwork they deform), so
                        // they scale with the document. Length/radius have no separate axis, so a
                        // non-uniform resample approximates them with the X factor (uniform is exact).
                        if (isBones(node) && node.armature) scaleArmature(node.armature, scaleX, scaleY);
                        if (isGroup(node) && Array.isArray(node.layers)) walk(node.layers);
                    });
                })(cel.layers);
            });
            forEachPropertyKey(key=>{
                Object.keys(key.props || {}).forEach(id=>{
                    let entry = key.props[id];
                    if (typeof entry.x === "number") entry.x = Math.round(entry.x * scaleX);
                    if (typeof entry.y === "number") entry.y = Math.round(entry.y * scaleY);
                    // Bone pose translations live in scope space like the rest geometry, so they
                    // scale with the document too (angle/scale are dimensionless; not rounded —
                    // the deformer resamples). Matches scaleArmature() for the base pose.
                    if (entry.bones){
                        Object.keys(entry.bones).forEach(bid=>{
                            let bp = entry.bones[bid];
                            if (typeof bp.x === "number") bp.x *= scaleX;
                            if (typeof bp.y === "number") bp.y *= scaleY;
                        });
                    }
                });
            });
            // Override x/y and bone x/y deltas live in the target's parent space, which scales with
            // the document too — absolute and relative alike (spec 025 R41).
            forEachOverride(rec=>{
                let map = clonePlainData(rec.map);
                Object.keys(map).forEach(p=>{
                    let e = map[p];
                    if (!e) return;
                    if (typeof e.x === "number") e.x *= scaleX;
                    if (typeof e.y === "number") e.y *= scaleY;
                    if (e.bones) Object.keys(e.bones).forEach(bid=>{
                        let bp = e.bones[bid];
                        if (typeof bp.x === "number") bp.x *= scaleX;
                        if (typeof bp.y === "number") bp.y *= scaleY;
                    });
                });
                rec.set(map);
            });
            // ...and so do x/y and bone x/y in parameter keys (spec 026 R24)
            forEachParamKey(k=>{
                Object.keys(k.props || {}).forEach(id=>{
                    let e = k.props[id];
                    if (!e) return;
                    if (typeof e.x === "number") e.x = Math.round(e.x * scaleX);
                    if (typeof e.y === "number") e.y = Math.round(e.y * scaleY);
                    if (e.bones) Object.keys(e.bones).forEach(bid=>{
                        let bp = e.bones[bid];
                        if (typeof bp.x === "number") bp.x *= scaleX;
                        if (typeof bp.y === "number") bp.y *= scaleY;
                    });
                });
            });
            clearDrivenSetMemo();
            // Clip pivots live in clip-local space, which scales with the document (R40).
            library().clips.forEach(clip=>{
                clip.pivot = {x: clip.pivot.x * scaleX, y: clip.pivot.y * scaleY};
            });
            clearClipCache();
            clearRenderCache();
            let todo = 0;
            let done = 0;
            let leaves = [];
            forEachCel(cel=>{
                (function walk(nodes){
                    nodes.forEach(node=>{
                        if (isGroup(node)){
                            // the group canvas is a scratch buffer at the OLD document size:
                            // drop it so render() rebuilds it at the new one
                            if (node.invalidateCache) node.invalidateCache();
                            walk(node.layers || []);
                        }else if (!isClip(node)){
                            // a clip instance has no pixels: its clip's own cels are leaves here
                            leaves.push(node);
                        }
                    });
                })(cel.layers);
            });
            todo = leaves.length;
            if (!todo){
                HistoryService.end();
                EventBus.trigger(EVENT.imageSizeChanged);
                return;
            }

            [leaves].forEach(() => {
                leaves.forEach((layer) => {
                    let canvas = layer.getCanvas();
                    let ctx = layer.getContext();
                    // Crop/canvas resize preserve the layer's backing canvas. Scale its
                    // own dimensions, rather than fitting those hidden pixels to the document.
                    let w = Math.max(1, Math.round(canvas.width * scaleX));
                    let h = Math.max(1, Math.round(canvas.height * scaleY));
                    layer.canvasX = Math.round((layer.canvasX || 0) * scaleX);
                    layer.canvasY = Math.round((layer.canvasY || 0) * scaleY);
                    if (layer.invalidateCache) layer.invalidateCache();

                    if (quality === "pixelated") {
                        let d = duplicateCanvas(canvas, true);
                        canvas.width = w;
                        canvas.height = h;
                        ctx.webkitImageSmoothingEnabled = false;
                        ctx.mozImageSmoothingEnabled = false;
                        ctx.imageSmoothingEnabled = false;
                        ctx.drawImage(d, 0, 0, d.width, d.height, 0, 0, w, h);
                        releaseCanvas(d);
                        done++;
                        if (done >= todo) {
                            HistoryService.end();
                            clearRenderCache();
                            EventBus.trigger(EVENT.imageSizeChanged);
                        }
                    } else {
                        let imageData = ctx.getImageData(
                            0,
                            0,
                            canvas.width,
                            canvas.height
                        );
                        let result;
                        if (imageData.width > w && imageData.height > h) {
                            result = ImageProcessing.downScale(imageData, w, h);
                        } else {
                            result = ImageProcessing.biCubic(imageData, w, h);
                        }
                        canvas.width = w;
                        canvas.height = h;
                        ctx.putImageData(result, 0, 0);
                        done++;
                        if (done >= todo) {
                            HistoryService.end();
                            clearRenderCache();
                            EventBus.trigger(EVENT.imageSizeChanged);
                        }
                    }
                });
            });
            clearClipCache();
        }
    };

    me.activateLayer = function(ref){
        let frame = currentFrame();
        let path = toPath(ref) || [0];
        let layer = path.length === 1 ? frame.layers[path[0]] : resolveLayerPath(frame.layers, path);
        if (!layer){
            // path no longer resolves (e.g. after a structural change) → fall back to root 0
            path = [0];
            layer = frame.layers[0];
        }
        activeLayerPath = path;
        activeLayer = layer;
        activeLayerIndex = flatIndex(frame.layers, path);
        if (activeLayerIndex < 0) activeLayerIndex = path[0] || 0;
        // Persist onto the cel so a later resolveActiveLayer() (playhead/track move, keyframe add)
        // restores THIS layer instead of reverting to the stale cel.activeLayerIndex (index 0).
        if (frame) frame.activeLayerIndex = activeLayerIndex;
        // a nested focus belongs to its instance: selecting anything else drops it (spec 025 R20)
        if (nestedFocus && (!layer || layer.id !== nestedFocus.instanceId)) clearNestedFocus();
        EventBus.trigger(EVENT.layersChanged);
    };

    me.getActiveLayerPath = function(){
        return activeLayerPath;
    };

    me.toggleLayer = function(ref){
        let layer = me.getLayer(ref);
        if (!layer) return;
        layer.visible = !layer.visible;
        EventBus.trigger(EVENT.layersChanged);
        EventBus.trigger(EVENT.imageContentChanged);
    };

    me.toggleLayerLock = function(ref){
        let layer = me.getLayer(ref);
        if (!layer) return;
        layer.locked = !layer.locked;
        EventBus.trigger(EVENT.layersChanged);
    };

    me.duplicateLayer = function(ref){
        if (refuseInParam("Duplicating a layer")) return;
        let path = typeof ref === "undefined" ? activeLayerPath : toPath(ref);
        if (!path) return;
        let frame = currentFrame();
        let p = parentOf(frame.layers, path);
        let layer = resolveLayerPath(frame.layers, path) || (path.length===1 ? frame.layers[path[0]] : undefined);
        if (!p || !layer) return;

        let newName = DuplicateName(layer.name, p.parent);
        // The copy is an independent node set (fresh ids), so it carries none of the source's
        // property-key overrides: every branch below bakes the values resolved at the playhead
        // into the copy's own base values, or the duplicate of an animated/moved layer lands
        // somewhere other than where the user sees the original.
        let resolvedProps = me.getResolvedProps();

        if (isGroup(layer)){
            // deep-copy the whole subtree via clone/restore (async), like duplicateFrame
            let newLayer = Layer.makeGroup(currentFile.width, currentFile.height, newName);
            let struct = withResolvedProps(withFreshIds(layer.clone(false)), layer, resolvedProps);
            struct.name = newName;
            let insertPath = path.slice();
            insertPath[insertPath.length-1] = p.index + 1;
            insertAtPath(frame.layers, insertPath, newLayer);
            me.activateLayer(insertPath);
            // returns a Promise so callers can sequence history capture after the deep copy
            return newLayer.restore(struct).then(()=>{
                // attachments inside the copy follow the copy's own bone layers (spec 024)
                remapAttachIds(newLayer.layers, copyIdMap(layer.layers, newLayer.layers));
                EventBus.trigger(EVENT.layerContentChanged);
            });
        }

        if (layer.type === "vector" || layer.type === "bone" || layer.type === "clip"){
            // These carry editable geometry/armature instead of pixels: the quick canvas-copy
            // path below would rasterize them into a plain pixel layer, silently dropping the
            // type. Deep-copy the whole struct via clone/restore (async) so the duplicate stays
            // the same kind of layer, exactly like the group branch above.
            let newLayer = Layer(currentFile.width, currentFile.height, newName);
            let struct = withResolvedProps(withFreshIds(layer.clone(false)), layer, resolvedProps);
            struct.name = newName;
            let insertPath = path.slice();
            insertPath[insertPath.length-1] = p.index + 1;
            insertAtPath(frame.layers, insertPath, newLayer);
            // restore() sets me.type ("vector"/"bone") — activate only AFTER it, so the layer-panel
            // rebuild (triggered by activateLayer → layersChanged) reads the correct type and draws
            // the right type icon. Activating first rendered the row while it was still the default
            // pixel type (square icon), only corrected on the next rebuild (e.g. a visibility toggle).
            return newLayer.restore(struct).then(()=>{
                me.activateLayer(insertPath);
                EventBus.trigger(EVENT.layerContentChanged);
            });
        }

        // The source canvas is not necessarily document-sized or document-aligned: crop/resize are
        // non-destructive and ensureLocalRect() grows the canvas (moving canvasX/canvasY) when
        // something is painted outside it. Reproduce that geometry on the copy — a document-sized
        // canvas with the source drawn at 0,0 shifted the pixels by the canvas origin, so
        // duplicating a layer that had been moved and painted on came out offset (and anything
        // sticking out past the document was clipped away).
        // getCanvasType(false) is the raw pixel canvas: getCanvas() hands back the MASK while the
        // mask is being edited, which would copy the mask into the duplicate's pixels.
        let source = layer.getCanvasType(false);
        let effective = effectiveProps(layer, resolvedProps);
        let newLayer = Layer(
            source.width,
            source.height,
            newName
        );
        newLayer.opacity = effective.opacity;
        newLayer.blendMode = layer.blendMode;
        newLayer.locked = layer.locked;
        newLayer.x = effective.x;
        newLayer.y = effective.y;
        newLayer.canvasX = layer.canvasX || 0;
        newLayer.canvasY = layer.canvasY || 0;
        newLayer.getContext().drawImage(source,0,0);
        let insertPath = path.slice();
        insertPath[insertPath.length-1] = p.index + 1;
        insertAtPath(frame.layers, insertPath, newLayer);
        me.activateLayer(insertPath);
    };

    me.flipLayer = function(index, horizontal){
        if (typeof index !== "number") index = activeLayerIndex;
        let layer = currentFrame().layers[index];
        if (layer) {
            let canvas = duplicateCanvas(layer.getCanvas(), true);
            let ctx = layer.getContext();
            layer.clear();
            if (horizontal) {
                ctx.translate(canvas.width, 0);
                ctx.scale(-1, 1);
            }else{
                ctx.translate(0, canvas.height);
                ctx.scale(1, -1);
            }
            ctx.drawImage(canvas, 0, 0);
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            releaseCanvas(canvas);

            EventBus.trigger(EVENT.layerContentChanged);
        }
    }

    me.removeStrayPixels = function(index){
        if (typeof index !== "number") index = activeLayerIndex;
        let layer = currentFrame().layers[index];
        if (layer) {
            let canvas = layer.getCanvas();
            let ctx = layer.getContext();
            let w = canvas.width;
            let h = canvas.height;
            let imgData = ctx.getImageData(0, 0, w, h);
            let data = imgData.data;

            let visited = new Uint8Array(w * h);

            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    let i = y * w + x;
                    if (visited[i]) continue;

                    if (data[i * 4 + 3] === 0) {
                        visited[i] = 1;
                        continue;
                    }

                    let q = [i];
                    let cluster = [i];
                    visited[i] = 1;

                    let minX = x;
                    let maxX = x;
                    let minY = y;
                    let maxY = y;

                    let head = 0;
                    while(head < q.length) {
                        let curr = q[head++];
                        let cx = curr % w;
                        let cy = Math.floor(curr / w);

                        if (cx < minX) minX = cx;
                        if (cx > maxX) maxX = cx;
                        if (cy < minY) minY = cy;
                        if (cy > maxY) maxY = cy;

                        for (let ny = cy - 1; ny <= cy + 1; ny++) {
                            for (let nx = cx - 1; nx <= cx + 1; nx++) {
                                if (nx === cx && ny === cy) continue;
                                if (nx >= 0 && ny >= 0 && nx < w && ny < h) {
                                    let ni = ny * w + nx;
                                    if (!visited[ni] && data[ni * 4 + 3] > 0) {
                                        visited[ni] = 1;
                                        q.push(ni);
                                        cluster.push(ni);
                                    }
                                }
                            }
                        }
                    }

                    let clusterWidth = maxX - minX + 1;
                    let clusterHeight = maxY - minY + 1;

                    if (clusterWidth < 12 && clusterHeight < 12) {
                        for (let j = 0; j < cluster.length; j++) {
                            let ci = cluster[j];
                            data[ci * 4 + 0] = 0;
                            data[ci * 4 + 1] = 0;
                            data[ci * 4 + 2] = 0;
                            data[ci * 4 + 3] = 0;
                        }
                    }
                }
            }

            ctx.putImageData(imgData, 0, 0);
            EventBus.trigger(EVENT.layerContentChanged);
        }
    }

    // Opacity is an animatable property now, so it goes through the same key targeting as
    // x/y instead of writing the layer's base value directly.
    me.setLayerOpacity = function(value){
        if (!activeLayer) return;
        me.setLayerKeyProps(undefined,{opacity: value});
    };

    me.setLayerBlendMode = function(value){
        if (activeLayer) {
            activeLayer.blendMode = value;
            clearRenderCache();
            EventBus.trigger(EVENT.imageContentChanged);
        }
    };

    // ── coordinate mapping (document space ⇄ layer-local pixels) ──────────────────

    // The resolved property overlay of the ACTIVE track at the playhead. This is what the
    // user currently sees, so pointer mapping and hit testing must use it (and not the cel
    // base values) for edits to land under the cursor on a tweened frame.
    me.getResolvedProps = function(){
        let track = activeTrack();
        if (!track) return undefined;
        let state = resolveTrackState(track, activeFrameIndex);
        return state ? state.props : undefined;
    };

    // Cumulative offset of a layer (default: the active layer) including its ancestor
    // groups, with the resolved overlay applied. TRANSLATION ONLY — for the general case
    // (a layer nested under a scaled/rotated group) use getLayerMatrix instead.
    me.getLayerOffset = function(ref){
        let frame = currentFrame();
        if (!frame) return {x:0,y:0};
        let path = typeof ref === "undefined" ? activeLayerPath : toPath(ref);
        if (!path) return {x:0,y:0};
        return resolvedOffset(frame.layers, path, me.getResolvedProps());
    };

    // Document coordinates → pixels of the layer's OWN canvas (what getCanvas()/getContext()
    // address): the resolved offset above PLUS the canvas origin. A layer's canvas is NOT pinned
    // to the layer origin — ensureLocalRect() grows it and moves canvasX/canvasY (negative when it
    // grows up/left) as soon as something is painted outside it, which is exactly what happens
    // once a layer has been moved and you keep painting on it. So code that draws a
    // document-space shape straight into getContext() must subtract THIS, not getLayerOffset():
    // forgetting the canvas origin shifts the result by it. TRANSLATION ONLY, like getLayerOffset.
    me.getLayerCanvasOffset = function(ref){
        let offset = me.getLayerOffset(ref);
        let layer = typeof ref === "undefined" ? activeLayer : me.getLayer(ref);
        if (!layer) return offset;
        return {
            x: offset.x + (layer.canvasX || 0),
            y: offset.y + (layer.canvasY || 0)
        };
    };

    // Spec 018: every OTHER vector layer sharing `ref`'s immediate parent group that is visible and
    // not locked — the candidate set for cross-layer vector selection. Re-resolved fresh on every
    // call (never cached), so a visibility/lock toggle takes effect on the very next gesture.
    me.getEligibleVectorSiblings = function(ref){
        let frame = currentFrame();
        let path = typeof ref === "undefined" ? activeLayerPath : toPath(ref);
        if (!frame || !path) return [];
        return eligibleVectorSiblings(frame.layers, path);
    };

    // The full local→document affine matrix for a layer, folding in every ancestor group's
    // offset AND runtime transform (spec 007 decision 2 — full inverse mapping). For a plain
    // layer with no transformed ancestor this reduces to a pure translation, identical to
    // getLayerOffset, so the untransformed common path is unchanged and cheap (the opaque-bounds
    // scan only runs for a group that actually carries a non-identity transform).
    me.getLayerMatrix = function(ref){
        let frame = currentFrame();
        if (!frame) return matIdentity();
        let path = typeof ref === "undefined" ? activeLayerPath : toPath(ref);
        if (!path || !path.length) return matIdentity();
        let props = me.getResolvedProps();
        let m = matIdentity();
        let current = frame.layers;
        for (let i = 0; i < path.length; i++){
            let node = current && current[path[i]];
            if (!node) break;
            let effective = effectiveProps(node, props);
            let attachMap = node.attach ? buildAttachMap(current, props) : undefined;
            let attached = attachMap && attachMap.get(node);
            if (attached) m = matMultiply(m, attached);
            if (isClip(node)){
                // clip-local → parent: translate + rotate/scale about the clip pivot (D2)
                let clip = clipById(node.clipId);
                m = matMultiply(m, clip ? instanceMatrix(effective, clip.pivot) : matTranslate(effective.x, effective.y));
                break;
            }
            m = matMultiply(m, matTranslate(effective.x, effective.y));
            if (isGroup(node)){
                if (hasGroupTransform(effective)){
                    let bounds = getOpaqueBounds(node.render(props));
                    if (bounds) m = matMultiply(m, groupTransformMatrix(effective, bounds));
                }
                current = node.layers;
            }else{
                break;
            }
        }
        return m;
    };

    // Document coordinates → layer-local pixels for the target layer. Tools keep working in
    // document space; this is the single mapping applied before they touch a layer.
    me.docToLayer = function(point,ref){
        if (!point) return point;
        return matApply(matInvert(me.getLayerMatrix(ref)), point);
    };

    // Inverse of docToLayer.
    me.layerToDoc = function(point,ref){
        if (!point) return point;
        return matApply(me.getLayerMatrix(ref), point);
    };

    // The active layer's pixels projected into DOCUMENT space: a document-sized canvas with
    // the layer drawn through its resolved matrix. Selection, flood fill and colour select all
    // reason in document coordinates, so this is what they must read. When the layer already
    // sits on the document grid (identity matrix) its own canvas is returned unchanged (no copy).
    me.getActiveLayerDocCanvas = function(ref){
        let layer = typeof ref === "undefined" ? activeLayer : me.getLayer(ref);
        if (!layer) return undefined;
        let source = layer.getCanvas();
        let m = me.getLayerMatrix(ref);
        let canvasX = layer.canvasX || 0;
        let canvasY = layer.canvasY || 0;
        let identity = m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && !m.e && !m.f && !canvasX && !canvasY;
        if (identity && source.width === currentFile.width && source.height === currentFile.height){
            return source;
        }
        let canvas = document.createElement("canvas");
        canvas.width = currentFile.width;
        canvas.height = currentFile.height;
        let ctx = canvas.getContext("2d",{willReadFrequently:true});
        ctx.imageSmoothingEnabled = false;
        ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
        ctx.drawImage(source, canvasX, canvasY);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        return canvas;
    };

    // The write-back counterpart of getActiveLayerDocCanvas: draws a DOCUMENT-space canvas into
    // a layer's own canvas, mapping document coordinates to canvas pixels through
    // getLayerCanvasOffset. Whole-image operations (colour reduce, restore-original) produce a
    // document-space result; drawing it at 0,0 put it at the layer's canvas origin instead of on
    // the document window, so on a layer that had been moved the picture came back shifted.
    // Only the area the canvas covers is replaced, so pixels the layer keeps outside the document
    // window survive. Translation only — a layer under a scaled/rotated group is not resampled
    // back (same v1 limitation as getLayerOffset); groups and vector layers have no paintable
    // canvas and are skipped, exactly like getActiveContext().
    me.drawDocCanvasOnLayer = function(canvas,ref){
        if (!canvas) return false;
        let layer = typeof ref === "undefined" ? activeLayer : me.getLayer(ref);
        if (!layer || isGroup(layer) || isVector(layer)) return false;
        let offset = me.getLayerCanvasOffset(ref);
        let ctx = layer.getContext();
        if (!ctx) return false;
        ctx.clearRect(-offset.x, -offset.y, canvas.width, canvas.height);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(canvas, -offset.x, -offset.y);
        return true;
    };

    // Bounding box of the layer's opaque pixels, in DOCUMENT coordinates.
    me.getLayerBoundingRect = function(layerIndex){
        let layer = activeLayer;
        let ref = layerIndex;
        if (typeof layerIndex === "number") {
            layer = currentFrame().layers[layerIndex];
        }else{
            ref = undefined;
        }
        if (!layer) return {x:0,y:0,w:0,h:0};

        let ctx = layer.getContext();
        let canvas = ctx.canvas;
        let w = canvas.width,
            h = canvas.height,
            pix = { x: [], y: [] },
            imageData = ctx.getImageData(0, 0, canvas.width, canvas.height),
            x,
            y,
            index;

        for (y = 0; y < h; y++) {
            for (x = 0; x < w; x++) {
                index = (y * w + x) * 4;
                if (imageData.data[index + 3] > 0) {
                    pix.x.push(x);
                    pix.y.push(y);
                }
            }
        }
        pix.x.sort(function (a, b) {
            return a - b;
        });
        pix.y.sort(function (a, b) {
            return a - b;
        });
        let n = pix.x.length - 1;
        if (n < 0) return { x: 0, y: 0, w: 0, h: 0 };

        w = 1 + pix.x[n] - pix.x[0];
        h = 1 + pix.y[n] - pix.y[0];

        // Project the local opaque box into document space through the layer's full matrix, then
        // take the axis-aligned bounding box of the (possibly rotated) result. For a layer with
        // no transformed ancestor the matrix is a pure translation, so this returns exactly the
        // old {x+offset, y+offset, w, h}. Corners rounded outward to whole pixels.
        let m = me.getLayerMatrix(ref);
        let x0 = pix.x[0] + (layer.canvasX || 0), y0 = pix.y[0] + (layer.canvasY || 0);
        let corners = [
            {x: x0,     y: y0},
            {x: x0 + w, y: y0},
            {x: x0,     y: y0 + h},
            {x: x0 + w, y: y0 + h}
        ].map(p => matApply(m, p));
        let minX = Math.min(corners[0].x, corners[1].x, corners[2].x, corners[3].x);
        let maxX = Math.max(corners[0].x, corners[1].x, corners[2].x, corners[3].x);
        let minY = Math.min(corners[0].y, corners[1].y, corners[2].y, corners[3].y);
        let maxY = Math.max(corners[0].y, corners[1].y, corners[2].y, corners[3].y);
        minX = Math.floor(minX); minY = Math.floor(minY);
        maxX = Math.ceil(maxX);  maxY = Math.ceil(maxY);
        return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    };

    // Moves the playhead. The governing cel (and with it the layer panel and every editing
    // target) is re-resolved for the new position.
    me.activateFrame = function(index){
        let count = editLength();
        if (typeof index !== "number" || isNaN(index)) index = 0;
        if (index < 0) index = 0;
        if (index >= count) index = count - 1;
        rememberActiveLayer();
        let leftCel = currentFrame();
        let leftId = activeLayer && activeLayer.id;
        activeFrameIndex = index;
        cachedImage = undefined;
        resolveActiveLayer();
        followLineage(leftCel, leftId);
        holdRenderCache(()=>{
            EventBus.trigger(EVENT.layersChanged);
            EventBus.trigger(EVENT.imageContentChanged);
            EventBus.trigger(EVENT.framesChanged);
        });
    };

    me.nextFrame = function(offset){
        offset = offset || 1;
        let count = editLength();
        let frame = activeFrameIndex + offset;
        if (frame < 0) frame = count - 1;
        if (frame >= count) frame = 0;
        me.activateFrame(frame);
    }

    // ── tracks ────────────────────────────────────────────────────────────────────

    me.getActiveTrackIndex = function(){
        return activeTrackIndex;
    };

    me.getActiveTrack = function(){
        return activeTrack();
    };

    me.getTracks = function(){
        return tracks();
    }

    // The timeline a clip id addresses (null = the root, a deleted clip = undefined). Exposed for
    // history resolution tests and edit-context consumers (spec 024 §3.13).
    me.getTimelineOf = function(clipId){
        return timelineOf(clipId);
    };

    // ── clip library API (spec 024 §3.7) ──────────────────────────────────────────

    me.getLibrary = function(){
        return library();
    };

    me.getClip = function(id){
        return clipById(id);
    };

    // Instance occurrences of clip `id` across the root and every clip timeline (R5).
    me.getClipUsage = function(id){
        return clipUsage(rootTimeline(), library()).get(id) || 0;
    };

    // Content bounds of a clip at local time t, in clip-local space ({x,y,w,h} or null).
    me.getClipBounds = function(id, t){
        let clip = clipById(id);
        if (!clip) return null;
        return clipBounds(clip, t || 0, childEnv(clipRenderEnv(), clip));
    };

    // The clip composited on its own at local time t: {canvas, x, y} in clip-local space, or null.
    // The canvas is a shared cache entry — read only.
    me.getClipComposite = function(id, t){
        let clip = clipById(id);
        if (!clip) return null;
        return getClipComposite(clip, t || 0, clipRenderEnv());
    };

    // A size×size thumbnail of the clip at local frame 0 (R5), fitted and centred.
    me.getClipThumbnail = function(id, size){
        size = size || 32;
        let canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        let composite = me.getClipComposite(id, 0);
        if (composite){
            let c = composite.canvas;
            let scale = Math.min(size / c.width, size / c.height, 1);
            let w = Math.max(1, Math.round(c.width * scale));
            let h = Math.max(1, Math.round(c.height * scale));
            let ctx = canvas.getContext("2d");
            ctx.imageSmoothingEnabled = scale < 1;
            ctx.drawImage(c, Math.floor((size - w) / 2), Math.floor((size - h) / 2), w, h);
        }
        return canvas;
    };

    me.getClipMetrics = function(){
        return getClipMetrics();
    };

    // Lineage invariant problems in the live document (spec 025 R2): [] when sane. Diagnostic and
    // test helper.
    me.checkLineages = function(){
        return checkLineages(allTimelines());
    };

    me.getClipWarnings = function(){
        return getClipWarnings();
    };

    // Creates a clip. Without `opts.tracks` it gets one track holding one empty layer. The pivot
    // defaults to the centre of the content bounds (the document centre for empty content) and
    // is never recomputed afterwards (D2). The caller owns the history step. Returns the clip.
    function addClip(name, opts){
        opts = opts || {};
        let tracksList = opts.tracks || [makeTrack("Track 1",
            makeCel([Layer(currentFile.width, currentFile.height, "Layer 1")]))];
        let timeline = {tracks: tracksList};
        let clip = {
            id: allocateClipId(),
            name: uniqueClipName(name),
            length: clampLength(typeof opts.length === "number" ? opts.length : timelineLength(timeline)),
            pivot: {x: Math.round(currentFile.width / 2), y: Math.round(currentFile.height / 2)},
            markers: copyMarkers(opts.markers),
            timeline: timeline,
            rev: ++clipRevCounter
        };
        library().clips.push(clip);
        ensureTrackIds(timeline);
        touchClip(clip);
        if (opts.pivot){
            clip.pivot = {x: opts.pivot.x, y: opts.pivot.y};
        }else{
            // The centre of what is actually painted at local frame 0 (read once, at creation).
            let composite = me.getClipComposite(clip.id, 0);
            let opaque = composite ? getOpaqueBounds(composite.canvas) : null;
            if (opaque) clip.pivot = {
                x: Math.round(composite.x + opaque.x + opaque.w / 2),
                y: Math.round(composite.y + opaque.y + opaque.h / 2)
            };
        }
        return clip;
    }

    me.createClip = function(name, opts){
        HistoryService.start(EVENT.libraryHistory);
        let clip = addClip(name, opts);
        HistoryService.end();
        libraryChanged();
        return clip;
    };

    // Import an image as a one-frame library clip without changing the open document.
    me.importClipFromImage = function(image, name){
        if (!image || !image.width || !image.height) throw new Error("Could not decode the image");
        let layer = Layer(image.width, image.height, name || "Image");
        layer.getContext().drawImage(image, 0, 0);
        return me.createClip(name || "Image", {tracks: [makeTrack("Track 1", makeCel([layer]))]});
    };

    // A DPaint document whose root is the selected clip, with only its transitive
    // dependencies in the library. It can be opened as a document or imported as a clip.
    me.exportClip = function(id){
        let selected = clipById(id);
        if (!selected) throw new Error("Select a clip to export");
        syncParamTracks();
        let dependencies = [], visited = new Set(), visiting = new Set();
        function visit(clip){
            if (visiting.has(clip.id)) throw new Error("Cannot export a clip cycle");
            if (visited.has(clip.id)) return;
            visiting.add(clip.id);
            function nodes(list){
                (list || []).forEach(node=>{
                    if (isClip(node)){
                        let child = clipById(node.clipId);
                        if (!child) throw new Error("Cannot export missing clip " + node.clipId);
                        visit(child);
                    }
                    if (node.layers) nodes(node.layers);
                });
            }
            (clip.timeline.tracks || []).forEach(track=>(track.keys || []).forEach(key=>{
                if (key.cel) nodes(key.cel.layers);
            }));
            visiting.delete(clip.id); visited.add(clip.id);
            if (clip !== selected) dependencies.push(clip);
        }
        visit(selected);
        function serialize(clip){
            let saved = {id: clip.id, name: clip.name, length: clip.length,
                pivot: {...clip.pivot}, markers: copyMarkers(clip.markers),
                timeline: {tracks: clip.timeline.tracks.map(track=>({
                    id: track.id, name: track.name, visible: track.visible !== false,
                    locked: !!track.locked, mask: !!track.mask,
                    keys: track.keys.map(key=>key.type === "content"
                        ? {frame: key.frame, type: "content", tween: !!key.tween, ...easingData(key.easing),
                            cel: {activeLayerIndex: key.cel.activeLayerIndex || 0,
                                layers: key.cel.layers.map(layer=>layer.clone(true))}}
                        : {frame: key.frame, type: "property", tween: !!key.tween, ...easingData(key.easing), props: clonePlainData(key.props) || {}})
                }))}};
            if (Array.isArray(clip.params) && clip.params.length){
                saved.params = copyParams(clip.params);
                saved.nextParamId = clip.nextParamId || 1;
            }
            return saved;
        }
        let image = serialize(selected);
        delete image.id;
        Object.assign(image, {width: currentFile.width, height: currentFile.height,
            activeFrameIndex: 0, activeTrackIndex: 0, activeLayerIndex: 0,
            nextLayerId: syncNextLayerId(),
            library: {nextClipId: library().nextClipId, clips: dependencies.map(serialize)}});
        image.timeline.fps = me.getFps();
        if (currentFile.smooth) image.smooth = true;
        let data = {type: "dpaint", version: "2", image, palette: clonePlainData(Palette.get())};
        let fonts = getCustomFonts();
        if (fonts.length) data.customFonts = fonts;
        return data;
    };

    // Accept a saved DPaint document or a standalone clip object. Its timeline becomes one
    // library clip; layer identities are regenerated so they cannot collide with this document.
    me.importClipFromJSON = async function(data, fallbackName){
        let documentData = data && data.image && (data.type === "dpaint" || data.image.timeline || data.image.frames);
        let source = documentData ? data.image : data;
        let timeline = documentData ? toTimelineStruct(source) : source && source.timeline;
        if (!timeline || !Array.isArray(timeline.tracks) || !timeline.tracks.length){
            throw new Error("This JSON file has no DPaint animation timeline");
        }
        let sourceClips = new Map(((source.library && source.library.clips) || []).map(clip=>[clip.id, clip]));
        let dependencies = [], visiting = new Set(), visited = new Set();
        function visitTimeline(timeline){
            (timeline.tracks || []).forEach(track=>(track.keys || []).forEach(key=>{
                function visitNodes(nodes){
                    (nodes || []).forEach(node=>{
                        if (node.type === "clip") visitClip(node.clipId);
                        if (node.layers) visitNodes(node.layers);
                    });
                }
                if (key.cel) visitNodes(key.cel.layers);
            }));
        }
        function visitClip(id){
            if (visiting.has(id)) throw new Error("The imported animation contains a clip cycle");
            if (visited.has(id)) return;
            let clip = sourceClips.get(id);
            if (!clip || !clip.timeline) throw new Error("The imported animation is missing clip " + id);
            visiting.add(id);
            visitTimeline(clip.timeline);
            visiting.delete(id);
            visited.add(id);
            dependencies.push(clip);
        }
        visitTimeline(timeline);
        if (Array.isArray(data.customFonts) && data.customFonts.length){
            restoreCustomFonts(data.customFonts);
            EventBus.trigger(EVENT.fontListChanged);
        }
        let layerIds = {}, clipIds = new Map();
        function remapOverrides(entry){
            if (!entry || !entry.overrides) return;
            let overrides = {};
            Object.keys(entry.overrides).forEach(path=>{
                overrides[path.split("/").map(id=>layerIds[id] || id).join("/")] = entry.overrides[path];
            });
            entry.overrides = overrides;
        }
        function decodeIndexedBitmap(node){
            if (!node.indexedPixels || node.canvas) return;
            if (!Array.isArray(data.palette)) throw new Error("Indexed JSON needs its source palette");
            let width = node.w || source.width || currentFile.width;
            let height = node.h || source.height || currentFile.height;
            let canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            let ctx = canvas.getContext("2d");
            let pixels = ctx.createImageData(width, height);
            for (let y = 0; y < height; y++){
                let row = node.indexedPixels[y] || [];
                for (let x = 0; x < width; x++){
                    let color = data.palette[row[x]];
                    if (!color) continue;
                    let offset = (y * width + x) * 4;
                    pixels.data[offset] = color[0];
                    pixels.data[offset + 1] = color[1];
                    pixels.data[offset + 2] = color[2];
                    pixels.data[offset + 3] = 255;
                }
            }
            ctx.putImageData(pixels, 0, 0);
            node.canvas = canvas.toDataURL();
            delete node.indexedPixels;
        }
        function prepareNode(node){
            decodeIndexedBitmap(node);
            if (Array.isArray(node.layers)) node.layers.forEach(prepareNode);
        }
        async function importTracks(timeline){
        let pending = [];
        let imported = timeline.tracks.map(track=>{
            if (!track || !Array.isArray(track.keys) || !track.keys.length){
                throw new Error("The imported animation has an invalid track");
            }
            let idMap = layerIds;
            let keys = track.keys.map(key=>{
                if (!Number.isInteger(key.frame) || key.frame < 0){
                    throw new Error("The imported animation has an invalid keyframe");
                }
                if (key.type === "property") return makePropertyKey(key.frame, clonePlainData(key.props) || {}, key.tween,key.easing);
                if (key.type !== "content" || !key.cel || !Array.isArray(key.cel.layers)){
                    throw new Error("The imported animation has an invalid content keyframe");
                }
                let cel = makeCel();
                cel.activeLayerIndex = key.cel.activeLayerIndex || 0;
                key.cel.layers.forEach(node=>{
                    if (!node || typeof node !== "object") throw new Error("The imported animation has an invalid layer");
                    let layer = Layer(currentFile.width, currentFile.height, node.name);
                    cel.layers.push(layer);
                    let struct = clonePlainData(node);
                    prepareNode(struct);
                    function remapInstances(node){
                        remapOverrides(node);
                        if (node.layers) node.layers.forEach(remapInstances);
                    }
                    remapInstances(struct);
                    pending.push(layer.restore(remapIds(struct, idMap)));
                });
                return makeContentKey(key.frame, cel, key.tween,key.easing);
            });
            return {id: track.id, name: track.name || "Track 1", visible: track.visible !== false,
                locked: !!track.locked, mask: !!track.mask, keys, idMap};
        });
        await Promise.all(pending);
        imported.forEach(track=>{
            track.keys.forEach(key=>{
                if (key.type === "content") remapAttachIds(key.cel.layers, track.idMap);
                else {
                    let props = {};
                    Object.keys(key.props).forEach(id=>{
                        if (track.idMap[id]){
                            remapOverrides(key.props[id]);
                            props[track.idMap[id]] = key.props[id];
                        }
                    });
                    key.props = sanitizeKeyOverrides(props);
                }
            });
            delete track.idMap;
        });
        return imported;
        }
        // Decode everything before changing the library; all additions share one undo step.
        let prepared = [];
        for (let dependency of dependencies){
            prepared.push({source: dependency, tracks: await importTracks(dependency.timeline)});
        }
        let imported = await importTracks(timeline);
        let opts = {tracks: imported};
        opts.length = source.length;
        opts.markers = source.markers;
        if (source.pivot && Number.isFinite(source.pivot.x) && Number.isFinite(source.pivot.y)) opts.pivot = source.pivot;
        let name = source && typeof source.name === "string" && source.name.trim() ? source.name : fallbackName;
        HistoryService.start(EVENT.libraryHistory);
        function relinkNodes(nodes){
            (nodes || []).forEach(node=>{
                if (node.type === "clip") node.clipId = clipIds.get(node.clipId);
                if (node.layers) relinkNodes(node.layers);
            });
        }
        function relinkTracks(tracks){
            tracks.forEach(track=>track.keys.forEach(key=>{ if (key.cel) relinkNodes(key.cel.layers); }));
        }
        function restoreParams(clip, source){
            if (Array.isArray(source.params)){
                clip.params = copyParams(source.params);
                clip.nextParamId = source.nextParamId || 1;
                clip.params.forEach(param=>Object.values(param.tracks || {}).forEach(keys=>keys.forEach(key=>{
                    let props = {};
                    Object.keys(key.props || {}).forEach(id=>{
                        remapOverrides(key.props[id]);
                        props[layerIds[id] || id] = key.props[id];
                    });
                    key.props = props;
                })));
            }
        }
        prepared.forEach(item=>{
            relinkTracks(item.tracks);
            let clip = addClip(item.source.name, {...item.source, tracks: item.tracks});
            clipIds.set(item.source.id, clip.id);
            restoreParams(clip, item.source);
        });
        relinkTracks(imported);
        let clip = addClip(name || "Clip", opts);
        restoreParams(clip, source);
        HistoryService.end();
        libraryChanged();
        return clip;
    };

    me.renameClip = function(id, name){
        let clip = clipById(id);
        if (!clip) return false;
        let next = uniqueClipName(name, id);
        if (next === clip.name) return true;
        HistoryService.start(EVENT.libraryHistory);
        clip.name = next;
        library().rev = ++clipRevCounter;
        HistoryService.end();
        libraryChanged();
        return true;
    };

    // A deep copy with a fresh clip id and fresh layer ids (property keys remapped). Returns a
    // Promise for the new clip, because cel copies go through Layer.clone/restore.
    me.duplicateClip = function(id){
        let source = clipById(id);
        if (!source) return Promise.resolve(undefined);
        let idMap = {};
        return copyTracks(source.timeline.tracks, idMap).then(copied=>{
            HistoryService.start(EVENT.libraryHistory);
            let clip = addClip(DuplicateName(source.name, library().clips), {
                tracks: copied,
                length: source.length,
                pivot: source.pivot,
                markers: source.markers
            });
            // parameters (spec 026 R24): same ids, track ids kept by copyTracks, layer ids remapped
            syncParamTracks();
            if (Array.isArray(source.params) && source.params.length){
                clip.params = copyParams(source.params);
                clip.nextParamId = source.nextParamId || 1;
                clip.params.forEach(p=>Object.values(p.tracks || {}).forEach(keys=>keys.forEach(k=>{
                    let props = {};
                    Object.keys(k.props || {}).forEach(oldId=>{ props[idMap[oldId] || oldId] = k.props[oldId]; });
                    k.props = props;
                })));
                touchClip(clip);
            }
            HistoryService.end();
            libraryChanged();
            return clip;
        });
    };

    me.setClipLength = function(id, n){
        if (refuseInParam("Changing the clip length")) return false;
        let clip = clipById(id);
        if (!clip || !Number.isFinite(n)) return false;
        let length = clampLength(n);
        if (length === clip.length) return true;
        HistoryService.start(EVENT.libraryHistory);
        clip.length = length;
        touchClip(clip);
        HistoryService.end();
        libraryChanged();
        if (editClipId() === id) timelineStructureChanged();
        return true;
    };

    // Moves the pivot to the centre of what the clip shows at local frame t (default: the edit
    // playhead when editing it, else 0). One libraryHistory step. Returns the new pivot or null.
    me.centerClipPivot = function(id, t){
        let clip = clipById(id);
        if (!clip) return null;
        if (typeof t !== "number") t = editClipId() === id ? activeFrameIndex : 0;
        let composite = getClipComposite(clip, t, clipRenderEnv());
        let opaque = composite ? getOpaqueBounds(composite.canvas) : null;
        if (!opaque) return null;
        let pivot = {
            x: Math.round(composite.x + opaque.x + opaque.w / 2),
            y: Math.round(composite.y + opaque.y + opaque.h / 2)
        };
        me.setClipPivot(id, pivot);
        return pivot;
    };

    me.setClipPivot = function(id, pivot){
        if (refuseInParam("Moving the clip pivot")) return null;
        let clip = clipById(id);
        if (!clip || !pivot || !Number.isFinite(pivot.x) || !Number.isFinite(pivot.y)) return false;
        HistoryService.start(EVENT.libraryHistory);
        clip.pivot = {x: pivot.x, y: pivot.y};
        touchClip(clip);
        HistoryService.end();
        libraryChanged();
        return true;
    };

    // Replaces a clip's markers after validation (R22). Returns {ok, reason}.
    me.setClipMarkers = function(id, markers){
        let clip = clipById(id);
        if (!clip) return {ok: false, reason: "No such clip"};
        let result = validateMarkers(clip, markers);
        if (!result.ok) return result;
        HistoryService.start(EVENT.libraryHistory);
        clip.markers = copyMarkers(markers);
        touchClip(clip);
        HistoryService.end();
        libraryChanged();
        return {ok: true};
    };

    // libraryHistory snapshot (R39): library structure only. Timelines are referenced, never
    // cloned — key/track/pixel edits inside a clip have their own history steps.
    me.cloneLibraryStructure = function(){
        syncParamTracks();
        let lib = library();
        return {
            nextClipId: lib.nextClipId,
            clips: lib.clips.map(c=>({
                id: c.id, name: c.name, length: c.length,
                pivot: {x: c.pivot.x, y: c.pivot.y},
                markers: copyMarkers(c.markers),
                timeline: c.timeline,
                params: copyParams(c.params),
                nextParamId: c.nextParamId
            }))
        };
    };

    me.restoreLibraryStructure = function(snapshot){
        if (!snapshot || !Array.isArray(snapshot.clips)) return;
        let lib = library();
        let existing = clipMap(lib);
        // ids are never reused, so the allocator only ever moves forward
        lib.nextClipId = Math.max(lib.nextClipId || 1, snapshot.nextClipId || 1);
        lib.clips = snapshot.clips.map(s=>{
            let clip = existing.get(s.id) || {id: s.id};
            clip.name = s.name;
            clip.length = s.length;
            clip.pivot = {x: s.pivot.x, y: s.pivot.y};
            clip.markers = copyMarkers(s.markers);
            clip.timeline = s.timeline;
            if (s.params && s.params.length){ clip.params = copyParams(s.params); clip.nextParamId = s.nextParamId || 1; }
            else { delete clip.params; }
            clip.rev = ++clipRevCounter;
            return clip;
        });
        paramCtx = null;
        touchClip();
        validateEditStack();
        libraryChanged();
        timelineStructureChanged();
    };

    // Whether an instance of `clipId` may go into the timeline being edited: never into itself or
    // into any clip it (transitively) contains (R4).
    me.canPlaceClip = function(clipId){
        return canPlace(library(), clipId, editClipId());
    };

    // Places an instance of `clipId` directly above the active layer of the active cel (in the
    // edited timeline). With `at` (a drop point) the clip's pivot lands there; without it the
    // instance sits at 0,0 so clip-local coordinates coincide with the document (touch *Place*).
    // Refused with a message on a cycle. One undo step. Returns the new node, or undefined.
    me.placeClip = function(clipId, at){
        if (refuseInParam("Placing a clip")) return undefined;
        let clip = clipById(clipId);
        let cel = currentFrame();
        if (!clip || !cel) return undefined;
        if (!me.canPlaceClip(clipId)){
            Modal.softAlert("A clip can't contain itself.", "Place clip");
            return undefined;
        }
        let node = Layer.makeClip(clipId, clip.name);
        if (at && Number.isFinite(at.x) && Number.isFinite(at.y)){
            node.x = Math.round(at.x - clip.pivot.x);
            node.y = Math.round(at.y - clip.pivot.y);
        }
        HistoryService.start(EVENT.imageHistory);
        let p = parentOf(cel.layers, activeLayerPath);
        let path;
        if (p){
            p.parent.splice(p.index + 1, 0, node);
            path = activeLayerPath.slice(0, -1).concat(p.index + 1);
        }else{
            cel.layers.push(node);
            path = [cel.layers.length - 1];
        }
        HistoryService.end();
        me.activateLayer(path);
        clearRenderCache();
        cachedImage = undefined;
        EventBus.trigger(EVENT.layersChanged);
        EventBus.trigger(EVENT.libraryChanged);
        EventBus.trigger(EVENT.imageContentChanged);
        return node;
    };

    // A copy of resolved props must never carry an instance's cue / scrub frame into a NEW key:
    // a cue re-anchors the clock at the key it sits on (R24), so copying it would restart the clip.
    function withoutTimeCues(props){
        Object.keys(props || {}).forEach(id=>{
            let entry = props[id];
            if (entry){ delete entry.cue; delete entry.frame; }
        });
        return props;
    }

    // ── Convert to Clip (R6) ──────────────────────────────────────────────────────
    // sel = {layerPaths: [path…]}  sibling nodes of the active cel, or
    //       {trackIndices: [i…]}   contiguous tracks of the edited timeline.
    // Content keeps its coordinates as clip-local coordinates (D2) and the instance sits at 0,0
    // with an identity transform, so the frames look the same immediately after converting.

    function analyseLayerSelection(paths){
        let cel = currentFrame();
        let track = activeTrack();
        if (!cel || !track || !Array.isArray(paths) || !paths.length) return {ok: false, reason: "Nothing selected"};
        let parentKey = null, parent = null;
        let indices = [];
        for (let i = 0; i < paths.length; i++){
            let path = toPath(paths[i]);
            let p = path && parentOf(cel.layers, path);
            if (!p || !p.parent[p.index]) return {ok: false, reason: "Invalid selection"};
            let key = path.slice(0, -1).join(",");
            if (parentKey === null){ parentKey = key; parent = p.parent; }
            else if (key !== parentKey) return {ok: false, reason: "Select layers that share a parent"};
            if (indices.indexOf(p.index) < 0) indices.push(p.index);
        }
        indices.sort((a,b)=>a-b);
        // A lone unattached pixel layer can stay under the same bone layer as an instance: the
        // compositor deforms an instance on the same scope-sized mesh as a pixel layer. Other
        // selections can change grouping, attachments or deformation order when split.
        let selected = new Set(indices);
        let lonePixel = indices.length === 1 && !isGroup(parent[indices[0]]) &&
            !isBones(parent[indices[0]]) && !isVector(parent[indices[0]]) &&
            !isClip(parent[indices[0]]) && !parent[indices[0]].attach;
        for (let i = 0; i < parent.length; i++){
            if (!isBones(parent[i])) continue;
            for (let j = 0; j < i; j++){
                if (selected.has(i) !== selected.has(j) && !(lonePixel && selected.has(j)))
                    return {ok: false, reason: "Include the bone layer and the layers it deforms"};
            }
        }
        let gov = governingContentKey(track, activeFrameIndex) || contentKeys(track)[0];
        let next = contentKeys(track).find(k=>k.frame > gov.frame);
        let end = next ? next.frame - 1 : Math.max(gov.frame, editLength() - 1);
        return {ok: true, kind: "layers", track, cel, parent, indices, gov, end,
            prefix: toPath(paths[0]).slice(0, -1)};
    }

    function analyseTrackSelection(indices){
        let list = tracks();
        if (!Array.isArray(indices) || !indices.length) return {ok: false, reason: "Nothing selected"};
        let sorted = indices.slice().sort((a,b)=>a-b);
        for (let i = 0; i < sorted.length; i++){
            if (!list[sorted[i]]) return {ok: false, reason: "Invalid selection"};
            if (i && sorted[i] !== sorted[i - 1] + 1) return {ok: false, reason: "Select adjacent tracks"};
        }
        let lo = sorted[0], hi = sorted[sorted.length - 1];
        // A mask belongs to the track directly beneath it: it can't be separated from it.
        if (list[lo].mask) return {ok: false, reason: "Include the track the mask belongs to"};
        let above = list[hi + 1];
        if (above && above.mask && above.visible !== false && lo !== hi){
            return {ok: false, reason: "Include the mask track above the selection"};
        }
        let first = Infinity;
        sorted.forEach(i=>(list[i].keys || []).forEach(k=>{ if (k.frame < first) first = k.frame; }));
        if (!Number.isFinite(first)) first = 0;
        return {ok: true, kind: "tracks", lo, hi, first};
    }

    me.canConvertToClip = function(sel){
        if (!sel) return {ok: false, reason: "Nothing selected"};
        let a = sel.trackIndices ? analyseTrackSelection(sel.trackIndices) : analyseLayerSelection(sel.layerPaths);
        return {ok: !!a.ok, reason: a.reason};
    };

    // Returns the new clip (or undefined when refused). One imageHistory step.
    me.convertToClip = function(sel, name){
        if (refuseInParam("Convert to Clip")) return undefined;
        if (!sel) return undefined;
        let a = sel.trackIndices ? analyseTrackSelection(sel.trackIndices) : analyseLayerSelection(sel.layerPaths);
        if (!a.ok){
            Modal.softAlert(a.reason, "Convert to Clip");
            return undefined;
        }
        HistoryService.start(EVENT.imageHistory);
        let clip = a.kind === "tracks" ? convertTracks(a, name) : convertLayers(a, name);
        HistoryService.end();
        PanelManager.reveal && PanelManager.reveal("library", true);
        timelineStructureChanged();
        EventBus.trigger(EVENT.libraryChanged);
        return clip;
    };

    function convertLayers(a, name){
        let moved = a.indices.map(i=>a.parent[i]);
        let movedIds = new Set();
        moved.forEach(node=>collectIds(node).forEach(id=>movedIds.add(id)));
        let K = a.gov.frame;

        // A moved layer whose lineage continues in another content key of this track stays in
        // the parent there, so inside the clip it becomes a new lineage with a fresh id: an id
        // may only live on one track of one timeline (spec 025 R2).
        let idMap = {};
        movedIds.forEach(id=>{ if (lineageElsewhere(a.track, a.gov.cel, id)) idMap[id] = Layer.nextId(); });
        if (Object.keys(idMap).length){
            (function reId(nodes){
                nodes.forEach(node=>{
                    if (!node) return;
                    if (idMap[node.id]) node.id = idMap[node.id];
                    if (isGroup(node)) reId(node.layers || []);
                });
            })(moved);
            remapAttachIds(moved, idMap);
        }

        // Every property key the governing cel owns moves along (rebased to the clip's frame 0),
        // carrying only the moved layers' entries. ALL of them, even ones that don't mention a
        // moved layer: a key without an entry still pins those layers to their base values, which
        // is part of how their tweens look.
        let clipKeys = [makeContentKey(0, makeCel(moved), a.gov.tween,a.gov.easing)];
        propertyKeysGovernedBy(a.track, a.gov).forEach(key=>{
            let props = {};
            Object.keys(key.props || {}).forEach(id=>{
                if (!movedIds.has(id)) return;
                props[idMap[id] || id] = key.props[id];
                delete key.props[id];
            });
            if (key.frame <= a.end) clipKeys.push(makePropertyKey(key.frame - K, props, key.tween,key.easing));
        });
        let clipTrack = {name: a.track.name || "Track 1", visible: true, locked: false, mask: false, keys: clipKeys};
        let defaultName = moved.length === 1 ? moved[0].name : "Clip";
        let clip = addClip(name || defaultName, {tracks: [clipTrack], length: a.end - K + 1});

        // The instance takes the place of the topmost moved node; its clock starts at the
        // governing key and plays once, which reproduces the original frames exactly.
        let top = a.indices[a.indices.length - 1];
        let below = a.indices.filter(i=>i < top).length;
        for (let i = a.indices.length - 1; i >= 0; i--) a.parent.splice(a.indices[i], 1);
        let node = Layer.makeClip(clip.id, clip.name);
        node.cue = {playback: "once", start: 0, speed: 1};
        let at = top - below;
        a.parent.splice(at, 0, node);
        me.activateLayer(a.prefix.concat(at));
        // lineages that moved with their ids now live one level deeper (spec 025 R30)
        if (editStack.length){
            let kept = new Set();
            movedIds.forEach(id=>{ if (!idMap[id]) kept.add(id); });
            followConvertedIntoClip(kept, node.id);
            // the moved lineages left this clip: its parameters no longer pose them (spec 026)
            pruneParamKeysOf(editClip());
        }
        return clip;
    }

    function convertTracks(a, name){
        let list = tracks();
        let moved = list.slice(a.lo, a.hi + 1);
        let m = a.first;
        let length = Math.max(1, editLength() - m);
        moved.forEach(track=>(track.keys || []).forEach(key=>{ key.frame -= m; }));
        let named = moved.find(t=>!t.mask) || moved[0];
        let clip = addClip(name || named.name || "Clip", {tracks: moved, length});
        let node = Layer.makeClip(clip.id, clip.name);
        node.cue = {playback: "once", start: 0, speed: 1};
        let track = {
            name: clip.name,
            visible: true,
            locked: false,
            mask: false,
            keys: [makeContentKey(m, makeCel([node]))]
        };
        list.splice(a.lo, moved.length, track);
        rememberActiveLayer();
        activeTrackIndex = a.lo;
        resolveActiveLayer();
        // every lineage of the moved tracks now lives one level deeper (spec 025 R30)
        if (editStack.length){
            let kept = new Set();
            moved.forEach(t=>forEachCelIn({tracks: [t]}, cel=>{
                (function walk(nodes){ (nodes || []).forEach(n=>{ if (n && n.id) kept.add(n.id); if (isGroup(n)) walk(n.layers); }); })(cel.layers);
            }));
            followConvertedIntoClip(kept, node.id);
            // the moved tracks' parameter keys stay behind (the new clip has no parameters) and
            // their lineages are gone from this clip: prune (spec 026 R24)
            let dropped = pruneParamKeysOf(editClip());
            if (dropped) Modal.softAlert(dropped + " parameter setting" + (dropped === 1 ? "" : "s") + " for the converted content were removed: the new clip has no parameters.", "Convert to Clip");
        }
        return clip;
    }

    // Converting content of the edited clip into a new clip moves those lineages one level down:
    // outer override paths that reach them get the new instance inserted before the first moved
    // segment (spec 025 R30). Ids name one lineage, so a moved id in a path can only mean that one.
    function followConvertedIntoClip(movedIds, instanceId){
        if (!movedIds.size) return;
        rewriteOverridePaths(p=>{
            let segs = pathSegments(p);
            let k = segs.findIndex(seg=>movedIds.has(seg));
            if (k < 0) return p;
            segs.splice(k, 0, instanceId);
            return segs.length > MAX_CLIP_DEPTH ? null : segs.join("/");
        });
    }

    // ── Break Apart (R7) and deleting a clip (R5a, D4) ───────────────────────────

    // A struct of `node` with fresh ids and everything the timeline resolves at local time `t`
    // baked into base values: x/y/opacity and transforms (withResolvedProps), bone poses, vector
    // node/curve overlays, and — for a nested instance — its time: a default-clock instance keeps
    // looping with an offset that preserves its current local frame at `parentFrame`; a cue- or
    // scrub-driven one holds that frame.
    function bakeForBreakApart(node, props, times, parentFrame){
        let struct = withResolvedProps(withFreshIds(node.clone(false)), node, props);
        (function bake(s, n){
            let entry = props && n.id ? props[n.id] : undefined;
            if (isBones(n) && s.armature && entry && entry.bones){
                s.armature.bones.forEach(b=>{
                    let o = entry.bones[b.id];
                    if (o) b.pose = Object.assign({}, b.pose, o);
                });
            }
            if (isVector(n) && s.vector && entry && (entry.nodes || entry.curves)){
                s.vector = poseVector(s.vector, entry.nodes, entry.curves);
            }
            if (isClip(n)){
                let info = times.get(n.id);
                if (info){
                    if (info.source === "default"){
                        s.offset = Math.round(info.local - parentFrame);
                        delete s.cue;
                    }else{
                        s.cue = {playback: "hold", start: info.local, speed: 1};
                    }
                    delete s.frame;
                }
            }
            // a visibility override from the broken-apart instance (spec 025) is baked in too
            if (entry && typeof entry.visible === "boolean") s.visible = entry.visible;
            if (isGroup(n) && Array.isArray(s.layers)) s.layers.forEach((c,i)=>bake(c, n.layers[i]));
        })(struct, node);
        return struct;
    }

    // What an instance on `track` hands to its clip at `frame` (its override set and blend window,
    // spec 025), for operations that rebuild its content outside a render (Break Apart).
    function instancePartsAt(track, frame, node, clip){
        let state = resolveTrackState(track, frame, library());
        if (!state) return undefined;
        return instanceParts(node, state.props, trackOptionsFor(undefined, state), clipRenderEnv(), clip);
    }

    function findNodeDeep(nodes, id){
        for (let i = 0; i < (nodes || []).length; i++){
            let n = nodes[i];
            if (!n) continue;
            if (n.id === id) return n;
            if (isGroup(n)){
                let inner = findNodeDeep(n.layers, id);
                if (inner) return inner;
            }
        }
        return undefined;
    }

    // Builds (asynchronously, without touching the document) the group that replaces an instance
    // of `clip` showing local time `t`, sitting in a timeline at `parentFrame`.
    // `parts` = the instance's override set and blend window (spec 025): single-segment overrides
    // are baked into the copies like any resolved value; longer paths move one level down onto
    // the copied nested instances (R30). The group carries the old → new id map it used, as
    // `breakApartMap`, so outer overrides running through the instance can follow.
    function buildBreakApartGroup(clip, t, parentFrame, parts){
        let lib = library();
        let env = childEnv(clipRenderEnv(), clip, parts);
        let overridden = new Set();
        if (parts && parts.overrides) parts.overrides.forEach((R, path)=>{
            if (pathSegments(path).length === 1 && R.time && R.time.kind === "local") overridden.add(path);
        });
        let list = (clip.timeline && clip.timeline.tracks) || [];
        let pending = [];
        let trackGroups = [];
        let remaps = [];
        list.forEach((track, index)=>{
            if (track.mask || !track.visible) return;
            let state = resolveForRender(track, t, env);
            if (!state) return;
            let group = Layer.makeGroup(currentFile.width, currentFile.height, track.name || "Track");
            let maskState = resolveMaskFor(list, index, t, lib, env);
            if (maskState){
                // groups carry no masks: a masked track is baked into one pixel layer
                let leaf = Layer(currentFile.width, currentFile.height, track.name || "Track");
                renderTimeline([track, list[index + 1]], t, leaf.getContext(), env);
                group.layers.push(leaf);
            }else{
                let gov = governingContentKey(track, t);
                let times = new Map();
                forEachClipNode(state.cel.layers, n=>{
                    let nested = clipById(n.clipId);
                    if (!nested) return;
                    // a nested time set by an override holds the frame it shows (like a cue)
                    if (overridden.has(n.id) && state.clipTimes && state.clipTimes.has(n.id)){
                        times.set(n.id, {source: "override", local: state.clipTimes.get(n.id)});
                    }else{
                        times.set(n.id, resolveInstanceTime(track, t, n, gov, nested));
                    }
                });
                state.cel.layers.forEach(n=>{
                    let copy = Layer(currentFile.width, currentFile.height, n.name);
                    group.layers.push(copy);
                    pending.push(copy.restore(bakeForBreakApart(n, state.props, times, parentFrame)));
                });
                remaps.push({group, sources: state.cel.layers});
            }
            trackGroups.push(group);
        });
        return Promise.all(pending).then(()=>{
            // attachments inside the copies follow the copied rigs
            let idMap = {};
            remaps.forEach(r=>{
                let map = copyIdMap(r.sources, r.group.layers);
                remapAttachIds(r.group.layers, map);
                Object.assign(idMap, map);
            });
            // one track: its layers go straight into the result group
            let result = Layer.makeGroup(currentFile.width, currentFile.height, clip.name);
            if (trackGroups.length === 1) result.layers = trackGroups[0].layers;
            else result.layers = trackGroups;
            // overrides addressed THROUGH a nested instance now belong on its copy (R30)
            if (parts && parts.overrides) parts.overrides.forEach((R, path)=>{
                let segs = pathSegments(path);
                if (segs.length < 2) return;
                let copy = idMap[segs[0]] ? findNodeDeep(result.layers, idMap[segs[0]]) : undefined;
                if (!isClip(copy)) return;
                let rest = segs.slice(1).join("/");
                let raw = resolvedToRaw(R);
                if (!raw) return;
                let merged = mergeRawOuter(copy.overrides && copy.overrides[rest], raw);
                if (merged) copy.overrides = Object.assign({}, copy.overrides, {[rest]: JSON.parse(JSON.stringify(merged))});
            });
            result.breakApartMap = idMap;
            return result;
        });
    }

    // The group's transform pivots about its content centre c, the instance's about the clip
    // pivot p: x_group = x_instance + (I − L)(p − c) keeps every pixel where it was.
    function pivotCompensation(t, d){
        let L = matMultiply(matRotate(t.rotation || 0), matScale(t.scaleX, t.scaleY));
        let Ld = matApply(L, d);
        return {x: d.x - Ld.x, y: d.y - Ld.y};
    }

    function transformOfEntry(e, fallback){
        return {
            scaleX: typeof e.scaleX === "number" ? e.scaleX : fallback.scaleX,
            scaleY: typeof e.scaleY === "number" ? e.scaleY : fallback.scaleY,
            rotation: typeof e.rotation === "number" ? e.rotation : fallback.rotation
        };
    }

    // Replaces `node` (an instance in `parentArray`, in the cel of content key `key` on `track`)
    // with a built break-apart `group`: base transform + every governed property key entry move
    // from the instance to the group, pivot-compensated.
    function applyBreakApart(track, key, parentArray, node, clip, group){
        let bounds = getOpaqueBounds(group.render());
        let c = bounds ? {x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2} : {x: clip.pivot.x, y: clip.pivot.y};
        let d = {x: clip.pivot.x - c.x, y: clip.pivot.y - c.y};
        let base = {
            scaleX: typeof node.scaleX === "number" ? node.scaleX : 1,
            scaleY: typeof node.scaleY === "number" ? node.scaleY : 1,
            rotation: typeof node.rotation === "number" ? node.rotation : 0
        };
        let comp = pivotCompensation(base, d);
        group.x = Math.round((node.x || 0) + comp.x);
        group.y = Math.round((node.y || 0) + comp.y);
        group.scaleX = base.scaleX;
        group.scaleY = base.scaleY;
        group.rotation = base.rotation;
        group.opacity = typeof node.opacity === "number" ? node.opacity : 100;
        group.blendMode = node.blendMode || "normal";
        group.visible = node.visible !== false;
        group.locked = !!node.locked;
        group.smooth = !!currentFile.smooth;
        if (node.attach) group.attach = JSON.parse(JSON.stringify(node.attach));

        propertyKeysGovernedBy(track, key).forEach(k=>{
            let entry = k.props && k.props[node.id];
            if (!entry) return;
            delete k.props[node.id];
            let out = Object.assign({}, entry);
            delete out.cue;
            delete out.frame;
            // the instance's overrides are baked into the pieces (spec 025); a group has none
            delete out.overrides;
            let resolved = keyState(track, k)[node.id] || {};
            let tf = transformOfEntry(out, transformOfEntry(resolved, base));
            let kc = pivotCompensation(tf, d);
            out.x = Math.round((typeof out.x === "number" ? out.x : (node.x || 0)) + kc.x);
            out.y = Math.round((typeof out.y === "number" ? out.y : (node.y || 0)) + kc.y);
            k.props[group.id] = out;
        });
        let index = parentArray.indexOf(node);
        if (index >= 0) parentArray.splice(index, 1, group);
        followBrokenApart(track, node.id, group);
    }

    // Outer overrides that ran THROUGH a broken-apart instance follow it one level down (R30):
    // ".../X/A/..." → ".../A'/...", ".../X" → ".../group". Only once the instance's lineage is gone
    // from its timeline: while other content keys still hold X, those paths keep addressing it.
    function followBrokenApart(track, instanceId, group){
        let map = group.breakApartMap || {};
        delete group.breakApartMap;
        let timeline = allTimelines().find(t=>tracksOf(t).indexOf(track) >= 0);
        if (!timeline || timeline === rootTimeline()) return;
        let alive = false;
        forEachCelIn(timeline, cel=>{ if (!alive && findNodeDeep(cel.layers, instanceId)) alive = true; });
        if (alive) return;
        rewriteOverridePaths(p=>{
            let segs = pathSegments(p);
            let i = segs.indexOf(instanceId);
            if (i < 0) return p;
            if (i === segs.length - 1){ segs[i] = group.id; return segs.join("/"); }
            let mapped = map[segs[i + 1]];
            if (!mapped) return null;
            segs.splice(i, 2, mapped);
            return segs.join("/");
        });
    }

    // Where `ref` sits in the active cel, and the instance's local time at the playhead.
    function instanceAt(ref){
        let cel = currentFrame();
        let track = activeTrack();
        let path = typeof ref === "undefined" ? activeLayerPath : toPath(ref);
        if (!cel || !track || !path) return undefined;
        let p = parentOf(cel.layers, path);
        let node = p && p.parent[p.index];
        if (!isClip(node)) return undefined;
        let clip = clipById(node.clipId);
        if (!clip) return undefined;
        let gov = governingContentKey(track, activeFrameIndex) || contentKeys(track)[0];
        let t = resolveInstanceTime(track, activeFrameIndex, node, gov, clip).local;
        return {track, key: gov, parent: p.parent, node, clip, t, path};
    }

    me.canBreakApart = function(ref){
        return !!instanceAt(ref);
    };

    // Replace one instance by the pixels it shows at the current playhead. Rendering the
    // instance through compositeNodes preserves its resolved clock, cue/action, nested overrides,
    // parameter pose, mask and transform. The result is document-aligned in this layer scope;
    // the clip definition and any other instances in the library are left alone.
    me.flattenClipToImage = function(ref){
        if (refuseInParam("Flatten to image")) return undefined;
        let at = instanceAt(ref);
        if (!at) return undefined;
        let state = resolveTrackState(at.track, activeFrameIndex, library());
        if (!state) return undefined;
        let effective = effectiveProps(at.node, state.props);
        let options = trackOptionsFor(Object.assign({env: clipRenderEnv()}, me.getCompositeOptions()), state);
        let index = at.path[at.path.length - 1];
        let governed = !at.node.attach && at.parent.slice(index + 1).some(layer=>{
            if (!isBones(layer) || !isVisibleIn(layer, state.props) || !layer.armature) return false;
            let overlay = state.props && state.props[layer.id] && state.props[layer.id].bones;
            return BoneDeformer.hasDeformation(applyPoseOverlay(layer.armature.bones, overlay));
        });
        let source = governed ? getDeformSource(at.node, state.props, Object.assign({}, options, {
            deformScope: {x: 0, y: 0, w: currentFile.width, h: currentFile.height},
            deformOffset: effective
        })) : null;
        let canvas;
        if (source){
            // Keep alpha on the new layer: the outer rig skins these exact pixels before the
            // layer's opacity/blend is applied, just as it did for the clip instance.
            canvas = source.canvas;
        }else{
            canvas = document.createElement("canvas");
            canvas.width = currentFile.width;
            canvas.height = currentFile.height;
            // The instance blend mode needs the backdrop below it. Keep it on the new image and
            // rasterize the clip itself with normal blending; opacity is baked into its alpha.
            let isolated = Object.create(at.node);
            isolated.blendMode = "normal";
            let props = Object.assign({}, state.props, {
                [at.node.id]: Object.assign({}, state.props && state.props[at.node.id], {opacity: effective.opacity})
            });
            compositeNodes([isolated], canvas.getContext("2d"), props, options);
        }

        HistoryService.start(EVENT.imageHistory);
        let flat = Layer(currentFile.width, currentFile.height, at.node.name);
        flat.drawImage(canvas, 0, 0);
        flat.opacity = source ? effective.opacity : 100;
        flat.blendMode = at.node.blendMode;
        flat.locked = at.node.locked;
        flat.visible = isVisibleIn(at.node, state.props);
        if (at.node.attach) flat.attach = at.node.attach;
        at.parent[at.path[at.path.length - 1]] = flat;
        HistoryService.end();
        me.activateLayer(at.path);
        timelineStructureChanged();
        return flat;
    };

    // Returns a Promise for the group that replaced the instance (undefined when refused).
    me.breakApart = function(ref){
        if (refuseInParam("Break Apart")) return Promise.resolve(undefined);
        let at = instanceAt(ref);
        if (!at) return Promise.resolve(undefined);
        let parts = instancePartsAt(at.track, activeFrameIndex, at.node, at.clip);
        return buildBreakApartGroup(at.clip, at.t, activeFrameIndex, parts).then(group=>{
            HistoryService.start(EVENT.imageHistory);
            applyBreakApart(at.track, at.key, at.parent, at.node, at.clip, group);
            HistoryService.end();
            me.activateLayer(at.path);
            timelineStructureChanged();
            EventBus.trigger(EVENT.libraryChanged);
            return group;
        });
    };

    // Deletes a clip (D4). In use and without {breakApart}: refused → {refused: true, usage}.
    // With {breakApart}: every instance anywhere (root and other clips) is broken apart at the
    // local time it shows at the start of its governing content key, then the clip is removed —
    // one imageHistory step. Unused: removed as one libraryHistory step. Returns a Promise.
    me.deleteClip = function(id, opts){
        let clip = clipById(id);
        if (!clip) return Promise.resolve({ok: false});
        let usage = me.getClipUsage(id);
        if (usage && !(opts && opts.breakApart)) return Promise.resolve({refused: true, usage});

        let finish = ()=>{
            library().clips = library().clips.filter(c=>c.id !== id);
            touchClip();
            validateEditStack();
        };
        if (!usage){
            HistoryService.start(EVENT.libraryHistory);
            finish();
            HistoryService.end();
            libraryChanged();
            timelineStructureChanged();
            return Promise.resolve({ok: true, usage: 0});
        }

        // collect every instance of the clip (outside the clip itself) with its break-apart time
        let jobs = [];
        allTimelines().forEach(timeline=>{
            if (timeline === clip.timeline) return;
            forEachCelIn(timeline, (cel, key, track)=>{
                (function walk(nodes){
                    nodes.forEach(n=>{
                        if (isGroup(n)) walk(n.layers || []);
                        else if (isClip(n) && n.clipId === id){
                            let t = resolveInstanceTime(track, key.frame, n, key, clip).local;
                            jobs.push({timeline, track, key, parent: nodes, node: n, t,
                                parts: instancePartsAt(track, key.frame, n, clip)});
                        }
                    });
                })(cel.layers);
            });
        });
        return Promise.all(jobs.map(job=>buildBreakApartGroup(clip, job.t, job.key.frame, job.parts))).then(groups=>{
            HistoryService.start(EVENT.imageHistory);
            jobs.forEach((job, i)=>applyBreakApart(job.track, job.key, job.parent, job.node, clip, groups[i]));
            // a clip whose content changed (it held an instance) has a new definition
            library().clips.forEach(c=>{ if (jobs.some(job=>job.timeline === c.timeline)) touchClip(c); });
            finish();
            HistoryService.end();
            resolveActiveLayer();
            libraryChanged();
            timelineStructureChanged();
            return {ok: true, usage};
        });
    };

    // ── edit in place (spec 024 §3.8) ─────────────────────────────────────────────
    // Entering a clip pushes an edit-stack entry; from then on tracks()/currentFrame() resolve
    // into the clip's timeline, and every tool, panel and history step works on it. Clip-local
    // coordinates map 1:1 onto the document viewport (D2); the parent context is drawn dimmed
    // around it by getDisplayCanvas.

    me.isEditingClip = function(){
        return editStack.length > 0;
    };

    me.getEditClipId = function(){
        return editClipId();
    };

    // The breadcrumb: [{clipId, name}] from the outermost entered clip to the edited one.
    me.getEditContext = function(){
        return editStack.map(entry=>{
            let clip = clipById(entry.clipId);
            if (entry.kind === "param"){
                let param = paramOf(clip, entry.paramId);
                return {clipId: entry.clipId, paramId: entry.paramId, kind: "param", name: param ? param.name : "(missing parameter)"};
            }
            return {clipId: entry.clipId, name: clip ? clip.name : "(missing clip)"};
        });
    };

    me.getContextFrames = function(){
        return contextFrames();
    };

    me.canEnterClip = function(ref, mode){
        if (mode === "in-place" && editStack.some(entry=>entry.standalone)) return false;
        return !!instanceAt(ref);
    };

    // The path of the first instance of `clipId` in the active cel (depth-first), or undefined —
    // how the Library panel's *Edit* finds something to enter.
    me.findInstancePath = function(clipId){
        let cel = currentFrame();
        if (!cel) return undefined;
        let found;
        (function walk(nodes, prefix){
            (nodes || []).forEach((node, i)=>{
                if (found || !node) return;
                if (isClip(node) && node.clipId === clipId) found = prefix.concat(i);
                else if (isGroup(node)) walk(node.layers, prefix.concat(i));
            });
        })(cel.layers, []);
        return found;
    };

    // The cue in effect on an instance at the active frame, or null (default clock / scrub).
    function cueInEffect(info, at){
        if (!info || info.source !== "cue" || !info.key) return null;
        let data = info.key === at.key ? at.node : (info.key.props && info.key.props[at.node.id]);
        return normalizeCue(data && data.cue);
    }

    // Enters the clip of the instance at `ref` (default: the active layer). The clip playhead
    // becomes the local frame the instance shows at the parent playhead (R19). Returns true.
    me.enterClip = function(ref, options){
        if (options?.mode === "in-place" && editStack.some(entry=>entry.standalone)) return false;
        let at = instanceAt(ref);
        if (!at) return false;
        let info = resolveInstanceTime(at.track, activeFrameIndex, at.node, at.key, at.clip);
        let local = Math.max(0, Math.floor(info.local));
        // Linear (the parent playhead follows the clip playhead) where the instance's time is a
        // plain 1:1 run: the default clock, or a loop/once cue at speed 1 inside its range.
        // Otherwise (hold, scrub, other speeds, a finished once) the context stays frozen.
        let linear = info.source === "default";
        let cue = cueInEffect(info, at);
        if (cue && cue.speed === 1 && (cue.playback === "loop" || cue.playback === "once")){
            let range = rangeFor(at.clip, cue.action) || {start: 0, end: clampLength(at.clip.length) - 1};
            let t = cue.start + (activeFrameIndex - info.key.frame);
            linear = cue.playback === "loop" || (t >= 0 && t <= range.end - range.start);
        }
        let parentChain = editStack.length ? editStack[editStack.length - 1].chainMatrix : matIdentity();
        let entry = {
            viewMode: options?.mode || (editStack.length ? me.getClipEditMode() : "in-place"),
            clipId: at.clip.id,
            instanceId: at.node.id,
            instancePath: at.path.slice(),
            parentTrackIndex: activeTrackIndex,
            parentFrame: activeFrameIndex,
            parentLayerPath: activeLayerPath.slice(),
            entryLocal: info.local,
            mapping: {kind: linear ? "linear" : "frozen", parentAtEntry: activeFrameIndex, localAtEntry: local, speed: 1},
            // clip-local → document: every ancestor level's instance chain, then this instance
            chainMatrix: matMultiply(parentChain, me.getLayerMatrix(at.path))
        };
        rememberActiveLayer();
        clearNestedFocus();
        editStack.push(entry);
        activeTrackIndex = 0;
        activeFrameIndex = Math.min(local, editLength() - 1);
        resolveActiveLayer();
        EventBus.trigger(EVENT.editContextChanged);
        timelineStructureChanged();
        return true;
    };

    me.getClipEditMode = function(){
        let top = editStack[editStack.length-1];
        return top?.viewMode || "in-place";
    };
    me.canShowClipContext = ()=>editStack.length > 0 && !editStack.some(entry=>entry.standalone);
    me.setClipEditMode = function(mode){
        if (!editStack.length || !["clip","in-place"].includes(mode)) return false;
        if (mode === "in-place" && !me.canShowClipContext()) return false;
        editStack[editStack.length-1].viewMode = mode;
        EventBus.trigger(EVENT.editContextChanged);
        EventBus.trigger(EVENT.imageContentChanged);
        return true;
    };
    // Library definitions need no scene instance to be editable.
    me.editClipDefinition = function(id){
        let clip = clipById(id);
        if (!clip) return false;
        let path = me.findInstancePath(id);
        if (path) return me.enterClip(path,{mode:"clip"});
        if (editStack.some(entry=>entry.clipId === id)) return false;
        rememberActiveLayer();
        clearNestedFocus();
        editStack.push({clipId:id,standalone:true,viewMode:"clip",parentTrackIndex:activeTrackIndex,
            parentFrame:activeFrameIndex,parentLayerPath:activeLayerPath.slice(),entryLocal:0,
            mapping:{kind:"frozen",parentAtEntry:activeFrameIndex,localAtEntry:0,speed:1},chainMatrix:matIdentity()});
        activeTrackIndex = activeFrameIndex = 0;
        resolveActiveLayer();
        EventBus.trigger(EVENT.editContextChanged);
        timelineStructureChanged();
        return true;
    };

    // Opens parameter `paramId` of the clip being edited, one level deeper (spec 026 D9, R18).
    // The playhead lands on the parameter's last frame (its maximum / last option).
    me.enterParam = function(paramId){
        let top = editStack[editStack.length - 1];
        if (!top || top.kind === "param") return false;
        let clip = clipById(top.clipId);
        let param = paramOf(clip, paramId);
        if (!param) return false;
        rememberActiveLayer();
        clearNestedFocus();
        invalidateParamCtx();
        editStack.push({
            kind: "param", clipId: clip.id, paramId, instanceId: null,
            viewMode: me.getClipEditMode(),
            parentTrackIndex: activeTrackIndex, parentFrame: activeFrameIndex, parentLayerPath: activeLayerPath.slice(),
            mapping: {kind: "frozen", parentAtEntry: activeFrameIndex, localAtEntry: 0, speed: 1},
            chainMatrix: top.chainMatrix
        });
        activeFrameIndex = paramLastFrame(param);
        resolveActiveLayer();
        EventBus.trigger(EVENT.editContextChanged);
        timelineStructureChanged();
        return true;
    };

    // Opens a parameter of any clip: enters the clip first (through an instance in the active
    // cel) when it is not the one being edited. Returns true on success.
    me.enterClipParam = function(clipId, paramId){
        if (editParamEntry()) me.exitClip();
        if (editClipId() !== clipId){
            me.exitToRoot();
            let path = me.findInstancePath(clipId);
            if (!path || !me.enterClip(path)) return false;
        }
        return me.enterParam(paramId);
    };

    me.isEditingParam = function(){
        return !!editParamEntry();
    };

    // {clipId, paramId, param (a copy), value} of the parameter being edited, or undefined.
    me.getEditParam = function(){
        let pe = editParamEntry();
        if (!pe) return undefined;
        let param = paramOf(clipById(pe.clipId), pe.paramId);
        if (!param) return undefined;
        return {clipId: pe.clipId, paramId: pe.paramId, param: copyParams([param])[0],
            value: paramValueOf(param, activeFrameIndex), localFrame: pe.parentFrame};
    };

    // Leaves the edited clip; the parent playhead is where the context mapping puts it.
    me.exitClip = function(){
        if (!editStack.length) return false;
        if (editParamEntry()) invalidateParamCtx();
        let frames = contextFrames();
        rememberActiveLayer();
        clearNestedFocus();
        let entry = editStack.pop();
        let list = tracks();
        activeTrackIndex = Math.max(0, Math.min(entry.parentTrackIndex, list.length - 1));
        activeFrameIndex = frames[editStack.length];
        resolveActiveLayer();
        if (me.getLayer(entry.parentLayerPath)) me.activateLayer(entry.parentLayerPath);
        EventBus.trigger(EVENT.editContextChanged);
        timelineStructureChanged();
        return true;
    };

    me.exitToRoot = function(){
        let left = false;
        while (editStack.length) left = me.exitClip() || left;
        return left;
    };

    // Leaves levels until `depth` levels remain (breadcrumb: 0 = the document).
    me.exitToDepth = function(depth){
        while (editStack.length > Math.max(0, depth)) me.exitClip();
    };

    // What the canvas shows (spec 024 §3.8): at the root the plain composite; inside a clip the
    // parent context — every sibling at every level, resolved at the context frames, the edited
    // instance left out — drawn dimmed through the inverse chain matrix, with the clip itself on
    // top at identity and full strength. Nothing of the context is editable (N10): every edit API
    // targets tracks(), which is the clip.
    const CONTEXT_ALPHA = 0.35;
    // Only dependencies that actually belong to the dimmed scene affect its cache.
    // The edited instance is omitted; other instances of its definition still invalidate it.
    function contextDependencyStamp(hidden){
        let memoKey = contextRootRevision+"|"+(library().rev || 0)+"|"+JSON.stringify(hidden);
        if (contextDependencyMemo?.key === memoKey) return contextDependencyMemo.stamp;
        let dependencies = new Map(), seen = new Set();
        function visitTimeline(timeline,depth,stack){
            function visitNodes(nodes){
                (nodes || []).forEach(node=>{
                    if (isGroup(node)) visitNodes(node.layers);
                    if (!isClip(node)) return;
                    let onChain = depth >= 0 && hidden[depth]?.instanceId === node.id && hidden[depth]?.clipId === node.clipId;
                    if (onChain && depth === hidden.length-1) return;
                    let clip = clipById(node.clipId);
                    if (!clip || stack.has(clip.id) || stack.size >= MAX_CLIP_DEPTH) return;
                    dependencies.set(clip.id,clip.rev || 0);
                    let nextDepth = onChain ? depth+1 : -1;
                    let key = clip.id+":"+nextDepth;
                    if (seen.has(key)) return;
                    seen.add(key);
                    visitTimeline(clip.timeline,nextDepth,new Set([...stack,clip.id]));
                });
            }
            tracksOf(timeline).forEach(track=>(track.keys || []).forEach(key=>visitNodes(key.cel?.layers)));
        }
        visitTimeline(rootTimeline(),0,new Set());
        let stamp = [...dependencies].sort(([a],[b])=>a.localeCompare(b)).map(([id,rev])=>id+":"+rev).join("|");
        contextDependencyMemo = {key:memoKey,stamp};
        return stamp;
    }
    function getContextSurface(top,hidden,frame,bounds){
        let key = JSON.stringify([contextRootRevision,frame,hidden,top.chainMatrix,bounds,!!currentFile.smooth,contextDependencyStamp(hidden)]);
        let entry = contextFramesCache.get(key);
        if (entry){
            contextFramesCache.delete(key);contextFramesCache.set(key,entry);
            return {canvas:entry.canvas,cached:true};
        }
        let canvas = document.createElement("canvas");canvas.width=bounds.w;canvas.height=bounds.h;
        let ctx = canvas.getContext("2d"), inv = matInvert(top.chainMatrix);
        ctx.setTransform(inv.a,inv.b,inv.c,inv.d,inv.e-bounds.x,inv.f-bounds.y);
        ctx.imageSmoothingEnabled = !!currentFile.smooth;
        renderTimeline(tracksOf(rootTimeline()),frame,ctx,Object.assign(rootEnv({library:library()}),{hidden}));
        let bytes = canvas.width*canvas.height*4;
        if (bytes <= CONTEXT_CACHE_BUDGET){
            while(contextCacheBytes+bytes > CONTEXT_CACHE_BUDGET && contextFramesCache.size){
                let oldestKey=contextFramesCache.keys().next().value,oldest=contextFramesCache.get(oldestKey);
                contextFramesCache.delete(oldestKey);contextCacheBytes-=oldest.bytes;releaseCanvas(oldest.canvas);
            }
            contextFramesCache.set(key,{canvas,bytes});contextCacheBytes+=bytes;
            return {canvas,cached:true};
        }
        return {canvas,cached:false};
    }
    EventBus.on(EVENT.paletteChanged,clearContextCache);
    me.getEditViewKey = ()=>JSON.stringify(editStack.map(entry=>({
        clipId:entry.clipId,instanceId:entry.instanceId,paramId:entry.paramId,mode:entry.viewMode || "in-place"
    })));
    // View geometry only: editing coordinates and saved document dimensions stay unchanged.
    me.getClipWorkspace = function(){
        if (!editStack.length) return null;
        let top = editStack[editStack.length - 1];
        let corners = b => [{x:b.x,y:b.y},{x:b.x+b.w,y:b.y},
            {x:b.x+b.w,y:b.y+b.h},{x:b.x,y:b.y+b.h}];
        let clip = clipById(top.clipId);
        let boundsEnv = childEnv(clipRenderEnv(), clip);
        let time = activeFrameIndex;
        if (top.kind === "param"){
            time = top.parentFrame;
            let param = paramOf(clip, top.paramId);
            let set = param && paramContribution(clip,param,time,paramValueOf(param,activeFrameIndex));
            if (set) boundsEnv.overrides = resolveSetTimes(set,clip,clipMap(library()));
        }
        let clipBox = clipBounds(clip, time, boundsEnv);
        if (me.getClipEditMode() === "clip"){
            let b = clipBox || {x:0,y:0,w:1,h:1};
            return {bounds:{x:b.x-16,y:b.y-16,w:b.w+32,h:b.h+32},clipBounds:clipBox,documentPoints:[]};
        }
        let inv = matInvert(top.chainMatrix);
        let documentPoints = corners({x:0,y:0,w:currentFile.width,h:currentFile.height}).map(p=>matApply(inv,p));
        let frame = contextFrames()[0];
        let boundsKey = contextRootRevision+"|"+(library().rev || 0)+"|"+frame;
        let sceneBox;
        if (contextBoundsCache.has(boundsKey)) sceneBox=contextBoundsCache.get(boundsKey);
        else{
            sceneBox = clipBounds({timeline:rootTimeline()}, frame, rootEnv({library:library()}));
            contextBoundsCache.set(boundsKey,sceneBox);
            if (contextBoundsCache.size > 16) contextBoundsCache.delete(contextBoundsCache.keys().next().value);
        }
        let points = documentPoints.slice();
        if (clipBox) points.push(...corners(clipBox));
        if (sceneBox) points.push(...corners(sceneBox).map(p=>matApply(inv,p)));
        let x = Math.floor(Math.min(...points.map(p=>p.x))) - 16;
        let y = Math.floor(Math.min(...points.map(p=>p.y))) - 16;
        let right = Math.ceil(Math.max(...points.map(p=>p.x))) + 16;
        let bottom = Math.ceil(Math.max(...points.map(p=>p.y))) + 16;
        return {bounds:{x,y,w:right-x,h:bottom-y},clipBounds:clipBox,documentPoints};
    };
    me.getDisplayCanvas = function(opts){
        if (!editStack.length) return me.getCanvas(undefined, opts);
        opts = opts || {};
        let out = document.createElement("canvas");
        let bounds = opts.bounds || {x:0,y:0,w:currentFile.width,h:currentFile.height};
        out.width = bounds.w;
        out.height = bounds.h;
        let ctx = out.getContext("2d");

        let top = editStack[editStack.length - 1];
        let clipLevels = editStack.filter(entry=>entry.kind !== "param");
        if (me.getClipEditMode() === "in-place"){
            let frames = contextFrames();
            let hidden = clipLevels.map(entry=>({clipId: entry.clipId, instanceId: entry.instanceId}));
            let context = getContextSurface(top,hidden,frames[0],bounds);
            ctx.globalAlpha = CONTEXT_ALPHA;
            ctx.drawImage(context.canvas, 0, 0);
            ctx.globalAlpha = 1;
            if (!context.cached) releaseCanvas(context.canvas);
        }
        ctx.translate(-bounds.x, -bounds.y);

        let env = rootEnv({
            library: library(),
            dissolve: Palette.isLockedGlobal(),
            skipVectorDisplay: !!opts.skipVectorDisplay
        });
        env.depth = me.getClipEditMode() === "clip" ? 1 : clipLevels.length;
        env.stack = new Set(me.getClipEditMode() === "clip" ? [top.clipId] : clipLevels.map(entry=>entry.clipId));
        let pe = editParamEntry();
        let pclip = pe && clipById(pe.clipId);
        let param = pe && paramOf(pclip, pe.paramId);
        if (param){
            // a parameter timeline (spec 026): the clip at the entry frame with only this
            // parameter applied at the playhead's value — exactly what an instance would show
            let set = paramContribution(pclip, param, pe.parentFrame, paramValueOf(param, activeFrameIndex));
            if (set) env.overrides = resolveSetTimes(set, pclip, clipMap(library()));
            renderTimeline(pclip.timeline.tracks, pe.parentFrame, ctx, env);
            return out;
        }
        renderTimeline(tracks(), activeFrameIndex, ctx, env);
        return out;
    };

    // imageHistory snapshots also record where the user was editing (not saved files): after a
    // whole-image undo the context is re-entered level by level while each level still resolves.
    function editContextSnapshot(){
        let frames = contextFrames();
        return editStack.map((entry, i)=>{
            let deeper = editStack[i + 1];
            return {
                kind: entry.kind,
                viewMode: entry.viewMode,
                standalone: entry.standalone,
                paramId: entry.paramId,
                clipId: entry.clipId,
                instanceId: entry.instanceId,
                frame: frames[i + 1],
                trackIndex: deeper ? deeper.parentTrackIndex : activeTrackIndex,
                layerPath: (deeper ? deeper.parentLayerPath : activeLayerPath).slice()
            };
        });
    }

    me.cloneForHistory = function(){
        let struct = me.clone();
        if (editStack.length) struct.editContext = editContextSnapshot();
        return struct;
    };

    // One cel's tree, like findNodeById (ids are unique per cel, spec 025 R2).
    function findPathById(nodes, id, prefix){
        prefix = prefix || [];
        for (let i = 0; i < (nodes || []).length; i++){
            let node = nodes[i];
            if (node && node.id === id) return prefix.concat(i);
            if (isGroup(node)){
                let inner = findPathById(node.layers, id, prefix.concat(i));
                if (inner) return inner;
            }
        }
        return undefined;
    }

    function reenterEditContext(levels){
        if (!Array.isArray(levels)) return;
        for (let i = 0; i < levels.length; i++){
            let level = levels[i];
            if (level.kind === "param"){
                if (!me.enterParam(level.paramId)) return;
            }else{
                let cel = currentFrame();
                let path = cel && findPathById(cel.layers, level.instanceId);
                if (level.standalone){
                    if (!me.editClipDefinition(level.clipId)) return;
                }else if (!path || !me.enterClip(path,{mode:level.viewMode}) || editClipId() !== level.clipId) return;
            }
            if (level.viewMode) editStack[editStack.length-1].viewMode = level.viewMode;
            let list = tracks();
            activeTrackIndex = Math.max(0, Math.min(level.trackIndex || 0, list.length - 1));
            activeFrameIndex = Math.max(0, Math.min(level.frame || 0, editLength() - 1));
            resolveActiveLayer();
            if (level.layerPath && me.getLayer(level.layerPath)) me.activateLayer(level.layerPath);
        }
        EventBus.trigger(EVENT.editContextChanged);
        timelineStructureChanged();
    }

    // ── clip parameters: definitions and values (spec 026 §3.7) ───────────────────

    function allocParamId(clip, prefix){
        clip.nextParamId = Math.max(clip.nextParamId || 1, maxParamId(clip.params) + 1);
        return prefix + (clip.nextParamId++);
    }

    function uniqueParamName(clip, name, exceptId){
        let taken = new Set((clip.params || []).filter(p=>p.id !== exceptId).map(p=>p.name));
        let base = typeof name === "string" && name.trim() ? name.trim() : "Parameter";
        let out = base, n = 2;
        while (taken.has(out)) out = base + " " + (n++);
        return out;
    }

    // One libraryHistory step around `fn(clip, param?)`; bumps the clip and refreshes.
    function paramDefinitionEdit(clipId, paramId, fn){
        let clip = clipById(clipId);
        if (!clip) return undefined;
        let param = paramId ? paramOf(clip, paramId) : undefined;
        if (paramId && !param) return undefined;
        syncParamTracks();
        HistoryService.start(EVENT.libraryHistory);
        let result = fn(clip, param);
        if (result === false){ HistoryService.neverMind(); return false; }
        HistoryService.end();
        paramCtx = null;
        touchClip(clip);
        clearDrivenSetMemo();
        libraryChanged();
        timelineStructureChanged();
        return result === undefined ? true : result;
    }

    me.getClipParams = function(clipId){
        let clip = clipById(clipId);
        syncParamTracks();
        return clip ? copyParams(clip.params) : [];
    };

    // Adds a parameter (R1–R3): spec = {name, type: "number"|"switch", min, max, rest, default,
    // frames, options: [names]}. Its timeline starts with an empty rest key on every clip track
    // (R8). Returns a copy of the new parameter.
    me.addClipParam = function(clipId, spec){
        spec = spec || {};
        let result = paramDefinitionEdit(clipId, null, clip=>{
            ensureTrackIds(clip.timeline);
            let type = spec.type === "switch" ? "switch" : "number";
            let raw = {id: allocParamId(clip, "P"), name: uniqueParamName(clip, spec.name || (type === "switch" ? "Switch" : "Parameter")), type};
            if (type === "number"){
                Object.assign(raw, {min: spec.min, max: spec.max, rest: spec.rest, default: spec.default, frames: spec.frames});
            }else{
                let names = Array.isArray(spec.options) && spec.options.length ? spec.options : ["Option 1", "Option 2"];
                raw.options = names.map(n=>({id: allocParamId(clip, "O"), name: n}));
            }
            let param = normalizeParams([raw])[0];
            if (!param) return false;
            let restAt = Math.round(paramFrameOf(param, param.rest));
            param.tracks = {};
            tracksOf(clip.timeline).forEach(track=>{
                if (track.id) param.tracks[track.id] = [{frame: restAt, type: "property", tween: param.type === "number", props: {}}];
            });
            clip.params = (clip.params || []).concat([param]);
            return copyParams([param])[0];
        });
        return result || undefined;
    };

    me.renameClipParam = function(clipId, paramId, name){
        return paramDefinitionEdit(clipId, paramId, (clip, param)=>{ param.name = uniqueParamName(clip, name, paramId); });
    };

    // Range / rest / default / resolution (R5). Keys stay on their frames (R6); keys past a shorter
    // timeline are dropped.
    me.setClipParamRange = function(clipId, paramId, spec){
        return paramDefinitionEdit(clipId, paramId, (clip, param)=>{
            if (param.type !== "number") return false;
            let merged = normalizeParams([Object.assign({}, param, spec || {}, {tracks: {}})])[0];
            if (!merged) return false;
            ["min", "max", "rest", "default", "frames"].forEach(k=>{ param[k] = merged[k]; });
            Object.keys(param.tracks || {}).forEach(id=>{
                param.tracks[id] = param.tracks[id].filter(k=>k.frame <= param.frames);
                if (!param.tracks[id].length) delete param.tracks[id];
            });
        });
    };

    me.setClipParamDefault = function(clipId, paramId, value){
        return paramDefinitionEdit(clipId, paramId, (clip, param)=>{
            if (param.type === "switch"){
                if (!param.options.some(o=>o.id === value)) return false;
                param.default = value;
            }else{
                if (!Number.isFinite(value)) return false;
                param.default = Math.min(param.max, Math.max(param.min, value));
            }
        });
    };

    me.setClipParamRest = function(clipId, paramId, value){
        return paramDefinitionEdit(clipId, paramId, (clip, param)=>{
            if (param.type === "switch"){
                if (!param.options.some(o=>o.id === value)) return false;
                param.rest = value;
            }else{
                if (!Number.isFinite(value)) return false;
                param.rest = Math.min(param.max, Math.max(param.min, value));
            }
        });
    };

    me.moveClipParam = function(clipId, paramId, index){
        return paramDefinitionEdit(clipId, paramId, (clip, param)=>{
            let list = clip.params.filter(p=>p !== param);
            list.splice(Math.max(0, Math.min(list.length, index)), 0, param);
            clip.params = list;
        });
    };

    me.addParamOption = function(clipId, paramId, name){
        return paramDefinitionEdit(clipId, paramId, (clip, param)=>{
            if (param.type !== "switch") return false;
            let taken = new Set(param.options.map(o=>o.name));
            let base = typeof name === "string" && name.trim() ? name.trim() : "Option";
            let out = base, n = 2;
            while (taken.has(out)) out = base + " " + (n++);
            let option = {id: allocParamId(clip, "O"), name: out};
            param.options.push(option);
            return option.id;
        });
    };

    me.renameParamOption = function(clipId, paramId, optionId, name){
        return paramDefinitionEdit(clipId, paramId, (clip, param)=>{
            let option = param.type === "switch" && param.options.find(o=>o.id === optionId);
            if (!option || typeof name !== "string" || !name.trim()) return false;
            if (param.options.some(o=>o !== option && o.name === name.trim())) return false;
            option.name = name.trim();
        });
    };

    // Removes an option and its frame (later options' keys move down one frame).
    me.removeParamOption = function(clipId, paramId, optionId){
        return paramDefinitionEdit(clipId, paramId, (clip, param)=>{
            if (param.type !== "switch" || param.options.length < 2) return false;
            let index = param.options.findIndex(o=>o.id === optionId);
            if (index < 0) return false;
            param.options.splice(index, 1);
            Object.keys(param.tracks || {}).forEach(id=>{
                param.tracks[id] = param.tracks[id].filter(k=>k.frame !== index)
                    .map(k=>{ if (k.frame > index) k.frame--; return k; });
                if (!param.tracks[id].length) delete param.tracks[id];
            });
            if (param.default === optionId) param.default = param.options[0].id;
            if (param.rest === optionId) param.rest = param.options[0].id;
        });
    };

    // Deletes a parameter and strips its values from every instance of the clip — bases, keys
    // and outer `params` overrides — in one whole-image step (R6).
    me.removeClipParam = function(clipId, paramId){
        let clip = clipById(clipId);
        if (!clip || !paramOf(clip, paramId)) return false;
        if (editParamEntry() && editParamEntry().paramId === paramId) me.exitClip();
        HistoryService.start(EVENT.imageHistory);
        clip.params = clip.params.filter(p=>p.id !== paramId);
        if (!clip.params.length) delete clip.params;
        let clips = clipMap(library());
        let strip = obj=>{ if (obj && obj.params && paramId in obj.params){ obj.params = Object.assign({}, obj.params); delete obj.params[paramId]; if (!Object.keys(obj.params).length) delete obj.params; } };
        allTimelines().forEach(timeline=>tracksOf(timeline).forEach(track=>(track.keys || []).forEach(key=>{
            if (key.type === "content" && key.cel){
                forEachClipNode(key.cel.layers, node=>{ if (node.clipId === clipId) strip(node); });
            }else if (key.type === "property" && key.props){
                let gov = governingContentKey(track, key.frame);
                Object.keys(key.props).forEach(id=>{
                    let node = gov && gov.cel ? findNodeById(gov.cel.layers || [], id) : undefined;
                    if (node && node.clipId === clipId && key.props[id]) strip(key.props[id]);
                });
            }
        })));
        forEachOverride(rec=>{
            let instClip = rec.instance ? clips.get(rec.instance.clipId) : undefined;
            if (!instClip) return;
            let changed = false;
            let out = Object.assign({}, rec.map);
            Object.keys(out).forEach(p=>{
                let e = out[p];
                if (!e || !e.params || !(paramId in e.params)) return;
                let walk = walkPath(clips, instClip, p);
                if (!walk.targetClip || walk.targetClip.id !== clipId) return;
                let ne = clonePlainData(e);
                strip(ne);
                out[p] = ne;
                changed = true;
            });
            if (changed) rec.set(out);
        });
        HistoryService.end();
        paramCtx = null;
        touchClip(clip);
        clearDrivenSetMemo();
        libraryChanged();
        timelineStructureChanged();
        return true;
    };

    // The parameters of the instance at `ref` with their resolved values at the playhead (R21):
    // [{id, name, type, value, min, max, options, source: "base"|"key"|"default"}].
    me.getInstanceParams = function(ref){
        let at = instanceAt(ref);
        if (!at || !Array.isArray(at.clip.params) || !at.clip.params.length) return [];
        let state = resolveTrackState(at.track, activeFrameIndex, library());
        let resolved = state && state.props && state.props[at.node.id] && state.props[at.node.id].params;
        let key = previousKey(at.track, activeFrameIndex);
        let keyed = key && key.type === "property" && key.props && key.props[at.node.id] && key.props[at.node.id].params;
        let values = paramEffectiveValues(at.clip, resolved);
        return at.clip.params.map(p=>{
            let out = {id: p.id, name: p.name, type: p.type, value: values.get(p.id)};
            if (p.type === "number"){ out.min = p.min; out.max = p.max; }
            else out.options = p.options.map(o=>({id: o.id, name: o.name}));
            out.source = keyed && p.id in keyed ? "key" : (resolved && p.id in resolved ? "base" : "default");
            return out;
        });
    };

    // Sets a parameter value on the instance at `ref` at the playhead (R15: the held property key,
    // or the instance base on its content key). One undo step.
    me.setInstanceParam = function(ref, paramId, value){
        let at = instanceAt(ref);
        if (!at) return false;
        let param = paramOf(at.clip, paramId);
        if (!param) return false;
        if (param.type === "switch"){ if (!param.options.some(o=>o.id === value)) return false; }
        else { value = toFiniteNumber(value); if (typeof value !== "number") return false; value = Math.min(param.max, Math.max(param.min, value)); }
        let key = previousKey(at.track, activeFrameIndex);
        if (!key || refusePinned(key)) return false;
        let ownBracket = !HistoryService.isRecording();
        if (key.type === "property"){
            if (ownBracket) HistoryService.start(EVENT.timelineHistory);
            key.props = key.props || {};
            let entry = Object.assign({}, key.props[at.node.id]);
            entry.params = Object.assign({}, entry.params, {[paramId]: value});
            key.props[at.node.id] = entry;
        }else{
            if (ownBracket) HistoryService.start(EVENT.layerHistory, at.path.slice());
            at.node.params = Object.assign({}, at.node.params, {[paramId]: value});
        }
        if (ownBracket) HistoryService.end();
        if (editStack.length) touchClip(editClip());
        clearRenderCache();
        cachedImage = undefined;
        EventBus.trigger(EVENT.timelineChanged);
        EventBus.trigger(EVENT.imageContentChanged);
        return true;
    };

    // Through a nested focus on an instance (025): the value as an override `params` (R16).
    me.setNestedParam = function(paramId, value){
        return me.setNestedOverride({params: {[paramId]: value}});
    };

    // Frames of the keys on track `trackIndex` that carry parameter values (R22).
    me.getParamKeyFrames = function(trackIndex){
        let track = tracks()[typeof trackIndex === "number" ? trackIndex : activeTrackIndex];
        let frames = [];
        (track && track.keys || []).forEach(key=>{
            let has = false;
            if (key.type === "property") has = Object.keys(key.props || {}).some(id=>key.props[id] && key.props[id].params && Object.keys(key.props[id].params).length);
            else if (key.cel) forEachClipNode(key.cel.layers, node=>{ if (node.params && Object.keys(node.params).length) has = true; });
            if (has && key.frame >= 0) frames.push(key.frame);
        });
        return frames;
    };

    // The value a frame of the edited parameter timeline stands for (the ruler labels).
    me.getParamFrameLabel = function(frame){
        let pe = editParamEntry();
        let param = pe && paramOf(clipById(pe.clipId), pe.paramId);
        if (!param) return undefined;
        let v = paramValueOf(param, frame);
        if (param.type === "switch"){ let o = param.options.find(x=>x.id === v); return o ? o.name : ""; }
        return String(Math.round(v * 100) / 100);
    };

    // ── markers (spec 024 R22, R28) ───────────────────────────────────────────────
    // All marker edits validate the resulting set (unique names, no overlap) and are one
    // libraryHistory step — except a rename, which also rewrites every cue and scrub frame that
    // references the marker in every timeline, so it is one imageHistory step.

    function uniqueMarkerName(clip, base){
        let names = new Set((clip.markers || []).map(m=>m.name));
        base = (typeof base === "string" && base.trim()) ? base.trim() : "Action";
        if (!names.has(base)) return base;
        let n = 2;
        while (names.has(base + " " + n)) n++;
        return base + " " + n;
    }

    // Adds a marker at `frame`. Returns {ok, reason?, name?}.
    me.addClipMarker = function(id, frame, name){
        if (refuseInParam("Markers")) return {ok: false, reason: "Not in a parameter"};
        let clip = clipById(id);
        if (!clip) return {ok: false, reason: "No such clip"};
        if (!Number.isInteger(frame) || frame < 0) return {ok: false, reason: "Invalid marker frame"};
        let markerName = uniqueMarkerName(clip, name || "Action " + ((clip.markers || []).length + 1));
        let result = me.setClipMarkers(id, copyMarkers(clip.markers).concat({frame: frame, name: markerName}));
        return result.ok ? {ok: true, name: markerName} : result;
    };

    function editMarker(id, name, change){
        let clip = clipById(id);
        if (!clip) return {ok: false, reason: "No such clip"};
        let markers = copyMarkers(clip.markers);
        let marker = markers.find(m=>m.name === name);
        if (!marker) return {ok: false, reason: "No such marker"};
        change(marker, markers);
        return me.setClipMarkers(id, markers.filter(m=>!m.remove));
    }

    me.moveClipMarker = function(id, name, frame){
        if (refuseInParam("Markers")) return {ok: false, reason: "Not in a parameter"};
        return editMarker(id, name, marker=>{
            let delta = frame - marker.frame;
            marker.frame = frame;
            // an explicit end moves along, keeping the range's length
            if (typeof marker.end === "number") marker.end += delta;
        });
    };

    // `end` null/undefined clears the explicit end (the range then runs to the next marker).
    me.setClipMarkerEnd = function(id, name, end){
        if (refuseInParam("Markers")) return {ok: false, reason: "Not in a parameter"};
        return editMarker(id, name, marker=>{
            if (typeof end === "number") marker.end = end; else delete marker.end;
        });
    };

    me.removeClipMarker = function(id, name){
        if (refuseInParam("Markers")) return {ok: false, reason: "Not in a parameter"};
        return editMarker(id, name, marker=>{ marker.remove = true; });
    };

    me.renameClipMarker = function(id, oldName, newName){
        if (refuseInParam("Markers")) return {ok: false, reason: "Not in a parameter"};
        let clip = clipById(id);
        if (!clip) return {ok: false, reason: "No such clip"};
        newName = typeof newName === "string" ? newName.trim() : "";
        if (!newName) return {ok: false, reason: "A marker needs a name"};
        if (newName === oldName) return {ok: true};
        let markers = copyMarkers(clip.markers);
        let marker = markers.find(m=>m.name === oldName);
        if (!marker) return {ok: false, reason: "No such marker"};
        marker.name = newName;
        let check = validateMarkers(clip, markers);
        if (!check.ok) return check;
        HistoryService.start(EVENT.imageHistory);
        clip.markers = markers;
        renameMarkerRefs(allTimelines(), library(), id, oldName, newName);
        renameOverrideMarkerRefs(id, oldName, newName);
        // string scrub frames in parameter keys that pose an instance of this clip (spec 026 R24)
        forEachParamKey((k, param, owner)=>{
            let index = clipNodeIndex(owner);
            Object.keys(k.props || {}).forEach(nid=>{
                let e = k.props[nid];
                let info = index.get(nid);
                if (e && e.frame === oldName && info && info.clipId === id) e.frame = newName;
            });
        });
        clearDrivenSetMemo();
        touchClip(clip);
        HistoryService.end();
        libraryChanged();
        timelineStructureChanged();
        return {ok: true};
    };

    me.getClipMarkerRanges = function(id){
        let clip = clipById(id);
        return clip ? markerRanges(clip) : [];
    };

    // ── cues and scrub frames (spec 024 R23–R29a) ─────────────────────────────────

    // The instance at `ref` in the active cel with its time at the playhead:
    //   {local, source: "default"|"cue"|"scrub", keyFrame, cue, frame, onKey, missingMarker, clipId}
    // `cue`/`frame` are the ones in effect (from `keyFrame`); `onKey` tells whether the playhead
    // sits on a key of the active track (a write then lands on that key, otherwise D8 inserts one).
    me.getInstanceTime = function(ref){
        let at = instanceAt(ref);
        if (!at) return undefined;
        let info = resolveInstanceTime(at.track, activeFrameIndex, at.node, at.key, at.clip);
        let data;
        if (info.key) data = info.key === at.key ? at.node : (info.key.props && info.key.props[at.node.id]);
        let cue = info.source === "cue" ? normalizeCue(data && data.cue) : null;
        let frame = info.source === "scrub" ? normalizeFrame(data && data.frame) : undefined;
        let missing = false;
        if (cue && cue.action && !rangeFor(at.clip, cue.action)) missing = true;
        if (typeof frame === "string" && !rangeFor(at.clip, frame)) missing = true;
        return {
            local: info.local,
            source: info.source,
            keyFrame: info.key ? info.key.frame : undefined,
            cue: cue,
            frame: frame,
            onKey: !!keyAt(at.track, activeFrameIndex),
            missingMarker: missing,
            clipId: at.clip.id
        };
    };

    // Where a cue/scrub write at the playhead lands for `at`: the key at the playhead, or — D8 — a
    // property key inserted there first (copying the resolved state, and the tween, so the frames
    // look the same). Returns {key} | {refused: reason}. Runs inside the caller's history step.
    function timeWriteTarget(at){
        let key = keyAt(at.track, activeFrameIndex);
        if (key) return {key};
        if (!canInsertPropertyKey(at.track, activeFrameIndex)) return {refused: "There is no key here to put a cue on"};
        let state = resolveTrackState(at.track, activeFrameIndex);
        if (!state) return {refused: "There is no key here to put a cue on"};
        key = makePropertyKey(activeFrameIndex, withoutTimeCues(clonePlainData(state.props)), !!state.tweening,state.key.easing);
        insertKey(at.track, key);
        return {key};
    }

    // Writes `apply(entry)` into the cue/frame data of the instance at `ref` at the playhead: the
    // node base on its content key, props[id] on a property key. One undo step. Returns true.
    function writeInstanceTime(ref, apply){
        let at = instanceAt(ref);
        if (!at) return false;
        let key = keyAt(at.track, activeFrameIndex);
        let onContentKey = key && key === at.key;
        if (onContentKey){
            // base node fields: a layer step, recorded against the instance itself
            if (!sameRef(activeLayerPath, at.path)) me.activateLayer(at.path);
            HistoryService.start(EVENT.layerHistory, at.path.slice());
            apply(at.node);
            HistoryService.end();
        }else{
            HistoryService.start(EVENT.timelineHistory);
            let target = timeWriteTarget(at);
            if (target.refused){
                HistoryService.neverMind();
                Modal.softAlert(target.refused, "Cue");
                return false;
            }
            target.key.props = target.key.props || {};
            let entry = Object.assign({}, target.key.props[at.node.id]);
            apply(entry);
            target.key.props[at.node.id] = entry;
            HistoryService.end();
        }
        if (editStack.length) touchClip(editClip());
        timelineStructureChanged();
        return true;
    }

    function sameRef(a, b){
        return Array.isArray(a) && Array.isArray(b) && a.join(",") === b.join(",");
    }

    // Sets (or with null clears) the cue on the instance at the playhead (R23, R29a). A cue and a
    // scrub frame never share a key: setting one removes the other there.
    me.setInstanceCue = function(ref, cue){
        if (refuseInParam("Cues (a parameter picks poses with Scrub frames instead)")) return false;
        let normalized = cue === null ? null : normalizeCue(cue || {});
        return writeInstanceTime(ref, entry=>{
            if (normalized){ entry.cue = normalized; delete entry.frame; }
            else delete entry.cue;
        });
    };

    // Sets (or with null clears) an explicit scrub frame — a number or a marker name (R26).
    me.setInstanceScrubFrame = function(ref, frame){
        let normalized = frame === null ? undefined : normalizeFrame(frame);
        if (frame !== null && typeof normalized === "undefined") return false;
        return writeInstanceTime(ref, entry=>{
            if (typeof normalized !== "undefined"){ entry.frame = normalized; delete entry.cue; }
            else delete entry.frame;
        });
    };

    // The per-instance default-clock offset (R11): a base value, not keyable. One undo step.
    me.setInstanceOffset = function(ref, offset){
        if (refuseInParam("The clock offset")) return false;
        let at = instanceAt(ref);
        if (!at || !Number.isFinite(offset)) return false;
        if (!sameRef(activeLayerPath, at.path)) me.activateLayer(at.path);
        HistoryService.start(EVENT.layerHistory, at.path.slice());
        at.node.offset = Math.round(offset);
        HistoryService.end();
        if (editStack.length) touchClip(editClip());
        timelineStructureChanged();
        return true;
    };

    // ── nested overrides (spec 025 §3.10) ─────────────────────────────────────────
    // A NESTED FOCUS is a node inside an instance, selected from above: the instance (by its
    // lineage id, so it survives playhead moves across content keys) plus an override path.
    // While it is set, the panels and tools edit overrides on the instance instead of anything in
    // the clip definition (N10). It belongs to one edit context.
    let nestedFocus = null;   // {instanceId, path, clipId}

    function nestedFocusChanged(){
        EventBus.trigger(EVENT.nestedFocusChanged);
        EventBus.trigger(EVENT.layersChanged);
    }

    function clearNestedFocus(){
        if (!nestedFocus) return;
        nestedFocus = null;
        nestedFocusChanged();
    }

    function nestedOpts(instancePath, path, excludeOwn){
        return {library: library(), track: activeTrack(), frame: activeFrameIndex, cel: currentFrame(),
            instancePath, path, excludeOwn: !!excludeOwn};
    }

    // The layer path of the focused instance in the active cel, or undefined.
    function focusInstancePath(){
        if (!nestedFocus || nestedFocus.clipId !== editClipId()) return undefined;
        let cel = currentFrame();
        return cel ? findPathById(cel.layers || [], nestedFocus.instanceId) : undefined;
    }

    // Sets (path) or clears (null) the nested focus on the instance at `ref` (default: active).
    // The path must resolve at the playhead. Activates the instance. Returns true on success.
    me.setNestedFocus = function(ref, path){
        if (path === null || typeof path === "undefined"){ clearNestedFocus(); return true; }
        if (refuseInParam("Overriding nested parts")) return false;
        let at = instanceAt(ref);
        let p = normalizePath(path);
        if (!at || !p) return false;
        let r = resolveNested(nestedOpts(at.path, p));
        if (!r.node) return false;
        if (!sameRef(activeLayerPath, at.path)) me.activateLayer(at.path);
        nestedFocus = {instanceId: at.node.id, path: p, clipId: editClipId()};
        nestedFocusChanged();
        return true;
    };

    // Where a static override write at the playhead lands for the instance at `instPath` (D7, the
    // setLayerKeyProps rule): the property key the frame is held from, or the instance's base on
    // its content key. → {kind: "key"|"base", key, node, track} | undefined
    function overrideTarget(instPath){
        let track = activeTrack();
        let cel = currentFrame();
        if (!track || !cel || !instPath) return undefined;
        let node = resolveLayerPath(cel.layers, instPath);
        if (!isClip(node)) return undefined;
        let key = previousKey(track, activeFrameIndex);
        if (!key) return undefined;
        return {kind: key.type === "property" ? "key" : "base", key, node, track};
    }

    function overrideMapAt(target){
        if (!target) return undefined;
        if (target.kind === "base") return target.node.overrides;
        let entry = target.key.props && target.key.props[target.node.id];
        return entry && entry.overrides;
    }

    function plainEntry(entry){
        let normalized = normalizeEntry(entry);
        return normalized ? JSON.parse(JSON.stringify(normalized)) : undefined;
    }

    // Replaces override `path` in `target` with mutate(current copy) — undefined removes it.
    function putOverride(target, path, mutate){
        let current = overrideMapAt(target);
        let next = plainEntry(mutate(current && current[path] ? clonePlainData(current[path]) : {}));
        let map = Object.assign({}, current || {});
        if (next) map[path] = next; else delete map[path];
        let empty = !Object.keys(map).length;
        if (target.kind === "base"){
            if (empty) delete target.node.overrides; else target.node.overrides = map;
        }else{
            target.key.props = target.key.props || {};
            let entry = Object.assign({}, target.key.props[target.node.id]);
            if (empty) delete entry.overrides; else entry.overrides = map;
            target.key.props[target.node.id] = entry;
        }
    }

    function overridesChanged(){
        if (editStack.length) touchClip(editClip());
        clearRenderCache();
        cachedImage = undefined;
        EventBus.trigger(EVENT.timelineChanged);
        EventBus.trigger(EVENT.imageContentChanged);
        nestedFocusChanged();
    }

    // One undo step (unless a gesture bracket is already open): a base write is a layer step on
    // the instance, a key write a timeline step — the same history types as the instance's own
    // props, so undo lands in the right clip (024-R21).
    function writeOverride(instPath, path, mutate){
        let target = overrideTarget(instPath);
        if (!target) return false;
        let ownBracket = !HistoryService.isRecording();
        if (ownBracket){
            if (target.kind === "base") HistoryService.start(EVENT.layerHistory, instPath.slice());
            else HistoryService.start(EVENT.timelineHistory);
        }
        putOverride(target, path, mutate);
        if (ownBracket) HistoryService.end();
        overridesChanged();
        return true;
    }

    const OVERRIDE_NUMERIC = ["x", "y", "scaleX", "scaleY", "rotation", "opacity"];

    // Merges `values` into the focused override at the playhead: x, y, scaleX, scaleY, rotation,
    // opacity, visible, mode ("absolute" | "relative"), bones {id: {angle, x, y, scale}}. A null value
    // removes that component. One undo step.
    me.setNestedOverride = function(values){
        let instPath = focusInstancePath();
        if (!instPath || !values || typeof values !== "object") return false;
        return writeOverride(instPath, nestedFocus.path, entry=>{
            OVERRIDE_NUMERIC.forEach(c=>{
                if (!(c in values)) return;
                if (values[c] === null){ delete entry[c]; return; }
                let v = toFiniteNumber(values[c]);
                if (typeof v === "number") entry[c] = v;
            });
            if ("visible" in values){
                if (values.visible === null) delete entry.visible; else entry.visible = !!values.visible;
            }
            if ("mode" in values){
                if (values.mode === "absolute") entry.mode = "absolute"; else delete entry.mode;
            }
            // parameter values for a focused nested instance (spec 026 R16); null removes one
            if (values.params && typeof values.params === "object"){
                let params = Object.assign({}, entry.params);
                Object.keys(values.params).forEach(id=>{ if (values.params[id] === null) delete params[id]; else params[id] = values.params[id]; });
                if (Object.keys(params).length) entry.params = params; else delete entry.params;
            }
            if (values.bones && typeof values.bones === "object"){
                let bones = Object.assign({}, entry.bones);
                Object.keys(values.bones).forEach(id=>{
                    if (values.bones[id] === null) delete bones[id];
                    else bones[id] = Object.assign({}, bones[id], values.bones[id]);
                });
                if (Object.keys(bones).length) entry.bones = bones; else delete entry.bones;
            }
            return entry;
        });
    };

    // Resolved values of the focused target: with every override (`now`) and without this level's
    // own entry for the path (`under`, what a relative entry is measured against).
    function focusResolved(){
        let instPath = focusInstancePath();
        if (!instPath) return undefined;
        let now = resolveNested(nestedOpts(instPath, nestedFocus.path));
        let under = resolveNested(nestedOpts(instPath, nestedFocus.path, true));
        if (!now.node || !under.node) return undefined;
        return {instPath, now, under};
    }

    function posedBonesMap(node, resolved){
        let map = {};
        if (!node || !node.armature) return map;
        applyPoseOverlay(node.armature.bones || [], resolved && resolved.bones).forEach(b=>{
            let p = b.pose || {};
            map[b.id] = {angle: p.angle || 0, x: p.x || 0, y: p.y || 0, scale: typeof p.scale === "number" ? p.scale : 1};
        });
        return map;
    }

    const ADDITIVE_COMPONENT = {x: true, y: true, rotation: true, angle: true};
    function relativeOf(c, target, under){
        if (ADDITIVE_COMPONENT[c]) return target - under;
        if (c === "opacity") return under ? target / under * 100 : 100;
        return under ? target / under : 1;
    }

    // Switches the focused override between relative and absolute, converting the components it
    // sets so the frame looks the same. One undo step.
    me.setNestedOverrideMode = function(mode){
        let f = focusResolved();
        if (!f) return false;
        let absolute = mode === "absolute";
        let R = f.now.resolved || {}, U = f.under.resolved || {};
        let rb = posedBonesMap(f.now.node, R), ub = posedBonesMap(f.under.node, U);
        let transformable = isGroup(f.now.node) || isClip(f.now.node);
        let base = c=>typeof U[c] === "number" ? U[c] : (c === "opacity" ? 100 : (c === "scaleX" || c === "scaleY" ? 1 : 0));
        let value = c=>typeof R[c] === "number" ? R[c] : base(c);
        return writeOverride(f.instPath, nestedFocus.path, entry=>{
            if ((entry.mode === "absolute") === absolute) return entry;
            OVERRIDE_NUMERIC.forEach(c=>{
                if (typeof entry[c] !== "number") return;
                if (!transformable && (c === "scaleX" || c === "scaleY" || c === "rotation")) return;
                entry[c] = absolute ? value(c) : relativeOf(c, value(c), base(c));
            });
            if (entry.bones){
                Object.keys(entry.bones).forEach(id=>{
                    let e = entry.bones[id], r = rb[id], u = ub[id];
                    if (!r || !u) return;
                    Object.keys(e).forEach(c=>{ e[c] = absolute ? r[c] : relativeOf(c, r[c], u[c]); });
                });
            }
            if (absolute) entry.mode = "absolute"; else delete entry.mode;
            return entry;
        });
    };

    // Poses the focused nested bone layer: `absMap` = {boneId: absolute pose}. Stored as deltas
    // against the un-overridden pose at the playhead (relative) so the clip's own animation keeps
    // playing underneath, or as-is in absolute mode (R24). One undo step (or part of a gesture).
    me.setNestedBonePoses = function(absMap){
        let f = focusResolved();
        if (!f || !absMap || !isBones(f.now.node)) return false;
        let ub = posedBonesMap(f.under.node, f.under.resolved);
        return writeOverride(f.instPath, nestedFocus.path, entry=>{
            let absolute = entry.mode === "absolute";
            let bones = Object.assign({}, entry.bones);
            Object.keys(absMap).forEach(id=>{
                let a = absMap[id], u = ub[id];
                if (!a || !u) return;
                let pose = {angle: a.angle || 0, x: a.x || 0, y: a.y || 0, scale: typeof a.scale === "number" ? a.scale : 1};
                bones[id] = absolute ? pose : {
                    angle: pose.angle - u.angle, x: pose.x - u.x, y: pose.y - u.y,
                    scale: relativeOf("scale", pose.scale, u.scale)
                };
            });
            entry.bones = bones;
            return entry;
        });
    };

    // The focused nested bone layer's poses as shown (every override applied): {boneId: pose}.
    me.getNestedBonePoses = function(){
        let instPath = focusInstancePath();
        if (!instPath) return undefined;
        let r = resolveNested(nestedOpts(instPath, nestedFocus.path));
        return r.node && isBones(r.node) ? posedBonesMap(r.node, r.resolved) : undefined;
    };

    // A document-space delta → the focused target's parent space (where its x/y apply), so a move
    // gesture lands under the cursor through any rotated/scaled instance chain (R23).
    me.nestedDocDeltaToLocal = function(dx, dy){
        let instPath = focusInstancePath();
        if (!instPath) return undefined;
        let r = resolveNested(nestedOpts(instPath, nestedFocus.path));
        if (!r.node) return undefined;
        let m = r.placeMatrix;
        let inv = matInvert({a: m.a, b: m.b, c: m.c, d: m.d, e: 0, f: 0});
        return matApply(inv, {x: dx, y: dy});
    };

    // Sets the focused target's RESOLVED placement to `T` ({x, y, scaleX, scaleY, rotation}, any
    // subset): stored relative to the un-overridden values, or as-is in absolute mode (R23).
    me.setNestedTransform = function(T){
        let f = focusResolved();
        if (!f || !T) return false;
        let U = f.under.resolved || {};
        let transformable = isGroup(f.now.node) || isClip(f.now.node);
        return writeOverride(f.instPath, nestedFocus.path, entry=>{
            let absolute = entry.mode === "absolute";
            OVERRIDE_NUMERIC.forEach(c=>{
                if (c === "opacity" || typeof T[c] !== "number") return;
                if (!transformable && (c === "scaleX" || c === "scaleY" || c === "rotation")) return;
                let u = typeof U[c] === "number" ? U[c] : (c === "scaleX" || c === "scaleY" ? 1 : 0);
                entry[c] = absolute ? T[c] : relativeOf(c, T[c], u);
            });
            return entry;
        });
    };

    // Time overrides (cue / scrub) follow 024-D8: on a keyless frame a property key is inserted
    // first; on the instance's content key they go to its base. One undo step.
    function writeNestedTime(apply){
        let instPath = focusInstancePath();
        if (!instPath) return false;
        let track = activeTrack();
        let node = resolveLayerPath(currentFrame().layers, instPath);
        let key = keyAt(track, activeFrameIndex);
        let gov = governingContentKey(track, activeFrameIndex);
        let path = nestedFocus.path;
        if (key && key === gov){
            HistoryService.start(EVENT.layerHistory, instPath.slice());
            putOverride({kind: "base", key, node, track}, path, apply);
            HistoryService.end();
        }else{
            HistoryService.start(EVENT.timelineHistory);
            let target = timeWriteTarget({track});
            if (target.refused){
                HistoryService.neverMind();
                Modal.softAlert(target.refused, "Cue");
                return false;
            }
            putOverride({kind: "key", key: target.key, node, track}, path, apply);
            HistoryService.end();
        }
        overridesChanged();
        timelineStructureChanged();
        return true;
    }

    // Cue (or null to clear) on the focused nested instance, as an override (R10, R25).
    me.setNestedCue = function(cue){
        let normalized = cue === null ? null : normalizeCue(cue || {});
        return writeNestedTime(entry=>{
            if (normalized){ entry.cue = normalized; delete entry.frame; }
            else delete entry.cue;
            return entry;
        });
    };

    me.setNestedScrubFrame = function(frame){
        let normalized = frame === null ? undefined : normalizeFrame(frame);
        if (frame !== null && typeof normalized === "undefined") return false;
        return writeNestedTime(entry=>{
            if (typeof normalized !== "undefined"){ entry.frame = normalized; delete entry.cue; }
            else delete entry.frame;
            return entry;
        });
    };

    // Removes the focused override at the playhead's write target, or (allKeys) from the
    // instance's base in every content key and from every property key of the track. One step.
    me.resetNestedOverride = function(opts){
        let instPath = focusInstancePath();
        if (!instPath) return false;
        let path = nestedFocus.path;
        if (!(opts && opts.allKeys)) return writeOverride(instPath, path, ()=>undefined);
        let track = activeTrack();
        let id = nestedFocus.instanceId;
        HistoryService.start(EVENT.imageHistory);
        (track.keys || []).forEach(key=>{
            if (key.type === "content" && key.cel){
                let p = findPathById(key.cel.layers || [], id);
                let node = p && resolveLayerPath(key.cel.layers, p);
                if (isClip(node) && node.overrides && node.overrides[path]) putOverride({kind: "base", key, node, track}, path, ()=>undefined);
            }else if (key.type === "property" && key.props && key.props[id] && key.props[id].overrides && key.props[id].overrides[path]){
                putOverride({kind: "key", key, node: {id}, track}, path, ()=>undefined);
            }
        });
        HistoryService.end();
        overridesChanged();
        return true;
    };

    // The focused override for the UI: names, target type, resolved values (with and without this
    // level's entry), the entry at the write target and where that is. undefined without a focus.
    me.getNestedFocus = function(){
        let instPath = focusInstancePath();
        if (!instPath) return undefined;
        let r = resolveNested(nestedOpts(instPath, nestedFocus.path));
        let target = overrideTarget(instPath);
        let map = overrideMapAt(target);
        let out = {
            instanceId: nestedFocus.instanceId, instancePath: instPath, path: nestedFocus.path,
            names: r.names || [], active: !!r.node, missing: r.missing,
            writeTarget: target ? target.kind : undefined, keyFrame: target ? target.key.frame : undefined,
            entry: map && map[nestedFocus.path] ? clonePlainData(map[nestedFocus.path]) : null,
            dangling: me.getDanglingOverrides(instPath).length
        };
        if (!r.node) return out;
        let node = r.node;
        out.type = node.type || "pixel";
        out.targetId = node.id;
        out.name = node.name;
        out.transformable = isGroup(node) || isClip(node);
        out.isClip = isClip(node);
        out.isBones = isBones(node);
        if (isClip(node)) out.targetClipId = node.clipId;
        let resolved = Object.assign({}, r.resolved || {});
        resolved.visible = isVisibleIn(node, r.props);
        if (isBones(node)) resolved.bones = posedBonesMap(node, r.resolved);
        out.resolved = resolved;
        // a focused nested instance's clip parameters with their values as shown (spec 026 R16)
        let targetClip = isClip(node) ? clipById(node.clipId) : undefined;
        if (targetClip && Array.isArray(targetClip.params) && targetClip.params.length){
            let values = paramEffectiveValues(targetClip, resolved.params);
            out.params = targetClip.params.map(p=>{
                let item = {id: p.id, name: p.name, type: p.type, value: values.get(p.id)};
                if (p.type === "number"){ item.min = p.min; item.max = p.max; }
                else item.options = p.options.map(o=>({id: o.id, name: o.name}));
                return item;
            });
        }
        out.local = r.local;
        return out;
    };

    // The bone tool's nested target (R24): the focused nested bone layer, the matrix from its scope
    // to the edit-level document, and its poses as shown. undefined unless the focus is a bone layer.
    me.getNestedBoneTarget = function(){
        let instPath = focusInstancePath();
        if (!instPath) return undefined;
        let r = resolveNested(nestedOpts(instPath, nestedFocus.path));
        if (!r.node || !isBones(r.node)) return undefined;
        return {node: r.node, matrix: r.fullMatrix, poses: posedBonesMap(r.node, r.resolved),
            key: nestedFocus.instanceId + "|" + nestedFocus.path + "|" + editClipId()};
    };

    // Snapshot / restore of the focused instance's override data on its track (base in every
    // content key, props on every property key), so a cancelled bone gesture can roll back what
    // it wrote live (the bone tool's counterpart of cloneBoneOverlayState).
    me.cloneNestedOverrideState = function(){
        if (!nestedFocus) return undefined;
        let track = activeTrack();
        if (!track) return undefined;
        let id = nestedFocus.instanceId;
        let snap = {id, track, keys: []};
        (track.keys || []).forEach(key=>{
            if (key.type === "content" && key.cel){
                let p = findPathById(key.cel.layers || [], id);
                let node = p && resolveLayerPath(key.cel.layers, p);
                if (node) snap.keys.push({key, node, map: node.overrides ? clonePlainData(node.overrides) : null});
            }else if (key.type === "property"){
                let entry = key.props && key.props[id];
                snap.keys.push({key, map: entry && entry.overrides ? clonePlainData(entry.overrides) : null});
            }
        });
        return snap;
    };

    me.restoreNestedOverrideState = function(snap){
        if (!snap) return false;
        snap.keys.forEach(rec=>{
            if (rec.node){
                if (rec.map) rec.node.overrides = rec.map; else delete rec.node.overrides;
            }else{
                rec.key.props = rec.key.props || {};
                let entry = Object.assign({}, rec.key.props[snap.id]);
                if (rec.map) entry.overrides = rec.map; else delete entry.overrides;
                if (Object.keys(entry).length) rec.key.props[snap.id] = entry; else delete rec.key.props[snap.id];
            }
        });
        overridesChanged();
        return true;
    };

    // ── override integrity (spec 025 §3.12) ──────────────────────────────────────────

    // Calls cb({map, set(map|null), instance, instanceId, timeline, track, key}) for every stored
    // override map: instance bases in every content key, props[id].overrides on every property key.
    function forEachOverride(cb){
        allTimelines().forEach(timeline=>{
            tracksOf(timeline).forEach(track=>{
                (track.keys || []).forEach(key=>{
                    if (key.type === "content" && key.cel){
                        forEachClipNode(key.cel.layers, node=>{
                            if (!node.overrides) return;
                            cb({map: node.overrides, instance: node, instanceId: node.id, timeline, track, key,
                                set: m=>{ if (m && Object.keys(m).length) node.overrides = m; else delete node.overrides; }});
                        });
                    }else if (key.type === "property" && key.props){
                        Object.keys(key.props).forEach(id=>{
                            let entry = key.props[id];
                            if (!entry || !entry.overrides) return;
                            let gov = governingContentKey(track, key.frame);
                            let node = gov && gov.cel ? findNodeById(gov.cel.layers || [], id) : undefined;
                            cb({map: entry.overrides, instance: node, instanceId: id, timeline, track, key,
                                set: m=>{
                                    let e = Object.assign({}, key.props[id]);
                                    if (m && Object.keys(m).length) e.overrides = m; else delete e.overrides;
                                    key.props[id] = e;
                                }});
                        });
                    }
                });
            });
        });
    }

    // Every parameter-timeline key of every clip: cb(key, param, clip, trackId) (spec 026).
    function forEachParamKey(cb){
        syncParamTracks();
        library().clips.forEach(clip=>(clip.params || []).forEach(p=>{
            Object.keys(p.tracks || {}).forEach(tid=>(p.tracks[tid] || []).forEach(k=>cb(k, p, clip, tid)));
        }));
    }

    // Layer ids alive in one clip's timeline.
    function clipLiveIds(clip){
        let live = new Set();
        forEachCelIn(clip.timeline, cel=>{
            (function walk(nodes){
                (nodes || []).forEach(n=>{ if (!n) return; if (n.id) live.add(n.id); if (isGroup(n)) walk(n.layers); });
            })(cel.layers);
        });
        return live;
    }

    // Drops parameter-key entries for lineages no longer in their clip (spec 026 R24: deleted,
    // or moved into another clip by Convert to Clip). Returns how many entries went.
    function pruneParamKeysOf(clip){
        if (!clip || !Array.isArray(clip.params) || !clip.params.length) return 0;
        syncParamTracks();
        let live = clipLiveIds(clip);
        let removed = 0;
        clip.params.forEach(p=>Object.keys(p.tracks || {}).forEach(tid=>(p.tracks[tid] || []).forEach(k=>{
            Object.keys(k.props || {}).forEach(id=>{ if (!live.has(id)){ delete k.props[id]; removed++; } });
        })));
        if (removed){ paramCtx = null; touchClip(clip); clearDrivenSetMemo(); }
        return removed;
    }

    // Rewrites every stored override path through fn(path, record) → new path | null (drop) | the
    // same path. An existing entry at the new path wins over a moved one.
    function rewriteOverridePaths(fn){
        forEachOverride(rec=>{
            let changed = false;
            let out = {};
            Object.keys(rec.map).forEach(p=>{
                let np = fn(p, rec);
                if (np === p){ if (!(p in out)) out[p] = rec.map[p]; return; }
                changed = true;
                if (np && !(np in out) && !Object.prototype.hasOwnProperty.call(rec.map, np)) out[np] = rec.map[p];
            });
            if (changed) rec.set(out);
        });
    }

    // Every layer id alive in a clip timeline (the only possible override targets).
    function liveClipIds(){
        let live = new Set();
        library().clips.forEach(clip=>forEachCelIn(clip.timeline, cel=>{
            (function walk(nodes){
                (nodes || []).forEach(n=>{
                    if (!n) return;
                    if (n.id) live.add(n.id);
                    if (isGroup(n)) walk(n.layers);
                });
            })(cel.layers);
        }));
        return live;
    }

    // Drops overrides whose path names a lineage that no longer exists anywhere (R29).
    function pruneVanishedOverrides(){
        let live = liveClipIds();
        rewriteOverridePaths(p=>pathSegments(p).every(seg=>live.has(seg)) ? p : null);
    }

    // Override cues / string scrub frames that target clip `clipId` follow a marker rename (R31).
    function renameOverrideMarkerRefs(clipId, oldName, newName){
        let clips = clipMap(library());
        forEachOverride(rec=>{
            let instClip = rec.instance ? clips.get(rec.instance.clipId) : undefined;
            if (!instClip) return;
            let changed = false;
            let out = Object.assign({}, rec.map);
            Object.keys(out).forEach(p=>{
                let e = out[p];
                if (!e || (!(e.cue && e.cue.action === oldName) && e.frame !== oldName)) return;
                let walk = walkPath(clips, instClip, p);
                if (!walk.targetClip || walk.targetClip.id !== clipId) return;
                let ne = clonePlainData(e);
                if (ne.cue && ne.cue.action === oldName) ne.cue.action = newName;
                if (ne.frame === oldName) ne.frame = newName;
                out[p] = ne;
                changed = true;
            });
            if (changed) rec.set(out);
        });
    }

    // Stored override maps of the instance lineage `id` on `track` (bases + property keys).
    function instanceOverrideRecords(track, id){
        let out = [];
        forEachOverride(rec=>{ if (rec.track === track && rec.instanceId === id) out.push(rec); });
        return out;
    }

    const warnedDangling = new Set();

    // Overrides of the instance at `ref` whose path no longer resolves in its clip at all (R28):
    // [{path, keyFrame, where: "base"|"key"}]. Deduped console warning per path.
    me.getDanglingOverrides = function(ref){
        let at = instanceAt(ref);
        if (!at) return [];
        let clips = clipMap(library());
        let out = [];
        instanceOverrideRecords(at.track, at.node.id).forEach(rec=>{
            Object.keys(rec.map).forEach(p=>{
                if (walkPath(clips, at.clip, p).missing === undefined) return;
                out.push({path: p, keyFrame: rec.key.frame, where: rec.key.type === "content" ? "base" : "key"});
                let warnKey = at.node.id + "|" + p;
                if (!warnedDangling.has(warnKey)){
                    warnedDangling.add(warnKey);
                    console.warn("Override " + p + " on instance " + at.node.id + " no longer resolves in clip " + at.clip.id + "; it is ignored");
                }
            });
        });
        return out;
    };

    // Removes the dangling overrides of the instance at `ref` (every key of its track). One step.
    me.cleanupOverrides = function(ref){
        let at = instanceAt(ref);
        if (!at) return 0;
        let clips = clipMap(library());
        let removed = 0;
        HistoryService.start(EVENT.imageHistory);
        instanceOverrideRecords(at.track, at.node.id).forEach(rec=>{
            let out = {};
            Object.keys(rec.map).forEach(p=>{
                if (walkPath(clips, at.clip, p).missing === undefined) out[p] = rec.map[p];
                else removed++;
            });
            if (Object.keys(out).length !== Object.keys(rec.map).length) rec.set(out);
        });
        if (removed) HistoryService.end(); else HistoryService.neverMind();
        if (removed) overridesChanged();
        return removed;
    };

    // The Free Transform box of the focused nested group / instance (R23), shaped like
    // getNodeTransformBox, in the target's parent space. The resizer carries the parent matrix
    // so scaled/rotated ancestors (including shear from nested transforms) remain editable.
    me.getNestedTransformBox = function(){
        let instPath = focusInstancePath();
        if (!instPath) return undefined;
        let r = resolveNested(nestedOpts(instPath, nestedFocus.path));
        let node = r.node;
        if (!node || !(isGroup(node) || isClip(node))) return undefined;
        let m = r.placeMatrix;
        if (Math.abs(m.a * m.d - m.b * m.c) < 1e-12) return undefined;
        let effective = effectiveProps(node, r.props);
        let bounds = getOpaqueBounds(node.render(r.props));
        if (!bounds) return undefined;
        let cx = (node.canvasX || 0) + bounds.x + bounds.w / 2;
        let cy = (node.canvasY || 0) + bounds.y + bounds.h / 2;
        let centerX, centerY, pivotDelta, clip;
        if (isClip(node) && (clip = clipById(node.clipId))){
            let doc = matApply(instanceMatrix(effective, clip.pivot), {x: cx, y: cy});
            centerX = doc.x;
            centerY = doc.y;
            pivotDelta = {x: cx - clip.pivot.x, y: cy - clip.pivot.y};
        }else{
            // a group rotates/scales about its content centre, which therefore only translates
            centerX = effective.x + cx;
            centerY = effective.y + cy;
        }
        let dispW = bounds.w * effective.scaleX;
        let dispH = bounds.h * effective.scaleY;
        let box = {
            x: centerX - dispW / 2, y: centerY - dispH / 2, w: dispW, h: dispH,
            rotation: effective.rotation || 0, centerX, centerY, baseW: bounds.w, baseH: bounds.h,
            start: {x: effective.x, y: effective.y}, nested: true, parentMatrix: m
        };
        if (pivotDelta){
            box.pivotDelta = pivotDelta;
            box.startTransform = {scaleX: effective.scaleX, scaleY: effective.scaleY, rotation: effective.rotation || 0};
        }
        return box;
    };

    // Edit in place shows the clip DEFINITION (D8, R27): outer overrides that reach into the edited
    // clip are not applied to it. → {count, from} — how many there are at the context frames, and the
    // name of the outermost level holding one — for the breadcrumb notice.
    me.getContextOverrideCount = function(){
        if (!editStack.length) return {count: 0};
        let frames = contextFrames();
        let count = 0, from;
        editStack.forEach((entry, i)=>{
            let parentClip = i === 0 ? undefined : clipById(editStack[i - 1].clipId);
            let timeline = i === 0 ? rootTimeline() : (parentClip && parentClip.timeline);
            let track = timeline && tracksOf(timeline)[entry.parentTrackIndex];
            let state = track ? resolveTrackState(track, frames[i], library()) : null;
            if (!state) return;
            let paths = new Set();
            let own = state.props && state.props[entry.instanceId];
            if (own && own.overrides) Object.keys(own.overrides).forEach(p=>paths.add(p));
            let times = state.overrideTimes && state.overrideTimes.get(entry.instanceId);
            if (times) times.forEach((ti, p)=>paths.add(p));
            let chain = editStack.slice(i + 1).map(level=>level.instanceId).join("/");
            let prefix = chain ? chain + "/" : "";
            paths.forEach(p=>{
                if (p.length <= prefix.length || p.slice(0, prefix.length) !== prefix) return;
                count++;
                if (!from) from = parentClip ? parentClip.name : "the document";
            });
        });
        return {count, from};
    };

    // The nested tree of the instance at `ref` (default: active) for the Layers panel (R19), each
    // item flagged `hasOverride` when this level carries an entry for its path at the playhead.
    me.getNestedTree = function(ref){
        let at = instanceAt(ref);
        if (!at) return [];
        let tree = nestedTree(nestedOpts(at.path));
        let state = resolveTrackState(at.track, activeFrameIndex, library());
        let own = new Set();
        let entry = state && state.props && state.props[at.node.id];
        if (entry && entry.overrides) Object.keys(entry.overrides).forEach(p=>own.add(p));
        let times = state && state.overrideTimes && state.overrideTimes.get(at.node.id);
        if (times) times.forEach((ti, p)=>own.add(p));
        (function flag(items){
            items.forEach(item=>{ item.hasOverride = own.has(item.path); flag(item.children || []); });
        })(tree);
        return tree;
    };

    // The override path of the deepest nested node under document point `point` inside the
    // instance at `ref` (default: active), or undefined (R21).
    me.getNestedPathAtPoint = function(point, ref){
        let at = instanceAt(ref);
        if (!at || !point) return undefined;
        // inside a clip, tools already work in clip-local space (identity edit space, 024 §3.8)
        return nestedPathAtPoint(nestedOpts(at.path), point);
    };

    // Frames of the keys on track `trackIndex` that carry overrides (timeline markers, R26).
    me.getOverrideKeyFrames = function(trackIndex){
        let track = tracks()[typeof trackIndex === "number" ? trackIndex : activeTrackIndex];
        let frames = [];
        (track && track.keys || []).forEach(key=>{
            let has = false;
            if (key.type === "property"){
                has = Object.keys(key.props || {}).some(id=>key.props[id] && key.props[id].overrides && Object.keys(key.props[id].overrides).length);
            }else if (key.cel){
                forEachClipNode(key.cel.layers, node=>{ if (node.overrides && Object.keys(node.overrides).length) has = true; });
            }
            if (has) frames.push(key.frame);
        });
        return frames;
    };

    // What an instance on track `trackIndex` plays over parent frames [from, to] (R30), for the
    // timeline sub-lane: [{frame, local, action, playback, scrub, instanceId, clipId}] with null
    // entries where the track shows no instance. The instance followed is the active layer when it
    // is an instance on this track, otherwise the topmost instance of the governing cel.
    me.getInstanceTimeSeries = function(trackIndex, from, to){
        let track = tracks()[trackIndex];
        let out = [];
        if (!track) return out;
        let lib = library();
        let preferId = isClip(activeLayer) && trackIndex === activeTrackIndex ? activeLayer.id : undefined;
        for (let f = Math.max(0, from | 0); f <= to; f++){
            let gov = governingContentKey(track, f);
            if (!gov){ out.push(null); continue; }
            let candidates = [];
            forEachClipNode(gov.cel.layers, n=>candidates.push(n));
            let node = (preferId && candidates.find(n=>n.id === preferId)) || candidates[candidates.length - 1];
            let clip = node && clipById(node.clipId);
            if (!clip){ out.push(null); continue; }
            let info = resolveInstanceTime(track, f, node, gov, clip);
            let data;
            if (info.key) data = info.key === gov ? node : (info.key.props && info.key.props[node.id]);
            let cue = info.source === "cue" ? normalizeCue(data && data.cue) : null;
            let action = cue && cue.action && rangeFor(clip, cue.action) ? cue.action : undefined;
            if (info.source === "scrub"){
                let range = markerRanges(clip).find(r=>info.local >= r.start && info.local <= r.end);
                action = range ? range.name : undefined;
            }
            let item = {
                frame: f,
                local: info.local,
                action: action,
                playback: info.source === "default" ? "loop" : (cue ? cue.playback : "scrub"),
                scrub: info.source === "scrub",
                source: info.source,
                length: clampLength(clip.length),
                instanceId: node.id,
                clipId: clip.id
            };
            // inside a cue's blend window (spec 025 R38): the weight of the new action and the
            // action it fades from (what the previous source plays at this frame)
            if (info.blend){
                let prev = resolveInstanceTime(track, f, node, gov, clip, {before: info.key.frame, noBlend: true});
                let prevData = prev.key ? (prev.key === gov ? node : (prev.key.props && prev.key.props[node.id])) : undefined;
                let prevCue = prev.source === "cue" ? normalizeCue(prevData && prevData.cue) : null;
                let from = prevCue && prevCue.action && rangeFor(clip, prevCue.action) ? prevCue.action : undefined;
                if (prev.source !== "cue"){
                    let range = markerRanges(clip).find(r=>prev.local >= r.start && prev.local <= r.end);
                    from = range ? range.name : undefined;
                }
                item.blendW = info.blend.w;
                item.blendFrom = from;
            }
            out.push(item);
        }
        return out;
    };

    // Whether any content key of track `trackIndex` holds a clip instance (the sub-lane is shown
    // only on such tracks).
    me.trackHasInstances = function(trackIndex){
        let track = tracks()[trackIndex];
        let found = false;
        ((track && track.keys) || []).forEach(key=>{
            if (!found && key.type === "content" && key.cel) forEachClipNode(key.cel.layers, ()=>{ found = true; });
        });
        return found;
    };

    // ── bone attachment (spec 024 §3.11, R31–R36) ─────────────────────────────────

    // Bone layers a node can attach to (D6): bone layers in the SAME layers[] array, same cel.
    // [{boneLayerId, boneId, name, layerName, boneName}]
    me.getAttachTargets = function(ref){
        let cel = currentFrame();
        let path = typeof ref === "undefined" ? activeLayerPath : toPath(ref);
        let p = cel && path && parentOf(cel.layers, path);
        let node = p && p.parent[p.index];
        if (!node || isBones(node)) return [];
        let out = [];
        p.parent.forEach(sibling=>{
            if (!isBones(sibling) || sibling === node || !sibling.armature) return;
            (sibling.armature.bones || []).forEach(bone=>{
                out.push({boneLayerId: sibling.id, boneId: bone.id, layerName: sibling.name,
                    boneName: bone.name || String(bone.id), name: (sibling.name || "Bones") + " › " + (bone.name || bone.id)});
            });
        });
        return out;
    };

    function nodeAt(ref){
        let cel = currentFrame();
        let path = typeof ref === "undefined" ? activeLayerPath : toPath(ref);
        let p = cel && path && parentOf(cel.layers, path);
        let node = p && p.parent[p.index];
        return node ? {node, parent: p.parent, path: path.slice()} : undefined;
    }

    // Attaches the node at `ref` to bone `boneId` of bone layer `boneLayerId` (same scope, D6).
    // The attachment is recorded against the rest pose — bind = inverse(skin at the playhead's
    // resolved pose) — so attaching while posed does not make the node jump (R33). Not keyable:
    // it animates only through the bone (R35). One undo step.
    me.attachToBone = function(ref, boneLayerId, boneId){
        if (refuseInParam("Bone attachment")) return false;
        let at = nodeAt(ref);
        if (!at || isBones(at.node)) return false;
        let boneLayer = at.parent.find(n=>isBones(n) && n.id === boneLayerId);
        if (!boneLayer) return false;
        let skin = boneSkinMatrix(boneLayer, boneId, me.getResolvedProps());
        if (!skin) return false;
        if (activeLayerPath.join(",") !== at.path.join(",")) me.activateLayer(at.path);
        HistoryService.start(EVENT.layerHistory, at.path.slice());
        at.node.attach = {boneLayerId: boneLayerId, boneId: boneId, bind: matInvert(skin)};
        HistoryService.end();
        attachmentChanged();
        return true;
    };

    function attachmentChanged(){
        if (editStack.length) touchClip(editClip());
        clearRenderCache();
        cachedImage = undefined;
        EventBus.trigger(EVENT.layersChanged);
        EventBus.trigger(EVENT.imageContentChanged);
        EventBus.trigger(EVENT.bonesChanged);
    }

    // What detaching `node` (under attach matrix A, resolved `props`) bakes into its own values:
    // groups and instances get their full placement back as x/y/scale/rotation (a polar
    // decomposition — `lossy` when a stretch along a non-axis bone leaves a skew); a leaf can only
    // carry a translation, so it keeps A at its content centre and is `lossy` when A rotates or
    // scales (spec 024 §3.11 refines R33).
    function detachPlan(node, A, props){
        let eff = effectiveProps(node, props);
        let isIdentityLinear = Math.abs(A.a - 1) < 1e-6 && Math.abs(A.b) < 1e-6 && Math.abs(A.c) < 1e-6 && Math.abs(A.d - 1) < 1e-6;
        if (isGroup(node) || isClip(node)){
            // the pivot the node's own transform turns about, in its parent scope
            let local;
            if (isClip(node)){
                let clip = clipById(node.clipId);
                local = clip ? clip.pivot : {x: 0, y: 0};
            }else{
                let b = getOpaqueBounds(node.render(props));
                local = b ? {x: b.x + b.w / 2, y: b.y + b.h / 2} : {x: 0, y: 0};
            }
            let placed = matApply(A, {x: eff.x + local.x, y: eff.y + local.y});
            let L = matMultiply(matRotate(eff.rotation || 0), matScale(eff.scaleX, eff.scaleY));
            let Lp = matMultiply({a: A.a, b: A.b, c: A.c, d: A.d, e: 0, f: 0}, L);
            let sx = Math.hypot(Lp.a, Lp.b);
            let rotation = Math.atan2(Lp.b, Lp.a) * 180 / Math.PI;
            let sy = sx ? (Lp.a * Lp.d - Lp.b * Lp.c) / sx : 1;
            let skew = sx && sy ? (Lp.a * Lp.c + Lp.b * Lp.d) / (sx * Math.abs(sy)) : 0;
            return {
                values: {x: Math.round(placed.x - local.x), y: Math.round(placed.y - local.y),
                    scaleX: sx, scaleY: sy, rotation: rotation},
                lossy: Math.abs(skew) > 1e-3
            };
        }
        let canvas = node.getCanvasType ? node.getCanvasType() : undefined;
        let b = canvas ? getOpaqueBounds(node.render(props)) : null;
        let q = b ? {x: eff.x + (node.canvasX || 0) + b.x + b.w / 2, y: eff.y + (node.canvasY || 0) + b.y + b.h / 2}
                  : {x: eff.x, y: eff.y};
        let moved = matApply(A, q);
        return {values: {x: Math.round(eff.x + moved.x - q.x), y: Math.round(eff.y + moved.y - q.y)}, lossy: !isIdentityLinear};
    }

    function attachMatrixOf(node, parent, props){
        let map = buildAttachMap(parent, props);
        return (map && map.get(node)) || matIdentity();
    }

    // For the bone overlay (R35): every node attached to `boneLayer` in its scope, as
    // [{boneId, x, y}] — the node's (pivot or content) centre where it currently shows, in scope
    // coordinates.
    me.getAttachmentLinks = function(boneLayer){
        let cel = currentFrame();
        if (!cel || !boneLayer) return [];
        let props = me.getResolvedProps();
        let out = [];
        (function walk(nodes){
            if (nodes.indexOf(boneLayer) >= 0){
                let map = buildAttachMap(nodes, props);
                nodes.forEach(n=>{
                    if (!n.attach || n.attach.boneLayerId !== boneLayer.id) return;
                    let eff = effectiveProps(n, props);
                    let local;
                    if (isClip(n)){
                        let clip = clipById(n.clipId);
                        local = clip ? {x: eff.x + clip.pivot.x, y: eff.y + clip.pivot.y} : {x: eff.x, y: eff.y};
                    }else{
                        let b = getOpaqueBounds(n.render(props));
                        local = b ? {x: eff.x + (n.canvasX || 0) + b.x + b.w / 2, y: eff.y + (n.canvasY || 0) + b.y + b.h / 2}
                                  : {x: eff.x, y: eff.y};
                    }
                    let m = map && map.get(n);
                    let p = m ? matApply(m, local) : local;
                    out.push({boneId: n.attach.boneId, x: p.x, y: p.y});
                });
                return;
            }
            nodes.forEach(n=>{ if (isGroup(n)) walk(n.layers || []); });
        })(cel.layers);
        return out;
    };

    // Would detaching the node at `ref` keep it exactly where it is? (the UI warns when not)
    me.canDetachExactly = function(ref){
        let at = nodeAt(ref);
        if (!at || !at.node.attach) return true;
        let props = me.getResolvedProps();
        return !detachPlan(at.node, attachMatrixOf(at.node, at.parent, props), props).lossy;
    };

    // Detaches, baking the current resolved placement into the node (no jump where the node type
    // can represent it). One undo step. Returns {ok, lossy}.
    me.detach = function(ref){
        if (refuseInParam("Bone attachment")) return {ok: false};
        let at = nodeAt(ref);
        if (!at || !at.node.attach) return {ok: false};
        let props = me.getResolvedProps();
        let plan = detachPlan(at.node, attachMatrixOf(at.node, at.parent, props), props);
        if (activeLayerPath.join(",") !== at.path.join(",")) me.activateLayer(at.path);
        HistoryService.start(EVENT.imageHistory);
        delete at.node.attach;
        me.setLayerKeyProps(at.path, plan.values);
        HistoryService.end();
        attachmentChanged();
        return {ok: true, lossy: plan.lossy};
    };

    // Detaches every node attached to bone layer `boneLayerId` (to bone `boneId` when given) in
    // every cel that holds that bone layer, baking each placement into its base values (R36).
    // Runs inside the caller's history step (deleting the bone / the bone layer).
    // `onlyCel` (default: the active cel) limits the sweep to one cel: an id names a lineage
    // (spec 025 R1), so the same rig lives on — with its bones — in the other content keys of the
    // track, and their attachments must stay. Pass `false` to sweep every cel.
    me.detachAllFor = function(boneLayerId, boneId, onlyCel){
        let count = 0;
        let scope = onlyCel === false ? undefined : (onlyCel || currentFrame());
        allTimelines().forEach(timeline=>forEachCelIn(timeline, (cel, key, track)=>{
            if (scope && cel !== scope) return;
            let active = cel === currentFrame();
            let props = active ? me.getResolvedProps() : (resolveTrackState(track, key.frame) || {}).props;
            (function walk(nodes){
                if (nodes.some(n=>isBones(n) && n.id === boneLayerId)){
                    nodes.forEach(n=>{
                        if (!n.attach || n.attach.boneLayerId !== boneLayerId) return;
                        if (typeof boneId !== "undefined" && n.attach.boneId !== boneId) return;
                        let plan = detachPlan(n, attachMatrixOf(n, nodes, props), props);
                        delete n.attach;
                        Object.assign(n, plan.values);
                        count++;
                    });
                }
                nodes.forEach(n=>{ if (isGroup(n)) walk(n.layers || []); });
            })(cel.layers);
        }));
        if (count) attachmentChanged();
        return count;
    };

    // Drops edit-stack levels whose clip no longer exists (undo of a create, crafted files).
    function validateEditStack(){
        let i = editStack.findIndex(entry=>!clipById(entry.clipId)
            || (entry.kind === "param" && !paramOf(clipById(entry.clipId), entry.paramId)));
        if (i < 0) return;
        editStack.length = i;
        EventBus.trigger(EVENT.editContextChanged);
    };

    me.activateTrack = function(index){
        if (typeof index !== "number" || index < 0 || index >= tracks().length) return;
        if (index === activeTrackIndex) return;
        rememberActiveLayer();
        clearNestedFocus();
        activeTrackIndex = index;
        cachedImage = undefined;
        resolveActiveLayer();
        holdRenderCache(()=>{
            EventBus.trigger(EVENT.timelineChanged);
            EventBus.trigger(EVENT.layersChanged);
            EventBus.trigger(EVENT.imageContentChanged);
        });
    };

    // A new track starts with one content key at frame 0 holding one blank layer, and
    // becomes the active track (it is added on top of the z-order).
    // "Track <n>", or `preferred` when it is free — an imported animation is easier to find
    // by its file name than by a number.
    function uniqueTrackName(preferred){
        let taken = new Set(tracks().map(track=>track.name));
        if (preferred && !taken.has(preferred)) return preferred;
        let base = preferred || "Track";
        let n = preferred ? 2 : tracks().length + 1;
        while (taken.has(base + " " + n)) n++;
        return base + " " + n;
    }

    me.addTrack = function(name){
        if (refuseInParam("Adding a track")) return;
        if (!editTimeline()) return;
        HistoryService.start(EVENT.timelineHistory);
        let index = tracks().length;
        let track = makeTrack(name || uniqueTrackName(),
            makeCel([Layer(currentFile.width, currentFile.height, "Layer 1")]));
        tracks().push(track);
        rememberActiveLayer();
        activeTrackIndex = index;
        resolveActiveLayer();
        HistoryService.end();
        timelineStructureChanged();
        return track;
    };

    // Rewrites every id in a cloned layer struct to a freshly allocated one, recording
    // old → new as it goes. withFreshIds() is enough when the copy has no property keys to
    // repoint; a duplicated TRACK does, so it needs the mapping rather than just the strip.
    // Points copied `attach.boneLayerId`s at the copied bone layers (spec 024 §3.11): every copy
    // path that refreshes ids must do this, or an attachment keeps following the ORIGINAL rig.
    // `map` is old id → new id; an id that was not copied is left alone (a duplicate of one node
    // keeps following its sibling rig).
    function remapAttachIds(nodes, map){
        (nodes || []).forEach(node=>{
            if (!node) return;
            if (node.attach && map[node.attach.boneLayerId]) node.attach.boneLayerId = map[node.attach.boneLayerId];
            if (isGroup(node)) remapAttachIds(node.layers, map);
        });
    }

    // The old → new id map of a copy made by a fresh-id clone/restore, by walking the source and
    // the copy in parallel (same structure).
    function copyIdMap(sources, copies, map){
        map = map || {};
        (sources || []).forEach((source, i)=>{
            let copy = copies && copies[i];
            if (!source || !copy) return;
            if (source.id && copy.id) map[source.id] = copy.id;
            if (isGroup(source) && isGroup(copy)) copyIdMap(source.layers, copy.layers, map);
        });
        return map;
    }

    // One copy operation maps each source id to ONE fresh id: the same id in several content keys
    // is one lineage (spec 025 R1), and its copies must form one lineage too.
    function remapIds(struct,map){
        if (!struct) return struct;
        if (struct.id){
            let fresh = map[struct.id] || Layer.nextId();
            map[struct.id] = fresh;
            struct.id = fresh;
        }
        if (Array.isArray(struct.layers)) struct.layers.forEach(child=>remapIds(child,map));
        return struct;
    }

    // Deep copies of `list` (tracks): every cel copied through Layer.clone/restore with fresh
    // layer ids (recorded old → new in `idMap`) and every property key repointed at the copies.
    // Returns a Promise for the new track array.
    function copyTracks(list, idMap){
        let pending = [];
        let copied = (list || []).map(source=>({
            id: source.id,
            name: source.name,
            visible: source.visible !== false,
            locked: !!source.locked,
            mask: !!source.mask,
            keys: (source.keys || []).map(key=>{
                if (key.type !== "content") return makePropertyKey(key.frame, clonePlainData(key.props), key.tween,key.easing);
                let cel = makeCel();
                cel.activeLayerIndex = (key.cel && key.cel.activeLayerIndex) || 0;
                ((key.cel && key.cel.layers) || []).forEach(node=>{
                    let copy = Layer(currentFile.width, currentFile.height, node.name);
                    cel.layers.push(copy);
                    pending.push(copy.restore(remapIds(node.clone(false), idMap)));
                });
                return makeContentKey(key.frame, cel, key.tween,key.easing);
            })
        }));
        return Promise.all(pending).then(()=>{
            copied.forEach(track=>track.keys.forEach(key=>{
                if (key.type === "content" && key.cel) remapAttachIds(key.cel.layers, idMap);
                if (key.type !== "property" || !key.props) return;
                let props = {};
                Object.keys(key.props).forEach(id=>{ props[idMap[id] || id] = key.props[id]; });
                key.props = props;
            }));
            return copied;
        });
    }

    // A full copy of a track — every cel deep-copied, every key kept at its own frame —
    // inserted directly ABOVE the source, i.e. one step up the z-order. Returns a Promise
    // because the cel copies go through Layer.clone/restore.
    //
    // The copy's property keys are repointed at the copied nodes through the id map: sharing
    // ids with the source would make one property key animate both tracks at once.
    //
    // Note that inserting a track between two others changes what a mask track sits on top
    // of: duplicating a masked track hands the mask to the duplicate (the mask track is still
    // directly above whatever is at that index). That follows from "right above" and is one
    // undo away.
    me.duplicateTrack = function(trackIndex){
        if (refuseInParam("Duplicating a track")) return;
        let index = typeof trackIndex === "number" ? trackIndex : activeTrackIndex;
        let source = tracks()[index];
        if (!source) return;

        let idMap = {};
        let pending = [];
        let keys = (source.keys || []).map(key=>{
            if (key.type !== "content"){
                return makePropertyKey(key.frame, clonePlainData(key.props), key.tween,key.easing);
            }
            let cel = makeCel();
            cel.activeLayerIndex = (key.cel && key.cel.activeLayerIndex) || 0;
            (((key.cel && key.cel.layers) || [])).forEach(node=>{
                // Copies are created at the document size, exactly as ImageFile.restore()
                // does, so a duplicate is no lossier than a save/load round trip.
                let copy = isGroup(node)
                    ? Layer.makeGroup(currentFile.width, currentFile.height, node.name)
                    : Layer(currentFile.width, currentFile.height, node.name);
                cel.layers.push(copy);
                pending.push(copy.restore(remapIds(node.clone(false), idMap)));
            });
            return makeContentKey(key.frame, cel, key.tween,key.easing);
        });

        return Promise.all(pending).then(()=>{
            keys.forEach(key=>{
                if (key.type === "content" && key.cel) remapAttachIds(key.cel.layers, idMap);
                if (key.type !== "property" || !key.props) return;
                let props = {};
                Object.keys(key.props).forEach(id=>{ props[idMap[id] || id] = key.props[id]; });
                key.props = props;
            });
            HistoryService.start(EVENT.timelineHistory);
            let copy = {
                name: DuplicateName(source.name, tracks()),
                visible: source.visible !== false,
                locked: !!source.locked,
                mask: !!source.mask,
                keys: keys
            };
            tracks().splice(index + 1, 0, copy);
            // the clip's parameters pose the copy like the source (spec 026 R23)
            let owner = editClip();
            if (owner && Array.isArray(owner.params) && owner.params.length && source.id){
                ensureTrackIds(editTimeline());
                syncParamTracks();
                owner.params.forEach(p=>{
                    let keys = p.tracks && p.tracks[source.id];
                    if (!keys || !copy.id) return;
                    p.tracks[copy.id] = keys.map(k=>{
                        let props = {};
                        Object.keys(k.props || {}).forEach(oldId=>{ props[idMap[oldId] || oldId] = clonePlainData(k.props[oldId]); });
                        return {frame: k.frame, type: "property", tween: k.tween, ...easingData(k.easing), props};
                    });
                });
                clearDrivenSetMemo();
            }
            rememberActiveLayer();
            activeTrackIndex = index + 1;
            resolveActiveLayer();
            HistoryService.end();
            timelineStructureChanged();
            return copy;
        });
    };

    // Removing the last remaining track is refused, like removing the last layer today.
    me.removeTrack = function(index){
        if (refuseInParam("Removing a track")) return;
        if (typeof index !== "number") index = activeTrackIndex;
        let list = tracks();
        if (list.length <= 1 || index < 0 || index >= list.length) return false;
        HistoryService.start(EVENT.timelineHistory);
        list.splice(index,1);
        if (activeTrackIndex >= list.length) activeTrackIndex = list.length - 1;
        resolveActiveLayer();
        HistoryService.end();
        timelineStructureChanged();
        return true;
    };

    // Track order IS the global z-order (decision 7), so this is a z-order operation.
    me.moveTrack = function(from,to){
        if (refuseInParam("Moving a track")) return;
        let list = tracks();
        if (list.length <= 1) return false;
        if (from < 0 || from >= list.length) return false;
        if (to < 0) to = 0;
        if (to >= list.length) to = list.length - 1;
        if (from === to) return false;
        HistoryService.start(EVENT.timelineHistory);
        let track = list[from];
        list.splice(from,1);
        list.splice(to,0,track);
        activeTrackIndex = list.indexOf(track);
        resolveActiveLayer();
        HistoryService.end();
        timelineStructureChanged();
        return true;
    };

    me.toggleTrack = function(index){
        let track = tracks()[typeof index === "number" ? index : activeTrackIndex];
        if (!track) return;
        track.visible = !track.visible;
        timelineStructureChanged();
    };

    me.toggleTrackLock = function(index){
        let track = tracks()[typeof index === "number" ? index : activeTrackIndex];
        if (!track) return;
        track.locked = !track.locked;
        EventBus.trigger(EVENT.timelineChanged);
        EventBus.trigger(EVENT.layersChanged);
    };

    // Turns a track into a mask for the track directly beneath it (and back). The bottom-most
    // track has nothing to mask, so it is refused — a mask there would only hide itself.
    me.toggleTrackMask = function(index){
        if (refuseInParam("Mask tracks")) return;
        if (typeof index !== "number") index = activeTrackIndex;
        let track = tracks()[index];
        if (!track) return false;
        if (!track.mask && index === 0) return false;
        HistoryService.start(EVENT.timelineHistory);
        track.mask = !track.mask;
        HistoryService.end();
        timelineStructureChanged();
        return true;
    };

    me.canBeMaskTrack = function(index){
        if (typeof index !== "number") index = activeTrackIndex;
        let track = tracks()[index];
        if (!track) return false;
        return !!track.mask || index > 0;
    };

    me.renameTrack = function(index,name){
        let track = tracks()[typeof index === "number" ? index : activeTrackIndex];
        if (!track || typeof name !== "string" || !name.length) return;
        track.name = name;
        EventBus.trigger(EVENT.timelineChanged);
        EventBus.trigger(EVENT.layersChanged);
    };

    let timelineBatch = false;
    let timelineSelectionProvider;
    me.setTimelineSelectionProvider = provider=>{ timelineSelectionProvider = provider; };

    function timelineStructureChanged(){
        if (timelineBatch) return;
        syncParamTracks();
        ensureAllTrackIds();
        clearRenderCache();
        cachedImage = undefined;
        EventBus.trigger(EVENT.timelineChanged);
        EventBus.trigger(EVENT.layersChanged);
        EventBus.trigger(EVENT.imageContentChanged);
        EventBus.trigger(EVENT.framesChanged);
    }

    // ── keyframes ─────────────────────────────────────────────────────────────────

    me.applyTimelineSelection = async function(operation, frame, options){
        if (timelineBatch) return false;
        options = options || {};
        if (typeof frame !== "number") frame = activeFrameIndex;
        const range = options.selection || (timelineSelectionProvider && timelineSelectionProvider());
        const selected = range && activeTrackIndex >= (range.trackFrom ?? range.trackIndex)
            && activeTrackIndex <= (range.trackTo ?? range.trackIndex);
        const indices = selected
            ? Array.from({length:(range.trackTo ?? range.trackIndex) - (range.trackFrom ?? range.trackIndex) + 1}, (_,i)=>(range.trackFrom ?? range.trackIndex)+i)
            : [activeTrackIndex];
        if (operation === "remove") indices.reverse();
        const from = selected ? range.from : frame;
        const to = selected ? range.to : frame;
        if ((operation === "key" || operation === "insert" || operation === "deleteFrames") && refuseInParam("Content keys")) return false;
        if (operation === "tween" && refuseInParam("Tweening (parameter keys always interpolate)")) return false;
        if (operation !== "insert" && operation !== "deleteFrames" && !indices.some(index=>{
            const track = tracks()[index];
            if (!track) return false;
            for (let at = from; at <= to; at++){
                const key = keyAt(track,at);
                if (operation === "key" && !key) return true;
                if (operation === "property" && canInsertPropertyKey(track,at)) return true;
                if (operation === "tween" && key && canTween(track,key)) return true;
                if (operation === "easing"){
                    const source = key || previousKey(track,at);
                    if (source && source.tween && canTween(track,source)) return true;
                }
                if (operation === "remove" && key) return true;
            }
            return false;
        })) return false;
        const originalTrack = activeTrackIndex;
        const originalTrackObject = activeTrack();
        const originalFrame = activeFrameIndex;
        const tweenState = options.state ?? !keyAt(activeTrack(), frame)?.tween;
        await HistoryService.groupTimeline(async ()=>{
            timelineBatch = true;
            try {
                for (const index of indices){
                    if (!tracks()[index]) continue;
                    me.activateTrack(index);
                    const targetTrack = activeTrack();
                    if (operation === "insert"){
                        me.insertFrame(from, to - from + 1);
                        continue;
                    }
                    if (operation === "deleteFrames"){
                        await me.removeFrames(from,to-from+1);
                        continue;
                    }
                    const frames = Array.from({length:to-from+1}, (_,i)=>from+i);
                    if (operation === "remove") frames.reverse();
                    for (const at of frames){
                        if (!tracks().includes(targetTrack)) break;
                        const key = keyAt(activeTrack(), at);
                        if (operation === "key" && !key){
                            if (options.copy) activeFrameIndex = originalFrame;
                            await me.addKeyframe(at, options);
                        }
                        if (operation === "property") me.addPropertyKeyframe(at);
                        if (operation === "tween") me.setKeyTween(at, tweenState);
                        if (operation === "easing") me.setTweenEasing(at,options.easing);
                        if (operation === "remove" && key) me.removeKeyframe(at);
                    }
                }
            } finally {
                activeTrackIndex = tracks().includes(originalTrackObject) ? tracks().indexOf(originalTrackObject) : Math.min(originalTrack, tracks().length - 1);
                activeFrameIndex = Math.min(originalFrame, editLength() - 1);
                resolveActiveLayer();
                timelineBatch = false;
            }
        });
        timelineStructureChanged();
        return true;
    };

    // Validate every row before committing so a blocked row refuses the whole rectangle.
    me.canMoveTimelineSelection = function(indices, frames, delta, copy, propertiesOnly){
        if (!Number.isInteger(delta) || !delta || frames.some(frame=>frame + delta < 0)) return false;
        let hasKeys = false;
        for (const index of indices){
            const track = tracks()[index];
            if (!track) return false;
            const sources = track.keys.filter(key=>frames.includes(key.frame));
            if (!sources.length) continue;
            hasKeys = true;
            if (copy){
                if (!propertiesOnly && editParamEntry() && sources.some(key=>key.type === "content")) return false;
                if (sources.some(key=>keyAt(track, key.frame + delta))) return false;
                if (sources.some(key=>(propertiesOnly || key.type === "property") &&
                    !track.keys.some(content=>content.type === "content" && content.frame <= key.frame + delta) &&
                    !( !propertiesOnly && sources.some(content=>content.type === "content" && content.frame <= key.frame)))) return false;
            } else {
                const trial = {...track, keys:track.keys.map(key=>({...key}))};
                if (!moveKeys(trial, frames, delta)) return false;
            }
        }
        return hasKeys;
    };

    me.moveTimelineSelection = async function(indices, frames, delta, copy, propertiesOnly){
        if (timelineBatch || !me.canMoveTimelineSelection(indices, frames, delta, copy, propertiesOnly)) return false;
        await HistoryService.groupTimeline(async ()=>{
            timelineBatch = true;
            try {
                for (const index of indices){
                    if (!tracks()[index].keys.some(key=>frames.includes(key.frame))) continue;
                    if (copy) await me.copyKeyframes(frames, delta, index, propertiesOnly);
                    else me.moveKeyframes(frames, delta, index);
                }
            } finally {
                timelineBatch = false;
            }
        });
        timelineStructureChanged();
        return true;
    };

    function extendEditedClipForKey(frame){
        if (editParamEntry()) return;
        const clip = editClip();
        if (clip && frame >= clip.length){
            clip.length = clampLength(frame + 1);
            touchClip(clip);
        }
    }

    // A deep copy of what the track currently shows at `frame`: the governing cel's layer
    // tree with the RESOLVED (possibly tweened) values baked into the copies' base
    // x/y/opacity. The copies keep the source layer ids (the same lineage, spec 025 R1).
    function copyResolvedCel(track,frame){
        let state = resolveTrackState(track, frame);
        if (!state) return Promise.resolve(makeCel([Layer(currentFile.width, currentFile.height, "Layer 1")]));
        let cel = makeCel();
        cel.activeLayerIndex = state.cel.activeLayerIndex || 0;
        let pending = [];
        state.cel.layers.forEach(node=>{
            let copy = isGroup(node)
                ? Layer.makeGroup(currentFile.width, currentFile.height, node.name)
                : Layer(currentFile.width, currentFile.height, node.name);
            // A content-key copy CONTINUES the layer over time, so it keeps the source ids: an id
            // names a lineage, not one node object (spec 025 R1). The copy is still an
            // independent node with its own pixels.
            let struct = withResolvedProps(node.clone(false),node,state.props);
            // Preserve the visible pose and nested overlays in the copied content key.
            (function bake(s,n){
                const entry = state.props && state.props[n.id];
                if (entry){
                    if (isBones(n) && s.armature && entry.bones){
                        s.armature.bones.forEach(b=>{ if (entry.bones[b.id]) b.pose = {...b.pose,...entry.bones[b.id]}; });
                    }
                    if (isVector(n) && s.vector && (entry.nodes || entry.curves)) s.vector = poseVector(s.vector,entry.nodes,entry.curves);
                    if (isClip(n)){
                        ["cue","frame","overrides","params"].forEach(prop=>{ if (entry[prop] !== undefined) s[prop] = clonePlainData(entry[prop]); });
                    }
                }
                if (isGroup(n) && s.layers) s.layers.forEach((child,index)=>bake(child,n.layers[index]));
            })(struct,node);
            cel.layers.push(copy);
            pending.push(copy.restore(struct));
        });
        return Promise.all(pending).then(()=>{
            remapAttachIds(cel.layers, copyIdMap(state.cel.layers, cel.layers));
            return cel;
        });
    }

    // Content key on the active track. Returns a Promise when `copy` is set (the deep copy
    // of the cel is asynchronous), so callers can sequence history around it.
    me.addKeyframe = function(frame,options){
        if (refuseInParam("Content keys")) return;
        options = options || {};
        let track = activeTrack();
        if (!track) return;
        if (typeof frame !== "number") frame = activeFrameIndex;
        if (frame < 0) return;

        let finish = (cel)=>{
            HistoryService.start(EVENT.timelineHistory);
            insertKey(track, makeContentKey(frame, cel));
            extendEditedClipForKey(frame);
            activeFrameIndex = frame;
            resolveActiveLayer();
            HistoryService.end();
            timelineStructureChanged();
        };

        if (options.copy){
            return copyResolvedCel(track, activeFrameIndex).then(finish);
        }
        finish(makeCel([Layer(currentFile.width, currentFile.height, "Layer 1")]));
    };

    // Insert timeline space without creating a key or changing the existing cels.
    me.insertFrame = function(frame,count){
        if (refuseInParam("Insert Frame")) return false;
        let track = activeTrack();
        if (!track) return false;
        if (typeof frame !== "number") frame = activeFrameIndex;
        if (!Number.isInteger(frame) || frame < 0) return false;
        if (typeof count !== "number") count = 1;
        if (!Number.isInteger(count) || count < 1) return false;
        HistoryService.start(EVENT.timelineHistory);
        track.keys.forEach(key=>{
            if (key.frame >= frame) key.frame += count;
        });
        extendEditedClipForKey(Math.max(frame + count - 1, track.keys[track.keys.length - 1]?.frame || 0));
        activeFrameIndex = frame;
        resolveActiveLayer();
        HistoryService.end();
        timelineStructureChanged();
        return true;
    };

    // Delete timeline cells and close the gap, retaining a surviving held cel when its key
    // was inside the deleted range. Property keys to the right keep their original lineage.
    me.removeFrames = async function(frame,count = 1){
        if (refuseInParam("Remove Frame")) return false;
        const track = activeTrack();
        if (!track || !Number.isInteger(frame) || frame < 0 || !Number.isInteger(count) || count < 1) return false;
        const end = frame + count;
        const length = editLength();
        if (frame >= length) return false;
        count = Math.min(count,length-frame);
        const resumeFrame = frame + count;
        const state = resolveTrackState(track,resumeFrame);
        const governing = governingContentKey(track,resumeFrame);
        const resume = resumeFrame < length && governing && governing.frame >= frame && governing.frame < end
            ? makeContentKey(frame,await copyResolvedCel(track,resumeFrame),state.tweening,state.key.easing) : undefined;
        HistoryService.start(EVENT.timelineHistory);
        track.keys = track.keys.filter(key=>key.frame < frame || key.frame >= resumeFrame);
        track.keys.forEach(key=>{ if (key.frame >= resumeFrame) key.frame -= count; });
        if (resume) insertKey(track,resume);
        if (!contentKeys(track).length){
            insertKey(track,makeContentKey(0,makeCel([Layer(currentFile.width,currentFile.height,"Layer 1")])));
        }
        activeFrameIndex = Math.min(frame,editLength()-1);
        resolveActiveLayer();
        HistoryService.end();
        timelineStructureChanged();
        return true;
    };

    // Property key on the active track. Its initial props are the resolved state at `frame`,
    // so inserting one mid-tween preserves what you see and continues that tween.
    me.addPropertyKeyframe = function(frame){
        let track = activeTrack();
        if (!track) return false;
        if (typeof frame !== "number") frame = activeFrameIndex;
        if (!canInsertPropertyKey(track, frame)) return false;
        let state = resolveTrackState(track, frame);
        if (!state) return false;
        HistoryService.start(EVENT.timelineHistory);
        insertKey(track, makePropertyKey(frame, withoutTimeCues(clonePlainData(state.props)), !!state.tweening,state.key.easing));
        extendEditedClipForKey(frame);
        activeFrameIndex = frame;
        resolveActiveLayer();
        HistoryService.end();
        timelineStructureChanged();
        return true;
    };

    // Removes the key at `frame` on the active track. Removing a content key cascades to the
    // property keys it governs; the last content key of the last track is refused.
    me.removeKeyframe = function(frame){
        let track = activeTrack();
        if (!track) return false;
        if (typeof frame !== "number") frame = activeFrameIndex;
        let key = keyAt(track, frame);
        if (!key) return false;
        if (key.type === "content" && contentKeys(track).length <= 1 && tracks().length <= 1) return false;
        HistoryService.start(EVENT.timelineHistory);
        removeKey(track, frame);
        if (!contentKeys(track).length){
            // the track lost its last content key: drop the track entirely (it can no longer
            // resolve to anything) unless it is the only one left
            let index = tracks().indexOf(track);
            if (tracks().length > 1){
                tracks().splice(index,1);
                if (activeTrackIndex >= tracks().length) activeTrackIndex = tracks().length - 1;
            }else{
                insertKey(track, makeContentKey(0, makeCel([Layer(currentFile.width, currentFile.height, "Layer 1")])));
            }
        }
        if (activeFrameIndex >= editLength()) activeFrameIndex = editLength() - 1;
        resolveActiveLayer();
        HistoryService.end();
        timelineStructureChanged();
        return true;
    };

    // How many keys removeKeyframe(frame) would take with it — the timeline panel uses this
    // to confirm before a cascading delete.
    me.getKeyframeRemovalCount = function(frame){
        let track = activeTrack();
        if (!track) return 0;
        if (typeof frame !== "number") frame = activeFrameIndex;
        let key = keyAt(track, frame);
        if (!key) return 0;
        return key.type === "content" ? 1 + propertyKeysGovernedBy(track, key).length : 1;
    };

    me.moveKeyframe = function(from,to,trackIndex){
        let track = tracks()[typeof trackIndex === "number" ? trackIndex : activeTrackIndex];
        if (!track) return false;
        HistoryService.start(EVENT.timelineHistory);
        let moved = moveKey(track, from, to);
        if (!moved){
            // the guard rejected it (occupied slot / governance change): drop the snapshot
            HistoryService.neverMind();
            return false;
        }
        HistoryService.end();
        if (activeFrameIndex >= editLength()) activeFrameIndex = editLength() - 1;
        resolveActiveLayer();
        timelineStructureChanged();
        return true;
    };

    // Moves every key on `frames` by `delta` on one track, atomically — the commit of a
    // multi-frame selection drag. Refused as a whole if any target is occupied or would
    // re-parent a property key (see timelineUtils.moveKeys).
    me.moveKeyframes = function(frames,delta,trackIndex){
        let track = tracks()[typeof trackIndex === "number" ? trackIndex : activeTrackIndex];
        if (!track) return false;
        HistoryService.start(EVENT.timelineHistory);
        if (!moveKeys(track, frames, delta)){
            HistoryService.neverMind();
            return false;
        }
        HistoryService.end();
        if (activeFrameIndex >= editLength()) activeFrameIndex = editLength() - 1;
        resolveActiveLayer();
        timelineStructureChanged();
        return true;
    };

    // Copies a dragged selection without replacing occupied destinations. Resolve properties
    // at the source, before inserting anything that could change the timeline's resolution.
    me.copyKeyframes = async function(frames,delta,trackIndex,propertiesOnly){
        let track = tracks()[typeof trackIndex === "number" ? trackIndex : activeTrackIndex];
        if (!track || !Number.isInteger(delta) || !delta) return false;
        let sources = track.keys.filter(key => frames.includes(key.frame));
        if (!sources.length) return false;
        if (!propertiesOnly && sources.some(key => key.type === "content") && refuseInParam("Content keys")) return false;
        let copies = sources.map(key => {
            let frame = key.frame + delta;
            if (propertiesOnly){
                let state = resolveTrackState(track, key.frame);
                return makePropertyKey(frame, withoutTimeCues(clonePlainData(state.props)), key.tween,key.easing);
            }
            return Object.assign({}, key, {frame, props: clonePlainData(key.props)});
        });
        let valid = () => copies.every(key => Number.isInteger(key.frame) && key.frame >= 0 &&
            !keyAt(track, key.frame) && (key.type === "content" ||
                track.keys.concat(copies).some(content => content.type === "content" && content.frame <= key.frame)));
        if (!valid()) return false;
        await Promise.all(copies.map(async (key,index) => {
            if (key.type !== "content") return;
            let source = sources[index].cel;
            let cel = makeCel();
            cel.activeLayerIndex = source.activeLayerIndex || 0;
            await Promise.all(source.layers.map(async node => {
                let copy = isGroup(node) ? Layer.makeGroup(currentFile.width, currentFile.height, node.name)
                    : Layer(currentFile.width, currentFile.height, node.name);
                cel.layers.push(copy);
                await copy.restore(node.clone(false));
            }));
            key.cel = cel;
        }));
        if (!valid() || !tracks().includes(track)) return false;
        HistoryService.start(EVENT.timelineHistory);
        copies.sort((a,b) => a.frame - b.frame).forEach(key => insertKey(track, key));
        resolveActiveLayer();
        HistoryService.end();
        timelineStructureChanged();
        return true;
    };

    me.setKeyTween = function(frame,state){
        if (refuseInParam("Tweening (parameter keys always interpolate)")) return false;
        let track = activeTrack();
        if (!track) return false;
        if (typeof frame !== "number") frame = activeFrameIndex;
        let key = keyAt(track, frame);
        if (!key || !canTween(track, key)) return false;
        HistoryService.start(EVENT.timelineHistory);
        key.tween = typeof state === "boolean" ? state : !key.tween;
        HistoryService.end();
        timelineStructureChanged();
        return true;
    };

    me.canInsertPropertyKeyframe = function(frame){
        let track = activeTrack();
        if (!track) return false;
        return canInsertPropertyKey(track, typeof frame === "number" ? frame : activeFrameIndex);
    };

    me.canTweenKeyframe = function(frame){
        let track = activeTrack();
        if (!track) return false;
        let key = keyAt(track, typeof frame === "number" ? frame : activeFrameIndex);
        return canTween(track, key);
    };

    me.getTweenSettings = function(frame){
        const track = activeTrack();
        if (!track) return;
        if (typeof frame !== "number") frame = activeFrameIndex;
        const key = previousKey(track,frame);
        if (!key || !key.tween || !canTween(track,key)) return;
        return {frame:key.frame, endFrame:nextKey(track,key.frame).frame, easing:normalizeEasing(key.easing)};
    };

    me.setTweenEasing = function(frame,easing){
        const settings = me.getTweenSettings(frame);
        if (!settings) return false;
        const key = keyAt(activeTrack(),settings.frame);
        easing = normalizeEasing(easing);
        if (normalizeEasing(key.easing) === easing) return false;
        HistoryService.start(EVENT.timelineHistory);
        if (easing === "linear") delete key.easing;
        else key.easing = easing;
        HistoryService.end();
        timelineStructureChanged();
        return true;
    };

    // ── animatable layer properties ───────────────────────────────────────────────

    // Writes x/y/opacity for a layer to the right place (design 3.4 / decision 2):
    //   playhead on a property key → that key's props entry
    //   playhead on a content key  → the layer's own base values
    //   playhead on a derived frame → the nearest PRECEDING key (which is one of the above)
    // "75" → 75, 75 → 75, "" / undefined / "abc" / NaN → undefined ("leave this one alone").
    function toFiniteNumber(value){
        if (typeof value === "number") return isFinite(value) ? value : undefined;
        if (typeof value === "string" && value.trim() !== ""){
            let parsed = parseFloat(value);
            return isFinite(parsed) ? parsed : undefined;
        }
        return undefined;
    }

    me.setLayerKeyProps = function(ref,values){
        if (!values) return false;
        let track = activeTrack();
        let cel = currentFrame();
        if (!track || !cel) return false;
        let path = typeof ref === "undefined" ? activeLayerPath : toPath(ref);
        if (!path) return false;
        let node = resolveLayerPath(cel.layers, path) || cel.layers[path[0]];
        if (!node) return false;

        // previousKey covers all three cases at once: on a key it IS that key, on a derived
        // frame it is the key the state is held from.
        let key = previousKey(track, activeFrameIndex);
        if (!key) return false;
        if (refusePinned(key)) return false;

        // Coerce first: UI controls hand over strings ("75" from a range input), and an
        // unparsable or absent value must leave that property alone rather than write NaN.
        let nextX = toFiniteNumber(values.x);
        let nextY = toFiniteNumber(values.y);
        let nextOpacity = toFiniteNumber(values.opacity);
        if (typeof nextOpacity === "number") nextOpacity = Math.max(0, Math.min(100, nextOpacity));

        // A group additionally carries a runtime transform (spec 007), and so does a clip
        // instance (spec 024 R9). scaleX/scaleY/rotation are NOT rounded — they are continuous
        // and animate; only x/y snap to whole pixels.
        let group = isGroup(node) || isClip(node);
        let nextScaleX = group ? toFiniteNumber(values.scaleX) : undefined;
        let nextScaleY = group ? toFiniteNumber(values.scaleY) : undefined;
        let nextRotation = group ? toFiniteNumber(values.rotation) : undefined;

        function transformOf(source){
            return {
                scaleX: typeof source.scaleX === "number" ? source.scaleX : 1,
                scaleY: typeof source.scaleY === "number" ? source.scaleY : 1,
                rotation: typeof source.rotation === "number" ? source.rotation : 0
            };
        }

        let from;
        let to;
        if (key.type === "property"){
            key.props = key.props || {};
            let current = key.props[node.id] || keyState(track, key)[node.id] ||
                {x: node.x || 0, y: node.y || 0, opacity: node.opacity};
            from = {x: current.x, y: current.y, opacity: current.opacity};
            to = {
                x: typeof nextX === "number" ? Math.round(nextX) : current.x,
                y: typeof nextY === "number" ? Math.round(nextY) : current.y,
                opacity: typeof nextOpacity === "number" ? nextOpacity : current.opacity
            };
            if (group){
                let cur = transformOf(current);
                from.scaleX = cur.scaleX; from.scaleY = cur.scaleY; from.rotation = cur.rotation;
                to.scaleX = typeof nextScaleX === "number" ? nextScaleX : cur.scaleX;
                to.scaleY = typeof nextScaleY === "number" ? nextScaleY : cur.scaleY;
                to.rotation = typeof nextRotation === "number" ? nextRotation : cur.rotation;
            }
            // Merge, don't replace: the entry may also carry a bone pose, vector nodes/curves or a
            // clip cue / scrub frame for this layer, none of which an x/y/opacity edit may drop.
            key.props[node.id] = Object.assign({}, key.props[node.id], to);
        }else{
            from = {x: node.x || 0, y: node.y || 0, opacity: node.opacity};
            if (typeof nextX === "number") node.x = Math.round(nextX);
            if (typeof nextY === "number") node.y = Math.round(nextY);
            if (typeof nextOpacity === "number") node.opacity = nextOpacity;
            to = {x: node.x, y: node.y, opacity: node.opacity};
            if (group){
                let cur = transformOf(node);
                from.scaleX = cur.scaleX; from.scaleY = cur.scaleY; from.rotation = cur.rotation;
                if (typeof nextScaleX === "number") node.scaleX = nextScaleX;
                if (typeof nextScaleY === "number") node.scaleY = nextScaleY;
                if (typeof nextRotation === "number") node.rotation = nextRotation;
                to.scaleX = typeof node.scaleX === "number" ? node.scaleX : 1;
                to.scaleY = typeof node.scaleY === "number" ? node.scaleY : 1;
                to.rotation = typeof node.rotation === "number" ? node.rotation : 0;
            }
        }

        // A surrounding start()/end() pair (a drag gesture) owns the history step; only a
        // stand-alone edit records itself.
        if (!HistoryService.isRecording()){
            HistoryService.add(EVENT.keyPropsHistory,
                {clipId: editContextKey(), trackIndex: tracks().indexOf(track), keyFrame: key.frame, layerId: node.id, values: from},
                {clipId: editContextKey(), trackIndex: tracks().indexOf(track), keyFrame: key.frame, layerId: node.id, values: to});
        }

        clearRenderCache();
        cachedImage = undefined;
        EventBus.trigger(EVENT.imageContentChanged);
        EventBus.trigger(EVENT.layersChanged);
        return true;
    };

    // ── dissolve (palette-locked transparency) ────────────────────────────────────

    me.getDissolvePatterns = function(){
        return DISSOLVE_PATTERNS;
    };

    me.getLayerDissolve = function(ref){
        let layer = typeof ref === "undefined" ? activeLayer : me.getLayer(ref);
        return (layer && layer.dissolve) || DEFAULT_DISSOLVE_PATTERN;
    };

    // Effects belong to this layer/instance, and leave the source pixels untouched.
    me.setLayerEffects = function(effects){
        if (!activeLayer || isBones(activeLayer) || nestedFocus) return false;
        HistoryService.start(EVENT.layerHistory, activeLayerPath.slice());
        activeLayer.effects = normalizeEffects(effects);
        HistoryService.end();
        if (editStack.length) touchClip(editClip());
        clearRenderCache();
        cachedImage = undefined;
        EventBus.trigger(EVENT.imageContentChanged);
        EventBus.trigger(EVENT.layersChanged);
        return true;
    };

    me.hasActiveEffects = function(){
        function hasEffects(nodes){
            return (nodes || []).some(node=>activeStroke(node) || (node.layers && hasEffects(node.layers)));
        }
        return allTimelines().some(timeline=>(timeline.tracks || []).some(track=>
            (track.keys || []).some(key=>key.cel && hasEffects(key.cel.layers))));
    };

    me.setLayerDissolve = function(pattern,ref){
        if (!isDissolvePattern(pattern)) return false;
        let layer = typeof ref === "undefined" ? activeLayer : me.getLayer(ref);
        if (!layer) return false;
        layer.dissolve = pattern;
        clearRenderCache();
        cachedImage = undefined;
        EventBus.trigger(EVENT.imageContentChanged);
        EventBus.trigger(EVENT.layersChanged);
        return true;
    };

    // Walks a cel's tree, reporting each leaf with the opacity chain above it folded in.
    function forEachLeafWithOpacity(nodes,callback,inheritedOpacity,originX,originY){
        inheritedOpacity = typeof inheritedOpacity === "number" ? inheritedOpacity : 100;
        originX = originX || 0;
        originY = originY || 0;
        nodes.forEach(node=>{
            let opacity = typeof node.opacity === "number" ? node.opacity : 100;
            let x = originX + (node.x || 0);
            let y = originY + (node.y || 0);
            if (isGroup(node)){
                forEachLeafWithOpacity(node.layers || [], callback, inheritedOpacity * opacity / 100, x, y);
            }else{
                callback(node, inheritedOpacity * opacity / 100, x, y);
            }
        });
    }

    function forEachNode(nodes,callback){
        nodes.forEach(node=>{
            callback(node);
            if (isGroup(node)) forEachNode(node.layers || [], callback);
        });
    }

    // Bakes one cel: punch each leaf's dissolve stencil into its own pixels, then reset every
    // opacity to 100 so the result renders identically with the palette lock switched off.
    // Nested groups fold correctly because the stencil is a binary document-space mask and the
    // compositing operator is source-over: masking each leaf equals masking the group result.
    // An "if lighter" layer is left alone: its stencil is a comparison against the layers
    // BELOW it, which a per-layer bake has no access to (they are on other tracks as often as
    // not). Baking it would have to flatten the whole composite, so instead it keeps its
    // opacity and its pattern, and getDissolvePlan does not count it as bakeable.
    function bakeCelDissolve(cel){
        forEachLeafWithOpacity(cel.layers,(leaf,opacity,originX,originY)=>{
            if (isDissolveComparison(leaf.dissolve)) return;
            // A fixed-density pattern stencils at every opacity, so "fully opaque" is not a
            // reason to skip it — only an opacity-driven pattern has nothing to do at 100.
            if (opacity >= 100 && dissolveFollowsOpacity(leaf.dissolve)) return;
            let canvas = leaf.getCanvasType ? leaf.getCanvasType() : undefined;
            if (!canvas) return;
            applyDissolve(canvas.getContext("2d"), opacity, leaf.dissolve, originX, originY);
            if (leaf.reset) leaf.reset();
        });
        forEachNode(cel.layers,node=>{
            if (isDissolveComparison(node.dissolve)) return;
            node.opacity = 100;
            // The stencil now lives in the pixels. Setting opacity to 100 is enough to retire
            // an opacity-driven pattern, but a fixed-density one would punch a SECOND stencil
            // through the already-baked pixels on the next render, so retire the pattern too.
            if (!dissolveFollowsOpacity(node.dissolve)) node.dissolve = DEFAULT_DISSOLVE_PATTERN;
        });
    }

    // True when any property key on the track animates a layer's opacity (i.e. holds a value
    // that differs from the cel that governs it). Baking then has to become per-frame content
    // keys, because one static cel cannot carry a changing stencil.
    me.hasAnimatedOpacity = function(trackIndex){
        let track = tracks()[typeof trackIndex === "number" ? trackIndex : activeTrackIndex];
        if (!track) return false;
        return (track.keys || []).some(key=>{
            if (key.type !== "property" || !key.props) return false;
            let base = celBaseState((governingContentKey(track, key.frame) || {}).cel);
            return Object.keys(key.props).some(id=>{
                let entry = key.props[id];
                if (!entry || typeof entry.opacity !== "number") return false;
                let baseOpacity = base[id] ? base[id].opacity : 100;
                return entry.opacity !== baseOpacity;
            });
        });
    };

    // What applyDissolve() would do, so the UI can enable the button and warn about the cost.
    me.getDissolvePlan = function(){
        let track = activeTrack();
        if (!track) return {canApply: false};
        let animated = me.hasAnimatedOpacity(activeTrackIndex);
        let partial = false;
        let comparison = false;
        (track.keys || []).forEach(key=>{
            if (key.type === "content" && key.cel){
                forEachLeafWithOpacity(key.cel.layers,(leaf,opacity)=>{
                    if (isDissolveComparison(leaf.dissolve)){
                        comparison = true;
                        return;
                    }
                    // a fixed-density layer has holes to bake whatever its opacity is
                    if (opacity < 100 || !dissolveFollowsOpacity(leaf.dissolve)) partial = true;
                });
            }else if (key.props){
                Object.keys(key.props).forEach(id=>{
                    if (key.props[id] && key.props[id].opacity < 100) partial = true;
                });
            }
        });
        return {
            canApply: partial,
            animated: animated,
            frameCount: animated ? editLength() : 0,
            // "if lighter" layers are reported so the UI can say they are staying as they are
            comparison: comparison,
            trackName: track.name
        };
    };

    // Bakes the active track's dissolve into pixels so it survives the palette lock being
    // turned off. Returns a Promise for the animated case (deep cel copies are async).
    me.applyDissolve = function(){
        let track = activeTrack();
        if (!track) return false;
        let plan = me.getDissolvePlan();
        if (!plan.canApply) return false;

        if (!plan.animated){
            HistoryService.start(EVENT.imageHistory);
            (track.keys || []).forEach(key=>{
                if (key.type === "content" && key.cel) bakeCelDissolve(key.cel);
                // every opacity is 100 now, so stale prop entries must not re-apply it
                if (key.type === "property" && key.props){
                    Object.keys(key.props).forEach(id=>{
                        if (typeof key.props[id].opacity === "number") key.props[id].opacity = 100;
                    });
                }
            });
            HistoryService.end();
            clearRenderCache();
            cachedImage = undefined;
            EventBus.trigger(EVENT.layerContentChanged);
            EventBus.trigger(EVENT.layersChanged);
            return true;
        }

        // Animated: the stencil changes from frame to frame, so each frame becomes its own
        // content keyframe. copyResolvedCel already bakes the resolved x/y/opacity into the
        // copy's base values, so the motion survives; only the tween stops being editable.
        let count = editLength();
        let frames = [];
        for (let i = 0; i < count; i++) frames.push(i);
        return frames.reduce((chain,frame)=>chain.then(cels=>
            copyResolvedCel(track, frame).then(cel=>{
                bakeCelDissolve(cel);
                cels.push(makeContentKey(frame, cel));
                return cels;
            })
        ), Promise.resolve([])).then(keys=>{
            HistoryService.start(EVENT.imageHistory);
            track.keys = keys;
            resolveActiveLayer();
            HistoryService.end();
            timelineStructureChanged();
            return true;
        });
    };

    // Where setLayerKeyProps would write for `ref` right now, plus the current values there.
    // Used by HistoryService to bracket a whole drag gesture in one undo step.
    me.getKeyPropsTarget = function(ref){
        let track = activeTrack();
        let cel = currentFrame();
        if (!track || !cel) return undefined;
        let path = typeof ref === "undefined" || ref === null ? activeLayerPath : toPath(ref);
        if (!path) path = activeLayerPath;
        let node = resolveLayerPath(cel.layers, path) || cel.layers[path[0]];
        let key = previousKey(track, activeFrameIndex);
        if (!node || !key) return undefined;
        let values;
        if (key.type === "property"){
            values = (key.props && key.props[node.id]) || keyState(track, key)[node.id] ||
                {x: node.x || 0, y: node.y || 0, opacity: node.opacity};
        }else{
            values = {x: node.x || 0, y: node.y || 0, opacity: node.opacity};
        }
        let out = {x: values.x, y: values.y, opacity: values.opacity};
        // A group also brackets its runtime transform, so an undo/redo of a group free-transform
        // (or a Properties-panel edit) restores scaleX/scaleY/rotation too (spec 007). Same for
        // a clip instance (spec 024).
        if (isGroup(node) || isClip(node)){
            out.scaleX = typeof values.scaleX === "number" ? values.scaleX : (typeof node.scaleX === "number" ? node.scaleX : 1);
            out.scaleY = typeof values.scaleY === "number" ? values.scaleY : (typeof node.scaleY === "number" ? node.scaleY : 1);
            out.rotation = typeof values.rotation === "number" ? values.rotation : (typeof node.rotation === "number" ? node.rotation : 0);
        }
        return {
            clipId: editClipId(),
            trackIndex: tracks().indexOf(track),
            keyFrame: key.frame,
            layerId: node.id,
            values: out
        };
    };

    // Resolved x/y/opacity of a layer at the playhead, plus whether those values come from a
    // property key or a tween (the layer panel marks overridden values).
    me.getLayerKeyProps = function(ref){
        let track = activeTrack();
        let cel = currentFrame();
        if (!track || !cel) return undefined;
        let path = typeof ref === "undefined" ? activeLayerPath : toPath(ref);
        if (!path) return undefined;
        let node = resolveLayerPath(cel.layers, path) || cel.layers[path[0]];
        if (!node) return undefined;
        let base = {x: node.x || 0, y: node.y || 0,
            opacity: typeof node.opacity === "number" ? node.opacity : 100};
        let state = resolveTrackState(track, activeFrameIndex);
        let resolved = (state && state.props && state.props[node.id]) || base;
        let result = {
            x: resolved.x,
            y: resolved.y,
            opacity: resolved.opacity,
            overridden: resolved.x !== base.x || resolved.y !== base.y || resolved.opacity !== base.opacity,
            tweening: !!(state && state.tweening)
        };
        // A group also reports its runtime transform (spec 007) and the CURRENT displayed pixel
        // size (natural content bounds × scale) so the Properties panel can show Width/Height in
        // pixels while the model stores scale factors.
        if (isGroup(node)){
            let effective = effectiveProps(node, state && state.props);
            result.isGroup = true;
            result.scaleX = effective.scaleX;
            result.scaleY = effective.scaleY;
            result.rotation = effective.rotation;
            let bounds = getOpaqueBounds(node.render(state && state.props));
            result.baseWidth = bounds ? bounds.w : 0;
            result.baseHeight = bounds ? bounds.h : 0;
            result.width = Math.round(result.baseWidth * effective.scaleX);
            result.height = Math.round(result.baseHeight * effective.scaleY);
            let bx = typeof node.scaleX === "number" ? node.scaleX : 1;
            let by = typeof node.scaleY === "number" ? node.scaleY : 1;
            let br = typeof node.rotation === "number" ? node.rotation : 0;
            if (effective.scaleX !== bx || effective.scaleY !== by || effective.rotation !== br){
                result.overridden = true;
            }
            // Timeline-wide (not animatable) smooth-resampling toggle — see setGroupSmooth.
            result.smooth = !!node.smooth;
        }
        // A clip instance reports its transform like a group (spec 024), with pixel sizes from the
        // opaque bounds of its current composite, plus which clip it shows.
        if (isClip(node)){
            let effective = effectiveProps(node, state && state.props);
            let clip = clipById(node.clipId);
            result.isClip = true;
            result.clipId = node.clipId;
            result.clipName = clip ? clip.name : undefined;
            result.missingClip = !clip;
            result.offset = node.offset || 0;
            result.scaleX = effective.scaleX;
            result.scaleY = effective.scaleY;
            result.rotation = effective.rotation;
            let bounds = getOpaqueBounds(node.render(state && state.props));
            result.baseWidth = bounds ? bounds.w : 0;
            result.baseHeight = bounds ? bounds.h : 0;
            result.width = Math.round(result.baseWidth * effective.scaleX);
            result.height = Math.round(result.baseHeight * effective.scaleY);
            let bx = typeof node.scaleX === "number" ? node.scaleX : 1;
            let by = typeof node.scaleY === "number" ? node.scaleY : 1;
            let br = typeof node.rotation === "number" ? node.rotation : 0;
            if (effective.scaleX !== bx || effective.scaleY !== by || effective.rotation !== br){
                result.overridden = true;
            }
            result.smooth = typeof node.smooth === "boolean" ? node.smooth : !!currentFile.smooth;
        }
        // Bone attachment (spec 024 R35): the targets this node could attach to, and its current one.
        if (!isBones(node)){
            let targets = me.getAttachTargets(path);
            result.canAttach = targets.length > 0 || !!node.attach;
            if (node.attach){
                let target = targets.find(t=>t.boneLayerId === node.attach.boneLayerId && t.boneId === node.attach.boneId);
                result.attach = {boneLayerId: node.attach.boneLayerId, boneId: node.attach.boneId,
                    name: target ? target.name : "(missing)", missing: !target};
            }
        }
        // A vector layer reports its display mode so the Properties panel can offer the selector.
        if (isVector(node)){
            result.isVector = true;
            result.vectorDisplay = getDisplayMode(node.vector);
        }
        return result;
    };

    // Whether the active (or referenced) group resamples smoothly during its runtime transform.
    me.getGroupSmooth = function(ref){
        let cel = currentFrame();
        if (!cel) return false;
        let path = typeof ref === "undefined" ? activeLayerPath : toPath(ref);
        if (!path) return false;
        let node = resolveLayerPath(cel.layers, path) || cel.layers[path[0]];
        return !!(node && node.smooth);
    };

    // Sets a group or clip instance's "smooth" toggle. Unlike scaleX/scaleY/rotation this is NOT animatable — it
    // is a single timeline-wide setting, so it is written onto the matching group node in EVERY cel
    // of the timeline (a group's id is stable across cels) rather than onto a key/base at the
    // playhead. Modelled on setFps: no per-key history entry; the flag rides along in cel snapshots.
    me.setGroupSmooth = function(ref, value){
        if (refuseInParam("This setting")) return false;
        let cel = currentFrame();
        if (!cel) return false;
        let path = typeof ref === "undefined" ? activeLayerPath : toPath(ref);
        if (!path) return false;
        let node = resolveLayerPath(cel.layers, path) || cel.layers[path[0]];
        if (!isGroup(node) && !isClip(node)) return false;
        let id = node.id;
        let smooth = !!value;
        forEachCel(c=>{
            forEachNode(c.layers, n=>{ if ((isGroup(n) || isClip(n)) && n.id === id) n.smooth = smooth; });
        });
        // Preserve the legacy document default for groups. A clip's explicit setting is local
        // to its instance; older instances without a setting inherit the document default.
        if (isGroup(node)) currentFile.smooth = smooth;
        clearClipCache();
        clearRenderCache();
        cachedImage = undefined;
        EventBus.trigger(EVENT.imageContentChanged);
        EventBus.trigger(EVENT.layersChanged);
        return true;
    };

    // Sets a vector layer's display mode ("sharp" | "smooth" | "vector"). Like setGroupSmooth this
    // is a single per-layer (not animatable) setting, so it is written onto the matching vector node
    // in EVERY cel and the raster cache is invalidated so render() re-rasterizes in the new mode.
    me.setVectorDisplayMode = function(ref, value){
        if (refuseInParam("This setting")) return false;
        let cel = currentFrame();
        if (!cel) return false;
        let path = typeof ref === "undefined" ? activeLayerPath : toPath(ref);
        if (!path) return false;
        let node = resolveLayerPath(cel.layers, path) || cel.layers[path[0]];
        if (!isVector(node)) return false;
        let id = node.id;
        let mode = VECTOR_DISPLAY_MODES.indexOf(value) >= 0 ? value : "smooth";
        forEachCel(c=>{
            forEachNode(c.layers, n=>{
                if (isVector(n) && n.id === id && n.vector){
                    n.vector.displayMode = mode;
                    delete n.vector.snapToPixel; // drop the migrated legacy flag
                    n.vectorDirty = true;
                }
            });
        });
        clearRenderCache();
        cachedImage = undefined;
        EventBus.trigger(EVENT.imageContentChanged);
        EventBus.trigger(EVENT.layersChanged);
        EventBus.trigger(EVENT.vectorChanged);
        return true;
    };

    // Flat list of the visible vector layers set to "vector" display mode at `frameIndex` (the
    // playhead when omitted), in composite (bottom-to-top) order. The on-screen editor uses this to
    // RE-RASTERIZE those layers crisply at the current zoom (canvas.js drawVectorDisplay) so a true-
    // vector layer stays sharp when you zoom in — the doc-resolution composite/export is untouched.
    //
    // Each entry carries the geometry plus the accumulated document-space offset, the accumulated
    // opacity (0..1, folding in every ancestor group) and the node's blend mode. Bone layers and
    // transformed groups are skipped: they can't be reduced to a plain offset, so any vector layer
    // inside a transformed group falls back to the (still correct) doc-resolution composite.
    me.getVectorDisplayLayers = function(frameIndex){
        let f = typeof frameIndex === "number" ? frameIndex : activeFrameIndex;
        let list = tracks();
        let out = [];
        if (!list || !list.length) return out;
        list.forEach(track=>{
            if (track.mask || !track.visible) return;
            let state = resolveTrackState(track, f);
            if (!state) return;
            walk(state.cel.layers, state.props, 0, 0, 1);
        });
        return out;

        function walk(nodes, props, ox, oy, opacityFactor){
            nodes.forEach(node=>{
                if (!node.visible || isBones(node)) return;
                let eff = effectiveProps(node, props);
                let nx = ox + eff.x;
                let ny = oy + eff.y;
                let op = opacityFactor * ((typeof eff.opacity === "number" ? eff.opacity : 100) / 100);
                if (isGroup(node)){
                    if (hasGroupTransform(eff) || activeStroke(node)) return; // transformed/effected groups render as pixels
                    walk(node.layers || [], props, nx, ny, op);
                    return;
                }
                if (isVector(node) && node.vector && getDisplayMode(node.vector) === "vector" && !activeStroke(node)){
                    // Apply this frame's node + curve overlay (spec 012) so the on-screen true-SVG
                    // shape shows the tween live; poseVector returns the base document when nothing moved.
                    let p = props && node.id ? props[node.id] : null;
                    let posed = poseVector(node.vector, p && p.nodes, p && p.curves);
                    out.push({vector: posed, x: nx, y: ny, opacity: op, blend: node.blendMode || "normal"});
                }
            });
        }
    };

    // Render-op tree for the SVG exporter (spec 009), built from the visible track/layer tree at
    // `frameIndex` (the playhead when omitted), bottom-to-top. Pure data (no DOM): each op is a
    // "group" (nested children), a "vector" (its layer.vector document, kept as true geometry) or
    // an "image" (base64 PNG of a rendered layer). Mirrors getVectorDisplayLayers' walk, but keeps
    // EVERY visible layer — pixel layers become images, vector layers of any display mode become
    // vectors, and a transformed group (which can't fold into a plain translate) is rasterized in
    // place via compositeNodes. `x`/`y` are each node's own offset relative to its parent, so the
    // serializer's nested <g transform> composes the offsets for free — see fileformats/svg.js.
    me.getSvgExportModel = function(frameIndex){
        // An export: always the ROOT timeline, at the root playhead by default (spec 024).
        let f = typeof frameIndex === "number" ? frameIndex : me.getRootFrameIndex();
        let list = tracksOf(rootTimeline());
        let root = [];
        if (!list || !list.length) return root;
        list.forEach(track=>{
            if (track.mask || !track.visible) return;
            let state = resolveTrackState(track, f, library());
            if (!state) return;
            walk(state.cel.layers, state.props, root, trackOptionsFor(undefined, state));
        });
        return root;

        // `trackOpts`: the cel's instance times / blends / override times (trackOptionsFor).
        function walk(nodes, props, out, trackOpts){
            nodes.forEach(node=>{
                if (!node.visible || isBones(node)) return;
                let eff = effectiveProps(node, props);
                let x = eff.x || 0;
                let y = eff.y || 0;
                let opacity = (typeof eff.opacity === "number" ? eff.opacity : 100) / 100;
                let blend = node.blendMode || "normal";
                if (activeStroke(node)){
                    out.push(rasterNode(node, props, trackOpts));
                    return;
                }
                if (isGroup(node)){
                    if (hasGroupTransform(eff)){
                        // A scale/rotation can't be reduced to a translate — bake the whole group in
                        // place. compositeNodes applies its transform/offset/opacity/blend, so the op
                        // is a full-document image with neutral placement.
                        let op = rasterNode(node, props, trackOpts);
                        if (op) out.push(op);
                    }else{
                        let children = [];
                        walk(node.layers || [], props, children, trackOpts);
                        if (children.length) out.push({kind:"group", x:x, y:y, opacity:opacity, blend:blend, children:children});
                    }
                    return;
                }
                // A clip instance is rasterized in place at its composite position (R16).
                if (isClip(node)){
                    out.push(rasterNode(node, props, trackOpts));
                    return;
                }
                if (isVector(node) && node.vector){
                    // Bake this frame's node + curve overlay (spec 012) into the exported geometry.
                    let p = props && node.id ? props[node.id] : null;
                    let posed = poseVector(node.vector, p && p.nodes, p && p.curves);
                    out.push({kind:"vector", x:x, y:y, opacity:opacity, blend:blend, vector:posed});
                    return;
                }
                // plain pixel layer: render() returns its document-sized, unshifted canvas; the
                // animatable offset is applied here via x/y on the <image>.
                let canvas = node.render(props);
                if (!canvas) return;
                out.push({kind:"image", x:x, y:y, width:canvas.width, height:canvas.height, opacity:opacity, blend:blend, dataUrl:canvas.toDataURL("image/png")});
            });
        }

        function rasterNode(node, props, trackOpts){
            let canvas = document.createElement("canvas");
            canvas.width = currentFile.width;
            canvas.height = currentFile.height;
            compositeNodes([node], canvas.getContext("2d"), props, trackOpts);
            return {kind:"image", x:0, y:0, width:canvas.width, height:canvas.height, opacity:1, blend:"normal", dataUrl:canvas.toDataURL("image/png")};
        }
    };

    // ── single-layer SVG round-trip (split-panel "view as code") ───────────────────────
    // The "view as code" view (editpanel.js + components/codeView.js) shows the ACTIVE vector layer
    // as standalone SVG text and writes edits back. Both directions reuse the SVG import/export
    // module (fileformats/svg.js) so the text is exactly the vector<->path mapping used everywhere.

    // Standalone .svg for the active vector layer's GEOMETRY alone (layer offset/opacity/blend are
    // layer properties, not part of the shapes, so they are left at neutral values). Returns null
    // when the active layer is not a vector layer. svg.js (~30KB) is only needed for this "view as
    // code" round-trip and full SVG import/export, so it's loaded on first use rather than eagerly.
    me.getActiveVectorSvg = async function(){
        if (!isVector(activeLayer) || !activeLayer.vector) return null;
        let model = [{kind:"vector", x:0, y:0, opacity:1, blend:"normal", vector: activeLayer.vector}];
        let SVG = (await import("./fileformats/svg.js")).default;
        return SVG.write(model, currentFile.width, currentFile.height);
    };

    // The source element (region/edge/nodes) behind each <path> that getActiveVectorSvg emits, in the
    // same order the paths appear in the text. Lets the code view map a canvas selection to the path
    // line(s) that represent it. Returns [] when the active layer is not a vector layer.
    me.getActiveVectorShapeSources = function(){
        if (!isVector(activeLayer) || !activeLayer.vector) return [];
        return getVectorSvgShapeSources(activeLayer.vector);
    };

    // Replaces the active vector layer's geometry with the shapes parsed from `svgText` — the inverse
    // of getActiveVectorSvg (every vector run in the document is flattened into this one layer, the
    // layer's display mode is preserved). Wrapped in a single undo step. Returns false and changes
    // nothing when the active layer is not a vector layer or the text is not a valid SVG document.
    me.setActiveVectorFromSvg = async function(svgText){
        if (!isVector(activeLayer)) return false;
        let parsed;
        try {
            let SVG = (await import("./fileformats/svg.js")).default;
            parsed = SVG.parse(svgText);
        } catch (e){
            return false;
        }
        let merged = emptyVectorData();
        merged.displayMode = getDisplayMode(activeLayer.vector);
        (parsed.layers || []).forEach(spec=>{
            if (spec.kind === "vector" && spec.vector) appendVector(merged, spec.vector, 0, 0);
        });
        HistoryService.start(EVENT.imageHistory);
        activeLayer.vector = merged;
        activeLayer.vectorDirty = true;
        activeLayer.vectorRasterized = false;
        if (activeLayer.markVectorDirty) activeLayer.markVectorDirty();
        HistoryService.end();
        EventBus.trigger(EVENT.vectorChanged);
        EventBus.trigger(EVENT.layerContentChanged);
        EventBus.trigger(EVENT.imageContentChanged);
        return true;
    };

    // The oriented box used to free-transform a group (spec 007): its content bounds scaled by the
    // current transform, positioned in document space, with the current rotation. The resizer is
    // seeded from this and its scale/rotation map straight back (decision 1). Returns null for a
    // non-group or an empty group.
    // The same box for a group OR a clip instance (spec 024 §3.7). A clip rotates/scales about its
    // stored pivot rather than its content centre, so its box also carries `pivotDelta` (content
    // centre − pivot, clip-local) and the transform at gesture start; Free Transform uses them to
    // keep the pivot fixed while the box's centre moves (see editor updateGroupTransform).
    me.getNodeTransformBox = function(ref){
        let frame = currentFrame();
        if (!frame) return null;
        let path = typeof ref === "undefined" ? activeLayerPath : toPath(ref);
        let node = resolveLayerPath(frame.layers, path);
        if (isGroup(node)) return me.getGroupTransformBox(ref);
        if (!isClip(node)) return null;
        let clip = clipById(node.clipId);
        if (!clip) return null;
        let props = me.getResolvedProps();
        let effective = effectiveProps(node, props);
        let composite = node.render(props);
        let bounds = getOpaqueBounds(composite);
        if (!bounds) return null;
        // content centre in clip-local space
        let cx = (node.canvasX || 0) + bounds.x + bounds.w / 2;
        let cy = (node.canvasY || 0) + bounds.y + bounds.h / 2;
        // …and in document space: the parent-scope offset of the node plus the instance matrix
        let own = me.getLayerOffset(ref);
        let parentX = own.x - effective.x, parentY = own.y - effective.y;
        let doc = matApply(instanceMatrix(effective, clip.pivot), {x: cx, y: cy});
        let centerX = parentX + doc.x, centerY = parentY + doc.y;
        let dispW = bounds.w * effective.scaleX;
        let dispH = bounds.h * effective.scaleY;
        return {
            x: centerX - dispW / 2,
            y: centerY - dispH / 2,
            w: dispW,
            h: dispH,
            rotation: effective.rotation || 0,
            centerX: centerX,
            centerY: centerY,
            baseW: bounds.w,
            baseH: bounds.h,
            pivotDelta: {x: cx - clip.pivot.x, y: cy - clip.pivot.y},
            startTransform: {scaleX: effective.scaleX, scaleY: effective.scaleY, rotation: effective.rotation || 0}
        };
    };

    me.getGroupTransformBox = function(ref){
        let frame = currentFrame();
        if (!frame) return null;
        let path = typeof ref === "undefined" ? activeLayerPath : toPath(ref);
        let node = resolveLayerPath(frame.layers, path);
        if (!isGroup(node)) return null;
        let props = me.getResolvedProps();
        let effective = effectiveProps(node, props);
        let bounds = getOpaqueBounds(node.render(props));
        if (!bounds) return null;
        // Ancestor+own translation of the group (rotation about the content centre does not move
        // the centre, so a translation is enough to place it — nested transformed ancestors are a
        // documented v1 approximation).
        let offset = me.getLayerOffset(ref);
        let centerX = offset.x + bounds.x + bounds.w / 2;
        let centerY = offset.y + bounds.y + bounds.h / 2;
        let dispW = bounds.w * effective.scaleX;
        let dispH = bounds.h * effective.scaleY;
        return {
            x: centerX - dispW / 2,
            y: centerY - dispH / 2,
            w: dispW,
            h: dispH,
            rotation: effective.rotation || 0,
            centerX: centerX,
            centerY: centerY,
            baseW: bounds.w,
            baseH: bounds.h
        };
    };

    // ── bone pose animation (spec 006) ─────────────────────────────────────────────
    // A bone layer's per-bone poses animate through the SAME timeline property keyframes as a
    // layer's x/y/opacity: the overlay lives at props[boneLayerId].bones[boneId] = {angle,x,y,scale}
    // and REPLACES the armature's own base pose at that frame (per bone, per component). The
    // compositor resolves and feeds this to the deformer (see layerUtils.buildDeformMap), so a
    // tweened armature bakes exactly like a live pose. These methods are the write/read path.

    // The bone-layer node the caller means: a node object directly, a path/index ref, or (when
    // omitted) the active layer. undefined if the result is not a bone layer.
    function resolveBoneLayerNode(ref){
        let node;
        if (typeof ref === "undefined" || ref === null) node = activeLayer;
        else if (isBones(ref)) node = ref;                 // a Layer node passed straight in
        else node = me.getLayer(ref);
        return isBones(node) ? node : undefined;
    }

    function coercePose(p){
        p = p || {};
        let angle = toFiniteNumber(p.angle);
        let x = toFiniteNumber(p.x);
        let y = toFiniteNumber(p.y);
        let scale = toFiniteNumber(p.scale);
        return {
            angle: typeof angle === "number" ? angle : 0,
            x: typeof x === "number" ? x : 0,
            y: typeof y === "number" ? y : 0,
            scale: typeof scale === "number" ? scale : 1
        };
    }

    // The resolved pose map for a bone-layer node at the playhead (held or tweened), keyed by
    // bone id — exactly what the deformer skins. Falls back to the armature's base poses before
    // the track's first key.
    function resolvedBonesFor(track, node){
        let state = track ? resolveTrackState(track, activeFrameIndex) : null;
        let entry = state && state.props && state.props[node.id];
        if (entry && entry.bones) return entry.bones;
        let map = {};
        (node.armature && node.armature.bones || []).forEach(b=>{
            let bp = b.pose || {};
            map[b.id] = {angle: bp.angle||0, x: bp.x||0, y: bp.y||0,
                scale: typeof bp.scale === "number" ? bp.scale : 1};
        });
        return map;
    }

    function resolveBonePose(track, node, boneId){
        let p = resolvedBonesFor(track, node)[boneId];
        if (p) return {angle: p.angle||0, x: p.x||0, y: p.y||0,
            scale: typeof p.scale === "number" ? p.scale : 1};
        return {angle: 0, x: 0, y: 0, scale: 1};
    }

    // Returns the LIVE-MUTABLE pose object a Transform drag should edit at the playhead:
    //   - on a property key → that key's props[id].bones[boneId] overlay entry, seeded on first
    //     touch from the currently resolved pose (so the drag starts where the bone visually is);
    //   - on a content key / derived frame → the bone's base pose object in the cel.
    // Mutating the returned object updates exactly the value the compositor resolves for this
    // frame, so the live preview is correct even when an overlay already masks the base pose.
    me.getBonePoseObject = function(ref, boneId){
        let node = resolveBoneLayerNode(ref);
        if (!node || !node.armature) return undefined;
        let bone = (node.armature.bones || []).find(b=>b.id === boneId);
        if (!bone) return undefined;
        let track = activeTrack();
        let key = track ? previousKey(track, activeFrameIndex) : undefined;
        // inside a parameter timeline a keyless frame must not pose the clip's own rig (spec 026)
        if (key && key.pinned){ refusePinned(key); return undefined; }
        if (key && key.type === "property"){
            key.props = key.props || {};
            let entry = key.props[node.id] || (key.props[node.id] = {});
            entry.bones = entry.bones || {};
            if (!entry.bones[boneId]) entry.bones[boneId] = resolveBonePose(track, node, boneId);
            return entry.bones[boneId];
        }
        bone.pose = bone.pose || {angle: 0, x: 0, y: 0, scale: 1};
        if (typeof bone.pose.scale !== "number") bone.pose.scale = 1;
        return bone.pose;
    };

    // The pose map (by bone id) that the bone tool should DISPLAY and hit-test against: the pose
    // of the key an edit would target (a property key's merged overlay, or the base pose on a
    // content-derived frame). Keeps the on-screen handles on the pixels the deformer draws.
    me.getEditBonePoses = function(ref){
        let node = resolveBoneLayerNode(ref);
        let track = activeTrack();
        if (!node || !track) return null;
        let key = previousKey(track, activeFrameIndex);
        if (!key) return null;
        let st = keyState(track, key)[node.id];
        return (st && st.bones) || null;
    };

    // Resolved pose of one bone at the playhead + whether it is overridden by this frame's key
    // and whether the frame is tweening. For a tool-options read-out.
    me.getBonePose = function(ref, boneId){
        let node = resolveBoneLayerNode(ref);
        if (!node) return undefined;
        let track = activeTrack();
        let pose = resolveBonePose(track, node, boneId);
        let key = track ? previousKey(track, activeFrameIndex) : undefined;
        let overridden = !!(key && key.type === "property" && key.props && key.props[node.id]
            && key.props[node.id].bones && key.props[node.id].bones[boneId]);
        let state = track ? resolveTrackState(track, activeFrameIndex) : null;
        pose.overridden = overridden;
        pose.tweening = !!(state && state.tweening);
        return pose;
    };

    // Writes one bone's pose at the playhead per the write-target rule above. `pose` is absolute
    // (the four components are coerced/defaulted). Records its own single undo step unless a
    // gesture bracket is already open (the bone tool owns that).
    me.setBonePose = function(ref, boneId, pose){
        let map = {};
        map[boneId] = pose;
        return me.setBonePoses(ref, map);
    };

    // Batch form of setBonePose: { [boneId]: {angle,x,y,scale} }. One undo step for the whole map.
    me.setBonePoses = function(ref, map){
        if (!map) return false;
        let node = resolveBoneLayerNode(ref);
        if (!node || !node.armature) return false;
        let track = activeTrack();
        let key = track ? previousKey(track, activeFrameIndex) : undefined;
        if (refusePinned(key)) return false;

        let ownBracket = !HistoryService.isRecording();
        if (ownBracket) HistoryService.start(EVENT.imageHistory);

        Object.keys(map).forEach(boneId=>{
            let bone = node.armature.bones.find(b=>b.id === boneId);
            if (!bone) return;
            let pose = coercePose(map[boneId]);
            if (key && key.type === "property"){
                key.props = key.props || {};
                let entry = key.props[node.id] || (key.props[node.id] = {});
                entry.bones = entry.bones || {};
                entry.bones[boneId] = pose;
            }else{
                bone.pose = pose;
            }
        });

        if (ownBracket) HistoryService.end();

        clearRenderCache();
        cachedImage = undefined;
        EventBus.trigger(EVENT.timelineChanged);
        EventBus.trigger(EVENT.imageContentChanged);
        return true;
    };

    // Snapshot / restore the active bone layer's pose OVERLAYS across the active track's property
    // keys, so the bone tool can roll back a cancelled gesture (the armature snapshot covers only
    // the base pose; the overlay lives in the timeline keys). Deep-copied to survive later edits.
    // Lineage-safe (spec 025 R4): with a stable id the snapshot spans every content range of the
    // bone layer on this track, and restoring all of them is exactly the pre-gesture state.
    me.cloneBoneOverlayState = function(ref){
        let node = resolveBoneLayerNode(ref);
        let track = activeTrack();
        if (!node || !track) return undefined;
        let snap = {layerId: node.id, clipId: editContextKey(), trackIndex: tracks().indexOf(track), keys: []};
        (track.keys || []).forEach(k=>{
            if (k.type === "property"){
                let entry = k.props && k.props[node.id];
                snap.keys.push({frame: k.frame, entry: entry ? clonePlainData(entry) : null});
            }
        });
        return snap;
    };

    me.restoreBoneOverlayState = function(snap){
        if (!snap) return false;
        if (snap.clipId) touchClip(clipById(snap.clipId));
        let track = trackListFor(snap.clipId)[snap.trackIndex];
        if (!track) return false;
        snap.keys.forEach(rec=>{
            let k = (track.keys || []).find(x=>x.frame === rec.frame && x.type === "property");
            if (!k) return;
            if (rec.entry === null){
                if (k.props) delete k.props[snap.layerId];
            }else{
                k.props = k.props || {};
                k.props[snap.layerId] = clonePlainData(rec.entry);
            }
        });
        clearRenderCache();
        cachedImage = undefined;
        return true;
    };

    // ── vector node animation (spec 012) ───────────────────────────────────────────────
    // What an edit to the vector layer `ref` at the playhead targets. Mirrors the bone tool's
    // getEditBonePoses/write-target split, but for the per-node `{x,y}` overlay:
    //   - a CONTENT key at this exact frame → {mode:"base"}: edit the base drawing (as before).
    //   - a PROPERTY key at this exact frame → {mode:"pose", key, nodes}: author that key's node
    //     overlay; `nodes` is the key's resolved node map (base overlaid) so the tool starts where
    //     the points visually are.
    //   - any other (derived/in-between) frame → {mode:"display", nodes}: the resolved node map at
    //     this frame, for read-only display (geometry editing is disabled off a key).
    me.getVectorEditTarget = function(ref){
        let track = activeTrack();
        if (!track) return null;
        let id = ref && ref.id;
        if (!id) return null;
        let key = keyAt(track, activeFrameIndex);
        if (key && key.type === "content") return {mode: "base"};
        if (key && key.type === "property"){
            let st = keyState(track, key)[id];
            return {mode: "pose", key: key, nodes: (st && st.nodes) || {}, curves: (st && st.curves) || {}};
        }
        let state = resolveTrackState(track, activeFrameIndex);
        let st = state && state.props && state.props[id];
        return {mode: "display", nodes: (st && st.nodes) || {}, curves: (st && st.curves) || {}};
    };

    // Writes one sub-channel (`nodes` or `curves`) of the vector layer `ref`'s overlay on `key` (a
    // property key). An empty map clears that sub-key (and drops an emptied props entry). No undo
    // step of its own — the vector tool owns the gesture bracket — and no event (the tool triggers
    // vectorChanged); it just refreshes the render cache so the compositor and SVG display pick up
    // the new geometry. Fired live on every move during a drag.
    function writeVectorOverlaySub(ref, key, sub, map){
        if (!key || key.type !== "property") return false;
        let id = ref && ref.id;
        if (!id) return false;
        key.props = key.props || {};
        let entry = key.props[id] || (key.props[id] = {});
        if (map && Object.keys(map).length){
            entry[sub] = clonePlainData(map);
        }else{
            delete entry[sub];
            if (Object.keys(entry).length === 0) delete key.props[id];
        }
        clearRenderCache();
        cachedImage = undefined;
        return true;
    }
    // Absolute node positions {nodeId:{x,y}} the tool committed on this key.
    me.setVectorNodes = function(ref, key, map){ return writeVectorOverlaySub(ref, key, "nodes", map); };
    // Per-edge handle OFFSETS {edgeId:{h1:{x,y},h2:{x,y}}} (relative to endpoints) the tool committed.
    me.setVectorCurves = function(ref, key, map){ return writeVectorOverlaySub(ref, key, "curves", map); };

    // Snapshot / restore just the `nodes` and `curves` sub-keys of a vector layer's overlay across
    // the active track's property keys, so the tool can roll back a cancelled pose gesture (the
    // base-geometry snapshot it already keeps covers the drawing; the overlay lives in the timeline
    // keys). Surgical to those two sub-keys so it never disturbs a key's x/y/opacity/bone overlay.
    me.cloneVectorOverlayState = function(ref){
        let track = activeTrack();
        let id = ref && ref.id;
        if (!track || !id) return undefined;
        let snap = {layerId: id, clipId: editContextKey(), trackIndex: tracks().indexOf(track), keys: []};
        (track.keys || []).forEach(k=>{
            if (k.type === "property"){
                let entry = k.props && k.props[id];
                snap.keys.push({
                    frame: k.frame,
                    nodes: entry && entry.nodes ? clonePlainData(entry.nodes) : null,
                    curves: entry && entry.curves ? clonePlainData(entry.curves) : null
                });
            }
        });
        return snap;
    };

    me.restoreVectorOverlayState = function(snap){
        if (!snap) return false;
        if (snap.clipId) touchClip(clipById(snap.clipId));
        let track = trackListFor(snap.clipId)[snap.trackIndex];
        if (!track) return false;
        let restoreSub = function(entry, k, layerId, sub, value){
            if (value === null){
                if (entry){ delete entry[sub]; }
            }else{
                entry = entry || (k.props[layerId] = {});
                entry[sub] = clonePlainData(value);
            }
            return entry;
        };
        snap.keys.forEach(rec=>{
            let k = (track.keys || []).find(x=>x.frame === rec.frame && x.type === "property");
            if (!k) return;
            k.props = k.props || {};
            let entry = k.props[snap.layerId];
            entry = restoreSub(entry, k, snap.layerId, "nodes", rec.nodes);
            entry = restoreSub(entry, k, snap.layerId, "curves", rec.curves);
            if (entry && Object.keys(entry).length === 0) delete k.props[snap.layerId];
        });
        clearRenderCache();
        cachedImage = undefined;
        return true;
    };

    // v2 document: tracks own keys own cels. `indexed` switches layer pixels from data URLs
    // to palette indices (used by the indexed save path).
    me.clone = function(indexed){
        let struct = {
            type: "dpaint",
            version: "2",
            image: {},
        };

        struct.image.name = currentFile.name;
        struct.image.width = currentFile.width;
        struct.image.height = currentFile.height;
        struct.image.activeLayerIndex = editStack.length ? 0 : activeLayerIndex;
        struct.image.activeLayerPath = editStack.length ? editStack[0].parentLayerPath : activeLayerPath;
        // The saved playhead is the ROOT one: inside a clip the active indices are clip-local,
        // and the root values wait in the bottom edit-stack entry (spec 024 §3.7).
        struct.image.activeFrameIndex = me.getRootFrameIndex();
        struct.image.activeTrackIndex = editStack.length ? (editStack[0].parentTrackIndex || 0) : activeTrackIndex;
        struct.image.nextLayerId = syncNextLayerId();
        struct.errorCount = 0;

        function serializeTracks(list){
            return (list || []).map(track=>({
                id: track.id,
                name: track.name,
                visible: track.visible !== false,
                locked: !!track.locked,
                mask: !!track.mask,
                keys: (track.keys || []).map(key=>{
                    if (key.type === "content"){
                        let cel = {layers: [], activeLayerIndex: (key.cel && key.cel.activeLayerIndex) || 0};
                        ((key.cel && key.cel.layers) || []).forEach(layer=>{
                            let _layer = layer.clone(true, indexed);
                            struct.errorCount += (_layer.conversionErrors || 0);
                            cel.layers.push(_layer);
                        });
                        return {frame: key.frame, type: "content", tween: !!key.tween, ...easingData(key.easing), cel: cel};
                    }
                    return {frame: key.frame, type: "property", tween: !!key.tween, ...easingData(key.easing),
                        props: clonePlainData(key.props) || {}};
                })
            }));
        }

        // Serialization is of the ROOT timeline, whatever is being edited (spec 024).
        struct.image.timeline = {
            fps: me.getFps(),
            tracks: serializeTracks(tracksOf(rootTimeline()))
        };
        // The clip library (spec 024, D5: format stays "2", extended in place). Written whenever
        // the document ever had a clip, so the id allocator never hands out a deleted clip's id.
        let lib = currentFile.library;
        syncParamTracks();
        if (lib && (lib.clips.length || (lib.nextClipId || 1) > 1)){
            struct.image.library = {
                nextClipId: lib.nextClipId || 1,
                clips: lib.clips.map(clip=>{
                    let out = {
                        id: clip.id,
                        name: clip.name,
                        length: clip.length,
                        pivot: {x: clip.pivot.x, y: clip.pivot.y},
                        markers: copyMarkers(clip.markers),
                        timeline: {tracks: serializeTracks(clip.timeline && clip.timeline.tracks)}
                    };
                    // clip parameters and their timelines (spec 026 R25)
                    if (Array.isArray(clip.params) && clip.params.length){
                        out.params = copyParams(clip.params);
                        out.nextParamId = clip.nextParamId || 1;
                    }
                    return out;
                })
            };
        }
        if (currentFile.smooth) struct.image.smooth = true;

        if (currentFile.colorRange) struct.image.colorRange = currentFile.colorRange;
        if (currentFile.meta) struct.image.meta = clonePlainData(currentFile.meta);

        // Embed any user-loaded vector-text fonts so text set in them still renders (and can
        // still be "Convert to Shape"-d) after reloading this file - see util/fonts.js.
        let customFonts = getCustomFonts();
        if (customFonts.length) struct.customFonts = customFonts;

        return struct;
    };

    function maxParamId(params){
        let max = 0;
        (params || []).forEach(p=>{
            [p.id].concat((p.options || []).map(o=>o.id)).forEach(id=>{
                let n = parseInt(String(id).replace(/^[A-Z]/, ""), 10);
                if (Number.isFinite(n) && n > max) max = n;
            });
        });
        return max;
    }

    function restoreLibrary(source, restoreTracks){
        let lib = emptyLibrary();
        if (!source || !Array.isArray(source.clips)) return lib;
        let finite = v=>typeof v === "number" && Number.isFinite(v);
        let maxId = 0;
        let names = new Set();
        let ids = new Set();
        source.clips.forEach(c=>{
            if (!c || typeof c.id !== "string" || !c.id || ids.has(c.id)) return;
            ids.add(c.id);
            maxId = Math.max(maxId, clipIdNumber(c.id));
            let name = typeof c.name === "string" && c.name.trim() ? c.name : "Clip";
            if (names.has(name)){
                let n = 2;
                while (names.has(name + " " + n)) n++;
                name = name + " " + n;
            }
            names.add(name);
            let clip = {
                id: c.id,
                name: name,
                length: clampLength(c.length),
                pivot: {x: finite(c.pivot && c.pivot.x) ? c.pivot.x : 0, y: finite(c.pivot && c.pivot.y) ? c.pivot.y : 0},
                markers: [],
                timeline: {tracks: restoreTracks(c.timeline && c.timeline.tracks)},
                rev: ++clipRevCounter
            };
            let markers = copyMarkers(Array.isArray(c.markers) ? c.markers.filter(m=>m && typeof m.name === "string") : []);
            if (validateMarkers(clip, markers).ok) clip.markers = markers;
            // parameters (spec 026): data, normalized; the id allocator stays above every id
            let params = normalizeParams(c.params);
            if (params.length){
                clip.params = params;
                clip.nextParamId = Math.max(finite(c.nextParamId) ? Math.floor(c.nextParamId) : 1, maxParamId(params) + 1);
            }
            // a clip always has at least one track to edit
            if (!clip.timeline.tracks.length) clip.timeline.tracks.push(makeTrack("Track 1", makeCel([])));
            lib.clips.push(clip);
        });
        lib.nextClipId = Math.max(1, maxId + 1, (finite(source.nextClipId) ? Math.floor(source.nextClipId) : 1));
        lib.rev = ++clipRevCounter;
        return lib;
    }

    // Nested overrides in restored key props are data (spec 025 R39): normalized, invalid parts
    // dropped, never thrown.
    function sanitizeKeyOverrides(props){
        Object.keys(props || {}).forEach(id=>{
            let entry = props[id];
            if (!entry || typeof entry !== "object" || !("overrides" in entry)) return;
            let normalized = normalizeOverrides(entry.overrides);
            if (normalized) entry.overrides = JSON.parse(JSON.stringify(normalized));
            else delete entry.overrides;
        });
        return props;
    }

    // Detection is by SHAPE, not by version number: `image.timeline` → v2, `image.frames` →
    // v1 migration. The v1 reader path stays permanently (feasibility section 6) and covers
    // saved files, autosave blobs and whole-image undo snapshots alike.
    function toTimelineStruct(image){
        if (image.timeline) return image.timeline;
        // v1 migration: frame i becomes a content key at frame i on one track. Layers have
        // no stored id/offset, so they get fresh ids and 0/0 (Layer.restore does that).
        return {
            fps: 12,
            tracks: [{
                name: "Track 1",
                visible: true,
                locked: false,
                keys: (image.frames || []).map((frame,index)=>({
                    frame: index,
                    type: "content",
                    tween: false,
                    cel: {layers: frame.layers || [], activeLayerIndex: frame.activeLayerIndex || 0}
                }))
            }]
        };
    }

    me.restore = function(data){
        // Before any layer (and its vector text) is rebuilt, so font-name lookups resolve.
        restoreCustomFonts(data.customFonts);
        if (data.customFonts && data.customFonts.length) EventBus.trigger(EVENT.fontListChanged);

        let image = data.image;
        currentFile.width = image.width;
        currentFile.height = image.height;
        let mockImage = new Image(currentFile.width, currentFile.height);
        let restoredType = getRestoredTypeFromMeta(image.meta);
        let restorePromises = [];
        newFile(mockImage, image.name || currentFile.name, restoredType, undefined, image.meta);
        currentFile.name = image.name || "Untitled";

        let source = toTimelineStruct(image);
        // Restored ids must survive, so raise the allocator above everything stored before
        // any Layer() is created for the restored tree.
        Layer.setIdCounter(image.nextLayerId);
        // An id names one layer lineage on one track (spec 025 R2). Repair files that break that
        // (crafted, or edited outside the app) before anything is rebuilt; sane data is untouched.
        let lineageSources = [source].concat(image.library && Array.isArray(image.library.clips)
            ? image.library.clips.map(c=>c && c.timeline).filter(t=>t && typeof t === "object") : []);
        lineageIds(lineageSources).forEach(id=>Layer.observeId(id));
        let lineageRepairs = sanitizeLineages(lineageSources, ()=>Layer.nextId());
        if (lineageRepairs.length){
            console.warn("Repaired " + lineageRepairs.length + " conflicting layer id(s): " + lineageRepairs.map(r=>r.from + "→" + r.to).join(", "));
        }

        function restoreTracks(list){
            return (Array.isArray(list) ? list : []).map(_track=>({
                // stable track id (spec 026 D10); missing / duplicate ones are repaired below
                id: typeof _track.id === "string" && _track.id ? _track.id : undefined,
                name: _track.name || "Track 1",
                visible: _track.visible !== false,
                locked: !!_track.locked,
                // absent in v1 documents and in pre-mask v2 documents → plain content track
                mask: !!_track.mask,
                keys: (_track.keys || []).map(_key=>{
                    if (_key.type === "property"){
                        return {frame: _key.frame, type: "property", tween: !!_key.tween, ...easingData(_key.easing),
                            props: sanitizeKeyOverrides(clonePlainData(_key.props) || {})};
                    }
                    // Rebuild each cel's layer list from scratch so structural changes
                    // (added/removed/regrouped nodes) restore correctly. Layer.restore owns
                    // the recursion into group children.
                    let cel = {layers: [], activeLayerIndex: (_key.cel && _key.cel.activeLayerIndex) || 0};
                    (((_key.cel && _key.cel.layers) || [])).forEach(_layer=>{
                        let layer = Layer(currentFile.width, currentFile.height);
                        cel.layers.push(layer);
                        restorePromises.push(layer.restore(_layer).then(() => {
                            EventBus.trigger(EVENT.layersChanged);
                            EventBus.trigger(EVENT.imageSizeChanged);
                        }));
                    });
                    return {frame: _key.frame, type: "content", tween: !!_key.tween, ...easingData(_key.easing), cel: cel};
                })
            }));
        }

        currentFile.timeline = {
            fps: source.fps || 12,
            tracks: restoreTracks(source.tracks)
        };
        // The clip library (spec 024). Everything read from the file is treated as data: ids and
        // names are opaque strings, lengths clamped, pivots and markers sanitized (§8). v1 files
        // and v2 files without clips simply have none.
        currentFile.library = restoreLibrary(image.library, restoreTracks);
        currentFile.smooth = !!image.smooth;
        ensureAllTrackIds();
        clearClipCache();
        if (!currentFile.timeline.tracks.length){
            currentFile.timeline = makeTimeline([makeCel([Layer(currentFile.width,currentFile.height,"Layer 1")])]);
        }
        activeTrackIndex = Math.min(image.activeTrackIndex || 0, currentFile.timeline.tracks.length - 1);
        clearRenderCache();
        syncNextLayerId();

        // Resolves once every layer (root and clip timelines) is rebuilt and reactivated.
        let ready = Promise.all(restorePromises).then(()=>{
            clearClipCache();
            // Reactivate after the whole tree exists, by path (falls back to flat index).
            me.activateFrame(image.activeFrameIndex || 0);
            if (Array.isArray(image.activeLayerPath)){
                me.activateLayer(image.activeLayerPath);
            } else {
                me.activateLayer(image.activeLayerIndex || 0);
            }
            restoreOriginalDataFromMeta();
            clearRenderCache();
            EventBus.trigger(EVENT.timelineChanged);
            EventBus.trigger(EVENT.framesChanged);
            if (data.editContext) reenterEditContext(data.editContext);
        });

        if (image.colorRange) currentFile.colorRange = image.colorRange;

        if (data.palette) Palette.set(data.palette);

        if (data.paletteList){
            Palette.setPaletteList(data.paletteList);
            Palette.setPaletteIndex(data.paletteIndex);
        }
        return ready;
    };

    // ── timeline structure history (cheap snapshots) ───────────────────────────────
    // A structure snapshot records tracks/keys/props but references content-key CELS BY
    // REFERENCE — key and track operations never touch pixels, so cloning them would only
    // waste memory. Removed cels stay alive through the snapshot and come back on undo.

    me.cloneTimelineStructure = function(){
        return {
            // Which timeline this snapshot is of: null = root, else the edited clip (spec 024), or
            // "clipId#paramId" for a parameter timeline (spec 026).
            clipId: editContextKey(),
            clipLength: !editParamEntry() && editClip() ? editClip().length : undefined,
            fps: me.getFps(),
            activeTrackIndex: activeTrackIndex,
            activeFrameIndex: activeFrameIndex,
            tracks: tracks().map(track=>({
                id: track.id,
                name: track.name,
                visible: track.visible !== false,
                locked: !!track.locked,
                mask: !!track.mask,
                keys: (track.keys || []).map(key=>key.type === "content"
                    ? {frame: key.frame, type: "content", tween: !!key.tween, ...easingData(key.easing), cel: key.cel}
                    : {frame: key.frame, type: "property", tween: !!key.tween, ...easingData(key.easing), props: clonePlainData(key.props) || {}})
            }))
        };
    };

    me.restoreTimelineStructure = function(snapshot){
        if (!snapshot || !Array.isArray(snapshot.tracks)) return;
        let clipId = typeof snapshot.clipId === "undefined" ? editContextKey() : snapshot.clipId;
        let clip = clipId === null ? undefined : clipById(clipId);
        if (clipId !== null && !clip) return; // the clip was deleted since: no-op (N8)
        // a parameter timeline (spec 026): only its property keys are restored, per track id
        let pctx = parseContextKey(clipId);
        if (pctx.paramId){
            let param = paramOf(clip, pctx.paramId);
            if (!param) return;
            let tracksMap = {};
            snapshot.tracks.forEach(track=>{
                let keys = (track.keys || []).filter(k=>k.type === "property" && k.frame >= 0)
                    .map(k=>({frame: k.frame, type: "property", tween: param.type === "number", ...easingData(k.easing), props: clonePlainData(k.props) || {}}));
                if (track.id && keys.length) tracksMap[track.id] = keys;
            });
            if (paramCtx && paramCtx.param === param) paramCtx = null;
            param.tracks = tracksMap;
            touchClip(clip);
            if (clipId === editContextKey()){
                activeTrackIndex = Math.min(snapshot.activeTrackIndex || 0, Math.max(0, tracks().length - 1));
                activeFrameIndex = Math.min(snapshot.activeFrameIndex || 0, editLength() - 1);
            }
            resolveActiveLayer();
            timelineStructureChanged();
            return;
        }
        let restored = {
            tracks: snapshot.tracks.map(track=>({
                id: track.id,
                name: track.name,
                visible: track.visible !== false,
                locked: !!track.locked,
                mask: !!track.mask,
                keys: track.keys.map(key=>key.type === "content"
                    ? {frame: key.frame, type: "content", tween: !!key.tween, ...easingData(key.easing), cel: key.cel}
                    : {frame: key.frame, type: "property", tween: !!key.tween, ...easingData(key.easing), props: clonePlainData(key.props) || {}})
            }))
        };
        if (clip){
            clip.timeline = restored;
            if (typeof snapshot.clipLength === "number") clip.length = clampLength(snapshot.clipLength);
            touchClip(clip);
        }else{
            restored.fps = snapshot.fps || 12;
            currentFile.timeline = restored;
        }
        // The playhead/active track only follow when the restored timeline is the one being
        // edited; an undo that lands in another clip leaves the current context alone (R21).
        if (clipId === editContextKey()){
            activeTrackIndex = Math.min(snapshot.activeTrackIndex || 0, restored.tracks.length - 1);
            activeFrameIndex = Math.min(snapshot.activeFrameIndex || 0, editLength() - 1);
        }
        resolveActiveLayer();
        timelineStructureChanged();
    };

    // ── history targeting ─────────────────────────────────────────────────────────
    // A layer history step is recorded against the cel that owned the edit. The playhead and
    // the active track can move before undo runs, so the step carries {clipId, trackIndex,
    // keyFrame} and resolves its layer through that instead of through "whatever is active now".
    // clipId (spec 024) is null at the root, so undo lands in the right clip even after leaving it.

    me.getHistoryTarget = function(){
        let track = activeTrack();
        if (!track) return undefined;
        let gov = governingContentKey(track, activeFrameIndex) || contentKeys(track)[0];
        return {clipId: editContextKey(), trackIndex: activeTrackIndex, keyFrame: gov ? gov.frame : 0};
    };

    me.getLayerInTarget = function(target,ref){
        if (!target) return me.getLayer(ref);
        // A target inside a clip that no longer exists resolves to nothing (N8).
        if (target.clipId !== null && typeof target.clipId !== "undefined"){
            let clip = clipById(target.clipId);
            if (!clip) return undefined;
            // resolving a layer inside a clip is how every undo/redo reaches it: whatever it
            // does next changes that clip's definition, wherever the user is editing now
            touchClip(clip);
        }
        let track = trackListFor(target.clipId)[target.trackIndex];
        if (!track) return me.getLayer(ref);
        let key = keyAt(track, target.keyFrame);
        if (!key || key.type !== "content" || !key.cel) return me.getLayer(ref);
        let path = toPath(ref);
        if (!path) return undefined;
        return resolveLayerPath(key.cel.layers, path) || key.cel.layers[path[0]];
    };

    // Applies a keyPropsHistory record (used by undo/redo).
    me.applyKeyProps = function(record){
        if (!record) return;
        if (record.clipId) touchClip(clipById(record.clipId));
        let track = trackListFor(record.clipId)[record.trackIndex];
        if (!track) return;
        let key = keyAt(track, record.keyFrame);
        if (!key) return;
        let v = record.values || {};
        let hasTransform = typeof v.scaleX === "number" || typeof v.scaleY === "number" || typeof v.rotation === "number";
        if (key.type === "property"){
            key.props = key.props || {};
            let entry = {x: v.x, y: v.y, opacity: v.opacity};
            if (hasTransform){
                if (typeof v.scaleX === "number") entry.scaleX = v.scaleX;
                if (typeof v.scaleY === "number") entry.scaleY = v.scaleY;
                if (typeof v.rotation === "number") entry.rotation = v.rotation;
            }
            // merge: keep any pose/vector/cue data the entry carries alongside x/y/opacity
            key.props[record.layerId] = Object.assign({}, key.props[record.layerId], entry);
        }else{
            let node = findNodeById(key.cel.layers, record.layerId);
            if (!node) return;
            node.x = v.x;
            node.y = v.y;
            node.opacity = v.opacity;
            if ((isGroup(node) || isClip(node)) && hasTransform){
                if (typeof v.scaleX === "number") node.scaleX = v.scaleX;
                if (typeof v.scaleY === "number") node.scaleY = v.scaleY;
                if (typeof v.rotation === "number") node.rotation = v.rotation;
            }
        }
        clearRenderCache();
        cachedImage = undefined;
        EventBus.trigger(EVENT.imageContentChanged);
        EventBus.trigger(EVENT.layersChanged);
    };

    // True when layer `id` also lives in a cel of `track` other than `cel` (the lineage continues
    // in another content key, spec 025 R1).
    function lineageElsewhere(track, cel, id){
        return (track && track.keys || []).some(k=>k.type === "content" && k.cel && k.cel !== cel
            && !!findNodeById(k.cel.layers || [], id));
    }

    // Searches ONE cel's tree: ids are unique within a cel (a lineage id may recur in other cels).
    function findNodeById(nodes,id){
        for (let i = 0; i < nodes.length; i++){
            let node = nodes[i];
            if (!node) continue;
            if (node.id === id) return node;
            if (isGroup(node)){
                let inner = findNodeById(node.layers || [], id);
                if (inner) return inner;
            }
        }
        return undefined;
    }

    me.export = function(indexed){
        let struct = me.clone(indexed);

        struct.palette = Palette.get();
        let paletteList = Palette.getPaletteList();
        if (paletteList.length>1){
            struct.paletteList = paletteList;
            struct.paletteIndex = Palette.getPaletteIndex();
        }

        if (currentFile.colorRange) struct.colorRange = currentFile.colorRange;
        if (currentFile.indexedPixels){
            struct.indexedPixels = currentFile.indexedPixels;
        }else{
            if (indexed){
                struct.indexedPixels = me.generateIndexedPixels();
            }
        }
        console.log(struct);
        return struct;
    }

    function preservePreviousDocument(){
        if (!currentFile?.timeline || !me.getActiveLayer()) return;
        // Serialize before the incoming file changes the palette, metadata or layer tree.
        rememberPreviousDocument(structuredClone(me.export()));
    }

    me.restorePreviousDocument = async function(){
        const previous = getPreviousDocument();
        if (!previous?.data) return;
        preservePreviousDocument();
        setCurrentFileHandle();
        await me.restore(previous.data);
    };

    me.autoSave = function(){
        let data = me.export();
        storage.putFile("autosave",data);
    }
    window.autoSave = me.autoSave;

    me.restoreAutoSave = function(){
        storage.getFile("autosave").then(data=>{
            if (data){
                setCurrentFileHandle();
                me.restore(data);
            }
        });
    }

    function autoSave(){
        if (autoSaveTimer) clearTimeout(autoSaveTimer);
        autoSaveTimer = setTimeout(me.autoSave,1000);
    }

    me.addLayer = addLayer;
    me.removeLayer = removeLayer;
    me.moveLayer = moveLayer;

    me.hasMultipleFrames = function(){
        return me.getFrameCount() > 1;
    }

    function handleUpload(files,target,onOpened){
        stop();
        if (files.length) {
            var file = files[0];
            var detectType;
            var isText;
            var fileName = file.name.split(".");
            var ext = fileName.pop().toLowerCase();
            fileName = fileName.join(".");

            if (ext === "info") detectType = true;
            if (ext === "gif") detectType = true;
            if (ext === "png") detectType = true;
            if (ext === "psd") detectType = true;
            if (ext === "pcx") detectType = true;
            if (ext === "pdf") detectType = true;
            if (ext === "planes") detectType = true;
            if (ext === "json") isText = true;
            if (ext === "svg") isText = true;

            var reader = new FileReader();
            reader.onload = async function(){
                try {
                if (detectType) {
                    me.handleBinary(reader.result, file.name, target,true,onOpened);
                } else if (isText) {
                    if (ext === "svg") {
                        if (await me.importSVG(reader.result, fileName)) onOpened?.("SVG");
                    } else {
                        let data = {};
                        if (ext === "json") {
                            try {
                                data = JSON.parse(reader.result);
                            } catch (e) {
                                console.error("Can't parse JSON");
                            }
                        }
                        if (data) {
                            me.handleJSON(data,target);
                            if (data.image && target === "file") onOpened?.("DPAINT");
                        }
                    }
                } else {
                    // load as Image, fallback to detectType if it fails
                    var image = new Image();
                    image.onload = function(){
                        URL.revokeObjectURL(this.src);
                        handleOpenedImage(image,fileName,target);
                        onOpened?.(({"image/jpeg":"JPG", "image/png":"PNG"})[file.type]
                            || ({jpg:"JPG", jpeg:"JPG", png:"PNG"})[ext]);
                    };
                    image.onerror = function(){
                        URL.revokeObjectURL(this.src);
                        detectType = true;
                        reader.readAsArrayBuffer(file);
                    };
                    image.setAttribute("crossOrigin", "");
                    image.src = reader.result;
                }
                } catch (error){ Modal.alert(error.message, "Could not open file"); }
            };
            reader.onerror = () => Modal.alert("Could not read " + file.name, "Could not open file");
            if (isText) {
                reader.readAsText(file);
            } else if (detectType) {
                reader.readAsArrayBuffer(file);
            } else {
                reader.readAsDataURL(file);
            }
        }
    }
    me.handleUpload = handleUpload;

    me.handleBinary = function (data,name,target,stillTryImage,onOpened){
        let now = performance.now();

        name = name || "";
        let fileName = name.split(".");
        fileName = fileName.join(".");
        console.log("Loading file: ", fileName);

        // Raw bitplanes are headerless, so there is nothing for the FileDetector to detect:
        // the layout has to be asked for. Handled here rather than in detect.js so that
        // cancelling the dialog simply does nothing, instead of falling through to the
        // "not a known image type" path.
        if (name.split(".").pop().toLowerCase() === "planes"){
            importPlanes(data,fileName,target,onOpened);
            return;
        }

        FileDetector.detect(data, name).then((result) => {
            console.log(" FileDetector: ", result);
            if (result) {
                const commit = images => {
                    openDetected(result,fileName,target,now,images);
                    const formats = ["PNG", "GIF", "PSD", "PCX", "PDF", "classicIcon", "colorIcon", "PNGIcon"];
                    const format = result.type === "IFF" ? (result.data?.frames?.length ? "ANIM" : "IFF")
                        : (formats.includes(result.type) ? result.type : (name.toLowerCase().endsWith(".png") ? "PNG" : undefined));
                    onOpened?.(format);
                };
                // Opening a multi-frame file asks which frames to take FIRST. Everything
                // below mutates the current document (palette included), so the question has
                // to come before any of it — cancelling then leaves the open file untouched.
                // Icons are excluded: their two "frames" are states, not an animation.
                if (target === "file" && Array.isArray(result.image) && result.image.length > 1
                    && !isIconType(result.type)){
                    Modal.show(DIALOG.FRAMERANGE,{
                        frameCount: result.image.length,
                        fileName: name,
                        onOk: (range)=>commit(result.image.slice(range.from, range.to + 1))
                    });
                    return;
                }
                commit();
            } else {
                if (stillTryImage) {
                    // happens when the file is not coming from a file upload
                    var image = new Image();
                    image.onload = function(){
                        URL.revokeObjectURL(this.src);
                        handleOpenedImage(image,fileName,target);
                        onOpened?.(({png:"PNG", jpg:"JPG", jpeg:"JPG"})[name.split(".").pop().toLowerCase()]);
                    };
                    image.onerror = function(){
                        URL.revokeObjectURL(this.src);
                        console.error("File is not a default image type");
                    };
                    image.setAttribute("crossOrigin", "");
                    var arrayBufferView = new Uint8Array(data);
                    var blob = new Blob([arrayBufferView], {
                        type: "image/png",
                    });
                    image.src = URL.createObjectURL(blob);
                }
            }
        }).catch(error => Modal.alert(error.message, "Could not open file"));
    };

    // Commits a detected file to the document: original type/data/meta, the palette, and then
    // the image itself. Split out of handleBinary so a multi-frame open can put a dialog in
    // front of it without any of this having happened yet. `images` overrides result.image,
    // which is how a frame range is applied.
    function openDetected(result,fileName,target,startTime,images){
        if (target !== "frame" && target !== "brush") preservePreviousDocument();
        let meta = extractFileMeta(result.type,result.data);
        currentFile.originalType = result.type;
        currentFile.originalData = result.data;
        currentFile.meta = meta;
        if (result.data) {
            if (
                result.data.xAspect &&
                result.data.yAspect &&
                result.data.xAspect !== result.data.yAspect
            ) {
                console.warn(
                    "Aspect ratio is not square! -> " +
                        result.data.xAspect / result.data.yAspect
                );
            }

            if (result.data.palette && target==="file") {
                Palette.set(result.data.palette);
            }

            if (result.data.colourRange) {
                console.log(
                    "Image has color cycling: ",
                    result.data.colourRange
                );
            }
        }
        handleOpenedImage(images || result.image,fileName,target,meta,true);

        if (typeof startTime === "number"){
            console.log("File loaded in " + (performance.now() - startTime) + "ms");
        }
    }

    me.setOriginalImageType = async function(type){
        let iconMeta = getCurrentIconMeta();
        let currentType = currentFile.originalType;
        if (!iconMeta || !type || type === currentType) return;

        storeCurrentIconVariant(currentType);
        let image = await getIconVariantCanvases(type);
        if (!image.length) return;

        if (iconMeta.variants) delete iconMeta.variants[type];
        iconMeta.selectedImageType = type;
        updateIconMetaAvailableTypes(iconMeta);

        currentFile.originalType = type;
        if (currentFile.originalData){
            currentFile.originalData.selectedImageType = type;
            currentFile.originalData.availableImageTypes = iconMeta.availableImageTypes.slice();
        }

        let fileName = currentFile.name || "Untitled";
        newFile(image[0],fileName,type,currentFile.originalData,currentFile.meta);

        EventBus.hold();
        for (let i = 1; i < image.length; i++) addFrame(image[i]);
        EventBus.release();
        EventBus.trigger(EVENT.framesChanged);
    };

    me.setOriginalIconType = function(type){
        let originalData = currentFile.originalData;
        if (!type) return;

        let numericType = parseInt(type,10);
        if (isNaN(numericType)) return;

        if (originalData){
            originalData.type = numericType;
            if (!originalData.info) originalData.info = {};
            originalData.info.type = AmigaIcon.getIconType(numericType);
        }
        let iconMeta = getCurrentIconMeta(true);
        if (iconMeta){
            iconMeta.iconType = numericType;
            iconMeta.iconTypeLabel = AmigaIcon.getIconType(numericType);
        }
        EventBus.trigger(EVENT.framesChanged);
    };

    me.setOriginalToolTypes = function(toolTypes){
        if (typeof toolTypes === "string"){
            toolTypes = toolTypes
                .split(/\r?\n/)
                .map(line=>line.trim())
                .filter(Boolean);
        }

        if (!Array.isArray(toolTypes)) return;

        let originalData = currentFile.originalData;
        if (originalData){
            originalData.toolTypes = toolTypes.slice();
            originalData.hasToolTypes = toolTypes.length ? 1 : 0;
        }
        let iconMeta = getCurrentIconMeta(true);
        if (iconMeta){
            iconMeta.toolTypes = toolTypes.slice();
        }
        EventBus.trigger(EVENT.framesChanged);
    };

    me.setOriginalDefaultTool = function(defaultTool){
        if (typeof defaultTool !== "string") return;

        let originalData = currentFile.originalData;
        if (originalData){
            originalData.defaultTool = defaultTool;
            originalData.hasDefaultTool = defaultTool ? 1 : 0;
        }

        let iconMeta = getCurrentIconMeta(true);
        if (iconMeta){
            iconMeta.defaultTool = defaultTool;
        }
        EventBus.trigger(EVENT.framesChanged);
    };

    function extractLayersFromDPaintJSON(data){
        let layerStructs = [];
        if (!data) return layerStructs;

        if (Array.isArray(data.layers)) {
            return data.layers;
        }

        let image = data.image || data;

        if (Array.isArray(image.layers)) {
            return image.layers;
        }

        let source = toTimelineStruct(image);
        if (source && Array.isArray(source.tracks)){
            let frameIdx = (typeof image.activeFrameIndex === "number") ? image.activeFrameIndex : 0;
            source.tracks.forEach(track => {
                if (!track || !Array.isArray(track.keys)) return;
                let contentKeys = track.keys.filter(k => k.type === "content" && k.cel && Array.isArray(k.cel.layers));
                if (!contentKeys.length) return;
                let targetKey = contentKeys.find(k => k.frame === frameIdx) || contentKeys[0];
                if (targetKey && targetKey.cel && Array.isArray(targetKey.cel.layers)){
                    targetKey.cel.layers.forEach(l => layerStructs.push(l));
                }
            });
        } else if (image.frames && Array.isArray(image.frames)){
            let frameIdx = (typeof image.activeFrameIndex === "number") ? image.activeFrameIndex : 0;
            let f = image.frames[frameIdx] || image.frames[0];
            if (f && Array.isArray(f.layers)){
                layerStructs.push(...f.layers);
            }
        }

        return layerStructs;
    }

    function importDPaintLayers(data){
        if (!data) return;
        if (data.customFonts){
            restoreCustomFonts(data.customFonts);
            if (data.customFonts.length) EventBus.trigger(EVENT.fontListChanged);
        }

        let sourceLayers = extractLayersFromDPaintJSON(data);
        if (!sourceLayers || !sourceLayers.length) return;

        HistoryService.start(EVENT.imageHistory);
        let restorePromises = [];

        sourceLayers.forEach(sourceLayer => {
            let layerStruct = withFreshIds(clonePlainData(sourceLayer));
            if (!layerStruct.w && layerStruct.width) layerStruct.w = layerStruct.width;
            if (!layerStruct.h && layerStruct.height) layerStruct.h = layerStruct.height;
            let layer = Layer(currentFile.width, currentFile.height);
            currentFrame().layers.push(layer);
            restorePromises.push(layer.restore(layerStruct));
        });

        Promise.all(restorePromises).then(() => {
            syncNextLayerId();
            let topIndex = currentFrame().layers.length - 1;
            me.activateLayer(topIndex);
            clearRenderCache();
            HistoryService.end();
            EventBus.trigger(EVENT.layersChanged);
            EventBus.trigger(EVENT.imageContentChanged);
            EventBus.trigger(EVENT.layerContentChanged);
            me.render();
        });
    }

    me.handleJSON = function(data,target){
        if (data.type === "dpaint" || data.image || data.layers) {
            if (target !== "frame" && target !== "brush" && data.image) preservePreviousDocument();

            if (target==="file"){
                if (data.palette) Palette.set(data.palette);

                if (data.paletteList){
                    Palette.setPaletteList(data.paletteList);
                    Palette.setPaletteIndex(data.paletteIndex);
                }

                if (data.colorRange){
                    currentFile.colorRange = data.colorRange;
                }
            }

            switch (target){
                case "frame":
                    importDPaintLayers(data);
                    break;
                case "brush":
                    Brush.import(data);
                    break;
                default:
                    setCurrentFileHandle();
                    me.restore(data);
            }
        }
        if (data.type === "palette") {
            Palette.set(data.palette);
        }
    }

    function importPlanes(data,fileName,target,onOpened){
        import("./fileformats/planes.js").then(module=>{
            let PLANES = module.default;
            let guess = PLANES.guess(data.byteLength,currentFile.width,PLANES.getPalettePlaneCount());
            Modal.show(DIALOG.PLANES,{
                buffer: data,
                guess: guess,
                onOk: (options)=>{
                    let canvas = PLANES.toCanvas(data,options);
                    if (!canvas) return;
                    if (target !== "frame" && target !== "brush") preservePreviousDocument();
                    // The palette is not part of the file: the planes are indexed against
                    // whatever palette is loaded, which is exactly how they were exported.
                    currentFile.originalType = "PLANES";
                    currentFile.originalData = undefined;
                    currentFile.meta = undefined;
                    handleOpenedImage(canvas,fileName,target,undefined,true);
                    onOpened?.();
                }
            });
        });
    }

    function handleOpenedImage(image,fileName,target,meta,previousPreserved){
        if (!previousPreserved && target !== "frame" && target !== "brush") preservePreviousDocument();
        switch (target){
            case "frame":
                if (Array.isArray(image)) {
                    // an animation: lay its frames out on their own track from the playhead
                    if (image.length > 1) importFramesAsTrack(image, fileName);
                    else drawFrame(image[0], fileName);
                } else {
                    drawFrame(image, fileName);
                }
                break;
            case "brush":
                Brush.import(image);
                break;
            default:
                setCurrentFileHandle();
                if (Array.isArray(image)) {
                    newFile(image[0],fileName,currentFile.originalType,currentFile.originalData,meta);
                    EventBus.hold();
                    for (let i = 1; i < image.length; i++) addFrame(image[i]);
                    EventBus.release();
                    EventBus.trigger(EVENT.framesChanged);
                } else if (currentFile.originalData && currentFile.originalData.layers && currentFile.originalData.layers.length) {
                    newFileFromLayers(currentFile.originalData.layers, image, fileName, currentFile.originalType, currentFile.originalData, meta);
                } else {
                    newFile(image,fileName,currentFile.originalType,currentFile.originalData,meta)
                }
        }
    }

    // Layer ids only have to be unique within one document, so a new file restarts the
    // allocator. ImageFile.restore() runs newFile() first and then raises the counter above
    // every id it reads back, so restored ids are always preserved (see Layer.observeId).
    function resetLayerIds(){
        Layer.resetIdCounter();
    }

    // Strips stored ids from a cloned layer struct (recursively) so restore() allocates
    // fresh ones. Duplicates and pastes are new nodes: they must not share identity with
    // their source, or a property key would animate both at once.
    function withFreshIds(struct){
        if (!struct) return struct;
        delete struct.id;
        if (Array.isArray(struct.layers)) struct.layers.forEach(withFreshIds);
        return struct;
    }

    // Bakes the RESOLVED (possibly tweened) values of `node` into the base values of its cloned
    // `struct`, recursively — the same thing copyResolvedCel() does for a content-key copy.
    // A copy that gets fresh ids (above) inherits none of the source's property-key overrides,
    // so without this a duplicate of a layer that was moved on a property key came back at its
    // base position instead of where the user sees it.
    function withResolvedProps(struct,node,props){
        if (!struct || !node) return struct;
        let effective = effectiveProps(node, props);
        struct.x = effective.x;
        struct.y = effective.y;
        struct.opacity = effective.opacity;
        if (isGroup(node) || isClip(node)){
            struct.scaleX = effective.scaleX;
            struct.scaleY = effective.scaleY;
            struct.rotation = effective.rotation;
            if (Array.isArray(struct.layers) && Array.isArray(node.layers)){
                struct.layers.forEach((child,index)=>withResolvedProps(child,node.layers[index],props));
            }
        }
        return struct;
    }

    // Mirrors the allocator into the document so it can be serialized (design 3.5).
    function syncNextLayerId(){
        currentFile.nextLayerId = Layer.peekIdCounter();
        return currentFile.nextLayerId;
    }
    me.getNextLayerId = syncNextLayerId;

    function newFile(image,fileName,type,originalData,meta){
        nestedFocus = null;
        Historyservice.clear();
        getRecorderIfLoaded()?.clear();
        cachedImage = undefined;
        resetLayerIds();
        EventBus.trigger(COMMAND.CLEARSELECTION);
        let w = 320;
        let h = 256;
        if (image) {
            w = image.width;
            h = image.height;
        }
        currentFile = {
            width: w,
            height: h,
            name: fileName || "Untitled",
            // one track, one content key at frame 0 — the degenerate case of the timeline
            // model, which is exactly what a still image is
            timeline: makeTimeline(),
            library: emptyLibrary(),
            nextLayerId: 1,
            colorRange:[]
        }
        if (editStack.length){ editStack = []; EventBus.trigger(EVENT.editContextChanged); }
        clearClipCache();
        activeTrackIndex = 0;
        if (type) currentFile.originalType = type;
        if (originalData){
            if (originalData.palette) currentFile.palette = originalData.palette;
            if (originalData.colourRange) currentFile.colorRange = originalData.colourRange;
            if (originalData.pixels) currentFile.indexedPixels = originalData.pixels;
            currentFile.originalData = originalData;
        }
        if (meta) currentFile.meta = clonePlainData(meta);
        activeFrameIndex = 0;
        activeLayerIndex = 0;
        activeLayerPath = [0];
        // Hold layersChanged until activeLayer points at the new layer — addLayer() fires it
        // synchronously, and listeners (e.g. Toolbar's pixel/vector mode switch) read
        // getActiveLayer() off that event, which would otherwise still return the layer from
        // the file we're replacing.
        EventBus.hold();
        addLayer();
        activeLayer = currentFrame().layers[0];
        activeLayer.clear();
        if (image) {
            activeLayer.getContext().drawImage(image, 0, 0);
        }
        EventBus.release();
        EventBus.trigger(EVENT.imageSizeChanged);
        if (["classicIcon","colorIcon","PNGIcon"].includes(type)){
            PanelManager.reveal("icon", true);
        }
    }

    // Builds a Layer (or group Layer) from a plain source-layer descriptor as produced by
    // the file-format parsers (PSD/Aseprite) or newFileFromLayers callers. Recurses into
    // `layers` for groups.
    function buildLayerNode(source, index, w, h){
        if (source && source.type === "group" && Array.isArray(source.layers)){
            let group = Layer.makeGroup(w, h, source.name || ("Group " + (index + 1)));
            group.visible = source.visible !== false;
            group.opacity = typeof source.opacity === "number" ? source.opacity : 100;
            group.blendMode = source.blendMode || "normal";
            group.locked = !!source.locked;
            group.collapsed = !!source.collapsed;
            group.layers = source.layers.map((child, i)=>buildLayerNode(child, i, w, h));
            return group;
        }
        let layer = Layer(w, h, source.name || ("Layer " + (index + 1)));
        layer.visible = source.visible !== false;
        layer.opacity = typeof source.opacity === "number" ? source.opacity : 100;
        layer.blendMode = source.blendMode || "normal";
        layer.locked = !!source.locked;
        if (source.canvas){
            layer.drawImage(source.canvas, source.left || 0, source.top || 0);
        }
        return layer;
    }

    function newFileFromLayers(sourceLayers,image,fileName,type,originalData,meta){
        Historyservice.clear();
        getRecorderIfLoaded()?.clear();
        cachedImage = undefined;
        resetLayerIds();
        EventBus.trigger(COMMAND.CLEARSELECTION);

        let w = originalData && originalData.width ? originalData.width : 320;
        let h = originalData && originalData.height ? originalData.height : 256;
        if (image) {
            w = image.width || w;
            h = image.height || h;
        }

        currentFile = {
            width: w,
            height: h,
            name: fileName || "Untitled",
            timeline: makeTimeline(),
            library: emptyLibrary(),
            nextLayerId: 1,
            colorRange:[]
        };
        if (editStack.length){ editStack = []; EventBus.trigger(EVENT.editContextChanged); }
        clearClipCache();
        activeTrackIndex = 0;

        if (type) currentFile.originalType = type;
        if (originalData){
            currentFile.originalData = originalData;
        }
        if (meta) currentFile.meta = clonePlainData(meta);

        activeFrameIndex = 0;
        activeLayerIndex = 0;
        activeLayerPath = [0];

        let layers = sourceLayers.slice();

        EventBus.hold();
        // Build the layer tree from the source list. A source entry with type "group" and
        // a `layers` array becomes a group Layer with recursively-built children (this is
        // what the PSD/Aseprite parsers emit once group reconstruction is active).
        currentFrame().layers = layers.map((sourceLayer, index)=>buildLayerNode(sourceLayer, index, w, h));
        EventBus.release();

        if (!currentFrame().layers.length) {
            addLayer();
        }

        activeLayerIndex = currentFrame().layers.length - 1;
        activeLayerPath = [activeLayerIndex];
        activeLayer = currentFrame().layers[activeLayerIndex];

        EventBus.trigger(EVENT.layersChanged);
        EventBus.trigger(EVENT.imageSizeChanged);
        EventBus.trigger(EVENT.imageContentChanged);
        restoreOriginalDataFromMeta();
    }

    function isIconType(type){
        return ["classicIcon","colorIcon","PNGIcon"].includes(type);
    }

    function clonePlainData(data){
        if (typeof data === "undefined") return undefined;
        return JSON.parse(JSON.stringify(data));
    }

    function extractFileMeta(type,data){
        if (!isIconType(type) || !data) return undefined;
        let selectedImageType = data.selectedImageType || type;
        let availableImageTypes = Array.isArray(data.availableImageTypes) ? data.availableImageTypes.slice() : AmigaIcon.getImageTypes(data);
        let variants = {};
        availableImageTypes.forEach(imageType=>{
            if (imageType === selectedImageType) return;
            let images = [
                AmigaIcon.getImage(data,0,imageType),
                AmigaIcon.getImage(data,1,imageType),
            ].filter(Boolean);
            if (images.length){
                variants[imageType] = serializeCanvasSet(images);
            }
        });
        return {
            icon: {
                iconType: data.type,
                iconTypeLabel: data.info && data.info.type,
                selectedImageType: selectedImageType,
                availableImageTypes: availableImageTypes.slice(),
                toolTypes: Array.isArray(data.toolTypes) ? data.toolTypes.slice() : [],
                variants: variants,
                userData: data.userData,
                stackSize: data.stackSize,
                defaultTool: data.defaultTool,
                toolWindow: typeof data.hasToolWindow === "string" ? data.hasToolWindow : data.toolWindow,
                drawerData: data.drawerData ? clonePlainData(data.drawerData) : undefined,
                drawerData2: data.drawerData2 ? clonePlainData(data.drawerData2) : undefined,
            }
        };
    }

    function getCurrentIconMeta(create){
        if (!currentFile.meta){
            if (!create) return;
            currentFile.meta = {};
        }
        if (!currentFile.meta.icon && create){
            currentFile.meta.icon = {};
        }
        return currentFile.meta.icon;
    }

    function getRestoredTypeFromMeta(meta){
        let iconMeta = meta && meta.icon;
        if (!iconMeta) return;
        return iconMeta.selectedImageType || "classicIcon";
    }

    function buildOriginalDataFromMeta(){
        let iconMeta = getCurrentIconMeta();
        if (!iconMeta) return;

        let originalData = {
            type: iconMeta.iconType,
            selectedImageType: iconMeta.selectedImageType || currentFile.originalType || "classicIcon",
            toolTypes: Array.isArray(iconMeta.toolTypes) ? iconMeta.toolTypes.slice() : [],
            hasToolTypes: Array.isArray(iconMeta.toolTypes) && iconMeta.toolTypes.length ? 1 : 0,
            userData: typeof iconMeta.userData === "number" ? iconMeta.userData : 1,
            stackSize: typeof iconMeta.stackSize === "number" ? iconMeta.stackSize : 8192,
        };

        if (iconMeta.iconTypeLabel){
            originalData.info = {type: iconMeta.iconTypeLabel};
        }
        if (iconMeta.defaultTool){
            originalData.defaultTool = iconMeta.defaultTool;
            originalData.hasDefaultTool = 1;
        }
        if (iconMeta.toolWindow){
            originalData.toolWindow = iconMeta.toolWindow;
            originalData.hasToolWindow = iconMeta.toolWindow;
        }

        originalData.availableImageTypes = Array.isArray(iconMeta.availableImageTypes)
            ? iconMeta.availableImageTypes.slice()
            : [originalData.selectedImageType];

        return originalData;
    }

    function restoreOriginalDataFromMeta(){
        if (currentFile.originalData || !getCurrentIconMeta()) return;
        currentFile.originalData = buildOriginalDataFromMeta();
        if (currentFile.originalData && !currentFile.originalType){
            currentFile.originalType = currentFile.originalData.selectedImageType;
        }
    }

    function canvasToRGBAState(canvas){
        let ctx = canvas.getContext("2d");
        let imageData = ctx.getImageData(0,0,canvas.width,canvas.height).data;
        let pixels = [];
        for (let i = 0; i<imageData.length; i += 4){
            pixels.push([
                imageData[i],
                imageData[i+1],
                imageData[i+2],
                imageData[i+3] / 255
            ]);
        }
        return {
            rgba: true,
            pixels: pixels,
            palette: []
        };
    }

    function serializeCanvasSet(canvases){
        return (canvases || []).filter(Boolean).map(canvas=>canvas.toDataURL("image/png"));
    }

    function deserializeCanvasSet(images){
        return Promise.all((images || []).map(loadCanvasFromDataUrl));
    }

    function loadCanvasFromDataUrl(dataUrl){
        return new Promise((resolve,reject)=>{
            let image = new Image();
            image.onload = ()=>{
                let canvas = document.createElement("canvas");
                canvas.width = image.width;
                canvas.height = image.height;
                canvas.getContext("2d").drawImage(image,0,0);
                resolve(canvas);
            };
            image.onerror = reject;
            image.src = dataUrl;
        });
    }

    function getCurrentImageSetCanvases(){
        return [me.getCanvas(0), me.getCanvas(1)].filter(Boolean).map(canvas=>duplicateCanvas(canvas,true));
    }

    function storeCurrentIconVariant(type){
        let iconMeta = getCurrentIconMeta(true);
        if (!iconMeta || !type) return;
        iconMeta.variants = iconMeta.variants || {};
        iconMeta.variants[type] = serializeCanvasSet(getCurrentImageSetCanvases());
        updateIconMetaAvailableTypes(iconMeta);
    }

    async function getIconVariantCanvases(type){
        let iconMeta = getCurrentIconMeta();
        if (iconMeta && iconMeta.variants && iconMeta.variants[type]){
            return deserializeCanvasSet(iconMeta.variants[type]);
        }

        let originalData = currentFile.originalData;
        if (!originalData) return [];

        return [
            AmigaIcon.getImage(originalData,0,type),
            AmigaIcon.getImage(originalData,1,type),
        ].filter(Boolean).map(canvas=>duplicateCanvas(canvas,true));
    }

    function updateIconMetaAvailableTypes(iconMeta){
        if (!iconMeta) return [];
        let selectedImageType = iconMeta.selectedImageType || currentFile.originalType;
        let availableImageTypes = selectedImageType ? [selectedImageType] : [];
        if (iconMeta.variants){
            Object.keys(iconMeta.variants).forEach(type=>{
                if (iconMeta.variants[type]) availableImageTypes.push(type);
            });
        }
        iconMeta.availableImageTypes = Array.from(new Set(availableImageTypes));
        return iconMeta.availableImageTypes;
    }

    // `options.width` / `options.height` ask for a canvas at least that big. A layer canvas is
    // never SMALLER than the document (anything painted outside its own canvas is lost, so a
    // small import still gets a full-size surface to work on), but it may well be bigger:
    // content past the edges stays alive and is clipped at composite time. See §5/§6 of
    // project/documentation/timeline-animation.md — nothing may assume a layer canvas matches
    // the document, serialization included.
    function addLayer(index,name,options){
        if (refuseInParam("Adding a layer")) return;
        let newLayer = Layer(
            Math.max(currentFile.width, (options && options.width) || 0),
            Math.max(currentFile.height, (options && options.height) || 0),
            name || "Layer " + (currentFrame().layers.length + 1)
        );
        let newIndex = currentFrame().layers.length;
        if (options){
            if (options.locked) newLayer.locked = true;
            if (options.internal) newLayer.internal = true;
        }

        if (typeof index === "undefined") {
            currentFrame().layers.push(newLayer);
        } else {
            currentFrame().layers.splice(index, 0, newLayer);
            newIndex = index;
        }
        EventBus.trigger(EVENT.layersChanged);
        return newIndex;
    }

    // Collects the ids of a node and everything nested inside it.
    function collectIds(node,into){
        into = into || [];
        if (!node) return into;
        if (node.id) into.push(node.id);
        if (isGroup(node) && Array.isArray(node.layers)) node.layers.forEach(child=>collectIds(child,into));
        return into;
    }

    // A property key entry for a layer that no longer exists is harmless but dead weight,
    // and would resurrect if the id were ever reused. Prune it in the same step.
    // Scoped to the property keys governed by the cel the layers were removed FROM (spec 025 R3):
    // an id names a lineage, so the same layer can live on in other content keys of the track,
    // and their property keys still animate it. Defaults to the active track and cel.
    function prunePropsForIds(ids, track, cel){
        if (!ids.length) return;
        track = track || activeTrack();
        cel = cel || currentFrame();
        if (!track || !cel) return;
        let gov = (track.keys || []).find(k=>k.type === "content" && k.cel === cel);
        if (!gov) return;
        propertyKeysGovernedBy(track, gov).forEach(key=>{
            if (!key.props) return;
            ids.forEach(id=>{ delete key.props[id]; });
        });
        // Removing the last cel of a lineage inside a clip: overrides that address it are dead
        // (spec 025 R29). Only clip content can be an override target, and edits inside a clip
        // are whole-image history steps, so undo brings them back.
        if (editStack.length){
            pruneVanishedOverrides();
            pruneParamKeysOf(editClip());
        }
    }

    function removeLayer(ref){
        if (refuseInParam("Removing a layer")) return;
        let path = typeof ref === "undefined" ? activeLayerPath : toPath(ref);
        if (!path) return;
        // removing a bone layer detaches every node attached to it, baking their placement (R36)
        let doomed = resolveLayerPath((currentFrame() || {layers: []}).layers, path);
        if (isBones(doomed)) me.detachAllFor(doomed.id);
        let frame = currentFrame();
        let p = parentOf(frame.layers, path);
        if (!p) return;
        // Don't remove the last remaining top-level layer.
        if (p.parent === frame.layers && frame.layers.length <= 1) return;
        let removedIds = collectIds(resolveLayerPath(frame.layers, path) || p.parent[p.index]);
        removeAtPath(frame.layers, path);
        prunePropsForIds(removedIds);
        // Reactivate: prefer the previous sibling in the same parent, else parent/root 0.
        let activeP = activeLayerPath.slice();
        if (activeP.length){
            if (activeP[activeP.length-1] >= p.parent.length && activeP.length === path.length){
                activeP[activeP.length-1] = Math.max(0, p.parent.length - 1);
            }
        }
        me.activateLayer(activeP.length ? activeP : [0]);
        EventBus.trigger(EVENT.imageContentChanged);
    }

    // ── Group operations ──────────────────────────────────────────────────────────

    // Creates an empty group. atPath: insertion path (defaults to just above active layer at root).
    me.addGroup = function(name, atPath){
        let frame = currentFrame();
        let group = Layer.makeGroup(currentFile.width, currentFile.height,
            name || DuplicateName("Group", frame.layers));
        if (Array.isArray(atPath)){
            insertAtPath(frame.layers, atPath, group);
            me.activateLayer(atPath);
        }else{
            frame.layers.push(group);
            me.activateLayer([frame.layers.length - 1]);
        }
        EventBus.trigger(EVENT.layersChanged);
        EventBus.trigger(EVENT.imageContentChanged);
        return group;
    };

    // Creates a bone (armature) layer. It paints nothing itself; it deforms the pixel layers
    // below it in the same scope (spec 005). atPath: insertion path (defaults to just above the
    // active layer at root), same convention as addGroup.
    me.addBoneLayer = function(name, atPath){
        let frame = currentFrame();
        let bone = Layer.makeBones(currentFile.width, currentFile.height,
            name || DuplicateName("Bones", frame.layers));
        if (Array.isArray(atPath)){
            insertAtPath(frame.layers, atPath, bone);
            me.activateLayer(atPath);
        }else{
            frame.layers.push(bone);
            me.activateLayer([frame.layers.length - 1]);
        }
        EventBus.trigger(EVENT.layersChanged);
        EventBus.trigger(EVENT.imageContentChanged);
        return bone;
    };

    // Creates a vector layer. It holds editable geometry (see util/vectorUtils.js) and rasterizes
    // it into its own canvas at composite time (spec 008), so it composites/exports like a pixel
    // layer. atPath: insertion path (defaults to just above the active layer), like addGroup.
    me.addVectorLayer = function(name, atPath){
        let frame = currentFrame();
        let vector = Layer.makeVector(currentFile.width, currentFile.height,
            name || DuplicateName("Vector", frame.layers));
        if (Array.isArray(atPath)){
            insertAtPath(frame.layers, atPath, vector);
            me.activateLayer(atPath);
        }else{
            frame.layers.push(vector);
            me.activateLayer([frame.layers.length - 1]);
        }
        EventBus.trigger(EVENT.layersChanged);
        EventBus.trigger(EVENT.imageContentChanged);
        return vector;
    };

    // Opens an .svg as editable layers (spec 010): SVG.parse turns the document into vector- and
    // pixel-layer specs, which we realize on a fresh canvas of the parsed size. Vector geometry
    // becomes true vector layers (editable with the vector tools); <image> elements become pixel
    // layers. The inverse of the spec-009 exporter. A malformed SVG surfaces a Modal error rather
    // than corrupting the current document.
    me.importSVG = async function(text, fileName){
        let parsed;
        try {
            let SVG = (await import("./fileformats/svg.js")).default;
            parsed = SVG.parse(text);
        } catch (e){
            console.error("SVG import failed:", e);
            Modal.alert("Could not open this SVG file: " + (e && e.message ? e.message : "invalid SVG") + ".");
            return;
        }

        let blank = document.createElement("canvas");
        blank.width = parsed.width;
        blank.height = parsed.height;
        preservePreviousDocument();
        setCurrentFileHandle();
        newFile(blank, fileName, "SVG");

        for (const spec of parsed.layers){          // bottom-to-top
            if (spec.kind === "vector"){
                let layer = me.addVectorLayer(spec.name);
                layer.vector = spec.vector;
                layer.opacity = Math.round((spec.opacity == null ? 1 : spec.opacity) * 100);
                layer.blendMode = spec.blend || "normal";
                if (layer.markVectorDirty) layer.markVectorDirty();
            } else if (spec.kind === "image"){
                let img = await loadDataUrlImage(spec.dataUrl);
                if (!img) continue;
                let idx = addLayer(undefined, spec.name);
                let layer = me.getLayer([idx]);
                layer.clear();
                layer.drawImage(img, spec.x || 0, spec.y || 0);
                layer.opacity = Math.round((spec.opacity == null ? 1 : spec.opacity) * 100);
                layer.blendMode = spec.blend || "normal";
            }
        }

        // Drop the empty base pixel layer newFile created (only if we added real content on top).
        if (currentFrame().layers.length > 1) removeLayer([0]);
        me.activateLayer([currentFrame().layers.length - 1]);

        EventBus.trigger(EVENT.layersChanged);
        EventBus.trigger(EVENT.imageContentChanged);
        EventBus.trigger(EVENT.vectorChanged);
        return true;
    };

    function loadDataUrlImage(src){
        return new Promise(resolve=>{
            let img = new Image();
            img.onload = ()=>resolve(img);
            img.onerror = ()=>{ console.error("SVG import: could not decode embedded image"); resolve(null); };
            img.setAttribute("crossOrigin", "");
            img.src = src;
        });
    }

    // Bakes a vector layer at `path` into a plain pixel layer: its geometry is rendered into the
    // node's own canvas and the vector state is dropped (see Layer.rasterize). No-op otherwise.
    me.rasterizeLayer = function(path){
        let node = resolveLayerPath(currentFrame().layers, path || activeLayerPath);
        if (!node || !isVector(node)) return;
        node.rasterize();
        EventBus.trigger(EVENT.layersChanged);
        EventBus.trigger(EVENT.imageContentChanged);
    };

    // Scales an armature's rest geometry (and root pose translation) by the resample factors.
    // Angle is preserved (exact for uniform scale); length/radius use the X factor.
    function scaleArmature(armature, scaleX, scaleY){
        (armature.bones || []).forEach(b=>{
            b.rest.x *= scaleX;
            b.rest.y *= scaleY;
            b.rest.length *= scaleX;
            b.actionRadius *= scaleX;
            if (b.pose){
                b.pose.x = (b.pose.x || 0) * scaleX;
                b.pose.y = (b.pose.y || 0) * scaleY;
            }
        });
    }

    // Wraps the nodes at `paths` (which must share one parent) into a new group,
    // placed at the position of the topmost (lowest-index) selected node.
    me.groupLayers = function(paths){
        let frame = currentFrame();
        if (!Array.isArray(paths) || !paths.length){
            return me.addGroup();
        }
        // All selected paths must share the same parent.
        let parentKey = p => p.slice(0,-1).join(",");
        let key0 = parentKey(paths[0]);
        if (!paths.every(p => parentKey(p) === key0)){
            console.warn("groupLayers: selection spans multiple parents; ignoring");
            return;
        }
        // Sort by last index so we remove/insert deterministically.
        let sorted = paths.slice().sort((a,b)=>a[a.length-1]-b[b.length-1]);
        let parentPath = sorted[0].slice(0,-1);
        let parentArr = parentPath.length ? resolveLayerPath(frame.layers, parentPath).layers : frame.layers;
        let insertIndex = sorted[0][sorted[0].length-1];

        // Capture nodes, then remove them high-index-first so indices stay valid.
        let nodes = sorted.map(p => parentArr[p[p.length-1]]);
        for (let i = sorted.length-1; i>=0; i--){
            parentArr.splice(sorted[i][sorted[i].length-1], 1);
        }
        let group = Layer.makeGroup(currentFile.width, currentFile.height,
            DuplicateName("Group", frame.layers));
        nodes.forEach(n => group.layers.push(n));
        parentArr.splice(insertIndex, 0, group);

        let groupPath = parentPath.concat(insertIndex);
        me.activateLayer(groupPath);
        EventBus.trigger(EVENT.layersChanged);
        EventBus.trigger(EVENT.imageContentChanged);
        return group;
    };

    // Promotes a group's children into its parent scope (one level up) and removes the container.
    me.ungroupLayers = function(path){
        let frame = currentFrame();
        let p = parentOf(frame.layers, path);
        if (!p) return;
        let group = p.parent[p.index];
        if (!isGroup(group)) return;
        let children = group.layers.slice();
        // Replace the group with its children, in order, at the group's position.
        p.parent.splice(p.index, 1, ...children);
        me.activateLayer(p.parent.length ? path.slice(0,-1).concat(Math.min(p.index, p.parent.length-1)) : [0]);
        EventBus.trigger(EVENT.layersChanged);
        EventBus.trigger(EVENT.imageContentChanged);
    };

    // Flattens a group into a single leaf Layer at the same position,
    // inheriting the group's name/opacity/blendMode.
    me.mergeGroup = function(path){
        let frame = currentFrame();
        let p = parentOf(frame.layers, path);
        if (!p) return;
        let group = p.parent[p.index];
        if (!isGroup(group)) return;

        let merged = Layer(currentFile.width, currentFile.height, group.name);
        merged.opacity = group.opacity;
        merged.blendMode = group.blendMode;
        merged.locked = group.locked;
        // The group's own offset moves to the merged leaf; the children's offsets are already
        // baked into group.render(), which composites them onto the group canvas.
        merged.x = group.x || 0;
        merged.y = group.y || 0;
        // group.render() composites all visible children (applying their own opacity/blend/mask).
        let rendered = group.render();
        // Bake the group's runtime transform (spec 007) into the pixels: merging is the one
        // operation that makes the scale/rotation permanent, about the content-bounds centre —
        // the same geometry the compositor draws. A scaled-up group may exceed the document-sized
        // merged canvas and clip (consistent with the group canvas being document-sized in v1).
        let sx = typeof group.scaleX === "number" ? group.scaleX : 1;
        let sy = typeof group.scaleY === "number" ? group.scaleY : 1;
        let rot = typeof group.rotation === "number" ? group.rotation : 0;
        let bounds = (sx !== 1 || sy !== 1 || rot !== 0) ? getOpaqueBounds(rendered) : null;
        if (bounds){
            let mctx = merged.getContext();
            let cx = bounds.x + bounds.w / 2;
            let cy = bounds.y + bounds.h / 2;
            // Bake with the group's smooth setting so the merged pixels match what was on screen.
            mctx.imageSmoothingEnabled = !!group.smooth;
            mctx.save();
            mctx.translate(cx, cy);
            mctx.rotate(rot * Math.PI / 180);
            mctx.scale(sx, sy);
            mctx.translate(-cx, -cy);
            mctx.drawImage(rendered, 0, 0);
            mctx.restore();
            merged.update();
        }else{
            merged.drawImage(rendered, 0, 0);
        }
        p.parent.splice(p.index, 1, merged);
        me.activateLayer(path);
        EventBus.trigger(EVENT.layersChanged);
        EventBus.trigger(EVENT.imageContentChanged);
        return merged;
    };

    // Boolean-combines two SIBLING vector layers' geometry into ONE new vector layer that replaces
    // both (Layer panel tool-options buttons, shown when exactly 2 vector layers are multi-
    // selected). Higher index in the shared parent array composites later (see compositeNodes:
    // "bottom of the array first"), so the higher one is "front". mode is one of:
    //   "union"          — either layer's opaque area
    //   "intersect"      — only the overlap
    //   "frontMinusBack" — front's area minus whatever back covers
    //   "backMinusFront" — back's area minus whatever front covers
    // The vector data model has one flat fill colour per region (no raster blend), so the result
    // always takes a single colour — the same simplification real Pathfinder tools make: front's
    // fill wins except for backMinusFront, where only back's own shape (and so its own colour)
    // survives.
    //
    // Unlike a rasterize-then-trace approach, this is a real vector clip (vectorBoolean.js):
    // wherever a shape's edge is untouched by the cut, its ORIGINAL curve data (control points and
    // all) survives byte-identical in the result; only the new boundary the cut itself introduces
    // is fresh geometry. See vectorBoolean.js's own header comment for how (a Weiler–Atherton-style
    // clip generalised to cubic-bezier edges, exact split via de Casteljau at the crossing points).
    me.combineVectorLayers = function(pathA, pathB, mode){
        let frame = currentFrame();
        let pA = parentOf(frame.layers, pathA);
        let pB = parentOf(frame.layers, pathB);
        if (!pA || !pB || pA.parent !== pB.parent) return false;
        let nodeA = pA.parent[pA.index];
        let nodeB = pB.parent[pB.index];
        if (!isVector(nodeA) || !isVector(nodeB)) return false;

        let frontIsA = pA.index > pB.index;
        let frontNode = frontIsA ? nodeA : nodeB;
        let backNode  = frontIsA ? nodeB : nodeA;
        let frontPath = frontIsA ? pathA : pathB;

        let w = currentFile.width, h = currentFile.height;
        let frontOff = me.getLayerOffset(frontPath);
        let backOff  = me.getLayerOffset(frontIsA ? pathB : pathA);

        let result = booleanCombineVectors(frontNode.vector, frontOff, backNode.vector, backOff, mode);
        if (!result || !result.regions.length) return false;

        function firstFillColor(node){
            let regions = node.vector && node.vector.regions;
            if (!regions) return undefined;
            for (let id in regions){ if (regions[id].fill) return regions[id].fill.color; }
            return undefined;
        }
        let resultColor = mode === "backMinusFront"
            ? (firstFillColor(backNode) || firstFillColor(frontNode))
            : (firstFillColor(frontNode) || firstFillColor(backNode));
        if (!resultColor) resultColor = Palette.getDrawColor();

        let sharp = getDisplayMode(frontNode.vector) === "sharp";

        let v = emptyVectorData();
        v.displayMode = frontNode.vector.displayMode || "vector";

        // `arcs` is a closed loop of {p0,p3,h1,h2,isCurve} in document space (arc i's p3 === arc
        // i+1's p0) — build it into real nodes/edges, keeping curve data exactly as computed.
        let makeLoopEdges = (arcs)=>{
            let e = [];
            let firstNode = addNode(v, arcs[0].p0.x, arcs[0].p0.y);
            let prevNode = firstNode;
            for (let i = 0; i < arcs.length; i++){
                let arc = arcs[i];
                let nextNode = (i === arcs.length - 1) ? firstNode : addNode(v, arc.p3.x, arc.p3.y);
                let curve = arc.isCurve ? { h1: { x: arc.h1.x, y: arc.h1.y }, h2: { x: arc.h2.x, y: arc.h2.y } } : null;
                e.push(addEdge(v, prevNode.id, nextNode.id, { curve, stroke: null }).id);
                prevNode = nextNode;
            }
            return e;
        };

        result.regions.forEach(rgn=>{
            let id = newRegionId(v);
            v.regions[id] = {
                id,
                boundary: makeLoopEdges(rgn.boundary),
                holes: rgn.holes.map(makeLoopEdges),
                fillRule: "evenodd",
                fill: { color: resultColor, smooth: !sharp }
            };
        });

        let combinedLayer = Layer.makeVector(w, h, DuplicateName("Combined", frame.layers));
        combinedLayer.vector = v;

        // Replace both originals with the combined layer, at the FRONT layer's slot. front's index
        // is always the higher of the two (that's the definition of "front" above) — remove the
        // lower (back) index first, which shifts front's index down by one, then overwrite that
        // now-correct slot with the combined layer.
        let parentArr = pA.parent;
        let frontIndex = frontIsA ? pA.index : pB.index;
        let backIndex  = frontIsA ? pB.index : pA.index;
        parentArr.splice(backIndex, 1);
        parentArr.splice(frontIndex - 1, 1, combinedLayer);

        me.activateLayer(frontPath.slice(0, -1).concat(frontIndex - 1));
        EventBus.trigger(EVENT.layersChanged);
        EventBus.trigger(EVENT.imageContentChanged);
        return true;
    };

    // Reparenting changes the coordinate system, so carry the translation into the
    // node's local offsets. Shift absolute animation entries too, otherwise a property
    // key would override the compensation and make the layer jump again.
    function preserveLayerPosition(node, path, offset, props){
        if (!path) return;
        let next = resolvedOffset(currentFrame().layers, path, props);
        let dx = offset.x - next.x, dy = offset.y - next.y;
        if (!dx && !dy) return;
        node.x = (node.x || 0) + dx;
        node.y = (node.y || 0) + dy;
        let track = activeTrack();
        let gov = governingContentKey(track, activeFrameIndex);
        if (gov) propertyKeysGovernedBy(track, gov).forEach(key=>{
            let entry = key.props && key.props[node.id];
            if (!entry) return;
            if (typeof entry.x === "number") entry.x += dx;
            if (typeof entry.y === "number") entry.y += dy;
        });
    }

    function moveLayer(from,to){
        if (refuseInParam("Moving a layer")) return;
        let frame = currentFrame();
        let fromPath = toPath(from);
        let toP = toPath(to);
        if (!fromPath || !toP) return;

        // Legacy flat path: both top-level integers → clamp like before.
        if (fromPath.length === 1 && toP.length === 1){
            if (frame.layers.length <= 1) return;
            let toIndex = toP[0];
            if (toIndex >= frame.layers.length) toIndex = frame.layers.length - 1;
            if (toIndex < 0) toIndex = 0;
            if (toIndex !== fromPath[0]){
                let layer = frame.layers[fromPath[0]];
                frame.layers.splice(fromPath[0], 1);
                frame.layers.splice(toIndex, 0, layer);
            }
            me.activateLayer([toIndex]);
            EventBus.trigger(EVENT.imageContentChanged);
            return;
        }

        // Tree move: moveAtPath rejects moving a group into its own subtree.
        let node = resolveLayerPath(frame.layers, fromPath);
        if (!node) return;
        let props = me.getResolvedProps();
        let offset = resolvedOffset(frame.layers, fromPath, props);
        moveAtPath(frame.layers, fromPath, toP);
        // Re-find the moved node to set the active path correctly post-mutation.
        let movedPath = pathOfNode(frame.layers, node);
        preserveLayerPosition(node, movedPath, offset, props);
        me.activateLayer(movedPath || [0]);
        EventBus.trigger(EVENT.imageContentChanged);
    }

    // Move the node at fromPath into the array at parentPath, inserting at `index`
    // expressed in POST-REMOVAL coordinates (i.e. after fromPath has been spliced out).
    // This is the contract resolveDropPath() produces. Returns true if a move happened.
    me.moveLayerToParent = function(fromPath, parentPath, index){
        if (refuseInParam("Moving a layer")) return false;
        let frame = currentFrame();
        if (!Array.isArray(fromPath) || !Array.isArray(parentPath)) return false;
        // Reject moving a group into itself or its own subtree.
        if (parentPath.length >= fromPath.length){
            let inside = true;
            for (let i=0;i<fromPath.length;i++){ if (parentPath[i]!==fromPath[i]){ inside=false; break; } }
            if (inside) return false;
        }
        let node = resolveLayerPath(frame.layers, fromPath);
        if (!node) return false;

        // Resolve the target parent ARRAY by reference now (before removal), so any index
        // shifts from the removal don't invalidate it. `index` is given in post-removal
        // coordinates within this same array.
        let parentArr = parentPath.length === 0
            ? frame.layers
            : (resolveLayerPath(frame.layers, parentPath) || {}).layers;
        if (!parentArr) return false;

        let props = me.getResolvedProps();
        let offset = resolvedOffset(frame.layers, fromPath, props);
        removeAtPath(frame.layers, fromPath);

        if (index < 0) index = 0;
        if (index > parentArr.length) index = parentArr.length;
        parentArr.splice(index, 0, node);

        let movedPath = pathOfNode(frame.layers, node);
        preserveLayerPosition(node, movedPath, offset, props);
        me.activateLayer(movedPath || [0]);
        EventBus.trigger(EVENT.imageContentChanged);
        return true;
    };

    // Depth-first search for the path of a specific node instance in the tree.
    function pathOfNode(nodes, target, prefix){
        prefix = prefix || [];
        for (let i=0;i<nodes.length;i++){
            let n = nodes[i];
            let path = prefix.concat(i);
            if (n === target) return path;
            if (isGroup(n)){
                let inner = pathOfNode(n.layers, target, path);
                if (inner) return inner;
            }
        }
        return undefined;
    }

    // Appends a content key one frame after the active track's last key. This is what every
    // multi-image importer (GIF/ANIM/icon) calls, so imports land as the migrated shape.
    function addFrame(image){
        let track = activeTrack();
        if (!track) return;
        let layer = Layer(currentFile.width, currentFile.height, "Layer 1");
        let last = track.keys.length ? track.keys[track.keys.length-1].frame : -1;
        insertKey(track, makeContentKey(last + 1, makeCel([layer])));
        if (image) {
            if (image.placeholder){
                layer.placeholder = true;
            }else{
                if (image.width) layer.getContext().drawImage(image, 0, 0);
            }
        }
        clearRenderCache();
        EventBus.trigger(EVENT.imageSizeChanged);
    }

    // DELETEFRAME: remove the key under the playhead on the active track.
    function removeFrame(skipHistory){
        let track = activeTrack();
        if (!track) return;
        if (!keyAt(track, activeFrameIndex)) return;
        if (skipHistory) HistoryService.setEnabled(false);
        me.removeKeyframe(activeFrameIndex);
        if (skipHistory) HistoryService.setEnabled(true);
        me.activateFrame(Math.min(activeFrameIndex, editLength()-1));
        EventBus.trigger(EVENT.imageSizeChanged);
    }

    // Import of a multi-frame image (an animated GIF, an ANIM, an icon with two states):
    // every source frame becomes a content keyframe on a NEW track, laid out one frame apart
    // starting at the playhead. A new track rather than the active one because importing must
    // not overwrite what is already animating there, and starting at the playhead because
    // that is where the user is looking — it is also how you line an import up against
    // existing content.
    //
    // Frames larger than the document keep all of their pixels too (same reasoning as
    // drawFrame): they overhang the canvas rather than being cropped, and the document is not
    // resized under the user.
    function importFramesAsTrack(images,fileName){
        if (refuseInParam("Importing")) return;
        let frames = (images || []).filter(Boolean);
        if (!frames.length) return;
        let start = activeFrameIndex;
        let track = {
            name: uniqueTrackName(fileName),
            visible: true,
            locked: false,
            mask: false,
            keys: frames.map((image,index)=>{
                let layer = Layer(
                    Math.max(currentFile.width, image.width || 0),
                    Math.max(currentFile.height, image.height || 0),
                    (fileName || "Frame") + " " + (index + 1));
                layer.drawImage(image);
                return makeContentKey(start + index, makeCel([layer]));
            })
        };
        HistoryService.start(EVENT.timelineHistory);
        tracks().push(track);
        rememberActiveLayer();
        activeTrackIndex = tracks().length - 1;
        resolveActiveLayer();
        HistoryService.end();
        timelineStructureChanged();
        return track;
    }

    // Import of a single image as a new layer. An image LARGER than the canvas is no longer
    // cropped: the layer is sized to it, so it hangs over the edges and can be moved into view
    // (or the canvas grown around it) instead of losing the pixels at import time. It still
    // lands at 0,0, so what you see is unchanged — only what survives is different.
    function drawFrame(image,fileName){
        let layerIndex = me.addLayer(undefined, fileName, {width: image.width, height: image.height});
        let layer = me.getLayer(layerIndex);
        layer.clear();
        layer.drawImage(image);
        me.activateLayer(layerIndex);
        EventBus.trigger(EVENT.layerContentChanged);
    }

    function stop(){
        if (Palette.isCycling()) EventBus.trigger(COMMAND.CYCLEPALETTE);
    }

    // DUPLICATEFRAME: insert a copy of the current state at playhead+1, shifting every key
    // at or after that position on the SAME track one frame to the right (design 3.4).
    me.duplicateFrame = function(index){
        if (refuseInParam("Duplicate Frame")) return;
        let track = activeTrack();
        if (!track) return;
        if (typeof index !== "number") index = activeFrameIndex;
        let target = index + 1;
        return copyResolvedCel(track, index).then(cel=>{
            HistoryService.start(EVENT.timelineHistory);
            // shift right, highest frame first so no two keys ever collide mid-shift
            track.keys.slice().sort((a,b)=>b.frame-a.frame).forEach(key=>{
                if (key.frame >= target) key.frame++;
            });
            track.keys.sort((a,b)=>a.frame-b.frame);
            insertKey(track, makeContentKey(target, cel));
            HistoryService.end();
            clearRenderCache();
            EventBus.trigger(EVENT.imageSizeChanged);
            me.activateFrame(target);
        });
    };

    // Reposition the key under `fromIndex` on the active track.
    me.moveFrame = (fromIndex,toIndex) => {
        let track = activeTrack();
        if (!track) return;
        let last = track.keys.length ? track.keys[track.keys.length-1].frame : 0;
        if (toIndex < 0) toIndex = 0;
        if (toIndex > last + 1) toIndex = last + 1;
        if (me.moveKeyframe(fromIndex,toIndex)){
            me.activateFrame(Math.min(toIndex, editLength()-1));
        }
    };

    me.mergeDown = function (ref,skipHistory){
        if (refuseInParam("Merge Down")) return;
        let frame = currentFrame();
        let path = typeof ref === "undefined" ? activeLayerPath : toPath(ref);
        if (!path) return;
        let p = parentOf(frame.layers, path);
        if (!p) return;
        // "Down" is the previous sibling in the same parent scope.
        if (p.index <= 0) return; // nothing below in this scope (group-boundary guard)
        let layer = p.parent[p.index];
        let belowLayer = p.parent[p.index - 1];
        // A group can't be merged into (you'd lose its structure); only leaf targets below. The same
        // goes for a clip instance: its pixels belong to its library clip (spec 024).
        if (!layer || !belowLayer || isGroup(belowLayer) || isClip(belowLayer)) return;

        if (!skipHistory) HistoryService.start(EVENT.imageHistory);
        if (!isGroup(layer) && layer.hasMask) {
            layer.removeMask(true);
        }

        // Merging INTO a vector layer can't go through the pixel path below: a vector layer
        // regenerates its raster canvas from its geometry on the next repaint, so anything drawn onto
        // that canvas is discarded (the reported "content disappeared" bug). Two cases:
        //  - both layers are plain vector (top at full opacity, normal blend, no mask): merge the
        //    geometry so the result stays an editable vector layer. The top layer's nodes/edges/
        //    regions are appended AFTER the below layer's, so they keep their on-top z-order, shifted
        //    by the offset difference since geometry is layer-local.
        //  - otherwise the below layer is first rasterized to a plain pixel layer, so the pixels the
        //    merge draws in below actually persist.
        // What the merge has to bake in is what the user SEES, so read the opacity through the
        // resolved property overlay (on a property key or a tween the node's own base value is
        // not what is on screen) — same rule as duplicateLayer.
        let mergedOpacity = effectiveProps(layer, me.getResolvedProps()).opacity;

        let belowIsVector = isVector(belowLayer) && belowLayer.vector;
        let topIsPlainVector = isVector(layer) && layer.vector && !layer.hasMask
            && (mergedOpacity == null || mergedOpacity === 100)
            && (!layer.blendMode || layer.blendMode === "normal");
        if (belowIsVector && topIsPlainVector && !belowLayer.hasMask){
            // ensure the top layer's geometry is complete/up to date before copying it out
            appendVector(belowLayer.vector, layer.vector,
                (layer.x || 0) - (belowLayer.x || 0),
                (layer.y || 0) - (belowLayer.y || 0));
            belowLayer.vectorDirty = true;
            belowLayer.vectorRasterized = false;
            if (belowLayer.markVectorDirty) belowLayer.markVectorDirty();
            p.parent.splice(p.index, 1);
            if (!skipHistory) HistoryService.end();
            let belowPathV = path.slice();
            belowPathV[belowPathV.length-1] = p.index - 1;
            me.activateLayer(belowPathV);
            EventBus.trigger(EVENT.vectorChanged);
            EventBus.trigger(EVENT.layerContentChanged);
            return;
        }
        if (belowIsVector) belowLayer.rasterize(); // bake to pixels so the drawn merge persists

        let blendMode = layer.blendMode || "normal";
        if (blendMode === "normal") blendMode = "source-over";
        // Merging a clip instance DOWN bakes what it shows right now: its composite drawn through
        // the full instance transform into a scope-sized scratch, then into the layer below at the
        // below layer's on-screen offset (R15).
        if (isClip(layer)){
            let props = me.getResolvedProps();
            let eff = effectiveProps(layer, props);
            let scratch = document.createElement("canvas");
            scratch.width = currentFile.width;
            scratch.height = currentFile.height;
            let solo = Object.assign({}, props, {[layer.id]: Object.assign({}, eff, {opacity: 100})});
            let savedBlend = layer.blendMode;
            layer.blendMode = "normal"; // opacity + blend go with the draw below, like any leaf
            compositeNodes([layer], scratch.getContext("2d"), solo);
            layer.blendMode = savedBlend;
            let below = effectiveProps(belowLayer, props);
            belowLayer.drawImage(scratch, -below.x, -below.y,
                {alpha: (typeof mergedOpacity === "number" ? mergedOpacity : 100) / 100, blendMode: blendMode});
            releaseCanvas(scratch);
            p.parent.splice(p.index, 1);
            if (!skipHistory) HistoryService.end();
            let belowPathC = path.slice();
            belowPathC[belowPathC.length-1] = p.index - 1;
            me.activateLayer(belowPathC);
            EventBus.trigger(EVENT.layerContentChanged);
            EventBus.trigger(EVENT.libraryChanged);
            return;
        }
        // render() returns unshifted content, so draw it at the offset DIFFERENCE: the result
        // must land where the merged layer showed it, expressed in belowLayer's local space.
        // The opacity/blend mode go WITH the draw call (see Layer.drawImage): setting them on
        // the context here would be wiped by the canvas resize this draw can trigger.
        belowLayer.drawImage(layer.render(),
            (layer.x || 0) - (belowLayer.x || 0) + (layer.canvasX || 0),
            (layer.y || 0) - (belowLayer.y || 0) + (layer.canvasY || 0), // render() composites a group; returns canvas for a leaf
            {alpha: (typeof mergedOpacity === "number" ? mergedOpacity : 100) / 100, blendMode: blendMode});
        p.parent.splice(p.index, 1);
        if (!skipHistory) HistoryService.end();
        let belowPath = path.slice();
        belowPath[belowPath.length-1] = p.index - 1;
        me.activateLayer(belowPath);
        EventBus.trigger(EVENT.layerContentChanged);
    };

    me.paste = function(image){
        let w = ImageFile.getCurrentFile().width;
        let h = ImageFile.getCurrentFile().height;

        function doPaste() {
            // check if a mask is active on the current layer
            let layer = me.getActiveLayer();
            if (layer.hasMask && layer.isMaskActive()) {
               console.log("Pasting into mask");
            }else{
                let index = me.addLayer();
                me.activateLayer(index);
            }

            me.getActiveLayer().drawImage(image, 0, 0);
            EventBus.trigger(EVENT.layerContentChanged);
        }

        if (image && (image.width > w || image.height > h)) {
            Modal.show(DIALOG.OPTION, {
                title: "Paste Image",
                width: 320,
                text: "The image you are pasting is larger than the current canvas. What do you want to do?",
                buttons: [
                    {
                        label: "Keep the canvas at " + w + "x" + h + " pixels",
                        onclick: doPaste,
                    },
                    {
                        label:
                            "Enlarge the canvas to " +
                            image.width +
                            "x" +
                            image.height +
                            " pixels",
                        onclick: () => {
                            me.resize({
                                width: image.width,
                                height: image.height,
                            });
                            doPaste();
                        },
                    },
                    { label: "Cancel" },
                ],
            });
        } else {
            doPaste();
        }
    };

    // ── frame ⇄ layer conversions (design 3.4) ────────────────────────────────────

    // Every timeline frame becomes a layer of a single content key. Baked, so tweens and
    // multi-track z-order are flattened into the layer stack in the order they played.
    function refuseInsideClip(what){
        if (!editStack.length) return false;
        Modal.softAlert(what + " works on the document timeline: leave the clip first.", what);
        return true;
    }

    me.framesToLayers = function(){
        if (refuseInsideClip("Frames to Layers")) return;
        let canvases = me.getBakedFrames().map(canvas=>duplicateCanvas(canvas,true));
        if (!canvases.length) return;
        HistoryService.start(EVENT.imageHistory);
        resetLayerIds();
        let layers = canvases.map((canvas,index)=>{
            let layer = Layer(currentFile.width, currentFile.height, "Frame " + (index+1));
            layer.drawImage(canvas);
            releaseCanvas(canvas);
            return layer;
        });
        currentFile.timeline = makeTimeline([makeCel(layers)], me.getFps());
        activeTrackIndex = 0;
        activeFrameIndex = 0;
        resolveActiveLayer();
        HistoryService.end();
        timelineStructureChanged();
    };

    // Every layer of the active track's governing cel becomes its own content key on that
    // track, one frame apart. Existing keys on the track are replaced.
    me.layersToFrames = function(){
        if (refuseInsideClip("Layers to Frames")) return;
        let track = activeTrack();
        let cel = currentFrame();
        if (!track || !cel || cel.layers.length < 2) return;
        HistoryService.start(EVENT.imageHistory);
        let layers = cel.layers.slice();
        track.keys = layers.map((layer,index)=>makeContentKey(index, makeCel([layer])));
        activeFrameIndex = 0;
        resolveActiveLayer();
        HistoryService.end();
        timelineStructureChanged();
    };

    // ── convert a track's animation to frame-by-frame ─────────────────────────────

    // The resolved composite of ONE track at `frame`, in isolation: no other tracks and no
    // masking from the track above (masking is a relation *between* tracks and survives the
    // conversion untouched). Returns an empty document-sized canvas when the track resolves
    // to nothing there, so a baked track ends up with a cel on every frame either way.
    function compositeTrackCanvas(track,frame){
        let canvas = document.createElement("canvas");
        canvas.width = currentFile.width;
        canvas.height = currentFile.height;
        let state = resolveTrackState(track, frame, library());
        if (state){
            let options = me.getCompositeOptions();
            options = trackOptionsFor(options, state);
            compositeNodes(state.cel.layers, canvas.getContext("2d"), state.props, options);
        }
        return canvas;
    }

    // True when baking would actually change something: a track is already frame-by-frame
    // when every frame carries a content key holding one unshifted, fully opaque leaf.
    // The frame window a convert covers: the whole timeline, or the `from`..`to` range the
    // caller asked for, clamped into it.
    function convertRange(options){
        let last = editLength() - 1;
        let from = options && typeof options.from === "number" ? options.from : 0;
        let to = options && typeof options.to === "number" ? options.to : last;
        from = Math.max(0, Math.min(from, last));
        to = Math.max(from, Math.min(to, last));
        return {from: from, to: to, whole: from === 0 && to === last};
    }

    me.canConvertTrackToFrames = function(trackIndex,options){
        let track = tracks()[typeof trackIndex === "number" ? trackIndex : activeTrackIndex];
        if (!track) return false;
        let range = convertRange(options);
        for (let frame = range.from; frame <= range.to; frame++){
            let key = keyAt(track, frame);
            if (!key || key.type !== "content") return true;
            let layers = (key.cel && key.cel.layers) || [];
            if (layers.length !== 1) return true;
            let node = layers[0];
            if (isGroup(node) || node.x || node.y || node.opacity !== 100) return true;
        }
        return false;
    };

    // Property keys that a convert over `range` would leave unable to reach their layers. A
    // property key addresses its governing content key's layers BY ID, so once a baked cel
    // (with fresh ids) becomes its governor, its props match nothing and the frame resolves to
    // the baked state — the key survives but stops animating.
    //
    // They are deliberately NOT removed. Removing one that happens to be the track's last key
    // would shorten the timeline, i.e. baking two frames would silently truncate the animation
    // — much worse than leaving an inert key the user can see and delete. Reported instead, so
    // the confirm dialog can say what will happen.
    //
    // Detected by comparing governance before and after rather than by reasoning about frame
    // numbers, the same way timelineUtils.moveKey guards its own moves.
    function orphanedByConvert(track,range,bakedKeys){
        let keys = track.keys || [];
        let survivors = keys.filter(key=>key.frame < range.from || key.frame > range.to);
        let before = {keys: keys};
        let after = {keys: survivors.concat(bakedKeys).sort((a,b)=>a.frame-b.frame)};
        return survivors.filter(key=>key.type === "property"
            && governingContentKey(before, key.frame) !== governingContentKey(after, key.frame));
    }

    // Bakes a track's animation into a frame-by-frame one: every frame of the timeline gets
    // its own content key holding a SINGLE flattened canvas of whatever that track shows
    // there — empty before the track's first key, held/tweened states materialised as real
    // pixels. Holds, tweens, property keys and the layer stack are flattened away (that is
    // the point), so it is one imageHistory step and the confirm lives in the UI.
    // What a convert over `options` would do, so the UI can describe it before committing.
    me.getConvertToFramesPlan = function(trackIndex,options){
        let index = typeof trackIndex === "number" ? trackIndex : activeTrackIndex;
        let track = tracks()[index];
        if (!track) return {canApply: false};
        let range = convertRange(options);
        // frame numbers only, so this stays cheap enough to call from a context menu
        let bakedKeys = [];
        for (let frame = range.from; frame <= range.to; frame++){
            bakedKeys.push({frame: frame, type: "content"});
        }
        return {
            canApply: me.canConvertTrackToFrames(index, options),
            from: range.from,
            to: range.to,
            frameCount: range.to - range.from + 1,
            whole: range.whole,
            orphanedCount: orphanedByConvert(track, range, bakedKeys).length,
            trackName: track.name
        };
    };

    // `options.from` / `options.to` limit the bake to that frame range (a multi-frame timeline
    // selection); without them the whole timeline is baked. Keys outside the range are left
    // alone, apart from the property keys the bake would orphan (see orphanedByConvert).
    me.convertTrackToFrames = function(trackIndex,options){
        if (refuseInParam("Convert to Frames")) return false;
        let index = typeof trackIndex === "number" ? trackIndex : activeTrackIndex;
        let track = tracks()[index];
        if (!track) return false;
        let range = convertRange(options);
        // render everything up front: compositing reads the cels we are about to replace
        let canvases = [];
        for (let frame = range.from; frame <= range.to; frame++){
            canvases.push(compositeTrackCanvas(track, frame));
        }

        // The baked frames are ONE layer continued over time: one lineage id (spec 025 R1).
        let lineage;
        let baked = canvases.map((canvas,offset)=>{
            let frame = range.from + offset;
            let layer = Layer(currentFile.width, currentFile.height, "Frame " + (frame+1));
            if (lineage) layer.id = lineage; else lineage = layer.id;
            layer.drawImage(canvas);
            releaseCanvas(canvas);
            return makeContentKey(frame, makeCel([layer]));
        });

        HistoryService.start(EVENT.imageHistory);
        // Everything outside the range is kept, orphaned property keys included — see
        // orphanedByConvert for why they are reported rather than removed.
        let kept = (track.keys || []).filter(key=>key.frame < range.from || key.frame > range.to);
        track.keys = kept.concat(baked).sort((a,b)=>a.frame-b.frame);
        if (activeFrameIndex >= editLength()) activeFrameIndex = editLength() - 1;
        resolveActiveLayer();
        HistoryService.end();
        timelineStructureChanged();
        return true;
    };

    // Stacks the active cel's layers vertically into one taller layer (a sprite sheet).
    // The new layer's canvas is created at the new document size, so nothing is clipped.
    me.layersToSheet = function(){
        if (refuseInsideClip("Layers to Sheet")) return;
        let cel = currentFrame();
        if (!cel || cel.layers.length < 2) return;
        HistoryService.start(EVENT.imageHistory);
        let w = currentFile.width;
        let h = currentFile.height;
        let sources = cel.layers.map(node=>({
            canvas: duplicateCanvas(node.render(), true),
            x: node.x || 0,
            y: node.y || 0
        }));
        let newH = h * sources.length;
        let sheet = Layer(w, newH, cel.layers[0].name);
        let ctx = sheet.getContext();
        ctx.imageSmoothingEnabled = false;
        sources.forEach((source,i)=>{
            ctx.drawImage(source.canvas, source.x, source.y + i * h);
            releaseCanvas(source.canvas);
        });
        let removedIds = [];
        cel.layers.forEach(node=>collectIds(node,removedIds));
        prunePropsForIds(removedIds);
        cel.layers = [sheet];
        cel.activeLayerIndex = 0;
        currentFile.height = newH;
        resolveActiveLayer();
        HistoryService.end();
        clearRenderCache();
        EventBus.trigger(EVENT.imageSizeChanged);
        EventBus.trigger(EVENT.layersChanged);
    };

    // Rotates every layer of every cel 90° and swaps the document dimensions.
    // TODO offsets are left untouched: rotating an offset layer around the document centre
    // needs a per-node transform. They are 0 for everything that predates spec 004.
    me.rotate = function(){
        HistoryService.start(EVENT.imageHistory);
        forEachCel(cel=>{
            (function walk(nodes){
                nodes.forEach(node=>{
                    if (isGroup(node)){
                        if (node.invalidateCache) node.invalidateCache();
                        walk(node.layers || []);
                    }else if (!isClip(node)){
                        // (a clip instance has no pixels: its clip's own cels rotate via forEachCel)
                        ImageProcessing.rotate(node.getCanvas());
                    }
                });
            })(cel.layers);
        });
        let w = currentFile.width;
        currentFile.width = currentFile.height;
        currentFile.height = w;
        HistoryService.end();
        clearClipCache();
        clearRenderCache();
        EventBus.trigger(EVENT.imageSizeChanged);
    };

    me.addRange = function(){
        currentFile.colorRange = currentFile.colorRange || [];
        currentFile.colorRange.push({
            active: true,
            high:1,
            low:0,
            fps:10
        });
        EventBus.trigger(EVENT.colorRangesChanged);
    }

    // `transparentIndex` is the palette slot fully transparent pixels get. Formats that can
    // declare transparency (GIF, PNG8) pass the slot they reserved; everything else leaves it
    // out and transparent areas land on index 0.
    me.generateIndexedPixels = function(frameIndex,oneDimensional,transparentIndex){
        console.log("generate indexed pixels for frame " + frameIndex);
        let now = performance.now();
        let ctx = me.getCanvas(frameIndex).getContext("2d");
        let colors = Palette.get();

        let indexed = indexPixelsToPalette(ctx,colors,oneDimensional,transparentIndex);

        currentFile.indexedPixels = indexed.pixels;
        let time = performance.now() - now;
        console.log("Indexed pixels generated in " + time + "ms");
        if (indexed.notFoundCount){
            console.warn("Indexed pixels: " + indexed.notFoundCount + " colors not found in palette");
        }
        return currentFile.indexedPixels;

    }


    EventBus.on(COMMAND.NEW, function(){
        stop();
        setCurrentFileHandle();
        newFile();
    });

    EventBus.on(COMMAND.SAVE, function(){
        me.save();
    });

    EventBus.on(COMMAND.SAVEAS, function(){
        if (hasLocalFileHandle()) me.saveAs();
    });

    EventBus.on(COMMAND.RESIZE, function(){
        me.resize();
    });

    EventBus.on(COMMAND.RESAMPLE, function(){
        me.resample();
    });

    EventBus.on(COMMAND.INFO, function(){
        NativePanels.showInfo(currentFile);
    });

    // ── clip commands (spec 024) ──
    // NEWCLIP: an empty clip in the library (placed nowhere yet). CONVERTTOCLIP: the payload
    // selection ({layerPaths} | {trackIndices}), else the Layer panel's multi-selection, else the
    // active layer. PLACECLIP: payload {clipId, at?}. BREAKAPART: payload path (default active).
    EventBus.on(COMMAND.NEWCLIP, function(name){
        let clip = me.createClip(typeof name === "string" ? name : "Clip");
        PanelManager.reveal("library", true);
        return clip;
    });
    EventBus.on(COMMAND.CONVERTTOCLIP, function(sel){
        if (!sel || (!sel.layerPaths && !sel.trackIndices)) sel = {layerPaths: [activeLayerPath.slice()]};
        me.convertToClip(sel);
    });
    EventBus.on(COMMAND.PLACECLIP, function(data){
        if (!data || !data.clipId) return;
        me.placeClip(data.clipId, data.at);
    });
    EventBus.on(COMMAND.BREAKAPART, function(path){
        me.breakApart(Array.isArray(path) && path.length ? path : undefined);
    });
    EventBus.on(COMMAND.FLATTENCLIPTOIMAGE, function(path){
        me.flattenClipToImage(Array.isArray(path) && path.length ? path : undefined);
    });
    // EDITCLIP: payload path of an instance (default: the active layer). EXITCLIP: payload depth
    // to leave to (breadcrumb; default: one level up).
    EventBus.on(COMMAND.EDITCLIP, function(path){
        me.enterClip(Array.isArray(path) && path.length ? path : undefined,{mode:"in-place"});
    });
    EventBus.on(COMMAND.EDITCLIPONLY, function(payload){
        if (payload?.clipId) me.editClipDefinition(payload.clipId);
        else me.enterClip(Array.isArray(payload) && payload.length ? payload : undefined,{mode:"clip"});
    });
    EventBus.on(COMMAND.EXITCLIP, function(depth){
        if (typeof depth === "number") me.exitToDepth(depth);
        else me.exitClip();
    });

    EventBus.on(COMMAND.NEWLAYER, function(){
        PanelManager.showContainer("left");
        let newIndex = addLayer(activeLayerIndex+1);
        HistoryService.add(EVENT.layerPropertyHistory,{
            index:-1,
            currentIndex:activeLayerIndex
        },{
            index:newIndex
        });
    });

    EventBus.on(COMMAND.DELETELAYER, function(){
        HistoryService.start(EVENT.imageHistory);
        removeLayer();
        HistoryService.end();
    });

    EventBus.on(COMMAND.DUPLICATELAYER, function(){
        HistoryService.start(EVENT.imageHistory);
        let result = me.duplicateLayer();
        // group duplication is async (deep clone/restore); end history once it completes
        if (result && typeof result.then === "function"){
            result.then(()=>HistoryService.end());
        }else{
            HistoryService.end();
        }
    });

    EventBus.on(COMMAND.NEWGROUP, function(){
        PanelManager.showContainer("left");
        HistoryService.start(EVENT.imageHistory);
        let atPath = activeLayerPath && activeLayerPath.length ? activeLayerPath.slice() : undefined;
        if (atPath) atPath[atPath.length-1] = atPath[atPath.length-1] + 1;
        me.addGroup(undefined, atPath);
        HistoryService.end();
    });

    EventBus.on(COMMAND.NEWBONELAYER, function(){
        PanelManager.showContainer("left");
        HistoryService.start(EVENT.imageHistory);
        let atPath = activeLayerPath && activeLayerPath.length ? activeLayerPath.slice() : undefined;
        if (atPath) atPath[atPath.length-1] = atPath[atPath.length-1] + 1;
        me.addBoneLayer(undefined, atPath);
        HistoryService.end();
    });

    EventBus.on(COMMAND.NEWVECTORLAYER, function(){
        PanelManager.showContainer("left");
        HistoryService.start(EVENT.imageHistory);
        let atPath = activeLayerPath && activeLayerPath.length ? activeLayerPath.slice() : undefined;
        if (atPath) atPath[atPath.length-1] = atPath[atPath.length-1] + 1;
        me.addVectorLayer(undefined, atPath);
        HistoryService.end();
    });

    EventBus.on(COMMAND.RASTERIZELAYER, function(path){
        HistoryService.start(EVENT.imageHistory);
        me.rasterizeLayer(path && path.length ? path : activeLayerPath);
        HistoryService.end();
    });

    EventBus.on(COMMAND.COMBINEVECTORLAYERS, function(options){
        if (!options || !options.pathA || !options.pathB || !options.mode) return;
        HistoryService.start(EVENT.imageHistory);
        let changed = me.combineVectorLayers(options.pathA, options.pathB, options.mode);
        if (changed){
            HistoryService.end();
        }else{
            HistoryService.neverMind();
        }
    });

    EventBus.on(COMMAND.GROUPLAYERS, function(paths){
        HistoryService.start(EVENT.imageHistory);
        me.groupLayers(paths || [activeLayerPath]);
        HistoryService.end();
    });

    EventBus.on(COMMAND.UNGROUP, function(path){
        HistoryService.start(EVENT.imageHistory);
        me.ungroupLayers(path || activeLayerPath);
        HistoryService.end();
    });

    EventBus.on(COMMAND.MERGEGROUP, function(path){
        HistoryService.start(EVENT.imageHistory);
        me.mergeGroup(path || activeLayerPath);
        HistoryService.end();
    });

    EventBus.on(COMMAND.REMOVESTRAYPIXELS, function(){
        HistoryService.start(EVENT.layerContentHistory);
        me.removeStrayPixels();
        HistoryService.end();
    });


    EventBus.on(COMMAND.FLIPHORIZONTAL, function(){
        HistoryService.start(EVENT.layerContentHistory);
        me.flipLayer(undefined,true);
        HistoryService.end();
    });
    EventBus.on(COMMAND.FLIPVERTICAL, function(){
        HistoryService.start(EVENT.layerContentHistory);
        me.flipLayer(undefined,false);
        HistoryService.end();
    });

    EventBus.on(COMMAND.LAYERUP, function(index){
        if (typeof index === "undefined") index = activeLayerIndex;
        let fromIndex = index;
        let toIndex = fromIndex + 1;
        moveLayer(fromIndex, toIndex);
    });

    EventBus.on(COMMAND.LAYERDOWN, function(index){
        if (typeof index === "undefined") index = activeLayerIndex;
        let fromIndex = index;
        let toIndex = fromIndex - 1;
        moveLayer(fromIndex, toIndex);
    });

    EventBus.on(COMMAND.MERGEDOWN, function(index){
        HistoryService.start(EVENT.imageHistory);
        me.mergeDown(index);
        HistoryService.end();
    });

    EventBus.on(COMMAND.FLATTEN, function(){
        if (refuseInParam("Flatten")) return;
        HistoryService.start(EVENT.imageHistory);
        currentFrame().layers.forEach((layer) => {
            if (layer.hasMask) {
                layer.removeMask(true);
                EventBus.trigger(EVENT.layersChanged);
            }
        });

        let cel = currentFrame();
        if (cel.layers.length > 1) {
            // The composite is already in DOCUMENT space, so it goes onto a FRESH, document-sized,
            // document-aligned plain pixel layer. Re-using the top node (what this used to do) went
            // wrong three ways:
            //  - its canvas origin displaced the whole flattened image by that origin: drawImage
            //    maps layer-local → canvas pixels, and zeroing canvasX/canvasY afterwards does not
            //    move the pixels back;
            //  - a group / vector / bone node throws the drawn pixels away again (a group
            //    re-composites its children, a vector layer regenerates its raster from its
            //    geometry, a bone layer paints nothing of its own), so the flatten did nothing
            //    visible while every layer below it was already gone;
            //  - keeping its id kept every property key targeting it, which re-offset (or faded)
            //    the flattened image on that frame.
            let canvas = me.getCanvas();
            let name = cel.layers[cel.layers.length - 1].name;
            let removedIds = [];
            cel.layers.forEach(node=>collectIds(node,removedIds));
            let flat = Layer(currentFile.width, currentFile.height, name);
            flat.drawImage(canvas, 0, 0);
            cel.layers.length = 0;
            cel.layers.push(flat);
            prunePropsForIds(removedIds);
            me.activateLayer(0);
            EventBus.trigger(EVENT.imageContentChanged);
        }
        HistoryService.end();
    });

    // ── frame commands, remapped onto the active track (design 3.4) ────────────────

    EventBus.on(COMMAND.ADDFRAME, function(){
        if (refuseInParam("Content keys")) return;
        HistoryService.start(EVENT.timelineHistory);
        PanelManager.showContainer("left");
        addFrame();
        HistoryService.end();
        timelineStructureChanged();
    });

    EventBus.on(COMMAND.DELETEFRAME, function(){
        removeFrame();
    });

    EventBus.on(COMMAND.CLEARFRAME, function(){
        if (refuseInParam("Clear Frame")) return;
        HistoryService.start(EVENT.imageHistory)
        // clear all layers of the governing cel except the first one
        let cel = currentFrame();
        if (!cel) return;
        let len = cel.layers.length;
        if (len>1){
            let removedIds = [];
            cel.layers.slice(0,len-1).forEach(node=>collectIds(node,removedIds));
            cel.layers.splice(0,len-1);
            prunePropsForIds(removedIds);
        }
        let layer = cel.layers[0];
        if (layer) {
            layer.clear();
            layer.name = "Layer 1";
            layer.x = 0;
            layer.y = 0;
        }
        activeLayerIndex = 0;
        activeLayerPath = [0];
        activeLayer = cel.layers[0];

        HistoryService.end();
        clearRenderCache();
        EventBus.trigger(EVENT.layersChanged);
        EventBus.trigger(EVENT.imageSizeChanged);
    });

    EventBus.on(COMMAND.DUPLICATEFRAME, function(){
        me.duplicateFrame();
    });

    EventBus.on(COMMAND.FRAMEMOVETOEND, function(){
        let track = activeTrack();
        if (!track || !track.keys.length) return;
        let last = track.keys[track.keys.length-1].frame;
        if (activeFrameIndex >= last) return;
        me.moveFrame(activeFrameIndex,last + 1);
        EventBus.trigger(EVENT.imageSizeChanged);
    });

    // ── timeline commands ─────────────────────────────────────────────────────────

    EventBus.on(COMMAND.ADDTRACK, function(){
        me.addTrack();
    });

    EventBus.on(COMMAND.REMOVETRACK, function(index){
        me.removeTrack(typeof index === "number" ? index : undefined);
    });

    EventBus.on(COMMAND.TRACKUP, function(index){
        let from = typeof index === "number" ? index : activeTrackIndex;
        me.moveTrack(from, from + 1);
    });

    EventBus.on(COMMAND.TRACKDOWN, function(index){
        let from = typeof index === "number" ? index : activeTrackIndex;
        me.moveTrack(from, from - 1);
    });

    EventBus.on(COMMAND.ADDKEYFRAME, function(frame){
        me.applyTimelineSelection("key", typeof frame === "number" ? frame : undefined);
    });

    EventBus.on(COMMAND.ADDKEYFRAMECOPY, function(frame){
        me.applyTimelineSelection("key", typeof frame === "number" ? frame : undefined,{copy:true});
    });

    EventBus.on(COMMAND.ADDPROPERTYKEYFRAME, function(frame){
        me.applyTimelineSelection("property", typeof frame === "number" ? frame : undefined);
    });

    EventBus.on(COMMAND.REMOVEKEYFRAME, function(frame){
        me.applyTimelineSelection("remove", typeof frame === "number" ? frame : undefined);
    });

    EventBus.on(COMMAND.TOGGLETWEEN, function(frame){
        me.applyTimelineSelection("tween", typeof frame === "number" ? frame : undefined);
    });

    EventBus.on(COMMAND.IMPORTLAYER, function(){
        var input = document.createElement("input");
        input.type = "file";
        input.onchange = function (e) {
            handleUpload(e.target.files, "frame");
        };
        input.click();
    });

    // The per-frame composite cache must die whenever anything it was derived from moves.
    // These handlers are registered at module scope, i.e. before any UI subscribes, so the
    // cache is always empty by the time a redraw handler asks for a frame.
    EventBus.on(EVENT.layerContentChanged, function(options){
        options = options || {};
        if (!options.keepImageCache) cachedImage = undefined;
        clearRenderCache();
        if (activeLayer) activeLayer.update();
        me.render();
        EventBus.trigger(EVENT.imageContentChanged);
    });

    EventBus.on(EVENT.layersChanged, () => {
        cachedImage = undefined;
        clearRenderCache();
        autoSave();
    });

    EventBus.on(EVENT.imageContentChanged, () => {
        clearRenderCache();
        autoSave();
    });

    EventBus.on(EVENT.timelineChanged, () => {
        cachedImage = undefined;
        clearRenderCache();
    });

    EventBus.on(EVENT.imageSizeChanged,()=>{
        clearRenderCache();
        autoSave();
    });

    // A bone pose/rig change deforms sibling pixels at composite time, so the cached frame is
    // stale. (The deformer keeps its own bind/skin caches; this just drops the composite.)
    EventBus.on(EVENT.bonesChanged, () => {
        cachedImage = undefined;
        clearRenderCache();
        me.render();
    });

    EventBus.on(EVENT.historyChanged,()=>{
        autoSave();
    });


    window.getCurrentFile = me.getCurrentFile

    return me;
}();

export default ImageFile;
