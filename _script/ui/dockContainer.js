import $, {$div} from "../util/dom.js";
import EventBus from "../util/eventbus.js";
import {EVENT} from "../enum.js";
import {SNAP_THRESHOLD} from "./panelManager.js";

// DockContainer — one edge-docked region (left | right | bottom). Reuses the existing
// .panelcontainer / .panelsizer chrome and the side-panel cumulative-offset stacking.
//
// left/right  : panels stack vertically (cumulative top, per-panel height; collapsed
//               panels shrink to COLLAPSED_HEIGHT). right anchors to the right edge and
//               carries the resize sizer on its left edge.
// bottom      : panels stack horizontally (cumulative left). Collapsed bottom panels
//               render as a narrow vertical bar (handled via CSS in Phase 4).

const COLLAPSED_HEIGHT = 21;
const MIN_WIDTH = 120;
const MIN_HEIGHT = 60;
const DEFAULT_WIDTH = 175;
const DEFAULT_HEIGHT = 130;

function DockContainer(side, manager){
    let me = {};
    me.side = side;
    me.kind = "dock";

    let isHorizontal = side === "bottom";
    let size = isHorizontal ? DEFAULT_HEIGHT : DEFAULT_WIDTH;

    // root element. Carries a legacy alias class (.sidepanel / .bottompanel) so existing
    // selectors and SCSS that target the old containers keep working.
    let legacyClass = side === "left" ? " sidepanel" : (side === "bottom" ? " bottompanel" : "");
    let el = $div("dockcontainer dock-" + side + legacyClass);
    let innerContainer = $div("panelcontainer", "", el);

    // resize sizer: right edge for left, left edge for right, top edge for bottom.
    // `handle` is required for the global pointer pipeline (input.js dispatches drag via
    // e.target.closest(".handle")); the drag hooks are assigned below, after creation.
    let sizer = $div("panelsizer dock-sizer-" + side + " handle", "", el);
    let sizeAtDragStart;
    sizer.onDragStart = ()=>{ sizeAtDragStart = size; };
    sizer.onDrag = (x, y)=>{
        let delta;
        if (side === "left") delta = x;
        else if (side === "right") delta = -x;
        else delta = -y; // bottom: dragging up grows height
        me.setSize(sizeAtDragStart + delta);
        manager.apply();
    };
    sizer.onDragEnd = ()=>{ manager.persist(); };

    me.el = el;
    me.innerContainer = innerContainer;

    me.getSize = ()=>size;
    me.setSize = (px)=>{
        let min = isHorizontal ? MIN_HEIGHT : MIN_WIDTH;
        size = Math.max(px, min);
    };

    me.mount = function(panelView){
        if (panelView.el.parentNode !== innerContainer){
            innerContainer.appendChild(panelView.el);
        }
    };

    // position an ordered list of PanelViews inside this container
    me.layout = function(views){
        // size the container element itself (panels inside are positioned relative to it)
        if (isHorizontal){
            el.style.height = size + "px";
            el.style.width = "";
        }else{
            el.style.width = size + "px";
            el.style.height = "";
        }
        // Panels stack along the container axis at their own size and keep that size until
        // the user resizes them. The single exception is the LAST panel: when expanded it
        // stretches to fill the remaining space (anchored to the far edge with bottom:0 /
        // right:0), so there's never an empty gap at the end. A collapsed panel — including
        // the last one — just renders as a fixed-size bar in its natural slot; collapsing
        // the last panel does NOT reflow anything onto an earlier panel.
        let lastIndex = views.length - 1;

        if (isHorizontal){
            let x = 0;
            views.forEach((view, i)=>{
                let state = manager.getLayout(view.id);
                view.el.style.top = "0px";
                view.el.style.height = "";
                if (i === lastIndex && !state.collapsed){
                    // last expanded panel fills the remaining width
                    view.el.style.left = x + "px";
                    view.el.style.width = "";
                    view.el.style.right = "0px";
                }else{
                    // a collapsed bottom panel shrinks to a narrow vertical bar (rotated title)
                    let w = state.collapsed ? COLLAPSED_HEIGHT : (state.size || view.def.width || DEFAULT_WIDTH);
                    view.el.style.left = x + "px";
                    view.el.style.right = "";
                    view.el.style.width = w + "px";
                    x += w;
                }
            });
        }else{
            let y = 0;
            views.forEach((view, i)=>{
                let state = manager.getLayout(view.id);
                view.el.style.left = "0px";
                view.el.style.right = "0px";
                view.el.style.width = "";
                if (i === lastIndex && !state.collapsed){
                    // last expanded panel fills the remaining height
                    view.el.style.top = y + "px";
                    view.el.style.height = "";
                    view.el.style.bottom = "0px";
                }else{
                    let h = state.collapsed ? COLLAPSED_HEIGHT : (state.size || view.def.height || 100);
                    view.el.style.top = y + "px";
                    view.el.style.bottom = "";
                    view.el.style.height = h + "px";
                    y += h;
                }
            });
        }
    };

    // snapZoneTest: is (clientX,clientY) over this container's drop zone?
    //
    // The zone is the container's OWN rectangle, extended outward to the viewport edge.
    // A docked container does not necessarily touch that edge — the toolbar sits to the
    // left of the left dock — so testing a fixed SNAP_THRESHOLD band at the viewport edge
    // would sit over the toolbar and miss the container the snap indicator then draws over.
    // Extending outward keeps the "drag all the way to the edge" gesture working.
    //
    // An empty or hidden container has no rectangle (display:none → all-zero rect), so it
    // falls back to the plain SNAP_THRESHOLD edge band — that is what lets a panel be
    // dropped onto a side that currently holds nothing.
    //
    // The insertion index is computed by PanelManager.insertionIndexFor, not here.
    me.snapZoneTest = function(clientX, clientY){
        let vw = window.innerWidth;
        let vh = window.innerHeight;
        let rect = el.getBoundingClientRect();
        let sized = rect.width > 0 && rect.height > 0;

        if (side === "bottom"){
            let inner = sized ? rect.top : vh - SNAP_THRESHOLD;
            if (clientY < inner || clientY > vh) return false;
            return sized ? (clientX >= rect.left && clientX <= rect.right) : true;
        }

        // left / right: the main axis runs from the viewport edge to the container's
        // inner edge; the cross axis is limited to the container's own extent.
        if (side === "left"){
            let inner = sized ? rect.right : SNAP_THRESHOLD;
            if (clientX < 0 || clientX > inner) return false;
        }else{
            let inner = sized ? rect.left : vw - SNAP_THRESHOLD;
            if (clientX < inner || clientX > vw) return false;
        }
        return sized ? (clientY >= rect.top && clientY <= rect.bottom) : true;
    };

    return me;
}

// FloatLayer — hosts floating PanelViews positioned by absolute x/y over the app
// container. Contributes nothing to the editor layout size.
function FloatLayer(manager){
    let me = {};
    me.side = "floating";
    me.kind = "float";

    let el = $div("floatlayer");
    me.el = el;

    me.mount = function(panelView){
        if (panelView.el.parentNode !== el){
            el.appendChild(panelView.el);
        }
        let state = manager.getLayout(panelView.id);
        panelView.el.style.left = (state.x || 80) + "px";
        panelView.el.style.top = (state.y || 80) + "px";
        let fs = panelView.def.floatSize;
        // persisted user size (fw/fh) wins over the panel's default floatSize
        let w = state.fw || (fs && fs.w);
        let h = state.fh || (fs && fs.h);
        if (w) panelView.el.style.width = w + "px";
        if (h) panelView.el.style.height = h + "px";
    };

    me.layout = function(){ /* floating panels are positioned individually on mount */ };
    me.snapZoneTest = ()=>null;

    return me;
}

export {DockContainer, FloatLayer, COLLAPSED_HEIGHT};
