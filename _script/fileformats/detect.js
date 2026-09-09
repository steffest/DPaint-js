import BinaryStream from "../util/binarystream.js";

// File-type sniffing on open. Each branch only loads the ONE format module it actually needs
// (dynamic import), instead of this module (reached eagerly from image.js on every session)
// statically pulling in every format parser — IFF/PSD/GIF/PNG/Aseprite/DEGAS/PCX/AmigaIcon — just
// to open a single file.
let FileDetector = (function () {
    let me = {};

    me.detect = function (data, name) {
        return new Promise(async (next) => {
            name = name || "";
            let ext = name.split(".").pop().toLowerCase();
            let file;

            if (ext === "info") {
                let AmigaIcon = (await import("./amigaIcon.js")).default;
                file = BinaryStream(data.slice(0, data.byteLength), true);
                file.goto(0);
                // Note: this can be Async!
                AmigaIcon.parse(file, function (icon) {
                    if (icon) {
                        let selectedType = AmigaIcon.getType(icon);
                        let canvas = AmigaIcon.getImage(icon, 0, selectedType);
                        let canvas2 = AmigaIcon.getImage(icon, 1, selectedType);
                        icon.selectedImageType = selectedType;
                        icon.availableImageTypes = AmigaIcon.getImageTypes(icon);
                        next({
                            image: [canvas, canvas2].filter(Boolean),
                            type: selectedType,
                            data: icon,
                        });
                    } else {
                        detectIFF();
                    }
                });
            } else if (ext === "gif"){
                let GIF = (await import("./gif.js")).default;
                // Note: GIFs are always little-endian
                // see https://www.w3.org/Graphics/GIF/spec-gif89a.txt
                file = BinaryStream(data.slice(0, data.byteLength), false);
                file.goto(0);
                let result = GIF.detect(file);
                if (result) {
                    next(GIF.toFrames(file));
                }else{
                    next(false);
                }
            } else if (ext === "png"){
                let PNG = (await import("./png.js")).default;
                // check if it's an indexed PNG
                // note: PNGs are always big-endian
                file = BinaryStream(data.slice(0, data.byteLength), true);
                file.goto(0);
                let result = PNG.detect(file);
                if (result){
                    PNG.parse(file).then(next);
                }else{
                    next(false);
                }
            } else if (ext === "psd"){
                let PSD = (await import("./psd.js")).default;
                file = BinaryStream(data.slice(0, data.byteLength), true);
                file.goto(0);
                let result = PSD.detect(file);
                if (result){
                    let data = PSD.parse(file);
                    if (data && data.image){
                        next({
                            image: data.image,
                            type: "PSD",
                            data: data,
                        });
                    }else{
                        next(false);
                    }
                }else{
                    next(false);
                }
            } else if (ext === "pdf"){
                let PDF = (await import("./pdf.js")).default;
                file = BinaryStream(data.slice(0, data.byteLength), true);
                file.goto(0);
                let result = PDF.detect(file);
                if (result){
                    let data = await PDF.parse(file);
                    if (data && data.image){
                        next({
                            image: data.image,
                            type: "PDF",
                            data: data,
                        });
                    }else{
                        next(false);
                    }
                }else{
                    next(false);
                }
            } else if (ext === "pi1" || ext === "pi2" || ext === "pi3") {
                let DEGAS = (await import("./degas.js")).default;
                file = BinaryStream(data.slice(0, data.byteLength), true);
                file.goto(0);
                if (DEGAS.detect(file)) {
                    let parsed = DEGAS.parse(file);
                    if (parsed && parsed.image) {
                        next({
                            image: parsed.image,
                            type: "DEGAS",
                            data: parsed,
                        });
                    } else {
                        next(false);
                    }
                } else {
                    next(false);
                }
            } else if (ext === "neo") {
                let DEGAS = (await import("./degas.js")).default;
                file = BinaryStream(data.slice(0, data.byteLength), true);
                file.goto(0);
                if (DEGAS.detectNeo(file)) {
                    let parsed = DEGAS.parseNeo(file);
                    if (parsed && parsed.image) {
                        next({
                            image: parsed.image,
                            type: "NEO",
                            data: parsed,
                        });
                    } else {
                        next(false);
                    }
                } else {
                    next(false);
                }
            } else if (ext === "ase" || ext === "aseprite"){
                let Aseprite = (await import("./aseprite.js")).default;
                file = BinaryStream(data.slice(0, data.byteLength), false);
                file.goto(0);
                let result = Aseprite.detect(file);
                if (result){
                    let data = Aseprite.parse(file);
                    if (data && data.image){
                        next({
                            image: data.image,
                            type: "ASEPRITE",
                            data: data,
                        });
                    }else{
                        next(false);
                    }
                }else{
                    next(false);
                }
            } else if (ext === "pcx") {
                let PCX = (await import("./pcx.js")).default;
                file = BinaryStream(data.slice(0, data.byteLength), false);
                file.goto(0);
                if (PCX.detect(file)) {
                    let parsed = PCX.parse(file);
                    if (parsed && parsed.image) {
                        next({
                            image: parsed.image,
                            type: "PCX",
                            data: parsed,
                        });
                    } else {
                        next(false);
                    }
                } else {
                    next(false);
                }
            } else {
                file = BinaryStream(data.slice(0, data.byteLength), true);
                file.goto(0);
                await detectIFF();
            }

            async function detectIFF() {
                let IFF = (await import("./iff.js")).default;
                let fileType = IFF.detect(file);
                if (fileType) {
                    let data = IFF.parse(file, true, fileType);
                    let img;
                    if (data && data.frames && data.frames.length) {
                        img = data.frames.map((frame) => {
                            //TODO: maybe defer rendering all frames until needed?
                            return IFF.toCanvas(frame);
                        });
                        //img = IFF.toCanvas(data.frames[0]);
                    }else{
                        if (data && data.width) img = IFF.toCanvas(data);
                    }
                    if (img) {
                        next({
                            image: img,
                            type: "IFF",
                            data: data,
                        });
                    } else {
                        next(false);
                    }
                } else {
                    next(false);
                }
            }
        });
    };
    return me;
})();

export default FileDetector;
