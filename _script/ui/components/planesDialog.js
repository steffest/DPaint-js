import {$div, $elm, $input, $checkbox, $title} from "../../util/dom.js";
import PLANES from "../../fileformats/planes.js";

/*
    Import options for raw Amiga bitplane files (".planes").

    Those files carry no header at all, so width, height and plane count have to come from
    the user. Two things keep that from being guesswork: the height is derived from the
    file size whenever the width and plane count divide it evenly, and the preview renders
    the actual decode, so a wrong guess is visible before committing to it.
 */
var PlanesDialog = function() {
    let me = {};
    let currentData;
    let settings = {};

    me.render = function (container,modal,data) {
        currentData = data;
        container.innerHTML = "";
        let dialog = $div("planesdialog","",container);

        // Note: the layout guess arrives nested, not as data.width/data.height - Modal.show
        // reads those two off the data object to size the dialog window itself.
        let byteLength = data.buffer.byteLength;
        settings = {
            width: data.guess.width,
            height: data.guess.height,
            planeCount: data.guess.planeCount,
            transparentIndex0: false
        };

        $title(3, "Raw bitplane data: " + byteLength + " bytes", dialog);

        let panel = $div("panel form","",dialog);

        $elm("span","width",panel,"label");
        let inputW = $input("number",settings.width,panel,()=>{update("width",inputW)});
        $elm("span","pixels",panel);
        $elm("br","",panel);

        $elm("span","height",panel,"label");
        let inputH = $input("number",settings.height,panel,()=>{update("height",inputH)});
        $elm("span","pixels",panel);
        $elm("br","",panel);

        $elm("span","planes",panel,"label");
        let inputP = $input("number",settings.planeCount,panel,()=>{update("planeCount",inputP)});
        let colorInfo = $elm("span","",panel);
        $elm("br","",panel);

        inputW.min = inputH.min = inputP.min = 1;
        inputP.max = 8;
        inputW.onkeydown = inputH.onkeydown = inputP.onkeydown = modal.inputKeyDown;

        $checkbox("Color 0 is transparent",panel,"",(checked)=>{
            settings.transparentIndex0 = checked;
            refresh();
        },settings.transparentIndex0);

        let info = $div("info","",dialog);
        let preview = $div("preview","",dialog);

        let buttons = $div("buttons relative","",dialog);
        $div("button ghost","Cancel",buttons,()=>{modal.hide()});
        $div("button primary","Open",buttons,()=>{
            // modal.hide() runs onClose, which clears currentData - grab the callback first
            let onOk = currentData && currentData.onOk;
            modal.hide(true);
            if (onOk) onOk(Object.assign({},settings));
        });

        function update(property,input){
            let value = parseInt(input.value);
            if (isNaN(value) || value < 1) return;
            settings[property] = value;
            // The height follows from the file size, so it is recalculated whenever the
            // width or the plane count changes - but only when it divides evenly; an
            // in-between value would otherwise wipe out what the user typed.
            if (property !== "height"){
                let height = PLANES.getHeight(byteLength,settings.width,settings.planeCount);
                if (height){
                    settings.height = height;
                    inputH.value = height;
                }
            }
            refresh();
        }

        function refresh(){
            colorInfo.innerHTML = "(" + (1 << settings.planeCount) + " colors)";

            let fits = PLANES.fits(byteLength,settings.width,settings.height,settings.planeCount);
            info.innerHTML = fits ? "" : "These dimensions don't match the file size - the image may be cut off or padded.";
            info.classList.toggle("warning",!fits);

            preview.innerHTML = "";
            let canvas = PLANES.toCanvas(data.buffer,settings);
            if (canvas) preview.appendChild(canvas);
        }

        refresh();
    }

    me.onClose = function(fromButton) {
        if (!fromButton && currentData && currentData.onCancel) currentData.onCancel();
        currentData = null;
    }

    return me;
}();

export default PlanesDialog;
