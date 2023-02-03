import ImageFile from "../../image.js";
import {$div} from "../../util/dom.js";
import EventBus from "../../util/eventbus.js";
import {COMMAND, EVENT} from "../../enum.js";

let FramesPanel = function(){
    let me = {};
    let contentPanel;
    let frames=[];

    me.generate = (parent)=>{
        let toolbar = $div("paneltools","",parent);
        $div("button delete","",toolbar,()=>{
            EventBus.trigger(COMMAND.DELETEFRAME);
        });
        $div("button add","",toolbar,()=>{
            EventBus.trigger(COMMAND.ADDFRAME);
        });

        contentPanel = $div("panelcontent","",parent);
    }

    me.list = ()=>{
        contentPanel.innerHTML = "";
        frames=[];
        let activeIndex = ImageFile.getActiveFrameIndex() || 0;
        let imageFile = ImageFile.getCurrentFile();
        if (imageFile && imageFile.frames){
            imageFile.frames.forEach((frame,index)=>{
                let elm = $div("frame" + (activeIndex === index ? " active":""),"",contentPanel,()=>{
                    ImageFile.activateFrame(index);
                });

                let canvas = document.createElement("canvas");
                canvas.width = 48;
                canvas.height = 48;
                canvas.getContext("2d").drawImage(ImageFile.getCanvas(index),0,0,48,48);
                elm.appendChild(canvas);

                $div("label","" + index,elm);

                frames.push(elm);

            });
        }
    }

    me.update = ()=>{
        let index = ImageFile.getActiveFrameIndex();
        let frame = frames[index];
        if (frame){
            let canvas = frame.querySelector("canvas");
            if (canvas){
                let ctx = canvas.getContext("2d");
                ctx.clearRect(0, 0,canvas.width,canvas.height);
                ctx.drawImage(ImageFile.getCanvas(index),0,0,48,48);
            }
        }
    }

    EventBus.on(EVENT.imageSizeChanged,me.list);
    EventBus.on(EVENT.layerContentChanged,me.update);

    return me;
}();

export default FramesPanel;