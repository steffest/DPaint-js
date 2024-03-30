import Input from "../ui/input.js";
import ImageFile from "../image.js";
import EventBus from "../util/eventbus.js";
import {COMMAND, EVENT, ANIMATION} from "../enum.js";
import Animator from "../util/animator.js";
import ToolOptions from "../ui/components/toolOptions.js";
import Palette from "../ui/palette.js";

let Text = (()=>{
    let me = {};
    let currentText = {};
    let cursorOn;
    let isActive ;

    let fonts = [
        {name:"Arial"},
        {name:"Courier New"},
        {name:"Georgia"},
        {name:"GillSans-UltraBold"},
        {name:"Times New Roman"},
        {name:"Topaz Serif", url:"_font/amiga-topaz.otf"},
        {name:"Topaz Sans", url:"_font/topaz-8.ttf"},
        {name:"Verdana"}
    ]

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
        currentText.x = touchData.x;
        currentText.y = touchData.y;
        currentText.text = "";
        currentText.fontSize = ToolOptions.getFontSize();
        currentText.ctx.font = currentText.fontSize + "px " + ToolOptions.getFont();
        currentText.color = Palette.getDrawColor();
        cursorOn = true;
        isActive = true;
        let font = fonts.find(f=>f.name === ToolOptions.getFont());
        await loadFont(font);
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
        return fonts.map(f=>f.name);
    }

    function loadFont(font){
        return new Promise((next)=>{
            if (font && font.url && !font.loaded){
                const fontFace = new FontFace(font.name, 'url('+font.url+')');
                fontFace.load().then(loadedFont=>{
                    document.fonts.add(loadedFont);
                    font.loaded = true;
                    console.log("Font " + font.name + " loaded");
                    next();
                }).catch(err=>{
                    console.error("Error loading font " + font.name,err);
                    next();
                });
            }else{
                next();
            }
        });
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
           let f = fonts.find(f=>f.name === font.name);
           await loadFont(f);
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