import Brush from "./brush.js";
import EventBus from "../util/eventbus.js";
import {COMMAND, EVENT} from "../enum.js";
import ImageFile from "../image.js";
import {duplicateCanvas} from "../util/canvasUtils.js";

/*
Selection holds the data of the current selected pixels.
it always has a left,top,width, height of the bounding box.

if it has nothing more, selection is a rectangle
if it has a "points" array it's a polygon
if it has a canvas object, it is based on (the alpha layer of) the canvas.
 */

let Selection = function(){
    let me = {};
    let currentSelection;
    
    me.set = function(selection){
        currentSelection = selection || {};
        EventBus.trigger(EVENT.selectionChanged);
    }

    me.move = function(x,y,w,h){
        currentSelection = {
            left: x,
            top: y,
            width: w,
            height: h
        }
        EventBus.trigger(EVENT.selectionChanged);
    }

    me.get = function(){
        return currentSelection;
    }

    me.clear = function(){
        let hasSelection = !!currentSelection;
        currentSelection = undefined;
        if (hasSelection) EventBus.trigger(EVENT.selectionChanged);
    }

    me.selectAll = function(){
        let w = ImageFile.getCurrentFile().width;
        let h = ImageFile.getCurrentFile().height;
        EventBus.trigger(COMMAND.CLEARSELECTION);
        EventBus.trigger(COMMAND.SELECT);
        me.set({left: 0, top: 0, width: w, height: h});
    }

    me.getCanvas = function(){
        // renders the current selection to canvas
        if (currentSelection){
            if (currentSelection.canvas){
                return duplicateCanvas(currentSelection.canvas,true);
            }else if (currentSelection.points && currentSelection.points.length){
                let result = document.createElement("canvas");
                result.width = ImageFile.getCurrentFile().width;
                result.height = ImageFile.getCurrentFile().height;
                let ctx=result.getContext("2d");
                ctx.fillStyle = "black";
                ctx.beginPath();
                currentSelection.points.forEach((point,index)=>{
                    if (index){
                        ctx.lineTo(point.x,point.y);
                    }else{
                        ctx.moveTo(point.x,point.y);
                    }
                });
                ctx.closePath();
                ctx.fill();
                return result;
            }
        }
        console.error("No selection to convert to canvas");
    }

    me.toCanvas = function(){
        // TODO: non rectangular selections
        if (currentSelection){
            let canvas = document.createElement("canvas");
            canvas.width = currentSelection.width;
            canvas.height = currentSelection.height;
            let ctx = canvas.getContext("2d");
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(ImageFile.getActiveLayer().getCanvas(),currentSelection.left,currentSelection.top,canvas.width,canvas.height,0,0, canvas.width, canvas.height);
            return canvas;
        }
    }

    me.toStamp = function(){
        let canvas = me.toCanvas();
        if (canvas){
            Brush.set("canvas",canvas);
            EventBus.trigger(COMMAND.DRAW);
            EventBus.trigger(COMMAND.CLEARSELECTION);
        }
    }
    
    me.toLayer = function(andCut){
        if (currentSelection){
            let canvas = ImageFile.getActiveLayer().getCanvas();
            let sourceLayerIndex = ImageFile.getActiveLayerIndex();
            ImageFile.duplicateLayer();
            let layer = ImageFile.getActiveLayer();

            if (currentSelection.points || currentSelection.canvas){
                // draw on Mask
                layer.addMask();
                layer.toggleMask();
                let ctx = layer.getContext();
                ctx.fillStyle = "black";
                ctx.fillRect(0,0,canvas.width,canvas.height);

                if (currentSelection.points){
                    // draw Polygon on Mask
                    ctx.fillStyle = "white";
                    ctx.beginPath();
                    currentSelection.points.forEach((point,index)=>{
                        if (index){
                            ctx.lineTo(point.x,point.y);
                        }else{
                            ctx.moveTo(point.x,point.y);
                        }
                    });
                    ctx.closePath();
                    ctx.fill();
                }

                if (currentSelection.canvas){
                    ctx.drawImage(currentSelection.canvas,0,0);
                }

                layer.update();
                layer.removeMask(true);
            }else{
                // rectangle
                layer.clear();
                layer.getContext().drawImage(canvas,currentSelection.left,currentSelection.top,currentSelection.width,currentSelection.height,currentSelection.left,currentSelection.top, currentSelection.width, currentSelection.height);
            }

            if (andCut){
                ImageFile.activateLayer(sourceLayerIndex);
                EventBus.trigger(COMMAND.CLEAR);
                ImageFile.activateLayer(sourceLayerIndex+1);
            }


            EventBus.trigger(EVENT.layerContentChanged);
            EventBus.trigger(COMMAND.CLEARSELECTION);
        }
    }

    EventBus.on(COMMAND.SELECTALL,me.selectAll);
    EventBus.on(COMMAND.CLEARSELECTION,me.clear)
    EventBus.on(COMMAND.STAMP,me.toStamp)
    EventBus.on(COMMAND.TOLAYER,me.toLayer)

    EventBus.on(COMMAND.CUTTOLAYER,()=>{
        me.toLayer(true);
    })

    
    return me;
}()

export default Selection