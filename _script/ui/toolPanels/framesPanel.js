import ImageFile from "../../image.js";
import $,{$div} from "../../util/dom.js";
import EventBus from "../../util/eventbus.js";
import {COMMAND, EVENT} from "../../enum.js";
import ContextMenu from "../components/contextMenu.js";
import Input from "../input.js";
import Cursor from "../cursor.js";

let FramesPanel = function(){
    let me = {};
    let contentPanel;
    let frames=[];

    me.generate = (parent)=>{
        $(".paneltools",{parent:parent},
            $(".button.delete",{
                onClick:()=>{EventBus.trigger(COMMAND.DELETEFRAME)},
                info: "Delete active frame"}),
            $(".button.add",{
                onClick:()=>{EventBus.trigger(COMMAND.ADDFRAME)},
                info: "Add new frame"}),
         );

        contentPanel = $div("panelcontent","",parent);

    }

    me.list = ()=>{
        contentPanel.innerHTML = "";
        frames=[];
        let activeIndex = ImageFile.getActiveFrameIndex() || 0;
        let imageFile = ImageFile.getCurrentFile();
        if (imageFile && imageFile.frames){
            let hasMultipleItems = imageFile.frames.length>1;
            let max = imageFile.frames.length-1;
            imageFile.frames.forEach((frame,index)=>{
                let elm = $div("frame info" + ((activeIndex === index && hasMultipleItems) ? " active":""),"",contentPanel,()=>{
                    ImageFile.activateFrame(index);
                });
                elm.currentIndex = elm.targetIndex = index;
                elm.id = "frame" + index;
                elm.style.left = (index*52) + "px";
                elm.info = "Click to activate, drag to reorder, right click for more options";

                let canvas = document.createElement("canvas");
                canvas.width = 48;
                canvas.height = 48;
                canvas.getContext("2d").drawImage(ImageFile.getCanvas(index),0,0,48,48);
                elm.appendChild(canvas);

                elm.onDragStart = (e)=>{
                    let dupe = $div("dragelement box frame","Frame " + index);
                    Input.setDragElement(dupe);
                    let currentTarget = contentPanel.querySelector("#frame" + elm.currentIndex);
                    if (currentTarget){
                        currentTarget.startDragX = (currentTarget.currentIndex*52) + e.clientX - currentTarget.getBoundingClientRect().left;
                    }
                }

                elm.onDrag = (x,y)=>{
                    let distance = Math.abs(x);
                    // TODO: avoid comple list refresh on pointer down ?
                    if (distance>5){
                        Cursor.set("drag");
                        contentPanel.classList.add("inactive");
                        let currentTarget = contentPanel.querySelector("#frame" + elm.currentIndex);
                        if (currentTarget){
                            currentTarget.classList.add("ghost");
                            let newIndex = Math.floor((currentTarget.startDragX+x)/52);
                            elm.targetIndex = newIndex;
                            if (newIndex<0) newIndex=0;
                            if (newIndex>=max) newIndex = max;

                            for (let i = 0;i<=max;i++){
                                let el = contentPanel.querySelector("#frame" + i);
                                if (el){
                                    if (elm.currentIndex === i){
                                        el.style.left = (newIndex*52) + "px";
                                    }else{
                                        let ci = 0;
                                        if (newIndex<elm.currentIndex && i >= newIndex && i<=elm.currentIndex) ci=-1;
                                        if (newIndex>elm.currentIndex && i <= newIndex && i>=elm.currentIndex) ci=1;
                                        el.style.left = ((i-ci)*52) + "px";
                                    }
                                }
                            }
                        }
                    }
                }
                elm.onDragEnd = (e)=>{
                    Input.removeDragElement();
                    if (elm.currentIndex !== elm.targetIndex){
                        ImageFile.moveFrame(elm.currentIndex,elm.targetIndex);
                    }
                    let currentTarget = contentPanel.querySelector("#frame" + elm.currentIndex);
                    if (currentTarget) currentTarget.classList.remove("ghost");
                    Cursor.reset();
                    contentPanel.classList.remove("inactive");
                }

                elm.onContextMenu = ()=>{
                    let items = [];
                    if (hasMultipleItems) items.push ({label: "Remove Frame", command: COMMAND.DELETEFRAME});
                    items.push ({label: "Duplicate Frame", command: COMMAND.DUPLICATEFRAME});
                    items.push ({label: "Move to End", command: COMMAND.FRAMEMOVETOEND});

                    ContextMenu.show(items);
                }

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
    EventBus.on(EVENT.framesChanged,me.list);
    EventBus.on(EVENT.layerContentChanged,me.update);

    return me;
}();

export default FramesPanel;