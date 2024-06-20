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
                let color = Palette.getColorIndex([r, g, b],true);
                data[scanLineIndex + x + 1] = color;
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