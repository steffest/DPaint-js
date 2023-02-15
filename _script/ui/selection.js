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
        currentSelection = {
            left: selection.left,
            top: selection.top,
            width: selection.width,
            height: selection.height,
            points: selection.points,
            canvas: selection.canvas
        }
    }

    me.move = function(x,y,w,h){
        if (currentSelection){
            currentSelection.left = x;
            currentSelection.top = y;
            currentSelection.width = w;
            currentSelection.height = h;
            EventBus.trigger(EVENT.selectionChanged);
        }

        // TODO: in the case of a "points" polygon, should we move the points as well ?
    }

    me.get = function(){
        return currentSelection;
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

    me.toStamp = function(){
        if (currentSelection){
            let brushCanvas = document.createElement("canvas");
            brushCanvas.width = currentSelection.width;
            brushCanvas.height = currentSelection.height;
            let brushContext = brushCanvas.getContext("2d");
            brushContext.imageSmoothingEnabled = false;
            brushContext.drawImage(ImageFile.getActiveLayer().getCanvas(),currentSelection.left,currentSelection.top,brushCanvas.width,brushCanvas.height,0,0, brushCanvas.width, brushCanvas.height);
            Brush.set("canvas",brushCanvas);
            EventBus.trigger(COMMAND.DRAW);
            EventBus.trigger(COMMAND.CLEARSELECTION);
        }
    }
    
    me.toLayer = function(){
        if (currentSelection){
            let canvas = ImageFile.getActiveLayer().getCanvas();
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


            EventBus.trigger(EVENT.layerContentChanged);
            EventBus.trigger(COMMAND.CLEARSELECTION);
        }
    }

    EventBus.on(COMMAND.CLEARSELECTION,()=>{
        currentSelection = undefined;
    })

    EventBus.on(COMMAND.STAMP,()=>{
        me.toStamp();
    })

    EventBus.on(COMMAND.TOLAYER,()=>{
        me.toLayer();
    })
    
    return me;
}()

export default Selection