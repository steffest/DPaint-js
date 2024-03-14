import ImageFile from "../../image.js";
import EventBus from "../../util/eventbus.js";
import {COMMAND, EVENT} from "../../enum.js";

let DitherPanel = function(){
    let me = {};
    let ditherPattern;
    let ditherCtx;
    let dither;
    let invert = false;
    let ditherIndex = 3;
    let patternCanvas = document.createElement("canvas");
    patternCanvas.width = 4;
    patternCanvas.height = 4;

    let patterns=[
        [0,1,0,1,
         0,0,0,0,
         0,1,0,1,
         0,0,0,0],
        [0,1,0,1,
         1,0,0,0,
         0,1,0,1,
         0,0,1,0],
        [0,1,0,1,
         1,0,1,0,
         0,1,0,1,
         1,0,1,0],
        [0,1,0,1,
            1,1,1,0,
            0,1,0,1,
            1,0,1,1],
        [1,1,1,1,
            0,0,0,0,
            1,1,1,1,
            0,0,0,0],
        [1,0,1,0,
            1,0,1,0,
            1,0,1,0,
            1,0,1,0],
        [1,0,0,
            0,1,0,
            0,0,1],
        [1,1,0,0,
            0,0,1,1,
            1,1,0,0,
            0,0,1,1]
    ]

    me.getDitherPattern = ()=>{
        if (!ditherPattern) generateDitherPattern();
        return ditherPattern;
    }

    me.setDitherPattern = (pattern)=>{
        dither = !!pattern;
        if (dither){
            if (typeof pattern === "number"){
                ditherIndex = pattern;
                generateDitherPattern();
            }
            if (typeof pattern === "object"){
                generateDitherPattern(pattern);
            }
        }
        EventBus.trigger(EVENT.brushOptionsChanged);
    }

    me.setDitherState = (state)=>{
        dither = !!state;
        EventBus.trigger(EVENT.brushOptionsChanged);
    }

    me.getDitherState = ()=>{
        return dither;
    }

    me.setDitherInvertState = (state)=>{
        invert = !!state;
        EventBus.trigger(EVENT.brushOptionsChanged);
        ditherPattern = undefined;
    }

    me.getDitherInvertState = ()=>{
        return invert;
    }

    me.getDitherIndex = ()=>{
        return dither ? ditherIndex : 0;
    }

    function generateDitherPattern(fromCanvas){
        if (!ditherPattern){
            ditherPattern = document.createElement("canvas");
            ditherPattern.width = ImageFile.getCurrentFile().width;
            ditherPattern.height = ImageFile.getCurrentFile().height;
            ditherCtx = ditherPattern.getContext("2d");

        }

        ditherCtx.clearRect(0,0,ditherPattern.width,ditherPattern.height);

        let pCtx = patternCanvas.getContext("2d");
        if (fromCanvas){
            let s = fromCanvas.width;
            patternCanvas.width = s;
            patternCanvas.height = s;
            pCtx.clearRect(0,0,s,s);
            pCtx.drawImage(fromCanvas,0,0);
        }else{
            let grid = patterns[ditherIndex-1];
            let s = grid.length === 9?3:4;
            patternCanvas.width = s;
            patternCanvas.height = s;
            pCtx.clearRect(0,0,s,s);
            pCtx.fillStyle = "black";
            for (let y = 0;y<s; y++){
                for (let x = 0;x<s; x++){
                    let i = y*s + x;
                    let isBlack = !!grid[i];
                    if (invert) isBlack = !isBlack;
                    if (isBlack) pCtx.fillRect(x,y,1,1);
                }
            }
        }

        ditherCtx.fillStyle = ditherCtx.createPattern(patternCanvas, "repeat");
        ditherCtx.fillRect(0, 0, ditherPattern.width, ditherPattern.height);

    }

    me.getPreset = function(index){
        return patterns[index];
    }

    EventBus.on(EVENT.imageSizeChanged,()=>{
        ditherPattern = undefined;
    })

    EventBus.on(COMMAND.TOGGLEDITHER,()=>{
        dither = !dither;
        EventBus.trigger(EVENT.brushOptionsChanged);
    })

    EventBus.on(COMMAND.TOGGLEINVERT,()=>{
        invert = !invert;
        ditherPattern = undefined;
        EventBus.trigger(EVENT.brushOptionsChanged);
    })

    return me;
}()

export default DitherPanel;