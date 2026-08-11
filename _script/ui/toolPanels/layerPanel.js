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
import {isGroup, resolveDropPath} from "../../util/layerUtils.js";

let LayerPanel = function(){
    let me = {};
    let contentPanel;
    let opacityRange;
    let blendSelect;
    let editPath;
    let currentDisplayList = [];
    let dragState;

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
        $(".paneltools.multirow",{parent:parent},
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
            $(".button.delete",{
                onclick:()=>{EventBus.trigger(COMMAND.DELETELAYER);},
                info:"Delete active layer"
            }),
            $(".button.addgroup",{
                onclick:()=>{EventBus.trigger(COMMAND.NEWGROUP);},
                info:"Add new group"
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
        let frame = imageFile.frames[ImageFile.getActiveFrameIndex()];

        let displayList = buildDisplayList(frame.layers, [], 0, []);
        currentDisplayList = displayList;
        let rowCount = displayList.length;

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
            let key = pathKey(path);
            let isActive = key === activeKey;

            let elm = $div(
                "layer info"
                + (group ? " layergroup" : "")
                + (isActive ? " active" : "")
                + ((node.visible && !entry.ancestorHidden) ? "" : " hidden"),
                null,
                contentPanel,
                ()=>{
                    if (elm.classList.contains('hasinput')){
                        let input = elm.querySelector("input");
                        if (input) input.focus();
                        return;
                    }
                    if (!isActive) ImageFile.activateLayer(path);
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

            elm.onDoubleClick = ()=>{
                renameLayer(path);
            }

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

                items.push ({label: "Group Layers", command: COMMAND.NEWGROUP});

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
                opacityRange.value = node.opacity;
                blendSelect.value = node.blendMode;
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

    EventBus.on(EVENT.layersChanged,me.list);

    return me;
}();

export default LayerPanel;
