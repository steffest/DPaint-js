import {$div,$link} from "../util/dom.js";
import {COMMAND} from "../enum.js";
import EventBus from "../util/eventbus.js";

let Menu = function(){
    let me = {}
    let container;
    let activeMenu;
    let isMenuActive;
    let isMac = navigator.platform.toUpperCase().indexOf('MAC')>=0;

    let items=[
        {label: "File", items:[
                {label: "New", command: COMMAND.NEW,shortKey: "meta+N"},
                {label: "Open", command: COMMAND.OPEN,shortKey: "meta+O",needsRealClick: true},
                {label: "Save", command: COMMAND.SAVE,shortKey: "meta+S"},
                {label: "Import", command: COMMAND.IMPORTFRAME,shortKey: "meta+I",needsRealClick: true},
                {label: "Info", command: COMMAND.INFO},
            ]},
        {label: "Edit", items:[
                {label: "Copy", command: COMMAND.COPY,shortKey: "meta+C"},
                {label: "Paste", command: COMMAND.PASTE,shortKey: "meta+V"},
                {label: "Undo", command: COMMAND.UNDO,shortKey: "meta+Z"},
                {label: "Redo", command: COMMAND.REDO,shortKey: "meta+Y"},
            ]},
        {label: "Image", items:[
                {label: "Rotate", command: COMMAND.ROTATE},
                {label: "Clear", command: COMMAND.CLEAR},
                {label: "Crop", command: COMMAND.CROP},
                {label: "Trim", command: COMMAND.TRIM},
                {label: "Flatten",command: COMMAND.FLATTEN},
                {label: "Image size", command: COMMAND.RESAMPLE,shortKey: "meta+R"},
                {label: "Canvas Size", command: COMMAND.RESIZE,shortKey: "meta+P"},
            ]},
        {label: "Tools", items:[
                {label: "Draw",command: COMMAND.DRAW,shortKey: "B"},
                {label: "Select",command: COMMAND.SELECT,shortKey: "S"},
                {label: "Line",command: COMMAND.LINE,shortKey: "L"},
                {label: "Rectangle",command: COMMAND.SQUARE,shortKey: "R"},
                {label: "Circle",command: COMMAND.CIRCLE,shortKey: "C"},
                {label: "Gradient",command: COMMAND.GRADIENT,shortKey: "G"},
                {label: "Erase",command: COMMAND.ERASE,shortKey: "E"},
                {label: "Hand",command: COMMAND.PAN,shortKey: "H"},
                {label: "Color Picker",command: COMMAND.COLORPICKER,shortKey: "I"}
            ]},
        {label: "Layer", items:[
                {label: "New",command: COMMAND.NEWLAYER},
                {label: "Transform",command: COMMAND.TRANSFORMLAYER,shortKey: "T / V"},
                {label: "Duplicate",command: COMMAND.DUPLICATELAYER,shortKey: "meta+D"},
                {label: "Effects",command: COMMAND.EFFECTS,shortKey: "meta+B"},
                {label: "Move Up",command: COMMAND.LAYERUP},
                {label: "Move Down",command: COMMAND.LAYERDOWN},
                {label: "Merge Down",command: COMMAND.MERGEDOWN},
                {label: "Add Mask: Show",command: COMMAND.LAYERMASK, shortKey: "meta+Shift+A"},
                {label: "Add Mask: Hide",command: COMMAND.LAYERMASKHIDE, shortKey: "meta+Shift+H"},
                {label: "Layer to Selection",command: COMMAND.TOSELECTION}
            ]},
        {label: "Selection", items:[
                {label: "Deselect",command: COMMAND.CLEARSELECTION},
                {label: "Select All",command: COMMAND.SELECTALL,shortKey: "meta+A"},
                {label: "Copy To Layer",command: COMMAND.TOLAYER,shortKey: "meta+J"},
                {label: "Cut To Layer",command: COMMAND.CUTTOLAYER,shortKey: "meta+K"},
                {label: "To Stencil",command: COMMAND.STAMP}
            ]},
        {label: "Palette", items:[
                {label: "Edit",command: COMMAND.EDITPALETTE},
                {label: "From Image",command: COMMAND.PALETTEFROMIMAGE},
                {label: "Reduce",command: COMMAND.PALETTEREDUCE},
                {label: "Show Presets",command: COMMAND.TOGGLEPALETTES},
                {label: "Save Palette",command: COMMAND.SAVEPALETTE},
                {label: "Load Palette",command: COMMAND.LOADPALETTE}
            ]},
        {label: "View", items:[
                {label: "Split Screen",command: COMMAND.SPLITSCREEN,shortKey: "tab"},
                {label: "Full Screen",command: COMMAND.FULLSCREEN,needsRealClick: true},
            ]},
        {label: "Amiga", items:[
                {label: "Open ADF image",command: COMMAND.ADF, needsRealClick: true},
                {label: "Preview in Deluxe Paint",command: COMMAND.DELUXE},
            ]},
        {label: "Help", items:[
                {label: "About DPaint.js",command: COMMAND.ABOUT},
                {label: "Documentation",action: ()=>{
                        window.open('https://www.stef.be/dpaint/docs/');
                    },needsRealClick: true},
                {label: "SourceCode on GitHub",action: ()=>{
                    window.open('https://github.com/steffest/dpaint-js');
                    },needsRealClick: true}
            ]}
    ]

    me.init = function(parent){
        container = $div("menu","",parent);
        generate();
    }

    me.activateMenu = function(index){
        if(typeof activeMenu === "number" && activeMenu !== index) me.deActivateMenu(activeMenu);

        let item = items[index];
        if (item && item.element){
            item.element.classList.toggle("active");
            if (item.element.classList.contains("active")){
                activeMenu=index;
                isMenuActive=true;
            }else{
                isMenuActive=false;
            }
        }
    }

    me.deActivateMenu = function(index){
        if (typeof index === "undefined") index=activeMenu;

        let item = items[index];
        if (item && item.element){
            item.element.classList.remove("active");
            activeMenu = undefined;
            isMenuActive = false;
        }
    }

    me.close = function(){
        if (container) container.classList.remove("active");
        me.deActivateMenu();
    }

    function generate(){
        $div("hamburger menuitem","",container,()=>{
            container.classList.toggle("active");
        })
        items.forEach((item,index)=>{
            item.element = $link("menuitem main handle",item.label,container,(e) =>{
                me.activateMenu(index);
            });
            item.element.addEventListener("pointerenter",(e)=>{
                if (isMenuActive && activeMenu!==index){
                    me.activateMenu(index);
                }
            })
            if (item.items){
                let sub = $div("menuitem sub","",item.element);
                item.items.forEach(subitem=>{
                    let menuItem = $link("handle",subitem.label,sub,(e) =>{
                        if (subitem.command){
                            EventBus.trigger(subitem.command);
                            me.deActivateMenu();
                        }
                        if (subitem.action){
                            me.deActivateMenu();
                            subitem.action();
                        }
                    });
                    if (subitem.needsRealClick) menuItem.waitForClick = true;
                    if (subitem.shortKey){
                        let k = subitem.shortKey;
                        if (k.length>2){
                            menuItem.classList.add("wide");
                            let meta = isMac?"Cmd":"Ctrl";
                            if (k.indexOf("+N")>1) meta = isMac?"Ctrl":"Alt";
                            k = k.replace("meta",meta);
                            if (k.length>8)  menuItem.classList.add("ultra");
                        }
                        $div("shortkey",k,menuItem);
                    }
                });
            }
        })
    }

    return me;


}();

export default Menu;