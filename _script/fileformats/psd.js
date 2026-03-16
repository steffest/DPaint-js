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
})();

export default PSD;
