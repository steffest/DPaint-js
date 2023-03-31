import $,{$div} from "../../util/dom.js";
import IFF from "../../fileformats/iff.js";
import Icon from "../../fileformats/amigaIcon.js";
import ImageFile from "../../image.js";
import saveAs from "../../util/filesaver.js";
import Modal, {DIALOG} from "../modal.js";
import Palette from "../palette.js";
import EventBus from "../../util/eventbus.js";
import {COMMAND, EVENT} from "../../enum.js";
import ImageProcessing from "../../util/imageProcessing.js";

var SaveDialog = function(){
    let me ={};
    let nameInput;

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
        container.appendChild(
            $(".saveform",
                $(".name",$("h4","Name"),nameInput = $("input",{type:"text",value:ImageFile.getName()})),
                $("h4","Save as"),
                $(".platform.general",
                    $("h4.general","General"),
                    renderButton("png","PNG Image","PNG file","Full color and transparency, no layers, only the current frame gets saved.",writePNG),
                    renderButton("json","DPaint.JSON","JSON file","The internal format of Dpaint.js",writeJSON),
                    renderButton("psd","PSD","Coming soon ...","Working on it!")
                ),
                $(".platform.amiga",
                    $("h4.amiga","Amiga"),
                    renderButton("iff","IFF Image","Amiga IFF file","Maximum 32 colours, only the current frame gets saved.",writeIFF),
                    renderButton("mui","Amiga Classic Icon","OS1.3 Style","For all Amiga's. Use MUI palette for best compatibility",writeAmigaClassicIcon),
                    renderButton("os3","Amiga Color Icon","OS3.2 Style","Also called 'Glowicons'. For modern Amiga systems and/or with PeterK's Icon Library. Max 256 colors.",writeAmigaColorIcon),
                    renderButton("os4","Amiga Dual PNG Icon","OS4 Style","For modern Amiga systems and/or with PeterK's Icon Library. Full colors.",writeAmigaPNGIcon)
                )
        ));

        nameInput.onkeydown = function(e){
            e.stopPropagation();
        }
        nameInput.onchange = function(){
            ImageFile.setName(getFileName());
        }
    }

    function renderButton(type,title,subtitle,info,onClick){
        return $(".button",{onclick:onClick},
            $(".icon."+type),
            $(".title",title),
            $(".subtitle",subtitle),
            $(".info",info)
        );
    }

    function getFileName(){
        let name = nameInput.value.replace(/[ &\/\\#,+()$~%.'":*?<>{}]/g, "");
        return name || "Untitled"
    }

    function writeIFF(){
        let check = validate({
            maxColors: 32
        })

        if (!check.valid){
            Modal.show(DIALOG.OPTION,{
                title: "Save as IFF",
                text: ["Sorry, this image can't be saved as IFF."].concat(check.errors),
                buttons: [{label:"OK"}]
            });
            return;
        }

        var buffer = IFF.write(ImageFile.getCanvas());

        var blob = new Blob([buffer], {type: "application/octet-stream"});
        var fileName = getFileName() + '.iff';
        saveFile(blob,fileName,filetypes.IFF).then(()=>{
            Modal.hide();
        });
    }

    function writePNG(){
        ImageFile.getCanvas().toBlob(function(blob) {
            saveFile(blob,getFileName() + ".png",filetypes.PNG).then(()=>{
                Modal.hide();
            });
        });
    }

    function writeJSON(){
        let struct = ImageFile.clone();

        let blob = new Blob([JSON.stringify(struct,null,2)], { type: 'application/json' })
        saveFile(blob,getFileName() + '.json',filetypes.DPAINTJS).then(()=>{
            Modal.hide();
        });
    }

    function writeAmigaClassicIcon(config){
        config = config || {};
        config.title = "Save as Amiga Classic Icon";

        let check = validate({maxColors: 32});

        if (!check.valid){
            Modal.show(DIALOG.OPTION,{
                title: config.title,
                text: ["Sorry, this image has too many colors. Please reduce them to 16 or even better: 8 or less using the MUI palette"],
                buttons: [{label:"OK"}]
            });
            return;
        }

        check = validate({maxWidth: 1024, maxHeight: 1024});
        if (!check.valid){
            Modal.show(DIALOG.OPTION,{
                title: config.title,
                text: ["Sorry, this image is too big. Please reduce it to 1024x1024 pixels or less."],
                buttons: [{label:"OK"}]
            });
            return;
        }


        if (!config.skipColorCheck){
            check = validate({maxColors: 8})

            if (!check.valid){
                Modal.show(DIALOG.OPTION,{
                    title: config.title,
                    text: "Are you sure you want to save this image as Amiga Classic Icon? It has more than 8 colors which means it probably won't display correctly",
                    onOk:()=>{
                        config.skipColorCheck = true;
                        writeAmigaClassicIcon(config);
                    }
                });
                return;
            }
        }

        if (!config.skipSizeCheck){
            check = validate({maxWidth: 256, maxHeight: 256});

            if (!check.valid){
                Modal.show(DIALOG.OPTION,{
                    title: config.title,
                    text: "Are you sure you want to save this image as Amiga Classic Icon? It's kind of big... Allthough technically possible, it's not recommended to use icons bigger than 256x256 pixels",
                    onOk:()=>{
                        config.skipSizeCheck = true;
                        writeAmigaClassicIcon(config);
                    }
                });
                return;
            }
        }



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
        icon.img.planePick = 7 // color count - 1 (?)
        icon.img.pixels = [];
        icon.img2.width = w;
        icon.img2.height = h;
        icon.img2.depth = 3; // 8 colors
        icon.img2.planePick = 7 // color count - 1 (?)
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
                            // TODO: allow for arbitrary color palletes
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
        saveFile(blob,getFileName() + '.info',filetypes.ICO).then(()=>{
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
                    saveFile(blob, getFileName() + '.info',filetypes.ICO).then(()=>{
                        Modal.hide();
                    });
                });
            });
        }else{
            canvas1.toBlob(function(blob1) {
                let blob = new Blob([blob1], {type: "application/octet-stream"});
                saveFile(blob,getFileName() + '.info',filetypes.ICO).then(()=>{
                    Modal.hide();
                });
            });
        }
    };

    function writeAmigaColorIcon(){
        let check = validate({
            maxColors: 256,
            maxWidth: 256,
            maxHeight: 256
        })

        console.error(check);

        if (!check.valid){
            Modal.show(DIALOG.OPTION,{
                title: "Save as Amiga Color Icon",
                text: ["Sorry, this image can't be saved as Amiga Color Icon."].concat(check.errors),
                buttons: [{label:"OK"}]
            });
            return;
        }


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

        saveFile(blob,getFileName() + '.info',filetypes.ICO).then(()=>{
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
        saveFile(blob,getFileName() + '_palette.json',filetypes.PALETTE).then(()=>{

        });
    });

    function validate(config){
        let result = {
            valid: true,
            errors: []
        };
        if (config.maxColors){
            let colors = ImageProcessing.getColors(ImageFile.getCanvas(),config.maxColors).length;
            if (colors > config.maxColors){
                result.valid = false;
                result.errors.push("Please reduce the number of colors to maximum  " + config.maxColors + ".");
            }
        }

        if (config.maxWidth && config.maxHeight){
            let width = ImageFile.getCurrentFile().width
            let height = ImageFile.getCurrentFile().height;
            if (width > config.maxWidth || height > config.maxHeight){
                result.valid = false;
                result.errors.push("Please reduce the image size to maximum " + config.maxWidth + "x" + config.maxHeight + " pixels.");
            }
        }

        return result;
    }

    return me;
}();

export default SaveDialog;