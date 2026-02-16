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
import ImageFile from "../image.js";

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

    me.parse = function (file, decodeBody, fileType,parent,context) {
        let img = {
            palette: [],
        };
        if (context){
            if (context.ham) img.ham = true;
            if (context.ehb) img.ehb = true;
            if (context.numPlanes) img.numPlanes = context.numPlanes;
            if (context.colorPlanes) img.colorPlanes = context.colorPlanes;
        }

        let index = 12;

        function shamWordToRgb(word) {
            // SHAM palette words are typically stored as 0RGB (12-bit), 4 bits per channel.
            // Expand 0..15 to 0..255 via * 17.
            const r = (word >> 8) & 0x0f;
            const g = (word >> 4) & 0x0f;
            const b = word & 0x0f;
            return [r * 17, g * 17, b * 17];
        }

        function finalizeSham() {
            if (!img.shamPalettes || !img.shamPalettes.length) return;
            if (!img.height || img.height <= 0) return;

            const pals = img.shamPalettes;
            const h = img.height;
            const expectedHalf = Math.ceil(h / 2);

            // If the file is interlaced and SHAM provides per-even-line palettes, map y -> floor(y/2).
            // Otherwise, map y directly.
            let useHalfScanlineMap = false;
            if (pals.length === expectedHalf) useHalfScanlineMap = true;
            if (img.interlaced && pals.length < h && pals.length <= expectedHalf) useHalfScanlineMap = true;

            img.shamPaletteByLine = new Array(h);
            for (let y = 0; y < h; y++) {
                let pi = useHalfScanlineMap ? Math.floor(y / 2) : y;
                if (pi < 0) pi = 0;
                if (pi >= pals.length) pi = pals.length - 1;
                img.shamPaletteByLine[y] = pals[pi];
            }
        }

        function readChunk() {
            const chunk = {};
            chunk.name = file.readString(4);
            chunk.size = file.readDWord();
            return chunk;
        }

        while (index <= file.length - 8) {
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
                case "SHAM": {
                    // Sliced HAM (per-scanline palette). Common encoding: version (UWORD), then 16 UWORD colors per palette.
                    // We store the decoded palettes and derive per-line palettes after all chunks are read (order is not guaranteed).
                    if (chunk.size < 2) break;
                    const version = file.readWord();
                    img.shamVersion = version;

                    // Only version 0 is supported; other versions are ignored (best-effort behavior).
                    if (version !== 0) {
                        img.shamUnsupported = true;
                        break;
                    }

                    const remainingBytes = chunk.size - 2;
                    const words = Math.floor(remainingBytes / 2);
                    const paletteCount = Math.floor(words / 16);

                    img.shamPalettes = [];
                    for (let p = 0; p < paletteCount; p++) {
                        const pal = [];
                        for (let i = 0; i < 16; i++) {
                            pal.push(shamWordToRgb(file.readWord()));
                        }
                        img.shamPalettes.push(pal);
                    }
                    break;
                }
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
                                    // TODO: move this to Uint8 instead of int8
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
                    const view = new Uint8Array(buffer);
                    file.readUBytes(chunk.size+8,file.index-8,view);
                    let subFile = new BinaryStream(buffer,true);
                    
                    // pass context from parent
                    let context = {
                        ham: img.ham,
                        ehb: img.ehb,
                        numPlanes: img.numPlanes,
                        colorPlanes: img.colorPlanes
                    }
                    
                    let subImg = me.parse(subFile, true,fileType,img, context);
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
                    
                    // Copy HAM/EHB mode flags
                    if (frame.ham) img.ham = frame.ham;
                    if (frame.ehb) img.ehb = frame.ehb;
                    if (frame.camg !== undefined) img.camg = frame.camg;
                    if (frame.colorPlanes !== undefined) img.colorPlanes = frame.colorPlanes;

                    // TODO: this is slow...
                    frame.planes.forEach(plane=>{
                        let newPlane = [];
                        plane.forEach(line=>newPlane.push(line.slice()));
                        img.planes.push(newPlane);
                    });
                    
                    // Copy HAM pixel data if present
                    if (frame.hamPixels) {
                        img.hamPixels = [];
                        frame.hamPixels.forEach(line => {
                            img.hamPixels.push(line.slice());
                        });
                    }

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
                    
                    // Determine how many bitplanes to use for pixel values
                    // For HAM mode, only use color bitplanes
                    let pixelBitplanes = parent.numPlanes;
                    if (img.ham && img.colorPlanes !== undefined) {
                        pixelBitplanes = img.colorPlanes;
                    }
                    
                    for (let y = 0; y < img.height; y++) {
                        let line = [];
                        for (let x = 0; x < img.width; x++) {
                            let pixel = 0;
                            for (let bitPlaneIndex = 0; bitPlaneIndex < pixelBitplanes; bitPlaneIndex++) {
                                let bit = img.planes[bitPlaneIndex][y][x];
                                pixel += bit << bitPlaneIndex;
                            }
                            line.push(pixel);
                        }
                        img.pixels.push(line);
                    }
                    
                    // Rebuild HAM pixels from modifier bitplanes if in HAM mode
                    if (img.ham && img.colorPlanes !== undefined) {
                        img.hamPixels = [];
                        for (let y = 0; y < img.height; y++) {
                            let line = [];
                            for (let x = 0; x < img.width; x++) {
                                let hamPixel = 0;
                                // Build HAM pixel from modifier bitplanes (colorPlanes and above)
                                for (let bitPlaneIndex = img.colorPlanes; bitPlaneIndex < parent.numPlanes; bitPlaneIndex++) {
                                    let bit = img.planes[bitPlaneIndex][y][x];
                                    hamPixel += bit << (bitPlaneIndex - img.colorPlanes);
                                }
                                line.push(hamPixel);
                            }
                            img.hamPixels.push(line);
                        }
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

        finalizeSham();
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
        if (info.shamPaletteByLine && info.shamPaletteByLine.length) {
            result += " SHAM";
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
        //if (img && img.shamPaletteByLine && img.shamPaletteByLine.length && !img._shamAlerted) {
        //    img._shamAlerted = true;
        //    if (typeof alert === "function") {
        //        alert("SHAM detected");
        //    }
        //}

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
            const shamPalette = (img.shamPaletteByLine && img.shamPaletteByLine[y]) ? img.shamPaletteByLine[y] : null;
            let prevColor = [0, 0, 0];
            for (let x = 0; x < img.width; x++) {
                let pixel = img.pixels[y][x];
                // In SHAM, the base palette changes per scanline; fall back to global CMAP.
                let color = (shamPalette && shamPalette[pixel]) || img.palette[pixel] || [0, 0, 0];
                if (img.ham) {
                    const modifier = img.hamPixels[y][x];
                    if (modifier) {
                        pixel <<= 8 - img.colorPlanes; // should the remaining (lower) bits also be filled?
                        //pixel *= 17;
                        color = prevColor.slice();
                        if (modifier === 1) color[2] = pixel;
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

    me.toBitPlanes = function (canvas,includeTransparent) {
        let addExtraPlane = false;

        let colors = Palette.isLocked()?Palette.get():ImageProcessing.getColors(canvas, 256);

        // TODO: this is for sprite stuff?
        // then it should also be done for colors.length === 2?
        if (colors.length === 3 && includeTransparent){
            colors.unshift([-1,-1,-1]);
        }
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
                if (includeTransparent && pixels[pixel + 3] < 128){
                    colorIndex = 0;
                }else{
                    colorIndex = getIndex(color);
                }
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
            planes: file.buffer,
            bitPlaneSize: bitPlaneSize,
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

    // ByteRun1 (PackBits) compression
    // Used for ILBM BODY compression
    function byterun1Encode(data) {
        const output = [];
        let i = 0;
        
        while (i < data.length) {
            // Look for runs of identical bytes
            let runLength = 1;
            while (i + runLength < data.length && 
                   data[i] === data[i + runLength] && 
                   runLength < 128) {
                runLength++;
            }
            
            // If we have a run of 3 or more, encode it as a run
            if (runLength >= 3) {
                output.push(257 - runLength); // Run marker (negative count)
                output.push(data[i]);
                i += runLength;
            } else {
                // Find literal sequence (no runs)
                let literalStart = i;
                let literalLength = 0;
                
                while (i < data.length && literalLength < 128) {
                    // Check if we're starting a run of 3+ identical bytes
                    let nextRunLength = 1;
                    while (i + nextRunLength < data.length && 
                           data[i] === data[i + nextRunLength] && 
                           nextRunLength < 3) {
                        nextRunLength++;
                    }
                    
                    if (nextRunLength >= 3) {
                        // Found a run, stop the literal sequence
                        break;
                    }
                    
                    i++;
                    literalLength++;
                }
                
                // Write literal sequence
                if (literalLength > 0) {
                    output.push(literalLength - 1); // Literal count
                    for (let j = 0; j < literalLength; j++) {
                        output.push(data[literalStart + j]);
                    }
                }
            }
        }
        
        return new Uint8Array(output);
    }

    me.writeAnim = function (frames, options) {
        options = options || {};
        const useCompression = options.compression !== false; // Default to compressed

        // Helper: Get bitplanes from canvas
        function getPlanes(contextImageData, w, h, colors, bitplaneCount) {
            const bytesPerLine = Math.ceil(w / 16) * 2;
            const bitPlaneSize = bytesPerLine * h;
            let planes = [];
            for (let i = 0; i < bitplaneCount; i++) planes[i] = new Uint8Array(bitPlaneSize);

            const pixels = contextImageData.data;
            const width = contextImageData.width;

            function getIndex(c, palette) {
                // First try exact match (fast path)
                let index = palette.findIndex((p) => p[0] === c[0] && p[1] === c[1] && p[2] === c[2]);
                if (index >= 0) return index;
                
                // Fall back to nearest color match
                let minDist = Infinity;
                let bestIndex = 0;
                for (let i = 0; i < palette.length; i++) {
                    const p = palette[i];
                    const dr = c[0] - p[0];
                    const dg = c[1] - p[1];
                    const db = c[2] - p[2];
                    const dist = dr * dr + dg * dg + db * db;
                    if (dist < minDist) {
                        minDist = dist;
                        bestIndex = i;
                    }
                }
                return bestIndex;
            }

            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const pixelIndex = (x + y * width) * 4;
                    const c = [pixels[pixelIndex], pixels[pixelIndex + 1], pixels[pixelIndex + 2]];

                    let colorIndex = getIndex(c, colors);

                    for (let i = 0; i < bitplaneCount; i++) {
                        if (colorIndex & (1 << i)) {
                            let byteIndex = y * bytesPerLine + (x >> 3);
                            planes[i][byteIndex] |= 0x80 >> (x & 7);
                        }
                    }
                }
            }
            return planes;
        }

        // note: this is still buggy ... TODO: investigate. - let's avoid using this for now.
        function anim5_col_diff(diffmap, col_data) {
            const MSKIP = 0;
            const MUNIQ = 1;
            const MSAME = 2;
            const MAXRUN = 127;

            let opcount = 0;
            let ops = []; // We will store bytes here
            let row = 0;
            let start_row = row;
            let mode = MSKIP;
            let same_val = 0;

            function vsame(data, start) {
                let count = 1;
                let cdata = data[start];
                let col = start + 1;
                while (col < data.length && data[col] === cdata) {
                    count++;
                    col++;
                }
                return count;
            }

            // Note: col_data is the NEW data (plane1)
            // diffmap is boolean array where True means colDataOld != colDataNew
            
            while (row < col_data.length) {
                if (mode === MSKIP) {
                    if (diffmap[row]) {
                        if (row !== start_row) {
                            // write out skip op
                            ops.push(row - start_row);
                            opcount++;
                        }
                        // what op is next?
                        start_row = row;
                        if (vsame(col_data, row) > 3) {
                            mode = MSAME;
                            same_val = col_data[row];
                        } else {
                            mode = MUNIQ;
                        }
                    } else {
                        if (row - start_row >= MAXRUN) {
                            // write out skip op and continue
                            ops.push(MAXRUN);
                            opcount++;
                            start_row += MAXRUN;
                        }
                    }
                }

                if (mode === MUNIQ) {
                    if (diffmap[row]) {
                        if (vsame(col_data, row) > 3) {
                            // end uniq and write out uniq op
                            ops.push(128 + (row - start_row));
                            for (let k = start_row; k < row; k++) ops.push(col_data[k]);
                            opcount++;
                            // switch to same op
                            start_row = row;
                            mode = MSAME;
                            same_val = col_data[row];
                        } else {
                            if (row - start_row >= MAXRUN) {
                                // write out uniq op and continue
                                ops.push(128 + MAXRUN);
                                for (let k = 0; k < MAXRUN; k++) ops.push(col_data[start_row + k]);
                                opcount++;
                                start_row += MAXRUN;
                            }
                        }
                    } else {
                        // write out uniq op
                        ops.push(128 + (row - start_row));
                        for (let k = start_row; k < row; k++) ops.push(col_data[k]);
                        opcount++;
                        start_row = row;
                        mode = MSKIP;
                    }
                }

                if (mode === MSAME) {
                    if (same_val !== col_data[row]) {
                        // write out same op
                        ops.push(0);
                        ops.push(row - start_row);
                        ops.push(same_val);
                        opcount++;
                        
                        // what op is next?
                        start_row = row;
                        if (diffmap[row]) {
                            mode = MUNIQ;
                        } else {
                            mode = MSKIP;
                        }
                    } else {
                        if (row - start_row >= MAXRUN) {
                            // write out same op and continue
                            ops.push(0);
                            ops.push(MAXRUN);
                            ops.push(same_val);
                            opcount++;
                            start_row += MAXRUN;
                        }
                    }
                }
                row++;
            }

            // write out final op
            if (mode === MUNIQ) {
                // write out uniq op
                ops.push(128 + (row - start_row));
                for (let k = start_row; k < row; k++) ops.push(col_data[k]);
                opcount++;
            } else if (mode === MSAME) {
                // write out same op
                ops.push(0);
                ops.push(row - start_row);
                ops.push(same_val);
                opcount++;
            }



            // Fallback if opcount exceeds safe limit (255 byte limit)
            // This happens on high-detail vertical changes.
            if (opcount >= 256) {
                opcount = 0;
                ops = [];
                let idx = 0;
                while (idx < col_data.length) {
                    let run = Math.min(MAXRUN, col_data.length - idx);
                    // Write UNIQ op
                    ops.push(128 + run); // 128 + cnt
                    for (let k = 0; k < run; k++) ops.push(col_data[idx + k]);
                    idx += run;
                    opcount++;
                }
            }

            return { opcount: opcount, ops: ops };
        }


        function anim5_plane_diff(plane0, plane1, bytesPerLine, height) {
            let pl_diff = [];
            
            // Note:
            // plane0 is OLD frame
            // plane1 is NEW frame
            // diffmap = (plane0 != plane1)
            
            let ncol = bytesPerLine;
            let opcount_sum = 0;
            let col = 0;

            // diff a column at a time
            while (col < ncol) {
                let opcount = 0;
                let ops = [];
                
                // Extract column data
                let colDataOld = new Uint8Array(height);
                let colDataNew = new Uint8Array(height);
                let diffmap = new Uint8Array(height); // Using Uint8 as bool (0/1)
                
                let hasDiff = false;
                for(let y=0; y<height; y++){
                    let idx = y * bytesPerLine + col;
                    colDataOld[y] = plane0[idx];
                    colDataNew[y] = plane1[idx];
                    if (colDataOld[y] !== colDataNew[y]) {
                        diffmap[y] = 1;
                        hasDiff = true;
                    }
                }

                if (!hasDiff) {
                    // no diffs in column
                } else {
                    // SIMPLIFIED: Just write the entire new column as UNIQ ops
                    // see above: coll_diff is buggy.
                    opcount = 0;
                    ops = [];
                    let idx = 0;
                    while (idx < colDataNew.length) {
                        let run = Math.min(127, colDataNew.length - idx);
                        ops.push(128 + run); // UNIQ op
                        for (let k = 0; k < run; k++) ops.push(colDataNew[idx + k]);
                        idx += run;
                        opcount++;
                    }
                }

                pl_diff.push(opcount);
                if (ops.length > 0) {
                     for (let b of ops) pl_diff.push(b);
                }
                
                opcount_sum += opcount;
                col++;
            }

            if (opcount_sum === 0) {
                return null;
            } else {
                return new Uint8Array(pl_diff);
            }
        }

        let colorCycle = Palette.getColorRanges() || [];

        let colors = Palette.get().slice();

        // Ensure we have a valid canvas for dimensions from the first frame
        const canvas = ImageFile.getCanvasWithFilters(0);
        const w = canvas.width;
        const h = canvas.height;


        let bitplaneCount = 1;
        while (1 << bitplaneCount < colors.length) bitplaneCount++;
        if (bitplaneCount > 8) bitplaneCount = 8;        
        while (colors.length < 1 << bitplaneCount) colors.push([0, 0, 0]);

        // For EHB mode (6 bitplanes, 32 base colors), expand to 64 colors with shadows
        let useEHB = (bitplaneCount === 6 && colors.length === 32);
        let quantizePalette = colors.slice();
        if (useEHB) {
            // Add shadow colors (half brightness of each base color)
            for (let i = 0; i < 32; i++) {
                let shadowColor = [
                    Math.floor(colors[i][0] / 2),
                    Math.floor(colors[i][1] / 2),
                    Math.floor(colors[i][2] / 2)
                ];
                quantizePalette.push(shadowColor);
            }
        }


        const bytesPerLine = Math.ceil(w / 16) * 2;
        const bodySize = bytesPerLine * bitplaneCount * h;

        const maxFileSize = 5000 + (frames.length + 5) * (bodySize + 2000 + colors.length * 3);
        const file = BinaryStream(new ArrayBuffer(maxFileSize), true);

        // --- WRITE HEADER ---
        file.goto(0);
        file.writeString("FORM");
        file.writeDWord(0); // Patch later
        file.writeString("ANIM");

        // --- FIRST FRAME (Base) ---
        file.writeString("FORM");
        let firstFrameFormSizePtr = file.index; 
        file.writeDWord(0); // Patch later
        file.writeString("ILBM");

        file.writeString("BMHD");
        file.writeDWord(20);
        file.writeWord(w);
        file.writeWord(h);
        file.writeWord(0);
        file.writeWord(0);
        file.writeUbyte(bitplaneCount);
        file.writeUbyte(0); // masking
        file.writeUbyte(useCompression ? 1 : 0); // compression: 1=byterun1, 0=none
        file.writeUbyte(0);
        file.writeWord(0);
        file.writeUbyte(10);
        file.writeUbyte(11);
        file.writeWord(w);
        file.writeWord(h);

        file.writeString("CMAP");
        file.writeDWord(colors.length * 3);
        colors.forEach((color) => {
            file.writeUbyte(color[0]);
            file.writeUbyte(color[1]);
            file.writeUbyte(color[2]);
        });
        if (file.index % 2 !== 0) file.writeUbyte(0);

        if (colorCycle.length) {
             for (let i = 0; i < colorCycle.length; i++){
                let range = colorCycle[i];
                file.writeString("CRNG");
                file.writeDWord(8);
                file.writeWord(0);
                let rate = Math.floor(range.fps * 16384 / 60);
                let flags = range.active?1:0;
                flags += range.reverse?2:0;
                file.writeWord(rate);
                file.writeWord(flags);
                file.writeUbyte(range.low);
                file.writeUbyte(range.high);
            }
        }
        
        file.writeString("DPAN");
        file.writeDWord(8);
        file.writeWord(3);
        file.writeWord(frames.length);
        file.writeUbyte(60); 
        file.writeUbyte(0);
        file.writeUbyte(0);
        file.writeUbyte(0);

        file.writeString("ANHD");
        file.writeDWord(40); // Size = 40 bytes
        file.writeUbyte(0); // compression 0 for first frame
        file.writeUbyte(0); // mask
        file.writeWord(w);
        file.writeWord(h);
        file.writeWord(0); // x
        file.writeWord(0); // y
        file.writeDWord(1); // abstime = 1 jiffy
        file.writeDWord(1); // reltime = 1 jiffy
        file.writeUbyte(0); // interleave
        file.writeUbyte(128); // pad0 (0x80 seen in real files)
        file.writeDWord(0); // bits
        file.writeDWord(0); // pad8a high
        file.writeDWord(0); // pad8a low
        file.writeDWord(0); // pad8b high
        file.writeDWord(0); // pad8b low

        file.writeString("CAMG");
        file.writeDWord(4);
        file.writeDWord(0x00021000); // LORES | HIRES (standard mode)

        file.writeString("BODY");
        let bodySizePtr = file.index;
        file.writeDWord(0); // Placeholder, will patch later
        
        // ---Pre-calculate all frame planes to avoid double work ---
        let allPlanes = [];
        for (let i=0; i<frames.length; i++) {
             let curCanvas = ImageFile.getCanvas(i);
             // Create a temporary canvas and quantize it to the quantizePalette (with EHB if needed)
             let tempCanvas = document.createElement('canvas');
             tempCanvas.width = w;
             tempCanvas.height = h;
             let tempCtx = tempCanvas.getContext('2d');
             tempCtx.drawImage(curCanvas, 0, 0);
             
             // Apply palette quantization using our expanded palette
             let imageData = tempCtx.getImageData(0, 0, w, h);
             let pixels = imageData.data;
             for (let p = 0; p < pixels.length; p += 4) {
                 if (pixels[p + 3] > 0) {  // Skip transparent pixels
                     let r = pixels[p];
                     let g = pixels[p + 1];
                     let b = pixels[p + 2];
                     
                     // Find nearest color in quantizePalette
                     let minDist = Infinity;
                     let bestColor = quantizePalette[0];
                     for (let c of quantizePalette) {
                         let dr = r - c[0];
                         let dg = g - c[1];
                         let db = b - c[2];
                         let dist = dr * dr + dg * dg + db * db;
                         if (dist < minDist) {
                             minDist = dist;
                             bestColor = c;
                         }
                     }
                     
                     pixels[p] = bestColor[0];
                     pixels[p + 1] = bestColor[1];
                     pixels[p + 2] = bestColor[2];
                 }
             }
             tempCtx.putImageData(imageData, 0, 0);
             
             allPlanes.push(getPlanes(tempCtx.getImageData(0,0,w,h), w, h, quantizePalette, bitplaneCount));
        }

        // Write Frame 0 Body (interleaved by line)
        let basePlanes = allPlanes[0];
        let bodyStartPos = file.index;
        
        // Write bitplanes interleaved one line at a time
        for(let y=0; y<h; y++){
            for(let p=0; p<bitplaneCount; p++){
                // Extract one scanline
                let scanline = new Uint8Array(bytesPerLine);
                for(let x=0; x<bytesPerLine; x++){
                    let idx = y * bytesPerLine + x;
                    scanline[x] = basePlanes[p][idx];
                }
                
                if (useCompression) {
                    // Compress this scanline
                    let compressed = byterun1Encode(scanline);
                    for(let i=0; i<compressed.length; i++) {
                        file.writeUbyte(compressed[i]);
                    }
                } else {
                    // Write uncompressed
                    for(let x=0; x<bytesPerLine; x++){
                        file.writeUbyte(scanline[x]);
                    }
                }
            }
        }
        
        // Patch BODY size
        let bodyEndPos = file.index;
        let actualBodySize = bodyEndPos - bodyStartPos;
        file.goto(bodySizePtr);
        file.writeDWord(actualBodySize);
        file.goto(bodyEndPos);
        
        if (file.index % 2 !== 0) file.writeUbyte(0);
        
        let currentPos = file.index;
        file.goto(firstFrameFormSizePtr);
        file.writeDWord(currentPos - firstFrameFormSizePtr - 4);
        file.goto(currentPos);

        // --- DELTA FRAMES ---
        let anim_abstime = 1; // Start at 1 (first frame delay)
        let previ = 0; // Index of previous frame (starts at F0)

        // This writes deltas for frames 1, 2, ..., N-1, 0, 1 (wrapping for loop)
        
        for (let i = 1; i < frames.length + 2; i++) {
            let curri = i;
            if (i >= frames.length) curri = i - frames.length;
            
            // Get Current Frame
            let currPlanes = allPlanes[curri];
            // Get Previous Frame
            let prevPlanes = allPlanes[previ];
            
            // Delay for current frame (1 jiffy per frame for now)
            let delay = 1; 
            anim_abstime += delay;
            
            file.writeString("FORM");
            let frameFormSizePtr = file.index;
            file.writeDWord(0);
            file.writeString("ILBM");
            
            file.writeString("ANHD");
            file.writeDWord(40); // Size = 40 bytes (BBHHhhLLBBLQQ)
            file.writeUbyte(5); // Byte Vertical Delta
            file.writeUbyte(0); // mask
            file.writeWord(w);
            file.writeWord(h);
            file.writeWord(0); // x
            file.writeWord(0); // y
            file.writeDWord(anim_abstime);
            file.writeDWord(delay); 
            file.writeUbyte(0); // Interleave 0
            file.writeUbyte(128); // pad0 (0x80)
            file.writeDWord(0); // bits (4 bytes)
            file.writeDWord(0); // pad8a (8 bytes - first half)
            file.writeDWord(0); // pad8a (8 bytes - second half)
            file.writeDWord(0); // pad8b (8 bytes - first half)
            file.writeDWord(0); // pad8b (8 bytes - second half)
            
            let pl_diffs = [];
            let dataSize = 0;
            
            for(let p=0; p<bitplaneCount; p++){
                let p0 = prevPlanes && prevPlanes[p] ? prevPlanes[p] : new Uint8Array(bytesPerLine*h);
                let p1 = currPlanes && currPlanes[p] ? currPlanes[p] : new Uint8Array(bytesPerLine*h);
                let diff = anim5_plane_diff(p0, p1, bytesPerLine, h);
                pl_diffs[p] = diff;
                if (diff) dataSize += diff.length;
            }
            
            file.writeString("DLTA");
            file.writeDWord(64 + dataSize);
            
            // Pointers
            let currentDataOffset = 64; 
            for(let p=0; p<bitplaneCount; p++){
                if (pl_diffs[p]) {
                    file.writeDWord(currentDataOffset);
                    currentDataOffset += pl_diffs[p].length;
                } else {
                    file.writeDWord(0);
                }
            }
            // Fill remaining pointers (up to 16)
            for(let p=bitplaneCount; p<16; p++) file.writeDWord(0);
            
            // Data
            for(let p=0; p<bitplaneCount; p++){
                if (pl_diffs[p]) {
                    for(let k=0; k<pl_diffs[p].length; k++) file.writeUbyte(pl_diffs[p][k]);
                }
            }
            
            if (file.index % 2 !== 0) file.writeUbyte(0);

            // Patch Frame Size
            currentPos = file.index;
            // frameFormSizePtr points to the size field (after "FORM")
            // FORM size = everything after the size field
            let formSize = currentPos - frameFormSizePtr - 4;
            file.goto(frameFormSizePtr);
            file.writeDWord(formSize);
            file.goto(currentPos);
            
            // Update Previous Frame Index
            previ = curri;
        }

        // Patch Main FORM Size
        let totalSize = file.index;
        file.goto(4);
        file.writeDWord(totalSize - 8);
        
        return file.buffer.slice(0, totalSize);
    }

    return me;
})();

export default IFF;
