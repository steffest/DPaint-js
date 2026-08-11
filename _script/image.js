import FileDetector from "./fileformats/detect.js";
import AmigaIcon from "./fileformats/amigaIcon.js";
import EventBus from "./util/eventbus.js";
import {COMMAND,EVENT} from "./enum.js";
import Historyservice from "./services/historyservice.js";
import Layer from "./ui/layer.js";
import Modal,{DIALOG} from "./ui/modal.js";
import PanelManager from "./ui/panelManager.js";
import NativePanels from "./ui/nativePanels.js";
import {duplicateCanvas, indexPixelsToPalette, releaseCanvas} from "./util/canvasUtils.js";
import Palette from "./ui/palette.js";
import SaveDialog from "./ui/components/saveDialog.js";
import HistoryService from "./services/historyservice.js";
import ImageProcessing from "./util/imageProcessing.js";
import Brush from "./ui/brush.js";
import storage from "./util/storage.js";
import {DuplicateName} from "./util/textUtils.js";
import Recorder from "./services/recorder.js";
import {runWebGLQuantizer} from "./util/webgl-quantizer.js";
import {compositeNodes, resolveLayerPath, flatIndex, pathFromFlatIndex, isGroup, parentOf, removeAtPath, insertAtPath, moveAtPath, isLockedInTree} from "./util/layerUtils.js";

