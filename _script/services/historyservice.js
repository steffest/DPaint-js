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

    // TODO: maybe add a "framehistory" type to store the current frame instead of the whole image?

    me.start = function(type,data){
        console.log("start his");
        currentHistory={type,data:{}};
        let index = ImageFile.getActiveLayerIndex();
        if (typeof data === "number") index = data;

        switch (type){
            case EVENT.layerContentHistory:
                currentHistory.data.layerIndex = index;
                currentHistory.data.from = duplicateCanvas(ImageFile.getActiveContext().canvas,true);
                break;
            case EVENT.layerPropertyHistory:
                currentHistory.data.layerIndex = index;
                currentHistory.data.from = getLayerProperties(index);
                break;
            case EVENT.layerHistory:
                currentHistory.data.layerIndex = index;
                currentHistory.data.from = ImageFile.getActiveLayer().clone();
                break;
            case EVENT.imageHistory:
                currentHistory.data.from = ImageFile.clone();
                // TODO: this also clears all masks and selections
                // and it doesn't hold the current layer so future undo actions wont work ...
                // FIXME
                break;
            default:
                console.error("History type " + type + " not handled");
        }
    }

    me.end=function(){
        if (currentHistory){
            console.log("end his");
            switch (currentHistory.type){
                case EVENT.layerContentHistory:
                    currentHistory.data.to = duplicateCanvas(ImageFile.getActiveContext().canvas,true)
                    break;
                case EVENT.layerPropertyHistory:
                    currentHistory.data.to = getLayerProperties(currentHistory.data.layerIndex);
                    break;
                case EVENT.layerHistory:
                    currentHistory.data.to = ImageFile.getLayer(currentHistory.data.layerIndex).clone();
                    break;
                case EVENT.imageHistory:
                    currentHistory.data.to = ImageFile.clone();
                    break;
            }

            history.unshift(currentHistory);
            if (history.length>maxHistory) history.pop();
            future=[];
            currentHistory = undefined;
            EventBus.trigger(EVENT.historyChanged,[history.length,future.length]);
        }
    }

    me.neverMind = function(){
        currentHistory = undefined;
    }

    me.add = function(type,from,to){
        history.unshift({type,data:{from,to}});
        if (history.length>maxHistory) history.pop();
        future=[];
        EventBus.trigger(EVENT.historyChanged,[history.length,future.length]);
    }

    me.clear = function(){
        history = [];
        future = [];
    }

    function getLayerProperties(index){
        let layer = ImageFile.getLayer(index);
        return {
            name: layer.name,
            visible: layer.visible,
            hasMask: layer.hasMask,
            maskActive: layer.isMaskActive(),
            index: index
        }
    }

    EventBus.on(COMMAND.UNDO,()=>{
        if (history.length){
            let historyStep = history.shift();
            let layer;
            let target;
            switch (historyStep.type){
                case EVENT.layerContentHistory:
                    layer = ImageFile.getLayer(historyStep.data.layerIndex);
                    layer.clear();
                    layer.drawImage(historyStep.data.from);
                    EventBus.trigger(EVENT.layerContentChanged);
                    break;
                case EVENT.imageHistory:
                    ImageFile.restore(historyStep.data.from);
                    EventBus.trigger(COMMAND.CLEARSELECTION);
                    break;
                case EVENT.layerPropertyHistory:
                    target = historyStep.data.from;
                    let source = historyStep.data.to;
                    if (target.index<0){
                        // add new layer
                        ImageFile.removeLayer(target.index);
                        ImageFile.activateLayer(target.currentIndex);
                    }else{
                        layer = ImageFile.getLayer(target.index);
                        if (typeof target.name === "string") layer.name = target.name;
                        if (typeof target.visible === "boolean") layer.visible = target.visible;
                        if (source.hasMask && source.maskActive !== target.maskActive) layer.toggleMask();
                        console.error(layer);
                    }
                    EventBus.trigger(EVENT.layersChanged);
                    break;
                case EVENT.layerHistory:
                    layer = ImageFile.getLayer(historyStep.data.layerIndex);
                    layer.restore(historyStep.data.from);
                    EventBus.trigger(EVENT.layerContentChanged);
                    EventBus.trigger(EVENT.layersChanged);
                    break;
                default:
                    console.error("History type " + historyStep.type + " not handled");
            }

            future.unshift(historyStep);
            if (future.length>maxHistory) future.pop();
            EventBus.trigger(EVENT.historyChanged,[history.length,future.length]);

        }
    })

    EventBus.on(COMMAND.REDO,()=>{
        if (future.length){
            let historyStep = future.shift();
            let layer;
            let target;
            let source;
            //console.log(historyStep);
            switch (historyStep.type){
                case EVENT.layerContentHistory:
                    layer = ImageFile.getActiveLayer();
                    layer.clear();
                    layer.drawImage(historyStep.data.to);
                    EventBus.trigger(EVENT.layerContentChanged);
                    break;
                case EVENT.imageHistory:
                    ImageFile.restore(historyStep.data.to);
                    EventBus.trigger(COMMAND.CLEARSELECTION);
                    break;
                case EVENT.layerPropertyHistory:
                    target = historyStep.data.to;
                    source = historyStep.data.from;
                    if (source.index<0){
                        ImageFile.activateLayer(source.currentIndex);
                        ImageFile.addLayer(source.currentIndex);
                    }else{
                        layer = ImageFile.getLayer(target.index);
                        if (typeof target.name === "string") layer.name = target.name;
                        if (typeof target.visible === "boolean") layer.visible = target.visible;
                        if (source.hasMask && source.maskActive !== target.maskActive) layer.toggleMask();
                    }
                    EventBus.trigger(EVENT.layersChanged);
                    break;
                case EVENT.layerHistory:
                    layer = ImageFile.getLayer(historyStep.data.layerIndex);
                    layer.restore(historyStep.data.to);
                    EventBus.trigger(EVENT.layerContentChanged);
                    EventBus.trigger(EVENT.layersChanged);
                    break;
                default:
                    console.error("History type " + historyStep.type + " not handled");
            }

            history.unshift(historyStep);
            if (history.length>maxHistory) history.pop();
            EventBus.trigger(EVENT.historyChanged,[history.length,future.length]);
        }
    })

    
    return me;
}()

export default HistoryService;