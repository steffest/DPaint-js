import $,{$div} from "../util/dom.js";
import UI from "./ui.js";
import Input from "./input.js";
import SaveDialog from "./components/saveDialog.js";
import ResizeDialog from "./components/resizeDialog.js";
import ResampleDialog from "./components/resampleDialog.js";
import PaletteDialog from "./components/paletteDialog.js";
import EffectDialog from "./components/effectDialog.js";
import DitherDialog from "./components/ditherDialog.js";
import OptionDialog from "./components/optionDialog.js";
import EventBus from "../util/eventbus.js";
import {COMMAND} from "../enum.js";

export let DIALOG={
    SAVE: 1,
    RESIZE: 2,
    RESAMPLE: 3,
    PALETTE: 4,
    EFFECTS: 5,
    ABOUT: 6,
    DITHER: 7,
    OPTION:8
}

var Modal = function(){
    let me = {};
    let blanket;
    let modalWindow;
    let caption;
    let inner;
    let currentTranslate = [0,0];
    let currentDialog;
    let notification;

    let dialogs={
        1: {title: "Save File", fuzzy: true,width:400,height:"auto", handler: SaveDialog, position: [0,0]},
        2: {title: "Canvas Size", fuzzy: true, handler: ResizeDialog, position: [0,0],width:406,height:220},
        3: {title: "Image Size", fuzzy: true, handler: ResampleDialog, position: [0,0],width:326,height:220},
        4: {title: "Palette Editor", handler: PaletteDialog, width:450,height:304, position: [0,0]},
        5: {title: "Effects", handler: EffectDialog, position: [0,0],width:500,height:530},
        6: {title: "About", action: showAbout, position: [0,0],width:750,height:470},
        7: {title: "DitherPattern",  handler: DitherDialog, position: [0,0],width:662,height:326},
        8: {title: "Request", fuzzy: true, handler: OptionDialog, position: [0,0],width:300,height:"auto"}
    }

    me.show = function(type,data){
        data = data || {};
        let dialog = dialogs[type];
        if (dialog && dialog.fuzzy){
            UI.fuzzy(true);
            me.showBlanket();
        }
        if (!modalWindow){
            modalWindow = $div("modalwindow","",document.body);
            let titleBar = $div("caption","",modalWindow);
            caption = $div("handle","Title",titleBar);
            $div("button","x",titleBar,()=>{
                me.hide();
            });
            inner =  $div("inner","",modalWindow);
            caption.onDrag = function(x,y){
               x += currentDialog.position[0];
               y += currentDialog.position[1];
               currentTranslate = [x,y];
               modalWindow.style.transform = "translate("+x+"px,"+y+"px)";
            }
            caption.onDragEnd = function(){
                currentDialog.position = [currentTranslate[0],currentTranslate[1]];
            }
        }
        modalWindow.classList.add("active");
        Input.setActiveKeyHandler(keyHandler);

        if (dialog){
            let width = data.width || dialog.width || 440;
            let height = data.height || dialog.height || 260;

            let maxWidth = window.innerWidth - 20;
            let maxHeight = window.innerHeight - 20;
            if (width > maxWidth) width = maxWidth;
            if (height > maxHeight) height = maxHeight;

            modalWindow.style.width = width + "px";
            modalWindow.style.height = height + "px";
            let top = 'calc(50vh - ' + (height>>1) + 'px)';
            if (height==="auto"){
                modalWindow.style.height = "auto";
                top = 'calc(50vh - 150px)';
                inner.classList.remove("full");
            }else{
                inner.classList.add("full");
            }
            modalWindow.style.top = top;
            modalWindow.style.marginLeft = -(width>>1) + "px";
            currentDialog = dialog;
            let x = currentDialog.position[0];
            let y = currentDialog.position[1];
            modalWindow.style.transform = "translate("+x+"px,"+y+"px)";
            caption.innerHTML = data.title || dialog.title;
            if (dialog.handler){
                dialog.handler.render(inner,me,data);
            }
            if (dialog.action){
                dialog.action(data);
            }

        }else{
            console.error("no handler");
        }

    }

    me.hide = function(){
        UI.fuzzy(false);
        me.hideBlanket();
        if (modalWindow) modalWindow.classList.remove("active");
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

    me.showNotification = function(data){
        let delay = 0;
        if (!notification){
            notification = $div("notificationbox","",document.body);
            delay = 10;
        }
        notification.innerHTML = "";
        notification.appendChild($div("title",data.title));
        notification.appendChild($div("text",data.text));
        setTimeout(()=>{
            notification.classList.add("active");
        },delay);

        setTimeout(()=>{
            notification.classList.remove("active");
        },3000);
    }

    me.hideNotification = function(){
        if (notification) notification.classList.remove("active");
    }

    me.alert = (message, title)=>{
        Modal.show(DIALOG.OPTION,{
            title: title || "Alert",
            text: message,
            buttons: [{label:"OK"}]
        });
    }

    me.softAlert = (message, title)=>{
        Modal.showNotification({
            title: title || "Alert",
            text: message
        });
    }

    function keyHandler(code){
        switch (code){
            case "escape":
                me.hide();
                return true;
            case "enter":
                let button = inner.querySelector(".button.primary");
                if (button && button.onClick){
                    button.onClick();
                }else{
                    button =  inner.querySelector(".button");
                    if (button){
                        if (button.onClick){
                            button.onClick();
                        }else{
                            me.hide();
                        }
                    }
                }
                return true;
        }
    }

    function showAbout(version){
        inner.innerHTML = "";
        let gallery;

        inner.appendChild($(".about",
            $("img",{src:"./_img/dpaint-about.png",onclick:()=>me.hide()}),
            $(".text.version","version " + version),
            $(".text.info","Webbased image editor modeled after the legendary",$("br"),"Deluxe Paint with a focus on retro Amiga file formats."),
            $(".text.copyright.link",{onClick:()=>window.open("https://www.stef.be/")},"© 2023-2024 - Steffest"),
            $(".text.github.link",{onClick:()=>window.open("https://github.com/steffest/dpaint-js")},"Open Source - Plain JavaScript - Fork me on GitHub"),
            $(".text.nobullshit","Free software: No cookies - No tracking - No ads - No accounts"),
            $(".text.contrib",$("i","With contributions from"),"Michael Smith and Nicolas Ramz"),
        ));
    }

    return me;
}();

export default Modal