import $, {$checkbox, $div, $elm, $setTarget, $input} from "../../util/dom.js";
import ImageFile from "../../image.js";
import Palette from "../palette.js";
import Color from "../../util/color.js";
import canvas from "../canvas.js";
import {COMMAND, EVENT, SETTING} from "../../enum.js";
import EventBus from "../../util/eventbus.js";
import Input from "../input.js";
import ColorRange from "./colorRange.js";
import Generate from "../../fileformats/generate.js";
import Modal, {DIALOG} from "../modal.js";

var PaletteDialog = function() {
    let me = {};
    let colorCanvas;
    let colorCanvasCtx;
    let paletteCanvas;
    let paletteCanvasCtx;
    let sliders = [];
    let tabs = {};
    let panels = {};
    let buttons;
    let inputHex;
    let depthInfo;
    let colorHighlight;
    let colorPicker;
    let lockToImage = true;
    let highlight = false;
    let pixelCount;
    let currentIndex;
    let colorSize = 30;
    let palettePage = 0;
    let swapButton;
    let spreadButton;
    let pickButton;
    let paletteClickAction = "";
    let withActions = false;
    let panelContainer;
    let hsv = false;
    let isActive = false;
    let currentSelection = []; // Array of indices
    let batchOriginalColors = {}; // index -> [r,g,b]
    let batchAdjustments = {
        brightness: 0, contrast: 0, gamma: 1.0, hue: 0,
        saturation: 0, temperature: 0, red: 0, green: 0, blue: 0, smooth: 0
    };
    let previewLayerIndex = -1;
    let cachedCanvasPrev, cachedCanvasCurr;
    let lastBlendMode, lastBlendPercent;

    me.render = function (container,modal) {
        container.innerHTML = "";
        sliders = [];
        paletteClickAction = "";

        let currentColor = Palette.getDrawColor();
        currentIndex = Palette.getDrawColorIndex();
        // Reset selection to current active color when opening dialog
        currentSelection = (typeof currentIndex === "number") ? [currentIndex] : [];

        let palettePanel;
        let subPanel;
        let optionsPanel;
        let contextMenu;

        $setTarget(container);
        panelContainer = $(".palette.panel.form" + (withActions? ".withactions" : "") + (SETTING.useMultiPalettes? ".multipalette" : ""),
            palettePanel=$(".palettepanel"),
            $(".actions",
                $(".caption.sub",{onClick:()=>{
                        withActions=false;
                        panelContainer.classList.toggle("withactions",withActions);
                    }},"Actions"),
                $(".nav",$(".zoomin",{
                        onClick:()=>{colorSize = Math.min(colorSize*2,60); renderPalette(palettePanel);},
                        info: "Draw bigger color squares"
                    }),
                    $(".zoomout",{
                        onClick:()=>{colorSize = Math.max(colorSize/2,15); renderPalette(palettePanel);},
                        info: "Draw smaller color squares"
                    })),
                swapButton = $(".button.small",{
                    onClick:()=>{
                        let active = paletteClickAction === "swap";
                        active = !active;
                        paletteClickAction = active?"swap":"";
                        swapButton.classList.toggle("highlight",active);
                        if (active){
                            let dupe = $div("dragelement tooltip","Swap with");
                            Input.setDragElement(dupe,true);
                        }else{
                            Input.removeDragElement();
                        }
                    },
                    info:"Swap a color in the palette"
                },"Swap"),
                spreadButton = $(".button.small",{
                    onClick:()=>{
                        let active = paletteClickAction === "spread";
                        active = !active;
                        paletteClickAction = active?"spread":"";
                        spreadButton.classList.toggle("highlight",active);
                        if (active){
                            let dupe = $div("dragelement tooltip","Spread to");
                            Input.setDragElement(dupe,true);
                        }else{
                            Input.removeDragElement();
                        }
                    },
                    info:"Create a color gradient between 2 colors in the palette."
                },"Spread"),
                $(".button.small",{onClick:()=>{Palette.addColor(Color.fromString(inputHex.value))},"info":"Add a new color"},"Add"),
                $(".button.small",{onClick:()=>{Palette.removeColor(currentIndex)},"info":"Remove the selected color"},"Remove"),
                pickButton = $(".button.small",{
                    onClick:()=>{
                        let active = paletteClickAction === "pick";
                        active = !active;
                        paletteClickAction = active?"pick":"";
                        pickButton.classList.toggle("highlight",active);
                        if (active){
                            let dupe = $div("dragelement tooltip","Pick color from image");
                            Input.setDragElement(dupe,true);
                            EventBus.trigger(COMMAND.COLORPICKER);
                        }else{
                            Input.removeDragElement();
                        }
                    },
                    info:"Pick a color from the image"
                },"Pick"),$(".spacer"),
                $(".button.small",{onClick:()=>{contextMenu.classList.toggle("active")}},"Sort",contextMenu = $(".contextmenu",
                        $(".item",{onClick:()=>{Palette.reverse(); contextMenu.classList.remove("active")},"info":"Reverse the colors in the palette"},"Reverse"),
                        $(".item",{onClick:()=>{Palette.sortByHue(); contextMenu.classList.remove("active")},"info":"Sort by hue"},"Hue"),
                        $(".item",{onClick:()=>{Palette.sortBySaturation(); contextMenu.classList.remove("active")},"info":"Sort by saturation"},"Saturation"),
                        $(".item",{onClick:()=>{Palette.sortByLightness(); contextMenu.classList.remove("active")},"info":"Sort by lightness"},"Lightness"),
                        $(".item",{onClick:()=>{Palette.sortByUseCount(); contextMenu.classList.remove("active")},"info":"Sort by how much a color is used in the image (optimized for compression)"},"Use Count"),
                        $(".item",{onClick:()=>{Palette.sortByUseCount(true); contextMenu.classList.remove("active")},"info":"optimize and test compression results"},"File Size"))),
                $(".button.small",{onClick:()=>{EventBus.trigger(COMMAND.LOADPALETTE)},"info":"Open palette from disk"},"Load"),
                $(".button.small",{onClick:()=>{EventBus.trigger(COMMAND.SAVEPALETTE)},"info":"Save palette to disk"},"Save"),
                $(".button.small",{onClick:()=>{
                        let palette = Palette.get();
                        console.error(palette);
                        let content = "{";
                        for (let i=0;i<palette.length;i++){
                            let color = palette[i];
                            content += "0x";
                            color.forEach(c=>{
                                c = Math.round(c/16);
                                if (c>15) c=15;
                                if (c<0) c=0;
                                content += c.toString(16);
                            })
                            content += ",";
                        }
                        content = content.slice(0,-1) + "}";

                        Modal.show(DIALOG.TEXTOUTPUT,content);



                    },"info":"Export Palette"},"Export"),
            ),
            $(".mainpanel",
                $('.tabs',panels.colortab = $(".caption.sub",{onClick:toggleRangePanel},"Color"),panels.rangestab = $(".caption.sub.inactive",{onClick:toggleRangePanel},"Ranges")),
                panels.color = $(".colorpanel",
                    $(".batchedit.subpanel"),
                    $(".coloredit.subpanel.active",
                    $(".sliders",
                    colorCanvas = $("canvas",{
                        width:60,
                        height:30,
                        onclick:()=>{colorPicker.click();},
                        info: "Click to open Color Picker"
                    }),
                    colorPicker = $("input.masked",{
                        type:"color",
                        value:Color.toHex(currentColor),
                        oninput: ()=>{
                            inputHex.value = colorPicker.value;
                            updateColor(inputHex.value);
                        }
                    }),
                    pixelCount = $(".pixelcount"),
                    inputHex = $("input.hex",{
                        type:"text",
                        value:Color.toHex(currentColor),
                        oninput: ()=>{
                            updateColor(inputHex.value);
                        },
                        onkeydown: modal.inputKeyDown
                    }), $(".tabs",
                            tabs.rgb = $(".tab",{onClick:toggleHSV, info:"Choose RGB color model"}, $("span","R G B")),
                            tabs.hsv = $(".tab.inactive",{onClick:toggleHSV, info:"Choose HSV color model"},$("span","H S V")),
                            subPanel=$(".panel"))
                    ),
                    depthInfo = $(".depthinfo"),
                    buttons = $(".buttons"),
                    optionsPanel=$(".options"))
                ),
                panels.ranges = $(".rangepanel")
            ),
             SETTING.useMultiPalettes ? $(".palette-nav-bottom",
                 $(".nav-btn.prev", {onClick: () => {
                     Palette.setPaletteListIndex(Palette.getPaletteIndex(), -1);
                     updateNavDisplay();
                 }}),
                 $div("page-display", (Palette.getPaletteIndex() + 1) + "/" + Palette.getPaletteList().length),
                 $(".nav-btn.next", {onClick: () => {
                     Palette.setPaletteListIndex(Palette.getPaletteIndex(), 1);
                     updateNavDisplay();
                 }})
             ) : null,
             SETTING.useMultiPalettes ? $(".blend-controls",
                 $div("label", "Blend:"),
                 $("input", {type: "range", min: 0, max: 100, step: 1, value: 100, oninput: (e) => {
                     let val = parseInt(e.target.value);
                     let mode = e.target.nextSibling.value;
                     applyPaletteBlend(val, mode);
                 }}),
                 $("select", {onchange: (e) => {
                     let val = parseInt(e.target.previousSibling.value);
                     applyPaletteBlend(val, e.target.value);
                 }}, ["Linear", "Top to Bottom"].map(m => {
                     let o = document.createElement("option");
                     o.value = m.toLowerCase();
                     o.text = m;
                     if (m === "Linear") o.selected = true;
                     return o;
                 }))
             ) : null
        );



        function updateNavDisplay() {
            let display = container.querySelector(".page-display");
            if (display) display.innerHTML = (Palette.getPaletteIndex() + 1) + "/" + Palette.getPaletteList().length;
            renderPalette(palettePanel);
            cachedCanvasPrev = null;
            cachedCanvasCurr = null;
            
            let slider = container.querySelector(".blend-controls input[type=range]");
            if (slider) slider.value = 100;
            
            if (previewLayerIndex >= 0) {
                let layer = ImageFile.getLayer(previewLayerIndex);
                if (layer && layer.name === "Palette Blend Preview") {
                    ImageFile.removeLayer(previewLayerIndex);
                    EventBus.trigger(EVENT.imageContentChanged);
                }
                previewLayerIndex = -1;
            }
        }

        function applyPaletteBlend(percent, mode) {

            console.error("applyPaletteBlend", percent, mode);
            let list = Palette.getPaletteList();
            let index = Palette.getPaletteIndex();
            
            // "Current" is active palette. "Previous" is index - 1.
            let prevIndex = index - 1;
            if (prevIndex < 0) prevIndex = list.length - 1;
            
            let prevPal = list[prevIndex];
            let currPal = list[index];

            // 1. Ensure Cached Canvases Exist and are Valid
            // (We assume image content doesn't change while dialog is open and blending)
            if (!cachedCanvasPrev || !cachedCanvasCurr) {
                let w = ImageFile.getCurrentFile().width;
                let h = ImageFile.getCurrentFile().height;
                cachedCanvasPrev = document.createElement("canvas");
                cachedCanvasPrev.width = w;
                cachedCanvasPrev.height = h;
                cachedCanvasCurr = document.createElement("canvas");
                cachedCanvasCurr.width = w;
                cachedCanvasCurr.height = h;
                
                // Retrieve indexed pixels
                ImageFile.generateIndexedPixels();
                let image = ImageFile.getCurrentFile();
                let pixels = image.indexedPixels || [];
                
                // Render function
                function renderTo(ctx, palette) {
                    let imgData = ctx.createImageData(w, h);
                    let data = imgData.data;
                    for (let y = 0; y < h; y++) {
                        let row = pixels[y];
                        if (!row) continue;
                        for (let x = 0; x < w; x++) {
                            let colorIndex = row[x];
                            let color = palette[colorIndex] || [0,0,0]; // Default black if index out of bounds
                             // Handle transparent color index 0 if needed? 
                             // Usually DPaint treats index 0 as transparent for layers, but meant for background?
                             // Here we are rendering the FULL merged image typically?
                             // But ImageFile.generateIndexedPixels() is usually for the flattening.
                             // Let's assume full opacity for now unless indexedPixels supports alpha (it doesn't usually).
                             
                            let idx = (y * w + x) * 4;
                            data[idx] = color[0];
                            data[idx + 1] = color[1];
                            data[idx + 2] = color[2];
                            data[idx + 3] = 255;
                        }
                    }
                    ctx.putImageData(imgData, 0, 0);
                }

                renderTo(cachedCanvasPrev.getContext("2d"), prevPal);
                renderTo(cachedCanvasCurr.getContext("2d"), currPal);
            }

            // 2. Manage Preview Layer
            
            let layerName = "Palette Blend Preview";
            let layer = ImageFile.getLayer(previewLayerIndex);
            
            if (!layer || layer.name !== layerName) {
                 // Try to find it by name just in case
                let layers = ImageFile.getActiveFrame().layers || [];
                let foundIndex = layers.findIndex(l => l.name === layerName);
                
                if (foundIndex >= 0) {
                    previewLayerIndex = foundIndex;
                    layer = layers[foundIndex];
                } else {
                    // Create it
                    let newLayer = ImageFile.addLayer(undefined, layerName, {locked: true, internal: true});
                    
                    previewLayerIndex = ImageFile.getCurrentFile().layers.length - 1;
                    layer = ImageFile.getLayer(previewLayerIndex);
                }

                console.error("layer", layer);
            }
            
            let ctx = layer.getContext();
            let w = ctx.canvas.width;
            let h = ctx.canvas.height;

            ctx.clearRect(0, 0, w, h);
            
            // 3. Render Blend
            // Base: Previous Palette
            ctx.globalAlpha = 1.0;
            ctx.drawImage(cachedCanvasPrev, 0, 0);
            
            if (mode === "linear") {
                // Overlay: Current Palette with Opacity
                ctx.globalAlpha = percent / 100;
                ctx.drawImage(cachedCanvasCurr, 0, 0);
            } else if (mode === "top to bottom") {
                // Overlay: Current Palette Clipped
                // "0 is old palette visible" (percent 0)
                // "100 is new palette fully visible"
                // "50 is new palette visible on top half"
                
                // So at 50%, top half is NEW (Current), bottom is OLD (Previous).
                // We drew OLD everywhere. Now draw NEW on top, but clipped.
                
                let splitY = Math.floor(h * (percent / 100));
                console.error("top to bottom",splitY, percent);
                
                ctx.globalAlpha = 1.0;
                // Draw partial image
                // source x,y,w,h -> dest x,y,w,h
                if (splitY > 0) {
                    ctx.drawImage(cachedCanvasCurr, 0, 0, w, splitY, 0, 0, w, splitY);
                }
                
                // Draw a separator line maybe?
            }
            
            ctx.globalAlpha = 1.0;
            EventBus.trigger(EVENT.imageContentChanged);
        }
        
        renderPalette(palettePanel);
        colorCanvasCtx = colorCanvas.getContext("2d");
        colorCanvasCtx.fillStyle = currentColor;
        colorCanvasCtx.fillRect(0,0,60,30);


        let RGBValues = Color.fromString(currentColor);
        let colorDepth = Palette.getColorDepth()/3;
        ["red","green","blue"].forEach((color,index)=>{
            let slider = $div("slider","",subPanel);
            let range =  document.createElement("input");

            range.type = "range";
            range.className = "slider " + color;
            range.max = 255;
            let multiplier = 1;
            if (colorDepth === 4){
                range.max = 15;
                multiplier = 16;
            }
            if (colorDepth === 3){
                range.max = 7;
                multiplier = 32;
            }
            range.value = Math.floor(RGBValues[index]/multiplier);
            range.addEventListener("wheel",function(e){
                range.value = parseInt(range.value) + Math.sign(e.deltaY);
                range.oninput();
            });
            slider.appendChild(range);
            let label = $elm("span",color,slider,"label");
            let input = document.createElement("input");
            input.type = "text";
            input.className = "rangevalue";
            input.value = range.value;
            input.onkeydown = modal.inputKeyDown;
            slider.appendChild(input);
            sliders.push({
                range: range,
                input: input,
                label: label
            })

            range.oninput = ()=>{
                let value = range.value;
                let colorDepth = Palette.getColorDepth()/3;
                input.value = range.value;
                //let multiplier = 1;
                //if (colorDepth === 4) multiplier = 16;
                //if (colorDepth === 3) multiplier = 32;

                let newColor = [sliders[0].input.value,sliders[1].input.value,sliders[2].input.value];
                if (colorDepth<8) newColor = Color.to24bit(newColor,colorDepth);
                if (hsv){
                    newColor = Color.fromHSV(sliders[0].range.value*multiplier/360,sliders[1].range.value*multiplier/100,sliders[2].range.value*multiplier/100);
                    if (multiplier>1) newColor = Color.setBitDepth(newColor,colorDepth);
                }
                updateColor(newColor);
            }

            input.oninput = ()=>{
                let value = parseInt(input.value);
                let colorDepth = Palette.getColorDepth()/3;
                let max=255;
                let multiplier = 1;
                if (colorDepth === 4){
                    max = 15;
                    multiplier = 16;
                }
                if (colorDepth === 3){
                    max = 7;
                    multiplier = 32;
                }
                if (isNaN(value)) value=0;
                if (value<0) value=0;
                if (value>max) value=max;
                range.value = input.value = value;
                console.log("colorDepth",colorDepth,value,max);
                let newColor = [sliders[0].range.value*multiplier,sliders[1].range.value*multiplier,sliders[2].range.value*multiplier];
                if (hsv){
                    newColor = Color.fromHSV(sliders[0].range.value/360,sliders[1].range.value/100,sliders[2].range.value/100);
                }
                updateColor(newColor);
            }

            //currentIndex = 0;
        })

        if (currentSelection.length > 0 && currentSelection.length <= 1){
            toggleBatchPanel(false);
        } else if (currentSelection.length > 1){
             toggleBatchPanel(true);
        }

        $div("button small revert","Revert",buttons,()=>{
            setColor(Palette.get()[currentIndex],currentIndex);
        });
        $div("button small apply","Apply",buttons,()=>{
            let color = Color.fromString(inputHex.value);
            Palette.updateColor(currentIndex,color);
            let colorsPerPage = paletteCanvas.width / colorSize * paletteCanvas.height / colorSize;
            let start = palettePage * colorsPerPage;
            drawColor(color,currentIndex-start);
            colorCanvasCtx.fillStyle = Color.toString(color);
            colorCanvasCtx.fillRect(0,0,60,30);

            if (lockToImage){
                let currentHighLight = ImageFile.getLayerIndexesOfType("pixelSelection");
                if (currentHighLight.length){
                    let newIndex = ImageFile.getActiveLayerIndex()+1
                    ImageFile.moveLayer(currentHighLight[0],newIndex);
                    EventBus.trigger(COMMAND.MERGEDOWN,newIndex);
                }
            }
        });


        $checkbox("Update layer with color changes",optionsPanel,"",(checked)=>{
            lockToImage = checked;
        },lockToImage)
        $checkbox("HighLight pixels in layer that use selected color",optionsPanel,"",(checked)=>{
            highlight = checked;
            setPixelHighLights();
        },highlight)

        if (hsv){
            hsv = false;
            toggleHSV();
        }

        setColorDepth();

        isActive = true;
    }

    me.onClose = function(){
        removePixelHighLigts();
        me.clearPaletteClickAction();
        paletteCanvas = null;
        ColorRange.cleanUp();
        isActive = false;
        if (previewLayerIndex >= 0) {
            let layer = ImageFile.getLayer(previewLayerIndex);
            if (layer && layer.name === "Palette Blend Preview") {
                ImageFile.removeLayer(previewLayerIndex);
                EventBus.trigger(EVENT.imageContentChanged);
            }
            previewLayerIndex = -1;
        }
    }

    me.setPaletteClickAction = (action)=>{
        paletteClickAction = action;
    }

    me.getPaletteClickAction = ()=>{
        return isActive?paletteClickAction:"";
    }

    me.clearPaletteClickAction = function(){
        paletteClickAction="";
        Input.removeDragElement();
    }

    me.updateColor = function(color){
        color = Color.toHex(color);
        inputHex.value = color;
        updateColor(color);
    }

    function setColorDepth(){
        let depth = Palette.getColorDepth();
        depthInfo.innerHTML = "Color depth: " + depth + " bits";
        depthInfo.classList.toggle("active",depth<24);

        let colorDepth = depth/3;
        sliders.forEach((slider,index)=>{
            slider.range.max = Math.pow(2,colorDepth)-1;
        });
    }

    function toggleHSV(){
        hsv = !hsv;
        tabs.rgb.classList.toggle("inactive",hsv);
        tabs.hsv.classList.toggle("inactive",!hsv);

        let color = Color.fromString(inputHex.value);
        let labels = ["Red","Green","Blue"];
        let max = [255,255,255];
        let colorDepth = Palette.getColorDepth()/3;
        if (colorDepth === 4) max = [15,15,15];
        if (colorDepth === 3) max = [7,7,7];
        if (hsv){
            color = Color.toHSV(color,true);
            labels = ["Hue","Sat.","Value"];
            max = [360,100,100];
        }
        sliders.forEach((slider,index)=>{
            slider.range.max = max[index];
            slider.range.value = slider.input.value = color[index];
            slider.label.innerText = labels[index];
            slider.range.classList.toggle("hsv",hsv);
        })
    }

    function toggleRangePanel(){
        if (panels.colortab.classList.contains("inactive")){
            panels.colortab.classList.remove("inactive");
            panels.rangestab.classList.add("inactive");
            panels.color.style.display = "block";
            panels.ranges.style.display = "none";
            ColorRange.cleanUp();
        }else{
            panels.colortab.classList.add("inactive");
            panels.rangestab.classList.remove("inactive");
            panels.color.style.display = "none";
            panels.ranges.style.display = "block";
            ColorRange.render(panels.ranges);
        }
    }



    function renderPalette(parent){
        parent.innerHTML = "";
        paletteCanvas = $("canvas",{width:120,height:240});
        paletteCanvasCtx = paletteCanvas.getContext("2d");
        let colors = Palette.get();
        colorHighlight = $div("highlight","",parent);

        let colorsPerPage = paletteCanvas.width / colorSize * paletteCanvas.height / colorSize;
        let pageCount = Math.ceil(colors.length/colorsPerPage);
        if (palettePage>=pageCount) palettePage = pageCount-1;

        let isInRange = ()=>{return false;}
        if (ColorRange.getActiveRange() !== undefined){
            let range = ImageFile.getCurrentFile().colorRange[ColorRange.getActiveRange()];
            isInRange = (index)=>{
                return index >= range.low && index <= range.high;
            }
        }

        let start = palettePage * colorsPerPage;
        let end = start + colorsPerPage;
        for (let i=start;i<end;i++){
            if (!colors[i]) break;
            drawColor(colors[i],i-start,isInRange(i));
        }

        paletteCanvas.onpointerdown = function(e){
            const rect = paletteCanvas.getBoundingClientRect();
            const x = Math.floor((e.clientX - rect.left) / colorSize);
            const y = Math.floor((e.clientY - rect.top) / colorSize);
            let colorsPerRow = paletteCanvas.width / colorSize;
            let index = (y*colorsPerRow + x) + start;
            if (paletteClickAction === "swap"){
                Palette.swapColors(currentIndex,index);
                me.clearPaletteClickAction();
                swapButton.classList.remove("highlight");
            }
            if (paletteClickAction === "spread"){
                Palette.spreadColors(currentIndex,index);
                me.clearPaletteClickAction();
                spreadButton.classList.remove("highlight");
            }
            if (paletteClickAction === "rangeto"){
                ColorRange.setTo(index);
                me.clearPaletteClickAction();
            }
            if (paletteClickAction === "rangefrom"){
                ColorRange.setFrom(index);
                Input.removeDragElement();
                let dupe = $div("dragelement tooltip","Select range: To color");
                Input.setDragElement(dupe,true);
                paletteClickAction = "rangeto";
            }

            handleSelection(index,e.shiftKey,e.ctrlKey || e.metaKey);
        }

        parent.appendChild($(".caption.sub",{
            onClick:()=>{
                withActions=!withActions;
                panelContainer.classList.toggle("withactions",withActions);
            },
            info:"Show palette and color actions"},"Palette"));
        parent.appendChild(paletteCanvas);



        if (colors.length>colorsPerPage){
            $(".nav",{parent:parent},
                $(".prev"+(palettePage?".active":""),{onClick:()=>{palettePage--;renderPalette(parent);}}),
                $(".page",""+(palettePage+1)),
                $(".next"+(palettePage<pageCount-1?".active":""),{onClick:()=>{palettePage++;renderPalette(parent);}})
            );
        }else{
            palettePage = 0;
        }

        setColorSelection();
    }

    function handleSelection(index,isShift,isCtrl){
        if (isShift && currentSelection.length > 0){
             let start = currentSelection[currentSelection.length-1];
             // Select range
             let min = Math.min(start,index);
             let max = Math.max(start,index);
             currentSelection = [];
             for(let i=min; i<=max; i++) currentSelection.push(i);
        } else if (isCtrl){
            // Toggle
            let idx = currentSelection.indexOf(index);
            if (idx>=0){
                currentSelection.splice(idx,1);
            }else{
                currentSelection.push(index);
            }
        } else {
            // Single select
            currentSelection = [index];
        }

        // Ensure we always have at least one selected if we just clicked (unless we unselected the last one with ctrl)
        // Actually, if we unselect the last one, we might want empty selection?
        // But for app behavior, usually there is always an active color.
        if (currentSelection.length === 0 && !isCtrl) currentSelection = [index];

        if (currentSelection.length === 1){
            setColor(Palette.get()[currentSelection[0]], currentSelection[0]);
            toggleBatchPanel(false);
        } else {
            // Multiple selected
            // Set last clicked as active for drawing purposes?
            if (currentSelection.length > 0)
                Palette.setColorIndex(index);
                //setColor(Palette.get()[index], index); // This also updates inputs
            toggleBatchPanel(true);
        }
        
        // Redraw to show selection
        renderPalette(paletteCanvas.parentNode);
    }
    
    function toggleBatchPanel(show){
        let batchPanel = panels.color.querySelector(".batchedit");
        let colorEdit = panels.color.querySelector(".coloredit");
        
        if (!batchPanel || !colorEdit) return;

        if (show){

            let image = ImageFile.getCurrentFile();
             if (!image.indexedPixels) ImageFile.generateIndexedPixels();


             if (batchPanel.style.display !== "block"){
                 batchPanel.style.display = "block";
                 colorEdit.style.display = "none";
                 initBatchPanel(batchPanel);
             }
        } else {
            batchPanel.style.display = "none";
            colorEdit.style.display = "block";
        }
    }

    function initBatchPanel(container){
        container.innerHTML = "";
        
        // Capture initial state
        batchOriginalColors = {};
        let allColors = Palette.get();
        currentSelection.forEach(idx => {
            if (allColors[idx]){
                batchOriginalColors[idx] = [...allColors[idx]]; // Copy color
            }
        });
        
        // Reset adjustments
        batchAdjustments = {
            brightness: 0, contrast: 0, gamma: 1.0, hue: 0,
            saturation: 0, temperature: 0, red: 0, green: 0, blue: 0, smooth: 0
        };

        let controls = $div("controls","",container);
        
        const sliderDefs = [
            {key: 'brightness', label: 'Brightness', min: -100, max: 100, step: 1, val: 0},
            {key: 'contrast', label: 'Contrast', min: -100, max: 100, step: 1, val: 0},
            {key: 'gamma', label: 'Gamma', min: 0.1, max: 3.0, step: 0.1, val: 1.0},
            {key: 'hue', label: 'Hue', min: -180, max: 180, step: 1, val: 0},
            {key: 'saturation', label: 'Saturation', min: -100, max: 100, step: 1, val: 0},
            {key: 'temperature', label: 'Temperature', min: -100, max: 100, step: 1, val: 0},
            {key: 'red', label: 'Red', min: -255, max: 255, step: 1, val: 0},
            {key: 'green', label: 'Green', min: -255, max: 255, step: 1, val: 0},
            {key: 'blue', label: 'Blue', min: -255, max: 255, step: 1, val: 0},
            {key: 'smooth', label: 'Smooth', min: 0, max: 100, step: 1, val: 0}
        ];
        
        sliderDefs.forEach(def => {
            let wrapper = $div("custom-slider", "", controls);
            let fill = $div("slider-fill", "", wrapper);
            let label = $div("slider-label", def.label + ": " + def.val, wrapper);
            
            let updateVisuals = (val) => {
                let range = def.max - def.min;
                let percent = (val - def.min) / range * 100;
                
                if (def.min < 0) {
                    let zeroPercent = (0 - def.min) / range * 100;
                    if (val >= 0) {
                        fill.style.left = zeroPercent + "%";
                        fill.style.width = (percent - zeroPercent) + "%";
                    } else {
                        fill.style.left = percent + "%";
                        fill.style.width = (zeroPercent - percent) + "%";
                    }
                } else {
                    fill.style.left = "0";
                    fill.style.width = percent + "%";
                }
                label.innerText = def.label + ": " + (def.step < 1 ? val.toFixed(1) : Math.round(val));
            }
            
            updateVisuals(def.val);
            
            let isDragging = false;
            
            let updateFromEvent = (e) => {
                let rect = wrapper.getBoundingClientRect();
                let x = e.clientX - rect.left;
                let percent = Math.max(0, Math.min(1, x / rect.width));
                let range = def.max - def.min;
                let val = def.min + (range * percent);
                
                if (def.step) {
                    val = Math.round(val / def.step) * def.step;
                     // Fix floating point precision issues
                    if (def.step < 1) {
                        val = parseFloat(val.toFixed(1));
                    }
                }
                
                // Clamp
                val = Math.max(def.min, Math.min(def.max, val));

                if (batchAdjustments[def.key] !== val){
                    batchAdjustments[def.key] = val;
                    updateVisuals(val);
                    applyBatchUpdate();
                }
            }
            
            wrapper.addEventListener("mousedown", (e) => {
                isDragging = true;
                updateFromEvent(e);
                window.addEventListener("mousemove", onMouseMove);
                window.addEventListener("mouseup", onMouseUp);
            });
            
            let onMouseMove = (e) => {
                if (isDragging) updateFromEvent(e);
            }
            
            let onMouseUp = () => {
                isDragging = false;
                window.removeEventListener("mousemove", onMouseMove);
                window.removeEventListener("mouseup", onMouseUp);
            }
            
            wrapper.addEventListener("dblclick", () => {
                 let val = def.key === 'gamma' ? 1.0 : 0;
                 batchAdjustments[def.key] = val;
                 updateVisuals(val);
                 applyBatchUpdate();
            });
        });

        $div("button revert small", "Revert", controls, () => {
              batchAdjustments = {
                brightness: 0, contrast: 0, gamma: 1.0, hue: 0,
                saturation: 0, temperature: 0, red: 0, green: 0, blue: 0, smooth: 0
              };
              applyBatchUpdate();
              initBatchPanel(container);
        });
    }

    function applyBatchUpdate(){
        let palette = Palette.get();
        
        let indices = currentSelection.slice().sort((a,b)=>a-b);
        if (indices.length === 0) return;
        
        // Calculate adjusted values for each color
        let newColors = {};
        
        indices.forEach(idx => {
            let original = batchOriginalColors[idx];
            if (original) {
               newColors[idx] = applyColorAdjustment(original[0], original[1], original[2], batchAdjustments,idx);
            }
        });
        
        // Apply smoothing if contiguous and smooth > 0
        if (batchAdjustments.smooth > 0 && indices.length > 2) {
             // Basic smoothing over the sorted selection
             // This assumes the user wants to smooth across the selection order
             const smoothFactor = batchAdjustments.smooth / 100;
             // Let's smooth between the first and last of the selection? 
             // Or just smooth the calculated values?
             // editor.html logic:
             // Interpolates between start and end of range.
             
             let startIdx = indices[0];
             let endIdx = indices[indices.length-1];
             let startColor = newColors[startIdx];
             let endColor = newColors[endIdx];
             
             if (startColor && endColor){
                 for (let i = 0; i < indices.length; i++) {
                     let idx = indices[i];
                     let t = i / (indices.length - 1);
                     
                     // Target interpolated color
                     let ir = startColor[0] + (endColor[0] - startColor[0]) * t;
                     let ig = startColor[1] + (endColor[1] - startColor[1]) * t;
                     let ib = startColor[2] + (endColor[2] - startColor[2]) * t;
                     
                     let [r,g,b] = newColors[idx];
                     
                     r = r * (1 - smoothFactor) + ir * smoothFactor;
                     g = g * (1 - smoothFactor) + ig * smoothFactor;
                     b = b * (1 - smoothFactor) + ib * smoothFactor;
                     
                     newColors[idx] = [Math.round(r), Math.round(g), Math.round(b)];
                 }
             }
        }
        
        // Apply to palette
        for (let idx in newColors){
            palette[idx] = newColors[idx];
        }
        Palette.set(palette);
        EventBus.trigger(EVENT.paletteChanged);

        console.error(lockToImage);
        console.error(newColors);

        if (lockToImage){
             let image = ImageFile.getCurrentFile();
             if (!image.indexedPixels) ImageFile.generateIndexedPixels();
             
             let pixels = image.indexedPixels;
             let layer = ImageFile.getActiveLayer();
             let ctx = layer.getContext();
             let w = ctx.canvas.width;
             let h = ctx.canvas.height;
             let imageData = ctx.getImageData(0,0,Math.floor(w),Math.floor(h));
             let data = imageData.data;
             
             let hasUpdates = false;
             
             for (let y=0; y<h; y++){
                 if (!pixels[y]) continue; 
                 for (let x=0; x<w; x++){
                     let index = pixels[y][x];
                     //console.error(index,typeof index === "number" );
                     if (typeof index === "number" && newColors[index]){
                         let color = newColors[index];
                         let pIndex = (y*w + x)*4;
                         // Only update if not transparent? 
                         // Check existing alpha? 
                         // If indexedPixels said it was this index, it should correspond to this color.
                         // However, maintain alpha from existing pixel if possible, or force full opaque?
                         // DPaint colors are usually opaque.
                         if (data[pIndex+3] > 0){
                             data[pIndex] = color[0];
                             data[pIndex+1] = color[1];
                             data[pIndex+2] = color[2];
                             data[pIndex+3] = 255;
                             hasUpdates = true;
                         }
                     }
                 }
             }
             
             console.error(hasUpdates);
             if (hasUpdates){
                 ctx.putImageData(imageData,0,0);
                 EventBus.trigger(EVENT.imageContentChanged);
             }
        }
    }


    function drawColor(color,index,highlight){
        let colorsPerRow = paletteCanvas.width / colorSize;
        let x = (index%colorsPerRow) * colorSize;
        let y = Math.floor(index/colorsPerRow) * colorSize;
        let c = Color.toString(color);
        paletteCanvasCtx.fillStyle = c;
        paletteCanvasCtx.fillRect(x,y,colorSize,colorSize);
        
        // Check selection
        let isSelected = currentSelection.includes(index);
        
        if (highlight || isSelected){
            paletteCanvasCtx.beginPath();
            paletteCanvasCtx.strokeStyle = isSelected ? "rgba(255,255,255,1)" : "rgba(255,255,255,0.5)"; // Stronger highlight for selection
            paletteCanvasCtx.lineWidth = isSelected ? 2 : 1;
            paletteCanvasCtx.rect(x+1.5,y+1.5,colorSize-3,colorSize-3);
            paletteCanvasCtx.closePath();
            paletteCanvasCtx.stroke();
            
            // Add secondary stroke for contrast if selected
            if (isSelected) {
                paletteCanvasCtx.beginPath();
                paletteCanvasCtx.strokeStyle = "rgba(0,0,0,0.5)";
                paletteCanvasCtx.lineWidth = 1;
                paletteCanvasCtx.rect(x+0.5,y+0.5,colorSize-1,colorSize-1);
                paletteCanvasCtx.stroke();
             }
        }
        
        if (highlight){
        if (c === Palette.getDrawColor() && currentSelection.length<=1){
            // Only move highlighting box if single selection or it matches draw color
            // Logic is a bit mixed here, but effectively keeps legacy behavior
            currentIndex = index;
            colorHighlight.style.left = x + "px";
            // ...
        }
            colorHighlight.style.top = y + "px";
        }
    }

    function setColor(color,index){
        if (index>=Palette.get().length) return;
        currentIndex = index;
        Palette.setColorIndex(index);
    }

    function setColorSelection(){
        let colorsPerRow = paletteCanvas.width / colorSize;
        let colorsPerPage = colorsPerRow * paletteCanvas.height / colorSize;
        let visualIndex =  currentIndex - (palettePage * colorsPerPage);
        
        // Hide default highlighter if multi-selected, as we draw them in drawColor
        if (currentSelection.length > 1) {
             colorHighlight.style.display = "none";
             return;
        }

        if ((visualIndex<0) || (visualIndex>=colorsPerPage)){
            colorHighlight.style.display = "none";
        }else{
            colorHighlight.style.display = "block";
            colorHighlight.style.left = (visualIndex%colorsPerRow * colorSize)+ "px";
            colorHighlight.style.top = (Math.floor(visualIndex/colorsPerRow) * colorSize) + "px";
            colorHighlight.style.width = colorHighlight.style.height = colorSize + "px";
        }

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
        if (typeof color === "string" && color.substr(0,1) === "#"){
            color = color + "000000";
            color=color.substr(0, 7);
            color = Color.fromString(color);
            let sliderValues = color;
            if (hsv) sliderValues = Color.toHSV(color,true);
            sliders.forEach((slider,index)=>{
                slider.range.value = slider.input.value = sliderValues[index];
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
        buttons.classList.add("active");
        //buttons.forEach(button=>{button.classList.add("active")})
    }

    function setColorRanges(){
        if (paletteCanvas){
            let color = Palette.getDrawColor();
            currentIndex = Palette.getDrawColorIndex();

            colorCanvasCtx.fillStyle = Color.toString(color);
            colorCanvasCtx.fillRect(0,0,60,30);
            inputHex.value = colorPicker.value = Color.toHex(color);

            color = hsv ? Color.toHSV(color,true) : Color.fromString(color);

            let colorDepth = Palette.getColorDepth()/3;
            let multiplier = 1;
            if (colorDepth === 4) multiplier = 16;
            if (colorDepth === 3) multiplier = 32;

            sliders.forEach((slider,_index)=>{
                let v = Math.floor(color[_index]/multiplier);
                slider.range.value = v;
                slider.input.value = v;
            });
            setPixelHighLights();
            setColorSelection();
            buttons.classList.remove("active");
        }
    }

    EventBus.on(EVENT.colorCount,(count)=>{
        if (highlight) pixelCount.innerHTML = "Used on<br>"  + count + " pixels";
    })

    EventBus.on(EVENT.paletteChanged,()=>{
        if (paletteCanvas){
            console.log("render palette")
            renderPalette(paletteCanvas.parentNode);
        }
    })

    EventBus.on(EVENT.colorCycleChanged,(index)=>{
        if (!paletteCanvas) return;

        let image = ImageFile.getCurrentFile();
        let range = image.colorRange[index];

        for (let i=range.low;i<=range.high;i++){
            let index = i-(range.index || 0);
            if (index<range.low) index += range.max;
            let color = Palette.get()[index];

            let colorsPerRow = paletteCanvas.width / colorSize;
            let rows = Math.floor(paletteCanvas.height/colorSize);
            let start = palettePage * colorsPerRow * rows;

            if (i>=start && i<start+colorsPerRow*rows){
                let x = ((i-start)%colorsPerRow) * colorSize;
                let y = Math.floor((i-start)/colorsPerRow) * colorSize;
                paletteCanvasCtx.fillStyle = Color.toString(color);
                paletteCanvasCtx.fillRect(x,y,colorSize,colorSize);
            }
        }
    });

    EventBus.on(EVENT.colorRangeChanged,()=>{
        if (paletteCanvas) renderPalette(paletteCanvas.parentNode);
    });

    EventBus.on(EVENT.drawColorChanged,()=>{
        setColorRanges();
    });

    EventBus.on(EVENT.colorDepthChanged,()=>{
        if (isActive){
            setColorDepth();
            setColorRanges();
        }
    });

    EventBus.on(EVENT.paletteChanged,()=>{
        if (isActive) renderPalette(paletteCanvas.parentNode);
    });


    return me;

    // Helper functions for batch color adjustment
    function rgbToHsl(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        let h, s, l = (max + min) / 2;

        if (max === min) {
            h = s = 0; // achromatic
        } else {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            switch (max) {
                case r: h = (g - b) / d + (g < b ? 6 : 0); break;
                case g: h = (b - r) / d + 2; break;
                case b: h = (r - g) / d + 4; break;
            }
            h /= 6;
        }
        return [h, s, l];
    }

    function hslToRgb(h, s, l) {
        let r, g, b;
        if (s === 0) {
            r = g = b = l; // achromatic
        } else {
            const hue2rgb = (p, q, t) => {
                if (t < 0) t += 1;
                if (t > 1) t -= 1;
                if (t < 1 / 6) return p + (q - p) * 6 * t;
                if (t < 1 / 2) return q;
                if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
                return p;
            };
            const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
            const p = 2 * l - q;
            r = hue2rgb(p, q, h + 1 / 3);
            g = hue2rgb(p, q, h);
            b = hue2rgb(p, q, h - 1 / 3);
        }
        return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
    }

    function applyColorAdjustment(r, g, b, adj, currentIdx) {
        // Optimization check
        if (adj.brightness === 0 && adj.contrast === 0 && adj.gamma === 1 &&
            adj.hue === 0 && adj.saturation === 0 && adj.temperature === 0 &&
            adj.red === 0 && adj.green === 0 && adj.blue === 0) {
            return [r, g, b];
        }

        let brightness = adj.brightness;
        let contrast = adj.contrast;
        let gamma = adj.gamma;
        let hueShift = adj.hue;
        let saturation = adj.saturation;
        let temperature = adj.temperature;
        let redShift = adj.red;
        let greenShift = adj.green;
        let blueShift = adj.blue;

        let contrastFactor = (259 * (contrast + 255)) / (255 * (259 - contrast));

        // 1. Hue & Saturation
        if (hueShift !== 0 || saturation !== 0) {
            let [h, s, l] = rgbToHsl(r, g, b);

            // Hue
            if (hueShift !== 0) {
                h += hueShift / 360;
                if (h > 1) h -= 1;
                if (h < 0) h += 1;
            }

            // Saturation
            if (saturation !== 0) {
                s += saturation / 100;
                s = Math.max(0, Math.min(1, s));
            }

            [r, g, b] = hslToRgb(h, s, l);
        }

        // 2. Temperature
        if (temperature !== 0) {
            r += temperature;
            b -= temperature;
        }

        // 3. Contrast
        if (contrast !== 0){
             r = contrastFactor * (r - 128) + 128;
             g = contrastFactor * (g - 128) + 128;
             b = contrastFactor * (b - 128) + 128;
        }

        // 4. Brightness
        r += brightness;
        g += brightness;
        b += brightness;

        // 4b. RGB Adjustments
        r += redShift;
        g += greenShift;
        b += blueShift;

        // 5. Gamma
        if (gamma !== 1.0) {
            r = 255 * Math.pow(Math.max(0, r) / 255, 1 / gamma);
            g = 255 * Math.pow(Math.max(0, g) / 255, 1 / gamma);
            b = 255 * Math.pow(Math.max(0, b) / 255, 1 / gamma);
        }

        // Clamp
        r = Math.min(255, Math.max(0, r));
        g = Math.min(255, Math.max(0, g));
        b = Math.min(255, Math.max(0, b));

        // Uniqueness check
        let finalR = Math.round(r);
        let finalG = Math.round(g);
        let finalB = Math.round(b);

        let palette = Palette.get();

        function isUnique(tryR, tryG, tryB) {
            for (let i = 0; i < palette.length; i++) {
                if (i === currentIdx) continue;
                let c = palette[i];
                let pr, pg, pb;
                if (typeof c === "string") {
                    c = Color.fromString(c);
                }
                pr = c[0]; pg = c[1]; pb = c[2];
                if (pr === tryR && pg === tryG && pb === tryB) return false;
            }
            return true;
        }

        if (isUnique(finalR, finalG, finalB)) return [finalR, finalG, finalB];

        // Find closest unique color
        for (let d = 1; d < 32; d++) {
            let offsets = [d, -d];
            for (let off of offsets) {
                let tr = Math.max(0, Math.min(255, finalR + off));
                if (isUnique(tr, finalG, finalB)) return [tr, finalG, finalB];

                let tg = Math.max(0, Math.min(255, finalG + off));
                if (isUnique(finalR, tg, finalB)) return [finalR, tg, finalB];

                let tb = Math.max(0, Math.min(255, finalB + off));
                if (isUnique(finalR, finalG, tb)) return [finalR, finalG, tb];
            }
        }
        
        // Fallback: random probe if structured search fails
        for (let i=0; i<50; i++){
             let tr = Math.max(0, Math.min(255, finalR + Math.floor(Math.random()*10 - 5)));
             let tg = Math.max(0, Math.min(255, finalG + Math.floor(Math.random()*10 - 5)));
             let tb = Math.max(0, Math.min(255, finalB + Math.floor(Math.random()*10 - 5)));
              if (isUnique(tr, tg, tb)) return [tr, tg, tb];
        }

        return [finalR, finalG, finalB];
    }

}();

export default PaletteDialog;