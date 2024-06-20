import {$checkbox, $div, $elm, $input} from "../../util/dom.js";
import Effects from "../effects.js";
import modal from "../modal.js";
import ImageFile from "../../image.js";
import Canvas from "../canvas.js";
import {duplicateCanvas, releaseCanvas} from "../../util/canvasUtils.js";
import EventBus from "../../util/eventbus.js";
import {EVENT} from "../../enum.js";
import SyntaxEdit from "./syntaxEdit.js";
import Palette from "../palette.js";
import ImageProcessing from "../../util/imageProcessing.js";
import HistoryService from "../../services/historyservice.js";

var EffectDialog = function() {
    let me = {};
    let effects = [];
    let previewCanvas;
    let livePreview = true;
    let codePanel;
    let currentSource;
    let currentRecipeSource;
    let mainPanel;

    me.render = function (container,modal) {
        if (!previewCanvas){
            previewCanvas = document.createElement("canvas");
            previewCanvas.width = 200;
            previewCanvas.height = 200;
        }else{
            previewCanvas.getContext("2d").clearRect(0,0,previewCanvas.width,previewCanvas.height);
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
        HistoryService.start(EVENT.layerContentHistory);

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
            {name: "Glow", file:"glow"},
            {name: "Frost", file:"web"},
            {name: "Displace", file:"displace"},
            {name: "Offset", file:"offset"},
            //{name: "BeachShadow", file:"beachshadow"},
            //{name: "Texture", file:"texture"},
        ]

        recipes.forEach(recipe=>{
            $div("recipe",recipe.name,alchemy,()=>{
                loadRecipe(recipe.file,recipe.name);
            })
        })



        /* previewPanel */

        let previewPanel = $div("previewpanel","",mainPanel);
        let p = $div("preview","",previewPanel);
        p.appendChild(previewCanvas);
        $checkbox("Preview",previewPanel,"",checked=>{
            livePreview = checked;
            update();
        },livePreview);

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
            Effects.clear();
            modal.hide();
            releaseCanvas(currentSource);
            EventBus.trigger(EVENT.layerContentChanged);
            HistoryService.neverMind();
        });
        $div("button primary","Apply",buttons,()=>{
            if (codePanel){

            }else{
                let t = ImageFile.getActiveLayer().getContext();
                Effects.setSrcTarget(currentSource,t);
                Effects.apply();
            }
            Effects.clear();
            releaseCanvas(currentSource);
            modal.hide();
            EventBus.trigger(EVENT.layerContentChanged);

            if (Palette.isLocked()){
                Palette.apply();
            }
            HistoryService.end();
        });

        Effects.clear();

    }

    function createSlider(parent,label,value,min,max,onInput,isCustom,onChange){
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
        valueElm.onchange = ()=>{
            if (onChange) onChange();
        }
        if (onChange) range.onchange = onChange;
        if (parent) parent.appendChild(result);
        if (!isCustom) effects.push(range);
        return result;
    }

    function update(){
        if (livePreview){
            Effects.setSrcTarget(currentSource,ImageFile.getActiveLayer().getContext());
            Effects.apply();
            Effects.setSrcTarget(currentSource,previewCanvas.getContext("2d"));
            EventBus.trigger(EVENT.layerContentChanged);
        }
    }

    async function loadRecipe(recipe,name){
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


        let run = $div("button primary","Run",codePanel,()=>{
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
            let value = process.toString();

            let exposeIndex = value.indexOf("expose=");
            let exposeIndexEnd = 0;
            if (exposeIndex<0) exposeIndex = value.indexOf("expose =");
            if (exposeIndex>=0){
                let expose = value.substring(exposeIndex);
                let bracketCount = 0;
                let bracketFound = false;
                for (let i=1;i<expose.length;i++){
                    if (expose[i]==="{") bracketCount++;
                    if (expose[i]==="}") {bracketCount--;bracketFound=true;}
                    if (bracketFound && bracketCount===0){
                        exposeIndexEnd = i;
                        let endOfLine = expose.indexOf("\n",exposeIndexEnd);
                        if (endOfLine>=0) exposeIndexEnd = endOfLine;
                        expose = expose.substring(0,i+1);
                        break;
                    }
                }
                try {
                    let exposed = eval(expose);
                    if (exposed && typeof exposed==="object" && Object.keys(exposed).length>0){
                        renderRecipeParams (exposed);
                    }
                }   catch (e){
                    console.error(e);
                }
            }

            textarea.setValue(value);
            currentRecipeSource = value;

            if (exposeIndex>0 && exposeIndexEnd>0){
                currentRecipeSource = value.substring(0,exposeIndex)+ "###exposed###" + value.substring(exposeIndex+exposeIndexEnd);
            }

        }

        function renderRecipeParams(params){
            let paramPanel = $div("params","<h3>Parameters for '" + name + "'</h3>",codePanel);
            let keys = Object.keys(params);
            if (keys.length>5) paramPanel.classList.add("columns");

            keys.forEach(key=>{
                let param = params[key];
                // parent,label,value,min,max,onInput,isCustom
                let slider = createSlider(paramPanel,camelCaseToSpace(key),param.value,param.min,param.max,(value)=>{
                    params[key].value = parseFloat(value);
                    let expose = "expose = {\n";
                    Object.keys(params).forEach(key=>{
                        expose += "        "+key+": "+ JSON.stringify(params[key])+",\n";
                    });
                    expose += "    };";
                    textarea.setValue(currentRecipeSource.replace("###exposed###",expose));
                },true,()=>{
                    textarea.onChange();
                    run.onClick();
                });
                if (param.main) slider.classList.add("main");
            });


        }
    }

    function camelCaseToSpace(str){
        let result = "";
        for (let i=0;i<str.length;i++){
            let c = str[i];
            if (c===c.toUpperCase()){
                result += " "+c;
            }else{
                result += c;
            }
        }
        return result;
    }


    return me;
}();

export default EffectDialog;