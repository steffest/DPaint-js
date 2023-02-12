import Color from "../util/color.js";
import ToolOptions from "./components/toolOptions.js";
import {releaseCanvas} from "../util/canvasUtils.js";

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
        if (mask){
            let _ctx = combined.getContext("2d");
            _ctx.clearRect(0,0,combined.width,combined.height);

            _ctx.globalCompositeOperation = "source-over";
            _ctx.drawImage(canvas,0,0);

            if (maskActive && ToolOptions.showMask()){
                _ctx.fillStyle = "red";
                _ctx.globalAlpha = 0.7;
                _ctx.fillRect(0,0,combined.width,combined.height);
                _ctx.globalAlpha = 1;
            }

            _ctx.globalCompositeOperation = "destination-in";
            _ctx.drawImage(alphaLayer,0,0);
            _ctx.globalCompositeOperation = "source-over";
            return combined;
        }else{
            return canvas;
        }
    }
    
    me.clear = function(){
        ctx.clearRect(0,0, canvas.width, canvas.height);
    }

    me.draw = function(image,x,y){
        x=x||0;y=y||0;
        let _ctx = me.getContext();
        _ctx.imageSmoothingEnabled = false;
        _ctx.drawImage(image,x,y);
        me.update();
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
            mask = document.createElement("canvas");
            combined = document.createElement("canvas");
            alphaLayer = document.createElement("canvas");
            mask.width = combined.width = alphaLayer.width = canvas.width;
            mask.height = combined.height = alphaLayer.height = canvas.height;
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
            //releaseCanvas(combined);
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

    me.update = ()=>{
        if (maskActive){
            console.error("update");
            // move mask mayer to alpha layer
            let img = maskCtx.getImageData(0, 0, canvas.width, canvas.height);
            for (let i =0, max=img.data.length; i<max; i+=4){
                img.data[i+3] = img.data[i]; // move red channel to alpha
            }

            alphaCtx.putImageData(img, 0, 0);
        }
    }
    
    return me;
}

export default Layer;