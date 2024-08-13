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

var SidePanel = function(){
    let me = {}
    let container;
    let collapsedHeight = 21;

    let panels = {
        info:{
            label: "Info",
            height: 84
        },
        frames:{
            label: "Frames",
            height: 116,
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
            height: 118,
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
            content: parent=>{
                GridPanel.generate(parent);
            }
        },
        reduce:{
            label: "Reduce Colors",
            collapsed: true,
            height: 270,
            content: parent=>{
                Palette.generateControlPanel(parent);
            }
        }
    }

    me.init = parent=>{
        let w=175;
        let panel = $(".sidepanel",{
            parent: parent,
            style: {width: w + "px"}
        },
            container=$(".panelcontainer"),
            $(".panelsizer",{
                onDrag: (x)=>{
                    let _w = Math.max(w + x,120);
                    panel.style.width = _w + "px";
                    EventBus.trigger(EVENT.panelResized,_w);
                },
                onDragStart: e=>{
                    w=panel.offsetWidth;
                }
            })
        );
        generate();
    }

    me.show = (section)=>{
        document.body.classList.add("withsidepanel");
        if (section){
            Object.keys(panels).forEach(key=>{
                if (key === section){
                    panels[key].collapsed = false;
                }
            })
            setPanelsState();
        }
    }

    me.hide = ()=>{
        document.body.classList.remove("withsidepanel");
    }

    me.toggle = ()=>{
        document.body.classList.toggle("withsidepanel");
        EventBus.trigger(EVENT.UIresize);
    }

    me.isVisible = ()=>{
        return document.body.classList.contains("withsidepanel");
    }

    me.showInfo = (file)=>{
        let contentPanel = panels.info.container.querySelector(".inner");
        if (contentPanel){
            if (file && file.width){
                contentPanel.innerHTML = "";
                generateInfoLine("Width",file.width + "px",contentPanel);
                generateInfoLine("Height",file.height + "px",contentPanel);
                generateInfoLine("Colors",ImageProcessing.getColors(ImageFile.getCanvas()).length,contentPanel);
            }else{
                contentPanel.innerHTML = "<small>No file present</small>";
            }
        }
        FramesPanel.list();
        me.show();
    }

    function generate(){
        let y = 0;
        Object.keys(panels).forEach(key=>{
            let panel = panels[key];
            let height = panel.collapsed?collapsedHeight:(panel.height || 100);
            panel.container = generatePanel(panel,container);
            panel.container.style.height = height + "px";
            panel.container.style.top = y + "px";
            y+= height;
        })
    }

    function generatePanel(panelInfo,parent){
        let panel = $div("panel " + panelInfo.label.toLowerCase() + (panelInfo.collapsed?' collapsed':''),"",parent);
        let caption = $div("caption","<i></i> " + panelInfo.label,panel,()=>{
            panelInfo.collapsed = !panelInfo.collapsed;
            setPanelsState();
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
            let height = (panel.height || 100);
            if (panel.collapsed) height=collapsedHeight;
            panel.container.style.height = height + "px";
            panel.container.style.top = y + "px";
            panel.container.classList.toggle("collapsed",!!panel.collapsed);
            y+= height;
        })
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
    
    return me;
}()

export default SidePanel;