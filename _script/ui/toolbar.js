import {$div, $link} from "../util/dom.js";
import {COMMAND} from "../enum.js";
import EventBus from "../util/eventbus.js";
import Palette from "./palette.js";
import Brush from "./brush.js";
import Editor from "./editor.js";

let Toolbar = function(){
    let me = {}
    let container;

    let items=[
        {name: "line",command: COMMAND.DRAW, isTool: true},
        {name: "select",command: COMMAND.SELECT, isTool: true},
        {name: "stamp",label: "S", command: COMMAND.STAMP},
        {name: "split",label: "|", command: COMMAND.SPLITSCREEN, toggleProperty: "splitPanel"},
        {name: "zoom",label: "+", command: COMMAND.ZOOMIN},
        {name: "zoomout",label: "-",command: COMMAND.ZOOMOUT}
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
                        if (itm.isTool) itm.element.classList.toggle("active",index === i);
                    });
                })
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