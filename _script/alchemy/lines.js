let process = function(source,target){
    let expose = {
        lineCount:{min:1,max:1000,value:500},
        curve:{min:0,max:50,value:0},
        horizontalShift:{min:5,max:100,value:35},
        verticalShift:{min:-50,max:50,value:2},
    };

    let w = source.width;
    let h = source.height;
    target.clearRect(0,0,target.canvas.width,target.canvas.height);
    target.drawImage(source,0,0);

    function lineSet(color,alpha){
        let x = Math.floor(Math.random()*w)-expose.horizontalShift.value/2+5;
        let y = Math.floor(Math.random()*h);

        let x_offset = expose.horizontalShift.value + Math.random()*10;
        let y_offset = -(expose.verticalShift.value) + Math.random()*2;

        if (expose.curve.value){
            let hx = (w/2-x)/2;
            let hy = y/h;

            y_offset = Math.random()*hx * hy * expose.curve.value/10;
            y_offset = Math.round(y_offset);
        }

        let dist = 4;
        for (let i=0;i<4;i++){
            let d = dist*i;
            line(x,y+d,x+x_offset,y+y_offset+d,toRGBA(color,alpha/(1<<i)));
        }
    }

    function line(x,y,x2,y2,color){
        target.strokeStyle = color;
        target.beginPath();
        target.moveTo(x,y);
        target.lineTo(x2,y2);
        target.closePath();
        target.stroke();
    }

    for (let i = 0;i<expose.lineCount.value;i++){
        lineSet([0,0,0],0.1);
        lineSet([0,0,0],0.2);
        lineSet([255,255,255],0.08);
    }

    function toRGBA(color,alpha){
        return "rgba("+color[0]+","+color[1]+","+color[2]+","+alpha+")"
    }

}



export default process;