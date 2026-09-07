// Dissolve ("screen door") transparency for palette-locked rendering.
//
// With a locked palette, alpha blending is wrong: blending a 40% layer over a background
// invents colours that are not in the palette, and the quantizer then snaps them to whatever
// happens to be nearest. The retro answer is to keep transparency at 1 bit per pixel: every
// pixel is either fully drawn or fully dropped, chosen by a threshold pattern. The output is
// then made exclusively of real palette colours, and quantization has nothing left to do.
//
// This module owns the patterns and the stencils. It is otherwise dependency-free: give it an
// opacity (0..100), a pattern id and where the target sits in DOCUMENT space, and it punches
// the stencil through a 2D context.
//
// Anchoring matters. The stencil is aligned to the DOCUMENT grid, not to the layer, so a
// tweened layer sliding across the canvas swims through a static pattern instead of dragging
// a crawling set of holes with it. It is also fully deterministic per pixel, so playback and
// export cannot shimmer and baked output always matches the preview.

export const DISSOLVE_PATTERNS = [
    {id: "ordered",    label: "Ordered"},
    {id: "ordered4",   label: "Ordered coarse"},
    {id: "halftone",   label: "Halftone"},
    {id: "noise",      label: "Noise"},
    {id: "horizontal", label: "Horizontal lines"},
    {id: "vertical",   label: "Vertical lines"},
    {id: "voronoi",    label: "Voronoi"},
    {id: "iflighter",  label: "If lighter"},
];

export const DEFAULT_DISSOLVE_PATTERN = "ordered";

// "If lighter" is the odd one out: it is not a threshold pattern at all. Instead of dropping
// pixels by POSITION it drops them by COMPARISON, keeping only the ones that are lighter than
// whatever is already underneath — a 1-bit "lighten", which is the palette-locked answer to a
// lighten blend mode (real blend modes are off under a locked palette because they invent
// colours that are not in it).
//
// It composes with opacity: the comparison decides which pixels are candidates, and the
// opacity stencil then thins them out as usual. There is no separate pattern to pick for that,
// so thresholdMatrix/stencilTile fall through to the default ordered matrix for this id.
export const DISSOLVE_IF_LIGHTER = "iflighter";

// Patterns whose density is FIXED instead of following the layer's opacity. Voronoi is a
// sparse organic speckle at a constant 14%: the cells are the point, not a fade, so a full
// opacity layer still gets holes and moving the opacity slider does not thin it out. (Opacity
// 0 still hides the layer — compositeNodes drops it before any stencil is involved.)
const DISSOLVE_FIXED_DENSITY = {
    voronoi: 14
};

export function isDissolvePattern(id){
    return DISSOLVE_PATTERNS.some(pattern=>pattern.id === id);
}

// The fixed stencil density of `id` in 0..100, or undefined when its density comes from the
// layer's opacity like every ordinary pattern.
export function dissolveDensity(id){
    return DISSOLVE_FIXED_DENSITY[id];
}

// True for the ordinary patterns: more opacity means more pixels, and full opacity means no
// stencil at all. False for the two special cases — a fixed-density pattern and a comparison
// both have work to do at 100%, so anything that skips the stencil when a layer is fully
// opaque has to check this first.
export function dissolveFollowsOpacity(id){
    return !isDissolveComparison(id) && typeof dissolveDensity(id) !== "number";
}

// True for the ids that compare against the destination rather than tiling a matrix. Callers
// that punch a stencil in isolation (baking) have to know the difference: a comparison cannot
// be resolved without the layers below it.
export function isDissolveComparison(id){
    return id === DISSOLVE_IF_LIGHTER;
}

// ── threshold matrices ───────────────────────────────────────────────────────────
// A matrix is {size, values}: `values` holds size*size thresholds in 0..1. A pixel survives
// when its threshold is BELOW the opacity, so raising the opacity only ever adds pixels —
// which is what makes the dissolve look like a smooth fade rather than a reshuffle.

// Classic recursive Bayer ordering: M(2n) = [[4M, 4M+2], [4M+3, 4M+1]].
function bayerRanks(size){
    if (size <= 1) return [0];
    let half = bayerRanks(size / 2);
    let halfSize = size / 2;
    let result = new Array(size * size);
    for (let y = 0; y < halfSize; y++){
        for (let x = 0; x < halfSize; x++){
            let base = half[y * halfSize + x] * 4;
            result[y * size + x] = base;
            result[y * size + x + halfSize] = base + 2;
            result[(y + halfSize) * size + x] = base + 3;
            result[(y + halfSize) * size + x + halfSize] = base + 1;
        }
    }
    return result;
}

// Deterministic hash in 0..1 — no Math.random(), so the same pixel always gets the same
// threshold on every render, every playback pass and every export.
function hash(x, y){
    let n = x * 374761393 + y * 668265263;
    n = (n ^ (n >> 13)) * 1274126177;
    n = n ^ (n >> 16);
    // +0.5 keeps the result strictly inside (0,1), so opacity 0 drops everything and
    // opacity 100 keeps everything, exactly like the ordered matrices
    return (((n >>> 0) % 65536) + 0.5) / 65536;
}

