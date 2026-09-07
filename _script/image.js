import FileDetector from "./fileformats/detect.js";
import AmigaIcon from "./fileformats/amigaIcon.js";
import SVG from "./fileformats/svg.js";
import EventBus from "./util/eventbus.js";
import {COMMAND,EVENT} from "./enum.js";
import Historyservice from "./services/historyservice.js";
import Layer from "./ui/layer.js";
import Modal,{DIALOG} from "./ui/modal.js";
import PanelManager from "./ui/panelManager.js";
import NativePanels from "./ui/nativePanels.js";
import {duplicateCanvas, indexPixelsToPalette, releaseCanvas} from "./util/canvasUtils.js";
import Palette from "./ui/palette.js";
import SaveDialog from "./ui/components/saveDialog.js";
import HistoryService from "./services/historyservice.js";
import ImageProcessing from "./util/imageProcessing.js";
import Brush from "./ui/brush.js";
import storage from "./util/storage.js";
import {DuplicateName} from "./util/textUtils.js";
import Recorder from "./services/recorder.js";
import {createEditService} from "./services/editService.js";
import {runWebGLQuantizer} from "./util/webgl-quantizer.js";
import {compositeNodes, resolveLayerPath, flatIndex, pathFromFlatIndex, isGroup, isBones, isVector, parentOf, removeAtPath, insertAtPath, moveAtPath, isLockedInTree, resolvedOffset, effectiveProps, hasGroupTransform, getOpaqueBounds, groupTransformMatrix, matIdentity, matMultiply, matTranslate, matApply, matInvert} from "./util/layerUtils.js";
import {DISSOLVE_PATTERNS, DEFAULT_DISSOLVE_PATTERN, isDissolvePattern, isDissolveComparison,
    dissolveFollowsOpacity, applyDissolve} from "./util/dissolveUtils.js";
import {getDisplayMode, VECTOR_DISPLAY_MODES, appendVector, emptyVectorData, getVectorSvgShapeSources, poseVector} from "./util/vectorUtils.js";
import {timelineLength, keyAt, previousKey, nextKey, governingContentKey, contentKeys,
    propertyKeysGovernedBy, resolveTrackState, keyState, celBaseState, canInsertPropertyKey,
    canTween, insertKey, removeKey, moveKey, moveKeys} from "./util/timelineUtils.js";
