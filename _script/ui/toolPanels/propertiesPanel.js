import ImageFile from "../../image.js";
import $, {$checkbox} from "../../util/dom.js";
import {VECTOR_DISPLAY_MODES} from "../../util/vectorUtils.js";
import EventBus from "../../util/eventbus.js";
import {EVENT} from "../../enum.js";
import VectorTool from "../../paintTools/vectorTool.js";
import Palette from "../palette.js";
import Color from "../../util/color.js";

// PropertiesPanel (spec 007) — the animatable transform of the active node at the playhead.
//
// Every node shows X/Y (moved here out of the Layers panel). A GROUP additionally shows Width,
// Height and Rotation: its runtime transform (scaleX/scaleY/rotation applied at composite time,
// NOT baked into the child pixels). Width/Height are presented in PIXELS — the displayed size of
// the group's content bounding box — while the model stores scale factors; the panel converts
// between the two. All four write through ImageFile.setLayerKeyProps, which lands the edit on the
// cel's base values or on a property key exactly like x/y/opacity (so it animates on the timeline).
//
// A group transform field whose value differs from the default (scale 1 / rotation 0°) is marked
// with an orange outline and shows a reset icon to the left of the box; clicking it restores that
// component's default, and hovering it names the default value in the status bar.
//
// When a group has an active transform it additionally shows a "Smooth" checkbox (the app checkbox
// component, sharing the Rotation row): whether the group is resampled smoothly (bilinear) or crisply
// (nearest-neighbour, the pixel-art default) while it is scaled/rotated. Unlike the transform this is
// NOT animatable — it is one timeline-wide setting, so it writes through ImageFile.setGroupSmooth
// (not setLayerKeyProps) and carries no override marker.
let PropertiesPanel = function(){
    let me = {};
    let keyPropsRow;
    let trackLabel;
    let xInput;
    let yInput;
    let groupRow;       // W + H
    let groupRotRow;    // Rot (+ the Smooth toggle, shown only when a transform is active)
    let smoothCheck;
    let vectorRow;          // vector-layer-only: the "Display" mode selector
    let vectorDisplaySelect;
    let wField;
    let hField;
    let rotField;
    // The natural (unscaled) content bounds of the active group, so Width/Height in pixels map
    // back to scale factors. Refreshed on every read-back.
    let baseWidth = 0;
    let baseHeight = 0;

    // Vector-selection properties (below): the geometry currently picked by the Vector tool. A
    // single point shows editable X/Y; a group of points shows X/Y/W/H/Rot of its bounding box; a
    // line shows its colour + width; a filled shape shows its line colour + width and its fill.
    let vsPosRow;               // X/Y — a single point, or the top-left of a multi-point bbox
    let vsSizeRow;              // W/H — multi-point bbox only
    let vsRotRow;               // Rot — multi-point bbox only
    let vsStyleRow;             // line colour + width (+ fill for a shape)
    let vsStrokeBlock, vsFillBlock;
    let vpX, vpY, vsW, vsH, vsRot;
    let strokeSwatch, fillSwatch, widthRange, widthVal;
    let vectorKind = "none";           // last-seen vector selection kind (drives the field onchanges)
    let lastVectorSelSig = null;       // selection identity, to sync the foreground colour once per change
    let suppressColorWrite = false;    // guard: we're setting the foreground FROM the selection, don't write back

    // One field: a fixed-width label, the value box, then a reset-icon slot on the RIGHT. The
    // slot is always reserved (so boxes in different rows line up in columns) but the icon only
    // shows when the field is off its default (the .nondefault class) — and only transform fields
    // pass a resetFn; position fields (X/Y) reserve the slot but never reveal it.
    function makeField(labelText, resetFn){
        let input;
        let reset;
        let field = $(".transformfield",
            $(".label", labelText),
            input = $("input", {type: "text", value: 0}),
            reset = $(".resetprop", resetFn ? {onClick: resetFn, info: ""} : {info: ""})
        );
        input.onkeydown = (e)=>{ e.stopPropagation(); };
        return {field: field, input: input, reset: reset};
    }

    // A clickable colour swatch backed by a hidden native colour input. `onPick(hex)` fires when the
    // user commits a colour. `.set(color)` reflects a stored colour (any CSS/hex form) into the box.
    function makeSwatch(onPick){
        let input = $("input", {type: "color", value: "#000000"});
        input.style.width = input.style.height = "0";
        input.style.opacity = "0";
        input.style.position = "absolute";
        input.style.pointerEvents = "none";
        let sw = $(".vectorswatch info", {onClick: ()=>{ input.click(); }, info: "Click to pick a colour"}, input);
        input.onchange = ()=>{ onPick(input.value); };
        return {
            el: sw, input: input,
            set: (color)=>{
                sw.style.backgroundColor = color || "transparent";
                sw.classList.toggle("nofill", !color);
                if (color) input.value = toInputHex(color);
            }
        };
    }

    // Any stored colour ("#rrggbb", "rgb(...)", a name) → the "#rrggbb" a native colour input needs.
    function toInputHex(color){
        let h = Color.toHex(color);
        if (typeof h === "string" && /^#[0-9a-fA-F]{6}/.test(h)) return h.substr(0, 7);
        return "#000000";
    }

    // Set the foreground colour (which the selection's primary colour is bound to). Not suppressed:
    // this is a deliberate user edit that SHOULD flow through to the selected fill/line.
    function setForeground(hex){
        Palette.setColor(Color.fromString(hex), false, true);
    }

    function round2(n){ return Math.round(n * 100) / 100; }

    function hideVectorSelRows(){
        [vsPosRow, vsSizeRow, vsRotRow, vsStyleRow].forEach(r=>{ if (r) r.style.display = "none"; });
    }

    // Reflect the Vector tool's current selection into the rows, and (once per selection change)
    // sync the foreground colour to the selection's primary colour: the fill of a shape, or the
    // colour of a line. Editing the foreground afterwards writes back through the drawColorChanged
    // handler, so the palette and the selected object stay in step.
    function updateVectorSelection(){
        if (!vsPosRow) return;
        let info = (VectorTool.getSelectionInfo && VectorTool.isActive()) ? VectorTool.getSelectionInfo() : {kind: "none"};
        vectorKind = info.kind;

        let sig = info.kind === "none" ? null : (info.kind + "#" + (info.id || ""));
        if (sig !== lastVectorSelSig){
            lastVectorSelSig = sig;
            let primary = info.kind === "region" ? info.fill
                        : ((info.kind === "edge" || info.kind === "nodes") ? info.strokeColor : null);
            if (primary){
                suppressColorWrite = true;
                Palette.setColor(Color.fromString(primary), false, true);
                suppressColorWrite = false;
            }
        }

        if (info.kind === "none"){ hideVectorSelRows(); return; }

        // X/Y — a single point, or the top-left of a multi-point bounding box.
        if (info.kind === "node" || info.kind === "nodes"){
            vsPosRow.style.display = "";
            if (document.activeElement !== vpX.input) vpX.input.value = round2(info.x);
            if (document.activeElement !== vpY.input) vpY.input.value = round2(info.y);
        } else vsPosRow.style.display = "none";

        // W/H + Rot — multi-point bounding box only.
        if (info.kind === "nodes"){
            vsSizeRow.style.display = "";
            vsRotRow.style.display = "";
            if (document.activeElement !== vsW.input) vsW.input.value = round2(info.w);
            if (document.activeElement !== vsH.input) vsH.input.value = round2(info.h);
            if (document.activeElement !== vsRot.input) vsRot.input.value = 0;   // rotation isn't stored
        } else { vsSizeRow.style.display = "none"; vsRotRow.style.display = "none"; }

        // Line colour + width (+ fill for a shape). Also shown for a multi-point selection that
        // includes lines (e.g. Select-All), so the whole line set can be recoloured / resized at once.
        if (info.kind === "edge" || info.kind === "region" || (info.kind === "nodes" && info.edgeCount)){
            vsStyleRow.style.display = "";
            strokeSwatch.set(info.strokeColor);
            let w = info.strokeWidth == null ? 1 : info.strokeWidth;
            if (document.activeElement !== widthRange) widthRange.value = w;
            widthVal.innerText = w + "px";
            if (info.kind === "region"){ vsFillBlock.style.display = ""; fillSwatch.set(info.fill); }
            else vsFillBlock.style.display = "none";
        } else vsStyleRow.style.display = "none";
    }

    me.generate = (parent)=>{
        // X/Y position — same field shape as the transform fields so the left boxes (X above W)
        // and right boxes (Y above H) line up in columns. No reset (position has no "default").
        let xField = makeField("X");
        let yField = makeField("Y");
        xInput = xField.input;
        yInput = yField.input;
        keyPropsRow = $(".layerkeyprops",
            {parent: parent, info: "Position of the active layer at the playhead"},
            trackLabel = $(".activetrack",""),
            xField.field,
            yField.field
        );

        // Group-only transform. W and H share a row; Rotation gets its own line. Hidden unless the
        // active node is a group.
        wField = makeField("W", ()=>{ ImageFile.setLayerKeyProps(undefined,{scaleX: 1}); });
        hField = makeField("H", ()=>{ ImageFile.setLayerKeyProps(undefined,{scaleY: 1}); });
        rotField = makeField("Rot", ()=>{ ImageFile.setLayerKeyProps(undefined,{rotation: 0}); });

        groupRow = $(".grouptransform",
            {parent: parent, info: "Runtime size of the active group (scaled on the fly, not baked into the pixels)"},
            wField.field,
            hField.field
        );
        // Smooth toggle — the app checkbox component, sharing the Rotation row. NOT animatable (one
        // timeline-wide setting via ImageFile.setGroupSmooth), so it carries no reset/override marker
        // and is shown only while a transform is active. Its checkbox box is aligned with the left
        // column (X/W input boxes) via CSS, with the "Smooth" label to its left; Rot stays
        // right-aligned in its own column.
        smoothCheck = $checkbox("Smooth", null, "small smooth-toggle", (checked)=>{
            ImageFile.setGroupSmooth(undefined, checked);
        });

        groupRotRow = $(".grouptransform",
            {parent: parent, info: "Runtime rotation of the active group (rotated on the fly, not baked into the pixels)"},
            smoothCheck,
            rotField.field
        );

        // Vector-layer-only: "Display" mode selector — how the layer is rendered/edited. One
        // per-layer (not animatable) setting, written through ImageFile.setVectorDisplayMode.
        //   pixel sharp  = pixel-art: nodes snap to the grid, no anti-aliasing (crisp/aliased).
        //   pixel smooth = anti-aliased raster at document resolution (the default).
        //   vector       = anti-aliased, plus the editing view re-rasterizes at the zoom level so it
        //                  stays crisp when you zoom in (the doc-resolution export is unchanged).
        vectorDisplaySelect = $("select.vectordisplay-select",
            $("option", {value: "sharp"}, "pixel sharp"),
            $("option", {value: "smooth"}, "pixel smooth"),
            $("option", {value: "vector"}, "vector")
        );
        vectorDisplaySelect.onchange = ()=>{
            ImageFile.setVectorDisplayMode(undefined, vectorDisplaySelect.value);
        };
        vectorRow = $(".vectorprops",
            {parent: parent, info: "Vector layer display mode: pixel sharp (aliased), pixel smooth (anti-aliased), or vector (crisp at any zoom)"},
            $(".label", "Display"),
            vectorDisplaySelect
        );

        // ── Vector-selection rows (shown only while the Vector tool has geometry selected) ──────
        // X/Y (point or bbox top-left) and W/H reuse the .layerkeyprops/.grouptransform styling so
        // their boxes line up in the same columns as the layer transform above.
        let vpXField = makeField("X");
        let vpYField = makeField("Y");
        vpX = vpXField; vpY = vpYField;
        vsPosRow = $(".layerkeyprops vectorsel",
            {parent: parent, info: "Position of the selected point"},
            vpXField.field, vpYField.field
        );

        let vsWField = makeField("W");
        let vsHField = makeField("H");
        vsW = vsWField; vsH = vsHField;
        vsSizeRow = $(".grouptransform vectorsel",
            {parent: parent, info: "Size of the selected points' bounding box"},
            vsWField.field, vsHField.field
        );

        let vsRotField = makeField("Rot");
        vsRot = vsRotField;
        vsRotRow = $(".grouptransform vectorsel",
            {parent: parent, info: "Rotate the selected points about their bounding-box centre (degrees)"},
            vsRotField.field
        );

        // Line colour + width (+ fill for a shape). Colour swatches open a native colour picker; the
        // "primary" colour (fill for a shape, line for a line) is bound to the foreground colour.
        strokeSwatch = makeSwatch((hex)=>{ setForeground(hex); });   // line = primary for a line
        widthRange = document.createElement("input");
        widthRange.type = "range"; widthRange.min = 0; widthRange.max = 25; widthRange.value = 1;
        // Live update: apply the width to the drawing on every drag step (kept as one undo step via
        // the live flag), then finalize that single history entry when the slider is released.
        widthRange.oninput = ()=>{
            widthVal.innerText = widthRange.value + "px";
            VectorTool.setSelectedStrokeWidth(parseInt(widthRange.value, 10), true);
        };
        widthRange.onchange = ()=>{ VectorTool.commitSelectedStroke(); };
        widthVal = $(".value", "1px");
        vsStrokeBlock = $(".styleblock",
            $(".label", "Line"), strokeSwatch.el, widthRange, widthVal
        );

        fillSwatch = makeSwatch((hex)=>{ setForeground(hex); });     // fill = primary for a shape
        vsFillBlock = $(".styleblock",
            $(".label", "Fill"), fillSwatch.el
        );

        vsStyleRow = $(".vectorprops vectorstyle",
            {parent: parent, info: "Colour and line width of the selected line / shape"},
            vsStrokeBlock, vsFillBlock
        );

        groupRow.style.display = "none";
        groupRotRow.style.display = "none";
        smoothCheck.style.display = "none";
        vectorRow.style.display = "none";
        hideVectorSelRows();

        // Vector position/size/rotation edits. X/Y drives a single point OR the bbox top-left; W/H
        // and Rot reshape the multi-point bounding box.
        [vpX, vpY].forEach(f=>{
            f.input.onchange = ()=>{
                let x = parseFloat(vpX.input.value), y = parseFloat(vpY.input.value);
                if (isNaN(x) || isNaN(y)) return;
                if (vectorKind === "node") VectorTool.setSelectedNodePosition(x, y);
                else if (vectorKind === "nodes") VectorTool.setSelectionBBox({x: x, y: y});
            };
        });
        vsW.input.onchange = ()=>{ let w = parseFloat(vsW.input.value); if (!isNaN(w)) VectorTool.setSelectionBBox({w: w}); };
        vsH.input.onchange = ()=>{ let h = parseFloat(vsH.input.value); if (!isNaN(h)) VectorTool.setSelectionBBox({h: h}); };
        vsRot.input.onchange = ()=>{ let r = parseFloat(vsRot.input.value); if (!isNaN(r) && r) VectorTool.setSelectionBBox({rot: r}); };

        // X/Y — whole-pixel position (same contract as the old Layers-panel inputs).
        [xInput,yInput].forEach(input=>{
            input.onchange = ()=>{
                let x = parseInt(xInput.value,10);
                let y = parseInt(yInput.value,10);
                if (isNaN(x) || isNaN(y)) return;
                ImageFile.setLayerKeyProps(undefined,{x:x,y:y});
            };
        });

        // Width/Height — pixels → scale factor (guarded against a zero natural size).
        wField.input.onchange = ()=>{
            let w = parseInt(wField.input.value,10);
            if (isNaN(w) || !baseWidth) return;
            ImageFile.setLayerKeyProps(undefined,{scaleX: w / baseWidth});
        };
        hField.input.onchange = ()=>{
            let h = parseInt(hField.input.value,10);
            if (isNaN(h) || !baseHeight) return;
            ImageFile.setLayerKeyProps(undefined,{scaleY: h / baseHeight});
        };
        // Rotation — degrees.
        rotField.input.onchange = ()=>{
            let r = parseFloat(rotField.input.value);
            if (isNaN(r)) return;
            ImageFile.setLayerKeyProps(undefined,{rotation: r});
        };

        update();
    };

    // Reflects which track's cel is on display (spec 004 3.8), kept in step with the timeline.
    function updateTrackLabel(){
        if (!trackLabel) return;
        let track = ImageFile.getActiveTrack();
        let count = ImageFile.getTracks().length;
        trackLabel.innerHTML = track ? (count > 1 ? track.name : "") : "";
        trackLabel.info = track ? ("Showing the properties of track \"" + track.name + "\"") : "";
    }

    // Marks a transform field off-default: reveals its reset icon + orange outline and names the
    // default value in the reset icon's status-bar tooltip.
    function setFieldState(f, nondefault, defaultDisplay){
        f.field.classList.toggle("nondefault", nondefault);
        f.reset.info = "Reset to default (" + defaultDisplay + ")";
    }

    function hideGroupRows(){
        if (groupRow) groupRow.style.display = "none";
        if (groupRotRow) groupRotRow.style.display = "none";
        if (smoothCheck) smoothCheck.style.display = "none";
        if (vectorRow) vectorRow.style.display = "none";
        hideVectorSelRows();
    }

    function update(){
        if (!keyPropsRow) return;
        updateTrackLabel();
        let path = ImageFile.getActiveLayerPath();
        if (!path){ hideGroupRows(); return; }
        // Never write into a control the user is currently operating (a read-back mid-edit would
        // resolve to a different value at the playhead and yank the field out from under them).
        let props = ImageFile.getLayerKeyProps(path);
        if (!props){ hideGroupRows(); return; }
        if (document.activeElement !== xInput) xInput.value = props.x;
        if (document.activeElement !== yInput) yInput.value = props.y;
        keyPropsRow.classList.toggle("overridden", !!props.overridden);
        keyPropsRow.classList.toggle("tweening", !!props.tweening);

        if (props.isGroup){
            groupRow.style.display = "";
            groupRotRow.style.display = "";
            baseWidth = props.baseWidth;
            baseHeight = props.baseHeight;
            if (document.activeElement !== wField.input) wField.input.value = props.width;
            if (document.activeElement !== hField.input) hField.input.value = props.height;
            let rot = Math.round(props.rotation * 100) / 100;   // trim tween noise, keep it terse
            if (document.activeElement !== rotField.input) rotField.input.value = rot;

            // Off-default = a transform is present on that component (default is scale 1 / 0°).
            setFieldState(wField, props.scaleX !== 1, props.baseWidth);
            setFieldState(hField, props.scaleY !== 1, props.baseHeight);
            setFieldState(rotField, rot !== 0, "0°");

            // A tween interpolates the whole transform, so dash every box while animating.
            groupRow.classList.toggle("tweening", !!props.tweening);
            groupRotRow.classList.toggle("tweening", !!props.tweening);

            // Smooth is only meaningful (and only shown) once a scale or rotation is active.
            let hasTransform = props.scaleX !== 1 || props.scaleY !== 1 || rot !== 0;
            smoothCheck.style.display = hasTransform ? "" : "none";
            smoothCheck.setState(!!props.smooth);
        }else{
            groupRow.style.display = "none";
            groupRotRow.style.display = "none";
            smoothCheck.style.display = "none";
        }

        // Vector layer: show the Display-mode selector (mutually exclusive with the group rows).
        if (props.isVector){
            vectorRow.style.display = "";
            let mode = VECTOR_DISPLAY_MODES.indexOf(props.vectorDisplay) >= 0 ? props.vectorDisplay : "smooth";
            if (document.activeElement !== vectorDisplaySelect) vectorDisplaySelect.value = mode;
        }else{
            vectorRow.style.display = "none";
        }

        updateVectorSelection();
    }

    EventBus.on(EVENT.layersChanged, update);
    EventBus.on(EVENT.timelineChanged, updateTrackLabel);
    // The Vector tool's selection changes (and its geometry edits) fire vectorChanged; refresh the
    // vector-selection rows so they track what's picked.
    EventBus.on(EVENT.vectorChanged, updateVectorSelection);
    // A filled shape / line stays bound to the foreground colour: editing the foreground writes it
    // into the selected fill (shape) or line colour. Skipped while we're setting the foreground FROM
    // the selection (suppressColorWrite), so there's no feedback loop.
    EventBus.on(EVENT.drawColorChanged, (color)=>{
        if (suppressColorWrite || !VectorTool.isActive()) return;
        let info = VectorTool.getSelectionInfo();
        let stylesNodes = info.kind === "nodes" && info.edgeCount;
        if (info.kind !== "region" && info.kind !== "edge" && !stylesNodes) return;
        let hex = Color.toHex(color);
        if (typeof hex !== "string" || !/^#[0-9a-fA-F]{6}/.test(hex)) return;   // e.g. "transparent" → leave it
        hex = hex.substr(0, 7);
        if (info.kind === "region") VectorTool.setSelectedFillColor(hex);
        else VectorTool.setSelectedStrokeColor(hex);   // edge, or the lines within a Select-All
    });

    return me;
}();

export default PropertiesPanel;
