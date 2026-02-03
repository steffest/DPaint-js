import {COMMAND, EVENT, SETTING} from "../enum.js";
import $, {$checkbox, $div} from "../util/dom.js";
import EventBus from "../util/eventbus.js";
import UserSettings from "../userSettings.js";
import SidePanel from "./sidepanel.js";

var ContentPanel = function(){
    let me = {}
    let container;
    let innerContainer;

    me.init = parent=>{
        let w=175;
        container = $(".contentpanel",{
                parent: parent,
                style: {width: w + "px"}
            },
            innerContainer=$(".panelcontainer",
                $(".caption.noicon","Preferences",$(".close",{onClick:me.hide},"x"))
            ),
            $(".panelsizer",{
                onDrag: (x)=>{
                    let _w = Math.max(w + x,120);
                    container.style.width = _w + "px";
                    EventBus.trigger(EVENT.panelUIChanged);
                },
                onDragStart: e=>{
                    w=container.offsetWidth;
                }
            })
        );
        generate();


        EventBus.on(EVENT.panelUIChanged,(()=>{
            container.style.left = SidePanel.getWidth() + 70 + "px";
        }));
    }

    me.show = (section)=>{
        container.classList.add("active");
        EventBus.trigger(EVENT.panelUIChanged);
    }

    me.hide = ()=>{
        container.classList.remove("active");
        EventBus.trigger(EVENT.panelUIChanged);
    }

    me.toggle = ()=>{
        container.classList.toggle("active");
        EventBus.trigger(EVENT.panelUIChanged);
    }

    me.isVisible = ()=>{
        return container.classList.contains("active");
    }

    me.getWidth = ()=>{
        if (me.isVisible()){
            return container.offsetWidth + 5;
        }else{
            return 0;
        }
    }


    function generate(){
        //container.innerHTML = "";
        container.appendChild(
            $("section",
                $("h4","Touch"),
                $checkbox("Rotate on Pinch/zoom",null,"",(checked)=>{UserSettings.set(SETTING.touchRotate,checked)},UserSettings.get(SETTING.touchRotate)),
            )
        )
    }

    EventBus.on(COMMAND.PREFERENCES,me.toggle);

    return me;
}()

export default ContentPanel;