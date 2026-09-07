import $ from "../../util/dom.js";
import ImageFile from "../../image.js";
import EventBus from "../../util/eventbus.js";
import {EVENT} from "../../enum.js";

let BitPlaneViewer = (()=>{
    let me = {};
    let listContainer;
    let refreshTimer;
    let renderToken = 0;

    // Regenerating is only worth doing once a change has settled. imageContentChanged
    // fires per mousemove while drawing (ImageFile re-broadcasts every layerContentChanged
    // as one), so the refresh is debounced on the trailing edge: a continuous stroke keeps
    // re-arming the timer and only rebuilds once the user stops.
    const REFRESH_DELAY = 250;

    me.generate = function(parent){
        listContainer = $(".gallery.bitplane-list", {parent:parent}, $(".list"));
        listContainer = listContainer.querySelector(".list");
        list();
        return listContainer;
    }

    // The panel is detached from the DOM when hidden and its .inner is display:none when
    // the panel is collapsed, so the DOM answers both questions without asking the
    // PanelManager (which would introduce an import cycle). A hidden panel needs no
    // refresh: it is registered with rerenderOnShow, so showing it rebuilds from scratch.
    function isPanelVisible(){
        return !!listContainer && listContainer.isConnected && listContainer.offsetParent !== null;
    }

    function scheduleRefresh(){
        if (!isPanelVisible()) return;
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(()=>{
            if (isPanelVisible()) list();
        },REFRESH_DELAY);
    }

    async function list(){
        // list() is async; a refresh landing while a previous one is still awaiting its
        // imports must not append its planes to the newer render.
        let token = ++renderToken;
        let target = listContainer;
        target.innerHTML = "";

        // Wait for dynamic imports
        const IFF = (await import("../../fileformats/iff.js")).default;
        if (token !== renderToken) return;

        let canvas = ImageFile.getCanvas();

        // resolve the palette once and hand it to toBitPlanes: it would otherwise rescan
        // the whole canvas for colours a second time.
        let colors = IFF.getBitPlanePalette(canvas, true);

        let isEHB = colors.length > 32 && colors.length <= 64;

        let bitplanes = IFF.toBitPlanes(canvas, true, isEHB, colors);
        let planeCount = bitplanes.planes.byteLength / bitplanes.bitPlaneSize;
        let byteView = new Uint8Array(bitplanes.planes);
        let w = bitplanes.width;
        let h = bitplanes.height;

        let headerText = "Bitplanes";
        if (isEHB) {
             headerText += " (Amiga EHB mode)";
        }

        $(".section",{parent:target}, $(".title", headerText), $(".description", planeCount + " planes generated"));

        for (let p = 0; p < planeCount; p++) {
             let pCanvas = document.createElement("canvas");
             pCanvas.width = w;
             pCanvas.height = h;
             let pCtx = pCanvas.getContext("2d");
             let pImgData = pCtx.getImageData(0, 0, w, h);
             let data = pImgData.data;

             let planeOffset = p * bitplanes.bitPlaneSize;
             let bytesPerLine = Math.ceil(w / 16) * 2;

             for (let y = 0; y < h; y++) {
                  for (let x = 0; x < w; x++) {
                       let byteIndex = planeOffset + (y * bytesPerLine) + (x >> 3);
                       let bit = byteView[byteIndex] & (0x80 >> (x & 7));

                       let idx = (y * w + x) * 4;
                       let val = bit ? 255 : 0;
                       data[idx] = val;
                       data[idx+1] = val;
                       data[idx+2] = val;
                       data[idx+3] = 255;
                  }
             }
             pCtx.putImageData(pImgData, 0, 0);

             // The canvas goes into the DOM as-is: encoding a PNG per plane (and holding an
             // object URL for it) costs more than the whole rest of the refresh, and is only
             // ever needed when a plane is actually clicked.
             $(".item",{ parent:target, onClick:()=>{ download(pCanvas, p); }},
                 $(".thumb", pCanvas),
                 $(".fileinfo",
                     $(".title", "Bitplane " + p)
                 )
             );
        }
    }

    function download(planeCanvas, index){
        planeCanvas.toBlob(blob=>{
            let url = URL.createObjectURL(blob);
            let a = document.createElement("a");
            a.href = url;
            a.download = "bitplane_" + index + ".png";
            a.click();
            URL.revokeObjectURL(url);
        },"image/png");
    }

    // no separate layerContentChanged listener: ImageFile re-broadcasts each one as an
    // imageContentChanged, so subscribing to both would just refresh twice.
    EventBus.on(EVENT.imageContentChanged,scheduleRefresh);
    EventBus.on(EVENT.imageSizeChanged,scheduleRefresh);
    EventBus.on(EVENT.paletteChanged,scheduleRefresh);
    EventBus.on(EVENT.paletteLockChanged,scheduleRefresh);

    return me;

});

export default BitPlaneViewer();
