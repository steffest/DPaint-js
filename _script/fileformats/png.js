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

let IndexedPng = function(){
    let me = {};

    let pngHeader = new Uint8Array([137,80,78,71,13,10,26,10]);

    me.write=function(canvas){
        let bitDepth = 8;
        let colorType = 3; // indexed color
        let compressionMethod = 0;
        let filterMethod = 0;
        let interlaceMethod = 0;

        let header = getHeaderChunk(canvas.width, canvas.height, bitDepth, colorType, compressionMethod, filterMethod, interlaceMethod);
        let palette = getPaletteChunk();
        let data = getDataChunk(canvas);

        let pngSize = pngHeader.length + chunkSize(header) + chunkSize(palette) + chunkSize(data) + chunkSize([]);
        let arrayBuffer = new ArrayBuffer(pngSize);
        let file = new BinaryStream(arrayBuffer, true);
        file.writeByteArray(pngHeader);
        writeChunk(file, IHDR, header);
        writeChunk(file, PLTE, palette);
        writeChunk(file, IDAT, data);
        writeChunk(file, IEND, []);

        return file.buffer;

    }

    function writeChunk(stream, type, data){
        let len = data.length;
        stream.writeUint(len);
        stream.writeByteArray(type);
        stream.writeByteArray(data);
        stream.writeUint(crc32.get(type.concat(Array.from(data))));
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

    function getPaletteChunk(){
        let palette = Palette.get();
        let data = new Uint8Array(palette.length*3);
        for (let i = 0; i < palette.length; i++) data.set(palette[i], i*3);
        return data;
    }

    function getDataChunk(canvas){
        let w = canvas.width;
        let h = canvas.height;

        // convert canvas to indexed color
        // put scanline filter method in first byte of each scanline
        // zlib compress the whole thing

        let imageData = canvas.getContext("2d").getImageData(0, 0, w, h);
        let pixels = imageData.data;

        let data = new Uint8Array(w * h + h);
        for (let y = 0; y < h; y++){
            let scanLineIndex = y * (w + 1);
            data[scanLineIndex] = 0; // no filter
            for (let x = 0; x < w; x++){
                let i = (y * w + x) * 4;
                let r = pixels[i];
                let g = pixels[i + 1];
                let b = pixels[i + 2];
                let color = Palette.getColorIndex([r, g, b]);
                data[scanLineIndex + x + 1] = color;
            }
        }

        let zData = new Zlib.Deflate(data).compress();
        return zData;
    }

    return me;
}();

export default IndexedPng;