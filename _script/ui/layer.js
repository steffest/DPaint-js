import Color from "../util/color.js";

let Layer = function(width,height,name){
    let me = {
        visible:true,
        opacity:100,
        name: name,
        blendMode: "normal"
    }
    
    let canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    let ctx = canvas.getContext("2d");
    
    me.getCanvas = function(){
        return canvas;
    }
    
    me.getContext = function(){
        return ctx;
    }
    
    me.clear = function(){
        ctx.clearRect(0,0, canvas.width, canvas.height);
    }

    me.draw = function(image,x,y){
        x=x||0;y=y||0;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(image,x,y);
    }

    me.fill = function(color){
        color = Color.fromString(color);
        let imageData = ctx.getImageData(0,0,canvas.width, canvas.height);
        let data = imageData.data;
        let max = data.length>>2;
        for (let i = 0; i<max; i++){
            let index = i*4;
            if (data[index + 3]>100){
                imageData.data[index] = color[0];
                imageData.data[index+1] = color[1];
                imageData.data[index+2] = color[2];
            }
        }
        ctx.putImageData(imageData,0,0);
    }
    
    return me;
}

export default Layer;