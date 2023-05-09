let process = function(source,target){
    let expose = {
        starPointCount:{min:1,max:100,value:10},
        starSize:{min:1,max:100,value:25},
        sizeVariation:{min:1,max:1000,value:100},
        dabbleCount:{min:1,max:1000,value:200},
        transparency:{min:0,max:100,value:5}
    };

    let ctx=source.getContext("2d");
    let w = source.width;
    let h = source.height;
    target.clearRect(0,0,target.canvas.width,target.canvas.height);
    target.drawImage(source,0,0);

    let transparency = expose.transparency.value/100;

    let data = ctx.getImageData(0,0,w,h);
    let d = data.data;

    for (let i = 0; i<expose.dabbleCount.value;i++){
        splash();
    }


    function splash(){
        let x = Math.floor(Math.random()*w);
        let y = Math.floor(Math.random()*h);
        let color = getColor(x,y);
        target.fillStyle = toRGBA(color,transparency);
        for (let i = 0; i<10;i++){
            polygon(x,y);
        }
    }

    function polygon(x,y){
        target.beginPath();
        target.moveTo(x,y);

        for (let i = 0; i<expose.starPointCount.value; i++){
            target.lineTo(x+r(expose.starSize.value + r(expose.sizeVariation.value)),y+r(expose.starSize.value + r(expose.sizeVariation.value)));
        }
        target.closePath();
        target.fill();
    }

    function r(size){
        return Math.random()*size - size/2;
    }

    function getColor(x,y){
        let index = (y*w+x)*4;
        return [d[index],d[index+1],d[index+2]];
    }

    function toRGBA(color,alpha){
        return "rgba("+color[0]+","+color[1]+","+color[2]+","+alpha+")"
    }
}


export default process;