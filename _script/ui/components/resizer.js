import Selection from "../selection.js";
import EventBus from "../../util/eventbus.js";
import {COMMAND, EVENT} from "../../enum.js";
import {$div} from "../../util/dom.js";
import Editor from "../editor.js";
import Input from "../input.js";
import Cursor from "../cursor.js";

var Resizer = function(){
    let me = {};
    let currentSize;
    let sizeBox;
    let updateHandler;
    let dots = [];
    let rotateDots = [];
    let touchData = {};
    let aspectRatio = 1;

    me.set = function(x,y,w,h,rotation,hot,parent,startAspectRatio){
        if (!sizeBox) createSizeBox(parent);
        currentSize = {
            left: Math.round(x),
            top: Math.round(y),
            width: Math.round(w),
            height: Math.round(h),
            rotation: rotation
        }
        sizeBox.classList.add("active");
        if (!rotation){
            sizeBox.style.transform = "none";
        }

        if (hot) sizeBox.classList.add("hot");
        if (startAspectRatio) {
            console.log("setting AR to " + startAspectRatio)
            aspectRatio = startAspectRatio;
        }

        EventBus.trigger(EVENT.sizerChanged,currentSize);
    }

    me.setOnUpdate = function(handler){
        updateHandler = handler;
    }

    me.commit = function(){
        sizeBox.classList.remove("hot");
        updateHandler = undefined;
    }
    
    me.get = function(){
        return currentSize;
    }

    me.move = function(x,y){
        if (me.isActive() && currentSize){
            currentSize.left += x;
            currentSize.top += y;
            EventBus.trigger(EVENT.sizerChanged);
        }
    }

    me.isActive = function(){
        return sizeBox && sizeBox.classList.contains("active");
    }

    EventBus.on(EVENT.sizerChanged,function(data){
        if (sizeBox && sizeBox.classList.contains("active")){
            data = data||currentSize;
            currentSize = {
                left: data.left,
                top: data.top,
                width: data.width,
                height: data.height,
                rotation: currentSize?currentSize.rotation:undefined
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
                console.error("CHECK");
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
        if (s && s.width && s.height && sizeBox){
            sizeBox.classList.add("active");
        }
    })

    // TODO should this be in resizer?
    EventBus.on(COMMAND.CLEARSELECTION,()=>{
        if (sizeBox) sizeBox.classList.remove("active");
    })

    function createSizeBox(parent){
        sizeBox = $div("sizebox","",parent,e=>{
            resizeBox(e);
        });

        for (let i = 0; i< 8; i++){
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

        for (let i = 0; i< 4; i++){
            let rotateDot = $div("rotatedot d"+(i+1),"",sizeBox,function(e){

            });
            rotateDot.onDragStart = function(){
                let x = currentSize.left + currentSize.width/2;
                let y = currentSize.top + currentSize.height/2;
                touchData.rotateCenter = [x,y];
                touchData.startAngle = currentSize.rotation;
                if (i===0)  touchData.rotateStart= [currentSize.left,currentSize.top];
                if (i===1)  touchData.rotateStart= [currentSize.left+currentSize.width,currentSize.top];
                if (i===2)  touchData.rotateStart= [currentSize.left+currentSize.width,currentSize.top+currentSize.height];
                if (i===3)  touchData.rotateStart= [currentSize.left,currentSize.top+currentSize.height];
                touchData.isRotating = true;

            }
            rotateDot.onDrag = function(x,y,_touchData){
                touchData.rotateEnd = [touchData.rotateStart[0]+x,touchData.rotateStart[1]+y];
                let a ={x:touchData.rotateStart[0],y:touchData.rotateStart[1]};
                let b ={x:touchData.rotateCenter[0],y:touchData.rotateCenter[1]};
                let c ={x:touchData.rotateEnd[0],y:touchData.rotateEnd[1]};
                let angle = angle_between_points(c,b,a);
                angle += touchData.startAngle||0;
                if (Input.isShiftDown() && Input.isMouseDown()){
                    angle = Math.round(angle/15) * 15;
                }
                currentSize.angle=angle;
                currentSize.rotation=angle;
                sizeBox.style.transform = "rotate("+angle+"deg)";

                updateSizeBox();

            }
            rotateDot.onDragEnd = function(x,y){
                currentSize.rotation = currentSize.angle;
                delete  currentSize.angle;
                touchData.isRotating = false;
            }
            rotateDot.onmouseenter = function(){
                Cursor.set("rotate");
            }
            rotateDot.onmouseleave = function(){
                Cursor.reset();
            }
            rotateDot.index = i;
            rotateDots.push(rotateDot);
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

        if (Input.isShiftDown() && Input.isMouseDown() && !touchData.isRotating){
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

        rotateDots[1].style.left = dots[2].style.left;
        rotateDots[2].style.top = dots[4].style.top;
        rotateDots[2].style.left = dots[4].style.left;
        rotateDots[3].style.top = dots[6].style.top;


        if (updateHandler) updateHandler();

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

        me.set(l,t,w,h,currentSize?currentSize.rotation:0);

    }

    function angle_between_points( p1, p2, p3 ){
        // p2 is the center point;
        const ab = { x: p2.x - p1.x, y: p2.y - p1.y };
        const bc = { x: p3.x - p2.x, y: p3.y - p2.y };
        const radians = Math.atan2(bc.y, bc.x) - Math.atan2(ab.y, ab.x);
        const degrees = -(radians * 180 / Math.PI -180) % 360;
        return degrees;
    }
    
    return me;
}();

export default Resizer