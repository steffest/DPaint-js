import BinaryStream from "../util/binarystream.js";
import Palette from "../ui/palette.js";
import lzw from "../util/lzw.js";
import ImageFile from "../image.js";

const GIF = (()=>{
    const me = {};

    me.detect = function (file) {
        const id = file.readString(3, 0);
        if (id === "GIF") {
            let version = file.readString(3);
            return version === "87a" || version === "89a";
        }
        return false;
    };

    me.parse = function (file) {
        let img = {};
        file.goto(3);
        img.version = file.readString(3);

        //Logical Screen Descriptor
        img.width = file.readShort();
        img.height = file.readShort();
        let packed = file.readUbyte();
        img.gctFlag = (packed & 0b10000000) !== 0;
        img.colorResolution = (packed & 0b01110000) >> 4;
        img.sortFlag = (packed & 0b00001000) !== 0;
        img.gctSize = packed & 0b00000111;
        img.colorCount = 1 << (img.gctSize + 1);
        img.bgColorIndex = file.readUbyte();
        img.pixelAspectRatio = file.readUbyte();
        if (img.gctFlag) {
            img.palette = [];
            for (let i = 0; i < img.colorCount; i++) {
                let r = file.readUbyte();
                let g = file.readUbyte();
                let b = file.readUbyte();
                img.palette.push([r, g, b]);
            }
        }

        function parseBlock(){
            let block = {};
            block.id = file.readUbyte();
            switch (block.id) {
                case 0x21:
                    //Extension
                    block.label = file.readUbyte();
                    switch (block.label) {
                        case 0xF9:
                            //Graphics Control Extension
                            console.log("Graphics Control Extension Found");
                            block.size = file.readUbyte();
                            let packed = file.readUbyte();
                            img.disposalMethod = (packed & 0b00011100) >> 2;
                            //disposalMethod: 0: unspecified, 1: do not dispose, 2: restore to background, 3: restore to previous
                            img.userInputFlag = (packed & 0b00000010) !== 0;
                            img.transparentColorFlag = (packed & 0b00000001) !== 0;
                            img.delayTime = file.readShort();
                            img.transparentColorIndex = file.readUbyte();
                            file.readUbyte(); //block terminator
                            break;
                        case 0xFF:
                            //Application Extension
                            console.log("Application Extension Found");
                            block.size = file.readUbyte();
                            block.app = file.readString(11);
                            let subBlockSize = file.readUbyte();
                            if (block.app === "NETSCAPE2.0") {
                                file.jump(1);
                                img.loopCount = file.readShort();
                                file.readUbyte(); //block terminator
                            } else {
                                file.jump(subBlockSize);
                                file.readUbyte(); //block terminator
                            }
                            break;
                        case 0xFE:
                        case 0x01:
                            //0xFE: Comment Extension
                            //0x01: Plain Text Extension
                            // ignore for now
                            console.error("Comment Extension");
                            file.jump(1);
                            let size = file.readUbyte();
                            file.jump(size);
                            file.readUbyte(); //block terminator
                            break;
                        default:
                            console.error("Unknown GIF block label: " + block.label);
                    }
                    break;
                case 0x2C:
                    //Image Descriptor
                    console.log("Image Descriptor Found");
                    img.frames = img.frames || [];
                    let frame = {};
                    frame.left = file.readShort();
                    frame.top = file.readShort();
                    frame.width = file.readShort();
                    frame.height = file.readShort();
                    let packed = file.readUbyte();

                    block.lctFlag = (packed & 0b10000000) !== 0;
                    block.interlaceFlag = (packed & 0b01000000) !== 0;
                    block.sortFlag = (packed & 0b00100000) !== 0;
                    block.reserved = (packed & 0b00011000) >> 3;
                    block.lctSize = packed & 0b00000111;
                    block.colorCount = 1 << (block.lctSize + 1);

                    if (block.lctFlag) {
                        frame.palette = [];
                        for (let i = 0; i < block.colorCount; i++) {
                            let r = file.readUbyte();
                            let g = file.readUbyte();
                            let b = file.readUbyte();
                            frame.palette.push([r, g, b]);
                        }
                    }

                    block.lzwMinCodeSize = file.readUbyte();

                    let lzwData = [];
                    let size;
                    do {
                        size = file.readUbyte();
                        for (let i = 0; i < size; i++) lzwData.push(file.readUbyte());
                    } while (size > 0);

                    frame.pixels =  lzwDecode(lzwData, block.lzwMinCodeSize, frame.width*frame.height);
                    if (!frame.palette) frame.palette = img.palette;
                    if (img.transparentColorFlag){
                        frame.transparentColorIndex = img.transparentColorIndex;
                    }
                    img.frames.push(frame);

                    break;
                case 0x3B:
                    //Trailer
                    console.log("EOF Found");
                    break;
                default:
                    console.error("Unknown GIF block: ", block);
            }
            return block;
        }

        let block = parseBlock();
        while (block.id !== 0x3B) {
            block = parseBlock();
        }


        return img;
    }

    me.toCanvas = function (img) {
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d");
        let imageData =  new ImageData(img.width, img.height);

        img.pixels.forEach((pixel,index)=>{
            let color = img.palette[pixel] || [0,0,0];
            imageData.data[index*4] = color[0];
            imageData.data[index*4+1] = color[1];
            imageData.data[index*4+2] = color[2];
            imageData.data[index*4+3] = img.transparentColorIndex === pixel ? 0 : 255;
        });
        ctx.putImageData(imageData, 0, 0);
        return canvas;
    }

    me.toFrames = function (file) {
        let data = me.parse(file);
        let img;
        // gifs should have at least one frame
        if (data && data.frames && data.frames.length) {
            img = [];
            data.frames.forEach((frame,index) => {
                let frameCanvas = GIF.toCanvas(frame);

                let canvas = document.createElement("canvas");
                canvas.width = data.width;
                canvas.height = data.height;
                let ctx = canvas.getContext("2d");
                ctx.fillStyle = frame.palette[data.bgColorIndex || 0];
                if (data.disposalMethod === 0 || data.disposalMethod === 1){
                    if (index>0) ctx.drawImage(img[index-1], 0, 0);
                }
                if (data.disposalMethod === 2){
                    // restore to background color
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                }
                if (data.disposalMethod === 3){
                    if (index>0) ctx.drawImage(img[0], 0, 0);
                }

                ctx.drawImage(frameCanvas, frame.left || 0, frame.top || 0);
                img.push(canvas);
            });
        }
        if (img){
            return {
                image: img,
                type: "GIF",
                data: data,
            }
        }
    }


    function encode64(input) {
        var output = "", i = 0, l = input.length,
            key = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=",
            chr1, chr2, chr3, enc1, enc2, enc3, enc4;
        while (i < l) {
            chr1 = input.charCodeAt(i++);
            chr2 = input.charCodeAt(i++);
            chr3 = input.charCodeAt(i++);
            enc1 = chr1 >> 2;
            enc2 = ((chr1 & 3) << 4) | (chr2 >> 4);
            enc3 = ((chr2 & 15) << 2) | (chr3 >> 6);
            enc4 = chr3 & 63;
            if (isNaN(chr2)) enc3 = enc4 = 64;
            else if (isNaN(chr3)) enc4 = 64;
            output = output + key.charAt(enc1) + key.charAt(enc2) + key.charAt(enc3) + key.charAt(enc4);
        }
        return output;
    }

    me.write = function(canvas) {
        // write GIF file
        // https://www.w3.org/Graphics/GIF/spec-gif89a.txt

        ImageFile.generateIndexedPixels(true);
        let pixels = ImageFile.getCurrentFile().indexedPixels;
        let palette = Palette.get();


        let headerSize = 13 + palette.length*3;
        let gceSize = 8;
        let imageDescriptorSize = 10;

        var myencoder = new lzw(canvas.width, canvas.height, pixels, 8);
        let out = [];
        myencoder.encode(out);

        let totalSize = headerSize + gceSize + imageDescriptorSize + out.length + 1;
        let file = new BinaryStream(new ArrayBuffer(totalSize),false);


        //Header
        file.writeString("GIF89a");


        // Logical Screen Descriptor
        file.writeWord(canvas.width);
        file.writeWord(canvas.height);
        let gctSize = 7

        file.writeUbyte((0x80 | // 1 : global color table flag = 1 (gct used)
            0x70 | // 2-4 : color resolution = 7
            0x00 | // 5 : gct sort flag = 0
            gctSize)); // 6-8 : gct size

        file.writeUbyte(0); //background color index
        file.writeUbyte(0); //pixel aspect ratio

        //Global Color Table
        for (let i = 0; i < palette.length; i++) {
            file.writeUbyte(palette[i][0]);
            file.writeUbyte(palette[i][1]);
            file.writeUbyte(palette[i][2]);
        }
        // padding if we have < 256 colors // TODO: fixme
        var n = (3 * 256) - palette.length*3;
        for (var i = 0; i < n; i++) file.writeUbyte(0);


        ////Graphics Control Extension
        file.writeUbyte(0x21); //extension introducer
        file.writeUbyte(0xF9); //graphic control label
        file.writeUbyte(0x04); //block size


        var transp;
        var disp;
        let transparent = null;
        let dispose = 0;

        if (transparent === null) {
            transp = 0;
            disp = 0; // dispose = no action
        } else {
            transp = 1;
            disp = 2; // force clear if using transparent color
        }
        if (dispose >= 0) {
            disp = dispose & 7; // user override
        }
        disp <<= 2;
        // packed fields
        file.writeUbyte(0 | // 1:3 reserved
            disp | // 4:6 disposal
            0 | // 7 user input - 0 = none
            transp); // 8 transparency flag


        file.writeWord(0); //delay time x 1/100 sec
        file.writeUbyte(0); //transparent color index
        file.writeUbyte(0); //block terminator


        //Image Descriptor
        file.writeUbyte(0x2C); //image separator
        file.writeWord(0); //image left position
        file.writeWord(0); //image top position
        file.writeWord(canvas.width); //image width
        file.writeWord(canvas.height); //image height

        let isFirstFrame = true;
        if (isFirstFrame) {
            // no local color table
            file.writeUbyte(0);
        }else{
            // on second frame, if a local color table exists
            file.writeUbyte(0x80 | // 1 local color table 1=yes
                0 | // 2 interlace - 0=no
                0 | // 3 sorted - 0=no
                0 | // 4-5 reserved
                gctSize); // 6-8 size of color table

            // and write palette
        }

        // image data
        file.writeByteArray(out);
        //out.forEach((byte)=>{
        //    file.writeUbyte(byte);
        //});

        //Trailer
        file.writeUbyte(0x3B);

        return file.buffer;


    }

    function lzwDecode(data, minCodeSize, pixelCount){
        // This function is taken from https://github.com/matt-way/gifuct-js
        // available under MIT license

        const MAX_STACK_SIZE = 4096;
        const nullCode = -1;
        const npix = pixelCount;
        let available, clear, code_mask, code_size, end_of_information, in_code, old_code, code, i, data_size;

        const dstPixels = new Array(pixelCount);
        const prefix = new Array(MAX_STACK_SIZE);
        const suffix = new Array(MAX_STACK_SIZE);
        const pixelStack = new Array(MAX_STACK_SIZE + 1);

        // Initialize GIF data stream decoder.
        data_size = minCodeSize;
        clear = 1 << data_size;
        end_of_information = clear + 1;
        available = clear + 2;
        old_code = nullCode;
        code_size = data_size + 1;
        code_mask = (1 << code_size) - 1;
        for (code = 0; code < clear; code++) {
            prefix[code] = 0;
            suffix[code] = code;
        }

        // Decode GIF pixel stream.
        let datum, bits, count, first, top, pi, bi
        datum = bits = count = first = top = pi = bi = 0;
        for (i = 0; i < npix; ) {
            if (top === 0) {
                if (bits < code_size) {
                    // get the next byte
                    datum += data[bi] << bits;
                    bits += 8;
                    bi++;
                    continue;
                }
                // Get the next code.
                code = datum & code_mask;
                datum >>= code_size;
                bits -= code_size;
                // Interpret the code
                if (code > available || code == end_of_information) break;
                if (code == clear) {
                    // Reset decoder.
                    code_size = data_size + 1;
                    code_mask = (1 << code_size) - 1;
                    available = clear + 2;
                    old_code = nullCode;
                    continue;
                }
                if (old_code == nullCode) {
                    pixelStack[top++] = suffix[code];
                    old_code = code;
                    first = code;
                    continue;
                }
                in_code = code;
                if (code == available) {
                    pixelStack[top++] = first;
                    code = old_code;
                }
                while (code > clear) {
                    pixelStack[top++] = suffix[code];
                    code = prefix[code];
                }

                first = suffix[code] & 0xff;
                pixelStack[top++] = first;

                // add a new string to the table, but only if space is available
                // if not, just continue with current table until a clear code is found
                // (deferred clear code implementation as per GIF spec)
                if (available < MAX_STACK_SIZE) {
                    prefix[available] = old_code;
                    suffix[available] = first;
                    available++;
                    if ((available & code_mask) === 0 && available < MAX_STACK_SIZE) {
                        code_size++;
                        code_mask += available;
                    }
                }
                old_code = in_code;
            }
            // Pop a pixel off the pixel stack.
            top--;
            dstPixels[pi++] = pixelStack[top];
            i++;
        }

        for (i = pi; i < npix; i++) {
            dstPixels[i] = 0; // clear missing pixels
        }

        return dstPixels;
    }

    return me;
})();

export default GIF;