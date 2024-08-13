import FileDetector from "./fileformats/detect.js";
import EventBus from "./util/eventbus.js";
import {COMMAND,EVENT} from "./enum.js";
import Historyservice from "./services/historyservice.js";
import Layer from "./ui/layer.js";
import Modal,{DIALOG} from "./ui/modal.js";
import SidePanel from "./ui/sidepanel.js";
import {duplicateCanvas, indexPixelsToPalette, releaseCanvas} from "./util/canvasUtils.js";
import Palette from "./ui/palette.js";
import SaveDialog from "./ui/components/saveDialog.js";
import HistoryService from "./services/historyservice.js";
import ImageProcessing from "./util/imageProcessing.js";
import Brush from "./ui/brush.js";
import storage from "./util/storage.js";

let ImageFile = function(){
    let me = {};
    let activeLayer;
    let activeLayerIndex = 0;
    let activeFrameIndex = 0;
    let cachedImage;
    let currentFile = {
        name: "Untitled",
        layers: [],
    };
    let autoSaveTimer;

    me.getCurrentFile = function(){
        return currentFile;
    };

    me.getName = function(){
        return currentFile.name || "Untitled";
    };

    me.setName = function(name){
        currentFile.name = name;
    };

    me.getOriginal = function(){
        if (!cachedImage) {
            console.error("caching image");
            cachedImage = document.createElement("canvas");
            let img = me.getCanvas();
            cachedImage.width = img.width;
            cachedImage.height = img.height;
            cachedImage.getContext("2d").drawImage(img, 0, 0);
        }
        return cachedImage;
    };

    me.restoreOriginal = function(){
        if (cachedImage) {
            let ctx = me.getActiveContext();
            ctx.clearRect(0, 0, currentFile.width, currentFile.height);
            ctx.drawImage(cachedImage, 0, 0);
            EventBus.trigger(EVENT.imageContentChanged);
        }
    };

    me.getCanvas = function(frameIndex){
        let frame =
            typeof frameIndex === "number"
                ? currentFile.frames[frameIndex]
                : currentFrame();
        if (!frame) return;
        if (frame.layers.length === 1) {
            if (typeof frameIndex === "number") {
                return frame.layers[0].render();
            } else {
                if (activeLayer && activeLayer.visible) {
                    return activeLayer.render();
                }
            }
        } else {
            let canvas = document.createElement("canvas");
            let ctx = canvas.getContext("2d");
            canvas.width = currentFile.width;
            canvas.height = currentFile.height;
            frame.layers.forEach((layer) => {
                if (layer.visible) {
                    ctx.globalAlpha = layer.opacity / 100;
                    let blendMode = layer.blendMode || "normal";
                    if (blendMode === "normal") blendMode = "source-over";
                    ctx.globalCompositeOperation = blendMode;
                    ctx.drawImage(layer.render(), 0, 0);
                    ctx.globalAlpha = 1;
                    ctx.globalCompositeOperation = "source-over";
                }
            });
            return canvas;
        }
    };

    me.getContext = function(){
        if (currentFrame().layers.length === 1 && activeLayer) {
            return activeLayer.getContext();
        }else{
            return me.getCanvas().getContext("2d");
        }
    };

    me.getActiveContext = function(){
        if (activeLayer) return activeLayer.getContext();
    };

    me.getActiveLayerIndex = function(){
        return activeLayerIndex;
    };

    me.getActiveLayer = function(){
        return activeLayer;
    };

    me.getLayer = function(index){
        let frame = currentFile.frames[activeFrameIndex];
        return frame ? frame.layers[index] : undefined;
    };

    me.getLayerIndexesOfType = function(type){
        let frame = currentFile.frames[activeFrameIndex];
        let result = [];
        if (frame) {
            frame.layers.forEach((layer, index) => {
                if (layer.type === type) result.push(index);
            });
        }
        return result;
    };

    me.getActiveFrameIndex = function(){
        return activeFrameIndex;
    };

    me.getActiveFrame = function(){
        return currentFrame();
    };

    me.render = function(){
        if (currentFrame().layers.length>1){

        }
    }

    me.openLocal = function(target){
        stop();
        var input = document.createElement("input");
        input.type = "file";
        input.onchange = function (e) {
            handleUpload(e.target.files, target || "file");
        };
        input.click();
    };

    me.openUrl = function(url,useProxy){
        stop();
        return new Promise((resolve,reject)=>{
            let fileName = url.substring(url.lastIndexOf("/")+1);
            let extension = fileName.substring(fileName.lastIndexOf(".")+1).toLowerCase();
            fetch(url).then(response=>{
                if (extension === "json"){
                    response.json().then(json=>{
                        me.handleJSON(json);
                        resolve();
                    })
                }else{
                    response.blob().then(blob=>{
                        blob.arrayBuffer().then(buffer=>{
                            me.handleBinary(buffer, fileName, "file",true);
                            resolve();
                        })
                    })
                }
            }).catch(err=>{
                if (!useProxy){
                    // probably a CORS error
                    url = "https://www.stef.be/bassoontracker/api/proxy/?"+encodeURIComponent(url);
                    me.openUrl(url,true).then(resolve).catch(reject);
                }else{
                    console.error(err);
                    reject(err);
                }
            })
        });
    }

    me.save = function(){
        Modal.show(DIALOG.SAVE);
    };

    me.resize = function(properties){
        if (!properties) {
            Modal.show(DIALOG.RESIZE);
        } else {
            let w = properties.width;
            let h = properties.height;
            let anchor = properties.anchor || "topleft";
            let pW = currentFile.width;
            let pH = currentFile.height;
            currentFile.width = w;
            currentFile.height = h;
            let aX = Math.round((w - pW) / 2);
            let aY = Math.round((h - pH) / 2);
            if (anchor.indexOf("top") >= 0) aY = 0;
            if (anchor.indexOf("bottom") >= 0) aY = h - pH;
            if (anchor.indexOf("left") >= 0) aX = 0;
            if (anchor.indexOf("right") >= 0) aX = w - pW;
            console.log("Resizing image to " +w + "x" + h);
            currentFile.frames.forEach(frame=>{
                frame.layers.forEach(layer=>{
                    // TODO: what about mask canvas and dither canvas ?
                    let canvas = layer.getCanvas();
                    let ctx = layer.getContext();
                    let d = duplicateCanvas(canvas, true);
                    canvas.width = w;
                    canvas.height = h;
                    ctx.drawImage(d, aX, aY);
                    releaseCanvas(d);
                });
            });
            EventBus.trigger(EVENT.imageSizeChanged);
        }
    };

    me.resample = function(properties){
        if (!properties) {
            Modal.show(DIALOG.RESAMPLE);
        } else {
            let w = properties.width;
            let h = properties.height;
            if (w === currentFile.width && h === currentFile.height) return;
            let quality = properties.quality || "pixelated";
            HistoryService.start(EVENT.imageHistory);
            currentFile.width = w;
            currentFile.height = h;
            let todo = 0;
            let done = 0;
            currentFile.frames.forEach((frame) => {
                todo += frame.layers.length;
            });

            currentFile.frames.forEach((frame) => {
                frame.layers.forEach((layer) => {
                    let canvas = layer.getCanvas();
                    let ctx = layer.getContext();

                    if (quality === "pixelated") {
                        let d = duplicateCanvas(canvas, true);
                        canvas.width = w;
                        canvas.height = h;
                        ctx.webkitImageSmoothingEnabled = false;
                        ctx.mozImageSmoothingEnabled = false;
                        ctx.imageSmoothingEnabled = false;
                        ctx.drawImage(d, 0, 0, d.width, d.height, 0, 0, w, h);
                        releaseCanvas(d);
                        done++;
                        if (done >= todo) {
                            HistoryService.end();
                            EventBus.trigger(EVENT.imageSizeChanged);
                        }
                    } else {
                        let imageData = ctx.getImageData(
                            0,
                            0,
                            canvas.width,
                            canvas.height
                        );
                        let result;
                        if (imageData.width > w && imageData.height > h) {
                            result = ImageProcessing.downScale(imageData, w, h);
                        } else {
                            result = ImageProcessing.biCubic(imageData, w, h);
                        }
                        canvas.width = w;
                        canvas.height = h;
                        ctx.putImageData(result, 0, 0);
                        done++;
                        if (done >= todo) {
                            HistoryService.end();
                            EventBus.trigger(EVENT.imageSizeChanged);
                        }
                    }
                });
            });
        }
    };

    me.activateLayer = function(index){
        activeLayerIndex = index;
        activeLayer = currentFrame().layers[activeLayerIndex];
        EventBus.trigger(EVENT.layersChanged);
    };

    me.toggleLayer = function(index){
        currentFrame().layers[index].visible =
            !currentFrame().layers[index].visible;
        EventBus.trigger(EVENT.layersChanged);
        EventBus.trigger(EVENT.imageContentChanged);
    };

    me.duplicateLayer = function(index){
        if (typeof index !== "number") index = activeLayerIndex;
        let layer = currentFrame().layers[index];
        let newLayer = Layer(
            currentFile.width,
            currentFile.height,
            layer.name + " duplicate"
        );
        newLayer.opacity = layer.opacity;
        newLayer.blendMode = layer.blendMode;
        newLayer.drawImage(layer.getCanvas());
        currentFrame().layers.splice(index + 1, 0, newLayer);
        me.activateLayer(index + 1);
    };

    me.flipLayer = function(index, horizontal){
        if (typeof index !== "number") index = activeLayerIndex;
        let layer = currentFrame().layers[index];
        if (layer) {
            let canvas = duplicateCanvas(layer.getCanvas(), true);
            let ctx = layer.getContext();
            layer.clear();
            if (horizontal) {
                ctx.translate(canvas.width, 0);
                ctx.scale(-1, 1);
            }else{
                ctx.translate(0, canvas.height);
                ctx.scale(1, -1);
            }
            ctx.drawImage(canvas, 0, 0);
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            releaseCanvas(canvas);

            EventBus.trigger(EVENT.layerContentChanged);
        }
    }

    me.setLayerOpacity = function(value){
        if (activeLayer) {
            activeLayer.opacity = value;
            EventBus.trigger(EVENT.imageContentChanged);
        }
    };

    me.setLayerBlendMode = function(value){
        if (activeLayer) {
            activeLayer.blendMode = value;
            EventBus.trigger(EVENT.imageContentChanged);
        }
    };

    me.getLayerBoundingRect = function(layerIndex){
        let layer = activeLayer;
        if (typeof layerIndex === "number") {
            layer = currentFrame().layers[layerIndex];
        }

        let ctx = layer.getContext();
        let canvas = ctx.canvas;
        let w = canvas.width,
            h = canvas.height,
            pix = { x: [], y: [] },
            imageData = ctx.getImageData(0, 0, canvas.width, canvas.height),
            x,
            y,
            index;

        for (y = 0; y < h; y++) {
            for (x = 0; x < w; x++) {
                index = (y * w + x) * 4;
                if (imageData.data[index + 3] > 0) {
                    pix.x.push(x);
                    pix.y.push(y);
                }
            }
        }
        pix.x.sort(function (a, b) {
            return a - b;
        });
        pix.y.sort(function (a, b) {
            return a - b;
        });
        let n = pix.x.length - 1;

        w = 1 + pix.x[n] - pix.x[0];
        h = 1 + pix.y[n] - pix.y[0];

        return { x: pix.x[0], y: pix.y[0], w: w, h: h };
    };

    me.activateFrame = function(index){
        let frame = currentFile.frames[activeFrameIndex];
        if (frame) frame.activeLayerIndex = activeLayerIndex;

        frame = currentFile.frames[index];
        if (frame)  activeLayerIndex = frame.activeLayerIndex || 0;
        activeFrameIndex = index;
        cachedImage = undefined;
        activeLayer = currentFrame().layers[activeLayerIndex];
        EventBus.trigger(EVENT.layersChanged);
        EventBus.trigger(EVENT.imageContentChanged);
        EventBus.trigger(EVENT.framesChanged);
    };

    me.nextFrame = function(offset){
        offset = offset || 1;
        let frame = activeFrameIndex + offset;
        if (frame < 0) frame = currentFile.frames.length - 1;
        if (frame >= currentFile.frames.length) frame = 0;
        me.activateFrame(frame);
    }

    me.clone = function(indexed){
        let struct = {
            type: "dpaint",
            version: "1",
            image: {},
        };

        struct.image.name = currentFile.name;
        struct.image.width = currentFile.width;
        struct.image.height = currentFile.height;
        struct.image.activeLayerIndex = activeLayerIndex;
        struct.image.activeFrameIndex = activeFrameIndex;
        struct.image.frames = [];
        struct.errorCount = 0;

        currentFile.frames.forEach((frame) => {
            let _frame = {
                layers: [],
                activeLayerIndex: frame.activeLayerIndex || 0
            };
            frame.layers.forEach((layer) => {
                let _layer = layer.clone(true, indexed);
                struct.errorCount += (_layer.conversionErrors || 0);
                _frame.layers.push(_layer);
            });
            struct.image.frames.push(_frame);
        });

        if (currentFile.colorRange) struct.image.colorRange = currentFile.colorRange;

        return struct;
    };

    me.restore = function(data){
        let image = data.image;
        currentFile.width = image.width;
        currentFile.height = image.height;
        let mockImage = new Image(currentFile.width, currentFile.height);
        newFile(mockImage, currentFile.name, currentFile.type);
        currentFile.name = image.name || "Untitled";
        image.frames.forEach((_frame, frameIndex) => {
            let frame = currentFile.frames[frameIndex];
            if (!frame) {
                addFrame();
                frame = currentFile.frames[frameIndex];
            }
            frame.activeLayerIndex = _frame.activeLayerIndex || 0;
            _frame.layers.forEach((_layer, layerIndex) => {
                let layer = frame.layers[layerIndex];
                if (!layer) {
                    layer = Layer(currentFile.width, currentFile.height);
                    frame.layers.push(layer);
                }
                layer.restore(_layer).then(() => {

                    if (frame.activeLayerIndex === layerIndex && image.activeFrameIndex === frameIndex) {
                        me.activateFrame(frameIndex);
                        me.activateLayer(layerIndex);
                    }
                    EventBus.trigger(EVENT.layersChanged);
                    EventBus.trigger(EVENT.imageSizeChanged);
                });
            });
        });

        if (image.colorRange) currentFile.colorRange = image.colorRange;

        if (data.palette) Palette.set(data.palette);

        if (data.paletteList){
            Palette.setPaletteList(data.paletteList);
            Palette.setPaletteIndex(data.paletteIndex);
        }

    };

    me.export = function(indexed){
        let struct = me.clone(indexed);

        struct.palette = Palette.get();
        let paletteList = Palette.getPaletteList();
        if (paletteList.length>1){
            struct.paletteList = paletteList;
            struct.paletteIndex = Palette.getPaletteIndex();
        }

        if (currentFile.colorRange) struct.colorRange = currentFile.colorRange;
        if (currentFile.indexedPixels){
            struct.indexedPixels = currentFile.indexedPixels;
        }else{
            if (indexed){
                struct.indexedPixels = me.generateIndexedPixels();
            }
        }
        console.log(struct);
        return struct;
    }

    me.autoSave = function(){
        let data = me.export();
        storage.putFile("autosave",data);
    }
    window.autoSave = me.autoSave;

    me.restoreAutoSave = function(){
        storage.getFile("autosave").then(data=>{
            if (data) me.restore(data);
        });
    }

    function autoSave(){
        if (autoSaveTimer) clearTimeout(autoSaveTimer);
        autoSaveTimer = setTimeout(me.autoSave,1000);
    }

    me.addLayer = addLayer;
    me.removeLayer = removeLayer;
    me.moveLayer = moveLayer;

    me.hasMultipleFrames = function(){
        return currentFile.frames.length > 1;
    }

    function handleUpload(files,target){
        stop();
        if (files.length) {
            var file = files[0];
            var detectType;
            var isText;
            var fileName = file.name.split(".");
            var ext = fileName.pop().toLowerCase();
            fileName = fileName.join(".");

            if (ext === "info") detectType = true;
            if (ext === "gif") detectType = true;
            if (ext === "png") detectType = true;
            if (ext === "json") isText = true;

            var reader = new FileReader();
            reader.onload = function(){
                if (detectType) {
                    me.handleBinary(reader.result, file.name, target,true);
                } else if (isText) {
                    let data = {};
                    if (ext === "json") {
                        try {
                            data = JSON.parse(reader.result);
                        } catch (e) {
                            console.error("Can't parse JSON");
                        }
                    }
                    if (data) {
                        me.handleJSON(data,target);
                    }
                } else {
                    // load as Image, fallback to detectType if it fails
                    var image = new Image();
                    image.onload = function(){
                        URL.revokeObjectURL(this.src);
                        handleOpenedImage(image,fileName,target)
                    };
                    image.onerror = function(){
                        URL.revokeObjectURL(this.src);
                        detectType = true;
                        reader.readAsArrayBuffer(file);
                    };
                    image.setAttribute("crossOrigin", "");
                    image.src = reader.result;
                }
            };
            if (isText) {
                reader.readAsText(file);
            } else if (detectType) {
                reader.readAsArrayBuffer(file);
            } else {
                reader.readAsDataURL(file);
            }
            SaveDialog.setFile();
        }
    }
    me.handleUpload = handleUpload;

    me.handleBinary = function (data,name,target,stillTryImage){
        let now = performance.now();

        name = name || "";
        let fileName = name.split(".");
        fileName = fileName.join(".");
        console.log("Loading file: ", fileName);

        FileDetector.detect(data, name).then((result) => {
            console.log(" FileDetector: ", result);
            if (result) {
                currentFile.originalType = result.type;
                currentFile.originalData = result.data;
                if (result.data) {
                    if (
                        result.data.xAspect &&
                        result.data.yAspect &&
                        result.data.xAspect !== result.data.yAspect
                    ) {
                        console.warn(
                            "Aspect ratio is not square! -> " +
                                result.data.xAspect / result.data.yAspect
                        );
                    }

                    if (result.data.palette && target==="file") {
                        Palette.set(result.data.palette);
                    }

                    if (result.data.colourRange) {
                        console.log(
                            "Image has color cycling: ",
                            result.data.colourRange
                        );
                    }
                }
                let image = result.image;
                handleOpenedImage(image,fileName,target);

                let time = performance.now() - now;
                console.log("File loaded in " + time + "ms");
            } else {
                if (stillTryImage) {
                    // happens when the file is not coming from a file upload
                    var image = new Image();
                    image.onload = function(){
                        URL.revokeObjectURL(this.src);
                        handleOpenedImage(image,fileName,target);
                    };
                    image.onerror = function(){
                        URL.revokeObjectURL(this.src);
                        console.error("File is not a default image type");
                    };
                    image.setAttribute("crossOrigin", "");
                    var arrayBufferView = new Uint8Array(data);
                    var blob = new Blob([arrayBufferView], {
                        type: "image/png",
                    });
                    image.src = URL.createObjectURL(blob);
                }
            }
        });
    };

    me.handleJSON = function(data,target){
        if (data.type === "dpaint") {

            if (target==="file"){
                if (data.palette) Palette.set(data.palette);

                if (data.paletteList){
                    Palette.setPaletteList(data.paletteList);
                    Palette.setPaletteIndex(data.paletteIndex);
                }

                if (data.colorRange){
                    currentFile.colorRange = data.colorRange;
                }
            }

            switch (target){
                case "frame":
                    break;
                case "brush":
                    Brush.import(data);
                    break;
                default:
                    me.restore(data);
            }
        }
        if (data.type === "palette") {
            Palette.set(data.palette);
        }
    }

    function handleOpenedImage(image,fileName,target){
        switch (target){
            case "frame":
                if (Array.isArray(image)) {
                    drawFrame(image[0], fileName);
                } else {
                    drawFrame(image, fileName);
                }
                break;
            case "brush":
                Brush.import(image);
                break;
            default:
                if (Array.isArray(image)) {
                    newFile(image[0],fileName,currentFile.originalType,currentFile.originalData);
                    EventBus.hold();
                    for (let i = 1; i < image.length; i++) addFrame(image[i]);
                    EventBus.release();
                    EventBus.trigger(EVENT.framesChanged);
                } else {
                    newFile(image,fileName,currentFile.originalType,currentFile.originalData)
                }
        }
    }

    function newFile(image,fileName,type,originalData){
        Historyservice.clear();
        cachedImage = undefined;
        let w = 320;
        let h = 256;
        if (image) {
            w = image.width;
            h = image.height;
        }
        currentFile = {
            width: w,
            height: h,
            name: fileName || "Untitled",
            frames:[{
                layers:[]
            }],
            colorRange:[]
        }
        if (type) currentFile.originalType = type;
        if (originalData){
            if (originalData.palette) currentFile.palette = originalData.palette;
            if (originalData.colourRange) currentFile.colorRange = originalData.colourRange;
            if (originalData.pixels) currentFile.indexedPixels = originalData.pixels;
            currentFile.originalData = originalData;
        }
        activeFrameIndex = 0;
        activeLayerIndex = 0;
        addLayer();
        activeLayer = currentFrame().layers[0];
        activeLayer.clear();
        if (image) {
            activeLayer.getContext().drawImage(image, 0, 0);
        }
        EventBus.trigger(EVENT.imageSizeChanged);
    }

    function addLayer(index,name,options){
        let newLayer = Layer(
            currentFile.width,
            currentFile.height,
            name || "Layer " + (currentFrame().layers.length + 1)
        );
        let newIndex = currentFrame().layers.length;
        if (options){
            if (options.locked) newLayer.locked = true;
            if (options.internal) newLayer.internal = true;
        }

        if (typeof index === "undefined") {
            currentFrame().layers.push(newLayer);
        } else {
            currentFrame().layers.splice(index, 0, newLayer);
            newIndex = index;
        }
        EventBus.trigger(EVENT.layersChanged);
        return newIndex;
    }

    function removeLayer(index){
        if (typeof index === "undefined") index = activeLayerIndex;
        if (currentFrame().layers.length > 1) {
            currentFrame().layers.splice(index, 1);
            if (activeLayerIndex >= currentFrame().layers.length) {
                activeLayerIndex--;
            }
            me.activateLayer(activeLayerIndex);
            EventBus.trigger(EVENT.imageContentChanged);
        }
    }

    function moveLayer(fromIndex,toIndex){
        if (currentFrame().layers.length > 1) {
            if (toIndex >= currentFrame().layers.length) {
                toIndex = currentFrame().layers.length - 1;
            }
            if (toIndex < 0) toIndex = 0;
            if (toIndex !== fromIndex) {
                let layer = currentFrame().layers[fromIndex];
                currentFrame().layers.splice(fromIndex, 1);
                currentFrame().layers.splice(toIndex, 0, layer);
            }
            me.activateLayer(toIndex);
            EventBus.trigger(EVENT.imageContentChanged);
        }
    }

    function addFrame(image){
        let layer = Layer(currentFile.width, currentFile.height, "Layer 1");
        currentFile.frames.push({
            layers: [layer],
        });
        if (image) {
            if (image.placeholder){
                layer.placeholder = true;
            }else{
                if (image.width) layer.getContext().drawImage(image, 0, 0);
            }
        }
        //console.error(image);
        //EventBus.trigger(EVENT.imageSizeChanged);
    }

    function removeFrame(){
        if (currentFile.frames.length > 1) {
            HistoryService.start(EVENT.imageHistory);
            currentFile.frames.splice(activeFrameIndex, 1);
            if (activeFrameIndex >= currentFile.frames.length) {
                activeFrameIndex--;
            }
            Historyservice.end();
            me.activateFrame(activeFrameIndex);
            EventBus.trigger(EVENT.imageSizeChanged);
        }
    }

    function drawFrame(image,fileName){
        let layerIndex = me.addLayer(0, fileName);
        let layer = me.getLayer(layerIndex);
        layer.clear();
        layer.drawImage(image);
        me.activateLayer(layerIndex);
        EventBus.trigger(EVENT.layerContentChanged);
    }

    function currentFrame(){
        return currentFile.frames[activeFrameIndex];
    }

    function stop(){
        if (Palette.isCycling()) EventBus.trigger(COMMAND.CYCLEPALETTE);
    }

    me.duplicateFrame = function(index){
        HistoryService.start(EVENT.imageHistory);
        if (typeof index !== "number") index = activeFrameIndex;
        let layers = currentFrame().layers;
        let newFrame = { layers: [] };
        layers.forEach((layer) => {
            let newLayer = Layer(
                currentFile.width,
                currentFile.height,
                layer.name
            );
            newLayer.opacity = layer.opacity;
            newLayer.blendMode = layer.blendMode;
            newLayer.drawImage(layer.getCanvas());
            newFrame.layers.push(newLayer);
        });
        currentFile.frames.splice(index + 1, 0, newFrame);
        Historyservice.end();
        EventBus.trigger(EVENT.imageSizeChanged);
    };

    me.moveFrame = (fromIndex,toIndex) => {
        if (currentFile.frames.length > 1) {
            if (toIndex >= currentFile.frames.length) {
                toIndex = currentFile.frames.length - 1;
            }
            if (toIndex < 0) toIndex = 0;
            if (toIndex !== fromIndex) {
                let frame = currentFile.frames[fromIndex];
                currentFile.frames.splice(fromIndex, 1);
                currentFile.frames.splice(toIndex, 0, frame);
            }
            me.activateFrame(toIndex);
            EventBus.trigger(EVENT.imageContentChanged);
        }
    };

    me.mergeDown = function (index,skipHistory){
        if (typeof index !== "number") index = activeLayerIndex;
        let layer = currentFrame().layers[index];
        let belowLayer = currentFrame().layers[index - 1];
        if (layer && belowLayer) {
            if (!skipHistory) HistoryService.start(EVENT.imageHistory);
            if (layer.hasMask) {
                layer.removeMask(true);
            }
            let ctx = belowLayer.getContext();
            ctx.globalAlpha = layer.opacity;
            let blendMode = layer.blendMode || "normal";
            if (blendMode === "normal") blendMode = "source-over";
            ctx.globalCompositeOperation = blendMode;
            belowLayer.drawImage(layer.getCanvas(), 0, 0);
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = "source-over";
            currentFrame().layers.splice(index, 1);
            if (!skipHistory) Historyservice.end();
            me.activateLayer(index - 1);
            EventBus.trigger(EVENT.layerContentChanged);
        }
    };

    me.paste = function(image){
        let w = ImageFile.getCurrentFile().width;
        let h = ImageFile.getCurrentFile().height;

        function doPaste() {
            // check if a mask is active on the current layer
            let layer = me.getActiveLayer();
            if (layer.hasMask && layer.isMaskActive()) {
               console.log("Pasting into mask");
            }else{
                let index = me.addLayer();
                me.activateLayer(index);
            }

            me.getActiveLayer().drawImage(image, 0, 0);
            EventBus.trigger(EVENT.layerContentChanged);
        }

        if (image && (image.width > w || image.height > h)) {
            Modal.show(DIALOG.OPTION, {
                title: "Paste Image",
                width: 320,
                text: "The image you are pasting is larger than the current canvas. What do you want to do?",
                buttons: [
                    {
                        label: "Keep the canvas at " + w + "x" + h + " pixels",
                        onclick: doPaste,
                    },
                    {
                        label:
                            "Enlarge the canvas to " +
                            image.width +
                            "x" +
                            image.height +
                            " pixels",
                        onclick: () => {
                            me.resize({
                                width: image.width,
                                height: image.height,
                            });
                            doPaste();
                        },
                    },
                    { label: "Cancel" },
                ],
            });
        } else {
            doPaste();
        }
    };

    me.addRange = function(){
        currentFile.colorRange = currentFile.colorRange || [];
        currentFile.colorRange.push({
            active: true,
            high:1,
            low:0,
            fps:10
        });
        EventBus.trigger(EVENT.colorRangesChanged);
    }

    me.generateIndexedPixels = function(frameIndex,oneDimensional){
        console.log("generate indexed pixels for frame " + frameIndex);
        let now = performance.now();
        let ctx = me.getCanvas(frameIndex).getContext("2d");
        let colors = Palette.get();

        let indexed = indexPixelsToPalette(ctx,colors,oneDimensional);

        currentFile.indexedPixels = indexed.pixels;
        let time = performance.now() - now;
        console.log("Indexed pixels generated in " + time + "ms");
        if (indexed.notFoundCount){
            console.warn("Indexed pixels: " + indexed.notFoundCount + " colors not found in palette");
        }
        return currentFile.indexedPixels;

    }


    EventBus.on(COMMAND.NEW, function(){
        stop();
        newFile();
    });

    EventBus.on(COMMAND.SAVE, function(){
        me.save();
    });

    EventBus.on(COMMAND.RESIZE, function(){
        me.resize();
    });

    EventBus.on(COMMAND.RESAMPLE, function(){
        me.resample();
    });

    EventBus.on(COMMAND.INFO, function(){
        SidePanel.showInfo(currentFile);
    });

    EventBus.on(COMMAND.NEWLAYER, function(){
        SidePanel.show();
        let newIndex = addLayer(activeLayerIndex+1);
        HistoryService.add(EVENT.layerPropertyHistory,{
            index:-1,
            currentIndex:activeLayerIndex
        },{
            index:newIndex
        });
    });

    EventBus.on(COMMAND.DELETELAYER, function(){
        HistoryService.start(EVENT.imageHistory);
        removeLayer();
        HistoryService.end();
    });

    EventBus.on(COMMAND.DUPLICATELAYER, function(){
        HistoryService.start(EVENT.imageHistory);
        me.duplicateLayer();
        HistoryService.end();
    });

    EventBus.on(COMMAND.FLIPHORIZONTAL, function(){
        HistoryService.start(EVENT.layerContentHistory);
        me.flipLayer(undefined,true);
        HistoryService.end();
    });
    EventBus.on(COMMAND.FLIPVERTICAL, function(){
        HistoryService.start(EVENT.layerContentHistory);
        me.flipLayer(undefined,false);
        HistoryService.end();
    });

    EventBus.on(COMMAND.LAYERUP, function(index){
        if (typeof index === "undefined") index = activeLayerIndex;
        let fromIndex = index;
        let toIndex = fromIndex + 1;
        moveLayer(fromIndex, toIndex);
    });

    EventBus.on(COMMAND.LAYERDOWN, function(index){
        if (typeof index === "undefined") index = activeLayerIndex;
        let fromIndex = index;
        let toIndex = fromIndex - 1;
        moveLayer(fromIndex, toIndex);
    });

    EventBus.on(COMMAND.MERGEDOWN, function(index){
        HistoryService.start(EVENT.imageHistory);
        me.mergeDown(index);
        HistoryService.end();
    });

    EventBus.on(COMMAND.FLATTEN, function(){
        HistoryService.start(EVENT.imageHistory);
        currentFrame().layers.forEach((layer) => {
            if (layer.hasMask) {
                layer.removeMask(true);
                EventBus.trigger(EVENT.layersChanged);
            }
        });

        if (currentFrame().layers.length > 1) {
            let canvas = me.getCanvas();
            currentFrame().layers.splice(0, currentFrame().layers.length - 1);
            let layer = currentFrame().layers[0];
            if (layer) {
                layer.clear();
                layer.drawImage(canvas, 0, 0);
                layer.opacity = 100;
                layer.blendMode = "normal";
                layer.visible = true;
            }
            me.activateLayer(0);
            EventBus.trigger(EVENT.imageContentChanged);
        }
        HistoryService.end();
    });

    EventBus.on(COMMAND.ADDFRAME, function(){
        HistoryService.start(EVENT.imageHistory);
        SidePanel.show();
        addFrame();
        HistoryService.end();
    });

    EventBus.on(COMMAND.DELETEFRAME, function(){
        HistoryService.start(EVENT.imageHistory);
        removeFrame();
        HistoryService.end();
    });

    EventBus.on(COMMAND.DUPLICATEFRAME, function(){
        HistoryService.start(EVENT.imageHistory);
        me.duplicateFrame();
        HistoryService.end();
    });

    EventBus.on(COMMAND.FRAMEMOVETOEND, function(){
        HistoryService.start(EVENT.imageHistory);
        me.moveFrame(activeFrameIndex,currentFile.frames.length-1);
        HistoryService.end();
        EventBus.trigger(EVENT.imageSizeChanged);
    });

    EventBus.on(COMMAND.IMPORTLAYER, function(){
        var input = document.createElement("input");
        input.type = "file";
        input.onchange = function (e) {
            handleUpload(e.target.files, "frame");
        };
        input.click();
    });

    EventBus.on(EVENT.layerContentChanged, function(options){
        options = options || {};
        if (!options.keepImageCache) cachedImage = undefined;
        if (activeLayer) activeLayer.update();
        me.render();
        EventBus.trigger(EVENT.imageContentChanged);
    });

    EventBus.on(EVENT.layersChanged, () => {
        cachedImage = undefined;
        autoSave();
    });

    EventBus.on(EVENT.imageContentChanged, () => {
        autoSave();
    });

    EventBus.on(EVENT.imageSizeChanged,()=>{
        autoSave();
    });

    EventBus.on(EVENT.historyChanged,()=>{
        autoSave();
    });


    window.getCurrentFile = me.getCurrentFile

    return me;
}();

export default ImageFile;
