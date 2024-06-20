let process = function(source,target){
    let expose = {
        distanceX:{min:0,max:100,value:50},
        distanceY:{min:0,max:100,value:50},
    };

    let w = source.width;
    let h = source.height;

    target.clearRect(0,0,target.canvas.width,target.canvas.height);

    let fx = expose.distanceX.value/100;
    let fy = expose.distanceY.value/100;

    let bw = Math.floor(w * fx);
    let bh = Math.floor(h * fy);

    let aw = w - bw;
    let ah = h - bh;

    target.drawImage(source,0,0,aw,ah,bw,bh,aw,ah);
    target.drawImage(source,aw,0,bw,ah,0,bh,bw,ah);
    target.drawImage(source,0,ah,aw,bh,bw,0,aw,bh);
    target.drawImage(source,aw,ah,bw,bh,0,0,bw,bh);

}


export default process;