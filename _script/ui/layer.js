import Color from "../util/color.js";
import ToolOptions from "./components/toolOptions.js";
import {duplicateCanvas, releaseCanvas} from "../util/canvasUtils.js";
import Brush from "./brush.js";
import ImageFile from "../image.js";
import HistoryService from "../services/historyservice.js";

let Layer = function(width,height,name){
    let me = {
        visible:true,
        opacity:100,
        name: name,
        blendMode: "normal",
        hasMask: false,
    }
    
    let canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    let ctx = canvas.getContext("2d");
    let mask;
    let maskCtx;
    let maskActive;
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
    
    me.getContext = function(){
        if (maskActive){
            return maskCtx;
        }else{
            return ctx;
        }
    }

    me.render = function(){
        if (mask || isDrawing){
            if (!combined) combined = duplicateCanvas(canvas);
            let combinedCtx = combined.getContext("2d");
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
        ctx.clearRect(0,0, canvas.width, canvas.height);
    }

    me.drawImage = function(image,x,y){
        x=x||0;y=y||0;
        let _ctx = me.getContext();
        _ctx.imageSmoothingEnabled = false;
        _ctx.drawImage(image,x,y);
        me.update();
    }

    me.draw = function(x,y,color,_isDrawing){
        if (!drawLayer){
            drawLayer=duplicateCanvas(canvas);
            drawCtx = drawLayer.getContext("2d");
        }
        if (!_isDrawing){
            drawOpacity = Brush.getOpacity();
        }
        isDrawing = true;
        currentColor = color;
        let drawColor = color;
        if (color === "transparent"){
            drawColor = "black";
        }
        //Brush.draw(me.getContext(),x,y,color,true);
        Brush.draw(drawCtx,x,y,drawColor,true);
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
        HistoryService.end();
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

    me.addMask = function(){
        if (!mask){
            mask = duplicateCanvas(canvas);
            alphaLayer = duplicateCanvas(canvas);
            if (!combined) combined = duplicateCanvas(canvas);

            maskCtx = mask.getContext("2d");
            alphaCtx = alphaLayer.getContext("2d");
            maskCtx.fillStyle = alphaLayer.fillStyle = "white";
            maskCtx.fillRect(0,0,mask.width,mask.height);
            alphaCtx.fillRect(0,0,mask.width,mask.height);
            me.hasMask = true;
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

    me.toggleMask = function(){
        maskActive = !maskActive;
    }

    me.isMaskActive = ()=>{
        return maskActive;
    }

    me.update = (_maskCtx)=>{
        _maskCtx = _maskCtx||maskCtx;
        if (maskActive){
            console.error("update");
            // move mask mayer to alpha layer
            let img = _maskCtx.getImageData(0, 0, canvas.width, canvas.height);
            for (let i =0, max=img.data.length; i<max; i+=4){
                img.data[i+3] = img.data[i]; // move red channel to alpha
            }

            alphaCtx.putImageData(img, 0, 0);
        }
    }
    
    return me;
}

export default Layer;