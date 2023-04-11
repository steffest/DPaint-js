import $ from "../../util/dom.js";
import Palette from "../palette.js";
import Color from "../../util/color.js";
import Eventbus from "../../util/eventbus.js";
import {COMMAND} from "../../enum.js";
let PaletteList = function(){
    let me = {};
    let container;
    let parent;

    me.init = function(_parent){
        parent = _parent;
        Eventbus.on(COMMAND.TOGGLEPALETTES,me.toggle);
    }

    me.toggle = function(){
        if (document.body.classList.contains("withpalettelist")){
            me.hide();
        }else{
            me.show();
        }
    }

    me.show = ()=>{
        if (!container) generate();
        document.body.classList.add("withpalettelist");
        container.classList.add("active");
    }

    me.hide = ()=>{
        document.body.classList.remove("withpalettelist");
        container.classList.remove("active");
    }

    function generate(){
        container = $(".palettelist",
            $(".caption","Palettes",
                $(".close",{
                    onClick:me.hide
                },"x")
            )
        );

        let list = Palette.getPaletteMap();
        for (let key in list){
            renderPalette(list[key]);
        }
        container.appendChild($(".buttons",
            $(".button",{onClick:()=>{Eventbus.trigger(COMMAND.LOADPALETTE)}}, "Load Palette"),
            $(".button",{onClick:()=>{Eventbus.trigger(COMMAND.SAVEPALETTE)}}, "Save Palette")
        ));
        parent.appendChild(container);
    }

    function renderPalette(palette){
        let colors = palette.palette;
        if (colors){
            let canvas,ctx;
            $(".palette",
                {parent:container,onClick:()=>{
                        Palette.set(colors);
                    }},
                $(".caption",palette.label),
                canvas = $("canvas")
            );

            canvas.width = 80;
            canvas.height = Math.ceil(colors.length/8) * 10;
            ctx = canvas.getContext("2d");
            colors.forEach((color,index)=>{
                ctx.fillStyle = Color.toString(color);
                ctx.fillRect((index%8)*10,Math.floor(index/8)*10,10,10);
            });
        }
    }

    return me;
}();

export default PaletteList;