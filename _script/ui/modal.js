import {$div} from "../util/dom.js";
import UI from "./ui.js";
import Input from "./input.js";
import SaveDialog from "./components/saveDialog.js";

var Modal = function(){
    let me = {};
    let blanket;
    let window;
    let inner;

    me.show = function(type){
        UI.fuzzy(true);
        me.showBlanket();
        if (!window){
            window = $div("modalwindow","",document.body);
            let caption = $div("caption","Title",window);
            $div("button","x",caption,()=>{
                me.hide();
            });
            inner =  $div("inner","",window);
        }
        window.classList.add("active");
        Input.setActiveKeyHandler(keyHandler);

        SaveDialog.render(inner);
    }

    me.hide = function(){
        UI.fuzzy(false);
        me.hideBlanket();
        if (window) window.classList.remove("active");
        Input.setActiveKeyHandler(null);
    }

    me.isVisible = function(){

    }

    me.showBlanket = function(){
        if (!blanket){
            blanket = $div("blanket","",document.body);
        }
        blanket.classList.add("active");
    }

    me.hideBlanket = function(){
        if (blanket) blanket.classList.remove("active");
    }

    function keyHandler(code){
        switch (code){
            case "escape":
                me.hide();
                break;
        }
    }

    return me;
}();

export default Modal