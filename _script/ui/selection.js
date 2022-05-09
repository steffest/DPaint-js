import Brush from "./brush.js";
import EventBus from "../util/eventbus.js";
import {COMMAND} from "../enum.js";

let Selection = function(){
    let me = {};
    let currentSelection;
    
    me.set = function(canvas,selection){
        currentSelection = {
            x: selection.x,
            y: selection.y,
            width: selection.width,
            height: selection.height,
            canvas:  canvas.getCanvas()
        }
    }

    me.get = function(){
        return currentSelection;
    }

    me.toStamp = function(){
        if (currentSelection){
            console.error(currentSelection);
            let brushCanvas = document.createElement("canvas");
            brushCanvas.width = currentSelection.width;
            brushCanvas.height = currentSelection.height;
            brushCanvas.getContext("2d").drawImage(currentSelection.canvas,currentSelection.x,currentSelection.y,brushCanvas.width,brushCanvas.height,0,0, brushCanvas.width, brushCanvas.height);
            Brush.set("canvas",brushCanvas);
            EventBus.trigger(COMMAND.DRAW);
            EventBus.trigger(COMMAND.CLEARSELECTION);
        }
    }
    
    me.toLayer = function(){
        
    }
    
    EventBus.on(COMMAND.STAMP,()=>{
        me.toStamp();
    })

    EventBus.on(COMMAND.CLEARSELECTION,()=>{
        currentSelection = undefined;
    })
    
    return me;
}()

export default Selection