// file format: https://www.adobe.com/devnet-apps/photoshop/fileformatashtml/

import BinaryStream from "../util/binarystream.js";

const FILETYPE = {
    PSD: { name: "Adobe Photoshop Document", actions: ["show"], inspect: true },
};

const BLEND_MODES = {
    norm: "normal",
    pass: "normal",
    dark: "darken",
    mul: "multiply",
    lite: "lighten",
    scrn: "screen",
    over: "overlay",
    diff: "difference",
    smud: "exclusion",
    xclu: "exclusion",
    hue: "hue",
    sat: "saturation",
    colr: "color",
    lum: "luminosity",
    hLit: "hard-light",
    sLit: "soft-light",
    div: "color-dodge",
    dodge: "color-dodge",
    burn: "color-burn",
    idiv: "color-burn",
};

const PSD_BLEND_MODES = {
    normal: "norm",
    darken: "dark",
    multiply: "mul",
    lighten: "lite",
    screen: "scrn",
    overlay: "over",
    difference: "diff",
    exclusion: "smud",
    hue: "hue",
    saturation: "sat",
    color: "colr",
    luminosity: "lum",
    "hard-light": "hLit",
    "soft-light": "sLit",
    "color-dodge": "div",
    "color-burn": "idiv",
};

const PSD = (function(){
    let me = {};

    me.fileTypes = FILETYPE;

    me.detect = function(file){
        file.goto(0);
        if (file.readString(4) !== "8BPS") return false;
        if (file.readWord() !== 1) return false;
        return FILETYPE.PSD;
    };

    me.parse = function(file){
        file.goto(0);
        let data = {
            type: "PSD",
            layers: [],
        };

        if (file.readString(4) !== "8BPS") return false;
        let version = file.readWord();
        if (version !== 1) return false;

        file.jump(6); // reserved

        data.channels = file.readWord();
        data.height = readInt32(file);
        data.width = readInt32(file);
        data.depth = file.readWord();
        data.mode = file.readWord();

        if (data.width <= 0 || data.height <= 0) return false;
        if (data.depth !== 8) return false;
        if (data.mode !== 1 && data.mode !== 3) return false;

        let colorModeLength = file.readDWord();
        file.jump(colorModeLength);

        let imageResourcesLength = file.readDWord();
        file.jump(imageResourcesLength);

        let layerMaskInfoLength = file.readDWord();
        let layerMaskEnd = file.index + layerMaskInfoLength;
        if (layerMaskInfoLength > 0){
            let layerInfoLength = file.readDWord();
            let layerInfoEnd = file.index + layerInfoLength;
            if (layerInfoLength > 0 && layerInfoEnd <= file.length){
                let layerCount = file.readShort();
                let absoluteLayerCount = Math.abs(layerCount);
                let layerRecords = [];

                for (let i = 0; i < absoluteLayerCount; i++){
                    let record = readLayerRecord(file, data.width, data.height);
                    layerRecords.push(record);
                }

                for (let i = 0; i < layerRecords.length; i++){
                    readLayerChannels(file, layerRecords[i], data.mode);
                }

                data.layers = layerRecords.filter((layer) => {
                    if (layer.sectionDivider && layer.sectionDivider !== 0) return false;
                    if (!layer.canvas) return false;
                    return layer.width > 0 && layer.height > 0;
                });

                file.goto(layerInfoEnd);
            }

            file.goto(layerMaskEnd);
        }

        data.image = readCompositeImage(file, data);
        if (!data.image) data.image = renderCompositeFromLayers(data);

        return data;
    };

    me.toCanvas = function(data){
        if (!data) return false;
        if (data.image) return data.image;
        return renderCompositeFromLayers(data);
    };

    me.write = function(frame, width, height, compositeCanvas, options){
        options = options || {};
        let compression = options.compression ? 1 : 0;
        let layerRecords = [];
        let layerChannelData = [];
        let layers = frame && frame.layers ? frame.layers : [];

        for (let i = 0; i < layers.length; i++){
            let encoded = encodeLayer(layers[i], width, height, compression);
            layerRecords.push(encoded.record);
            for (let c = 0; c < encoded.channelBlocks.length; c++){
                layerChannelData.push(encoded.channelBlocks[c]);
            }
        }

        let layerInfo = concatArrays([
            int16ToBytes(layers.length),
            ...layerRecords,
            ...layerChannelData,
        ]);

        let layerMaskInfo = concatArrays([
            uint32ToBytes(layerInfo.length),
            layerInfo,
            uint32ToBytes(0),
        ]);

        let composite = encodeComposite(compositeCanvas, width, height, compression);
        let colorModeData = uint32ToBytes(0);
        let imageResources = uint32ToBytes(0);

        let totalSize = 26 + colorModeData.length + imageResources.length + 4 + layerMaskInfo.length + composite.length;
        let file = BinaryStream(new ArrayBuffer(totalSize), true);

        file.writeString("8BPS");
        file.writeWord(1);
        file.fill(0, 6);
        file.writeWord(4);
        file.writeDWord(height);
        file.writeDWord(width);
        file.writeWord(8);
        file.writeWord(3);

        writeBytes(file, colorModeData);
        writeBytes(file, imageResources);
        file.writeDWord(layerMaskInfo.length);
        writeBytes(file, layerMaskInfo);
        writeBytes(file, composite);

        return file.buffer;
    };

    return me;

    function readLayerRecord(file, docWidth, docHeight){
        let layer = {
            top: readInt32(file),
            left: readInt32(file),
            bottom: readInt32(file),
            right: readInt32(file),
            channels: [],
            opacity: 100,
            visible: true,
            blendMode: "normal",
            name: "Layer",
        };

        layer.height = Math.max(0, layer.bottom - layer.top);
        layer.width = Math.max(0, layer.right - layer.left);

        let channelCount = file.readWord();
        for (let c = 0; c < channelCount; c++){
            layer.channels.push({
                id: file.readShort(),
                length: file.readDWord(),
            });
        }

        file.readString(4); // signature, usually 8BIM
        let blendKey = file.readString(4);
        layer.blendMode = BLEND_MODES[blendKey] || "normal";
        layer.opacity = Math.round(file.readUbyte() / 255 * 100);
        layer.clipping = file.readUbyte();
        let flags = file.readUbyte();
        file.readUbyte(); // filler

        layer.visible = !(flags & 0x02);

        let extraLength = file.readDWord();
        let extraEnd = file.index + extraLength;

        let maskDataLength = file.readDWord();
        file.jump(maskDataLength);

        let blendingRangesLength = file.readDWord();
        file.jump(blendingRangesLength);

        layer.name = readPascalString(file, 4) || layer.name;

        while (file.index < extraEnd){
            let signature = file.readString(4);
            let key = file.readString(4);
            let length = file.readDWord();
            let blockEnd = file.index + length;

            if (signature === "8BIM" || signature === "8B64"){
                if (key === "luni"){
                    layer.name = readUnicodeString(file) || layer.name;
                }else if (key === "lsct"){
                    layer.sectionDivider = readInt32(file);
                }
            }

            file.goto(blockEnd);
            if (length % 2 === 1) file.jump(1);
        }

        file.goto(extraEnd);

        if (layer.left < 0) layer.offsetX = layer.left;
        if (layer.top < 0) layer.offsetY = layer.top;
        layer.docWidth = docWidth;
        layer.docHeight = docHeight;

        return layer;
    }

    function readLayerChannels(file, layer, mode){
        if (!layer.width || !layer.height){
            for (let i = 0; i < layer.channels.length; i++){
                file.jump(layer.channels[i].length);
            }
            layer.canvas = null;
            return;
        }

        let channelMap = {};
        for (let i = 0; i < layer.channels.length; i++){
            let channel = layer.channels[i];
            let channelStart = file.index;
            let decoded = new Uint8Array(layer.width * layer.height);
            if (channel.length >= 2){
                let compression = file.readWord();
                let dataLength = Math.max(0, channel.length - 2);
                decoded = decodeChannel(file, compression, layer.width, layer.height, dataLength);
            }
            channelMap[channel.id] = decoded;
            file.goto(channelStart + channel.length);
        }

        layer.canvas = channelsToCanvas(channelMap, layer.width, layer.height, mode);
    }

    function decodeChannel(file, compression, width, height, dataLength){
        let expectedLength = width * height;
        if (!width || !height) {
            file.jump(dataLength);
            return new Uint8Array(0);
        }

        if (compression === 0){
            return file.readUBytes(expectedLength);
        }

        if (compression === 1){
            let rowLengths = new Uint16Array(height);
            let total = 0;
            for (let y = 0; y < height; y++){
                rowLengths[y] = file.readWord();
                total += rowLengths[y];
            }

            let result = new Uint8Array(expectedLength);
            let offset = 0;
            for (let y = 0; y < height; y++){
                let packed = file.readUBytes(rowLengths[y]);
                offset = decodePackBitsRow(packed, result, offset, width);
            }
            return result;
        }

        file.jump(dataLength);
        return new Uint8Array(expectedLength);
    }

    function decodePackBitsRow(source, target, offset, width){
        let src = 0;
        let rowEnd = offset + width;
        while (src < source.length && offset < rowEnd){
            let header = source[src++];
            if (header === 128) continue;

            if (header < 128){
                let count = header + 1;
                for (let i = 0; i < count && src < source.length && offset < rowEnd; i++){
                    target[offset++] = source[src++];
                }
            }else{
                let count = 257 - header;
                let value = src < source.length ? source[src++] : 0;
                for (let i = 0; i < count && offset < rowEnd; i++){
                    target[offset++] = value;
                }
            }
        }

        while (offset < rowEnd) target[offset++] = 0;
        return offset;
    }

    function channelsToCanvas(channelMap, width, height, mode){
        if (!width || !height) return null;

        let canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        let ctx = canvas.getContext("2d", {willReadFrequently: true});
        let imageData = ctx.createImageData(width, height);
        let data = imageData.data;
        let pixelCount = width * height;

        let red = channelMap[0];
        let green = channelMap[1];
        let blue = channelMap[2];
        let alpha = channelMap[-1];

        for (let i = 0; i < pixelCount; i++){
            let offset = i * 4;
            if (mode === 1){
                let value = red ? red[i] : 0;
                data[offset] = value;
                data[offset + 1] = value;
                data[offset + 2] = value;
            }else{
                data[offset] = red ? red[i] : 0;
                data[offset + 1] = green ? green[i] : data[offset];
                data[offset + 2] = blue ? blue[i] : data[offset];
            }
            data[offset + 3] = alpha ? alpha[i] : 255;
        }

        ctx.putImageData(imageData, 0, 0);
        return canvas;
    }

    function readCompositeImage(file, data){
        if (file.isEOF(1)) return false;

        let compression = file.readWord();
        let channelData = {};
        if (compression === 1){
            let rowLengths = [];
            for (let channel = 0; channel < data.channels; channel++){
                rowLengths[channel] = new Uint16Array(data.height);
                for (let y = 0; y < data.height; y++){
                    rowLengths[channel][y] = file.readWord();
                }
            }

            for (let channel = 0; channel < data.channels; channel++){
                channelData[channel] = decodeCompositeRLEChannel(file, data.width, data.height, rowLengths[channel]);
            }
        }else{
            for (let channel = 0; channel < data.channels; channel++){
                channelData[channel] = decodeCompositeChannel(file, compression, data.width, data.height);
            }
        }

        if (data.mode === 1){
            return channelsToCanvas({
                0: channelData[0],
                [-1]: channelData[1],
            }, data.width, data.height, data.mode);
        }

        return channelsToCanvas({
            0: channelData[0],
            1: channelData[1],
            2: channelData[2],
            [-1]: channelData[3],
        }, data.width, data.height, data.mode);
    }

    function decodeCompositeChannel(file, compression, width, height){
        let expectedLength = width * height;
        if (compression === 0){
            return file.readUBytes(expectedLength);
        }

        return new Uint8Array(expectedLength);
    }

    function decodeCompositeRLEChannel(file, width, height, rowLengths){
        let expectedLength = width * height;
        let result = new Uint8Array(expectedLength);
        let offset = 0;
        for (let y = 0; y < height; y++){
            let packedLength = rowLengths[y] || 0;
            let packed = file.readUBytes(packedLength);
            offset = decodePackBitsRow(packed, result, offset, width);
        }
        return result;
    }

    function renderCompositeFromLayers(data){
        if (!data.layers || !data.layers.length) return false;
        let canvas = document.createElement("canvas");
        canvas.width = data.width;
        canvas.height = data.height;
        let ctx = canvas.getContext("2d");

        for (let i = data.layers.length - 1; i >= 0; i--){
            let layer = data.layers[i];
            if (!layer.visible || !layer.canvas) continue;
            ctx.globalAlpha = layer.opacity / 100;
            let blendMode = layer.blendMode === "normal" ? "source-over" : layer.blendMode;
            ctx.globalCompositeOperation = blendMode;
            ctx.drawImage(layer.canvas, layer.left, layer.top);
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = "source-over";
        }

        return canvas;
    }

    function readUnicodeString(file){
        let charCount = file.readDWord();
        let value = "";
        for (let i = 0; i < charCount; i++){
            value += String.fromCharCode(file.readWord());
        }
        return value.replace(/\u0000+$/, "");
    }

    function readPascalString(file, padding){
        let length = file.readUbyte();
        let value = file.readString(length);
        let bytesRead = length + 1;
        let pad = bytesRead % padding;
        if (pad) file.jump(padding - pad);
        return value;
    }

    function readInt32(file){
        let value = file.dataView.getInt32(file.index, file.litteEndian);
        file.index += 4;
        return value;
    }

    function encodeLayer(layer, width, height, compression){
        let canvas = layer.render ? layer.render() : layer.getCanvas();
        let ctx = canvas.getContext("2d", {willReadFrequently: true});
        let imageData = ctx.getImageData(0, 0, width, height).data;
        let channelBytes = extractChannels(imageData, width, height);

        let channelBlocks = [
            encodeChannel(channelBytes.red, width, height, compression),
            encodeChannel(channelBytes.green, width, height, compression),
            encodeChannel(channelBytes.blue, width, height, compression),
            encodeChannel(channelBytes.alpha, width, height, compression),
        ];

        let channelIds = [0, 1, 2, -1];
        let blendMode = PSD_BLEND_MODES[layer.blendMode] || "norm";
        let layerOpacity = typeof layer.opacity === "number" ? layer.opacity : 100;
        let opacity = Math.max(0, Math.min(255, Math.round(layerOpacity / 100 * 255)));
        let flags = layer.visible === false ? 0x02 : 0;
        let nameBlock = encodePascalString(layer.name || "Layer", 4);
        let extraData = concatArrays([
            uint32ToBytes(0),
            uint32ToBytes(0),
            nameBlock,
        ]);

        let recordSize = 16 + 2 + (channelBlocks.length * 6) + 4 + 4 + 4 + 4 + extraData.length;
        let record = new Uint8Array(recordSize);
        let offset = 0;

        offset = writeArray(record, int32ToBytes(0), offset);
        offset = writeArray(record, int32ToBytes(0), offset);
        offset = writeArray(record, int32ToBytes(height), offset);
        offset = writeArray(record, int32ToBytes(width), offset);
        offset = writeArray(record, uint16ToBytes(channelBlocks.length), offset);

        for (let i = 0; i < channelBlocks.length; i++){
            offset = writeArray(record, int16ToBytes(channelIds[i]), offset);
            offset = writeArray(record, uint32ToBytes(channelBlocks[i].length), offset);
        }

        offset = writeAscii(record, "8BIM", offset);
        offset = writeAscii(record, blendMode, offset);
        record[offset++] = opacity;
        record[offset++] = 0;
        record[offset++] = flags;
        record[offset++] = 0;
        offset = writeArray(record, uint32ToBytes(extraData.length), offset);
        writeArray(record, extraData, offset);

        return {
            record,
            channelBlocks,
        };
    }

    function encodeComposite(canvas, width, height, compression){
        let ctx = canvas.getContext("2d", {willReadFrequently: true});
        let imageData = ctx.getImageData(0, 0, width, height).data;
        let channels = extractChannels(imageData, width, height);

        if (compression === 1){
            let encodedRed = encodeChannelRLE(channels.red, width, height);
            let encodedGreen = encodeChannelRLE(channels.green, width, height);
            let encodedBlue = encodeChannelRLE(channels.blue, width, height);
            let encodedAlpha = encodeChannelRLE(channels.alpha, width, height);
            return concatArrays([
                uint16ToBytes(1),
                encodedRed.rowTable,
                encodedGreen.rowTable,
                encodedBlue.rowTable,
                encodedAlpha.rowTable,
                encodedRed.data,
                encodedGreen.data,
                encodedBlue.data,
                encodedAlpha.data,
            ]);
        }

        return concatArrays([
            uint16ToBytes(0),
            channels.red,
            channels.green,
            channels.blue,
            channels.alpha,
        ]);
    }

    function encodeChannel(bytes, width, height, compression){
        if (compression === 1){
            let encoded = encodeChannelRLE(bytes, width, height);
            return concatArrays([
                uint16ToBytes(1),
                encoded.rowTable,
                encoded.data,
            ]);
        }
        return encodeRawChannel(bytes);
    }

    function encodeRawChannel(bytes){
        let result = new Uint8Array(2 + bytes.length);
        result[0] = 0;
        result[1] = 0;
        result.set(bytes, 2);
        return result;
    }

    function encodeChannelRLE(bytes, width, height){
        let rows = [];
        let rowLengths = new Uint8Array(height * 2);
        for (let y = 0; y < height; y++){
            let start = y * width;
            let row = bytes.subarray(start, start + width);
            let packed = packBitsEncode(row);
            let length = packed.length;
            rowLengths[y * 2] = (length >> 8) & 0xff;
            rowLengths[y * 2 + 1] = length & 0xff;
            rows.push(packed);
        }
        return {
            rowTable: rowLengths,
            data: concatArrays(rows),
        };
    }

    function packBitsEncode(bytes){
        let output = [];
        let i = 0;

        while (i < bytes.length){
            let runLength = 1;
            while (
                i + runLength < bytes.length &&
                bytes[i + runLength] === bytes[i] &&
                runLength < 128
            ){
                runLength++;
            }

            if (runLength >= 3){
                output.push(257 - runLength);
                output.push(bytes[i]);
                i += runLength;
                continue;
            }

            let literalStart = i;
            i += runLength;

            while (i < bytes.length){
                runLength = 1;
                while (
                    i + runLength < bytes.length &&
                    bytes[i + runLength] === bytes[i] &&
                    runLength < 128
                ){
                    runLength++;
                }
                if (runLength >= 3) break;
                i += runLength;
                if (i - literalStart >= 128) break;
            }

            let literalLength = i - literalStart;
            while (literalLength > 0){
                let chunkLength = Math.min(128, literalLength);
                output.push(chunkLength - 1);
                for (let j = 0; j < chunkLength; j++){
                    output.push(bytes[literalStart + j]);
                }
                literalStart += chunkLength;
                literalLength -= chunkLength;
            }
        }

        return Uint8Array.from(output);
    }

    function extractChannels(imageData, width, height){
        let pixelCount = width * height;
        let red = new Uint8Array(pixelCount);
        let green = new Uint8Array(pixelCount);
        let blue = new Uint8Array(pixelCount);
        let alpha = new Uint8Array(pixelCount);

        for (let i = 0; i < pixelCount; i++){
            let src = i * 4;
            red[i] = imageData[src];
            green[i] = imageData[src + 1];
            blue[i] = imageData[src + 2];
            alpha[i] = imageData[src + 3];
        }

        return { red, green, blue, alpha };
    }

    function encodePascalString(value, padding){
        value = (value || "").replace(/[\u0100-\uffff]/g, "?");
        if (value.length > 255) value = value.substring(0, 255);
        let length = value.length;
        let blockLength = length + 1;
        let remainder = blockLength % padding;
        if (remainder) blockLength += padding - remainder;
        let result = new Uint8Array(blockLength);
        result[0] = length;
        for (let i = 0; i < length; i++){
            result[i + 1] = value.charCodeAt(i) & 0xff;
        }
        return result;
    }

    function concatArrays(arrays){
        let total = 0;
        for (let i = 0; i < arrays.length; i++){
            total += arrays[i].length;
        }
        let result = new Uint8Array(total);
        let offset = 0;
        for (let i = 0; i < arrays.length; i++){
            result.set(arrays[i], offset);
            offset += arrays[i].length;
        }
        return result;
    }

    function writeArray(target, source, offset){
        target.set(source, offset);
        return offset + source.length;
    }

    function writeAscii(target, value, offset){
        for (let i = 0; i < value.length; i++){
            target[offset + i] = value.charCodeAt(i) & 0xff;
        }
        return offset + value.length;
    }

    function uint16ToBytes(value){
        let result = new Uint8Array(2);
        result[0] = (value >> 8) & 0xff;
        result[1] = value & 0xff;
        return result;
    }

    function int16ToBytes(value){
        if (value < 0) value = 0x10000 + value;
        return uint16ToBytes(value);
    }

    function uint32ToBytes(value){
        let result = new Uint8Array(4);
        result[0] = (value >>> 24) & 0xff;
        result[1] = (value >>> 16) & 0xff;
        result[2] = (value >>> 8) & 0xff;
        result[3] = value & 0xff;
        return result;
    }

    function int32ToBytes(value){
        if (value < 0) value = 0x100000000 + value;
        return uint32ToBytes(value);
    }

    function writeBytes(file, bytes){
        for (let i = 0; i < bytes.length; i++){
            file.writeUbyte(bytes[i]);
        }
    }
})();

export default PSD;
