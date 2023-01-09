import Selection from "../selection.js";
import EventBus from "../../util/eventbus.js";
import {COMMAND, EVENT} from "../../enum.js";
import {$div} from "../../util/dom.js";
import Editor from "../editor.js";
import UI from "../ui.js";

var Resizer = function(){
    let me = {};
    let currentSize;
    let sizeBox;
    let dots = [];
    let touchData = {};

    me.set = function(x,y,w,h,hot,parent){
        if (!sizeBox) createSizeBox(parent);
        currentSize = {
            left: x,
            top: y,
            width: w,
            height: h
        }
        sizeBox.classList.add("active");
        if (hot) sizeBox.classList.add("hot");

        EventBus.trigger(EVENT.sizerChanged,currentSize);
    }

    me.commit = function(){
        sizeBox.classList.remove("hot");
    }
    
    me.get = function(){
        return currentSize;
    }

    EventBus.on(EVENT.sizerChanged,function(data){
        if (sizeBox && sizeBox.classList.contains("active")){
            data = data||currentSize;
            currentSize = {
                left: data.left,
                top: data.top,
                width: data.width,
                height: data.height
            }
            updateSizeBox();
        }
    })

    EventBus.on(EVENT.selectionChanged,function(){
        if (sizeBox.classList.contains("active")){
            let s = Selection.get();
            if (s && s.width && s.height){
                me.set(s.left,s.top,s.width,s.height);
            }
        }
    })

    EventBus.on(EVENT.toolDeActivated,command=>{
        if (command === COMMAND.SELECT){
            sizeBox.classList.remove("active");
        }
    })

    EventBus.on(COMMAND.SELECT,()=>{
        let s = Selection.get();
        if (s && s.width && s.height){
            sizeBox.classList.add("active");
        }
    })

    EventBus.on(COMMAND.CLEARSELECTION,()=>{
        sizeBox.classList.remove("active");
    })

    function createSizeBox(parent){
        sizeBox = $div("sizebox","",parent,e=>{
            resizeSelectBox(e);
        });

        for (var i = 0; i< 8; i++){
            let dot = $div("sizedot","",sizeBox,function(e){
                resizeSelectBox(e);
            });

            dot.onDrag = function(x,y){
                handleDrag(x,y,dot)}
            dot.onDragEnd = function(x,y){
                sizeBox.classList.remove("hot");
            }
            dot.index = i;
            dots.push(dot);
        }

        sizeBox.onDrag = function(x,y){
            handleDrag(x,y,{index:8})
        }
        sizeBox.onDragEnd = function(x,y){
            sizeBox.classList.remove("hot");
        }
    }

    function updateSizeBox(){
        var parent = Editor.getActivePanel().getCanvas();
        let viewport = Editor.getActivePanel().getViewPort();
        var rect = parent.getBoundingClientRect();
        var rect2 =  viewport.getBoundingClientRect();
        let zoom = Editor.getActivePanel().getZoom();

        let wz = currentSize.width*zoom;
        let hz = currentSize.height*zoom;

        window.v = viewport;
        console.error(viewport);

        sizeBox.style.left =  (rect.left - rect2.left + viewport.scrollLeft + currentSize.left*zoom) + "px";
        sizeBox.style.top =  (rect.top - rect2.top + viewport.scrollTop + currentSize.top*zoom)  + "px";
        sizeBox.style.width =  wz  + "px";
        sizeBox.style.height =  hz + "px";

        dots[1].style.left = Math.round(wz/2) + "px";
        dots[2].style.left = wz + "px";

        dots[3].style.left = wz + "px";
        dots[3].style.top = Math.round(hz/2) + "px";

        dots[4].style.left = wz + "px";
        dots[4].style.top = hz + "px";

        dots[5].style.left = dots[1].style.left;
        dots[5].style.top = hz + "px";

        dots[6].style.top = hz + "px";

        dots[7].style.top = dots[3].style.top;
    }

    function resizeSelectBox(event){
        touchData.isResizing = true;
        touchData.isdown = true;
        touchData.selection = Selection.get();
        touchData.startSelectWidth =  touchData.selection.width;
        touchData.startSelectHeight =  touchData.selection.height;
        touchData.startSelectLeft =  touchData.selection.left;
        touchData.startSelectTop =  touchData.selection.top;
        sizeBox.classList.add("hot");
    }

    function handleDrag(x,y,dot){
        let zoom = Editor.getActivePanel().getZoom();
        let l = touchData.startSelectLeft;
        let t = touchData.startSelectTop;
        let w = touchData.startSelectWidth;
        let h = touchData.startSelectHeight;

        let xz = x/zoom;
        let yz = y/zoom;


        switch (dot.index){
            case 0:
                l+=xz;
                t+=yz;
                h-=yz;
                w-=xz;
                break;
            case 1:
                t+=yz;
                h-=yz;
                break;
            case 2:
                t+=yz;
                w+=xz;
                h-=yz;
                break;
            case 3:
                w+=xz;
                break;
            case 4:
                w+=xz;
                h+=yz;
                break;
            case 5:
                h+=yz;
                break;
            case 6:
                l+=xz;
                w-=xz;
                h+=yz;
                break;
            case 7:
                l+=xz;
                w-=xz;
                break;
            case 8:
                l+=xz;
                t+=yz;
                break;
        }

        me.set(l,t,w,h);

    }
    
    return me;
}();

export default Resizer