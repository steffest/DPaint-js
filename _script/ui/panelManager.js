import {COMMAND, EVENT, SETTING} from "../enum.js";
import $, {$div} from "../util/dom.js";
import EventBus from "../util/eventbus.js";
import UserSettings from "../userSettings.js";
import PanelView from "./panelView.js";
import {DockContainer, FloatLayer} from "./dockContainer.js";
import NativePanels from "./nativePanels.js";
import Input from "./input.js";
import ContextMenu from "./components/contextMenu.js";
import Menu from "./menu.js";
import ImageFile from "../image.js";

// PanelManager — single owner of the free-panel docking system.
//
// Panels are data (PanelDef in a registry); containers (left/right/bottom/floating)
// are thin renderers of an ordered list of panel ids. Layout state (container, order,
// collapsed, visible, floating x/y, size) is persisted via UserSettings.
//
// Built incrementally across phases. Current scope: registry + layout state, PanelView
// lifecycle, container mount/layout, apply()/move()/setCollapsed, extents for editor.js.
// (Persistence, View-menu, drag, dialog conversions land in later phases.)

// ── Tunable internal constants (NOT user-exposed; see design §"Tunable constants") ──
export const DRAG_THRESHOLD = 6;
export const SNAP_THRESHOLD = 48;

const LAYOUT_VERSION = 1;
const LAYOUT_KEY = "panelLayout";

