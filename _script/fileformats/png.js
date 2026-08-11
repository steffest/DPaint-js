/*

    Simple PNG write support for indexed palette images
    Copyright (c) 2023 Steffest - dev@stef.be

    spec -> https://www.w3.org/TR/png/

 */


import BinaryStream from "../util/binarystream.js";
import Palette from "../ui/palette.js";
import crc32 from "../util/crc32.js";

import zlib_closure from "../util/zlib.js";
zlib_closure.call(window);

const PLTE = [80,76,84,69];
const IHDR = [73,72,68,82];
const IDAT = [73,68,65,84];
const IEND = [73,69,78,68];
const TRNS = [116,82,78,83];

let IndexedPng = function(){
    let me = {};

    let pngHeader = new Uint8Array([137,80,78,71,13,10,26,10]);

    // canvas: the image to write.
    // paletteOverride: optional [r,g,b][] palette to use instead of the current global
    //   palette (e.g. an optimized palette built from the image). Colors are matched
    //   against this palette, not Palette.get().
    me.write=function(canvas, paletteOverride){
        let performance = window.performance || Date;
        let startTime = performance.now();
        let bitDepth = 8;
        let colorType = 3; // indexed color
        let compressionMethod = 0;
        let filterMethod = 0;
        let interlaceMethod = 0;

        let paletteColors = (paletteOverride || Palette.get()).slice();
        let transparentIndex = -1;

        let w = canvas.width;
        let h = canvas.height;
        let ctx = canvas.getContext("2d");
        let imageData = ctx.getImageData(0, 0, w, h);
        let pixels = imageData.data;

        // Single pass: map each opaque pixel to a palette index (exact match against the
        // palette we're actually writing, falling back to 0 - same as the old
        // Palette.getColorIndex(color,true)), and track transparency + which indices
        // opaque pixels use. Transparent pixels are resolved later, once we know the
        // transparent index.
        let lookup = buildColorLookup(paletteColors);
        let indices = new Uint8Array(w * h);
        let usedByOpaque = new Uint8Array(paletteColors.length);
        let hasTransparency = false;
        for (let i = 0, p = 0; i < pixels.length; i += 4, p++) {
            if (pixels[i + 3] === 0) {
                hasTransparency = true;
            } else {
                let idx = lookup(pixels[i], pixels[i + 1], pixels[i + 2]);
                indices[p] = idx;
                usedByOpaque[idx] = 1;
            }
        }

        if (hasTransparency) {
            if (paletteColors.length < 256) {
                // Room for a dedicated transparent entry - no image color is affected.
                transparentIndex = paletteColors.length;
                paletteColors.push([0, 0, 0]);
            } else {
                // Palette is full. Reuse an index that no opaque pixel uses, so we don't
                // turn opaque pixels of that color transparent. (Common case: the palette
                // contains a color only used by the transparent area.)
                for (let i = 0; i < usedByOpaque.length; i++) {
                    if (!usedByOpaque[i]) { transparentIndex = i; break; }
                }
                // Last resort - every color is used by an opaque pixel, so transparency
                // and that color can't both be represented. Fall back to the background
                // color index (may turn matching opaque pixels transparent).
                if (transparentIndex < 0) {
                    transparentIndex = typeof Palette.getBackColorIndex === "function" ? Palette.getBackColorIndex() : 0;
                }
            }

            // Now assign the chosen transparent index to every transparent pixel.
            for (let i = 0, p = 0; i < pixels.length; i += 4, p++) {
                if (pixels[i + 3] === 0) indices[p] = transparentIndex;
            }
        }

        let header = getHeaderChunk(w, h, bitDepth, colorType, compressionMethod, filterMethod, interlaceMethod);
        let palette = getPaletteChunk(paletteColors);
        let transparency = getTransparencyChunk(paletteColors, transparentIndex);
        let data = getDataChunk(w, h, indices);

        let pngSize = pngHeader.length + chunkSize(header) + chunkSize(palette) + (transparency ? chunkSize(transparency) : 0) + chunkSize(data) + chunkSize([]);
        let arrayBuffer = new ArrayBuffer(pngSize);
        let file = new BinaryStream(arrayBuffer, true);
        file.writeByteArray(pngHeader);
        writeChunk(file, IHDR, header);
        writeChunk(file, PLTE, palette);
        if (transparency) writeChunk(file, TRNS, transparency);
        writeChunk(file, IDAT, data);
        writeChunk(file, IEND, []);


        console.log("PNG write time: " + (performance.now() - startTime) + "ms");

        return file.buffer;



    }

    function writeChunk(stream, type, data){
        let len = data.length;
        stream.writeUint(len);
        stream.writeByteArray(type);
        stream.writeByteArray(data);
        stream.writeUint(crc32.get(type.concat(Array.from(data))));
    }

    function readChunk(file,includeData){
        let index = file.index;
        let data;
        let len = file.readUint();
        let type = file.readUBytes(4);
        if (includeData) data = file.readUBytes(len);
        let crc = file.readUint();

        file.goto(index + 4 + 4 + len + 4);

        return {type, data};
    }

    function chunkSize(data){
        return data.length + 12;
    }

    function getHeaderChunk(width, height, bitDepth, colorType, compressionMethod, filterMethod, interlaceMethod){
        let byteArr = new ArrayBuffer(13);
        let data = new BinaryStream(byteArr, true);
        data.writeUint(width);
        data.writeUint(height);
        data.writeUbyte(bitDepth);
        data.writeUbyte(colorType);
        data.writeUbyte(compressionMethod);
        data.writeUbyte(filterMethod);
        data.writeUbyte(interlaceMethod);
        return new Uint8Array(data.buffer);
    }

    function readHeaderChunk(file){
        let width = file.readUint();
        let height = file.readUint();
        let bitDepth = file.readUbyte();
        let colorType = file.readUbyte();
        let compressionMethod = file.readUbyte();
        let filterMethod = file.readUbyte();
        let interlaceMethod = file.readUbyte();
        file.jump(4); // skip CRC
        return {width, height, bitDepth, colorType, compressionMethod, filterMethod, interlaceMethod};
    }

    function getPaletteChunk(paletteColors){
        let data = new Uint8Array(paletteColors.length*3);
        for (let i = 0; i < paletteColors.length; i++) data.set(paletteColors[i], i*3);
        return data;
    }

    function getTransparencyChunk(paletteColors, transparentIndex){
        if (transparentIndex < 0) return null;
        
        let data = new Uint8Array(paletteColors.length);
        
        // Set alpha values: 0 for transparent colors, 255 for opaque
        for (let i = 0; i < paletteColors.length; i++){
            data[i] = (i === transparentIndex) ? 0 : 255;
        }
        
        return data;
    }

    // Build a fast exact-match color->palette-index lookup. First match wins (same as
    // Array.findIndex), and unmatched colors fall back to index 0 - matching the old
    // Palette.getColorIndex(color, true) behaviour, but against the palette being written.
    function buildColorLookup(paletteColors){
        let map = new Map();
        for (let i = 0; i < paletteColors.length; i++){
            let c = paletteColors[i];
            let key = c[0] + "," + c[1] + "," + c[2];
            if (!map.has(key)) map.set(key, i);
        }
        return (r, g, b) => {
            let idx = map.get(r + "," + g + "," + b);
            return idx === undefined ? 0 : idx;
        };
    }

    function getDataChunk(w, h, indices){
        // indices already holds one palette index per pixel.
        // put scanline filter method in first byte of each scanline,
        // then zlib compress the whole thing.
        let data = new Uint8Array(w * h + h);
        for (let y = 0; y < h; y++){
            let scanLineIndex = y * (w + 1);
            data[scanLineIndex] = 0; // no filter
            for (let x = 0; x < w; x++){
                data[scanLineIndex + x + 1] = indices[y * w + x];
            }
        }

        let zData = new Zlib.Deflate(data).compress();
        return zData;
    }


    function isArrayEqual(a,b){
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++){
            if (a[i] !== b[i]) return false;
        }
        return true;
    }

    // detect 8-bit indexed PNG
    me.detect = file=>{
        let header = file.readUBytes(8, 0);
        let isIndexedPng = isArrayEqual(header, pngHeader);
        if (isIndexedPng){
            // according to specs the IHDR chunk should be the first chunk
           let chunk = readChunk(file);
           if (isArrayEqual(chunk.type, IHDR)){
               file.goto(8 + 4 + 4);
               let header =  readHeaderChunk(file);
               isIndexedPng = header.colorType === 3;
           }
        }
        return isIndexedPng;
    }

    me.parse = file=>{
        return new Promise((next)=>{
            let result = {data:{}};
            file.goto(8 + 4 + 4);
            let header =  readHeaderChunk(file);

            // find palette chunk
            let paletteFound = false;
            let palette;
            while (!paletteFound && file.index < file.length - 12){
                let index = file.index;
                let chunk = readChunk(file, false);
                if (isArrayEqual(chunk.type, PLTE)){
                    paletteFound = true;
                    file.goto(index);
                    chunk = readChunk(file, true);
                    palette = [];
                    for (let i = 0; i < chunk.data.length; i+=3){
                        palette.push([chunk.data[i], chunk.data[i+1], chunk.data[i+2]]);
                    }
                   result.data.palette = palette;
                }
            }

            // use the browser's built-in PNG parser
            var image = new Image();
            image.src = URL.createObjectURL(new Blob([file.buffer], {type: "image/png"}));
            image.onload = function(){
                result.image = image;
                next(result);
            }
        });
    }

    return me;
}();

export default IndexedPng;