import {$div} from "../util/dom.js";
import Eventbus from "../util/eventbus.js";
import Input from "./input.js";
import {COMMAND, EVENT} from "../enum.js";
import Editor from "./editor.js";

var Cursor = function(){
    var me = {}
    var cursor;
    var cursorMark;
    let position = {x:0,y:0}
    
    me.init = function(){
        cursor = $div("cursor");
        cursorMark = $div("mark","",cursor);
        document.body.appendChild(cursor);

        document.body.addEventListener("mousemove", function (e) {
            position = {x:e.clientX,y:e.clientY};
            cursor.style.left =  e.clientX  + "px";
            cursor.style.top =  e.clientY  + "px";
            //cursor.style.transform = "translate(" + e.clientX + "px," + e.clientY + "px)";
        }, false);
        
        Eventbus.on(EVENT.drawColorChanged,(color)=>{
            cursorMark.style.borderColor = "rgb(" + color[0] + "," + color[1] + "," + color[2] + ")";
         })
    }

    me.set = function(name){
        document.body.classList.add("customcursor");
        if (name === "colorpicker") document.body.classList.add("colorpicker");
        cursor.className = "cursor " + name;
    }

    me.reset = function(name){
        document.body.classList.remove("customcursor","colorpicker");
        cursor.className = "cursor";
    }

    me.getPosition = ()=>{
        return position;
    }

    Eventbus.on(EVENT.modifierKeyChanged,()=>{
        let ct = Editor.getCurrentTool();
        if (ct===COMMAND.DRAW){
            if (Input.isShiftDown() || Input.isAltDown()){
                me.set("colorpicker");
            }else{
                me.reset();
            }
        }

    })
    
    return me;
}();

export default Cursor;