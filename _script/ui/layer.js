let Layer = function(width,height){
    let me = {
        visible:true
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

    
    return me;
}

export default Layer;