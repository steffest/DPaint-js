import BinaryStream from "../util/binarystream.js";
import Palette from "../ui/palette.js";
import LZW from "../util/lzw.js";
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
                            console.log("Comment Extension found, skipping");
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

                    frame.pixels =  LZW.decode(lzwData, block.lzwMinCodeSize, frame.width*frame.height);
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


    me.write = function(canvas) {
        // write GIF file
        // https://www.w3.org/Graphics/GIF/spec-gif89a.txt

        let frames = [canvas];
        if (Array.isArray(canvas)){
            frames = [];
            canvas.forEach((c,index)=>{
               frames.push(ImageFile.getCanvas(index));
            });
        }

        // TODO: scan for transparent pixels and add transparent to palette
        // TODO: set loop count in UI
        // TODO: set frame delay in UI


        let delayTime = 0;
        if (frames.length > 1) delayTime = 20;

        let encodedFrames = [];
        let palette = Palette.get();

        // add transparent color to palette as color 0;
        //palette.unshift([0,0,0]);

        let colorDepth = 1;
        while (1 << colorDepth < palette.length) colorDepth++;
        let gctSize = colorDepth - 1;
        let colorCount = 1 << colorDepth;

        frames.forEach((frame,index)=>{
            let pixels = ImageFile.generateIndexedPixels(index,true);
            encodedFrames.push(LZW.encode(pixels,frame.width, frame.height, colorDepth));
        });


        let headerSize = 13 + colorCount*3;
        let gceSize = 8;
        let imageDescriptorSize = 10;
        let applicationExtensionSize = 19;


        let totalSize = headerSize + 1 + applicationExtensionSize;
        encodedFrames.forEach((frame)=>{
            totalSize += gceSize + imageDescriptorSize + frame.length;
        });
        console.log("Total GIF size: ", totalSize);
        let file = new BinaryStream(new ArrayBuffer(totalSize),false);

        //Header
        file.writeString("GIF89a");

        // Logical Screen Descriptor
        file.writeWord(frames[0].width);
        file.writeWord(frames[0].height);

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
        let remaining = colorCount - palette.length;
        for (var i = 0; i < remaining*3; i++) file.writeUbyte(0);


        // write application extension to enable loop
        file.writeUbyte(0x21); //extension introducer
        file.writeUbyte(0xFF); //application extension label
        file.writeUbyte(0x0B); //block size
        file.writeString("NETSCAPE2.0");
        file.writeUbyte(0x03); //sub-block size
        file.writeUbyte(0x01); //sub-block id
        file.writeWord(0); //loop count
        file.writeUbyte(0x00); //block terminator


        frames.forEach((frame,index)=>{
            ////Graphics Control Extension
            file.writeUbyte(0x21); //extension introducer
            file.writeUbyte(0xF9); //graphic control label
            file.writeUbyte(0x04); //block size

            var transp;
            var disp;
            let transparent = 0;
            transparent = null;
            let dispose = 0;

            if (transparent === null) {
                transp = 0;
                disp = 0; // dispose = no action
            } else {
                transp = 1;
                disp = 2; // force clear if using transparent color
            }
            // TODO: what was this for, again?
            // disp should remain at 2 when transparency is used, no ?
            //if (dispose >= 0) {
                //disp = dispose & 7; // user override
            //}
            disp <<= 2;

            // packed fields
            let packed = 0 | // 1:3 reserved
                disp | // 4:6 disposal
                0 | // 7 user input - 0 = none
                transp; // 8 transparency flag
            file.writeUbyte(packed);

            file.writeWord(delayTime); //delay time x 1/100 sec
            file.writeUbyte(0); //transparent color index
            file.writeUbyte(0); //block terminator



            //Image Descriptor
            file.writeUbyte(0x2C); //image separator
            file.writeWord(0); //image left position
            file.writeWord(0); //image top position
            file.writeWord(frame.width); //image width
            file.writeWord(frame.height); //image height

            if (index === 0) {
                // no local color table
                file.writeUbyte(0);
            }else{
                // on second frame, if a local color table exists
                /*
                file.writeUbyte(0x80 | // 1 local color table 1=yes
                    0 | // 2 interlace - 0=no
                    0 | // 3 sorted - 0=no
                    0 | // 4-5 reserved
                    gctSize); // 6-8 size of color table

                // and write palette*/

                file.writeUbyte(0);
            }

            file.writeByteArray(encodedFrames[index]);
        })

        //Trailer
        file.writeUbyte(0x3B);

        return file.buffer;

    }

    return me;
})();

export default GIF;