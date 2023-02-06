import {$checkbox, $div, $elm} from "../../util/dom.js";
import {COMMAND} from "../../enum.js";

let ToolOptions = function(){
    let me = {}
    let smooth = false;
    let lineSize = 1;

    let smoothCheckbox;
    let lineSizeRange;

    me.isSmooth = ()=>{
        return smooth;
    }

    me.getLineSize = ()=>{
        return lineSize;
    }

    me.getOptions = (command)=>{
        let options = $div("options");
        switch (command){
            case COMMAND.LINE:
                options.appendChild(label("Line:"));
                options.appendChild(smoothSetting())
                options.appendChild(lineSetting())
                break;
        }
        return options;
    }

    function smoothSetting(){
        if (!smoothCheckbox) smoothCheckbox=$checkbox("Smooth");
        return smoothCheckbox;
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