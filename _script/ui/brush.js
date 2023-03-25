import {$div} from "../util/dom.js";
import EventBus from "../util/eventbus.js";
import {COMMAND, EVENT} from "../enum.js";
import Palette from "./palette.js";
import Color from "../util/color.js";
import Editor from "./editor.js";

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

    var brushCanvas = document.createElement("canvas");
    var brushBackCanvas = document.createElement("canvas");
    let brushCtx = brushCanvas.getContext("2d");
    let brushBackCtx = brushBackCanvas.getContext("2d");

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
            if (brushType === 'canvas' && brushIndex>=0){
                generateBrush();
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
        return{
            width:width,
            height:height,
            opacity: opacity
        };
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
            brushType = type;
            brushIndex = -1;
            console.error(index)
            brushCanvas.width = brushBackCanvas.width = index.width;
            brushCanvas.height = brushBackCanvas.height = index.height;
            brushCtx.clearRect(0,0,brushCanvas.width,brushCanvas.height);
            brushCtx.drawImage(index,0,0);
            brushBackCtx.clearRect(0,0,brushCanvas.width,brushCanvas.height);
            brushBackCtx.drawImage(index,0,0);
            // TODO: What do we draw when grabbing a stencil with right-click draw ?
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


    me.draw = function(ctx,x,y,color,onBackground){

        let w,h,cFrom;

        if (brushType === "canvas"){
            w = brushCanvas.width;
            h = brushCanvas.height;
        }else{
            w = width;
            h = height;
        }

        if (w>1) x -= Math.floor((w-1)/2);
        if (h>1) y -= Math.floor((h-1)/2);

        if (brushType === "canvas"){
            if (onBackground){
                ctx.drawImage(brushBackCanvas,x,y);
            }else{
                ctx.drawImage(brushCanvas,x,y);
            }
        }else{
            ctx.fillStyle = color;
            ctx.fillRect(x,y,w,h);
        }

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

        brushBackCtx.fillStyle = Palette.getBackgroundColor();
        brushBackCtx.fillRect(0,0,width,height);
        brushBackCtx.globalCompositeOperation = "destination-in";
        brushBackCtx.drawImage(brushCanvas,0,0);
        brushBackCtx.globalCompositeOperation = "source-over";


    }

    return me;
}();

export default Brush;