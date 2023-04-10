import {$checkbox, $div, $elm, $input} from "../../util/dom.js";
import Effects from "../effects.js";
import modal from "../modal.js";
import ImageFile from "../../image.js";
import Canvas from "../canvas.js";
import {duplicateCanvas, releaseCanvas} from "../../util/canvasUtils.js";
import EventBus from "../../util/eventbus.js";
import {EVENT} from "../../enum.js";
import SyntaxEdit from "./syntaxEdit.js";

var EffectDialog = function() {
    let me = {};
    let effects = [];
    let previewCanvas;
    let livePreview;
    let codePanel;
    let currentSource;
    let mainPanel;

    me.render = function (container,modal) {
        if (!previewCanvas){
            previewCanvas = document.createElement("canvas");
            previewCanvas.width = 200;
            previewCanvas.height = 200;
        }

        container.innerHTML = "";
        mainPanel = $div("effects panel form","",container);

        let tabs = $div("tabs","",mainPanel);
        let generalTab = $div("tab active","General",tabs,()=>{
            generalTab.classList.add('active');
            alchemyTab.classList.remove('active');
            sliders.classList.add("active");
            alchemy.classList.remove('active');
            if (codePanel){
                codePanel.innerHTML = "";
                codePanel = undefined;
            }
        });
        let alchemyTab = $div("tab","Alchemy",tabs,()=>{
            generalTab.classList.remove('active');
            alchemyTab.classList.add('active');
            sliders.classList.remove("active");
            alchemy.classList.add('active');
        });


        let sliders = $div("sliders active","",mainPanel);

        currentSource = duplicateCanvas(ImageFile.getActiveLayer().getCanvas(),true);

        Effects.setSrcTarget(currentSource,previewCanvas.getContext("2d"))

        createSlider(sliders,"Brightness",0,-50,50,(value)=>{
            Effects.setBrightness(value); update();
        });
        createSlider(sliders,"Contrast",0,-50,50,(value)=>{
            Effects.setContrast(value); update();
        });
        createSlider(sliders,"Saturation",0,-50,50,(value)=>{
            Effects.setSaturation(value); update();
        });
        createSlider(sliders,"Hue",0,-180,180,(value)=>{
            Effects.setHue(value); update();
        });
        createSlider(sliders,"Blur",0,0,100,(value)=>{
            Effects.setBlur(value); update();
        });
        createSlider(sliders,"Sharpen",0,0,100,(value)=>{
            Effects.setSharpen(value); update();
        });
        createSlider(sliders,"Sepia",0,0,100,(value)=>{
            Effects.setSepia(value); update();
        });
        createSlider(sliders,"Invert",0,0,100,(value)=>{
            Effects.setInvert(value); update();
        });
        createSlider(sliders,"Cyan/Red",0,-100,100,(value)=>{
            Effects.setColorBalance("red",value); update();
        });
        createSlider(sliders,"Magenta/Green",0,-100,100,(value)=>{
            Effects.setColorBalance("green",value); update();
        });
        createSlider(sliders,"Yellow/Blue",0,-100,100,(value)=>{
            Effects.setColorBalance("blue",value); update();
        });


        /* alchemy */
        codePanel = undefined;
        let alchemy = $div("alchemy","",mainPanel);

        let recipes=[
            {name: "Dabble", file:"dots"},
            {name: "Speckles", file:"speckles"},
            {name: "Lines", file:"lines"},
            {name: "Lines Curved", file:"linescurved"},
            {name: "Glow", file:"glow"},
            //{name: "Webby", file:"web"},
            //{name: "Texture", file:"texture"},
        ]

        recipes.forEach(recipe=>{
            $div("recipe",recipe.name,alchemy,()=>{
                loadRecipe(recipe.file);
            })
        })



        /* previewPanel */

        let previewPanel = $div("previewpanel","",mainPanel);
        let p = $div("preview","",previewPanel);
        p.appendChild(previewCanvas);
        $checkbox("Preview",previewPanel,"",checked=>{
            livePreview = checked;
            update();
        });

        let buttons = $div("buttons","",mainPanel);
        $div("button ghost left","Reset",buttons,()=>{
            Effects.hold();
            effects.forEach(slider=>{
                slider.value = 0;
                slider.oninput();
            });
            Effects.apply();
        });
        $div("button ghost","Cancel",buttons,()=>{
            let t = ImageFile.getActiveLayer().getContext();
            t.clearRect(0,0,t.canvas.width,t.canvas.height);
            t.drawImage(currentSource,0,0);
            modal.hide();
            releaseCanvas(currentSource);
            EventBus.trigger(EVENT.layerContentChanged);
        });
        $div("button primary","Apply",buttons,()=>{
            if (codePanel){

            }else{
                let t = ImageFile.getActiveLayer().getContext();
                Effects.setSrcTarget(currentSource,t);
                Effects.apply();
            }
            releaseCanvas(currentSource);
            modal.hide();
            EventBus.trigger(EVENT.layerContentChanged);
        });

        Effects.clear();

    }

    function createSlider(parent,label,value,min,max,onInput){
        let result = $div("slider");
        let labelElm = $elm("label",label,result);
        let range = $input("range",value,result);
        let valueElm = $input("text",value,result);
        range.min = min||0;
        range.max = max||100;
        range.className = label.toLowerCase().split("/")[0];
        range.ondblclick = ()=>{
            range.value = value;
            range.oninput();
        }
        range.oninput = ()=>{
            valueElm.value = range.value;
            if (onInput) onInput(range.value);
        }
        valueElm.onkeydown = modal.inputKeyDown;
        valueElm.oninput = ()=>{
            let p = parseInt(valueElm.value);
            if (isNaN(p)) p=0;
            if (p<min) p=min;
            if (p>max) p=max;
            range.value = p;
            if (onInput) onInput(range.value);
        }
        if (parent) parent.appendChild(result);
        effects.push(range);
    }

    function update(){
        if (livePreview){
            Effects.setSrcTarget(currentSource,ImageFile.getActiveLayer().getContext());
            Effects.apply();
            Effects.setSrcTarget(currentSource,previewCanvas.getContext("2d"));
            EventBus.trigger(EVENT.layerContentChanged);
        }
    }

    async function loadRecipe(recipe){
        let textarea;
        let button;
        let process;
        if (codePanel){
            codePanel.remove();
            codePanel = undefined;
        }


        codePanel = $div("code","",mainPanel);
        textarea = SyntaxEdit(codePanel,(value)=>{
            console.log("updating function");
            let f  = new Function("source", "target", 'return ' + value);
            process = f();
        })


        $div("button primary","Run",codePanel,()=>{
            console.error(typeof process);
            if (typeof process === "function"){
                let source = currentSource;
                //let target = ImageFile.getActiveLayer().getContext();
                let target = previewCanvas.getContext("2d");
                process(source,target);
                if(livePreview){
                    target = ImageFile.getActiveLayer().getContext();
                    process(source,target);
                }
                EventBus.trigger(EVENT.layerContentChanged);
            }
        })


        process = (await import("../../alchemy/"+recipe+".js")).default
        if (typeof process === "function"){
            textarea.setValue(process.toString());
        }
    }


    return me;
}();

export default EffectDialog;