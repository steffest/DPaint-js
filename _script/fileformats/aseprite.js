// file format: https://github.com/aseprite/aseprite/blob/main/docs/ase-file-specs.md

import zlib_closure from "../util/zlib.js";
zlib_closure.call(window);

const FILETYPE = {
    ASEPRITE: { name: "Aseprite Sprite", actions: ["show"], inspect: true },
};

const BLEND_MODES = {
    0: "normal",
    1: "multiply",
    2: "screen",
    3: "overlay",
    4: "darken",
    5: "lighten",
    6: "color-dodge",
    7: "color-burn",
    8: "hard-light",
    9: "soft-light",
    10: "difference",
    11: "exclusion",
    12: "hue",
    13: "saturation",
    14: "color",
    15: "luminosity",
    16: "lighter",
    17: "darker",
    18: "color-burn",
};

const Aseprite = (function(){
    let me = {};

    me.fileTypes = FILETYPE;

    me.detect = function(file){
        file.goto(0);
        if (file.length < 128) return false;
        file.readDWord();
        if (file.readWord() !== 0xa5e0) return false;
        return FILETYPE.ASEPRITE;
    };

    me.parse = function(file){
        file.goto(0);

        let data = {
            type: "ASEPRITE",
            layers: [],
        };

        data.fileSize = file.readDWord();
        if (file.readWord() !== 0xa5e0) return false;

        data.frameCount = file.readWord();
        data.width = file.readWord();
        data.height = file.readWord();
        data.depth = file.readWord();
        data.flags = file.readDWord();
        data.speed = file.readWord();
        file.jump(8);
        data.transparentIndex = file.readUbyte();
        file.jump(3);
        data.colorCount = file.readWord() || 256;
        data.pixelWidth = file.readUbyte() || 1;
        data.pixelHeight = file.readUbyte() || 1;
        data.gridX = file.readShort();
        data.gridY = file.readShort();
        data.gridWidth = file.readWord();
        data.gridHeight = file.readWord();
        file.jump(84);

        if (!data.width || !data.height) return false;
        if (data.depth !== 32) {
            console.warn("Aseprite loader currently supports only 32-bit RGBA sprites.");
            return false;
        }

        let spriteLayers = [];
        let layerByIndex = [];
        let frameCount = data.frameCount || 1;

        for (let frameIndex = 0; frameIndex < frameCount && file.index < file.length - 15; frameIndex++){
            let frameStart = file.index;
            let frameBytes = file.readDWord();
            let frameMagic = file.readWord();
            if (frameMagic !== 0xf1fa) return false;

            let oldChunkCount = file.readWord();
            let frameDuration = file.readWord();
            file.jump(2);
            let newChunkCount = file.readDWord();
            let chunkCount = newChunkCount || oldChunkCount;
            let frameEnd = frameStart + frameBytes;

            if (frameIndex === 0) data.frameDuration = frameDuration;

            for (let chunkIndex = 0; chunkIndex < chunkCount && file.index < frameEnd; chunkIndex++){
                let chunkStart = file.index;
                let chunkSize = file.readDWord();
                let chunkType = file.readWord();
                let chunkEnd = chunkStart + chunkSize;

                if (chunkSize < 6 || chunkEnd > file.length) return false;

                if (frameIndex === 0){
                    if (chunkType === 0x2004){
                        let layer = readLayerChunk(file, spriteLayers.length);
                        spriteLayers.push(layer);
                        layerByIndex[layer.index] = layer;
                    }else if (chunkType === 0x2005){
                        readCelChunk(file, data, layerByIndex, frameIndex, chunkEnd);
                    }
                }

                file.goto(chunkEnd);
            }
            file.goto(frameEnd);
        }

        data.layers = buildLayerTree(spriteLayers, data.width, data.height);

        data.image = renderComposite(data);

        return data;
    };

    return me;

    function readLayerChunk(file, index){
        let flags = file.readWord();
        let layerType = file.readWord();
        let childLevel = file.readWord();
        let defaultWidth = file.readWord();
        let defaultHeight = file.readWord();
        let blendMode = file.readWord();
        let opacity = file.readUbyte();
        file.jump(3);
        let name = readString(file) || ("Layer " + (index + 1));

        if (layerType === 2) file.jump(4);

        return {
            index: index,
            flags: flags,
            type: layerType,
            childLevel: childLevel,
            defaultWidth: defaultWidth,
            defaultHeight: defaultHeight,
            name: name,
            visible: !!(flags & 1),
            opacity: Math.round(opacity / 255 * 100),
            blendMode: BLEND_MODES[blendMode] || "normal",
        };
    }

    function readCelChunk(file, data, layerByIndex, frameIndex, chunkEnd){
        let layerIndex = file.readWord();
        let x = file.readShort();
        let y = file.readShort();
        let opacity = file.readUbyte();
        let celType = file.readWord();
        let zIndex = file.readShort();
        file.jump(5);

        let layer = layerByIndex[layerIndex];
        if (!layer || layer.type !== 0) return;

        let celCanvas;
        if (celType === 0){
            celCanvas = readRawCel(file, data.depth);
        }else if (celType === 2){
            celCanvas = readCompressedCel(file, data.depth, chunkEnd);
        }else{
            return;
        }

        if (!celCanvas) return;
        if (!layer.canvas) layer.canvas = createCanvas(data.width, data.height);

        let ctx = layer.canvas.getContext("2d");
        ctx.save();
        if (opacity < 255) ctx.globalAlpha = opacity / 255;
        ctx.drawImage(celCanvas, x, y);
        ctx.restore();

        layer.frameIndex = frameIndex;
        layer.celX = x;
        layer.celY = y;
        layer.celOpacity = opacity;
        layer.zIndex = zIndex;
    }

    function readRawCel(file, depth){
        let width = file.readWord();
        let height = file.readWord();
        if (depth !== 32) return false;
        let byteLength = width * height * 4;
        let pixels = file.readUBytes(byteLength);
        return canvasFromRgba(width, height, pixels);
    }

    function readCompressedCel(file, depth, chunkEnd){
        let width = file.readWord();
        let height = file.readWord();
        if (depth !== 32) return false;
        let compressedLength = Math.max(0, chunkEnd - file.index);
        let compressed = file.readUBytes(compressedLength);
        let pixels = new Zlib.Inflate(compressed).decompress();
        if (pixels.length !== width * height * 4) return false;
        return canvasFromRgba(width, height, pixels);
    }

    // Reconstructs the group hierarchy from the flat Aseprite layer list using childLevel.
    // Aseprite stores layers bottom-to-top; a group (layerType 1) is followed by its
    // children at childLevel+1. We track a stack of open groups keyed by depth.
    function buildLayerTree(spriteLayers, width, height){
        let root = [];
        let stack = [];   // stack[d] = the group node opened at childLevel d

        function descriptorFor(layer){
            if (!layer.canvas) layer.canvas = createCanvas(width, height);
            return {
                name: layer.name,
                visible: layer.visible,
                opacity: layer.opacity,
                blendMode: layer.blendMode,
                left: 0,
                top: 0,
                canvas: layer.canvas,
            };
        }

        spriteLayers.forEach((layer)=>{
            let level = layer.childLevel || 0;
            let parent = level > 0 && stack[level - 1] ? stack[level - 1].layers : root;

            if (layer.type === 1){
                // group layer
                let group = {
                    type: "group",
                    name: layer.name,
                    visible: layer.visible,
                    opacity: layer.opacity,
                    blendMode: layer.blendMode,
                    locked: false,
                    collapsed: false,
                    layers: [],
                };
                parent.push(group);
                stack[level] = group;
                stack.length = level + 1; // drop any deeper stale entries
            } else if (layer.type === 0){
                parent.push(descriptorFor(layer));
            }
            // other layer types (e.g. 2 = tilemap) are ignored
        });

        return root;
    }

    function renderComposite(data){
        let canvas = createCanvas(data.width, data.height);
        let ctx = canvas.getContext("2d");
        (function draw(nodes){
            nodes.forEach((layer) => {
                if (!layer.visible) return;
                if (layer.type === "group" && Array.isArray(layer.layers)){
                    // composite group children with the group's own opacity/blend
                    let groupCanvas = createCanvas(data.width, data.height);
                    let gctx = groupCanvas.getContext("2d");
                    (function drawInto(n, targetCtx){
                        n.forEach((child)=>{
                            if (!child.visible) return;
                            if (child.type === "group" && Array.isArray(child.layers)){
                                let sub = createCanvas(data.width, data.height);
                                drawInto(child.layers, sub.getContext("2d"));
                                targetCtx.save();
                                targetCtx.globalAlpha = (typeof child.opacity === "number" ? child.opacity : 100) / 100;
                                targetCtx.drawImage(sub, 0, 0);
                                targetCtx.restore();
                            } else if (child.canvas){
                                targetCtx.save();
                                targetCtx.globalAlpha = (typeof child.opacity === "number" ? child.opacity : 100) / 100;
                                let bm = child.blendMode || "normal";
                                targetCtx.globalCompositeOperation = bm === "normal" ? "source-over" : bm;
                                targetCtx.drawImage(child.canvas, 0, 0);
                                targetCtx.restore();
                            }
                        });
                    })(layer.layers, gctx);
                    ctx.save();
                    ctx.globalAlpha = (typeof layer.opacity === "number" ? layer.opacity : 100) / 100;
                    ctx.drawImage(groupCanvas, 0, 0);
                    ctx.restore();
                    return;
                }
                if (!layer.canvas) return;
                ctx.save();
                ctx.globalAlpha = (typeof layer.opacity === "number" ? layer.opacity : 100) / 100;
                let blendMode = layer.blendMode || "normal";
                if (blendMode === "normal") blendMode = "source-over";
                ctx.globalCompositeOperation = blendMode;
                ctx.drawImage(layer.canvas, 0, 0);
                ctx.restore();
            });
        })(data.layers);
        return canvas;
    }

    function canvasFromRgba(width, height, pixels){
        let canvas = createCanvas(width, height);
        let ctx = canvas.getContext("2d");
        let imageData = ctx.createImageData(width, height);
        imageData.data.set(pixels);
        ctx.putImageData(imageData, 0, 0);
        return canvas;
    }

    function createCanvas(width, height){
        let canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        return canvas;
    }

    function readString(file){
        let length = file.readWord();
        if (!length) return "";
        let bytes = file.readUBytes(length);
        if (typeof TextDecoder !== "undefined"){
            return new TextDecoder("utf-8").decode(bytes);
        }
        return Array.from(bytes).map((code) => String.fromCharCode(code)).join("");
    }
})();

export default Aseprite;
