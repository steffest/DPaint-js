let Effects = function(){
    let me = {}
    let filters = {};
    let _src, _target;
    let doApply = true;

    let customFilters = {
        sharpen : function(value){
            sharpen(_target,_target.canvas.width,_target.canvas.height,value);
        },
        red : function(value){
            if (value){
                overlayColor(value>0?"#F50A0A":"#0AF5F5",Math.abs(value/3));
            }
        },
        green : function(value){
            if (value){
                overlayColor(value>0?"#0AF50A":"#F50AF5",Math.abs(value/3));
            }
        },
        blue : function(value){
            if (value){
                overlayColor(value>0?"#0A0AF5":"#F5F50A",Math.abs(value/3));
            }
        }
    }

    me.setBrightness = (value,src,target)=>{
        me.setSrcTarget(src,target);
        value = parseInt(value);
        if (isNaN(value)) value=50;
        filters.brightness = (value+50)/50;
        if (filters.brightness === 1) delete filters.brightness;
        applyFilters();
    }

    me.setContrast = (value,src,target)=>{
        me.setSrcTarget(src,target);
        value = parseInt(value);
        if (isNaN(value)) value=50;
        filters.contrast =  (value+50)/50;
        applyFilters();
    }

    me.setSaturation = (value,src,target)=>{
        me.setSrcTarget(src,target);
        value = parseInt(value);
        if (isNaN(value)) value=50;
        filters.saturate = (value+50)/50;
        applyFilters();
    }

    me.setHue = (value,src,target)=>{
        me.setSrcTarget(src,target)
        filters["hue-rotate"] = value + "deg";
        applyFilters();
    }

    me.setBlur = (value,src,target)=>{
        me.setSrcTarget(src,target)
        filters.blur = (value/5) + "px";
        applyFilters();
    }

    me.setSharpen = (value,src,target)=>{
        me.setSrcTarget(src,target)
        filters.sharpen = (value/100);
        applyFilters();
    }

    me.setSepia = (value,src,target)=>{
        me.setSrcTarget(src,target)
        filters.sepia = (value/100);
        applyFilters();
    }

    me.setInvert = (value,src,target)=>{
        me.setSrcTarget(src,target)
        filters.invert = (value/100);
        applyFilters();
    }

    me.setColorBalance = (channel,value,src,target)=>{
        me.setSrcTarget(src,target);
        value = parseInt(value);
        filters[channel] = value/100;
        applyFilters();
    }

    me.setSrcTarget = (src,target)=>{
        if (src) _src = src;
        if (target) _target = target;
    }

    me.hold = ()=>{
        doApply = false;
    }

    me.apply = ()=>{
        doApply = true;
        applyFilters();
    }

   function applyFilters(){
        if (!doApply) return;

        let filter = "";
        if (_src && _target){
            _target.filter = "none";
            _target.clearRect(0,0,_target.canvas.width,_target.canvas.height);
            _target.drawImage(_src, 0, 0);

            for (let key in filters){
                if (typeof filters[key] !== "undefined"){
                    if (customFilters[key]){
                        customFilters[key](filters[key])
                    }else{
                        filter += key + "(" + filters[key] + ") ";
                    }
                }
            }

            _target.filter = filter;
            _target.drawImage(_target.canvas, 0, 0);
            _target.filter = "none";

        }

   }

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

    function overlayColor(color,amount){
        if (_target && amount){
            _target.globalCompositeOperation = "overlay";
            _target.globalAlpha = amount;
            _target.fillStyle = color;
            _target.fillRect(0,0,_target.canvas.width,_target.canvas.height);
            _target.globalCompositeOperation = "source-over";
            _target.globalAlpha = 1;
        }
    }

    return me;

}();

export default Effects;