// Spreads `count` ranks over an axis in a scattered (bit-reversed) order, so lines fill in
// evenly as the opacity rises instead of sweeping across from one side.
function scatteredRanks(count){
    let bits = Math.round(Math.log2(count));
    let result = new Array(count);
    for (let i = 0; i < count; i++){
        let reversed = 0;
        for (let b = 0; b < bits; b++){
            if (i & (1 << b)) reversed |= 1 << (bits - 1 - b);
        }
        result[i] = reversed;
    }
    return result;
}

function ranksToMatrix(size, ranks){
    let levels = size * size;
    let values = new Float32Array(levels);
    for (let i = 0; i < levels; i++) values[i] = (ranks[i] + 0.5) / levels;
    return {size: size, values: values};
}

function buildMatrix(id){
    switch (id){
        case "ordered4":
            return ranksToMatrix(4, bayerRanks(4));
        case "halftone": {
            // clustered dot: pixels grow outwards from a centre, the classic print look
            let ranks = [
                12, 5, 6, 13,
                4, 0, 1, 7,
                11, 3, 2, 8,
                15, 10, 9, 14
            ];
            return ranksToMatrix(4, ranks);
        }
        case "noise": {
            // A 64x64 tile is large enough that the repeat is not readable as a grid.
            let size = 64;
            let values = new Float32Array(size * size);
            for (let y = 0; y < size; y++){
                for (let x = 0; x < size; x++) values[y * size + x] = hash(x, y);
            }
            return {size: size, values: values};
        }
        case "horizontal": {
            let size = 8;
            let rows = scatteredRanks(size);
            let values = new Float32Array(size * size);
            for (let y = 0; y < size; y++){
                let threshold = (rows[y] + 0.5) / size;
                for (let x = 0; x < size; x++) values[y * size + x] = threshold;
            }
            return {size: size, values: values};
        }
        case "voronoi": {
            // Organic cells instead of a grid: every pixel takes the threshold of its NEAREST
            // seed, so a whole cell fills or empties as one blob. Distances wrap around the
            // tile edges (toroidal), otherwise the cells break at the seam and the 64px repeat
            // becomes readable as a grid — the very thing the pattern is here to avoid.
            // A 128px tile with cells averaging ~64px: big enough that the repeat is not
            // readable, which a 64px tile at this density was — the lit cells are large clumps,
            // so a short repeat stands out far more than it does for fine-grained noise.
            // Built once and cached, so the ~4M distance tests here cost nothing per frame.
            let size = 128;
            let seedCount = 256;
            let seedX = new Float32Array(seedCount);
            let seedY = new Float32Array(seedCount);
            for (let i = 0; i < seedCount; i++){
                // hash(), not Math.random(): the tile has to be identical on every render,
                // every playback pass and every export.
                seedX[i] = hash(i + 1, 17) * size;
                seedY[i] = hash(i + 1, 31) * size;
            }
            let half = size / 2;
            let owner = new Int32Array(size * size);
            let area = new Int32Array(seedCount);
            for (let y = 0; y < size; y++){
                for (let x = 0; x < size; x++){
                    let best = 0;
                    let bestDistance = Infinity;
                    for (let i = 0; i < seedCount; i++){
                        let dx = Math.abs(x - seedX[i]);
                        if (dx > half) dx = size - dx;
                        let dy = Math.abs(y - seedY[i]);
                        if (dy > half) dy = size - dy;
                        let distance = dx * dx + dy * dy;
                        if (distance < bestDistance){
                            bestDistance = distance;
                            best = i;
                        }
                    }
                    owner[y * size + x] = best;
                    area[best]++;
                }
            }

            // Thresholds are weighted by CELL AREA, not by cell index: a threshold of t has to
            // mean "t of the tile's PIXELS survive", and voronoi cells differ wildly in size,
            // so ranking them by index made 14% of the cells cover only ~9.6% of the tile.
            // Each cell takes the cumulative area fraction at its own midpoint, which makes
            // the density accurate at every level and keeps this a well-behaved matrix.
            //
            // The order they accumulate in is scattered, so a rising density lights up cells
            // from all over the tile rather than sweeping across it.
            let ranks = scatteredRanks(seedCount);
            let byRank = new Array(seedCount);
            for (let i = 0; i < seedCount; i++) byRank[ranks[i]] = i;

            let total = size * size;
            let cellThreshold = new Float32Array(seedCount);
            let accumulated = 0;
            byRank.forEach(cell=>{
                cellThreshold[cell] = (accumulated + area[cell] / 2) / total;
                accumulated += area[cell];
            });

            let values = new Float32Array(size * size);
            for (let i = 0; i < values.length; i++) values[i] = cellThreshold[owner[i]];
            return {size: size, values: values};
        }
        case "vertical": {
            let size = 8;
            let cols = scatteredRanks(size);
            let values = new Float32Array(size * size);
            for (let x = 0; x < size; x++){
                let threshold = (cols[x] + 0.5) / size;
                for (let y = 0; y < size; y++) values[y * size + x] = threshold;
            }
            return {size: size, values: values};
        }
        default:
            return ranksToMatrix(8, bayerRanks(8));
    }
}

