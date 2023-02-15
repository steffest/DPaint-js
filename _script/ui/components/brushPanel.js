import {$div, $input, $elm} from "../../util/dom.js";
import Brush from "../brush.js";
import EventBus from "../../util/eventbus.js";
import {EVENT} from "../../enum.js";

let BrushPanel = function(){
    let me = {};
    let sizeRange;
    let sizeInput;
    let softRange;
    let opacityRange;
    let opacityInput;

    me.generate = (parent)=> {

        let sizeSelect = $div("rangeselect", "", parent);
        $elm("label","Size",sizeSelect);
        sizeRange = $input("range",0,sizeSelect,()=>{
            update();
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
        });
        opacityInput = $input("text",100,opacitySelect);
        opacityRange.min = 1;
        sanitize(opacityInput,opacityRange);
    };

    function update(){
        let size = parseInt(sizeRange.value);
        let soft = parseInt(softRange.value);
        let opacity = parseInt(opacityRange.value);
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
    })

    return me;
}();

export default BrushPanel;