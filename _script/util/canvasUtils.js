import Palette from "../ui/palette.js";

// Duplicate a canvas element. Spec 016 phase 3.5 (R8): the 2d context policy is now
// explicit. The `willReadFrequently` hint belongs on getContext("2d", …) — not on
// createElement, where it was silently ignored before. A duplicate is CPU-read heavy
// by default (it exists to be read back / composited), so the hint defaults to true;
// pass options.willReadFrequently === false for a copy that stays GPU-side (e.g. one
// only ever drawImage'd or uploaded as a texture) to let the browser keep it on-GPU.
// Passing includingContent implies at least one immediate readback of the source.
export function duplicateCanvas(canvas,includingContent,options){
    let willReadFrequently = true;
    if (options && options.willReadFrequently === false) willReadFrequently = false;
    let result = document.createElement("canvas");
    result.width = canvas.width;
    result.height = canvas.height;
    if (includingContent) result.getContext("2d",{willReadFrequently:willReadFrequently}).drawImage(canvas,0,0);
    return result;
}

export function releaseCanvas(canvas) {
    // mostly needed for safari as it tends to hold on the canvas elements;
    canvas.width = 1;
    canvas.height = 1;
    canvas.getContext('2d').clearRect(0, 0, 1, 1);
    canvas = undefined;
}

// create an SVG outline path from the non-transparent pixels of a canvas context,
// next to the SVG, the function also returns the bounding box of the pixels
// TODO: move to webworker?

export function outLineCanvas(ctx,generateSVG){

    let lines = [];
    let img = ctx.getImageData(0,0,ctx.canvas.width,ctx.canvas.height);
    let topLine = {x:0, y:0, w:0}
    let bottomLine = {x:0, y:0, w:0}
    let leftLine = {x:0, y:0, h:0}
    let rightLine = {x:0, y:0, h:0}
    let w  = img.width;
    let h = img.height;

    let boundingCoords = {x1:w,y1:h,x2:0,y2:0};

    function isPixel(x,y){
        if (x<0 || x>=w || y<0 || y>=h) return false;
        let index = (y * w + x) * 4;
        let alpha = img.data[index + 3];
        return alpha>1;
    }

    function addLine(line,horizontal){
        if (line.w){
            if (horizontal){
                lines.push([line.x,line.y,line.x+line.w,line.y]);
            }else{
                lines.push([line.x,line.y,line.x,line.y+line.w]);
            }
            line.w = 0;
        }
    }

    // find horizontal lines;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (isPixel(x,y)){

                // update bounding box
                if (x<boundingCoords.x1) boundingCoords.x1 = x;
                if (x>boundingCoords.x2) boundingCoords.x2 = x;
                if (y<boundingCoords.y1) boundingCoords.y1 = y;
                if (y>boundingCoords.y2) boundingCoords.y2 = y;

                if (!isPixel(x,y-1)){
                    // top edge found
                    if (topLine.w){
                        topLine.w++;
                    }else{
                        topLine = {x:x,y:y,w:1};
                    }
                }else{
                    addLine(topLine,true);
                }

                if (!isPixel(x,y+1)){
                    // bottom edge found
                    if (bottomLine.w){
                        bottomLine.w++;
                    }else{
                        bottomLine = {x:x,y:y+1,w:1};
                    }
                }else{
                    addLine(bottomLine,true);
                }
            }else{
                addLine(topLine,true);
                addLine(bottomLine,true);
            }
        }
        addLine(topLine,true);
        addLine(bottomLine,true);
    }
    let boundingBox = {
        x:boundingCoords.x1,
        y:boundingCoords.y1,
        w:boundingCoords.x2-boundingCoords.x1,
        h:boundingCoords.y2-boundingCoords.y1
    }

    // find vertical lines;
    for (let x = 0; x < w; x++) {
        for (let y = 0; y < h; y++) {
            if (isPixel(x,y)){
                if (!isPixel(x-1,y)){
                    // left edge found
                    if (leftLine.w){
                        leftLine.w++;
                    }else{
                        leftLine = {x:x,y:y,w:1};
                    }
                }else{
                    addLine(leftLine);
                }

                if (!isPixel(x+1,y)){
                    // right edge found
                    if (rightLine.w){
                        rightLine.w++;
                    }else{
                        rightLine = {x:x+1,y:y,w:1};
                    }
                }else{
                    addLine(rightLine);
                }
            }else{
                addLine(leftLine);
                addLine(rightLine);
            }
        }

        addLine(leftLine);
        addLine(rightLine);
    }

    // TODO: should we do the extra pass to construct polylines?

    let totalLines = lines.length;

    let svg;
    if (generateSVG){
        svg = "<svg xmlns='http://www.w3.org/2000/svg' viewbox='0 0 "+ctx.canvas.width+" " + ctx.canvas.height +"' preserveAspectRatio='none'>";
        if (totalLines>6000){
            console.warn("too many lines, displaying bounding box instead");

            svg += '<rect x="'+boundingBox.x+'" y="'+boundingBox.y+'" width="'+boundingBox.w+'" height="'+boundingBox.h+'" class="white" />';
            svg += '<rect x="'+boundingBox.x+'" y="'+boundingBox.y+'" width="'+boundingBox.w+'" height="'+boundingBox.h+'" class="ants" />';

        }else{
            // draw lines
            lines.forEach(h=>{
                let x = h[0];
                let y = h[1];
                let x2 = h[2];
                let y2 = h[3];
                svg += '<line x1="'+x+'" y1="'+y+'" x2="'+x2+'" y2="'+y2+'" class="white" />';
                svg += '<line x1="'+x+'" y1="'+y+'" x2="'+x2+'" y2="'+y2+'" class="ants" />';
            });

        }

        svg += "</svg>"
    }

    return {
        svg:svg,
        box:boundingBox,
        lines:lines,
        lineCount: totalLines
    }


}

