import Modal, {DIALOG} from "../ui/modal.js";
import IFF from "./iff.js";
import ImageFile from "../image.js";
import ImageProcessing from "../util/imageProcessing.js";
import Icon from "./amigaIcon.js";
import Palette from "../ui/palette.js";
import IndexedPng from "./png.js";
import GIF from "./gif.js";

let Generate = function(){
    let me = {};

    me.validate = (config)=>{
        let result = {
            valid: true,
            errors: []
        };
        if (config.maxColors){
            let colors = ImageProcessing.getColors(ImageFile.getCanvas(),config.maxColors).length;
            if (ImageFile.getCurrentFile().frames.length>1 && config.checkAllFrames){
                colors = Math.max(colors,ImageProcessing.getColors(ImageFile.getCanvas(1),config.maxColors).length);
            }
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

    // returns a blob
    me.file = async type=>{
        switch (type){
            case "classicIcon":
                return await me.classicIcon();
            case "colorIcon":
                return me.colorIcon();
            case "PNGIcon":
                return await me.PNGIcon();
            case "IFF":
                return me.iff();
            case "BitPlanes":
                return me.planes();
            case "BitMask":
                return me.mask();
            case "PNG":
                return await new Promise(resolve => ImageFile.getCanvas().toBlob(resolve));
            case "PNG8":
                return me.png8();
            case "GIF":
                return me.gif();
            case "DPAINT":
                return me.dPaint();
            case "DPAINTINDEXED":
                return me.dPaint(true);
            default:
                console.error("Unknown file type",type);
        }
    }

    me.iff=(maxColors,tooManyColorMessage)=>{
        maxColors = maxColors || 256;
        let check = me.validate({
            maxColors: maxColors
        })

        if (!check.valid){
            Modal.show(DIALOG.OPTION,{
                title: "Save as IFF",
                text: [tooManyColorMessage||"Sorry, this image can't be saved as IFF."].concat(check.errors),
                buttons: [{label:"OK"}]
            });
            return;
        }

        let buffer = IFF.write(ImageFile.getCanvas());
        return new Blob([buffer], {type: "application/octet-stream"});
    }

    me.planes=()=>{
        let maxColors = 32;
        let check = me.validate({
            maxColors: maxColors
        })

        if (!check.valid){
            Modal.show(DIALOG.OPTION,{
                title: "Save as BitPlane data",
                text: ["Sorry, this image can't be saved as Bitplane data."].concat(check.errors),
                buttons: [{label:"OK"}]
            });
            return;
        }

       return IFF.toBitPlanes(ImageFile.getCanvas());

    }

    me.mask=()=>{
        return IFF.toBitMask(ImageFile.getCanvas());
    }

    me.png8=()=>{
        let maxColors = 256;

        let check = me.validate({
            maxColors: maxColors
        });
        if (!check.valid){
            return {
                result: "error",
                title: "Save as PNG8",
                messages: ["Sorry, this image can't be saved as PNG8."].concat(check.errors)
            }
        }

        let buffer = IndexedPng.write(ImageFile.getCanvas());
        return {
            result: "ok",
            file: new Blob([buffer], {type: "application/octet-stream"})
        };
    }

    me.gif=()=>{
        let maxColors = 256;
        let check = me.validate({
            maxColors: maxColors
        });
        if (!check.valid){
            return {
                result: "error",
                title: "Save as GIF",
                messages: ["Sorry, this image can't be saved as GIF."].concat(check.errors)
            }
        }

        let buffer = GIF.write(ImageFile.getCurrentFile().frames);
        return {
            result: "ok",
            file: new Blob([buffer], {type: "application/octet-stream"})
        };
    }

    me.dPaint=(indexed)=>{
        let exportResult = ImageFile.export(indexed);
        let result = {result:"ok"};

        if (indexed && exportResult.errorCount){
            let pixels = " pixel";
            if (exportResult.errorCount>1) pixels += "s";
            result.messages = [exportResult.errorCount + pixels + " could not be converted to index colors because there was no matching color found in the palette."];
            result.result = "warning";
        }
        result.file = new Blob([JSON.stringify(exportResult)], { type: 'application/json' });
        return result;
    }

    me.classicIcon=(config)=>{
        return new Promise(next=>{
            config = config || {};
            config.title = "Save as Amiga Classic Icon";

            let check = me.validate({maxColors: 32, checkAllFrames: true});

            if (!check.valid){
                Modal.show(DIALOG.OPTION,{
                    title: config.title,
                    text: ["Sorry, this image has too many colors. Please reduce them to 16 or even better: 8 or less using the MUI palette"],
                    buttons: [{label:"OK"}]
                });
                next();
            }

            check = me.validate({maxWidth: 1024, maxHeight: 1024});
            if (!check.valid){
                Modal.show(DIALOG.OPTION,{
                    title: config.title,
                    text: ["Sorry, this image is too big. Please reduce it to 1024x1024 pixels or less."],
                    buttons: [{label:"OK"}]
                });
                next();
            }


            if (!config.skipColorCheck){
                check = me.validate({maxColors: 8})

                if (!check.valid){
                    Modal.show(DIALOG.OPTION,{
                        title: config.title,
                        text: "Are you sure you want to save this image as Amiga Classic Icon? It has more than 8 colors which means it probably won't display correctly",
                        onOk:()=>{
                            config.skipColorCheck = true;
                            me.classicIcon(config).then(next);
                        }
                    });
                    return;
                }
            }

            if (!config.skipSizeCheck){
                check = me.validate({maxWidth: 256, maxHeight: 256});

                if (!check.valid){
                    Modal.show(DIALOG.OPTION,{
                        title: config.title,
                        text: "Are you sure you want to save this image as Amiga Classic Icon? It's kind of big... Although technically possible, it's not recommended to use icons bigger than 256x256 pixels",
                        onOk:()=>{
                            config.skipSizeCheck = true;
                            me.classicIcon(config).then(next);
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

                let additionalColors = ["#000000"];


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
                                console.warn("No MUI color: " + rgb);

                                // making some assumptions here:
                                // get from palette
                                colorIndex = Palette.getColorIndex([r,g,b],true);

                                // check if already in list
                                if (colorIndex<0) colorIndex = additionalColors.indexOf(rgb);

                                if (colorIndex<0){
                                    // add to list
                                    additionalColors.push(rgb);
                                    colorIndex = additionalColors.length-1;
                                }

                                if (colorIndex>15){
                                    console.error("Too many colors: " + rgb);
                                    colorIndex = 0;
                                }
                            }
                            pixels.push(colorIndex);
                        }else{
                            pixels.push(0);
                        }
                    }
                }
            }

            fillPixels(ctx1,icon.img.pixels);
            fillPixels(ctx2,icon.img2.pixels);

            let buffer = Icon.write(icon);
            next(new Blob([buffer], {type: "application/octet-stream"}));
        });
    }

    me.colorIcon=()=>{
        let check = me.validate({
            maxColors: 256,
            checkAllFrames: true,
            maxWidth: 256,
            maxHeight: 256
        })

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
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                let index = (x + y * w) * 4;

                r = data[index];
                g = data[index+1];
                b = data[index+2];
                alpha = data[index+3];

                if(alpha>100){
                    let rgb = rgbToHex(r,g,b);
                    let colorIndex = colorLookup[rgb];
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
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                let index = (x + y * w) * 4;

                r = data2[index];
                g = data2[index+1];
                b = data2[index+2];
                alpha = data2[index+3];

                if(alpha>100){
                    let rgb = rgbToHex(r,g,b);
                    let colorIndex = colorLookup2[rgb];
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
        let state2 = icon.colorIcon.states[1];
        state2.NumColors = palette2.length;
        state2.paletteSize = state2.NumColors * 3;
        state2.palette = palette2.slice();
        state2.pixels = pixels2.slice();


        let buffer = Icon.write(icon);

        return new Blob([buffer], {type: "application/octet-stream"});
    }

    me.PNGIcon=(config)=>{
        return new Promise(next=>{
            let canvas1 = ImageFile.getCanvas(0);
            let canvas2 = ImageFile.getCanvas(1);
            if (canvas2){
                canvas1.toBlob(function(blob1) {
                    canvas2.toBlob(function(blob2) {
                        next(new Blob([blob1,blob2], {type: "application/octet-stream"}));
                    });
                });
            }else{
                canvas1.toBlob(function(blob1) {
                    next(new Blob([blob1], {type: "application/octet-stream"}));
                });
            }
        });
    }

    function rgbToHex(r, g, b) {
        return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
    }

    return me
}();

export default Generate;