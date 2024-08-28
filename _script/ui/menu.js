import {$div,$link} from "../util/dom.js";
import {COMMAND} from "../enum.js";
import EventBus from "../util/eventbus.js";

let Menu = function(){
    let me = {}
    let container;
    let activeMenu;
    let isMenuActive;
    let isMac = navigator.platform.toUpperCase().indexOf('MAC')>=0;
    let refs = {};

    let items=[
        {label: "File", items:[
                {label: "New", command: COMMAND.NEW,shortKey: "meta+N"},
                {label: "Open", command: COMMAND.OPEN,shortKey: "meta+O",needsRealClick: true},
                {label: "Save", command: COMMAND.SAVE,shortKey: "meta+S"},
                {label: "Import", command: COMMAND.IMPORTLAYER,shortKey: "meta+I",needsRealClick: true},
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
                {label: "Flatten",command: COMMAND.FLATTEN,shortKey: "meta+Shift+F"},
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
                {label: "Smudge",command: COMMAND.SMUDGE,shortKey: "M"},
                {label: "Spray",command: COMMAND.SPRAY,shortKey: "P"},
                {label: "Text",command: COMMAND.TEXT,shortKey: "T"},
                {label: "Hand",command: COMMAND.PAN,shortKey: "H"},
                {label: "Color Picker",command: COMMAND.COLORPICKER,shortKey: "K"}
            ]},
        {label: "Layer", items:[
                {label: "New",command: COMMAND.NEWLAYER},
                {label: "Transform",items:[
                        {label: "Free Transform",command: COMMAND.TRANSFORMLAYER,shortKey: "T / V"},
                        {label: "Flip Horizontal",command: COMMAND.FLIPHORIZONTAL},
                        {label: "Flip Vertical",command: COMMAND.FLIPVERTICAL}
                    ]},
                {label: "Duplicate",command: COMMAND.DUPLICATELAYER,shortKey: "meta+D"},
                {label: "Effects",command: COMMAND.EFFECTS,shortKey: "meta+E"},
                {label: "Move Up",command: COMMAND.LAYERUP},
                {label: "Move Down",command: COMMAND.LAYERDOWN},
                {label: "Merge Down",command: COMMAND.MERGEDOWN, shortKey: "meta+Shift+↓"},
                {label: "Add Mask",items:[
                        {label: "Show All",command: COMMAND.LAYERMASK, shortKey: "meta+Shift+A"},
                        {label: "Hide All",command: COMMAND.LAYERMASKHIDE, shortKey: "meta+Shift+H"},
                    ]}
            ]},
        {label: "Selection", items:[
                {label: "Select",items:[
                        {label: "All",command: COMMAND.SELECTALL,shortKey: "meta+A"},
                        {label: "Pixels in Current Layer",command: COMMAND.TOSELECTION, shortKey: "meta+Shift+L"},
                        {label: "Pixels in Current Color",command: COMMAND.COLORSELECT, shortKey: "meta+Shift+P"},
                        {label: "Transparent pixels",command: COMMAND.ALPHASELECT},
                    ]},
                {label: "Deselect",command: COMMAND.CLEARSELECTION,shortKey: "Esc"},
                {label: "Copy To Layer",command: COMMAND.TOLAYER,shortKey: "meta+L"},
                {label: "Cut To Layer",command: COMMAND.CUTTOLAYER,shortKey: "meta+K"},
                {label: "Copy To Brush",command: COMMAND.STAMP,shortKey: "meta+B"}
            ]},
        {label: "Brush", items:[
                {label: "Load Brush",command: COMMAND.LOADBRUSH},
                {label: "Save Brush",command: COMMAND.SAVEBRUSH},
                {label: "Transform",items:[
                        {label: "Rotate Right",command: COMMAND.BRUSHROTATERIGHT,shortKey: "meta+Shift+→"},
                        {label: "Rotate Left",command: COMMAND.BRUSHROTATELEFT},
                        {label: "Flip Horizontal",command: COMMAND.BRUSHFLIPHORIZONTAL,shortKey: "meta+Shift+←"},
                        {label: "Flip Vertical",command: COMMAND.BRUSHFLIPVERTICAL,shortKey: "meta+Shift+↑"}
                    ]},
                {label: "From Selection",command: COMMAND.STAMP,shortKey: "meta+B"}
            ]},
        {label: "Palette", items:[
                {label: "Edit",command: COMMAND.EDITPALETTE},
                {label: "From Image",command: COMMAND.PALETTEFROMIMAGE},
                {label: "Reduce",command: COMMAND.PALETTEREDUCE},
                {label: "Show Presets",command: COMMAND.TOGGLEPALETTES},
                {label: "Save Palette",command: COMMAND.SAVEPALETTE},
                {label: "Load Palette",command: COMMAND.LOADPALETTE},
                {label: "Toggle Color Cycle",command: COMMAND.CYCLEPALETTE,shortKey: "tab"},
                {label: "Color Depth",items:[
                        {label: "24bit",info:"16 Million",command: COMMAND.COLORDEPTH24,checked:true,ref:true},
                        {label: "12bit",info:"4096 - Amiga OCS",command: COMMAND.COLORDEPTH12,checked:false,ref:true},
                        {label: "9bit",info:"512 - Atari ST",command: COMMAND.COLORDEPTH9,checked:false,ref:true},
                    ]},
            ]},
        {label: "View", items:[
                {label: "Grid",command: COMMAND.TOGGLEGRID,shortKey: "G",checked:false},
                {label: "Split Screen",command: COMMAND.SPLITSCREEN,shortKey: "N", checked: false},
                {label: "Tool Options",command: COMMAND.TOGGLESIDEPANEL, checked: false},
                {label: "Gallery",command: COMMAND.TOGGLEGALLERY, checked: false},
                {label: "Presentation mode",command: COMMAND.PRESENTATION, checked: false},
                {label: "Full Screen",command: COMMAND.FULLSCREEN,needsRealClick: true, checked: false},
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


    function buildMenuItem(item,parent){
        let menuItem = $link("handle",item.label,parent,(e) =>{
            if (item.command){
                EventBus.trigger(item.command);
                me.deActivateMenu();
            }
            if (item.action){
                me.deActivateMenu();
                item.action();
            }
        });
        if (item.items){
            menuItem.classList.add("caret");
            let sub = $div("menuitem subsub","",menuItem);
            item.items.forEach(subitem=>{
                buildMenuItem(subitem,sub);
            });
        }
        if (item.needsRealClick) menuItem.waitForClick = true;
        if (item.shortKey){
            let k = item.shortKey;
            if (k.length>2){
                menuItem.classList.add("wide");
                let meta = isMac?"Cmd":"Ctrl";
                if (k.indexOf("+N")>1) meta = isMac?"Ctrl":"Alt";
                k = k.replace("meta",meta);
                if (k.length>8)  menuItem.classList.add("ultra");
            }
            $div("shortkey",k,menuItem);
        }
        if (item.info){
            menuItem.classList.add("hasinfo");
            $div("info",item.info,menuItem);
        }
        if (typeof item.checked !== "undefined"){
            parent.classList.add("checkable");
            EventBus.on(item.command,(e)=>{
                item.checked = !item.checked;
                menuItem.classList.toggle("checked");
            });
        }
        if (item.checked){
            menuItem.classList.add("checked");
        }
        if (item.ref){
            refs[item.command] = menuItem;
        }
    }

    function generate(){
        $div("hamburger menuitem","DPaint.js",container,()=>{
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
                    buildMenuItem(subitem,sub);
                });
            }
        })
    }

    EventBus.on(COMMAND.COLORDEPTH24,()=>{
        refs[COMMAND.COLORDEPTH12].classList.remove("checked");
        refs[COMMAND.COLORDEPTH9].classList.remove("checked");
    });
    EventBus.on(COMMAND.COLORDEPTH12,()=>{
        console.log(refs);
        refs[COMMAND.COLORDEPTH24].classList.remove("checked");
        refs[COMMAND.COLORDEPTH9].classList.remove("checked");
    });
    EventBus.on(COMMAND.COLORDEPTH9,()=>{
        refs[COMMAND.COLORDEPTH12].classList.remove("checked");
        refs[COMMAND.COLORDEPTH24].classList.remove("checked");
    });

    return me;


}();

export default Menu;