// Maps an RGB colour to a palette index. An exact match is a Map hit; anything else snaps to
// the NEAREST palette colour by squared RGB distance — the same measure the quantizer shader
// uses — and is memoised, so an off-palette colour costs one palette scan per distinct colour
// rather than one per pixel. `lookup.misses` counts the PIXELS that were not an exact match.
//
// Snapping to the nearest colour is the whole point of this helper. A composite can perfectly
// well contain colours that are not in the palette: a mask track whose "black" is a near-black
// palette entry leaves a few percent of the layer below showing through, a partially
// transparent layer blends with what is under it, and either way the result is a colour that
// was never in the palette. Sending all of those to index 0 turns them into whatever colour
// sits in slot 0 — dark speckles scattered over the export, which is what this used to do.
export function buildColorLookup(paletteColors){
    let exact = new Map();
    for (let i = 0; i < paletteColors.length; i++){
        let c = paletteColors[i];
        let key = c[0] + "," + c[1] + "," + c[2];
        if (!exact.has(key)) exact.set(key, i);
    }
    // kept apart from `exact` so a memoised near match still counts as a miss every time
    let approximated = new Map();
    let lookup = (r, g, b) => {
        let key = r + "," + g + "," + b;
        let index = exact.get(key);
        if (index !== undefined) return index;
        lookup.misses++;
        index = approximated.get(key);
        if (index === undefined){
            index = nearestColorIndex(paletteColors, r, g, b);
            approximated.set(key, index);
        }
        return index;
    };
    lookup.misses = 0;
    return lookup;
}

function nearestColorIndex(paletteColors, r, g, b){
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < paletteColors.length; i++){
        let c = paletteColors[i];
        let dr = r - c[0], dg = g - c[1], db = b - c[2];
        let distance = dr*dr + dg*dg + db*db;
        if (distance < bestDistance){
            bestDistance = distance;
            best = i;
        }
    }
    return best;
}

// `transparentIndex` is the palette slot fully transparent pixels are written as. It has to
// come from the caller, because only the caller knows which slot its format reserved: the GIF
// writer appends a dedicated entry and declares it in the Graphic Control Extension, PNG8
// does the same in its tRNS chunk. It defaults to 0, the conventional background slot — NOT
// to some fixed index, which used to hand transparent areas whatever colour happened to sit
// in that slot (and an out-of-range index for palettes shorter than it).
export function indexPixelsToPalette(ctx,palette,oneDimensional,transparentIndex){
    let width = ctx.canvas.width;
    let height = ctx.canvas.height;
    let pixels = [];
    let data = ctx.getImageData(0,0,width,height).data;
    if (typeof transparentIndex !== "number" || transparentIndex < 0) transparentIndex = 0;

    // Exact where possible, nearest where not (see buildColorLookup). notFoundCount stays a
    // PIXEL count, since that is what the save dialog reports back to the user.
    let lookup = buildColorLookup(palette);

    for (let i=0;i<data.length;i+=4){
        let x = (i/4)%width;
        let y = Math.floor((i/4)/width);
        let a = data[i+3];

        let index = a ? lookup(data[i],data[i+1],data[i+2]) : transparentIndex;
        if (oneDimensional){
            pixels.push(index);
        }else{
            pixels[y] = pixels[y] || [];
            pixels[y][x] = index;
        }
    }

    return {
        pixels:pixels,
        notFoundCount:lookup.misses
    }
}

