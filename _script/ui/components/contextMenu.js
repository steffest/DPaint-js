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
            // An item may be `disabled`: it stays visible (so the available operations are
            // discoverable) but does nothing and renders dimmed.
            if (item.disabled){
                let elm = $div("contextmenuitem disabled",item.label,menu);
                elm.setAttribute("aria-disabled","true");
                return;
            }
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

        // Keep the menu on screen: now that it's laid out we can measure it and nudge it
        // back inside the viewport when it would overflow the right/bottom edge.
        const margin = 4;
        let rect = menu.getBoundingClientRect();
        let x = position.x;
        let y = position.y;
        if (rect.right > window.innerWidth) x -= (rect.right - window.innerWidth + margin);
        if (rect.bottom > window.innerHeight) y -= (rect.bottom - window.innerHeight + margin);
        x = Math.max(margin, x);
        y = Math.max(margin, y);
        if (x !== position.x) menu.style.left = x + "px";
        if (y !== position.y) menu.style.top = y + "px";
    }

    me.hide = ()=>{
        if (menu) menu.classList.remove("active");
    }

    return me;
})();

export default ContextMenu;