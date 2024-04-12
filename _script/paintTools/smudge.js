import ImageFile from "../image.js";
import EventBus from "../util/eventbus.js";
import {EVENT} from "../enum.js";
import Brush from "../ui/brush.js";
import Palette from "../ui/palette.js";
import Color from "../util/color.js";
import {duplicateCanvas} from "../util/canvasUtils.js";
import DitherPanel from "../ui/toolPanels/ditherPanel.js";
import ToolOptions from "../ui/components/toolOptions.js";
import effects from "../ui/effects.js";

// somewhat based on https://stackoverflow.com/questions/28197378/html5-canvas-javascript-smudge-brush-tool

let Smudge = function(){
    let me = {};

    let lastForce = 1;
    let alpha = 0.5;
    let hardness = 0.01;
    let radius = 10;
    const brushCtx = document.createElement('canvas').getContext('2d');
    let composeCtx = document.createElement('canvas').getContext('2d');
    let featherGradient;
    let ctx;
    let lastX;
    let lastY;
    let doBlur = false;
    let doSharpen = false;
    let filters;
    let dither = false;
    let workingCtx;

    me.start = function(touchData){
        touchData.isSmudging = true;
        touchData.drawLayer = ImageFile.getActiveLayer();
        ctx = touchData.drawLayer.getContext();
        let {x,y} = touchData;

        lastX = x;
        lastY = y;
        lastForce = touchData.force || 1;


         let settings = Brush.getSettings();
            alpha = settings.opacity/100;
            hardness = 1-(settings.softness/10);
            radius = settings.width;
            if (isNaN(hardness)) hardness = 0.01;
            if (radius<2) radius = 2;

        updateBrushSettings();
        doBlur = ToolOptions.getSmudgeAction() === "blur";
        doSharpen = ToolOptions.getSmudgeAction() === "sharpen";
        if (doBlur || doSharpen){
            filters = effects.getFilters(brushCtx);
            workingCtx = duplicateCanvas(ctx.canvas,true).getContext("2d");
        }
        dither = DitherPanel.getDitherState();
    }

    me.draw = function(touchData){
        if (!touchData.isSmudging) {
            return;
        }
        let {x,y,force} = touchData;
        force = force || 1;
        let tempCtx;
        if (Palette.isLocked()){
            let tempCanvas = duplicateCanvas(brushCtx.canvas);
            tempCtx = tempCanvas.getContext("2d");
        }

        let w = brushCtx.canvas.width;
        let h = brushCtx.canvas.height;


        const line = setupLine(lastX, lastY,x, y);
        for (let more = true; more;) {
            more = advanceLine(line);
            if (doBlur) more = false;

            let x = line.position[0] - brushCtx.canvas.width / 2;
            let y = line.position[1] - brushCtx.canvas.height / 2;
            x = Math.floor(x);
            y = Math.floor(y);



            if (doBlur || doSharpen){
                brushCtx.clearRect(0,0,w,h);
                brushCtx.drawImage(workingCtx.canvas, x,y,w,h,0,0,w,h);
                if (doBlur){
                    let s = ToolOptions.getStrength() * 10;
                    if (s>w) s = w;
                    if (s<1) s = 1;
                    filters.blur(s);
                }
                if (doSharpen) filters.sharpen(ToolOptions.getStrength());
                feather(brushCtx);
                composeCtx.clearRect(0,0,w,h);
                composeCtx.globalAlpha = ToolOptions.getStrength();
                composeCtx.drawImage(brushCtx.canvas, 0, 0);
                composeCtx.globalAlpha = 1;
            }else{
                composeCtx.globalAlpha = ToolOptions.getStrength();
                composeCtx.globalCompositeOperation='copy';
                composeCtx.drawImage(composeCtx.canvas, 0,0);
                composeCtx.globalCompositeOperation = "source-over";

                composeCtx.globalAlpha = alpha * lerp(lastForce, force, line.u);
                composeCtx.drawImage(brushCtx.canvas, 0, 0);
                composeCtx.globalAlpha = 1;
            }


            if (dither){
                let pattern = DitherPanel.getDitherPattern();
                composeCtx.globalCompositeOperation = "destination-in";
                composeCtx.drawImage(pattern,x,y,w,h,0,0,w,h);
                composeCtx.globalCompositeOperation = "source-over";
                ctx.drawImage(composeCtx.canvas, x, y);
            }


            if (Palette.isLocked()){
                tempCtx.clearRect(0,0,w,h);
                tempCtx.drawImage(ctx.canvas,x,y,w,h,0,0,w,h);
                tempCtx.drawImage(composeCtx.canvas,0,0);

                // reapply dither
                let composeData;
                if (dither){
                    composeData = composeCtx.getImageData(0,0,w,h);
                }

                Palette.applyToCanvas(tempCtx.canvas,true,composeData);

                ctx.drawImage(tempCtx.canvas,x,y);

            }else{
                ctx.drawImage(composeCtx.canvas, x, y);
            }

            updateBrush(line.position[0], line.position[1]);

        }
        lastX = x;
        lastY = y;
        lastForce = force;
        EventBus.trigger(EVENT.layerContentChanged);
    }

    function createFeatherGradient(radius, hardness) {
        const innerRadius = Math.min(radius * hardness, radius - 1);
        const gradient = brushCtx.createRadialGradient(
            0, 0, innerRadius,
            0, 0, radius);
        gradient.addColorStop(0, 'rgba(0, 0, 0, 0)');
        gradient.addColorStop(1, 'rgba(0, 0, 0, 1)');
        return gradient;
    }

    function updateBrushSettings() {
        featherGradient = createFeatherGradient(radius/2, hardness);
        brushCtx.canvas.width = radius;
        brushCtx.canvas.height = radius;
        composeCtx.canvas.width = radius;
        composeCtx.canvas.height = radius;
    }

    function feather(ctx) {
        // feather the brush
        ctx.save();
        ctx.fillStyle = featherGradient;
        ctx.globalCompositeOperation = 'destination-out';
        const {width, height} = ctx.canvas;
        ctx.translate(width / 2, height / 2);
        ctx.fillRect(-width / 2, -height / 2, width, height);
        ctx.restore();
        ctx.globalCompositeOperation = 'source-over';
    }

    function updateBrush(x, y) {
        let width = brushCtx.canvas.width;
        let height = brushCtx.canvas.height;
        let srcX = x - width / 2;
        let srcY = y - height / 2;
        // draw it in the middle of the brush
        let dstX = (brushCtx.canvas.width - width) / 2;
        let dstY = (brushCtx.canvas.height - height) / 2;

        // clear the brush canvas
        brushCtx.clearRect(0, 0, brushCtx.canvas.width, brushCtx.canvas.height);

        // clip the rectangle to be
        // inside
        if (srcX < 0) {
            width += srcX;
            dstX -= srcX;
            srcX = 0;
        }
        const overX = srcX + width - ctx.canvas.width;
        if (overX > 0) {
            width -= overX;
        }

        if (srcY < 0) {
            dstY -= srcY;
            height += srcY;
            srcY = 0;
        }
        const overY = srcY + height - ctx.canvas.height;
        if (overY > 0) {
            height -= overY;
        }

        if (width <= 0 || height <= 0) {
            return;
        }

        brushCtx.drawImage(
            ctx.canvas,
            srcX, srcY, width, height,
            dstX, dstY, width, height);

        feather(brushCtx);
    }

    function lerp(a, b, t) {
        return a + (b - a) * t;
    }

    function setupLine(x, y, targetX, targetY) {
        const deltaX = targetX - x;
        const deltaY = targetY - y;
        const deltaRow = Math.abs(deltaX);
        const deltaCol = Math.abs(deltaY);
        const counter = Math.max(deltaCol, deltaRow);
        const axis = counter == deltaCol ? 1 : 0;

        // setup a line draw.
        return {
            position: [x, y],
            delta: [deltaX, deltaY],
            deltaPerp: [deltaRow, deltaCol],
            inc: [Math.sign(deltaX), Math.sign(deltaY)],
            accum: Math.floor(counter / 2),
            counter: counter,
            endPnt: counter,
            axis: axis,
            u: 0,
        };
    };

    function advanceLine(line) {
        --line.counter;
        line.u = 1 - line.counter / line.endPnt;
        if (line.counter <= 0) {
            return false;
        }
        const axis = line.axis;
        const perp = 1 - axis;
        line.accum += line.deltaPerp[perp];
        if (line.accum >= line.endPnt) {
            line.accum -= line.endPnt;
            line.position[perp] += line.inc[perp];
        }
        line.position[axis] += line.inc[axis];
        return true;
    }

    return me;
}();

export default Smudge;