import $, {$div} from "../util/dom.js";

// PanelView — one per registered panel. Builds the existing panel chrome
// (.panel > .caption(i, close, more) / .inner / .sizer) via the $ helpers and
// reuses the existing SCSS. The content generator is invoked lazily exactly once;
// the DOM node is re-parented (never re-generated) when the panel moves between
// containers, so live canvases and event wiring survive a move.
//
// Caption interactions:
//  - drag (threshold-gated by PanelManager) → dock / reorder / float
//  - a press that never crosses the drag threshold → collapse toggle (decided in
//    onDragEnd, so a click never accidentally decouples the panel)
//  - right-click / long-press / the .more button → caption context menu

let PanelView = function(def, manager){
    let me = {};
    let contentRendered = false;

    me.id = def.id;
    me.def = def;

    let panel = $div("free-panel " + def.id);
    // `handle` makes the global pointer pipeline (input.js) pick up the drag hooks below;
    // input.js dispatches via e.target.closest(".handle").
    let caption = $div("caption handle", "", panel);
    let captionIcon = document.createElement("i");
    caption.appendChild(captionIcon);
    caption.appendChild(document.createTextNode(" " + (def.label || def.id)));

    // ── Caption drag (consumed by the global pointer pipeline in input.js) ──────────
    caption.onDragStart = (e)=>{
        manager.beginDrag(me.id, e.clientX, e.clientY);
    };
    caption.onDrag = (x, y, touchData, e)=>{
        manager.updateDrag(e.clientX, e.clientY);
    };
    caption.onDragEnd = (e)=>{
        let wasDragging = manager.isDragging();
        let cx = e ? e.clientX : 0;
        let cy = e ? e.clientY : 0;
        manager.endDrag(cx, cy);
        // a press that never became a drag → treat as a collapse toggle
        if (!wasDragging){
            manager.setCollapsed(me.id, !manager.getLayout(me.id).collapsed);
        }
    };
    caption.onContextMenu = ()=>{ manager.showPanelMenu(me.id); };

    // explicit "more" affordance (also opens the context menu)
    let more = $div("more info", "", caption, ()=>{ manager.showPanelMenu(me.id); });
    more.info = "Panel options";

    let close = $div("close info", "x", caption, ()=>{
        manager.hide(me.id);
    });
    close.info = "Close panel";

    let inner = $div("inner", "", panel);

    // per-panel edge sizer: resizes this docked panel along the container's stacking axis
    // (height in left/right, width in bottom). `handle` lets the global pointer pipeline
    // drive the drag (input.js dispatches via e.target.closest(".handle")).
    let sizer = $div("sizer handle", "", panel);
    let panelResizeStart;
    sizer.onDragStart = ()=>{ panelResizeStart = manager.beginPanelResize(me.id); };
    sizer.onDrag = (x, y)=>{ if (panelResizeStart) manager.updatePanelResize(me.id, panelResizeStart, x, y); };
    sizer.onDragEnd = ()=>{ manager.persist(); };

    // corner resize handle — only meaningful while the panel floats (CSS hides it when
    // docked). Drives PanelManager.resizeFloat via the global pointer pipeline.
    let floatResize = $div("float-resize handle", "", panel);
    let resizeStart;
    floatResize.onDragStart = (e)=>{
        resizeStart = manager.beginFloatResize(me.id);
    };
    floatResize.onDrag = (x, y)=>{
        if (resizeStart) manager.updateFloatResize(me.id, resizeStart, x, y);
    };
    me.floatResize = floatResize;

    me.el = panel;
    me.caption = caption;
    me.inner = inner;
    me.sizer = sizer;

    // Host object substituting for the modal `me` passed to converted dialog
    // handlers — only inputKeyDown + hide are ever used by those handlers.
    let host = {
        inputKeyDown: (e)=>{ e.stopPropagation(); },
        hide: ()=>{ manager.hide(me.id); }
    };

    me.renderContent = function(){
        if (contentRendered) return;
        contentRendered = true;
        if (typeof def.content === "function"){
            def.content(inner, host);
        }
    };

    // Force a fresh render (used by dialog-style panels that rebuild from current state
    // each time they are shown, e.g. palette/effects/bitplanes). The inner is cleared
    // first so generators that append (rather than replace) don't duplicate content.
    me.rerenderContent = function(){
        if (typeof def.content === "function"){
            contentRendered = true;
            inner.innerHTML = "";
            def.content(inner, host);
        }
    };

    me.isContentRendered = ()=>contentRendered;

    me.setCollapsedClass = function(collapsed){
        panel.classList.toggle("collapsed", !!collapsed);
    };

    return me;
};

export default PanelView;