let matrixCache = new Map();

export function thresholdMatrix(id){
    let key = isDissolvePattern(id) ? id : DEFAULT_DISSOLVE_PATTERN;
    if (!matrixCache.has(key)) matrixCache.set(key, buildMatrix(key));
    return matrixCache.get(key);
}

// How many distinct densities a pattern can express (its usable opacity resolution).
export function patternLevels(id){
    let matrix = thresholdMatrix(id);
    return matrix.size * matrix.size;
}

// ── stencils ─────────────────────────────────────────────────────────────────────

// A pattern tile for one opacity level: alpha 255 where the pixel survives, 0 where it is
// dropped. Cached per pattern and per whole-percent level, so at most a few hundred tiny
// canvases over the lifetime of the app.
let tileCache = new Map();

export function stencilTile(id, opacity){
    let pattern = isDissolvePattern(id) ? id : DEFAULT_DISSOLVE_PATTERN;
    let fixed = dissolveDensity(pattern);
    if (typeof fixed === "number") opacity = fixed;
    let level = Math.max(0, Math.min(100, Math.round(opacity)));
    let key = pattern + "@" + level;
    if (tileCache.has(key)) return tileCache.get(key);

    let matrix = thresholdMatrix(pattern);
    let size = matrix.size;
    let canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    let ctx = canvas.getContext("2d");
    let image = ctx.createImageData(size, size);
    let data = image.data;
    let threshold = level / 100;
    for (let i = 0; i < size * size; i++){
        // strictly below, so level 0 keeps nothing and level 100 keeps everything
        data[i * 4 + 3] = matrix.values[i] < threshold ? 255 : 0;
    }
    ctx.putImageData(image, 0, 0);
    tileCache.set(key, canvas);
    return canvas;
}

function wrap(value, size){
    return ((Math.round(value) % size) + size) % size;
}

// Rec. 601 luma — the same weighting the dither/threshold code uses, so "lighter" means the
// same thing everywhere in the app.
function luma(r, g, b){
    return r * 0.299 + g * 0.587 + b * 0.114;
}

// Drops every pixel of `ctx` that is not lighter than what sits under it in `destinationCtx`.
// (offsetX, offsetY) is where this context's (0,0) lands in the destination; getImageData pads
// out-of-bounds reads with transparent black, so a layer hanging off the edge needs no special
// case. An empty destination counts as BLACK: with nothing underneath, every pixel is lighter,
// so the layer appears in full rather than vanishing.
//
// The verdict is punched through as a 1-bit mask with destination-in rather than by writing the
// pixels back, which leaves the layer's own RGB values untouched (a putImageData round trip
// re-premultiplies and would nudge partially transparent pixels).
export function applyIfLighter(ctx, destinationCtx, offsetX, offsetY){
    if (!ctx || !destinationCtx) return false;
    let width = ctx.canvas.width;
    let height = ctx.canvas.height;
    if (!width || !height) return false;

    let source = ctx.getImageData(0, 0, width, height).data;
    let below = destinationCtx.getImageData(offsetX || 0, offsetY || 0, width, height).data;

    let mask = document.createElement("canvas");
    mask.width = width;
    mask.height = height;
    let maskCtx = mask.getContext("2d");
    let image = maskCtx.createImageData(width, height);
    let data = image.data;
    for (let i = 0; i < source.length; i += 4){
        let under = below[i + 3] ? luma(below[i], below[i + 1], below[i + 2]) : 0;
        data[i + 3] = luma(source[i], source[i + 1], source[i + 2]) > under ? 255 : 0;
    }
    maskCtx.putImageData(image, 0, 0);

    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(mask, 0, 0);
    ctx.restore();
    return true;
}

// Punches the stencil for `opacity` through everything already drawn in `ctx`.
// originX/originY are the DOCUMENT coordinates of the context's own (0,0), which is what keeps
// the pattern anchored to the document rather than to the layer being drawn.
export function applyDissolve(ctx, opacity, patternId, originX, originY){
    if (!ctx) return false;
    // A fixed-density pattern ignores the layer's opacity, so resolve that BEFORE the
    // early-outs below — otherwise a fully opaque voronoi layer would skip its own stencil.
    let fixed = dissolveDensity(patternId);
    if (typeof fixed === "number") opacity = fixed;
    if (opacity >= 100) return false;            // nothing to drop
    if (opacity <= 0){                           // drop everything
        ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        return true;
    }
    let tile = stencilTile(patternId, opacity);
    let size = tile.width;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "destination-in";
    // Shift the pattern so that document (0,0) lands on the tile's own origin. The fill has to
    // cover the WHOLE context: with destination-in, anything left unfilled is erased.
    ctx.translate(-wrap(originX, size), -wrap(originY, size));
    ctx.fillStyle = ctx.createPattern(tile, "repeat");
    ctx.fillRect(0, 0, ctx.canvas.width + size, ctx.canvas.height + size);
    ctx.restore();
    return true;
}
