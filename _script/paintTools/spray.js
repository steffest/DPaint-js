import Palette from "../ui/palette.js";
import ImageFile from "../image.js";
import EventBus from "../util/eventbus.js";
import {ANIMATION, EVENT} from "../enum.js";
import Animator from "../util/animator.js";
import ToolOptions from "../ui/components/toolOptions.js";
import Brush from "../ui/brush.js";

let Spray = (()=>{

    let me={};
    let currentData;
    let speed = 4;
    let size = 20;
    let useOpacity = true;

    me.start=function(touchData){
        size = parseInt(ToolOptions.getSpread()) + 1;
        speed = Math.floor(ToolOptions.getStrength()*20) + 1;
        useOpacity = ToolOptions.usePressure();
        if (!useOpacity) Brush.setPressure(1);

        let {x,y} = touchData;
        let color = touchData.button?Palette.getBackgroundColor():Palette.getDrawColor();

        touchData.isSpraying = true;
        touchData.drawLayer = ImageFile.getActiveLayer();
        touchData.drawLayer.draw(x,y,color,touchData);
        currentData = touchData;

        EventBus.trigger(EVENT.layerContentChanged);

        Animator.start(ANIMATION.SPRAY,()=>{
            let {x,y} = currentData;
            let color = currentData.button?Palette.getBackgroundColor():Palette.getDrawColor();

            for (let i = 0; i < speed; i++){
                let angle = Math.random() * Math.PI * 2;
                let radius = Math.sqrt(Math.random()) * size;
                let _x = Math.round(x + radius * Math.cos(angle));
                let _y = Math.round(y + radius * Math.sin(angle));
                if (useOpacity) Brush.setPressure(Math.random());
                currentData.drawLayer.draw(_x,_y,color,currentData);
            }

            EventBus.trigger(EVENT.layerContentChanged);
        },50);


    }

    me.stop=function(){
        if (!currentData) return;
        currentData.isSpraying = false;
        Animator.stop(ANIMATION.SPRAY);
    }

    return me;
})();

export default Spray;