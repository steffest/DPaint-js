import ImageFile from "../../image.js";
import $, {$checkbox, $div} from "../../util/dom.js";
import Input from "../input.js";
import Animator from "../../util/animator.js";
import Palette from "../palette.js";
import EventBus from "../../util/eventbus.js";
import {EVENT} from "../../enum.js";
import Color from "../../util/color.js";
import PaletteDialog from "./paletteDialog.js";

let ColorRange = function(){
    let me = {};

    let colorRangeContext = []
    let playButton;
    let container;
    let currentRange = undefined;
    let rangesPanel;

    me.render = (parent)=>{
        container = parent || container;
        container.innerHTML = "";
        colorRangeContext = [];
        let image = ImageFile.getCurrentFile();
        let buttons = $(".bottom",{parent:container},$(".button.small.add",{
            onclick:()=>{
                ImageFile.addRange();
            }
        },"Add Range"));
        if (image.colorRange && image.colorRange.length){
            $(".captions",{parent:container},$(".a","Active"),$(".b","Speed (fps)"),$(".c","Colors"));
            rangesPanel =  $(".ranges",{parent:container,onClick:deActivateRange})

            image.colorRange.forEach((range,index)=>{
                let rangeContainer = $div("range" + (currentRange===index?" active":""),"",rangesPanel,()=>{
                    deActivateRange();
                    currentRange = index;
                    rangeContainer.classList.add("active");
                    EventBus.trigger(EVENT.colorRangeChanged);
                });
                $checkbox("",rangeContainer,"",(checked)=>{
                    range.active = checked;
                    colorRangeContext[index].canvas.classList.toggle("inactive",!checked);
                },range.active)
                let slider = $("input.slider",{type:"range",parent:rangeContainer,min:-60,max:60,value:(range.fps * (range.reverse?-1:1)),oninput:()=>{
                        range.fps = Math.abs(slider.value);
                        speed.value = slider.value;
                        range.reverse = slider.value<0;
                    }});

                let speed = $("input.speed",{
                    type:"text",
                    parent:rangeContainer,
                    value:range.fps * (range.reverse?-1:1),
                    oninput:()=>{
                        range.fps = Math.abs(speed.value);
                        slider.value = speed.value;
                        range.reverse = speed.value<0;
                    },
                    onkeydown: (e)=>{
                        e.stopPropagation();
                    }
                });

                if (range.high){
                    range.low = range.low || 0;
                    let length = range.high - range.low + 1;
                    let canvas = $("canvas",{
                        width:length*10,
                        height:20,
                        parent:rangeContainer,
                        onClick:()=>{
                            canvas.classList.toggle("active");
                            if (canvas.classList.contains("active")){
                                deActivateRange();
                                PaletteDialog.setPaletteClickAction("rangefrom");
                                currentRange = index;
                                canvas.classList.add("active");
                                rangeContainer.classList.add("active");
                                let dupe = $div("dragelement tooltip","Select range: From color");
                                Input.setDragElement(dupe,true);
                                EventBus.trigger(EVENT.colorRangeChanged);
                            }else{
                                PaletteDialog.clearPaletteClickAction();
                            }
                        }
                    });
                    drawRange(canvas.getContext("2d"),range);
                    colorRangeContext[index] = (canvas.getContext("2d"));
                }
            });

            playButton = $div("button small" + (Animator.isRunning()?" active":""),Animator.isRunning()?"Stop":"Play",buttons,Palette.cycle);
        }else{
            $div("norange","No ranges specified",container);
        }
    }

    me.cleanUp = ()=>{
        colorRangeContext = [];
        currentRange = undefined;
        EventBus.trigger(EVENT.colorRangeChanged);
    }

    me.getActiveRange = ()=>{
        return currentRange;
    }

    me.setFrom = (index)=>{
        let range = ImageFile.getCurrentFile().colorRange[currentRange];
        range.low = index;
        updateRange(range);
    }

    me.setTo = (index)=>{
        let range = ImageFile.getCurrentFile().colorRange[currentRange];
        range.high = index;
        updateRange(range,true);
    }

    function deActivateRange(){
        currentRange = undefined;
        if (rangesPanel){
            let r = rangesPanel.querySelector(".range.active")
            if (r){
                r.classList.remove("active")
                r.querySelector("canvas").classList.remove("active")
            }
            PaletteDialog.clearPaletteClickAction();
        }
        EventBus.trigger(EVENT.colorRangeChanged);
    }

    function updateRange(range,done){
        if (range.low>range.high){
            if (done){
                let temp = range.low;
                range.low = range.high;
                range.high = temp;
            }else{
                range.high = range.low;
            }
        }
        let ctx = colorRangeContext[currentRange];
        if (ctx){
            let length = range.high - range.low + 1;
            ctx.canvas.width = length*10;
            if (done) ctx.canvas.classList.remove("active");
            drawRange(ctx,range);
        }
        EventBus.trigger(EVENT.colorRangeChanged);
    }

    function drawRange(ctx,range){
        for (let i=range.low;i<=range.high;i++){
            let index = i-(range.index || 0);
            if (index<range.low) index += range.max;
            let color = Palette.get()[index];
            ctx.fillStyle = Color.toString(color);
            ctx.fillRect((i-range.low)*10,0,10,20);
        }
    }


    EventBus.on(EVENT.colorCycleToggled,()=>{
        if (playButton){
            let isActive = Animator.isRunning();
            playButton.classList.toggle("active",isActive);
            playButton.innerHTML = isActive ? "Stop" : "Play";
        }
    });

    EventBus.on(EVENT.colorRangesChanged,()=>{
        me.render()
    })

    EventBus.on(EVENT.colorCycleChanged,(index)=>{
        if (colorRangeContext[index]){
            let range = ImageFile.getCurrentFile().colorRange[index];
            drawRange(colorRangeContext[index],range);
        }
    });

    return me;
}();

export default ColorRange;