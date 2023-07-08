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

                    frame.pixels = lzwDecode2(lzwData, block.lzwMinCodeSize);
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
        let imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

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




    var lzwDecode2 = function(data,minCodeSize) {
        // this part is taken from https://github.com/shachaf/jsgif/blob/master/gif.js
        // available under MIT license
        // TODO: optimize

        var pos = 0;

        var readCode = function(size) {
            var code = 0;
            for (var i = 0; i < size; i++) {
                if (data[pos >> 3] & (1 << (pos & 7))) {
                    code |= 1 << i;
                }
                pos++;
            }
            return code;
        };

        var output = [];

        var clearCode = 1 << minCodeSize;
        var eoiCode = clearCode + 1;

        var codeSize = minCodeSize + 1;

        var dict = [];

        var clear = function() {
            dict = [];
            codeSize = minCodeSize + 1;
            for (var i = 0; i < clearCode; i++) {
                dict[i] = [i];
            }
            dict[clearCode] = [];
            dict[eoiCode] = null;

        };

        var code;
        var last;

        while (true) {
            last = code;
            code = readCode(codeSize);

            if (code === clearCode) {
                clear();
                continue;
            }
            if (code === eoiCode) break;

            if (code < dict.length) {
                if (last !== clearCode) {
                    dict.push(dict[last].concat(dict[code][0]));
                }
            } else {
                if (code !== dict.length) throw new Error('Invalid LZW code.');
                dict.push(dict[last].concat(dict[last][0]));
            }
            output.push.apply(output, dict[code]);

            if (dict.length === (1 << codeSize) && codeSize < 12) {
                codeSize++;
            }
        }

        return output;
    };


    return me;
})();

export default GIF;