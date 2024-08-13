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

var Brush = function(){
    var me = {};
    var container;
    var width = 1;
    var height = 1;
    var brushType = "square";
    var presets = [];
    var brushIndex = 0;
    let dynamicSettings;
    let opacity = 100;
    let pressure = 1;

    var brushCanvas = document.createElement("canvas");
    var brushBackCanvas = document.createElement("canvas");
    let brushCtx = brushCanvas.getContext("2d");
    let brushBackCtx = brushBackCanvas.getContext("2d");
    let brushAlphaLayer;
    let currentType;
    let currentIndex;

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
            presets.push(b);
        }
        
        EventBus.on(EVENT.drawColorChanged,()=>{
            if (brushType === 'canvas'){
                if (brushIndex>=0){
                    generateBrush();
                }else{
                    generateStencil();
                }
            }
        })
        EventBus.on(EVENT.backgroundColorChanged,()=>{
            if (brushType === 'canvas' && brushIndex>=0){
                generateBrush();
            }
        })
    }

    me.get = function(){

    }

    me.getOpacity = ()=>{
        return opacity/100;
    }

    me.getSettings=()=>{
        let settings = {
            width:width,
            height:height,
            opacity: opacity
        };
        if (dynamicSettings){
            settings.softness = dynamicSettings.softness;
        }
        return settings;
    }

    me.set = function(type,index){
        if (type === "preset"){
            presets.forEach((b,i)=>{
                b.classList.toggle("active",i===index);
            });
            brushIndex = index;
            switch (index){
                case 0:
                    brushType = "square";
                    width = height = 1;
                    break;
                case 1:
                case 2:
                case 3:
                case 4:
                    brushType = "canvas";
                    let size = (index*2) + 1;
                    if (brushIndex === 3) size = 5;
                    if (brushIndex === 4) size = 7;
                    width = height = size;
                    generateBrush();
                    break;
                case 5:
                case 6:
                case 7:
                case 8:
                    brushType = "square";
                    width = height  = (9-index)*2 + 1;
                    break;
                case 9:
                    brushType = "canvas";
                    width = height = 7;
                    generateBrush();
                    break;
            }
        }

        if (type === "canvas"){
            // Note: "index" is an image object in this case.
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
        }

        if (type === "dynamic"){
            width = index.width;
            height = index.height;
            opacity = index.opacity || 100;

            if (!index.softness){
                brushType = "square";
            }else{
                brushIndex = 100;
                brushType = "canvas";
                dynamicSettings = index;
                generateBrush();

            }
        }

        EventBus.trigger(EVENT.brushOptionsChanged);
    }

    me.setPressure = (p)=>{
        pressure = p;
    }

    me.getPressure = ()=>{
        return pressure;
    }


    me.draw = function(ctx,x,y,color,onBackground,blendColor){
        let w,h,p;
        let useCustomBlend = blendColor && Palette.isLocked();
        let useOpacity = ToolOptions.usePressure() && !useCustomBlend;
        let finalColor = color;

        if (brushType === "canvas"){
            w = brushCanvas.width;
            h = brushCanvas.height;
        }else{
            w = width;
            h = height;
        }

        if (w>1) x -= Math.floor((w-1)/2);
        if (h>1) y -= Math.floor((h-1)/2);

        if (useOpacity){
            p = ctx.globalAlpha;
            ctx.globalAlpha = pressure;
        }


        if (brushType === "canvas"){
            // TODO: blendColor when Palette is Locked !
            // FIXME
            if (onBackground){
                ctx.drawImage(brushBackCanvas,x,y);
            }else{
                ctx.drawImage(brushCanvas,x,y);
            }
        }else{
            if (blendColor && Palette.isLocked()){
                let c = Color.fromString(color);
                let imageCtx = ImageFile.getContext();
                let data = imageCtx.getImageData(x,y,w,h);
                let opacity2 = opacity/100;
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
        if (brushType === "canvas"){
            ImageProcessing.rotate(brushCanvas,left);
            width = brushCanvas.width;
            height = brushCanvas.height;
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
        brushCanvas.width = brushBackCanvas.width = width;
        brushCanvas.height = brushBackCanvas.height = height;
        brushCtx.clearRect(0,0,width,height);
        brushCtx.fillStyle = Palette.getDrawColor();

        switch (brushIndex){
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
        }

        generateBackBrush();
    }

    function generateBackBrush(){
        brushBackCtx.fillStyle = Palette.getBackgroundColor();
        brushBackCtx.fillRect(0,0,width,height);
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