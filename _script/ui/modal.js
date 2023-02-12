import {$div} from "../util/dom.js";
import UI from "./ui.js";
import Input from "./input.js";
import SaveDialog from "./components/saveDialog.js";
import ResizeDialog from "./components/resizeDialog.js";
import ResampleDialog from "./components/resampleDialog.js";
import PaletteDialog from "./components/paletteDialog.js";
import EffectDialog from "./components/effectDialog.js";

export let DIALOG={
    SAVE: 1,
    RESIZE: 2,
    RESAMPLE: 3,
    PALETTE: 4,
    EFFECTS: 5
}

var Modal = function(){
    let me = {};
    let blanket;
    let window;
    let caption;
    let inner;
    let currentTranslate = [0,0];
    let currentDialog;

    let dialogs={
        1: {title: "Save File", fuzzy: true, handler: SaveDialog, position: [0,0]},
        2: {title: "Canvas Size", fuzzy: true, handler: ResizeDialog, position: [0,0]},
        3: {title: "Image Size", fuzzy: true, handler: ResampleDialog, position: [0,0]},
        4: {title: "Palette", handler: PaletteDialog, position: [0,0]},
        5: {title: "Effects", handler: EffectDialog, position: [0,0],width:500,height:500}
    }

    me.show = function(type){
        let dialog = dialogs[type];
        if (dialog && dialog.fuzzy){
            UI.fuzzy(true);
            me.showBlanket();
        }
        if (!window){
            window = $div("modalwindow","",document.body);
            let titleBar = $div("caption","",window);
            caption = $div("handle","Title",titleBar);
            $div("button","x",titleBar,()=>{
                me.hide();
            });
            inner =  $div("inner","",window);
            caption.onDrag = function(x,y){
               x += currentDialog.position[0];
               y += currentDialog.position[1];
               currentTranslate = [x,y];
               window.style.transform = "translate("+x+"px,"+y+"px)";
            }
            caption.onDragEnd = function(){
                currentDialog.position = [currentTranslate[0],currentTranslate[1]];
            }
        }
        window.classList.add("active");
        Input.setActiveKeyHandler(keyHandler);

        if (dialog){
            let width = dialog.width || 440;
            let height = dialog.height || 260;
            window.style.width = width + "px";
            window.style.height = height + "px";
            window.style.top = 'calc(50vh - ' + (height>>1) + 'px)';
            window.style.marginLeft = -(width>>1) + "px";
            currentDialog = dialog;
            let x = currentDialog.position[0];
            let y = currentDialog.position[1];
            window.style.transform = "translate("+x+"px,"+y+"px)";
            caption.innerHTML = dialog.title;
            dialog.handler.render(inner,me);
        }else{
            console.error("no handler");
        }

    }

    me.hide = function(){
        UI.fuzzy(false);
        me.hideBlanket();
        if (window) window.classList.remove("active");
        Input.setActiveKeyHandler(null);
        if (currentDialog && currentDialog.handler && currentDialog.handler.onClose){
            currentDialog.handler.onClose();
        }
        currentDialog = undefined;
    }

    me.isVisible = function(){

    }

    me.inputKeyDown = function(e){
        e.stopPropagation();
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
            case "enter":
                let button = inner.querySelector(".button.primary");
                if (button && button.onClick) button.onClick();
                break;
        }
    }

    return me;
}();

export default Modal