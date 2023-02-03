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
                {label: "Open", command: COMMAND.OPEN,shortKey: "meta+O"},
                {label: "Save", command: COMMAND.SAVE,shortKey: "meta+S"},
                {label: "Import to Frame", command: COMMAND.IMPORTFRAME},
                {label: "Info", command: COMMAND.INFO,shortKey: "meta+I"},
            ]},
        {label: "Edit", items:[
                {label: "Undo", command: COMMAND.UNDO,shortKey: "meta+Z"},
                {label: "Redo", command: COMMAND.REDO,shortKey: "meta+Y"},
                {label: "Rotate", command: COMMAND.ROTATE},
                {label: "Clear", command: COMMAND.CLEAR},
                {label: "Crop", command: COMMAND.CROP},
                {label: "Trim", command: COMMAND.TRIM},
                {label: "Image size", command: COMMAND.RESAMPLE,shortKey: "meta+R"},
                {label: "Canvas Size", command: COMMAND.RESIZE,shortKey: "meta+P"},
                {label: "Sharpen", command: COMMAND.SHARPEN},
                {label: "blur", command: COMMAND.BLUR},
            ]},
        {label: "Tools", items:[
                {label: "Draw",command: COMMAND.DRAW,shortKey: "B"},
                {label: "Select",command: COMMAND.SELECT,shortKey: "S"},
                {label: "Line",command: COMMAND.LINE,shortKey: "L"},
                {label: "Rectangle",command: COMMAND.SQUARE,shortKey: "R"},
                {label: "Circle",command: COMMAND.CIRCLE,shortKey: "C"},
                {label: "Erase",command: COMMAND.ERASE,shortKey: "E"}
            ]},
        {label: "Layer", items:[
                {label: "New",command: COMMAND.NEWLAYER},
                {label: "Transform",command: COMMAND.TRANSFORMLAYER,shortKey: "meta+T"},
                {label: "Move Up",command: COMMAND.LAYERUP},
                {label: "Move Down",command: COMMAND.LAYERDOWN},
                {label: "Duplicate",command: COMMAND.DUPLICATELAYER,shortKey: "meta+D"},
                {label: "Merge Down",command: COMMAND.MERGEDOWN},
                {label: "Flatten",command: COMMAND.FLATTEN}
            ]},
        {label: "Selection", items:[
                {label: "Deselect",command: COMMAND.CLEARSELECTION},
                {label: "To Layer",command: COMMAND.TOLAYER,shortKey: "meta+J"},
                {label: "To Stencil",command: COMMAND.STAMP}
            ]},
        {label: "Palette", items:[
                {label: "Edit",command: COMMAND.EDITPALETTE},
                {label: "From Image",command: COMMAND.PALETTEFROMIMAGE},
                {label: "Reduce",command: COMMAND.PALETTEREDUCE},
                {label: "Highlight Selected Colour",command: COMMAND.COLORMASK}
            ]},
        {label: "View", items:[
                {label: "Split Screen",command: COMMAND.SPLITSCREEN,shortKey: "tab"}
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
        me.deActivateMenu();
    }

    function generate(){
        items.forEach((item,index)=>{
            item.element = $link("menuitem main handle",item.label,container,(e) =>{
                me.activateMenu(index);
            });
            item.element.addEventListener("mouseenter",(e)=>{
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
                    });
                    if (subitem.shortKey){
                        let k = subitem.shortKey;
                        if (k.length>2){
                            menuItem.classList.add("wide");
                            let meta = isMac?"Cmd":"Ctrl";
                            if (k.indexOf("+N")>1) meta = isMac?"Ctrl":"Alt";
                            k = k.replace("meta",meta);
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