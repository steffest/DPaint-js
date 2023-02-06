import {$div, $link} from "../util/dom.js";
import {COMMAND, EVENT} from "../enum.js";
import EventBus from "../util/eventbus.js";
import Palette from "./palette.js";
import Brush from "./brush.js";
import Editor from "./editor.js";

let Toolbar = function(){
    let me = {}
    let container;

    let items=[
        {name: "pencil",command: COMMAND.DRAW, isTool: true},
        {name: "select",command: COMMAND.SELECT, isTool: true, handleDeActivate: true},
        {name: "circle",label: "", isTool: true, command: COMMAND.CIRCLE},
        {name: "square",label: "", isTool: true, command: COMMAND.SQUARE},
        {name: "line",label: "L", isTool: true, command: COMMAND.LINE},
        {name: "stamp",label: "S", command: COMMAND.STAMP},
        {name: "erase",label: "E", isTool: true, command: COMMAND.ERASE},
        {name: "split", command: COMMAND.SPLITSCREEN, toggleProperty: "splitPanel"},
        {name: "zoom",label: "", command: COMMAND.ZOOMIN},
        {name: "zoomout",label: "",command: COMMAND.ZOOMOUT}
    ]

    me.init = function(parent){
        container = $div("toolbar");
        parent.appendChild(container);
        generate();
    }

    me.activateButton = function(index){
        let item = items[index];
        if (item && item.command) EventBus.trigger(item.command);
    }

    function generate(){
        Brush.init(container);
        items.forEach((item,index)=>{
            item.element = $div("button handle icon " + item.name,item.label,container,(e) =>{
                me.activateButton(index);
            });

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