let ImageFile = function(){
    let me = {};
    let activeLayer;
    let activeLayerIndex = 0;
    let activeLayerPath = [0];
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

    // Normalises a layer reference to a path array. Accepts a path (number[]) as-is,
    // or a legacy flat top-level integer index → [index]. Used by all path-aware ops
    // so existing integer callers keep working while a flat tree has no groups.
    function toPath(ref){
        if (Array.isArray(ref)) return ref;
        if (typeof ref === "number") return [ref];
        return undefined;
    }

    me.addLayer = addLayer;
    me.removeLayer = removeLayer;

    me.getName = function(withoutExtension){
        let name = currentFile.name || "Untitled";
        if (withoutExtension) {
            let parts = name.split(".");
            if (parts.length > 1) {
                parts.pop();
                name = parts.join(".");
            }
        }
        return name;
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

    me.getCanvasWithFilters = function(frameIndex){
        let canvas = me.getCanvas(frameIndex);
        if (Palette.isLockedGlobal()){
            runWebGLQuantizer(canvas, Palette.get(), false, undefined, 0, 0);
        }
        return canvas;
    }

    me.getCanvas = function(frameIndex){
        let frame =
            typeof frameIndex === "number"
                ? currentFile.frames[frameIndex]
                : currentFrame();
        if (!frame) return;
        // Single top-level leaf layer: return its render directly (fast path).
        // Note: only valid for a leaf — a single group must still be composited so
        // its own opacity/blendMode apply. References frame.layers[0], not activeLayer,
        // which may now be a nested child.
        if (frame.layers.length === 1 && !isGroup(frame.layers[0])) {
            let only = frame.layers[0];
            if (only.visible) return only.render();
            // hidden single layer → fall through to produce an empty canvas
        }
        let canvas = document.createElement("canvas");
        let ctx = canvas.getContext("2d");
        canvas.width = currentFile.width;
        canvas.height = currentFile.height;
        compositeNodes(frame.layers, ctx);
        return canvas;
    };

    me.getContext = function(){
        let active = me.getActiveLayer();
        if (active && !isGroup(active) && currentFrame().layers.length === 1) {
            return active.getContext();
        }else{
            return me.getCanvas().getContext("2d");
        }
    };

    me.getActiveContext = function(){
        // A group has no paintable context; tools must no-op (see editor guard).
        if (activeLayer && isGroup(activeLayer)) return undefined;
        if (activeLayer) return activeLayer.getContext();
    };

    me.getActiveLayerIndex = function(){
        return activeLayerIndex;
    };

    me.getActiveLayer = function(){
        return activeLayer;
    };

    // True if the active node is itself locked OR sits inside a locked group, OR is a
    // group (groups have no paintable canvas). Drawing/editing tools no-op when true.
    me.isActiveLayerLocked = function(){
        let frame = currentFrame();
        if (!frame) return false;
        if (isGroup(activeLayer)) return true;
        return isLockedInTree(frame.layers, activeLayerPath);
    };

    me.getLayer = function(ref){
        let frame = currentFile.frames[activeFrameIndex];
        if (!frame) return undefined;
        let path = toPath(ref);
        if (!path) return undefined;
        // legacy flat integer → top-level index
        if (path.length === 1) return frame.layers[path[0]];
        return resolveLayerPath(frame.layers, path);
    };

    // Returns the path (number[]) of the topmost opaque node at `point`, or undefined.
    // Descends into visible groups to find the topmost opaque leaf; returns a collapsed
    // group's own path when the hit lies inside it.
    me.getTopLayerIndexAtPoint = function(point){
        let frame = currentFrame();
        if (!frame || !point) return undefined;
        if (point.x < 0 || point.y < 0 || point.x >= currentFile.width || point.y >= currentFile.height) return undefined;

        function opaqueAt(node){
            if (!node || !node.visible || !node.opacity) return false;
            let c = node.render();
            let cx = c ? c.getContext("2d",{willReadFrequently:true}) : undefined;
            if (!cx) return false;
            return cx.getImageData(point.x,point.y,1,1).data[3] > 0;
        }

        function search(nodes, prefix){
            for (let i = nodes.length - 1; i >= 0; i--){
                let node = nodes[i];
                if (!node || !node.visible || !node.opacity) continue;
                let path = prefix.concat(i);
                if (isGroup(node) && !node.collapsed){
                    let inner = search(node.layers, path);
                    if (inner) return inner;
                    // group is expanded but nothing opaque inside at this point
                    continue;
                }
                if (opaqueAt(node)) return path;
            }
            return undefined;
        }

        return search(frame.layers, []);
    };

    // Returns an array of paths (number[][]) for nodes whose type matches, full-tree depth-first.
    me.getLayerIndexesOfType = function(type){
        let frame = currentFile.frames[activeFrameIndex];
        let result = [];
        if (frame) {
            (function walk(nodes, prefix){
                nodes.forEach((node, index) => {
                    let path = prefix.concat(index);
                    if (node.type === type) result.push(path);
                    if (isGroup(node)) walk(node.layers, path);
                });
            })(frame.layers, []);
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
            cachedImage = undefined;
            HistoryService.start(EVENT.imageHistory);
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
                    layer.resize(w,h,aX,aY);
                });
            });
            HistoryService.end();
            EventBus.trigger(EVENT.imageSizeChanged);
        }
    };

    me.resample = function(properties){
        if (!properties) {
            Modal.show(DIALOG.RESAMPLE);
        } else {
            cachedImage = undefined;
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

    me.activateLayer = function(ref){
        let frame = currentFrame();
        let path = toPath(ref) || [0];
        let layer = path.length === 1 ? frame.layers[path[0]] : resolveLayerPath(frame.layers, path);
        if (!layer){
            // path no longer resolves (e.g. after a structural change) → fall back to root 0
            path = [0];
            layer = frame.layers[0];
        }
        activeLayerPath = path;
        activeLayer = layer;
        activeLayerIndex = flatIndex(frame.layers, path);
        if (activeLayerIndex < 0) activeLayerIndex = path[0] || 0;
        EventBus.trigger(EVENT.layersChanged);
    };

    me.getActiveLayerPath = function(){
        return activeLayerPath;
    };

    me.toggleLayer = function(ref){
        let layer = me.getLayer(ref);
        if (!layer) return;
        layer.visible = !layer.visible;
        EventBus.trigger(EVENT.layersChanged);
        EventBus.trigger(EVENT.imageContentChanged);
    };

    me.toggleLayerLock = function(ref){
        let layer = me.getLayer(ref);
        if (!layer) return;
        layer.locked = !layer.locked;
        EventBus.trigger(EVENT.layersChanged);
    };

    me.duplicateLayer = function(ref){
        let path = typeof ref === "undefined" ? activeLayerPath : toPath(ref);
        if (!path) return;
        let frame = currentFrame();
        let p = parentOf(frame.layers, path);
        let layer = resolveLayerPath(frame.layers, path) || (path.length===1 ? frame.layers[path[0]] : undefined);
        if (!p || !layer) return;

        let newName = DuplicateName(layer.name, p.parent);

        if (isGroup(layer)){
            // deep-copy the whole subtree via clone/restore (async), like duplicateFrame
            let newLayer = Layer.makeGroup(currentFile.width, currentFile.height, newName);
            let struct = layer.clone(false);
            struct.name = newName;
            let insertPath = path.slice();
            insertPath[insertPath.length-1] = p.index + 1;
            insertAtPath(frame.layers, insertPath, newLayer);
            me.activateLayer(insertPath);
            // returns a Promise so callers can sequence history capture after the deep copy
            return newLayer.restore(struct).then(()=>{
                EventBus.trigger(EVENT.layerContentChanged);
            });
        }

        let newLayer = Layer(
            currentFile.width,
            currentFile.height,
            newName
        );
        newLayer.opacity = layer.opacity;
        newLayer.blendMode = layer.blendMode;
        newLayer.locked = layer.locked;
        newLayer.drawImage(layer.getCanvas());
        let insertPath = path.slice();
        insertPath[insertPath.length-1] = p.index + 1;
        insertAtPath(frame.layers, insertPath, newLayer);
        me.activateLayer(insertPath);
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

    me.removeStrayPixels = function(index){
        if (typeof index !== "number") index = activeLayerIndex;
        let layer = currentFrame().layers[index];
        if (layer) {
            let canvas = layer.getCanvas();
            let ctx = layer.getContext();
            let w = canvas.width;
            let h = canvas.height;
            let imgData = ctx.getImageData(0, 0, w, h);
            let data = imgData.data;

            let visited = new Uint8Array(w * h);

            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    let i = y * w + x;
                    if (visited[i]) continue;

                    if (data[i * 4 + 3] === 0) {
                        visited[i] = 1;
                        continue;
                    }

                    let q = [i];
                    let cluster = [i];
                    visited[i] = 1;

                    let minX = x;
                    let maxX = x;
                    let minY = y;
                    let maxY = y;

                    let head = 0;
                    while(head < q.length) {
                        let curr = q[head++];
                        let cx = curr % w;
                        let cy = Math.floor(curr / w);

                        if (cx < minX) minX = cx;
                        if (cx > maxX) maxX = cx;
                        if (cy < minY) minY = cy;
                        if (cy > maxY) maxY = cy;

                        for (let ny = cy - 1; ny <= cy + 1; ny++) {
                            for (let nx = cx - 1; nx <= cx + 1; nx++) {
                                if (nx === cx && ny === cy) continue;
                                if (nx >= 0 && ny >= 0 && nx < w && ny < h) {
                                    let ni = ny * w + nx;
                                    if (!visited[ni] && data[ni * 4 + 3] > 0) {
                                        visited[ni] = 1;
                                        q.push(ni);
                                        cluster.push(ni);
                                    }
                                }
                            }
                        }
                    }

                    let clusterWidth = maxX - minX + 1;
                    let clusterHeight = maxY - minY + 1;

                    if (clusterWidth < 12 && clusterHeight < 12) {
                        for (let j = 0; j < cluster.length; j++) {
                            let ci = cluster[j];
                            data[ci * 4 + 0] = 0;
                            data[ci * 4 + 1] = 0;
                            data[ci * 4 + 2] = 0;
                            data[ci * 4 + 3] = 0;
                        }
                    }
                }
            }

            ctx.putImageData(imgData, 0, 0);
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
        activeLayerPath = pathFromFlatIndex(currentFrame().layers, activeLayerIndex) || [activeLayerIndex];
        activeLayer = resolveLayerPath(currentFrame().layers, activeLayerPath) || currentFrame().layers[activeLayerIndex];
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
        struct.image.activeLayerPath = activeLayerPath;
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
        if (currentFile.meta) struct.image.meta = clonePlainData(currentFile.meta);

        return struct;
    };

    me.restore = function(data){
        let image = data.image;
        currentFile.width = image.width;
        currentFile.height = image.height;
        let mockImage = new Image(currentFile.width, currentFile.height);
        let restoredType = getRestoredTypeFromMeta(image.meta);
        let restorePromises = [];
        newFile(mockImage, image.name || currentFile.name, restoredType, undefined, image.meta);
        currentFile.name = image.name || "Untitled";
        image.frames.forEach((_frame, frameIndex) => {
            let frame = currentFile.frames[frameIndex];
            if (!frame) {
                addFrame();
                frame = currentFile.frames[frameIndex];
            }
            frame.activeLayerIndex = _frame.activeLayerIndex || 0;
            // Rebuild the top-level layer list from scratch so structural changes
            // (added/removed/regrouped nodes) restore correctly. Layer.restore owns
            // the recursion into group children.
            frame.layers = [];
            _frame.layers.forEach((_layer) => {
                let layer = Layer(currentFile.width, currentFile.height);
                frame.layers.push(layer);
                restorePromises.push(layer.restore(_layer).then(() => {
                    EventBus.trigger(EVENT.layersChanged);
                    EventBus.trigger(EVENT.imageSizeChanged);
                }));
            });
        });

        Promise.all(restorePromises).then(()=>{
            // Reactivate after the whole tree exists, by path (falls back to flat index).
            me.activateFrame(image.activeFrameIndex || 0);
            if (Array.isArray(image.activeLayerPath)){
                me.activateLayer(image.activeLayerPath);
            } else {
                me.activateLayer(image.activeLayerIndex || 0);
            }
            restoreOriginalDataFromMeta();
            EventBus.trigger(EVENT.framesChanged);
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
            if (ext === "psd") detectType = true;
            if (ext === "pcx") detectType = true;
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
                let meta = extractFileMeta(result.type,result.data);
                currentFile.originalType = result.type;
                currentFile.originalData = result.data;
                currentFile.meta = meta;
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
                handleOpenedImage(image,fileName,target,meta);

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

    me.setOriginalImageType = async function(type){
        let iconMeta = getCurrentIconMeta();
        let currentType = currentFile.originalType;
        if (!iconMeta || !type || type === currentType) return;

        storeCurrentIconVariant(currentType);
        let image = await getIconVariantCanvases(type);
        if (!image.length) return;

        if (iconMeta.variants) delete iconMeta.variants[type];
        iconMeta.selectedImageType = type;
        updateIconMetaAvailableTypes(iconMeta);

        currentFile.originalType = type;
        if (currentFile.originalData){
            currentFile.originalData.selectedImageType = type;
            currentFile.originalData.availableImageTypes = iconMeta.availableImageTypes.slice();
        }

        let fileName = currentFile.name || "Untitled";
        newFile(image[0],fileName,type,currentFile.originalData,currentFile.meta);

        EventBus.hold();
        for (let i = 1; i < image.length; i++) addFrame(image[i]);
        EventBus.release();
        EventBus.trigger(EVENT.framesChanged);
    };

    me.setOriginalIconType = function(type){
        let originalData = currentFile.originalData;
        if (!type) return;

        let numericType = parseInt(type,10);
        if (isNaN(numericType)) return;

        if (originalData){
            originalData.type = numericType;
            if (!originalData.info) originalData.info = {};
            originalData.info.type = AmigaIcon.getIconType(numericType);
        }
        let iconMeta = getCurrentIconMeta(true);
        if (iconMeta){
            iconMeta.iconType = numericType;
            iconMeta.iconTypeLabel = AmigaIcon.getIconType(numericType);
        }
        EventBus.trigger(EVENT.framesChanged);
    };

    me.setOriginalToolTypes = function(toolTypes){
        if (typeof toolTypes === "string"){
            toolTypes = toolTypes
                .split(/\r?\n/)
                .map(line=>line.trim())
                .filter(Boolean);
        }

        if (!Array.isArray(toolTypes)) return;

        let originalData = currentFile.originalData;
        if (originalData){
            originalData.toolTypes = toolTypes.slice();
            originalData.hasToolTypes = toolTypes.length ? 1 : 0;
        }
        let iconMeta = getCurrentIconMeta(true);
        if (iconMeta){
            iconMeta.toolTypes = toolTypes.slice();
        }
        EventBus.trigger(EVENT.framesChanged);
    };

    me.setOriginalDefaultTool = function(defaultTool){
        if (typeof defaultTool !== "string") return;

        let originalData = currentFile.originalData;
        if (originalData){
            originalData.defaultTool = defaultTool;
            originalData.hasDefaultTool = defaultTool ? 1 : 0;
        }

        let iconMeta = getCurrentIconMeta(true);
        if (iconMeta){
            iconMeta.defaultTool = defaultTool;
        }
        EventBus.trigger(EVENT.framesChanged);
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

    function handleOpenedImage(image,fileName,target,meta){
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
                    newFile(image[0],fileName,currentFile.originalType,currentFile.originalData,meta);
                    EventBus.hold();
                    for (let i = 1; i < image.length; i++) addFrame(image[i]);
                    EventBus.release();
                    EventBus.trigger(EVENT.framesChanged);
                } else if (currentFile.originalData && currentFile.originalData.layers && currentFile.originalData.layers.length) {
                    newFileFromLayers(currentFile.originalData.layers, image, fileName, currentFile.originalType, currentFile.originalData, meta);
                } else {
                    newFile(image,fileName,currentFile.originalType,currentFile.originalData,meta)
                }
        }
    }

    function newFile(image,fileName,type,originalData,meta){
        Historyservice.clear();
        Recorder.clear();
        cachedImage = undefined;
        EventBus.trigger(COMMAND.CLEARSELECTION);
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
        if (meta) currentFile.meta = clonePlainData(meta);
        activeFrameIndex = 0;
        activeLayerIndex = 0;
        activeLayerPath = [0];
        addLayer();
        activeLayer = currentFrame().layers[0];
        activeLayer.clear();
        if (image) {
            activeLayer.getContext().drawImage(image, 0, 0);
        }
        EventBus.trigger(EVENT.imageSizeChanged);
        if (["classicIcon","colorIcon","PNGIcon"].includes(type)){
            PanelManager.reveal("icon", true);
        }
    }

    // Builds a Layer (or group Layer) from a plain source-layer descriptor as produced by
    // the file-format parsers (PSD/Aseprite) or newFileFromLayers callers. Recurses into
    // `layers` for groups.
    function buildLayerNode(source, index, w, h){
        if (source && source.type === "group" && Array.isArray(source.layers)){
            let group = Layer.makeGroup(w, h, source.name || ("Group " + (index + 1)));
            group.visible = source.visible !== false;
            group.opacity = typeof source.opacity === "number" ? source.opacity : 100;
            group.blendMode = source.blendMode || "normal";
            group.locked = !!source.locked;
            group.collapsed = !!source.collapsed;
            group.layers = source.layers.map((child, i)=>buildLayerNode(child, i, w, h));
            return group;
        }
        let layer = Layer(w, h, source.name || ("Layer " + (index + 1)));
        layer.visible = source.visible !== false;
        layer.opacity = typeof source.opacity === "number" ? source.opacity : 100;
        layer.blendMode = source.blendMode || "normal";
        layer.locked = !!source.locked;
        if (source.canvas){
            layer.drawImage(source.canvas, source.left || 0, source.top || 0);
        }
        return layer;
    }

    function newFileFromLayers(sourceLayers,image,fileName,type,originalData,meta){
        Historyservice.clear();
        Recorder.clear();
        cachedImage = undefined;
        EventBus.trigger(COMMAND.CLEARSELECTION);

        let w = originalData && originalData.width ? originalData.width : 320;
        let h = originalData && originalData.height ? originalData.height : 256;
        if (image) {
            w = image.width || w;
            h = image.height || h;
        }

        currentFile = {
            width: w,
            height: h,
            name: fileName || "Untitled",
            frames:[{
                layers:[]
            }],
            colorRange:[]
        };

        if (type) currentFile.originalType = type;
        if (originalData){
            currentFile.originalData = originalData;
        }
        if (meta) currentFile.meta = clonePlainData(meta);

        activeFrameIndex = 0;
        activeLayerIndex = 0;
        activeLayerPath = [0];

        let layers = sourceLayers.slice();

        EventBus.hold();
        // Build the layer tree from the source list. A source entry with type "group" and
        // a `layers` array becomes a group Layer with recursively-built children (this is
        // what the PSD/Aseprite parsers emit once group reconstruction is active).
        currentFrame().layers = layers.map((sourceLayer, index)=>buildLayerNode(sourceLayer, index, w, h));
        EventBus.release();

        if (!currentFrame().layers.length) {
            addLayer();
        }

        activeLayerIndex = currentFrame().layers.length - 1;
        activeLayerPath = [activeLayerIndex];
        activeLayer = currentFrame().layers[activeLayerIndex];

        EventBus.trigger(EVENT.layersChanged);
        EventBus.trigger(EVENT.imageSizeChanged);
        EventBus.trigger(EVENT.imageContentChanged);
        restoreOriginalDataFromMeta();
    }

    function isIconType(type){
        return ["classicIcon","colorIcon","PNGIcon"].includes(type);
    }

    function clonePlainData(data){
        if (typeof data === "undefined") return undefined;
        return JSON.parse(JSON.stringify(data));
    }

    function extractFileMeta(type,data){
        if (!isIconType(type) || !data) return undefined;
        let selectedImageType = data.selectedImageType || type;
        let availableImageTypes = Array.isArray(data.availableImageTypes) ? data.availableImageTypes.slice() : AmigaIcon.getImageTypes(data);
        let variants = {};
        availableImageTypes.forEach(imageType=>{
            if (imageType === selectedImageType) return;
            let images = [
                AmigaIcon.getImage(data,0,imageType),
                AmigaIcon.getImage(data,1,imageType),
            ].filter(Boolean);
            if (images.length){
                variants[imageType] = serializeCanvasSet(images);
            }
        });
        return {
            icon: {
                iconType: data.type,
                iconTypeLabel: data.info && data.info.type,
                selectedImageType: selectedImageType,
                availableImageTypes: availableImageTypes.slice(),
                toolTypes: Array.isArray(data.toolTypes) ? data.toolTypes.slice() : [],
                variants: variants,
                userData: data.userData,
                stackSize: data.stackSize,
                defaultTool: data.defaultTool,
                toolWindow: typeof data.hasToolWindow === "string" ? data.hasToolWindow : data.toolWindow,
                drawerData: data.drawerData ? clonePlainData(data.drawerData) : undefined,
                drawerData2: data.drawerData2 ? clonePlainData(data.drawerData2) : undefined,
            }
        };
    }

    function getCurrentIconMeta(create){
        if (!currentFile.meta){
            if (!create) return;
            currentFile.meta = {};
        }
        if (!currentFile.meta.icon && create){
            currentFile.meta.icon = {};
        }
        return currentFile.meta.icon;
    }

    function getRestoredTypeFromMeta(meta){
        let iconMeta = meta && meta.icon;
        if (!iconMeta) return;
        return iconMeta.selectedImageType || "classicIcon";
    }

    function buildOriginalDataFromMeta(){
        let iconMeta = getCurrentIconMeta();
        if (!iconMeta) return;

        let originalData = {
            type: iconMeta.iconType,
            selectedImageType: iconMeta.selectedImageType || currentFile.originalType || "classicIcon",
            toolTypes: Array.isArray(iconMeta.toolTypes) ? iconMeta.toolTypes.slice() : [],
            hasToolTypes: Array.isArray(iconMeta.toolTypes) && iconMeta.toolTypes.length ? 1 : 0,
            userData: typeof iconMeta.userData === "number" ? iconMeta.userData : 1,
            stackSize: typeof iconMeta.stackSize === "number" ? iconMeta.stackSize : 8192,
        };

        if (iconMeta.iconTypeLabel){
            originalData.info = {type: iconMeta.iconTypeLabel};
        }
        if (iconMeta.defaultTool){
            originalData.defaultTool = iconMeta.defaultTool;
            originalData.hasDefaultTool = 1;
        }
        if (iconMeta.toolWindow){
            originalData.toolWindow = iconMeta.toolWindow;
            originalData.hasToolWindow = iconMeta.toolWindow;
        }

        originalData.availableImageTypes = Array.isArray(iconMeta.availableImageTypes)
            ? iconMeta.availableImageTypes.slice()
            : [originalData.selectedImageType];

        return originalData;
    }

    function restoreOriginalDataFromMeta(){
        if (currentFile.originalData || !getCurrentIconMeta()) return;
        currentFile.originalData = buildOriginalDataFromMeta();
        if (currentFile.originalData && !currentFile.originalType){
            currentFile.originalType = currentFile.originalData.selectedImageType;
        }
    }

    function canvasToRGBAState(canvas){
        let ctx = canvas.getContext("2d");
        let imageData = ctx.getImageData(0,0,canvas.width,canvas.height).data;
        let pixels = [];
        for (let i = 0; i<imageData.length; i += 4){
            pixels.push([
                imageData[i],
                imageData[i+1],
                imageData[i+2],
                imageData[i+3] / 255
            ]);
        }
        return {
            rgba: true,
            pixels: pixels,
            palette: []
        };
    }

    function serializeCanvasSet(canvases){
        return (canvases || []).filter(Boolean).map(canvas=>canvas.toDataURL("image/png"));
    }

    function deserializeCanvasSet(images){
        return Promise.all((images || []).map(loadCanvasFromDataUrl));
    }

    function loadCanvasFromDataUrl(dataUrl){
        return new Promise((resolve,reject)=>{
            let image = new Image();
            image.onload = ()=>{
                let canvas = document.createElement("canvas");
                canvas.width = image.width;
                canvas.height = image.height;
                canvas.getContext("2d").drawImage(image,0,0);
                resolve(canvas);
            };
            image.onerror = reject;
            image.src = dataUrl;
        });
    }

    function getCurrentImageSetCanvases(){
        return [me.getCanvas(0), me.getCanvas(1)].filter(Boolean).map(canvas=>duplicateCanvas(canvas,true));
    }

    function storeCurrentIconVariant(type){
        let iconMeta = getCurrentIconMeta(true);
        if (!iconMeta || !type) return;
        iconMeta.variants = iconMeta.variants || {};
        iconMeta.variants[type] = serializeCanvasSet(getCurrentImageSetCanvases());
        updateIconMetaAvailableTypes(iconMeta);
    }

    async function getIconVariantCanvases(type){
        let iconMeta = getCurrentIconMeta();
        if (iconMeta && iconMeta.variants && iconMeta.variants[type]){
            return deserializeCanvasSet(iconMeta.variants[type]);
        }

        let originalData = currentFile.originalData;
        if (!originalData) return [];

        return [
            AmigaIcon.getImage(originalData,0,type),
            AmigaIcon.getImage(originalData,1,type),
        ].filter(Boolean).map(canvas=>duplicateCanvas(canvas,true));
    }

    function updateIconMetaAvailableTypes(iconMeta){
        if (!iconMeta) return [];
        let selectedImageType = iconMeta.selectedImageType || currentFile.originalType;
        let availableImageTypes = selectedImageType ? [selectedImageType] : [];
        if (iconMeta.variants){
            Object.keys(iconMeta.variants).forEach(type=>{
                if (iconMeta.variants[type]) availableImageTypes.push(type);
            });
        }
        iconMeta.availableImageTypes = Array.from(new Set(availableImageTypes));
        return iconMeta.availableImageTypes;
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

    function removeLayer(ref){
        let path = typeof ref === "undefined" ? activeLayerPath : toPath(ref);
        if (!path) return;
        let frame = currentFrame();
        let p = parentOf(frame.layers, path);
        if (!p) return;
        // Don't remove the last remaining top-level layer.
        if (p.parent === frame.layers && frame.layers.length <= 1) return;
        removeAtPath(frame.layers, path);
        // Reactivate: prefer the previous sibling in the same parent, else parent/root 0.
        let activeP = activeLayerPath.slice();
        if (activeP.length){
            if (activeP[activeP.length-1] >= p.parent.length && activeP.length === path.length){
                activeP[activeP.length-1] = Math.max(0, p.parent.length - 1);
            }
        }
        me.activateLayer(activeP.length ? activeP : [0]);
        EventBus.trigger(EVENT.imageContentChanged);
    }

    // ── Group operations ──────────────────────────────────────────────────────────

    // Creates an empty group. atPath: insertion path (defaults to just above active layer at root).
    me.addGroup = function(name, atPath){
        let frame = currentFrame();
        let group = Layer.makeGroup(currentFile.width, currentFile.height,
            name || DuplicateName("Group", frame.layers));
        if (Array.isArray(atPath)){
            insertAtPath(frame.layers, atPath, group);
            me.activateLayer(atPath);
        }else{
            frame.layers.push(group);
            me.activateLayer([frame.layers.length - 1]);
        }
        EventBus.trigger(EVENT.layersChanged);
        EventBus.trigger(EVENT.imageContentChanged);
        return group;
    };

    // Wraps the nodes at `paths` (which must share one parent) into a new group,
    // placed at the position of the topmost (lowest-index) selected node.
    me.groupLayers = function(paths){
        let frame = currentFrame();
        if (!Array.isArray(paths) || !paths.length){
            return me.addGroup();
        }
        // All selected paths must share the same parent.
        let parentKey = p => p.slice(0,-1).join(",");
        let key0 = parentKey(paths[0]);
        if (!paths.every(p => parentKey(p) === key0)){
            console.warn("groupLayers: selection spans multiple parents; ignoring");
            return;
        }
        // Sort by last index so we remove/insert deterministically.
        let sorted = paths.slice().sort((a,b)=>a[a.length-1]-b[b.length-1]);
        let parentPath = sorted[0].slice(0,-1);
        let parentArr = parentPath.length ? resolveLayerPath(frame.layers, parentPath).layers : frame.layers;
        let insertIndex = sorted[0][sorted[0].length-1];

        // Capture nodes, then remove them high-index-first so indices stay valid.
        let nodes = sorted.map(p => parentArr[p[p.length-1]]);
        for (let i = sorted.length-1; i>=0; i--){
            parentArr.splice(sorted[i][sorted[i].length-1], 1);
        }
        let group = Layer.makeGroup(currentFile.width, currentFile.height,
            DuplicateName("Group", frame.layers));
        nodes.forEach(n => group.layers.push(n));
        parentArr.splice(insertIndex, 0, group);

        let groupPath = parentPath.concat(insertIndex);
        me.activateLayer(groupPath);
        EventBus.trigger(EVENT.layersChanged);
        EventBus.trigger(EVENT.imageContentChanged);
        return group;
    };

    // Promotes a group's children into its parent scope (one level up) and removes the container.
    me.ungroupLayers = function(path){
        let frame = currentFrame();
        let p = parentOf(frame.layers, path);
        if (!p) return;
        let group = p.parent[p.index];
        if (!isGroup(group)) return;
        let children = group.layers.slice();
        // Replace the group with its children, in order, at the group's position.
        p.parent.splice(p.index, 1, ...children);
        me.activateLayer(p.parent.length ? path.slice(0,-1).concat(Math.min(p.index, p.parent.length-1)) : [0]);
        EventBus.trigger(EVENT.layersChanged);
        EventBus.trigger(EVENT.imageContentChanged);
    };

    // Flattens a group into a single leaf Layer at the same position,
    // inheriting the group's name/opacity/blendMode.
    me.mergeGroup = function(path){
        let frame = currentFrame();
        let p = parentOf(frame.layers, path);
        if (!p) return;
        let group = p.parent[p.index];
        if (!isGroup(group)) return;

        let merged = Layer(currentFile.width, currentFile.height, group.name);
        merged.opacity = group.opacity;
        merged.blendMode = group.blendMode;
        merged.locked = group.locked;
        // group.render() composites all visible children (applying their own opacity/blend/mask).
        merged.drawImage(group.render(), 0, 0);
        p.parent.splice(p.index, 1, merged);
        me.activateLayer(path);
        EventBus.trigger(EVENT.layersChanged);
        EventBus.trigger(EVENT.imageContentChanged);
        return merged;
    };

    function moveLayer(from,to){
        let frame = currentFrame();
        let fromPath = toPath(from);
        let toP = toPath(to);
        if (!fromPath || !toP) return;

        // Legacy flat path: both top-level integers → clamp like before.
        if (fromPath.length === 1 && toP.length === 1){
            if (frame.layers.length <= 1) return;
            let toIndex = toP[0];
            if (toIndex >= frame.layers.length) toIndex = frame.layers.length - 1;
            if (toIndex < 0) toIndex = 0;
            if (toIndex !== fromPath[0]){
                let layer = frame.layers[fromPath[0]];
                frame.layers.splice(fromPath[0], 1);
                frame.layers.splice(toIndex, 0, layer);
            }
            me.activateLayer([toIndex]);
            EventBus.trigger(EVENT.imageContentChanged);
            return;
        }

        // Tree move: moveAtPath rejects moving a group into its own subtree.
        let node = resolveLayerPath(frame.layers, fromPath);
        if (!node) return;
        moveAtPath(frame.layers, fromPath, toP);
        // Re-find the moved node to set the active path correctly post-mutation.
        me.activateLayer(pathOfNode(frame.layers, node) || [0]);
        EventBus.trigger(EVENT.imageContentChanged);
    }

    // Move the node at fromPath into the array at parentPath, inserting at `index`
    // expressed in POST-REMOVAL coordinates (i.e. after fromPath has been spliced out).
    // This is the contract resolveDropPath() produces. Returns true if a move happened.
    me.moveLayerToParent = function(fromPath, parentPath, index){
        let frame = currentFrame();
        if (!Array.isArray(fromPath) || !Array.isArray(parentPath)) return false;
        // Reject moving a group into itself or its own subtree.
        if (parentPath.length >= fromPath.length){
            let inside = true;
            for (let i=0;i<fromPath.length;i++){ if (parentPath[i]!==fromPath[i]){ inside=false; break; } }
            if (inside) return false;
        }
        let node = resolveLayerPath(frame.layers, fromPath);
        if (!node) return false;

        // Resolve the target parent ARRAY by reference now (before removal), so any index
        // shifts from the removal don't invalidate it. `index` is given in post-removal
        // coordinates within this same array.
        let parentArr = parentPath.length === 0
            ? frame.layers
            : (resolveLayerPath(frame.layers, parentPath) || {}).layers;
        if (!parentArr) return false;

        removeAtPath(frame.layers, fromPath);

        if (index < 0) index = 0;
        if (index > parentArr.length) index = parentArr.length;
        parentArr.splice(index, 0, node);

        me.activateLayer(pathOfNode(frame.layers, node) || [0]);
        EventBus.trigger(EVENT.imageContentChanged);
        return true;
    };

    // Depth-first search for the path of a specific node instance in the tree.
    function pathOfNode(nodes, target, prefix){
        prefix = prefix || [];
        for (let i=0;i<nodes.length;i++){
            let n = nodes[i];
            let path = prefix.concat(i);
            if (n === target) return path;
            if (isGroup(n)){
                let inner = pathOfNode(n.layers, target, path);
                if (inner) return inner;
            }
        }
        return undefined;
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
        EventBus.trigger(EVENT.imageSizeChanged);

    }

    function removeFrame(skipHistory){
        if (currentFile.frames.length > 1) {
            if (!skipHistory) HistoryService.start(EVENT.imageHistory);
            currentFile.frames.splice(activeFrameIndex, 1);
            if (activeFrameIndex >= currentFile.frames.length) {
                activeFrameIndex--;
            }
            if (!skipHistory) Historyservice.end();
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
            let struct = layer.clone(false);
            newLayer.restore(struct);
            newFrame.layers.push(newLayer);
        });
        currentFile.frames.splice(index + 1, 0, newFrame);
        Historyservice.end();
        EventBus.trigger(EVENT.imageSizeChanged);
        ImageFile.nextFrame();
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

    me.mergeDown = function (ref,skipHistory){
        let frame = currentFrame();
        let path = typeof ref === "undefined" ? activeLayerPath : toPath(ref);
        if (!path) return;
        let p = parentOf(frame.layers, path);
        if (!p) return;
        // "Down" is the previous sibling in the same parent scope.
        if (p.index <= 0) return; // nothing below in this scope (group-boundary guard)
        let layer = p.parent[p.index];
        let belowLayer = p.parent[p.index - 1];
        // A group can't be merged into (you'd lose its structure); only leaf targets below.
        if (!layer || !belowLayer || isGroup(belowLayer)) return;

        if (!skipHistory) HistoryService.start(EVENT.imageHistory);
        if (!isGroup(layer) && layer.hasMask) {
            layer.removeMask(true);
        }
        let ctx = belowLayer.getContext();
        ctx.globalAlpha = layer.opacity / 100;
        let blendMode = layer.blendMode || "normal";
        if (blendMode === "normal") blendMode = "source-over";
        ctx.globalCompositeOperation = blendMode;
        belowLayer.drawImage(layer.render(), 0, 0); // render() composites a group; returns canvas for a leaf
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = "source-over";
        p.parent.splice(p.index, 1);
        if (!skipHistory) Historyservice.end();
        let belowPath = path.slice();
        belowPath[belowPath.length-1] = p.index - 1;
        me.activateLayer(belowPath);
        EventBus.trigger(EVENT.layerContentChanged);
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
        NativePanels.showInfo(currentFile);
    });

    EventBus.on(COMMAND.NEWLAYER, function(){
        PanelManager.showContainer("left");
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
        let result = me.duplicateLayer();
        // group duplication is async (deep clone/restore); end history once it completes
        if (result && typeof result.then === "function"){
            result.then(()=>HistoryService.end());
        }else{
            HistoryService.end();
        }
    });

    EventBus.on(COMMAND.NEWGROUP, function(){
        PanelManager.showContainer("left");
        HistoryService.start(EVENT.imageHistory);
        let atPath = activeLayerPath && activeLayerPath.length ? activeLayerPath.slice() : undefined;
        if (atPath) atPath[atPath.length-1] = atPath[atPath.length-1] + 1;
        me.addGroup(undefined, atPath);
        HistoryService.end();
    });

    EventBus.on(COMMAND.GROUPLAYERS, function(paths){
        HistoryService.start(EVENT.imageHistory);
        me.groupLayers(paths || [activeLayerPath]);
        HistoryService.end();
    });

    EventBus.on(COMMAND.UNGROUP, function(path){
        HistoryService.start(EVENT.imageHistory);
        me.ungroupLayers(path || activeLayerPath);
        HistoryService.end();
    });

    EventBus.on(COMMAND.MERGEGROUP, function(path){
        HistoryService.start(EVENT.imageHistory);
        me.mergeGroup(path || activeLayerPath);
        HistoryService.end();
    });

    EventBus.on(COMMAND.REMOVESTRAYPIXELS, function(){
        HistoryService.start(EVENT.layerContentHistory);
        me.removeStrayPixels();
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
        PanelManager.showContainer("left");
        addFrame();
        HistoryService.end();
    });

    EventBus.on(COMMAND.DELETEFRAME, function(){
        removeFrame();
    });

    EventBus.on(COMMAND.CLEARFRAME, function(){
        HistoryService.start(EVENT.imageHistory)
        // clear all layers of the current frame except the first one
        let len = currentFrame().layers.length;
        if (len>1){
            currentFrame().layers.splice(0,len-1);
        }
        let layer = currentFrame().layers[0];
        if (layer) {
            layer.clear();
            layer.name = "Layer 1";
        }
        activeLayerIndex = 0;
        activeLayerPath = [0];
        activeLayer = currentFrame().layers[0];

        HistoryService.end();
        EventBus.trigger(EVENT.layersChanged);
        EventBus.trigger(EVENT.imageSizeChanged);
    });

    EventBus.on(COMMAND.DUPLICATEFRAME, function(){
        me.duplicateFrame();
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
