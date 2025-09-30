import {COMMAND, EVENT, SETTING} from "../enum.js";
import $, {$checkbox, $div} from "../util/dom.js";
import EventBus from "../util/eventbus.js";
import UserSettings from "../userSettings.js";

var ContentPanel = function(){
    let me = {}
    let container;

    me.init = parent=>{
        let w=175;
        let panel = $(".contentpanel",{
                parent: parent,
                style: {width: w + "px"}
            },
            container=$(".panelcontainer",
                $(".caption","Preferences",$(".close",{onClick:me.hide},"x"))
            ),
            $(".panelsizer",{
                onDrag: (x)=>{
                    let _w = Math.max(w + x,120);
                    panel.style.width = _w + "px";
                    //EventBus.trigger(EVENT.panelResized,_w);
                },
                onDragStart: e=>{
                    w=panel.offsetWidth;
                }
            })
        );
        generate();


        EventBus.on(EVENT.panelResized,(width=>{
            panel.style.left = width + 75 + "px";
        }));
    }

    me.show = (section)=>{
        document.body.classList.add("withcontentpanel");
    }

    me.hide = ()=>{
        document.body.classList.remove("withcontentpanel");
    }

    me.toggle = ()=>{
        document.body.classList.toggle("withcontentpanel");
        EventBus.trigger(EVENT.UIresize);
    }

    me.isVisible = ()=>{
        return document.body.classList.contains("withcontentpanel");
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