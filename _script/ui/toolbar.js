import $,{$div, $link} from "../util/dom.js";
import {COMMAND, EVENT} from "../enum.js";
import EventBus from "../util/eventbus.js";
import Palette from "./palette.js";
import Brush from "./brush.js";
import Editor from "./editor.js";
import ToolOptions from "./components/toolOptions.js";
import PanelManager from "./panelManager.js";
import ImageFile from "../image.js";
import {isBones, isVector} from "../util/layerUtils.js";

let Toolbar = function(){
    let me = {}
    let container;
    let undo,redo;
    let isMac = navigator.platform.toUpperCase().indexOf('MAC')>=0;
    let meta = isMac?"Cmd":"Ctrl";
    let toggleButton;

    let items=[
        {name: "pencil",command: COMMAND.DRAW, isTool: true, group: "pixel", info: "<b>B</b> Left click: draw with foreground color, Right click: draw with background color."},
        {name: "select",command: COMMAND.SELECT, isTool: true, group: "pixel", handleDeActivate: true, info: "<b>S</b> Make rectangular selection."},
        //{name: "layerselect",command: COMMAND.SELECTLAYER, isTool: true, info: "Select the top-most visible layer under the cursor and start free transform."},
        {name: "polygonselect",command: COMMAND.POLYGONSELECT, isTool: true, group: "pixel", handleDeActivate: true, info: "<b>P</b> Make polygon selection."},
        {name: "floodselect", isTool: true, group: "pixel", command: COMMAND.FLOODSELECT, info: "<b>W</b> Make selection of an area of the same color."},
        {name: "circle",label: "", isTool: true, group: "pixel", canFill: true, command: COMMAND.CIRCLE, info: "<b>C</b> Draw ellipsis. Shift to lock to circle, select again to toggle fill."},
        {name: "square",label: "", isTool: true, group: "pixel", canFill: true, command: COMMAND.SQUARE, info: "<b>R</b> Draw rectangle. Shift to lock to square, select again to toggle fill."},
        {name: "line",label: "", isTool: true, group: "pixel", command: COMMAND.LINE, info: "<b>L</b> Draw straight line."},
        {name: "curve",label: "", isTool: true, group: "pixel", command: COMMAND.ARC, info: "<b>A</b> Draw arc."},
        {name: "gradient", isTool: true, group: "pixel", command: COMMAND.GRADIENT, info: "<b>G</b> Gradient fill, draw line to set start- and endpoint."},
        {name: "flood", isTool: true, group: "pixel", command: COMMAND.FLOOD, info: "<b>F</b> Fill an area."},
        {name: "spray", isTool: true, group: "pixel", command: COMMAND.SPRAY, info: "<b>O</b>  Spray brush."},
        //{name: "text", command: COMMAND.TEXT,isTool: true, info: "Write text."},
        {name: "smudge", isTool: true, group: "pixel", command: COMMAND.SMUDGE, info: "<b>M</b>  Smudge/Smear colors."},
        {name: "erase", isTool: true, group: "pixel", command: COMMAND.ERASE, info: "<b>E</b> Erase."},
        // Bone tools — shown only while a bone layer is active (see updateBoneMode).
        {name: "boneselect", label: "", isTool: true, group: "bone", command: COMMAND.BONESELECT, info: "Select and edit the bone rig: drag pivot, tip and action-radius handles."},
        {name: "boneadd", label: "＋", isTool: true, group: "bone", command: COMMAND.BONEADD, info: "Add a bone: drag from pivot to tip. Parented to the selected bone."},
        {name: "bonetransform", label: "↻", isTool: true, group: "bone", command: COMMAND.BONETRANSFORM, info: "Pose bones: rotate about the pivot; children and the pixels below follow."},
        {name: "bonereset", label: "⟲", group: "bone", command: COMMAND.BONERESET, info: "Reset all bones to their rest pose."},
        {name: "bonedelete", label: "✕", group: "bone", command: COMMAND.BONEDELETE, info: "Delete the selected bone (children re-parent to its parent)."},
        // Vector tools — shown only while a vector layer is active (see updateSpecialMode).
        {name: "vectorselect", label: "", isTool: true, group: "vector", command: COMMAND.VECTORSELECT, info: "<b>S</b> Edit: click a shape to select it (drag to move), click/drag its points, ctrl-click a segment to add a point, shift-click lines to multi-select, double-click a line to select its whole path, drag a segment into a curve, edit bezier handles. Delete removes the selection."},
        {name: "vectorline", label: "", isTool: true, group: "vector", command: COMMAND.VECTORLINE, info: "<b>L</b> Draw a line. Intersecting lines are cut at their crossing point."},
        {name: "vectorrect", label: "", isTool: true, group: "vector", canFill: true, command: COMMAND.VECTORRECT, info: "<b>R</b> Draw a rectangle. Shift to lock to square, select again to toggle fill."},
        {name: "vectorcircle", label: "", isTool: true, group: "vector", canFill: true, command: COMMAND.VECTORCIRCLE, info: "<b>C</b> Draw an ellipse. Shift to lock to circle, select again to toggle fill."},
        {name: "vectorblob", label: "⬮", isTool: true, group: "vector", command: COMMAND.VECTORBLOB, info: "<b>B</b> Paint a freehand filled shape (blob brush - round/square, sized in the tool options or a toolbar brush preset)."},
        {name: "vectorfill", label: "", isTool: true, group: "vector", command: COMMAND.VECTORFILL, info: "<b>F</b> Fill a closed shape with the current color."},
        {name: "vectoroutline", label: "◌", isTool: true, group: "vector", command: COMMAND.VECTOROUTLINE, info: "<b>O</b> Outline a shape with the current color and line width."},
        {name: "vectortext", label: "T", isTool: true, group: "vector", command: COMMAND.VECTORTEXT, info: "<b>T</b> Add vector text: click or drag to place it, type to edit, drag an existing text to move it, and use the Properties panel to style or convert it to shapes."},
        {name: "split", command: COMMAND.SPLITSCREEN, toggleProperty: "splitPanel", info: "<b>N</b> Toggle split view."},
        {name: "pan", isTool: true, command: COMMAND.PAN, info: "<b>H</b> or <b>Space</b> Hand: Pan the image."},
        {name: "picker", isTool: true, command: COMMAND.COLORPICKER, info: "<b>K</b> or <b>Shift+Draw</b> Pick color from image."},
        {name: "zoom",label: "", command: COMMAND.ZOOMIN, info: "<b>+</b> Zoom in."},
        {name: "zoomout",label: "",command: COMMAND.ZOOMOUT, info: "<b>-</b> Zoom out."},
        {name: "undo", command: COMMAND.UNDO, info: "<b>"+meta+"-Z</b> Undo."},
        {name: "redo",command: COMMAND.REDO, info: "<b>"+meta+"-Y</b> Redo."}
    ]

    me.init = function(parent){
        container = $div("toolbar","",parent);
        generate();

        EventBus.on(EVENT.toolOptionsChanged,()=>{
            if (container) container.classList.toggle("fill",ToolOptions.isFill());
        })

        EventBus.on(EVENT.panelUIChanged,()=>{
            if (toggleButton){
                let sidePanelsVisible = PanelManager.isContainerVisible("left");
                toggleButton.classList.toggle("active",sidePanelsVisible);
            }
        });

        // Swap the toolbar between pixel tools and the special layer tools (bone / vector) depending
        // on the active layer type (spec 005 R5, spec 008 §4). Only act on the transition so we don't
        // re-trigger a default tool on every layersChanged. Leaving a special mode restores the last
        // pixel tool.
        EventBus.on(EVENT.layersChanged,updateSpecialMode);

    }

    let currentSpecialMode = null;      // null | "bone" | "vector"
    let lastActiveLayerId = null;       // id of the layer we last reacted to (stable across clones)
    let lastPixelCommand = COMMAND.DRAW;
    function specialModeOf(layer){
        if (isBones(layer)) return "bone";
        if (isVector(layer)) return "vector";
        return null;
    }
    function updateSpecialMode(){
        let layer = ImageFile.getActiveLayer();
        let modeNow = specialModeOf(layer);
        let layerId = layer ? layer.id : null;
        // Re-select the default sub-tool when the special mode changes OR when the active layer
        // itself changes within the same mode — so activating another vector layer always lands on
        // the edit/node tool (not whatever draw sub-mode was last used). Other layersChanged events
        // (playhead moves, visibility toggles) keep the same id, so they don't reset the tool.
        if (modeNow === currentSpecialMode && layerId === lastActiveLayerId) return;
        let layerChangedInMode = (modeNow === currentSpecialMode);
        // remember the pixel tool we came from before leaving pixel mode
        if (currentSpecialMode === null){
            let activePixel = items.find(itm=>itm.isTool && itm.group==="pixel" && itm.element && itm.element.classList.contains("active"));
            if (activePixel) lastPixelCommand = activePixel.command;
        }
        currentSpecialMode = modeNow;
        lastActiveLayerId = layerId;
        if (container){
            container.classList.toggle("bone-mode",modeNow === "bone");
            container.classList.toggle("vector-mode",modeNow === "vector");
        }
        if (modeNow === "bone"){
            EventBus.trigger(COMMAND.BONESELECT);
        }else if (modeNow === "vector"){
            EventBus.trigger(COMMAND.VECTORSELECT);
        }else if (!layerChangedInMode){
            // only reset to a pixel tool when we actually left a special mode — switching between two
            // pixel layers must keep the tool the user is drawing with.
            EventBus.trigger(lastPixelCommand || COMMAND.DRAW);
        }
    }

    me.activateButton = function(index){
        let item = items[index];
        if (item){
            if (item.element){
                if (item.canFill && item.element.classList.contains("active")){
                    ToolOptions.setFill(!ToolOptions.isFill());
                }
            }
            if (item.command) EventBus.trigger(item.command);
        }
    }

    function generate(){
        let tools = $(".tools",{parent: container},
            toggleButton = $(".togglepanel.sidebar",{
                onClick: ()=>EventBus.trigger(COMMAND.TOGGLESIDEPANEL),
                info:"Toggle side panels"
            })
        );

        Brush.init(tools);

        items.forEach((item,index)=>{
            let groupClass = item.group ? (" group-" + item.group) : "";
            item.element = $div("button handle info icon " + item.name + groupClass,item.label,tools,(e) =>{
                me.activateButton(index);
            });

            item.element.info = item.info;
            if (item.isTool && item.command){
                EventBus.on(item.command,()=>{
                    items.forEach((itm,i)=>{
                        if (itm.isTool){
                            if (itm.handleDeActivate && itm.command && itm.element.classList.contains("active") && index !== i){
                                EventBus.trigger(EVENT.toolDeActivated,itm.command);
                            }
                            itm.element.classList.toggle("active",index === i);
                        }
                    });
                    EventBus.trigger(EVENT.toolChanged,item.command);
                });
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

            if (item.command === COMMAND.UNDO){
                undo = item.element;
                undo.classList.toggle("disabled",true);
            }
            if (item.command === COMMAND.REDO){
                redo = item.element;
                redo.classList.toggle("disabled",true);
            }
        });
        Palette.init(tools,container);
    }

    EventBus.on(EVENT.historyChanged,([undoCount,redoCount])=>{
        if (undo) undo.classList.toggle("disabled",undoCount === 0);
        if (redo) redo.classList.toggle("disabled",redoCount === 0);
    });

    return me;


}();

export default Toolbar;
