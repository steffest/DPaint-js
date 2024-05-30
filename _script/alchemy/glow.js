let process = function(source,target){
    let mode;
    mode = "MUI";
    //mode = "COLOR";
    mode = "ALPHA";

    let colors;
    if (mode==="MUI"){
        colors=[
            [255,255,255],
            [255, 169, 151],
            [170, 144, 124],
            [170, 144, 124,255]
        ]
        colors.forEach(color=>outline(target,color));
    }

    if (mode==="COLOR"){
        colors=[
            [255,255,255],
            [239, 231, 20],
            [221, 187, 68],
            [221, 187, 68,255]
        ]
        colors.forEach(color=>outline(target,color));
    }

    function outline(ctx,color,dotted){
        let w = ctx.canvas.width;
        let h = ctx.canvas.height;
        let data = ctx.getImageData(0,0,w,h);
        let d = data.data;
        let target = [];

        if (color.length>3) dotted=true;

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

                if (dotted){
                    let x = (index/4)%w;
                    let y = Math.floor((index/4)/w);
                    if (x%2){
                        d[index+3] = y%2?0:255;
                    }else{
                        d[index+3] = y%2?255:0;
                    }
                }
            });
            target=[];
            ctx.putImageData(data,0,0);
        }else{
            return target;
        }

    }

}

export default process;
