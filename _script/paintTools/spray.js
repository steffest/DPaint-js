import Palette from "../ui/palette.js";
import ImageFile from "../image.js";
import EventBus from "../util/eventbus.js";
import {ANIMATION, EVENT} from "../enum.js";
import Animator from "../util/animator.js";
import ToolOptions from "../ui/components/toolOptions.js";
import Brush from "../ui/brush.js";
import {emitParticles} from "../util/sprayKernel.js";

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

        // spray draws into the layer's own canvas -> layer-local coordinates
        let x = touchData.layerX;
        let y = touchData.layerY;
        let color = touchData.button?Palette.getBackgroundColor():Palette.getDrawColor();

        touchData.isSpraying = true;
        touchData.drawLayer = ImageFile.getActiveLayer();
        touchData.drawLayer.draw(x,y,color,touchData);
        currentData = touchData;

        EventBus.trigger(EVENT.layerContentChanged);

        Animator.start(ANIMATION.SPRAY,()=>{
            let x = currentData.layerX;
            let y = currentData.layerY;
            let color = currentData.button?Palette.getBackgroundColor():Palette.getDrawColor();

            // Spec 016 phase 3 (R4): the ordered particle emission runs in the pure
            // kernel (util/sprayKernel.js) fed by Math.random, so the draw order,
            // rounding, and pressure sequence are byte-identical to the old inline
            // loop — only now the batch is materialised up front (enabling seeded
            // replay in tests and batched damage).
            let particles = emitParticles({x:x, y:y, size:size, count:speed, useOpacity:useOpacity, rng:Math.random});
            for (let i = 0; i < particles.length; i++){
                let p = particles[i];
                if (useOpacity) Brush.setPressure(p.pressure);
                currentData.drawLayer.draw(p.x,p.y,color,currentData);
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