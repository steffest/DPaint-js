import Selection from "../selection.js";
import EventBus from "../../util/eventbus.js";
import {COMMAND, EVENT} from "../../enum.js";
import {$div} from "../../util/dom.js";
import Editor from "../editor.js";
import Input from "../input.js";

var Resizer = function(){
    let me = {};
    let currentSize;
    let sizeBox;
    let overlay;
    let overlayContent;
    let dots = [];
    let touchData = {};
    let aspectRatio = 1;

    me.set = function(x,y,w,h,hot,parent,startAspectRatio){
        if (!sizeBox) createSizeBox(parent);
        currentSize = {
            left: Math.round(x),
            top: Math.round(y),
            width: Math.round(w),
            height: Math.round(h)
        }
        sizeBox.classList.add("active");
        if (hot) sizeBox.classList.add("hot");
        if (startAspectRatio) {
            console.log("setting AR to " + startAspectRatio)
            aspectRatio = startAspectRatio;
        }

        EventBus.trigger(EVENT.sizerChanged,currentSize);
    }

    me.setOverlay = function(content){
        if (!sizeBox){
            console.error("Please set Resizer before defining overlay");
            return;
        }
        if (!overlay){
            overlay = document.createElement("canvas");
            overlay.width = 0;
            overlay.height = 0;
            sizeBox.appendChild(overlay);
        }
        overlayContent = content;
    }

    me.commit = function(){
        sizeBox.classList.remove("hot");
    }
    
    me.get = function(){
        return currentSize;
    }

    me.move = function(x,y){
        if (sizeBox && sizeBox.classList.contains("active") && currentSize){
            currentSize.left += x;
            currentSize.top += y;
            EventBus.trigger(EVENT.sizerChanged);
        }
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

    EventBus.on(EVENT.modifierKeyChanged,function(){
        if (sizeBox && sizeBox.classList.contains("active") && currentSize){
            updateSizeBox();
        }
    });

    // TODO should this be in resizer?
    EventBus.on(EVENT.selectionChanged,function(){
        if (sizeBox && sizeBox.classList.contains("active")){
            let s = Selection.get();
            if (s && s.width && s.height){
                me.set(s.left,s.top,s.width,s.height);
            }
        }
    })

    EventBus.on(EVENT.toolDeActivated,command=>{
        if (command === COMMAND.SELECT && sizeBox){
            sizeBox.classList.remove("active");
        }
    })

    // TODO should this be in resizer?
    EventBus.on(COMMAND.SELECT,()=>{
        let s = Selection.get();
        if (s && s.width && s.height){
            sizeBox.classList.add("active");
        }
    })

    // TODO should this be in resizer?
    EventBus.on(COMMAND.CLEARSELECTION,()=>{
        if (sizeBox) sizeBox.classList.remove("active");
        if (overlay){
            overlay.remove();
            overlay = undefined;
        }
    })

    function createSizeBox(parent){
        sizeBox = $div("sizebox","",parent,e=>{
            resizeBox(e);
        });

        for (var i = 0; i< 8; i++){
            let dot = $div("sizedot","",sizeBox,function(e){
                resizeBox(e);
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

        if (Input.isShiftDown() && Input.isMouseDown()){
            // aspect ratio lock
            currentSize._width = currentSize._width||currentSize.width;
            currentSize._height = currentSize._height||currentSize.height;
            //let size = Math.min(currentSize._width,currentSize._height);
            let w = currentSize._width;
            let h = w / aspectRatio;
            if (w>currentSize.width || h>currentSize.height){
                h = currentSize.height;
                w = h * aspectRatio;
            }
            currentSize.width = w;
            currentSize.height = h;
        }

        let wz = currentSize.width*zoom;
        let hz = currentSize.height*zoom;

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

        if (overlay){
            overlay.width = wz;
            overlay.height = hz;
            updateOverlay();
        }
    }

    function updateOverlay(){
        if (overlay && overlayContent){
            if (typeof overlayContent === "function"){
                overlayContent(overlay);
            }else{
                // only type canvas?
                let ctx = overlay.getContext("2d");
                ctx.webkitImageSmoothingEnabled = false;
                ctx.mozImageSmoothingEnabled = false;
                ctx.imageSmoothingEnabled = false;
                ctx.clearRect(0,0,overlay.width,overlay.height);
                ctx.drawImage(overlayContent,0,0,overlay.width,overlay.height);
            }
        }
    }

    function resizeBox(event){
        touchData.isResizing = true;
        touchData.isdown = true;
        // TODO; why do we need "selection" data in the resizer?
        //touchData.selection = Selection.get();
        touchData.startSelectWidth =  currentSize.width;
        touchData.startSelectHeight =  currentSize.height;
        touchData.startSelectLeft =  currentSize.left;
        touchData.startSelectTop =  currentSize.top;
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