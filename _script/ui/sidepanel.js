import {COMMAND, EVENT} from "../enum.js";
import $, {$div} from "../util/dom.js";
import ImageProcessing from "../util/imageProcessing.js";
import ImageFile from "../image.js";
import EventBus from "../util/eventbus.js";
import Palette from "./palette.js";
import LayerPanel from "./toolPanels/layerPanel.js";
import FramesPanel from "./toolPanels/framesPanel.js";
import BrushPanel from "./toolPanels/brushPanel.js";
import ColorPicker from "./components/colorPicker.js";
import GridPanel from "./toolPanels/gridPanel.js";
import UserSettings from "../userSettings.js";

var SidePanel = function(){
    let me = {}
    let container;
    let innerContainer;
    let collapsedHeight = 21;
    let minWidth = 120;

    let panels = {
        info:{
            label: "Info",
            height: 84,
            collapsed: true,
        },
        icon:{
            label: "Amiga Icon",
            height: 210,
            collapsed: true,
            isVisible: ()=>isAmigaIconFile(),
            content: parent=>{
                renderIconInfo(parent);
            }
        },
        frames:{
            label: "Frames",
            height: 130,
            content: parent=>{
                FramesPanel.generate(parent);
            }
        },
        layers:{
            label: "Layers",
            height: 180,
            minHeight: 100,
            content: parent=>{
                LayerPanel.generate(parent);
            }
        },
        brush:{
            label: "Brush",
            height: 190,
            content: parent=>{
                BrushPanel.generate(parent);
            }
        },
        color:{
            label: "Color",
            height: 142,
            content: parent=>{
                ColorPicker.generate(parent);
            }
        },
        grid:{
            label: "Grid",
            height: 120,
            collapsed: true,
            content: parent=>{
                GridPanel.generate(parent);
            }
        },
        reduce:{
            label: "Reduce Colors",
            collapsed: true,
            height: 290,
            content: parent=>{
                Palette.generateControlPanel(parent);
            }
        }
    }

    me.init = parent=>{
        let w = getInitialWidth();
        container = $(".sidepanel",{
            parent: parent,
            style: {width: w + "px"}
        },
            innerContainer=$(".panelcontainer"),
            $(".panelsizer",{
                onDrag: (x)=>{
                    let _w = Math.max(w + x,minWidth);
                    container.style.width = _w + "px";
                    EventBus.trigger(EVENT.panelUIChanged);
                },
                onDragStart: e=>{
                    w=container.offsetWidth;
                },
                onDragEnd: ()=>{
                    UserSettings.set("sidepanelWidth",container.offsetWidth);
                }
            })
        );
        generate();

        if (UserSettings.get("sidepanel")){
            setTimeout(()=>{
                me.show();
            },50);
        }
    }

    me.show = (section)=>{
        if (section){
            Object.keys(panels).forEach(key=>{
                if (key === section){
                    panels[key].collapsed = false;
                }
            })
            setPanelsState();
        }
        UserSettings.set("sidepanel",true);
        container.classList.add("active");
        EventBus.trigger(EVENT.panelUIChanged);
    }

    me.hide = ()=>{
        UserSettings.set("sidepanel",false);
        container.classList.remove("active");
        EventBus.trigger(EVENT.panelUIChanged);
    }

    me.toggle = ()=>{
        UserSettings.set("sidepanel",!me.isVisible());
        container.classList.toggle("active",me.isVisible());
        EventBus.trigger(EVENT.panelUIChanged);
    }

    me.isVisible = ()=>{
        return !!UserSettings.get("sidepanel");
    }

    me.getWidth = ()=>{
        if (me.isVisible()){
            return container.offsetWidth + 5;
        }else{
            return 0;
        }
    }

    me.showInfo = (file)=>{
        file = file || ImageFile.getCurrentFile();
        let contentPanel = panels.info.container.querySelector(".inner");
        if (contentPanel){
            if (file && file.width){
                contentPanel.innerHTML = "";
                generateInfoLine("Width",file.width + "px",contentPanel);
                generateInfoLine("Height",file.height + "px",contentPanel);
                generateInfoLine("Colors",ImageProcessing.getColors(ImageFile.getCanvasWithFilters()).length,contentPanel);
                $(".button.refresh",{parent: contentPanel, onClick:()=>{me.showInfo(file);}});
            }else{
                contentPanel.innerHTML = "<small>No file present</small>";
            }
        }
        FramesPanel.list();
        me.show();
        if (panels.info.collapsed){
            panels.info.collapsed = false;
            setPanelsState();
        }
    }

    function generate(){
        Object.keys(panels).forEach(key=>{
            let panel = panels[key];
            panel.container = generatePanel(panel,innerContainer);
        })
        setPanelsState();
    }

    function getInitialWidth(){
        let width = parseInt(UserSettings.get("sidepanelWidth"),10);
        if (!width || Number.isNaN(width)){
            width = 175;
        }
        return Math.max(width,minWidth);
    }

    function generatePanel(panelInfo,parent){
        let panel = $div("panel " + panelInfo.label.toLowerCase() + (panelInfo.collapsed?' collapsed':''),"",parent);
        let caption = $div("caption","<i></i> " + panelInfo.label,panel,()=>{
            panelInfo.collapsed = !panelInfo.collapsed;
            setPanelsState();
            if (!panelInfo.collapsed  && panelInfo.label === "Info"){
                me.showInfo();
            }
        });
        let close = $div("close info","x",caption,()=>EventBus.trigger(COMMAND.TOGGLESIDEPANEL));
        close.info = "Close side panels";
        let inner = $div("inner","",panel);
        let w;
        $(".sizer",{
            parent: panel,
            onDrag: (x,y)=>{
                panelInfo.height = Math.max(w + y,panelInfo.minHeight || 34);
                setPanelsState();
            },
            onDragStart: e=>{
                w = panelInfo.height;
            }
        });
        if (panelInfo.content){
            panelInfo.content(inner);
        }
        return panel;
    }

    function setPanelsState(){
        let y = 0;
        Object.keys(panels).forEach(key=>{
            let panel = panels[key];
            let isVisible = panel.isVisible ? panel.isVisible() : true;
            panel.container.style.display = isVisible ? "" : "none";
            if (!isVisible) return;
            let height = (panel.height || 100);
            if (panel.collapsed) height=collapsedHeight;
            panel.container.style.height = height + "px";
            panel.container.style.top = y + "px";
            panel.container.classList.toggle("collapsed",!!panel.collapsed);
            y+= height;
        })
    }

    function isAmigaIconFile(){
        let file = ImageFile.getCurrentFile();
        return ["classicIcon","colorIcon","PNGIcon"].includes(file && file.originalType);
    }

    function renderIconInfo(parent){
        let contentPanel = parent || (panels.icon.container && panels.icon.container.querySelector(".inner"));
        if (!contentPanel) return;

        let file = ImageFile.getCurrentFile();
        let iconMeta = file && file.meta && file.meta.icon;
        let iconType = iconMeta && iconMeta.iconType;
        if (!iconType && file && file.originalData) iconType = file.originalData.type;
        let availableImageTypes = file && file.originalData && Array.isArray(file.originalData.availableImageTypes)
            ? file.originalData.availableImageTypes
            : iconMeta && Array.isArray(iconMeta.availableImageTypes)
                ? iconMeta.availableImageTypes
                : [];
        let selectedImageType = file && file.originalData && file.originalData.selectedImageType
            ? file.originalData.selectedImageType
            : iconMeta && iconMeta.selectedImageType
                ? iconMeta.selectedImageType
                : file && file.originalType;
        let defaultTool = file && file.originalData && typeof file.originalData.defaultTool === "string"
            ? file.originalData.defaultTool
            : iconMeta && typeof iconMeta.defaultTool === "string"
                ? iconMeta.defaultTool
                : "";
        let toolTypes = file && file.originalData && Array.isArray(file.originalData.toolTypes)
            ? file.originalData.toolTypes
            : iconMeta && Array.isArray(iconMeta.toolTypes)
                ? iconMeta.toolTypes
                : [];

        contentPanel.innerHTML = "";

        if (availableImageTypes.length > 1) renderImageTypeSelector(contentPanel,availableImageTypes,selectedImageType);
        if (iconType) renderIconTypeSelector(contentPanel,iconType);

        renderDefaultToolEditor(contentPanel,defaultTool);
        renderToolTypesEditor(contentPanel,toolTypes);
    }

    function renderIconTypeSelector(parent,selectedType){
        let wrapper = $(".subpanel.flex.condensed",{parent});
        $(".label",{parent: wrapper},"Type");
        let select = $("select",{
            parent: wrapper,
            onchange: e=>{
                ImageFile.setOriginalIconType(e.target.value);
                renderIconInfo(parent);
            }
        });

        getAvailableIconTypes().forEach(iconType=>{
            $("option",{
                parent: select,
                value: iconType.value,
                text: iconType.label,
                selected: parseInt(selectedType,10) === iconType.value
            });
        });
    }

    function renderImageTypeSelector(parent,availableImageTypes,selectedImageType){
        let wrapper = $(".subpanel.flex.condensed",{parent});
        $(".label",{parent: wrapper},"Image");
        let select = $("select",{
            parent: wrapper,
            onchange: e=>{
                if (e.target.value !== selectedImageType){
                    ImageFile.setOriginalImageType(e.target.value);
                }
            }
        });

        availableImageTypes.forEach(imageType=>{
            $("option",{
                parent: select,
                value: imageType,
                text: getImageTypeLabel(imageType),
                selected: imageType === selectedImageType
            });
        });
    }

    function getImageTypeLabel(type){
        if (type === "classicIcon") return "Classic";
        if (type === "colorIcon") return "Color";
        if (type === "PNGIcon") return "PNG";
        return type || "Unknown";
    }

    function getAvailableIconTypes(){
        return [
            {value: 1, label: "Disk"},
            {value: 2, label: "Drawer"},
            {value: 3, label: "Tool"},
            {value: 4, label: "Project"},
            {value: 5, label: "Garbage"},
        ];
    }

    function renderToolTypesEditor(parent,toolTypes){
        let wrapper = $div("subpanel","",parent);
        $div("label","Tooltypes",wrapper);
        let textarea = $("textarea",{
            parent: wrapper,
            rows: Math.max(4,Math.min(10,(toolTypes || []).length || 4)),
            value: (toolTypes || []).join("\n"),
            onkeydown: e=>{
                e.stopPropagation();
            },
            oninput: e=>{
                ImageFile.setOriginalToolTypes(e.target.value);
            },
            style: {
                width: "100%",
                minHeight: "88px",
                resize: "vertical",
                boxSizing: "border-box"
            }
        });
        textarea.placeholder = "One tooltype per line";
    }

    function renderDefaultToolEditor(parent,defaultTool){
        $(".subpanel.flex.condensed",
            {parent},
            $(".label","Default tool"),
            $("input",{
                type: "text",
                value: defaultTool || "",
                placeholder: "Optional default tool",
                onkeydown: e=>{
                    e.stopPropagation();
                },
                oninput: e=>{
                    ImageFile.setOriginalDefaultTool(e.target.value);
                },
                style: {
                    width: "100%",
                    boxSizing: "border-box"
                }
            })
        );
    }

    function generateInfoLine(label,value,parent){
        let line = document.createElement("dl");
        let dt = document.createElement("dt");
        dt.innerHTML = label;
        let dd = document.createElement("dd");
        dd.innerHTML = value;
        line.appendChild(dt);
        line.appendChild(dd);
        parent.appendChild(line);
    }

    EventBus.on(COMMAND.TOGGLESIDEPANEL,me.toggle);
    EventBus.on(EVENT.imageSizeChanged,()=>{
        renderIconInfo();
        setPanelsState();
    });

    return me;
}()

export default SidePanel;
