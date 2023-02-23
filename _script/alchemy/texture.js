/* Attempt to mimic the "texture" effect in Adobe Camera RAW
*  Experimental and cpu intensive - might crash from time to time
*  Steffest
* */

let process = function(source,target){
    let w = source.width;
    let h = source.height;
    function sharpen(ctx, w, h, mix){
        var x, sx, sy, r, g, b, a, dstOff, srcOff, wt, cx, cy, scy, scx,
            weights = [0, -1, 0, -1, 5, -1, 0, -1, 0],
            katet = Math.round(Math.sqrt(weights.length)),
            half = (katet * 0.5) | 0,
            dstData = ctx.createImageData(w, h),
            dstBuff = dstData.data,
            srcBuff = ctx.getImageData(0, 0, w, h).data,
            y = h;
        while (y--) {
            x = w;
            while (x--) {
                sy = y;
                sx = x;
                dstOff = (y * w + x) * 4;
                r = 0;
                g = 0;
                b = 0;
                a = 0;
                if(x>0 && y>0 && x<w-1 && y<h-1) {
                    for (cy = 0; cy < katet; cy++) {
                        for (cx = 0; cx < katet; cx++) {
                            scy = sy + cy - half;
                            scx = sx + cx - half;

                            if (scy >= 0 && scy < h && scx >= 0 && scx < w) {
                                srcOff = (scy * w + scx) * 4;
                                wt = weights[cy * katet + cx];

                                r += srcBuff[srcOff] * wt;
                                g += srcBuff[srcOff + 1] * wt;
                                b += srcBuff[srcOff + 2] * wt;
                                a += srcBuff[srcOff + 3] * wt;
                            }
                        }
                    }

                    dstBuff[dstOff] = r * mix + srcBuff[dstOff] * (1 - mix);
                    dstBuff[dstOff + 1] = g * mix + srcBuff[dstOff + 1] * (1 - mix);
                    dstBuff[dstOff + 2] = b * mix + srcBuff[dstOff + 2] * (1 - mix);
                    dstBuff[dstOff + 3] = srcBuff[dstOff + 3];
                } else {
                    dstBuff[dstOff] = srcBuff[dstOff];
                    dstBuff[dstOff + 1] = srcBuff[dstOff + 1];
                    dstBuff[dstOff + 2] = srcBuff[dstOff + 2];
                    dstBuff[dstOff + 3] = srcBuff[dstOff + 3];
                }
            }
        }

        ctx.putImageData(dstData, 0, 0);
    }

}

export default process;