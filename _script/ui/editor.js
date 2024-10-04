import Canvas from "./canvas.js";
import {$div} from "../util/dom.js";
import EventBus from "../util/eventbus.js";
import {COMMAND, EVENT} from "../enum.js";
import EditPanel from "./editpanel.js";
import ImageProcessing from "../util/imageProcessing.js";
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
    var state= {
        splitPanel: false,
        left: 250
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

            EventBus.trigger(EVENT.panelResized,0);
        }

        EventBus.on(EVENT.panelResized,width=>{
            if (!width) return;
            state.left = width + 75;
            container.style.left = state.left + "px";
        });

        EventBus.on(COMMAND.TOGGLESIDEPANEL,function(){
            console.error("toggle side panel");
            // TODO: this should probably move to a common UI service
            setTimeout(()=>{
                if (document.body.classList.contains("withsidepanel")){
                    console.error(state.left);
                    if (state.left){
                        container.style.left = state.left + "px";
                    }
                }else{
                    container.style.left = "70px";
                }
            },10);
        });
        
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
        EventBus.on(COMMAND.SPLITSCREEN,function(){
            me.splitPanel();
        });
        EventBus.on(COMMAND.ROTATE,function(){
            EventBus.trigger(COMMAND.CLEARSELECTION);
            let currentFrame = ImageFile.getActiveFrame();
            currentFrame.layers.forEach(layer=>{
                ImageProcessing.rotate(layer.getCanvas());
            })
            let w = ImageFile.getCurrentFile().width;
            ImageFile.getCurrentFile().width = ImageFile.getCurrentFile().height;
            ImageFile.getCurrentFile().height = w;
            EventBus.trigger(EVENT.imageSizeChanged);
        });
        EventBus.on(COMMAND.CLEAR,function(){
            var s = Selection.get();
            let layer = ImageFile.getActiveLayer();
            if (!layer) return;
            HistoryService.start(EVENT.layerContentHistory);
            if (s){
                if (s.canvas || s.points){
                    let canvas = Selection.getCanvas();
                    let layerCtx = layer.getContext();
                    layerCtx.globalCompositeOperation = "destination-out";
                    layerCtx.drawImage(canvas,0,0);
                    layerCtx.globalCompositeOperation = "source-over";
                    releaseCanvas(canvas);
                }else{
                    // rectangular selection
                    layer.getContext().clearRect(s.left,s.top,s.width,s.height);
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
                HistoryService.start(EVENT.imageHistory);
                ImageFile.getCurrentFile().frames.forEach(frame=>{
                    frame.layers.forEach(layer=>{
                        let c = layer.getCanvas();
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
                        releaseCanvas(canvas);
                    })
                });
                ImageFile.getCurrentFile().width = s.width;
                ImageFile.getCurrentFile().height = s.height;
                Selection.move(0,0,s.width,s.height);
                HistoryService.end();
                EventBus.trigger(EVENT.imageSizeChanged);
            }
        });
        EventBus.on(COMMAND.TRIM,()=>{
            let ctx = ImageFile.getActiveContext();
            let canvas = ctx.canvas;
            let box = ImageFile.getLayerBoundingRect();
            if (!box.w || !box.h) return;
            let cut = ctx.getImageData(box.x, box.y, box.w, box.h);
            if (box.w === canvas.width && box.h === canvas.height && box.x === 0) return;

            HistoryService.start(EVENT.imageHistory);
            canvas.width = box.w;
            canvas.height = box.h;
            ctx.putImageData(cut, 0, 0);
            ImageFile.getCurrentFile().width = canvas.width;
            ImageFile.getCurrentFile().height = canvas.height;
            HistoryService.end();
            EventBus.trigger(EVENT.imageSizeChanged);
        })

        EventBus.on(COMMAND.TRANSFORMLAYER,()=>{

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
            ctx.drawImage(ImageFile.getActiveContext().canvas,box.x,box.y,box.w,box.h,0,0,box.w,box.h);

            HistoryService.start(EVENT.layerContentHistory);
            touchData.transformLayer = ImageFile.getActiveLayer();
            resizer.setOnUpdate(updateTransform);
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
                        ctx2.fillRect(x,y,1,1);
                    }
                }
            }
            EventBus.trigger(EVENT.imageContentChanged);
            EventBus.trigger(EVENT.colorCount,count);
            return layerIndex;
        })

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
            Modal.show(DIALOG.PALETTE);
        })
        EventBus.on(COMMAND.EFFECTS, ()=>{
            Modal.show(DIALOG.EFFECTS);
        })
        EventBus.on(EVENT.toolChanged,(tool)=>{
            me.commit();
            Cursor.reset();
            if (tool === COMMAND.SELECT || tool === COMMAND.FLOODSELECT || tool === COMMAND.POLYGONSELECT){
                currentTool = tool;
                Cursor.set("select");
                EventBus.trigger(COMMAND.INITSELECTION,tool);
            }
        });
        EventBus.on(EVENT.sidePanelChanged,(tool)=>{

        });

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
            console.log("commit layer");
            resizer.commit();
            updateTransform(true).then(()=>{
                clearTransform();
                EventBus.trigger(COMMAND.CLEARSELECTION);
                currentTool = undefined;
                HistoryService.end();
                if (previousTool) EventBus.trigger(previousTool);
            });
        }
        if (currentTool === COMMAND.POLYGONSELECT){
            EventBus.trigger(COMMAND.ENDPOLYGONSELECT);
        }
    }

    me.reset = function(){
        if (currentTool === COMMAND.TRANSFORMLAYER){
            resizer.commit();
            resetTransform();
            clearTransform();
            currentTool = undefined;
            HistoryService.neverMind();
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
        return (currentTool === COMMAND.DRAW || currentTool === COMMAND.SQUARE || currentTool === COMMAND.GRADIENT || currentTool === COMMAND.LINE || currentTool === COMMAND.CIRCLE  ||  currentTool === COMMAND.SPRAY ||  currentTool === COMMAND.ERASE);
    }

    me.usesBrush = (tool)=>{
        let t = tool || currentTool;
        return (t === COMMAND.DRAW || t === COMMAND.SPRAY || t === COMMAND.ERASE);
    }

    async function updateTransform(final,onDone){
        if (!touchData.transformLayer) return;
        console.log("update transform layer");
        let d = resizer.get();
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

            let x = d.left + (d.width - w) / 2;
            let y = d.top + (d.height - h) / 2;

            if (Palette.isLocked()){
                // rotated is a WEBGL canvas
                rotated = duplicateCanvas(rotated,true);
                Palette.applyToCanvas(rotated);
            }

            ctx.drawImage(rotated,x,y,w,h);
        }else{
            if (d.rotation){
                console.log("rotate " + d.rotation);

                let dw = (d.left + d.width/2);
                let dh = (d.top + d.height/2);
                ctx.translate(dw,dh);
                ctx.rotate((d.rotation * Math.PI) / 180);
                ctx.translate(-dw,-dh);
            }

            ctx.drawImage(touchData.transformCanvas,d.left,d.top,d.width,d.height);
            ctx.setTransform(1, 0, 0, 1, 0, 0);

            if (angled && final && Palette.isLocked()){
                Palette.applyToCanvas(ctx.canvas,true);
            }
        }
        EventBus.trigger(EVENT.layerContentChanged);
    }

    function resetTransform(){
        touchData.transformLayer.clear();
        let ctx = touchData.transformLayer.getContext();
        let box = touchData.transformBox;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(touchData.transformCanvas,box.x,box.y,box.w,box.h);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        EventBus.trigger(EVENT.layerContentChanged);
    }

    function clearTransform(){
        touchData.transformBox = undefined;
        if (touchData.transformCanvas) releaseCanvas(touchData.transformCanvas);
        touchData.transformLayer = undefined;
    }


    return me;
}();

export default Editor;