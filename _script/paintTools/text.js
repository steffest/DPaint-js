import Input from "../ui/input.js";
import ImageFile from "../image.js";
import EventBus from "../util/eventbus.js";
import {COMMAND, EVENT, ANIMATION} from "../enum.js";
import Animator from "../util/animator.js";
import ToolOptions from "../ui/components/toolOptions.js";
import Palette from "../ui/palette.js";
import {getFontNames, getFontDefinition, loadFont} from "../util/fonts.js";

let Text = (()=>{
    let me = {};
    let currentText = {};
    let cursorOn;
    let isActive ;

    // TODO: load Amiga fonts
    // see https://github.com/smugpie/amiga-bitmap-font-tools

    // TODO: implement bitmap fonts
    // https://github.com/ianhan/BitmapFonts
    // https://www.spriters-resource.com/amiga_amiga_cd32/gods/sheet/111137/

    me.start=async (touchData)=>{
        if (isActive) me.stop();
        Input.setActiveKeyHandler(keyHandler);
        currentText.layerIndex = ImageFile.addLayer(ImageFile.getActiveLayerIndex()+1,"Text");
        ImageFile.activateLayer(currentText.layerIndex);
        currentText.layer = ImageFile.getLayer(currentText.layerIndex);
        currentText.ctx = currentText.layer.getContext();
        // text is rendered into the layer's own canvas -> layer-local coordinates
        currentText.x = touchData.layerX;
        currentText.y = touchData.layerY;
        currentText.text = "";
        currentText.fontSize = ToolOptions.getFontSize();
        currentText.ctx.font = currentText.fontSize + "px " + ToolOptions.getFont();
        currentText.color = Palette.getDrawColor();
        cursorOn = true;
        isActive = true;
        await loadFont(ToolOptions.getFont());
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

    me.getFonts = ()=>{
        return getFontNames();
    }

    function keyHandler(code,key,rawKey){
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
                // rawKey preserves the actual Shift/CapsLock-resolved character (e.g. Shift+C ->
                // "C") — `key` has already been lowercased by input.js for the tool-shortcut
                // switches, which don't care about case.
                currentText.text += rawKey;
                drawText();
                return true;
        }
    }

    function drawText(){
        currentText.layer.clear();
        currentText.ctx.fillStyle = currentText.color;
        currentText.ctx.fillText(currentText.text,currentText.x,currentText.y);
        if (cursorOn){
            let w = Math.ceil(currentText.ctx.measureText(currentText.text).width);
            currentText.ctx.beginPath();
            currentText.ctx.strokeStyle = currentText.color;
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

    EventBus.on(EVENT.fontStyleChanged,async font=>{
       if (isActive && currentText.ctx){
           await loadFont(getFontDefinition(font.name));
           currentText.ctx.font = font.size + "px " + font.name;
           currentText.fontSize = font.size;
           drawText();
       }
    });

    EventBus.on(EVENT.drawColorChanged,()=>{
        if (isActive){
            currentText.color = Palette.getDrawColor();
            drawText();
        }
    });


    return me;
})();

export default Text;