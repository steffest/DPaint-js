import Input from "../ui/input.js";
import ImageFile from "../image.js";
import EventBus from "../util/eventbus.js";
import {COMMAND, EVENT, ANIMATION} from "../enum.js";
import Animator from "../util/animator.js";
import ToolOptions from "../ui/components/toolOptions.js";

let Text = (()=>{
    let me = {};
    let currentText = {};
    let cursorOn;
    let isActive ;

    me.start=(touchData)=>{
        if (isActive) me.stop();
        Input.setActiveKeyHandler(keyHandler);
        currentText.layerIndex = ImageFile.addLayer(ImageFile.getActiveLayerIndex()+1,"Text");
        ImageFile.activateLayer(currentText.layerIndex);
        currentText.layer = ImageFile.getLayer(currentText.layerIndex);
        currentText.ctx = currentText.layer.getContext();
        currentText.x = touchData.x;
        currentText.y = touchData.y;
        currentText.text = "";
        currentText.fontSize = ToolOptions.getFontSize();
        currentText.ctx.font = currentText.fontSize + "px " + ToolOptions.getFont();
        cursorOn = true;
        isActive = true;
        drawText();
        Animator.start(ANIMATION.TEXT,()=>{
            cursorOn = !cursorOn;
            drawText();
        },2);
    }

    me.stop=(commit)=>{
        Input.setActiveKeyHandler(null);
        Animator.stop(ANIMATION.TEXT);
        currentText.text = currentText.text || "";
        if (currentText.text.length === 0 && currentText.layerIndex){
            ImageFile.removeLayer(currentText.layerIndex);
        }else{
            currentText.layer.clear();
            cursorOn = false;
            drawText();
        }
        currentText = {};
        isActive = false;
        if (commit) EventBus.trigger(COMMAND.DRAW);
    }

    function keyHandler(code,key){
        switch (code){
            case "enter":
            case "escape":
                me.stop(true);
                break;
            case "backspace":
                currentText.text = currentText.text.slice(0,-1);
                drawText();
                return true;
            default:
                if (key.length > 1) return false;
                let char=key;
                if (Input.isMetaDown()) char = char.toUpperCase();
                currentText.text += char;
                drawText();
                return true;
        }
    }

    function drawText(){
        currentText.layer.clear();
        currentText.ctx.fillText(currentText.text,currentText.x,currentText.y);
        if (cursorOn){
            let w = Math.ceil(currentText.ctx.measureText(currentText.text).width);
            currentText.ctx.beginPath();
            currentText.ctx.strokeStyle = "black";
            currentText.ctx.lineWidth = 2;
            currentText.ctx.moveTo(currentText.x + w,currentText.y-currentText.fontSize+2);
            currentText.ctx.lineTo(currentText.x + w,currentText.y+1);
            currentText.ctx.stroke();
        }
        EventBus.trigger(EVENT.layerContentChanged);
    }

    EventBus.on(EVENT.toolChanged,()=>{
        if (isActive) me.stop();
    });

    EventBus.on(EVENT.fontStyleChanged,(font)=>{
       if (isActive && currentText.ctx){
           currentText.ctx.font = font.size + "px " + font.name;
           currentText.fontSize = font.size;
           drawText();
       }
    });


    return me;
})();

export default Text;