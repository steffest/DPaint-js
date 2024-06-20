import $,{$div, $elm, $title} from "../../util/dom.js";
import ImageFile from "../../image.js";
import UserSettings from "../../userSettings.js";

var ResampleDialog = function() {
    let me = {};
    let lockAspectRatio = true;
    let aspectRatio = 1;

    me.render = function (container,modal) {
        let image = ImageFile.getCurrentFile();
        aspectRatio = image.width/image.height;
        container.innerHTML = "";
        let inputW;
        let inputH;
        let lock;
        let qbuttons;
        let qualitySelect;
        let resampleQuality = UserSettings.get("resampleQuality") || "pixelated";

        $("h3",{parent:container},"Resize Image to:");
        $(".panel.form",{parent:container},
            $("span.label","width"),
            inputW = $("input",{type:"number",value:image.width, onkeydown:modal.inputKeyDown, oninput:()=>{
                if (lockAspectRatio){
                    let w = parseInt(inputW.value);
                    if (isNaN(w)) w=image.width;
                    inputH.value = Math.round(w/aspectRatio);
                }}}),
            $("span","pixels"),
            $("br"),
            $("span.label","height"),
            inputH = $("input",{type:"number",value:image.height, onkeydown:modal.inputKeyDown, oninput:()=>{
                    if (lockAspectRatio){
                        let h = parseInt(inputH.value);
                        if (isNaN(h)) w=image.height;
                        inputW.value = Math.round(h*aspectRatio);
                    }}}),
            $("span","pixels"),
            lock = $(".lock.active",$(".link",{onClick:()=>{
                    lockAspectRatio = !lockAspectRatio;
                    lock.classList.toggle("active",lockAspectRatio);
                }})),
            qbuttons = $(".quick"),
            qualitySelect = $("select.resize",$("option",{selected:resampleQuality==="pixelated"},"Pixelated"),$("option",{selected:resampleQuality==="smooth"},"Smooth"))
        );

        $(".buttons",{parent:container},
            $(".button.ghost",{onClick:modal.hide},"Cancel"),
            $(".button.primary",{onClick:()=>{
                    let w = parseInt(inputW.value);
                    if (isNaN(w)) w = image.width;
                    let h = parseInt(inputH.value);
                    if (isNaN(h)) w = image.height;
                    if (w<1)w=1;
                    if (h<1)h=1;
                    let quality = qualitySelect.value === "Pixelated" ? "pixelated" : "smooth";
                    UserSettings.set("resampleQuality",quality);
                    modal.hide();
                    ImageFile.resample({width:w,height: h,quality:quality});
                }},"Update")
        );


        let labels = ["x2","/2","x3","/3"];
        for (let i = 0;i<4;i++){
            $div("button calc",labels[i],qbuttons,()=>{
                let w =  parseInt(inputW.value);
                let h =  parseInt(inputH.value);
                if (isNaN(w)) w=image.width;
                if (isNaN(h)) w=image.height;
                if (i===0){w*=2;h*=2;}
                if (i===1){w/=2;h/=2;}
                if (i===2){w*=3;h*=3;}
                if (i===3){w/=3;h/=3;}
                inputW.value =  Math.round(w);
                inputH.value =  Math.round(h);
            });
        }

    }
    return me;
}();

export default ResampleDialog;