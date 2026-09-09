import ImageFile from "../../image.js";
import $,{$div, $elm, $input} from "../../util/dom.js";
import EventBus from "../../util/eventbus.js";
import {COMMAND, EVENT} from "../../enum.js";
import input from "../input.js";
import Input from "../input.js";
import ContextMenu from "../components/contextMenu.js";
import Historyservice from "../../services/historyservice.js";
import HistoryService from "../../services/historyservice.js";
import Editor from "../editor.js";
import {isGroup, isBones, isVector, resolveDropPath} from "../../util/layerUtils.js";
import Palette from "../palette.js";
import Modal, {DIALOG} from "../modal.js";

let LayerPanel = function(){
    let me = {};
    let contentPanel;
    let opacityRange;
    let blendSelect;
    let toolsRow;
    let dissolveRow;
    let dissolveSelect;
    let dissolveApply;
    let editPath;
    let currentDisplayList = [];
    let dragState;
    let lastRowClick;
    const DOUBLECLICK_TIME = 400;

    // Shift-click multi-selection (range, within one parent group only). `selectedPaths` holds
    // every path in the live range (active layer included) once a range spans 2+ rows, else it's
    // empty. `rangeAnchorPath` is the last PLAIN-clicked row, which shift-click extends the range
    // from (standard Explorer/Photoshop behaviour — the anchor never moves on a shift-click,
    // only on a plain click).
    let selectedPaths = [];
    let rangeAnchorPath;

    const ROW_HEIGHT = 23;
    const MARKER_HEIGHT = 13;   // end-group marker slot — shorter than a layer row
    const INDENT_PX = 14;

    // Builds a CSS `background` shorthand drawing `count` full-height 1px vertical guide
    // lines at x = k*INDENT_PX - 3 (k = 1..count) — the same x positions the nested rows
    // and end-group bracket sit on, so the rails connect continuously down the list.
    // Returns "none" when there is nothing to draw.
    function railLayers(count){
        if (count < 1) return "none";
        let layers = [];
        for (let k = 1; k <= count; k++){
            layers.push("linear-gradient(#7d7d7d,#7d7d7d) " + (k * INDENT_PX - 3) + "px 0 / 1px 100% no-repeat");
        }
        return layers.join(",");
    }

    // Height of the display-list entry at `index` (markers are shorter than layer rows).
    function rowHeight(index){
        let entry = currentDisplayList[index];
        return (entry && entry.endGroup) ? MARKER_HEIGHT : ROW_HEIGHT;
    }

    // Cumulative pixel offset (top) of the display-list entry at `index`. Rows are
    // variable-height (markers are shorter), so positions are summed rather than
    // computed as index × ROW_HEIGHT. Both static layout and the drag preview use this.
    function rowTop(index){
        let top = 0;
        for (let i = 0; i < index; i++) top += rowHeight(i);
        return top;
    }

    // Total height of all rows from `index` onward (used to size the trailing gap).
    function totalHeight(){
        return rowTop(currentDisplayList.length);
    }

    let blendModes=[
        "normal",
        "lighter",
        "multiply",
        "screen",
        "overlay",
        "darken",
        "lighten",
        "color-dodge",
        "color-burn",
        "hard-light",
        "soft-light",
        "hue",
        "saturation",
        "color",
        "luminosity",

        /*"source-in",
    "source-out",
    "source-atop",
    "destination-over",
    "destination-in",
    "destination-out",
    "destination-atop",
    "lighter",
    "copy",
    "xor",
    "difference",
    "exclusion"*/

    ]

    me.generate = (parent)=>{
        toolsRow = $(".paneltools.multirow",{parent:parent},
            $(".rangeselect",
                {info: "Set transparency of active layer"},
                $(".label","Opacity"),
                opacityRange = $("input",{type:"range",max:100,min:0,value:100,oninput:()=>{
                    ImageFile.setLayerOpacity(opacityRange.value);
                }})
            ),
            $(".blendselect",
                $(".label","Blend"),
                blendSelect = $("select",{oninput:()=>{
                    ImageFile.setLayerBlendMode(blendSelect.value);
                }})
            ),
            // With a locked palette, blend modes are ignored (they produce colours outside the
            // palette) and opacity is rendered as a dither stencil instead of an alpha blend.
            // So this row takes the blend row's place and picks the stencil pattern, plus an
            // Apply that bakes the pattern into the pixels (see ImageFile.applyDissolve).
            dissolveRow = $(".dissolveselect",
                $(".label","Dissolve"),
                dissolveSelect = $("select",{oninput:()=>{
                    ImageFile.setLayerDissolve(dissolveSelect.value);
                }}),
                dissolveApply = $(".apply",{
                    onClick:()=>applyDissolve(),
                    info:"Bake the dissolve pattern into the pixels so it survives unlocking the palette"
                },"Apply")
            ),
            $(".button.delete",{
                onclick:()=>{EventBus.trigger(COMMAND.DELETELAYER);},
                info:"Delete active layer"
            }),
            $(".button.add",{
                onclick:()=>{EventBus.trigger(COMMAND.NEWLAYER);},
                info:"Add new layer"
            })
        );

        contentPanel = $(".panelcontent",{parent:parent});
        blendModes.forEach(mode=>{
            $elm("option",mode,blendSelect);
        });
        ImageFile.getDissolvePatterns().forEach(pattern=>{
            let option = $elm("option",pattern.label,dissolveSelect);
            option.value = pattern.id;
        });
        updateLockedState();
    }

    // Builds a flat, top-down display list of the layer tree, honouring collapse state.
    // Each entry is either a real row { node, path, depth, ancestorHidden } or an
    // end-group marker { endGroup:true, groupPath, depth, ancestorHidden }. Order is
    // depth-first with each group's children rendered directly under (visually below) the
    // group header row, followed by an end-group marker at the children's indent depth.
    // `ancestorHidden` is true when an enclosing group is hidden — used to dim rows
    // visually without touching their own visible flag.
    function buildDisplayList(nodes, path, depth, out, ancestorHidden){
        for (let i = nodes.length - 1; i >= 0; i--){
            let node = nodes[i];
            let nodePath = path.concat(i);
            out.push({node, path: nodePath, depth, ancestorHidden: !!ancestorHidden});
            if (isGroup(node) && !node.collapsed){
                let childHidden = ancestorHidden || !node.visible;
                buildDisplayList(node.layers, nodePath, depth + 1, out, childHidden);
                out.push({endGroup: true, groupPath: nodePath, depth: depth + 1, ancestorHidden: !!childHidden});
            }
        }
        return out;
    }

    function pathKey(path){
        return path.join(",");
    }

    function parentKey(path){
        return path.slice(0,-1).join(",");
    }

    // All sibling paths (same immediate parent as `anchorPath`) visually between `anchorPath`
    // and `targetPath`, inclusive — the shift-click range. Returns null when the two rows don't
    // share a parent (nothing sane to select, so the caller falls back to a plain click).
    function computeRange(anchorPath, targetPath){
        if (parentKey(anchorPath) !== parentKey(targetPath)) return null;
        let anchorRow = currentDisplayList.findIndex(e => !e.endGroup && pathKey(e.path) === pathKey(anchorPath));
        let targetRow = currentDisplayList.findIndex(e => !e.endGroup && pathKey(e.path) === pathKey(targetPath));
        if (anchorRow < 0 || targetRow < 0) return null;
        let lo = Math.min(anchorRow, targetRow);
        let hi = Math.max(anchorRow, targetRow);
        let scope = parentKey(anchorPath);
        let range = [];
        for (let i = lo; i <= hi; i++){
            let entry = currentDisplayList[i];
            if (entry.endGroup) continue;
            if (parentKey(entry.path) === scope) range.push(entry.path);
        }
        return range;
    }

    // DOM-id-safe encoding of a path (no commas, which complicate querySelector).
    function pathId(path){
        return "layer-" + path.join("-");
    }

    // DOM id for an end-group marker row, keyed by the group's path.
    function markerId(groupPath){
        return "endgroup-" + groupPath.join("-");
    }

    me.list = ()=>{
        contentPanel.innerHTML = "";
        let activePath = ImageFile.getActiveLayerPath() || [0];
        let activeKey = pathKey(activePath);
        let imageFile = ImageFile.getCurrentFile();
        // The layer tree shown is the ACTIVE TRACK's governing cel at the playhead (spec 004).
        let frame = ImageFile.getActiveFrame();
        if (!frame || !frame.layers) return;

        let displayList = buildDisplayList(frame.layers, [], 0, []);
        currentDisplayList = displayList;
        let rowCount = displayList.length;

        // Drop any selected/anchor path that no longer resolves in the current tree (layer
        // deleted, grouped away, undo, frame switch, …) rather than trust stale indices.
        let liveKeys = new Set(displayList.filter(e => !e.endGroup).map(e => pathKey(e.path)));
        selectedPaths = selectedPaths.filter(p => liveKeys.has(pathKey(p)));
        if (selectedPaths.length < 2) selectedPaths = [];
        if (rangeAnchorPath && !liveKeys.has(pathKey(rangeAnchorPath))) rangeAnchorPath = undefined;

        // Only visualise per-layer types when the frame actually mixes in a special layer: if there
        // is at least one bone or vector layer present, every non-group row gets a small type icon
        // (solid square = pixel, circle outline = vector, diagonal bone = bone) so they read apart.
        // An all-pixel frame stays icon-free (the type classes are simply not added).
        let showLayerTypes = displayList.some(e => e.node && (isBones(e.node) || isVector(e.node)));

        displayList.forEach((entry, rowIndex)=>{
            // End-group marker: a non-draggable placeholder closing an expanded group.
            // It acts as a drop target boundary (above = inside group, below = outside).
            if (entry.endGroup){
                let marker = $div("endgroup" + (entry.ancestorHidden ? " hidden" : ""), null, contentPanel);
                marker.style.top = rowTop(rowIndex) + "px";
                marker.style.setProperty("--endgroup-indent", (entry.depth * INDENT_PX) + "px");
                marker.id = markerId(entry.groupPath);
                marker.setAttribute("data-endgroup", pathKey(entry.groupPath));
                // Ancestor rails pass straight through the marker (full height); the marker's
                // own level is closed off by the .endgroupline bracket instead.
                marker.style.background = railLayers(entry.depth - 1);
                $(".endgroupline",{parent: marker});
                return;
            }

            let node = entry.node;
            let path = entry.path;
            let group = isGroup(node);
            let bone = isBones(node);
            let vector = isVector(node);
            let pixel = !group && !bone && !vector;
            let key = pathKey(path);
            let isActive = key === activeKey;
            let isMultiSelected = selectedPaths.some(p => pathKey(p) === key);

            let elm = $div(
                "layer info"
                + (group ? " layergroup" : "")
                + (showLayerTypes && bone ? " bonelayer" : "")
                + (showLayerTypes && vector ? " vectorlayer" : "")
                + (showLayerTypes && pixel ? " pixellayer" : "")
                + (isActive ? " active" : "")
                + (isMultiSelected ? " selected" : "")
                + ((node.visible && !entry.ancestorHidden) ? "" : " hidden"),
                null,
                contentPanel,
                (e)=>{
                    if (elm.classList.contains('hasinput')){
                        let input = elm.querySelector("input");
                        if (input) input.focus();
                        return;
                    }
                    let now = performance.now();
                    let isDoubleClick = lastRowClick && lastRowClick.key === key
                        && (now - lastRowClick.time) < DOUBLECLICK_TIME;
                    lastRowClick = isDoubleClick ? undefined : {key: key, time: now};

                    let range = (e && e.shiftKey && rangeAnchorPath) ? computeRange(rangeAnchorPath, path) : null;
                    if (range){
                        selectedPaths = range;
                        if (!isActive) ImageFile.activateLayer(path);
                        me.list();
                        return;
                    }

                    rangeAnchorPath = path;
                    selectedPaths = [];
                    if (!isActive) ImageFile.activateLayer(path);
                    if (isDoubleClick) renameLayer(path);
                }
            );
            // Top-down: first display-list entry sits at the top.
            elm.style.top = rowTop(rowIndex) + "px";
            elm.layerPath = path;
            elm.setAttribute("data-path", key);
            elm.id = pathId(path);
            elm.info = "Drag to reorder, double click to rename, right click for more options";
            if (node.name && node.name.indexOf("_")===0){
                elm.classList.add("system");
            }

            // Row contents are built left-to-right: indent, collapse toggle (groups),
            // then the name label. Trailing icons (more/eye/lock/mask) are added after.

            // Indentation for nested rows. The row box starts at its own group's left
            // border (--row-indent offset); its own rail is the box border-left, and the
            // rails of any enclosing groups are painted in the strip to its left by the
            // .nested::before pseudo-element from --ancestor-rails.
            elm.style.setProperty("--row-indent", (entry.depth * INDENT_PX) + "px");
            if (entry.depth > 0){
                elm.classList.add("nested");
                elm.style.setProperty("--ancestor-rails", railLayers(entry.depth - 1));
            }

            // Collapse toggle for group rows — before the name.
            if (group){
                $(".layercollapse" + (node.collapsed ? ".collapsed" : ""),{
                    parent:elm,
                    onClick:()=>{
                        node.collapsed = !node.collapsed;
                        me.list();
                    },
                    info: node.collapsed ? "Expand group" : "Collapse group"
                });
            }

            // Name label.
            $(".layername",{parent:elm}, node.name);

            elm.onDragStart = (e)=>{
                if (elm.classList.contains('hasinput')) return;
                beginDrag(rowIndex);
                let dupe = $div("dragelement box",node.name);
                Input.setDragElement(dupe);
            }

            elm.onDrag = (x,y,touchData,e)=>{
                if (elm.classList.contains('hasinput')) return;
                if (!dragState) return;
                updateDrag(x, y, e);
            }

            elm.onDragEnd = (e)=>{
                Input.removeDragElement();
                endDrag();
            }

            let showContextMenu = ()=>{
                let items = [];
                if (rowCount>1) items.push ({label: "Remove Layer", command: COMMAND.DELETELAYER});
                items.push ({label: "Duplicate Layer", command: COMMAND.DUPLICATELAYER});
                items.push ({label: "Rename Layer", action: ()=>{
                    renameLayer(path);
                    }});

                items.push ({label: "Group Layers", action: ()=>EventBus.trigger(COMMAND.GROUPLAYERS, me.getSelectedPaths())});

                if (isVector(node)){
                    items.push ({label: "Rasterize Layer", action: ()=>{
                        EventBus.trigger(COMMAND.RASTERIZELAYER, path);
                    }});
                }

                items.push ({label: node.locked ? "Unlock Layer" : "Lock Layer", action: ()=>{
                    Historyservice.start(EVENT.imageHistory);
                    ImageFile.toggleLayerLock(path);
                    Historyservice.end();
                }});

                if (group){
                    items.push ({label: "Ungroup", command: COMMAND.UNGROUP});
                    items.push ({label: "Merge Group", command: COMMAND.MERGEGROUP});
                    items.push ({label: "Duplicate Group", command: COMMAND.DUPLICATELAYER});
                }

                if (!group){
                    if (node.hasMask){
                        items.push({label: "Remove Layer Mask", command: COMMAND.DELETELAYERMASK});
                        if (node.isMaskEnabled()){
                            items.push({label: "Disable Layer Mask", command: COMMAND.DISABLELAYERMASK});
                        }else{
                            items.push({label: "Enable Layer Mask", command: COMMAND.ENABLELAYERMASK});
                        }
                        items.push({label: "Apply Layer Mask", command: COMMAND.APPLYLAYERMASK});
                    }else{
                        items.push({label: "Add Layer Mask: Show", command: COMMAND.LAYERMASK});
                        items.push({label: "Add Layer Mask: Hide", command: COMMAND.LAYERMASKHIDE});
                    }
                }

                // Merge Down only within the same parent scope (path index > 0).
                if (path[path.length-1] > 0){
                    items.push ({label: "Merge Down", command: COMMAND.MERGEDOWN});
                }

                ContextMenu.show(items);
            };

            elm.onContextMenu = showContextMenu;

            if (key === pathKey(editPath || [])){
                let input = $input("text",node.name);
                elm.appendChild(input);
            }

            $(".more",{
                parent:elm,
                onClick:showContextMenu,
                info:"More options"
            });

            $(".eye",{
                parent:elm,
                onClick:()=>{
                    Historyservice.start(EVENT.layerPropertyHistory,path);
                    ImageFile.toggleLayer(path);
                    Historyservice.end();
                },
                info:"Toggle layer visibility"
            })

            if (!group && node.hasMask){
                $(".mask" + (node.isMaskActive()?".active":"") + (node.isMaskEnabled()?"":".disabled"),{
                    parent:elm,
                    onClick:()=>{
                        if (!node.isMaskEnabled()) return;
                        Editor.commit().then(()=>{
                            Historyservice.start(EVENT.layerPropertyHistory,path);
                            node.toggleMask();
                            Historyservice.end();
                            EventBus.trigger(EVENT.toolChanged);
                            EventBus.trigger(EVENT.layersChanged);
                        });
                    },
                    info : "Toggle layer mask"
                })
            }

            if (node.locked){
                elm.classList.add("locked");
                $(".lock",{
                    parent:elm,
                    onClick:()=>{
                        Historyservice.start(EVENT.imageHistory);
                        ImageFile.toggleLayerLock(path);
                        Historyservice.end();
                    },
                    info:"Layer is locked — click to unlock"
                })
            }

            if (isActive){
                blendSelect.value = node.blendMode;
                // Show the RESOLVED opacity at the playhead (x/y and the group transform live
                // in the Properties panel now). Never write back into a control the user is
                // currently operating: writing to a key from a derived frame resolves to a
                // different value at the playhead (decision 2 — the edit lands on the owning
                // key), which would otherwise make the slider jump out from under the drag.
                let keyProps = ImageFile.getLayerKeyProps(path);
                if (keyProps){
                    if (document.activeElement !== opacityRange) opacityRange.value = Math.round(keyProps.opacity);
                }else if (document.activeElement !== opacityRange){
                    opacityRange.value = node.opacity;
                }
            }
        });
    }


    // ── Drag-and-drop reorder / reparent ──────────────────────────────────────────
    // Preserves the original feel: a floating duplicate follows the cursor, the dragged
    // row(s) dim in place (.ghost), and every other row live-repositions to preview the
    // resulting order. A group drags as a block (header + its visible descendants). The
    // tree mutates ONCE on drop via ImageFile.moveLayer. Pointer X chooses the indent so
    // the user can pick "beside the group" vs "inside the group".

    function descendantCount(startIndex){
        // number of consecutive following rows that are descendants of row startIndex
        let baseDepth = currentDisplayList[startIndex].depth;
        let n = 0;
        for (let i = startIndex + 1; i < currentDisplayList.length; i++){
            if (currentDisplayList[i].depth > baseDepth) n++;
            else break;
        }
        return n;
    }

    function rowEl(index){
        let entry = currentDisplayList[index];
        if (!entry) return null;
        let id = entry.endGroup ? markerId(entry.groupPath) : pathId(entry.path);
        return contentPanel.querySelector("#" + id);
    }

    function beginDrag(rowIndex){
        let blockSize = 1 + descendantCount(rowIndex);
        let blockRows = [];
        for (let i = 0; i < blockSize; i++) blockRows.push(rowIndex + i);
        let dragged = currentDisplayList[rowIndex];
        // reference X of the dragged row's content, to translate pointer X → indent delta
        let baseEl = rowEl(rowIndex);
        dragState = {
            rowIndex,
            blockSize,
            blockRows,
            fromPath: dragged.path.slice(),
            fromDepth: dragged.depth,
            startLeft: baseEl ? baseEl.getBoundingClientRect().left : 0,
            target: undefined,
            moved: false
        };
    }

    function updateDrag(x, y, e){
        if (Math.abs(y) < 5 && !dragState.moved) return;
        dragState.moved = true;

        // Dim the dragged block in place.
        dragState.blockRows.forEach(i=>{
            let el = rowEl(i);
            if (el) el.classList.add("ghost");
        });

        // Rows NOT part of the dragged block, in display order, with their original positions.
        // End-group markers are carried through so resolveDropPath can use them as
        // inside/outside boundaries.
        let rest = [];
        currentDisplayList.forEach((entry, i)=>{
            if (dragState.blockRows.indexOf(i) >= 0) return;
            if (entry.endGroup){
                rest.push({ index: i, endGroup: true, groupPath: entry.groupPath, depth: entry.depth });
            } else {
                rest.push({
                    index: i,
                    path: entry.path,
                    depth: entry.depth,
                    isGroup: isGroup(entry.node),
                    collapsed: !!entry.node.collapsed
                });
            }
        });

        // Rows are variable-height (markers are shorter), so positions are computed from
        // cumulative pixel offsets rather than index × ROW_HEIGHT. Work in "rest-space"
        // (the layout with the dragged block removed): restTop[k] is the pixel offset of
        // the k-th insertion boundary among `rest`.
        let restTop = [0];
        for (let r = 0; r < rest.length; r++){
            restTop.push(restTop[r] + rowHeight(rest[r].index));
        }

        // The dragged block's top edge, in the original layout, is rowTop(rowIndex)+y.
        // (At y=0 this equals restTop[rowIndex], so gap defaults to rowIndex.) The gap is
        // the boundary whose pixel position is closest to that edge — the variable-height
        // generalisation of the old round(y / ROW_HEIGHT).
        let blockTopPx = rowTop(dragState.rowIndex) + y;
        let gap = 0;
        let bestDist = Infinity;
        for (let k = 0; k < restTop.length; k++){
            let dist = Math.abs(restTop[k] - blockTopPx);
            if (dist < bestDist){ bestDist = dist; gap = k; }
        }

        // Pointer X → desired indent depth.
        let dx = (e ? e.clientX : dragState.startLeft) - dragState.startLeft;
        let desiredDepth = dragState.fromDepth + Math.round(dx / INDENT_PX);
        if (desiredDepth < 0) desiredDepth = 0;

        let drop = resolveDropPath(rest, gap, desiredDepth);
        dragState.target = drop;
        dragState.gap = gap;

        // Total pixel height of the dragged block (sum of its rows' heights).
        let blockHeight = 0;
        for (let b = 0; b < dragState.blockRows.length; b++) blockHeight += rowHeight(dragState.blockRows[b]);

        // Reposition every row to preview the result: open a blockHeight-tall gap at the
        // gap boundary. rest rows before the gap keep their slot; rows from the gap onward
        // shift down by blockHeight to make room for the dragged block.
        for (let r = 0; r < rest.length; r++){
            let top = (r < gap) ? restTop[r] : restTop[r] + blockHeight;
            let el = rowEl(rest[r].index);
            if (el) el.style.top = top + "px";
        }
        // place the dragged block into the opened gap (stacked from restTop[gap])
        let blockOffset = 0;
        for (let b = 0; b < dragState.blockRows.length; b++){
            let el = rowEl(dragState.blockRows[b]);
            if (el){
                el.style.top = (restTop[gap] + blockOffset) + "px";
                blockOffset += rowHeight(dragState.blockRows[b]);
                // show the indent change live on the dragged head row
                if (b === 0){
                    el.style.setProperty("--row-indent", (drop.depth * INDENT_PX) + "px");
                    el.style.setProperty("--ancestor-rails", railLayers(drop.depth - 1));
                    el.classList.toggle("nested", drop.depth > 0);
                }
            }
        }
    }

    function endDrag(){
        if (!dragState){ return; }
        let state = dragState;
        dragState = undefined;
        // an actual drag is not the first half of a double click
        if (state.moved) lastRowClick = undefined;
        // clear ghosts
        state.blockRows.forEach(i=>{
            let el = rowEl(i);
            if (el) el.classList.remove("ghost");
        });
        let t = state.target;
        if (state.moved && t && !isNoopMove(state.fromPath, t)){
            // single, undoable mutation on drop (no history/mutation during the drag)
            HistoryService.start(EVENT.imageHistory);
            let changed = ImageFile.moveLayerToParent(state.fromPath, t.parentPath, t.index);
            if (changed){
                HistoryService.end();
                EventBus.trigger(EVENT.layersChanged);
            } else {
                HistoryService.neverMind();
                me.list();
            }
        } else {
            me.list();
        }
    }

    // True if dropping at target would leave the node exactly where it started.
    function isNoopMove(fromPath, target){
        // same parent and same resulting slot?
        let fromParent = fromPath.slice(0, -1);
        if (pathKey(fromParent) !== pathKey(target.parentPath)) return false;
        // within the same parent, removal then insert at the original index (or the slot
        // just after it, since removal shifts everything above down by one) is a no-op.
        let fromIndex = fromPath[fromPath.length - 1];
        return target.index === fromIndex;
    }

    function renameLayer(path){
        let elm=contentPanel.querySelector("#" + pathId(path));
        let layer = ImageFile.getLayer(path);
        if (elm && layer){
            if (elm.classList.contains('hasinput')) return;
            let input = $input("text",layer.name);
            input.onkeydown = function(e){
                e.stopPropagation();
                if (e.code === "Enter"){
                    HistoryService.start(EVENT.layerPropertyHistory,path);
                    layer.name = input.value;
                    HistoryService.end();
                    me.list();
                }
                if (e.code === "Escape"){
                    me.list();
                }
            }
            elm.appendChild(input);
            elm.classList.add('hasinput');
            elm.classList.remove('handle');
            input.focus();

            // needed for rename from context menu
            setTimeout(()=>{
                input.focus();
                input.select();
            },50);
        }

    }

    // Locked palette → show the dissolve row instead of the blend row. Only the class moves;
    // both rows stay in the DOM so nothing has to be rebuilt.
    function updateLockedState(){
        if (!toolsRow) return;
        let locked = Palette.isLockedGlobal();
        toolsRow.classList.toggle("palettelocked",locked);
        if (locked && dissolveSelect) dissolveSelect.value = ImageFile.getLayerDissolve();
        if (locked && dissolveApply){
            let plan = ImageFile.getDissolvePlan();
            dissolveApply.classList.toggle("disabled",!plan.canApply);
            dissolveApply.info = plan.canApply
                ? (plan.animated
                    ? "Bake the animated dissolve into " + plan.frameCount + " content keyframes"
                    : "Bake the dissolve pattern into the pixels")
                : (plan.comparison
                    // "If lighter" is a comparison against the layers below, so there is
                    // nothing per-layer to bake — say that rather than claiming the track is
                    // fully opaque, which it may well not be.
                    ? "An \"if lighter\" layer compares against the layers below it, so it cannot be baked into its own pixels"
                    : "Nothing to bake: every layer on this track is fully opaque");
        }
    }

    // Baking an ANIMATED dissolve has to turn the tween into one content keyframe per frame,
    // which is a big, no-longer-editable change — so confirm that one first.
    function applyDissolve(){
        let plan = ImageFile.getDissolvePlan();
        if (!plan.canApply) return;
        if (!plan.animated){
            ImageFile.applyDissolve();
            return;
        }
        Modal.show(DIALOG.OPTION,{
            title: "Apply Dissolve",
            width: 360,
            text: "Opacity is animated on track \"" + plan.trackName + "\". Baking the dissolve " +
                "turns the tween into " + plan.frameCount + " content keyframes, one per frame. " +
                "The animation keeps playing the same way, but the tween can no longer be edited.",
            buttons:[
                {label:"Bake " + plan.frameCount + " keyframes", onclick:()=>ImageFile.applyDissolve()},
                {label:"Cancel"}
            ]
        });
    }

    // Current multi-selection as an array of paths, active layer included — falls back to just
    // the active layer's own path when no shift-click range is live. Consumed by Ctrl/Cmd+G
    // (group selected layers) and by the Free Transform tool (moving every selected layer
    // together with the arrow keys).
    me.getSelectedPaths = function(){
        return selectedPaths.length ? selectedPaths.map(p => p.slice()) : [ImageFile.getActiveLayerPath().slice()];
    };

    me.hasMultiSelection = function(){
        return selectedPaths.length > 1;
    };

    EventBus.on(EVENT.layersChanged,()=>{
        updateLockedState();
        me.list();
    });
    EventBus.on(EVENT.paletteLockChanged,()=>{
        updateLockedState();
        me.list();
    });

    return me;
}();

export default LayerPanel;
