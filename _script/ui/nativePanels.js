import {EVENT, SETTING} from "../enum.js";
import $, {$div, $checkbox, $elm} from "../util/dom.js";
import EventBus from "../util/eventbus.js";
import ImageProcessing from "../util/imageProcessing.js";
import ImageFile from "../image.js";
import UserSettings from "../userSettings.js";
import Palette from "./palette.js";
import LayerPanel from "./toolPanels/layerPanel.js";
import PropertiesPanel from "./toolPanels/propertiesPanel.js";
import TimelinePanel from "./toolPanels/timelinePanel.js";
import BrushPanel from "./toolPanels/brushPanel.js";
import ColorPicker from "./components/colorPicker.js";
import GridPanel from "./toolPanels/gridPanel.js";

// These five panels are already `lazy:true` (content only rendered on first reveal, see
// panelManager.js), but their component modules were still imported eagerly here, at
// nativePanels.js module scope — which is itself static from image.js from app.js, so they
// ended up in the main bundle anyway. lazyModule() defers the import() itself to that same
// first-reveal moment and caches the resolved module for every render/onHide after that.
//
// The loader MUST be `()=>import("literal/path.js")` with the path written out at each call
// site, not a path string forwarded into a shared `import(path)` — Rollup can only rewrite a
// dynamic import to its built chunk when it sees a literal argument; a variable produces a build
// that looks fine (the chunk still gets emitted) but 404s at runtime because the unrewritten
// original relative path is requested instead of the hashed chunk file.
function lazyModule(loader){
    let mod, loading;
    return {
        get: ()=>mod,
        ensure: ()=>{
            if (mod) return Promise.resolve(mod);
            if (!loading) loading = loader().then(m=>{ mod = m.default || m; return mod; });
            return loading;
        }
    };
}
let paletteDialogModule = lazyModule(()=>import("./components/paletteDialog.js"));
let effectDialogModule = lazyModule(()=>import("./components/effectDialog.js"));
let galleryModule = lazyModule(()=>import("./components/gallery.js"));
let bitPlanesModule = lazyModule(()=>import("./components/bitplanes.js"));
let fileBrowserModule = lazyModule(()=>import("./components/fileBrowser.js"));

// NativePanels — registers the built-in panels (Info, Layers, Brush, Color, Grid,
// Reduce, Frames, Amiga Icon, Preferences) with the PanelManager. The content-producing
// logic that used to live in sidepanel.js / contentpanel.js (Info refresh, Amiga Icon
// editor, Preferences form) is relocated here as panel content generators.

