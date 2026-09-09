import {$div} from "../../util/dom.js";
import Selection from "../selection.js";
import EventBus from "../../util/eventbus.js";
import {COMMAND, EVENT} from "../../enum.js";
import Editor from "../editor.js";
import ImageFile from "../../image.js";
import Input from "../input.js";
import {duplicateCanvas, releaseCanvas, outLineCanvas} from "../../util/canvasUtils.js";
import Color from "../../util/color.js";
import ToolOptions from "./toolOptions.js";
import Palette from "../palette.js";
import {computeFloodRegion} from "../../util/fillKernel.js";
import HistoryService from "../../services/historyservice.js";
import {isVector} from "../../util/layerUtils.js";

/*
    SelectBox follows changes in the selection.
    If the resize is active, the resize triggers a change in the selection, this triggers a change in the selectbox.

    There are 3 different types of selection:
    - rectangle selection, this is also calculated as a bounding box for the other types
    - polygon selection, this is a series of points
    - canvas selection, this is a selection of pixels
 */

let SelectBox = ((editor,resizer)=>{
    let me = {};

    let box = $div("selectbox");
    let canvas;
    let ctx;
    let selectionPoints = [];
    let selectionTransform;
    let selecting;
    let dots;
    let shape;
    let selectionTool;
    let timeout;
    let selectionMode = "replace"; // "replace", "add", "subtract"
    let pendingBaseSelection;
    let pendingNewRect;

    let border = $div("border","<svg xmlns='http://www.w3.org/2000/svg' viewbox='0 0 40 40' preserveAspectRatio='none'><rect class='white' width='40' height='40'/><rect class='ants'  width='40' height='40'/>/svg>");
    box.appendChild(border);

    let border2 = $div("border","<svg xmlns='http://www.w3.org/2000/svg' viewbox='0 0 40 40' preserveAspectRatio='none'><rect class='white' width='40' height='40'/><rect class='ants'  width='40' height='40'/>/svg>");
    box.appendChild(border2);

    let content = $div("content");
    box.appendChild(content);

    me.getBox = ()=>{
        return box;
    }

    me.activate = (tool)=>{
        if (tool) selectionTool = tool;
        let currentSelection = Selection.get();
        box.classList.add("active");

        if (currentSelection){
            switch (tool){
                case COMMAND.SELECT:
                    if (editor.isActive()){
                        resizer.init({
                            x:currentSelection.left,
                            y:currentSelection.top,
                            width:currentSelection.width,
                            height:currentSelection.height,
                            rotation:0,
                            aspectRatio:1,
                            canRotate: false
                        });
                    }
                    break;
                case COMMAND.POLYGONSELECT:
                    if (currentSelection.points){
                        clearTimeout(timeout);
                        resizer.remove();
                        me.polySelect();
                    }
                    break;
                case COMMAND.FLOODSELECT:
                    resizer.remove();
                    break;
                case COMMAND.COLORSELECT:
                case COMMAND.COLORSELECT_NOT_PALETTE:
                    resizer.remove();
                    break;
                case COMMAND.TOSELECTION:
                    resizer.remove();
                    break;
            }
        }
    }

    me.deActivate = ()=>{
        box.classList.remove("active","capture");
        cleanUp();
    }

    me.isActive = ()=>{
        return box.classList.contains("active");
    }

    me.startCombine = (mode)=>{
        pendingBaseSelection = Selection.get();
        selectionMode = mode;
    }

    me.hasPendingCombine = ()=>{
        return selectionMode !== "replace";
    }

    // newRect: explicit new rect for rect-select combine; omit for polygon/flood (uses Selection.get())
    me.finalizeCombine = (newRect)=>{
        if (selectionMode === "replace"){
            pendingNewRect = undefined;
            return;
        }
        let mode = selectionMode;
        let base = pendingBaseSelection;
        selectionMode = "replace";
        pendingBaseSelection = undefined;
        pendingNewRect = undefined;
        border2.classList.remove("active","filled");

        // For rect-select, newRect is passed explicitly.
        // For polygon/flood, it's omitted and we read from the current Selection.
        let newSelection = newRect || Selection.get();

        if (!base){
            if (mode === "subtract"){
                Selection.clear();
            } else if (newRect){
                Selection.set(newRect);
            }
            return;
        }
        if (!newSelection){
            // No new selection drawn: restore base
            Selection.set(base);
            return;
        }

        let w = ImageFile.getCurrentFile().width;
        let h = ImageFile.getCurrentFile().height;
        let baseCanvas = selectionToCanvas(base, w, h);
        let newCanvas = selectionToCanvas(newSelection, w, h);

        let result = document.createElement("canvas");
        result.width = w;
        result.height = h;
        let resultCtx = result.getContext("2d");

        if (mode === "add"){
            resultCtx.drawImage(baseCanvas, 0, 0);
            resultCtx.drawImage(newCanvas, 0, 0);
        } else {
            resultCtx.drawImage(baseCanvas, 0, 0);
            resultCtx.globalCompositeOperation = "destination-out";
            resultCtx.drawImage(newCanvas, 0, 0);
            resultCtx.globalCompositeOperation = "source-over";
        }

        resultCtx.globalCompositeOperation = "source-in";
        resultCtx.fillStyle = "white";
        resultCtx.fillRect(0, 0, w, h);
        resultCtx.globalCompositeOperation = "source-over";

        let outline = outLineCanvas(resultCtx, false);
        if (outline.box.w <= 0 || outline.box.h <= 0){
            Selection.clear();
        } else {
            Selection.set({
                left: outline.box.x,
                top: outline.box.y,
                width: outline.box.w,
                height: outline.box.h,
                canvas: result,
                outline: outline.lines
            });
        }
    }

    me.boundingBoxSelect = (point)=>{
        if (selectionMode === "replace"){
            EventBus.trigger(COMMAND.CLEARSELECTION);
        }
        me.activate(COMMAND.SELECT);
        resizer.init({
            x: point.x,
            y: point.y,
            width: 0,
            height: 0,
            rotation: 0,
            hot: true,
            aspect: 1,
            canRotate: false,
        });
    }

    me.polySelect = (point)=>{
        if (!dots) dots = $div("dots","",content);

        if (!selecting){
            let currentSelection = Selection.get();
            if (selectionMode === "replace" && currentSelection && currentSelection.points && currentSelection.points.length){
                selectionPoints = currentSelection.points;
            }else{
                selectionPoints = [];
            }
            Input.setActiveKeyHandler(keyHandler);
        }
        selecting = true;
        border.classList.remove("active","filled");
        box.classList.add("capture","active");

        if (point){
            selectionPoints.push(point);
            if (selectionPoints.length===1) selectionPoints.push({x:point.x,y:point.y});
        }

        updateBoundingBox();
        drawPolyShape();
    }

    me.endPolySelect = (fromClick)=>{
        selecting = false;
        me.finalizeCombine();
        timeout = setTimeout(()=>{
            EventBus.trigger(EVENT.endPolygonSelect);
            Input.setActiveKeyHandler();
            selectionPoints = [];
            if (dots){
                dots.innerHTML = "";
                dots = undefined;
            }
            box.classList.remove("capture");
        },fromClick?100:0);
    }

    // Don't overuse this function, it's expensive
    me.applyCanvas = _canvas=>{
        let selectedCanvas = duplicateCanvas(_canvas,true);
        let selectedCtx = selectedCanvas.getContext("2d");

        selectedCtx.globalCompositeOperation = "source-in";
        selectedCtx.fillStyle = "white";
        selectedCtx.fillRect(0,0,_canvas.width,_canvas.height);
        selectedCtx.globalCompositeOperation = "source-over";

        // generate SVG outline..; Expensive! move to webworker?
        let outline = outLineCanvas(selectedCtx,false);

        Selection.set({
            left:outline.box.x,
            top: outline.box.y,
            width: outline.box.w,
            height: outline.box.h,
            canvas: selectedCanvas,
            outline: outline.lines
        })
    }


    me.floodSelect = function(canvas,point,fillColor){
        // Spec 016 phase 3 (R4): the connectivity walk now runs in the pure span
        // kernel (util/fillKernel.js) instead of an inline hash-set + shift() queue.
        // The matching predicate is byte-identical (exact 4-channel match, else
        // Euclidean RGBA distance <= tolerance*2), so the painted result is
        // unchanged; only the traversal is faster and bounded.
        let isFloodFill = !!fillColor;
        let useGlobalFloodSelect = !isFloodFill && ToolOptions.useFloodSelectGlobal();
        fillColor = fillColor||[0,0,0];
        let w = canvas.width;
        let h = canvas.height;
        let imageData = canvas.getContext("2d").getImageData(0,0,w,h);
        let tolerance = ToolOptions.getTolerance();
        fillColor[3] = 255;

        let c = duplicateCanvas(canvas).getContext("2d");
        let target = c.getImageData(0,0,w,h);

        let startIndex = point.y*w + point.x;
        let region = computeFloodRegion({
            data: imageData.data,
            width: w,
            height: h,
            startIndex: startIndex,
            tolerance: tolerance,
            connectivity: 4,
            global: useGlobalFloodSelect
        });

        let matched = region.matched;
        for (let i=0;i<matched.length;i++){
            if (matched[i]){
                target.data[i*4] = fillColor[0];
                target.data[i*4 + 1] = fillColor[1];
                target.data[i*4 + 2] = fillColor[2];
                target.data[i*4 + 3] = 255;
            }
        }

        c.putImageData(target,0,0);
        return c.canvas;
    }


    me.colorSelect = function(color){
        // selections live in DOCUMENT space, so read the layer projected into it
        let canvas = ImageFile.getActiveLayerDocCanvas();

        let w = canvas.width;
        let h = canvas.height;
        let imageData = canvas.getContext("2d").getImageData(0,0,w,h);

        let c = duplicateCanvas(canvas).getContext("2d");
        let target = c.getImageData(0,0,w,h);
        color = Color.fromString(color);

        for (let x = 0;x<w;x++){
            for (let y = 0;y<h;y++){
                let index = (y*w + x)*4;
                let r = imageData.data[index];
                let g = imageData.data[index+1];
                let b = imageData.data[index+2];
                let a = imageData.data[index+3];
                if (a && r===color[0] && g===color[1] && b===color[2]){
                    target.data[index] = 255;
                    target.data[index+1] = 255;
                    target.data[index+2] = 255;
                    target.data[index+3] = 255;
                }
            }
        }
        c.putImageData(target,0,0);
        me.applyCanvas(c.canvas);
    }

    me.colorSelectNotInPalette = function(){
        let canvas = ImageFile.getActiveLayerDocCanvas();
        let palette = Palette.get();

        let w = canvas.width;
        let h = canvas.height;
        let imageData = canvas.getContext("2d").getImageData(0,0,w,h);

        let c = duplicateCanvas(canvas).getContext("2d");
        let target = c.getImageData(0,0,w,h);

        let paletteStrings = new Set();
        palette.forEach(col => {
            let c = col;
            if (typeof c === "string") c = Color.fromString(c);
            if (c) paletteStrings.add(c[0] + "," + c[1] + "," + c[2]);
        });

        for (let x = 0;x<w;x++){
            for (let y = 0;y<h;y++){
                let index = (y*w + x)*4;
                let r = imageData.data[index];
                let g = imageData.data[index+1];
                let b = imageData.data[index+2];
                let a = imageData.data[index+3];

                if (a) {
                    let colorKey = r + "," + g + "," + b;
                    if (!paletteStrings.has(colorKey)){
                        target.data[index] = 255;
                        target.data[index+1] = 255;
                        target.data[index+2] = 255;
                        target.data[index+3] = 255;
                    }
                }
            }
        }
        c.putImageData(target,0,0);
        me.applyCanvas(c.canvas);
    }

    me.alphaSelect = function(){
        let canvas = ImageFile.getActiveLayerDocCanvas();

        let w = canvas.width;
        let h = canvas.height;
        let imageData = canvas.getContext("2d").getImageData(0,0,w,h);

        let c = duplicateCanvas(canvas).getContext("2d");
        let target = c.getImageData(0,0,w,h);

        for (let x = 0;x<w;x++){
            for (let y = 0;y<h;y++){
                let index = (y*w + x)*4;
                let a = imageData.data[index+3];
                if (a<255){
                    target.data[index] = 255;
                    target.data[index+1] = 255;
                    target.data[index+2] = 255;
                    target.data[index+3] = 255;
                }
            }
        }
        c.putImageData(target,0,0);
        me.applyCanvas(c.canvas);
    }

    function updateCombineBox(){
        if (selectionMode !== "replace" && pendingNewRect && pendingNewRect.width > 0 && pendingNewRect.height > 0){
            let zoom = editor.getZoom();
            border2.style.left = pendingNewRect.left * zoom + "px";
            border2.style.top = pendingNewRect.top * zoom + "px";
            border2.style.width = pendingNewRect.width * zoom + "px";
            border2.style.height = pendingNewRect.height * zoom + "px";
            border2.classList.add("active");
        } else {
            border2.classList.remove("active","filled");
        }
    }

    function renderSelection(){
        let selection = Selection.get();
        let zoom = editor.getZoom();
        let showOutline = ToolOptions.showSelectionOutline();
        let showFill = ToolOptions.showSelectionMask();

        border.classList.remove("active");
        border.classList.remove("filled");
        if (shape) shape.innerHTML = "";
        if (canvas && ctx) ctx.clearRect(0,0,canvas.width,canvas.height);

        if (selection){
            if (selection.points && selection.points.length){
                selectionPoints = selection.points;
                drawPolyShape();
            }else if (selection.canvas) {
                if (showFill){
                    if (!canvas){
                        canvas = duplicateCanvas(ImageFile.getCanvas());
                        content.appendChild(canvas);
                        ctx = canvas.getContext("2d");
                    }
                    ctx.globalAlpha = 0.5;
                    ctx.drawImage(selection.canvas,0,0);
                    ctx.globalCompositeOperation = "source-in";
                    ctx.fillStyle = "red";
                    ctx.fillRect(0,0,canvas.width,canvas.height);
                    ctx.globalCompositeOperation = "source-over";
                }

                if (showOutline){
                    if (selection.outline){
                        drawOutline(selection);
                    }
                }
            }else{
                border.style.left = selection.left*zoom + "px";
                border.style.top = selection.top*zoom + "px";
                border.style.width = selection.width*zoom + "px";
                border.style.height = selection.height*zoom + "px";
                if (showOutline) border.classList.add("active");
                if (showFill) border.classList.add("filled");

            }

            if (selectionTool === COMMAND.SELECT && resizer.isActive()){
                let r = resizer.get();
                if (r && (r.left !== selection.left || r.top !== selection.top || r.width !== selection.width || r.height !== selection.height)){
                    let sx = selection.left, sy = selection.top, sw = selection.width, sh = selection.height;
                    let doInit = ()=>{
                        resizer.init({x:sx, y:sy, width:sw, height:sh, rotation:0, aspectRatio:1, canRotate:false, silent:true});
                    };
                    // Defer when Shift+pointer-down to avoid the square-constraint in updateSizeBox
                    // corrupting the combined selection bounds (pointer-down class is removed after onDragEnd returns)
                    if (Input.isShiftDown() && Input.isPointerDown()){
                        setTimeout(doInit, 0);
                    } else {
                        doInit();
                    }
                }
            }
        }else{
            me.deActivate();
        }
        updateCombineBox();
    }

    me.zoom = (zoom)=>{
        resizer.zoom();
        renderSelection();
    }

    me.updatePoint =(point,index)=>{
        if (typeof index === "undefined") index = selectionPoints.length-1;
        let p = selectionPoints[index];
        if (p){
            p.x = point.x;
            p.y = point.y;
        }
        updateBoundingBox();
        drawPolyShape();
    }

    function drawPolyShape(){
        let zoom = Editor.getActivePanel().getZoom();
        let drawOutline = ToolOptions.showSelectionOutline();
        let drawFill = ToolOptions.showSelectionMask();
        let generateSVG = drawOutline || drawFill;

        if (dots) dots.innerHTML = "";
        let w = ImageFile.getCurrentFile().width;
        let h = ImageFile.getCurrentFile().height;

        let path = "";

        selectionPoints.forEach((point,index)=>{
            if (dots){
                let dot = $div("sizedot","",dots,()=>{

                });
                dot.onDragStart = (x,y)=>{
                    point.startX = point.x;
                    point.startY = point.y;
                }
                dot.onDrag = (x,y)=>{
                    point.x = Math.round(point.startX + x/zoom);
                    point.y = Math.round(point.startY + y/zoom);
                    drawPolyShape();
                }
                dot.onDragEnd = ()=>{
                    updateBoundingBox();
                }
                dot.style.left = point.x*zoom + "px";
                dot.style.top = point.y*zoom + "px";
            }


            if (generateSVG) path += point.x + " " + point.y + " ";

        });

        if (generateSVG){
            if (!shape) shape = $div("shape","",content);
            // close the path
            if (selectionPoints.length>1){
                path += selectionPoints[0].x + " " + selectionPoints[0].y + " ";
            }

            let svg = "<svg xmlns='http://www.w3.org/2000/svg' viewbox='0 0 "+w+" " + h +"' preserveAspectRatio='none'>";

            let className = "";
            if (drawOutline) className = "white";
            if (drawFill) className += " filled";


            svg += "<path class='"+className+"' d='M" + path + "'/>";
            if (drawOutline) svg += "<path class='ants' d='M" + path + "'/>";
            svg += "</svg>";

            shape.innerHTML = svg;
        }else{
            if (shape){
                shape.innerHTML = "";
                shape = undefined;
            }
        }

    }

    function drawOutline(selection){
        if (!selection) return;
        let lines = selection.outline;
        if (!lines) return;

        if (!shape) shape = $div("shape","",content);
        let w = ImageFile.getCurrentFile().width;
        let h = ImageFile.getCurrentFile().height;

        let svg = "<svg xmlns='http://www.w3.org/2000/svg' viewbox='0 0 "+w+" "+h+"' preserveAspectRatio='none'>";
        if (lines.length>6000){
            console.warn("too many lines, displaying bounding box instead");

            svg += '<rect x="'+selection.left+'" y="'+selection.top+'" width="'+selection.width+'" height="'+selection.height+'" class="white" />';
            svg += '<rect x="'+selection.left+'" y="'+selection.top+'" width="'+selection.width+'" height="'+selection.height+'" class="ants" />';

        }else{
            // draw lines
            lines.forEach(h=>{
                let x = h[0];
                let y = h[1];
                let x2 = h[2];
                let y2 = h[3];
                svg += '<line x1="'+x+'" y1="'+y+'" x2="'+x2+'" y2="'+y2+'" class="white" />';
                svg += '<line x1="'+x+'" y1="'+y+'" x2="'+x2+'" y2="'+y2+'" class="ants" />';
            });

        }

        svg += "</svg>"
        shape.innerHTML = svg;
    }


    function keyHandler(code){
        //console.error(code);
        if (selecting){
            switch (code){
                case "keyj":
                    EventBus.trigger(COMMAND.TOLAYER)
                    return true;
                case "keyk":
                    EventBus.trigger(COMMAND.CUTTOLAYER)
                    return true;
                case "escape":
                    me.endPolySelect();
                    return true;
                case "enter":
                    me.endPolySelect();
                    return true;
            }
        }
    }

    EventBus.on(EVENT.sizerEndChange,()=>{
        endPixelFloat();
    });

    function cleanUp(){
        endPixelFloat();
        selectionPoints = [];
        selectionTransform = undefined;
        if (dots){
            dots.innerHTML = "";
            dots = undefined;
        }
        if (shape){
            shape.innerHTML = "";
            shape = undefined;
        }
        if (canvas){
            canvas.remove();
            releaseCanvas(canvas);
            canvas = undefined;
        }
        content.innerHTML = "";
        border.classList.remove("active");
        border.classList.remove("filled");
        border2.classList.remove("active","filled");

        if (selecting){
            selecting = false;
            me.endPolySelect();
        }
    }

    // Ctrl-drag on the selection body or on a resize handle (move/scale selected pixels, not just
    // the marquee): conceptually "cut, transform, merge back" in one drag. The layer pixels under
    // the selection are lifted into a floating buffer ONCE (at the drag's start position/size) and
    // the source pixels are cleared to transparent there ONCE too — that "background" snapshot
    // never changes afterwards. Every subsequent frame just redraws background + floating,
    // remapped to the live drag rect, so the hole only ever exists at the original position/size,
    // never at any position/size passed through mid-drag. Both are baked back into the layer as
    // one history step when the drag commits (on drag end, or earlier if Ctrl is released first).
    let pixelFloat;

    function startPixelFloat(selection){
        let layer = ImageFile.getActiveLayer();
        if (!layer || layer.locked || layer.type === "group" || isVector(layer)) return;
        if (!selection.width || !selection.height) return;
        let layerCtx = layer.getContext();
        let offset = ImageFile.getLayerOffset();
        let w = ImageFile.getCurrentFile().width;
        let h = ImageFile.getCurrentFile().height;

        let mask = selectionToCanvas(selection, w, h);
        let original = duplicateCanvas(layerCtx.canvas, true);

        let floating = document.createElement("canvas");
        floating.width = layerCtx.canvas.width;
        floating.height = layerCtx.canvas.height;
        let fctx = floating.getContext("2d");
        fctx.drawImage(original,0,0);
        fctx.globalCompositeOperation = "destination-in";
        fctx.drawImage(mask,-offset.x,-offset.y);
        fctx.globalCompositeOperation = "source-over";

        let background = document.createElement("canvas");
        background.width = layerCtx.canvas.width;
        background.height = layerCtx.canvas.height;
        let bctx = background.getContext("2d");
        bctx.drawImage(original,0,0);
        bctx.globalCompositeOperation = "destination-out";
        bctx.drawImage(mask,-offset.x,-offset.y);
        bctx.globalCompositeOperation = "source-over";

        releaseCanvas(original);
        releaseCanvas(mask);

        HistoryService.start(EVENT.layerContentHistory);

        pixelFloat = {
            layerCtx: layerCtx,
            background: background,
            floating: floating,
            offset: offset,
            origLeft: selection.left,
            origTop: selection.top,
            origWidth: selection.width,
            origHeight: selection.height
        };
    }

    // newLeft/Top/Width/Height are the LIVE drag rect (document space, same shape as Selection).
    // Moving is just the degenerate case of this same mapping (scale 1, pure translate).
    function updatePixelFloat(newLeft,newTop,newWidth,newHeight){
        if (!pixelFloat) return;
        let scaleX = newWidth / pixelFloat.origWidth;
        let scaleY = newHeight / pixelFloat.origHeight;
        if (!isFinite(scaleX)) scaleX = 1;
        if (!isFinite(scaleY)) scaleY = 1;

        // Map layer-space point (origLeft-offset, origTop-offset) — the original selection's
        // top-left, in the floating canvas's own coordinate space — to where the live rect's
        // top-left now is, scaling everything else around that anchor.
        let origLeftLayer = pixelFloat.origLeft - pixelFloat.offset.x;
        let origTopLayer = pixelFloat.origTop - pixelFloat.offset.y;
        let newLeftLayer = newLeft - pixelFloat.offset.x;
        let newTopLayer = newTop - pixelFloat.offset.y;
        let dx = newLeftLayer - origLeftLayer*scaleX;
        let dy = newTopLayer - origTopLayer*scaleY;

        let ctx = pixelFloat.layerCtx;
        ctx.clearRect(0,0,ctx.canvas.width,ctx.canvas.height);
        ctx.drawImage(pixelFloat.background,0,0);
        ctx.imageSmoothingEnabled = ToolOptions.isSmooth();
        ctx.drawImage(pixelFloat.floating,dx,dy,pixelFloat.floating.width*scaleX,pixelFloat.floating.height*scaleY);
        ctx.imageSmoothingEnabled = false;
        EventBus.trigger(EVENT.layerContentChanged);
        EventBus.trigger(EVENT.imageContentChanged);
    }

    function endPixelFloat(){
        if (!pixelFloat) return;
        releaseCanvas(pixelFloat.background);
        releaseCanvas(pixelFloat.floating);
        pixelFloat = undefined;
        HistoryService.end();
    }

    function selectionToCanvas(selection, w, h){
        let c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        let ctx = c.getContext("2d");
        ctx.fillStyle = "white";
        if (selection.canvas){
            ctx.drawImage(selection.canvas, 0, 0);
        } else if (selection.points && selection.points.length){
            ctx.beginPath();
            selection.points.forEach((point, index)=>{
                if (index) ctx.lineTo(point.x, point.y);
                else ctx.moveTo(point.x, point.y);
            });
            ctx.closePath();
            ctx.fill();
        } else {
            ctx.fillRect(selection.left, selection.top, selection.width, selection.height);
        }
        return c;
    }

    function updateBoundingBox(){
        let x = ImageFile.getCurrentFile().width;
        let y = ImageFile.getCurrentFile().height;
        let x2 = 0;
        let y2 = 0;
        if (selectionPoints && selectionPoints.length){
            selectionPoints.forEach(point=>{
                if (point.x<x) x = point.x;
                if (point.y<y) y = point.y;
                if (point.x>x2) x2 = point.x;
                if (point.y>y2) y2 = point.y;
            });
            // warning; this updates the selection, which triggers a change in the selectbox
            Selection.set({left: x, top: y, width: x2-x, height: y2-y, points: selectionPoints});
        }
    }

    EventBus.on(EVENT.sizerStartChange,()=>{
        if (me.isActive()  && editor.isActive()){
            // Safety net: a new drag gesture is starting, so any pixel float left dangling by a
            // previous one (should already be closed by sizerEndChange) must not bleed into it.
            endPixelFloat();
            let selection = Selection.get();
            if (selection.canvas){
                selectionTransform = {
                    left: selection.left,
                    top: selection.top,
                    width: selection.width,
                    height: selection.height,
                    canvas: duplicateCanvas(selection.canvas,true)
                }
                if (selection.outline){
                    selectionTransform.outline = selection.outline.map(a=>a.slice());
                }
            }
        }
    });

    EventBus.on(EVENT.sizerChanged,(change)=>{
        if (me.isActive() && editor.isActive()){
            if (selectionMode !== "replace"){
                pendingNewRect = change.to;
                updateCombineBox();
                return;
            }
            let fromSize = change.from;
            let currentSize = change.to;
            if (currentSize){
                let selection = Selection.get();
                let handled = false;
                if (fromSize && selection){
                    let translate = {x:0,y:0,scale:1};
                    translate.x =  currentSize.left - fromSize.left;
                    translate.y = currentSize.top - fromSize.top;
                    translate.scaleX = currentSize.width/fromSize.width;
                    translate.scaleY = currentSize.height/fromSize.height;
                    if (isNaN(translate.scaleX)) translate.scaleX = 1;
                    if (isNaN(translate.scaleY)) translate.scaleY = 1;

                    // change.dotIndex (8 = whole-box move, 0-7 = a resize handle) is only set by an
                    // actual pointer drag on the sizebox/a handle (resizer.js) — never by resizer
                    // init, an arrow-key nudge, or the shift-aspect-lock replay on modifier change.
                    // Inferring "is this a drag frame" from the from/to deltas instead is ambiguous:
                    // a single-axis resize handle leaves the other axis unchanged all gesture long,
                    // and any momentarily-stationary frame leaves both unchanged, so either can look
                    // identical to a pure move. dotIndex sidesteps that entirely, and — since a move
                    // is just a resize with scale 1 — the same updatePixelFloat handles both.
                    let isDragFrame = typeof change.dotIndex === "number";
                    if (isDragFrame && Input.isControlDown()){
                        if (!pixelFloat) startPixelFloat(selection);
                        if (pixelFloat) updatePixelFloat(currentSize.left, currentSize.top, currentSize.width, currentSize.height);
                    } else if (pixelFloat && isDragFrame){
                        endPixelFloat();
                    }

                    if (selection.points && selection.points.length){
                        selectionPoints = selection.points;
                        if (translate.x || translate.y){
                            selectionPoints.forEach(point=>{
                                point.x += translate.x;
                                point.y += translate.y;
                            });
                        }
                        if (translate.scaleX!==1 || translate.scaleY!==1){
                            let startX = currentSize.left;
                            let startY = currentSize.top;

                            selectionPoints.forEach(point=>{
                                point.x = startX + Math.round((point.x-startX)*translate.scaleX);
                                point.y = startY + Math.round((point.y-startY)*translate.scaleY);
                            });
                        }

                        currentSize.points = selectionPoints;
                        Selection.set(currentSize);
                        handled = true;
                    }else if (selection.canvas){
                        if (translate.scaleX!==1 || translate.scaleY!==1 || translate.x || translate.y){
                            // scale the original selection canvas and outline
                            let deltaScaleX = currentSize.width/selectionTransform.width;
                            let deltaScaleY = currentSize.height/selectionTransform.height;

                            if (selection.outline && selectionTransform.outline){
                                for (let i = 0;i<selection.outline.length;i++){
                                    selection.outline[i][0] = currentSize.left + Math.round((selectionTransform.outline[i][0]-selectionTransform.left)*deltaScaleX);
                                    selection.outline[i][1] = currentSize.top + Math.round((selectionTransform.outline[i][1]-selectionTransform.top)*deltaScaleY);
                                    selection.outline[i][2] = currentSize.left + Math.round((selectionTransform.outline[i][2]-selectionTransform.left)*deltaScaleX);
                                    selection.outline[i][3] = currentSize.top + Math.round((selectionTransform.outline[i][3]-selectionTransform.top)*deltaScaleY);
                                }
                                currentSize.outline = selection.outline;
                            }

                            if (selectionTransform.canvas){
                                let offsetX = selectionTransform.left*deltaScaleX - currentSize.left;
                                let offsetY = selectionTransform.top*deltaScaleY - currentSize.top;
                                let c = duplicateCanvas(selectionTransform.canvas);
                                let ctx = c.getContext("2d");
                                ctx.clearRect(0,0,c.width,c.height);
                                ctx.drawImage(selectionTransform.canvas,-offsetX,-offsetY,c.width*deltaScaleX,c.height*deltaScaleY);
                                currentSize.canvas = c;
                            }

                            Selection.set(currentSize);
                            handled = true;
                        }
                    }
                }

                if (!handled){
                    // set the bounding box
                    if (selection){
                        selection.left = currentSize.left;
                        selection.top = currentSize.top;
                        selection.width = currentSize.width;
                        selection.height = currentSize.height;
                        Selection.set(selection);
                    }else{
                        Selection.set(currentSize);
                    }

                }
            }
        }
    })


    EventBus.on(EVENT.selectionChanged,()=>{
        if (!editor.isVisible()) return;
        if (!me.isActive()) return;
        renderSelection();
    });

    EventBus.on(EVENT.toolChanged,(tool)=>{
        if (me.isActive()){
            endPixelFloat();
            selectionTransform = undefined;
            selectionMode = "replace";
            pendingBaseSelection = undefined;
            box.classList.remove("capture");
            resizer.remove();
        }
    });


    return me;
});

export default SelectBox;