import {$checkbox, $div, $elm, $input} from "../../util/dom.js";
import {COMMAND, EVENT} from "../../enum.js";
import EventBus from "../../util/eventbus.js";
import ImageFile from "../../image.js";
import BrushPanel from "./brushPanel.js";
import Brush from "../brush.js";
import DitherPanel from "./ditherPanel.js";

let ToolOptions = function(){
    let me = {}
    let smooth = false;
    let fill = false;
    let lineSize = 1;
    let tolerance = 0;
    let mask = false;

    let smoothCheckbox;
    let maskCheckbox;
    let ditherCheckbox;
    let fillCheckbox;
    let lineSizeRange;
    let toleranceRange;
    let brushOptionGroup;
    let brushSettings={};

    me.isSmooth = ()=>{
        return smooth;
    }

    me.isFill = ()=>{
        return fill;
    }

    me.showMask = ()=>{
        return mask;
    }

    me.setFill = (state)=>{
        fill = !!state;
        if (fillCheckbox){
            let cb = fillCheckbox.querySelector("input");
            if (cb) cb.checked = fill;
        }
        EventBus.trigger(EVENT.toolOptionsChanged);
    }

    me.getLineSize = ()=>{
        return lineSize;
    }

    me.getTolerance = ()=>{
        return tolerance;
    }

    me.getOptions = (command)=>{
        let options = $div("options");
        switch (command){
            case COMMAND.DRAW:
                options.appendChild(label("Brush:"));
                options.appendChild(brushSetting());
                options.appendChild(ditherSetting());
                break;
            case COMMAND.SMUDGE:
                options.appendChild(label("Brush:"));
                options.appendChild(brushSetting());
                break;
            case COMMAND.LINE:
                options.appendChild(label("Line:"));
                options.appendChild(smoothSetting());
                options.appendChild(lineSetting());
                break;
            case COMMAND.SQUARE:
                options.appendChild(label("Rectangle:"));
                options.appendChild(fillSetting());
                options.appendChild(lineSetting());
                break;
            case COMMAND.CIRCLE:
                options.appendChild(label("Circle:"));
                options.appendChild(fillSetting());
                options.appendChild(smoothSetting());
                options.appendChild(lineSetting());
                break;
            case COMMAND.GRADIENT:
                options.appendChild(label("Gradient:"));
                options.appendChild(ditherSetting());
                break;
            case COMMAND.FLOOD:
            case COMMAND.FLOODSELECT:
                options.appendChild(toleranceSetting());
                break;
        }

        let activeLayer = ImageFile.getActiveLayer();
        if (activeLayer.isMaskActive()){
            options.appendChild(maskSetting());
        }
        return options;
    }

    function smoothSetting(){
        if (!smoothCheckbox) smoothCheckbox=$checkbox("Smooth","","",(checked)=>{
            smooth = checked;
        });
        return smoothCheckbox;
    }

    function fillSetting(){
        if (!fillCheckbox) fillCheckbox=$checkbox("Fill","","",(checked)=>{
            fill = checked;
            EventBus.trigger(EVENT.toolOptionsChanged);
        });
        return fillCheckbox;
    }

    function lineSetting(){
        if (!lineSizeRange){
            lineSizeRange = $div("range");
            $elm("label","Size:",lineSizeRange);
            let range = document.createElement("input");
            range.type="range";
            range.min=1;
            range.max=10;
            range.value = 1;
            lineSizeRange.appendChild(range);
            let value = $elm("span","1px",lineSizeRange);
            range.oninput = function(){
                value.innerText = range.value + "px";
                lineSize = range.value;
            }

        }
        return lineSizeRange;
    }

    function brushSetting(){
        if (!brushOptionGroup){
            let settings = Brush.getSettings();
            brushOptionGroup = $div("optionsgroup");
            let brushSizeRange = $div("range","",brushOptionGroup);
            $elm("label","Size:",brushSizeRange);
            brushSettings.sizeRange = $input("range",settings.width,brushSizeRange)
            brushSettings.sizeRange.min=1;
            brushSettings.sizeRange.max=100;
            brushSettings.sizeInput = $elm("span", settings.width+"px",brushSizeRange);
            brushSettings.sizeRange.oninput = function(){
                BrushPanel.set({size:brushSettings.sizeRange.value});
            }


            let brushOpacityRange = $div("range","",brushOptionGroup);
            $elm("label","Opacity:",brushOpacityRange,"inline");
            brushSettings.opacityRange = $input("range",settings.opacity,brushOpacityRange)
            brushSettings.opacityRange.min=1;
            brushSettings.opacityRange.max=100;
            brushSettings.opacityInput = $elm("span",settings.opacity + "%",brushOpacityRange);
            brushSettings.opacityRange.oninput = function(){
                BrushPanel.set({opacity:brushSettings.opacityRange.value});
            }

            EventBus.on(EVENT.brushOptionsChanged,()=>{
                let settings = Brush.getSettings();
                brushSettings.sizeRange.value = settings.width;
                brushSettings.sizeInput.innerText = settings.width + "px" ;
                brushSettings.opacityRange.value = settings.opacity;
                brushSettings.opacityInput.innerText = settings.opacity + "%" ;
                if (ditherCheckbox) ditherCheckbox.setState(DitherPanel.getDitherState());
            })

        }

        return brushOptionGroup;
    }

    function maskSetting(){
        if (!maskCheckbox) maskCheckbox=$checkbox("Show Mask","","mask",(checked)=>{
            mask = checked;
            EventBus.trigger(EVENT.layerContentChanged);
        });
        return maskCheckbox;
    }

    function ditherSetting(){
        if (!ditherCheckbox) ditherCheckbox=$checkbox("Dither","","inline",(checked)=>{
            DitherPanel.setDitherState(checked);
        });
        ditherCheckbox.setState(DitherPanel.getDitherState());
        return ditherCheckbox;
    }

    function toleranceSetting(){
        if (!toleranceRange){
            toleranceRange = $div("range");
            $elm("label","Tolerance:",toleranceRange);
            let range = document.createElement("input");
            range.type="range";
            range.min=0;
            range.max=100;
            range.value = 0;
            toleranceRange.appendChild(range);
            let value = $elm("span","0",toleranceRange);
            range.oninput = function(){
                value.innerText = range.value;
                tolerance = range.value;
            }

        }
        return toleranceRange;
    }

    function label(text){
        let label = document.createElement("span");
        label.className = "tool";
        label.innerText = text;
        return label;
    }

    function lineWidthSetting(){

    }


    return me;
}();

export default ToolOptions;