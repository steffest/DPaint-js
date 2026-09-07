import EventBus from "../util/eventbus.js";
import {EVENT} from "../enum.js";
import ImageFile from "../image.js";
import HistoryService from "../services/historyservice.js";
import {duplicateCanvas, releaseCanvas} from "../util/canvasUtils.js";

// Mesh Warp — an interactive grid deformation of the active layer.
//
// The layer's opaque bounding box is covered by an 8x8 grid of cells (9x9 control
// points / "crosspoints"). Dragging one point warps only the cells that touch it;
// every other point stays put and pins the image in place — a local, "liquid" warp.
//
// Rendering maps the immutable source snapshot onto the deformed grid by drawing each
// cell as two affine-textured triangles (clip + setTransform). This is cheap enough to
// do live: re-renders are coalesced to one per animation frame so a burst of pointer
// moves never renders more than the display can show.
let MeshWarp = function(){
    let me = {};

    const CELLS = 8;              // 8x8 grid of cells
    const COLS = CELLS + 1;       // 9 crosspoints per row/column
    const ROWS = CELLS + 1;
    const SEAM_EXPAND = 0.6;      // px each triangle grows outward to hide anti-alias seams

    let active = false;
    let layer;                   // the layer being warped
    let snapshot;                // immutable source texture (the box region of the layer)
    let originalCanvas;          // full layer copy, for cancel/restore
    let box;                     // {x,y,w,h} opaque bounding rect, DOCUMENT coordinates
    let localOrigin;             // box origin in the layer's own canvas space
    let src = [];                // source vertices, box-local coords (never change)
    let dst = [];                // warped vertices, box-local coords
    let moved = [];              // per-vertex: has the user dragged it?
    let dragIndex = -1;
    let hoverIndex = -1;
    let dirty = false;           // any vertex actually moved?
    let renderScheduled = false;

    function idx(col,row){ return row * COLS + col; }

    me.isActive = function(){ return active; };

    // Begin a warp session on the active layer. Returns false when there is nothing to warp
    // (no active paintable layer, locked layer, or an empty layer).
    me.start = function(){
        if (active) cleanup();
        let l = ImageFile.getActiveLayer();
        if (!l || ImageFile.isActiveLayerLocked()) return false;

        let b = ImageFile.getLayerBoundingRect();
        if (!b.w || !b.h) return false;

        layer = l;
        box = {x:b.x, y:b.y, w:b.w, h:b.h};
        let offset = ImageFile.getLayerOffset();
        localOrigin = {x: b.x - offset.x, y: b.y - offset.y};

        // immutable source texture: the opaque region copied out of the layer
        snapshot = document.createElement("canvas");
        snapshot.width = b.w;
        snapshot.height = b.h;
        let sctx = snapshot.getContext("2d");
        sctx.imageSmoothingEnabled = false;
        sctx.drawImage(layer.getContext().canvas, localOrigin.x, localOrigin.y, b.w, b.h, 0, 0, b.w, b.h);

        // full layer copy so cancel can restore pixels that the warp pushed around
        originalCanvas = duplicateCanvas(layer.getContext().canvas, true);

        // build the grid in box-local coordinates
        src = []; dst = []; moved = [];
        for (let row = 0; row < ROWS; row++){
            for (let col = 0; col < COLS; col++){
                let x = col * b.w / CELLS;
                let y = row * b.h / CELLS;
                src.push({x, y});
                dst.push({x, y});
                moved.push(false);
            }
        }

        dragIndex = -1;
        hoverIndex = -1;
        dirty = false;
        active = true;

        HistoryService.start(EVENT.layerContentHistory);
        EventBus.trigger(EVENT.meshWarpChanged);
        return true;
    };

    // Nearest control point to a DOCUMENT-space point within `tolerance` px, or -1.
    me.pick = function(point, tolerance){
        let px = point.x - box.x;
        let py = point.y - box.y;
        let best = -1;
        let bestDist = tolerance * tolerance;
        for (let i = 0; i < dst.length; i++){
            let dx = dst[i].x - px;
            let dy = dst[i].y - py;
            let d = dx*dx + dy*dy;
            if (d <= bestDist){ bestDist = d; best = i; }
        }
        return best;
    };

    // Pointer down: grab a control point if one is close enough. Always consumed while active.
    me.handleDown = function(point, tolerance){
        if (!active) return;
        dragIndex = me.pick(point, tolerance);
        hoverIndex = dragIndex;
        EventBus.trigger(EVENT.meshWarpChanged);
    };

    // Pointer move with a grabbed point: move it and schedule a re-render.
    me.handleMove = function(point){
        if (!active || dragIndex < 0) return;
        dst[dragIndex].x = point.x - box.x;
        dst[dragIndex].y = point.y - box.y;
        moved[dragIndex] = true;
        dirty = true;
        scheduleRender();
    };

    // Pointer move without a button: highlight the point under the cursor.
    me.handleHover = function(point, tolerance){
        if (!active) return;
        let i = me.pick(point, tolerance);
        if (i !== hoverIndex){
            hoverIndex = i;
            EventBus.trigger(EVENT.meshWarpChanged);
        }
    };

    me.handleUp = function(){
        dragIndex = -1;
    };

    // Apply the warp: flush any pending render and keep the pixels. If nothing was ever
    // dragged the history step is dropped so a no-op warp doesn't clutter undo.
    me.commit = function(){
        if (!active) return;
        if (dirty){
            renderWarp();
            HistoryService.end();
        }else{
            HistoryService.neverMind();
        }
        cleanup();
    };

    // Discard the warp and restore the layer's original pixels.
    me.cancel = function(){
        if (!active) return;
        if (dirty && layer && originalCanvas){
            let ctx = layer.getContext();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
            ctx.drawImage(originalCanvas, 0, 0);
            EventBus.trigger(EVENT.layerContentChanged);
        }
        HistoryService.neverMind();
        cleanup();
    };

    // Draw the grid + control points onto an overlay context (DOCUMENT coordinates).
    // `zoom` keeps line widths and dot radii at a constant on-screen size.
    me.drawOverlay = function(octx, zoom){
        if (!active) return;
        let s = 1 / (zoom || 1);
        octx.clearRect(0, 0, octx.canvas.width, octx.canvas.height);
        octx.save();

        octx.lineWidth = Math.max(0.4, s);
        octx.strokeStyle = "rgba(0,150,255,0.85)";
        octx.beginPath();
        for (let row = 0; row < ROWS; row++){          // rows of the grid
            for (let col = 0; col < COLS; col++){
                let p = dst[idx(col,row)];
                let x = p.x + box.x, y = p.y + box.y;
                if (col === 0) octx.moveTo(x, y); else octx.lineTo(x, y);
            }
        }
        for (let col = 0; col < COLS; col++){          // columns of the grid
            for (let row = 0; row < ROWS; row++){
                let p = dst[idx(col,row)];
                let x = p.x + box.x, y = p.y + box.y;
                if (row === 0) octx.moveTo(x, y); else octx.lineTo(x, y);
            }
        }
        octx.stroke();

        let r = 3.5 * s;
        for (let i = 0; i < dst.length; i++){
            let x = dst[i].x + box.x, y = dst[i].y + box.y;
            octx.beginPath();
            octx.arc(x, y, r, 0, Math.PI * 2);
            if (i === dragIndex || i === hoverIndex) octx.fillStyle = "#ffffff";
            else if (moved[i]) octx.fillStyle = "#ff5a00";
            else octx.fillStyle = "rgba(0,150,255,0.9)";
            octx.fill();
            octx.lineWidth = Math.max(0.4, s);
            octx.strokeStyle = "rgba(0,0,40,0.9)";
            octx.stroke();
        }
        octx.restore();
    };

    function scheduleRender(){
        if (renderScheduled) return;
        renderScheduled = true;
        requestAnimationFrame(function(){
            renderScheduled = false;
            if (!active) return;
            renderWarp();
            EventBus.trigger(EVENT.meshWarpChanged);
        });
    }

    function renderWarp(){
        if (!active || !layer) return;
        let ctx = layer.getContext();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

        for (let row = 0; row < CELLS; row++){
            for (let col = 0; col < CELLS; col++){
                let a = idx(col,     row);
                let b = idx(col + 1, row);
                let c = idx(col,     row + 1);
                let d = idx(col + 1, row + 1);
                drawTriangle(ctx, src[a], src[b], src[d], dst[a], dst[b], dst[d]);
                drawTriangle(ctx, src[a], src[d], src[c], dst[a], dst[d], dst[c]);
            }
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        EventBus.trigger(EVENT.layerContentChanged);
    }

    // Texture-map the source triangle (s0,s1,s2 in snapshot coords) onto the destination
    // triangle (box-local, shifted into the layer's own space) via a clipped affine draw.
    function drawTriangle(ctx, s0, s1, s2, d0, d1, d2){
        let ax = d0.x + localOrigin.x, ay = d0.y + localOrigin.y;
        let bx = d1.x + localOrigin.x, by = d1.y + localOrigin.y;
        let cx = d2.x + localOrigin.x, cy = d2.y + localOrigin.y;

        // affine transform mapping the source triangle onto the destination triangle
        let dx1 = s1.x - s0.x, dy1 = s1.y - s0.y;
        let dx2 = s2.x - s0.x, dy2 = s2.y - s0.y;
        let det = dx1 * dy2 - dx2 * dy1;
        if (det > -1e-6 && det < 1e-6) return; // degenerate source

        ctx.save();

        // grow the clip triangle a touch so neighbouring cells overlap instead of leaving gaps
        let mx = (ax + bx + cx) / 3, my = (ay + by + cy) / 3;
        let e0 = expand(ax, ay, mx, my);
        let e1 = expand(bx, by, mx, my);
        let e2 = expand(cx, cy, mx, my);
        ctx.beginPath();
        ctx.moveTo(e0.x, e0.y);
        ctx.lineTo(e1.x, e1.y);
        ctx.lineTo(e2.x, e2.y);
        ctx.closePath();
        ctx.clip();

        let ex1 = bx - ax, ey1 = by - ay;
        let ex2 = cx - ax, ey2 = cy - ay;
        let ma = (ex1 * dy2 - ex2 * dy1) / det;
        let mb = (ey1 * dy2 - ey2 * dy1) / det;
        let mc = (ex2 * dx1 - ex1 * dx2) / det;
        let md = (ey2 * dx1 - ey1 * dx2) / det;
        let me_ = ax - ma * s0.x - mc * s0.y;
        let mf = ay - mb * s0.x - md * s0.y;

        ctx.setTransform(ma, mb, mc, md, me_, mf);
        ctx.drawImage(snapshot, 0, 0);
        ctx.restore();
    }

    function expand(x, y, mx, my){
        let dx = x - mx, dy = y - my;
        let len = Math.sqrt(dx*dx + dy*dy) || 1;
        return {x: x + dx / len * SEAM_EXPAND, y: y + dy / len * SEAM_EXPAND};
    }

    function cleanup(){
        active = false;
        if (snapshot) releaseCanvas(snapshot);
        if (originalCanvas) releaseCanvas(originalCanvas);
        snapshot = undefined;
        originalCanvas = undefined;
        layer = undefined;
        box = undefined;
        localOrigin = undefined;
        src = []; dst = []; moved = [];
        dragIndex = -1; hoverIndex = -1;
        dirty = false;
        EventBus.trigger(EVENT.meshWarpChanged);
    }

    return me;
}();

export default MeshWarp;
