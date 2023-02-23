import {COMMAND, EVENT} from "../enum.js";
import {$div} from "../util/dom.js";
import ImageProcessing from "../util/imageProcessing.js";
import ImageFile from "../image.js";
import EventBus from "../util/eventbus.js";
import Palette from "./palette.js";
import LayerPanel from "./components/layerPanel.js";
import FramesPanel from "./components/framesPanel.js";
import BrushPanel from "./components/brushPanel.js";

var SidePanel = function(){
    let me = {}
    let container;

    let panels = {
        info:{
            label: "Info",
            height: 100
        },
        frames:{
            label: "Frames",
            height: 100,
            content: parent=>{
                FramesPanel.generate(parent);
            }
        },
        layers:{
            label: "Layers",
            height: 180,
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
        colors:{
            label: "Colors",
            height: 230,
            content: parent=>{
                Palette.generateControlPanel(parent);
            }
        }
    }

    me.init = parent=>{
        container = $div("sidepanel");
        parent.appendChild(container);
        generate();
    }

    me.show = ()=>{
        document.body.classList.add("withsidepanel");
    }

    me.hide = ()=>{
        document.body.classList.remove("withsidepanel");
    }

    me.toggle = ()=>{
        document.body.classList.toggle("withsidepanel");
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
            console.error(contentPanel,file);
        }
        FramesPanel.list();
        me.show();
    }

    function generate(){
        let y = 0;
        Object.keys(panels).forEach(key=>{
            let panel = panels[key];
            let height = (panel.height || 100);
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
        let close = $div("close","x",caption,me.hide);
        let inner = $div("inner","",panel);
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
            if (panel.collapsed) height=21;
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
    
    return me;
}()

export default SidePanel;