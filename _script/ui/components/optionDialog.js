import $,{$setTarget} from "../../util/dom.js";
import ImageFile from "../../image.js";

let OptionDialog = function() {
    let me = {};
    let currentData;

    me.render = function (container,modal,data) {
        container.innerHTML = "";
        let panel = $(".optiondialog",{parent: container});

        $setTarget(panel)
        currentData = data;
        if (data.text){
            if (typeof data.text === "string") data.text=[data.text];
            data.text.forEach(text=>{$("p",text);});
        }

        if (data.buttons){
            data.buttons.forEach(button=>{
                $(".button.large",{onclick: ()=>{
                    if (button.onclick) button.onclick();
                    modal.hide()
                }},button.label);
            })
        }else{
            $(".buttons.relative",
                $(".button.ghost",{onclick: ()=>{modal.hide(true); if (data.onCancel) data.onCancel()}},"Cancel"),
                $(".button.primary",{onclick: ()=>{modal.hide(true); if (data.onOk) data.onOk()}},"OK")
            );
        }
    }

    me.onClose = function(fromButton) {
        if (!fromButton && currentData && currentData.onCancel) currentData.onCancel();
        currentData = null;
    }
    return me;
}();

export default OptionDialog;