import Editor from "./ui/editor.js";
import FileDetector from "./fileformats/detect.js";
import EventBus from "./util/eventbus.js";
import {COMMAND, EVENT} from "./enum.js";
import Historyservice from "./services/historyservice.js";
import Layer from "./ui/layer.js";
import IFF from "./fileformats/iff.js";
import saveAs from "./util/filesaver.js";

let ImageFile = function(){
    let me = {};
    let activeLayer;
    let currentFile = {
        layers:[]
    }
    
    me.getCanvas = function(){
        if (currentFile.layers.length === 1 && activeLayer){
            return activeLayer.getCanvas();
        }
    }
    
    me.getContext = function(){
        if (currentFile.layers.length === 1 && activeLayer){
            return activeLayer.getContext();
        }
    }

    me.getActiveContext = function(){
        if (activeLayer) return activeLayer.getContext();
    }
    
    me.render = function(){
        if (currentFile.layers.length>1){
           
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
        var buffer = IFF.write(activeLayer.getCanvas());

        var blob = new Blob([buffer], {type: "application/octet-stream"});
        var fileName = 'test.iff';
        saveAs(blob,fileName);
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
                            Editor.set(result[0]);
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
            layers:[]
        }
        addLayer();
        activeLayer = currentFile.layers[0];
        activeLayer.clear();
        if (image){
            activeLayer.getContext().drawImage(image,0,0);
        }
        EventBus.trigger(EVENT.imageSizeChanged);
    }
    
    function addLayer(){
        currentFile.layers.push(Layer(currentFile.width,currentFile.height));
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

    EventBus.on(COMMAND.NEWLAYER,function(){
        addLayer();
        document.body.classList.add("withsidepanel");
    });

    EventBus.on(EVENT.layerContentChanged,function(){
       me.render();
       EventBus.trigger(EVENT.imageContentChanged);
    });

    return me;
}();

export default ImageFile;