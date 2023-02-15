import {$div, $link} from "../util/dom.js";
import {COMMAND, EVENT} from "../enum.js";
import EventBus from "../util/eventbus.js";
import Palette from "./palette.js";
import Brush from "./brush.js";
import Editor from "./editor.js";
import ToolOptions from "./components/toolOptions.js";
import SidePanel from "./sidepanel.js";

let Toolbar = function(){
    let me = {}
    let container;

    let items=[
        {name: "pencil",command: COMMAND.DRAW, isTool: true, info: "Left click: draw with foreground color, Right click: draw with background color"},
        {name: "select",command: COMMAND.SELECT, isTool: true, handleDeActivate: true, info: "Make rectangular selection"},
        {name: "polygonselect",command: COMMAND.POLYGONSELECT, isTool: true, handleDeActivate: true, info: "Make polygon selection"},
        {name: "line",label: "", isTool: true, command: COMMAND.LINE, info: "Draw straight line"},
        {name: "circle",label: "", isTool: true, canFill: true, command: COMMAND.CIRCLE, info: "Draw ellipsis. Shift to lock to circle, select again to toggle fill."},
        {name: "square",label: "", isTool: true, canFill: true, command: COMMAND.SQUARE, info: "Draw rectangle. Shift to lock to square, select again to toggle fill."},
        {name: "gradient", isTool: true, command: COMMAND.GRADIENT, info: "Gradient fill, draw line to set start- and endpoint"},
        {name: "stamp", command: COMMAND.STAMP, info: "Draw stencil from selection"},
        {name: "erase", isTool: true, command: COMMAND.ERASE, info: "Erase"},
        {name: "split", command: COMMAND.SPLITSCREEN, toggleProperty: "splitPanel", info: "Toggle split view"},
        {name: "zoom",label: "", command: COMMAND.ZOOMIN, info: "Zoom in"},
        {name: "zoomout",label: "",command: COMMAND.ZOOMOUT, info: "Zoom out"}
    ]

    me.init = function(parent){
        container = $div("toolbar","",parent);
        generate();

        EventBus.on(EVENT.toolOptionsChanged,()=>{
            if (container) container.classList.toggle("fill",ToolOptions.isFill());
        })
    }

    me.activateButton = function(index){
        let item = items[index];
        if (item){
            if (item.element){
                if (item.canFill && item.element.classList.contains("active")){
                    ToolOptions.setFill(!ToolOptions.isFill());
                }
            }
            if (item.command) EventBus.trigger(item.command);
        }
    }

    function generate(){
        let toggleButton = $div("togglepanel info","",container,()=>{
            SidePanel.toggle();
        });
        toggleButton.info = "Toggle side panels"


        Brush.init(container);
        items.forEach((item,index)=>{
            item.element = $div("button handle info icon " + item.name,item.label,container,(e) =>{
                me.activateButton(index);
            });

            item.element.info = item.info;
            if (item.isTool && item.command){
                EventBus.on(item.command,()=>{
                    items.forEach((itm,i)=>{
                        if (itm.isTool){
                            if (itm.handleDeActivate && itm.command && itm.element.classList.contains("active") && index !== i){
                                EventBus.trigger(EVENT.toolDeActivated,itm.command);
                            }
                            itm.element.classList.toggle("active",index === i);
                        }
                    });
                    EventBus.trigger(EVENT.toolChanged,item.command);
                });
            }

            if (item.toggleProperty && item.command){
                EventBus.on(item.command,()=>{
                    setTimeout(() => {
                        items.forEach((itm,i)=>{
                            if (index === i){
                                itm.element.classList.toggle("active",Editor.isStateActive(item.toggleProperty));
                            }
                        });
                    },50)
                })
            }
        });

        Palette.init(container);
    }

    return me;


}();

export default Toolbar;