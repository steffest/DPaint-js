import EventBus from "../util/eventbus.js";
import {COMMAND, EVENT} from "../enum.js";
import ImageFile from "../image.js";
import {duplicateCanvas} from "../util/canvasUtils.js";
import {cloneVector} from "../util/vectorUtils.js";
import {createPatchRecorder, applyPatches} from "../util/tilePatch.js";

let HistoryService = function(){
    let me = {};

    let maxHistory = 20;
    let history = [];
    let future = [];
    let currentHistory;
    let enabled = true;

    // TODO: maybe add a "framehistory" type to store the current frame instead of the whole image?

    me.setEnabled = function(state){
        enabled = !!state;
        if (!enabled) currentHistory = undefined;
    }

    // True while a start()/end() pair is open. Lets callers that would otherwise record a
    // single-shot add() defer to the surrounding step (e.g. one entry per drag gesture
    // instead of one per pointer move).
    me.isRecording = function(){
        return !!currentHistory;
    }

    me.notifyLayerExpanded = function(layer){
        if (currentHistory && currentHistory.type === EVENT.layerContentHistory && !currentHistory.data.expandedLayerFrom){
            currentHistory.data.expandedLayerFrom = layer.clone();
            currentHistory.data.recorder = undefined;
        }
    }

    me.start = function(type,data){
        if (!enabled) return;
        console.log("start his");
        currentHistory={type,data:{}};
        // Which cel this step belongs to. The playhead (and the active track) may move before
        // undo runs, so a layer step must not resolve its layer through "whatever is active
        // now" — see ImageFile.getLayerInTarget (spec 004 design 3.9).
        currentHistory.data.target = ImageFile.getHistoryTarget();
        let index = ImageFile.getActiveLayerIndex();
        // data may be a flat layer index (number) or a path array (number[]) pointing
        // into nested groups. Honour either so property history targets the right node.
        if (typeof data === "number" || Array.isArray(data)) index = data;

        switch (type){
            case EVENT.layerContentHistory:
                currentHistory.data.layerIndex = index;
                // Spec 016 phase 5: instead of storing two full copies of the layer (a "from"
                // and a "to" canvas), record only the 128×128 tiles that actually change.
                // Capture the whole active layer's before-image now, split into tiles; end()
                // reads it again and keeps just the tiles that differ. readRegion re-fetches the
                // active context each call so a tool that swaps the layer canvas mid-step still
                // diffs the right pixels.
                {
                    let startCtx = ImageFile.getActiveContext();
                    let w = startCtx.canvas.width, h = startCtx.canvas.height;
                    let recorder = createPatchRecorder({
                        width: w, height: h,
                        readRegion: (x,y,rw,rh)=> ImageFile.getActiveContext().getImageData(x,y,rw,rh).data
                    });
                    recorder.beforeWrite({x:0,y:0,width:w,height:h});
                    currentHistory.data.recorder = recorder;
                }
                break;
            case EVENT.layerPropertyHistory:
                currentHistory.data.layerIndex = index;
                currentHistory.data.from = getLayerProperties(index);
                break;
            case EVENT.layerHistory:
                currentHistory.data.layerIndex = index;
                currentHistory.data.from = ImageFile.getActiveLayer().clone();
                break;
            case EVENT.imageHistory:
                currentHistory.data.from = ImageFile.clone();
                // TODO: this also clears all masks and selections
                // and it doesn't hold the current layer so future undo actions wont work ...
                // FIXME
                break;
            case EVENT.vectorHistory:
                // Fine-grained vector-layer step (spec 015): capture ONLY the edited layer's geometry
                // (+ its timeline pose overlays when animating), not the whole document. `data` is the
                // active layer PATH so a grouped vector layer resolves correctly; the target cel lets
                // undo find the right layer after the playhead moved.
                currentHistory.data.layerIndex = index;
                currentHistory.data.from = captureVectorSnapshot(currentHistory.data.target, index);
                break;
            case EVENT.vectorGroupHistory:
                // Spec 018: a multi-layer vector gesture (move/delete spanning several sibling
                // layers) as ONE undo step. `data` is the array of layer paths touched, active layer
                // first — capture each one's own snapshot via the spec 015 per-layer helper.
                currentHistory.data.refs = data;
                currentHistory.data.from = data.map(ref => captureVectorSnapshot(currentHistory.data.target, ref));
                break;
            case EVENT.timelineHistory:
                // Track/key STRUCTURE only. Content-key cels are captured by reference, so
                // this is cheap: key and track operations never touch pixels, and a cel that
                // a step removes stays alive through the snapshot and returns on undo.
                currentHistory.data.from = ImageFile.cloneTimelineStructure();
                break;
            case EVENT.keyPropsHistory:
                // One x/y/opacity edit on one layer, targeted at the key that owns it.
                currentHistory.data.from = ImageFile.getKeyPropsTarget(index);
                break;
            case EVENT.keyPropsGroupHistory:
                // A multi-layer free-transform move (Layer panel multi-select, spec-less follow-up
                // to vectorGroupHistory): `data` is the array of layer paths touched, active layer
                // first — capture each one's own key-props snapshot.
                currentHistory.data.refs = data;
                currentHistory.data.from = data.map(ref => ImageFile.getKeyPropsTarget(ref));
                break;
            default:
                console.error("History type " + type + " not handled");
        }
    }

    me.end=function(){
        if (currentHistory){
            console.log("end his");
            switch (currentHistory.type){
                case EVENT.layerContentHistory:
                    if (currentHistory.data.expandedLayerFrom){
                        let l = ImageFile.getLayerInTarget(currentHistory.data.target, currentHistory.data.layerIndex) || ImageFile.getActiveLayer();
                        currentHistory.data.to = l ? l.clone() : undefined;
                    } else if (currentHistory.data.recorder){
                        // Diff against the before-image and keep only the changed tiles.
                        let result = currentHistory.data.recorder.captureAfter();
                        currentHistory.data.patches = result.patches;
                        currentHistory.data.recorder = undefined;
                    } else {
                        // Fallback: no recorder was set up (should not happen for a start()/end()
                        // pair) — keep the old full-canvas snapshot so undo still works.
                        currentHistory.data.to = duplicateCanvas(ImageFile.getActiveContext().canvas,true);
                    }
                    break;
                case EVENT.layerPropertyHistory:
                    currentHistory.data.to = getLayerProperties(currentHistory.data.layerIndex);
                    break;
                case EVENT.layerHistory:
                    currentHistory.data.to = ImageFile
                        .getLayerInTarget(currentHistory.data.target,currentHistory.data.layerIndex).clone();
                    break;
                case EVENT.imageHistory:
                    currentHistory.data.to = ImageFile.clone();
                    break;
                case EVENT.vectorHistory:
                    currentHistory.data.to = captureVectorSnapshot(currentHistory.data.target, currentHistory.data.layerIndex);
                    break;
                case EVENT.vectorGroupHistory:
                    currentHistory.data.to = currentHistory.data.refs.map(ref =>
                        captureVectorSnapshot(currentHistory.data.target, ref));
                    break;
                case EVENT.timelineHistory:
                    currentHistory.data.to = ImageFile.cloneTimelineStructure();
                    break;
                case EVENT.keyPropsHistory:
                    currentHistory.data.to = ImageFile.getKeyPropsTarget(currentHistory.data.layerIndex);
                    break;
                case EVENT.keyPropsGroupHistory:
                    currentHistory.data.to = currentHistory.data.refs.map(ref => ImageFile.getKeyPropsTarget(ref));
                    break;
            }

            history.unshift(currentHistory);
            if (history.length>maxHistory) history.pop();
            future=[];
            currentHistory = undefined;
            EventBus.trigger(EVENT.historyChanged,[history.length,future.length]);
        }
    }

    me.neverMind = function(){
        currentHistory = undefined;
    }

    me.add = function(type,from,to,layerIndex){
        if (!enabled) return;
        let data = {from,to};
        if (layerIndex !== undefined) data.layerIndex = layerIndex;
        history.unshift({type,data});
        if (history.length>maxHistory) history.pop();
        future=[];
        EventBus.trigger(EVENT.historyChanged,[history.length,future.length]);
    }

    me.clear = function(){
        history = [];
        future = [];
    }

    // ── vector-layer history (spec 015) ─────────────────────────────────────────────────
    // A vector gesture only ever changes one layer's geometry (`layer.vector`) and — when editing on
    // a timeline property key — that layer's pose overlays (`nodes`/`curves`). Snapshot just those,
    // resolved through the step's target cel so undo hits the right layer after the playhead moved.
    // `cloneVector` copies only the node/edge/region maps (no canvases); the overlay clone covers a
    // single layer's active-track property keys — both far cheaper than an `ImageFile.clone()`.
    function captureVectorSnapshot(target, ref){
        let layer = ImageFile.getLayerInTarget(target, ref);
        if (!layer) return null;
        return {
            vector: layer.vector ? cloneVector(layer.vector) : null,
            overlay: ImageFile.cloneVectorOverlayState ? ImageFile.cloneVectorOverlayState(layer) : null
        };
    }
    function applyVectorSnapshot(target, ref, snap){
        if (!snap) return;
        let layer = ImageFile.getLayerInTarget(target, ref);
        if (layer && snap.vector){
            // clone the stored snapshot into the layer so a later edit can't mutate the history entry
            layer.vector = cloneVector(snap.vector);
            layer.vectorDirty = true;
            layer.vectorRasterized = false;
            if (layer.markVectorDirty) layer.markVectorDirty();
        }
        if (snap.overlay && ImageFile.restoreVectorOverlayState) ImageFile.restoreVectorOverlayState(snap.overlay);
        EventBus.trigger(EVENT.vectorChanged);
        EventBus.trigger(EVENT.layerContentChanged);
    }

    // Spec 016 phase 5: put changed tiles back onto a layer. direction "undo" writes each
    // tile's before-image, "redo" writes its after-image. Only the tiles a step actually
    // touched are written; every other pixel is left as-is (it did not change in this step).
    function applyRasterPatches(layer, patches, direction){
        let ctx = layer.getContext();
        applyPatches(patches, direction, (x,y,w,h,buf)=>{
            ctx.putImageData(new ImageData(new Uint8ClampedArray(buf), w, h), x, y);
        });
    }

    function getLayerProperties(index){
        let layer = ImageFile.getLayer(index);
        return {
            name: layer.name,
            visible: layer.visible,
            hasMask: layer.hasMask,
            maskActive: layer.isMaskActive(),
            index: index
        }
    }

    EventBus.on(COMMAND.UNDO,()=>{
        if (history.length){
            let historyStep = history.shift();
            let layer;
            let target;
            switch (historyStep.type){
                case EVENT.layerContentHistory:
                    layer = ImageFile.getLayerInTarget(historyStep.data.target,historyStep.data.layerIndex);
                    if (!layer) break;
                    if (historyStep.data.expandedLayerFrom){
                        layer.restore(historyStep.data.expandedLayerFrom);
                    } else if (historyStep.data.patches){
                        applyRasterPatches(layer, historyStep.data.patches, "undo");
                    } else {
                        layer.clear();
                        layer.drawImage(historyStep.data.from);
                    }
                    EventBus.trigger(EVENT.layerContentChanged);
                    break;
                case EVENT.imageHistory:
                    ImageFile.restore(historyStep.data.from);
                    EventBus.trigger(COMMAND.CLEARSELECTION);
                    break;
                case EVENT.vectorHistory:
                    applyVectorSnapshot(historyStep.data.target, historyStep.data.layerIndex, historyStep.data.from);
                    break;
                case EVENT.vectorGroupHistory:
                    historyStep.data.refs.forEach((ref, i) =>
                        applyVectorSnapshot(historyStep.data.target, ref, historyStep.data.from[i]));
                    break;
                case EVENT.layerPropertyHistory:
                    target = historyStep.data.from;
                    let source = historyStep.data.to;
                    if (target.index<0){
                        // add new layer
                        ImageFile.removeLayer(target.index);
                        ImageFile.activateLayer(target.currentIndex);
                    }else{
                        layer = ImageFile.getLayer(target.index);
                        if (typeof target.name === "string") layer.name = target.name;
                        if (typeof target.visible === "boolean") layer.visible = target.visible;
                        if (source.hasMask && source.maskActive !== target.maskActive) layer.toggleMask();
                        console.error(layer);
                    }
                    EventBus.trigger(EVENT.layersChanged);
                    break;
                case EVENT.layerHistory:
                    layer = ImageFile.getLayerInTarget(historyStep.data.target,historyStep.data.layerIndex);
                    if (!layer) break;
                    layer.restore(historyStep.data.from);
                    EventBus.trigger(EVENT.layerContentChanged);
                    EventBus.trigger(EVENT.layersChanged);
                    break;
                case EVENT.timelineHistory:
                    ImageFile.restoreTimelineStructure(historyStep.data.from);
                    break;
                case EVENT.keyPropsHistory:
                    ImageFile.applyKeyProps(historyStep.data.from);
                    break;
                case EVENT.keyPropsGroupHistory:
                    historyStep.data.from.forEach(record => ImageFile.applyKeyProps(record));
                    break;
                default:
                    console.error("History type " + historyStep.type + " not handled");
            }

            future.unshift(historyStep);
            if (future.length>maxHistory) future.pop();
            EventBus.trigger(EVENT.historyChanged,[history.length,future.length]);

        }
    })

    EventBus.on(COMMAND.REDO,()=>{
        if (future.length){
            let historyStep = future.shift();
            let layer;
            let target;
            let source;
            //console.log(historyStep);
            switch (historyStep.type){
                case EVENT.layerContentHistory:
                    layer = (historyStep.data.layerIndex !== undefined
                        ? ImageFile.getLayerInTarget(historyStep.data.target,historyStep.data.layerIndex)
                        : undefined) || ImageFile.getActiveLayer();
                    if (!layer) break;
                    if (historyStep.data.expandedLayerFrom && historyStep.data.to){
                        layer.restore(historyStep.data.to);
                    } else if (historyStep.data.patches){
                        applyRasterPatches(layer, historyStep.data.patches, "redo");
                    } else {
                        layer.clear();
                        layer.drawImage(historyStep.data.to);
                    }
                    EventBus.trigger(EVENT.layerContentChanged);
                    break;
                case EVENT.imageHistory:
                    ImageFile.restore(historyStep.data.to);
                    EventBus.trigger(COMMAND.CLEARSELECTION);
                    break;
                case EVENT.vectorHistory:
                    applyVectorSnapshot(historyStep.data.target, historyStep.data.layerIndex, historyStep.data.to);
                    break;
                case EVENT.vectorGroupHistory:
                    historyStep.data.refs.forEach((ref, i) =>
                        applyVectorSnapshot(historyStep.data.target, ref, historyStep.data.to[i]));
                    break;
                case EVENT.layerPropertyHistory:
                    target = historyStep.data.to;
                    source = historyStep.data.from;
                    if (source.index<0){
                        ImageFile.activateLayer(source.currentIndex);
                        ImageFile.addLayer(source.currentIndex);
                    }else{
                        layer = ImageFile.getLayer(target.index);
                        if (typeof target.name === "string") layer.name = target.name;
                        if (typeof target.visible === "boolean") layer.visible = target.visible;
                        if (source.hasMask && source.maskActive !== target.maskActive) layer.toggleMask();
                    }
                    EventBus.trigger(EVENT.layersChanged);
                    break;
                case EVENT.layerHistory:
                    layer = ImageFile.getLayerInTarget(historyStep.data.target,historyStep.data.layerIndex);
                    if (!layer) break;
                    layer.restore(historyStep.data.to);
                    EventBus.trigger(EVENT.layerContentChanged);
                    EventBus.trigger(EVENT.layersChanged);
                    break;
                case EVENT.timelineHistory:
                    ImageFile.restoreTimelineStructure(historyStep.data.to);
                    break;
                case EVENT.keyPropsHistory:
                    ImageFile.applyKeyProps(historyStep.data.to);
                    break;
                case EVENT.keyPropsGroupHistory:
                    historyStep.data.to.forEach(record => ImageFile.applyKeyProps(record));
                    break;
                default:
                    console.error("History type " + historyStep.type + " not handled");
            }

            history.unshift(historyStep);
            if (history.length>maxHistory) history.pop();
            EventBus.trigger(EVENT.historyChanged,[history.length,future.length]);
        }
    })

    
    return me;
}()

export default HistoryService;