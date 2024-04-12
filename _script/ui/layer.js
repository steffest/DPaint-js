import Color from "../util/color.js";
import ToolOptions from "./components/toolOptions.js";
import {duplicateCanvas, indexPixelsToPalette, releaseCanvas} from "../util/canvasUtils.js";
import Brush from "./brush.js";
import HistoryService from "../services/historyservice.js";
import DitherPanel from "./toolPanels/ditherPanel.js";
import historyservice from "../services/historyservice.js";
import Palette from "./palette.js";
import ImageFile from "../image.js";

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
        if (maskActive){
            return maskCtx;
        }else{
            return ctx;
        }
    }

    me.render = function(){
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
        let b = Brush.draw(drawCtx,x,y,drawColor,touchData.button,true); // TODO: color should not be part of the brush?

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

    me.fill = function(color){
        color = Color.fromString(color);
        let imageData = ctx.getImageData(0,0,canvas.width, canvas.height);
        let data = imageData.data;
        let max = data.length>>2;
        for (let i = 0; i<max; i++){
            let index = i*4;
            if (data[index + 3]>100){
                imageData.data[index] = color[0];
                imageData.data[index+1] = color[1];
                imageData.data[index+2] = color[2];
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
            hasMask: me.hasMask
        };
        if (!forSerialization) indexed=false;

        if (indexed){
            let indexed = me.generateIndexedPixels();
            struct.indexedPixels = indexed.pixels;
            struct.conversionErrors=indexed.notFoundCount;
        }else{
            struct.canvas = forSerialization ? canvas.toDataURL() : duplicateCanvas(canvas);
        }

        if (me.hasMask){
            struct.mask = forSerialization ? mask.toDataURL() : duplicateCanvas(mask);
        }

        return struct;
    }

    me.restore = (struct)=> {
        return new Promise((next)=>{

            me.name = struct.name;
            me.blendMode = struct.blendMode;
            me.opacity = struct.opacity;
            me.visible = !!struct.visible;
            me.hasMask = !!struct.hasMask;

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

export default Layer;