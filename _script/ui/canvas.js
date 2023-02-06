import Input from "./input.js";
import EventBus from "../util/eventbus.js";
import {COMMAND, EVENT} from "../enum.js";
import {$div} from "../util/dom.js";
import Palette from "./palette.js";
import Brush from "./brush.js";
import Editor from "./editor.js";
import HistoryService from "../services/historyservice.js";
import Selection from "./selection.js";
import ImageFile from "../image.js";
import Resizer from "./components/resizer.js";
import input from "./input.js";
import ToolOptions from "./components/toolOptions.js";

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
    selectBox = $div("selectbox");

    canvas.width = 200;
    canvas.height = 200;
    overlayCanvas.width = 200;
    overlayCanvas.height = 200;
    ctx = canvas.getContext("2d",{willReadFrequently: true, antialias:false, desynchronized: false});
    overlayCtx = overlayCanvas.getContext("2d",{willReadFrequently: true});

    let c = $div("canvascontainer");

    overlayCanvas.className = "overlaycanvas";
    canvas.className = "maincanvas";
    c.appendChild(canvas);
    c.appendChild(overlayCanvas);
    c.appendChild(selectBox);
    
    panelParent = parent.getViewPort();
    panelParent.appendChild(c);

    panelParent.addEventListener('scroll',(e)=>{handle('scroll', e)},false);

    canvas.addEventListener("mousemove", function (e) {handle('move', e)}, false);
    canvas.addEventListener("mousedown", function (e) {handle('down', e)}, false);
    canvas.addEventListener("mouseup", function (e) {handle('up', e)}, false);
    canvas.addEventListener("mouseout", function (e) {handle('out', e)}, false);
    canvas.onmouseenter = function(){
        Input.setMouseOver("iconEditorCanvas");
    };

    canvas.onmouseleave = function(){
        Input.removeMouseOver("iconEditorCanvas");
    };

    EventBus.on(EVENT.hideCanvasOverlay,()=>{
        overlayCanvas.style.opacity = 0;
    });

    EventBus.on(EVENT.drawCanvasOverlay,(point)=>{
        overlayCanvas.style.opacity = 1;
        overlayCtx.clearRect(0,0, canvas.width, canvas.height);
        Brush.draw(overlayCtx,point.x,point.y,Palette.getDrawColor());
    });
    
    EventBus.on(COMMAND.CLEARSELECTION,()=>{
        selectBox.classList.remove("active");
    })

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
        if (selectBox.classList.contains("active")){
            updateSelectBox(true);
        }
    })

    EventBus.on(EVENT.sizerChanged,()=>{
        if (selectBox.classList.contains("active")){
            Selection.set(me,Resizer.get());
            updateSelectBox(true);
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

        if (selectBox.classList.contains("active")){
            updateSelectBox();
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
        Brush.draw(ImageFile.getActiveContext(),x,y,color,true);
        EventBus.trigger(EVENT.layerContentChanged);
    }

    let defaultDrawFunction = function(canvas){
        let w = canvas.width;
        let h = canvas.height;
        let x = 0;
        let y = 0;
        drawFunction(canvas.getContext("2d"),x,y,w,h);
    }

    function handle(action,e){
        e.preventDefault();
        var point;
        switch (action){
            case "down":
                console.error(Editor.getCurrentTool());
                point = getCursorPosition(canvas,e,true);
                touchData.isdown = true;
                touchData.button = e.button;
                if (e.metaKey) touchData.button = 3;
                if (Input.isSpaceDown()){
                    touchData.startDragX = e.clientX;
                    touchData.startDragY =  e.clientY;
                    touchData.startScrollX = panelParent.scrollLeft;
                    touchData.startScrollY = panelParent.scrollTop;
                    return;
                }else if (Input.isShiftDown() && canPickColor()){
                    var pixel = ctx.getImageData(point.x, point.y, 1, 1).data;
                    Palette.setColor(pixel);
                    return;
                }
                
                if (touchData.isResizing){
                    return;
                }
                switch (Editor.getCurrentTool()){
                    case COMMAND.DRAW:
                    case COMMAND.ERASE:
                        touchData.isDrawing = true;
                        HistoryService.start([COMMAND.DRAW,ctx,onChange]);
                        draw();
                        break;
                    case COMMAND.SELECT:
                        touchData.isSelecting = true;
                        selectBox.classList.add("active");
                        Resizer.set(point.x,point.y,0,0,true,parent.getViewPort(),1);
                        break;
                    case COMMAND.SQUARE:
                        touchData.isSelecting = true;
                        selectBox.classList.add("active");
                        Resizer.set(point.x,point.y,0,0,true,parent.getViewPort(),1);
                        drawFunction = function(ctx,x,y,w,h,button){
                            ctx.fillStyle = button?Palette.getBackgroundColor():Palette.getDrawColor();
                            ctx.fillRect(x,y,w,h);
                        }
                        Resizer.setOverlay(defaultDrawFunction);
                        break;
                    case COMMAND.CIRCLE:
                        touchData.isSelecting = true;
                        selectBox.classList.add("active");
                        Resizer.set(point.x,point.y,0,0,true,parent.getViewPort(),1);
                        drawFunction = function(ctx,x,y,w,h,button){
                            let cx = x + w/2;
                            let cy = y + h/2;
                            let wx = w/2;
                            let wh = h/2;
                            ctx.fillStyle = button?Palette.getBackgroundColor():Palette.getDrawColor();
                            ctx.beginPath();
                            ctx.ellipse(cx, cy, wx, wh, 0, 0, 2 * Math.PI);
                            ctx.fill();
                        }
                        Resizer.setOverlay(defaultDrawFunction);
                        break;
                    case COMMAND.LINE:
                        let layerIndex = ImageFile.addLayer();
                        let drawLayer = ImageFile.getLayer(layerIndex);
                        touchData.hotDrawFunction = function(x,y){
                            drawLayer.clear();
                            let ctx = drawLayer.getContext();
                            ctx.lineWidth = ToolOptions.getLineSize();
                            let isOdd = ctx.lineWidth%2===1;
                            ctx.lineCap = "square";
                            ctx.strokeStyle = Palette.getDrawColor();

                            ctx.imageSmoothingEnabled = ToolOptions.isSmooth();
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
                            if (isOdd) ctx.translate(.5,.5);
                            ctx.beginPath();
                            ctx.moveTo(point.x,point.y);
                            ctx.lineTo(x,y);
                            ctx.closePath();
                            ctx.stroke();
                            if (isOdd) ctx.translate(-.5,-.5);
                            EventBus.trigger(EVENT.layerContentChanged);
                        }
                        touchData.hotDrawDone = function(){
                            ImageFile.mergeDown(layerIndex);
                        }
                        break;
                }
                break;
            case 'up':
            case "out":

                if (touchData.isDrawing){
                    HistoryService.end();
                }

                if (touchData.isSelecting){
                    if (touchData.selection){
                        Selection.set(me,touchData.selection);
                        Resizer.commit();

                        if (Editor.getCurrentTool() ===  COMMAND.SQUARE || Editor.getCurrentTool() ===  COMMAND.CIRCLE){
                            let s = Resizer.get();
                            drawFunction(ImageFile.getActiveContext(),s.left,s.top,s.width,s.height,touchData.button)
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

                touchData.isdown = false;
                touchData.isDrawing = false;
                touchData.isSelecting = false;
                touchData.isResizing = false;
                touchData.selection = undefined;
                selectBox.classList.remove("hot");
                hideOverlay();

                break;
            case "move":
                point = getCursorPosition(canvas,e,false);
                
                if (touchData.isdown){
                    if (Input.isSpaceDown()){
                        var dx = (touchData.startDragX-e.clientX);
                        var dy = touchData.startDragY-e.clientY;
                        panelParent.scrollLeft = touchData.startScrollX+dx;
                        panelParent.scrollTop = touchData.startScrollY+dy;
                        return;
                    }

                    if (Input.isShiftDown() && canPickColor()){
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

                    if (touchData.isResizing){
                        let w = point.x - touchData.x;
                        let h = point.y - touchData.y;
                        touchData.selection.width = touchData.startSelectWidth + w;
                        touchData.selection.height = touchData.startSelectHeight + h;
                        EventBus.trigger(EVENT.sizerChanged,touchData.selection);
                    }

                    if (touchData.hotDrawFunction){
                        touchData.hotDrawFunction(point.x,point.y);
                    }
                    
                }else{
                    if (Input.isSpaceDown()){
                        hideOverlay();
                    }else{
                        drawOverlay(point);
                    }
                }
                
                
                    /*if (Main.isShift && Main.isMouseDown){
                        var pixel = ctx.getImageData(x, y, 1, 1).data;
                        drawColor = "rgb(" + pixel[0] +"," + pixel[1] +"," + pixel[2] +")";
                        cursorMark.style.borderColor = drawColor;
                        console.log("set drawcolor to " + drawColor);
                        EventBus.trigger(EVENT.drawColorChanged);
                    }

                    cursor.style.top = point.y + "px";
                    cursor.style.left = point.x + "px";*/
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

    function updateSelectBox(fromEvent){
        let data = Selection.get();

        if (data){
            selectBox.style.left = data.left*zoom + "px";
            selectBox.style.top = data.top*zoom + "px";
            selectBox.style.width = data.width*zoom + "px";
            selectBox.style.height = data.height*zoom + "px";
        }
        console.error("zoom");
        if (!fromEvent) EventBus.trigger(EVENT.selectionChanged);
    }

    function canPickColor(){
        let ct = Editor.getCurrentTool();
        return !(ct === COMMAND.SELECT || ct === COMMAND.SQUARE || ct === COMMAND.CIRCLE || ct === COMMAND.LINE ||  ct === COMMAND.TRANSFORMLAYER);
    }

    return me;
};

export default Canvas;