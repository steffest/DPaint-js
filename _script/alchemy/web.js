let process = function(source,target){
    let ctx=source.getContext("2d");
    let w = source.width;
    let h = source.height;
    target.clearRect(0,0,target.canvas.width,target.canvas.height);
    target.drawImage(source,0,0);

    let polygonSize=25;
    let polygonPointCount=10;
    let sizeVariation =100;
    let transparency = 0.05;
    let splashCount = 200;

    let data = ctx.getImageData(0,0,w,h);
    let d = data.data;

    for (let i = 0; i<splashCount;i++){
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

        for (let i = 0; i<polygonPointCount; i++){
            target.lineTo(x+r(polygonSize + r(sizeVariation)),y+r(polygonSize + r(sizeVariation)));
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