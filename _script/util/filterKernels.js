// Heavy exact filter kernels for spec 016 (Editor Performance), phase 6.4, design §7.
//
// The exact (Apply-time) heavy operations, extracted as pure functions so they run in a
// worker without DOM access and are byte-for-byte reference-verifiable. What matters here:
//
//   - exact nearest-colour REMAP with a deterministic tie policy (lowest index wins) — the
//     committed default that a coarse preview LUT can never claim to equal;
//   - error DIFFUSION whose error state threads ACROSS row chunks, so a chunked worker run
//     is identical to a whole-image run (the whole reason a naive per-chunk reset is wrong);
//   - a local blur whose per-region evaluation reads its HALO from the immutable source, so
//     any tiling produces the same pixels as the whole;
//   - capability-based implementation selection with a safe fallback, and explicit exclusion
//     of DOM-dependent recipes from the worker path.
//
// Reuses the existing quantization palette convention (array of [r,g,b]); it does not
// re-implement the app's quantizers, it provides the exact per-pixel primitives the worker
// and the settled preview share.

// Exact nearest palette index by squared RGB distance. Ties resolve to the LOWEST index so
// the mapping is deterministic and matches the committed Apply result.
export function nearestIndex(r, g, b, palette) {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < palette.length; i++) {
        const p = palette[i];
        const dr = r - p[0], dg = g - p[1], db = b - p[2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD) { bestD = d; best = i; } // strict < keeps the first (lowest) index on a tie
    }
    return best;
}

// Exact remap of an RGBA buffer to palette indices (alpha ignored, preserved by the caller).
export function remapToPalette(pixels, palette) {
    const n = pixels.length >> 2;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        const b = i << 2;
        out[i] = nearestIndex(pixels[b], pixels[b + 1], pixels[b + 2], palette);
    }
    return out;
}

function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

// Floyd–Steinberg error diffusion whose error state PERSISTS across processRow calls, so a
// worker can process the image in row chunks and still get the exact whole-image result.
// createErrorDiffusion({ width, palette }) -> { reset, processRow(y, srcPixels, indexOut) }.
export function createErrorDiffusion(options) {
    options = options || {};
    const width = options.width | 0;
    const palette = options.palette;
    // Per-channel error carried into the current row (errCurr) and the next row (errNext).
    let errCurr = new Float32Array(width * 3);
    let errNext = new Float32Array(width * 3);

    function reset() { errCurr = new Float32Array(width * 3); errNext = new Float32Array(width * 3); }

    function processRow(y, srcPixels, indexOut) {
        for (let x = 0; x < width; x++) {
            const base = (y * width + x) << 2;
            const e = x * 3;
            const r = clamp255(srcPixels[base] + errCurr[e]);
            const g = clamp255(srcPixels[base + 1] + errCurr[e + 1]);
            const b = clamp255(srcPixels[base + 2] + errCurr[e + 2]);
            const idx = nearestIndex(r, g, b, palette);
            indexOut[y * width + x] = idx;
            const p = palette[idx];
            const er = r - p[0], eg = g - p[1], eb = b - p[2];
            if (x + 1 < width) { const n = (x + 1) * 3; errCurr[n] += er * 7 / 16; errCurr[n + 1] += eg * 7 / 16; errCurr[n + 2] += eb * 7 / 16; }
            if (x - 1 >= 0) { const n = (x - 1) * 3; errNext[n] += er * 3 / 16; errNext[n + 1] += eg * 3 / 16; errNext[n + 2] += eb * 3 / 16; }
            { const n = x * 3; errNext[n] += er * 5 / 16; errNext[n + 1] += eg * 5 / 16; errNext[n + 2] += eb * 5 / 16; }
            if (x + 1 < width) { const n = (x + 1) * 3; errNext[n] += er * 1 / 16; errNext[n + 1] += eg * 1 / 16; errNext[n + 2] += eb * 1 / 16; }
        }
        // The next row's incoming error becomes current; clear the row after it.
        const t = errCurr; errCurr = errNext; errNext = t; errNext.fill(0);
    }

    return { reset, processRow, get errorState() { return { curr: errCurr.slice(), next: errNext.slice() }; } };
}

