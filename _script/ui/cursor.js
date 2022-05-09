import {$div} from "../util/dom.js";
import Eventbus from "../util/eventbus.js";
import {EVENT} from "../enum.js";

var Cursor = function(){
    var me = {}
    var cursor;
    var cursorMark;
    
    me.init = function(){
        cursor = $div("cursor");
        cursorMark = $div("mark","",cursor);
        document.body.appendChild(cursor);

        document.body.addEventListener("mousemove", function (e) {
            cursor.style.left =  e.clientX  + "px";
            cursor.style.top =  e.clientY  + "px";
            //cursor.style.transform = "translate(" + e.clientX + "px," + e.clientY + "px)";
        }, false);
        
        Eventbus.on(EVENT.drawColorChanged,(color)=>{
            cursorMark.style.borderColor = "rgb(" + color[0] + "," + color[1] + "," + color[2] + ")";
         })
    }

    me.set = function(name){
        console.error(name);
    }
    
    return me;
}();

export default Cursor;