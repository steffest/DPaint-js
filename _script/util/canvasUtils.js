import Palette from "../ui/palette.js";

export function duplicateCanvas(canvas,includingContent){
    let result = document.createElement("canvas");
    result.width = canvas.width;
    result.height = canvas.height;
    if (includingContent) result.getContext("2d").drawImage(canvas,0,0);
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

export function indexPixelsToPalette(ctx,palette,oneDimensional){
    let width = ctx.canvas.width;
    let height = ctx.canvas.height;
    let pixels = [];
    let data = ctx.getImageData(0,0,width,height).data;
    let notFoundCount = 0;
    let transparentIndex = 0;

    function getIndex(color,x,y){
        let index = palette.findIndex((c)=>{return c[0] === color[0] && c[1] === color[1] && c[2] === color[2]});
        if (index<0){
            index = 0;
            notFoundCount++;
        }
        return index;
    }

    for (let i=0;i<data.length;i+=4){
        let x = (i/4)%width;
        let y = Math.floor((i/4)/width);
        let r = data[i];
        let g = data[i+1];
        let b = data[i+2];
        let a = data[i+3];

        let index = a?getIndex([r,g,b,a],x,y):transparentIndex;
        if (oneDimensional){
            pixels.push(index);
        }else{
            pixels[y] = pixels[y] || [];
            pixels[y][x] = index;
        }
    }


    return {
        pixels:pixels,
        notFoundCount:notFoundCount
    }
}