// Convenience whole-image error diffusion (reference for the chunked path).
export function diffuseWhole(pixels, width, height, palette) {
    const runner = createErrorDiffusion({ width, palette });
    const out = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) runner.processRow(y, pixels, out);
    return out;
}

// Exact separable box blur of a REGION, reading its vertical/horizontal halo from the
// immutable source. Any tiling of the output region yields identical pixels because each
// tile reads the neighbourhood it needs from `src`, never from a partially-written buffer.
// region = { x, y, width, height } within the src of size srcW×srcH. Returns RGBA for region.
export function blurRegion(src, srcW, srcH, radius, region) {
    radius = Math.max(0, radius | 0);
    const rw = region.width, rh = region.height;
    const out = new Uint8ClampedArray(rw * rh * 4);
    const k = radius * 2 + 1;
    // Horizontal pass into a padded scratch covering region rows plus vertical halo.
    const padTop = Math.max(0, region.y - radius);
    const padBot = Math.min(srcH, region.y + rh + radius);
    const scratchRows = padBot - padTop;
    const scratch = new Float32Array(rw * scratchRows * 4);
    for (let sy = 0; sy < scratchRows; sy++) {
        const srcY = padTop + sy;
        for (let ox = 0; ox < rw; ox++) {
            let ar = 0, ag = 0, ab = 0, aa = 0;
            for (let dx = -radius; dx <= radius; dx++) {
                let sx = region.x + ox + dx;
                if (sx < 0) sx = 0; else if (sx >= srcW) sx = srcW - 1;
                const b = (srcY * srcW + sx) << 2;
                ar += src[b]; ag += src[b + 1]; ab += src[b + 2]; aa += src[b + 3];
            }
            const o = (sy * rw + ox) << 2;
            scratch[o] = ar / k; scratch[o + 1] = ag / k; scratch[o + 2] = ab / k; scratch[o + 3] = aa / k;
        }
    }
    // Vertical pass over the scratch, clamping to the scratch (== source) extent.
    for (let oy = 0; oy < rh; oy++) {
        const scratchY = (region.y + oy) - padTop;
        for (let ox = 0; ox < rw; ox++) {
            let ar = 0, ag = 0, ab = 0, aa = 0;
            for (let dy = -radius; dy <= radius; dy++) {
                let sy = scratchY + dy;
                if (sy < 0) sy = 0; else if (sy >= scratchRows) sy = scratchRows - 1;
                const b = (sy * rw + ox) << 2;
                ar += scratch[b]; ag += scratch[b + 1]; ab += scratch[b + 2]; aa += scratch[b + 3];
            }
            const o = (oy * rw + ox) << 2;
            out[o] = ar / k; out[o + 1] = ag / k; out[o + 2] = ab / k; out[o + 3] = aa / k;
        }
    }
    return out;
}

// A recipe is DOM-dependent (and thus excluded from the worker) if it relies on canvas
// filter strings, 2D-context features, or other main-thread-only APIs.
export function isDomDependentRecipe(recipe) {
    if (!recipe) return false;
    return !!(recipe.usesCanvasFilter || recipe.usesDom || recipe.contextFilter);
}

// Choose the implementation for a recipe given detected capabilities. Falls back safely:
// a DOM-dependent recipe or a missing OffscreenCanvas forces the main-thread chunked path.
export function selectImplementation(caps, recipe) {
    caps = caps || {};
    if (isDomDependentRecipe(recipe)) return { impl: "main", reason: "dom-dependent" };
    if (caps.webgl2 && recipe && recipe.gpuEligible) return { impl: "gpu", reason: "gpu-eligible" };
    if (caps.worker && caps.offscreenCanvas !== false) return { impl: "worker", reason: "worker" };
    return { impl: "main", reason: caps.worker ? "no-offscreen" : "no-worker" };
}
