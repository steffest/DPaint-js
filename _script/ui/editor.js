import Canvas from "./canvas.js";
import {$div} from "../util/dom.js";
import EventBus from "../util/eventbus.js";
import {COMMAND, EVENT} from "../enum.js";
import EditPanel from "./editpanel.js";
import ImageProcessing from "../util/imageProcessing.js";
import ImageFile from "../image.js";
import Selection from "./selection.js";
import Palette from "./palette.js";
import Resizer from "./components/resizer.js";
import Color from "../util/color.js";
import Modal, {DIALOG} from "./modal.js";

var Editor = function(){
    var me = {};
    let panels=[];
    let divider;
    var container;
    var zoomFactor = 1.1;
    var activePanel;
    var currentTool = COMMAND.DRAW;
    var touchData = {};
    var state= {
        splitPanel: false
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

        divider.onDrag = function(x,y){
            console.error(x,y);
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
        
        EventBus.on(COMMAND.ZOOMIN,function(center){
            activePanel.zoom(zoomFactor,center);
        });
        EventBus.on(COMMAND.ZOOMOUT,function(center){
            activePanel.zoom(1/zoomFactor,center);
        });
        EventBus.on(COMMAND.DRAW,function(){
            currentTool = COMMAND.DRAW;
            document.body.classList.remove("select");
            document.body.classList.add("draw");
        });
        EventBus.on(COMMAND.ERASE,function(){
            currentTool = COMMAND.ERASE;
            document.body.classList.remove("select");
            document.body.classList.add("draw");
        });
        EventBus.on(COMMAND.SELECT,function(){
            currentTool = COMMAND.SELECT;
            document.body.classList.add("select");
            document.body.classList.remove("draw");
        });
        EventBus.on(COMMAND.SQUARE,function(){
            currentTool = COMMAND.SQUARE;
            document.body.classList.add("select");
            document.body.classList.remove("draw");
        });
        EventBus.on(COMMAND.CIRCLE,function(){
            currentTool = COMMAND.CIRCLE;
            document.body.classList.add("select");
            document.body.classList.remove("draw");
        });
        EventBus.on(COMMAND.SPLITSCREEN,function(){
            me.splitPanel();
        });
        EventBus.on(COMMAND.ROTATE,function(){
            EventBus.trigger(COMMAND.CLEARSELECTION);
            ImageProcessing.rotate(ImageFile.getCanvas());
            EventBus.trigger(EVENT.imageSizeChanged);
        });
        EventBus.on(COMMAND.SHARPEN,function(){
            EventBus.trigger(COMMAND.CLEARSELECTION);
            ImageProcessing.sharpen(ImageFile.getCanvas());
            EventBus.trigger(EVENT.imageSizeChanged);
        });
        EventBus.on(COMMAND.BLUR,function(){
            EventBus.trigger(COMMAND.CLEARSELECTION);
            ImageProcessing.blur(ImageFile.getCanvas());
            EventBus.trigger(EVENT.imageSizeChanged);
        });
        EventBus.on(COMMAND.CLEAR,function(){
            var s = Selection.get();
            let ctx = ImageFile.getActiveContext();
            if (ctx) ctx.fillStyle = Palette.getBackgroundColor();
            if (s){
                ctx.fillRect(s.left,s.top,s.width,s.height);
            }else{
                s = ImageFile.getCurrentFile();
                ctx.fillRect(0,0,s.width,s.height);
            }
            EventBus.trigger(EVENT.imageContentChanged);
        });
        EventBus.on(COMMAND.CROP,function(){
            var s = Selection.get();
            if (s){
                let c = ImageFile.getCanvas();
                let ctx = c.getContext("2d");
                let canvas = document.createElement("canvas");
                canvas.width = s.width;
                canvas.height = s.height;

                canvas.getContext("2d").clearRect(0,0,s.width,s.height);
                canvas.getContext("2d").drawImage(c,s.left,s.top,s.width,s.height,0,0,s.width,s.height);
                c.width = s.width;
                c.height = s.height;
                ctx.clearRect(0,0,s.width,s.height);
                ctx.drawImage(canvas,0,0);
                Selection.move(0,0,s.width,s.height);
                EventBus.trigger(EVENT.imageSizeChanged);

            }
        });
        EventBus.on(COMMAND.TRIM,()=>{
            let ctx = ImageFile.getActiveContext();
            let canvas = ctx.canvas;
            let box = ImageFile.getLayerBoundingRect();
            let cut = ctx.getImageData(box.x, box.y, box.w, box.h);

            canvas.width = box.w;
            canvas.height = box.h;
            ctx.putImageData(cut, 0, 0);
            EventBus.trigger(EVENT.imageSizeChanged);
        })

        EventBus.on(COMMAND.TRANSFORMLAYER,()=>{
            currentTool = COMMAND.TRANSFORMLAYER;
            let box = ImageFile.getLayerBoundingRect();
            Resizer.set(box.x,box.y,box.w,box.h,false,activePanel.getViewPort(),box.w/box.h);
            let sizeCanvas = document.createElement("canvas");
            sizeCanvas.width = box.w;
            sizeCanvas.height = box.h;
            sizeCanvas.getContext("2d").drawImage(ImageFile.getActiveContext().canvas,box.x,box.y,box.w,box.h,0,0,box.w,box.h);
            Resizer.setOverlay(sizeCanvas)
        });

        EventBus.on(COMMAND.COLORMASK,()=>{
            let ctx = ImageFile.getActiveContext();
            let color = Palette.getDrawColor();
            let w = ImageFile.getCurrentFile().width;
            let h = ImageFile.getCurrentFile().height;
            let data = ctx.getImageData(0,0,w,h).data;
            let layerIndex = ImageFile.addLayer();
            let layer = ImageFile.getLayer(layerIndex);
            layer.type = "pixelSelection";
            let ctx2 = ImageFile.getLayer(layerIndex).getContext();
            ctx2.fillStyle = "red";
            for (let y = 0;y<h;y++){
                for (let x = 0;x<w;x++){
                    let index = (y*w + x) * 4;
                    let r = data[index];
                    let g = data[index+1];
                    let b = data[index+2];
                    let c = Color.toString([r,g,b]);
                    if (c === color){
                        ctx2.fillRect(x,y,1,1);
                    }
                }
            }
            EventBus.trigger(EVENT.imageContentChanged);
            return layerIndex;
        })

        EventBus.on(COMMAND.EDITPALETTE, ()=>{
            Modal.show(DIALOG.PALETTE);
        })

    }

    me.set = function(image){
        //panels.forEach(panel=>panel.set(image,true));
    }

    me.setPanel = function(image,index){
        //panels[index].set(image,false);
    }

    me.setActivePanel = function(panel){
        activePanel = panels[panel];
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
        }else{
            panels[0].setWidth("calc(50% - 4px)");
            panels[1].setWidth("calc(50% - 4px)");
            panels[1].show();
            divider.style.display = "block";
            EventBus.trigger(EVENT.imageSizeChanged);
        }
    }

    me.isStateActive = function(name){
        return !!state[name];
    }

    me.commit = function(){
        if (currentTool === COMMAND.TRANSFORMLAYER){
            console.error("commit layer");
            let d = Resizer.get();
            let box = ImageFile.getLayerBoundingRect();
            console.error(box,d);

            let sizeCanvas = document.createElement("canvas");
            sizeCanvas.width = box.w;
            sizeCanvas.height = box.h;
            let sctx = sizeCanvas.getContext("2d");
            sctx.imageSmoothingEnabled = false;
            sctx.drawImage(ImageFile.getActiveContext().canvas,box.x,box.y,box.w,box.h,0,0,box.w,box.h);

            let layer = ImageFile.getActiveLayer();
            layer.clear();
            let ctx = layer.getContext();
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(sizeCanvas,d.left,d.top,d.width,d.height);
            EventBus.trigger(COMMAND.CLEARSELECTION);
            EventBus.trigger(EVENT.layerContentChanged);

        }
    }


    return me;
}();

export default Editor;