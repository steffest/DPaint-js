import Color from "../util/color.js";
import ToolOptions from "./components/toolOptions.js";
import {duplicateCanvas, indexPixelsToPalette, releaseCanvas} from "../util/canvasUtils.js";
import Brush from "./brush.js";
import HistoryService from "../services/historyservice.js";
import DitherPanel from "./toolPanels/ditherPanel.js";
import historyservice from "../services/historyservice.js";
import Palette from "./palette.js";
import ImageFile from "../image.js";
import EventBus from "../util/eventbus.js";
import {EVENT} from "../enum.js";
import {compositeNodes} from "../util/layerUtils.js";
import {DEFAULT_DISSOLVE_PATTERN} from "../util/dissolveUtils.js";
import {emptyVectorData, cloneVector, rasterizeVector, poseVector} from "../util/vectorUtils.js";

// Monotonic per-file id allocator (spec 004). Every layer node carries a stable `id` so
// timeline property keys can address it across frames. The counter lives here so *every*
// Layer() creation path gets a fresh id automatically; image.js mirrors it into
// currentFile.nextLayerId for serialization and syncs it back on restore.
let idCounter = 1;
function allocateId(){
    return "L" + (idCounter++);
}

let Layer = function(width,height,name){
    let me = {
        id: allocateId(),
        visible:true,
        opacity:100,
        // Base offset of this node's content relative to its parent scope (the document for
        // top-level nodes, the group canvas for children). The layer's own canvas is never
        // shifted; offsets are applied by the parent at composite time (see layerUtils).
        x: 0,
        y: 0,
        canvasX: 0,
        canvasY: 0,
        name: name,
        blendMode: "normal",
        // Which stencil pattern this node's opacity uses while the palette is locked, where
        // transparency is dithered rather than blended (see util/dissolveUtils.js).
        dissolve: DEFAULT_DISSOLVE_PATTERN,
        hasMask: false,
        locked: false,
    }

    let canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    let ctx = canvas.getContext("2d",{willReadFrequently:true});
    //note: willReadFrequently forces the canvas to remain on the CPU instead of the GPU
    // this also "fixes" a bug in Chrome where multiple calls to getImageData() on the same canvas clears the canvas incorrectly

    // group nodes (me.type === "group") composite their children onto this offscreen canvas
    let groupCanvas;
    let groupCtx;

    let mask;
    let maskCtx;
    let maskActive;
    let maskEnabled;
    let alphaLayer;
    let alphaCtx;
    let combined;
    let drawLayer;
    let drawCtx;
    let drawMask;
    let drawMaskCtx;
    let isDrawing;
    let drawOpacity;
    let currentColor;

    me.getCanvas = function(){
        if (me.type === "group") return me.render();
        // A vector layer in "vector" display mode is drawn on screen as live SVG shapes, so its own
        // raster canvas is never populated by the compositor. Anything asking for the pixels (copy,
        // copy/cut-to-layer, duplicate, export helpers) must trigger the raster now, behind the same
        // dirty flag render() uses, so it never reads a blank canvas.
        if (me.type === "vector" && (me.vectorDirty || !me.vectorRasterized)){
            rasterizeVector(me.vector, ctx, canvas.width, canvas.height);
            me.vectorDirty = false;
            me.vectorRasterized = true;
            me._vectorRenderSig = ""; // base geometry is on the canvas now — invalidate any posed cache
        }
        if (maskActive){
            return mask;
        }else{
            return canvas;
        }
    }

    me.getCanvasType = function(maskType){
       return (maskType) ? mask : canvas;
    }

    // Bakes a vector layer's editable geometry into this node's own bitmap canvas and drops all
    // the vector-only state, turning the node into a plain pixel layer. No-op for other types.
    me.rasterize = function(){
        if (me.type !== "vector") return;
        rasterizeVector(me.vector, ctx, canvas.width, canvas.height);
        delete me.type;
        delete me.vector;
        delete me.vectorDirty;
        delete me.vectorRasterized;
        delete me.markVectorDirty;
    }

    me.getContext = function(){
        if (me.type === "group"){
            // read-only: returns the composited group context. Tools must not draw here.
            me.render();
            return groupCtx;
        }
        if (maskActive){
            return maskCtx;
        }else{
            return ctx;
        }
    }

    // render() never applies the node's OWN offset — that is the parent's job at composite
    // time (single place, no double-application). `props` is the timeline property overlay and
    // `options` the compositor options (dissolve + document origin); both are forwarded to the
    // children so a node nested inside a group animates and dissolves like a top-level one.
    me.render = function(props,options){
        if (me.type === "group"){
            if (!groupCanvas){
                groupCanvas = document.createElement("canvas");
                groupCanvas.width = canvas.width;
                groupCanvas.height = canvas.height;
                groupCtx = groupCanvas.getContext("2d",{willReadFrequently:true});
            }
            groupCtx.clearRect(0,0,groupCanvas.width,groupCanvas.height);
            // The group canvas stays document-sized in v1: a child pushed far outside it can
            // clip at the group boundary even when the group itself is offset back inside the
            // document. Accepted v1 limitation, consistent with decision 4 (spec 004).
            compositeNodes(me.layers.filter(c=>c.visible), groupCtx, props, options);
            return groupCanvas;
        }
        // A bone layer paints nothing of its own — it deforms its younger siblings at composite
        // time (see boneDeformer + compositeNodes). Its own canvas stays blank; return it so a
        // stray composite draws nothing.
        if (me.type === "bone"){
            return canvas;
        }
        // A vector layer's real content is geometry (me.vector). Lazily rasterize it into this
        // node's own canvas behind a dirty flag, then return the canvas so compositing, export,
        // palette-indexing, offsets, opacity and blend modes all work exactly like a pixel layer.
        if (me.type === "vector"){
            // A timeline overlay (spec 012) displaces some of this layer's points (`nodes`) and/or
            // bends its edges (`curves`) on this frame; poseVector returns the base document
            // untouched when nothing is displaced or bent, so the static case stays a plain
            // rasterize. Since the SAME Layer instance is composited at different frames (each with a
            // different pose), cache by a signature of the applied pose: re-rasterize when the
            // geometry is dirty OR the pose changed.
            let p = (props && me.id) ? props[me.id] : undefined;
            let pose = p ? p.nodes : undefined;
            let curves = p ? p.curves : undefined;
            let posed = (pose || curves) ? poseVector(me.vector, pose, curves) : me.vector;
            let sig = (posed === me.vector) ? "" : JSON.stringify({n: pose, c: curves});
            if (me.vectorDirty || !me.vectorRasterized || sig !== me._vectorRenderSig){
                rasterizeVector(posed, ctx, canvas.width, canvas.height);
                me.vectorDirty = false;
                me.vectorRasterized = true;
                me._vectorRenderSig = sig;
            }
            return canvas;
        }
        if ((mask && maskEnabled) || isDrawing){
            if (!combined) combined = duplicateCanvas(canvas);
            let combinedCtx = combined.getContext("2d",{willReadFrequently:true});
            combinedCtx.clearRect(0,0,combined.width,combined.height);

            combinedCtx.globalCompositeOperation = "source-over";
            combinedCtx.drawImage(canvas,0,0);


            if (isDrawing && drawLayer){
                if (mask && maskActive){
                    // temporary composite alphaLayer
                    if (!drawMask){
                        drawMask = duplicateCanvas(mask);
                        drawMaskCtx = drawMask.getContext("2d");
                    }
                    drawMaskCtx.clearRect(0 ,0,drawMask.width,drawMask.height);
                    drawMaskCtx.drawImage(mask,0,0);
                    drawMaskCtx.globalAlpha = drawOpacity;
                    drawMaskCtx.drawImage(drawLayer,0,0);
                    drawMaskCtx.globalAlpha = 1;
                    me.update(drawMaskCtx);
                }else{
                    combinedCtx.globalAlpha = drawOpacity;
                    if(currentColor==="transparent"){
                        combinedCtx.globalCompositeOperation = "destination-out";
                    }
                    combinedCtx.drawImage(drawLayer,0,0);
                    combinedCtx.globalCompositeOperation = "source-over";
                    combinedCtx.globalAlpha = 1;
                }
            }


            if (mask){
                if (maskActive && ToolOptions.showMask()){
                    combinedCtx.fillStyle = "red";
                    combinedCtx.globalAlpha = 0.7;
                    combinedCtx.fillRect(0,0,combined.width,combined.height);
                    combinedCtx.globalAlpha = 1;
                }

                combinedCtx.globalCompositeOperation = "destination-in";
                combinedCtx.drawImage(alphaLayer,0,0);
                combinedCtx.globalCompositeOperation = "source-over";
            }

            return combined;
        }else{
            return canvas;
        }
    }
    
    me.clear = function(){
        if (maskActive){
            maskCtx.clearRect(0,0, canvas.width, canvas.height);
        }else{
            ctx.clearRect(0,0, canvas.width, canvas.height);
        }
    }

    me.reset = function(){
        drawLayer = undefined;
        combined = undefined;
        //drawMask = undefined;
        //drawCtx = undefined;
        //drawMaskCtx = undefined;
    }

    // Drops every scratch buffer whose size is tied to the document (the group composite
    // buffer above all). Used after a resample changes the document dimensions without
    // going through resize()/crop().
    me.invalidateCache = function(){
        groupCanvas = undefined;
        groupCtx = undefined;
        combined = undefined;
        drawLayer = undefined;
        drawCtx = undefined;
    }

    // Destructively re-sizes the node's own canvas, moving its content to (x,y).
    // NOTE: since spec 004 the document-level resize/crop are non-destructive (they only
    // change the document size and the node offsets), so nothing in the app calls this any
    // more. Kept as part of the Layer API for callers that really do want to re-sample a
    // layer's own canvas.
    me.ensureLocalRect = function(x,y,w,h){
        if (me.type === "group" || me.type === "bone" || me.type === "vector") return;
        w = typeof w === "number" ? w : 1;
        h = typeof h === "number" ? h : 1;
        let curMinX = me.canvasX || 0;
        let curMinY = me.canvasY || 0;
        let curMaxX = curMinX + canvas.width;
        let curMaxY = curMinY + canvas.height;

        let targetMinX = Math.min(curMinX, x);
        let targetMinY = Math.min(curMinY, y);
        let targetMaxX = Math.max(curMaxX, x + w);
        let targetMaxY = Math.max(curMaxY, y + h);

        let curFile = ImageFile.getCurrentFile ? ImageFile.getCurrentFile() : undefined;
        let off = ImageFile.getLayerOffset ? ImageFile.getLayerOffset() : {x: me.x || 0, y: me.y || 0};
        if (curFile && off){
            let docLocalMinX = -off.x;
            let docLocalMinY = -off.y;
            let docLocalMaxX = curFile.width - off.x;
            let docLocalMaxY = curFile.height - off.y;
            if (targetMinX < curMinX){
                targetMinX = Math.min(targetMinX, docLocalMinX);
            }
            if (targetMinY < curMinY){
                targetMinY = Math.min(targetMinY, docLocalMinY);
            }
            if (targetMaxX > curMaxX){
                targetMaxX = Math.max(targetMaxX, docLocalMaxX);
            }
            if (targetMaxY > curMaxY){
                targetMaxY = Math.max(targetMaxY, docLocalMaxY);
            }
        }

        if (targetMinX >= curMinX && targetMinY >= curMinY && targetMaxX <= curMaxX && targetMaxY <= curMaxY){
            return;
        }

        if (HistoryService.isRecording() && HistoryService.notifyLayerExpanded){
            HistoryService.notifyLayerExpanded(me);
        }

        let newW = Math.ceil(targetMaxX - targetMinX);
        let newH = Math.ceil(targetMaxY - targetMinY);
        let deltaX = curMinX - targetMinX;
        let deltaY = curMinY - targetMinY;

        let d = duplicateCanvas(canvas, true);
        canvas.width = newW;
        canvas.height = newH;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(d, deltaX, deltaY);
        releaseCanvas(d);

        if (mask){
            let m = duplicateCanvas(mask, true);
            mask.width = newW;
            mask.height = newH;
            maskCtx.imageSmoothingEnabled = false;
            maskCtx.drawImage(m, deltaX, deltaY);
            releaseCanvas(m);
        }

        if (alphaLayer){
            let a = duplicateCanvas(alphaLayer, true);
            alphaLayer.width = newW;
            alphaLayer.height = newH;
            alphaCtx.imageSmoothingEnabled = false;
            alphaCtx.drawImage(a, deltaX, deltaY);
            releaseCanvas(a);
        }

        if (drawLayer){
            let dl = duplicateCanvas(drawLayer, true);
            drawLayer.width = newW;
            drawLayer.height = newH;
            drawCtx.imageSmoothingEnabled = false;
            drawCtx.drawImage(dl, deltaX, deltaY);
            releaseCanvas(dl);
        }

        if (drawMask){
            let dm = duplicateCanvas(drawMask, true);
            drawMask.width = newW;
            drawMask.height = newH;
            drawMaskCtx.imageSmoothingEnabled = false;
            drawMaskCtx.drawImage(dm, deltaX, deltaY);
            releaseCanvas(dm);
        }

        if (combined){
            releaseCanvas(combined);
            combined = undefined;
        }

        me.canvasX = targetMinX;
        me.canvasY = targetMinY;
    };

    me.resize = function(width,height,x,y){
        if (me.type === "group"){
            me.layers.forEach(c=>c.resize(width,height,x,y));
            groupCanvas = undefined;
            groupCtx = undefined;
            EventBus.trigger(EVENT.layerContentChanged);
            return;
        }
        let d = duplicateCanvas(canvas, true);
        canvas.width = width;
        canvas.height = height;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(d, x, y);
        releaseCanvas(d);

        if (mask){
            let m = duplicateCanvas(mask, true);
            mask.width = width;
            mask.height = height;
            maskCtx.drawImage(m, x, y);
            releaseCanvas(m);
        }

        if (alphaLayer){
            let a = duplicateCanvas(alphaLayer, true);
            alphaLayer.width = width;
            alphaLayer.height = height;
            alphaCtx.drawImage(a, x, y);
            releaseCanvas(a);
        }

        me.canvasX = 0;
        me.canvasY = 0;
        me.reset();
        EventBus.trigger(EVENT.layerContentChanged);
    }

    // Destructively crops the node's own canvas. See the note on resize() above: the
    // document-level crop is non-destructive and does not go through here.
    me.crop = function(x,y,w,h){
        if (me.type === "group"){
            me.layers.forEach(c=>c.crop(x,y,w,h));
            groupCanvas = undefined;
            groupCtx = undefined;
            EventBus.trigger(EVENT.layerContentChanged);
            return;
        }
        let d = duplicateCanvas(canvas, true);
        canvas.width = w;
        canvas.height = h;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(d, x, y, w, h, 0, 0, w, h);
        releaseCanvas(d);

        if (mask){
            let m = duplicateCanvas(mask, true);
            mask.width = w;
            mask.height = h;
            maskCtx.drawImage(m, x, y, w, h, 0, 0, w, h);
            releaseCanvas(m);
        }

        if (alphaLayer){
            let a = duplicateCanvas(alphaLayer, true);
            alphaLayer.width = w;
            alphaLayer.height = h;
            alphaCtx.drawImage(a, x, y, w, h, 0, 0, w, h);
            releaseCanvas(a);
        }

        me.canvasX = 0;
        me.canvasY = 0;
        me.reset();
        EventBus.trigger(EVENT.layerContentChanged);
    }

    me.drawImage = function(image,x,y){
        x=x||0;y=y||0;
        if (image){
            me.ensureLocalRect(x, y, image.width, image.height);
        }
        let bx = x - (me.canvasX || 0);
        let by = y - (me.canvasY || 0);
        let _ctx = me.getContext();
        _ctx.imageSmoothingEnabled = false;
        _ctx.drawImage(image,bx,by);
        me.update();
    }

    me.draw = function(x,y,color,touchData){
        let brush = Brush.get();
        let bw = brush.width || 1;
        let bh = brush.height || bw;
        let rx = Math.floor((bw - 1) / 2);
        let ry = Math.floor((bh - 1) / 2);

        me.ensureLocalRect(x - rx, y - ry, bw, bh);

        let bx = x - (me.canvasX || 0);
        let by = y - (me.canvasY || 0);

        if (!drawLayer){
            drawLayer=duplicateCanvas(canvas);
            drawCtx = drawLayer.getContext("2d");
        }
        if (!touchData.isDrawing){
            drawOpacity = Palette.isLocked() ? 1 : Brush.getOpacity();
        }
        isDrawing = true;
        currentColor = color;
        let drawColor = color;
        if (color === "transparent"){
            drawColor = "black";
        }

        //Brush.draw(me.getContext(),x,y,color,true);
        let b = Brush.draw(drawCtx,bx,by,drawColor,touchData.button,true,true,!touchData.isDrawing); // TODO: color should not be part of the brush?

        if (DitherPanel.getDitherState()){
            let pattern = DitherPanel.getDitherPattern();

            drawCtx.globalCompositeOperation = touchData.button ? "destination-out" : "destination-in";
            drawCtx.drawImage(pattern,0,0);
            drawCtx.globalCompositeOperation = "source-over";
        }

        // Return the drawn footprint (layer-local) so the canvas can damage-clip the
        // on-screen composite (spec 016 phase 11). The dither pass above only masks
        // within the brush's own pixels, so b still bounds every changed pixel.
        return {
            x: b.x + (me.canvasX || 0),
            y: b.y + (me.canvasY || 0),
            width: b.width,
            height: b.height
        };
    }

    me.drawShape = function(drawFunction,x,y,w,h){
        me.ensureLocalRect(x, y, w, h);
        let bx = x - (me.canvasX || 0);
        let by = y - (me.canvasY || 0);

        if (!drawLayer){
            drawLayer=duplicateCanvas(canvas);
            drawCtx = drawLayer.getContext("2d");
        }
        isDrawing = true;
        drawOpacity = 1; // Shapes should always be fully opaque
        drawCtx.globalAlpha = 1; // Reset context alpha from any previous brush operations

        drawFunction(drawCtx,bx,by,w,h);
    }

    me.commitDraw = function(){
        let _ctx = me.getContext();
        _ctx.globalAlpha = drawOpacity;
        if(currentColor==="transparent"){
            _ctx.globalCompositeOperation = "destination-out";
        }
        _ctx.drawImage(drawLayer,0,0);
        _ctx.globalCompositeOperation = "source-over";
        _ctx.globalAlpha = 1;
        drawCtx.clearRect(0,0,drawLayer.width,drawLayer.height);
        isDrawing = false;
        currentColor="";
        historyservice.end();
    }

    // Recolor the layer with a solid color.
    // By default only existing (non-transparent) pixels are recolored, preserving
    // transparency — this is what the palette editor's live colour preview relies on.
    // Pass fillTransparent=true to paint the entire layer opaque (used by the public API).
    me.fill = function(color,fillTransparent){
        color = Color.fromString(color);
        let imageData = ctx.getImageData(0,0,canvas.width, canvas.height);
        let data = imageData.data;
        let max = data.length>>2;
        for (let i = 0; i<max; i++){
            let index = i*4;
            if (fillTransparent || data[index + 3]>100){
                data[index] = color[0];
                data[index+1] = color[1];
                data[index+2] = color[2];
                data[index + 3] = 255;
            }
        }
        ctx.putImageData(imageData,0,0);
    }

    me.addMask = function(hide){
        if (!mask){
            mask = duplicateCanvas(canvas);
            alphaLayer = duplicateCanvas(canvas);
            if (!combined) combined = duplicateCanvas(canvas);

            maskCtx = mask.getContext("2d");
            alphaCtx = alphaLayer.getContext("2d");
            maskCtx.fillStyle = alphaLayer.fillStyle = hide?"black":"white";
            maskCtx.fillRect(0,0,mask.width,mask.height);
            alphaCtx.fillRect(0,0,mask.width,mask.height);
            me.hasMask = true;
            maskEnabled = true;

            if (!me.isMaskActive()){
                me.toggleMask();
                me.update(maskCtx);
                me.toggleMask();
            }
        }
    }

    me.removeMask = function(andApply){
        if (mask){
            if (andApply){
                ctx.globalCompositeOperation = "destination-in";
                ctx.drawImage(alphaLayer,0,0);
                ctx.globalCompositeOperation = "source-over";
            }
            releaseCanvas(mask);
            if (drawMask) releaseCanvas(drawMask);
            //releaseCanvas(alphaLayer);
            maskCtx  = undefined;
            mask = undefined;
            me.hasMask = false;
            maskActive = false;
        }
    }

    me.enableMask = function(state){
        maskEnabled = !!state;
        if (!maskEnabled) maskActive = false;
    }

    me.toggleMask = function(){
        maskActive = !maskActive;
    }

    me.isMaskActive = ()=>{
        return maskActive;
    }

    me.isMaskEnabled = ()=>{
        return maskEnabled;
    }

    me.update = (_maskCtx)=>{
        _maskCtx = _maskCtx||maskCtx;
        if (maskActive){
            // move mask mayer to alpha layer
            let img = _maskCtx.getImageData(0, 0, canvas.width, canvas.height);
            for (let i =0, max=img.data.length; i<max; i+=4){
                img.data[i+3] = img.data[i]; // move red channel to alpha
            }
            alphaCtx.putImageData(img, 0, 0);
        }
    }

    me.clone = (forSerialization,indexed)=>{
        let struct = {
            // id/x/y must be carried by BOTH branches below — a field missing here is
            // silently lost on undo and on save (see spec 001 design 3.1).
            id: me.id,
            x: me.x || 0,
            y: me.y || 0,
            canvasX: me.canvasX || 0,
            canvasY: me.canvasY || 0,
            // The canvas is NOT always document-sized: crop and resize are non-destructive, so
            // a layer keeps the pixels that now fall outside the document. Record the real
            // size, or restore() rebuilds the canvas at the document size and clips them away.
            w: canvas.width,
            h: canvas.height,
            name: me.name,
            blendMode: me.blendMode,
            dissolve: me.dissolve || DEFAULT_DISSOLVE_PATTERN,
            opacity: me.opacity,
            visible: me.visible,
            locked: !!me.locked,
            hasMask: me.hasMask
        };
        if (!forSerialization) indexed=false;

        if (me.type === "group"){
            struct.type = "group";
            struct.collapsed = !!me.collapsed;
            // Runtime transform (spec 007). Non-destructive: it scales/rotates the composited
            // group canvas, not the child pixels. Carried here so it survives undo and save
            // (a field missing here is silently lost — spec 001 §3.1).
            struct.scaleX = typeof me.scaleX === "number" ? me.scaleX : 1;
            struct.scaleY = typeof me.scaleY === "number" ? me.scaleY : 1;
            struct.rotation = typeof me.rotation === "number" ? me.rotation : 0;
            // Timeline-wide (not animatable): smooth resampling during the runtime transform.
            struct.smooth = !!me.smooth;
            struct.layers = me.layers.map(c=>c.clone(forSerialization,indexed));
            return struct;
        }

        // A bone layer carries an armature instead of pixels. Deep-clone it so undo/save keep a
        // fully independent copy (a field missing here is silently lost on undo — spec 001 §3.1).
        // Derived data (binds, deformed canvases, world matrices) is never serialized.
        if (me.type === "bone"){
            struct.type = "bone";
            struct.armature = cloneArmature(me.armature);
            struct.gridQuality = me.gridQuality;
            return struct;
        }

        // A vector layer carries editable geometry instead of pixels. Deep-clone it so undo/save
        // keep a fully independent copy (a field missing here is silently lost — spec 001 §3.1).
        // The rasterized bitmap is derived and is regenerated by render(), so it is never stored.
        if (me.type === "vector"){
            struct.type = "vector";
            struct.vector = cloneVector(me.vector);
            return struct;
        }

        if (indexed){
            let indexed = me.generateIndexedPixels();
            struct.indexedPixels = indexed.pixels;
            struct.conversionErrors=indexed.notFoundCount;
        }else{
            struct.canvas = forSerialization ? canvas.toDataURL() : duplicateCanvas(canvas,true);
        }

        if (me.hasMask){
            struct.mask = forSerialization ? mask.toDataURL() : duplicateCanvas(mask,true);
        }

        return struct;
    }

    me.restore = (struct)=> {
        return new Promise((next)=>{
            me.name = struct.name;
            me.blendMode = struct.blendMode;
            // absent in documents written before dissolve existed
            me.dissolve = struct.dissolve || DEFAULT_DISSOLVE_PATTERN;
            me.opacity = struct.opacity;
            me.visible = !!struct.visible;
            me.locked = !!struct.locked;
            me.hasMask = !!struct.hasMask;
            // Keep the stored identity (property keys reference it) and make sure the
            // allocator never hands the same id out again. Structs from before spec 004
            // carry no id/offset, so those keep the freshly allocated id and 0/0.
            if (struct.id){
                me.id = struct.id;
                Layer.observeId(struct.id);
            }
            me.x = struct.x || 0;
            me.y = struct.y || 0;
            me.canvasX = struct.canvasX || 0;
            me.canvasY = struct.canvasY || 0;

            // A stored canvas can be LARGER than the document: crop and resize are
            // non-destructive, so a layer keeps the pixels that now fall outside the document
            // bounds. Size this canvas to what was stored BEFORE anything draws into it or
            // reads its dimensions — addMask() sizes the mask from it, a group sizes its
            // composite buffer from it, and drawImage(...,0,0) into a document-sized canvas
            // silently clips the rest. Getting this wrong is what made a save/reopen after a
            // crop lose the artwork of every offset layer while keeping its offsets, so the
            // whole animation looked translated.
            // Grows only, never shrinks: a canvas that is BIGGER than the document is the
            // state that has to be reproduced, while one that is smaller (a non-destructive
            // grow-resize) renders identically either way and is safer left document-sized,
            // since anything painted outside a layer's own canvas is lost.
            function sizeCanvasTo(width,height){
                if (!width || !height) return;
                let w = Math.max(canvas.width, width);
                let h = Math.max(canvas.height, height);
                if (canvas.width === w && canvas.height === h) return;
                canvas.width = w;
                canvas.height = h;
                me.invalidateCache();
                // resizing the canvas element clears it, so a vector layer must re-rasterize.
                if (me.type === "vector") me.vectorDirty = true;
            }
            // Recorded since crop/resize became non-destructive. Documents written before that
            // always stored a document-sized canvas, so falling back to the stored bitmap's own
            // size (below) restores them unchanged.
            sizeCanvasTo(struct.w, struct.h);

            if (struct.type === "group"){
                me.type = "group";
                me.collapsed = !!struct.collapsed;
                // Runtime transform (spec 007). Absent in documents written before 007 → identity.
                me.scaleX = typeof struct.scaleX === "number" ? struct.scaleX : 1;
                me.scaleY = typeof struct.scaleY === "number" ? struct.scaleY : 1;
                me.rotation = typeof struct.rotation === "number" ? struct.rotation : 0;
                me.smooth = !!struct.smooth;
                groupCanvas = undefined;
                groupCtx = undefined;
                let children = Array.isArray(struct.layers) ? struct.layers : [];
                if (!Array.isArray(struct.layers)){
                    console.warn("Layer.restore: group struct without layers array; restoring as empty group");
                }
                me.layers = children.map(()=>Layer(canvas.width,canvas.height));
                Promise.all(me.layers.map((child,i)=>child.restore(children[i]))).then(()=>next());
                return;
            }

            // Bone layer: restore the armature (no pixels to decode). Guard against a missing/old
            // struct by falling back to an empty armature.
            if (struct.type === "bone"){
                me.type = "bone";
                me.armature = cloneArmature(struct.armature) || { bones: [], nextBoneId: 1 };
                if (struct.gridQuality) me.gridQuality = struct.gridQuality;
                next();
                return;
            }

            // Vector layer: restore the geometry (no pixels to decode) and flag the raster cache
            // dirty so the next render() regenerates the bitmap into this canvas.
            if (struct.type === "vector"){
                me.type = "vector";
                me.vector = cloneVector(struct.vector);
                me.vectorDirty = true;
                me.vectorRasterized = false;
                next();
                return;
            }

            if (mask) releaseCanvas(mask);
            if (alphaLayer) releaseCanvas(alphaLayer);
            if (combined) releaseCanvas(combined);

            mask = undefined;
            alphaLayer = undefined;
            // released above, so it must not be reused at its old (1x1) size by addMask()
            combined = undefined;
            maskActive = false;

            function loadImage(src){
                return new Promise(resolve=>{
                    let img = new Image();
                    img.onload = ()=>resolve(img);
                    img.onerror = ()=>{
                        console.warn("Layer.restore: could not decode the stored bitmap");
                        resolve(undefined);
                    };
                    img.src = src;
                });
            }

            function restoreIndexedPixels(indexed){
                let w = canvas.width;
                let h = canvas.height;
                let imgData = ctx.createImageData(w,h);
                let colors = Palette.get();
                for (let y = 0; y<h; y++){
                    for (let x = 0; x<w; x++){
                        let line = indexed[y] || [];
                        let offset = (y*w+x)*4;
                        let index = line[x];
                        if (typeof index !== 'number') index = -1;
                        if (index>=0){
                            let color = colors[index] || [0,0,0];
                            imgData.data[offset] = color[0];
                            imgData.data[offset+1] = color[1];
                            imgData.data[offset+2] = color[2];
                            imgData.data[offset+3] = 255;
                        }else{
                            imgData.data[offset] = 0;
                            imgData.data[offset+1] = 0;
                            imgData.data[offset+2] = 0;
                            imgData.data[offset+3] = 0;
                        }
                    }
                }
                ctx.putImageData(imgData,0,0);
            }

            let bitmap = Promise.resolve(undefined);
            if (struct.canvas){
                bitmap = typeof struct.canvas === "string"
                    ? loadImage(struct.canvas)
                    : Promise.resolve(struct.canvas);
            }

            bitmap.then(image=>{
                // no w/h in the struct: the bitmap is the only record of the real size
                if (image) sizeCanvasTo(image.width, image.height);
                if (image) ctx.drawImage(image,0,0);
                else if (struct.indexedPixels) restoreIndexedPixels(struct.indexedPixels);

                if (!struct.mask) return;
                // after the canvas is final, so the mask matches its size
                me.addMask();
                if (typeof struct.mask !== "string"){
                    maskCtx.drawImage(struct.mask,0,0);
                    return;
                }
                return loadImage(struct.mask).then(maskImage=>{
                    if (maskImage) maskCtx.drawImage(maskImage,0,0);
                });
            }).then(()=>{
                if (struct.mask){
                    let a = maskActive;
                    maskActive = true;
                    me.update();
                    maskActive = a;
                }
                next();
            });
        });
    }

    me.generateIndexedPixels = function(){
        return indexPixelsToPalette(ctx,Palette.get());

    }

    return me;
}

