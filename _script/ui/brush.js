import {$div} from "../util/dom.js";
import EventBus from "../util/eventbus.js";
import {COMMAND, EVENT} from "../enum.js";
import Palette from "./palette.js";
import Color from "../util/color.js";
import Editor from "./editor.js";
import ImageFile from "../image.js";
import ToolOptions from "./components/toolOptions.js";
import {duplicateCanvas, releaseCanvas} from "../util/canvasUtils.js";
import ImageProcessing from "../util/imageProcessing.js";
import Modal from "./modal.js";
import BrushPanel from "./toolPanels/brushPanel.js";

/*
Brush Types:
 - square
 - circle
 - cross (fixed size)
 - canvas (fixed size)
 - brush (canvas with dynamic size)
 */

var Brush = function(){
    var me = {};
    var container;
    let pressure = 1;
    let rotationCache = {};

    let presets = [
        {
            type: "square",
            width: 1,
            height: 1,
            softness: 0,
            opacity: 100,
            flow: 100,
            jitter: 0,
            rotation: 0
        },
        {
            type: "circle",
            width: 3,
            height: 3,
            softness: 0,
            opacity: 100,
            flow: 100,
            jitter: 0,
            rotation: 0
        },
        {
            type: "cross",
            width: 5,
            height: 5,
            softness: 0,
            opacity: 100,
            flow: 100,
            jitter: 0,
            rotation: 0
        },
        {
            type: "circle",
            width: 5,
            height: 5,
            softness: 0,
            opacity: 100,
            flow: 100,
            jitter: 0,
            rotation: 0
        },
        {
            type: "circle",
            width: 7,
            height: 7,
            softness: 0,
            opacity: 100,
            flow: 100,
            jitter: 0,
            rotation: 0
        },
        {
            type: "square",
            width: 9,
            height: 9,
            softness: 0,
            opacity: 100,
            flow: 100,
            jitter: 0,
            rotation: 0
        },
        {
            type: "square",
            width: 7,
            height: 7,
            softness: 0,
            opacity: 100,
            flow: 100,
            jitter: 0,
            rotation: 0
        },
        {
            type: "square",
            width: 5,
            height: 5,
            softness: 0,
            opacity: 100,
            flow: 100,
            jitter: 0,
            rotation: 0
        },
        {
            type: "square",
            width: 3,
            height: 3,
            softness: 0,
            opacity: 100,
            flow: 100,
            jitter: 0,
            rotation: 0
        },
        {
            type: "canvas",
            width: 7,
            height: 7,
            softness: 0,
            opacity: 100,
            flow: 100,
            jitter: 0,
            rotation: 0
        },
        {
            type: "brush",
            width: 3,
            height: 3,
            softness: 0,
            opacity:90,
            flow: 90,
            jitter:10,
            rotation: 0,
            url: "brush1.png"
        },
        {
            type: "brush",
            width: 6,
            height: 6,
            softness: 0,
            opacity:80,
            flow: 80,
            jitter:10,
            rotation: 0,
            url: "brush2.png"
        },
        {
            type: "brush",
            width: 10,
            height: 10,
            softness: 0,
            opacity:80,
            flow: 80,
            jitter:10,
            rotation: 0,
            url: "brush3.png"
        },
        {
            type: "brush",
            width: 14,
            height: 14,
            softness: 0,
            opacity:70,
            flow: 70,
            jitter:20,
            rotation: 50,
            url: "brush3.png"
        }

    ]

    let currentBrush =  Object.assign({},presets[0]);


    var brushCanvas = document.createElement("canvas");
    var brushBackCanvas = document.createElement("canvas");
    let brushCtx = brushCanvas.getContext("2d");
    let brushBackCtx = brushBackCanvas.getContext("2d");
    let brushAlphaLayer;

    me.init = function(parent){
        container = $div("brushes info","",parent);
        container.info = "Select the brush for drawing";
        for (var i = 0; i<10;i++){
            let b = $div("brush","",container,(e)=>{
                let index = e.target.index || 0;
                me.set("preset",index);
                let currentTool = Editor.getCurrentTool();
                if (!(currentTool === COMMAND.DRAW || currentTool === COMMAND.ERASE)){
                    EventBus.trigger(COMMAND.DRAW);
                }
            })
            let x = -(i % 5)*11 + "px";
            let y = (Math.floor(i / 5) * -11) + "px";
            b.style.backgroundPosition = x + " " + y;
            b.index = i;
            if (!i) b.classList.add("active");
            let p = presets[i];
            p.element = b;
        }
        
        EventBus.on(EVENT.drawColorChanged,()=>{
            if (currentBrush.type === "brush" && !currentBrush.url) currentBrush.isStencil = true;
            generateBrush();
        })
        EventBus.on(EVENT.backgroundColorChanged,()=>{
            generateBrush();
        })
    }

    me.get = function(){
        return currentBrush;
    }

    me.set = function(type,data){
        if (type === "preset" && typeof(data) === "number") {

            let currentTool = Editor.getCurrentTool();
            if (!(currentTool === COMMAND.DRAW || currentTool === COMMAND.ERASE)){
                EventBus.trigger(COMMAND.DRAW);
            }

            if (data<10){
                // these are the fixed presets from the toolbar
                for (let i = 0; i<10;i++){
                    let p = presets[i];
                    p.element.classList.toggle("active",i===data);
                }
            }
            data = presets[data] || presets[0];

            if (data.type === "brush" && data.url && !data.img){
                let img = new Image();
                img.onload = ()=>{
                    console.log("Loaded brush " + data.url);
                    data.img = img;
                    rotationCache = {};
                    me.set("brush",data);
                }
                img.onerror = ()=>{
                    Modal.alert("Failed to load brush preset");
                }
                img.src = "./_img/brushes/" + data.url;
                return;
            }
        }

        if (type === "canvas"){
            currentBrush = {
                type: "brush",
                img: data,
                width: data.width,
                height: data.height,
                softness: 0,
                opacity: 100,
                flow: 100,
                jitter: 0
            };
            brushAlphaLayer = undefined;
            rotationCache = {};
            generateBrush();
            EventBus.trigger(EVENT.brushOptionsChanged);
            return;
        }


        rotationCache = {};
        currentBrush = Object.assign({},data);
        brushAlphaLayer = undefined;
        generateBrush();
        EventBus.trigger(EVENT.brushOptionsChanged);

        /*if (type === "canvas" || type === "brush"){
            // Note: "data" is an image object in this case.
            brushType = type;
            brushIndex = -1;
            console.error(index);
            brushCanvas.width = brushBackCanvas.width = index.width;
            brushCanvas.height = brushBackCanvas.height = index.height;
            brushCtx.clearRect(0,0,brushCanvas.width,brushCanvas.height);
            brushCtx.drawImage(index,0,0);
            brushBackCtx.clearRect(0,0,brushCanvas.width,brushCanvas.height);
            brushBackCtx.drawImage(index,0,0);
            // TODO: What do we draw when grabbing a stencil with right-click draw ?
            brushAlphaLayer = undefined;
        }*/

    }

    me.setSize = function(width, height){
        currentBrush.width = parseInt(width);
        currentBrush.height = parseInt(height) || parseInt(width);
        brushAlphaLayer = undefined;
        generateBrush();
        EventBus.trigger(EVENT.brushOptionsChanged);
    }

    me.setOpacity = function(opacity){
        currentBrush.opacity = parseInt(opacity);
        EventBus.trigger(EVENT.brushOptionsChanged);
    }

    me.getOpacity = ()=>{
        return currentBrush.opacity/100;
    }

    me.setPressure = (p)=>{
        pressure = p;
    }

    me.getPressure = ()=>{
        return pressure;
    }

    me.setFlow = (f)=>{
        currentBrush.flow = parseInt(f);
        EventBus.trigger(EVENT.brushOptionsChanged);
    }

    me.getFlow = ()=>{
        return currentBrush.flow;
    }

    me.setJitter = (j)=>{
        currentBrush.jitter = j;
        EventBus.trigger(EVENT.brushOptionsChanged);
    }

    me.getJitter = ()=>{
        return currentBrush.jitter;
    }

    me.setSoftness = (f)=>{
        currentBrush.softness = parseInt(f);
        if (currentBrush.type === "square" && currentBrush.softness){
            currentBrush.type = "circle";
        }
        generateBrush();
        EventBus.trigger(EVENT.brushOptionsChanged);
    }

    me.setRotation = (r)=>{
        currentBrush.rotation = parseInt(r);
        EventBus.trigger(EVENT.brushOptionsChanged);
    }

    me.draw = function(ctx,x,y,color,onBackground,blendColor,isDrawing,isFirst){
        let p;
        let useCustomBlend = blendColor && Palette.isLocked();
        let useOpacity = ToolOptions.usePressure() && !useCustomBlend;
        let finalColor = color;

        let w = currentBrush.width;
        let h = currentBrush.height;

        let drawCanvas = brushCanvas;
        let drawBackCanvas = brushBackCanvas;

        if (isDrawing && currentBrush.rotation && (currentBrush.type === "brush" || currentBrush.type === "canvas") && currentBrush.img){
             let maxAngle = (currentBrush.rotation / 100) * 360;
             let angle = Math.floor(Math.random() * maxAngle);

             if (rotationCache[angle]){
                 drawCanvas = rotationCache[angle];
             }else{
                 // Create rotated version
                 // 1. rotate original image
                 let tempCanvas = document.createElement("canvas");
                 let size = Math.max(currentBrush.img.width, currentBrush.img.height) * 1.5; // enough space
                 tempCanvas.width = size;
                 tempCanvas.height = size;
                 let tCtx = tempCanvas.getContext("2d");
                 tCtx.translate(size/2, size/2);
                 tCtx.rotate(angle * Math.PI / 180);
                 tCtx.drawImage(currentBrush.img, -currentBrush.img.width/2, -currentBrush.img.height/2);
                 tCtx.setTransform(1, 0, 0, 1, 0, 0);

                 // Trim empty space? Maybe too expensive.
                 // But we need to update w and h for this draw call?
                 // If we change w and h, it might affect spacing.
                 // For now, let's keep it simple and just colorize.

                 rotationCache[angle] = tempCanvas;
                 drawCanvas = tempCanvas;
             }

             // Cache = Raw Rotated.
             // Render = Clone Cache -> Colorize.
             // Since "generateStencil" logic is simple (fillRect + composite), it might be fast enough.

             if (currentBrush.url || currentBrush.isStencil){
                 let coloredCanvas = duplicateCanvas(drawCanvas, true);
                 let cCtx = coloredCanvas.getContext("2d");
                 cCtx.globalCompositeOperation = "source-in";
                 cCtx.fillStyle = Palette.getDrawColor();
                 cCtx.fillRect(0,0,coloredCanvas.width,coloredCanvas.height);
                 // If we have an alpha mask (brushAlphaLayer logic)... but here we just use source-in on the image itself.
                 drawCanvas = coloredCanvas;
             }
             
             let scaleX = currentBrush.width / currentBrush.img.width;
             let scaleY = currentBrush.height / currentBrush.img.height;
             w = drawCanvas.width * scaleX;
             h = drawCanvas.height * scaleY;
        }

        if (w>1) x -= Math.floor((w-1)/2);
        if (h>1) y -= Math.floor((h-1)/2);

        if (isDrawing && currentBrush.jitter && !isFirst){
            let jx = (Math.random() - 0.5) * currentBrush.jitter * w * 0.05;
            let jy = (Math.random() - 0.5) * currentBrush.jitter * h  * 0.05;

            if (currentBrush.type === "square" || ! currentBrush.softness){
                jx = Math.round(jx);
                jy = Math.round(jy);
            }
            x+=jx;
            y+=jy;
        }


        if (useOpacity){
            p = ctx.globalAlpha;
            ctx.globalAlpha = pressure;
        }else{
            ctx.globalAlpha = 1;
        }

        if (isDrawing && currentBrush.flow<100){
            let c = currentBrush.flow * Math.random() * 0.01;
            ctx.globalAlpha *= c;
        }

        if (isDrawing && ToolOptions.usePressure()){
            let sizeFactor = 10;
            w = Math.max(1, w * pressure * (Math.random() * 0.5 + 0.5) * sizeFactor);
            h = Math.max(1, h * pressure * (Math.random() * 0.5 + 0.5) * sizeFactor);
        }

        if (currentBrush.type === "canvas" || currentBrush.type === "circle"){
            if (onBackground){
                ctx.drawImage(drawBackCanvas,x,y);
            }else{
                ctx.drawImage(drawCanvas,x,y);
            }
        }else if (currentBrush.type === "brush"){
            if (onBackground){
                ctx.drawImage(drawBackCanvas,x,y,w,h);
            }else{
                ctx.drawImage(drawCanvas,x,y,w,h);
            }
        }else{
            if (blendColor && Palette.isLocked()){
                let c = Color.fromString(color);
                let imageCtx = ImageFile.getContext();
                let data = imageCtx.getImageData(x,y,w,h);
                let opacity2 = currentBrush.opacity/100;
                if (ToolOptions.usePressure()){
                    opacity2 *= pressure;
                }


                for (let i = 0; i<data.data.length;i+=4){
                    let sourceColor = [data.data[i],data.data[i+1],data.data[i+2]];
                    let targetColor = Color.blend(sourceColor,c,opacity2);
                    finalColor = Palette.matchColor(targetColor);

                    console.log(sourceColor,finalColor);
                    if (Color.equals(sourceColor,finalColor) && !Color.equals(sourceColor,c)){
                       opacity2 *= 1.5;
                       if (opacity2>1) opacity2 = 1;
                        targetColor = Color.blend(sourceColor,c,opacity2);
                        finalColor = Palette.matchColor(targetColor);
                    }

                    data.data[i] = finalColor[0];
                    data.data[i+1] = finalColor[1];
                    data.data[i+2] = finalColor[2];
                    data.data[i+3] = 255;
                }
                ctx.putImageData(data,x,y);
            }else{
                ctx.fillStyle = color;
                ctx.fillRect(x,y,w,h);
            }

        }

        if (useOpacity){
            ctx.globalAlpha = p;
        }

        return{
            x:x,
            y:y,
            width:w,
            height:h,
            color:finalColor
        };

    }

    me.rotate = (left)=>{
        if (currentBrush.type === "canvas" || currentBrush.type === "brush"){
            ImageProcessing.rotate(brushCanvas,left);
            currentBrush.width = brushCanvas.width;
            currentBrush.height = brushCanvas.height;
            brushAlphaLayer = undefined;
            EventBus.trigger(EVENT.drawCanvasOverlay);
        }
    }

    me.flip = (horizontal)=>{
        let canvas = duplicateCanvas(brushCanvas, true);
        brushCtx.clearRect(0,0,canvas.width,canvas.height);
        if (horizontal) {
            brushCtx.translate(canvas.width, 0);
            brushCtx.scale(-1, 1);
        }else{
            brushCtx.translate(0, canvas.height);
            brushCtx.scale(1, -1);
        }
        brushCtx.drawImage(canvas, 0, 0);
        brushCtx.setTransform(1, 0, 0, 1, 0, 0);
        releaseCanvas(canvas);
        brushAlphaLayer = undefined;

        //brushBackCtx.clearRect(0,0,brushCanvas.width,brushCanvas.height);
        //brushBackCtx.drawImage(brushCanvas,0,0);
        generateBackBrush();
        window.debug = true;

        EventBus.trigger(EVENT.drawCanvasOverlay);

    }

    me.export = ()=>{
        let currentFile = ImageFile.getCurrentFile();
        let struct = {
            type: "dpaint",
            version: "1",
            image: {},
        };
        struct.image.name = currentFile.name + "_brush";
        struct.image.width = brushCanvas.width;
        struct.image.height = brushCanvas.height;
        struct.image.frames = [{
            layers: [{
                name: "brush",
                opacity:1,
                visible:true,
                hasMask: false,
                canvas: brushCanvas.toDataURL()
            }]
        }];

        return struct;
    }

    me.import = (data)=>{
        if (!data) return;
        if (data.image && data.type === "dpaint"){
            let frame = data.image.frames[0];
            let layer = frame.layers[0];
            let canvas = new Image();
            canvas.onload = ()=>{
                me.set("canvas",canvas);
                EventBus.trigger(EVENT.drawCanvasOverlay);
            }
            canvas.src = layer.canvas;
        }else{
            if (data.width && data.height){
                me.set("canvas",data);
                EventBus.trigger(EVENT.drawCanvasOverlay);
            }
        }
    }

    me.openLocal = ()=>{
        ImageFile.openLocal("brush");
    }
    
    function generateBrush(){
        console.log("Generating brush",currentBrush);
        brushCanvas.width = brushBackCanvas.width = currentBrush.width;
        brushCanvas.height = brushBackCanvas.height = currentBrush.height;
        brushCtx.clearRect(0,0,currentBrush.width,currentBrush.height);
        brushCtx.fillStyle = Palette.getDrawColor();

        switch (currentBrush.type){
            case "square":
                brushCtx.fillRect(0,0,currentBrush.width,currentBrush.height);
                break;
            case "circle":
                let wx = currentBrush.width/2;
                let wh = currentBrush.height/2;

                if (currentBrush.softness){
                    console.error(typeof currentBrush.softness)
                    if (currentBrush.softness === 1){
                        // default anti-aliased circle
                        brushCtx.beginPath();
                        brushCtx.ellipse(wx,wh,wx,wh, 0, 0,
                            2 * Math.PI);
                        brushCtx.fill();
                    }else{
                        let opacityStep = 1/wx/currentBrush.softness;
                        let opacity = opacityStep;
                        let c=Color.fromString(Palette.getDrawColor());
                        for (let radius=wx;radius>0;radius--){
                            brushCtx.globalAlpha = Math.min(opacity,1);

                            brushCtx.beginPath();
                            brushCtx.ellipse(wx, wh, radius, radius, 0, 0, 2 * Math.PI);
                            brushCtx.fill();
                            opacity+=opacityStep;

                        }

                        // hmm... this doesn't preserve the color 100%
                        // reset color
                        // TODO: better way of generating transparent brushes;
                        let data = brushCtx.getImageData(0,0,currentBrush.width,currentBrush.height);
                        let d=data.data;
                        for (let i = 0, max = d.length; i<max; i += 4){
                            d[i]=c[0];
                            d[i+1]=c[1];
                            d[i+2]=c[2];
                        }
                        brushCtx.putImageData(data,0,0);
                    }
                }else{
                    // non anti-aliased circle
                    switch (currentBrush.width){
                        case 3:
                            brushCtx.fillRect(0,1,3,1);
                            brushCtx.fillRect(1,0,1,3);
                            break;
                        case 5:
                            brushCtx.fillRect(0,1,5,3);
                            brushCtx.fillRect(1,0,3,5);
                            break;
                        case 7:
                            brushCtx.fillRect(0,2,7,3);
                            brushCtx.fillRect(2,0,3,7);
                            brushCtx.fillRect(1,1,5,5);
                            break;
                        default:
                            brushCtx.beginPath();
                            brushCtx.ellipse(wx,  wh,wx, wh, 0, 0,
                                2 * Math.PI);
                            brushCtx.fill();

                            // make sure we have solid edges
                            let data = brushCtx.getImageData(0,0,currentBrush.width,currentBrush.height);
                            let d=data.data;
                            let c=Color.fromString(Palette.getDrawColor());
                            for (let i = 0, max = d.length; i<max; i += 4){
                                if (d[i+3]>0){
                                    d[i]=c[0];
                                    d[i+1]=c[1];
                                    d[i+2]=c[2];
                                    d[i+3]=255;
                                }
                            }
                            brushCtx.putImageData(data,0,0);
                    }
                }
                break;
            case "brush":
                if (currentBrush.img){
                    brushCtx.drawImage(currentBrush.img,0,0,currentBrush.width,currentBrush.height);
                }
                // apply current color
                if (currentBrush.url || currentBrush.isStencil) generateStencil();
                break;
            default:
                console.error("Invalid brush type");
        }

        /*switch (brushIndex){
            case 1:
                brushCtx.fillRect(0,1,3,1);
                brushCtx.fillRect(1,0,1,3);
                break;
            case 2:
                brushCtx.fillRect(0,2,5,1);
                brushCtx.fillRect(2,0,1,5);
                brushCtx.fillRect(1,1,3,3);
                break;
            case 3:
                brushCtx.fillRect(0,1,5,3);
                brushCtx.fillRect(1,0,3,5);
                break;
            case 4:
                brushCtx.fillRect(0,2,7,3);
                brushCtx.fillRect(2,0,3,7);
                brushCtx.fillRect(1,1,5,5);
                break;
            case 9:
                brushCtx.fillRect(2,0,1,1);
                for (var y=1;y<6;y++){
                    var c = 0;
                    if (y%2===1) c=1;
                    if (y===4) c=2;
                    for (var x=0;x<5;x+=2){
                        brushCtx.fillRect(x+c,y,1,1);
                    }
                }
                brushCtx.fillRect(4,6,1,1);
                break;
            case 100:
                // dynamic Brush
                let cx = dynamicSettings.width/2;
                let cy = dynamicSettings.height/2;
                let wx = dynamicSettings.width/2;
                let wh = dynamicSettings.height/2;

                let color = Palette.getDrawColor();
                if (color === "transparent") color="black";
                brushCtx.fillStyle = color;

                if (dynamicSettings.softness){
                    let opacityStep = 1/wx/dynamicSettings.softness;
                    let opacity = opacityStep;
                    let c=Color.fromString(Palette.getDrawColor());
                    for (let radius=wx;radius>0;radius--){
                        brushCtx.globalAlpha = Math.min(opacity,1);

                        brushCtx.beginPath();
                        brushCtx.ellipse(cx, cy,radius, radius, 0, 0, 2 * Math.PI);
                        brushCtx.fill();
                        opacity+=opacityStep;

                    }

                    // hmm... this doesn't preserve the color 100%
                    // reset color
                    // TODO: better way of generating transparent brushes;
                    let data = brushCtx.getImageData(0,0,width,height);
                    let d=data.data;
                    for (let i = 0, max = d.length; i<max; i += 4){
                        d[i]=c[0];
                        d[i+1]=c[1];
                        d[i+2]=c[2];
                    }
                    brushCtx.putImageData(data,0,0);
                }else{
                    brushCtx.beginPath();
                    brushCtx.ellipse(cx, cy,radius, radius, 0, 0, 2 * Math.PI);
                    brushCtx.fill();
                }
                brushCtx.globalAlpha = 1;

            default:
                break;
        }*/

        generateBackBrush();
    }

    function generateBackBrush(){
        brushBackCtx.fillStyle = Palette.getBackgroundColor();
        brushBackCtx.fillRect(0,0,currentBrush.width,currentBrush.height);
        brushBackCtx.globalCompositeOperation = "destination-in";
        brushBackCtx.drawImage(brushCanvas,0,0);
        brushBackCtx.globalCompositeOperation = "source-over";
    }

    function generateStencil(){
        let w = brushCanvas.width;
        let h = brushCanvas.height;

        if (!brushAlphaLayer){
            brushAlphaLayer = duplicateCanvas(brushCanvas,true);
            let ctx = brushAlphaLayer.getContext("2d");
            ctx.globalCompositeOperation = "source-in";
            ctx.fillStyle = "black";
            ctx.fillRect(0,0,w,h);
        }

        brushCtx.fillStyle = Palette.getDrawColor();
        brushCtx.fillRect(0,0,w,h);
        brushCtx.globalCompositeOperation = "destination-in";
        brushCtx.drawImage(brushAlphaLayer,0,0);
        brushCtx.globalCompositeOperation = "source-over";

       // brushCtx.clearRect(0,0,width,height);
        //brushCtx.fillStyle = Palette.getDrawColor();
    }

    EventBus.on(COMMAND.BRUSHROTATERIGHT,()=>{
        me.rotate();
    });

    EventBus.on(COMMAND.BRUSHROTATELEFT,()=>{
        me.rotate(true);
    });

    EventBus.on(COMMAND.BRUSHFLIPVERTICAL,()=>{
        me.flip(false);
    });

    EventBus.on(COMMAND.BRUSHFLIPHORIZONTAL,()=>{
        me.flip(true);
    });

    return me;
}();

export default Brush;