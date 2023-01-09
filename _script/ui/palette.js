import {$div} from "../util/dom.js";
import EventBus from "../util/eventbus.js";
import {COMMAND, EVENT} from "../enum.js";
import Color from "../util/color.js";
import Editor from "./editor.js";
import ImageProcessing from "../util/imageProcessing.js";
import ImageFile from "../image.js";

let Palette = function(){
    let me = {};
    var container;
    var paletteCanvas;
    var paletteCtx;
    var size = 14;
    var currentPalette;

    var drawColor = "white";
    var backgroundColor = "black"

    var colors = [
        [149,149,149],
        [0,0,0],
        [255,255,255],
        [59,103,162],
        [123,123,123],
        [175,175,175],
        [170,144,124],
        [255,169,151]
    ]

    me.init = function(parent){
        container = $div("palette","",parent);

        let display = $div("display","",container);
        let front = $div("front","",display);
        let back = $div("back","",display);

        paletteCanvas = document.createElement("canvas");
        paletteCanvas.classList.add("handle");
        container.appendChild(paletteCanvas);
        paletteCtx = paletteCanvas.getContext("2d");

        paletteCanvas.onClick = function(e){
            const rect = paletteCanvas.getBoundingClientRect();
            const x = Math.floor(e.clientX - rect.left);
            const y = Math.floor(e.clientY - rect.top);
            let p = paletteCtx.getImageData(x,y,1,1).data;
            me.setColor([p[0],p[1],p[2]],e.button);
        }

        me.set(colors);

        EventBus.on(EVENT.drawColorChanged,(color)=>{
            front.style.backgroundColor = "rgb(" + color[0] + "," + color[1] + "," + color[2] + ")";
        });
        EventBus.on(EVENT.backgroundColorChanged,(color)=>{
            back.style.backgroundColor = "rgb(" + color[0] + "," + color[1] + "," + color[2] + ")";
        });

        me.setColor(colors[2],false);
        me.setColor(colors[1],true);
    }

    me.setColor=function(color,back){
        if (back){
            backgroundColor = Color.toString(color);
            EventBus.trigger(EVENT.backgroundColorChanged,color);
        }else{
            drawColor = Color.toString(color);
            console.error(drawColor);
            EventBus.trigger(EVENT.drawColorChanged,color);
        }
    }

    me.getDrawColor = function(){
        return drawColor;
    }

    me.getBackgroundColor = function(){
        return backgroundColor;
    }

    me.set = function(palette){
        currentPalette = palette;
        let cols = 4;
        let rows = palette.length/cols;
        paletteCanvas.width = cols*size;
        paletteCanvas.height = rows*size;

        palette.forEach((color,index)=>{
            //let c = $div("color","",container,(e)=>{
            //    me.setColor(color,e.button);
            //});

            let x = index%cols * size;
            let y = Math.floor(index/cols) * size;
            paletteCtx.fillStyle = "rgb(" + color[0] + "," + color[1] + "," + color[2] + ")";
            paletteCtx.fillRect(x,y,size,size);
        })
    }

    me.get = function(){
        return currentPalette;
    }

    me.fromImage = function(){
        var colors = ImageProcessing.getColors(ImageFile.getCanvas());
        var palette = [];
        var max = Math.min(colors.length,256);

        for (var i=0;i<max;i++){
            var c = colors[i];
            palette.push([c.Red,c.Green,c.Blue])
        }
        Palette.set(palette);
    }

    me.reduce = function(){
        ImageProcessing.reduce(ImageFile.getCanvas(),16);
    }

    me.getColorIndex = function(color){
        var index = currentPalette.findIndex((c)=>{return c[0] === color[0] && c[1] === color[1] && c[2] === color[2]});
        if (index<0) index=0;
        return index;
    }

    EventBus.on(COMMAND.PALETTEFROMIMAGE,me.fromImage);
    EventBus.on(COMMAND.PALETTEREDUCE,me.reduce);


    return me;
}();

export default Palette;