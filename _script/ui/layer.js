let Layer = function(width,height){
    let me = {}
    
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
        ctx.fillStyle = "black";
        ctx.fillRect(0,0, canvas.width, canvas.height);
    }
    
    return me;
}

export default Layer;