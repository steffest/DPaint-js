import {$div, $elm, $title} from "../../util/dom.js";
import ImageFile from "../../image.js";

var ResizeDialog = function() {
    let me = {};
    let lockAspectRatio = true;
    let aspectRatio = 1;
    let anchorPoint = "center";

    me.render = function (container,modal) {
        let image = ImageFile.getCurrentFile();
        aspectRatio = image.width/image.height;
        container.innerHTML = "";
        $title(3, "Resize Canvas to:", container);
        let panel = $div("panel form","",container);
        let inputW = document.createElement("input");
        inputW.value = image.width;
        inputW.type = "number";
        let inputH = document.createElement("input");
        inputH.type = "number";
        inputH.value = image.height;
        inputW.onkeydown = modal.inputKeyDown;
        inputH.onkeydown = modal.inputKeyDown;
        inputW.oninput = ()=>{
            if (lockAspectRatio){
                let w = parseInt(inputW.value);
                if (isNaN(w)) w=image.width;
                inputH.value = Math.round(w/aspectRatio);
            }
        }
        inputH.oninput = ()=>{
            if (lockAspectRatio){
                let h = parseInt(inputH.value);
                if (isNaN(h)) w=image.height;
                inputW.value = Math.round(h*aspectRatio);
            }
        }

        $elm("span","width",panel,"label");
        panel.appendChild(inputW);
        $elm("span","pixels",panel);
        $elm("br","",panel);

        $elm("span","height",panel,"label");
        panel.appendChild(inputH);
        $elm("span","pixels",panel);

        let lock = $div("lock active","",panel);
        $div("link","",lock,()=>{
            lockAspectRatio = !lockAspectRatio;
            lock.classList.toggle("active",lockAspectRatio);
        });

        let qbuttons=$div("quick","",panel);
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


        let anchor=$div("anchor center","",panel);
        let zones = ["top left","top","top right","left","center","right","bottom left","bottom","bottom right"];
        for (let i = 0; i<9; i++){
            $div("hotspot","",anchor,()=>{
                anchorPoint = zones[i];
                anchor.className="anchor " + anchorPoint;
            })
        }
        $div("page","",anchor);
        $title(3, "Anchor:", anchor);
        let directions=["top","right","bottom","left"];
        for (let i = 0; i<4; i++){
            $div("arrow " + directions[i],"",anchor);
        }

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
            ImageFile.resize({width:w,height: h, anchor: anchorPoint});
        });

    }
    return me;
}();

export default ResizeDialog;