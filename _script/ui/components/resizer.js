import EventBus from "../../util/eventbus.js";
import {COMMAND, EVENT} from "../../enum.js";
import {$div} from "../../util/dom.js";
import Editor from "../editor.js";
import Input from "../input.js";
import Cursor from "../cursor.js";
import StatusBar from "../statusbar.js";

var Resizer = function(editor){
    let me = {};
    let currentSize;
    let previousSize;
    let sizeBox;
    let updateHandler;
    let dots = [];
    let rotateDots = [];
    let touchData = {};
    let aspectRatio = 1;
    let canRotate = false;
    // Whole-pixel snapping is right for a raster layer (the box maps to pixel resampling), but a
    // vector layer in "smooth"/"vector" display mode keeps sub-pixel precision everywhere else
    // (docToGeoAt et al) — callers pass round:false there so Free Transform doesn't quietly harden
    // every move/scale to the grid. Defaults to true (the pre-existing raster-layer behaviour).
    let roundToPixel = true;

    me.init = function(options){
        options = options || {};
        if (!sizeBox) createSizeBox(editor.getViewPort());
        sizeBox.classList.add("active");
        sizeBox.classList.toggle("hot",!!options.hot);
        if (!options.silent) {
            touchData.isResizing = false;
            aspectRatio = options.aspect || 1;
        }
        canRotate = !!options.canRotate;
        sizeBox.classList.toggle("canrotate",canRotate);
        roundToPixel = options.round !== false;
        previousSize = undefined;
        currentSize = undefined;

        setSize(options.x,options.y,options.width,options.height,options.rotation,options.silent);
    }

    function setSize(x,y,w,h,rotation,silent,dotIndex){
        previousSize = Object.assign({},currentSize);
        currentSize = {
            left: roundToPixel ? Math.round(x) : x,
            top: roundToPixel ? Math.round(y) : y,
            width: roundToPixel ? Math.round(w) : w,
            height: roundToPixel ? Math.round(h) : h,
            rotation: rotation
        }
        if (!rotation){
            sizeBox.style.transform = "none";
        }

        updateSizeBox();
        if (!silent){
            EventBus.trigger(EVENT.sizerChanged,{
                from: previousSize,
                to: currentSize,
                // Which handle drove this change (8 = whole-box move, 0-7 = a resize handle),
                // undefined for anything not driven by an actual pointer drag (init, arrow-key
                // nudge, the shift-aspect-lock replay below). selectbox.js's ctrl-drag pixel
                // move/resize needs this to tell "a move" from "a resize" reliably — inferring it
                // from from/to deltas alone is ambiguous (a single-axis resize handle leaves the
                // other axis, or a momentarily-stationary frame leaves both, looking identical to
                // a move).
                dotIndex: dotIndex
            });
        }
    }

    me.setOnUpdate = function(handler){
        updateHandler = handler;
    }

    me.commit = function(){
        if (sizeBox) sizeBox.classList.remove("hot");
        updateHandler = undefined;
    }
    
    me.get = function(){
        return currentSize;
    }

    me.move = function(x,y){
        if (me.isActive() && currentSize){
            EventBus.trigger(EVENT.sizerStartChange);
            //TODO: this still crops the canvas if we move outside the canvas

            previousSize = Object.assign({},currentSize);
            currentSize.left += x;
            currentSize.top += y;
            updateSizeBox();
            EventBus.trigger(EVENT.sizerChanged,{
                from: previousSize,
                to: currentSize
            });
        }
    }

    me.zoom = function(zoom){
        updateSizeBox();
    }

    me.isActive = function(){
        return sizeBox && sizeBox.classList.contains("active");
    }

    me.remove = function(){
        previousSize = undefined;
        if(sizeBox) sizeBox.classList.remove("active");
    }


    EventBus.on(EVENT.modifierKeyChanged,function(){
        if (sizeBox && sizeBox.classList.contains("active") && currentSize){
            let before = Object.assign({}, currentSize);
            // On Shift release during a drag, restore the original unconstrained dimensions
            if (!Input.isShiftDown() && Input.isPointerDown() && currentSize._width){
                currentSize.width = currentSize._width;
                currentSize.height = currentSize._height;
                delete currentSize._width;
                delete currentSize._height;
            }
            updateSizeBox();
            if (currentSize.width !== before.width || currentSize.height !== before.height ||
                    currentSize.left !== before.left || currentSize.top !== before.top){
                previousSize = before;
                EventBus.trigger(EVENT.sizerChanged, {from: previousSize, to: currentSize});
            }
        }
    });

    EventBus.on(COMMAND.CLEARSELECTION,()=>{
        me.remove();
    })

    EventBus.on(EVENT.imageSizeChanged,()=>{
        me.remove();
    });

    function createSizeBox(parent){
        sizeBox = $div("sizebox","",parent,e=>{
            resizeBox(e);
        });
        sizeBox.classList.toggle("canrotate",canRotate);

        for (let i = 0; i< 8; i++){
            let dot = $div("sizedot","",sizeBox,function(e){
                resizeBox(e);
            });

            dot.onDragStart = function(){
                EventBus.trigger(EVENT.sizerStartChange);
            }
            dot.onDrag = function(x,y){
                handleDrag(x,y,dot)
            }
            dot.onDragEnd = function(x,y){
                sizeBox.classList.remove("hot");
                EventBus.trigger(EVENT.sizerEndChange);
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
                if (Input.isShiftDown() && Input.isPointerDown()){
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
            rotateDot.onpointerenter = function(){
                Cursor.set("rotate");
            }
            rotateDot.onpointerleave = function(){
                Cursor.reset();
            }
            rotateDot.index = i;
            rotateDots.push(rotateDot);
        }

        sizeBox.onDragStart = function(x,y){
            EventBus.trigger(EVENT.sizerStartChange);
        }
        sizeBox.onDrag = function(x,y){
            handleDrag(x,y,{index:8})
        }
        sizeBox.onDragEnd = function(x,y){
            sizeBox.classList.remove("hot");
            EventBus.trigger(EVENT.sizerEndChange);
        }
    }

    function updateSizeBox(){
        if (!currentSize) return;
        var parent = editor.getCanvas();
        let viewport = editor.getViewPort();
        var rect = parent.getBoundingClientRect();
        var rect2 =  viewport.getBoundingClientRect();
        let zoom = editor.getZoom();

        if (Input.isShiftDown() && Input.isPointerDown() && !touchData.isRotating){
            // aspect ratio lock — use the original selection AR when resizing a handle, otherwise use aspectRatio (1 = square for new selections)
            let ar = (touchData.isResizing && touchData.startSelectHeight)
                ? touchData.startSelectWidth / touchData.startSelectHeight
                : aspectRatio;
            currentSize._width = currentSize._width||currentSize.width;
            currentSize._height = currentSize._height||currentSize.height;
            let w = currentSize._width;
            let h = w / ar;
            if (w>currentSize.width || h>currentSize.height){
                h = currentSize.height;
                w = h * ar;
            }
            if (roundToPixel){ w = Math.round(w); h = Math.round(h); }
            currentSize.width = w;
            currentSize.height = h;
        }

        let wz = currentSize.width*zoom;
        let hz = currentSize.height*zoom;

        let xz = (rect.left - rect2.left + viewport.scrollLeft + currentSize.left*zoom);
        let yz = (rect.top - rect2.top + viewport.scrollTop + currentSize.top*zoom);

        sizeBox.style.left =  xz + "px";
        sizeBox.style.top =  yz  + "px";
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

        let text = "x:" +currentSize.left + " y:" + currentSize.top + " w:" + currentSize.width + " h:" + currentSize.height;
        if (currentSize.rotation) text += " " + Math.round(currentSize.rotation) + "°";
        StatusBar.setToolTip(text);

        if (updateHandler) updateHandler();

    }

    function resizeBox(){
        touchData.isResizing = true;
        touchData.isdown = true;
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

        if (Input.isShiftDown() && dot.index === 8){
            if (Math.abs(xz) > Math.abs(yz)){
                yz = 0;
            }else{
                xz = 0;
            }
        }

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

        setSize(l,t,w,h,currentSize?currentSize.rotation:0,false,dot.index);

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
};

export default Resizer