import $ from "../../util/dom.js";
import Palette from "../palette.js";
import Color from "../../util/color.js";
import Eventbus from "../../util/eventbus.js";
import {COMMAND, EVENT} from "../../enum.js";
let PaletteList = function(){
    let me = {};
    let container;
    let parent;
    let inner;
    let showGeneral = true;
    let showPlatform = false;

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
        if (!container){
            container = $(".palettelist",$(".caption","Palettes",
                $(".close",{
                    onClick:me.hide
                },"x")
            ),inner = $(".inner"));
            parent.appendChild(container);
        }
        inner.innerHTML = "";

        let list = Palette.getPaletteMap();

        inner.appendChild($(".group" + (showGeneral?".active":""),{onClick:()=>{showGeneral=!showGeneral; generate()}},"General"));

        if (showGeneral){
            for (let key in list){
                if (!list[key].platform) renderPalette(list[key]);
            }
        }

        inner.appendChild($(".group" + (showPlatform?".active":""),{onClick:()=>{showPlatform=!showPlatform; generate()}},"Retro platforms"));
        if (showPlatform){
            for (let key in list){
                if (list[key].platform) renderPalette(list[key]);
            }
        }

        inner.appendChild($(".buttons",
            $(".button",{onClick:()=>{Eventbus.trigger(COMMAND.LOADPALETTE)}}, "Load Palette"),
            $(".button",{onClick:()=>{Eventbus.trigger(COMMAND.SAVEPALETTE)}}, "Save Palette")
        ));
    }

    function renderPalette(palette){
        let preset = palette.palette;
        if (preset){
            let canvas,ctx,colors;
            $(".palette",
                {parent:inner,onClick:()=>{
                        Palette.set(colors);
                        Eventbus.trigger(EVENT.paletteChanged);
                    }},
                $(".caption",palette.label),
                canvas = $("canvas")
            );

            Palette.loadPreset(palette).then(_colors=>{
                colors = _colors;
                canvas.width = 80;
                let size = colors.length>32 ? 5:10;
                let colorsPerRow = Math.floor(canvas.width/size);
                canvas.height = Math.ceil(colors.length/colorsPerRow) * size;
                ctx = canvas.getContext("2d");
                colors.forEach((color,index)=>{
                    ctx.fillStyle = Color.toString(color);
                    ctx.fillRect((index%colorsPerRow)*size,Math.floor(index/colorsPerRow)*size,size,size);
                });
            });
        }
    }

    return me;
}();

export default PaletteList;