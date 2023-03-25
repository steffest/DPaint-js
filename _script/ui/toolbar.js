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
    let undo,redo;

    let items=[
        {name: "pencil",command: COMMAND.DRAW, isTool: true, info: "Left click: draw with foreground color, Right click: draw with background color"},
        {name: "select",command: COMMAND.SELECT, isTool: true, handleDeActivate: true, info: "Make rectangular selection"},
        {name: "polygonselect",command: COMMAND.POLYGONSELECT, isTool: true, handleDeActivate: true, info: "Make polygon selection"},
        {name: "floodselect", isTool: true, command: COMMAND.FLOODSELECT, info: "Make selection of on area of the same color"},
        {name: "circle",label: "", isTool: true, canFill: true, command: COMMAND.CIRCLE, info: "Draw ellipsis. Shift to lock to circle, select again to toggle fill."},
        {name: "square",label: "", isTool: true, canFill: true, command: COMMAND.SQUARE, info: "Draw rectangle. Shift to lock to square, select again to toggle fill."},
        {name: "line",label: "", isTool: true, command: COMMAND.LINE, info: "Draw straight line"},
        {name: "gradient", isTool: true, command: COMMAND.GRADIENT, info: "Gradient fill, draw line to set start- and endpoint"},
        {name: "flood", isTool: true, command: COMMAND.FLOOD, info: "Fill an area"},
        {name: "stamp", command: COMMAND.STAMP, info: "Draw stencil from selection"},
        {name: "erase", isTool: true, command: COMMAND.ERASE, info: "Erase"},
        {name: "split", command: COMMAND.SPLITSCREEN, toggleProperty: "splitPanel", info: "Toggle split view"},
        {name: "zoom",label: "", command: COMMAND.ZOOMIN, info: "Zoom in"},
        {name: "zoomout",label: "",command: COMMAND.ZOOMOUT, info: "Zoom out"},
        {name: "undo", command: COMMAND.UNDO, info: "Undo"},
        {name: "redo",command: COMMAND.REDO, info: "Redo"}
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

            if (item.command === COMMAND.UNDO){
                undo = item.element;
                undo.classList.toggle("disabled",true);
            }
            if (item.command === COMMAND.REDO){
                redo = item.element;
                redo.classList.toggle("disabled",true);
            }
        });

        Palette.init(container);
    }

    EventBus.on(EVENT.historyChanged,([undoCount,redoCount])=>{
        if (undo) undo.classList.toggle("disabled",undoCount === 0);
        if (redo) redo.classList.toggle("disabled",redoCount === 0);
    });

    return me;


}();

export default Toolbar;