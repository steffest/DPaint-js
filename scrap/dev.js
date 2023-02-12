import Modal, {DIALOG} from "../_script/ui/modal.js";
import UI from "../_script/ui/ui.js";
import Input from "../_script/ui/input.js";

let App = function(){
    let me = {}
    let canvas;
    let canvasOut;

    me.init = function(){
        Input.init();
        canvas = document.createElement("canvas");
        canvasOut = document.createElement("canvas");
        canvasOut.width = canvas.width = 256;
        canvasOut.height = canvas.height = 256;

        document.body.appendChild(canvas);
        document.body.appendChild(canvasOut);
        let image = new Image();
        image.onload = ()=>{
            canvas.getContext("2d").drawImage(image,0,0);
        }
        image.src = "scrap/face1.png";

        Modal.show(DIALOG.EFFECTS);
    }

    window.addEventListener('DOMContentLoaded', (event) => {
        me.init();
    });

    me.getTarget = ()=>{
        return canvasOut.getContext("2d");
    }

    me.getSource = ()=>{
        return canvas;
    }




    return me;
}();

export default App