let PanelManager = (function(){
    let me = {};

    let parentEl;
    let registry = new Map();     // id → PanelDef
    let layout = {};              // id → PanelLayoutState
    let views = {};               // id → PanelView (created on first need)
    let containers = {};          // name → DockContainer | FloatLayer
    let initialized = false;
    let extents = {left:0, right:0, bottom:0};
    // container-level visibility (the legacy "whole side panel" show/hide). Per-panel
    // `visible` state is preserved while a container is hidden. Left starts hidden to
    // match the legacy default (side panel inactive on fresh load).
    let containerHidden = {left:true, right:false, bottom:false, floating:false};

    // ── Registry ────────────────────────────────────────────────────────────────
    me.register = function(panelDef){
        if (!panelDef || !panelDef.id){
            console.error("PanelManager.register: panelDef requires an id", panelDef);
            return;
        }
        registry.set(panelDef.id, panelDef);
        if (!layout[panelDef.id]) layout[panelDef.id] = defaultLayoutFor(panelDef);
        // Eagerly create + render content for non-lazy panels so component modules whose
        // generate() populates internal state (e.g. LayerPanel) are ready before any
        // event (layersChanged, etc.) calls back into them — matching the legacy
        // sidepanel behaviour of generating all panel content up front. Heavy on-demand
        // editors (palette/effects/…) set lazy:true and render on first show.
        if (!panelDef.lazy){
            let view = getView(panelDef.id);
            if (view) view.renderContent();
        }
        if (initialized) me.apply();
        return panelDef;
    };

    me.get = (id)=>registry.get(id);
    me.getIds = ()=>Array.from(registry.keys());
    me.getLayout = (id)=>layout[id];

    function defaultLayoutFor(def){
        return {
            container: def.defaultContainer || "left",
            order: typeof def.defaultOrder === "number" ? def.defaultOrder : 0,
            collapsed: !!def.defaultCollapsed,
            visible: def.defaultVisible !== false,
            x: undefined,
            y: undefined,
            size: undefined
        };
    }

    function getView(id){
        if (!views[id]){
            let def = registry.get(id);
            if (!def) return undefined;
            views[id] = PanelView(def, me);
        }
        return views[id];
    }

    function isAvailable(id){
        let def = registry.get(id);
        if (def && typeof def.isAvailable === "function") return !!def.isAvailable();
        return true;
    }

    // ordered list of panel ids assigned to a container that are visible + available
    me.getVisibleIdsFor = function(side){
        return me.getIds()
            .filter(id => layout[id].container === side && layout[id].visible && isAvailable(id))
            .sort((a,b)=> layout[a].order - layout[b].order);
    };

    me.getVisibleViewsFor = function(side){
        return me.getVisibleIdsFor(side).map(getView).filter(Boolean);
    };

    // ── Visibility ────────────────────────────────────────────────────────────────
    me.isVisible = (id)=> !!(layout[id] && layout[id].visible);

    me.show = function(id /*, section */){
        let state = layout[id];
        if (!state) return;
        state.visible = true;
        me.apply();
        let view = getView(id);
        let def = registry.get(id);
        if (view){
            // dialog-style panels rebuild from current state on each show
            if (def && def.rerenderOnShow) view.rerenderContent();
            else view.renderContent();
        }
        if (def && def.onShow) def.onShow();
        me.persist();
    };

    me.hide = function(id){
        let state = layout[id];
        if (!state) return;
        state.visible = false;
        let def = registry.get(id);
        if (def && def.onHide) def.onHide();   // e.g. dialog handler onClose()
        me.apply();
        me.persist();
    };

    me.toggle = function(id){
        if (me.isVisible(id)) me.hide(id); else me.show(id);
    };

    // reveal: show a panel AND ensure its container is visible + expanded (the common
    // "jump to this section" intent; replaces legacy SidePanel.show("section")).
    me.reveal = function(id, expand){
        let state = layout[id];
        if (!state) return;
        if (containerHidden[state.container]) me.showContainer(state.container);
        if (expand && state.collapsed){
            state.collapsed = false;
        }
        me.show(id);
    };

    // ── Container-level visibility (legacy "whole side/bottom panel" show/hide) ────
    me.isContainerVisible = (side)=> !containerHidden[side];

    me.showContainer = function(side){
        containerHidden[side] = false;
        if (side === "left") UserSettings.set("sidepanel", true);
        if (side === "bottom") UserSettings.set("bottompanel", true);
        me.apply();
        me.persist();
    };

    me.hideContainer = function(side){
        containerHidden[side] = true;
        if (side === "left") UserSettings.set("sidepanel", false);
        if (side === "bottom") UserSettings.set("bottompanel", false);
        me.apply();
        me.persist();
    };

    me.toggleContainer = function(side){
        if (containerHidden[side]) me.showContainer(side); else me.hideContainer(side);
    };

    me.setCollapsed = function(id, collapsed){
        let state = layout[id];
        if (!state) return;
        state.collapsed = !!collapsed;
        let view = getView(id);
        if (view) view.setCollapsedClass(state.collapsed);
        me.apply();
        me.persist();
    };

    // ── Move (dock / float / reorder) ─────────────────────────────────────────────
    me.move = function(id, container, index){
        let state = layout[id];
        if (!state) return;
        if (!containers[container]) container = "floating";

        let siblings = me.getVisibleIdsFor(container).filter(x=>x!==id);
        if (typeof index !== "number") index = siblings.length;
        index = Math.max(0, Math.min(index, siblings.length));
        siblings.splice(index, 0, id);

        state.container = container;
        state.visible = true;
        // a panel becoming floating is always expanded — collapse is a docked space-saver,
        // so a panel collapsed while docked opens up when detached to a floating window.
        if (container === "floating") state.collapsed = false;
        siblings.forEach((sid,i)=>{ layout[sid].order = i; });

        me.apply();
        let view = getView(id);
        if (view) view.renderContent();
        me.persist();
    };

    // ── Layout extents consumed by editor.js ──────────────────────────────────────
    me.getDockWidth = (side)=> (side === "right") ? extents.right : extents.left;
    me.getDockHeight = ()=> extents.bottom;
    me.getContainer = (name)=> containers[name];

    // ── apply(): mount + position every visible panel; toggle container .active ───
    me.apply = function(){
        if (!initialized) return;

        ["left","right","bottom","floating"].forEach(side=>{
            let container = containers[side];
            if (!container) return;
            let hidden = !!containerHidden[side];
            let ids = hidden ? [] : me.getVisibleIdsFor(side);
            let sideViews = ids.map(getView).filter(Boolean);

            sideViews.forEach(view=>{
                container.mount(view);
                // Lazy panels (heavy/image-dependent editors) render on show(), not here —
                // rendering them during a layout pass can run before the image exists
                // (e.g. boot-time restore of a persisted-visible editor). Only render
                // non-lazy panels, or lazy ones already rendered once.
                let def = registry.get(view.id);
                if (!def || !def.lazy || view.isContentRendered()) view.renderContent();
                view.setCollapsedClass(layout[view.id].collapsed);
            });
            container.layout(sideViews);

            if (container.kind === "dock"){
                let empty = sideViews.length === 0;
                container.el.classList.toggle("active", !empty);
                // a non-empty dock's extent is just its size (we already know `empty`)
                extents[side] = empty ? 0 : container.getSize();
            }
        });

        // When the bottom dock is active it occupies a runtime-resizable band above the
        // 20px status bar. The left/right containers are pinned to `bottom:20px` in CSS, so
        // they would overlap it — lift their bottom edge to sit just above the bottom dock.
        // (extents.bottom is 0 when the bottom container is hidden/empty → fall back to CSS.)
        let sideBottom = extents.bottom > 0 ? (extents.bottom + 22) + "px" : "";
        ["left","right"].forEach(side=>{
            let c = containers[side];
            if (c && c.el) c.el.style.bottom = sideBottom;
        });

        // detach any view whose current container differs from where it's mounted, or
        // which is hidden/unavailable
        me.getIds().forEach(id=>{
            let view = views[id];
            if (!view) return;
            let state = layout[id];
            let shouldShow = state.visible && isAvailable(id);
            let target = containers[state.container];
            if (!shouldShow || !target){
                detachView(view);
            }else if (view.el.parentNode && view.el.parentNode !== target.innerContainer && target.kind === "dock"){
                // mounted in the wrong dock container
                target.mount(view);
            }
        });

        refreshPanelMenu();
        EventBus.trigger(EVENT.panelUIChanged);
    };

    // Rebuild the View ▸ Panels menu entries from the registry (R8). apply() runs at
    // pointermove frequency during drag/resize, but the menu only depends on per-panel
    // availability + visibility — skip the DOM rebuild when that signature is unchanged.
    let lastMenuSig;
    function refreshPanelMenu(){
        if (!Menu.setPanelMenu) return;
        let availableIds = me.getIds().filter(id => isAvailable(id));
        let sig = availableIds.map(id => id + (me.isVisible(id) && !containerHidden[layout[id].container] ? "1" : "0")).join(",");
        if (sig === lastMenuSig) return;
        lastMenuSig = sig;
        let entries = availableIds
            .map(id=>{
                let def = registry.get(id);
                return {
                    label: def.label || id,
                    visible: me.isVisible(id) && !containerHidden[layout[id].container],
                    action: ()=>{
                        // toggle: hide if currently shown, else reveal (restores its container)
                        if (me.isVisible(id) && !containerHidden[layout[id].container]) me.hide(id);
                        else me.reveal(id);
                    }
                };
            });
        Menu.setPanelMenu(entries);
    }

    function detachView(view){
        if (view.el.parentNode) view.el.parentNode.removeChild(view.el);
    }

    // ── Drag: dock / reorder / float, with threshold gate + snap indicator (R2/R4) ─
    let dragState;
    let snapIndicator;
    let insertLine;

    function getSnapIndicator(){
        if (!snapIndicator){
            snapIndicator = $div("snap-indicator");
            if (parentEl) parentEl.appendChild(snapIndicator);
        }
        return snapIndicator;
    }

    function getInsertLine(){
        if (!insertLine){
            insertLine = $div("snap-insert-line");
            if (parentEl) parentEl.appendChild(insertLine);
        }
        return insertLine;
    }

    function hideSnapIndicator(){
        if (snapIndicator) snapIndicator.classList.remove("active");
        if (insertLine) insertLine.classList.remove("active");
    }

    // The panels a drop would be inserted among: everything visible in `side` except the
    // dragged panel itself, which is leaving its current slot.
    function insertionSiblings(side){
        return me.getVisibleViewsFor(side).filter(v=> !dragState || v.id !== dragState.panelId);
    }

    // Compute an insertion index within a dock container from the pointer position,
    // using the same cumulative-offset gap idea as the layer-panel reorder.
    function insertionIndexFor(side, clientX, clientY){
        let viewsInSide = insertionSiblings(side);
        let horizontal = side === "bottom";
        let idx = viewsInSide.length;
        for (let i=0;i<viewsInSide.length;i++){
            let rect = viewsInSide[i].el.getBoundingClientRect();
            let mid = horizontal ? rect.left + rect.width/2 : rect.top + rect.height/2;
            let pos = horizontal ? clientX : clientY;
            if (pos < mid){ idx = i; break; }
        }
        return idx;
    }

    me.beginDrag = function(id, clientX, clientY){
        let state = layout[id];
        if (!state) return;
        let floating = state.container === "floating";
        let grabDX = 0, grabDY = 0;
        if (floating){
            let view = views[id];
            let rect = view ? view.el.getBoundingClientRect() : null;
            if (rect){ grabDX = clientX - rect.left; grabDY = clientY - rect.top; }
        }
        dragState = {
            panelId: id,
            startX: clientX,
            startY: clientY,
            floating: floating,   // an already-floating panel moves as a real window
            grabDX: grabDX,       // pointer offset within the panel (keeps grab point fixed)
            grabDY: grabDY,
            active: false,
            target: null
        };
    };

    me.updateDrag = function(clientX, clientY){
        if (!dragState) return;
        if (!dragState.active){
            let dx = clientX - dragState.startX;
            let dy = clientY - dragState.startY;
            if (Math.sqrt(dx*dx + dy*dy) < DRAG_THRESHOLD) return; // gate: not a drag yet
            dragState.active = true;
            let view = views[dragState.panelId];
            if (dragState.floating){
                // true window drag: move the real element, raise it, no ghost proxy
                if (view){
                    view.el.classList.add("dragging");
                    view.el.style.zIndex = 1000;
                }
            }else{
                // docked panel: drag a lightweight proxy and dim the source in place
                let def = registry.get(dragState.panelId);
                Input.setDragElement($div("dragelement box", def ? def.label : dragState.panelId));
                if (view) view.el.classList.add("ghost");
            }
        }

        // a floating panel follows the cursor live (keeping the original grab point)
        if (dragState.floating){
            let view = views[dragState.panelId];
            if (view){
                let x = clientX - dragState.grabDX;
                let y = clientY - dragState.grabDY;
                view.el.style.left = x + "px";
                view.el.style.top = y + "px";
                let st = layout[dragState.panelId];
                st.x = x; st.y = y;
            }
        }

        // which dock container's snap zone are we in?
        let target = null;
        ["left","right","bottom"].forEach(side=>{
            if (target) return;
            let container = containers[side];
            if (container && container.snapZoneTest){
                let zone = container.snapZoneTest(clientX, clientY);
                if (zone){
                    let index = insertionIndexFor(side, clientX, clientY);
                    target = {container: side, index};
                }
            }
        });
        dragState.target = target;

        // position the snap indicator (or hide → will float)
        if (target){
            showSnapIndicatorFor(target.container);
            showInsertLineFor(target.container, target.index);
        }else{
            hideSnapIndicator();
        }
    };

    function showSnapIndicatorFor(side){
        let ind = getSnapIndicator();
        let container = containers[side];
        let cRect = container.el.getBoundingClientRect();

        // base rectangle = the container's edge band
        ind.style.left = cRect.left + "px";
        ind.style.top = cRect.top + "px";
        ind.style.width = (cRect.width || SNAP_THRESHOLD) + "px";
        ind.style.height = (cRect.height || SNAP_THRESHOLD) + "px";
        // if the container is currently empty/zero-sized, draw a band on that edge
        if (!cRect.width || !cRect.height){
            let vw = window.innerWidth, vh = window.innerHeight;
            if (side === "left"){ ind.style.left="0px"; ind.style.top="27px"; ind.style.width=SNAP_THRESHOLD+"px"; ind.style.height=(vh-47)+"px"; }
            if (side === "right"){ ind.style.left=(vw-SNAP_THRESHOLD)+"px"; ind.style.top="27px"; ind.style.width=SNAP_THRESHOLD+"px"; ind.style.height=(vh-47)+"px"; }
            if (side === "bottom"){ ind.style.left="0px"; ind.style.top=(vh-SNAP_THRESHOLD-20)+"px"; ind.style.width=vw+"px"; ind.style.height=SNAP_THRESHOLD+"px"; }
        }
        ind.classList.add("active");
    }

    // Insertion line: while the container highlight says WHERE the panel docks, this marks
    // the exact slot it takes within that container — the reorder preview. It is drawn at
    // the leading edge of the panel that would follow the drop, or at the trailing edge of
    // the last panel when dropping at the end. Line orientation follows the container's
    // stacking axis: horizontal for the vertically-stacked left/right docks, vertical for
    // the horizontally-stacked bottom dock.
    const INSERT_LINE_THICKNESS = 3;
    function showInsertLineFor(side, index){
        let container = containers[side];
        let cRect = container.el.getBoundingClientRect();
        // an empty/hidden container has no slots to choose between — the highlight is enough
        if (!cRect.width || !cRect.height) return;

        let siblings = insertionSiblings(side);
        let horizontal = side === "bottom";
        let pos;
        if (!siblings.length){
            pos = horizontal ? cRect.left : cRect.top;
        }else if (index < siblings.length){
            let r = siblings[index].el.getBoundingClientRect();
            pos = horizontal ? r.left : r.top;
        }else{
            let r = siblings[siblings.length-1].el.getBoundingClientRect();
            pos = horizontal ? r.right : r.bottom;
        }

        let line = getInsertLine();
        if (horizontal){
            let x = clamp(pos - INSERT_LINE_THICKNESS/2, cRect.left, cRect.right - INSERT_LINE_THICKNESS);
            line.style.left = Math.round(x) + "px";
            line.style.top = Math.round(cRect.top) + "px";
            line.style.width = INSERT_LINE_THICKNESS + "px";
            line.style.height = Math.round(cRect.height) + "px";
        }else{
            let y = clamp(pos - INSERT_LINE_THICKNESS/2, cRect.top, cRect.bottom - INSERT_LINE_THICKNESS);
            line.style.left = Math.round(cRect.left) + "px";
            line.style.top = Math.round(y) + "px";
            line.style.width = Math.round(cRect.width) + "px";
            line.style.height = INSERT_LINE_THICKNESS + "px";
        }
        line.classList.add("active");
    }

    function clamp(v, min, max){
        return Math.max(min, Math.min(v, max));
    }

    me.endDrag = function(clientX, clientY){
        if (!dragState) return;
        let state = dragState;
        dragState = undefined;
        hideSnapIndicator();

        let view = views[state.panelId];
        if (view){
            view.el.classList.remove("ghost");
            view.el.classList.remove("dragging");
            view.el.style.zIndex = "";
        }

        // released without crossing the threshold → not a drag (caption handles collapse)
        if (!state.active) return;

        if (!state.floating) Input.removeDragElement();

        if (state.target){
            me.move(state.panelId, state.target.container, state.target.index);
        }else if (state.floating){
            // already floating and dropped away from edges: it has been moved live in place;
            // just commit the final position + persist.
            me.persist();
        }else{
            // docked panel dropped away from any edge → float at the drop point
            me.float(state.panelId, clientX, clientY);
        }
    };

    me.isDragging = ()=> !!(dragState && dragState.active);

    // Caption context menu (R3): move the panel to another container or float it.
    me.showPanelMenu = function(id){
        let state = layout[id];
        if (!state) return;
        let items = [];
        let dests = [
            {side:"left", label:"Dock left"},
            {side:"right", label:"Dock right"},
            {side:"bottom", label:"Dock bottom"},
            {side:"floating", label:"Float"}
        ];
        dests.forEach(d=>{
            if (d.side === state.container) return; // skip current location
            items.push({label: d.label, action: ()=>{
                if (d.side !== "floating" && containerHidden[d.side]) me.showContainer(d.side);
                me.move(id, d.side);
            }});
        });
        items.push({label:"Close panel", action: ()=> me.hide(id)});
        ContextMenu.show(items);
    };

    me.float = function(id, x, y){
        let state = layout[id];
        if (!state) return;
        if (typeof x === "number") state.x = x;
        if (typeof y === "number") state.y = y;
        me.move(id, "floating", 0);
    };

    // ── Floating-panel corner resize ───────────────────────────────────────────────
    me.beginFloatResize = function(id){
        let view = views[id];
        if (!view) return null;
        let rect = view.el.getBoundingClientRect();
        return {w: rect.width, h: rect.height};
    };

    me.updateFloatResize = function(id, start, dx, dy){
        let view = views[id];
        let state = layout[id];
        if (!view || !state) return;
        let w = Math.max(140, start.w + dx);
        let h = Math.max(80, start.h + dy);
        state.fw = w;
        state.fh = h;
        view.el.style.width = w + "px";
        view.el.style.height = h + "px";
        me.persist();
    };

    // ── Per-panel docked resize (the panel's own edge .sizer) ──────────────────────
    // Resizes a single docked panel along the container's stacking axis: height in
    // left/right (vertical stacking), width in bottom (horizontal stacking). Stored in
    // layout `size`, which DockContainer.layout() already reads.
    me.beginPanelResize = function(id){
        let state = layout[id];
        if (!state) return null;
        let view = views[id];
        let def = registry.get(id);
        let container = state.container;
        // current effective size (persisted size, or the def default)
        let base = state.size;
        if (typeof base !== "number"){
            if (container === "bottom") base = (def && def.width) || 240;
            else base = (def && def.height) || 100;
        }
        return {size: base, container, minH: (def && def.minHeight) || 34};
    };

    me.updatePanelResize = function(id, start, dx, dy){
        let state = layout[id];
        if (!state || !start) return;
        // bottom container stacks horizontally → resize width with dx; else height with dy
        let delta = start.container === "bottom" ? dx : dy;
        let min = start.container === "bottom" ? 60 : start.minH;
        state.size = Math.max(min, start.size + delta);
        me.apply();
    };

    // ── Persistence ────────────────────────────────────────────────────────────────
    let persistTimer;
    me.persist = function(){
        // debounced; skipped mid-drag to avoid localStorage churn
        if (me.isDragging()) return;
        if (persistTimer) return;
        persistTimer = setTimeout(()=>{
            persistTimer = undefined;
            me.saveLayout();
        }, 150);
    };

    me.saveLayout = function(){
        let blob = {
            version: LAYOUT_VERSION,
            containersHidden: Object.assign({}, containerHidden),
            panels: {},
            containers: {}
        };
        me.getIds().forEach(id=>{
            let s = layout[id];
            blob.panels[id] = {
                container: s.container, order: s.order, collapsed: s.collapsed,
                visible: s.visible, x: s.x, y: s.y, size: s.size, fw: s.fw, fh: s.fh
            };
        });
        ["left","right","bottom"].forEach(side=>{
            if (containers[side]) blob.containers[side] = {size: containers[side].getSize()};
        });
        try {
            UserSettings.set(LAYOUT_KEY, blob);
        } catch(e){
            console.error("PanelManager.saveLayout failed", e);
        }
    };

    me.restoreLayout = function(){
        let blob;
        try {
            blob = UserSettings.get(LAYOUT_KEY);
        } catch(e){
            console.error("PanelManager.restoreLayout: read failed", e);
            return false;
        }
        if (!blob || blob.version !== LAYOUT_VERSION) return false;

        if (blob.containersHidden){
            ["left","right","bottom","floating"].forEach(side=>{
                if (typeof blob.containersHidden[side] === "boolean") containerHidden[side] = blob.containersHidden[side];
            });
        }
        if (blob.containers){
            ["left","right","bottom"].forEach(side=>{
                if (containers[side] && blob.containers[side] && typeof blob.containers[side].size === "number"){
                    containers[side].setSize(blob.containers[side].size);
                }
            });
        }
        if (blob.panels){
            Object.keys(blob.panels).forEach(id=>{
                if (!registry.has(id)) return; // unknown id → ignore
                let saved = blob.panels[id];
                let cur = layout[id] || {};
                layout[id] = {
                    container: saved.container || cur.container || "left",
                    order: typeof saved.order === "number" ? saved.order : (cur.order || 0),
                    collapsed: typeof saved.collapsed === "boolean" ? saved.collapsed : !!cur.collapsed,
                    visible: typeof saved.visible === "boolean" ? saved.visible : !!cur.visible,
                    x: saved.x, y: saved.y, size: saved.size, fw: saved.fw, fh: saved.fh
                };
            });
        }
        return true;
    };

    // ── init ──────────────────────────────────────────────────────────────────────
    me.init = function(parent){
        parentEl = parent;
        initialized = true;
        me.createContainers();
        NativePanels.register(me);
        // Honour the legacy whole-container visibility settings on boot (full layout
        // restore lands in Phase 6). Side panel defaults to hidden unless the user had
        // it open; bottom mirrors its legacy setting.
        // Seed whole-container visibility from the legacy settings, then let a saved
        // free-panel layout (if any) take precedence.
        containerHidden.left = !UserSettings.get("sidepanel");
        containerHidden.bottom = !UserSettings.get("bottompanel");
        me.restoreLayout();

        // Legacy command aliases (previously owned by sidepanel/bottompanel/contentpanel).
        EventBus.on(COMMAND.TOGGLESIDEPANEL, ()=> me.toggleContainer("left"));
        EventBus.on(COMMAND.TOGGLEBOTTOMPANEL, ()=> me.toggleContainer("bottom"));
        EventBus.on(COMMAND.PREFERENCES, ()=>{
            // toggle the Preferences panel (reveal() ensures its container is shown)
            if (me.isVisible("preferences")) me.hide("preferences");
            else me.reveal("preferences");
        });

        me.apply();

        // A restored layout may mark a lazy editor panel (palette/effects/…) visible.
        // apply() above mounts it but defers its content render (the image doesn't exist
        // yet at UI.init time — COMMAND.NEW runs after and fires imageSizeChanged). Render
        // those once the first image is ready, mirroring what show() does.
        let renderedRestored = false;
        let renderRestoredLazy = ()=>{
            if (renderedRestored) return;
            if (!ImageFile.getActiveLayer || !ImageFile.getActiveLayer()) return; // wait for image
            renderedRestored = true;
            me.getIds().forEach(id=>{
                let def = registry.get(id);
                let view = views[id];
                if (def && def.lazy && view && me.isVisible(id) && !view.isContentRendered()
                    && !containerHidden[layout[id].container] && isAvailable(id)){
                    if (def.rerenderOnShow) view.rerenderContent(); else view.renderContent();
                }
            });
            me.apply();
        };
        EventBus.on(EVENT.imageSizeChanged, renderRestoredLazy);
        EventBus.on(EVENT.imageContentChanged, renderRestoredLazy);
    };

    // create the four containers and attach to the app container. Separated from init()
    // so the native-panel migration (Phase 3) controls exactly when the new containers
    // replace the legacy ones.
    me.createContainers = function(){
        if (containers.left) return;
        containers.left = DockContainer("left", me);
        containers.right = DockContainer("right", me);
        containers.bottom = DockContainer("bottom", me);
        containers.floating = FloatLayer(me);
        ["left","right","bottom","floating"].forEach(side=>{
            if (parentEl) parentEl.appendChild(containers[side].el);
        });
        me.apply();
    };

    return me;
})();

export default PanelManager;
