import dom from "../../util/dom.js";
import SidePanel from "../sidepanel.js";
import Palette from "../palette.js";

let ColorPicker = function(){
    let me = {};
    let ctx;
    let ctx2;
    let rgbaColor = 'rgba(255,0,0,1)';
    let w = 120;
    let cx = w-1;
    let cy = 0;
    let dot;
    let line;

    me.generate = (parent)=> {
        let container = dom(".colorpicker",{parent});

        let canvas = dom("canvas.handle",{width: w, height:w, parent:container, onDrag:(x,y,d)=>{
            let box = canvas.getBoundingClientRect();
            cx = d.startX+x - box.left;
            cy = d.startY+y - box.top;
            setColor(d.button);
        }, onDragStart:(e)=>{
            let box = canvas.getBoundingClientRect();
            cx= e.clientX - box.left;
            cy= e.clientY - box.top;
            setColor(e.button);
        }});
        ctx = canvas.getContext("2d");
        fillGradient();

        let colorStrip = dom("canvas.handle",{width: 20, height:w, parent:container, onDrag:(x,y,d)=>{
            let box = colorStrip.getBoundingClientRect();
            let cy = d.startY+y - box.top;
            setStrip(cy,d.button);
        }, onDragStart:(e)=>{
            let box = colorStrip.getBoundingClientRect();
            let cy = e.clientY - box.top;
            setStrip(cy,e.button);
        }});
        ctx2 = colorStrip.getContext("2d");
        fillStrip();

        dot = dom(".dot",{parent:container});
        line = dom(".line",{parent:container});

    }

    function fillStrip(){
        let grd1 = ctx2.createLinearGradient(0, 0, 0, w);
        grd1.addColorStop(0, 'rgba(255, 0, 0, 1)');
        grd1.addColorStop(0.17, 'rgba(255, 255, 0, 1)');
        grd1.addColorStop(0.34, 'rgba(0, 255, 0, 1)');
        grd1.addColorStop(0.51, 'rgba(0, 255, 255, 1)');
        grd1.addColorStop(0.68, 'rgba(0, 0, 255, 1)');
        grd1.addColorStop(0.85, 'rgba(255, 0, 255, 1)');
        grd1.addColorStop(1, 'rgba(255, 0, 0, 1)');
        ctx2.fillStyle = grd1;
        ctx2.fillRect(0, 0, 20, w);
    }

    function fillGradient() {
        ctx.fillStyle = rgbaColor;
        ctx.fillRect(0, 0, w, w);

        let grdWhite = ctx.createLinearGradient(0, 0, w, 0);
        grdWhite.addColorStop(0, 'rgba(255,255,255,1)');
        grdWhite.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = grdWhite;
        ctx.fillRect(0, 0, w, w);

        let grdBlack = ctx.createLinearGradient(0, 0, 0,w);
        grdBlack.addColorStop(0, 'rgba(0,0,0,0)');
        grdBlack.addColorStop(1, 'rgba(0,0,0,1)');
        ctx.fillStyle = grdBlack;
        ctx.fillRect(0, 0, w, w);
    }

    function setColor(button){
        if (cx<0) cx = 0;
        if (cx>w) cx = w-1;
        if (cy<0) cy = 0;
        if (cy>w) cy = w-1;

        dot.style.left = cx+"px";
        dot.style.top = cy+"px";

        let imageData = ctx.getImageData(cx, cy, 1, 1).data;
        Palette.setColor(imageData,button,true)
    }

    function setStrip(sy,button){
        if (sy>w) sy = w-1;
        if (sy<0) sy = 0;
        line.style.top = sy+"px";
        let imageData = ctx2.getImageData(0, sy, 1, 1).data;
        rgbaColor = 'rgba(' + imageData[0] + ',' + imageData[1] + ',' + imageData[2] + ',1)';
        fillGradient();
        setColor(button);
    }

    return me;
}();

export default ColorPicker;