import EventBus from "../util/eventbus.js";
import {COMMAND, EVENT} from "../enum.js";
import ImageFile from "../image.js";
import {duplicateCanvas} from "../util/canvasUtils.js";

let HistoryService = function(){
    let me = {};

    let maxHistory = 20;
    let history = [];
    let future = [];
    let currentHistory;

    me.start = function(type){
        console.log("start his");
        currentHistory={type,data:{}};
        if (type === EVENT.layerHistory){
            currentHistory.data.from = duplicateCanvas(ImageFile.getActiveContext().canvas,true)
        }
    }

    me.end=function(){
        if (currentHistory){
            console.log("end his");
            switch (currentHistory.type){
                case EVENT.layerHistory:
                    currentHistory.data.to = duplicateCanvas(ImageFile.getActiveContext().canvas,true)
                    break;
            }

            history.unshift(currentHistory);
            if (history.length>maxHistory) history.pop();
            future=[];
            currentHistory = undefined;

        }
    }

    me.clear = function(){
        history = [];
        future = [];
    }

    EventBus.on(COMMAND.UNDO,()=>{
        if (history.length){
            let historyStep = history.shift();
            console.error(historyStep);
            switch (historyStep.type){
                case EVENT.layerHistory:
                    let layer = ImageFile.getActiveLayer();
                    layer.clear();
                    layer.drawImage(historyStep.data.from);
                    EventBus.trigger(EVENT.layerContentChanged);
                    future.unshift(historyStep);
                    if (future.length>maxHistory) future.pop();
                    break;
                default:
                    console.error("History type " + historyStep.type + " not handled");
            }
        }
    })

    EventBus.on(COMMAND.REDO,()=>{
        if (future.length){
            let historyStep = future.shift();
            console.error(historyStep);
            switch (historyStep.type){
                case EVENT.layerHistory:
                    let layer = ImageFile.getActiveLayer();
                    layer.clear();
                    layer.drawImage(historyStep.data.to);
                    EventBus.trigger(EVENT.layerContentChanged);
                    history.unshift(historyStep);
                    if (history.length>maxHistory) history.pop();
                    break;
                default:
                    console.error("History type " + historyStep.type + " not handled");
            }
        }
    })

    
    return me;
}()

export default HistoryService;