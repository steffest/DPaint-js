import {$div} from "../util/dom.js";
import EventBus from "../util/eventbus.js";
import {COMMAND, EVENT} from "../enum.js";
import Canvas from "./canvas.js";
import Editor from "./editor.js";
import ImageFile from "../image.js";

var EditPanel = function(parent,type){
    var me = {};
    var zoomLevels = [0.1,0.25,0.5,1,2,3,4,6,8,10,15,20,30,50,100];
    
    var panel = $div("panel " + type,"",parent);

    var toolbar = $div("toolbar","",panel);
    var viewport = $div("viewport","",panel);
    
    var thisPanel = type === "left" ? 0:1;
    if (thisPanel === 1) panel.style.display = "none";
    me.getViewPort = function(){
        return viewport;
    }
    var canvas = Canvas(me);

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

    me.set = function(image,reset){
        console.error("DEPRECATED");
        //canvas.set(image,reset);
        //syncZoomLevel();

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
    $div("button","-",toolbar,()=>{
        var z =  canvas.getZoom();
        for (var i=zoomLevels.length-1;i>=0;i--){
            var zoom = zoomLevels[i];
            if (zoom<z) break;
        }
        canvas.setZoom(zoom);
        syncZoomLevel();
    })
    var zoombutton = $div("button auto","100%",toolbar,()=>{
        canvas.setZoom(1);
        syncZoomLevel();
    })
    $div("button","+",toolbar,()=>{
        var z =  canvas.getZoom();
        for (var i=0;i<zoomLevels.length-1;i++){
            var zoom = zoomLevels[i];
            if (zoom>z) break;
        }
        canvas.setZoom(zoom);
        syncZoomLevel();
    })
    $div("button expand","",toolbar,me.zoomToFit);

    EventBus.on(EVENT.imageSizeChanged,()=>{
       setTimeout(syncZoomLevel,20);
    })
    
    return me;
};



export default EditPanel;