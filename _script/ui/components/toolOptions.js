import {$checkbox, $div, $elm, $input} from "../../util/dom.js";
import {COMMAND, EVENT} from "../../enum.js";
import EventBus from "../../util/eventbus.js";
import ImageFile from "../../image.js";
import BrushPanel from "../toolPanels/brushPanel.js";
import Brush from "../brush.js";
import DitherPanel from "../toolPanels/ditherPanel.js";
import Text from "../../paintTools/text.js";

let ToolOptions = function(){
    let me = {}
    let smooth = false;
    let pixelPerfect    = false;
    let fill = false;
    let lineSize = 1;
    let tolerance = 0;
    let strength = 50;
    let spread = 20;
    let mask = false;
    let selectionOutline = true;
    let selectionMask = false;
    let pressure = false;

    let smoothCheckbox;
    let pixelPerfectCheckbox;
    let maskCheckbox;
    let selectSection;
    let selectionOutlineCheckbox;
    let selectionMaskCheckbox;
    let ditherSection;
    let ditherCheckbox;
    let invertCheckbox;
    let pressureCheckbox;
    let pressureOpacityCheckbox;
    let fillCheckbox;
    let lineSizeRange;
    let toleranceRange;
    let strengthRange;
    let spreadRange;
    let brushOptionGroup;
    let brushSettings={};
    let smudgeAction = "Smudge";
    let smudgeSelect;
    let fontOptionGroup;
    let fontSettings={};

    me.isSmooth = ()=>{
        return smooth;
    }

    me.isPixelPerfect = ()=>{
        return pixelPerfect;
    }

    me.isFill = ()=>{
        return fill;
    }

    me.showMask = ()=>{
        return mask;
    }

    me.showSelectionOutline = ()=>{
        return selectionOutline;
    }

    me.showSelectionMask = ()=>{
        return selectionMask;
    }

    me.usePressure = ()=>{
       return pressure;
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

    me.getStrength = ()=>{
        return strength/100;
    }

    me.getSpread = ()=>{
        return spread;
    }

    me.getSmudgeAction = ()=>{
        return smudgeAction.toLowerCase();
    }

    me.getFont = ()=>{
        return fontSettings.name;
    }

    me.getFontSize = ()=>{
        return fontSettings.size;
    }

    me.getOptions = (command)=>{
        let options = $div("options");
        switch (command){
            case COMMAND.DRAW:
                options.appendChild(label("Brush:"));
                options.appendChild(brushSetting(true));
                options.appendChild(ditherSetting());
                options.appendChild(pressureSetting());
                break;
            case COMMAND.ERASE:
                options.appendChild(label("Erase:"));
                options.appendChild(brushSetting(true));
                options.appendChild(ditherSetting());
                break;
            case COMMAND.SMUDGE:
                options.appendChild(smudgeLabel());
                options.appendChild(brushSetting());
                options.appendChild(strengthSetting());
                options.appendChild(ditherSetting());
                break;
            case COMMAND.SPRAY:
                options.appendChild(label("Spray:"));
                options.appendChild(spreadSetting());
                options.appendChild(strengthSetting());
                options.appendChild(pressureOpacitySetting());
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
            case COMMAND.SELECT:
            case COMMAND.POLYGONSELECT:
            case COMMAND.FLOODSELECT:
                options.appendChild(selectSetting());
                if (command === COMMAND.FLOODSELECT) options.appendChild(toleranceSetting());
                break;
            case COMMAND.FLOOD:
                options.appendChild(label("Fill:"));
                options.appendChild(toleranceSetting());
                break;
            case COMMAND.TRANSFORMLAYER:
                options.appendChild(label("Transform rotation:"));
                options.appendChild(smoothSetting());
                options.appendChild(pixelPerfectSetting());
                break;
            case COMMAND.TEXT:
                options.appendChild(label("Font:"));
                options.appendChild(fontSetting());
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

    function pixelPerfectSetting(){
        if (!pixelPerfectCheckbox) pixelPerfectCheckbox=$checkbox("Pixel Optimized","","",(checked)=>{
            pixelPerfect = checked;
        });
        return pixelPerfectCheckbox;
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

    function brushSetting(withOpacity){
        let brushOpacityRange;
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


            brushOpacityRange = $div("range opacity","",brushOptionGroup);
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
                if (invertCheckbox) invertCheckbox.setState(DitherPanel.getDitherInvertState());
            })

        }

        if (!brushOpacityRange) brushOpacityRange = brushOptionGroup.querySelector(".opacity");
        if (withOpacity){
            brushOpacityRange.style.display = "block";
        }else {
            brushOpacityRange.style.display = "none";
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

    function selectSetting(){
        if (!selectSection){
            selectSection = $div("optionsgroup");
            selectionMaskCheckbox=$checkbox("Show Mask",selectSection,"mask",(checked)=>{
                selectionMask = checked;
                EventBus.trigger(EVENT.selectionChanged);
            });
            selectionOutlineCheckbox=$checkbox("Show Outline",selectSection,"",(checked)=>{
                selectionOutline = checked;
                EventBus.trigger(EVENT.selectionChanged);
            });
        }
        selectionOutlineCheckbox.setState(selectionOutline);
        selectionMaskCheckbox.setState(selectionMask);
        return selectSection;
    }

    function ditherSetting(){
        if (!ditherSection){
            ditherSection = $div("inline flex");
            ditherCheckbox=$checkbox("Dither",ditherSection,"inline info",(checked)=>{
                DitherPanel.setDitherState(checked);
            });
            ditherCheckbox.info="Toggle Brush Dither Pattern";

            invertCheckbox=$checkbox("Invert",ditherSection,"info",(checked)=>{
                DitherPanel.setDitherInvertState(checked);
            });
            invertCheckbox.info="<b>I</b> Invert Brush Dither Pattern";
        }
        ditherCheckbox.setState(DitherPanel.getDitherState());
        invertCheckbox.setState(DitherPanel.getDitherInvertState());
        return ditherSection;
    }

    function pressureSetting(){
        if (!pressureCheckbox) pressureCheckbox=$checkbox("Pressure","","pressure info",(checked)=>{
            pressure = checked;
        });
        pressureCheckbox.info="Toggle brush pressure sensitivity";
        pressureCheckbox.setState(pressure);
        return pressureCheckbox;
    }

    function pressureOpacitySetting(){
        if (!pressureOpacityCheckbox) pressureOpacityCheckbox=$checkbox("Opacity","","pressure info inline",(checked)=>{
            pressure = checked;
        });
        pressureOpacityCheckbox.info="Use random opacity when spraying";
        pressureOpacityCheckbox.setState(pressure);
        return pressureOpacityCheckbox;
    }

    function strengthSetting(){
        if (!strengthRange){
            strengthRange = $div("range");
            $elm("label","Strength:",strengthRange,"inline");
            let range = document.createElement("input");
            range.type="range";
            range.min=0;
            range.max=100;
            range.value = strength;
            strengthRange.appendChild(range);
            let value = $elm("span",strength,strengthRange);
            range.oninput = function(){
                value.innerText = range.value;
                strength = range.value;
            }

        }
        return strengthRange;
    }

    function spreadSetting(){
        if (!spreadRange){
            spreadRange = $div("range");
            $elm("label","Spread:",spreadRange,"inline");
            let range = document.createElement("input");
            range.type="range";
            range.min=1;
            range.max=100;
            range.value = spread;
            spreadRange.appendChild(range);
            let value = $elm("span",spread,spreadRange);
            range.oninput = function(){
                value.innerText = range.value;
                spread = range.value;
            }

        }
        return spreadRange;
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

    function smudgeLabel(){
        let options = ["Smudge","Blur","Sharpen"];
        if (!smudgeSelect){
            smudgeSelect = $elm("select","",null,"inline");
            options.forEach((option)=>{
                let opt = document.createElement("option");
                opt.value = option;
                opt.innerText = option;
                smudgeSelect.appendChild(opt);
            });
            smudgeSelect.onchange = function(){
                smudgeAction = smudgeSelect.value;
            }
        }
        return smudgeSelect;
    }

    function fontSetting(){
        let options = Text.getFonts();
        if (!fontOptionGroup){
            fontOptionGroup = $div("optionsgroup");


            let fontSelect = $elm("select","",fontOptionGroup,"inline");
            options.forEach((option)=>{
                let opt = document.createElement("option");
                opt.value = option;
                opt.innerText = option;
                fontSelect.appendChild(opt);
            });
            fontSettings.name = options[0];
            fontSelect.onchange = function(){
                fontSettings.name = fontSelect.value;
                EventBus.trigger(EVENT.fontStyleChanged,fontSettings);
            }

            let fontSizeRange = $div("range","",fontOptionGroup);
            $elm("label","Size:",fontSizeRange,"inline");
            let range = document.createElement("input");
            range.type="range";
            range.min=5;
            range.max=100;
            range.value = 32;
            fontSizeRange.appendChild(range);
            fontSettings.size = range.value;
            let value = $elm("span",fontSettings.size+"px",fontSizeRange);
            range.oninput = function(){
                value.innerText = range.value + "px";
                fontSettings.size = range.value;
                EventBus.trigger(EVENT.fontStyleChanged,fontSettings);
            }
        }
        return fontOptionGroup;
    }

    function label(text){
        let label = document.createElement("span");
        label.className = "tool";
        label.innerText = text;
        return label;
    }



    function lineWidthSetting(){

    }

    EventBus.on(COMMAND.TOGGLEMASK,()=>{
        mask = !mask;
        if (window.override) mask=false;
        EventBus.trigger(EVENT.layerContentChanged);
    });

    return me;
}();

export default ToolOptions;