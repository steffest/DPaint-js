/*

    MIT License

    Copyright (c) 2019-2023 Steffest - dev@stef.be

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.

 */

import BinaryStream from "../util/binarystream.js";
import ImageProcessing from "../util/imageProcessing.js";
import Palette from "../ui/palette.js";
import Color from "../util/color.js";

const FILETYPE = {
    IFF: { name: "IFF file" },
    PBM: { name: "PBM Image" },
    ILBM: { name: "ILBM Image", actions: ["show"], inspect: true },
    ANIM: { name: "IFF ILBM Animation" },
};

const IFF = (function () {
    // Detect and Decode IFF Files
    // handles ILBM images, including EHB (Extra Half-Bright) and HAM (Hold and Modify)
    // and ANIM animations
    // TODO: Brushes and other masked images

    // image format info on https://en.wikipedia.org/wiki/ILBM

    const me = {};

    me.fileTypes = {
        IFF: { name: "IFF file" },
        ILBM: { name: "ILBM Image", actions: ["show"], inspect: true },
        ANIM: { name: "IFF ILBM Animation" },
    };

    me.parse = function (file, decodeBody, fileType,parent) {
        let img = {
            palette: [],
        };
        let index = 12;

        function readChunk() {
            const chunk = {};
            chunk.name = file.readString(4);
            chunk.size = file.readDWord();
            return chunk;
        }

        while (index < file.length - 4) {
            file.goto(index);
            const chunk = readChunk();

            switch (chunk.name) {
                case "BMHD":
                    img.width = file.readWord();
                    img.height = file.readWord();
                    img.x = file.readShort();
                    img.y = file.readShort();
                    img.numPlanes = file.readUbyte();
                    img.mask = file.readUbyte();
                    img.compression = file.readUbyte();
                    img.pad = file.readUbyte();
                    img.transparentColor = file.readWord();
                    img.xAspect = file.readUbyte();
                    img.yAspect = file.readUbyte();
                    img.pageWidth = file.readWord();
                    img.pageHeight = file.readWord();
                    if (img.numPlanes && img.numPlanes < 9) {
                        img.colors = 1 << img.numPlanes;
                    }
                    if (img.numPlanes == 24) {
                        img.trueColor = true;
                    }
                    break;
                case "CMAP":
                    for (var i = 0, max = chunk.size / 3; i < max; i++) {
                        img.palette.push([
                            file.readUbyte(),
                            file.readUbyte(),
                            file.readUbyte(),
                        ]);
                    }
                    break;
                case "CRNG":
                    img.colourRange = img.colourRange || [];
                    file.readShort(); // padding
                    let CRNGrange = {
                        rate: file.readShort(), // 16384 = 60 steps/second
                        flags: file.readShort(),
                        low: file.readUbyte(),
                        high: file.readUbyte()
                    }
                    CRNGrange.fps = CRNGrange.rate/16384*60;
                    CRNGrange.active = CRNGrange.flags & 1;
                    CRNGrange.reverse = CRNGrange.flags & 2;
                    img.colourRange.push(CRNGrange);
                    break;
                case "DRNG": {
                    // Dpaint IV enhanced color cycle chunk.
                    // https://wiki.amigaos.net/wiki/ILBM_IFF_Interleaved_Bitmap#ILBM.DRNG
                    img.colourRange = img.colourRange || [];
                    const range = {
                        min: file.readUbyte(),
                        max: file.readUbyte(),
                        rate: file.readShort(),
                        flags: file.readShort(),
                        numberOfDColors: file.readUbyte(),
                        colors: [],
                        numberOfDIndexes: file.readUbyte(),
                        indexes: [],
                    };
                    for (let i = 0; i < range.numberOfDColors; i++) {
                        // true color RGB values. (Is this used? I've never seen it in the wild)
                        range.colors.push({
                            index: file.readUbyte(),
                            red: file.readUbyte(),
                            green: file.readUbyte(),
                            blue: file.readUbyte(),
                        });
                    }

                    for (let i = 0; i < range.numberOfDIndexes; i++) {
                        // index values
                        range.indexes.push({
                            index: file.readUbyte(),
                            colorIndex: file.readUbyte(),
                        });
                    }
                    img.colourRange.push(range);
                    break;
                }
                case "CCRT":
                    // Graphicraft Color Cycle chunk
                    // https://wiki.amigaos.net/wiki/ILBM_IFF_Interleaved_Bitmap#ILBM.CCRT
                    // examples: https://amiga.lychesis.net/applications/Graphicraft.html
                    img.colourRange = img.colourRange || [];
                    let CCRTRange = {
                        direction: file.readWord(),
                        low: file.readUbyte(),
                        high: file.readUbyte(),
                        seconds: file.readLong(),
                        microseconds: file.readLong(),
                        padding: file.readWord()
                    }
                    CCRTRange.active = CCRTRange.direction !== 0;
                    CCRTRange.fps = 1/(CCRTRange.seconds + CCRTRange.microseconds/1000000);
                    img.colourRange.push(CCRTRange);
                    break;
                case "CAMG":
                    var v = file.readLong();
                    img.interlaced = v & 0x4;
                    img.ehb = v & 0x80;
                    img.ham = v & 0x800;
                    img.hires = v & 0x8000;
                    break;
                case "BODY":
                    img.body = [];

                    // adjust EHB and HAM palette here as the order of CMAP and CAMG is not defined;
                    if (img.ehb) {
                        for (i = 0; i < 32; i++) {
                            const c = img.palette[i];
                            img.palette[i + 32] = [
                                c[0] >> 1,
                                c[1] >> 1,
                                c[2] >> 1,
                            ];
                        }
                    }
                    img.colorPlanes = img.numPlanes;
                    if (img.ham) {
                        img.hamPixels = [];
                        img.colorPlanes = 6; // HAM8
                        if (img.numPlanes < 7) img.colorPlanes = 4; // HAM6
                    }

                    // some images have bad CAMG blocks?
                    if (!img.hires && img.width >= 640) img.hires = true;
                    if (img.hires && !img.interlaced && img.height >= 400) {
                        img.interlaced = true;
                    }

                    if (decodeBody) {
                        console.error(img.compression)
                        console.error(img)
                        if (fileType === FILETYPE.PBM) {
                            let pixelData = [];

                            if (img.compression) {
                                // Decompress the data
                                for (let i = 0; i < chunk.size; i++) {
                                    const byte = file.readUbyte();

                                    if (byte > 128) {
                                        const nextByte = file.readUbyte();
                                        for (let i = 0; i < 257 - byte; i++) {
                                            pixelData.push(nextByte);
                                        }
                                    } else if (byte < 128) {
                                        for (let i = 0; i < byte + 1; i++) {
                                            pixelData.push(file.readUbyte());
                                        }
                                    } else {
                                        break;
                                    }
                                }
                            } else {
                                // Just copy the data
                                // FIXME: Use BinaryStream.readBytes() ?
                                for (let i = 0; i < chunk.size; i++) {
                                    pixelData.push(file.readUbyte());
                                }
                            }

                            // Rearrange pixel data in the right format for rendering?
                            // FIXME: Figure out why this needs to happen
                            let pixels = [];
                            for (let y = 0; y < img.height; y++) {
                                pixels[y] = [];
                                for (let x = 0; x < img.width; x++) {
                                    pixels[y][x] = pixelData[y * img.width + x];
                                }
                            }

                            img.pixels = pixels;
                        } else {
                            const pixels = [];
                            const planes = [];
                            let lineWidth = (img.width + 15) >> 4; // in words
                            lineWidth *= 2; // in bytes

                            if (img.compression < 2) {

                                for (let y = 0; y < img.height; y++) {
                                    pixels[y] = [];
                                    if (img.ham) img.hamPixels[y] = [];

                                    for (let plane = 0; plane < img.numPlanes; plane++) {
                                        planes[plane] = planes[plane] || [];
                                        planes[plane][y] = planes[plane][y] || [];
                                        const line = [];
                                        if (img.compression) {

                                            // RLE compression
                                            let pCount = 0;
                                            while (pCount < lineWidth) {
                                                var b = file.readUbyte();
                                                if (b === 128) break;
                                                if (b > 128) {
                                                    let b2 = file.readUbyte();
                                                    for (var k = 0; k < 257 - b; k++) {
                                                        line.push(b2);
                                                        pCount++;
                                                    }
                                                } else {
                                                    for (k = 0; k <= b; k++) {
                                                        line.push(file.readUbyte());
                                                    }
                                                    pCount += b + 1;
                                                }
                                            }
                                        } else {
                                            for (let x = 0; x < lineWidth; x++) {
                                                line.push(file.readUbyte());
                                            }
                                        }

                                        // add bitplane line to pixel values;
                                        for (b = 0; b < lineWidth; b++) {
                                            const val = line[b];
                                            for (i = 7; i >= 0; i--) {
                                                let x = b * 8 + (7 - i);
                                                const bit = val & (1 << i) ? 1 : 0;
                                                if (plane < img.colorPlanes) {
                                                    var p = pixels[y][x] || 0;
                                                    pixels[y][x] = p + (bit << plane);
                                                    planes[plane][y][x] = bit;
                                                } else {
                                                    p = img.hamPixels[y][x] || 0;
                                                    img.hamPixels[y][x] = p + (bit << (plane - img.colorPlanes));
                                                }
                                            }
                                        }
                                    }
                                }
                            } else {
                                // Atari ST ByteRun2 compression: each bitplane is stored in column
                                for (let plane = 0; plane < img.numPlanes; plane++) {
                                    planes[plane] = planes[plane] || [];
                                    const lines = [];
                                    // each plane is stored in a 'VDAT' chunk inside the 'BODY' chunk
                                    readChunk();
                                    const count = file.readWord() - 2;

                                    const cmds = file.readBytes(count)
                                    let x = 0;
                                    let y = 0;
                                    let dataCount = 0;
                                    for (let i = 0; i < count && x < lineWidth; ++i) {
                                        const cmd = cmds[i]

                                        if (cmd === 0) {
                                            dataCount = file.readWord()
                                            while (dataCount-- > 0 && x < lineWidth) {
                                                lines[x + y * lineWidth] = file.readUbyte();
                                                lines[x + y++ * lineWidth + 1] = file.readUbyte();
                                                if (y >= img.height) {
                                                    y = 0;
                                                    x += 2;
                                                }
                                            }
                                        } else if (cmd < 0) {
                                            dataCount = -cmd;
                                            while (dataCount-- > 0 && x < lineWidth) {
                                                lines[x + y * lineWidth] = file.readUbyte();
                                                lines[x + y++ * lineWidth + 1] = file.readUbyte();
                                                if (y >= img.height) {
                                                    y = 0;
                                                    x += 2;
                                                }
                                            }
                                        }
                                        else if (cmd === 1) {
                                            dataCount = file.readWord();
                                            let repeat = file.readWord();

                                            while (dataCount-- > 0 && x < lineWidth) {
                                                lines[x + y * lineWidth] = repeat >> 8;
                                                lines[x + y++ * lineWidth + 1] = repeat & 0xFF;
                                                if (y >= img.height) {
                                                    y = 0;
                                                    x += 2;
                                                }
                                            }
                                        } else {
                                            dataCount = cmd;
                                            let repeat = file.readWord();
                                            while (dataCount-- > 0 && x < lineWidth) {
                                                lines[x + y * lineWidth] = repeat >> 8;
                                                lines[x + y++ * lineWidth + 1] = repeat & 0xFF;
                                                if (y >= img.height) {
                                                    y = 0;
                                                    x += 2;
                                                }
                                            }
                                        }
                                    }

                                    for (let y = 0; y < img.height; ++y) {
                                        planes[plane][y] = planes[plane][y] || [];
                                        pixels[y] = pixels[y] || [];
                                        for (b = 0; b < lineWidth; b++) {
                                            const val = lines[y * lineWidth + b];
                                            for (i = 7; i >= 0; i--) {
                                                let x = b * 8 + (7 - i);
                                                const bit = val & (1 << i) ? 1 : 0;
    
                                                var p = pixels[y][x] || 0;
                                                pixels[y][x] = p + (bit << plane);
                                                planes[plane][y][x] = bit;
                                            }
                                        }
                                    }
                                }
                            }
                            img.pixels = pixels;
                            img.planes = planes;
                        }
                    }

                    break;
                case "FORM": // ANIM or other embedded IFF structure
                    img.frames = img.frames || [];
                    if (img.animFrameCount && img.frames.length >= img.animFrameCount){
                        console.log("ANIM: frame count exceeded, skipping frame");
                        break;
                    }
                    let buffer = new ArrayBuffer(chunk.size+8);
                    const view = new DataView(buffer);
                    file.readUBytes(chunk.size+8,file.index-8,view);
                    let subFile = new BinaryStream(buffer,true);
                    let subImg = me.parse(subFile, true,fileType,img);
                    if (subImg){
                        img.frames.push(subImg);
                        if (img.frames.length === 1) {
                            img.width = subImg.width;
                            img.height = subImg.height;
                            img.numPlanes = subImg.numPlanes;
                            img.palette = subImg.palette;
                            img.animFrameCount = subImg.animFrameCount;
                        }
                    }
                    //console.error(subImg);
                    break;
                case "ANHD": // https://wiki.amigaos.net/wiki/ANIM_IFF_CEL_Animations#ANHD_Chunk
                    img.animHeader = {
                        compression: file.readUbyte(),
                        mask: file.readUbyte(),
                        width: file.readWord(),
                        height: file.readWord(),
                        x: file.readWord(),
                        y: file.readWord(),
                        absTime: file.readDWord(),
                        relTime: file.readDWord(),
                        interleave: file.readUbyte(),
                        pad: file.readUbyte(),
                        bits: file.readUbyte(),
                        future: file.readUbyte(),
                    }
                    break;
                case "DPAN":
                    img.animVersion = file.readWord();
                    img.animFrameCount = file.readWord();
                    break;
                case "DLTA": // https://wiki.amigaos.net/wiki/ANIM_IFF_CEL_Animations#DLTA_Chunk

                    if (!parent){
                        console.error("Error: DLTA chunk without parent structure");
                        return;
                    }

                    img.animHeader = img.animHeader || {};

                    let sourceFrameIndex = Math.max(parent.frames.length - 2,0);
                    let frame = parent.frames[sourceFrameIndex];
                    if (!frame){
                        console.error("Error: No frame to apply DLTA chunk to");
                        return;
                    }
                    // copy reference frame;
                    img.width = frame.width;
                    img.height = frame.height;
                    img.palette = frame.palette;
                    img.planes = [];

                    // TODO: this is slow...
                    frame.planes.forEach(plane=>{
                        let newPlane = [];
                        plane.forEach(line=>newPlane.push(line.slice()));
                        img.planes.push(newPlane);
                    });

                    if (sourceFrameIndex>0){
                        //parent.frames[sourceFrameIndex-1].planes = undefined;
                    }


                    switch (img.animHeader.compression) {
                        case 0: // No compression
                            break;
                        case 1: // XOR compression
                            console.warn("unhandled ANIM compression: XOR");
                            break;
                        case 2: // long Delta compression
                            console.warn("unhandled ANIM compression: long Delta");
                            break;
                        case 3: // short Delta compression
                            console.warn("unhandled ANIM compression: short Delta");
                            break;
                        case 4: // Generalized Delta compression
                            console.warn("unhandled ANIM compression: Generalized Delta");
                            break;
                        case 5: // Byte Vertical Delta compression
                            // This is the default compression method for Deluxe Paint Animations.

                            let startIndex = file.index;
                            let pointers = [];
                            for (let i =0;i<8;i++) pointers.push(file.readDWord());
                            let colCount = parent.width + 15 >>> 4 << 1;
                            let bitPlaneCount = Math.min(parent.numPlanes,8);

                            for (let bitPlaneIndex = 0; bitPlaneIndex < bitPlaneCount; bitPlaneIndex++) {
                                let pointer = pointers[bitPlaneIndex];
                                if (pointer){
                                    //console.log('handling bitPlaneIndex ' + bitPlaneIndex + ' at ' + pointer);
                                    file.goto(startIndex+pointer);

                                    for (let colIndex = 0; colIndex < colCount; colIndex++) {
                                        let opCount = file.readUbyte();
                                        if (opCount === 0) continue;
                                        //console.warn(opCount + " opCounts in column " + colIndex);
                                        let destinationIndex = 0;
                                        for (let opIndex = 0; opIndex < opCount; opIndex++) {
                                            let opCode = file.readUbyte();
                                            //console.warn("opCode", opCode);
                                            if (opCode === 0) {
                                                //Same ops
                                                let copyCount = file.readUbyte();
                                                let byteToCopy = file.readUbyte();
                                                //console.warn("copy",byteToCopy,copyCount);
                                                for (let i = 0; i < copyCount; i++) {
                                                    let y = destinationIndex;
                                                    //data[(destinationIndex * bitPlaneCount + bitPlaneIndex) * colCount + colIndex] = byteToCopy;
                                                    for (let bi = 7; bi >= 0; bi--) {
                                                        let x =  (colIndex*8) + 7 - bi;
                                                        const bit = byteToCopy & (1 << bi) ? 1 : 0;
                                                        img.planes[bitPlaneIndex][y][x] = bit;
                                                    }
                                                    destinationIndex++
                                                }
                                            } else if (opCode < 128) {
                                                // Skip ops: jump over opCode pixels
                                                destinationIndex += opCode;
                                                //console.warn("skip to line",destinationIndex);
                                            } else {
                                                // Uniq ops: read opCode pixels
                                                opCode -= 128;
                                                for (let i = 0; i < opCode; i++) {
                                                    let b = file.readUbyte();
                                                    let y = destinationIndex;
                                                    let bits = [];

                                                    if (destinationIndex < img.height) {
                                                        for (let bi = 7; bi >= 0; bi--) {
                                                            let x =  (colIndex*8) + 7 - bi;
                                                            const bit = b & (1 << bi) ? 1 : 0;
                                                            img.planes[bitPlaneIndex][y][x] = bit;
                                                            bits.push(bit);
                                                        }

                                                        destinationIndex++;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            break;
                        case 6: // Stereo op 5 compression
                            console.warn("unhandled ANIM compression: Stereo op 5");
                            break;
                        case 7: // short/long Vertical Delta mode
                            console.warn("unhandled ANIM compression: short/long Vertical Delta");
                            break;
                        default:
                            console.error(`unhandled ANIM compression: ${img.animHeader.compression}`);
                    }

                    let now = performance.now();
                    // planes to pixels
                    img.pixels = [];
                    for (let y = 0; y < img.height; y++) {
                        let line = [];
                        for (let x = 0; x < img.width; x++) {
                            let pixel = 0;
                            for (let bitPlaneIndex = 0; bitPlaneIndex < parent.numPlanes; bitPlaneIndex++) {
                                let bit = img.planes[bitPlaneIndex][y][x];
                                pixel += bit << bitPlaneIndex;
                            }
                            line.push(pixel);
                        }
                        img.pixels.push(line);
                    }
                    //console.log("to pixels", performance.now() - now);

                    break;
                default:
                    console.warn(`unhandled IFF chunk: ${chunk.name}`);
                    break;
            }

            index += chunk.size + 8;
            if (chunk.size % 2 === 1) index++;
        }

        return img;
    };

    me.detect = function (file) {
        const id = file.readString(4, 0);
        if (id === "FORM") {
            const size = file.readDWord();
            if (size + 8 <= file.length) {
                // the size check isn't always exact for images?
                const format = file.readString(4);
                if (format === "ILBM") {
                    return FILETYPE.ILBM;
                }
                if (format === "PBM ") {
                    return FILETYPE.PBM;
                }
                if (format === "ANIM") {
                    return FILETYPE.ANIM;
                }
                return FILETYPE.IFF;
            }
        }
    };

    me.inspect = function (file) {
        let result = "";
        const info = me.parse(file, false);
        if (info.width && info.height) result = `${info.width}x${info.height}`;
        if (info.ham) {
            result += ` HAM${info.numPlanes < 7 ? "6" : "8"}`;
        }
        if (info.trueColor) {
            result += " 24-bit";
        } else if (info.colors) {
            result += ` ${info.colors} colours`;
        } else if (info.palette) {
            result += `palette with ${info.palette.length} colours`;
        }
        return result;
    };

    me.handle = function (file, action) {
        if (action === "show") {
            const img = me.parse(file, true);
            //if (AdfViewer) AdfViewer.showImage(me.toCanvas(img));
        }
    };

    me.toCanvas = function (img) {
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d");
        let pixelWidth = 1;
        if (img.interlaced && !img.hires) {
            canvas.width *= 2;
            pixelWidth = 2;
        }
        //const ctx = canvas.getContext("2d");
        //let imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

        if (!img.ham && !img.trueColor && img.colourRange && img.colourRange.length > 0){
            // Executive decision right here:
            // we're checking for duplicate colors in the palette that are inside the color range
            // if we find any, we're going to slighty alter them to make them unique
            // this is definitely a hack, but otherwise we have to implement full color index tracking through ALL image operations in ALL layers, which is definitely not worth it

            img.palette.forEach((color, index) => {
                if (img.colourRange.some(range => range.low <= index && index <= range.high)) {
                    let colorIndex = img.palette.findIndex((c, i) => i !== index && Color.equals(c, color));
                    let offsetIndex = 0;
                    let direction = [1,1,1];
                    if (color[0] > 128) direction[0] = -1;
                    if (color[1] > 128) direction[1] = -1;
                    if (color[2] > 128) direction[2] = -1;
                    let count = 0;

                    while (colorIndex !== -1 && count < 150) {
                        color[offsetIndex] += direction[offsetIndex];
                        if (color[offsetIndex] < 0) color[offsetIndex] = 0;
                        if (color[offsetIndex] > 255) color[offsetIndex] = 255;
                        offsetIndex = (offsetIndex + 1) % 3;
                        colorIndex = img.palette.findIndex((c, i) => i !== index && Color.equals(c, color));
                        count++;
                    }
                    img.palette[index] = color;
                }
            })
        }

        let imageData = new ImageData(img.width, img.height);
        let count = 0;
        for (let y = 0; y < img.height; y++) {
            let prevColor = [0, 0, 0];
            for (let x = 0; x < img.width; x++) {
                let pixel = img.pixels[y][x];
                let color = img.palette[pixel] || [0, 0, 0];
                if (img.ham) {
                    const modifier = img.hamPixels[y][x];
                    if (modifier) {
                        pixel <<= 8 - img.colorPlanes; // should the remaining (lower) bits also be filled?
                        color = prevColor.slice();
                        if (modifier === 1) color[3] = pixel;
                        if (modifier === 2) color[0] = pixel;
                        if (modifier === 3) color[1] = pixel;
                    }
                }
                if (img.trueColor) {
                    // bits are stored like R0-R7,G0-B7,B0-B7
                    // when reading out we just stack them on top, that's why the BlUE values are in 0xff0000 and the RED values are in 0x0000ff
                    color = [
                        pixel & 0x0000ff,
                        (pixel & 0x00ff00) >> 8,
                        (pixel & 0xff0000) >> 16,
                    ];

                    // NewTek deep ILBM bit ordering:
                    // saved first ------------------------------------------------> saved last
                    // R7 G7 B7 R6 G6 B6 R5 G5 B5 R4 G4 B4 R3 G3 B3 R2 G2 B2 R1 G1 B1 R0 G0 B0

                    // extract bit and shift to the right position

                    /*let bits = intTo24Bit(pixel);

                    let r = (bits[0]<<0) + (bits[3]<<1) + (bits[6]<<2) + (bits[9]<<3) + (bits[12]<<4) + (bits[15]<<5) + (bits[18]<<6) + (bits[21]<<7);
                    let g = (bits[1]<<0) + (bits[4]<<1) + (bits[7]<<2) + (bits[10]<<3) + (bits[13]<<4) + (bits[16]<<5) + (bits[19]<<6) + (bits[22]<<7);
                    let b = (bits[2]<<0) + (bits[5]<<1) + (bits[8]<<2) + (bits[11]<<3) + (bits[14]<<4) + (bits[17]<<5) + (bits[20]<<6) + (bits[23]<<7);

                    //let r = (pixel & (0b000000000000000000000100<<5)) + (pixel & (0b000000000000000000100000<<1)) + (pixel & (0b000000000000000100000000>>3)) + (pixel & (0b000000000000100000000000>>7)) + (pixel & (0b000000000010000000000000>>10))+ (pixel & (0b000000001000000000000000>>13));
                    //let g = (pixel & (0b000000000000000000000010<<6)) + (pixel & (0b000000000000000000010000<<2)) + (pixel & (0b000000000000000010000000>>2)) + (pixel & (0b000000000000010000000000>>6)) + (pixel & (0b000000000001000000000000>>9)) + (pixel & (0b000000000100000000000000>>12));
                    //let b = (pixel & (0b000000000000000000000001<<7)) + (pixel & (0b000000000000000000001000<<3)) + (pixel & (0b000000000000000001000000>>1)) + (pixel & (0b000000000000001000000000>>5)) + (pixel & (0b000000000000100000000000>>8)) + (pixel & (0b000000000010000000000000>>11));

                    color = [r,g,b];

                    count++;
                    if (count<10){
                        console.error(pixel);
                        console.error(bits);
                        console.error([r,g,b]);
                    }*/


                }
                prevColor = color;

                for (let i = 0; i < pixelWidth; i++) {
                    const index = (y * canvas.width + x * pixelWidth + i) * 4;
                    imageData.data[index] = color[0];
                    imageData.data[index + 1] = color[1];
                    imageData.data[index + 2] = color[2];
                    imageData.data[index + 3] = 255;
                }

            }
        }
        ctx.putImageData(imageData, 0, 0);
        return canvas;
    };

    function intTo24Bit(b){
        return [
            b>>23 & 1,
            b>>22 & 1,
            b>>21 & 1,
            b>>20 & 1,
            b>>19 & 1,
            b>>18 & 1,
            b>>17 & 1,
            b>>16 & 1,
            b>>15 & 1,
            b>>14 & 1,
            b>>13 & 1,
            b>>12 & 1,
            b>>11 & 1,
            b>>10 & 1,
            b>>9 & 1,
            b>>8 & 1,
            b>>7 & 1,
            b>>6 & 1,
            b>>5 & 1,
            b>>4 & 1,
            b>>3 & 1,
            b>>2 & 1,
            b>>1 & 1,
            b    & 1
        ]
    }

    // creates an ArrayBuffer with the binary data of the image;
    me.write = function (canvas) {
        let colorCycle = Palette.getColorRanges() || [];
        let lockPalette = colorCycle.length || Palette.isLocked();
        let colors = lockPalette?Palette.get():ImageProcessing.getColors(canvas, 256);

        let bitplaneCount = 1;
        while (1 << bitplaneCount < colors.length) bitplaneCount++;
        while (colors.length < 1 << bitplaneCount) colors.push([0, 0, 0]);

        const w = canvas.width;
        const h = canvas.height;
        const pixels = canvas.getContext("2d").getImageData(0, 0, w, h).data;

        const bytesPerLine = Math.ceil(w / 16) * 2;
        const bodySize = bytesPerLine * bitplaneCount * h;

        let colorCycleSize = 8 + 8; // header + data
        let fileSize = 40 + 8 + 8;
        fileSize += colors.length * 3;
        fileSize += bodySize;
        let colorRangeCount = colorCycle.length;
        if (colorRangeCount){
            // we need at least 4 CRNG chunks to store, otherwise Deluxe Paint will inject default values
            colorRangeCount = Math.max(4,colorRangeCount);
            fileSize += (colorCycleSize * colorRangeCount);
        }
        if (fileSize & 1) fileSize++;

        const file = BinaryStream(new ArrayBuffer(fileSize), true);

        file.goto(0);
        file.writeString("FORM");
        file.writeDWord(fileSize - 8);

        file.writeString("ILBM");

        file.writeString("BMHD");
        file.writeDWord(20);
        file.writeWord(w);
        file.writeWord(h);
        file.writeWord(0);
        file.writeWord(0);
        file.writeUbyte(bitplaneCount);
        file.writeUbyte(0);
        file.writeUbyte(0);
        file.writeUbyte(0);
        file.writeWord(0);
        file.writeUbyte(1);
        file.writeUbyte(1);
        file.writeWord(w);
        file.writeWord(h);

        // palette
        file.writeString("CMAP");
        file.writeDWord(colors.length * 3);
        colors.forEach((color) => {
            file.writeUbyte(color[0]);
            file.writeUbyte(color[1]);
            file.writeUbyte(color[2]);
        });

        // color cycling
        if (colorRangeCount){
            for (let i = 0; i < colorRangeCount; i++){
                let range = colorCycle[i] || {active:0,reverse:0,low:0,high:0,fps:0};

                file.writeString("CRNG");
                file.writeDWord(8);

                file.writeWord(0); // padding

                let rate = Math.floor(range.fps * 16384 / 60);
                let flags = range.active?1:0;
                flags += range.reverse?2:0;

                file.writeWord(rate);
                file.writeWord(flags);
                file.writeUbyte(range.low);
                file.writeUbyte(range.high);
            }
        }

        // body
        file.writeString("BODY");
        file.writeDWord(bodySize);
        const bitplaneLines = [];

        function getIndex(color) {
            let index = colors.findIndex(
                (c) =>
                    c[0] === color[0] && c[1] === color[1] && c[2] === color[2]
            );
            if (index < 0) {
                index = 0;
                console.error("color not found in palette", color);
            }
            return index;
        }

        for (let y = 0; y < h; y++) {
            for (var i = 0; i < bitplaneCount; i++) {
                bitplaneLines[i] = new Uint8Array(bytesPerLine);
            }
            for (let x = 0; x < w; x++) {
                let colorIndex = 0;
                const pixel = (x + y * w) * 4;
                const color = [
                    pixels[pixel],
                    pixels[pixel + 1],
                    pixels[pixel + 2],
                ];

                // should we use an alpha threshold?
                // const a = pixels[pixel + 3];

                colorIndex = getIndex(color);
                for (i = 0; i < bitplaneCount; i++) {
                    if (colorIndex & (1 << i)) {
                        bitplaneLines[i][x >> 3] |= 0x80 >> (x & 7);
                    }
                }
            }
            for (i = 0; i < bitplaneCount; i++) {
                for (let bi = 0; bi < bytesPerLine; bi++) {
                    file.writeUbyte(bitplaneLines[i][bi]);
                }
            }
        }

        return file.buffer;
    };

    me.toBitPlanes = function (canvas) {
        let addExtraPlane = false;

        let colors = Palette.isLocked()?Palette.get():ImageProcessing.getColors(canvas, 256);
        let bitplaneCount = 1;
        while (1 << bitplaneCount < colors.length) bitplaneCount++;
        while (colors.length < 1 << bitplaneCount) colors.push([0, 0, 0]);

        const w = canvas.width;
        const h = canvas.height;
        const pixels = canvas.getContext("2d").getImageData(0, 0, w, h).data;

        const bytesPerLine = Math.ceil(w / 16) * 2;
        const bitPlaneSize = bytesPerLine * h;
        let fileSize = bitPlaneSize * bitplaneCount;

        if (addExtraPlane) {
            fileSize += bitPlaneSize;
        }

        const file = BinaryStream(new ArrayBuffer(fileSize), true);
        file.goto(0);
        const bitplanes = [];

        function getIndex(color) {
            let index = colors.findIndex(
                (c) =>
                    c[0] === color[0] && c[1] === color[1] && c[2] === color[2]
            );
            if (index < 0) {
                index = 0;
                console.error("color not found in palette", color);
            }
            return index;
        }
        for (var i = 0; i < bitplaneCount; i++) {
            bitplanes[i] = new Uint8Array(bitPlaneSize);
        }

        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                let colorIndex = 0;
                const pixel = (x + y * w) * 4;
                const color = [
                    pixels[pixel],
                    pixels[pixel + 1],
                    pixels[pixel + 2],
                ];
                colorIndex = getIndex(color);
                for (i = 0; i < bitplaneCount; i++) {
                    if (colorIndex & (1 << i)) {
                        let index = (y * bytesPerLine) + (x >> 3);
                        bitplanes[i][index] |= 0x80 >> (x & 7);
                    }
                }
            }


        }

        for (i = 0; i < bitplaneCount; i++) {
            for (let bi = 0; bi < bitPlaneSize; bi++) {
                file.writeUbyte(bitplanes[i][bi]);
            }
        }

        if (addExtraPlane){
            for (let bi = 0; bi < bitPlaneSize; bi++) {
                file.writeUbyte(255);
            }
        }

        return {
            width: w,
            height: h,
            palette: colors,
            planes: file.buffer
        }

    }

    me.toBitMask = function (canvas) {
        let bitplaneCount = 1;
        const w = canvas.width;
        const h = canvas.height;
        const pixels = canvas.getContext("2d").getImageData(0, 0, w, h).data;

        const bytesPerLine = Math.ceil(w / 16) * 2;
        const bitPlaneSize = bytesPerLine * h;
        let fileSize = bitPlaneSize * bitplaneCount;

        const file = BinaryStream(new ArrayBuffer(fileSize), true);
        file.goto(0);
        const bitplanes = [new Uint8Array(bitPlaneSize)];

        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                let colorIndex = 0;
                const pixel = (x + y * w) * 4;
                let alpha = pixels[pixel + 3];
                if (alpha > 128) {
                    colorIndex = 1;
                }

                if (colorIndex) {
                    let index = (y * bytesPerLine) + (x >> 3);
                    bitplanes[0][index] |= 0x80 >> (x & 7);
                }
            }
        }

        for (let bi = 0; bi < bitPlaneSize; bi++) {
            file.writeUbyte(bitplanes[0][bi]);
        }

        return {
            planes: file.buffer
        }

    }

    return me;
})();

export default IFF;
