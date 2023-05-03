import $,{$div, $input} from "../util/dom.js";
import EventBus from "../util/eventbus.js";
import {COMMAND, EVENT} from "../enum.js";
import Color from "../util/color.js";
import ImageProcessing from "../util/imageProcessing.js";
import ImageFile from "../image.js";
import SidePanel from "./sidepanel.js";
import {duplicateCanvas} from "../util/canvasUtils.js";

let Palette = function(){
    let me = {};
    var container;
    var paletteCanvas;
    var paletteCtx;
    var paletteNav;
    var size = 14;
    var currentPalette;
    var alphaThreshold = 44;
    var ditherIndex = 0;
    var targetColorCount = 32;
    let palettePageIndex = 0;
    let palettePageCount = 1;
    let currentHeight;

    var drawColor = "black";
    var backgroundColor = "white";

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
        current: {label: "Current", palette: null},
        mui: {label: "MUI", palette:muiPalette},
        db8: {label: "DawnBringer 8", palette:[[20, 12, 28],[85, 65, 95],[100, 105, 100],[215, 115, 85],[80, 140, 215],[100, 185, 100],[230, 200, 110],[220, 245, 255]]},
        db16: {label: "DawnBringer 16", palette:db16Palette},
        db32: {label: "DawnBringer 32", palette:db32Palette},
        gfxk16: {label: "Grafxkid 16", palette:[[26, 28, 44],[93, 39, 93],[177, 62, 83],[239, 125, 87],[255, 205, 117],[167, 240, 112],[56, 183, 100],[37, 113, 121],[41, 54, 111],[59, 93, 201],[65, 166, 246],[115, 239, 247],[244, 244, 244],[148, 176, 194],[86, 108, 134],[51, 60, 87]]},
        gfxk: {label: "Grafxkid 32", palette:gfxkPalette},
        pico8: {label: "PICO-8", palette:[[0, 0, 0],[29, 43, 83],[126, 37, 83],[0, 135, 81],[171, 82, 54],[95, 87, 79],[194, 195, 199],[255, 241, 232],[255, 0, 77],[255, 163, 0],[255, 236, 39],[0, 228, 54],[41, 173, 255],[131, 118, 156],[255, 119, 168],[255, 204, 170]]},
        dga:{label: "DGA-16",palette:["#010101","#031b75","#108c00","#17bbd3","#720c0a","#6c1c9e","#b25116","#b8b0a8","#4a4842","#0b63c4","#9bce00","#73f5d5","#e89e00","#ff7bdb","#fef255","#fffffe"]},
        micro: {label: "BBC Micro", platform: true, palette:[[0,0,0],[255,0,0],[0,255,0],[255,255,0],[0,0,255],[255,0,255],[0,255,255],[255,255,255]]},
        pepto: {label: "Pepto (C64)", platform: true, palette:[[0, 0, 0],[255, 255, 255],[104,55,43],[112 ,164 ,178 ],[111 ,61 ,134 ],[88 ,141 ,67],[53 ,40 ,121],[184 ,199 ,111],[111 ,79 ,37],[67 ,57 ,0],[154 ,103 ,89],[68 ,68 ,68],[108 ,108 ,108],[154 ,210 ,132],[108 ,94 ,181],[149 ,149 ,149]]},
        spectrum: {label: "ZX Spectrum", platform: true, palette:[[0,0,0],[0,0,128],[0,0,255],[128,0,0],[255,0,0],[128,0,128],[255,0,255],[0,128,0],[0,255,0],[0,128,128],[0,255,255],[128,128,0],[255,255,0],[128,128,128],[255,255,255]]},
        msx:{label: "MSX",platform:true,palette:"MSX.json"},
        cga:{label: "CGA (IBM PC)",platform:true,palette:"CGA.json"},
        amstrad: {label: "Amstrad CPC", platform: true, palette:"Amstrad-CPC.json"},
        ted:{label: "C= TED/+4/16",platform:true,palette:"TED-Plus4-C16.json"},
        atari2600pal:{label: "Atari 2600 PAL",platform:true,palette:"Atari-2600-PAL.json"},
        atari2600ntsc:{label: "Atari 2600 NTSC",platform:true,palette:"Atari-2600-NTSC.json"},
        atari:{label: "Atari GTIA",platform:true,palette:"Atari-GTIA.json"},
    };
    var targetPalette = null;

    me.init = function(parent,paletteParent){
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

        let swapColors = $div("button swapcolors info","",display,()=>{
            EventBus.trigger(COMMAND.SWAPCOLORS);
        });
        swapColors.info = "<b>X</b> Swap foreground and background color"

        let noColor = $div("button transparentcolors info","",display,(e)=>{
            me.setColor("transparent",e.button);
        });
        noColor.info = "Select transparent color, left click to select front, right click to select back";

        $(".togglepanel.showpalettelist",{
            parent: container,
            onClick: ()=>{EventBus.trigger(COMMAND.TOGGLEPALETTES)},
            info:"Show palettes"
        },"Palette");

        paletteCanvas = $("canvas.info.palettecanvas",{
            parent: paletteParent,
            info: "Color palette, left click to select front, right click to select back",
            onClick: function(e){
                const rect = paletteCanvas.getBoundingClientRect();
                const x = Math.floor(e.clientX - rect.left);
                const y = Math.floor(e.clientY - rect.top);
                let p = paletteCtx.getImageData(x,y,1,1).data;
                me.setColor([p[0],p[1],p[2]],e.button);
            }
        })

        paletteNav = $div("palettenav","",paletteParent);

        paletteCtx = paletteCanvas.getContext("2d");
        me.set(colors);

        EventBus.on(EVENT.drawColorChanged,(color)=>{
            color = Color.fromString(color);
            if (color.length > 3 && color[3] === 0) color = "transparent";
            if (color === "transparent"){
                front.style.backgroundColor = color;
                front.classList.add("nofill");
            }else{
                front.style.backgroundColor = "rgb(" + color[0] + "," + color[1] + "," + color[2] + ")";
                front.classList.remove("nofill");
            }
        });
        EventBus.on(EVENT.backgroundColorChanged,(color)=>{
            color = Color.fromString(color);
            if (color.length > 3 && color[3] === 0) color = "transparent";
            if (color === "transparent"){
                back.style.backgroundColor = color;
                back.classList.add("nofill");
            }else{
                back.style.backgroundColor = "rgb(" + color[0] + "," + color[1] + "," + color[2] + ")";
                back.classList.remove("nofill");
            }


        });

        me.setColor(colors[1],false);
        me.setColor(colors[2],true);
    }



    me.setColor=function(color,back){
        if (back){
            backgroundColor = Color.toString(color);
            EventBus.trigger(EVENT.backgroundColorChanged,color);
        }else{
            drawColor = Color.toString(color);
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
        let cols = 4;
        let rows = Math.ceil(palette.length/cols);
        paletteCanvas.width = cols*size;
        paletteCanvas.height = rows*size;
        palettePageIndex = 0;
        palettePageCount = 1;
        paletteNav.innerHTML = "";
        let pageNumber,pageNext,pagePrev;


        let box = paletteCanvas.getBoundingClientRect();
        let parentBox = paletteCanvas.parentElement.getBoundingClientRect();
        let availableHeight = parentBox.height + parentBox.top - box.top;
        currentHeight = availableHeight;
        if (availableHeight < paletteCanvas.height){
            let rows = Math.floor((availableHeight-22)/size);
            paletteCanvas.height = rows*size;
            palettePageCount = Math.ceil(palette.length/(cols*rows));
            paletteNav.appendChild($(".nav",
                pagePrev = $(".prev",{onClick:()=>{setPage(-1)}}),
                pageNumber = $(".page","1"),
                pageNext = $(".next.active",{onClick:()=>{setPage(1)}})));
        }
        currentPalette = palette;
        drawPalette();

        function setPage(index){
            palettePageIndex += index;
            if (palettePageIndex < 0) palettePageIndex = 0;
            if (palettePageIndex >= palettePageCount) palettePageIndex = palettePageCount-1;
            pageNumber.innerHTML = palettePageIndex+1;
            pagePrev.classList.toggle("active",palettePageIndex > 0);
            pageNext.classList.toggle("active",palettePageIndex < palettePageCount-1);
            drawPalette();
        }
    }

    function drawPalette(){
        let cols = 4;
        let rows = Math.floor(paletteCanvas.height/size);
        let start = palettePageIndex * cols * rows;
        let end = start + cols * rows;
        if (end > currentPalette.length) end = currentPalette.length;
        paletteCtx.clearRect(0,0,paletteCanvas.width,paletteCanvas.height);
        for (let i=start;i<end;i++){
            let color = currentPalette[i];
            if (typeof color === "string"){
                color = Color.fromString(color);
                currentPalette[i] = color;
            }
            let x = ((i-start)%cols) * size;
            let y = Math.floor((i-start)/cols) * size;
            paletteCtx.fillStyle = "rgb(" + color[0] + "," + color[1] + "," + color[2] + ")";
            paletteCtx.fillRect(x,y,size,size);
        }
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
            palette.push(c);
        }
        Palette.set(palette);
    }

    me.reduce = function(){

        if (targetColorCount>256 && !targetPalette){
            ImageFile.restoreOriginal();
        }else{
            let base = ImageFile.getOriginal();
            let c = duplicateCanvas(base,true);
            if (targetColorCount === 2 && ditherIndex){
                ImageProcessing.bayer(c.getContext("2d"),Math.floor(alphaThreshold*2.56),false);
                let layer = ImageFile.getActiveLayer();
                layer.clear();
                layer.drawImage(c,0,0);
                EventBus.trigger(EVENT.layerContentChanged,true);
            }else{
                ImageProcessing.reduce(c,targetPalette || targetColorCount,alphaThreshold,ditherIndex);
            }

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
            if (pselect.value === "current") targetPalette = currentPalette;
            if (typeof targetPalette === "string"){
                me.loadPreset(paletteMap[pselect.value]).then(palette=>{
                    paletteMap[pselect.value].palette = palette;
                    targetPalette = palette;
                    me.reduce();
                })
            }else{
                me.reduce();
            }

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

    me.getPaletteMap = function(){
        return paletteMap;
    }

    me.loadPreset = function(preset){
        return new Promise((resolve)=>{
            if (preset && preset.palette){
                if (typeof preset.palette === "object"){
                    resolve(preset.palette);
                    return;
                }
                if (typeof preset.palette === "string"){
                    console.log("loading palette",preset.palette);
                    fetch("_data/palettes/"+preset.palette).then(r=>r.json()).then(data=>{
                        if (data && data.palette){
                            preset.palette = data.palette;
                            resolve(data.palette);
                        }else{
                            console.error("Error loading palette",preset.palette);
                            resolve([]);
                        }
                    });
                    return;
                }
            }
            resolve([])
        });
    }


    EventBus.on(COMMAND.PALETTEFROMIMAGE,me.fromImage);
    EventBus.on(COMMAND.PALETTEREDUCE,me.reduce);
    EventBus.on(COMMAND.SWAPCOLORS,()=>{
        let c = drawColor;
        me.setColor(backgroundColor);
        me.setColor(c,1);
    })
    EventBus.on(EVENT.UIresize,()=>{
        let box = paletteCanvas.getBoundingClientRect();
        let parentBox = paletteCanvas.parentElement.getBoundingClientRect();
        let availableHeight = parentBox.height + parentBox.top - box.top;
        if (availableHeight !== currentHeight){
            me.set(currentPalette);
        }
    });

    return me;
}();

export default Palette;