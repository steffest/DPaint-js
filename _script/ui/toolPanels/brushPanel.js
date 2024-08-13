import {$div, $input, $elm} from "../../util/dom.js";
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
    let opacityRange;
    let opacityInput;
    let ditherPatterns = [];

    me.generate = (parent)=> {

        let sizeSelect = $div("rangeselect", "", parent);
        $elm("label","Size",sizeSelect);
        sizeRange = $input("range",0,sizeSelect,()=>{
            update();
            sizeInput.value = sizeRange.value;
        });
        sizeInput = $input("text",1,sizeSelect);
        sizeRange.min = 1;
        sanitize(sizeInput,sizeRange);

        let softSelect = $div("rangeselect", "", parent);
        $elm("label","Softness",softSelect);
        softRange = $input("range",0,softSelect,()=>{
            update();
            softInput.value = softRange.value;
        });
        let softInput = $input("text",0,softSelect);
        softRange.max = 10;
        sanitize(softInput,softRange);

        let opacitySelect = $div("rangeselect", "", parent);
        $elm("label","Opacity",opacitySelect);
        opacityRange = $input("range",100,opacitySelect,()=>{
            update();
            opacityInput.value = opacityRange.value;
        });
        opacityInput = $input("text",100,opacitySelect);
        opacityRange.min = 1;
        sanitize(opacityInput,opacityRange);

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




    };

    function update(){
        let size = parseInt(sizeRange.value);
        let soft = parseInt(softRange.value);
        let opacity = parseInt(opacityRange.value);
        // TODO: this is not always "dynamic" - it should be set to the current brush type
        // FIXME
        Brush.set("dynamic",{width: size, height: size, softness: soft, opacity: opacity});
    }

    me.set = function(settings){
        let doUpdate = false;
        if (settings.size){
            sizeRange.value = settings.size;
            doUpdate=true;
        }
        if (settings.opacity){
            opacityRange.value = settings.opacity;
            doUpdate=true;
        }
        if (doUpdate) update();
    }

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
            update();
        }
    }

    EventBus.on(EVENT.brushOptionsChanged,()=>{
        let settings = Brush.getSettings();
        sizeRange.value = settings.width;
        sizeInput.value = settings.width;
        opacityRange.value = settings.opacity;
        opacityInput.value = settings.opacity;

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