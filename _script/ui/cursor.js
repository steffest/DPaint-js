import {$div} from "../util/dom.js";
import Eventbus from "../util/eventbus.js";
import Input from "./input.js";
import {COMMAND, EVENT} from "../enum.js";
import Editor from "./editor.js";
import {getVectorToolIfLoaded} from "../paintTools/vectorToolLoader.js";

var Cursor = function(){
    var me = {}
    var cursor;
    var cursorMark;
    var toolTip;
    let position = {x:0,y:0}
    let defaultCursor = "default";
    let currentCursor = undefined;
    let overrideCursor = undefined;
    
    me.init = function(){
        cursor = $div("cursor");
        cursorMark = $div("mark","",cursor);
        toolTip = $div("tooltip","",cursor);
        document.body.appendChild(cursor);

        document.body.addEventListener("pointermove", function (e) {
            position = {x:e.clientX,y:e.clientY};
            cursor.style.left =  e.clientX  + "px";
            cursor.style.top =  e.clientY  + "px";
        }, false);
        
        Eventbus.on(EVENT.drawColorChanged,(color)=>{
            cursorMark.style.borderColor = "rgb(" + color[0] + "," + color[1] + "," + color[2] + ")";
         })
    }

    me.set = function(name){
        currentCursor = name;
        setCursor();
    }

    me.reset = function(){
        currentCursor = undefined;
        setCursor();
    }

    me.isCurrent = function(name){
        return currentCursor === name;
    }

    me.override = function(name){
        overrideCursor = name;
        setCursor();
    }

    me.hasOverride = function(name){
        return overrideCursor === name;
    }

    me.resetOverride = function(){
        overrideCursor = undefined;
        setCursor();
    }

    me.resetSize = function(){
        cursorMark.classList.remove("large");
    }

    me.attach = function(enlarge){
        cursor.style.display = "block";
        cursorMark.style.display = "block";
        cursorMark.classList.toggle("large",enlarge);
    }

    me.getPosition = ()=>{
        return position;
    }

    me.setPosition = function(x,y){
        position.x = x;
        position.y = y;
        cursor.style.left =  x  + "px";
        cursor.style.top =  y  + "px";
    }

    function setCursor(){
        document.body.classList.forEach((c)=>{
            if (c.startsWith("cursor-")) document.body.classList.remove(c);
        });
        let cursorName = overrideCursor || currentCursor || defaultCursor;
        document.body.classList.add("cursor-" + cursorName);
    }

    function updateSelectionModifierCursor(){
        let tool = Editor.getCurrentTool();
        let isSelectionTool = tool === COMMAND.SELECT || tool === COMMAND.POLYGONSELECT || tool === COMMAND.FLOODSELECT;
        document.body.classList.toggle("selection-add", isSelectionTool && Input.isShiftDown() && !Input.isAltDown());
        document.body.classList.toggle("selection-subtract", isSelectionTool && Input.isAltDown() && !Input.isShiftDown());
        // Ctrl-drag on the selection body moves the pixel content instead of the marquee
        // (selectbox.js) — only the rectangular Select tool shows the resizer's .sizebox at all.
        document.body.classList.toggle("selection-cut", tool === COMMAND.SELECT && Input.isControlDown());
    }

    Eventbus.on(EVENT.modifierKeyChanged,()=>{
        if ((Input.isShiftDown() || Input.isAltDown()) && Editor.canPickColor(Input.isPointerDown())){
            me.override("colorpicker");
        }else{
            me.resetOverride();
        }

        if (Input.isSpaceDown()){
            me.override("pan");
        }

        updateSelectionModifierCursor();

        // On a vector layer, toggling Control over a line flips the action cursor between "bend the
        // curve" and "add a point" — re-query it here so it updates without moving the mouse.
        let VectorTool = getVectorToolIfLoaded();
        if (VectorTool?.isActive()){
            let vc = VectorTool.getHoverCursor(Input.isControlDown());
            if (vc) me.set(vc); else me.reset();
        }
    })

    Eventbus.on(EVENT.toolChanged,()=>{
        document.body.classList.remove("selection-add","selection-subtract","selection-cut");
    })

    return me;
}();

export default Cursor;