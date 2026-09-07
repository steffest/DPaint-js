import {$div, $elm, $input, $title} from "../../util/dom.js";

/*
    Which frames to take when opening a multi-frame file (an animated GIF, an ANIM, ...).

    Opening a long animation to look at three frames of it is common enough that loading all
    of them first is wasteful, and a 300-frame file makes the timeline unusable until it is
    trimmed. The default is the whole file, so confirming without touching anything behaves
    exactly like it did before this dialog existed.

    Frame numbers here are 0-based, matching the timeline ruler and the Frame field rather
    than the "frame 1" of the file format — the numbers the user sees after opening are the
    numbers they typed.

    The caller gets {from, to} inclusive, and nothing at all on cancel: the dialog runs before
    the document is touched, so cancelling leaves the current file and its palette alone.
 */
var FrameRangeDialog = function() {
    let me = {};
    let currentData;

    me.render = function (container,modal,data) {
        currentData = data;
        container.innerHTML = "";
        let dialog = $div("framerangedialog","",container);

        let frameCount = Math.max(1, data.frameCount || 1);
        let last = frameCount - 1;
        let range = {from: 0, to: last};

        let name = data.fileName ? data.fileName + " — " : "";
        $title(3, name + frameCount + " frame" + (frameCount === 1 ? "" : "s"), dialog);

        let panel = $div("panel form","",dialog);

        $elm("span","first frame",panel,"label");
        let inputFrom = $input("number",range.from,panel,()=>update("from",inputFrom));
        $elm("br","",panel);

        $elm("span","last frame",panel,"label");
        let inputTo = $input("number",range.to,panel,()=>update("to",inputTo));
        $elm("br","",panel);

        inputFrom.min = inputTo.min = 0;
        inputFrom.max = inputTo.max = last;
        inputFrom.onkeydown = inputTo.onkeydown = modal.inputKeyDown;

        let info = $div("info","",dialog);

        let buttons = $div("buttons relative","",dialog);
        $div("button ghost","Cancel",buttons,()=>{modal.hide()});
        $div("button primary","Open",buttons,()=>{
            // modal.hide() runs onClose, which clears currentData — grab the callback first
            let onOk = currentData && currentData.onOk;
            modal.hide(true);
            if (onOk) onOk({from: range.from, to: range.to});
        });

        // The two ends clamp against each other rather than being validated afterwards, so
        // the range can never be inverted and there is nothing to warn about.
        function update(property,input){
            let value = parseInt(input.value,10);
            if (isNaN(value)) return;
            if (property === "from"){
                range.from = Math.min(Math.max(0,value), range.to);
                if (range.from !== value) input.value = range.from;
            }else{
                range.to = Math.max(Math.min(last,value), range.from);
                if (range.to !== value) input.value = range.to;
            }
            refresh();
        }

        function refresh(){
            let count = range.to - range.from + 1;
            info.innerHTML = count === frameCount
                ? "The whole animation."
                : count + " of " + frameCount + " frames.";
        }

        refresh();
    }

    me.onClose = function(fromButton) {
        if (!fromButton && currentData && currentData.onCancel) currentData.onCancel();
        currentData = null;
    }

    return me;
}();

export default FrameRangeDialog;
