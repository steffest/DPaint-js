import $,{$div} from "../util/dom.js";
import UI from "./ui.js";
import Input from "./input.js";
import EventBus from "../util/eventbus.js";
import {COMMAND, SETTING} from "../enum.js";
// OPTION/TEXTOUTPUT back every generic alert/confirm/text-result box in the app (including
// Modal.alert() below) and are trivially small, so — unlike the rest of `dialogs` — they stay a
// plain eager import instead of a lazy `loader`.
import OptionDialog from "./components/optionDialog.js";
import TextOutputDialog from "./components/textOutputDialog.js";

export let DIALOG={
    SAVE: 1,
    RESIZE: 2,
    RESAMPLE: 3,
    PALETTE: 4,
    EFFECTS: 5,
    ABOUT: 6,
    DITHER: 7,
    OPTION:8,
    TEXTOUTPUT:9,
    PLANES:10,
    FRAMERANGE:11
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

    // Every dialog but ABOUT/OPTION/TEXTOUTPUT is its own component module, loaded on first use via
    // `loader` instead of eagerly — resolveHandler() resolves it once and caches the result on
    // `handler`, so re-opening the same dialog later is synchronous again.
    let dialogs={
        1: {title: "Save File As", fuzzy: true,width:600,height:"auto", loader: ()=>import("./components/saveDialog.js"), position: [0,0]},
        2: {title: "Canvas Size", fuzzy: true, loader: ()=>import("./components/resizeDialog.js"), position: [0,0],width:406,height:220},
        3: {title: "Image Size", fuzzy: true, loader: ()=>import("./components/resampleDialog.js"), position: [0,0],width:326,height:220},
        4: {title: "Palette Editor", loader: ()=>import("./components/paletteDialog.js"), width:450,height:()=>{return SETTING.useMultiPalettes?334:304}, position: [0,0]},
        5: {title: "Effects", loader: ()=>import("./components/effectDialog.js"), position: [0,0],width:500,height:590},
        6: {title: "About", action: showAbout, position: [0,0],width:750,height:470},
        7: {title: "DitherPattern",  loader: ()=>import("./components/ditherDialog.js"), position: [0,0],width:662,height:326},
        8: {title: "Request", fuzzy: true, handler: OptionDialog, position: [0,0],width:300,height:"auto"},
        9: {title: "Output", handler: TextOutputDialog, position: [0,0],width:300,height:220},
        10: {title: "Import Bitplanes", fuzzy: true, loader: ()=>import("./components/planesDialog.js"), position: [0,0],width:420,height:"auto"},
        11: {title: "Open Animation", fuzzy: true, loader: ()=>import("./components/frameRangeDialog.js"), position: [0,0],width:340,height:"auto"}
    }

    // Resolves (and caches on the dialog entry) the handler module behind a lazy dialog's loader.
    function resolveHandler(dialog){
        if (dialog.handler) return Promise.resolve(dialog.handler);
        if (!dialog.loading){
            dialog.loading = dialog.loader().then(mod=>{
                dialog.handler = mod.default || mod;
                return dialog.handler;
            });
        }
        return dialog.loading;
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
            caption.onDragStart = function(e){
                caption.shouldClose = (e.target.tagName.toLowerCase() === "img");
                currentTranslate = [currentDialog.position[0],currentDialog.position[1]];
                caption.hasMoved = false;
            }
            caption.onDrag = function(x,y){
               caption.hasMoved = true;
               x += currentDialog.position[0];
               y += currentDialog.position[1];
               currentTranslate = [x,y];
               modalWindow.style.transform = "translate("+x+"px,"+y+"px)";
            }
            caption.onDragEnd = function(){
                currentDialog.position = [currentTranslate[0],currentTranslate[1]];
                if (!caption.hasMoved && currentDialog.action === showAbout && caption.shouldClose){
                    me.hide();
                }
            }
        }
        modalWindow.classList.add("active");
        Input.setActiveKeyHandler(keyHandler);

        if (dialog){
            let width = data.width || dialog.width || 440;
            let height = data.height || dialog.height || 260;

            if (typeof height === "function") height = height();

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
            }else if (dialog.loader){
                resolveHandler(dialog).then(handler=>{
                    if (currentDialog !== dialog) return; // closed / switched before the chunk loaded
                    handler.render(inner,me,data);
                });
            }
            if (dialog.action){
                dialog.action(data);
            }

        }else{
            console.error("no handler");
        }

    }

    me.hide = function(fromButton){
        UI.fuzzy(false);
        me.hideBlanket();
        if (modalWindow) modalWindow.classList.remove("active");
        Input.setActiveKeyHandler(null);
        if (currentDialog && currentDialog.handler && currentDialog.handler.onClose){
            currentDialog.handler.onClose(fromButton);
        }
        currentDialog = undefined;
    }

    me.isVisible = function(){
        return !!(modalWindow && modalWindow.classList.contains("active"));
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

    me.confirm = (title,message)=>{
        return new Promise(next=>{
            me.show(DIALOG.OPTION,{
                title: title,
                text: message,
                onOk:()=>{
                    next(true);
                },
                onCancel:()=>{
                    next(false);
                }
            });
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
            $("img",{src:"./_img/dpaint-about.png",onDrag:caption.onDrag,onDragEnd:caption.onDragEnd,onDragStart:caption.onDragStart}),
            $(".text.version","version " + version),
            $(".text.info","Webbased image editor modeled after the legendary",$("br"),"Deluxe Paint with a focus on retro Amiga file formats."),
            $(".text.copyright.link",{onClick:()=>window.open("https://www.stef.be/")},"© 2023-2026 - Steffest"),
            $(".text.github.link",{onClick:()=>window.open("https://github.com/steffest/dpaint-js")},"Open Source - Plain JavaScript - Fork me on GitHub"),
            $(".text.nobullshit","Free software: No cookies - No tracking - No ads - No accounts"),
            $(".text.contrib",$("i","With contributions from"),"Michael Smith, Nicolas Ramz and Rob Coenen"),
        ));
    }

    return me;
}();

export default Modal