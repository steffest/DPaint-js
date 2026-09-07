import Brush from "./brush.js";
import EventBus from "../util/eventbus.js";
import {COMMAND, EVENT} from "../enum.js";
import ImageFile from "../image.js";
import HistoryService from "../services/historyservice.js"
import {duplicateCanvas, outLineCanvas} from "../util/canvasUtils.js";
import {isVector} from "../util/layerUtils.js";
import {deleteNodesWhere, keepNodesInside, cloneVector, vectorSelectionIds, isEmptyVectorSelection, subsetVector, removeVectorSelection} from "../util/vectorUtils.js";
import VectorTool from "../paintTools/vectorTool.js";

/*
Selection holds the data of the current selected pixels.
it always has a left,top,width, height of the bounding box.

if it has nothing more, selection is a rectangle
if it has a "points" array it's a polygon
if it has a canvas object, it is based on (the alpha layer of) the canvas.
 */

let Selection = function(){
    let me = {};
    let currentSelection;
    
    me.set = function(selection){
        currentSelection = selection || {};
        EventBus.trigger(EVENT.selectionChanged);
    }

    me.move = function(x,y,w,h){
        currentSelection = {
            left: x,
            top: y,
            width: w,
            height: h
        }
        EventBus.trigger(EVENT.selectionChanged);
    }

    me.get = function(){
        return currentSelection;
    }

    me.clear = function(){
        let hasSelection = !!currentSelection;
        currentSelection = undefined;
        if (hasSelection) EventBus.trigger(EVENT.selectionChanged);
    }

    me.selectAll = function(){
        let w = ImageFile.getCurrentFile().width;
        let h = ImageFile.getCurrentFile().height;
        EventBus.trigger(COMMAND.CLEARSELECTION);
        EventBus.trigger(COMMAND.SELECT);
        me.set({left: 0, top: 0, width: w, height: h});
    }

    me.invert = function(){
        let w = ImageFile.getCurrentFile().width;
        let h = ImageFile.getCurrentFile().height;

        let canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        let ctx = canvas.getContext("2d");

        ctx.fillStyle = "white";
        ctx.fillRect(0,0,w,h);

        ctx.globalCompositeOperation = "destination-out";

        if (currentSelection){
            if (currentSelection.points && currentSelection.points.length){
                ctx.beginPath();
                currentSelection.points.forEach((point,index)=>{
                    if (index) ctx.lineTo(point.x,point.y);
                    else ctx.moveTo(point.x,point.y);
                });
                ctx.closePath();
                ctx.fill();
            }else if (currentSelection.canvas){
                ctx.drawImage(currentSelection.canvas,0,0);
            }else{
                // Rectangle
                ctx.fillRect(currentSelection.left,currentSelection.top,currentSelection.width,currentSelection.height);
            }
        }

        ctx.globalCompositeOperation = "source-over";
        let outline = outLineCanvas(ctx,false);
        if (outline.box.w <= 0 || outline.box.h <= 0){
            me.clear();
        }else{
            currentSelection = {
                left: outline.box.x,
                top: outline.box.y,
                width: outline.box.w,
                height: outline.box.h,
                canvas: canvas,
                outline: outline.lines
            };
            EventBus.trigger(EVENT.selectionChanged);
        }
    }

    // Whether a DOCUMENT-space point lies within the current selection, for all three selection
    // shapes (rectangle / polygon points / alpha-mask canvas). Used by the vector-layer cut to find
    // which geometry nodes fall inside the selection.
    me.containsPoint = function(x,y){
        if (!currentSelection) return false;
        let s = currentSelection;
        if (s.canvas){
            let px = Math.floor(x), py = Math.floor(y);
            if (px < 0 || py < 0 || px >= s.canvas.width || py >= s.canvas.height) return false;
            let ctx = s.canvas.getContext("2d",{willReadFrequently:true});
            return ctx.getImageData(px,py,1,1).data[3] > 0; // opaque mask pixel = selected
        }
        if (s.points && s.points.length){
            return pointInPolygon(x,y,s.points);
        }
        return x >= s.left && x < (s.left + s.width) && y >= s.top && y < (s.top + s.height);
    }

    function pointInPolygon(x,y,pts){
        let inside = false;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++){
            let xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
            if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
        }
        return inside;
    }

    me.getCanvas = function(){
        // renders the current selection to canvas
        if (currentSelection){
            if (currentSelection.canvas){
                return duplicateCanvas(currentSelection.canvas,true);
            }else if (currentSelection.points && currentSelection.points.length){
                let result = document.createElement("canvas");
                result.width = ImageFile.getCurrentFile().width;
                result.height = ImageFile.getCurrentFile().height;
                let ctx=result.getContext("2d");
                ctx.fillStyle = "black";
                ctx.beginPath();
                currentSelection.points.forEach((point,index)=>{
                    if (index){
                        ctx.lineTo(point.x,point.y);
                    }else{
                        ctx.moveTo(point.x,point.y);
                    }
                });
                ctx.closePath();
                ctx.fill();
                return result;
            }
        }
        console.error("No selection to convert to canvas");
    }

    me.toCanvas = function(){
        // TODO: non rectangular selections
        if (currentSelection){
            let canvas = document.createElement("canvas");
            canvas.width = currentSelection.width;
            canvas.height = currentSelection.height;
            let ctx = canvas.getContext("2d");
            ctx.imageSmoothingEnabled = false;
            // the selection rectangle is in document space
            ctx.drawImage(ImageFile.getActiveLayerDocCanvas(),currentSelection.left,currentSelection.top,canvas.width,canvas.height,0,0, canvas.width, canvas.height);
            return canvas;
        }
    }

    me.toStamp = function(){
        let canvas = me.toCanvas();
        if (canvas){
            Brush.set("canvas",canvas);
            EventBus.trigger(COMMAND.DRAW);
            EventBus.trigger(COMMAND.CLEARSELECTION);
        }
    }
    
    me.toLayer = function(andCut){
        // A vector layer stays a vector layer: copy/cut-to-layer builds a NEW vector layer holding
        // the selected geometry (instead of rasterizing it into a pixel layer). The "selection" on a
        // vector layer is the vector tool's own pick (region/edge/nodes) — no pixel marquee can be
        // drawn there — so toVectorLayer decides whether there is anything to copy; don't bail on the
        // missing pixel marquee here.
        let sourceLayer = ImageFile.getActiveLayer();
        if (isVector(sourceLayer) && sourceLayer.vector){
            toVectorLayer(andCut, sourceLayer);
            return;
        }

        if (!currentSelection) return;

        {
            HistoryService.start(EVENT.imageHistory);
            let canvas = ImageFile.getActiveLayerDocCanvas();
            let sourceLayerIndex = ImageFile.getActiveLayerIndex();
            
            ImageFile.duplicateLayer(); 
            let layer = ImageFile.getActiveLayer(); 

            // The selection is expressed in document coordinates; the mask and the layer
            // canvas are in the layer's own space, so shift by the layer's resolved offset.
            let offset = ImageFile.getLayerOffset();

            if (currentSelection.points || currentSelection.canvas){
                layer.addMask();
                layer.toggleMask();
                let ctx = layer.getContext();
                ctx.fillStyle = "black";
                ctx.fillRect(0,0,ctx.canvas.width,ctx.canvas.height);

                if (currentSelection.points){
                    // draw Polygon on Mask
                    ctx.fillStyle = "white";
                    ctx.beginPath();
                    currentSelection.points.forEach((point,index)=>{
                        if (index){
                            ctx.lineTo(point.x - offset.x,point.y - offset.y);
                        }else{
                            ctx.moveTo(point.x - offset.x,point.y - offset.y);
                        }
                    });
                    ctx.closePath();
                    ctx.fill();
                } else if (currentSelection.canvas){
                     ctx.drawImage(currentSelection.canvas,-offset.x,-offset.y);
                }

                layer.update();
                layer.removeMask(true); // Apply mask
            }else{
                layer.clear();
                let ctx = layer.getContext();
                ctx.drawImage(canvas,
                    currentSelection.left,currentSelection.top,currentSelection.width,currentSelection.height,
                    currentSelection.left - offset.x,currentSelection.top - offset.y, currentSelection.width, currentSelection.height
                );
            }

            if (andCut){
                ImageFile.activateLayer(sourceLayerIndex);
                 var s = currentSelection;
                 let originalLayer = ImageFile.getLayer(sourceLayerIndex);
                 let cutOffset = ImageFile.getLayerOffset(sourceLayerIndex);

                 if (isVector(originalLayer) && originalLayer.vector){
                     // Vector-native cut: the layer stays a vector layer; we remove the geometry
                     // nodes (and their edges) that fall inside the selection instead of erasing
                     // raster pixels (which would just be regenerated from the geometry). Nodes are
                     // in the layer's own space, so shift the selection test by the layer offset.
                     deleteNodesWhere(originalLayer.vector, (gx,gy)=> me.containsPoint(gx + cutOffset.x, gy + cutOffset.y));
                     originalLayer.vectorDirty = true;
                     originalLayer.vectorRasterized = false;
                     if (originalLayer.markVectorDirty) originalLayer.markVectorDirty();
                     EventBus.trigger(EVENT.vectorChanged);
                 } else {
                     let layerCtx = originalLayer.getContext();
                     layerCtx.globalCompositeOperation = "destination-out";
                     if (s.points || s.canvas){
                          if (s.canvas){
                              layerCtx.drawImage(s.canvas,-cutOffset.x,-cutOffset.y);
                          } else {
                              let mask = me.getCanvas();
                              layerCtx.drawImage(mask,-cutOffset.x,-cutOffset.y);
                          }
                     } else {
                         layerCtx.clearRect(s.left - cutOffset.x,s.top - cutOffset.y,s.width,s.height);
                     }
                     layerCtx.globalCompositeOperation = "source-over";
                 }

                 ImageFile.activateLayer(sourceLayerIndex+1);
            }

            EventBus.trigger(EVENT.layerContentChanged);
            EventBus.trigger(COMMAND.CLEARSELECTION);
            HistoryService.end();
        }
    }

    // Copy/cut the selection on a vector layer into a fresh vector layer, keeping the geometry
    // editable. Two selection sources are supported:
    //   1. The vector tool's own pick (a shape/region, an edge, or a set of nodes) — the normal case,
    //      because a pixel marquee cannot be drawn while a vector layer is active (the vector tool
    //      owns all pointer input). subsetVector copies exactly the picked geometry.
    //   2. A pixel marquee carried over from another layer (fallback) — keepNodesInside copies the
    //      geometry the marquee touches (border-crossing edges copied whole).
    // The new layer is inserted just above the source (like Add-vector-layer) and inherits the
    // source layer's offset so the copied nodes keep their position — geometry is stored in
    // layer-local space, so the same coordinates line up. On cut, the same geometry is removed from
    // the source (a hard cut). With no selection of either kind, there is nothing to do.
    function toVectorLayer(andCut, sourceLayer){
        // The vector tool's selection is the primary source (only reliable when it is actually the
        // active tool on this layer).
        let vsel = VectorTool.isActive() ? vectorSelectionIds(sourceLayer.vector, VectorTool.getSelection(), VectorTool.getSelectedNodes()) : null;
        let useVectorSel = vsel && !isEmptyVectorSelection(vsel);

        if (!useVectorSel && !currentSelection) return; // nothing selected → nothing to copy

        HistoryService.start(EVENT.imageHistory);

        let sourcePath = ImageFile.getActiveLayerPath();
        // Resolved offset (folds in any ancestor groups) — nodes are in layer-local space, so shift
        // by this to test each node against a document-space pixel marquee.
        let offset = ImageFile.getLayerOffset();

        let copy;
        if (useVectorSel){
            copy = subsetVector(sourceLayer.vector, vsel);
        } else {
            copy = cloneVector(sourceLayer.vector);
            keepNodesInside(copy, (gx,gy)=> me.containsPoint(gx + offset.x, gy + offset.y));
        }

        // Insert the new vector layer as a sibling just above the source, so it shares the same
        // parent scope (and thus the same ancestor offsets).
        let atPath = sourcePath && sourcePath.length ? sourcePath.slice() : undefined;
        if (atPath) atPath[atPath.length-1] = atPath[atPath.length-1] + 1;
        let newLayer = ImageFile.addVectorLayer(undefined, atPath);
        newLayer.x = sourceLayer.x || 0;
        newLayer.y = sourceLayer.y || 0;
        newLayer.vector = copy;
        newLayer.vectorRasterized = false;
        if (newLayer.markVectorDirty) newLayer.markVectorDirty();

        if (andCut){
            if (useVectorSel){
                removeVectorSelection(sourceLayer.vector, vsel);
            } else {
                deleteNodesWhere(sourceLayer.vector, (gx,gy)=> me.containsPoint(gx + offset.x, gy + offset.y));
            }
            sourceLayer.vectorRasterized = false;
            if (sourceLayer.markVectorDirty) sourceLayer.markVectorDirty();
        }

        EventBus.trigger(EVENT.vectorChanged);
        EventBus.trigger(EVENT.layerContentChanged);
        EventBus.trigger(COMMAND.CLEARSELECTION);
        HistoryService.end();
    }

    EventBus.on(COMMAND.SELECTALL,me.selectAll);
    EventBus.on(COMMAND.INVERTSELECTION,me.invert);
    EventBus.on(COMMAND.CLEARSELECTION,me.clear)
    EventBus.on(COMMAND.STAMP,me.toStamp)
    EventBus.on(COMMAND.TOLAYER,me.toLayer)

    EventBus.on(COMMAND.CUTTOLAYER,()=>{
        me.toLayer(true);
    })

    
    return me;
}()

export default Selection