import FileDetector from "./fileformats/detect.js";
import EventBus from "./util/eventbus.js";
import {COMMAND, EVENT} from "./enum.js";
import Historyservice from "./services/historyservice.js";
import Layer from "./ui/layer.js";
import Modal, {DIALOG} from "./ui/modal.js";
import SidePanel from "./ui/sidepanel.js";
import {duplicateCanvas, releaseCanvas} from "./util/canvasUtils.js";
import Palette from "./ui/palette.js";
import SaveDialog from "./ui/components/saveDialog.js";

let ImageFile = function(){
   let me = {};
    let activeLayer;
    let activeLayerIndex = 0;
    let activeFrameIndex = 0;
    let cachedImage;
    let currentFile = {
        name:"Untitled",
        layers:[]
    }

    me.getCurrentFile = function(){
        return currentFile;
    }

    me.getName = function(){
        return currentFile.name || "Untitled";
    }

    me.setName = function(name){
        currentFile.name = name;
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
                return frame.layers[0].render();
            }else{
                if (activeLayer && activeLayer.visible){
                    return activeLayer.render();
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
                    ctx.drawImage(layer.render(),0,0);
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

    me.getActiveFrame = function(){
        return currentFrame();
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
            let anchor = properties.anchor || "topleft";
            let pW = currentFile.width;
            let pH = currentFile.height;
            currentFile.width = w;
            currentFile.height = h;
            let aX = Math.round((w-pW)/2);
            let aY = Math.round((h-pH)/2);
            if (anchor.indexOf("top")>=0) aY = 0;
            if (anchor.indexOf("bottom")>=0) aY = h-pH;
            if (anchor.indexOf("left")>=0) aX = 0;
            if (anchor.indexOf("right")>=0) aX = w-pW;
            console.log("Resizing image to " +w + "x" + h);
            currentFile.frames.forEach(frame=>{
                frame.layers.forEach(layer=>{
                    // TODO: what about mask canvas and dither canvas ?
                    let canvas = layer.getCanvas();
                    let ctx = layer.getContext();
                    let d = duplicateCanvas(canvas,true);
                    canvas.width = w;
                    canvas.height = h;
                    ctx.drawImage(d,aX,aY);
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
                    let d = duplicateCanvas(canvas,true);
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

    me.duplicateLayer = function(index){
        if (typeof index !== "number") index = activeLayerIndex;
        let layer = currentFrame().layers[index];
        let newLayer = Layer(currentFile.width,currentFile.height,layer.name + " duplicate");
        newLayer.opacity = layer.opacity;
        newLayer.blendMode = layer.blendMode;
        newLayer.drawImage(layer.getCanvas());
        currentFrame().layers.splice(index+1,0,newLayer);
        me.activateLayer(index+1);
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
        if (typeof layerIndex === "number") layer = currentFrame().layers[layerIndex];

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

    me.clone = function(){
        let struct = {
            type: "dpaint",
            image: {}
        }

        struct.image.name = currentFile.name;
        struct.image.width = currentFile.width;
        struct.image.height = currentFile.height;
        struct.image.frames=[];

        currentFile.frames.forEach(frame=>{
            let _frame={layers:[]};
            frame.layers.forEach(layer=>{
                let _layer={
                    blendMode: layer.blendMode,
                    name: layer.name,
                    opacity: layer.opacity,
                    visible: layer.visible,
                    canvas: layer.getCanvas().toDataURL()
                }
                _frame.layers.push(_layer);
            });
            struct.image.frames.push(_frame);
        })

        return struct;
    }

    me.restore = function(data){
        let image = data.image;
        currentFile.width = image.width;
        currentFile.height = image.height;
        let mockImage = new Image(currentFile.width,currentFile.height);
        newFile(mockImage,currentFile.name,currentFile.type);
        currentFile.name = image.name || "Untitled";
        image.frames.forEach((_frame,frameIndex)=>{
            let frame = currentFile.frames[frameIndex];
            if (!frame){
                addFrame();
                frame = currentFile.frames[frameIndex];
            }
            _frame.layers.forEach((_layer,layerIndex)=>{
                let layer = frame.layers[layerIndex];
                if (!layer){
                    layer = Layer(currentFile.width,currentFile.height);
                    frame.layers.push(layer);
                }
                layer.name = _layer.name;
                layer.opacity = _layer.opacity;
                layer.blendMode = _layer.blendMode;
                layer.visible = _layer.visible;
                let _image = new Image();
                _image.onload = function () {
                    layer.drawImage(_image);
                    EventBus.trigger(EVENT.layersChanged);
                    EventBus.trigger(EVENT.imageSizeChanged);
                }
                _image.src = _layer.canvas;
            });
        })
    }

    me.addLayer = addLayer;
    me.removeLayer = removeLayer;
    me.moveLayer = moveLayer;

    function handleUpload(files,target){
        console.log("file uploaded");
        if (files.length){
            var file = files[0];
            var detectType;
            var isText;
            var fileName = file.name.split(".");
            var ext = fileName.pop().toLowerCase();
            fileName = fileName.join(".");

            if (ext === "info") detectType=true;
            if (ext === "json") isText=true;


            var reader = new FileReader();
            reader.onload = function(){
                if (detectType) {
                    console.log("Detecting type");
                    me.handleBinary(reader.result,file.name,target);
                }else if (isText){
                    let data={};
                    if (ext === "json"){
                        try {data=JSON.parse(reader.result)}catch (e){console.error("Can't parse JSON")};
                    }
                    if (data){
                        if (data.type==="dpaint"){
                            me.restore(data);
                        }
                        if (data.type==="palette"){
                            Palette.set(data.palette);
                        }
                    }
                }else{
                    // load as Image, fallback to detectType if it fails
                    var image = new Image();
                    image.onload = function(){
                        URL.revokeObjectURL(this.src);
                        if (target === "frame"){
                            drawFrame(image,fileName);
                        }else{
                            newFile(image,fileName)
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
            if (isText){
                reader.readAsText(file);
            }else if (detectType){
                reader.readAsArrayBuffer(file);
            }else{
                reader.readAsDataURL(file);
            }
            SaveDialog.setFile();
        }
    }
    me.handleUpload = handleUpload;

    me.handleBinary = function(data,name,target,stillTryImage){
        name = name || "";
        let fileName = name.split(".");
        let ext = fileName.pop().toLowerCase();
        fileName = fileName.join(".");

        FileDetector.detect(data,name).then(result => {
            if (result){
                currentFile.originalType = result.type;
                let image = result.image;
                if (target === "frame") {
                    if (Array.isArray(image)) {
                        drawFrame(image[0],fileName);
                    } else {
                        drawFrame(image,fileName);
                    }
                    //drawFrame(image,fileName);
                } else {
                    if (Array.isArray(image)) {
                        newFile(image[0],fileName,currentFile.originalType);
                        addFrame(image[1]);
                    } else {
                        newFile(image,fileName,currentFile.originalType)
                    }
                }
            }else{
                console.log("Can't detect file type");
                if (stillTryImage){
                    // happens when the file is not coming from a file upload
                    var image = new Image();
                    image.onload = function(){
                        URL.revokeObjectURL(this.src);
                        if (target === "frame"){
                            drawFrame(image,fileName);
                        }else{
                            newFile(image,fileName,currentFile.originalType)
                        }
                    };
                    image.onerror = function(){
                        URL.revokeObjectURL(this.src);
                        console.log("File is not a default image type");
                    };
                    image.setAttribute('crossOrigin', '');
                    var arrayBufferView = new Uint8Array( data );
                    var blob = new Blob( [ arrayBufferView ], { type: "image/png" } );
                    image.src = URL.createObjectURL( blob );
                }
            }
        });
    }
    
    function newFile(image,fileName,type){
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
            name: fileName || "Untitled",
            frames:[{
                layers:[]
            }]
        }
        if (type) currentFile.originalType = type;
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
    
    function addLayer(index,name){
        let newLayer = Layer(currentFile.width,currentFile.height,name || "Layer " + (currentFrame().layers.length+1));
        let newIndex = currentFrame().layers.length;

        if (typeof index === "undefined"){
            currentFrame().layers.push(newLayer);
        }else{
            currentFrame().layers.splice(index,0,newLayer);
            newIndex = index;
        }
        EventBus.trigger(EVENT.layersChanged);
        return newIndex;
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
            layers:[layer]
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

    function drawFrame(image,fileName){
        let layerIndex = me.addLayer(0,fileName);
        let layer = me.getLayer(layerIndex);
        layer.clear();
        layer.drawImage(image);
        me.activateLayer(layerIndex);
        EventBus.trigger(EVENT.layerContentChanged);
    }

    function currentFrame(){
        return currentFile.frames[activeFrameIndex];
    }

    me.mergeDown = function(index){
        if (typeof index !== "number") index = activeLayerIndex;
        let layer = currentFrame().layers[index];
        let belowLayer = currentFrame().layers[index-1];
        if (layer && belowLayer){
            if (layer.hasMask){
                layer.removeMask(true);
            }
            let ctx = belowLayer.getContext();
            ctx.globalAlpha = layer.opacity;
            let blendMode = layer.blendMode || "normal";
            if (blendMode === "normal") blendMode = "source-over";
            ctx.globalCompositeOperation = blendMode;
            belowLayer.drawImage(layer.getCanvas(),0,0);
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = "source-over";
            currentFrame().layers.splice(index,1);
            EventBus.trigger(EVENT.layerContentChanged);
            me.activateLayer(index-1);
        }
    }

    me.paste = function(image){
        let w= ImageFile.getCurrentFile().width;
        let h= ImageFile.getCurrentFile().height;

        function doPaste(){
            let index = me.addLayer();
            me.activateLayer(index);
            me.getActiveLayer().drawImage(image,0,0);
            EventBus.trigger(EVENT.layerContentChanged);
        }

        if (image && (image.width>w || image.height>h)){
            Modal.show(DIALOG.OPTION,{
                title: "Paste Image",
                width: 320,
                text:"The image you are pasting is larger than the current canvas. What do you want to do?",
                buttons:[
                    {label: "Keep the canvas at " + w + "x" + h + " pixels", onclick: doPaste},
                    {label: "Enlarge the canvas to " + image.width + "x" + image.height + " pixels", onclick: ()=>{
                        me.resize({width: image.width, height: image.height});
                        doPaste();
                    }},
                    {label: "Cancel"}
                ]
            })
        }else{
            doPaste();
        }
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
        me.duplicateLayer();
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
        me.mergeDown(index);
    });

    EventBus.on(COMMAND.FLATTEN,function(){
        currentFrame().layers.forEach(layer=>{
            console.log(layer.hasMask);
            if (layer.hasMask){
                layer.removeMask(true);
                EventBus.trigger(EVENT.layersChanged);
            }
        });


        if (currentFrame().layers.length>1){
            let canvas = me.getCanvas();
            currentFrame().layers.splice(0,currentFrame().layers.length-1);
            let layer = currentFrame().layers[0];
            if (layer){
                layer.clear();
                layer.drawImage(canvas,0,0);
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

    EventBus.on(EVENT.layerContentChanged,function(keepImageCache){
        if (!keepImageCache) cachedImage = undefined;
        if (activeLayer) activeLayer.update();
        me.render();
        EventBus.trigger(EVENT.imageContentChanged);
    });

    EventBus.on(EVENT.imageSizeChanged,()=>{
        cachedImage = undefined;
    })

    return me;
}();

export default ImageFile;