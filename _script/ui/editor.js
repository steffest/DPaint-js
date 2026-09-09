import Canvas from "./canvas.js";
import {$div} from "../util/dom.js";
import EventBus from "../util/eventbus.js";
import {COMMAND, EVENT} from "../enum.js";
import EditPanel from "./editpanel.js";
import ImageFile from "../image.js";
import Selection from "./selection.js";
import Palette from "./palette.js";
import Color from "../util/color.js";
import Modal, {DIALOG} from "./modal.js";
import {releaseCanvas, duplicateCanvas} from "../util/canvasUtils.js";
import Input from "./input.js";
import HistoryService from "../services/historyservice.js";
import Cursor from "./cursor.js";
import ToolOptions from "./components/toolOptions.js";
import {ensureMeshWarp, getMeshWarpIfLoaded} from "../paintTools/meshWarpLoader.js";
import {ensureBoneTool, getBoneToolIfLoaded} from "../paintTools/boneToolLoader.js";
import {ensureVectorTool, getVectorToolIfLoaded} from "../paintTools/vectorToolLoader.js";
import {isVector} from "../util/layerUtils.js";
import {cloneVector, vectorBounds, transformVector, transformVectorSubset, getDisplayMode} from "../util/vectorUtils.js";
import UI from "./ui.js";
import UserSettings from "../userSettings.js";
import PanelManager from "./panelManager.js";
import LayerPanel from "./toolPanels/layerPanel.js";

