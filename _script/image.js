import FileDetector from "./fileformats/detect.js";
import EventBus from "./util/eventbus.js";
import {COMMAND, EVENT} from "./enum.js";
import Historyservice from "./services/historyservice.js";
import Layer from "./ui/layer.js";
import Modal from "./ui/modal.js";
import SidePanel from "./ui/sidepanel.js";

let ImageFile = function(){
    let me = {};
    let activeLayer;
    let activeLayerIndex = 0;
    let activeFrameIndex = 0;
    let currentFile = {
        layers:[]
    }

    me.getCurrentFile = function(){
        return currentFile;
    }
    
    me.getCanvas = function(frameIndex){
        let frame = (typeof frameIndex === "number") ? currentFile.frames[frameIndex]: currentFrame();
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
                    ctx.drawImage(layer.getCanvas(),0,0);
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
            handleUpload(e.target.files);
        };
        input.click();
    }

    me.save = function(){
        Modal.show();

        //const iconData = activeLayer.getCanvas().toDataURL('image/x-icon');
        //console.error(iconData);

        //var buffer = IFF.write(activeLayer.getCanvas());

        //var blob = new Blob([buffer], {type: "application/octet-stream"});
        //var fileName = 'test.iff';
        //saveAs(blob,fileName);
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

    me.activateFrame = function(index){
        console.log("Activating frame " + index);
        activeFrameIndex = index;
        activeLayerIndex = 0;
        activeLayer = currentFrame().layers[activeLayerIndex];
        EventBus.trigger(EVENT.layersChanged);
        EventBus.trigger(EVENT.imageContentChanged);
    }

    function handleUpload(files){
        console.log("file uploaded");
        if (files.length){
            var file = files[0];
            var detectType;

            var reader = new FileReader();
            reader.onload = function(){
                if (detectType){
                    console.log("Detecting type");
                    FileDetector.detect(file,reader.result).then(result=>{
                        console.error(result)
                        if (Array.isArray(result)){
                            //Editor.set(result[0]);
                            newFile(result[0]);
                            addFrame(result[1]);
                        }else{
                            //Editor.set(result);
                            newFile(result)
                        }
                    });
                }else{
                    // load as Image, fallback to detectType if it fails
                    var image = new Image();
                    image.onload = function(){
                        URL.revokeObjectURL(this.src);
                        newFile(image)
                        //Editor.set(image);
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
            reader.readAsDataURL(file);
        }
    }
    
    function newFile(image){
        Historyservice.clear();
        let w = 400;
        let h = 200;
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
    
    function addLayer(){
        currentFrame().layers.push(Layer(currentFile.width,currentFile.height));
        EventBus.trigger(EVENT.layersChanged);
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

    function currentFrame(){
        return currentFile.frames[activeFrameIndex];
    }

    EventBus.on(COMMAND.NEW,function(){
        console.log("new file");
        newFile();
        //panels.forEach(panel=>panel.clear());
    });

    EventBus.on(COMMAND.SAVE,function(){
        console.log("save file");
        me.save();
    });

    EventBus.on(COMMAND.INFO,function(){
        SidePanel.showInfo(currentFile);
    });

    EventBus.on(COMMAND.NEWLAYER,function(){
        SidePanel.show();
        addLayer();
    });

    EventBus.on(EVENT.layerContentChanged,function(){
       me.render();
       EventBus.trigger(EVENT.imageContentChanged);
    });

    return me;
}();

export default ImageFile;