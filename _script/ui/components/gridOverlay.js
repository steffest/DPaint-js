import {$div} from "../../util/dom.js";
import ImageFile from "../../image.js";
import GridPanel from "../toolPanels/gridPanel.js";

let GridOverlay = ((parent)=>{
    let container = parent;
    let me={};
    let visible = false;
    let grid;
    let zoom = 1;
    let linesVertical = [];
    let linesHorizontal = [];

    me.toggle=()=>{
        visible = !visible;
        if (visible && !grid){
            grid = $div("grid","",container);
        }
        grid.style.display = visible?"block":"none";
        me.update();
    }

    me.update = (rebuild)=>{
        let options = GridPanel.getOptions();
        visible = options.visible;
        if (!visible) return;
        if (!grid){
            grid = $div("grid","",container);
        }

        let w = ImageFile.getCurrentFile().width;
        let h = ImageFile.getCurrentFile().height;
        let size = options.size || 16;
        grid.innerHTML = "";
        grid.style.opacity = options.opacity/100;
        grid.style.filter = "brightness(" + (options.brightness) + "%)";

        linesVertical = [];
        linesHorizontal = [];

        for (let x=size;x<w;x+=size){
            let line = $div("line vertical","",grid);
            line.style.left = x*zoom + "px";
            linesVertical.push(line);
        }

        for (let y=size;y<h;y+=size){
            let line = $div("line horizontal","",grid);
            line.style.top = y*zoom + "px";
            linesHorizontal.push(line);
        }
    }

    me.zoom = (factor)=>{
        zoom = factor;
        let options = GridPanel.getOptions();
        visible = options.visible;
        if (!visible) return;

        let size = options.size || 16;
        console.log("zooming grid",size,zoom);
        linesVertical.forEach((line,index)=>{
            line.style.left = (size*zoom*(index+1)) + "px";
            console.log("line",line.style.left);
        });
        linesHorizontal.forEach((line,index)=>{
            line.style.top = (size*zoom*(index+1)) + "px";
        });


    }

    return me;

});

export default GridOverlay;