let NativePanels = (function(){
    let me = {};
    let manager;
    let infoInner;          // Info panel content root (for live refresh)
    let iconInner;          // Amiga Icon panel content root

    // ── Info panel ────────────────────────────────────────────────────────────────
    function generateInfoLine(label,value,parent){
        let line = $elm("dl","",parent);
        $elm("dt",label,line);
        $elm("dd",value,line);
    }

    me.showInfo = function(file){
        file = file || ImageFile.getCurrentFile();
        manager.reveal("info", true);
        renderInfo(file);
        TimelinePanel.list();
    };

    function renderInfo(file){
        file = file || ImageFile.getCurrentFile();
        if (!infoInner) return;
        infoInner.innerHTML = "";
        if (file && file.width){
            generateInfoLine("Width",file.width + "px",infoInner);
            generateInfoLine("Height",file.height + "px",infoInner);
            generateInfoLine("Colors",ImageProcessing.getColors(ImageFile.getCanvasWithFilters()).length,infoInner);
            $(".button.refresh",{parent: infoInner, onClick:()=>{renderInfo(file);}});
        }else{
            infoInner.innerHTML = "<small>No file present</small>";
        }
    }

    // ── Amiga Icon panel ────────────────────────────────────────────────────────
    function isAmigaIconFile(){
        let file = ImageFile.getCurrentFile();
        return ["classicIcon","colorIcon","PNGIcon"].includes(file && file.originalType);
    }

    function getAvailableIconTypes(){
        return [
            {value: 1, label: "Disk"}, {value: 2, label: "Drawer"}, {value: 3, label: "Tool"},
            {value: 4, label: "Project"}, {value: 5, label: "Garbage"},
        ];
    }

    function getImageTypeLabel(type){
        if (type === "classicIcon") return "Classic";
        if (type === "colorIcon") return "Color";
        if (type === "PNGIcon") return "PNG";
        return type || "Unknown";
    }

    function renderIconTypeSelector(parent,selectedType){
        let wrapper = $(".subpanel.flex.condensed",{parent});
        $(".label",{parent: wrapper},"Type");
        let select = $("select",{parent: wrapper, onchange: e=>{
            ImageFile.setOriginalIconType(e.target.value);
            renderIconInfo();
        }});
        getAvailableIconTypes().forEach(iconType=>{
            $("option",{parent: select, value: iconType.value, text: iconType.label,
                selected: parseInt(selectedType,10) === iconType.value});
        });
    }

    function renderImageTypeSelector(parent,availableImageTypes,selectedImageType){
        let wrapper = $(".subpanel.flex.condensed",{parent});
        $(".label",{parent: wrapper},"Image");
        let select = $("select",{parent: wrapper, onchange: e=>{
            if (e.target.value !== selectedImageType) ImageFile.setOriginalImageType(e.target.value);
        }});
        availableImageTypes.forEach(imageType=>{
            $("option",{parent: select, value: imageType, text: getImageTypeLabel(imageType),
                selected: imageType === selectedImageType});
        });
    }

    function renderToolTypesEditor(parent,toolTypes){
        let wrapper = $div("subpanel","",parent);
        $div("label","Tooltypes",wrapper);
        let textarea = $("textarea",{parent: wrapper,
            rows: Math.max(4,Math.min(10,(toolTypes || []).length || 4)),
            value: (toolTypes || []).join("\n"),
            onkeydown: e=>{ e.stopPropagation(); },
            oninput: e=>{ ImageFile.setOriginalToolTypes(e.target.value); },
            style: {width: "100%", minHeight: "88px", resize: "vertical", boxSizing: "border-box"}
        });
        textarea.placeholder = "One tooltype per line";
    }

    function renderDefaultToolEditor(parent,defaultTool){
        $(".subpanel.flex.condensed",{parent},
            $(".label","Default tool"),
            $("input",{type: "text", value: defaultTool || "", placeholder: "Optional default tool",
                onkeydown: e=>{ e.stopPropagation(); },
                oninput: e=>{ ImageFile.setOriginalDefaultTool(e.target.value); },
                style: {width: "100%", boxSizing: "border-box"}
            })
        );
    }

    function renderIconInfo(){
        if (!iconInner) return;
        let file = ImageFile.getCurrentFile();
        let iconMeta = file && file.meta && file.meta.icon;
        let iconType = iconMeta && iconMeta.iconType;
        if (!iconType && file && file.originalData) iconType = file.originalData.type;
        let availableImageTypes = file && file.originalData && Array.isArray(file.originalData.availableImageTypes)
            ? file.originalData.availableImageTypes
            : iconMeta && Array.isArray(iconMeta.availableImageTypes) ? iconMeta.availableImageTypes : [];
        let selectedImageType = file && file.originalData && file.originalData.selectedImageType
            ? file.originalData.selectedImageType
            : iconMeta && iconMeta.selectedImageType ? iconMeta.selectedImageType : file && file.originalType;
        let defaultTool = file && file.originalData && typeof file.originalData.defaultTool === "string"
            ? file.originalData.defaultTool
            : iconMeta && typeof iconMeta.defaultTool === "string" ? iconMeta.defaultTool : "";
        let toolTypes = file && file.originalData && Array.isArray(file.originalData.toolTypes)
            ? file.originalData.toolTypes
            : iconMeta && Array.isArray(iconMeta.toolTypes) ? iconMeta.toolTypes : [];

        iconInner.innerHTML = "";
        if (availableImageTypes.length > 1) renderImageTypeSelector(iconInner,availableImageTypes,selectedImageType);
        if (iconType) renderIconTypeSelector(iconInner,iconType);
        renderDefaultToolEditor(iconInner,defaultTool);
        renderToolTypesEditor(iconInner,toolTypes);
    }

    // ── Preferences panel ─────────────────────────────────────────────────────────
    function generatePreferences(parent){
        let recorderQualitySelect;
        parent.appendChild(
            $("section",
                $("h4","Touch"),
                $checkbox("Rotate on Pinch/zoom",null,"",(checked)=>{UserSettings.set("touchRotate",checked)},UserSettings.get("touchRotate")),
                $checkbox("Allow Color Picker in Pen-Only mode",null,"",(checked)=>{UserSettings.set("penOnlyAllowColorPicker",checked)},UserSettings.get("penOnlyAllowColorPicker")),
                $("h4","Recorder"),
                $(".subpanel.flex",
                    $(".label","Timelapse video quality"),
                    recorderQualitySelect = $("select",{oninput: ()=>{UserSettings.set("recorderQuality", recorderQualitySelect.value);}},
                        $("option",{value:"standard", selected: UserSettings.get("recorderQuality") === "standard"},"Standard (720p)"),
                        $("option",{value:"high", selected: UserSettings.get("recorderQuality") === "high"},"High (1080p)"),
                        $("option",{value:"best", selected: UserSettings.get("recorderQuality") === "best"},"Best (source size)")
                    )
                ),
                $(".hint","Higher quality keeps more detail, but export size and memory usage go up."),
                $("h4","Advanced"),
                $checkbox("Use Multi Palettes",null,"",(checked)=>{UserSettings.set("useMultiPalettes",checked,true)},UserSettings.get("useMultiPalettes")),
                $(".warning","Warning: Highly experimental, may cause data loss")
            )
        );
    }

    // ── Registration ───────────────────────────────────────────────────────────────
    me.register = function(panelManager){
        manager = panelManager;

        manager.register({
            id:"info", label:"Info", defaultContainer:"left", defaultOrder:0,
            defaultCollapsed:true, height:84,
            content:(inner)=>{ infoInner = inner; renderInfo(); }
        });
        manager.register({
            id:"icon", label:"Amiga Icon", defaultContainer:"left", defaultOrder:1,
            defaultCollapsed:true, height:210, isAvailable:isAmigaIconFile,
            content:(inner)=>{ iconInner = inner; renderIconInfo(); }
        });
        manager.register({
            id:"layers", label:"Layers", defaultContainer:"left", defaultOrder:2,
            // The animatable x/y position moved to the Properties panel (spec 007), so the
            // third tool row is gone and the panel returns to its pre-spec-004 height.
            height:180, minHeight:100,
            content:(inner)=>{ LayerPanel.generate(inner); }
        });
        // Properties: the animatable transform of the active node (x/y for any layer, plus
        // width/height/rotation for a group). Docked under Layers, visible by default (spec 007).
        manager.register({
            id:"properties", label:"Properties", defaultContainer:"left", defaultOrder:3,
            // room for three rows when a group is active: X/Y, W/H, and Rot (which also hosts Smooth)
            height:92,
            content:(inner)=>{ PropertiesPanel.generate(inner); }
        });
        manager.register({
            id:"brush", label:"Brush", defaultContainer:"left", defaultOrder:4,
            height:190,
            content:(inner)=>{ BrushPanel.generate(inner); }
        });
        manager.register({
            id:"color", label:"Color", defaultContainer:"left", defaultOrder:5,
            height:142,
            content:(inner)=>{ ColorPicker.generate(inner); }
        });
        manager.register({
            id:"grid", label:"Grid", defaultContainer:"left", defaultOrder:6,
            defaultCollapsed:true, height:120,
            content:(inner)=>{ GridPanel.generate(inner); }
        });
        manager.register({
            id:"reduce", label:"Reduce Colors", defaultContainer:"left", defaultOrder:7,
            defaultCollapsed:true, height:290,
            content:(inner)=>{ Palette.generateControlPanel(inner); }
        });
        // Timeline: bottom container when useBottomPanel is on (seed only), else left.
        manager.register({
            id:"timeline", label:"Timeline",
            defaultContainer: SETTING.useBottomPanel ? "bottom" : "left",
            defaultOrder:8, height:130, width:420,
            content:(inner)=>{ TimelinePanel.generate(inner); }
        });
        manager.register({
            id:"preferences", label:"Preferences", defaultContainer:"left", defaultOrder:9,
            defaultVisible:false, height:320,
            content:(inner)=>{ generatePreferences(inner); }
        });

        // ── Converted dialogs: dock-capable, floating by default, lazily rendered ──
        // The existing handlers' render(container, host) and onClose() contracts are
        // reused verbatim; `host` supplies the {inputKeyDown, hide} the handlers expect.
        manager.register({
            id:"palette", label:"Palette Editor", defaultContainer:"floating", defaultOrder:0,
            defaultVisible:false, lazy:true, rerenderOnShow:true, floatSize:{w:450,h:340},
            content:(inner, host)=>{ paletteDialogModule.ensure().then(PaletteDialog=>PaletteDialog.render(inner, host)); },
            onHide:()=>{ let PaletteDialog = paletteDialogModule.get(); if (PaletteDialog && PaletteDialog.onClose) PaletteDialog.onClose(); }
        });
        manager.register({
            id:"effects", label:"Effects", defaultContainer:"floating", defaultOrder:1,
            defaultVisible:false, lazy:true, rerenderOnShow:true, floatSize:{w:500,h:590},
            content:(inner, host)=>{ effectDialogModule.ensure().then(EffectDialog=>EffectDialog.render(inner, host)); },
            onHide:()=>{ let EffectDialog = effectDialogModule.get(); if (EffectDialog && EffectDialog.onClose) EffectDialog.onClose(); }
        });
        manager.register({
            id:"gallery", label:"Gallery", defaultContainer:"right", defaultOrder:9,
            defaultVisible:false, lazy:true, height:400, floatSize:{w:170,h:500},
            content:(inner)=>{ galleryModule.ensure().then(Gallery=>Gallery.generate(inner)); }
        });
        manager.register({
            id:"bitplanes", label:"BitPlanes", defaultContainer:"right", defaultOrder:10,
            defaultVisible:false, lazy:true, rerenderOnShow:true, height:400, floatSize:{w:170,h:500},
            content:(inner)=>{ bitPlanesModule.ensure().then(BitPlanes=>BitPlanes.generate(inner)); }
        });
        manager.register({
            id:"adf", label:"File Browser", defaultContainer:"right", defaultOrder:11,
            defaultVisible:false, lazy:true, height:400, floatSize:{w:200,h:500},
            content:(inner)=>{ fileBrowserModule.ensure().then(FileBrowser=>FileBrowser.generate(inner)); }
        });


        EventBus.on(EVENT.imageSizeChanged,()=>{
            renderInfo();
            renderIconInfo();
        });
    };

    return me;
})();

export default NativePanels;
