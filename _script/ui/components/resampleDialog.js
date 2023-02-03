import {$div, $elm, $title} from "../../util/dom.js";
import ImageFile from "../../image.js";

var ResampleDialog = function() {
    let me = {};

    me.render = function (container,modal) {
        let image = ImageFile.getCurrentFile();
        container.innerHTML = "";
        $title(3, "Resize Image to:", container);

        let panel = $div("panel form","",container);

        let inputW = document.createElement("input");
        inputW.value = image.width;
        inputW.type = "number";
        let inputH = document.createElement("input");
        inputH.type = "number";
        inputH.value = image.height;
        inputW.onkeydown = modal.inputKeyDown;
        inputH.onkeydown = modal.inputKeyDown;

        $elm("span","width",panel,"label");
        panel.appendChild(inputW);
        $elm("span","pixels",panel);
        $elm("br","",panel);

        $elm("span","height",panel,"label");
        panel.appendChild(inputH);
        $elm("span","pixels",panel);


        let buttons = $div("buttons","",container);
        $div("button ghost","Cancel",buttons,modal.hide);
        $div("button primary","Update",buttons,()=>{
            let w = parseInt(inputW.value);
            if (isNaN(w)) w = image.width;
            let h = parseInt(inputH.value);
            if (isNaN(h)) w = image.height;
            if (w<1)w=1;
            if (h<1)h=1;
            modal.hide();
            ImageFile.resample({width:w,height: h});
        });
    }
    return me;
}();

export default ResampleDialog;