// Filter preview quality planning for spec 016 (Editor Performance), phase 6.3, design §7.
//
// A live preview trades accuracy for responsiveness: it renders a REDUCED overview of the
// affected region while dragging and only the EXACT result when settled or on Apply. The
// approximation must be honest and geometrically stable. This module is the pure planning
// math (no pixels, no canvas):
//
//   - SOURCE selection: pointwise/local ops can preview a cropped overview; a `global` or
//     error-`diffusion` op cannot be cropped for an EXACT result (diffusion retains full
//     scan dependencies), so exact evaluates the whole selection;
//   - kernel halo + RADIUS SCALING: a local kernel's radius scales with the overview factor
//     so the blurred neighbourhood stays proportional;
//   - DOCUMENT-SPACE dither phase: the ordered/blue-noise matrix is indexed by absolute
//     document coordinates so a panned/zoomed preview does not shimmer;
//   - SELECTION-MASK merge: the write region is the crop intersected with the mask bounds;
//   - EXACT Apply is never approximate and produces exactly ONE atomic history commit
//     (the commit itself is owned by filterSession.js).
//
// Ordered/blue-noise dithering is explicitly labelled a preview approximation; exact nearest
// mapping with the committed tie policy is the Apply default and a coarse LUT can never
// claim to be exact.

export const FILTER_DEPENDENCY = { POINTWISE: "pointwise", LOCAL: "local", GLOBAL: "global", DIFFUSION: "diffusion" };

function intersect(a, b) {
    if (!a) return b ? Object.assign({}, b) : null;
    if (!b) return Object.assign({}, a);
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const x1 = Math.min(a.x + a.width, b.x + b.width);
    const y1 = Math.min(a.y + a.height, b.y + b.height);
    if (x1 <= x || y1 <= y) return null;
    return { x, y, width: x1 - x, height: y1 - y };
}

function clampToDoc(rect, docWidth, docHeight) {
    if (!rect) return null;
    const x = Math.max(0, Math.floor(rect.x));
    const y = Math.max(0, Math.floor(rect.y));
    const x1 = Math.min(docWidth, Math.ceil(rect.x + rect.width));
    const y1 = Math.min(docHeight, Math.ceil(rect.y + rect.height));
    if (x1 <= x || y1 <= y) return null;
    return { x, y, width: x1 - x, height: y1 - y };
}

// The halo (in document pixels) a kernel reads outside the write region.
export function kernelHalo(kernel) {
    kernel = kernel || {};
    switch (kernel.dependency) {
        case FILTER_DEPENDENCY.LOCAL: return Math.max(0, Math.ceil(kernel.radius || 0));
        case FILTER_DEPENDENCY.GLOBAL:
        case FILTER_DEPENDENCY.DIFFUSION: return Infinity; // needs the whole scan / whole image
        case FILTER_DEPENDENCY.POINTWISE:
        default: return 0;
    }
}

// Scale a local kernel radius to an overview factor. Never below 1 for a non-zero radius so
// a local op stays local at low resolution.
export function scaleRadius(radius, scale) {
    if (!(radius > 0)) return 0;
    if (!(scale > 1)) return radius;
    return Math.max(1, Math.round(radius / scale));
}

// The overview downscale factor so the cropped region fits a pixel budget. 1 = full res.
export function overviewScale(cropArea, budgetPixels) {
    if (!(budgetPixels > 0) || !(cropArea > budgetPixels)) return 1;
    return Math.max(1, Math.ceil(Math.sqrt(cropArea / budgetPixels)));
}

// Document-space dither phase for a crop: the ordered matrix is addressed by absolute doc
// coordinates, so the phase is the crop origin modulo the matrix size.
export function ditherPhase(cropRect, matrixSize) {
    matrixSize = matrixSize || 1;
    return {
        x: ((cropRect.x % matrixSize) + matrixSize) % matrixSize,
        y: ((cropRect.y % matrixSize) + matrixSize) % matrixSize,
    };
}

