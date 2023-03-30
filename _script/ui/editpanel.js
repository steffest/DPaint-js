import {$div} from "../util/dom.js";
import EventBus from "../util/eventbus.js";
import {COMMAND, EVENT} from "../enum.js";
import Canvas from "./canvas.js";
import Editor from "./editor.js";
import ImageFile from "../image.js";
import ToolOptions from "./components/toolOptions.js";
import Input from "./input.js";
import Brush from "./brush.js";
import BrushPanel from "./components/brushPanel.js";

var EditPanel = function(parent,type){
    var me = {};
    var zoomLevels = [0.1,0.25,0.5,1,2,3,4,6,8,10,15,20,30,50,100];
    let startZoom = 1;
    let startScale = 1;
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


    viewport.addEventListener("wheel",function(e){
        e.preventDefault();
        if (Input.isShiftDown()){
            let point = canvas.getCursorPosition(e);
            let settings = Brush.getSettings();
            let offset = e.deltaY>0?-1:1;
            BrushPanel.set({size:settings.width+offset});
            EventBus.trigger(EVENT.drawCanvasOverlay,point);
            //console.error(settings);
        }else if (Input.isControlDown()){
            let point = canvas.getCursorPosition(e);
            let settings = Brush.getSettings();
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

    viewport.addEventListener("gesturestart", function (e) {
        e.preventDefault();
        e.stopPropagation();
        Input.holdPointerEvents();
        startScale = e.scale || 1;
        startZoom = canvas.getZoom();
        touchData.startScrollX = viewport.scrollLeft;
        touchData.startScrollY = viewport.scrollTop;
        touchData.startX = e.clientX;
        touchData.startY = e.clientY;
        console.log("gesturestart", e);
    });

    viewport.addEventListener("gesturechange", function (e) {
        e.preventDefault();
        e.stopPropagation();
        let scale = startScale *  (e.scale || 1);
        if (scale>1.1 || scale<0.9){ // avoid zoom jittering when 2-finger pan is used
            let zoom = scale * startZoom;
            canvas.setZoom(zoom);
            syncZoomLevel();

            // TODO: how do we know the center of the gesture?
            // do we need to track the touch events?

            // TODO get center of current viewport and apply x/Y scroll offset
        }

        let x = e.clientX - touchData.startX;
        let y = e.clientY - touchData.startY;
        viewport.scrollLeft = touchData.startScrollX - x;
        viewport.scrollTop = touchData.startScrollY - y;

        console.log("gesturechange prop", e);
    });

    viewport.addEventListener("gestureend", function (e) {
        e.preventDefault();
        e.stopPropagation();
        Input.releasePointerEvents();
        console.log("gestureend", e);
    });

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
        toolPanel = $div("toolpanel","",toolbar);
        EventBus.on(EVENT.toolChanged,(tool)=>{
            tool = tool || Editor.getCurrentTool();
            toolPanel.innerHTML = "";
            toolPanel.appendChild(ToolOptions.getOptions(tool));
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
    
    return me;
};



export default EditPanel;