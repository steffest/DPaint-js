import {$div} from "../util/dom.js";
import EventBus from "../util/eventbus.js";
import {EVENT} from "../enum.js";
import Color from "../util/color.js";

let Palette = function(){
    let me = {};
    var container;

    var drawColor = "white";
    var backgroundColor = "black"

    var colors = [
        [149,149,149],
        [0,0,0],
        [255,255,255],
        [59,103,162],
        [123,123,123],
        [175,175,175],
        [170,144,124],
        [255,169,151]
    ]

    me.init = function(parent){
        container = $div("palette","",parent);

        let display = $div("display","",container);
        let front = $div("front","",display);
        let back = $div("back","",display);

        colors.forEach(color=>{
            let c = $div("color","",container,(e)=>{
                me.setColor(color,e.button);
            });
            c.style.backgroundColor = "rgb(" + color[0] + "," + color[1] + "," + color[2] + ")";
        })


        EventBus.on(EVENT.drawColorChanged,(color)=>{
            front.style.backgroundColor = "rgb(" + color[0] + "," + color[1] + "," + color[2] + ")";
        });
        EventBus.on(EVENT.backgroundColorChanged,(color)=>{
            back.style.backgroundColor = "rgb(" + color[0] + "," + color[1] + "," + color[2] + ")";
        });

        me.setColor(colors[2],false);
        me.setColor(colors[1],true);
    }

    me.setColor=function(color,back){
        if (back){
            backgroundColor = Color.toString(color);
            EventBus.trigger(EVENT.backgroundColorChanged,color);
        }else{
            drawColor = Color.toString(color);
            console.error(drawColor);
            EventBus.trigger(EVENT.drawColorChanged,color);
        }
    }

    me.getDrawColor = function(){
        return drawColor;
    }

    me.getBackgroundColor = function(){
        return backgroundColor;
    }


    return me;
}();

export default Palette;