import {COMMAND, EVENT} from "../enum.js";
import {$div} from "../util/dom.js";
import ImageProcessing from "../util/imageProcessing.js";
import ImageFile from "../image.js";
import EventBus from "../util/eventbus.js";

var SidePanel = function(){
    let me = {}
    let container;
    let infoPanel;
    let framesPanel;
    let layersPanel;
    
    me.init = parent=>{
        container = $div("sidepanel");
        parent.appendChild(container);
        generate();

        EventBus.on(EVENT.layersChanged,listLayers);
        EventBus.on(EVENT.imageSizeChanged,listFrames);
    }

    me.show = ()=>{
        document.body.classList.add("withsidepanel");
    }

    me.hide = ()=>{
        document.body.classList.remove("withsidepanel");
    }

    me.showInfo = (file)=>{
        let contentPanel = infoPanel.querySelector(".inner");
        if (contentPanel){
            if (file && file.width){
                contentPanel.innerHTML = "";
                generateInfoLine("Width",file.width + "px",contentPanel);
                generateInfoLine("Height",file.height + "px",contentPanel);
                generateInfoLine("Colors",ImageProcessing.getColors(ImageFile.getCanvas()).length,contentPanel);
            }else{
                contentPanel.innerHTML = "<small>No file present</small>";
            }
            console.error(contentPanel,file);
        }
        listFrames();
        me.show();
    }

    function generate(){
        infoPanel = generatePanel("Info",container);
        framesPanel = generatePanel("Frames",container);
        layersPanel = generatePanel("Layers",container);
    }

    function generatePanel(title,parent){
        let panel = $div("panel " + title.toLowerCase(),"",parent);
        let caption = $div("caption",title,panel);
        let close = $div("close","x",caption,me.hide);
        $div("inner","",panel);
        return panel;
    }

    function generateInfoLine(label,value,parent){
        let line = document.createElement("dl");
        let dt = document.createElement("dt");
        dt.innerHTML = label;
        let dd = document.createElement("dd");
        dd.innerHTML = value;
        line.appendChild(dt);
        line.appendChild(dd);
        parent.appendChild(line);
    }

    function listLayers(){
        let contentPanel = layersPanel.querySelector(".inner");
        contentPanel.innerHTML = "";
        let activeIndex = ImageFile.getActiveLayerIndex() || 0;
        let imageFile = ImageFile.getCurrentFile();
        let frame = imageFile.frames[ImageFile.getActiveFrameIndex()];
        for (let i = frame.layers.length-1;i>=0;i--){
            let layer = frame.layers[i];
            let elm = $div("layer" + (activeIndex === i ? " active":"") + (layer.visible?"":" hidden"),"Layer " + i,contentPanel,()=>{
                ImageFile.activateLayer(i);
            });

            $div("eye","",elm,()=>{
                ImageFile.toggleLayer(i);
            })
        }
    }

    function listFrames(){
        let contentPanel = framesPanel.querySelector(".inner");
        contentPanel.innerHTML = "";
        let activeIndex = ImageFile.getActiveFrameIndex() || 0;
        let imageFile = ImageFile.getCurrentFile();
        if (imageFile && imageFile.frames){
            imageFile.frames.forEach((frame,index)=>{
                let elm = $div("frame" + (activeIndex === index ? " active":""),"",contentPanel,()=>{
                    ImageFile.activateFrame(index);
                });

                let canvas = document.createElement("canvas");
                canvas.width = 50;
                canvas.height = 50;
                canvas.getContext("2d").drawImage(ImageFile.getCanvas(index),0,0,50,50);
                elm.appendChild(canvas);

                $div("label","" + index,elm);

            });
        }
    }
    
    return me;
}()

export default SidePanel;