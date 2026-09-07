import {$checkbox, $div, $elm, $input} from "../../util/dom.js";
import {COMMAND, EVENT} from "../../enum.js";
import EventBus from "../../util/eventbus.js";
import ImageFile from "../../image.js";
import BrushPanel from "../toolPanels/brushPanel.js";
import Brush from "../brush.js";
import DitherPanel from "../toolPanels/ditherPanel.js";
import Text from "../../paintTools/text.js";
import BoneTool from "../../paintTools/boneTool.js";
import VectorTool from "../../paintTools/vectorTool.js";

let ToolOptions = function(){
    let me = {}
    let smooth = false;
    let pixelPerfect    = false;
    let fill = false;
    let gapClose = "small";   // vector Fill: weld gaps this big before flood-filling (none/small/medium/large)
    let blobSmooth = 50;      // vector Blob: outline smoothness 0-100 (0 = raw polygon, 100 = very rounded)
    let lineSize = 1;
    let tolerance = 0;
    let floodSelectGlobal = false;
    let strength = 50;
    let spread = 20;
    let mask = false;
    let selectionOutline = true;
    let selectionMask = false;
    let pressure = false;
    let penOnly = false;
    let circle = false;

    let smoothCheckbox;
    let circleCheckbox;
    let pixelPerfectCheckbox;
    let maskCheckbox;
    let selectSection;
    let selectionOutlineCheckbox;
    let selectionMaskCheckbox;
    let ditherSection;
    let ditherCheckbox;
    let invertCheckbox;
    let pressureCheckbox;
    let penOnlyCheckbox;
    let pressureOpacityCheckbox;
    let fillCheckbox;
    let lineSizeRange;
    let toleranceRange;
    let floodSelectGlobalCheckbox;
    let strengthRange;
    let spreadRange;
    let brushOptionGroup;
    let brushSettings={};
    let smudgeAction = "Smudge";
    let smudgeSelect;
    let fontOptionGroup;
    let fontSettings={};
    let boneRadiusRange;
    let boneRadiusValue;
    let vectorNodeGroup;
    let vnSquareBtn, vnSharpBtn, vnSmoothBtn, vnSplitBtn, vnJoinBtn;
    let vectorGapGroup;
    let vgNoneBtn, vgSmallBtn, vgMediumBtn, vgLargeBtn;
    let blobGroup;
    let blobCircleBtn, blobSquareBtn, blobSizeRange, blobSizeInput, blobSmoothRange, blobSmoothInput;

    me.isSmooth = ()=>{
        return smooth;
    }

    // Vector Fill: how big a gap in an outline the flood-fill may bridge before filling
    // ("none" | "small" | "medium" | "large"). Consumed by VectorTool.fillAt (zoom-relative).
    me.getGapClose = ()=>{
        return gapClose;
    }

    // Vector Blob: outline smoothness 0-100. VectorTool.buildBlob maps it to the Catmull-Rom curve
    // tension it fits along the traced outline (0 = straight polygon, 50 ≈ natural, 100 = very round).
    me.getBlobSmoothness = ()=>{
        return blobSmooth;
    }

    me.isPixelPerfect = ()=>{
        return pixelPerfect;
    }

    me.isFill = ()=>{
        return fill;
    }

    me.isCircle = ()=>{
        return circle;
    }

    me.showMask = ()=>{
        return mask;
    }

    me.showSelectionOutline = ()=>{
        return selectionOutline;
    }

    me.showSelectionMask = ()=>{
        return selectionMask;
    }

    me.usePressure = ()=>{
       return pressure;
    }

    me.usePenOnly = ()=>{
        return penOnly;
    }

    me.setFill = (state)=>{
        fill = !!state;
        if (fillCheckbox){
            let cb = fillCheckbox.querySelector("input");
            if (cb) cb.checked = fill;
        }
        EventBus.trigger(EVENT.toolOptionsChanged);
    }

    me.getLineSize = ()=>{
        return lineSize;
    }

    me.getTolerance = ()=>{
        return tolerance;
    }

    me.useFloodSelectGlobal = ()=>{
        return floodSelectGlobal;
    }

    me.getStrength = ()=>{
        return strength/100;
    }

    me.getSpread = ()=>{
        return spread;
    }

    me.getSmudgeAction = ()=>{
        return smudgeAction.toLowerCase();
    }

    me.getFont = ()=>{
        return fontSettings.name;
    }

    me.getFontSize = ()=>{
        return fontSettings.size;
    }

    me.getOptions = (command)=>{
        let options = $div("options");
        switch (command){
            case COMMAND.DRAW:
                options.appendChild(label("Brush:"));
                options.appendChild(brushSetting(true));
                options.appendChild(ditherSetting());
                options.appendChild(pressureSetting());
                options.appendChild(penOnlySetting());
                break;
            case COMMAND.ERASE:
                options.appendChild(label("Erase:"));
                options.appendChild(brushSetting(true));
                options.appendChild(ditherSetting());
                break;
            case COMMAND.SMUDGE:
                options.appendChild(smudgeLabel());
                options.appendChild(brushSetting());
                options.appendChild(strengthSetting());
                options.appendChild(ditherSetting());
                break;
            case COMMAND.SPRAY:
                options.appendChild(label("Spray:"));
                options.appendChild(spreadSetting());
                options.appendChild(strengthSetting());
                options.appendChild(pressureOpacitySetting());
                break;
            case COMMAND.LINE:
                options.appendChild(label("Line:"));
                options.appendChild(smoothSetting());
                options.appendChild(lineSetting());
                break;
            case COMMAND.ARC:
                options.appendChild(label("Arc:"));
                options.appendChild(smoothSetting());
                options.appendChild(circleSetting());
                options.appendChild(lineSetting());
                break;
            case COMMAND.SQUARE:
                options.appendChild(label("Rectangle:"));
                options.appendChild(fillSetting());
                options.appendChild(lineSetting());
                break;
            case COMMAND.CIRCLE:
                options.appendChild(label("Circle:"));
                options.appendChild(fillSetting());
                options.appendChild(smoothSetting());
                options.appendChild(lineSetting());
                break;
            case COMMAND.GRADIENT:
                options.appendChild(label("Gradient:"));
                options.appendChild(ditherSetting());
                break;
            case COMMAND.SELECT:
            case COMMAND.POLYGONSELECT:
            case COMMAND.FLOODSELECT:
                options.appendChild(selectSetting());
                if (command === COMMAND.FLOODSELECT){
                    options.appendChild(floodSelectGlobalSetting());
                    options.appendChild(toleranceSetting());
                }
                break;
            case COMMAND.SELECTLAYER:
                options.appendChild(label("Layer Select:"));
                break;
            case COMMAND.FLOOD:
                options.appendChild(label("Fill:"));
                options.appendChild(toleranceSetting());
                break;
            case COMMAND.TRANSFORMLAYER:
                options.appendChild(label("Transform rotation:"));
                options.appendChild(smoothSetting());
                options.appendChild(pixelPerfectSetting());
                break;
            case COMMAND.TEXT:
                options.appendChild(label("Font:"));
                options.appendChild(fontSetting());
                break;
            case COMMAND.BONESELECT:
                options.appendChild(label("Bones – Select:"));
                options.appendChild(actionRadiusSetting());
                options.appendChild(gridQualitySetting());
                options.appendChild(stretchSetting());
                options.appendChild(resetPoseButton());
                break;
            case COMMAND.BONEADD:
                options.appendChild(label("Bones – Add:"));
                options.appendChild(gridQualitySetting());
                break;
            case COMMAND.BONETRANSFORM:
                options.appendChild(label("Bones – Transform:"));
                options.appendChild(stretchSetting());
                options.appendChild(resetPoseButton());
                break;
            case COMMAND.VECTORSELECT:
            case COMMAND.VECTORNODE:
                // The unified edit tool: the node option-bar (curve mode / split / join) applies
                // to whatever point(s) are selected. VECTORNODE is kept as an alias of VECTORSELECT.
                options.appendChild(label("Vector – Edit:"));
                options.appendChild(vectorNodeSetting());
                break;
            case COMMAND.VECTORLINE:
                options.appendChild(label("Vector – Line:"));
                options.appendChild(smoothSetting());
                options.appendChild(lineSetting());
                break;
            case COMMAND.VECTORRECT:
                options.appendChild(label("Vector – Rectangle:"));
                options.appendChild(fillSetting());
                options.appendChild(lineSetting());
                break;
            case COMMAND.VECTORCIRCLE:
                options.appendChild(label("Vector – Ellipse:"));
                options.appendChild(fillSetting());
                options.appendChild(smoothSetting());
                options.appendChild(lineSetting());
                break;
            case COMMAND.VECTORBLOB:
                options.appendChild(label("Vector – Blob:"));
                options.appendChild(blobSetting());
                break;
            case COMMAND.VECTORFILL:
                options.appendChild(label("Vector – Fill:"));
                options.appendChild(smoothSetting());
                options.appendChild(gapCloseSetting());
                break;
            case COMMAND.VECTOROUTLINE:
                options.appendChild(label("Vector – Outline:"));
                options.appendChild(smoothSetting());
                options.appendChild(lineSetting());
                break;
        }

        let activeLayer = ImageFile.getActiveLayer();
        if (activeLayer && activeLayer.isMaskActive && activeLayer.isMaskActive()){
            options.appendChild(maskSetting());
        }
        return options;
    }

    function smoothSetting(){
        if (!smoothCheckbox) smoothCheckbox=$checkbox("Smooth","","",(checked)=>{
            smooth = checked;
            EventBus.trigger(EVENT.toolOptionsChanged);
        });
        return smoothCheckbox;
    }

    me.toggleSmooth = function(){
        smooth = !smooth;
        if (smoothCheckbox) smoothCheckbox.setState(smooth);
        EventBus.trigger(EVENT.toolOptionsChanged);
    }

    function circleSetting(){
        if (!circleCheckbox) circleCheckbox=$checkbox("Circle","","",(checked)=>{
            circle = checked;
        });
        return circleCheckbox;
    }

    function pixelPerfectSetting(){
        if (!pixelPerfectCheckbox) pixelPerfectCheckbox=$checkbox("Pixel Optimized","","",(checked)=>{
            pixelPerfect = checked;
        });
        return pixelPerfectCheckbox;
    }

    function fillSetting(){
        if (!fillCheckbox) fillCheckbox=$checkbox("Fill","","",(checked)=>{
            fill = checked;
            EventBus.trigger(EVENT.toolOptionsChanged);
        });
        return fillCheckbox;
    }

    function lineSetting(){
        if (!lineSizeRange){
            lineSizeRange = $div("range");
            $elm("label","Size:",lineSizeRange);
            let range = document.createElement("input");
            range.type="range";
            range.min=1;
            range.max=10;
            range.value = 1;
            lineSizeRange.appendChild(range);
            let value = $elm("span","1px",lineSizeRange);
            range.oninput = function(){
                value.innerText = range.value + "px";
                lineSize = range.value;
            }

        }
        return lineSizeRange;
    }

    function brushSetting(withOpacity){
        let brushOpacityRange;
        if (!brushOptionGroup){
            let settings = Brush.get();
            brushOptionGroup = $div("optionsgroup");
            let brushSizeRange = $div("range","",brushOptionGroup);
            $elm("label","Size:",brushSizeRange);
            brushSettings.sizeRange = $input("range",settings.width,brushSizeRange)
            brushSettings.sizeRange.min=1;
            brushSettings.sizeRange.max=100;
            brushSettings.sizeInput = $elm("span", settings.width+"px",brushSizeRange);
            brushSettings.sizeRange.oninput = function(){
                Brush.setSize(brushSettings.sizeRange.value);
            }


            brushOpacityRange = $div("range opacity","",brushOptionGroup);
            $elm("label","Opacity:",brushOpacityRange,"inline");
            brushSettings.opacityRange = $input("range",settings.opacity,brushOpacityRange)
            brushSettings.opacityRange.min=1;
            brushSettings.opacityRange.max=100;
            brushSettings.opacityInput = $elm("span",settings.opacity + "%",brushOpacityRange);
            brushSettings.opacityRange.oninput = function(){
                Brush.setOpacity(brushSettings.opacityRange.value);
            }

            EventBus.on(EVENT.brushOptionsChanged,()=>{
                let settings = Brush.get();
                brushSettings.sizeRange.value = settings.width;
                brushSettings.sizeInput.innerText = settings.width + "px" ;
                brushSettings.opacityRange.value = settings.opacity;
                brushSettings.opacityInput.innerText = settings.opacity + "%" ;
                if (ditherCheckbox) ditherCheckbox.setState(DitherPanel.getDitherState());
                if (invertCheckbox) invertCheckbox.setState(DitherPanel.getDitherInvertState());
            })

        }

        if (!brushOpacityRange) brushOpacityRange = brushOptionGroup.querySelector(".opacity");
        if (withOpacity){
            brushOpacityRange.style.display = "block";
        }else {
            brushOpacityRange.style.display = "none";
        }

        return brushOptionGroup;
    }

    function maskSetting(){
        if (!maskCheckbox) maskCheckbox=$checkbox("Show Mask","","mask",(checked)=>{
            mask = checked;
            EventBus.trigger(EVENT.layerContentChanged);
        });
        return maskCheckbox;
    }

    function selectSetting(){
        if (!selectSection){
            selectSection = $div("optionsgroup");
            selectionMaskCheckbox=$checkbox("Show Mask",selectSection,"mask",(checked)=>{
                selectionMask = checked;
                EventBus.trigger(EVENT.selectionChanged);
            });
            selectionOutlineCheckbox=$checkbox("Show Outline",selectSection,"",(checked)=>{
                selectionOutline = checked;
                EventBus.trigger(EVENT.selectionChanged);
            });
        }
        selectionOutlineCheckbox.setState(selectionOutline);
        selectionMaskCheckbox.setState(selectionMask);
        return selectSection;
    }

    function ditherSetting(){
        if (!ditherSection){
            ditherSection = $div("inline flex");
            ditherCheckbox=$checkbox("Dither",ditherSection,"inline info",(checked)=>{
                DitherPanel.setDitherState(checked);
            });
            ditherCheckbox.info="Toggle Brush Dither Pattern";

            invertCheckbox=$checkbox("Invert",ditherSection,"info",(checked)=>{
                DitherPanel.setDitherInvertState(checked);
            });
            invertCheckbox.info="<b>I</b> Invert Brush Dither Pattern";
        }
        ditherCheckbox.setState(DitherPanel.getDitherState());
        invertCheckbox.setState(DitherPanel.getDitherInvertState());
        return ditherSection;
    }

    function pressureSetting(){
        if (!pressureCheckbox) pressureCheckbox=$checkbox("Pressure","","pressure info",(checked)=>{
            pressure = checked;
        });
        pressureCheckbox.info="Toggle brush pressure sensitivity";
        pressureCheckbox.setState(pressure);
        return pressureCheckbox;
    }

    function penOnlySetting(){
        if (!penOnlyCheckbox) penOnlyCheckbox=$checkbox("Pen Only","","penonly info",(checked)=>{
            penOnly = checked;
            EventBus.trigger(EVENT.penOnlyChanged,penOnly);
        });
        penOnlyCheckbox.info="Toggle pen-only mode";
        penOnlyCheckbox.setState(penOnly);
        return penOnlyCheckbox;
    }

    function pressureOpacitySetting(){
        if (!pressureOpacityCheckbox) pressureOpacityCheckbox=$checkbox("Opacity","","pressure info inline",(checked)=>{
            pressure = checked;
        });
        pressureOpacityCheckbox.info="Use random opacity when spraying";
        pressureOpacityCheckbox.setState(pressure);
        return pressureOpacityCheckbox;
    }

    function strengthSetting(){
        if (!strengthRange){
            strengthRange = $div("range");
            $elm("label","Strength:",strengthRange,"inline");
            let range = document.createElement("input");
            range.type="range";
            range.min=0;
            range.max=100;
            range.value = strength;
            strengthRange.appendChild(range);
            let value = $elm("span",strength,strengthRange);
            range.oninput = function(){
                value.innerText = range.value;
                strength = range.value;
            }

        }
        return strengthRange;
    }

    function spreadSetting(){
        if (!spreadRange){
            spreadRange = $div("range");
            $elm("label","Spread:",spreadRange,"inline");
            let range = document.createElement("input");
            range.type="range";
            range.min=1;
            range.max=100;
            range.value = spread;
            spreadRange.appendChild(range);
            let value = $elm("span",spread,spreadRange);
            range.oninput = function(){
                value.innerText = range.value;
                spread = range.value;
            }

        }
        return spreadRange;
    }



    function toleranceSetting(){
        if (!toleranceRange){
            toleranceRange = $div("range");
            $elm("label","Tolerance:",toleranceRange);
            let range = document.createElement("input");
            range.type="range";
            range.min=0;
            range.max=100;
            range.value = 0;
            toleranceRange.appendChild(range);
            let value = $elm("span","0",toleranceRange);
            range.oninput = function(){
                value.innerText = range.value;
                tolerance = range.value;
            }

        }
        return toleranceRange;
    }

    function floodSelectGlobalSetting(){
        if (!floodSelectGlobalCheckbox) floodSelectGlobalCheckbox = $checkbox("Global","","",(checked)=>{
            floodSelectGlobal = checked;
            EventBus.trigger(EVENT.toolOptionsChanged);
        });
        floodSelectGlobalCheckbox.setState(floodSelectGlobal);
        return floodSelectGlobalCheckbox;
    }

    function smudgeLabel(){
        let options = ["Smudge","Blur","Sharpen"];
        if (!smudgeSelect){
            smudgeSelect = $elm("select","",null,"inline");
            options.forEach((option)=>{
                let opt = document.createElement("option");
                opt.value = option;
                opt.innerText = option;
                smudgeSelect.appendChild(opt);
            });
            smudgeSelect.onchange = function(){
                smudgeAction = smudgeSelect.value;
            }
        }
        return smudgeSelect;
    }

    function fontSetting(){
        let options = Text.getFonts();
        if (!fontOptionGroup){
            fontOptionGroup = $div("optionsgroup");


            let fontSelect = $elm("select","",fontOptionGroup,"inline");
            options.forEach((option)=>{
                let opt = document.createElement("option");
                opt.value = option;
                opt.innerText = option;
                fontSelect.appendChild(opt);
            });
            fontSettings.name = options[0];
            fontSelect.onchange = function(){
                fontSettings.name = fontSelect.value;
                EventBus.trigger(EVENT.fontStyleChanged,fontSettings);
            }

            let fontSizeRange = $div("range","",fontOptionGroup);
            $elm("label","Size:",fontSizeRange,"inline");
            let range = document.createElement("input");
            range.type="range";
            range.min=5;
            range.max=100;
            range.value = 32;
            fontSizeRange.appendChild(range);
            fontSettings.size = range.value;
            let value = $elm("span",fontSettings.size+"px",fontSizeRange);
            range.oninput = function(){
                value.innerText = range.value + "px";
                fontSettings.size = range.value;
                EventBus.trigger(EVENT.fontStyleChanged,fontSettings);
            }
        }
        return fontOptionGroup;
    }

    // Bone-tool option controls. Rebuilt fresh on each toolChanged (getOptions clears the panel),
    // so they reflect the currently selected bone / active bone layer rather than caching state.
    function actionRadiusSetting(){
        let wrap = $div("range");
        $elm("label","Radius:",wrap);
        let range = document.createElement("input");
        range.type = "range";
        range.min = 1;
        range.max = 400;
        range.value = Math.round(BoneTool.getSelectedActionRadius()) || 1;
        wrap.appendChild(range);
        let value = $elm("span",range.value,wrap);
        range.oninput = function(){
            value.innerText = range.value;
            BoneTool.previewActionRadius(parseInt(range.value,10));
        };
        range.onchange = function(){
            BoneTool.setActionRadius(parseInt(range.value,10));
        };
        // keep references so a live radius drag on the canvas (the shoulder-line handle) can push the
        // new value back into this slider — see the bonesChanged sync listener below.
        boneRadiusRange = range;
        boneRadiusValue = value;
        return wrap;
    }

    function gridQualitySetting(){
        let wrap = $div("range");
        $elm("label","Grid:",wrap);
        let range = document.createElement("input");
        range.type = "range";
        range.min = 4;
        range.max = 48;
        let layer = ImageFile.getActiveLayer();
        range.value = (layer && layer.gridQuality) || 16;
        wrap.appendChild(range);
        let value = $elm("span",range.value,wrap);
        range.oninput = function(){
            value.innerText = range.value;
        };
        range.onchange = function(){
            let l = ImageFile.getActiveLayer();
            if (l) l.gridQuality = parseInt(range.value,10);
            // grid size is part of the deformer bind signature → re-composite rebinds automatically
            EventBus.trigger(EVENT.bonesChanged);
        };
        return wrap;
    }

    // "Stretch bones" toggle: when on, dragging a bone's tip in Transform mode scales the bone
    // axially (in addition to rotating). Reflects the single BoneTool.stretch flag, so it stays in
    // sync whether shown next to the Select radius/grid controls or in the Transform panel.
    function stretchSetting(){
        let cb = $checkbox("Stretch bones","","info",(checked)=>{
            BoneTool.setStretch(checked);
        });
        cb.info = "Dragging a bone's tip in Transform mode also stretches it";
        cb.setState(BoneTool.getStretch());
        return cb;
    }

    function resetPoseButton(){
        let btn = $div("button apply","Reset Pose");
        btn.info = "Reset all bones to their rest pose";
        btn.onclick = ()=>{ EventBus.trigger(COMMAND.BONERESET); };
        return btn;
    }

    // Node-tool option buttons: three curve modes (mutually exclusive) + split + join. Built once
    // and re-shown on each toolChanged; their state tracks the live node selection via the
    // vectorChanged listener below. Actions call straight through to VectorTool.
    function vectorNodeSetting(){
        if (!vectorNodeGroup){
            vectorNodeGroup = $div("optionsgroup vectornode");
            vnSquareBtn = nodeModeButton("square","▢","Corner point — straight edges, no curve");
            vnSharpBtn  = nodeModeButton("sharp","◇","Curved point — independent tangent handles (cusp)");
            vnSmoothBtn = nodeModeButton("smooth","◯","Smooth point — the two handles stay on one straight line");
            vnSplitBtn = $div("button icon","✂");
            vnSplitBtn.info = "Split the path at this point";
            vnSplitBtn.onclick = ()=>{ if (vnSplitBtn.classList.contains("disabled")) return; VectorTool.splitSelectedNode(); updateVectorNode(); };
            vnJoinBtn = $div("button icon","⋈");
            vnJoinBtn.info = "Join the selected points into one (at their average position)";
            vnJoinBtn.onclick = ()=>{ if (vnJoinBtn.classList.contains("disabled")) return; VectorTool.joinSelectedNodes(); updateVectorNode(); };
            vectorNodeGroup.appendChild(vnSquareBtn);
            vectorNodeGroup.appendChild(vnSharpBtn);
            vectorNodeGroup.appendChild(vnSmoothBtn);
            vectorNodeGroup.appendChild($div("optionsdivider"));
            vectorNodeGroup.appendChild(vnSplitBtn);
            vectorNodeGroup.appendChild(vnJoinBtn);
        }
        updateVectorNode();
        return vectorNodeGroup;
    }

    function nodeModeButton(mode, glyph, info){
        let b = $div("button icon", glyph);
        b.info = info;
        b.onclick = ()=>{ VectorTool.setSelectedNodeMode(mode); updateVectorNode(); };
        return b;
    }

    // Vector Fill "Close gaps": four mutually-exclusive square icon buttons (none / small / medium /
    // large), styled like the node-mode buttons. The chosen size scales the flood-fill's gap-welding
    // tolerance (VectorTool reads it via ToolOptions.getGapClose). Built once and re-shown.
    function gapCloseSetting(){
        if (!vectorGapGroup){
            vectorGapGroup = $div("optionsgroup vectorgap");
            vectorGapGroup.appendChild(label("Close gaps:"));
            vgNoneBtn   = gapButton("none",   "✕", "Don't close gaps — fill only fully-closed outlines");
            vgSmallBtn  = gapButton("small",  "◦", "Close small gaps (a few pixels)");
            vgMediumBtn = gapButton("medium", "○", "Close medium gaps");
            vgLargeBtn  = gapButton("large",  "◯", "Close larger gaps");
            vectorGapGroup.appendChild(vgNoneBtn);
            vectorGapGroup.appendChild(vgSmallBtn);
            vectorGapGroup.appendChild(vgMediumBtn);
            vectorGapGroup.appendChild(vgLargeBtn);
        }
        updateGapClose();
        return vectorGapGroup;
    }

    function gapButton(mode, glyph, info){
        let b = $div("button icon", glyph);
        b.info = info;
        b.onclick = ()=>{ gapClose = mode; updateGapClose(); EventBus.trigger(EVENT.toolOptionsChanged); };
        return b;
    }

    // Vector Blob option-bar: a brush-shape toggle (round / square) + a size slider. Both drive the
    // global Brush (the same brush the toolbar presets set), which the blob tool stamps along the
    // stroke. Built once, re-shown on each toolChanged, and kept in step with the live brush via the
    // brushOptionsChanged listener below (so picking a toolbar preset updates these controls too).
    function blobSetting(){
        if (!blobGroup){
            blobGroup = $div("optionsgroup vectorblob");
            blobCircleBtn = $div("button icon","●");
            blobCircleBtn.info = "Round brush";
            blobCircleBtn.onclick = ()=>{ Brush.setType("circle"); updateBlob(); };
            blobSquareBtn = $div("button icon","■");
            blobSquareBtn.info = "Square brush";
            blobSquareBtn.onclick = ()=>{ Brush.setType("square"); updateBlob(); };
            blobGroup.appendChild(blobCircleBtn);
            blobGroup.appendChild(blobSquareBtn);
            blobGroup.appendChild($div("optionsdivider"));
            let sizeRange = $div("range","",blobGroup);
            $elm("label","Size:",sizeRange);
            blobSizeRange = $input("range", Brush.get().width, sizeRange);
            blobSizeRange.min = 1;
            blobSizeRange.max = 100;
            blobSizeInput = $elm("span", Brush.get().width + "px", sizeRange);
            blobSizeRange.oninput = function(){
                Brush.setSize(blobSizeRange.value);
                blobSizeInput.innerText = blobSizeRange.value + "px";
            };
            blobGroup.appendChild($div("optionsdivider"));
            let smoothRange = $div("range","",blobGroup);
            $elm("label","Smooth:",smoothRange);
            blobSmoothRange = $input("range", blobSmooth, smoothRange);
            blobSmoothRange.min = 0;
            blobSmoothRange.max = 100;
            blobSmoothInput = $elm("span", blobSmooth + "%", smoothRange);
            blobSmoothRange.oninput = function(){
                blobSmooth = parseInt(blobSmoothRange.value, 10) || 0;
                blobSmoothInput.innerText = blobSmooth + "%";
                EventBus.trigger(EVENT.toolOptionsChanged);
            };
        }
        updateBlob();
        return blobGroup;
    }

    function updateBlob(){
        if (!blobGroup) return;
        let b = Brush.get();
        let shape = b.type === "square" ? "square" : "circle";
        blobCircleBtn.classList.toggle("active", shape === "circle");
        blobSquareBtn.classList.toggle("active", shape === "square");
        blobSizeRange.value = b.width;
        blobSizeInput.innerText = b.width + "px";
        if (blobSmoothRange){
            blobSmoothRange.value = blobSmooth;
            blobSmoothInput.innerText = blobSmooth + "%";
        }
    }

    function updateGapClose(){
        if (!vectorGapGroup) return;
        vgNoneBtn.classList.toggle("active", gapClose === "none");
        vgSmallBtn.classList.toggle("active", gapClose === "small");
        vgMediumBtn.classList.toggle("active", gapClose === "medium");
        vgLargeBtn.classList.toggle("active", gapClose === "large");
    }

    function updateVectorNode(){
        if (!vectorNodeGroup) return;
        let m = VectorTool.isActive && VectorTool.isActive() && VectorTool.getMode();
        let inNode = m === "select" || m === "node";  // unified edit tool
        let ids = inNode ? VectorTool.getSelectedNodes() : [];
        let count = ids.length;
        // the whole group only appears once at least one node is selected
        vectorNodeGroup.style.display = count ? "" : "none";
        let mode = count ? VectorTool.getSelectedNodeMode() : null;
        vnSquareBtn.classList.toggle("active", mode === "square");
        vnSharpBtn.classList.toggle("active", mode === "sharp");
        vnSmoothBtn.classList.toggle("active", mode === "smooth");
        vnSplitBtn.classList.toggle("disabled", count !== 1);
        vnJoinBtn.classList.toggle("disabled", count < 2);
    }

    function label(text){
        let label = document.createElement("span");
        label.className = "tool";
        label.innerText = text;
        return label;
    }



    function lineWidthSetting(){

    }

    EventBus.on(COMMAND.TOGGLEMASK,()=>{
        mask = !mask;
        if (window.override) mask=false;
        EventBus.trigger(EVENT.layerContentChanged);
    });

    // Live-sync the Radius slider while the user drags the bone's shoulder-line handle on the canvas.
    // bonesChanged fires (throttled) during that drag; reflect the selected bone's current radius so
    // the slider and its read-out track the drag. Cheap and idempotent when the slider drives itself.
    // Keep the node-tool buttons in step with the live vector selection (which changes without a
    // toolChanged, so the options panel is not rebuilt). Cheap and idempotent.
    EventBus.on(EVENT.vectorChanged,()=>{
        if (vectorNodeGroup && vectorNodeGroup.isConnected) updateVectorNode();
    });

    // Keep the Blob option-bar (shape toggle + size) in step with the live brush, so choosing a
    // toolbar preset — or resizing the brush elsewhere — is reflected while the Blob tool is showing.
    EventBus.on(EVENT.brushOptionsChanged,()=>{
        if (blobGroup && blobGroup.isConnected) updateBlob();
    });

    EventBus.on(EVENT.bonesChanged,()=>{
        if (!boneRadiusRange || !boneRadiusRange.isConnected) return;
        let r = Math.round(BoneTool.getSelectedActionRadius());
        if (!r) return;
        let v = String(r);
        if (boneRadiusRange.value !== v){
            boneRadiusRange.value = v;
            if (boneRadiusValue) boneRadiusValue.innerText = v;
        }
    });

    return me;
}();

export default ToolOptions;
