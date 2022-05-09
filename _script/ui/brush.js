import {$div} from "../util/dom.js";
import Eventbus from "../util/eventbus.js";
import {COMMAND, EVENT} from "../enum.js";
import Palette from "./palette.js";
import HistoryService from "../services/historyservice.js";

var Brush = function(){
    var me = {};
    var container;
    var width = 1;
    var height = 1;
    var brushType = "square";
    var presets = [];
    var brushIndex = 0;

    var brushCanvas = document.createElement("canvas");
    let brushCtx = brushCanvas.getContext("2d");

    me.init = function(parent){
        container = $div("brushes","",parent);
        for (var i = 0; i<10;i++){
            let b = $div("brush","",container,(e)=>{
                let index = e.target.index || 0;
                me.set("preset",index);
            })
            let x = -(i % 5)*11 + "px";
            let y = (Math.floor(i / 5) * -11) + "px";
            b.style.backgroundPosition = x + " " + y;
            b.index = i;
            if (!i) b.classList.add("active");
            presets.push(b);
        }
        
        Eventbus.on(EVENT.drawColorChanged,()=>{
            if (brushType === 'canvas' && brushIndex>=0){
                generateBrush();
            }
        })
    }

    me.get = function(){

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
            brushCanvas.width = index.width;
            brushCanvas.height = index.height;
            brushCtx.clearRect(0,0,brushCanvas.width,brushCanvas.height);
            brushCtx.drawImage(index,0,0);
        }
    }


    me.draw = function(ctx,x,y,color,useHistory){


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

        if (useHistory) cFrom = ctx.getImageData(x,y,w,h);

        if (brushType === "canvas"){
            ctx.drawImage(brushCanvas,x,y);
        }else{
            ctx.fillStyle = color;
            ctx.fillRect(x,y,w,h);
        }

        if (useHistory){
            let cTo = ctx.getImageData(x,y,w,h);
            HistoryService.log([x,y,cFrom,cTo]);
        }

    }
    
    function generateBrush(){
        brushCanvas.width = width;
        brushCanvas.height = height;
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
        }

    }

    return me;
}();

export default Brush;