// Creates a group layer: a Layer with type "group" and an (initially empty) layers array.
// render() composites its children onto an offscreen canvas (see render() above).
// A group carries id/x/y like any other node (inherited from Layer()).
Layer.makeGroup = function(width,height,name){
    let group = Layer(width,height,name || "Group");
    group.type = "group";
    group.layers = [];
    group.collapsed = false;
    // Runtime transform (spec 007), identity by default — see effectiveProps/compositeNodes.
    group.scaleX = 1;
    group.scaleY = 1;
    group.rotation = 0;
    group.smooth = false;   // timeline-wide (not animatable) — see ImageFile.setGroupSmooth
    return group;
}

// Creates a bone layer: a Layer with type "bone" that holds an armature (a tree of bones) and
// paints no pixels of its own — it deforms its younger siblings at composite time (see spec 005).
// It carries the base Layer fields (id/x/y/opacity/visible/locked/name) so the id/offset/timeline
// machinery applies unchanged. `gridQuality` is the deformation-mesh resolution (cells per side).
Layer.makeBones = function(width,height,name){
    let l = Layer(width,height,name || "Bones");
    l.type = "bone";
    l.armature = { bones: [], nextBoneId: 1 };
    l.gridQuality = 16;
    return l;
}

// Creates a vector layer: a Layer with type "vector" holding editable geometry (me.vector — see
// util/vectorUtils.js) instead of a bitmap. render() rasterizes that geometry into the layer's own
// canvas behind me.vectorDirty, so it composites/exports/indexes exactly like a pixel layer. It
// carries the base Layer fields (id/x/y/opacity/visible/locked/name) so the id/offset/timeline
// machinery applies unchanged, readying it for per-node animation (spec 009).
Layer.makeVector = function(width,height,name){
    let l = Layer(width,height,name || "Vector");
    l.type = "vector";
    l.vector = emptyVectorData();
    l.vectorDirty = true;
    l.vectorRasterized = false;
    // Marks the raster cache stale + notifies the view. Tools call this after any geometry edit.
    l.markVectorDirty = function(){
        l.vectorDirty = true;
    };
    return l;
}

