import ImageFile from "../../image.js";
import {$div, $elm} from "../../util/dom.js";
import EventBus from "../../util/eventbus.js";
import {COMMAND, EVENT} from "../../enum.js";
import input from "../input.js";

let LayerPanel = function(){
    let me = {};
    let container;
    let contentPanel;
    
    let blendModes=[
        "normal",
        "lighter",
        "multiply",
        "screen",
        "overlay",
        "darken",
        "lighten",
        "color-dodge",
        "color-burn",
        "hard-light",
        "soft-light",
        "hue",
        "saturation",
        "color",
        "luminosity",
    ]

    me.generate = (parent)=>{
        let toolbar = $div("paneltools multirow","",parent);
        let rangeSelect = $div("rangeselect","",toolbar);
        $div("label","Opacity",rangeSelect);
        let range = document.createElement("input");
        range.type = "range";
        range.max=100;
        range.min=0;
        range.value = 100;
        range.oninput = ()=>{
            ImageFile.setLayerOpacity(range.value);
        }
        rangeSelect.appendChild(range);

        let blendSelect = $div("blendselect","",toolbar);
        $div("label","Blend",blendSelect);
        let select = $elm("select","",blendSelect);
        blendModes.forEach(mode=>{
            $elm("option",mode,select);
        });
        select.oninput = ()=>{
            ImageFile.setLayerBlendMode(select.value);
        }



        $div("button delete","",toolbar,()=>{
            EventBus.trigger(COMMAND.DELETELAYER);
        });
        $div("button add","",toolbar,()=>{
            EventBus.trigger(COMMAND.NEWLAYER);
        });

        contentPanel = $div("panelcontent","",parent);
    }

    me.list = ()=>{
        contentPanel.innerHTML = "";
        let activeIndex = ImageFile.getActiveLayerIndex() || 0;
        let imageFile = ImageFile.getCurrentFile();
        let frame = imageFile.frames[ImageFile.getActiveFrameIndex()];
        for (let i = frame.layers.length-1;i>=0;i--){
            let layer = frame.layers[i];
            let elm = $div("layer" + (activeIndex === i ? " active":"") + (layer.visible?"":" hidden"),"Layer " + i,contentPanel,()=>{
                ImageFile.activateLayer(i);
            });
            elm.style.top = 46 + (i*23) + "px";

            elm.onDrag = (e)=>{
                console.error("drag");

            }

            elm.onDragEnd = (e)=>{
                console.error("drop");
            }

            $div("eye","",elm,()=>{
                ImageFile.toggleLayer(i);
            })
        }
    }

    EventBus.on(EVENT.layersChanged,me.list);


    return me;
}();

export default LayerPanel;