// The effective write region = crop ∩ selection-mask bounds.
export function maskedWriteRegion(cropRect, maskBounds) {
    return intersect(cropRect, maskBounds);
}

// Plan a PREVIEW: reduced overview for pointwise/local; approximate dither labelled honestly.
// spec: { docWidth, docHeight, selection, viewport, mask, kernel, budgetPixels, matrixSize }
export function planPreview(spec) {
    spec = spec || {};
    const kernel = spec.kernel || {};
    const dep = kernel.dependency || FILTER_DEPENDENCY.POINTWISE;
    const matrixSize = spec.matrixSize || 4;

    // The base region: selection, cropped to the viewport for local/pointwise ops; a global
    // op cannot be cropped (it reads the whole image), so it uses the whole selection.
    let base;
    if (dep === FILTER_DEPENDENCY.GLOBAL || dep === FILTER_DEPENDENCY.DIFFUSION) base = spec.selection;
    else base = intersect(spec.selection, spec.viewport) || spec.selection;

    const halo = kernelHalo(kernel);
    let region = base ? Object.assign({}, base) : { x: 0, y: 0, width: spec.docWidth, height: spec.docHeight };
    if (halo !== Infinity && halo > 0) region = { x: region.x - halo, y: region.y - halo, width: region.width + halo * 2, height: region.height + halo * 2 };
    const crop = clampToDoc(region, spec.docWidth, spec.docHeight);
    if (!crop) return { empty: true };

    const cropArea = crop.width * crop.height;
    const scale = overviewScale(cropArea, spec.budgetPixels);
    const scaledRadius = scaleRadius(kernel.radius, scale);

    // A preview is approximate when it is downscaled OR uses a labelled dither approximation
    // (ordered/blue-noise standing in for exact error diffusion).
    const usesApproxDither = dep === FILTER_DEPENDENCY.DIFFUSION && (spec.previewDither || "ordered") !== "error-diffusion";
    const approximate = scale > 1 || usesApproxDither;

    return {
        empty: false,
        mode: "preview",
        source: scale > 1 ? "overview" : "exact-region",
        scale,
        crop,
        halo,
        scaledRadius,
        ditherPhase: ditherPhase(crop, matrixSize),
        writeRegion: maskedWriteRegion(crop, spec.mask && spec.mask.bounds),
        approximate,
        status: approximate ? "approximate" : "exact",
        previewDither: usesApproxDither ? (spec.previewDither || "ordered") : null,
    };
}

// Plan an APPLY: exact, full-resolution, one atomic history commit. Global/diffusion ops
// evaluate the whole selection (no crop); the dither is the exact committed method.
export function planApply(spec) {
    spec = spec || {};
    const kernel = spec.kernel || {};
    const dep = kernel.dependency || FILTER_DEPENDENCY.POINTWISE;
    const crop = clampToDoc(spec.selection || { x: 0, y: 0, width: spec.docWidth, height: spec.docHeight }, spec.docWidth, spec.docHeight);
    if (!crop) return { empty: true };
    const matrixSize = spec.matrixSize || 4;
    const needsFullScan = dep === FILTER_DEPENDENCY.GLOBAL || dep === FILTER_DEPENDENCY.DIFFUSION;
    return {
        empty: false,
        mode: "apply",
        source: "exact",
        scale: 1,
        crop,
        halo: needsFullScan ? Infinity : kernelHalo(kernel),
        scaledRadius: kernel.radius || 0,
        ditherPhase: ditherPhase(crop, matrixSize),
        writeRegion: maskedWriteRegion(crop, spec.mask && spec.mask.bounds),
        approximate: false,
        status: "exact",
        ditherMethod: dep === FILTER_DEPENDENCY.DIFFUSION ? "error-diffusion" : (kernel.ditherMethod || "none"),
        commits: 1, // exactly one atomic history commit for an Apply
    };
}