var Editor = function(){
    var me = {};
    let panels=[];
    let divider;
    var container;
    var zoomFactor = 1.1;
    var activePanel;
    let resizer;
    var currentTool = COMMAND.DRAW;
    let previousTool;
    var touchData = {};
    let rotSprite;
    let colorMaskFlashTimer;
    let colorMaskFlashLayerIndex = -1;
    const COLOR_MASK_FLASH_INTERVAL = 500;
    const COLOR_MASK_RED_DISTANCE_THRESHOLD = 140;
    var state= {
        splitPanel: false,
        rulers: false,
        left: 250
    }

    function stopColorMaskFlash(){
        if (colorMaskFlashTimer){
            clearInterval(colorMaskFlashTimer);
            colorMaskFlashTimer = undefined;
        }
        colorMaskFlashLayerIndex = -1;
    }

    function removeColorMaskLayers(){
        stopColorMaskFlash();
        let currentHighLight = ImageFile.getLayerIndexesOfType("pixelSelection");
        // Remove deepest/highest paths first so earlier removals don't shift later ones.
        currentHighLight.slice().sort((a,b)=>{
            let len = Math.max(a.length,b.length);
            for (let i=0;i<len;i++){
                let av = a[i] ?? -1, bv = b[i] ?? -1;
                if (av !== bv) return bv - av;
            }
            return 0;
        }).forEach(path=>{
            ImageFile.removeLayer(path);
        });
    }

    function drawColorMaskState(layer, imageData, isVisible){
        if (!layer) return;
        let ctx = layer.getContext();
        let w = ctx.canvas.width;
        let h = ctx.canvas.height;
        ctx.clearRect(0,0,w,h);
        if (isVisible && imageData){
            ctx.putImageData(imageData,0,0);
        }
        EventBus.trigger(EVENT.imageContentChanged);
    }

    function getColorMaskFlashColor(color){
        color = Color.fromString(color);
        if (Color.distance(color,[255,0,0]) < COLOR_MASK_RED_DISTANCE_THRESHOLD){
            return [255,255,0];
        }
        return [255,0,0];
    }

    me.init=function(parent){
        container = $div("editor splitpanel","",parent);
        panels.push(EditPanel(container,"left"));
        divider = $div("splitter","",container,(e)=>{
            touchData.totalWidth = container.getBoundingClientRect().width;
            touchData.startWith = panels[0].getWidth();
            touchData.startWith2 = panels[1].getWidth();
            touchData.startX = parseInt(divider.style.marginLeft) || -3;
        })
        panels.push(EditPanel(container,"right"));
        activePanel = panels[0];
        resizer = activePanel.getResizer();

        divider.onDrag = function(x,y){
            let w = touchData.startWith+x;
            let w2 = touchData.startWith2-x;
            let min = 120;

            if (w<min) x = min-touchData.startWith;
            if (w2<min) x = touchData.startWith2-min;

            w = (touchData.startWith+x)*100/touchData.totalWidth;
            divider.style.left = w + "%";
            panels[0].setWidth(w,true);
            w = (touchData.startWith2-x)*100/touchData.totalWidth;
            panels[1].setWidth(w,true);
        }



        EventBus.on(EVENT.panelUIChanged,function(){
            // Sidepanel starts at 68px (toolbar 64px + 4px gap); add another 4px gap so the
            // sidepanel↔editor edge matches the toolbar↔sidepanel gap (see $panel-gap in _var.scss).
            container.style.left = (PanelManager.getDockWidth("left") + 68 + 4) + "px";
            container.style.right = PanelManager.getDockWidth("right") + "px";
            container.style.bottom = (PanelManager.getDockHeight() + 22) + "px";
        });
        // PanelManager.init() runs before this subscription exists, so its initial
        // panelUIChanged is missed; recompute the editor offsets now that we're wired.
        EventBus.trigger(EVENT.panelUIChanged);
        
        EventBus.on(COMMAND.ZOOMIN,function(center){
            activePanel.zoom(zoomFactor,center);
        });
        EventBus.on(COMMAND.ZOOMOUT,function(center){
            activePanel.zoom(1/zoomFactor,center);
        });

        //TODO: move these to ToolOptions
        EventBus.on(COMMAND.DRAW,function(){
            currentTool = COMMAND.DRAW;
            Cursor.set("draw");
        });
        EventBus.on(COMMAND.ERASE,function(){
            currentTool = COMMAND.ERASE;
            Cursor.set("draw");
        });
        EventBus.on(COMMAND.SMUDGE,function(){
            currentTool = COMMAND.SMUDGE;
        });
        EventBus.on(COMMAND.SPRAY,function(){
            currentTool = COMMAND.SPRAY;
        });
        EventBus.on(COMMAND.TEXT,function(){
            currentTool = COMMAND.TEXT;
            Cursor.set("text");
        });
        EventBus.on(COMMAND.FLOOD,function(){
            currentTool = COMMAND.FLOOD;
        });
        EventBus.on(COMMAND.SQUARE,function(){
            currentTool = COMMAND.SQUARE;
            Cursor.set("select");
        });
        EventBus.on(COMMAND.CIRCLE,function(){
            currentTool = COMMAND.CIRCLE;
            Cursor.set("select");
        });
        EventBus.on(COMMAND.LINE,function(){
            currentTool = COMMAND.LINE;
        });
        EventBus.on(COMMAND.GRADIENT,function(){
            currentTool = COMMAND.GRADIENT;
        });
        EventBus.on(COMMAND.PAN,function(){
            currentTool = COMMAND.PAN;
            Cursor.set("pan");
        });
        EventBus.on(COMMAND.COLORPICKER, function(){
            currentTool = COMMAND.COLORPICKER;
            Cursor.set("colorpicker");
        });
        EventBus.on(COMMAND.SELECTLAYER,function(){
            currentTool = COMMAND.SELECTLAYER;
            Cursor.set("select");
        });
        EventBus.on(COMMAND.SPLITSCREEN,function(){
            me.splitPanel();
        });
        EventBus.on(COMMAND.TOGGLERULERS,function(){
            state.rulers = !state.rulers;
            EventBus.trigger(EVENT.rulerOptionsChanged,state.rulers);
        });
        EventBus.on(COMMAND.ARC,function(){
            currentTool = COMMAND.ARC;
        });
        EventBus.on(COMMAND.ROTATE,function(){
            EventBus.trigger(COMMAND.CLEARSELECTION);
            // rotates every cel of every track and swaps the document dimensions
            ImageFile.rotate();
        });
        EventBus.on(COMMAND.CLEAR,function(){
            var s = Selection.get();
            let layer = ImageFile.getActiveLayer();
            if (!layer) return;
            HistoryService.start(EVENT.layerContentHistory);
            // the selection is in document space, the layer context in the layer's own space
            let clearOffset = ImageFile.getLayerOffset();
            if (s){
                if (s.canvas || s.points){
                    let canvas = Selection.getCanvas();
                    let layerCtx = layer.getContext();
                    layerCtx.globalCompositeOperation = "destination-out";
                    layerCtx.drawImage(canvas,-clearOffset.x,-clearOffset.y);
                    layerCtx.globalCompositeOperation = "source-over";
                    releaseCanvas(canvas);
                }else{
                    // rectangular selection
                    layer.getContext().clearRect(s.left - clearOffset.x,s.top - clearOffset.y,s.width,s.height);
                }
            }else{
                layer.clear();
            }
            HistoryService.end();
            EventBus.trigger(EVENT.layerContentChanged);
            EventBus.trigger(EVENT.imageContentChanged);
        });
        EventBus.on(COMMAND.CROP,function(){
            var s = Selection.get();
            if (s){
                // Non-destructive: the document window moves, layer pixels stay put and are
                // clipped at the new bounds (spec 004 decision 4).
                ImageFile.crop(s.left,s.top,s.width,s.height);
                Selection.move(0,0,s.width,s.height);
            }
        });
        EventBus.on(COMMAND.TRIM,()=>{
            let frame = ImageFile.getActiveFrame();
            let w = ImageFile.getCurrentFile().width;
            let h = ImageFile.getCurrentFile().height;
            let box = {
                left: w,
                right: 0,
                top: h,
                bottom: 0,
            }
            frame.layers.forEach((layer,i)=>{
                let b = ImageFile.getLayerBoundingRect(i);
                if (b.x < box.left) box.left = b.x;
                if (b.x + b.w > box.right) box.right = b.x + b.w;
                if (b.y < box.top) box.top = b.y;
                if (b.y + b.h > box.bottom) box.bottom = b.y + b.h;
            });

            box.w = box.right - box.left;
            box.h = box.bottom - box.top;
            if (!box.w || !box.h) return;
            if (box.w === w && box.h === h && box.x === 0) return;

            ImageFile.crop(box.left,box.top,box.w,box.h);
        })

        EventBus.on(COMMAND.TRANSFORMLAYER,()=>{
            let VectorTool = getVectorToolIfLoaded();
            resizer.setOnUpdate(undefined);
            touchData.transformLayer = undefined;
            touchData.transformGroup = false;
            touchData.transformVector = undefined;
            touchData.transformVectorSelection = undefined;
            touchData.transformMultiPaths = undefined;

            let node = ImageFile.getActiveLayer();

            // Free-transforming a VECTOR layer bakes into the GEOMETRY, not pixels: the resizer box
            // maps to an affine (translate/scale/rotate) applied to every node + curve handle, so
            // the shapes stay resolution-independent and re-rasterize crisp. Because a vector layer
            // keeps VectorTool active (which owns canvas pointer events), we suspend that tool for
            // the duration and re-enter it on commit/cancel via previousTool.
            if (isVector(node) && node.vector){
                // The resizer box normally snaps to whole document pixels (right, for a raster
                // layer's pixel grid) — but a vector layer's geometry is only ever hardened to that
                // grid in "sharp" (pixel-art) display mode; "smooth"/"vector" keep sub-pixel precision
                // everywhere else the tool touches geometry (docToGeoAt et al), so Free Transform must
                // match that here too instead of quietly rounding every move/scale.
                let round = getDisplayMode(node.vector) === "sharp";

                // Spec 018: when the vector tool has an active selection — on the active layer, on an
                // eligible sibling layer, or spanning several layers — Free Transform is scoped to
                // exactly that selection instead of the whole document, so the box wraps just the
                // selected points/lines/shape and dragging it moves every touched layer together.
                // With nothing selected it falls through to the existing whole-document behaviour.
                let scope = VectorTool?.isActive() ? VectorTool.getFreeTransformScope() : null;
                if (scope){
                    let b = scope.bounds;
                    if (!b.width || !b.height) return;

                    if (VectorTool.isActive()) VectorTool.commit();  // release canvas pointer routing

                    previousTool = currentTool;
                    currentTool = COMMAND.TRANSFORMLAYER;
                    resizer.init({
                        x: b.x, y: b.y, width: b.width, height: b.height,
                        rotation: 0, aspect: (b.width / b.height) || 1, canRotate: true, round: round
                    });
                    let target = ImageFile.getHistoryTarget();
                    touchData.transformVectorSelection = scope.groups.map(g=>{
                        let l = ImageFile.getLayerInTarget(target, g.path);
                        return { path: g.path, layer: l, nodeIds: g.nodeIds, snapshot: cloneVector(l.vector) };
                    });
                    touchData.transformVectorBox = b;
                    touchData.transformVectorResume = previousTool;
                    HistoryService.start(EVENT.imageHistory);
                    resizer.setOnUpdate(updateVectorSelectionTransform);
                    return;
                }

                // No vector-tool point/line selection, but several WHOLE vector layers are
                // multi-selected in the Layer panel (shift-click range): reuse the spec-018
                // selection-scoped machinery, just with every group covering its layer's entire
                // geometry (no nodeIds) instead of a node subset — see updateVectorSelectionTransform.
                if (LayerPanel.hasMultiSelection()){
                    let vectorPaths = LayerPanel.getSelectedPaths().filter(p => isVector(ImageFile.getLayer(p)));
                    if (vectorPaths.length > 1){
                        let combined = combinedVectorLayersBounds(vectorPaths);
                        if (combined){
                            if (VectorTool?.isActive()) VectorTool.commit();  // release canvas pointer routing

                            previousTool = currentTool;
                            currentTool = COMMAND.TRANSFORMLAYER;
                            let b = combined.bounds;
                            resizer.init({
                                x: b.x, y: b.y, width: b.width, height: b.height,
                                rotation: 0, aspect: (b.width / b.height) || 1, canRotate: true, round: round
                            });
                            touchData.transformVectorSelection = combined.groups;
                            touchData.transformVectorBox = b;
                            touchData.transformVectorResume = previousTool;
                            HistoryService.start(EVENT.imageHistory);
                            resizer.setOnUpdate(updateVectorSelectionTransform);
                            return;
                        }
                    }
                }

                let vb = vectorBounds(node.vector);
                if (!vb || !vb.width || !vb.height) return;
                let off = ImageFile.getLayerOffset();
                let dbox = { x: vb.x + off.x, y: vb.y + off.y, w: vb.width, h: vb.height };

                if (VectorTool?.isActive()) VectorTool.commit();  // release canvas pointer routing

                previousTool = currentTool;
                currentTool = COMMAND.TRANSFORMLAYER;
                resizer.init({
                    x: dbox.x, y: dbox.y, width: dbox.w, height: dbox.h,
                    rotation: 0, aspect: (dbox.w / dbox.h) || 1, canRotate: true, round: round
                });
                touchData.transformVector = node;
                touchData.transformVectorSnapshot = cloneVector(node.vector);
                touchData.transformVectorBox = dbox;
                touchData.transformVectorResume = previousTool;
                HistoryService.start(EVENT.imageHistory);
                resizer.setOnUpdate(updateVectorTransform);
                return;
            }

            // Free-transforming a GROUP does not bake pixels (spec 007): it drives the group's
            // runtime scale/rotation (which the compositor applies on the fly and which animate
            // through property keyframes). The resizer is seeded from the group's oriented box and
            // its scale/rotation map straight back onto the group node via setLayerKeyProps.
            let activeNode = ImageFile.getActiveLayer();
            if (activeNode && activeNode.type === "group"){
                let gbox = ImageFile.getGroupTransformBox();
                if (!gbox) return;
                previousTool = currentTool;
                currentTool = COMMAND.TRANSFORMLAYER;
                resizer.init({
                    x: gbox.x,
                    y: gbox.y,
                    width: gbox.w,
                    height: gbox.h,
                    rotation: gbox.rotation,
                    aspect: (gbox.w / gbox.h) || 1,
                    canRotate: true
                });
                touchData.transformGroup = true;
                touchData.transformGroupBox = gbox;
                touchData.transformLayer = activeNode;
                touchData.transformStartProps = ImageFile.getLayerKeyProps();
                HistoryService.start(EVENT.keyPropsHistory);
                resizer.setOnUpdate(updateGroupTransform);
                return;
            }

            let box = ImageFile.getLayerBoundingRect();
            if (!box.w || !box.h) return;

            previousTool = currentTool;
            currentTool = COMMAND.TRANSFORMLAYER;

            resizer.init({
                x: box.x,
                y: box.y,
                width: box.w,
                height: box.h,
                rotation: 0,
                aspect: box.w/box.h,
                canRotate: true
            });

            touchData.transformBox = box;
            touchData.transformCanvas = document.createElement("canvas");
            touchData.transformCanvas.width = box.w;
            touchData.transformCanvas.height = box.h;
            let ctx = touchData.transformCanvas.getContext("2d");
            ctx.imageSmoothingEnabled = false;
            // box is in document coordinates; the layer canvas is in the layer's own space
            let transformOffset = ImageFile.getLayerOffset();
            let activeLayer = ImageFile.getActiveLayer();
            ctx.drawImage(ImageFile.getActiveContext().canvas,
                box.x - transformOffset.x - (activeLayer?.canvasX || 0),box.y - transformOffset.y - (activeLayer?.canvasY || 0),box.w,box.h,0,0,box.w,box.h);

            HistoryService.start(EVENT.layerContentHistory);
            touchData.transformLayer = ImageFile.getActiveLayer();
            touchData.transformIsMove = false;
            // the node's OWN animatable x/y (base value or property-key entry) at gesture start
            touchData.transformStartProps = ImageFile.getLayerKeyProps();

            // Multiple layers selected in the Layer panel (shift-click range): Free Transform still
            // shows/resizes the box around the ACTIVE layer only, but a pure translate (arrow keys or
            // a plain drag, see updateTransform) carries every OTHER selected layer along by the same
            // delta, each through its own animatable x/y.
            touchData.transformMultiPaths = undefined;
            if (LayerPanel.hasMultiSelection()){
                let activeKey = ImageFile.getActiveLayerPath().join(",");
                let others = LayerPanel.getSelectedPaths().filter(p => p.join(",") !== activeKey);
                if (others.length){
                    touchData.transformMultiPaths = others.map(p => ({path: p, startProps: ImageFile.getLayerKeyProps(p)}));
                }
            }

            resizer.setOnUpdate(updateTransform);
        });

        EventBus.on(COMMAND.MESHWARP,()=>{
            if (getMeshWarpIfLoaded()?.isActive()) return;
            // commit any pending free-transform first
            me.commit();
            ensureMeshWarp().then(MeshWarp=>{
                if (!MeshWarp.start()) return;
                previousTool = currentTool;
                currentTool = COMMAND.MESHWARP;
            });
        });

        // Bone tools (spec 005). The three mode commands share one modal BoneTool bound to the
        // active bone layer; they only switch its interaction mode. The toolbar starts the tool
        // when a bone layer is activated and commits it when a pixel layer regains focus.
        // BoneTool loads on first use — see `_script/paintTools/boneToolLoader.js`.
        function activateBoneMode(mode){
            ensureBoneTool().then(BoneTool=>{
                if (!BoneTool.start()) return; // active layer is not a bone layer
                BoneTool.setMode(mode);
                currentTool = COMMAND.BONESELECT; // one canvas-routing bucket for all bone modes
            });
        }
        EventBus.on(COMMAND.BONESELECT,()=>{ activateBoneMode("select"); });
        EventBus.on(COMMAND.BONEADD,()=>{ activateBoneMode("add"); });
        EventBus.on(COMMAND.BONETRANSFORM,()=>{ activateBoneMode("transform"); });
        EventBus.on(COMMAND.BONERESET,()=>{ getBoneToolIfLoaded()?.resetPose(); });
        EventBus.on(COMMAND.BONEDELETE,()=>{ getBoneToolIfLoaded()?.deleteSelected(); });

        // Vector tools (spec 008). All sub-mode commands share one modal VectorTool bound to the
        // active vector layer; they only switch its interaction mode. The toolbar starts the tool
        // when a vector layer is activated and commits it when a pixel layer regains focus.
        // VectorTool loads on first use — see `_script/paintTools/vectorToolLoader.js`.
        function activateVectorMode(mode){
            ensureVectorTool().then(VectorTool=>{
                if (!VectorTool.start()) return; // active layer is not a vector layer
                VectorTool.setMode(mode);
                currentTool = COMMAND.VECTORSELECT; // one canvas-routing bucket for all vector modes
            });
        }
        EventBus.on(COMMAND.VECTORSELECT,()=>{ activateVectorMode("select"); });
        // VECTORNODE folded into the unified Select/Edit tool; kept as an alias for old callers.
        EventBus.on(COMMAND.VECTORNODE,()=>{ activateVectorMode("select"); });
        EventBus.on(COMMAND.VECTORLINE,()=>{ activateVectorMode("line"); });
        EventBus.on(COMMAND.VECTORRECT,()=>{ activateVectorMode("rect"); });
        EventBus.on(COMMAND.VECTORCIRCLE,()=>{ activateVectorMode("circle"); });
        EventBus.on(COMMAND.VECTORBLOB,()=>{ activateVectorMode("blob"); });
        EventBus.on(COMMAND.VECTORFILL,()=>{ activateVectorMode("fill"); });
        EventBus.on(COMMAND.VECTOROUTLINE,()=>{ activateVectorMode("outline"); });
        EventBus.on(COMMAND.VECTORTEXT,()=>{ activateVectorMode("text"); });
        EventBus.on(COMMAND.VECTORDELETE,()=>{ getVectorToolIfLoaded()?.deleteSelected(); });
        EventBus.on(COMMAND.SHAPELINESTOFILL,()=>{ getVectorToolIfLoaded()?.linesToFills(); });
        EventBus.on(COMMAND.SHAPEEXPANDFILL,()=>{ getVectorToolIfLoaded()?.startExpandFill(); });

        EventBus.on(COMMAND.COLORMASK,(options)=>{
            if (options === true){
                options = {flash:false};
            }
            options = options || {};

            if (options.clear){
                removeColorMaskLayers();
                return;
            }

            removeColorMaskLayers();

            let ctx = ImageFile.getActiveContext();
            let color = Palette.getDrawColor();
            let sourceColor = Color.fromString(color);
            let w = ImageFile.getCurrentFile().width;
            let h = ImageFile.getCurrentFile().height;
            let data = ctx.getImageData(0,0,w,h).data;
            let layerIndex = ImageFile.addLayer();
            let layer = ImageFile.getLayer(layerIndex);
            layer.type = "pixelSelection";
            let ctx2 = ImageFile.getLayer(layerIndex).getContext();
            let flashColor = getColorMaskFlashColor(sourceColor);
            let maskColor = options.flash ? flashColor : sourceColor;
            let maskImageData = ctx2.createImageData(w,h);
            let maskData = maskImageData.data;
            let count = 0;
            for (let y = 0;y<h;y++){
                for (let x = 0;x<w;x++){
                    let index = (y*w + x) * 4;
                    let r = data[index];
                    let g = data[index+1];
                    let b = data[index+2];
                    let c = Color.toString([r,g,b]);
                    if (c === color){
                        count++;
                        maskData[index] = maskColor[0];
                        maskData[index+1] = maskColor[1];
                        maskData[index+2] = maskColor[2];
                        maskData[index+3] = 255;
                    }
                }
            }

            if (options.flash){
                colorMaskFlashLayerIndex = layerIndex;
                drawColorMaskState(layer,maskImageData,true);
                let isVisible = true;
                colorMaskFlashTimer = setInterval(()=>{
                    let flashLayer = ImageFile.getLayer(colorMaskFlashLayerIndex);
                    if (!flashLayer || flashLayer.type !== "pixelSelection"){
                        stopColorMaskFlash();
                        return;
                    }
                    isVisible = !isVisible;
                    drawColorMaskState(flashLayer,maskImageData,isVisible);
                },COLOR_MASK_FLASH_INTERVAL);
            }else{
                ctx2.putImageData(maskImageData,0,0);
                EventBus.trigger(EVENT.imageContentChanged);
            }

            EventBus.trigger(EVENT.colorCount,count);
            return layerIndex;
        })

        EventBus.on(EVENT.layersChanged,()=>{
            if (!colorMaskFlashTimer) return;
            let flashLayer = ImageFile.getLayer(colorMaskFlashLayerIndex);
            if (!flashLayer || flashLayer.type !== "pixelSelection"){
                stopColorMaskFlash();
            }
        });

        EventBus.on(COMMAND.LAYERMASK,(hide)=>{
            HistoryService.start(EVENT.layerHistory);
            let layer = ImageFile.getActiveLayer();
            layer.addMask(!!hide);
            HistoryService.end();
            EventBus.trigger(EVENT.layerContentChanged);
            EventBus.trigger(EVENT.layersChanged);
        });
        EventBus.on(COMMAND.LAYERMASKHIDE,()=>{
            EventBus.trigger(COMMAND.LAYERMASK,true);

            setTimeout(()=>{
                EventBus.trigger(EVENT.layerContentChanged);
                EventBus.trigger(EVENT.layersChanged);
            },1000)
        });
        EventBus.on(COMMAND.DELETELAYERMASK,()=>{
            let layer = ImageFile.getActiveLayer();
            layer.removeMask();
            EventBus.trigger(EVENT.layerContentChanged);
            EventBus.trigger(EVENT.layersChanged);
        });
        EventBus.on(COMMAND.DISABLELAYERMASK,()=>{
            let layer = ImageFile.getActiveLayer();
            layer.enableMask(false);
            EventBus.trigger(EVENT.layerContentChanged);
            EventBus.trigger(EVENT.layersChanged);
        });
        EventBus.on(COMMAND.ENABLELAYERMASK,()=>{
            let layer = ImageFile.getActiveLayer();
            layer.enableMask(true);
            EventBus.trigger(EVENT.layerContentChanged);
            EventBus.trigger(EVENT.layersChanged);
        });
        EventBus.on(COMMAND.APPLYLAYERMASK,()=>{
            let layer = ImageFile.getActiveLayer();
            layer.removeMask(true);
            EventBus.trigger(EVENT.layerContentChanged);
            EventBus.trigger(EVENT.layersChanged);
        });
        EventBus.on(COMMAND.EDITPALETTE, ()=>{
            // Palette editor is now a dock-capable, floating-by-default free panel.
            PanelManager.show("palette");
        })
        EventBus.on(COMMAND.EFFECTS, ()=>{
            PanelManager.show("effects");
        })
        EventBus.on(EVENT.toolChanged,(tool)=>{
            // Switching between bone modes keeps the tool session (and selection) alive; only
            // committing when leaving bones entirely is handled by the bone command handlers below.
            let boneTool = tool === COMMAND.BONESELECT || tool === COMMAND.BONEADD || tool === COMMAND.BONETRANSFORM;
            if (boneTool && getBoneToolIfLoaded()?.isActive()) return;
            // Likewise, switching among vector sub-tools keeps the modal VectorTool (and its
            // selection) alive; committing only happens when leaving vector mode entirely.
            let vectorTool = tool === COMMAND.VECTORSELECT || tool === COMMAND.VECTORNODE
                || tool === COMMAND.VECTORLINE || tool === COMMAND.VECTORRECT
                || tool === COMMAND.VECTORCIRCLE || tool === COMMAND.VECTORBLOB
                || tool === COMMAND.VECTORFILL || tool === COMMAND.VECTOROUTLINE
                || tool === COMMAND.VECTORTEXT;
            if (vectorTool && getVectorToolIfLoaded()?.isActive()) return;
            me.commit();
            Cursor.reset();
            if (tool === COMMAND.SELECT || tool === COMMAND.FLOODSELECT || tool === COMMAND.POLYGONSELECT){
                currentTool = tool;
                Cursor.set("select");
                EventBus.trigger(COMMAND.INITSELECTION,tool);
            }
        });
        EventBus.on(COMMAND.PRESENTATION,()=>{
            if (UI.inPresentation()){
                state.prevLeft = state.left;
                container.style.left = 0;
                if (state.splitPanel){
                    EventBus.trigger(COMMAND.SPLITSCREEN);
                }
            }else{
                EventBus.trigger(EVENT.panelUIChanged);
            }
            EventBus.trigger(COMMAND.ZOOMFIT);


        })

        EventBus.on(COMMAND.FRAMES2LAYERS,()=>{
            // every BAKED timeline frame becomes a layer of a single content key
            ImageFile.framesToLayers();
        })

        EventBus.on(COMMAND.LAYERS2FRAMES,()=>{
            // every layer of the active cel becomes its own content key on the active track
            ImageFile.layersToFrames();
        })

        EventBus.on(COMMAND.LAYERS2SHEET,()=>{
            // stacks the active cel's layers vertically into one taller layer
            ImageFile.layersToSheet();
        })

    }

    me.setActivePanel = function(panel){
        activePanel = panels[panel];
        resizer = activePanel.getResizer();
    }

    me.getActivePanel = function(){
        return activePanel;
    }

    me.getCurrentTool = function(){
        return currentTool;
    }

    me.splitPanel = function(){
        state.splitPanel = !state.splitPanel;
        if (divider.style.display === "block"){
            panels[0].setWidth(100,true);
            panels[1].hide();
            divider.style.display = "none";
            EventBus.trigger(EVENT.UIresize);

        }else{
            // Each panel shrinks by half the shared $panel-gap (see _var.scss) so the visible
            // gap between the two panels equals $panel-gap, not double it.
            panels[0].setWidth("calc(50% - 2px)");
            panels[1].setWidth("calc(50% - 2px)");
            panels[1].show();
            divider.style.left = "";
            divider.style.display = "block";
            EventBus.trigger(EVENT.imageSizeChanged);
        }
    }

    me.isStateActive = function(name){
        return !!state[name];
    }

    me.isDrawing = function(){
        return activePanel ? activePanel.isDrawing() : false;
    }

    me.commit = async function(){
        let BoneTool = getBoneToolIfLoaded();
        let VectorTool = getVectorToolIfLoaded();
        let MeshWarp = getMeshWarpIfLoaded();
        if (BoneTool?.isActive()){
            BoneTool.commit();
        }
        if (VectorTool?.isActive()){
            VectorTool.commit();
        }
        if (MeshWarp?.isActive()){
            MeshWarp.commit();
            // Enter keeps currentTool === MESHWARP → restore the previous tool.
            // A tool switch already changed currentTool → leave the new tool in place.
            if (currentTool === COMMAND.MESHWARP){
                currentTool = undefined;
                if (previousTool) EventBus.trigger(previousTool);
            }
        }
        if (currentTool === COMMAND.TRANSFORMLAYER){
            console.log("commit layer");
            resizer.commit();
            await updateTransform(true);
            clearTransform();
            EventBus.trigger(COMMAND.CLEARSELECTION);
            currentTool = undefined;
            HistoryService.end();
            if (previousTool) EventBus.trigger(previousTool);
        }
        if (currentTool === COMMAND.POLYGONSELECT){
            EventBus.trigger(COMMAND.ENDPOLYGONSELECT);
        }
    }

    me.reset = function(){
        let BoneTool = getBoneToolIfLoaded();
        let VectorTool = getVectorToolIfLoaded();
        let MeshWarp = getMeshWarpIfLoaded();
        if (BoneTool?.isActive()){
            BoneTool.cancel();
            return;
        }
        if (VectorTool?.isActive()){
            VectorTool.cancel();
            return;
        }
        if (MeshWarp?.isActive()){
            MeshWarp.cancel();
            currentTool = undefined;
            let p = previousTool;
            previousTool = undefined;
            EventBus.trigger(COMMAND.CLEARSELECTION);
            if (p) EventBus.trigger(p);
            return;
        }
        if (currentTool === COMMAND.TRANSFORMLAYER){
            let resume = (touchData.transformVector || touchData.transformVectorSelection) ? touchData.transformVectorResume : undefined;
            resizer.commit();
            resetTransform();
            clearTransform();
            currentTool = undefined;
            HistoryService.neverMind();
            // a vector transform suspended VectorTool — re-enter the sub-tool it came from
            if (resume){ previousTool = undefined; EventBus.trigger(resume); }
        }
        EventBus.trigger(COMMAND.CLEARSELECTION);
    }

    me.arrowKey = function(direction){
        let x = 0;
        let y = 0;
        switch (direction){
            case "left": x=-1; break;
            case "right": x=1; break;
            case "up": y=-1; break;
            case "down": y=1; break;
        }
        // Vector node mode: arrow keys nudge the selected node(s); Meta = coarse 10px step.
        let VectorTool = getVectorToolIfLoaded();
        if (VectorTool?.isActive()){
            let step = Input.isMetaDown() ? 10 : 1;
            if (VectorTool.nudge(x*step, y*step)) return;
        }
        if (Input.isMetaAndShiftDown()){
            switch (direction){
                case "left":
                    EventBus.trigger(COMMAND.BRUSHFLIPHORIZONTAL)
                    break;
                case "right":
                    EventBus.trigger(COMMAND.BRUSHROTATERIGHT);
                    break;
                case "up":
                    EventBus.trigger(COMMAND.BRUSHFLIPVERTICAL);
                    break;
                //case "down": y=1; break;
            }
            return;
        }
        if (Input.isMetaDown()){
            x*=10;
            y*=10;
        }
        if (me.canDrawColor()){
            if (Input.isMetaDown() && ImageFile.hasMultipleFrames()){
                if (x>0) ImageFile.nextFrame();
                if (x<0) ImageFile.nextFrame(-1);
                return;
            }
            if (x>0) Palette.next();
            if (x<0) Palette.prev();
            return;
        }
        resizer.move(x,y);
    }

    me.setZoom = function(factor,center){
        activePanel.setZoom(factor,center);
    }

    me.canPickColor = (isDown)=>{
        console.log("can pick color");
        if (isDown && !Cursor.hasOverride("colorpicker")){
            return false;
        }
        return (
            currentTool === COMMAND.DRAW ||
            currentTool === COMMAND.CIRCLE ||
            currentTool === COMMAND.SQUARE ||
            currentTool === COMMAND.LINE ||
            currentTool === COMMAND.TEXT ||
            currentTool === COMMAND.SPRAY ||
            currentTool === COMMAND.FLOOD);
    }

    me.canDrawColor = ()=>{
        return (currentTool === COMMAND.DRAW || currentTool === COMMAND.SQUARE || currentTool === COMMAND.GRADIENT || currentTool === COMMAND.LINE || currentTool === COMMAND.ARC || currentTool === COMMAND.CIRCLE  ||  currentTool === COMMAND.SPRAY ||  currentTool === COMMAND.ERASE ||  currentTool === COMMAND.FLOOD);
    }

    me.usesBrush = (tool)=>{
        let t = tool || currentTool;
        return (t === COMMAND.DRAW || t === COMMAND.SPRAY || t === COMMAND.ERASE);
    }

    // A group free-transform (spec 007): translate the resizer box back into the group's
    // scale/rotation and centre offset, written through the animatable property path. No pixels
    // are copied — the compositor applies the transform on the fly.
    function updateGroupTransform(){
        let g = touchData.transformGroupBox;
        let sp = touchData.transformStartProps;
        if (!g || !sp) return;
        let d = resizer.get();
        let newCenterX = d.left + d.width / 2;
        let newCenterY = d.top + d.height / 2;
        let scaleX = g.baseW ? d.width / g.baseW : 1;
        let scaleY = g.baseH ? d.height / g.baseH : 1;
        ImageFile.setLayerKeyProps(undefined,{
            // The group's own offset shifts by however far its content centre moved.
            x: sp.x + (newCenterX - g.centerX),
            y: sp.y + (newCenterY - g.centerY),
            scaleX: scaleX,
            scaleY: scaleY,
            rotation: d.rotation
        });
    }

    // A vector free-transform: map the resizer box to an affine and bake it into the GEOMETRY
    // (nodes + curve handles), not pixels. Re-applied from the pristine snapshot on every update so
    // the mapping is absolute (never cumulative). Move/scale/rotate all flow through here.
    function updateVectorTransform(){
        let layer = touchData.transformVector;
        let snap = touchData.transformVectorSnapshot;
        let b0 = touchData.transformVectorBox;
        if (!layer || !snap || !b0) return;
        let d = resizer.get();
        let sx = b0.w ? d.width / b0.w : 1;
        let sy = b0.h ? d.height / b0.h : 1;
        let rad = (d.rotation || 0) * Math.PI / 180;
        let cos = Math.cos(rad), sin = Math.sin(rad);
        let cx = d.left + d.width / 2, cy = d.top + d.height / 2;
        let off = ImageFile.getLayerOffset();  // geometry(layer) coords = document coords − offset

        layer.vector = cloneVector(snap);
        transformVector(layer.vector, (gx, gy)=>{
            // geometry → document
            let px = gx + off.x, py = gy + off.y;
            // scale about the original box's top-left into the new box position/size
            let qx = d.left + (px - b0.x) * sx;
            let qy = d.top  + (py - b0.y) * sy;
            // rotate about the new box centre
            let rx = cx + (qx - cx) * cos - (qy - cy) * sin;
            let ry = cy + (qx - cx) * sin + (qy - cy) * cos;
            // document → geometry
            return { x: rx - off.x, y: ry - off.y };
        });
        layer.vectorDirty = true;
        layer.vectorRasterized = false;
        EventBus.trigger(EVENT.vectorChanged);
        EventBus.trigger(EVENT.layerContentChanged);
    }

    // Document-space union of the opaque geometry bounds of several WHOLE vector layers (Layer
    // panel multi-selection, not a vector-tool point/line selection). Returns null when none of the
    // paths resolve to a non-empty vector layer. `groups` matches the shape
    // updateVectorSelectionTransform expects, minus `nodeIds` — its absence means "transform the
    // layer's entire geometry" (see below).
    function combinedVectorLayersBounds(paths){
        let target = ImageFile.getHistoryTarget();
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        let groups = [];
        paths.forEach(path=>{
            let layer = ImageFile.getLayerInTarget(target, path);
            if (!layer || !layer.vector) return;
            // Only reject a layer with NO geometry at all (vectorBounds returns null) — unlike the
            // single-layer fallback below, a layer whose own bounds are zero-area (e.g. a single
            // point) still contributes a real position to the UNION box, so it isn't skipped here.
            let vb = vectorBounds(layer.vector);
            if (!vb) return;
            let off = ImageFile.getLayerOffset(path);
            let x = vb.x + off.x, y = vb.y + off.y;
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x + vb.width > maxX) maxX = x + vb.width;
            if (y + vb.height > maxY) maxY = y + vb.height;
            groups.push({ path, layer, snapshot: cloneVector(layer.vector) });
        });
        if (groups.length < 2) return null;
        let width = maxX - minX, height = maxY - minY;
        if (!width || !height) return null; // every point across every selected layer coincides
        return { bounds: { x: minX, y: minY, width, height }, groups };
    }

    // Spec 018: a SELECTION-scoped vector free-transform, possibly spanning several layers. Same
    // box→affine mapping as updateVectorTransform, applied once per touched layer (each resolving its
    // own offset), but only to that layer's selected node ids (transformVectorSubset) instead of the
    // whole document — UNLESS the group carries no `nodeIds` (a Layer-panel multi-selection of whole
    // vector layers, see combinedVectorLayersBounds), in which case the layer's entire geometry moves
    // via transformVector. Re-applied from each layer's pristine snapshot every update, same as the
    // whole-document case.
    function updateVectorSelectionTransform(){
        let groups = touchData.transformVectorSelection;
        let b0 = touchData.transformVectorBox;
        if (!groups || !b0) return;
        let d = resizer.get();
        let sx = b0.width ? d.width / b0.width : 1;
        let sy = b0.height ? d.height / b0.height : 1;
        let rad = (d.rotation || 0) * Math.PI / 180;
        let cos = Math.cos(rad), sin = Math.sin(rad);
        let cx = d.left + d.width / 2, cy = d.top + d.height / 2;

        groups.forEach(g=>{
            if (!g.layer) return;
            let off = ImageFile.getLayerOffset(g.path);
            g.layer.vector = cloneVector(g.snapshot);
            let mapFn = (gx, gy)=>{
                let px = gx + off.x, py = gy + off.y;
                let qx = d.left + (px - b0.x) * sx;
                let qy = d.top + (py - b0.y) * sy;
                let rx = cx + (qx - cx) * cos - (qy - cy) * sin;
                let ry = cy + (qx - cx) * sin + (qy - cy) * cos;
                return { x: rx - off.x, y: ry - off.y };
            };
            if (g.nodeIds){
                transformVectorSubset(g.layer.vector, g.nodeIds, mapFn);
            }else{
                // Whole-layer group (Layer panel multi-selection) — move every node/curve/text.
                transformVector(g.layer.vector, mapFn);
            }
            g.layer.vectorDirty = true;
            g.layer.vectorRasterized = false;
        });
        EventBus.trigger(EVENT.vectorChanged);
        EventBus.trigger(EVENT.layerContentChanged);
    }

    async function updateTransform(final,onDone){
        if (touchData.transformVectorSelection){ updateVectorSelectionTransform(); return; }
        if (touchData.transformVector){ updateVectorTransform(); return; }
        if (!touchData.transformLayer) return;
        // A group carries a runtime transform instead of pixels — never bake it.
        if (touchData.transformGroup){ updateGroupTransform(); return; }
        console.log("update transform layer");
        let d = resizer.get();
        let box = touchData.transformBox;

        // Pure translation (no scale, no rotation): move the layer through its ANIMATABLE
        // OFFSET instead of copying pixels. On a property key that writes props, so the move
        // becomes part of the animation rather than a destructive edit (spec 004 decision 2).
        if (!d.rotation && box && d.width === box.w && d.height === box.h && touchData.transformStartProps){
            let hasMulti = touchData.transformMultiPaths && touchData.transformMultiPaths.length;
            if (!touchData.transformIsMove){
                touchData.transformIsMove = true;
                // swap the pixel snapshot for a property snapshot, before the first write
                HistoryService.neverMind();
                if (hasMulti){
                    let allPaths = [ImageFile.getActiveLayerPath().slice()]
                        .concat(touchData.transformMultiPaths.map(entry => entry.path));
                    HistoryService.start(EVENT.keyPropsGroupHistory, allPaths);
                }else{
                    HistoryService.start(EVENT.keyPropsHistory);
                }
            }
            let dx = d.left - box.x;
            let dy = d.top - box.y;
            ImageFile.setLayerKeyProps(undefined,{
                x: touchData.transformStartProps.x + dx,
                y: touchData.transformStartProps.y + dy
            });
            if (hasMulti){
                touchData.transformMultiPaths.forEach(entry=>{
                    ImageFile.setLayerKeyProps(entry.path,{
                        x: entry.startProps.x + dx,
                        y: entry.startProps.y + dy
                    });
                });
            }
            return;
        }

        touchData.transformLayer.clear();
        if (d.width === 0 || d.height === 0) return;
        let ctx = touchData.transformLayer.getContext();

        let smooth = ToolOptions.isSmooth();
        let pixelOptimized = ToolOptions.isPixelPerfect();
        if (pixelOptimized) smooth = false;

        ctx.imageSmoothingEnabled = smooth;


        let angled = d.rotation && (d.rotation % 90 !== 0);
        let useHQ = final && pixelOptimized && angled && touchData.transformCanvas.width<=512 && touchData.transformCanvas.height<=512;

        if (useHQ){
            if (!rotSprite){
                rotSprite = await import("../paintTools/rotSprite.js");
                rotSprite = rotSprite.default;
            }
            let rotated = await rotSprite(touchData.transformCanvas,d.rotation);
            let rotateScaleX = touchData.transformCanvas.width / rotated.width;
            let rotateScaleY = touchData.transformCanvas.height / rotated.height;

            let w = d.width / rotateScaleX;
            let h = d.height / rotateScaleY;

            let moveOffset = ImageFile.getLayerOffset();
            let x = d.left - moveOffset.x - (touchData.transformLayer?.canvasX || 0) + (d.width - w) / 2;
            let y = d.top - moveOffset.y - (touchData.transformLayer?.canvasY || 0) + (d.height - h) / 2;

            if (Palette.isLocked()){
                // rotated is a WEBGL canvas
                rotated = duplicateCanvas(rotated,true);
                Palette.applyToCanvas(rotated);
            }

            ctx.drawImage(rotated,x,y,w,h);
        }else{
            let drawOffset = ImageFile.getLayerOffset();
            let localLeft = d.left - drawOffset.x - (touchData.transformLayer?.canvasX || 0);
            let localTop = d.top - drawOffset.y - (touchData.transformLayer?.canvasY || 0);
            if (d.rotation){
                console.log("rotate " + d.rotation);

                let dw = (localLeft + d.width/2);
                let dh = (localTop + d.height/2);
                ctx.translate(dw,dh);
                ctx.rotate((d.rotation * Math.PI) / 180);
                ctx.translate(-dw,-dh);
            }

            ctx.drawImage(touchData.transformCanvas,localLeft,localTop,d.width,d.height);
            ctx.setTransform(1, 0, 0, 1, 0, 0);

            if (angled && final && Palette.isLocked()){
                Palette.applyToCanvas(ctx.canvas,true);
            }
        }
        EventBus.trigger(EVENT.layerContentChanged);
    }

    function resetTransform(){
        // Cancelling a SELECTION-scoped vector free-transform (spec 018): restore each touched layer's
        // geometry snapshot (no pixels were touched).
        if (touchData.transformVectorSelection){
            touchData.transformVectorSelection.forEach(g=>{
                if (!g.layer || !g.snapshot) return;
                g.layer.vector = cloneVector(g.snapshot);
                g.layer.vectorDirty = true;
                g.layer.vectorRasterized = false;
            });
            EventBus.trigger(EVENT.vectorChanged);
            EventBus.trigger(EVENT.layerContentChanged);
            return;
        }
        // Cancelling a vector free-transform: restore the geometry snapshot (no pixels were touched).
        if (touchData.transformVector){
            let layer = touchData.transformVector;
            if (touchData.transformVectorSnapshot){
                layer.vector = cloneVector(touchData.transformVectorSnapshot);
                layer.vectorDirty = true;
                layer.vectorRasterized = false;
                EventBus.trigger(EVENT.vectorChanged);
                EventBus.trigger(EVENT.layerContentChanged);
            }
            return;
        }
        // Cancelling a group free-transform (spec 007): restore the transform props captured at
        // gesture start (no pixels were touched).
        if (touchData.transformGroup){
            let sp = touchData.transformStartProps;
            if (sp){
                ImageFile.setLayerKeyProps(undefined,{
                    x: sp.x, y: sp.y, scaleX: sp.scaleX, scaleY: sp.scaleY, rotation: sp.rotation
                });
            }
            return;
        }
        if (touchData.transformIsMove){
            // nothing was painted: just put the offset back
            if (touchData.transformStartProps){
                ImageFile.setLayerKeyProps(undefined,{
                    x: touchData.transformStartProps.x,
                    y: touchData.transformStartProps.y
                });
            }
            if (touchData.transformMultiPaths){
                touchData.transformMultiPaths.forEach(entry=>{
                    ImageFile.setLayerKeyProps(entry.path,{
                        x: entry.startProps.x,
                        y: entry.startProps.y
                    });
                });
            }
            return;
        }
        touchData.transformLayer.clear();
        let ctx = touchData.transformLayer.getContext();
        let box = touchData.transformBox;
        ctx.imageSmoothingEnabled = false;
        let resetOffset = ImageFile.getLayerOffset();
        ctx.drawImage(touchData.transformCanvas,box.x - resetOffset.x,box.y - resetOffset.y,box.w,box.h);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        EventBus.trigger(EVENT.layerContentChanged);
    }

    function clearTransform(){
        touchData.transformBox = undefined;
        if (touchData.transformCanvas) releaseCanvas(touchData.transformCanvas);
        touchData.transformLayer = undefined;
        touchData.transformIsMove = false;
        touchData.transformStartProps = undefined;
        touchData.transformGroup = false;
        touchData.transformGroupBox = undefined;
        touchData.transformVector = undefined;
        touchData.transformVectorSnapshot = undefined;
        touchData.transformVectorSelection = undefined;
        touchData.transformVectorBox = undefined;
        touchData.transformVectorResume = undefined;
        touchData.transformMultiPaths = undefined;
    }


    return me;
}();

export default Editor;
