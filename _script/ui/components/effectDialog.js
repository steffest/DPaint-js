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
import {createFilterSession} from "../../services/filterSession.js";
import {createPixelJobQueue, JOB_PRIORITY} from "../../services/pixelJobs.js";

var EffectDialog = function() {
    let me = {};
    let effects = [];
    let previewCanvas;
    let livePreview = true;
    let codePanel;
    let currentSource;
    let currentRecipeSource;
    let mainPanel;
    let ditherWarning;

    // While the panel is open we re-render when the active layer changes so the UI reflects the
    // current layer (a pixel layer gets the full editor, a group/vector only the hint). Track the
    // container + the layer we last rendered for, and whether the panel is currently shown.
    let currentContainer;
    let renderedLayer;
    let panelOpen = false;

    // Spec 016 phase 6: the General-effects tab is driven through a real filterSession.
    // Slider changes bump a session version and dispatch a job that renders the effect from
    // the immutable `currentSource` into a private output canvas; the accepted preview is
    // blitted to the layer for display, and Apply commits that exact output. The compute runs
    // in a real Worker on an OffscreenCanvas (createPixelJobQueue + workers/filter.js) so heavy
    // effects do not block the main thread; when Worker/OffscreenCanvas are unavailable it
    // falls back to a synchronous in-process job. The Alchemy tab and the palette-lock path
    // keep their own flow.
    let session;
    let params = {};
    let jobSeq = 0;

    // One persistent worker queue for the whole module, created lazily on first use. `null`
    // means the worker path is unavailable and submitJob uses the synchronous fallback.
    let filterQueue;
    function getFilterQueue(){
        if (filterQueue === undefined){
            filterQueue = null;
            if (typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined"){
                try {
                    filterQueue = createPixelJobQueue({
                        createWorker: () => new Worker(new URL("../../workers/filter.js", import.meta.url), {type: "module"})
                    });
                } catch (e){
                    console.warn("filter worker unavailable, using synchronous filters", e);
                    filterQueue = null;
                }
            }
        }
        return filterQueue;
    }

    // Wrap the worker's raw ImageData reply into the {canvas, byteSize, close()} output shape
    // the session and displayPreview/commitOutput expect.
    function wrapWorkerOutput(raw){
        let c = document.createElement("canvas");
        c.width = raw.width;
        c.height = raw.height;
        c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(raw.buffer), raw.width, raw.height), 0, 0);
        return { canvas: c, byteSize: raw.width * raw.height * 4, close(){ c.width = c.height = 0; } };
    }

    // Render the effect for a parameter set from currentSource into a target 2d context,
    // reusing the exact Effects transforms the sliders use.
    function renderEffect(p, targetCtx){
        Effects.hold();
        Effects.clear();
        Effects.setSrcTarget(currentSource, targetCtx);
        if (p.brightness != null) Effects.setBrightness(p.brightness);
        if (p.contrast != null) Effects.setContrast(p.contrast);
        if (p.saturation != null) Effects.setSaturation(p.saturation);
        if (p.hue != null) Effects.setHue(p.hue);
        if (p.blur != null) Effects.setBlur(p.blur);
        if (p.sharpen != null) Effects.setSharpen(p.sharpen);
        if (p.texture != null) Effects.setTexture(p.texture);
        if (p.dehaze != null) Effects.setDehaze(p.dehaze);
        if (p.sepia != null) Effects.setSepia(p.sepia);
        if (p.invert != null) Effects.setInvert(p.invert);
        if (p.red != null) Effects.setColorBalance("red", p.red);
        if (p.green != null) Effects.setColorBalance("green", p.green);
        if (p.blue != null) Effects.setColorBalance("blue", p.blue);
        Effects.apply();
    }

    // Build a fresh output canvas for a parameter set (an owned session output).
    function makeOutput(p){
        let c = document.createElement("canvas");
        c.width = currentSource.width;
        c.height = currentSource.height;
        renderEffect(p, c.getContext("2d"));
        return { canvas: c, byteSize: c.width * c.height * 4, close(){ c.width = c.height = 0; } };
    }

    // Blit an accepted preview onto the live layer (for display) + the small preview canvas.
    function displayPreview(output){
        if (!output) return;
        if (livePreview){
            let t = ImageFile.getActiveLayer().getContext();
            t.clearRect(0,0,t.canvas.width,t.canvas.height);
            t.drawImage(output.canvas,0,0);
            EventBus.trigger(EVENT.layerContentChanged);
        }
        let pctx = previewCanvas.getContext("2d");
        pctx.clearRect(0,0,previewCanvas.width,previewCanvas.height);
        pctx.drawImage(output.canvas,0,0);
    }

    // The session's job runner. Uses the worker queue when available, else a synchronous
    // in-process fallback. Both deliver the result through the same session callbacks and
    // return the { id, cancel() } handle the session tracks by id.
    function submitJob(request){
        let queue = getFilterQueue();
        if (queue){
            if (typeof navigator !== "undefined" && navigator.webdriver) window.__lastFilterJobMode = "worker";
            return submitJobWorker(queue, request);
        }
        if (typeof navigator !== "undefined" && navigator.webdriver) window.__lastFilterJobMode = "sync";
        return submitJobSync(request);
    }

    // Worker path: transfer a fresh copy of the source pixels to the worker, which runs the
    // exact same Effects recipe on an OffscreenCanvas and posts the result buffer back.
    function submitJobWorker(queue, request){
        let id = ++jobSeq;
        let kind = request.kind;
        let w = currentSource.width;
        let h = currentSource.height;
        // getImageData returns a fresh buffer, so transferring it does not touch currentSource.
        let imgData = currentSource.getContext("2d").getImageData(0,0,w,h);
        let buffer = imgData.data.buffer;
        let handle = queue.submit({
            kind: "filter",
            priority: kind === "apply" ? JOB_PRIORITY.apply : JOB_PRIORITY.preview,
            payload: { width: w, height: h, buffer: buffer, params: request.params || {} },
            transfer: [buffer],
            reserveBytes: w * h * 4 * 3,
            onResult: (raw)=>{
                if (!session) return;
                let output = wrapWorkerOutput(raw);
                if (kind === "apply"){
                    session.onApplyResult(id, output);
                } else {
                    let accepted = session.onPreviewResult(id, output);
                    if (accepted) displayPreview(session.getPreviewOutput());
                }
            },
            onError: (err)=>{
                if (session) session.onJobError(id, err);
            }
        });
        return { id, cancel(){ try { handle.cancel(); } catch (e) {} } };
    }

    // Synchronous fallback: preview/apply work runs on the main thread and the result is
    // delivered a microtask later, so the session has recorded the running job before its
    // result arrives (matching the async worker contract without a worker).
    function submitJobSync(request){
        let id = ++jobSeq;
        let cancelled = false;
        queueMicrotask(()=>{
            if (cancelled || !session) return;
            let output = makeOutput(request.params || {});
            if (request.kind === "apply"){
                session.onApplyResult(id, output);
            } else {
                let accepted = session.onPreviewResult(id, output);
                if (accepted) displayPreview(session.getPreviewOutput());
            }
        });
        return { id, cancel(){ cancelled = true; } };
    }

    // Atomic commit: bake the exact output onto the layer, bake locked-palette dithering if
    // any, then close the open history step.
    function commitOutput(output){
        let t = ImageFile.getActiveLayer().getContext();
        t.clearRect(0,0,t.canvas.width,t.canvas.height);
        t.drawImage(output.canvas,0,0);
        Effects.clear();
        releaseCanvas(currentSource);
        currentSource = undefined;
        if (Palette.isLockedGlobal()) Palette.apply(true,true);
        EventBus.trigger(EVENT.layerContentChanged);
        HistoryService.end();
        modalRef.hide();
    }

    function setParam(key,value){
        params[key] = value;
        if (session) session.setParams(Object.assign({},params));
    }

    let modalRef;

    me.render = function (container,modal) {
        modalRef = modal;
        currentContainer = container;
        panelOpen = true;
        if (!previewCanvas){
            previewCanvas = document.createElement("canvas");
            previewCanvas.width = 200;
            previewCanvas.height = 200;
        }else{
            previewCanvas.getContext("2d").clearRect(0,0,previewCanvas.width,previewCanvas.height);
        }

        container.innerHTML = "";
        mainPanel = $div("effects-editor","",container);

        // Guards run before the tabs so a non-pixel layer shows only the hint, no empty tab bar.
        // No active layer yet (e.g. opened before an image exists) → nothing to preview.
        let activeLayer = ImageFile.getActiveLayer();
        // Remember which layer this render is for, so the layersChanged handler can tell an
        // actual layer switch apart from unrelated layer events (rename, reorder, ...).
        renderedLayer = activeLayer;
        if (!activeLayer){
            $div("hint","No image to apply effects to.",mainPanel);
            return;
        }
        // A group or vector layer has no paintable raster context (getActiveContext() returns
        // undefined). Effects operate on pixels, so bail out rather than crash HistoryService.start.
        if (!ImageFile.getActiveContext()){
            $div("hint","Select a pixel layer to apply effects.",mainPanel);
            return;
        }

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

        currentSource = duplicateCanvas(activeLayer.getCanvas(),true);
        HistoryService.start(EVENT.layerContentHistory);

        // Fresh session for this dialog opening. sourceId/generation are constant here
        // (single-threaded, one source), so every synchronous result is acceptable.
        params = {};
        session = createFilterSession({
            submitJob,
            commit: commitOutput,
            reserveHistory: () => true
        });
        session.open({ sourceId: "effect", generation: 0, paletteRev: 0, maskRev: 0, params: {} });

        Effects.setSrcTarget(currentSource,previewCanvas.getContext("2d"))

        // let the canvas know effect changes are driving updates:
        // with palette lock on, the live preview then includes the reduce-panel dithering
        EventBus.trigger(EVENT.effectPreviewChanged,true);

        createSlider(sliders,"Brightness",0,-50,50,(value)=>setParam("brightness",value));
        createSlider(sliders,"Contrast",0,-50,50,(value)=>setParam("contrast",value));
        createSlider(sliders,"Saturation",0,-50,50,(value)=>setParam("saturation",value));
        createSlider(sliders,"Hue",0,-180,180,(value)=>setParam("hue",value));
        createSlider(sliders,"Blur",0,0,100,(value)=>setParam("blur",value));
        createSlider(sliders,"Sharpen",0,0,100,(value)=>setParam("sharpen",value));
        createSlider(sliders,"Texture",0,0,100,(value)=>setParam("texture",value));
        createSlider(sliders,"Dehaze",0,0,100,(value)=>setParam("dehaze",value));
        createSlider(sliders,"Sepia",0,0,100,(value)=>setParam("sepia",value));
        createSlider(sliders,"Invert",0,0,100,(value)=>setParam("invert",value));
        createSlider(sliders,"Cyan/Red",0,-100,100,(value)=>setParam("red",value));
        createSlider(sliders,"Magenta/Green",0,-100,100,(value)=>setParam("green",value));
        createSlider(sliders,"Yellow/Blue",0,-100,100,(value)=>setParam("blue",value));


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
            {name: "Ripples", file:"ripples"},
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
            if (codePanel){
                update(); // Alchemy tab keeps the old live-preview behaviour
            } else if (checked && session){
                session.setParams(Object.assign({},params)); // re-show the General preview
            }
        },livePreview);

        ditherWarning = $div("ditherwarning","",previewPanel);
        updateDitherWarning();

        let buttons = $div("buttons","",mainPanel);
        $div("button ghost left","Reset",buttons,()=>{
            effects.forEach(slider=>{
                slider.value = 0;
                slider.oninput();
            });
            params = {};
            if (session) session.setParams({});
        });
        $div("button ghost","Cancel",buttons,()=>{
            if (session) session.cancel();
            let t = ImageFile.getActiveLayer().getContext();
            t.clearRect(0,0,t.canvas.width,t.canvas.height);
            if (currentSource) t.drawImage(currentSource,0,0);
            Effects.clear();
            modal.hide();
            if (currentSource) releaseCanvas(currentSource);
            currentSource = undefined;
            EventBus.trigger(EVENT.layerContentChanged);
            HistoryService.neverMind();
        });
        $div("button primary","Apply",buttons,()=>{
            if (codePanel){
                // Alchemy recipe: the result is already drawn live on the layer; just close
                // the history step and bake any locked-palette dithering.
                Effects.clear();
                if (currentSource) releaseCanvas(currentSource);
                currentSource = undefined;
                modal.hide();
                if (Palette.isLockedGlobal()) Palette.apply(true,true);
                EventBus.trigger(EVENT.layerContentChanged);
                HistoryService.end();
            }else{
                // General effects: commit the exact session output (commitOutput closes the
                // history step + hides the modal once the apply job resolves).
                session.apply();
            }
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

                    textarea.onChange();
                    run.onClick();


                },true,()=>{
                    textarea.onChange();
                    run.onClick();
                });
                if (param.main) slider.classList.add("main");
            });


        }
    }

    // called by modal on every close (Apply, Cancel and the close button)
    me.onClose = function(){
        panelOpen = false;
        EventBus.trigger(EVENT.effectPreviewChanged,false);
    }

    // Discard an in-progress effect that is bound to `renderedLayer` (the previously active pixel
    // layer): the live preview draws onto that layer, so restore its original pixels from
    // currentSource, drop the session and abandon the open history step. A no-op when the last
    // render bailed early (group/vector/no image) since none of those resources were created.
    function abandonPending(){
        if (session){ try { session.cancel(); } catch(e){} }
        session = undefined;
        if (currentSource){
            let t = renderedLayer && renderedLayer.getContext ? renderedLayer.getContext() : undefined;
            if (t){
                t.clearRect(0,0,t.canvas.width,t.canvas.height);
                t.drawImage(currentSource,0,0);
            }
            releaseCanvas(currentSource);
            currentSource = undefined;
            Effects.clear();
            HistoryService.neverMind();
            EventBus.trigger(EVENT.layerContentChanged);
        }
    }

    // Keep the panel in sync with the active layer: switching layers while it is open re-runs the
    // pixel-layer check so the editor / hint matches the current layer. Only react to an actual
    // active-layer switch; layersChanged also fires for rename, reorder, opacity, etc.
    let switchingLayer = false;
    EventBus.on(EVENT.layersChanged,()=>{
        if (switchingLayer) return;
        if (!panelOpen || !currentContainer) return;
        if (ImageFile.getActiveLayer() === renderedLayer) return;
        switchingLayer = true;
        try {
            abandonPending();
            me.render(currentContainer,modalRef);
        } finally {
            switchingLayer = false;
        }
    });

    function updateDitherWarning(){
        if (!ditherWarning) return;
        let show = false;
        if (Palette.isLockedGlobal()){
            let dither = Palette.getDitherSettings();
            if (dither.index > 0){
                ditherWarning.innerHTML = "Palette lock: \"" + dither.label + "\" dithering is applied to the preview and the result.";
                show = true;
            }
        }
        ditherWarning.style.display = show ? "block" : "none";
    }

    // the EventBus has no "off": register once at module level and let the handler
    // target whatever warning element the latest render created
    EventBus.on(EVENT.ditherSettingsChanged,updateDitherWarning);
    EventBus.on(EVENT.paletteLockChanged,updateDitherWarning);

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