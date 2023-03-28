import Input from "./input.js";
import EventBus from "../util/eventbus.js";
import {COMMAND, EVENT} from "../enum.js";
import {$div} from "../util/dom.js";
import Palette from "./palette.js";
import Brush from "./brush.js";
import Editor from "./editor.js";
import Selection from "./selection.js";
import ImageFile from "../image.js";
import Resizer from "./components/resizer.js";
import ToolOptions from "./components/toolOptions.js";
import StatusBar from "./statusbar.js";
import SelectBox from "./components/selectbox.js";
import ImageProcessing from "../util/imageProcessing.js";
import DitherPanel from "./components/ditherPanel.js";
import Color from "../util/color.js";
import {duplicateCanvas} from "../util/canvasUtils.js";
import HistoryService from "../services/historyservice.js";

let Canvas = function(parent){
	let me = {};
    let canvas;
    let ctx;
    let overlayCanvas;
    let overlayCtx;
    let touchData={};
    let zoom=1;
    let prevZoom;
    let onChange;
    var panelParent;
    var selectBox;
    let drawFunction;

    canvas = document.createElement("canvas");
    overlayCanvas = document.createElement("canvas");
    selectBox = SelectBox();

    canvas.width = 200;
    canvas.height = 200;
    overlayCanvas.width = 200;
    overlayCanvas.height = 200;
    ctx = canvas.getContext("2d",{willReadFrequently: true, antialias:false, desynchronized: false});
    overlayCtx = overlayCanvas.getContext("2d",{willReadFrequently: true});

    let c = $div("canvascontainer");

    overlayCanvas.className = "overlaycanvas";
    canvas.className = "maincanvas info";
    c.appendChild(canvas);
    c.appendChild(overlayCanvas);
    c.appendChild(selectBox.getBox());
    
    panelParent = parent.getViewPort();
    panelParent.appendChild(c);

    panelParent.addEventListener('scroll',(e)=>{handle('scroll', e)},false);

    panelParent.classList.add("handle");
    panelParent.onDragStart = function (e) {handle('down', e)}
    panelParent.onDrag = function (x,y,touchData,e) {handle('move', e)}
    panelParent.onDragEnd = function (e) {handle('up', e)}
    panelParent.onDoubleClick = function(e){
        if (Editor.getCurrentTool() === COMMAND.POLYGONSELECT){
            selectBox.endPolySelect(true);
        }
    }

    canvas.addEventListener("mousemove", function (e) {handle('over', e)}, false);

    canvas.onmouseenter = function(){
        Input.setMouseOver("iconEditorCanvas");
    };

    canvas.onmouseleave = function(){
        Input.removeMouseOver("iconEditorCanvas");
        hideOverlay();
    };

    EventBus.on(EVENT.hideCanvasOverlay,()=>{
        overlayCanvas.style.opacity = 0;
    });

    EventBus.on(EVENT.drawCanvasOverlay,(point)=>{
        overlayCanvas.style.opacity = 1;
        overlayCtx.clearRect(0,0, canvas.width, canvas.height);
        overlayCtx.globalAlpha = Brush.getOpacity();
        Brush.draw(overlayCtx,point.x,point.y,Palette.getDrawColor(),(Input.isControlDown() || Input.isMetaDown()));
        overlayCtx.globalAlpha = 1;

    });
    
    EventBus.on(COMMAND.CLEARSELECTION,()=>{
        selectBox.deActivate();
    });

    EventBus.on(COMMAND.ENDPOLYGONSELECT,()=>{
        touchData.isPolySelect = false;
    });

    EventBus.on(EVENT.imageSizeChanged,()=>{
        if (!parent.isVisible()) return;
        let c = ImageFile.getCanvas();
        canvas.width = overlayCanvas.width = c.width;
        canvas.height = overlayCanvas.height = c.height;
        me.update();
        me.zoom(1);
    })

    EventBus.on(EVENT.imageContentChanged,()=>{
        me.clear();
        ctx.drawImage(ImageFile.getCanvas(),0,0);
    })

    EventBus.on(EVENT.selectionChanged,()=>{
        if (!parent.isVisible()) return;
        if (selectBox.isActive()){
            selectBox.update(true);
        }
    })

    me.clear = function(){
        ctx.clearRect(0,0,canvas.width,canvas.height);
    }

    me.set = function(image,reset){
        if (reset){
            canvas.width = overlayCanvas.width = image.width;
            canvas.height = overlayCanvas.height = image.height;
            zoom = 1;
            me.zoom(1);
        }
        me.clear();
    }
    
    me.update = function(){
        me.clear();
        ctx.drawImage(ImageFile.getCanvas(),0,0);
    }

    me.zoom = function(amount,event){
        hideOverlay();

        var z = prevZoom || zoom;
        prevZoom = undefined;
        const rect = panelParent.getBoundingClientRect();
        if (!event) event = {clientX: rect.width/2, clientY: rect.height/2};

        // zoom around point
        var x = Math.floor((event.clientX - rect.left)) + panelParent.scrollLeft;
        var y = Math.floor((event.clientY - rect.top)) + panelParent.scrollTop;

        zoom=zoom*amount;
        canvas.style.width = Math.floor(canvas.width * zoom) + "px";
        canvas.style.height = Math.floor(canvas.height * zoom) + "px";
        overlayCanvas.style.width = Math.floor(canvas.width * zoom) + "px";
        overlayCanvas.style.height = Math.floor(canvas.height * zoom) + "px";

        var _z = (zoom/z - 1);
        panelParent.scrollLeft += _z*x;
        panelParent.scrollTop += _z*y;

        if (selectBox.isActive()){
            selectBox.update();
        }

    }

    me.getZoom = function(){
        return zoom;
    }

    me.setZoom = function(amount){
        prevZoom = zoom;
        zoom = amount;
        me.zoom(1);
    }

    me.getCanvas = function(){
        return canvas;
    }

    me.startSelect = function(){
        touchData.isSelecting = true;
    }

    function draw() {
        // button=0 -> left, button=2: right
        let color = touchData.button?Palette.getBackgroundColor():Palette.getDrawColor();
        if (Editor.getCurrentTool() === COMMAND.ERASE) color = "transparent";
        let {x,y} = touchData;
        touchData.drawLayer = ImageFile.getActiveLayer();
        touchData.drawLayer.draw(x,y,color,touchData);
        touchData.isDrawing = true;
        EventBus.trigger(EVENT.layerContentChanged);
    }

    let defaultDrawFunction = function(){
        let box = Resizer.get();
        let w = box.width;
        let h = box.height;
        let x = box.left;
        let y = box.top;
        drawFunction(canvas.getContext("2d"),x,y,w,h);
    }

    function handle(action,e){
        e.preventDefault();
        var point;
        switch (action){
            case "down":
                point = getCursorPosition(canvas,e,true);
                touchData.isdown = true;
                touchData.button = e.button;
                if (e.metaKey || e.ctrlKey) touchData.button = 3;
                if (Input.isSpaceDown() || e.button===1){
                    hideOverlay();
                    document.body.classList.add("space");
                    touchData.startDragX = e.clientX;
                    touchData.startDragY =  e.clientY;
                    touchData.startScrollX = panelParent.scrollLeft;
                    touchData.startScrollY = panelParent.scrollTop;
                    return;
                }else if ((Input.isShiftDown() || Input.isAltDown()) && canPickColor()){
                    var pixel = ctx.getImageData(point.x, point.y, 1, 1).data;
                    Palette.setColor(pixel);
                    return;
                }

                let currentTool = Editor.getCurrentTool();
                switch (currentTool){
                    case COMMAND.DRAW:
                    case COMMAND.ERASE:
                        HistoryService.start(EVENT.layerHistory);
                        draw();
                        break;
                    case COMMAND.SELECT:
                        touchData.isSelecting = true;
                        selectBox.activate();
                        Resizer.set(point.x,point.y,0,0,0,true,parent.getViewPort(),1);
                        break;
                    case COMMAND.POLYGONSELECT:
                        touchData.isPolySelect = true;
                        selectBox.polySelect(point);
                        break;
                    case COMMAND.FLOODSELECT:
                        let c = selectBox.floodSelect(ImageFile.getActiveLayer().getCanvas(),point);
                        selectBox.activate();
                        selectBox.applyCanvas(c);
                        EventBus.trigger(EVENT.layerContentChanged);
                        break;
                    case COMMAND.FLOOD:
                        HistoryService.start(EVENT.layerHistory);
                        let cf = selectBox.floodSelect(ImageFile.getActiveLayer().getCanvas(),point,Color.fromString(e.button?Palette.getBackgroundColor():Palette.getDrawColor()));
                        ImageFile.getActiveLayer().drawImage(cf)
                        HistoryService.end();
                        EventBus.trigger(EVENT.layerContentChanged);
                        break;
                    case COMMAND.CIRCLE:
                    case COMMAND.SQUARE:
                        touchData.isSelecting = true;
                        selectBox.activate();
                        Resizer.set(point.x,point.y,0,0,0,true,parent.getViewPort(),1);
                        HistoryService.start(EVENT.layerHistory);

                        if (currentTool === COMMAND.CIRCLE){
                            drawFunction = function(ctx,x,y,w,h,button){
                                ctx.clearRect(0,0,ctx.canvas.width,ctx.canvas.height);
                                let color = button?Palette.getBackgroundColor():Palette.getDrawColor();
                                let cx = x + w/2;
                                let cy = y + h/2;
                                let wx = w/2;
                                let wh = h/2;
                                let isOdd = false;
                                ctx.imageSmoothingEnabled = ToolOptions.isSmooth();
                                ctx.fillStyle = color;
                                if (!ToolOptions.isFill()){
                                    ctx.strokeStyle = color;
                                    ctx.lineWidth = ToolOptions.getLineSize();
                                    isOdd = ctx.lineWidth%2===1;
                                }
                                ctx.beginPath();
                                if (isOdd) ctx.translate(0.5,0.5);
                                ctx.ellipse(cx, cy, wx, wh, 0, 0, 2 * Math.PI);
                                if (isOdd) ctx.translate(-0.5,-0.5);
                                if (ToolOptions.isFill()){
                                    ctx.fill();
                                }else{
                                    ctx.stroke();
                                }
                            }
                        }

                        if (currentTool === COMMAND.SQUARE){
                            drawFunction = function(ctx,x,y,w,h,button){
                                ctx.clearRect(0,0,ctx.canvas.width,ctx.canvas.height);
                                let color = button?Palette.getBackgroundColor():Palette.getDrawColor();
                                if (ToolOptions.isFill()){
                                    ctx.fillStyle = color;
                                    ctx.fillRect(x,y,w,h);
                                }else{
                                    ctx.strokeStyle = color;
                                    ctx.lineWidth = ToolOptions.getLineSize();
                                    let isOdd = ctx.lineWidth%2===1;
                                    ctx.beginPath();
                                    if (isOdd) ctx.translate(0.5,0.5);
                                    ctx.rect(x,y,w,h);
                                    if (isOdd) ctx.translate(-0.5,-0.5);
                                    ctx.closePath();
                                    ctx.stroke();
                                }
                            }
                        }

                        Resizer.setOnUpdate(()=>{
                            let box = Resizer.get();
                            let w = box.width;
                            let h = box.height;
                            let x = box.left;
                            let y = box.top;
                            ImageFile.getActiveLayer().drawShape(drawFunction,x,y,w,h);
                            EventBus.trigger(EVENT.layerContentChanged);
                        });
                        break;
                    case COMMAND.LINE:
                    case COMMAND.GRADIENT:
                        // TODO move this as well to the drawLayer of the active layer ?
                        HistoryService.start(EVENT.layerHistory);
                        let layerIndex = ImageFile.addLayer();
                        let drawLayer = ImageFile.getLayer(layerIndex);
                        touchData.hotDrawFunction = function(x,y){
                            drawLayer.clear();
                            let ctx = drawLayer.getContext();
                            let lineWidth = ToolOptions.getLineSize() / (window.devicePixelRatio || 1)
                            ctx.lineWidth = lineWidth;
                            ctx.lineCap = "square";
                            ctx.strokeStyle = Palette.getDrawColor();
                            ctx.imageSmoothingEnabled = false;

                            if (Input.isShiftDown()){
                                // snap to x or y axis
                                let w = Math.abs(x-point.x);
                                let h = Math.abs(y-point.y);
                                let ratio = Math.min(w/h,h/w);
                                if (ratio<=1 && ratio>0.5){
                                    let d = Math.min(w,h);
                                    x = point.x + d*(x<point.x?-1:1);
                                    y = point.y + d*(y<point.y?-1:1);
                                }else{
                                    if (w<h){
                                        x=point.x;
                                    }else{
                                        y=point.y;
                                    }
                                }
                            }

                            if (currentTool === COMMAND.GRADIENT){
                                ctx.strokeStyle = "black";
                                ctx.lineWidth = 2;
                                touchData.points=[point,{x:x,y:y}];
                            }

                            if (ToolOptions.isSmooth()){
                                let isOdd = ctx.lineWidth%2===1;
                                if (isOdd) ctx.translate(.5,.5);
                                ctx.beginPath();
                                ctx.moveTo(point.x,point.y);
                                ctx.lineTo(x,y);
                                ctx.closePath();
                                ctx.stroke();
                                if (isOdd) ctx.translate(-.5,-.5);
                            }else{
                                bLine(point.x,point.y,x,y,ctx,Color.fromString(Palette.getDrawColor()),lineWidth);
                            }

                            EventBus.trigger(EVENT.layerContentChanged);

                        }
                        touchData.hotDrawDone = function(){
                            if (currentTool === COMMAND.GRADIENT){
                                //drawLayer.clear();
                                let drawLayer = ImageFile.getLayer(layerIndex);
                                let ctx = drawLayer.getContext();

                                let p1=touchData.points[0];
                                let p2=touchData.points[1];
                                let w = ctx.canvas.width;
                                let h = ctx.canvas.height;
                                ctx.clearRect(0,0,w,h);
                                let grd;

                                if (DitherPanel.getDitherState()){
                                    let gradientCanvas = duplicateCanvas(ctx.canvas);
                                    let gCtx = gradientCanvas.getContext("2d");
                                    grd = gCtx.createLinearGradient(p1.x,p1.y,p2.x,p2.y);
                                    grd.addColorStop(0,"white");
                                    grd.addColorStop(1,"black");
                                    gCtx.fillStyle = grd;
                                    gCtx.fillRect(0,0,w,h);
                                    ImageProcessing.bayer(gCtx,128,true);

                                    let fColor = Palette.getDrawColor();
                                    let bColor = Palette.getBackgroundColor();
                                    let patterCanvas = duplicateCanvas(ctx.canvas);
                                    let pCtx = patterCanvas.getContext("2d");

                                    if (fColor === "transparent"){
                                        pCtx.fillStyle = bColor;
                                        pCtx.fillRect(0,0,w,h);

                                        pCtx.globalCompositeOperation = "destination-in";
                                        pCtx.drawImage(gradientCanvas,0,0);
                                        pCtx.globalCompositeOperation = "source-over";

                                        ctx.drawImage(patterCanvas,0,0);

                                    }else{
                                        pCtx.fillStyle = fColor;
                                        pCtx.fillRect(0,0,w,h);

                                        pCtx.globalCompositeOperation = "destination-out";
                                        pCtx.drawImage(gradientCanvas,0,0);
                                        pCtx.globalCompositeOperation = "source-over";

                                        ctx.fillStyle = bColor;
                                        ctx.fillRect(0,0,w,h);
                                        ctx.drawImage(patterCanvas,0,0);
                                    }
                                }else{
                                    grd = ctx.createLinearGradient(p1.x,p1.y,p2.x,p2.y);
                                    grd.addColorStop(0,Palette.getDrawColor());
                                    grd.addColorStop(1,Palette.getBackgroundColor());
                                    ctx.fillStyle = grd;
                                    ctx.fillRect(0,0,w,h);
                                }

                                EventBus.trigger(EVENT.layerContentChanged);
                            }
                            ImageFile.mergeDown(layerIndex);
                            HistoryService.end(EVENT.layerHistory);
                        }
                        break;
                }
                break;
            case 'up':
                if (touchData.isDrawing){
                    let layer = touchData.drawLayer || ImageFile.getActiveLayer();
                    layer.commitDraw();
                    EventBus.trigger(EVENT.layerContentChanged);
                }

                if (touchData.isSelecting){
                    if (touchData.selection){
                        Selection.set(touchData.selection);
                        Resizer.commit();

                        if (drawFunction){
                            //let s = Resizer.get();
                            //drawFunction(ImageFile.getActiveContext(),s.left,s.top,s.width,s.height,touchData.button)
                            ImageFile.getActiveLayer().commitDraw();
                            drawFunction = undefined;
                            EventBus.trigger(EVENT.layerContentChanged);
                            EventBus.trigger(COMMAND.CLEARSELECTION);
                        }
                    }else{
                        EventBus.trigger(COMMAND.CLEARSELECTION);
                    }
                }

                if (touchData.hotDrawFunction){
                    touchData.hotDrawFunction = undefined;
                    if (touchData.hotDrawDone){
                        touchData.hotDrawDone();
                    }
                }

                if (!Input.isSpaceDown()) document.body.classList.remove("space");

                touchData.isdown = false;
                touchData.isDrawing = false;
                touchData.isSelecting = false;
                touchData.selection = undefined;

                break;
            case "over":
                // mousemove with no click
                if (!touchData.isdown){
                    point = getCursorPosition(canvas,e,false);
                    StatusBar.setToolTip(point.x + "," + point.y);

                    if (touchData.isPolySelect){
                        selectBox.updatePoint(point);
                    }else{
                        if (Input.isSpaceDown()){
                            hideOverlay();
                        }else{
                            drawOverlay(point);
                        }
                    }
                }
                break;
            case "move":
                point = getCursorPosition(canvas,e,false);

                if (touchData.isdown){
                    if (Input.isSpaceDown() || touchData.button===1 ){
                        var dx = (touchData.startDragX-e.clientX);
                        var dy = touchData.startDragY-e.clientY;
                        panelParent.scrollLeft = touchData.startScrollX+dx;
                        panelParent.scrollTop = touchData.startScrollY+dy;
                        return;
                    }

                    if (touchData.isPolySelect){
                        selectBox.updatePoint(point);
                        return;
                    }

                    if ((Input.isShiftDown() || Input.isAltDown()) && canPickColor()){
                        var pixel = ctx.getImageData(point.x, point.y, 1, 1).data;
                        Palette.setColor(pixel);
                        return;
                    }

                    if (touchData.isDrawing){
                        hideOverlay();
                        getCursorPosition(canvas,e,true);
                        draw();
                    }

                    if (touchData.isSelecting){
                        let w = point.x - touchData.x;
                        let h = point.y - touchData.y;
                        let x = touchData.x;
                        let y = touchData.y;
                        if (w<0){
                            x += w;
                            w=-w;
                        }
                        if (h<0){
                            y += h;
                            h=-h;
                        }
                        touchData.selection = {left:x,top:y,width: w,height: h};
                        EventBus.trigger(EVENT.sizerChanged,touchData.selection);
                    }

                    if (touchData.hotDrawFunction){
                        touchData.hotDrawFunction(point.x,point.y);
                    }
                    
                }
                break;
            case "scroll":
                EventBus.trigger(EVENT.sizerChanged);
                break;
        }
    }


    function getCursorPosition(elm, event, persist) {
        const rect = elm.getBoundingClientRect();
        const x = Math.floor((event.clientX - rect.left)/zoom);
        const y = Math.floor((event.clientY - rect.top)/zoom);
        if (persist){
            touchData.prevX = touchData.x;
            touchData.prevY = touchData.y;
            touchData.x = x;
            touchData.y = y;
        }
        return{x:x,y:y};
    }

    me.getCursorPosition = function(event){
        return getCursorPosition(canvas,event);
    }

    function getElementPosition(el) {
        var rect = el.getBoundingClientRect(),
            scrollLeft = window.pageXOffset || document.documentElement.scrollLeft,
            scrollTop = window.pageYOffset || document.documentElement.scrollTop;
        return { top: rect.top + scrollTop, left: rect.left + scrollLeft }
    }
    
    function hideOverlay(){
        EventBus.trigger(EVENT.hideCanvasOverlay);
    }

    function drawOverlay(point){
        EventBus.trigger(EVENT.drawCanvasOverlay,point);
    }


    function canPickColor(){
        // TODO this is crap - FIXME !
        let ct = Editor.getCurrentTool();
        return !(ct === COMMAND.SELECT || ct === COMMAND.SQUARE || ct === COMMAND.GRADIENT || ct === COMMAND.CIRCLE  ||  ct === COMMAND.TRANSFORMLAYER);
    }

    //Bresenham's_line_algorithm
    //http://rosettacode.org/wiki/Bitmap/Bresenham's_line_algorithm
    function bLine_(x0, y0, x1, y1,ctx,color,lineWidth) {
        let imgData=ctx.getImageData(0,0,canvas.width,canvas.height);
        let data = imgData.data;

        var dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
        var dy = Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
        var err = (dx>dy ? dx : -dy)/2;
        while (true) {
            drawPixel(x0,y0);
            //drawPixel(x0+1,y0);
            //drawPixel(x0-1,y0);
            //drawPixel(x0,y0+1);
            //drawPixel(x0,y0-1);

            if (x0 === x1 && y0 === y1) break;
            var e2 = err;
            if (e2 > -dx) { err -= dy; x0 += sx; }
            if (e2 < dy) { err += dx; y0 += sy; }
        }
        ctx.putImageData(imgData,0,0);

        function drawPixel(x,y){
            let n=(y*canvas.width+x)*4;
            data[n]=color[0];
            data[n+1]=color[1];
            data[n+2]=color[2];
            data[n+3]=255;
        }
    }




    function bLine(x0, y0, x1, y1,ctx,color,thickness) {
        let dx = Math.abs(x1 - x0);
        let dy = Math.abs(y1 - y0);
        let sx = (x0 < x1) ? 1 : -1;
        let sy = (y0 < y1) ? 1 : -1;
        let err = dx - dy;
        let e2;
        let x = x0;
        let y = y0;
        let angle = Math.atan2(dy, dx);
        let thicknessX = thickness * Math.cos(angle);
        let thicknessY = thickness * Math.sin(angle);

        color = "black";

        while (true) {
            for (let i = Math.floor(-thicknessX/2); i <= Math.ceil(thicknessX/2); i++) {
                for (let j = Math.floor(-thicknessY/2); j <= Math.ceil(thicknessY/2); j++) {
                    let xi = Math.round(x + i * Math.cos(angle) - j * Math.sin(angle));
                    let yi = Math.round(y + i * Math.sin(angle) + j * Math.cos(angle));
                    ctx.fillStyle = color;
                    ctx.fillRect(xi, yi, 1, 1);
                }
            }

            if ((x == x1) && (y == y1)) break;
            e2 = err * 2;
            if (e2 > -dy) { err -= dy; x += sx; }
            if (e2 < dx) { err += dx; y += sy; }
        }
    }



    return me;
};

export default Canvas;