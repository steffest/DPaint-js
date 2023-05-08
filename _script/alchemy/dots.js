let process = function(source,target){
    let expose = {
        dotRadius:{min:1,max:50,value:5},
        radiusJitter:{min:0,max:50,value:5},
        positionJitter:{min:0,max:100,value:50},
        alpha:{min:0,max:100,value:10}
    };

    let ctx=source.getContext("2d");
    let w = source.width;
    let h = source.height;
    target.clearRect(0,0,target.canvas.width,target.canvas.height);
    target.drawImage(source,0,0);

    let data = ctx.getImageData(0,0,w,h);
    let d = data.data;

    function dot(){
        let x = Math.floor(Math.random()*w);
        let y = Math.floor(Math.random()*h);
        let color = getColor(x,y);
        target.fillStyle = toRGBA(color,expose.alpha.value/100);
        splash(x,y,expose.dotRadius.value,expose.positionJitter.value,expose.radiusJitter.value);
    }

    function getColor(x,y){
        let index = (y*w+x)*4;
        return [d[index],d[index+1],d[index+2]];
    }

    for (let i = 0;i<500;i++){
        dot();
    }

    function splash(x,y,radius,jitter,jitterRadius){
        jitterRadius =jitterRadius||jitter;
        for (let i = 0; i<20; i++){
            let _x = x + Math.random()*jitter - jitter/2;
            let _y = y + Math.random()*jitter - jitter/2;
            let _r = radius + Math.random()*jitterRadius - jitterRadius/2;
            if (_r<1) _r=1;
            target.beginPath();
            target.arc(_x, _y, _r, 0, 2 * Math.PI, false);
            target.fill();
        }
    }

    function toRGBA(color,alpha){
        return "rgba("+color[0]+","+color[1]+","+color[2]+","+alpha+")"
    }
}


export default process;