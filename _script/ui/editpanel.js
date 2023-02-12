import {$div} from "../util/dom.js";
import EventBus from "../util/eventbus.js";
import {COMMAND, EVENT} from "../enum.js";
import Canvas from "./canvas.js";
import Editor from "./editor.js";
import ImageFile from "../image.js";
import ToolOptions from "./components/toolOptions.js";

var EditPanel = function(parent,type){
    var me = {};
    var zoomLevels = [0.1,0.25,0.5,1,2,3,4,6,8,10,15,20,30,50,100];
    
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
        let point = [e.clientX,e.clientY];
        e.preventDefault();
        if (e.deltaY>0){
            EventBus.trigger(COMMAND.ZOOMOUT,e);
        }else if (e.deltaY<0){
            EventBus.trigger(COMMAND.ZOOMIN,e);
        }
    });

    panel.addEventListener("mousemove",()=>{
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