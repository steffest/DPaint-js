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

let Layer = function(width,height,name){
    let me = {
        visible:true,
        opacity:100,
        name: name,
        blendMode: "normal",
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
        if (maskActive){
            return mask;
        }else{
            return canvas;
        }
    }

    me.getCanvasType = function(maskType){
       return (maskType) ? mask : canvas;
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

    me.render = function(){
        if (me.type === "group"){
            if (!groupCanvas){
                groupCanvas = document.createElement("canvas");
                groupCanvas.width = canvas.width;
                groupCanvas.height = canvas.height;
                groupCtx = groupCanvas.getContext("2d",{willReadFrequently:true});
            }
            groupCtx.clearRect(0,0,groupCanvas.width,groupCanvas.height);
            compositeNodes(me.layers.filter(c=>c.visible), groupCtx);
            return groupCanvas;
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

        me.reset();
        EventBus.trigger(EVENT.layerContentChanged);
    }

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

        me.reset();
        EventBus.trigger(EVENT.layerContentChanged);
    }

    me.drawImage = function(image,x,y){
        x=x||0;y=y||0;
        let _ctx = me.getContext();
        _ctx.imageSmoothingEnabled = false;
        _ctx.drawImage(image,x,y);
        me.update();
    }

    me.draw = function(x,y,color,touchData){
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
        let b = Brush.draw(drawCtx,x,y,drawColor,touchData.button,true,true,!touchData.isDrawing); // TODO: color should not be part of the brush?

        if (DitherPanel.getDitherState()){
            let pattern = DitherPanel.getDitherPattern();

            drawCtx.globalCompositeOperation = touchData.button ? "destination-out" : "destination-in";
            drawCtx.drawImage(pattern,0,0);
            drawCtx.globalCompositeOperation = "source-over";
        }
    }

    me.drawShape = function(drawFunction,x,y,w,h){
        if (!drawLayer){
            drawLayer=duplicateCanvas(canvas);
            drawCtx = drawLayer.getContext("2d");
        }
        isDrawing = true;
        drawOpacity = 1; // Shapes should always be fully opaque
        drawCtx.globalAlpha = 1; // Reset context alpha from any previous brush operations

        drawFunction(drawCtx,x,y,w,h);
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
            name: me.name,
            blendMode: me.blendMode,
            opacity: me.opacity,
            visible: me.visible,
            locked: !!me.locked,
            hasMask: me.hasMask
        };
        if (!forSerialization) indexed=false;

        if (me.type === "group"){
            struct.type = "group";
            struct.collapsed = !!me.collapsed;
            struct.layers = me.layers.map(c=>c.clone(forSerialization,indexed));
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
            me.opacity = struct.opacity;
            me.visible = !!struct.visible;
            me.locked = !!struct.locked;
            me.hasMask = !!struct.hasMask;

            if (struct.type === "group"){
                me.type = "group";
                me.collapsed = !!struct.collapsed;
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

            let canvasRestored = true;
            let maskRestored = true;

            if (mask) releaseCanvas(mask);
            if (alphaLayer) releaseCanvas(alphaLayer);
            if (combined) releaseCanvas(combined);

            mask = undefined;
            alphaLayer=undefined;
            maskActive = false;

            let isDone = ()=>{
                if (canvasRestored && maskRestored){
                    if (struct.mask){
                        let a = maskActive;
                        maskActive = true;
                        me.update();
                        maskActive = a;
                    }
                    next();
                }
            }

            if (struct.canvas){
                canvasRestored = false;
                if (typeof struct.canvas === "string"){
                    let img = new Image();
                    img.onload = ()=>{
                        ctx.drawImage(img,0,0);
                        canvasRestored = true;
                        isDone();
                    }
                    img.src = struct.canvas;
                }else{
                    ctx.drawImage(struct.canvas,0,0);
                    canvasRestored = true;
                }
            }else if (struct.indexedPixels){
                console.log("restoring indexed pixels")
                canvasRestored = false;
                let imgData = ctx.createImageData(canvas.width,canvas.height);
                let colors = Palette.get();
                let w = canvas.width;
                let h = canvas.height;
                let indexed = struct.indexedPixels;
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
                canvasRestored = true;
            }
            if (struct.mask){
                maskRestored = false;
                me.addMask();
                if (typeof struct.mask === "string"){
                    let img = new Image();
                    img.onload = ()=>{
                        maskCtx.drawImage(img,0,0);
                        maskRestored = true;
                        isDone();
                    }
                    img.src = struct.mask;
                }else{
                    maskCtx.drawImage(struct.mask,0,0);
                    maskRestored = true;
                }
            }
            isDone();
        });
    }

    me.generateIndexedPixels = function(){
        return indexPixelsToPalette(ctx,Palette.get());

    }

    return me;
}

// Creates a group layer: a Layer with type "group" and an (initially empty) layers array.
// render() composites its children onto an offscreen canvas (see render() above).
Layer.makeGroup = function(width,height,name){
    let group = Layer(width,height,name || "Group");
    group.type = "group";
    group.layers = [];
    group.collapsed = false;
    return group;
}

export default Layer;