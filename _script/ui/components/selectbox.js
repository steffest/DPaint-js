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

    let border = $div("border","<svg xmlns='http://www.w3.org/2000/svg' viewbox='0 0 40 40' preserveAspectRatio='none'><rect class='white' width='40' height='40'/><rect class='ants'  width='40' height='40'/>/svg>");
    box.appendChild(border);

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

    me.boundingBoxSelect = (point)=>{
        EventBus.trigger(COMMAND.CLEARSELECTION);
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
            if (currentSelection && currentSelection.points && currentSelection.points.length){
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
        fillColor = fillColor||[0,0,0];
        let w = canvas.width;
        let h = canvas.height;
        let imageData = canvas.getContext("2d").getImageData(0,0,w,h);
        let tolerance = ToolOptions.getTolerance();
        fillColor[3] = 255;

        let c = duplicateCanvas(canvas).getContext("2d");
        let target = c.getImageData(0,0,w,h);

        let done = {};
        let check = [];
        let ind = getIndex(point);
        put(ind);
        let color = getColor(ind);

        while (check.length){
            let i = check.shift();
            let x = i%w;
            let y = (i-x)/w;
            if (x>0) checkIndex(i-1);
            if (x<w-1) checkIndex(i+1);
            if (y>0) checkIndex(i-w);
            if (y<h-1) checkIndex(i+w);
        }

        c.putImageData(target,0,0);
        return c.canvas;

        function getColor(index){
            index *= 4;
            let r = imageData.data[index];
            let g = imageData.data[index+1];
            let b = imageData.data[index+2];
            let a = imageData.data[index+3];
            if (index>=imageData.data.length){
                console.error("invalid index " + index)
            }else{
                return Color.toHex([r,g,b,a]);
            }

        }

        function getIndex(p) {
            return p.y*w + p.x;
        }

        function checkIndex(ind){
            if (!done[ind]){
                let c = getColor(ind);
                let passed = c === color;
                if (!passed && tolerance){
                    let distance = Color.distance(c,color);
                    passed = distance <= tolerance*2;
                }
                if (passed) put(ind);
            }
        }

        function put(ind){
            target.data[ind*4] = fillColor[0];
            target.data[ind*4 + 1] = fillColor[1];
            target.data[ind*4 + 2] = fillColor[2];
            target.data[ind*4 + 3] = 255;
            done[ind] = true;
            check.push(ind)
        }
    }


    me.colorSelect = function(color){
        let canvas = ImageFile.getActiveLayer().getCanvas();

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

    me.alphaSelect = function(){
        let canvas = ImageFile.getActiveLayer().getCanvas();

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
        }else{
            me.deActivate();
        }
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

    function cleanUp(){
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

        if (selecting){
            selecting = false;
            me.endPolySelect();
        }
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
            selectionTransform = undefined;
            box.classList.remove("capture");
            resizer.remove();
        }
    });


    return me;
});

export default SelectBox;