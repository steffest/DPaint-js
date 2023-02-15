import {$div} from "../../util/dom.js";
import Selection from "../selection.js";
import EventBus from "../../util/eventbus.js";
import {COMMAND, EVENT} from "../../enum.js";
import Editor from "../editor.js";
import ImageFile from "../../image.js";
import Input from "../input.js";
import {duplicateCanvas, releaseCanvas} from "../../util/canvasUtils.js";
import Resizer from "./resizer.js";
import effects from "../effects.js";

let SelectBox = (()=>{
    let me = {};

    let box = $div("selectbox");
    let canvas;
    let ctx;
    let selectionPoints = [];
    let selecting;
    let dots;

    me.getBox = ()=>{
        return box;
    }

    me.activate = (fullCover)=>{
        box.classList.add("active");
    }

    me.deActivate = ()=>{
        box.classList.remove("active","full");
        if (canvas){
            me.endPolySelect();
            box.innerHTML = "";
            selectionPoints = [];
            selecting = false;
            canvas.remove();
            releaseCanvas(canvas);
            canvas = undefined;
        }
    }

    me.isActive = ()=>{
        return box.classList.contains("active");
    }

    me.polySelect = (point)=>{
        setupCanvas();
        if (!dots) dots = $div("dots","",box);

        if (!selecting){
            selectionPoints = [];
            Input.setActiveKeyHandler(keyHandler);
        }
        selecting = true;
        selectionPoints.push(point);
        if (selectionPoints.length===1) selectionPoints.push({x:point.x,y:point.y});

        let w = ImageFile.getCurrentFile().width;
        let h = ImageFile.getCurrentFile().height;
        Selection.set({left: 0, top: 0, width: w, height: h, points: selectionPoints});
        drawShape();
    }

    me.endPolySelect = (fromClick)=>{
        console.error("end poly");
        setTimeout(()=>{
            selecting = false;
            EventBus.trigger(COMMAND.ENDPOLYGONSELECT);
            Input.setActiveKeyHandler();
            selectionPoints = [];
        },fromClick?100:0);
    }

    me.applyCanvas = _canvas=>{
        setupCanvas();
        selectionPoints = [];
        ctx.clearRect(0,0,canvas.width,canvas.height);
        //ctx.drawImage(_canvas,0,0);

        let selectedCanvas = duplicateCanvas(_canvas,true);
        let selectedCtx = selectedCanvas.getContext("2d");

        selectedCtx.globalCompositeOperation = "source-in";
        selectedCtx.fillStyle = "white";
        selectedCtx.fillRect(0,0,canvas.width,canvas.height);
        selectedCtx.globalCompositeOperation = "source-over";

        ctx.globalAlpha = 0.5;
        ctx.drawImage(selectedCanvas,0,0);
        ctx.globalCompositeOperation = "source-in";
        ctx.fillStyle = "red";
        ctx.fillRect(0,0,canvas.width,canvas.height);
        ctx.globalCompositeOperation = "source-over";

        let boundary = effects.outline(_canvas.getContext("2d"));
        if (boundary.length){
            let data = ctx.getImageData(0,0,canvas.width,canvas.height);
            let d=data.data;
            boundary.forEach(index=>{
                let p=index>>2;
                let y = Math.floor(p/canvas.width) >> 2;
                let x = p%canvas.width >> 2;
                let c = Math.abs(((x%2)-(y%2))*255);
                d[index] = c;
                d[index+1] = c;
                d[index+2] = c;
                d[index+3] = 255;
            });
            ctx.putImageData(data,0,0);
        }

        Selection.set({
            left:0,
            right: 0,
            width: canvas.width,
            height: canvas.height,
            canvas: selectedCanvas
        })
    }

    me.update = (fromEvent)=>{
        let data = Selection.get();
        let zoom = Editor.getActivePanel().getZoom();
        if (canvas){
            data = {
                left: 0,
                top: 0,
                width: ImageFile.getCurrentFile().width,
                height: ImageFile.getCurrentFile().height,
            }
            canvas.style.width = Math.floor(canvas.width * zoom) + "px";
            canvas.style.height = Math.floor(canvas.height * zoom) + "px";
            if (selectionPoints.length) drawShape();
        }
        if (data){
            box.style.left = data.left*zoom + "px";
            box.style.top = data.top*zoom + "px";
            box.style.width = data.width*zoom + "px";
            box.style.height = data.height*zoom + "px";
        }
        if (!fromEvent) EventBus.trigger(EVENT.selectionChanged);
    }

    me.updatePoint =(point,index)=>{
        if (typeof index === "undefined") index = selectionPoints.length-1;
        let p = selectionPoints[index];
        if (p){
            p.x = point.x;
            p.y = point.y;
        }
        Selection.set({left: 0, top: 0, width: canvas.width, height: canvas.height, points: selectionPoints});
        drawShape();
    }

    function setupCanvas(){
        box.classList.add("full","active");
        let zoom = Editor.getActivePanel().getZoom();
        let w = ImageFile.getCurrentFile().width;
        let h = ImageFile.getCurrentFile().height;

        box.style.left =  "0px";
        box.style.top = "0px";
        box.style.width = w*zoom + "px";
        box.style.height = h*zoom + "px";

        if (!canvas){
            canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            canvas.style.width = Math.floor(canvas.width * zoom) + "px";
            canvas.style.height = Math.floor(canvas.height * zoom) + "px";
            box.appendChild(canvas);
            ctx = canvas.getContext("2d");
        }
    }

    function drawShape(){
        let zoom = Editor.getActivePanel().getZoom();
        ctx.clearRect(0,0,canvas.width,canvas.height);
        dots.innerHTML = "";
        ctx.lineWidth = "2px";
        ctx.beginPath();
        selectionPoints.forEach((point,index)=>{
            let dot = $div("sizedot","",dots,()=>{
                console.error("dd");
            });
            dot.onDragStart = (x,y)=>{
                point.startX = point.x;
                point.startY = point.y;
            }
            dot.onDrag = (x,y)=>{
                point.x = Math.round(point.startX + x/zoom);
                point.y = Math.round(point.startY + y/zoom);
                drawShape();
            }
            dot.style.left = point.x*zoom + "px";
            dot.style.top = point.y*zoom + "px";
            if (index){
                ctx.lineTo(point.x,point.y);
            }else{
                ctx.moveTo(point.x,point.y);
            }
        });
        ctx.closePath();

        ctx.fillStyle = "rgba(255,0,0,0.3)";
        ctx.fill();

        ctx.strokeStyle = "black";
        ctx.setLineDash([]);
        ctx.stroke();
        ctx.setLineDash([5, 5]);
        ctx.strokeStyle = "white";
        ctx.stroke();




    }

    function keyHandler(code){
        switch (code){
            case "escape":
                me.endPolySelect();
                break;
            case "enter":
                me.endPolySelect();
                break;
        }
    }

    EventBus.on(EVENT.sizerChanged,()=>{
        if (me.isActive()){
            Selection.set(Resizer.get());
            me.update(true);
        }
    })

    EventBus.on(COMMAND.TOSELECTION,()=>{
        let layer = ImageFile.getActiveLayer();
        me.applyCanvas(layer.getCanvas());
    });

    return me;
});

export default SelectBox;