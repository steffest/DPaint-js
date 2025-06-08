import $ from "../../util/dom.js";

let TextOutputDialog = function() {
    let me = {};

    me.render = function (container,modal,data) {
        container.innerHTML = "";
        let panel = $(".panel",{parent: container});

        let textarea = $("textarea",{value:data});
        textarea.onkeydown = function(e){
            e.stopPropagation();
        }
        panel.appendChild(textarea);

    }
    return me;
}();

export default TextOutputDialog;