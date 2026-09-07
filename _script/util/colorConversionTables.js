// Exact channel conversion tables for spec 016 (Editor Performance), design §6, R4.
//
// The CPU quantizer (util/imageProcessing.js remapImage) converts every pixel and
// palette channel between sRGB and linear-ish RGB with `Math.pow(v/255, γ)*255`,
// once per channel per pixel. Those calls whose input is an integer byte (0..255)
// are the overwhelming majority (source pixels + palette setup) and always produce
// the same 256 results, so they are memoised into Float64 lookup tables.
//
// Float64 (not Float32) is deliberate: the tables must equal the original
// expression bit-for-bit so nearest-colour distances and comparisons are
// unchanged (design §6: "Use Float64 conversion tables when Float32 rounding
// changes current comparisons"). Callers with NON-integer intermediates (ordered
// Bayer offsets, error-diffusion residuals) must keep calling the exact formula —
// a byte-indexed table cannot represent fractional inputs.

const GAMMA = 2.2;

// The canonical scalar forms — identical to imageProcessing.js. Exported so callers
// can fall back to the exact formula for non-integer inputs.
export function rgbToSrgb(channel) {
    return Math.pow(channel / 255, 1 / GAMMA) * 255;
}
export function srgbToRgb(channel) {
    return Math.pow(channel / 255, GAMMA) * 255;
}

function buildTable(fn) {
    const table = new Float64Array(256);
    for (let i = 0; i < 256; i++) table[i] = fn(i);
    return table;
}

// 256-entry Float64 tables. table[i] === fn(i) exactly for every integer i in 0..255.
export const SRGB_TO_RGB = buildTable(srgbToRgb);
export const RGB_TO_SRGB = buildTable(rgbToSrgb);

// Convenience lookups. The input MUST be an integer byte 0..255; fractional inputs
// are a caller error and should use the scalar formula instead.
export function srgbToRgbByte(i) { return SRGB_TO_RGB[i]; }
export function rgbToSrgbByte(i) { return RGB_TO_SRGB[i]; }
