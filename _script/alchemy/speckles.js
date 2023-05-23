let process = function(source,target){
    let expose = {
        count:{main:true,min:1,max:1000,value:500},
        jitterRadius:{min:0,max:1000,value:1},
        jitterPosition:{min:0,max:100,value:50},
        darkAlpha:{min:0,max:100,value:3},
        lightAlpha:{min:0,max:100,value:6},
        horizontalShift:{min:-10,max:10,value:0},
        verticalShift:{min:-10,max:10,value:0},
    };



    let w = source.width;
    let h = source.height;
    target.clearRect(0,0,target.canvas.width,target.canvas.height);
    target.drawImage(source,0,0);

    function dot(color,alpha){
        let x = Math.floor(Math.random()*w);
        let y = Math.floor(Math.random()*h);
        target.fillStyle = toRGBA(color,alpha);
        splash(x,y,1,expose.jitterPosition.value,expose.jitterRadius.value/100);
    }

    for (let i = 0;i<expose.count.value;i++){
        if (expose.darkAlpha.value) dot([0,0,0],expose.darkAlpha.value/100);
        if (expose.lightAlpha.value) dot([255,255,255],expose.lightAlpha.value/100);
    }

    function splash(x,y,radius,jitter,jitterRadius){
        for (let j = 0;j<4;j++){
            for (let i = 0; i<5; i++){
                let _x = x;
                let _y = y;

                if (jitter){
                    _x += Math.random()*jitter - jitter/2;
                    _y += Math.random()*jitter - jitter/2;
                }

                if (expose.horizontalShift.value){
                    _x += j*expose.horizontalShift.value;
                }
                if (expose.verticalShift.value){
                    _y += i*expose.verticalShift.value + (j*-expose.verticalShift.value);
                }

                let _r = radius + Math.random()*jitterRadius - jitterRadius/2;
                if (_r<1) _r=1;
                target.beginPath();
                target.arc(_x, _y, _r, 0, 2 * Math.PI, false);
                target.fill();
            }
        }

    }

    function toRGBA(color,alpha){
        return "rgba("+color[0]+","+color[1]+","+color[2]+","+alpha+")"
    }
}


export default process;