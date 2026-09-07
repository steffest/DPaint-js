import Palette from "../ui/palette.js";
import Color from "../util/color.js";

/*
    Raw Amiga bitplane data, as written by the "BitPlanes" export (see Generate.planes).

    The format is headerless: plane 0 for the whole image, then plane 1, and so on, each
    plane padded to a whole number of 16-bit words per line. That means width, height and
    plane count can not be read from the file - the importer has to be told, which is what
    planesDialog.js is for. The palette lives in the ".palette.txt" sidecar the exporter
    writes next to it; it can be loaded separately with Palette > Load.
 */
let PLANES = (function(){
    let me = {};

    me.bytesPerLine = function(width){
        return Math.ceil(width/16)*2;
    }

    me.planeSize = function(width,height){
        return me.bytesPerLine(width)*height;
    }

    // The only structural constraint a raw plane file has: its length must be a whole
    // number of planes of the given size. Used to propose sane defaults and to flag a
    // width/plane-count combination that can not describe this file.
    me.fits = function(byteLength,width,height,planeCount){
        if (width<1 || height<1 || planeCount<1) return false;
        return me.planeSize(width,height)*planeCount === byteLength;
    }

    // Derives the height a file of this size would have for the given width and plane
    // count, or 0 when it doesn't divide evenly.
    me.getHeight = function(byteLength,width,planeCount){
        if (width<1 || planeCount<1) return 0;
        let lineSize = me.bytesPerLine(width)*planeCount;
        if (!lineSize || byteLength % lineSize) return 0;
        return byteLength/lineSize;
    }

    // Best guess at the layout of a headerless plane file: prefers the dimensions of the
    // image that is currently open (a plane export loaded straight back in is the common
    // case), then the usual Amiga screen widths.
    me.guess = function(byteLength,currentWidth,currentPlaneCount){
        let widths = [currentWidth,320,640,352,384,256,160,128,64,32,16].filter(w=>w>0);
        let planeCounts = [currentPlaneCount,5,4,3,6,2,1,7,8].filter(p=>p>0);

        // exact matches first: a width/plane count that divides the file evenly
        for (let p = 0; p < planeCounts.length; p++){
            for (let w = 0; w < widths.length; w++){
                let height = me.getHeight(byteLength,widths[w],planeCounts[p]);
                if (height) return {width: widths[w], height: height, planeCount: planeCounts[p]};
            }
        }

        let width = widths[0] || 320;
        let planeCount = planeCounts[0] || 5;
        return {
            width: width,
            height: Math.max(1,Math.ceil(byteLength/(me.bytesPerLine(width)*planeCount))),
            planeCount: planeCount
        };
    }

    // The plane count that matches the current palette, so the guess above starts from
    // what the user is most likely to have exported.
    me.getPalettePlaneCount = function(){
        let colors = Palette.get().length;
        let planeCount = 1;
        while ((1 << planeCount) < colors) planeCount++;
        return Math.min(8,planeCount);
    }

    /*
        Decodes raw planes into a canvas. Colours come from `palette` (the current palette
        by default) - the file itself carries none. Indices beyond the palette render
        black, so a wrong plane count shows up as an obviously broken image rather than
        failing silently.
     */
    me.toCanvas = function(buffer,options){
        options = options || {};
        let width = options.width|0;
        let height = options.height|0;
        let planeCount = options.planeCount|0;
        if (width<1 || height<1 || planeCount<1) return null;

        let bytes = new Uint8Array(buffer);
        let bytesPerLine = me.bytesPerLine(width);
        let planeSize = bytesPerLine*height;

        let palette = (options.palette || Palette.get()).map(color=>Color.fromString(color).slice(0,3));

        let canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        let ctx = canvas.getContext("2d");
        let imageData = ctx.getImageData(0,0,width,height);
        let data = imageData.data;

        for (let y = 0; y < height; y++){
            let lineOffset = y*bytesPerLine;
            for (let x = 0; x < width; x++){
                let byteOffset = lineOffset + (x>>3);
                let mask = 0x80 >> (x&7);
                let index = 0;
                for (let p = 0; p < planeCount; p++){
                    // bytes past the end of a truncated file read as 0
                    if (bytes[p*planeSize + byteOffset] & mask) index |= 1<<p;
                }

                let target = (y*width + x)*4;
                if (index === 0 && options.transparentIndex0){
                    data[target+3] = 0;
                    continue;
                }
                let color = palette[index] || [0,0,0];
                data[target] = color[0];
                data[target+1] = color[1];
                data[target+2] = color[2];
                data[target+3] = 255;
            }
        }

        ctx.putImageData(imageData,0,0);
        return canvas;
    }

    return me;
}());

export default PLANES;
