// Minimal, dependency-free PDF reader/writer. See docs/pdf_support.md for the exact
// supported/unsupported feature list.
//
// PDF is a page-description language, not an image format, so this module deliberately only
// covers the "one raster image on a page" subset: export always writes a single page holding
// the current frame as one FlateDecode-compressed image XObject (+ optional /SMask for alpha);
// import scans the file for indirect objects (N G obj ... endobj) instead of requiring a
// well-formed xref/trailer, finds the first /Type /Page object, and decodes its first image
// XObject (FlateDecode raw samples or DCTDecode/JPEG).

import zlib_closure from "../util/zlib.js";
zlib_closure.call(window);

const FILETYPE = {
    PDF: { name: "Adobe PDF Document", actions: ["show"], inspect: true },
};

const PDF = (function(){
    let me = {};

    me.fileTypes = FILETYPE;

    me.detect = function(file){
        file.goto(0);
        let header = file.readUBytes(Math.min(5,file.length),0);
        let sig = String.fromCharCode.apply(null,header);
        return sig === "%PDF-" ? FILETYPE.PDF : false;
    };

    me.parse = async function(file){
        file.goto(0);
        let bytes = file.readUBytes(file.length,0);
        let text = new TextDecoder("iso-8859-1").decode(bytes);

        let objects;
        try {
            objects = collectObjects(text,bytes);
        } catch (e){
            console.error("PDF parse error",e);
            return false;
        }
        if (!Object.keys(objects).length) return false;

        // v1 doesn't walk Catalog -> Pages -> Kids: it scans directly for the first
        // /Type /Page object (ascending object id, guaranteed by for..in over integer keys).
        // Simpler and more robust for the single/simple-page documents this targets; documented
        // limitation for documents whose object ids don't follow page order.
        let pageEntry = null;
        for (let id in objects){
            let value = objects[id].value;
            if (value && typeof value === "object" && value.Type === "Page"){
                pageEntry = objects[id];
                break;
            }
        }
        if (!pageEntry) return false;

        let page = pageEntry.value;
        let resources = resolveValue(objects,page.Resources);
        let xobjects = resources && resolveValue(objects,resources.XObject);
        if (!xobjects || typeof xobjects !== "object") return false;

        let imageEntry = null;
        for (let key in xobjects){
            let entry = resolveObj(objects,xobjects[key]);
            if (entry && entry.value && entry.value.Subtype === "Image"){
                imageEntry = entry;
                break;
            }
        }
        if (!imageEntry) return false;

        let canvas;
        try {
            canvas = await decodeImageEntry(imageEntry,objects);
        } catch (e){
            console.error("PDF image decode error",e);
            return false;
        }
        if (!canvas) return false;

        return {
            type: "PDF",
            width: canvas.width,
            height: canvas.height,
            image: canvas,
        };
    };

    me.toCanvas = function(data){
        if (!data) return false;
        return data.image || false;
    };

    // 1px = 1pt, so the page prints/displays at the image's native pixel size.
    me.write = function(frame,width,height,compositeCanvas,options){
        options = options || {};
        let ctx = compositeCanvas.getContext("2d",{willReadFrequently:true});
        let imageData = ctx.getImageData(0,0,width,height).data;
        let pixelCount = width * height;

        let rgb = new Uint8Array(pixelCount * 3);
        let alpha = new Uint8Array(pixelCount);
        let hasAlpha = false;
        for (let i = 0; i < pixelCount; i++){
            let s = i * 4;
            rgb[i*3] = imageData[s];
            rgb[i*3+1] = imageData[s+1];
            rgb[i*3+2] = imageData[s+2];
            let a = imageData[s+3];
            alpha[i] = a;
            if (a !== 255) hasAlpha = true;
        }

        let rgbCompressed = new Zlib.Deflate(rgb).compress();
        let alphaCompressed = hasAlpha ? new Zlib.Deflate(alpha).compress() : null;

        let chunks = [];
        let offset = 0;
        let objOffsets = {};

        function push(byteArray){
            chunks.push(byteArray);
            offset += byteArray.length;
        }
        function pushText(str){
            push(asciiBytes(str));
        }
        function beginObj(num){
            objOffsets[num] = offset;
            pushText(num + " 0 obj\n");
        }
        function endObj(){
            pushText("endobj\n");
        }

        pushText("%PDF-1.4\n");

        beginObj(1);
        pushText("<< /Type /Catalog /Pages 2 0 R >>\n");
        endObj();

        beginObj(2);
        pushText("<< /Type /Pages /Kids [3 0 R] /Count 1 >>\n");
        endObj();

        beginObj(3);
        pushText("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + width + " " + height +
            "] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>\n");
        endObj();

        let contentBytes = asciiBytes(width + " 0 0 " + height + " 0 0 cm\n/Im0 Do\n");
        beginObj(4);
        pushText("<< /Length " + contentBytes.length + " >>\nstream\n");
        push(contentBytes);
        pushText("\nendstream\n");
        endObj();

        let smaskRef = hasAlpha ? " /SMask 6 0 R" : "";
        beginObj(5);
        pushText("<< /Type /XObject /Subtype /Image /Width " + width + " /Height " + height +
            " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode" + smaskRef +
            " /Length " + rgbCompressed.length + " >>\nstream\n");
        push(rgbCompressed);
        pushText("\nendstream\n");
        endObj();

        if (hasAlpha){
            beginObj(6);
            pushText("<< /Type /XObject /Subtype /Image /Width " + width + " /Height " + height +
                " /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode" +
                " /Length " + alphaCompressed.length + " >>\nstream\n");
            push(alphaCompressed);
            pushText("\nendstream\n");
            endObj();
        }

        let objectCount = hasAlpha ? 6 : 5;
        let xrefOffset = offset;
        pushText("xref\n0 " + (objectCount+1) + "\n");
        pushText("0000000000 65535 f \n");
        for (let i = 1; i <= objectCount; i++){
            pushText(pad10(objOffsets[i]) + " 00000 n \n");
        }
        pushText("trailer\n<< /Size " + (objectCount+1) + " /Root 1 0 R >>\nstartxref\n" + xrefOffset + "\n%%EOF");

        return concatArrays(chunks).buffer;
    };

    return me;

    // ---- import: tolerant object scanner + minimal PDF value parser ----

    // Finds every "N G obj" header in the file and captures its parsed value plus, when
    // present, the raw bytes of its stream (sliced straight out of the original buffer, not
    // re-derived from the text view). No xref/trailer is required: this is what lets the
    // importer open files whose page tree lives behind compressed cross-reference/object
    // streams, since an image's own stream is never itself packed inside an object stream.
    function collectObjects(text,bytes){
        let objects = {};
        let headerRegex = /(\d+)\s+(\d+)\s+obj\b/g;
        let headers = [];
        let match;
        while ((match = headerRegex.exec(text))){
            headers.push({id: parseInt(match[1],10), bodyStart: headerRegex.lastIndex});
        }

        let pending = [];
        headers.forEach(h=>{
            let parsed;
            try {
                parsed = parseValue(text,h.bodyStart);
            } catch (e){
                return;
            }
            let entry = {value: parsed.value, streamBytes: null};
            objects[h.id] = entry;

            let i = skipWhitespaceAndComments(text,parsed.index);
            if (text.substr(i,6) === "stream"){
                let dataStart = i + 6;
                if (text[dataStart] === "\r") dataStart++;
                if (text[dataStart] === "\n") dataStart++;
                pending.push({entry, dataStart, dict: parsed.value});
            }
        });

        // /Length may be an indirect reference to another (already-parsed, plain-number)
        // object, so stream extents are resolved in a second pass.
        pending.forEach(p=>{
            let dict = p.dict;
            let length = dict && typeof dict === "object" ? dict.Length : null;
            let len = null;
            if (typeof length === "number") len = length;
            else if (length && typeof length === "object" && "ref" in length){
                let lenObj = objects[length.ref];
                if (lenObj && typeof lenObj.value === "number") len = lenObj.value;
            }

            let dataEnd;
            if (typeof len === "number" && len >= 0 && p.dataStart + len <= bytes.length){
                dataEnd = p.dataStart + len;
            } else {
                let idx = text.indexOf("endstream",p.dataStart);
                dataEnd = idx < 0 ? bytes.length : idx;
                if (text[dataEnd-1] === "\n") dataEnd--;
                if (text[dataEnd-1] === "\r") dataEnd--;
            }
            p.entry.streamBytes = bytes.subarray(p.dataStart,Math.max(p.dataStart,dataEnd));
        });

        return objects;
    }

    function resolveValue(objects,val){
        if (val && typeof val === "object" && "ref" in val){
            let target = objects[val.ref];
            return target ? target.value : null;
        }
        return val;
    }

    function resolveObj(objects,val){
        if (val && typeof val === "object" && "ref" in val){
            return objects[val.ref] || null;
        }
        return null;
    }

    async function decodeImageEntry(entry,objects){
        let dict = entry.value;
        let width = dict.Width;
        let height = dict.Height;
        if (!(width > 0) || !(height > 0)) return null;

        let bytes = entry.streamBytes;
        if (!bytes) return null;

        let filter = dict.Filter;
        if (Array.isArray(filter)) filter = filter[filter.length-1];

        let colorSpace = dict.ColorSpace;
        if (Array.isArray(colorSpace) || (colorSpace && typeof colorSpace === "object")) colorSpace = null;

        let canvas;
        if (filter === "DCTDecode"){
            canvas = await decodeJPEG(bytes,width,height);
        } else if (filter === "FlateDecode" || !filter){
            let raw = filter ? new Zlib.Inflate(bytes).decompress() : bytes;
            canvas = decodeRawSamples(raw,width,height,colorSpace,dict.BitsPerComponent || 8);
        } else {
            return null; // LZWDecode / CCITTFaxDecode / JPXDecode / ... — not supported in v1
        }
        if (!canvas) return null;

        let smaskEntry = resolveObj(objects,dict.SMask);
        if (smaskEntry && smaskEntry.value && smaskEntry.value.Subtype === "Image"){
            let alphaCanvas = await decodeImageEntry(smaskEntry,objects);
            if (alphaCanvas) applyAlpha(canvas,alphaCanvas);
        }

        return canvas;
    }

    function decodeRawSamples(raw,width,height,colorSpace,bitsPerComponent){
        if (bitsPerComponent !== 8) return null;
        let pixelCount = width * height;

        let comps;
        if (colorSpace === "DeviceRGB") comps = 3;
        else if (colorSpace === "DeviceGray" || colorSpace === "CalGray") comps = 1;
        else if (!colorSpace){
            if (raw.length >= pixelCount * 3) comps = 3;
            else if (raw.length >= pixelCount) comps = 1;
            else return null;
        } else {
            return null; // Indexed / DeviceCMYK / ICCBased / Separation / ... — not supported in v1
        }
        if (raw.length < pixelCount * comps) return null;

        let canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        let ctx = canvas.getContext("2d");
        let imageData = ctx.createImageData(width,height);
        let data = imageData.data;

        for (let i = 0; i < pixelCount; i++){
            let d = i * 4;
            if (comps === 3){
                let s = i * 3;
                data[d] = raw[s];
                data[d+1] = raw[s+1];
                data[d+2] = raw[s+2];
            } else {
                let v = raw[i];
                data[d] = v;
                data[d+1] = v;
                data[d+2] = v;
            }
            data[d+3] = 255;
        }

        ctx.putImageData(imageData,0,0);
        return canvas;
    }

    function decodeJPEG(bytes,width,height){
        return new Promise((resolve)=>{
            let blob = new Blob([bytes],{type:"image/jpeg"});
            let url = URL.createObjectURL(blob);
            let img = new Image();
            img.onload = ()=>{
                URL.revokeObjectURL(url);
                let canvas = document.createElement("canvas");
                canvas.width = width || img.naturalWidth;
                canvas.height = height || img.naturalHeight;
                canvas.getContext("2d").drawImage(img,0,0,canvas.width,canvas.height);
                resolve(canvas);
            };
            img.onerror = ()=>{
                URL.revokeObjectURL(url);
                resolve(null);
            };
            img.src = url;
        });
    }

    function applyAlpha(canvas,alphaCanvas){
        let w = canvas.width;
        let h = canvas.height;
        let ctx = canvas.getContext("2d");
        let imageData = ctx.getImageData(0,0,w,h);
        let data = imageData.data;

        let aw = alphaCanvas.width;
        let ah = alphaCanvas.height;
        let alphaData = alphaCanvas.getContext("2d").getImageData(0,0,aw,ah).data;
        let sameSize = aw === w && ah === h;

        for (let y = 0; y < h; y++){
            for (let x = 0; x < w; x++){
                let di = (y * w + x) * 4;
                let ai;
                if (sameSize){
                    ai = di;
                } else {
                    let sx = Math.min(aw-1,Math.floor(x * aw / w));
                    let sy = Math.min(ah-1,Math.floor(y * ah / h));
                    ai = (sy * aw + sx) * 4;
                }
                data[di+3] = alphaData[ai];
            }
        }

        ctx.putImageData(imageData,0,0);
    }

    // ---- minimal PDF object-syntax parser (dict/array/name/number/ref/string/bool/null) ----

    function isWhitespace(c){
        return c === " " || c === "\t" || c === "\r" || c === "\n" || c === "\f" || c === "\0";
    }

    function isDelim(c){
        return c === "(" || c === ")" || c === "<" || c === ">" || c === "[" || c === "]" ||
            c === "{" || c === "}" || c === "/" || c === "%";
    }

    function skipWhitespaceAndComments(text,i){
        while (i < text.length){
            let c = text[i];
            if (c === "%"){
                while (i < text.length && text[i] !== "\n" && text[i] !== "\r") i++;
            } else if (isWhitespace(c)){
                i++;
            } else {
                break;
            }
        }
        return i;
    }

    function parseValue(text,i){
        i = skipWhitespaceAndComments(text,i);
        let c = text[i];
        if (c === undefined) return {value: null, index: i};

        if (c === "/"){
            let start = ++i;
            while (i < text.length && !isWhitespace(text[i]) && !isDelim(text[i])) i++;
            return {value: text.slice(start,i), index: i};
        }

        if (c === "("){
            let depth = 1;
            let out = "";
            i++;
            while (i < text.length && depth > 0){
                let ch = text[i];
                if (ch === "\\"){ out += text[i+1]; i += 2; continue; }
                if (ch === "(") depth++;
                if (ch === ")"){
                    depth--;
                    if (depth === 0){ i++; break; }
                }
                out += ch;
                i++;
            }
            return {value: out, index: i};
        }

        if (c === "<"){
            if (text[i+1] === "<"){
                i += 2;
                let dict = {};
                while (true){
                    i = skipWhitespaceAndComments(text,i);
                    if (text[i] === ">" && text[i+1] === ">"){ i += 2; break; }
                    if (i >= text.length) break;
                    if (text[i] !== "/"){ i++; continue; }
                    let keyResult = parseValue(text,i);
                    i = keyResult.index;
                    let valResult = parseValue(text,i);
                    i = valResult.index;
                    dict[keyResult.value] = valResult.value;
                }
                return {value: dict, index: i};
            }
            let start = ++i;
            while (i < text.length && text[i] !== ">") i++;
            let hex = text.slice(start,i);
            i++;
            return {value: hex, index: i};
        }

        if (c === "["){
            i++;
            let arr = [];
            while (true){
                i = skipWhitespaceAndComments(text,i);
                if (text[i] === "]"){ i++; break; }
                if (i >= text.length) break;
                let r = parseValue(text,i);
                arr.push(r.value);
                i = r.index;
            }
            return {value: arr, index: i};
        }

        let start = i;
        while (i < text.length && !isWhitespace(text[i]) && !isDelim(text[i])) i++;
        let token = text.slice(start,i);

        if (token === "true") return {value: true, index: i};
        if (token === "false") return {value: false, index: i};
        if (token === "null") return {value: null, index: i};

        if (/^[+-]?\d+$/.test(token)){
            let after = i;
            let j = skipWhitespaceAndComments(text,after);
            let genStart = j;
            while (j < text.length && /\d/.test(text[j])) j++;
            if (j > genStart){
                let k = skipWhitespaceAndComments(text,j);
                if (text[k] === "R" && (k+1 >= text.length || isWhitespace(text[k+1]) || isDelim(text[k+1]))){
                    return {value: {ref: parseInt(token,10)}, index: k+1};
                }
            }
            return {value: parseInt(token,10), index: after};
        }

        if (/^[+-]?(\d+\.\d*|\.\d+)$/.test(token)){
            return {value: parseFloat(token), index: i};
        }

        return {value: token, index: i};
    }

    // ---- byte helpers (mirrors the pattern used in psd.js) ----

    function pad10(value){
        return String(value).padStart(10,"0");
    }

    function asciiBytes(value){
        let result = new Uint8Array(value.length);
        for (let i = 0; i < value.length; i++) result[i] = value.charCodeAt(i) & 0xff;
        return result;
    }

    function concatArrays(arrays){
        let total = 0;
        for (let i = 0; i < arrays.length; i++) total += arrays[i].length;
        let result = new Uint8Array(total);
        let offset = 0;
        for (let i = 0; i < arrays.length; i++){
            result.set(arrays[i],offset);
            offset += arrays[i].length;
        }
        return result;
    }
})();

export default PDF;
