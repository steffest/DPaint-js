let process = function(source,target){
    let expose = {
        frame:{min:1,max:200,value:1},
        refraction:{min:1,max:100,value: 55},
        reflection:{min:1,max:100,value: 10},
    };

    let width = source.width;
    let height = source.height;
    target.clearRect(0,0,target.canvas.width,target.canvas.height);

    let lightRefraction = expose.refraction.value / 10;
    let lightReflection = expose.reflection.value / 100;
    let waterModel;
    let ripple;

    if (!window.waterModel){
        let base = createRadialCanvas(30,10);
        base = skewCanvas(base);
        ripple= create2DArray(base);
        waterModel = WaterModel({
            width,
            height,
            resolution:2.0,
            damping:0.999,
            clipping:5
        });

        //waterModel.drop(150, 50, 10, ripple);
        //waterModel.drop(120, 250, 5, ripple);
        //waterModel.drop(200, 300, 10, ripple);
        //waterModel.drop(150, 230, 10, ripple);

        waterModel.drop(94, 167, 15, ripple);

        waterModel.renderFrames(800);
        window.waterModel = waterModel;
    }else{
        waterModel = window.waterModel;
    }




    let ctx = source.getContext('2d');
    let imgDataIn = ctx.getImageData(0, 0, width, height);
    let pixelsIn = imgDataIn.data;

    function drawFrame(step){
        var imgDataOut = target.getImageData(0, 0, width, height);
        var pixelsOut = imgDataOut.data;
        for (var i = 0; n = pixelsOut.length, i < n; i += 4) {
            var pixel = i/4;
            var x = pixel % width;
            var y = (pixel-x) / width;

            var strength = waterModel.getWater(x,y,step);

            var refraction = Math.round(strength * lightRefraction);

            var xPix = x + refraction;
            var yPix = y + refraction;

            if(xPix < 0) xPix = 0;
            if(yPix < 0) yPix = 0;
            if(xPix > width-1) xPix = width-1;
            if(yPix > height-1) yPix = height-1;


            var iPix = ((yPix * width) + xPix) * 4;
            var red 	= pixelsIn[iPix  ];
            var green 	= pixelsIn[iPix+1];
            var blue 	= pixelsIn[iPix+2];

            strength *= lightReflection;
            strength += 1.0;

            pixelsOut[i  ] = red *= strength;
            pixelsOut[i+1] = green *= strength;
            pixelsOut[i+2] = blue *= strength;
            pixelsOut[i+3] = 255; // alpha
        }

        target.putImageData(imgDataOut, 0,0);

    }

    drawFrame(expose.frame.value*4);

    function WaterModel(props) {
        let me = {}

        let resolution = props.resolution;
        let damping = props.damping;
        let clipping = props.clipping;
        let width = Math.ceil(props.width/resolution);
        let height = Math.ceil(props.height/resolution);

        let depthMap1 = new Array(width);
        let depthMap2 = new Array(width);
        for(var x = 0; x < width; x++){
            depthMap1[x] = new Array(height);
            depthMap2[x] = new Array(height);

            for (var y = 0; y < height; y++) {
                depthMap1[x][y] = 0.0;
                depthMap2[x][y] = 0.0;
            }
        }

        me.frames = [];

        me.getWater = function(x, y, frame){
            let xTrans = x/resolution;
            let yTrans = y/resolution;

            let xF = Math.floor(xTrans);
            let yF = Math.floor(yTrans);

            if(xF>width-1 || yF>height-1) return 0.0;

            let map = frame ? me.frames[frame] : depthMap1;
            if (!map) map = depthMap1;
            return map[xF][yF];
        }

        me.drop = function(x, y, pressure, array2d){
            x = Math.floor(x/resolution);
            y = Math.floor(y/resolution);

            if(array2d.length>4 || array2d[0].length>4){
                x-=array2d.length/2;
                y-=array2d[0].length/2;
            }

            if(x<0) x = 0;
            if(y<0) y = 0;
            if(x>width) x = width;
            if(y>height) y = height;

            for(var i = 2; i < array2d.length-2; i++){
                for(var j = 0; j < array2d[0].length; j++){

                    if(x+i>=0 && y+j>=0 && x+i<=width-1 && y+j<=height-1) {
                        depthMap1[x+i][y+j] -= array2d[i][j] * pressure;
                    }

                }
            }
        }

        me.renderFrames = function(count) {
            count = count || 1;

            for (var i = 0; i < count; i++) {

                if (i === 544){
                    //waterModel.drop(94, 167, 20, ripple);
                }

                for (var x = 0; x < width; x++) {
                    for (var y = 0; y < height; y++) {

                        // Handle borders correctly
                        var val = 	(x==0 ? 0 : depthMap1[x - 1][y]) +
                            (x==width-1 ? 0 : depthMap1[x + 1][y]) +
                            (y==0 ? 0 : depthMap1[x][y - 1]) +
                            (y==height-1 ? 0 : depthMap1[x][y + 1]);

                        // Damping
                        val = ((val / 2.0) - depthMap2[x][y]) * damping;

                        // Clipping prevention
                        if(val>clipping) val = clipping;
                        if(val<-clipping) val = -clipping;

                        depthMap2[x][y] = val;
                    }
                }

                // Swap buffer references
                let swapMap 	= depthMap1;
                depthMap1 	= depthMap2;
                depthMap2 	= swapMap;

                me.frames.push(cloneGrid(depthMap1));
            }

        }

        return me;
    }


    function cloneGrid(grid){return [...grid].map(row => [...row])}

    function createRadialCanvas(width, height){
        // Create a canvas
        var pointerCanvas = document.createElement('canvas');
        pointerCanvas.setAttribute('width', width);
        pointerCanvas.setAttribute('height', height);
        let pointerCtx = pointerCanvas.getContext('2d');

        // Create a drawing on the canvas
        var radgrad = pointerCtx.createRadialGradient(width/2,height/2,0,  width/2,height/2,height/2);
        radgrad.addColorStop(0, '#fff');
        radgrad.addColorStop(1, '#000');

        pointerCtx.fillStyle = radgrad;
        pointerCtx.fillRect(0,0,width,height);

        return pointerCanvas;
    }

    function skewCanvas(canvas) {
        let c = document.createElement('canvas');
        c.width = canvas.width;
        c.height = canvas.height;
        let ctx = c.getContext('2d');
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(canvas, 0, c.height/10, c.width, c.height/2);
        return c;
    }

    function create2DArray(canvas){
        let x,y;
        var width = canvas.width;
        var height = canvas.height;

        // Create an empty 2D  array
        var pointerArray = new Array(width);
        for(x = 0; x < width; x++){
            pointerArray[x] = new Array(height);
            for (y = 0; y < height; y++) {
                pointerArray[x][y] = 0.0;
            }
        }

        // Convert gray scale canvas to 2D array
        var pointerCtx = canvas.getContext('2d');
        var imgData = pointerCtx.getImageData(0, 0, width, height);
        var pixels = imgData.data;

        for (var i = 0; n = pixels.length, i < n; i += 4) {
            const pixVal = pixels[i];
            const arrVal = pixVal / 255.0;

            const pixel = i / 4;
            x = pixel % width;
            y = (pixel - x) / width;

            pointerArray[x][y] = arrVal;
        }

        return pointerArray;
    }



}



export default process;