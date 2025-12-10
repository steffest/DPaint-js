import $,{$div, $input, $elm} from "../../util/dom.js";
import Brush from "../brush.js";
import EventBus from "../../util/eventbus.js";
import {EVENT} from "../../enum.js";
import DitherPanel from "./ditherPanel.js";
import Modal, {DIALOG} from "../modal.js";

let BrushPanel = function(){
    let me = {};
    let sizeRange;
    let sizeInput;
    let softRange;
    let softInput;
    let opacityRange;
    let opacityInput;
    let flowRange;
    let flowInput;
    let jitterRange;
    let jitterInput;
    let rotationRange;
    let rotationInput;
    let ditherPatterns = [];

    me.generate = (parent)=> {
        let sizeSelect = $div("rangeselect", "", parent);
        $elm("label","Size",sizeSelect);
        sizeRange = $input("range",0,sizeSelect,()=>{
            Brush.setSize(sizeRange.value);
        });
        sizeInput = $input("text",1,sizeSelect);
        sizeRange.min = 1;
        sanitize(sizeInput,sizeRange);

        let softSelect = $div("rangeselect", "", parent);
        $elm("label","Softness",softSelect);
        softRange = $input("range",0,softSelect,()=>{
            Brush.setSoftness(softRange.value);
        });
        softInput = $input("text",0,softSelect);
        softRange.max = 10;
        sanitize(softInput,softRange);

        let opacitySelect = $div("rangeselect", "", parent);
        $elm("label","Opacity",opacitySelect);
        opacityRange = $input("range",100,opacitySelect,()=>{
            Brush.setOpacity(opacityRange.value);
        });
        opacityInput = $input("text",100,opacitySelect);
        opacityRange.min = 1;
        sanitize(opacityInput,opacityRange);

        let flowSelect = $div("rangeselect", "", parent);
        $elm("label","Flow",flowSelect);
        flowRange = $input("range",100,flowSelect,()=>{
            Brush.setFlow(flowRange.value);
        });
        flowInput = $input("text",100,flowSelect);
        flowRange.min = 1;
        sanitize(flowInput,flowRange);

        let jitterSelect = $div("rangeselect", "", parent);
        $elm("label","Jitter",jitterSelect);
        jitterRange = $input("range",0,jitterSelect,()=>{
            Brush.setJitter(jitterRange.value);
        });
        jitterInput = $input("text",0,jitterSelect);
        jitterRange.min = 0;
        sanitize(jitterInput,jitterRange);
        
        let rotationSelect = $div("rangeselect", "", parent);
        $elm("label","Rotation",rotationSelect);
        rotationRange = $input("range",0,rotationSelect,()=>{
            Brush.setRotation(rotationRange.value);
        });
        rotationInput = $input("text",0,rotationSelect);
        rotationRange.min = 0;
        sanitize(rotationInput,rotationRange);

        let ditherPanel = $div("dither",'',parent);
        $elm("label","Dither",ditherPanel);
        let patterns = $div("patterns","",ditherPanel);

        ditherPatterns = [];
        for (let i = 0; i<5; i++){
            let hasPattern = (i<4 && i>0)? " hasPattern" : "";
            ditherPatterns.push($div("pattern p"+i+hasPattern,"",patterns,()=>{
                if (i === 4){
                    Modal.show(DIALOG.DITHER);
                }else{
                    DitherPanel.setDitherPattern(i);
                }
            }))
        }
        ditherPatterns[0].classList.add("active");

        let presets = $div("presets","",parent);
        $(".subcaption",{parent:presets},"Presets")
        $(".preset",{parent:presets,style:{backgroundImage:'url("../_img/brushes/preview/0.png")'},onClick:()=>{
            Brush.set("preset",0);
        }})
        $(".preset",{parent:presets,onClick:()=>{
                Brush.set("preset",10);
            }})
        $(".preset",{parent:presets,style:{backgroundImage:'url("../_img/brushes/preview/2.png")'},onClick:()=>{
                Brush.set("preset",11);
            }})
        $(".preset",{parent:presets,style:{backgroundImage:'url("../_img/brushes/preview/3.png")'},onClick:()=>{
                Brush.set("preset",12);
            }})
        $(".preset",{parent:presets,style:{backgroundImage:'url("../_img/brushes/preview/4.png")'},onClick:()=>{
                Brush.set("preset",13);
            }})
    };


    function sanitize(input,range){
        range.min = range.min || 0;
        range.max = range.max || 100;

        input.onkeydown = (e)=>{
            e.stopPropagation();
        }

        input.oninput = (e)=>{
            let val = parseInt(input.value);
            if (isNaN(val)) val = range.min;
            if (val<range.min) val = range.min;
            if (val>range.max) val = range.max;
            range.value = val;
        }
    }

    EventBus.on(EVENT.brushOptionsChanged,()=>{
        let settings = Brush.get()
        sizeRange.value = sizeInput.value = settings.width;
        opacityRange.value = opacityInput.value = settings.opacity;
        jitterInput.value = jitterRange.value = settings.jitter || 0;
        rotationInput.value = rotationRange.value = settings.rotation || 0;
        flowInput.value = flowRange.value = settings.flow || 100;
        softRange.value = softInput.value = settings.softness || 0;


        let invert = DitherPanel.getDitherInvertState();
        ditherPatterns.forEach(elm=>{
            elm.classList.remove("active");
            elm.classList.toggle("invert",invert);
        })
        let ditherIndex = DitherPanel.getDitherIndex();
        let elm = ditherPatterns[ditherIndex];
        if (elm){
            elm.classList.add("active");
        }

    })

    return me;
}();

export default BrushPanel;