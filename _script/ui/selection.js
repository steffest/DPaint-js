import Brush from "./brush.js";
import EventBus from "../util/eventbus.js";
import {COMMAND, EVENT} from "../enum.js";
import ImageFile from "../image.js";

let Selection = function(){
    let me = {};
    let currentSelection;
    
    me.set = function(selection){
        currentSelection = {
            left: selection.left,
            top: selection.top,
            width: selection.width,
            height: selection.height,
            points: selection.points
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
    }

    me.get = function(){
        return currentSelection;
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
            let index = ImageFile.addLayer();
            console.error(currentSelection);
            ImageFile.activateLayer(index);
            ImageFile.getActiveContext().drawImage(canvas,currentSelection.left,currentSelection.top,currentSelection.width,currentSelection.height,currentSelection.left,currentSelection.top, currentSelection.width, currentSelection.height);

            if (currentSelection.points){
                // draw Polygon on Mask
                let layer = ImageFile.getActiveLayer();
                layer.addMask();
                layer.toggleMask();
                let ctx = layer.getContext();
                ctx.fillStyle = "black";
                ctx.fillRect(0,0,canvas.width,canvas.height);
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
                layer.update();
                layer.removeMask(true);
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