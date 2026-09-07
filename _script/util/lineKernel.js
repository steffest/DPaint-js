// Clipped Bresenham line/stamp kernel for spec 016 (Editor Performance), design §6, R4.
//
// Extracted from ui/canvas.js bLine_. The original stamped a square brush along a
// Bresenham line by writing `data[(y*width+x)*4]` with NO bounds check: a negative
// x wraps into the previous row and a large x/y runs off the buffer, so drawing a
// line past the image edge corrupted unrelated pixels. This kernel keeps the exact
// same integer arithmetic and stamp order — so every in-bounds pixel is written
// byte-for-byte identically — but clips each stamped pixel to the image, which is
// the only observable change (design §6: "Clip active bLine_/shape paths … honour
// negative/clipped coordinates").
//
// It writes into a caller-provided RGBA byte buffer and honours a typed-array
// byteOffset via the standard subarray contract, so callers can reuse scratch.

// Stamp a thick line into `data` (RGBA, row-major, length width*height*4).
// color is [r,g,b] (alpha is forced to 255, matching the original). lineWidth is
// the square brush size; values < 1 clamp to 1. Returns the number of pixels
// actually written (in-bounds), useful for damage accounting.
export function stampLine(options) {
    const data = options.data;
    const width = options.width | 0;
    const height = options.height | 0;
    const color = options.color;
    let x0 = options.x0 | 0, y0 = options.y0 | 0;
    const x1 = options.x1 | 0, y1 = options.y1 | 0;

    let lineWidth = options.lineWidth || 1;
    if (lineWidth < 1) lineWidth = 1;

    const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    const dy = Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    let err = (dx > dy ? dx : -dy) / 2;

    // Identical to the original, including parseInt truncation of lineWidth.
    const lineStart = 0 - Math.floor(lineWidth / 2);
    const lineEnd = parseInt(lineWidth) + lineStart;

    const r = color[0], g = color[1], b = color[2];
    let written = 0;

    function drawPixel(x, y) {
        if (x < 0 || y < 0 || x >= width || y >= height) return; // clip (the fix)
        const n = (y * width + x) * 4;
        data[n] = r;
        data[n + 1] = g;
        data[n + 2] = b;
        data[n + 3] = 255;
        written++;
    }

    while (true) {
        for (let i = lineStart; i < lineEnd; i++) {
            for (let j = lineStart; j < lineEnd; j++) {
                drawPixel(x0 + i, y0 + j);
            }
        }
        if (x0 === x1 && y0 === y1) break;
        const e2 = err;
        if (e2 > -dx) { err -= dy; x0 += sx; }
        if (e2 < dy) { err += dx; y0 += sy; }
    }
    return written;
}

// The bounding rectangle a stampLine call would touch, clipped to the image, or
// null if entirely off-image. Half-open integer bounds (design §4) for damage.
export function stampLineBounds(options) {
    const width = options.width | 0;
    const height = options.height | 0;
    let lineWidth = options.lineWidth || 1;
    if (lineWidth < 1) lineWidth = 1;
    const lineStart = 0 - Math.floor(lineWidth / 2);
    const lineEnd = parseInt(lineWidth) + lineStart; // exclusive upper stamp offset

    const x0 = options.x0 | 0, y0 = options.y0 | 0, x1 = options.x1 | 0, y1 = options.y1 | 0;
    let minX = Math.min(x0, x1) + lineStart;
    let minY = Math.min(y0, y1) + lineStart;
    let maxX = Math.max(x0, x1) + (lineEnd - 1); // last stamped column
    let maxY = Math.max(y0, y1) + (lineEnd - 1);

    minX = Math.max(0, minX); minY = Math.max(0, minY);
    maxX = Math.min(width - 1, maxX); maxY = Math.min(height - 1, maxY);
    if (maxX < minX || maxY < minY) return null;
    return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}
