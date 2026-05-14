// Atari ST DEGAS / DEGAS Elite / NeoChrome uncompressed bitmap formats
//
// DEGAS (.PI1/.PI2/.PI3):
//   2-byte resolution | 32-byte palette | 32000-byte interleaved bitplane body
//   Optional 32-byte DEGAS Elite animation trailer is ignored.
//
// NeoChrome (.NEO):
//   128-byte header (flag word | resolution word | 32-byte palette | metadata)
//   followed by the same 32000-byte interleaved bitplane body.
//
// Resolution values → screen mode:
//   0 = low  (320×200, 4 bitplanes, 16 colours)
//   1 = medium (640×200, 2 bitplanes, 4 colours)
//   2 = high   (640×400, 1 bitplane,  2 colours)

const DEGAS = (function () {
    let me = {};

    const MODES = {
        0: { width: 320, height: 200, planes: 4 },
        1: { width: 640, height: 200, planes: 2 },
        2: { width: 640, height: 400, planes: 1 },
    };

    function expand3(v) {
        // 3-bit Atari ST colour component (0–7) → 8-bit
        return (v << 5) | (v << 2) | (v >> 1);
    }

    function readPalette(file) {
        let palette = [];
        for (let i = 0; i < 16; i++) {
            let word = file.readWord();
            palette.push([
                expand3((word >> 8) & 0x7),
                expand3((word >> 4) & 0x7),
                expand3(word & 0x7),
            ]);
        }
        return palette;
    }

    function decodePixels(file, width, height, planes) {
        let wordsPerLine = width / 16;
        let pixels = new Uint8Array(width * height);
        for (let y = 0; y < height; y++) {
            for (let g = 0; g < wordsPerLine; g++) {
                let pw = [];
                for (let p = 0; p < planes; p++) pw[p] = file.readWord();
                for (let b = 15; b >= 0; b--) {
                    let x = g * 16 + (15 - b);
                    let idx = 0;
                    for (let p = 0; p < planes; p++) idx |= ((pw[p] >> b) & 1) << p;
                    pixels[y * width + x] = idx;
                }
            }
        }
        return pixels;
    }

    function buildCanvas(pixels, palette, width, height) {
        let canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        let ctx = canvas.getContext("2d");
        let imageData = ctx.createImageData(width, height);
        let d = imageData.data;
        for (let i = 0; i < pixels.length; i++) {
            let c = palette[pixels[i]];
            d[i * 4]     = c[0];
            d[i * 4 + 1] = c[1];
            d[i * 4 + 2] = c[2];
            d[i * 4 + 3] = 255;
        }
        ctx.putImageData(imageData, 0, 0);
        return canvas;
    }

    // --- DEGAS (.PI1 / .PI2 / .PI3) ---

    me.detect = function (file) {
        if (file.length < 34) return false;
        file.goto(0);
        let res = file.readWord();
        return res === 0 || res === 1 || res === 2;
    };

    me.parse = function (file) {
        file.goto(0);
        let res = file.readWord();
        let mode = MODES[res];
        if (!mode) return null;
        let { width, height, planes } = mode;
        let palette = readPalette(file);
        let pixels = decodePixels(file, width, height, planes);
        return { image: buildCanvas(pixels, palette, width, height), palette, width, height };
    };

    // --- NeoChrome (.NEO) ---

    me.detectNeo = function (file) {
        if (file.length < 128 + 32000) return false;
        file.goto(0);
        let flag = file.readWord();
        if (flag !== 0) return false;
        let res = file.readWord();
        return res === 0 || res === 1 || res === 2;
    };

    me.parseNeo = function (file) {
        file.goto(0);
        let flag = file.readWord();
        if (flag !== 0) return null;
        let res = file.readWord();
        let mode = MODES[res];
        if (!mode) return null;
        let { width, height, planes } = mode;
        let palette = readPalette(file); // bytes 4–35
        file.goto(128);                  // skip metadata, jump to pixel data
        let pixels = decodePixels(file, width, height, planes);
        return { image: buildCanvas(pixels, palette, width, height), palette, width, height };
    };

    return me;
})();

export default DEGAS;
