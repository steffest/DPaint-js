import {$elm, $title, $div} from "../../util/dom.js";
import ditherPanel from "../toolPanels/ditherPanel.js";
import Storage from "../../util/storage.js";

let DitherDialog = (()=>{
    let me = {}
    let patternCanvas;
    let patternCtx;
    let canvas;
    let ctx;
    let preview;
    let previewCtx;
    let gridSize = 4;
    let gridButtons = [];
    let presetPanel;
    let deleteButton;
    let saveButton;
    let touchData = {};
    let userPresetIndex;

    me.render = function (container,modal) {
        container.innerHTML = "";
        gridButtons = [];
        let ditherPanel = $div("ditheredit","",container);

        presetPanel = $div("presets","",ditherPanel);
        listPresets();

        let editPanel = $div("editpreset","",ditherPanel);
        $title("2","Draw pattern",editPanel);
        canvas = $elm("canvas","",editPanel,"handle info");
        canvas.width = 240;
        canvas.height = 240;
        ctx = canvas.getContext("2d");
        canvas.info = "Left click to draw black - Right click to draw white"
        let toolBar = $div("subtoolbar","",editPanel);
        $elm("label","Grid size",toolBar);
        gridButtons.push($div("button small",9,toolBar,()=>{
           setGridSize(3,true);
        }));
        gridButtons.push($div("button small active",16,toolBar,()=>{
            setGridSize(4,true);
        }));
        gridButtons.push($div("button small",25,toolBar,()=>{
            setGridSize(5,true);
        }));
        $div("button left","Clear",toolBar,()=>{
            ctx.fillStyle = "white";
            ctx.fillRect(0,0,canvas.width,canvas.height);
            drawGridLines();
            patternCtx.clearRect(0,0,patternCanvas.width,patternCanvas.height);
            updatePattern();
        });


        patternCanvas=document.createElement("canvas");
        patternCanvas.width = 8;
        patternCanvas.height = 8;
        patternCtx=patternCanvas.getContext("2d");
        patternCtx.fillStyle = "white";
        patternCtx.fillRect(0,0,patternCanvas.width,patternCanvas.height);


        canvas.onClick = (e)=>{
            touchData.box = canvas.getBoundingClientRect();
            let s = 240/gridSize/2;
            let x = Math.floor((e.clientX - touchData.box.left)/s);
            let y = Math.floor((e.clientY - touchData.box.top)/s);
            touchData.rightButton = e.button;
            putPixeltoPattern(x,y);
        }

        canvas.onDrag = (dx,dy,_touchData,e)=>{
            let s = 240/gridSize/2;
            let x = Math.floor((e.clientX - touchData.box.left)/s);
            let y = Math.floor((e.clientY - touchData.box.top)/s);
            if (x!==touchData.x || y!==touchData.y){
                putPixeltoPattern(x,y);
            }
        }

        let previewPanel = $div("previewpreset","",ditherPanel);
        $title("2","Preview",previewPanel);

        preview = document.createElement("canvas");
        previewCtx = preview.getContext("2d");
        preview.width = 200;
        preview.height = 240;
        previewPanel.appendChild(preview);

        let buttons = $div("subtoolbar","",previewPanel);
        deleteButton = $div("button left hidden","Remove preset",buttons,()=>{
            Storage.remove("dither",userPresetIndex);
            listPresets();
            loadPreset(0);
        });
        saveButton = $div("button","Save as new preset",buttons,()=>{
            let pattern = [];
            let data = patternCtx.getImageData(0,0,patternCanvas.width,patternCanvas.height).data;
            for (let i = 0; i<data.length; i+=4){
                pattern.push(data[i+3]?1:0);
            }
            Storage.put("dither",pattern,userPresetIndex);
            listPresets();
        })

        loadPreset(2);

    }

    function loadPreset(preset){
        let pattern = preset
        let isUserPreset = typeof preset!=="number";
        if (!isUserPreset){
            pattern = ditherPanel.getPreset(preset);
            userPresetIndex = undefined;
        }

        ctx.fillStyle = "white";
        ctx.fillRect(0,0,canvas.width,canvas.height);
        ctx.fillStyle = "black";
        if (isUserPreset){
            setGridSize(pattern.length === 36 ? 3:4)
        }else{
            setGridSize(pattern.length === 9 ? 3:4)
        }

        patternCanvas.width = gridSize*2;
        patternCanvas.height = gridSize*2;
        patternCtx.clearRect(0,0,patternCanvas.width,patternCanvas.height);

        if (isUserPreset){
            for (let y = 0; y<gridSize*2; y++){
                for (let x = 0; x<gridSize*2; x++){
                    let index = y*gridSize*2 + x;
                    if (pattern[index]){
                        drawPixel(x,y);
                    }
                }
            }
            deleteButton.classList.remove("hidden");
            saveButton.innerHTML = "Update preset";
        }else{
            // repeat preset 4 times
            for (let y = 0; y<gridSize; y++){
                for (let x = 0; x<gridSize; x++){
                    let index = y*gridSize + x;
                    if (pattern[index]){
                        drawPixel(x,y);
                        drawPixel(x+gridSize,y);
                        drawPixel(x,y+gridSize);
                        drawPixel(x+gridSize,y+gridSize);
                    }
                }
            }
            deleteButton.classList.add("hidden");
            saveButton.innerHTML = "Save as new preset";
        }


        drawGridLines();
        updatePattern();

        if(isUserPreset) ditherPanel.setDitherPattern(patternCanvas);
    }

    function userPresetToCanvas(preset){
        let size = preset.length === 36 ? 6:8;
        if (size>64) size=10;
        let canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        let ctx = canvas.getContext("2d");
        ctx.fillStyle = "black";
        for (let y = 0; y<size; y++){
            for (let x = 0; x<size; x++){
                let index = y*size+x;
                if (preset[index]){
                    ctx.fillRect(x,y,1,1);
                }
            }
        }
        return canvas;
    }

    function putPixeltoPattern(x,y){
        touchData.x = x;
        touchData.y = y;
        ctx.fillStyle =  patternCtx.fillStyle = touchData.rightButton?"white":"black";
        drawPixel(x,y,touchData.rightButton);
        drawGridLines();
        updatePattern();
        ditherPanel.setDitherPattern(patternCanvas);
    }

    function drawPixel(x,y,erase){
        let s = 240/gridSize/2;
        ctx.fillRect(x*s,y*s,s,s);
        if (erase){
            patternCtx.clearRect(x,y,1,1);
        }else{
            patternCtx.fillRect(x,y,1,1);
        }
    }

    function horizontalLine(y){
        let s = 240/gridSize/2;
        ctx.moveTo(0,y*s- 0.5);
        ctx.lineTo(240,y*s- 0.5);
    }
    function verticalLine(x){
        let s = 240/gridSize/2;
        ctx.moveTo(x*s - 0.5,0);
        ctx.lineTo(x*s - 0.5,240);
    }

    function updatePattern(){
        let pattern = previewCtx.createPattern(patternCanvas,"repeat");
        previewCtx.clearRect(0,0,preview.width,preview.height);
        previewCtx.fillStyle = pattern;
        previewCtx.fillRect(0,0,preview.width,preview.height);
    }

    function drawGridLines(){
        ctx.strokeStyle = "#666666";
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = 0; x<gridSize; x++){
            verticalLine(x);
            verticalLine(x+gridSize);
            horizontalLine(x);
            horizontalLine(x+gridSize);
        }
        ctx.stroke();
    }

    function setGridSize(size,force){
        gridSize = size;
        gridButtons.forEach(button=>button.classList.remove("active"));
        let button = gridButtons[size-3];
        if (button) button.classList.add("active");

        if (force){
            ctx.fillStyle = "white";
            ctx.fillRect(0,0,canvas.width,canvas.height);
            ctx.fillStyle = "black";
            gridSize = size;
            patternCanvas.width = gridSize*2;
            patternCanvas.height = gridSize*2;

            drawGridLines();
            updatePattern();
        }

    }

    function listPresets(){
        presetPanel.innerHTML = "";
        $title("2","Presets",presetPanel);

        for (let i = 0; i<8; i++){
            $div("preset p"+i,"",presetPanel,()=>{
                loadPreset(i);
                ditherPanel.setDitherPattern(i+1);
            })
        }

        let userPresets = Storage.get("dither");
        if (userPresets && userPresets.forEach){
            userPresets.forEach((preset,index)=>{
                let tile = $div("preset user","",presetPanel,()=>{
                    loadPreset(preset);
                    userPresetIndex = index;
                })
                tile.appendChild(userPresetToCanvas(preset));
            })
        }
    }


    return me;
})();

export  default DitherDialog;

