import $,{$setTarget} from "../../util/dom.js";
import ImageFile from "../../image.js";

let OptionDialog = function() {
    let me = {};

    me.render = function (container,modal,data) {
        container.innerHTML = "";
        let panel = $(".optiondialog",{parent: container});

        $setTarget(panel)
        //if (data.title) $("h3",data.title);
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
                $(".button.ghost",{onclick: modal.hide},"Cancel"),
                $(".button.primary",{onclick: ()=>{modal.hide(); if (data.onOk) data.onOk()}},"OK")
            );
        }
    }
    return me;
}();

export default OptionDialog;