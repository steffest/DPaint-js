import {$div,$link} from "../util/dom.js";
import {COMMAND, EVENT, SETTING} from "../enum.js";
import EventBus from "../util/eventbus.js";
import UserSettings from "../userSettings.js";
import ImageFile from "../image.js";
import LayerPanel from "./toolPanels/layerPanel.js";
import {isBones, isVector} from "../util/layerUtils.js";

let Menu = function(){
    let me = {}
    let container;
    let activeMenu;
    let isMenuActive;
    let isMac = navigator.platform.toUpperCase().indexOf('MAC')>=0;
    let refs = {};
    let groupDisabledItems = [];
    let notInGroupDisabledItems = [];
    let panelSubMenu;   // the View ▸ Panels submenu container (populated by PanelManager)
    let toolsSubMenu;   // the Tools submenu container, swapped between pixel/vector/bone tool sets
    let toolsCaption;   // non-selectable "Pixel"/"Vector"/"Bones" label atop the Tools submenu
    let brushMenuElement;  // top-level "Brush" menu — hidden while a vector layer is active
    let shapeMenuElement;  // top-level "Shape" menu — shown only while a vector layer is active

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
                {label: "Preferences", command: COMMAND.PREFERENCES},
            ]},
        {label: "Image", items:[
                {label: "Rotate", command: COMMAND.ROTATE},
                //{label: "Clear", command: COMMAND.CLEAR},
                {label: "Crop", command: COMMAND.CROP},
                {label: "Trim", command: COMMAND.TRIM},
                {label: "Flatten",command: COMMAND.FLATTEN,shortKey: "meta+Shift+F"},
                {label: "Image size", command: COMMAND.RESAMPLE,shortKey: "meta+R"},
                {label: "Canvas Size", command: COMMAND.RESIZE,shortKey: "meta+P"},
                {label: "Batch",items:[
                        {label: "Frames to Layers",command: COMMAND.FRAMES2LAYERS},
                        {label: "Layers to Frames",command: COMMAND.LAYERS2FRAMES},
                        {label: "Layers to sheet",command: COMMAND.LAYERS2SHEET}
                    ]},
            ]},
        {label: "Tools", toolsMenu: true, items:[
                // Pixel/group-layer tools — shown while a pixel or group layer is active.
                {label: "Draw",command: COMMAND.DRAW,shortKey: "B", group: "pixel"},
                {label: "Select",command: COMMAND.SELECT,shortKey: "S", group: "pixel"},
                {label: "Select Layer",command: COMMAND.SELECTLAYER, group: "pixel"},
                {label: "Circle",command: COMMAND.CIRCLE,shortKey: "C", group: "pixel"},
                {label: "Rectangle",command: COMMAND.SQUARE,shortKey: "R", group: "pixel"},
                {label: "Line",command: COMMAND.LINE,shortKey: "L", group: "pixel"},
                {label: "Arc",command: COMMAND.ARC,shortKey: "A", group: "pixel"},
                {label: "Gradient",command: COMMAND.GRADIENT,shortKey: "G", group: "pixel"},
                {label: "Erase",command: COMMAND.ERASE,shortKey: "E", group: "pixel"},
                {label: "Smudge",command: COMMAND.SMUDGE,shortKey: "M", group: "pixel"},
                {label: "Spray",command: COMMAND.SPRAY,shortKey: "O", group: "pixel"},
                {label: "Text",command: COMMAND.TEXT,shortKey: "T", group: "pixel"},
                {label: "Hand",command: COMMAND.PAN,shortKey: "H", group: "pixel"},
                {label: "Color Picker",command: COMMAND.COLORPICKER,shortKey: "K", group: "pixel"},
                // Vector-layer tools — shown while a vector layer is active.
                {label: "Edit",command: COMMAND.VECTORSELECT,shortKey: "S", group: "vector"},
                {label: "Line",command: COMMAND.VECTORLINE,shortKey: "L", group: "vector"},
                {label: "Rectangle",command: COMMAND.VECTORRECT,shortKey: "R", group: "vector"},
                {label: "Circle",command: COMMAND.VECTORCIRCLE,shortKey: "C", group: "vector"},
                {label: "Blob Brush",command: COMMAND.VECTORBLOB,shortKey: "B", group: "vector"},
                {label: "Fill",command: COMMAND.VECTORFILL,shortKey: "F", group: "vector"},
                {label: "Outline",command: COMMAND.VECTOROUTLINE,shortKey: "O", group: "vector"},
                {label: "Text",command: COMMAND.VECTORTEXT,shortKey: "T", group: "vector"},
                // Bone-layer tools — shown while a bone layer is active. No keyboard shortcuts yet.
                {label: "Select & Edit",command: COMMAND.BONESELECT, group: "bone"},
                {label: "Add Bone",command: COMMAND.BONEADD, group: "bone"},
                {label: "Pose",command: COMMAND.BONETRANSFORM, group: "bone"},
                {label: "Reset Pose",command: COMMAND.BONERESET, group: "bone"},
                {label: "Delete Bone",command: COMMAND.BONEDELETE, group: "bone"}
            ]},
        {label: "Layer", items:[
                {label: "New", items:[
                        {label: "Pixel layer",command: COMMAND.NEWLAYER},
                        {label: "Vector Layer",command: COMMAND.NEWVECTORLAYER},
                        {label: "Bone Layer",command: COMMAND.NEWBONELAYER},
                        {label: "Group",action: ()=>EventBus.trigger(COMMAND.GROUPLAYERS, LayerPanel.getSelectedPaths()),shortKey: "meta+G"},
                    ]},
                {label: "Transform",items:[
                        {label: "Free Transform",command: COMMAND.TRANSFORMLAYER,shortKey: "T / V"},
                        {label: "Mesh Warp",command: COMMAND.MESHWARP,groupDisabled: true},
                        {label: "Flip Horizontal",command: COMMAND.FLIPHORIZONTAL,groupDisabled: true},
                        {label: "Flip Vertical",command: COMMAND.FLIPVERTICAL,groupDisabled: true}
                    ]},
                {label: "Duplicate",command: COMMAND.DUPLICATELAYER,shortKey: "meta+D"},
                {label: "Effects",groupDisabled: true,command: COMMAND.EFFECTS,shortKey: "meta+E"},
                {label: "Move Up",command: COMMAND.LAYERUP},
                {label: "Move Down",command: COMMAND.LAYERDOWN},
                {label: "Merge Down",command: COMMAND.MERGEDOWN, shortKey: "meta+Shift+↓"},
                {label: "Ungroup",notInGroupDisabled: true,command: COMMAND.UNGROUP,shortKey: "meta+Shift+G"},
                {label: "Merge Group",notInGroupDisabled: true,command: COMMAND.MERGEGROUP},
                {label: "Add Mask",groupDisabled: true,items:[
                        {label: "Show All",command: COMMAND.LAYERMASK, shortKey: "meta+Shift+A"},
                        {label: "Hide All",command: COMMAND.LAYERMASKHIDE, shortKey: "meta+Shift+H"},
                    ]},
                {label: "Action",items:[
                        {label: "Remove stray pixels",command: COMMAND.REMOVESTRAYPIXELS}
                    ]}
            ]},
        {label: "Selection", items:[
                {label: "Select",items:[
                        {label: "All",command: COMMAND.SELECTALL,shortKey: "meta+A"},
                        {label: "Pixels in Current Layer",command: COMMAND.TOSELECTION, shortKey: "meta+Shift+L"},
                        {label: "Pixels in Current Color",command: COMMAND.COLORSELECT, shortKey: "meta+Shift+P"},
                        {label: "Pixels not in Palette",command: COMMAND.COLORSELECT_NOT_PALETTE},
                        {label: "Transparent pixels",command: COMMAND.ALPHASELECT},
                    ]},
                {label: "Deselect",command: COMMAND.CLEARSELECTION,shortKey: "Esc"},
                {label: "Invert",command: COMMAND.INVERTSELECTION,shortKey: "meta+Shift+I"},
                {label: "Copy To Layer",command: COMMAND.TOLAYER,shortKey: "meta+L"},
                {label: "Cut To Layer",command: COMMAND.CUTTOLAYER,shortKey: "meta+K"},
                {label: "Copy To Brush",command: COMMAND.STAMP,shortKey: "meta+B"}
            ]},
        {label: "Brush", brushMenu: true, items:[
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
        // Vector-only menu, replaces "Brush" in the menu bar while a vector layer is active.
        {label: "Shape", shapeMenu: true, items:[
                {label: "Lines to fill",command: COMMAND.SHAPELINESTOFILL},
                {label: "Expand fill",command: COMMAND.SHAPEEXPANDFILL},
                {label: "Straighten/Smooth",command: COMMAND.SHAPESTRAIGHTENSMOOTH}
            ]},
        {label: "Palette", items:[
                {label: "Edit",command: COMMAND.EDITPALETTE},
                {label: "From Image",items:[
                        {label: "Replace palette",command: COMMAND.PALETTEFROMIMAGE},
                        {label: "Expand palette",command: COMMAND.PALETTEEXPANDFROMIMAGE}
                ]},
                {label: "Reduce",command: COMMAND.PALETTEREDUCE},
                {label: "Show Presets",command: COMMAND.TOGGLEPALETTES},
                {label: "Save Palette",command: COMMAND.SAVEPALETTE},
                {label: "Load Palette",command: COMMAND.LOADPALETTE},
                {label: "Export",command: COMMAND.PALETTEEXPORT},
                {label: "Toggle Color Cycle",command: COMMAND.CYCLEPALETTE,shortKey: "tab"},
                {label: "Color Depth",items:[
                        {label: "24bit",info:"16 Million",command: COMMAND.COLORDEPTH24,checked:true,ref:true},
                        {label: "12bit",info:"4096 - Amiga OCS",command: COMMAND.COLORDEPTH12,checked:false,ref:true},
                        {label: "9bit",info:"512 - Atari ST",command: COMMAND.COLORDEPTH9,checked:false,ref:true},
                    ]},
                /*{label: "Mode",items:[
                    {label: "Normal",info:"Default",command: COMMAND.PALETTEMODE_NORMAL,checked:true,ref:true},
                    {label: "EHB",info:"Amiga Extra Half Bright",command: COMMAND.PALETTEMODE_EHB,checked:false,ref:true},
                ]},*/
            ]},
        {label: "View", className: "view", items:[
                {label: "Grid",command: COMMAND.TOGGLEGRID,checked:false},
                {label: "Rulers",command: COMMAND.TOGGLERULERS,shortKey: "meta+Shift+R",checked:false},
                {label: "Split Screen",command: COMMAND.SPLITSCREEN,shortKey: "N", checked: false},
                {label: "Tool Options",command: COMMAND.TOGGLESIDEPANEL, checked: false,ref:true},
                SETTING.useBottomPanel ? {label: "Timeline",command: COMMAND.TOGGLEBOTTOMPANEL, checked: false,ref:true} : undefined,
                {label: "Panels", panelMenu: true, items: []},
                {label: "Gallery",command: COMMAND.TOGGLEGALLERY, checked: false},
                {label: "Presentation mode",command: COMMAND.PRESENTATION, checked: false},
                {label: "Full Screen",command: COMMAND.FULLSCREEN,needsRealClick: true, checked: false},
                //{label: "Debug Overlay",command: COMMAND.TOGGLEOVERRIDE, checked: false},
            ]},
        {label: "Recorder", items:[
                {label: "Start",command: COMMAND.RECORDINGSTART},
                {label: "Stop",command: COMMAND.RECORDINGSTOP},
                //{label: "Export",command: COMMAND.RECORDINGEXPORT}
            ]},
        {label: "Amiga", items:[
                {label: "Open ADF image",command: COMMAND.ADF, needsRealClick: true},
                {label: "Preview in Deluxe Paint",command: COMMAND.DELUXE},
                //{label: "View Bitplanes",command: COMMAND.VIEWPLANES},
            ]},
        {label: "Help", items:[
                {label: "About DPaint.js",command: COMMAND.ABOUT},
                {label: "Documentation",action: ()=>{
                        window.open('./docs/');
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

    // Populate the View ▸ Panels submenu from PanelManager (called after panels register
    // and on visibility changes). Each entry toggles a panel; a leading "✓ " marks visible.
    me.setPanelMenu = function(entries){
        if (!panelSubMenu) return;
        panelSubMenu.innerHTML = "";
        entries.forEach(entry=>{
            buildMenuItem({
                label: (entry.visible ? "✓ " : "    ") + entry.label,
                action: entry.action
            }, panelSubMenu);
        });
    }

    function updateGroupState(){
        let active = ImageFile.getActiveLayer ? ImageFile.getActiveLayer() : undefined;
        let path = ImageFile.getActiveLayerPath ? ImageFile.getActiveLayerPath() : [];
        let isGroup = !!(active && active.type === "group");
        let inGroup = isGroup || (Array.isArray(path) && path.length > 1);

        groupDisabledItems.forEach(el => el.classList.toggle("disabled", isGroup));
        notInGroupDisabledItems.forEach(el => el.classList.toggle("disabled", !inGroup));
    }

    me.activateMenu = function(index){
        if(typeof activeMenu === "number" && activeMenu !== index) me.deActivateMenu(activeMenu);

        let item = items[index];
        if (item && item.element){
            item.element.classList.toggle("active");
            if (item.element.classList.contains("active")){
                activeMenu=index;
                isMenuActive=true;
                updateGroupState();
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
        if (!item) return;
        let menuItem = $link("handle",item.label,parent,(e) =>{
            if (menuItem.classList.contains("disabled")) return;
            if (item.command){
                EventBus.trigger(item.command);
                me.deActivateMenu();
            }
            if (item.action){
                me.deActivateMenu();
                item.action();
            }
        });
        if (item.group){
            menuItem.classList.add("group-"+item.group);
        }
        if (item.groupDisabled){
            groupDisabledItems.push(menuItem);
        }
        if (item.notInGroupDisabled){
            notInGroupDisabledItems.push(menuItem);
        }
        if (item.items){
            menuItem.classList.add("caret");
            menuItem.classList.add("menuitem");
            let sub = $div("menuitem subsub","",menuItem);
            if (item.panelMenu) panelSubMenu = sub;
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
            if (item.className) item.element.classList.add(item.className);
            if (item.brushMenu) brushMenuElement = item.element;
            if (item.shapeMenu) shapeMenuElement = item.element;
            item.element.addEventListener("pointerenter",(e)=>{
                if (isMenuActive && activeMenu!==index){
                    me.activateMenu(index);
                }
            })
            if (item.items){
                let sub = $div("menuitem sub","",item.element);
                if (item.toolsMenu){
                    toolsSubMenu = sub;
                    toolsCaption = $div("caption","Pixel",sub);
                }
                item.items.forEach(subitem=>{
                    buildMenuItem(subitem,sub);
                });
            }
        })
        updateToolsMenu();
    }

    // Swap the Tools menu between pixel/vector/bone tool sets depending on the active layer type,
    // and update the non-selectable caption on top of the submenu (mirrors Toolbar.updateSpecialMode).
    function updateToolsMenu(){
        if (!toolsSubMenu) return;
        let layer = ImageFile.getActiveLayer ? ImageFile.getActiveLayer() : undefined;
        let mode = isBones(layer) ? "bone" : (isVector(layer) ? "vector" : "pixel");
        if (toolsCaption) toolsCaption.textContent = mode === "bone" ? "Bones" : (mode === "vector" ? "Vector" : "Pixel");
        toolsSubMenu.classList.toggle("bone-mode",mode === "bone");
        toolsSubMenu.classList.toggle("vector-mode",mode === "vector");
        if (brushMenuElement) brushMenuElement.classList.toggle("hidden-menu",mode === "vector");
        if (shapeMenuElement) shapeMenuElement.classList.toggle("hidden-menu",mode !== "vector");
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

    EventBus.on(COMMAND.PALETTEMODE_NORMAL,()=>{
        refs[COMMAND.PALETTEMODE_EHB].classList.remove("checked");
    });
    EventBus.on(COMMAND.PALETTEMODE_EHB,()=>{
        refs[COMMAND.PALETTEMODE_NORMAL].classList.remove("checked");
    });

    EventBus.on(EVENT.panelUIChanged,()=>{
        setTimeout(()=>{
            if (refs[COMMAND.TOGGLESIDEPANEL]) refs[COMMAND.TOGGLESIDEPANEL].classList.toggle("checked",UserSettings.get("sidepanel"));
        },50)
    });

    EventBus.on(EVENT.layersChanged,()=>{
        updateGroupState();
        updateToolsMenu();
    });

    return me;


}();

export default Menu;
