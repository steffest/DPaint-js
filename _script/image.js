import FileDetector from "./fileformats/detect.js";
import EventBus from "./util/eventbus.js";
import {COMMAND, EVENT} from "./enum.js";
import Historyservice from "./services/historyservice.js";
import Layer from "./ui/layer.js";
import Modal, {DIALOG} from "./ui/modal.js";
import SidePanel from "./ui/sidepanel.js";
import {duplicateCanvas, releaseCanvas} from "./util/canvasUtils.js";

let ImageFile = function(){
    let me = {};
    let activeLayer;
    let activeLayerIndex = 0;
    let activeFrameIndex = 0;
    let cachedImage;
    let currentFile = {
        layers:[]
    }

    me.getCurrentFile = function(){
        return currentFile;
    }

    me.getOriginal = function(){
        if (!cachedImage){
            console.error("caching image");
            cachedImage = document.createElement("canvas");
            let img = me.getCanvas();
            cachedImage.width = img.width;
            cachedImage.height = img.height;
            cachedImage.getContext('2d').drawImage(img,0,0);
        }
        return cachedImage;
    }

    me.restoreOriginal = function(){
        if (cachedImage){
            let ctx = me.getActiveContext();
            ctx.clearRect(0,0,currentFile.width,currentFile.height);
            ctx.drawImage(cachedImage,0,0);
            EventBus.trigger(EVENT.imageContentChanged);
        }
    }
    
    me.getCanvas = function(frameIndex){
        let frame = (typeof frameIndex === "number") ? currentFile.frames[frameIndex]: currentFrame();
        if (!frame) return;
        if (frame.layers.length === 1){
            if (typeof frameIndex === "number"){
                return frame.layers[0].getCanvas();
            }else{
                if (activeLayer && activeLayer.visible){
                    return activeLayer.getCanvas();
                }
            }
        }else{
            let canvas = document.createElement("canvas");
            let ctx = canvas.getContext("2d");
            canvas.width = currentFile.width;
            canvas.height = currentFile.height;
            frame.layers.forEach(layer=>{
                if (layer.visible){
                    ctx.globalAlpha  = layer.opacity/100;
                    let blendMode = layer.blendMode || "normal";
                    if (blendMode === "normal") blendMode = "source-over";
                    ctx.globalCompositeOperation = blendMode;
                    ctx.drawImage(layer.getCanvas(),0,0);
                    ctx.globalAlpha  = 1;
                    ctx.globalCompositeOperation = "source-over";
                }
            });
            return canvas;
        }
    }
    
    me.getContext = function(){
        if (currentFrame().layers.length === 1 && activeLayer){
            return activeLayer.getContext();
        }
    }

    me.getActiveContext = function(){
        if (activeLayer) return activeLayer.getContext();
    }

    me.getActiveLayerIndex = function(){
        return activeLayerIndex;
    }

    me.getActiveLayer = function(){
        return activeLayer;
    }

    me.getLayer = function(index){
        let frame = currentFile.frames[activeFrameIndex];
        return frame ? frame.layers[index] : undefined;
    }

    me.getLayerIndexesOfType = function(type){
        let frame = currentFile.frames[activeFrameIndex];
        let result=[];
        if (frame){
           frame.layers.forEach((layer,index)=>{
               if (layer.type === type) result.push(index);
           })
        }
        return result;
    }

    me.getActiveFrameIndex = function(){
        return activeFrameIndex;
    }
    
    me.render = function(){
        if (currentFrame().layers.length>1){
           
        }
    }

    me.openLocal = function(){
        var input = document.createElement('input');
        input.type = 'file';
        input.onchange = function(e){
            handleUpload(e.target.files,"file");
        };
        input.click();
    }

    me.save = function(){
        Modal.show(DIALOG.SAVE);
    }

    me.resize = function(properties){
        if (!properties){
            Modal.show(DIALOG.RESIZE);
        }else{
            let w = properties.width;
            let h = properties.height;
            currentFile.width = w;
            currentFile.height = h;
            console.log("Resizing image to " +w + "x" + h);
            currentFile.frames.forEach(frame=>{
                frame.layers.forEach(layer=>{
                    let canvas = layer.getCanvas();
                    let ctx = layer.getContext();
                    let d = duplicateCanvas(canvas);
                    canvas.width = w;
                    canvas.height = h;
                    ctx.drawImage(d,0,0);
                    releaseCanvas(d);
                })
            })
            EventBus.trigger(EVENT.imageSizeChanged);
        }
    }

    me.resample = function(properties){
        if (!properties){
            Modal.show(DIALOG.RESAMPLE);
        }else{
            let w = properties.width;
            let h = properties.height;
            currentFile.width = w;
            currentFile.height = h;
            console.log("Resampling image to " +w + "x" + h);
            currentFile.frames.forEach(frame=>{
                frame.layers.forEach(layer=>{
                    let canvas = layer.getCanvas();
                    let ctx = layer.getContext();
                    let d = duplicateCanvas(canvas);
                    canvas.width = w;
                    canvas.height = h;
                    ctx.webkitImageSmoothingEnabled = false;
                    ctx.mozImageSmoothingEnabled = false;
                    ctx.imageSmoothingEnabled = false;
                    ctx.drawImage(d,0,0,d.width,d.height,0,0,w,h);
                    releaseCanvas(d);
                })
            })
            EventBus.trigger(EVENT.imageSizeChanged);
        }
    }

    me.activateLayer = function(index){
        console.log("Activating layer " + index);
        activeLayerIndex = index;
        activeLayer = currentFrame().layers[activeLayerIndex];
        EventBus.trigger(EVENT.layersChanged);
    }

    me.toggleLayer = function(index){
        currentFrame().layers[index].visible = !currentFrame().layers[index].visible;
        EventBus.trigger(EVENT.layersChanged);
        EventBus.trigger(EVENT.imageContentChanged);
    }

    me.setLayerOpacity = function(value){
        if(activeLayer){
            activeLayer.opacity = value;
            EventBus.trigger(EVENT.imageContentChanged);
        }
    }

    me.setLayerBlendMode = function(value){
        if(activeLayer){
            activeLayer.blendMode = value;
            EventBus.trigger(EVENT.imageContentChanged);
        }
    }

    me.getLayerBoundingRect = function(layerIndex){
        let layer = activeLayer;
        if (typeof layerIndex === "number") layer = currentFile.layers[layerIndex];

        let ctx = layer.getContext();
        let canvas = ctx.canvas;
        let w = canvas.width, h = canvas.height,
            pix = {x:[], y:[]},
            imageData = ctx.getImageData(0,0,canvas.width,canvas.height),
            x, y, index;

        for (y = 0; y < h; y++) {
            for (x = 0; x < w; x++) {
                index = (y * w + x) * 4;
                if (imageData.data[index+3] > 0) {
                    pix.x.push(x);
                    pix.y.push(y);
                }
            }
        }
        pix.x.sort(function(a,b){return a-b});
        pix.y.sort(function(a,b){return a-b});
        let n = pix.x.length-1;

        w = 1 + pix.x[n] - pix.x[0];
        h = 1 + pix.y[n] - pix.y[0];

        return{x:pix.x[0],y:pix.y[0],w:w,h:h};
    }

    me.activateFrame = function(index){
        console.log("Activating frame " + index);
        activeFrameIndex = index;
        activeLayerIndex = 0;
        cachedImage = undefined;
        activeLayer = currentFrame().layers[activeLayerIndex];
        EventBus.trigger(EVENT.layersChanged);
        EventBus.trigger(EVENT.imageContentChanged);
    }

    me.addLayer = addLayer;
    me.removeLayer = removeLayer;

    function handleUpload(files,target){
        console.log("file uploaded");
        if (files.length){
            var file = files[0];
            var detectType;
            var ext = file.name.split(".").pop().toLowerCase();
            if (ext === "info") detectType=true;


            var reader = new FileReader();
            reader.onload = function(){
                if (detectType){
                    console.log("Detecting type");
                    FileDetector.detect(file,reader.result).then(result=>{
                        if (target === "frame"){
                            if (Array.isArray(result)){
                                drawFrame(result[0]);
                            }else{
                                drawFrame(result);
                            }
                            drawFrame(image);
                        }else{
                            if (Array.isArray(result)){
                                newFile(result[0]);
                                addFrame(result[1]);
                            }else{
                                newFile(result)
                            }
                        }

                    });
                }else{
                    // load as Image, fallback to detectType if it fails
                    var image = new Image();
                    image.onload = function(){
                        URL.revokeObjectURL(this.src);
                        if (target === "frame"){
                            drawFrame(image);
                        }else{
                            newFile(image)
                        }
                    };
                    image.onerror = function(){
                        URL.revokeObjectURL(this.src);
                        console.log("File is not a default image type");
                        detectType = true;
                        reader.readAsArrayBuffer(file);
                    };
                    image.setAttribute('crossOrigin', '');
                    image.src = reader.result;
                }
            };
            if (detectType){
                reader.readAsArrayBuffer(file);
            }else{
                reader.readAsDataURL(file);
            }
        }
    }
    
    function newFile(image){
        Historyservice.clear();
        cachedImage = undefined;
        let w = 320;
        let h = 256;
        if (image){
            w = image.width;
            h = image.height;
        }
        currentFile = {
            width:  w,
            height: h,
            frames:[{
                layers:[]
            }]
        }
        activeFrameIndex = 0;
        activeLayerIndex = 0;
        addLayer();
        activeLayer = currentFrame().layers[0];
        activeLayer.clear();
        if (image){
            activeLayer.getContext().drawImage(image,0,0);
        }
        EventBus.trigger(EVENT.imageSizeChanged);
    }
    
    function addLayer(index){
        currentFrame().layers.push(Layer(currentFile.width,currentFile.height));
        EventBus.trigger(EVENT.layersChanged);
        return currentFrame().layers.length-1;
    }

    function removeLayer(index){
        if (typeof index === "undefined") index=activeLayerIndex;
        if (currentFrame().layers.length>1){
            currentFrame().layers.splice(index,1);
            if (activeLayerIndex>=currentFrame().layers.length) activeLayerIndex--;
            me.activateLayer(activeLayerIndex);
            EventBus.trigger(EVENT.imageContentChanged);
        }
    }

    function moveLayer(fromIndex,toIndex){
        console.error(fromIndex,toIndex);
        if (currentFrame().layers.length>1){
            if (toIndex>=currentFrame().layers.length) toIndex=currentFrame().layers.length-1;
            if (toIndex<0) toIndex=0;
            if (toIndex !== fromIndex){
                let layer = currentFrame().layers[fromIndex];
                currentFrame().layers.splice(fromIndex,1);
                currentFrame().layers.splice(toIndex,0,layer);
            }
            me.activateLayer(toIndex);
            EventBus.trigger(EVENT.imageContentChanged);
        }
    }

    function addFrame(image){
        let layer = Layer(currentFile.width,currentFile.height);
        currentFile.frames.push({
            layers:[layer ]
        })
        if (image){
            layer .getContext().drawImage(image,0,0);
        }
        EventBus.trigger(EVENT.imageSizeChanged);
    }

    function removeFrame(){
        if (currentFile.frames.length>1){
            currentFile.frames.splice(activeFrameIndex,1);
            if (activeFrameIndex>=currentFile.frames.length) activeFrameIndex--;
            me.activateFrame(activeFrameIndex);
            EventBus.trigger(EVENT.imageSizeChanged);
        }
    }

    function drawFrame(image){
        let layer = currentFrame().layers[0];
        layer.clear();
        layer.draw(image);
        EventBus.trigger(EVENT.layerContentChanged);
    }

    function currentFrame(){
        return currentFile.frames[activeFrameIndex];
    }

    EventBus.on(COMMAND.NEW,function(){
        newFile();
        //panels.forEach(panel=>panel.clear());
    });

    EventBus.on(COMMAND.SAVE,function(){
        me.save();
    });

    EventBus.on(COMMAND.RESIZE,function(){
        me.resize();
    });

    EventBus.on(COMMAND.RESAMPLE,function(){
        me.resample()
    });

    EventBus.on(COMMAND.INFO,function(){
        SidePanel.showInfo(currentFile);
    });

    EventBus.on(COMMAND.NEWLAYER,function(){
        SidePanel.show();
        addLayer();
    });

    EventBus.on(COMMAND.DELETELAYER,function(){
        removeLayer();
    });

    EventBus.on(COMMAND.DUPLICATELAYER,function(){
        let layer = currentFrame().layers[activeLayerIndex];
        let newLayer = Layer(currentFile.width,currentFile.height);
        newLayer.opacity = layer.opacity;
        newLayer.draw(layer.getCanvas());
        currentFrame().layers.splice(activeLayerIndex,0,newLayer);
        me.activateLayer(activeLayerIndex++);
    });

    EventBus.on(COMMAND.LAYERUP,function(index){
        if (typeof index === "undefined") index=activeLayerIndex;
        let fromIndex = index;
        let toIndex = fromIndex+1;
        moveLayer(fromIndex,toIndex);
    });

    EventBus.on(COMMAND.LAYERDOWN,function(index){
        if (typeof index === "undefined") index=activeLayerIndex;
        let fromIndex = index;
        let toIndex = fromIndex-1;
        moveLayer(fromIndex,toIndex);
    });

    EventBus.on(COMMAND.MERGEDOWN,function(index){
        if (typeof index !== "number") index = activeLayerIndex;
        let layer = currentFrame().layers[index];
        let belowLayer = currentFrame().layers[index-1];
        if (layer && belowLayer){
            let ctx = belowLayer.getContext();
            ctx.globalAlpha = layer.opacity;
            let blendMode = layer.blendMode || "normal";
            if (blendMode === "normal") blendMode = "source-over";
            ctx.globalCompositeOperation = blendMode;
            belowLayer.draw(layer.getCanvas(),0,0);
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = "source-over";
            currentFrame().layers.splice(index,1);
            me.activateLayer(index-1);
        }
    });

    EventBus.on(COMMAND.FLATTEN,function(index){
        if (currentFrame().layers.length>1){
            let canvas = me.getCanvas();
            currentFrame().layers.splice(0,currentFrame().layers.length-1);
            let layer = currentFrame().layers[0];
            if (layer){
                layer.clear();
                layer.draw(canvas,0,0);
            }
            me.activateLayer(0);
            EventBus.trigger(EVENT.imageContentChanged);
        }
    });

    EventBus.on(COMMAND.ADDFRAME,function(){
        SidePanel.show();
        addFrame();
    });

    EventBus.on(COMMAND.DELETEFRAME,function(){
        removeFrame();
    });

    EventBus.on(COMMAND.IMPORTFRAME,function(){
        var input = document.createElement('input');
        input.type = 'file';
        input.onchange = function(e){
            handleUpload(e.target.files,"frame");
        };
        input.click();
    });

    EventBus.on(EVENT.layerContentChanged,function(){
        me.render();
        EventBus.trigger(EVENT.imageContentChanged);
    });

    return me;
}();

export default ImageFile;