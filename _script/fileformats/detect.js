import BinaryStream from "../util/binarystream.js";
import AmigaIcon from "./amigaIcon.js";
import IFF from "./iff.js";
import GIF from "./gif.js";
import PNG from "./png.js";

let FileDetector = (function () {
    let me = {};

    me.detect = function (data, name) {
        return new Promise((next) => {
            name = name || "";
            let ext = name.split(".").pop().toLowerCase();
            let file;

            if (ext === "info") {
                file = BinaryStream(data.slice(0, data.byteLength), true);
                file.goto(0);
                // Note: this can be Async!
                AmigaIcon.parse(file, function (icon) {
                    if (icon) {
                        let canvas = AmigaIcon.getImage(icon);
                        let canvas2 = AmigaIcon.getImage(icon, 1);
                        next({
                            image: [canvas, canvas2],
                            type: AmigaIcon.getType(icon),
                        });
                    } else {
                        detectIFF();
                    }
                });
            } else if (ext === "gif"){
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
            } else {
                file = BinaryStream(data.slice(0, data.byteLength), true);
                file.goto(0);
                detectIFF();
            }

            function detectIFF() {
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
