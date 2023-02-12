import {$div, $input} from "../util/dom.js";
import EventBus from "../util/eventbus.js";
import {COMMAND, EVENT} from "../enum.js";
import Color from "../util/color.js";
import Editor from "./editor.js";
import ImageProcessing from "../util/imageProcessing.js";
import ImageFile from "../image.js";
import SidePanel from "./sidepanel.js";
import Canvas from "./canvas.js";
import FileDetector from "../fileformats/detect.js";

let Palette = function(){
    let me = {};
    var container;
    var paletteCanvas;
    var paletteCtx;
    var size = 14;
    var currentPalette;
    var alphaThreshold = 44;
    var ditherIndex = 0;
    var targetColorCount = 32;

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


    var muiPalette = [
        [149,149,149],
        [0,0,0],
        [255,255,255],
        [59,103,162],
        [123,123,123],
        [175,175,175],
        [170,144,124],
        [255,169,151]
    ];

    var sketchPalette = [
        [149,149,149],
        [58,65,67],
        [255,255,255],
        [141,174,198],
        [230,213,144],
        [231,227,216],
        [90,171,119],
        [171,57,57]
    ];

    var spotifyPalette = [
        [244, 228, 205],
        [237, 201, 156],
        [227, 179, 114],
        [219, 163, 80],
        [200, 114, 58],
        [137, 72, 44],
        [90, 44, 23],
        [54, 22, 13],
        [5, 3, 4],
        [187, 186, 155],
        [179, 176, 142],
        [171, 168, 135],
        [156, 151, 124],
        [151, 141, 113],
        [133, 123, 102],
        [124, 111, 93],
    ];

    // https://pixeljoint.com/forum/forum_posts.asp?TID=12795
    var db16Palette = [
        [20,12,28],
        [68,36,52],
        [48,52,109],
        [78,74,78],
        [133,76,48],
        [52,101,36],
        [208,70,72],
        [117,113,97],
        [89,125,206],
        [210,125,44],
        [133,149,161],
        [109,170,44],
        [210,170,153],
        [109,194,202],
        [218,212,94],
        [222,238,214]
    ];

    // DawnBringer's 32 Col Palette
    //http://pixeljoint.com/forum/forum_posts.asp?TID=16247
    var db32Palette = [
        [0,0,0],
        [34,32,52],
        [69,40,60],
        [102,57,49],
        [143,86,59],
        [223,113,38],
        [217,160,102],
        [238,195,154],
        [251,242,54],
        [153,229,80],
        [106,190,48],
        [55,148,110],
        [75,105,47],
        [82,75,36],
        [50,60,57],
        [63,63,116],
        [48,96,130],
        [91,110,225],
        [99,155,255],
        [95,205,228],
        [203,219,252],
        [255,255,255],
        [155,173,183],
        [132,126,135],
        [105,106,106],
        [89,86,82],
        [118,66,138],
        [172,50,50],
        [217,87,99],
        [215,123,186],
        [143,151,74],
        [138,111,48]
    ];

    // https://fulifuli.tumblr.com/post/141892525920/grafxkids-today-land-palette-release
    var gfxkPalette = [[17,10,3],[17,10,3],[99,13,38],[71,18,92],[37,30,106],[62,40,40],[14,53,62],[40,53,74],[152,30,130],[33,74,167],[181,45,27],[133,62,51],[21,105,72],[28,100,112],[109,93,91],[69,105,117],[10,152,216],[238,98,131],[202,117,56],[219,110,83],[240,117,8],[30,182,120],[89,179,45],[126,174,163],[176,162,141],[249,178,167],[245,185,125],[73,227,218],[251,197,49],[211,229,73],[239,239,233],[255,255,255]];

    var paletteMap = {
        optimized: {label: "Optimized", palette: null},
        mui: {label: "MUI", palette:muiPalette},
        sketch: {label: "Sketch", palette:sketchPalette},
        db16: {label: "DawnBringer 16", palette:db16Palette},
        db32: {label: "DawnBringer 32", palette:db32Palette},
        gfxk: {label: "Grafxkids 32", palette:gfxkPalette}
    };
    var targetPalette = null;

    me.init = function(parent){
        container = $div("palette","",parent);
        let colorPicker = $input("color","","",()=>{
            me.setColor(colorPicker.value,colorPicker.isBack);
        });

        let display = $div("display","",container);
        let front = $div("front info","",display,()=>{
            colorPicker.value = me.getDrawColor();
            colorPicker.isBack = false;
            colorPicker.click();
        });
        front.info = "Left click drawing color - click to pick color";
        let back = $div("back info","",display,()=>{
            colorPicker.value = me.getBackgroundColor();
            colorPicker.isBack = true;
            colorPicker.click();
        });
        back.info = "Right click drawing color - click to pick color";


        paletteCanvas = document.createElement("canvas");
        paletteCanvas.classList.add("handle","info");
        paletteCanvas.info = "Color palette, click to select";
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
            color = Color.fromString(color);
            front.style.backgroundColor = "rgb(" + color[0] + "," + color[1] + "," + color[2] + ")";
        });
        EventBus.on(EVENT.backgroundColorChanged,(color)=>{
            color = Color.fromString(color);
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

        if (targetColorCount>256 && !targetPalette){
            ImageFile.restoreOriginal();
        }else{
            let base = ImageFile.getOriginal();
            let c = document.createElement("canvas");
            c.width = base.width;
            c.height = base.height;
            c.getContext("2d").drawImage(base,0,0);
            ImageProcessing.reduce(c,targetPalette || targetColorCount,alphaThreshold,ditherIndex);
            SidePanel.show();
        }
    }

    me.getColorIndex = function(color){
        var index = currentPalette.findIndex((c)=>{return c[0] === color[0] && c[1] === color[1] && c[2] === color[2]});
        if (index<0) index=0;
        return index;
    }

    me.updateColor = function(index,color){
        currentPalette[index] = color;
        me.set(currentPalette);
    }

    me.generateControlPanel = function(parent){

        let palettePanel = $div("subpanel","",parent);
        $div("label","Palette",palettePanel);
        let pselect = document.createElement("select");
        Object.keys(paletteMap).forEach((key,index)=>{
            let option = document.createElement("option");
            option.value=key;
            option.innerHTML=paletteMap[key].label;
            pselect.appendChild(option);
        });
        pselect.onchange = function(){
            targetPalette = paletteMap[pselect.value].palette;
            me.reduce();
        }
        palettePanel.appendChild(pselect);

        let fixed = $div("subpanel","",parent);
        $div("label","Optimize colors",fixed);
        let value = $div("value","32",fixed);
        let range = document.createElement("input");
        range.type = "range";
        range.value = 5;
        range.min = 1;
        range.max = 9;
        range.oninput = function(){
            targetColorCount = Math.pow(2,range.value);
            value.innerHTML = range.value<9?targetColorCount:"Full";
        }
        range.onchange = function(){
            targetColorCount = Math.pow(2,range.value);
            pselect.value = "optimized";
            targetPalette = null;
            me.reduce();
        }
        fixed.appendChild(range);

        let dithering = $div("subpanel","",parent);
        $div("label","Dithering",dithering);

        let select = document.createElement("select");
        select.value=0;
        let options = ImageProcessing.getDithering();
        options.forEach((o,index)=>{
            let option = document.createElement("option");
            option.value=index;
            option.innerHTML=o.label;
            select.appendChild(option);
        });
        select.onchange = function(){
            ditherIndex = select.value;
            me.reduce();
        }
        $div("button square prev","<",dithering,()=>{
            let v = parseInt(select.value)-1;
            if (v<0)v=options.length-1;
            select.value = v;
            select.onchange();
        });
        $div("button square next",">",dithering,()=>{
            let v = parseInt(select.value)+1;
            if (v>=options.length)v=0;
            select.value = v;
            select.onchange();
        });

        dithering.appendChild(select);

        let alpha = $div("subpanel","",parent);
        $div("label","Alpha Threshold",alpha );
        let avalue = $div("value",alphaThreshold + "%",alpha );
        let arange = document.createElement("input");
        arange.type = "range";
        arange.value = alphaThreshold;
        arange.min = 0;
        arange.max = 100;
        arange.oninput = function(){
            avalue.innerHTML = arange.value + "%";
        }
        arange.onchange = function(){
            alphaThreshold = arange.value;
            me.reduce();
        }
        alpha.appendChild(arange);
    }

    me.openLocal = function(){
        var input = document.createElement('input');
        input.type = 'file';
        input.onchange = function(e){
            let files = e.target.files;
            if (files.length){
                var file = files[0];
                var ext = file.name.split(".").pop().toLowerCase();
                if (ext === "json"){
                    var reader = new FileReader();
                    reader.onload = function(){
                        let data = {};
                        try{
                            data = JSON.parse(reader.result);
                        }catch(error){
                            console.error("Error parsing Palette");
                        };
                        if (data && data.type === "palette" && data.palette){
                            me.set(data.palette);
                        }

                    }
                    reader.readAsText(file);
                }
            }
        };
        input.click();
    }


    EventBus.on(COMMAND.PALETTEFROMIMAGE,me.fromImage);
    EventBus.on(COMMAND.PALETTEREDUCE,me.reduce);


    return me;
}();

export default Palette;