import {createFrameCache, makeFrameKey, RENDER_VARIANT} from "./services/frameCache.js";
import {createExportSnapshot, iterateFrames} from "./services/exportSnapshot.js";

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

    me.getCurrentFile = function(){
        return currentFile;
    };

    // ── timeline model access ─────────────────────────────────────────────────────
    // currentFile.timeline = { fps, tracks:[ {name,visible,locked,keys:[...]} ] }
    // Track index 0 is the BOTTOM of the z-order (same convention as cel.layers).

    function tracks(){
        return (currentFile.timeline && currentFile.timeline.tracks) || [];
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

    function makeContentKey(frame,cel,tween){
        return {frame: frame, type: "content", tween: !!tween, cel: cel || makeCel()};
    }

    function makePropertyKey(frame,props,tween){
        return {frame: frame, type: "property", tween: !!tween, props: props || {}};
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

    // Every cel of every content key of every track, each visited exactly once. Cels are
    // never shared between content keys (property keys only reference them), so there is
    // no double-processing hazard for document-wide operations like resize/resample.
    function forEachCel(callback){
        tracks().forEach((track,trackIndex)=>{
            (track.keys || []).forEach(key=>{
                if (key.type === "content" && key.cel) callback(key.cel, key, track, trackIndex);
            });
        });
    }

    function forEachPropertyKey(callback){
        tracks().forEach((track,trackIndex)=>{
            (track.keys || []).forEach(key=>{
                if (key.type === "property") callback(key, track, trackIndex);
            });
        });
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
            let ctx = me.getActiveContext();
            ctx.clearRect(0, 0, currentFile.width, currentFile.height);
            ctx.drawImage(cachedImage, 0, 0);
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
        // A bone layer is not content — it deforms siblings; never hand it back as the whole frame.
        if (isBones(only)) return false;
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
        let list = tracks();
        if (!list.length) return;
        let f = typeof frameIndex === "number" ? frameIndex : activeFrameIndex;
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
        let compositeOptions = me.getCompositeOptions();
        if (skipVectorDisplay){
            compositeOptions = Object.assign({}, compositeOptions, {skipVectorDisplay: true});
        }
        list.forEach((track,index)=>{
            // A mask track is not content: it only shapes the alpha of the track below it.
            if (track.mask) return;
            if (!track.visible) return;
            let state = resolveTrackState(track, f);
            if (!state) return; // empty cells: this track has no key at or before f yet

            let maskState = resolveMaskFor(list, index, f);
            if (maskState){
                // Composite this track in ISOLATION, punch the mask through it, then draw the
                // result — masking has to happen before the track meets the tracks below it.
                // Side effect: a masked track's own blend modes no longer blend against lower
                // tracks (they blend within the track), which is the same trade-off Photoshop
                // makes for a masked group. The unmasked path below is unchanged.
                let masked = document.createElement("canvas");
                masked.width = currentFile.width;
                masked.height = currentFile.height;
                let maskedCtx = masked.getContext("2d",{willReadFrequently:true});
                compositeNodes(state.cel.layers, maskedCtx, state.props, compositeOptions);
                applyTrackMask(maskedCtx, maskState);
                ctx.drawImage(masked, 0, 0);
                releaseCanvas(masked);
                return;
            }
            compositeNodes(state.cel.layers, ctx, state.props, compositeOptions);
        });
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

    // The resolved state of the mask track sitting directly on top of `index`, or undefined.
    function resolveMaskFor(list, index, f){
        let maskTrack = list[index + 1];
        if (!maskTrack || !maskTrack.mask || maskTrack.visible === false) return undefined;
        return resolveTrackState(maskTrack, f);
    }

    // Punches the mask into `targetCtx`: the mask composite's RED channel becomes alpha, the
    // same rule Layer.update() uses for layer masks, so white keeps pixels and black drops
    // them. Painted-but-black areas conceal; an ENTIRELY unpainted mask cel means "no mask
    // yet" and is skipped, so flagging a track as a mask never blanks the artwork below it
    // before anything has been drawn. Returns true when a mask was actually applied.
    function applyTrackMask(targetCtx, maskState){
        let maskCanvas = document.createElement("canvas");
        maskCanvas.width = currentFile.width;
        maskCanvas.height = currentFile.height;
        let maskCtx = maskCanvas.getContext("2d",{willReadFrequently:true});
        compositeNodes(maskState.cel.layers, maskCtx, maskState.props);

        let image = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
        let data = image.data;
        let hasContent = false;
        for (let i = 0, max = data.length; i < max; i += 4){
            if (data[i + 3]) hasContent = true;
            data[i + 3] = data[i];
        }
        if (!hasContent){
            releaseCanvas(maskCanvas);
            return false;
        }
        maskCtx.putImageData(image, 0, 0);

        targetCtx.globalCompositeOperation = "destination-in";
        targetCtx.drawImage(maskCanvas, 0, 0);
        targetCtx.globalCompositeOperation = "source-over";
        releaseCanvas(maskCanvas);
        return true;
    }

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
    me.getFrameCount = function(){
        return timelineLength(currentFile.timeline);
    };

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
        return (currentFile.timeline && currentFile.timeline.fps) || 12;
    };

    me.setFps = function(value){
        let fps = parseInt(value,10);
        if (isNaN(fps) || fps < 1) return;
        if (!currentFile.timeline) return;
        currentFile.timeline.fps = fps;
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

    // Cached canvases are handed straight to callers, so they must not be released here —
    // dropping the references and letting GC reclaim them is the only safe invalidation.
    function clearRenderCache(){
        // Bump the composite revision BEFORE the cacheHold gate so it advances even during
        // playback (a playhead move is a composite-input change too). This is the single
        // signal the incremental display path uses to detect that its retained surface is stale.
        editService.bumpDocumentRevision("structure");
        if (cacheHold) return;
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
        // A group has no paintable context; tools must no-op (see editor guard).
        if (activeLayer && isGroup(activeLayer)) return undefined;
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
        if (isGroup(activeLayer)) return true;
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
            let lx = Math.floor(local.x);
            let ly = Math.floor(local.y);
            if (lx < 0 || ly < 0 || lx >= c.width || ly >= c.height) return false;
            return cx.getImageData(lx,ly,1,1).data[3] > 0;
        }

        function search(nodes, prefix, m){
            for (let i = nodes.length - 1; i >= 0; i--){
                let node = nodes[i];
                if (!node || !node.visible || !node.opacity) continue;
                let path = prefix.concat(i);
                let effective = effectiveProps(node, props);
                let nodeMatrix = matMultiply(m, matTranslate(effective.x, effective.y));
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

    me.openLocal = function(target){
        stop();
        var input = document.createElement("input");
        input.type = "file";
        input.onchange = function (e) {
            handleUpload(e.target.files, target || "file");
        };
        input.click();
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

    me.save = function(){
        Modal.show(DIALOG.SAVE);
    };

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
        forEachCel(cel=>{
            cel.layers.forEach(node=>{
                node.x = (node.x || 0) + dx;
                node.y = (node.y || 0) + dy;
            });
        });
        forEachPropertyKey(key=>{
            let topLevelIds = new Set();
            let gov = governingContentKey(keyOwnerTrack(key), key.frame);
            ((gov && gov.cel && gov.cel.layers) || []).forEach(node=>{ if (node.id) topLevelIds.add(node.id); });
            Object.keys(key.props || {}).forEach(id=>{
                if (!topLevelIds.has(id)) return;
                let entry = key.props[id];
                if (typeof entry.x === "number") entry.x += dx;
                if (typeof entry.y === "number") entry.y += dy;
            });
        });
    }

    function keyOwnerTrack(key){
        return tracks().find(track=>(track.keys || []).indexOf(key) >= 0);
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
                        }else{
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
        let path = typeof ref === "undefined" ? activeLayerPath : toPath(ref);
        if (!path) return;
        let frame = currentFrame();
        let p = parentOf(frame.layers, path);
        let layer = resolveLayerPath(frame.layers, path) || (path.length===1 ? frame.layers[path[0]] : undefined);
        if (!p || !layer) return;

        let newName = DuplicateName(layer.name, p.parent);

        if (isGroup(layer)){
            // deep-copy the whole subtree via clone/restore (async), like duplicateFrame
            let newLayer = Layer.makeGroup(currentFile.width, currentFile.height, newName);
            let struct = withFreshIds(layer.clone(false));
            struct.name = newName;
            let insertPath = path.slice();
            insertPath[insertPath.length-1] = p.index + 1;
            insertAtPath(frame.layers, insertPath, newLayer);
            me.activateLayer(insertPath);
            // returns a Promise so callers can sequence history capture after the deep copy
            return newLayer.restore(struct).then(()=>{
                EventBus.trigger(EVENT.layerContentChanged);
            });
        }

        if (layer.type === "vector" || layer.type === "bone"){
            // These carry editable geometry/armature instead of pixels: the quick canvas-copy
            // path below would rasterize them into a plain pixel layer, silently dropping the
            // type. Deep-copy the whole struct via clone/restore (async) so the duplicate stays
            // the same kind of layer, exactly like the group branch above.
            let newLayer = Layer(currentFile.width, currentFile.height, newName);
            let struct = withFreshIds(layer.clone(false));
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

        let newLayer = Layer(
            currentFile.width,
            currentFile.height,
            newName
        );
        newLayer.opacity = layer.opacity;
        newLayer.blendMode = layer.blendMode;
        newLayer.locked = layer.locked;
        newLayer.x = layer.x || 0;
        newLayer.y = layer.y || 0;
        newLayer.drawImage(layer.getCanvas());
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
        let identity = m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && !m.e && !m.f;
        if (identity && source.width === currentFile.width && source.height === currentFile.height){
            return source;
        }
        let canvas = document.createElement("canvas");
        canvas.width = currentFile.width;
        canvas.height = currentFile.height;
        let ctx = canvas.getContext("2d",{willReadFrequently:true});
        ctx.imageSmoothingEnabled = false;
        ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
        ctx.drawImage(source, 0, 0);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        return canvas;
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
        let x0 = pix.x[0], y0 = pix.y[0];
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
        let count = me.getFrameCount();
        if (typeof index !== "number" || isNaN(index)) index = 0;
        if (index < 0) index = 0;
        if (index >= count) index = count - 1;
        rememberActiveLayer();
        activeFrameIndex = index;
        cachedImage = undefined;
        resolveActiveLayer();
        holdRenderCache(()=>{
            EventBus.trigger(EVENT.layersChanged);
            EventBus.trigger(EVENT.imageContentChanged);
            EventBus.trigger(EVENT.framesChanged);
        });
    };

    me.nextFrame = function(offset){
        offset = offset || 1;
        let count = me.getFrameCount();
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
    };

    me.activateTrack = function(index){
        if (typeof index !== "number" || index < 0 || index >= tracks().length) return;
        if (index === activeTrackIndex) return;
        rememberActiveLayer();
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
        if (!currentFile.timeline) return;
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
    function remapIds(struct,map){
        if (!struct) return struct;
        if (struct.id){
            let fresh = Layer.nextId();
            map[struct.id] = fresh;
            struct.id = fresh;
        }
        if (Array.isArray(struct.layers)) struct.layers.forEach(child=>remapIds(child,map));
        return struct;
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
        let index = typeof trackIndex === "number" ? trackIndex : activeTrackIndex;
        let source = tracks()[index];
        if (!source) return;

        let idMap = {};
        let pending = [];
        let keys = (source.keys || []).map(key=>{
            if (key.type !== "content"){
                return makePropertyKey(key.frame, clonePlainData(key.props), key.tween);
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
            return makeContentKey(key.frame, cel, key.tween);
        });

        return Promise.all(pending).then(()=>{
            keys.forEach(key=>{
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

    function timelineStructureChanged(){
        clearRenderCache();
        cachedImage = undefined;
        EventBus.trigger(EVENT.timelineChanged);
        EventBus.trigger(EVENT.layersChanged);
        EventBus.trigger(EVENT.imageContentChanged);
        EventBus.trigger(EVENT.framesChanged);
    }

    // ── keyframes ─────────────────────────────────────────────────────────────────

    // A deep copy of what the track currently shows at `frame`: the governing cel's layer
    // tree with the RESOLVED (possibly tweened) values baked into the copies' base
    // x/y/opacity, and fresh layer ids so the copy is an independent node set.
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
            let struct = withFreshIds(node.clone(false));
            // bake the resolved overlay into the copy's own base values
            let resolvedValues = state.props && state.props[node.id];
            if (resolvedValues){
                struct.x = resolvedValues.x;
                struct.y = resolvedValues.y;
                struct.opacity = resolvedValues.opacity;
            }
            cel.layers.push(copy);
            pending.push(copy.restore(struct));
        });
        return Promise.all(pending).then(()=>cel);
    }

    // Content key on the active track. Returns a Promise when `copy` is set (the deep copy
    // of the cel is asynchronous), so callers can sequence history around it.
    me.addKeyframe = function(frame,options){
        options = options || {};
        let track = activeTrack();
        if (!track) return;
        if (typeof frame !== "number") frame = activeFrameIndex;
        if (frame < 0) return;

        let finish = (cel)=>{
            HistoryService.start(EVENT.timelineHistory);
            insertKey(track, makeContentKey(frame, cel));
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

    // Property key on the active track. Its initial props are the resolved state at `frame`,
    // so inserting one mid-tween freezes exactly what you see.
    me.addPropertyKeyframe = function(frame){
        let track = activeTrack();
        if (!track) return false;
        if (typeof frame !== "number") frame = activeFrameIndex;
        if (!canInsertPropertyKey(track, frame)) return false;
        let state = resolveTrackState(track, frame);
        if (!state) return false;
        HistoryService.start(EVENT.timelineHistory);
        insertKey(track, makePropertyKey(frame, clonePlainData(state.props)));
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
        if (activeFrameIndex >= me.getFrameCount()) activeFrameIndex = me.getFrameCount() - 1;
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
        if (activeFrameIndex >= me.getFrameCount()) activeFrameIndex = me.getFrameCount() - 1;
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
        if (activeFrameIndex >= me.getFrameCount()) activeFrameIndex = me.getFrameCount() - 1;
        resolveActiveLayer();
        timelineStructureChanged();
        return true;
    };

    me.setKeyTween = function(frame,state){
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

        // Coerce first: UI controls hand over strings ("75" from a range input), and an
        // unparsable or absent value must leave that property alone rather than write NaN.
        let nextX = toFiniteNumber(values.x);
        let nextY = toFiniteNumber(values.y);
        let nextOpacity = toFiniteNumber(values.opacity);
        if (typeof nextOpacity === "number") nextOpacity = Math.max(0, Math.min(100, nextOpacity));

        // A group additionally carries a runtime transform (spec 007). scaleX/scaleY/rotation are
        // NOT rounded — they are continuous and animate; only x/y snap to whole pixels.
        let group = isGroup(node);
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
            key.props[node.id] = to;
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
                {trackIndex: tracks().indexOf(track), keyFrame: key.frame, layerId: node.id, values: from},
                {trackIndex: tracks().indexOf(track), keyFrame: key.frame, layerId: node.id, values: to});
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
            frameCount: animated ? me.getFrameCount() : 0,
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
        let count = me.getFrameCount();
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
        // (or a Properties-panel edit) restores scaleX/scaleY/rotation too (spec 007).
        if (isGroup(node)){
            out.scaleX = typeof values.scaleX === "number" ? values.scaleX : (typeof node.scaleX === "number" ? node.scaleX : 1);
            out.scaleY = typeof values.scaleY === "number" ? values.scaleY : (typeof node.scaleY === "number" ? node.scaleY : 1);
            out.rotation = typeof values.rotation === "number" ? values.rotation : (typeof node.rotation === "number" ? node.rotation : 0);
        }
        return {
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

    // Sets the group's "smooth" toggle. Unlike scaleX/scaleY/rotation this is NOT animatable — it
    // is a single timeline-wide setting, so it is written onto the matching group node in EVERY cel
    // of the timeline (a group's id is stable across cels) rather than onto a key/base at the
    // playhead. Modelled on setFps: no per-key history entry; the flag rides along in cel snapshots.
    me.setGroupSmooth = function(ref, value){
        let cel = currentFrame();
        if (!cel) return false;
        let path = typeof ref === "undefined" ? activeLayerPath : toPath(ref);
        if (!path) return false;
        let node = resolveLayerPath(cel.layers, path) || cel.layers[path[0]];
        if (!isGroup(node)) return false;
        let id = node.id;
        let smooth = !!value;
        forEachCel(c=>{
            forEachNode(c.layers, n=>{ if (isGroup(n) && n.id === id) n.smooth = smooth; });
        });
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
                    if (hasGroupTransform(eff)) return; // can't fold a scale/rotation into an offset
                    walk(node.layers || [], props, nx, ny, op);
                    return;
                }
                if (isVector(node) && node.vector && getDisplayMode(node.vector) === "vector"){
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
        let f = typeof frameIndex === "number" ? frameIndex : activeFrameIndex;
        let list = tracks();
        let root = [];
        if (!list || !list.length) return root;
        list.forEach(track=>{
            if (track.mask || !track.visible) return;
            let state = resolveTrackState(track, f);
            if (!state) return;
            walk(state.cel.layers, state.props, root);
        });
        return root;

        function walk(nodes, props, out){
            nodes.forEach(node=>{
                if (!node.visible || isBones(node)) return;
                let eff = effectiveProps(node, props);
                let x = eff.x || 0;
                let y = eff.y || 0;
                let opacity = (typeof eff.opacity === "number" ? eff.opacity : 100) / 100;
                let blend = node.blendMode || "normal";
                if (isGroup(node)){
                    if (hasGroupTransform(eff)){
                        // A scale/rotation can't be reduced to a translate — bake the whole group in
                        // place. compositeNodes applies its transform/offset/opacity/blend, so the op
                        // is a full-document image with neutral placement.
                        let op = rasterNode(node, props);
                        if (op) out.push(op);
                    }else{
                        let children = [];
                        walk(node.layers || [], props, children);
                        if (children.length) out.push({kind:"group", x:x, y:y, opacity:opacity, blend:blend, children:children});
                    }
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

        function rasterNode(node, props){
            let canvas = document.createElement("canvas");
            canvas.width = currentFile.width;
            canvas.height = currentFile.height;
            compositeNodes([node], canvas.getContext("2d"), props);
            return {kind:"image", x:0, y:0, width:canvas.width, height:canvas.height, opacity:1, blend:"normal", dataUrl:canvas.toDataURL("image/png")};
        }
    };

    // ── single-layer SVG round-trip (split-panel "view as code") ───────────────────────
    // The "view as code" view (editpanel.js + components/codeView.js) shows the ACTIVE vector layer
    // as standalone SVG text and writes edits back. Both directions reuse the SVG import/export
    // module (fileformats/svg.js) so the text is exactly the vector<->path mapping used everywhere.

    // Standalone .svg for the active vector layer's GEOMETRY alone (layer offset/opacity/blend are
    // layer properties, not part of the shapes, so they are left at neutral values). Returns null
    // when the active layer is not a vector layer.
    me.getActiveVectorSvg = function(){
        if (!isVector(activeLayer) || !activeLayer.vector) return null;
        let model = [{kind:"vector", x:0, y:0, opacity:1, blend:"normal", vector: activeLayer.vector}];
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
    me.setActiveVectorFromSvg = function(svgText){
        if (!isVector(activeLayer)) return false;
        let parsed;
        try {
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
    me.cloneBoneOverlayState = function(ref){
        let node = resolveBoneLayerNode(ref);
        let track = activeTrack();
        if (!node || !track) return undefined;
        let snap = {layerId: node.id, trackIndex: tracks().indexOf(track), keys: []};
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
        let track = tracks()[snap.trackIndex];
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
        let snap = {layerId: id, trackIndex: tracks().indexOf(track), keys: []};
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
        let track = tracks()[snap.trackIndex];
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
        struct.image.activeLayerIndex = activeLayerIndex;
        struct.image.activeLayerPath = activeLayerPath;
        struct.image.activeFrameIndex = activeFrameIndex;
        struct.image.activeTrackIndex = activeTrackIndex;
        struct.image.nextLayerId = syncNextLayerId();
        struct.errorCount = 0;

        struct.image.timeline = {
            fps: me.getFps(),
            tracks: tracks().map(track=>({
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
                        return {frame: key.frame, type: "content", tween: !!key.tween, cel: cel};
                    }
                    return {frame: key.frame, type: "property", tween: !!key.tween,
                        props: clonePlainData(key.props) || {}};
                })
            }))
        };

        if (currentFile.colorRange) struct.image.colorRange = currentFile.colorRange;
        if (currentFile.meta) struct.image.meta = clonePlainData(currentFile.meta);

        return struct;
    };

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

        currentFile.timeline = {
            fps: source.fps || 12,
            tracks: (source.tracks || []).map(_track=>({
                name: _track.name || "Track 1",
                visible: _track.visible !== false,
                locked: !!_track.locked,
                // absent in v1 documents and in pre-mask v2 documents → plain content track
                mask: !!_track.mask,
                keys: (_track.keys || []).map(_key=>{
                    if (_key.type === "property"){
                        return {frame: _key.frame, type: "property", tween: !!_key.tween,
                            props: clonePlainData(_key.props) || {}};
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
                    return {frame: _key.frame, type: "content", tween: !!_key.tween, cel: cel};
                })
            }))
        };
        if (!currentFile.timeline.tracks.length){
            currentFile.timeline = makeTimeline([makeCel([Layer(currentFile.width,currentFile.height,"Layer 1")])]);
        }
        activeTrackIndex = Math.min(image.activeTrackIndex || 0, currentFile.timeline.tracks.length - 1);
        clearRenderCache();
        syncNextLayerId();

        Promise.all(restorePromises).then(()=>{
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
        });

        if (image.colorRange) currentFile.colorRange = image.colorRange;

        if (data.palette) Palette.set(data.palette);

        if (data.paletteList){
            Palette.setPaletteList(data.paletteList);
            Palette.setPaletteIndex(data.paletteIndex);
        }

    };

    // ── timeline structure history (cheap snapshots) ───────────────────────────────
    // A structure snapshot records tracks/keys/props but references content-key CELS BY
    // REFERENCE — key and track operations never touch pixels, so cloning them would only
    // waste memory. Removed cels stay alive through the snapshot and come back on undo.

    me.cloneTimelineStructure = function(){
        return {
            fps: me.getFps(),
            activeTrackIndex: activeTrackIndex,
            activeFrameIndex: activeFrameIndex,
            tracks: tracks().map(track=>({
                name: track.name,
                visible: track.visible !== false,
                locked: !!track.locked,
                mask: !!track.mask,
                keys: (track.keys || []).map(key=>key.type === "content"
                    ? {frame: key.frame, type: "content", tween: !!key.tween, cel: key.cel}
                    : {frame: key.frame, type: "property", tween: !!key.tween, props: clonePlainData(key.props) || {}})
            }))
        };
    };

    me.restoreTimelineStructure = function(snapshot){
        if (!snapshot || !Array.isArray(snapshot.tracks)) return;
        currentFile.timeline = {
            fps: snapshot.fps || 12,
            tracks: snapshot.tracks.map(track=>({
                name: track.name,
                visible: track.visible !== false,
                locked: !!track.locked,
                mask: !!track.mask,
                keys: track.keys.map(key=>key.type === "content"
                    ? {frame: key.frame, type: "content", tween: !!key.tween, cel: key.cel}
                    : {frame: key.frame, type: "property", tween: !!key.tween, props: clonePlainData(key.props) || {}})
            }))
        };
        activeTrackIndex = Math.min(snapshot.activeTrackIndex || 0, currentFile.timeline.tracks.length - 1);
        activeFrameIndex = Math.min(snapshot.activeFrameIndex || 0, me.getFrameCount() - 1);
        resolveActiveLayer();
        timelineStructureChanged();
    };

    // ── history targeting ─────────────────────────────────────────────────────────
    // A layer history step is recorded against the cel that owned the edit. The playhead and
    // the active track can move before undo runs, so the step carries {trackIndex, keyFrame}
    // and resolves its layer through that instead of through "whatever is active now".

    me.getHistoryTarget = function(){
        let track = activeTrack();
        if (!track) return undefined;
        let gov = governingContentKey(track, activeFrameIndex) || contentKeys(track)[0];
        return {trackIndex: activeTrackIndex, keyFrame: gov ? gov.frame : 0};
    };

    me.getLayerInTarget = function(target,ref){
        if (!target) return me.getLayer(ref);
        let track = tracks()[target.trackIndex];
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
        let track = tracks()[record.trackIndex];
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
            key.props[record.layerId] = entry;
        }else{
            let node = findNodeById(key.cel.layers, record.layerId);
            if (!node) return;
            node.x = v.x;
            node.y = v.y;
            node.opacity = v.opacity;
            if (isGroup(node) && hasTransform){
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

    me.autoSave = function(){
        let data = me.export();
        storage.putFile("autosave",data);
    }
    window.autoSave = me.autoSave;

    me.restoreAutoSave = function(){
        storage.getFile("autosave").then(data=>{
            if (data) me.restore(data);
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

    function handleUpload(files,target){
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
            if (ext === "planes") detectType = true;
            if (ext === "json") isText = true;
            if (ext === "svg") isText = true;

            var reader = new FileReader();
            reader.onload = function(){
                if (detectType) {
                    me.handleBinary(reader.result, file.name, target,true);
                } else if (isText) {
                    if (ext === "svg") {
                        me.importSVG(reader.result, fileName);
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
                        }
                    }
                } else {
                    // load as Image, fallback to detectType if it fails
                    var image = new Image();
                    image.onload = function(){
                        URL.revokeObjectURL(this.src);
                        handleOpenedImage(image,fileName,target)
                    };
                    image.onerror = function(){
                        URL.revokeObjectURL(this.src);
                        detectType = true;
                        reader.readAsArrayBuffer(file);
                    };
                    image.setAttribute("crossOrigin", "");
                    image.src = reader.result;
                }
            };
            if (isText) {
                reader.readAsText(file);
            } else if (detectType) {
                reader.readAsArrayBuffer(file);
            } else {
                reader.readAsDataURL(file);
            }
            SaveDialog.setFile();
        }
    }
    me.handleUpload = handleUpload;

    me.handleBinary = function (data,name,target,stillTryImage){
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
            importPlanes(data,fileName,target);
            return;
        }

        FileDetector.detect(data, name).then((result) => {
            console.log(" FileDetector: ", result);
            if (result) {
                // Opening a multi-frame file asks which frames to take FIRST. Everything
                // below mutates the current document (palette included), so the question has
                // to come before any of it — cancelling then leaves the open file untouched.
                // Icons are excluded: their two "frames" are states, not an animation.
                if (target === "file" && Array.isArray(result.image) && result.image.length > 1
                    && !isIconType(result.type)){
                    Modal.show(DIALOG.FRAMERANGE,{
                        frameCount: result.image.length,
                        fileName: name,
                        onOk: (range)=>openDetected(result,fileName,target,now,
                            result.image.slice(range.from, range.to + 1))
                    });
                    return;
                }
                openDetected(result,fileName,target,now);
            } else {
                if (stillTryImage) {
                    // happens when the file is not coming from a file upload
                    var image = new Image();
                    image.onload = function(){
                        URL.revokeObjectURL(this.src);
                        handleOpenedImage(image,fileName,target);
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
        });
    };

    // Commits a detected file to the document: original type/data/meta, the palette, and then
    // the image itself. Split out of handleBinary so a multi-frame open can put a dialog in
    // front of it without any of this having happened yet. `images` overrides result.image,
    // which is how a frame range is applied.
    function openDetected(result,fileName,target,startTime,images){
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
        handleOpenedImage(images || result.image,fileName,target,meta);

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

    me.handleJSON = function(data,target){
        if (data.type === "dpaint") {

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
                    break;
                case "brush":
                    Brush.import(data);
                    break;
                default:
                    me.restore(data);
            }
        }
        if (data.type === "palette") {
            Palette.set(data.palette);
        }
    }

    function importPlanes(data,fileName,target){
        import("./fileformats/planes.js").then(module=>{
            let PLANES = module.default;
            let guess = PLANES.guess(data.byteLength,currentFile.width,PLANES.getPalettePlaneCount());
            Modal.show(DIALOG.PLANES,{
                buffer: data,
                guess: guess,
                onOk: (options)=>{
                    let canvas = PLANES.toCanvas(data,options);
                    if (!canvas) return;
                    // The palette is not part of the file: the planes are indexed against
                    // whatever palette is loaded, which is exactly how they were exported.
                    currentFile.originalType = "PLANES";
                    currentFile.originalData = undefined;
                    currentFile.meta = undefined;
                    handleOpenedImage(canvas,fileName,target);
                }
            });
        });
    }

    function handleOpenedImage(image,fileName,target,meta){
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

    // Mirrors the allocator into the document so it can be serialized (design 3.5).
    function syncNextLayerId(){
        currentFile.nextLayerId = Layer.peekIdCounter();
        return currentFile.nextLayerId;
    }
    me.getNextLayerId = syncNextLayerId;

    function newFile(image,fileName,type,originalData,meta){
        Historyservice.clear();
        Recorder.clear();
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
            nextLayerId: 1,
            colorRange:[]
        }
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
        addLayer();
        activeLayer = currentFrame().layers[0];
        activeLayer.clear();
        if (image) {
            activeLayer.getContext().drawImage(image, 0, 0);
        }
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
        Recorder.clear();
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
            nextLayerId: 1,
            colorRange:[]
        };
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
    function prunePropsForIds(ids){
        if (!ids.length) return;
        forEachPropertyKey(key=>{
            if (!key.props) return;
            ids.forEach(id=>{ delete key.props[id]; });
        });
    }

    function removeLayer(ref){
        let path = typeof ref === "undefined" ? activeLayerPath : toPath(ref);
        if (!path) return;
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
            parsed = SVG.parse(text);
        } catch (e){
            console.error("SVG import failed:", e);
            Modal.alert("Could not open this SVG file: " + (e && e.message ? e.message : "invalid SVG") + ".");
            return;
        }

        let blank = document.createElement("canvas");
        blank.width = parsed.width;
        blank.height = parsed.height;
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

    function moveLayer(from,to){
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
        moveAtPath(frame.layers, fromPath, toP);
        // Re-find the moved node to set the active path correctly post-mutation.
        me.activateLayer(pathOfNode(frame.layers, node) || [0]);
        EventBus.trigger(EVENT.imageContentChanged);
    }

    // Move the node at fromPath into the array at parentPath, inserting at `index`
    // expressed in POST-REMOVAL coordinates (i.e. after fromPath has been spliced out).
    // This is the contract resolveDropPath() produces. Returns true if a move happened.
    me.moveLayerToParent = function(fromPath, parentPath, index){
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

        removeAtPath(frame.layers, fromPath);

        if (index < 0) index = 0;
        if (index > parentArr.length) index = parentArr.length;
        parentArr.splice(index, 0, node);

        me.activateLayer(pathOfNode(frame.layers, node) || [0]);
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
        me.activateFrame(Math.min(activeFrameIndex, me.getFrameCount()-1));
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
        let layerIndex = me.addLayer(0, fileName, {width: image.width, height: image.height});
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
            me.activateFrame(Math.min(toIndex, me.getFrameCount()-1));
        }
    };

    me.mergeDown = function (ref,skipHistory){
        let frame = currentFrame();
        let path = typeof ref === "undefined" ? activeLayerPath : toPath(ref);
        if (!path) return;
        let p = parentOf(frame.layers, path);
        if (!p) return;
        // "Down" is the previous sibling in the same parent scope.
        if (p.index <= 0) return; // nothing below in this scope (group-boundary guard)
        let layer = p.parent[p.index];
        let belowLayer = p.parent[p.index - 1];
        // A group can't be merged into (you'd lose its structure); only leaf targets below.
        if (!layer || !belowLayer || isGroup(belowLayer)) return;

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
        let belowIsVector = isVector(belowLayer) && belowLayer.vector;
        let topIsPlainVector = isVector(layer) && layer.vector && !layer.hasMask
            && (layer.opacity == null || layer.opacity === 100)
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

        let ctx = belowLayer.getContext();
        ctx.globalAlpha = layer.opacity / 100;
        let blendMode = layer.blendMode || "normal";
        if (blendMode === "normal") blendMode = "source-over";
        ctx.globalCompositeOperation = blendMode;
        // render() returns unshifted content, so draw it at the offset DIFFERENCE: the result
        // must land where the merged layer showed it, expressed in belowLayer's local space.
        belowLayer.drawImage(layer.render(),
            (layer.x || 0) - (belowLayer.x || 0),
            (layer.y || 0) - (belowLayer.y || 0)); // render() composites a group; returns canvas for a leaf
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
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
    me.framesToLayers = function(){
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
        let state = resolveTrackState(track, frame);
        if (state){
            compositeNodes(state.cel.layers, canvas.getContext("2d"), state.props, me.getCompositeOptions());
        }
        return canvas;
    }

    // True when baking would actually change something: a track is already frame-by-frame
    // when every frame carries a content key holding one unshifted, fully opaque leaf.
    // The frame window a convert covers: the whole timeline, or the `from`..`to` range the
    // caller asked for, clamped into it.
    function convertRange(options){
        let last = me.getFrameCount() - 1;
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
        let index = typeof trackIndex === "number" ? trackIndex : activeTrackIndex;
        let track = tracks()[index];
        if (!track) return false;
        let range = convertRange(options);
        // render everything up front: compositing reads the cels we are about to replace
        let canvases = [];
        for (let frame = range.from; frame <= range.to; frame++){
            canvases.push(compositeTrackCanvas(track, frame));
        }

        let baked = canvases.map((canvas,offset)=>{
            let frame = range.from + offset;
            let layer = Layer(currentFile.width, currentFile.height, "Frame " + (frame+1));
            layer.drawImage(canvas);
            releaseCanvas(canvas);
            return makeContentKey(frame, makeCel([layer]));
        });

        HistoryService.start(EVENT.imageHistory);
        // Everything outside the range is kept, orphaned property keys included — see
        // orphanedByConvert for why they are reported rather than removed.
        let kept = (track.keys || []).filter(key=>key.frame < range.from || key.frame > range.to);
        track.keys = kept.concat(baked).sort((a,b)=>a.frame-b.frame);
        if (activeFrameIndex >= me.getFrameCount()) activeFrameIndex = me.getFrameCount() - 1;
        resolveActiveLayer();
        HistoryService.end();
        timelineStructureChanged();
        return true;
    };

    // Stacks the active cel's layers vertically into one taller layer (a sprite sheet).
    // The new layer's canvas is created at the new document size, so nothing is clipped.
    me.layersToSheet = function(){
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
                    }else{
                        ImageProcessing.rotate(node.getCanvas());
                    }
                });
            })(cel.layers);
        });
        let w = currentFile.width;
        currentFile.width = currentFile.height;
        currentFile.height = w;
        HistoryService.end();
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
        newFile();
    });

    EventBus.on(COMMAND.SAVE, function(){
        me.save();
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
        HistoryService.start(EVENT.imageHistory);
        currentFrame().layers.forEach((layer) => {
            if (layer.hasMask) {
                layer.removeMask(true);
                EventBus.trigger(EVENT.layersChanged);
            }
        });

        if (currentFrame().layers.length > 1) {
            let canvas = me.getCanvas();
            currentFrame().layers.splice(0, currentFrame().layers.length - 1);
            let layer = currentFrame().layers[0];
            if (layer) {
                layer.clear();
                layer.drawImage(canvas, 0, 0);
                layer.opacity = 100;
                layer.blendMode = "normal";
                layer.visible = true;
                // the composite is already in document space — drop the offset so it is not
                // applied a second time when the flattened layer is drawn
                layer.x = 0;
                layer.y = 0;
            }
            me.activateLayer(0);
            EventBus.trigger(EVENT.imageContentChanged);
        }
        HistoryService.end();
    });

    // ── frame commands, remapped onto the active track (design 3.4) ────────────────

    EventBus.on(COMMAND.ADDFRAME, function(){
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
        me.addKeyframe(typeof frame === "number" ? frame : undefined);
    });

    EventBus.on(COMMAND.ADDKEYFRAMECOPY, function(frame){
        me.addKeyframe(typeof frame === "number" ? frame : undefined,{copy:true});
    });

    EventBus.on(COMMAND.ADDPROPERTYKEYFRAME, function(frame){
        me.addPropertyKeyframe(typeof frame === "number" ? frame : undefined);
    });

    EventBus.on(COMMAND.REMOVEKEYFRAME, function(frame){
        me.removeKeyframe(typeof frame === "number" ? frame : undefined);
    });

    EventBus.on(COMMAND.TOGGLETWEEN, function(frame){
        me.setKeyTween(typeof frame === "number" ? frame : undefined);
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
