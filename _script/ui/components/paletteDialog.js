import {$checkbox, $div, $elm, $title} from "../../util/dom.js";
import ImageFile from "../../image.js";
import Palette from "../palette.js";
import Color from "../../util/color.js";
import canvas from "../canvas.js";
import {COMMAND, EVENT} from "../../enum.js";
import EventBus from "../../util/eventbus.js";

var PaletteDialog = function() {
    let me = {};
    let colorCanvas;
    let colorCanvasCtx;
    let paletteCanvas;
    let paletteCanvasCtx;
    let sliders = [];
    let buttons = [];
    let inputHex;
    let colorHighlight;
    let colorPicker;
    let lockToImage = false;
    let highlight = false;
    let currentIndex;
    let colorSize = 30;

    me.render = function (container,modal) {
        container.innerHTML = "";
        sliders = [];
        buttons = [];
        let panel = $div("palette panel form","",container);

        let palettePanel = $div("palettepanel","",panel);
        renderPalette(palettePanel);
        let subPanel = $div("sliders","",panel);
        let currentColor = Palette.getDrawColor();

        colorCanvas = document.createElement("canvas");
        colorCanvas.width = 60;
        colorCanvas.height = 30;
        subPanel.appendChild(colorCanvas);
        colorCanvasCtx = colorCanvas.getContext("2d");
        colorCanvasCtx.fillStyle = Palette.getDrawColor();
        colorCanvasCtx.fillRect(0,0,60,30);

        colorPicker = document.createElement("input");
        colorPicker.type = "color";
        colorPicker.className = "masked";
        colorPicker.value=Color.toHex(Palette.getDrawColor());
        colorPicker.oninput = ()=>{
            inputHex.value = colorPicker.value;
            updateColor(inputHex.value);
        }
        subPanel.appendChild(colorPicker);
        colorCanvas.onclick = ()=>{
            colorPicker.click();
        }

        inputHex = document.createElement("input");
        inputHex.value = Color.toHex(Palette.getDrawColor());
        inputHex.type = "text";
        inputHex.className = "hex"
        inputHex.onkeydown = modal.inputKeyDown;
        inputHex.oninput = function(){
            updateColor(inputHex.value);
        }
        subPanel.appendChild(inputHex);

        let RGBValues = Color.fromString(currentColor);
        ["red","green","blue"].forEach((color,index)=>{
            let slider = $div("slider","",subPanel);
            let range =  document.createElement("input");
            range.type = "range";
            range.className = "slider " + color;
            range.max = 255;
            range.value = RGBValues[index];
            slider.appendChild(range);
            $elm("span",color,slider,"label");
            let input = document.createElement("input");
            input.type = "text";
            input.className = "rangevalue";
            input.value = RGBValues[index];
            input.onkeydown = modal.inputKeyDown;
            slider.appendChild(input);
            sliders.push({
                range: range,
                input: input
            })

            range.oninput = ()=>{
                input.value = range.value;
                let newColor = [sliders[0].input.value,sliders[1].input.value,sliders[2].input.value];
                updateColor(newColor);
            }

            input.oninput = ()=>{
                let value = parseInt(input.value);
                if (isNaN(value)) value=0;
                if (value<0) value=0;
                if (value>255) value=255;
                range.value = input.value;
                let newColor = [sliders[0].range.value,sliders[1].range.value,sliders[2].range.value];
                updateColor(newColor);
            }

            currentIndex = 0;
        })

        $checkbox("Lock to image",subPanel,"",(checked)=>{
            lockToImage = checked;
        })
        $checkbox("HighLight pixels",subPanel,"",(checked)=>{
            highlight = checked;
            setPixelHighLights();
        })

        buttons.push($div("button small revert","Revert",subPanel,()=>{
            setColor(Palette.get()[currentIndex],currentIndex);
        }));
        buttons.push($div("button small apply","Apply",subPanel,()=>{
            let color = Color.fromString(inputHex.value);
            Palette.updateColor(currentIndex,color);
            drawColor(color,currentIndex);
            colorCanvasCtx.fillStyle = Color.toString(color);
            colorCanvasCtx.fillRect(0,0,60,30);

            if (lockToImage){
                let currentHighLight = ImageFile.getLayerIndexesOfType("pixelSelection");
                if (currentHighLight.length){
                    EventBus.trigger(COMMAND.MERGEDOWN,currentHighLight[0]);
                }
            }
        }));
    }

    me.onClose = function(){
        console.error("onclose")
        removePixelHighLigts();
    }

    function renderPalette(parent){
        paletteCanvas = document.createElement("canvas");
        paletteCanvas.width = 120;
        paletteCanvas.height = 210;
        paletteCanvasCtx = paletteCanvas.getContext("2d");
        let colors = Palette.get();
        colorHighlight = $div("highlight","",parent);
        colors.forEach(drawColor);
        paletteCanvas.onmousedown = function(e){
            const rect = paletteCanvas.getBoundingClientRect();
            const x = Math.floor((e.clientX - rect.left) / colorSize);
            const y = Math.floor((e.clientY - rect.top) / colorSize);
            let index = y*4 + x;
            setColor(colors[index],index);

        }
        parent.appendChild(paletteCanvas);
    }

    function drawColor(color,index){
        let x = (index%4) * colorSize;
        let y = (index>>2) * colorSize;
        let c = Color.toString(color);
        paletteCanvasCtx.fillStyle = c;
        paletteCanvasCtx.fillRect(x,y,colorSize,colorSize);
        if (c === Palette.getDrawColor()){
            colorHighlight.style.left = x + "px";
            colorHighlight.style.top = y + "px";
        }
    }

    function setColor(color,index){
        currentIndex = index;
        colorCanvasCtx.fillStyle = Color.toString(color);
        colorCanvasCtx.fillRect(0,0,60,30);
        inputHex.value = colorPicker.value = Color.toHex(color);
        console.error(color);
        sliders.forEach((slider,_index)=>{
            slider.range.value = color[_index];
            slider.input.value = color[_index];
        });

        colorHighlight.style.left = (index%4 * 30)+ "px";
        colorHighlight.style.top = ((index>>2) * 30) + "px";

        Palette.setColor(color);
        setPixelHighLights();
        buttons.forEach(button=>{button.classList.remove("active")})
    }

    function setPixelHighLights(){
        removePixelHighLigts();
        if (highlight){
            EventBus.trigger(COMMAND.COLORMASK);
        }
    }

    function removePixelHighLigts(){
        let currentHighLight = ImageFile.getLayerIndexesOfType("pixelSelection");
        currentHighLight.forEach(layerIndex=>{
            ImageFile.removeLayer(layerIndex);
        })
    }

    function updateColor(color){
        if (window.debug){
            debugger;
        }
        if (typeof color === "string" && color.substr(0,1) === "#"){
            color = color + "000000";
            color=color.substr(0, 7);
            color = Color.fromString(color);
            sliders.forEach((slider,index)=>{
                slider.range.value = slider.input.value = color[index];
            })
        }else{
            inputHex.value = Color.toHex(color);
        }
        colorCanvasCtx.fillStyle = Color.toString(color);
        colorCanvasCtx.fillRect(30,0,30,30);

        if (lockToImage){
            let currentHighLight = ImageFile.getLayerIndexesOfType("pixelSelection");
            if (!currentHighLight.length){
                EventBus.trigger(COMMAND.COLORMASK,true);
                currentHighLight = ImageFile.getLayerIndexesOfType("pixelSelection");
            }
            let colorLayer = ImageFile.getLayer(currentHighLight[0]);
            if (colorLayer){
                colorLayer.fill(color);
                EventBus.trigger(EVENT.imageContentChanged);
            }else{
                console.error("colorLayer not found");
            }
        }

        buttons.forEach(button=>{button.classList.add("active")})
    }

    return me;
}();

export default PaletteDialog;