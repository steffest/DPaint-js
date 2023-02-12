import {$div, $input} from "../../util/dom.js";
import Brush from "../brush.js";

let BrushPanel = function(){
    let me = {};
    let sizeRange;
    let softRange;

    me.generate = (parent)=> {

        let sizeSelect = $div("rangeselect", "", parent);
        sizeRange = $input("range",0,sizeSelect,()=>{
           update();
        })
        sizeRange.min = 1;


        let softSelect = $div("rangeselect", "", parent);
        softRange = $input("range",0,softSelect,()=>{
            update();
        });
        softRange.max = 10;
    };

    function update(){
        let size = parseInt(sizeRange.value);
        let soft = parseInt(softRange.value);
        Brush.set("dynamic",{width: size, height: size, softness: soft});
    }

    return me;
}();

export default BrushPanel;