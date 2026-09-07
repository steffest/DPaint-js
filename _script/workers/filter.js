// Spec 016 phase 6 live wiring: run the filter-effect compute off the main thread.
// The worker imports the same Effects module the main thread uses (made canvas-factory
// agnostic so it runs on an OffscreenCanvas here), rebuilds the source from transferred
// pixels, applies the exact same filter recipe, and posts the result back as a
// transferable ImageData buffer.
//
// Protocol (matches createPixelJobQueue in ../services/pixelJobs.js):
//   in : { type:"run", jobId, generation, kind, payload:{ width, height, buffer, params } }
//   out: { type:"result", jobId, generation, output:{ buffer, width, height }, byteSize }
//        { type:"error",  jobId, error }
// A "cancel" message is a no-op: the kernel does not yield, so a superseded/cancelled job
// simply runs to completion and the queue rejects its stale result by id+generation.

import Effects from "../ui/effects.js";

// Mirror of effectDialog.renderEffect: apply the parameter set onto targetCtx from src.
function renderEffect(src, targetCtx, p){
    Effects.hold();
    Effects.clear();
    Effects.setSrcTarget(src, targetCtx);
    if (p.brightness != null) Effects.setBrightness(p.brightness);
    if (p.contrast != null) Effects.setContrast(p.contrast);
    if (p.saturation != null) Effects.setSaturation(p.saturation);
    if (p.hue != null) Effects.setHue(p.hue);
    if (p.blur != null) Effects.setBlur(p.blur);
    if (p.sharpen != null) Effects.setSharpen(p.sharpen);
    if (p.texture != null) Effects.setTexture(p.texture);
    if (p.dehaze != null) Effects.setDehaze(p.dehaze);
    if (p.sepia != null) Effects.setSepia(p.sepia);
    if (p.invert != null) Effects.setInvert(p.invert);
    if (p.red != null) Effects.setColorBalance("red", p.red);
    if (p.green != null) Effects.setColorBalance("green", p.green);
    if (p.blue != null) Effects.setColorBalance("blue", p.blue);
    Effects.apply();
}

function runFilter(payload){
    let w = payload.width;
    let h = payload.height;
    let params = payload.params || {};

    // Rebuild the source canvas from the transferred pixel buffer.
    let src = new OffscreenCanvas(w, h);
    let srcCtx = src.getContext("2d");
    srcCtx.putImageData(new ImageData(new Uint8ClampedArray(payload.buffer), w, h), 0, 0);

    let target = new OffscreenCanvas(w, h);
    let targetCtx = target.getContext("2d");
    renderEffect(src, targetCtx, params);

    let out = targetCtx.getImageData(0, 0, w, h);
    return { buffer: out.data.buffer, width: w, height: h };
}

self.onmessage = async function(e){
    let msg = e.data;
    if (!msg) return;
    if (msg.type === "cancel") return; // non-yielding kernel: nothing to interrupt
    if (msg.type !== "run") return;
    try {
        // The pixel fallback used when ctx.filter is unsupported loads asynchronously; the
        // first job can arrive before it settles, so wait for it here.
        await Effects.ready();
        let output = runFilter(msg.payload || {});
        let byteSize = output.width * output.height * 4;
        self.postMessage(
            { type: "result", jobId: msg.jobId, generation: msg.generation, output: output, byteSize: byteSize },
            [output.buffer]
        );
    } catch (err){
        self.postMessage({ type: "error", jobId: msg.jobId, error: (err && err.message) || String(err) });
    }
};