// Deep-clones an armature (pure data: bones with rest/pose/actionRadius/parentId/name/id, plus the
// nextBoneId counter). Returns undefined for a falsy input so callers can supply their own default.
// Derived state (world matrices, binds, deformed canvases) lives on the deformer, never here.
function cloneArmature(armature){
    if (!armature) return undefined;
    return {
        nextBoneId: armature.nextBoneId || 1,
        bones: (armature.bones || []).map(b=>({
            id: b.id,
            name: b.name,
            parentId: (b.parentId === undefined) ? null : b.parentId,
            rest: { x: b.rest.x, y: b.rest.y, angle: b.rest.angle, length: b.rest.length },
            pose: { angle: (b.pose && b.pose.angle) || 0, x: (b.pose && b.pose.x) || 0, y: (b.pose && b.pose.y) || 0, scale: (b.pose && b.pose.scale) || 1 },
            actionRadius: b.actionRadius
        }))
    };
}

// ── id allocator plumbing (used by image.js for serialization / migration) ─────────

// Next id the allocator would hand out, as a number ("L17" → 17).
Layer.peekIdCounter = function(){
    return idCounter;
}

// Raises the counter so it can never collide with an already-used id.
Layer.setIdCounter = function(value){
    let n = typeof value === "number" ? value : parseInt(value,10);
    if (!isNaN(n) && n > idCounter) idCounter = n;
}

// Registers an id that came from outside the allocator (restore/migration).
Layer.observeId = function(id){
    let n = parseInt(String(id).replace(/^L/,""),10);
    if (!isNaN(n) && n >= idCounter) idCounter = n + 1;
}

// A brand new document restarts at L1 (ids only have to be unique within one file).
Layer.resetIdCounter = function(){
    idCounter = 1;
}

Layer.nextId = allocateId;

export default Layer;