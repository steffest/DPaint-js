import ImageFile from "../../image.js";
import {$div, $elm} from "../../util/dom.js";
import EventBus from "../../util/eventbus.js";
import {COMMAND, EVENT} from "../../enum.js";
import input from "../input.js";
import Input from "../input.js";

let LayerPanel = function(){
    let me = {};
    let contentPanel;
    let dragData = {};
    let opacityRange;
    let blendSelect;
    
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
        opacityRange = document.createElement("input");
        opacityRange.type = "range";
        opacityRange.max=100;
        opacityRange.min=0;
        opacityRange.value = 100;
        opacityRange.oninput = ()=>{
            ImageFile.setLayerOpacity(opacityRange.value);
        }
        rangeSelect.appendChild(opacityRange);

        blendSelect = $div("blendselect","",toolbar);
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
        let max = frame.layers.length-1;
        for (let i = 0;i<=max;i++){
            let layer = frame.layers[i];
            let elm = $div("layer" + (activeIndex === i ? " active":"") + (layer.visible?"":" hidden"),layer.name,contentPanel,()=>{
                ImageFile.activateLayer(i);
            });
            elm.style.top = 46 + ((max-i)*23) + "px";
            elm.currentIndex = elm.targetIndex = i;
            elm.id = "layer" + i;

            elm.onDragStart = (e)=>{
                // TODO probably more performant if we postpone this to when we actually drag
                console.error("drag start");
                let dupe = $div("dragelement box",elm.innerText);
                elm.classList.add("ghost");
                Input.setDragElement(dupe,e);
            }

            elm.onDrag = (x,y)=>{
                let distance = Math.abs(y)

                if (distance>5){
                    // Meh... did we just did a rugpull regenerating the layer list? FIXME!
                    let currentTarget = contentPanel.querySelector("#layer" + elm.currentIndex);
                    currentTarget.classList.add("ghost");

                    let indexChange = Math.round(y/23);
                    let newIndex = elm.currentIndex - indexChange;
                    elm.targetIndex = newIndex;
                    if (newIndex<0) newIndex=0;
                    if (newIndex>=max) newIndex = max;
                    console.error(distance,elm.currentIndex , newIndex);


                    for (let i = 0;i<=max;i++){
                        let el = contentPanel.querySelector("#layer" + i);
                        if (el){
                            if (elm.currentIndex === i){
                                el.style.top = 46 + ((max-newIndex)*23) + "px";
                            }else{
                                let ci = 0;
                                if (newIndex<elm.currentIndex && i >= newIndex && i<=elm.currentIndex){
                                    ci=1;
                                }
                                if (newIndex>elm.currentIndex && i <= newIndex && i>=elm.currentIndex){
                                    ci=-1;
                                }
                                el.style.top = 46 + ((max-i-ci)*23) + "px";
                            }
                        }
                    }
                }
            }

            elm.onDragEnd = (e)=>{
                console.error("drop");
                Input.removeDragElement();
                let currentTarget = contentPanel.querySelector("#layer" + elm.currentIndex);
                currentTarget.classList.remove("ghost");
                if (elm.currentIndex !== elm.targetIndex){
                    ImageFile.moveLayer(elm.currentIndex,elm.targetIndex);
                }
            }

            $div("eye","",elm,()=>{
                ImageFile.toggleLayer(i);
            })

            if (activeIndex === i){
                opacityRange.value = layer.opacity;
                console.error(layer.blendMode);
                blendSelect.value = layer.blendMode;
            }
        }
    }

    EventBus.on(EVENT.layersChanged,me.list);


    return me;
}();

export default LayerPanel;