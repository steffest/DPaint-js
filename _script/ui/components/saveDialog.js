import {$div} from "../../util/dom.js";
import IFF from "../../fileformats/iff.js";
import Icon from "../../fileformats/amigaIcon.js";
import ImageFile from "../../image.js";
import saveAs from "../../util/filesaver.js";
import Modal from "../modal.js";
import Palette from "../palette.js";
import EventBus from "../../util/eventbus.js";
import {COMMAND, EVENT} from "../../enum.js";

var SaveDialog = function(){
    let me ={};

    let filetypes = {
        IFF:{
            description: 'IFF ILMB Image',
            accept: {
                'image/x-ilbm': ['.iff'],
            },
        },
        PNG:{
            description: 'PNG Image',
            accept: {
                'image/png': ['.png'],
            },
        },
        ICO:{
            description: 'Amiga Icon',
            accept: {
                'application/octet-stream': ['.info'],
            },
        },
        PALETTE:{
            description: 'DPaint.js Palette',
            accept: {
                'application/json': ['.json'],
            },
        },
        DPAINTJS:{
            description: 'DPaint.js File',
            accept: {
                'application/json': ['.json'],
            },
        }
    }

    async function saveFile(blob,fileName,type) {
        if (window.showSaveFilePicker){
            const newHandle = await window.showSaveFilePicker({
                suggestedName: fileName,
                types: [type],
            });
            const writableStream = await newHandle.createWritable();
            await writableStream.write(blob);
            await writableStream.close();
        }else{
            await saveAs(blob,fileName);
        }
    }

    me.render = function(container){
        container.innerHTML = "";
        container.appendChild(renderButton("Save as PNG","PNG file",writePNG));
        container.appendChild(renderButton("Save as DPaint.JSON","JSON file",writeJSON));
        container.appendChild(renderButton("Save as IFF","Amiga IFF file",writeIFF));
        container.appendChild(renderButton("Save as Amiga Classic Icon","(Use MUI palette for best compatibility)",writeAmigaClassicIcon));
        container.appendChild(renderButton("Save as Amiga Dual PNG Icon","(for modern Amiga system and/or with PeterK's Icon Library)",writeAmigaPNGIcon));
        container.appendChild(renderButton("Save as Amiga Color Icon","(for modern Amiga system and/or with PeterK's Icon Library)",writeAmigaColorIcon));
    }

    function renderButton(title,subtitle,onClick){
        let button = $div("button","",undefined,onClick);
        $div("title",title,button);
        $div("subtitle",subtitle,button);
        return button;
    }

    function writeIFF(){
        var buffer = IFF.write(ImageFile.getCanvas());

        var blob = new Blob([buffer], {type: "application/octet-stream"});
        var fileName = 'image.iff';
        saveFile(blob,fileName,filetypes.IFF).then(()=>{
            Modal.hide();
        });
    }

    function writePNG(){
        ImageFile.getCanvas().toBlob(function(blob) {
            saveFile(blob,"image.png",filetypes.PNG).then(()=>{
                Modal.hide();
            });
        });
    }

    function writeJSON(){
        let struct = ImageFile.clone();

        let blob = new Blob([JSON.stringify(struct,null,2)], { type: 'application/json' })
        saveFile(blob,'image.json',filetypes.DPAINTJS).then(()=>{
            Modal.hide();
        });
    }

    function writeAmigaClassicIcon(){
        let canvas1 = ImageFile.getCanvas(0);
        let canvas2 = ImageFile.getCanvas(1) || canvas1;
        let ctx1 = canvas1.getContext("2d");
        let ctx2 = canvas2.getContext("2d");
        let w = canvas1.width;
        let h = canvas1.height;

        let r,g,b,alpha;

        let icon = Icon.create(w,h);

        // discard ColorIcon
        icon.colorIcon = undefined;
        icon.width = w;
        icon.height = h;
        icon.img.width = w;
        icon.img.height = h;
        icon.img.depth = 3; // 8 colors
        icon.img.pixels = [];
        icon.img2.width = w;
        icon.img2.height = h;
        icon.img2.depth = 3; // 8 colors
        icon.img2.pixels = [];

        function fillPixels(_ctx,pixels){
            // canvas colours to pixel array

            let MUIColors = [
                "#959595",
                "#000000",
                "#ffffff",
                "#3b67a2",
                "#7b7b7b",
                "#afafaf",
                "#aa907c",
                "#ffa997"
            ];


            let data = _ctx.getImageData(0, 0, w, h).data;
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    let index = (x + y * w) * 4;

                    r = data[index];
                    g = data[index+1];
                    b = data[index+2];
                    alpha = data[index+3];


                    if(alpha>100){
                        let rgb = rgbToHex(r,g,b);
                        let colorIndex = MUIColors.indexOf(rgb);
                        if (colorIndex<0){
                            console.error("No MUI color: " + rgb);
                            colorIndex = 0;
                        }
                        //console.error(rgb);
                        //icon.img.pixels.push(colorIndex);
                        //colorIndex = 6;
                        pixels.push(colorIndex);
                    }else{
                        pixels.push(0);
                    }
                }
            }
        }

        fillPixels(ctx1,icon.img.pixels);
        fillPixels(ctx2,icon.img2.pixels);

        var buffer = Icon.write(icon);

        let blob = new Blob([buffer], {type: "application/octet-stream"});
        saveFile(blob,'icon.info',filetypes.ICO).then(()=>{
            Modal.hide();
        });
        Modal.hide();

    }

    function writeAmigaPNGIcon(){
        let canvas1 = ImageFile.getCanvas(0);
        let canvas2 = ImageFile.getCanvas(1);
        if (canvas2){
            canvas1.toBlob(function(blob1) {
                canvas2.toBlob(function(blob2) {

                    let blob = new Blob([blob1,blob2], {type: "application/octet-stream"});
                    saveFile(blob,'icon.info',filetypes.ICO).then(()=>{
                        Modal.hide();
                    });
                });
            });
        }else{
            canvas1.toBlob(function(blob1) {
                let blob = new Blob([blob1], {type: "application/octet-stream"});
                saveFile(blob,'icon.info',filetypes.ICO).then(()=>{
                    Modal.hide();
                });
            });
        }
    };

    function writeAmigaColorIcon(){
        // save as ColorIcon
        let canvas1 = ImageFile.getCanvas(0);
        var palette = [];
        var pixels = [];
        var ctx = canvas1.getContext("2d");

        let canvas2 = ImageFile.getCanvas(1) || canvas1;
        var palette2 = [];
        var pixels2 = [];
        var ctx2 = canvas2.getContext("2d");

        var w = canvas1.width;
        var h = canvas1.height;

        // for images < 8 colors we use the transparentColor as actual color;
        // for >=8 we add the transparent color as extra color (image processing should have filtered that out already)
        //if (IconEditor.getPalette().length > 7){
            palette.push(Palette.getBackgroundColor());
            palette2.push(Palette.getBackgroundColor());
        //}


        var r,g,b,alpha;
        var colorLookup = {};
        var colorLookup2 = {};

        function matchColor(r,g,b,_palette){
            for (var i=1,max=_palette.length;i<max;i++){
                var color = _palette[i];
                var div = Math.abs(color[0]-r) + Math.abs(color[1]-g) + Math.abs(color[2]-b);
                if (div === 0){
                    return i;
                }else{
                    // TODO: is this still needed? palette should already be exact?
                    if (div<5){
                        return i;
                    }
                }
            }
            return -1;
        }


        // canvas colours to pixel array
        var data = ctx.getImageData(0, 0, w, h).data;
        for (var y = 0; y < h; y++) {
            for (var x = 0; x < w; x++) {
                var index = (x + y * w) * 4;

                r = data[index];
                g = data[index+1];
                b = data[index+2];
                alpha = data[index+3];

                if(alpha>100){
                    var rgb = rgbToHex(r,g,b);
                    var colorIndex = colorLookup[rgb];
                    if (typeof colorIndex === "undefined"){
                        colorIndex = matchColor(r,g,b,palette);
                        if (colorIndex<0){
                            palette.push([r,g,b]);
                            colorIndex = palette.length-1;
                            colorLookup[rgb] = colorIndex;
                        }
                    }
                    pixels.push(colorIndex);
                }else{
                    pixels.push(0);
                }
            }
        }

        var data2 = ctx2.getImageData(0, 0, w, h).data;
        colorLookup2 = {};
        for (var y = 0; y < h; y++) {
            for (var x = 0; x < w; x++) {
                var index = (x + y * w) * 4;

                r = data2[index];
                g = data2[index+1];
                b = data2[index+2];
                alpha = data2[index+3];

                if(alpha>100){
                    var rgb = rgbToHex(r,g,b);
                    var colorIndex = colorLookup2[rgb];
                    if (typeof colorIndex === "undefined"){
                        colorIndex = matchColor(r,g,b,palette2);
                        if (colorIndex<0){
                            palette2.push([r,g,b]);
                            colorIndex = palette2.length-1;
                            colorLookup2[rgb] = colorIndex;
                        }
                    }
                    //console.error(colorIndex);
                    pixels2.push(colorIndex);
                }else{
                    pixels2.push(0);
                }
            }
        }

        var icon = Icon.create(w,h);

        icon.colorIcon.MaxPaletteSize = palette.length;
        var state = icon.colorIcon.states[0];
        state.NumColors = palette.length;
        state.paletteSize = state.NumColors * 3;
        state.palette = palette.slice();
        state.pixels = pixels.slice();

        icon.colorIcon.states.push(
            {
                transparentIndex: 0,
                flags:3,// ? Bit 1: transparent color exists - Bit 2: Palette Exists
                imageCompression:0,
                paletteCompression:0,
                depth:8, // number of bits to store each pixel
                imageSize: pixels2.length
            }
        );
        var state2 = icon.colorIcon.states[1];
        state2.NumColors = palette2.length;
        state2.paletteSize = state2.NumColors * 3;
        state2.palette = palette2.slice();
        state2.pixels = pixels2.slice();


        var buffer = Icon.write(icon);

        let blob = new Blob([buffer], {type: "application/octet-stream"});

        saveFile(blob,'icon.info',filetypes.ICO).then(()=>{
            Modal.hide();
        });
    };

    function rgbToHex(r, g, b) {
        return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
    }

    EventBus.on(COMMAND.SAVEPALETTE,()=>{
        let struct = {
            type: "palette",
            palette:  Palette.get()
        }
        let blob = new Blob([JSON.stringify(struct,null,2)], { type: 'application/json' })
        saveFile(blob,'palette.json',filetypes.PALETTE).then(()=>{

        });
    });

    return me;
}();

export default SaveDialog;