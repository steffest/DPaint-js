import * as StackBlur from "../util/stackBlur.js";

let Effects = function(){
    let me = {}
    let filters = {};
    let _src, _target;
    let maskCanvas;
    let doApply = true;

    let customFilters = {
        sharpen : function(value){
            sharpen(_target,_target.canvas.width,_target.canvas.height,value);
        },
        blur : function(value){
            StackBlur.canvasRGBA(_target.canvas,0,0,_target.canvas.width,_target.canvas.height,value);
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

    me.clear = ()=>{
        filters = {};
        maskCanvas = null;
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
        //filters.blur = (value/5) + "px";
        filters.blur = (value/2);
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
        createMask();
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

    me.feather = function(ctx,amount){
        let w = ctx.canvas.width;
        let h = ctx.canvas.height;
        let data = ctx.getImageData(0,0,w,h);
        let d = data.data;
        let target = [];

        if (amount>0){
            function onEdge(index){
                return d[index+3] === 0;
            }

            for (let y=0; y<h; y++){
                for (let x=0; x<w; x++){
                    let index = (y*w + x) * 4;
                    let alpha = d[index+3];
                    if (alpha){
                        let isOnEdge = onEdge(index-4) || onEdge(index+4) || onEdge(index-(w*4)) || onEdge(index+(w*4));
                        if (isOnEdge) target.push(index);
                    }
                }
            }

            target.forEach(index=>{
                d[index+3] = d[index+3]>>1;
            });
            ctx.putImageData(data,0,0);
        }else{
            let alphaIncrease = -amount*100;
            for (let y=0; y<h; y++){
                for (let x=0; x<w; x++){
                    let index = (y*w + x) * 4;
                    let alpha = d[index+3];
                    if (alpha<255 && alpha>0){
                        alpha = Math.min(255,alpha+=alphaIncrease);
                        d[index+3] = alpha;
                    }
                }
            }
            ctx.putImageData(data,0,0);
        }

    }

    me.outline = function(ctx,color){
        let w = ctx.canvas.width;
        let h = ctx.canvas.height;
        let data = ctx.getImageData(0,0,w,h);
        let d = data.data;
        let target = [];

        function checkPixel(index){
            if (d[index+3] === 0){
                target.push(index);
            }
        }

        for (let y=1; y<h-1; y++){
            for (let x=1; x<w-1; x++){
                let index = (y*w + x) * 4;
                let alpha = d[index+3];
                if (alpha){
                    checkPixel(index-4);
                    checkPixel(index+4);
                    checkPixel(index-(w*4));
                    checkPixel(index+(w*4));
                }
            }
        }

        if (color){
            target.forEach(index=>{
                d[index] = color[0];
                d[index+1] = color[1];
                d[index+2] = color[2];
                d[index+3] = 255;
            });
            target=[];
            ctx.putImageData(data,0,0);
        }else{
            return target;
        }

    }

    me.getFilters = (target)=>{
        _target = target;
        return customFilters;
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

            if (maskCanvas){
                _target.globalCompositeOperation = "destination-in";
                _target.drawImage(maskCanvas,0,0);
                _target.globalCompositeOperation = "source-over";
            }
        }
    }

    function createMask(){
        if (!_src){
            console.error("no source for mask");
            return;
        }

        if (!maskCanvas){
            maskCanvas = document.createElement("canvas");
            maskCanvas.width = _src.width;
            maskCanvas.height = _src.height;
            let maskCtx = maskCanvas.getContext("2d");
            let maskData = _src.getContext("2d").getImageData(0,0,maskCanvas.width,maskCanvas.height);
            maskCtx.fillStyle = "black";
            maskCtx.fillRect(0,0,maskCanvas.width,maskCanvas.height);
            let mask = maskData.data;
            for (let i = 0; i<mask.length; i+=4){
                if (mask[i+3] === 0){
                    mask[i] = 255;
                    mask[i+1] = 255;
                    mask[i+2] = 255;
                }
            }
            maskCtx.putImageData(maskData,0,0);
            console.log("mask created");
        }
    }

    return me;

}();

export default Effects;

