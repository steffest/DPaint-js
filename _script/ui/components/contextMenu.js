import {$div} from "../../util/dom.js";
import Cursor from "../cursor.js";
import EventBus from "../../util/eventbus.js";

let ContextMenu = (()=>{
    let menu;
    let me = {}

    me.show = (items)=>{
        if (!menu){
            menu = $div("contextmenu");
            document.body.appendChild(menu);
        }

        menu.innerHTML = "";
        items.forEach(item=>{
            $div("contextmenuitem",item.label,menu,()=>{
                if (item.command) EventBus.trigger(item.command);
                if (item.action) item.action();
                me.hide();
            })
        })

        let position = Cursor.getPosition();
        menu.style.left = position.x + "px";
        menu.style.top = position.y + "px";
        menu.classList.add("active");
    }

    me.hide = ()=>{
        if (menu) menu.classList.remove("active");
    }

    return me;
})();

export default ContextMenu;