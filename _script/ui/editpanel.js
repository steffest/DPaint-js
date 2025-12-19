import {$div} from "../util/dom.js";
import EventBus from "../util/eventbus.js";
import {COMMAND, EVENT, SETTING} from "../enum.js";
import Canvas from "./canvas.js";
import Editor from "./editor.js";
import ImageFile from "../image.js";
import ToolOptions from "./components/toolOptions.js";
import Input from "./input.js";
import Brush from "./brush.js";
import BrushPanel from "./toolPanels/brushPanel.js";
import UserSettings from "../userSettings.js";

var EditPanel = function(parent,type){
    var me = {};
    var zoomLevels = [0.1,0.25,0.5,1,2,3,4,6,8,10,15,20,30,50,100];
    let startZoom = 1;
    let startScale = 1;
    let isZooming = false;
    let touchData = {};
    
    var panel = $div("panel " + type,"",parent);

    var toolbar = $div("toolbar","",panel);
    var viewport = $div("viewport","",panel);
    let windowContainer;
    let windowCanvasList = [];
    let tileContainer;
    let toolPanel;

    let currentView = "editor";
    
    var thisPanel = type === "left" ? 0:1;
    if (thisPanel === 1) panel.style.display = "none";

    me.getViewPort = function(){
        return viewport;
    }
    var canvas = Canvas(me);

    me.getCanvas = function(){
        return canvas.getCanvas();
    }
    me.getZoom = function(){
        return canvas.getZoom();
    }
    me.getResizer = function(){
        return canvas.getResizer();
    }

    me.getIndex = function(){
        return thisPanel;
    }

    viewport.addEventListener("wheel",function(e){
        e.preventDefault();
        if (Input.isShiftDown()){
            let point = canvas.getCursorPosition(e);
            let settings = Brush.get();
            let offset = e.deltaY>0?-1:1;
            BrushPanel.set({size:settings.width+offset});
            EventBus.trigger(EVENT.drawCanvasOverlay,point);
            //console.error(settings);
        }else if (Input.isControlDown()){
            let point = canvas.getCursorPosition(e);
            let settings = Brush.get();
            let offset = e.deltaY>0?-5:5;
            BrushPanel.set({opacity:settings.opacity+offset});
            EventBus.trigger(EVENT.drawCanvasOverlay,point);
        }else{
            if (e.deltaY>0){
                EventBus.trigger(COMMAND.ZOOMOUT,e);
            }else if (e.deltaY<0){
                EventBus.trigger(COMMAND.ZOOMIN,e);
            }
        }
    });

    viewport.addEventListener("touchstart", function (e) {
        if (e.touches.length > 1) {
            e.preventDefault();
            e.stopPropagation();
            Input.holdPointerEvents();
            touchData.startPan = canvas.getPanning();
            touchData.startZoom = canvas.getZoom();

            let dx = e.touches[0].clientX - e.touches[1].clientX;
            let dy = e.touches[0].clientY - e.touches[1].clientY;
            touchData.startDistance = Math.sqrt(dx * dx + dy * dy);
            touchData.startMidpoint = {
                x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
                y: (e.touches[0].clientY + e.touches[1].clientY) / 2
            };
            touchData.startAngle = Math.atan2(dy, dx);
            touchData.startCanvasRotation = canvas.getRotation();
            touchData.multiTap = e.touches.length;


            if (ToolOptions && ToolOptions.usePenOnly()){
                touchData.multiTapGesture = {
                    start: performance.now()
                }
            }else{
                if (touchData.undoGesture) touchData.undoGesture = undefined;
            }
        }
    });

    viewport.addEventListener("touchmove", function (e) {
        if (touchData.multiTapGesture){
            let x = (e.touches[0].clientX + e.touches[1].clientX)/2;
            let y = (e.touches[0].clientY + e.touches[1].clientY)/2;
            let d = Math.max(Math.abs(x - touchData.startMidpoint.x), Math.abs(y - touchData.startMidpoint.y));
            if (d > 20) touchData.multiTapGesture = undefined;
        }

        if (e.touches.length > 1) {
            e.preventDefault();
            e.stopPropagation();

            let dx = e.touches[0].clientX - e.touches[1].clientX;
            let dy = e.touches[0].clientY - e.touches[1].clientY;
            let distance = Math.sqrt(dx * dx + dy * dy);
            if (touchData.startDistance === 0) return;
            let scale = distance / touchData.startDistance;

            if (UserSettings.get(SETTING.touchRotate)) {
                let angle = Math.atan2(dy, dx);
                let angleDiff = angle - touchData.startAngle;
                canvas.setRotation(touchData.startCanvasRotation + angleDiff * 180 / Math.PI);
            }

            let newZoom = touchData.startZoom * scale;

            let currentMidpoint = {
                x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
                y: (e.touches[0].clientY + e.touches[1].clientY) / 2
            };

            const canvasPointX = touchData.startMidpoint.x - touchData.startPan.x;
            const canvasPointY = touchData.startMidpoint.y - touchData.startPan.y;
            const finalPanX = currentMidpoint.x - scale * canvasPointX;
            const finalPanY = currentMidpoint.y - scale * canvasPointY;

            // Apply zoom, which also applies a pan adjustment to keep the zoom centered.
            canvas.setZoom(newZoom, currentMidpoint);
            // Then, immediately override the pan with our correctly calculated final value.
            canvas.setPanning(finalPanX, finalPanY);

            syncZoomLevel();
        }
    });

    viewport.addEventListener("touchend", function (e) {
        if (touchData.multiTapGesture){
            if (e.touches.length < touchData.multiTap) { // one or more fingers lifted
                let duration = performance.now() - touchData.multiTapGesture.start;
                if (duration < 400){
                    if (touchData.multiTap === 2){
                        EventBus.trigger(COMMAND.UNDO);
                    }
                    if (touchData.multiTap === 3){
                        EventBus.trigger(COMMAND.SWAPCOLORS);
                    }

                }
                touchData.multiTapGesture = undefined;
            }
        }
        e.preventDefault();
        e.stopPropagation();
        Input.releasePointerEvents();
        isZooming = false;
    });

    viewport.addEventListener("pointerenter", function (e) {
        Input.setPointerOver("viewport");
    }, false);
    viewport.addEventListener("pointerleave", function (e) {
        Input.removePointerOver("viewport");
    }, false);

    panel.addEventListener("pointermove",()=>{
        Editor.setActivePanel(thisPanel)
        //activeCanvas = type==="left"?canvas:canvas2;
    });

    function syncZoomLevel(){
        let z = Math.floor(canvas.getZoom()*100);
        zoombutton.innerHTML = z + "%";
    }

    me.clear = function(){
        canvas.clear();
    }

    me.zoom = function(zoomFactor,center){
        canvas.zoom(zoomFactor,center);
        syncZoomLevel();
    }

    me.zoomToFit = function(){
        const rect = viewport.getBoundingClientRect();
        let sx = rect.width/canvas.getCanvas().width;
        let sy = rect.height/canvas.getCanvas().height;
        canvas.setZoom(Math.min(sx,sy));
        canvas.resetPan();
        syncZoomLevel();
    }

    me.setZoom = function(factor){
        canvas.setZoom(factor);
        syncZoomLevel();
    }

    me.getWidth = function(){
        return panel.getBoundingClientRect().width;
    }

    me.setWidth = function(w,percentage){
        let p = percentage?"%":"px";
        if (typeof w === "string") p="";
        panel.style.width = w + p;
    }

    me.setView = function(type){
        console.log("setting view to " + type);
        currentView = type;
        viewport.classList.toggle("hidden",type !== "editor");
        if (windowContainer) windowContainer.classList.toggle("hidden",type !== "icons");
        if (tileContainer) tileContainer.classList.toggle("hidden",type !== "tiles");

        if (type === "icons"){
            if (!windowContainer) generateWindows();
            windowContainer.classList.remove("hidden");
            updateWindows();
        }

        if (type === "tiles"){
            if (!tileContainer) generateTiles();
            tileContainer.classList.remove("hidden");
            updateTiles();
        }

        EventBus.trigger(EVENT.previewModeChanged,type);
    }

    me.show = function(){
        panel.style.display = "block";
    }

    me.hide = function(){
        panel.style.display = "none";
    }
    
    me.isVisible = function(){
        return  panel.style.display !== "none";
    }

    me.isActive = function(){
        return me.isVisible() && Editor.getActivePanel().getIndex() === thisPanel;
    }

    // setup toolbar
    let zoomoutButton = $div("button info","-",toolbar,()=>{
        var z =  canvas.getZoom();
        for (var i=zoomLevels.length-1;i>=0;i--){
            var zoom = zoomLevels[i];
            if (zoom<z) break;
        }
        canvas.setZoom(zoom);
        syncZoomLevel();
    })
    var zoombutton = $div("button auto info","100%",toolbar,()=>{
        canvas.setZoom(1);
        syncZoomLevel();
    })
    let zoominButton = $div("button info","+",toolbar,()=>{
        var z =  canvas.getZoom();
        for (var i=0;i<zoomLevels.length-1;i++){
            var zoom = zoomLevels[i];
            if (zoom>z) break;
        }
        canvas.setZoom(zoom);
        syncZoomLevel();
    })
    let zoomFitButton = $div("button expand info","",toolbar,me.zoomToFit);
    zoomoutButton.info = "Zoom out";
    zoominButton.info = "Zoom in";
    zoombutton.info = "Reset zoom to 100%";
    zoomFitButton.info = "Zoom to fit screen";

    if (thisPanel === 0){
        $div("button closepresentation","x",toolbar,()=>{
            EventBus.trigger(COMMAND.PRESENTATION);
        });
        toolPanel = $div("toolpanel","",toolbar);
        EventBus.on(EVENT.toolChanged,(tool)=>{
            tool = tool || Editor.getCurrentTool();
            toolPanel.innerHTML = "";
            toolPanel.appendChild(ToolOptions.getOptions(tool));
        })
        EventBus.on(COMMAND.TRANSFORMLAYER,()=>{
            toolPanel.innerHTML = "";
            toolPanel.appendChild(ToolOptions.getOptions(COMMAND.TRANSFORMLAYER));
        })
    }
    if (thisPanel === 1){
        let viewPanel = $div("viewstyle","",toolbar);
        let b1 = $div("button info editor active","E",viewPanel,()=>{me.setView('editor')});
        let b2 = $div("button info icons","I",viewPanel,()=>{me.setView('icons')});
        let b3 = $div("button info tiles","T",viewPanel,()=>{me.setView('tiles')});
        b1.info = "View in editor";
        b2.info = "Preview as icon";
        b3.info = "Preview as tile";

        $div("button right","x",toolbar,()=>{
            EventBus.trigger(COMMAND.SPLITSCREEN);
        });

        EventBus.on(EVENT.previewModeChanged,(mode)=>{
            b1.classList.toggle("active",mode === "editor");
            b2.classList.toggle("active",mode === "icons");
            b3.classList.toggle("active",mode === "tiles");
        });
    }

    function generateWindows(){
        windowContainer = $div("windowContainer","",panel);

        for (let i = 1; i<4; i++){
            let window = $div("window","",windowContainer);
            let colorbar  =  $div("colorbar","",window);
            let windowCanvas=document.createElement("canvas");
            windowCanvas.width = 280;
            windowCanvas.height = 142;
            window.appendChild(windowCanvas);
            windowCanvasList.push(windowCanvas.getContext("2d"));
        }
    }

    function updateWindows(){
        let icon = ImageFile.getCanvas();
        let colors = ["#959595","#3A67A3","#000000"];

        windowCanvasList.forEach((ctx,index)=>{
            ctx.fillStyle = colors[index];
            ctx.fillRect(0,0,280,142);
            let x = 10;
            let y = 10;
            while (y<140) {
                while (x<280) {
                    ctx.drawImage(icon,x,y);
                    x = x + icon.width + 10;
                }
                x = 10;
                y = y+icon.height+10;
            }


        })
    }

    function generateTiles(){
        tileContainer = $div("tileContainer","",panel);
    }

    function updateTiles(){
        let tile = ImageFile.getCanvas();
        let imageDataURL = tile.toDataURL();
        tileContainer.style.backgroundImage = "url('"+imageDataURL+"')";
    }

    EventBus.on(EVENT.imageSizeChanged,()=>{
       setTimeout(syncZoomLevel,20);
    })

    EventBus.on(EVENT.imageContentChanged,()=>{
        if (currentView === "icons"){
            updateWindows();
        }
        if (currentView === "tiles"){
            updateTiles();
        }
    })

    EventBus.on(COMMAND.ZOOMFIT,()=>{
        if (me.isVisible()){
            me.zoomToFit();
        }
    })
    
    return me;
};



export default EditPanel;