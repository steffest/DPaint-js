let process = function(source,target){
    let w = source.width;
    let h = source.height;
    target.clearRect(0,0,target.canvas.width,target.canvas.height);
    target.drawImage(source,0,0);

    function dot(color,alpha){
        let x = Math.floor(Math.random()*w);
        let y = Math.floor(Math.random()*h);
        target.fillStyle = toRGBA(color,alpha);
        splash(x,y,1,50,0.001);
    }

    for (let i = 0;i<500;i++){
        dot([0,0,0],0.03);
        dot([255,255,255],0.06);
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
}

function toRGBA(color,alpha){
    return "rgba("+color[0]+","+color[1]+","+color[2]+","+alpha+")"
}

export default process;