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
import zlib_closure from "../util/zlib.js";
zlib_closure.call(window); // meh ... is there a better way to import closure compiled code? they are designed to hook themselves as global var.

var Icon = function(){
    // Detect and decode Amiga .info icon files
    // icon format info on
    // 		http://krashan.ppa.pl/articles/amigaicons/
    //		http://www.evillabs.net/index.php/Amiga_Icon_Formats
    // all Amiga icons formats are supported except newIcons

    var me = {};

    me.fileTypes={
        ICON: {name: "Icon file", actions:["show"], inspect: true}
    };

    var WB13Palette = [
        [85,170,255],
        [255,255,255],
        [0,0,0],
        [255,136,0]
    ];

    var MUIPalette = [
        [149,149,149],
        [0,0,0],
        [255,255,255],
        [59,103,162],
        [123,123,123],
        [175,175,175],
        [170,144,124],
        [255,169,151]
    ];

    me.parse = function(file,next){
        var icon = {};
        icon.info = {};

        var magicBytes = file.readDWord(0);
        var PNGID = 2303741511;
        if (magicBytes === PNGID){
            //DualPNG
            console.log("DualPNG icon");
            icon.PNGIcon = {
                canvas:[]
            };

            // look for second PNG
            file.goto(8);
            var found = false;
            var imageCount = 1;
            var buffer2;

            // read next chunk size
            var dw = file.readDWord();
            while (!file.isEOF(8)){
                // 4 byte Chunk Type ID and 4 byte CRC is not included
                dw += 8;
                file.jump(dw);

                // read next chunk size or next PNG ID
                dw = file.readDWord();
                if (dw === PNGID){
                    found = true;
                    break;
                }
            }
            if (found){
                imageCount=2;
                buffer2 = file.buffer.slice(file.index-4);
            }

            var done=function(){
                if (next){
                    if (icon.PNGIcon.canvas.length>(imageCount-1)){
                        next(icon);
                    }
                }
            };

            function toCanvas(buffer,index){
                var blob = new Blob( [ buffer], { type: "image/png" } );
                var urlCreator = window.URL || window.webkitURL;
                var imageUrl = urlCreator.createObjectURL( blob );
                var img = new Image();
                img.onload = function(){
                    icon.width = img.width;
                    icon.height = img.height;
                    var canvas = document.createElement("canvas");
                    canvas.width = img.width;
                    canvas.height = img.height;
                    canvas.getContext("2d").drawImage(img,0,0);
                    icon.PNGIcon.canvas[index] = canvas;
                    done();
                };
                img.src = imageUrl;
            }

            toCanvas(file.buffer,0);
            if (imageCount>1) toCanvas(buffer2,1);

        }else{
            //Amiga Icon
            file.goto(2);
            icon.version = file.readWord();
            icon.nextGadget = file.readDWord();
            icon.leftEdge = file.readWord();
            icon.topEdge = file.readWord();
            icon.width = file.readWord();
            icon.height = file.readWord();
            icon.flags = file.readWord();
            icon.activation = file.readWord();
            icon.gadgetType = file.readWord();
            icon.gadgetRender = file.readDWord();
            icon.selectRender = file.readDWord();
            icon.gadgetText = file.readDWord(); //Unused. Usually 0.
            icon.mutualExclude = file.readDWord(); //Unused. Usually 0.
            icon.specialInfo = file.readDWord(); //Unused. Usually 0.
            icon.gadgetID = file.readWord(); //Unused. Usually 0.
            icon.userData = file.readDWord(); // Used for icon revision. 0 for OS 1.x icons. 1 for OS 2.x/3.x icons.
            icon.type = file.readUbyte(); /*
			A type of icon:
				1 – disk or volume.
				2 – drawer (folder).
				3 – tool (executable).
				4 – project (data file).
				5 – trashcan.
				6 – device.
				7 – Kickstart ROM image.
				8 – an appicon (placed on the desktop by application).
		*/
            icon.info.type = getIconType(icon.type);

            icon.padding = file.readUbyte();
            icon.hasDefaultTool = file.readDWord();
            icon.hasToolTypes = file.readDWord();
            icon.currentX = file.readDWord();
            icon.currentY = file.readDWord();
            icon.hasDrawerData = file.readDWord(); // unused
            icon.hasToolWindow = file.readDWord(); // I don't think this is used somewhere?
            icon.stackSize = file.readDWord();

            // total size 78 bytes

            var offset = 78;

            var drawerData = {};
            if (icon.hasDrawerData){
                // skip for now
                offset += 56;
            }
            icon.drawerData = drawerData;


            icon.img = readIconImage(file,offset);

            if (icon.selectRender) icon.img2 = readIconImage(file);

            if (icon.hasDefaultTool) icon.defaultTool = readText(file);

            icon.toolTypes = [];
            let newIconFlags = 0;
            if (icon.hasToolTypes){
                icon.toolTypeCount =  file.readDWord();
                if (icon.toolTypeCount){
                    icon.toolTypeCount = (icon.toolTypeCount/4) - 1; // seriously ... who invents this stuff? ...

                    for (var i = 0; i< icon.toolTypeCount; i++){
                        let toolType = readText(file);
                        if (toolType){
                            let p = toolType.substr(0,4);
                            if ((p === "IM1=") || (p === "IM2=")) newIconFlags++;
                            icon.toolTypes.push(toolType);
                        }
                    }
                }
            }

            if (newIconFlags>2){
                icon.newIcon = decodeNewIcon(icon.toolTypes)
            }


            if (icon.hasToolWindow) icon.hasToolWindow = readText(file);

            if (icon.hasDrawerData && icon.userData){
                // OS2.x+ drawers

                icon.drawerData2 = {};
                icon.drawerData2.flags = file.readDWord();
                icon.drawerData2.ViewModes = file.readWord();
            }


            if (file.index<file.length){
                // we're not at the end of the file
                // check for FORM ICON file

                console.log("checking for IFF structure");

                var id = file.readString(4);
                if (id === "FORM"){

                    console.log("IFF file found");

                    var size = file.readDWord();
                    if ((size + 8) <= file.length){
                        // the size check isn't always exact for images?
                        var format = file.readString(4);

                        icon.colorIcon = readIFFICON(file);
                    }
                }

            }

            next(icon);
        }

        return icon;
    };

    me.detect=function(file){
        var id = file.readWord(0);
        if (id === 0xE310){
            return (typeof FILETYPE !== "undefined") ? FILETYPE.ICON : true;
        }
    };

    me.inspect = function(file){
        var result = "icon";
        var info = me.parse(file);

        return result;
    };

    me.getImage = function(icon,index){
        index = index || 0;
        if (icon.colorIcon) {
            return me.toCanvas(icon.colorIcon, index);
        }else if (icon.newIcon){
            return me.toCanvas(icon.newIcon, index);
        }else if (icon.PNGIcon){
            index = Math.min(index,icon.PNGIcon.canvas.length-1);
            return icon.PNGIcon.canvas[index];
        }else{
            var img = index?icon.img2:icon.img;
            if (img){
                img.palette = icon.userData ? MUIPalette : WB13Palette;
                return(me.toCanvas(img));
            }
        }
    };

    me.getType=function(icon){
        if (icon.colorIcon || icon.newIcon) return "colorIcon";
        if (icon.PNGIcon) return "PNGIcon";
        return "classicIcon";
    }

    me.setPalette = function(icon,stateIndex){
        var img = stateIndex?icon.img2:icon.img;
        if (img){
            img.palette = icon.userData ? MUIPalette : WB13Palette;
        }
    };

    me.handle = function(file,action){
        console.log(action);
        if (action === "show"){
            var icon = me.parse(file);
            var canvas = me.getImage(icon,0);
            if (AdfViewer) AdfViewer.showImage(canvas);
        }
    };

    me.toCanvas = function(img,index){
        var canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        var pixelWidth = 1;
        var ctx = canvas.getContext("2d");

        if (img.states){
            // colorIcon, newIcon or ARGB
            var state = img.states[index || 0];
            if (state){
                for (var y=0;y<img.height;y++){
                    for (var x=0;x<img.width;x++){
                        var pixel = state.pixels[y*img.width + x];
                        if (state.rgba){
                            var color = pixel;
                        }else{
                            color = state.palette[pixel] || [0,0,0,0];
                        }
                        if (color.length < 4) color[3] = 1;
                        if (pixel === 0) color = [0,0,0,0];
                        ctx.fillStyle = "rgba("+ color.join(",") + ")";
                        ctx.fillRect(x*pixelWidth, y, pixelWidth, 1 );
                    }
                }
            }
        }else{
            // WB Icon
            for (var y=0;y<img.height;y++){
                for (var x=0;x<img.width;x++){
                    var pixel = img.pixels[y][x];
                    var color = img.palette[pixel] || [0,0,0,0];
                    if (color.length < 4) color[3] = 1;
                    if (pixel === 0) color = [0,0,0,0];
                    ctx.fillStyle = "rgba("+ color.join(",") + ")";
                    ctx.fillRect(x*pixelWidth, y, pixelWidth, 1 );
                }
            }
        }

        return canvas;
    };

    me.create = function(width,height){
        var icon = {};
        icon.version = 1;
        icon.nextGadget = 0;
        icon.leftEdge = 0;
        icon.topEdge = 0;
        icon.width = width;
        icon.height = height;

        // this is the width and height of the simple icon, NOT of the ColorIcon
        icon.width = 8;
        icon.height = 8;


        icon.flags = 6; // according docs this is usually 5? 6 seems to be more current.
        icon.activation = 3;
        icon.gadgetType = 1;
        icon.gadgetRender = 1;
        icon.selectRender = 1;
        icon.gadgetText = 0;
        icon.mutualExclude = 0;
        icon.specialInfo = 0;
        icon.gadgetID = 0;
        icon.userData = 1; // OS 2.x/3.x icon - use 0 for 1.X icons
        icon.type = 4; // project

        icon.padding = 0;
        icon.hasDefaultTool = 0;
        icon.hasToolTypes = 0;
        icon.currentX = 0;
        icon.currentY = 0;
        icon.hasDrawerData = 0;
        icon.hasToolWindow = 0;
        icon.stackSize = 8192;

        // default Classic Icon
        var classicWidth = 8;
        var classicHeight = 8;

        icon.img = {
            leftEdge: 0,
            topEdge: 0,
            width: classicWidth,
            height: classicHeight,
            depth: 1,
            hasimageData: 1,
            planePick: 1, // ? setting this to 1 sometimes causes the icon to be displayed as a only 1 bitplane ?
            // according to https://wiki.amigaos.net/wiki/Icon_Library this should be 3
            // my guess is that this is the number of colors-1
            planeOnOff: 0,
            nextImage: 0,
            pixels: []
        };

        icon.img2 = Object.assign({},icon.img);
        icon.img2.pixels = [];

        for (var i = 0;i<classicHeight; i++){
            for (var j = 0;j<classicWidth; j++){
                var index = (i*classicWidth)+j;
                var value = 0;
                if (i===0 || j===0 || i===classicHeight-1 || j===classicWidth-1){
                    value = 1;
                }
                icon.img.pixels[index] = value;
                icon.img2.pixels[index] = 1;
            }
        }

        icon.colorIcon = {
            width: width,
            height: height,
            flags:0,// ?
            aspectRatio: 17, //?
            MaxPaletteSize:2,
            states:[
                {
                    transparentIndex: 0,
                    NumColors: 2,
                    flags:3,// ? Bit 1: transparent color exists - Bit 2: Palette Exists
                    imageCompression:0,
                    paletteCompression:0,
                    depth:8, // number of bits to store each pixel
                    imageSize: width*height,
                    paletteSize: 6, // num of colors * 3
                    pixels: [],
                    palette: [[0,0,200],[0,200,0]]
                }
            ]
        };

        for (i = 0;i<height; i++){
            for (var j = 0;j<height; j++){
                icon.colorIcon.states[0].pixels.push(1);
            }
        }

        return icon;
    };

    // creates an ArrayBuffer with the binary data of the Icon;
    me.write = function(icon){
        var fileSize = 2 + 76;

        var bitPlanes = icon.img.depth;

        var bitWidth = Math.ceil(icon.img.width/16) * 16;
        var bitSize = (icon.img.height * bitWidth) * bitPlanes;
        fileSize += 20 + (bitSize/8);

        bitWidth = Math.ceil(icon.img2.width/16) * 16;
        bitPlanes = icon.img2.depth;
        bitSize = (icon.img2.height * bitWidth) * bitPlanes;
        fileSize += 20 + (bitSize/8);

        //icon.colorIcon = 0;

        if (icon.colorIcon){
            generateColorIconData(icon.colorIcon);
            fileSize += icon.colorIcon.byteSize + 8; // 8 = "FORM" + Size Dword;
        }

        if (typeof module !== 'undefined' && module.exports){
            //var BinaryStream  = require('./file.js');
        }

        var file = BinaryStream(new ArrayBuffer(fileSize),true);
        console.log("File is " + fileSize + " bytes");

        icon.currentX = 128 << 24; // not sure but this seems to position the icon automatically in the window?
        icon.currentY = 128 << 24;

        file.writeUbyte(227);
        file.writeUbyte(16);
        file.writeWord(icon.version);
        file.writeDWord(icon.nextGadget);
        file.writeWord(icon.leftEdge);
        file.writeWord(icon.topEdge);
        file.writeWord(icon.width);
        file.writeWord(icon.height);
        file.writeWord(icon.flags);
        file.writeWord(icon.activation);
        file.writeWord(icon.gadgetType);
        file.writeDWord(icon.gadgetRender);
        file.writeDWord(icon.selectRender);
        file.writeDWord(icon.gadgetText);
        file.writeDWord(icon.mutualExclude);
        file.writeDWord(icon.specialInfo);
        file.writeWord(icon.gadgetID);
        file.writeDWord(icon.userData);
        file.writeUbyte(icon.type);
        file.writeUbyte(icon.padding);
        file.writeDWord(icon.hasDefaultTool);
        file.writeDWord(icon.hasToolTypes);

        file.writeDWord(icon.currentX);
        file.writeDWord(icon.currentY);
        file.writeDWord(icon.hasDrawerData);
        file.writeDWord(icon.hasToolWindow);
        file.writeDWord(icon.stackSize);

        // 78

        // write first image
        writeImage(icon.img,1);
        writeImage(icon.img2,2);

        function writeImage(img,index){
            file.writeWord(img.leftEdge);
            file.writeWord(img.topEdge);
            file.writeWord(img.width);
            file.writeWord(img.height);
            file.writeWord(img.depth);
            file.writeDWord(img.hasimageData);
            file.writeUbyte(img.planePick);
            file.writeUbyte(img.planeOnOff);
            file.writeDWord(img.nextImage);

            for (var bitPlane = 0; bitPlane< bitPlanes; bitPlane++){
                var pixelIndex = 0;
                for (var i = 0, max = img.height; i<max; i++){
                    var bits = [];
                    var bitWidth = Math.ceil(img.width/16) * 16;

                    //for (var j = 0, maxj = bitWidth; j<maxj; j++){
                    for (var j = 0, maxj =  img.width; j<maxj; j++){
                        var colorIndex = img.pixels[pixelIndex] || 0;
                        var pixel = 0;
                        if (bitPlane === 0) pixel = colorIndex%2 === 1;
                        if (bitPlane === 1) pixel = (colorIndex === 2) || (colorIndex === 3) || (colorIndex === 6) || (colorIndex === 7);
                        if (bitPlane === 2) pixel = (colorIndex === 4) || (colorIndex === 5) || (colorIndex === 6) || (colorIndex === 7);
                        bits.push(pixel?1:0);
                        pixelIndex++;
                    }

                    for (j = 0, maxj =  bitWidth - img.width; j<maxj; j++){
                        bits.push(0);
                    }

                    file.writeBits(bits);

                }
            }
        }


        if (icon.colorIcon){

            var writeIconState = function(state){

                //console.log(state);
                file.writeString("IMAG");

                // aparently this should be even?
                file.writeDWord(state.size);

                file.writeUbyte(state.transparentIndex);
                file.writeUbyte(state.NumColors-1);
                file.writeUbyte(state.flags);
                file.writeUbyte(state.imageCompression);
                file.writeUbyte(state.paletteCompression);
                file.writeUbyte(state.depth);
                file.writeWord(state.imageSize-1);
                file.writeWord(state.paletteSize-1);

                // then all pixels as UByte
                for (var i = 0; i<state.imageSize; i++){
                    file.writeUbyte(state.pixels[i]);
                }

                // then the palette
                if (state.palette){
                    for (i = 0; i<state.paletteSize/3; i++){
                        //console.log(i);
                        //console.log(state.palette[i]);
                        file.writeUbyte(state.palette[i][0]);
                        file.writeUbyte(state.palette[i][1]);
                        file.writeUbyte(state.palette[i][2]);
                    }
                }

                // padding byte if needed
                if (state.hasPaddingByte){
                    file.writeByte(0);
                }

            };

            file.writeString("FORM");
            file.writeDWord(icon.colorIcon.byteSize);
            file.writeString("ICON");
            file.writeString("FACE");
            file.writeDWord(6);
            file.writeUbyte(icon.colorIcon.width-1);
            file.writeUbyte(icon.colorIcon.height-1);
            file.writeUbyte(icon.colorIcon.flags);
            file.writeUbyte(icon.colorIcon.aspectRatio);
            file.writeWord(icon.colorIcon.MaxPaletteSize-1);

            writeIconState(icon.colorIcon.states[0]);
            if (icon.colorIcon.states[1]) writeIconState(icon.colorIcon.states[1]);
        }else{
            console.log("skipping Coloricon");
        }


        return file.buffer;
    };

    function generateColorIconData(colorIcon){
        var size = 18; // main header
        if (colorIcon.states[0]){
            colorIcon.states[0].size = (10 + colorIcon.states[0].imageSize +  colorIcon.states[0].paletteSize);

            // apparently this should be even?
            if (colorIcon.states[0].size%2 === 1){
                colorIcon.states[0].size++;
                colorIcon.states[0].hasPaddingByte = true;
            }else{
                colorIcon.states[0].hasPaddingByte = false;
            }

            size += colorIcon.states[0].size + 8; // 8 = "IMAG" + size Dword
        }

        if (colorIcon.states[1]){
            colorIcon.states[1].size = (10 + colorIcon.states[1].imageSize);
            if (colorIcon.states[1].palette){
                colorIcon.states[1].size += colorIcon.states[1].paletteSize;
            }

            if (colorIcon.states[1].size%2 === 1){
                colorIcon.states[1].size++;
                colorIcon.states[1].hasPaddingByte = true;
            }else{
                colorIcon.states[1].hasPaddingByte = false;
            }
            size += colorIcon.states[1].size + 8; // 8 = "IMAG" + size Dword
        }

        colorIcon.byteSize = size;

        console.log("state size = " + size);
    }

    function readIconImage(file,offset){
        if (offset) file.goto(offset);
        var img = {};
        img.leftEdge = file.readWord();
        img.topEdge = file.readWord();
        img.width = file.readWord();
        img.height = file.readWord();
        img.depth = file.readWord();
        img.hasimageData = file.readDWord();
        img.planePick = file.readUbyte(); // not used
        img.planeOnOff = file.readUbyte(); // not used
        img.nextImage = file.readDWord(); // not used

        //img.depth = 1;



        if (img.hasimageData){
            var lineWidth = ((img.width + 15) >> 4) << 1; // in bytes
            var pixels = [];

            if (img.depth<9){
                for (var plane=0;plane<img.depth;plane++){
                    for (var y = 0; y<img.height; y++){
                        pixels[y] = pixels[y] || [];

                        var line = [];
                        for (var x = 0; x<lineWidth; x++) line.push(file.readUbyte());

                        // add bitplane line to pixel values;
                        for (var b = 0; b<lineWidth; b++){
                            var val = line[b];
                            for (var i = 7; i >= 0; i--) {
                                x = (b*8) + (7-i);
                                var bit = val & (1 << i) ? 1 : 0;
                                var p = pixels[y][x] || 0;
                                pixels[y][x] = p + (bit<<plane);
                            }
                        }
                    }

                }
            }else{
                img.invalid = true;
                console.error("Error: This doesn't seem to be a valid icon file")
            }

            img.pixels = pixels;
        }

        return img;
    }

    function readText(file,offset){
        if (offset) file.goto(offset);
        var length = file.readDWord();
        var s = file.readString(length-1);
        file.readUbyte(); // zero byte;
        return s;
    }

    function decodeNewIcon(toolTypes){
        let newIcon = {
            states:[
                {pixels:[], palette:[]},
                {pixels:[], palette:[]}
            ]
        };

        let decodeData = [
            {firstLine:false,paletteBits:"",imageBits:""},
            {firstLine:false,paletteBits:"",imageBits:""}
        ]

        let decodeBits=(data)=>{
            let bits = "";
            for (let i = 0;i<data.length;i++){
                let byte = data.charCodeAt(i);
                let _bits;
                if (byte<160){
                    _bits = (byte-32).toString(2);
                }else if (byte<209){
                    _bits = (byte-81).toString(2);
                }else{
                    // RLE - just used for filling with 0
                    _bits="";
                    for (let j=0;j<byte-208;j++)_bits+="0000000";
                }
                if (_bits){
                    while(_bits.length<7){_bits = "0" + _bits}
                    bits += _bits;
                }
            }
            return bits;
        }

        toolTypes.forEach(toolType=>{
            if (toolType.indexOf("IM1=")===0 || toolType.indexOf("IM2=")===0){
                let data = toolType.substr(4);
                let imageIndex = toolType.indexOf("IM1=")===0 ? 0 : 1;
                let decoded = decodeData[imageIndex];
                let state = newIcon.states[imageIndex];
                if (!decoded.firstLine){
                    decoded.firstLine=true;
                    newIcon.transparency = data.charCodeAt(0) === 66 // B
                    newIcon.width = data.charCodeAt(1)-33;
                    newIcon.height = data.charCodeAt(2)-33;
                    state.colorCount = (data.charCodeAt(3)-33 << 6) + data.charCodeAt(4)-33;

                    state.bitCount = 1;
                    while ((1 << state.bitCount) < state.colorCount){state.bitCount++}

                    data = data.substr(5);
                    decoded.paletteBits = decodeBits(data);
                    let bitCount=8;
                    let max = Math.floor((decoded.paletteBits.length/bitCount) / 3) ;
                    for (let i=0;i<max;i++){
                        let index = i*bitCount*3;
                        let r = parseInt(decoded.paletteBits.substr(index,bitCount),2);
                        let g = parseInt(decoded.paletteBits.substr(index + bitCount,bitCount),2);
                        let b = parseInt(decoded.paletteBits.substr(index + bitCount*2,bitCount),2);
                        newIcon.states[imageIndex].palette.push([r,g,b]);
                    }
                }else{
                    // note: it's probably more efficient to put the pixel color in place directly, but yeah ... TODO for later
                    let bits = decodeBits(data);

                    let max = Math.floor(bits.length/state.bitCount);
                    for (let i=0;i<max;i++){
                        let nr = parseInt(bits.substr(i*state.bitCount,state.bitCount),2);
                        state.pixels.push(nr);
                    }
                }
            }
        })

        return newIcon;
    }

    function readIFFICON(file){

        var index = file.index;
        var img = {states:[]};

        function readChunk(){
            var chunk = {};
            chunk.name = file.readString(4);
            chunk.size = file.readDWord();
            return chunk;
        }

        while (index<file.length-4){
            file.goto(index);
            var chunk = readChunk();
            index += chunk.size + 8;
            if (chunk.size%2 === 1) index++;

            switch (chunk.name){
                case "FACE":
                    img.width = file.readUbyte() + 1;
                    img.height = file.readUbyte() + 1;
                    img.flags = file.readUbyte();
                    img.aspectRatio = file.readUbyte(); //upper 4 bits:x aspect, lower 4 bits: y aspect
                    img.MaxPaletteSize = file.readWord();
                    console.log("Icon is " + img.width + "x" + img.height);
                    break;
                case "IMAG":
                    var endIndex = file.index + chunk.size;

                    var state = {};
                    state.transparentIndex = file.readUbyte();
                    state.NumColors = file.readUbyte() + 1;
                    state.flags = file.readUbyte();
                    state.imageCompression = file.readUbyte();
                    state.paletteCompression = file.readUbyte();
                    state.depth = file.readUbyte();
                    state.imageSize = file.readWord() + 1;
                    state.paletteSize = file.readWord() + 1;

                    state.pixels = [];
                    state.palette = [];

                    var imageDataOffset = file.index;
                    var paletteDataOffset = imageDataOffset + state.imageSize;

                    if (state.imageCompression){
                        // note: this is BIT aligned, not byte aligned ...
                        // -> RLE control chars are 8 bits, but the data elements are n bits, determined by state.depth

                        var max = (state.imageSize-1) * 8;
                        var bitIndex = 0;

                        while (bitIndex < max) {
                            var b = file.readBits(8,bitIndex,imageDataOffset);
                            bitIndex += 8;

                            if (b > 128) {
                                var b2 = file.readBits(state.depth,bitIndex,imageDataOffset);
                                bitIndex += state.depth;
                                for (var k = 0; k < 257 - b; k++) state.pixels.push(b2);
                            }
                            if (b < 128) {
                                for (k = 0; k <= b; k++){
                                    state.pixels.push(file.readBits(state.depth,bitIndex,imageDataOffset));
                                    bitIndex += state.depth;
                                }
                            }
                        }
                    }else{
                        // note: uncompressed data is BYTE aligned, even if state.depth < 8
                        for (var i = 0; i < state.imageSize; i++){
                            state.pixels.push(file.readUbyte())
                        }
                    }

                    if (state.paletteSize){
                        file.goto(paletteDataOffset);
                        var rgb = [];

                        var bitsPerColorByte = 8;

                        if (state.paletteCompression){
                            var max = (state.paletteSize-1) * 8;
                            var bitIndex = 0;

                            while (bitIndex < max) {
                                var b = file.readBits(8,bitIndex,paletteDataOffset);
                                bitIndex += 8;

                                if (b > 128) {
                                    var b2 = file.readBits(bitsPerColorByte,bitIndex,paletteDataOffset);
                                    bitIndex += bitsPerColorByte;
                                    for (var k = 0; k < 257 - b; k++) rgb.push(b2);
                                }
                                if (b < 128) {
                                    for (k = 0; k <= b; k++){
                                        rgb.push(file.readBits(bitsPerColorByte,bitIndex,paletteDataOffset));
                                        bitIndex += bitsPerColorByte;
                                    }
                                }
                            }
                        }else{
                            for (i = 0; i < state.paletteSize; i++){
                                rgb.push(file.readUbyte())
                            }
                        }

                        if (rgb.length>2){
                            for (i = 0, max = rgb.length; i<max; i+=3){
                                state.palette.push([rgb[i],rgb[i+1],rgb[i+2]])
                            }
                        }
                    }
                    if (state.palette.length === 0 && state.flags<3){
                        // no palette, using the palette from the previous state if present;
                        if (img.states.length>0){
                            state.palette = img.states[img.states.length-1].palette;
                        }
                    }

                    img.states.push(state);


                    break;
                case "ARGB":
                    // zlib compressed
                    // found some info/structure on https://amigaworld.net//modules/newbb/viewtopic.php?viewmode=flat&order=0&topic_id=34625&forum=15&post_id=639101#639062

                    console.log("decoding ARGB data");

                    var state = {};

                    state.rgba = true;
                    state.pixels = [];
                    state.palette = [];


                    for (var offset = 0; offset<10;offset++){
                        // no idea what this data structure is ...
                        // first DWORD always seem to be 1?
                        state.dummy = file.readUbyte();
                        //console.log(state.dummy);
                    }

                    var size = chunk.size-offset;
                    var data = new Uint8Array(size);
                    for (var i = 0; i<size; i++){
                        data[i] = file.readUbyte();
                    }

                    try{
                        var a;
                        if (typeof Zlib !== "undefined"){
                            // running in browser
                            a = new Zlib.Inflate(data).decompress();
                        }else{
                            // running in node
                            var zlib = require('zlib');
                            a = zlib.inflateSync(data);
                        }

                        for (var y = 0; y<img.height; y++){
                            for (var x = 0; x<img.width; x++){
                                var pixelIndex = (y*img.width + x) * 4;
                                var color = [a[pixelIndex+1]||0,a[pixelIndex+2]||0,a[pixelIndex+3]||0,(a[pixelIndex]||0)/255];
                                state.pixels.push(color);
                            }
                        }

                        img.states.push(state);


                    }catch (e) {
                        console.log("invalid zlib structure");
                    }

                    break;
                default:
                    console.log("unhandled IFF chunk: " + chunk.name);
                    break;
            }
        }

        return img;
    }

    function getIconType(type){
        var iconTypes = {
            1: "disk",
            2: "drawer",
            3: "tool (executable)",
            4: "project (data file)",
            5: "trashcan",
            6: "device",
            7: "Kickstart ROM image",
            8: "Appicon (placed on the desktop by application)"
        };
        return iconTypes[type] ||"unknown";
    }

    me.MUIPalette = MUIPalette;

    if (typeof FileType !== "undefined") FileType.register(me);


    return me;


}();

if (typeof module !== 'undefined' && typeof module.exports !== 'undefined'){
    //module.exports = Icon;
}

export default Icon;