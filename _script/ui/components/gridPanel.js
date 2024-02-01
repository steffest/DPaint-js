import ImageFile from "../../image.js";
import EventBus from "../../util/eventbus.js";
import {COMMAND, EVENT} from "../../enum.js";
import $, {$div, $elm, $input} from "../../util/dom.js";
import Brush from "../brush.js";

let GridPanel = function(){
    let me = {};
    let sizeRange;
    let sizeInput;
    let opacityRange;
    let opacityInput;
    let brightnessRange;
    let brightnessInput;
    let visibleToggle;
    let contentPanel;
    let options={
        size: 32,
        brightness: 0,
        opacity: 100,
        visible: false
    }

    me.generate = (parent)=>{

        let visibleSelect = $div("rangeselect", "", parent);
        $elm("label","Visible",visibleSelect);
        visibleToggle = $(".yesno",{parent:visibleSelect,onClick:(e)=>{
            EventBus.trigger(COMMAND.TOGGLEGRID);
            },info:"Show or hide the grid"},$(".option","Yes"),$(".option","No"));




        let sizeSelect = $div("rangeselect", "", parent);
        $elm("label","Size",sizeSelect);
        sizeRange = $input("range",options.size,sizeSelect,()=>{
            update();
        });
        sizeInput = $input("text",options.size,sizeSelect);
        sizeRange.min = 16;
        sizeRange.max = 100;
        sanitize(sizeInput,sizeRange);


        let opacitySelect = $div("rangeselect", "", parent);
        $elm("label","Opacity",opacitySelect);
        opacityRange = $input("range",options.opacity,opacitySelect,()=>{
            update();
        });
        opacityInput = $input("text",options.opacity,opacitySelect);
        opacityRange.min = 1;
        opacityRange.max = 100;
        sanitize(opacityInput,opacityRange);

        let brightnessSelect = $div("rangeselect", "", parent);
        $elm("label","Brightness",brightnessSelect);
        brightnessRange = $input("range",options.brightness,brightnessSelect,()=>{
            update();
        });
        brightnessInput = $input("text",options.brightness,brightnessSelect);
        brightnessRange.min = 0;
        brightnessRange.max = 100;
        sanitize(brightnessInput,brightnessRange);

        contentPanel = $div("panelcontent","",parent);

    }

    me.getOptions = ()=>{
        return options;
    }

    function update(){
        options.size = parseInt(sizeRange.value);
        options.opacity = parseInt(opacityRange.value);
        options.brightness = parseInt(brightnessRange.value);

        EventBus.trigger(EVENT.gridOptionsChanged,options);
    }

    function sanitize(input,range){
        range.min = range.min || 0;
        range.max = range.max || 100;
        let min = parseInt(range.min);
        let max = parseInt(range.max);

        input.onkeydown = (e)=>{
            e.stopPropagation();
        }

        input.onchange = (e)=>{
            let val = parseInt(input.value,10);
            if (isNaN(val)) val = min;
            if (val<min) val = min;
            if (val>max) val = max;
            range.value = val;
            update();
        }
    }

    EventBus.on(EVENT.gridOptionsChanged,(_options)=>{
        options = _options;
        sizeRange.value = options.size;
        sizeInput.value = options.size;
        opacityRange.value = options.opacity;
        opacityInput.value = options.opacity;
        brightnessRange.value = options.brightness;
        brightnessInput.value = options.brightness;
    });

    EventBus.on(COMMAND.TOGGLEGRID,()=>{
        options.visible = !options.visible;
        visibleToggle.classList.toggle("selected",options.visible);
    });




    return me;
}()

export default GridPanel;