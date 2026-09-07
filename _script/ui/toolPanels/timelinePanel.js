import ImageFile from "../../image.js";
import $, {$div} from "../../util/dom.js";
import EventBus from "../../util/eventbus.js";
import {COMMAND, EVENT} from "../../enum.js";
import ContextMenu from "../components/contextMenu.js";
import Input from "../input.js";
import Cursor from "../cursor.js";
import Modal, {DIALOG} from "../modal.js";
import {createPlaybackClock} from "../../util/playbackClock.js";
import {createPlaybackDriver} from "../../services/playbackDriver.js";

// TimelinePanel — the multi-row timeline (spec 004, design 3.7). Replaces framesPanel.
//
// Layout (display is inverted vs storage: the TOP row is the HIGHEST track index, which is
// the top of the z-order, matching the layer panel's convention):
//
//   ┌────────────┬─ 0 ─ 1 ─ 2 ─ 3 ─ ...        ← frame ruler + playhead
//   │ ▶ fps 12   │
//   ├────────────┼──────────────────────
//   │ 👁 🔒 Trk 2 │  ●───────▶○      ●
//   │ 👁 🔒 Trk 1 │  ●     ●─────▶○───▶○
//   └────────────┴──────────────────────
//     ● content key   ○ property key   ──▶ tween span   ─── hold span
//
// All DOM goes through util/dom.js and its option keys; remember onClick fires on pointer
// DOWN (see input.js). Every mutation goes through the ImageFile timeline API, which owns
// the guards and the history steps.
let TimelinePanel = function(){
    let me = {};

    let panelTools;
    let contentPanel;
    let headerColumn;
    let gridColumn;
    let rulerRow;
    let playhead;
    let trackRows = [];
    let fpsRange;
    let fpsInput;
    let frameInput;
    let isPlaying = false;
    let editingTrackIndex = -1;
    let playbackClock;              // elapsed-time frame math (spec 016 phase 7)
    let playbackDriver;             // generation-safe rAF wrapper around the clock

    // Multi-frame selection: a contiguous frame range on ONE track. Dragging is horizontal
    // and never leaves the track, so a rectangle is never needed.
    //
    // Which gesture a drag becomes is decided by whether the cell was selected when the
    // pointer went DOWN, captured in dragIntent before onClick collapses the selection:
    //   not selected → rubber-band a new range from that cell
    //   selected     → move every key in the range
    // (onClick fires on pointer down in this codebase, hence the capture-first ordering.)
    let selection;                  // {trackIndex, from, to} | undefined
    let dragIntent;                 // "select" | "move" | undefined
    let dragAnchor = -1;            // the frame the rubber band started on
    let dragDelta = 0;

    let panelRoot;

    const ROW_HEIGHT = 22;
    const RULER_HEIGHT = 18;
    // Always show a few empty frames past the end so there is somewhere to drop a new key.
    const TRAILING_FRAMES = 4;

    // Horizontal scale: how many pixels one frame gets. Shift + wheel zooms it, so a long
    // animation can be squeezed into view or a busy stretch spread out. The lower bound keeps
    // a keyframe dot visible, the upper bound stops a handful of frames filling the panel.
    // Mirrored into CSS custom properties so the stylesheet can scale the dots with it.
    const CELL_WIDTH_DEFAULT = 18;
    const CELL_WIDTH_MIN = 6;
    const CELL_WIDTH_MAX = 48;
    let cellWidth = CELL_WIDTH_DEFAULT;

    function applyCellScale(){
        if (!panelRoot) return;
        panelRoot.style.setProperty("--timeline-cell-width", cellWidth + "px");
        panelRoot.style.setProperty("--timeline-dot-size",
            Math.max(4, Math.min(9, cellWidth - 4)) + "px");
    }

    function zoomCells(delta){
        let next = Math.round(cellWidth + delta);
        if (next < CELL_WIDTH_MIN) next = CELL_WIDTH_MIN;
        if (next > CELL_WIDTH_MAX) next = CELL_WIDTH_MAX;
        if (next === cellWidth) return;
        cellWidth = next;
        applyCellScale();
        me.list();
    }

    // Frame numbers on the ruler thin out as the scale shrinks, so labels never collide.
    // At the default 18px this is every 5 frames, matching the unzoomed look.
    function labelInterval(){
        if (cellWidth >= 30) return 2;
        if (cellWidth >= 14) return 5;
        if (cellWidth >= 8) return 10;
        return 20;
    }

    me.getCellWidth = ()=>cellWidth;

    // Sets the frame scale directly (clamped). The wheel handler goes through zoomCells.
    me.zoomTo = (width)=>{
        zoomCells(width - cellWidth);
        return cellWidth;
    };

    me.resetCellWidth = ()=>{
        cellWidth = CELL_WIDTH_DEFAULT;
        applyCellScale();
        me.list();
    };

    function columns(){
        return ImageFile.getFrameCount() + TRAILING_FRAMES;
    }

    // ── frame selection ───────────────────────────────────────────────────────────

    function isSelected(trackIndex,frame){
        return !!selection && selection.trackIndex === trackIndex
            && frame >= selection.from && frame <= selection.to;
    }

    function selectedFrames(){
        if (!selection) return [];
        let frames = [];
        for (let frame = selection.from; frame <= selection.to; frame++) frames.push(frame);
        return frames;
    }

    function setSelection(trackIndex,from,to){
        let low = Math.max(0, Math.min(from,to));
        let high = Math.max(0, Math.max(from,to));
        selection = {trackIndex: trackIndex, from: low, to: high};
    }

    me.getSelection = ()=>selection ? {trackIndex: selection.trackIndex,
        from: selection.from, to: selection.to} : undefined;

    me.setSelection = (trackIndex,from,to)=>{
        if (typeof trackIndex !== "number") return me.clearSelection();
        setSelection(trackIndex, from, typeof to === "number" ? to : from);
        me.list();
        return me.getSelection();
    };

    me.clearSelection = ()=>{
        if (!selection) return;
        selection = undefined;
        me.list();
    };

    me.generate = (parent)=>{
        // Unique context class for _style/_timeline.scss (no `:not()` collision hacks).
        if (parent && parent.classList) parent.classList.add("timeline-panel");
        panelRoot = parent;
        panelTools = $(".paneltools",{parent:parent},
            $(".transport",
                $(".button.play",{
                    onClick:(e)=>{
                        me.togglePlay();
                        if (e && e.target) e.target.classList.toggle("paused",isPlaying);
                    },
                    info: "Play the timeline"}),
                $(".rangeselectinline",
                    $("label","FPS"),
                    fpsRange = $("input",{type:"range",min:1,max:60,value:12,oninput:()=>{
                        fpsInput.value = fpsRange.value;
                        ImageFile.setFps(fpsRange.value);
                        if (playbackClock && playbackDriver && playbackDriver.isRunning()){
                            playbackClock.setFps(parseInt(fpsRange.value,10), performance.now());
                        }
                    }}),
                    fpsInput = $("input",{type:"text",value:12})
                ),
                $(".frameselectinline",
                    $("label","Frame"),
                    frameInput = $("input",{type:"text",value:0})
                )
            ),
            $(".button.addtrack",{
                onClick:()=>{EventBus.trigger(COMMAND.ADDTRACK)},
                info: "Add a new track"}),
            $(".button.delete",{
                onClick:()=>{EventBus.trigger(COMMAND.REMOVEKEYFRAME)},
                info: "Remove the keyframe under the playhead"}),
            $(".button.add",{
                onClick:()=>{EventBus.trigger(COMMAND.ADDKEYFRAME)},
                info: "Insert a keyframe at the playhead"})
        );

        contentPanel = $(".panelcontent",{parent:parent},
            headerColumn = $(".timeline-headers"),
            gridColumn = $(".timeline-grid",
                rulerRow = $(".timeline-ruler",{
                    className: "timeline-ruler handle",
                    onClick:(e)=>scrubTo(e),
                    onDrag:(x,y,touchData,e)=>scrubTo(e),
                    info: "Click or drag to move the playhead"
                }),
                playhead = $(".timeline-playhead")
            )
        );

        fpsInput.onkeydown = (e)=>{ e.stopPropagation(); };
        fpsInput.onchange = ()=>{
            let value = parseInt(fpsInput.value,10);
            if (isNaN(value)) value = 12;
            value = Math.min(60,Math.max(1,value));
            fpsInput.value = value;
            fpsRange.value = value;
            ImageFile.setFps(value);
            if (playbackClock && playbackDriver && playbackDriver.isRunning()){
                playbackClock.setFps(value, performance.now());
            }
        };

        frameInput.onkeydown = (e)=>{ e.stopPropagation(); };
        frameInput.onchange = ()=>{
            let value = parseInt(frameInput.value,10);
            if (isNaN(value)) value = 0;
            me.stopPlayback(); // a manual frame pick stops playback and edits the picked frame
            ImageFile.activateFrame(Math.min(Math.max(0,value), ImageFile.getFrameCount()-1));
        };

        // Shift + wheel zooms the horizontal (frame) scale. dom.js has no option key for
        // wheel events, so this is a direct listener on the scroll container (not on a row);
        // it must preventDefault because shift+wheel is horizontal scrolling by default.
        contentPanel.addEventListener("wheel",(e)=>{
            if (!e.shiftKey) return;
            e.preventDefault();
            let step = e.deltaMode === 1 ? e.deltaY * 3 : e.deltaY / 6;
            zoomCells(-step);
        },{passive:false});

        // Double clicking the ruler restores the default frame scale.
        rulerRow.onDoubleClick = ()=>me.resetCellWidth();

        applyCellScale();
        me.list();
    }

    // Maps a pointer event on the ruler to a frame index and moves the playhead there.
    function scrubTo(e){
        if (!e || !rulerRow) return;
        let rect = rulerRow.getBoundingClientRect();
        let frame = Math.floor((e.clientX - rect.left) / cellWidth);
        let max = ImageFile.getFrameCount() - 1;
        if (frame < 0) frame = 0;
        if (frame > max) frame = max;
        me.stopPlayback(); // scrubbing stops playback and edits the scrubbed frame
        if (frame !== ImageFile.getActiveFrameIndex()) ImageFile.activateFrame(frame);
    }

    // ── rendering ─────────────────────────────────────────────────────────────────

    me.list = ()=>{
        if (!contentPanel) return;
        let tracks = ImageFile.getTracks();
        if (!tracks.length) return;
        // a removed track (or an undo) can leave the selection pointing at nothing
        if (selection && !tracks[selection.trackIndex]) selection = undefined;
        let frameCount = ImageFile.getFrameCount();
        let cols = columns();
        let activeTrackIndex = ImageFile.getActiveTrackIndex();

        headerColumn.innerHTML = "";
        rulerRow.innerHTML = "";
        trackRows = [];
        // remove previously rendered rows, keep the ruler and the playhead marker
        Array.from(gridColumn.querySelectorAll(".timeline-row")).forEach(row=>row.remove());

        gridColumn.style.width = (cols * cellWidth) + "px";
        rulerRow.style.width = (cols * cellWidth) + "px";

        let labelEvery = labelInterval();
        for (let frame = 0; frame < cols; frame++){
            let labelled = frame % labelEvery === 0;
            let tick = $div("timeline-tick" + (frame >= frameCount ? " beyond" : ""),
                labelled ? String(frame) : "", rulerRow);
            tick.style.left = (frame * cellWidth) + "px";
            tick.style.width = cellWidth + "px";
            if (labelled) tick.classList.add("major");
        }

        // display top-down = highest storage index first
        for (let row = 0; row < tracks.length; row++){
            let trackIndex = tracks.length - 1 - row;
            renderTrackHeader(tracks[trackIndex], trackIndex, row, tracks.length, activeTrackIndex);
            renderTrackRow(tracks[trackIndex], trackIndex, row, cols, activeTrackIndex);
        }

        headerColumn.style.height = (tracks.length * ROW_HEIGHT + RULER_HEIGHT) + "px";
        me.update();
    }

    function renderTrackHeader(track, trackIndex, row, trackCount, activeTrackIndex){
        let elm = $div("timeline-trackheader handle"
            + (trackIndex === activeTrackIndex ? " active" : "")
            + (track.mask ? " masktrack" : "")
            + (ImageFile.isTrackMasked(trackIndex) ? " masked" : ""),
            "", headerColumn);
        elm.style.top = (RULER_HEIGHT + row * ROW_HEIGHT) + "px";
        elm.style.height = ROW_HEIGHT + "px";
        elm.id = "track-" + trackIndex;
        elm.trackIndex = trackIndex;
        elm.info = "Click to activate, double click to rename, drag to reorder";

        $div("eye" + (track.visible === false ? " off" : ""),"",elm,()=>{
            ImageFile.toggleTrack(trackIndex);
        }).info = track.visible === false ? "Track is hidden — click to show" : "Click to hide this track";

        $div("lock" + (track.locked ? " on" : ""),"",elm,()=>{
            ImageFile.toggleTrackLock(trackIndex);
        }).info = track.locked ? "Track is locked — click to unlock" : "Click to lock this track";

        // The bottom track has nothing beneath it, so it can never be a mask.
        let canMask = ImageFile.canBeMaskTrack(trackIndex);
        $div("maskflag" + (track.mask ? " on" : "") + (canMask ? "" : " disabled"),"",elm,()=>{
            if (canMask) ImageFile.toggleTrackMask(trackIndex);
        }).info = track.mask
            ? "Mask track — white reveals, black conceals the track below; click to make it a normal track"
            : (canMask
                ? "Click to use this track as a mask for the track below it"
                : "The bottom track has nothing beneath it to mask");

        if (editingTrackIndex === trackIndex){
            let input = $("input.trackname",{type:"text",value:track.name,parent:elm});
            input.onkeydown = (e)=>{
                e.stopPropagation();
                if (e.key === "Enter") commitRename(trackIndex,input.value);
                if (e.key === "Escape"){ editingTrackIndex = -1; me.list(); }
            };
            input.onblur = ()=>commitRename(trackIndex,input.value);
            setTimeout(()=>{ input.focus(); input.select(); },0);
        }else{
            $div("name","" + track.name,elm);
        }

        elm.onClick = ()=>{
            ImageFile.activateTrack(trackIndex);
        };
        elm.onDoubleClick = ()=>{
            editingTrackIndex = trackIndex;
            me.list();
        };
        elm.onContextMenu = ()=>{
            ContextMenu.show([
                {label:"Add Track", command: COMMAND.ADDTRACK},
                {label:"Duplicate Track", action:()=>ImageFile.duplicateTrack(trackIndex)},
                {label:"Rename Track", action:()=>{ editingTrackIndex = trackIndex; me.list(); }},
                {label:"Move Track Up", disabled: trackIndex >= trackCount-1,
                    action:()=>ImageFile.moveTrack(trackIndex,trackIndex+1)},
                {label:"Move Track Down", disabled: trackIndex <= 0,
                    action:()=>ImageFile.moveTrack(trackIndex,trackIndex-1)},
                {label: track.visible === false ? "Show Track" : "Hide Track",
                    action:()=>ImageFile.toggleTrack(trackIndex)},
                {label: track.mask ? "Stop Using as Mask" : "Use as Mask",
                    disabled: !ImageFile.canBeMaskTrack(trackIndex),
                    action:()=>ImageFile.toggleTrackMask(trackIndex)},
                {label: convertLabel(trackIndex),
                    disabled: !ImageFile.canConvertTrackToFrames(trackIndex,convertRange(trackIndex)),
                    action:()=>convertTrackToFramesWithConfirm(trackIndex)},
                {label:"Remove Track", disabled: trackCount <= 1,
                    action:()=>ImageFile.removeTrack(trackIndex)},
            ]);
        };

        // Vertical drag reorders the track — this IS the z-order (decision 7).
        elm.onDragStart = ()=>{
            Input.setDragElement($div("dragelement box","" + track.name));
            elm.classList.add("ghost");
            Cursor.set("drag");
        };
        elm.onDrag = (x,y)=>{
            elm.targetRow = Math.round((row * ROW_HEIGHT + y) / ROW_HEIGHT);
        };
        elm.onDragEnd = ()=>{
            Input.removeDragElement();
            elm.classList.remove("ghost");
            Cursor.reset();
            if (typeof elm.targetRow === "number" && elm.targetRow !== row){
                let clamped = Math.min(Math.max(0,elm.targetRow), trackCount-1);
                // display rows run top-down, storage indices bottom-up
                ImageFile.moveTrack(trackIndex, trackCount - 1 - clamped);
            }
            elm.targetRow = undefined;
        };
    }

    function commitRename(trackIndex,name){
        if (editingTrackIndex !== trackIndex) return;
        editingTrackIndex = -1;
        ImageFile.renameTrack(trackIndex,(name || "").trim() || undefined);
        me.list();
    }

    function renderTrackRow(track, trackIndex, row, cols, activeTrackIndex){
        let rowElm = $div("timeline-row" + (trackIndex === activeTrackIndex ? " active" : "")
            + (track.visible === false ? " hidden" : "")
            + (track.mask ? " masktrack" : "")
            + (ImageFile.isTrackMasked(trackIndex) ? " masked" : ""), "", gridColumn);
        rowElm.style.top = (RULER_HEIGHT + row * ROW_HEIGHT) + "px";
        rowElm.style.height = ROW_HEIGHT + "px";
        rowElm.style.width = (cols * cellWidth) + "px";
        trackRows[trackIndex] = rowElm;

        let keys = track.keys || [];
        let firstFrame = keys.length ? keys[0].frame : Infinity;
        let lastFrame = keys.length ? keys[keys.length-1].frame : -1;

        for (let frame = 0; frame < cols; frame++){
            let key = keys.find(k=>k.frame === frame);
            let classes = ["timeline-cell","handle"];
            if (frame < firstFrame) classes.push("empty");           // nothing renders here yet
            else if (frame <= lastFrame || key) classes.push("span");
            else classes.push("hold");                               // holds the last state
            if (key) classes.push(key.type === "content" ? "contentkey" : "propertykey");

            // A tween span is only drawn where the flag actually acts: the previous key has
            // tween on AND the next key is a property key.
            let governing = lastKeyAtOrBefore(keys,frame);
            if (governing && governing.tween){
                let next = keys.find(k=>k.frame > governing.frame);
                if (next && next.type === "property" && frame < next.frame) classes.push("tween");
            }

            if (isSelected(trackIndex,frame)){
                classes.push("selected");
                if (frame === selection.from) classes.push("selection-start");
                if (frame === selection.to) classes.push("selection-end");
            }

            let cell = $div(classes.join(" "),"",rowElm);
            cell.style.left = (frame * cellWidth) + "px";
            cell.style.width = cellWidth + "px";
            cell.id = "cell-" + trackIndex + "-" + frame;
            cell.dataset.frame = String(frame);
            cell.dataset.track = String(trackIndex);
            cell.info = key
                ? (key.type === "content" ? "Content keyframe" : "Property keyframe")
                : "Empty cell — right click to insert a keyframe";

            if (key) $div("dot","",cell);

            cell.onClick = ()=>{
                // Capture the gesture BEFORE the selection changes: a drag that starts on an
                // already-selected cell moves the selection, anything else rubber-bands.
                dragIntent = isSelected(trackIndex,frame) ? "move" : "select";
                dragAnchor = frame;
                dragDelta = 0;
                ImageFile.activateTrack(trackIndex);
                ImageFile.activateFrame(frame);
                if (dragIntent === "select"){
                    // collapse onto this cell, so the very next drag on it moves it
                    setSelection(trackIndex,frame,frame);
                    me.list();
                }
            };
            cell.onContextMenu = ()=>showCellMenu(trackIndex,frame,key);

            // Every cell drags: on an unselected one that means selecting a range, on a
            // selected one it means moving the keys under the selection. Both are horizontal
            // and stay on this track — the y of the drag is deliberately ignored.
            cell.onDragStart = ()=>{
                ImageFile.activateTrack(trackIndex);
                Cursor.set("drag");
                if (dragIntent === "move") markDragging(true);
            };
            cell.onDrag = (x)=>{
                let delta = Math.round(x / cellWidth);
                if (dragIntent === "move"){
                    dragDelta = delta;
                    return;
                }
                setSelection(trackIndex, dragAnchor, dragAnchor + delta);
                me.list();
            };
            cell.onDragEnd = ()=>{
                Cursor.reset();
                markDragging(false);
                let delta = dragDelta;
                let intent = dragIntent;
                dragIntent = undefined;
                dragDelta = 0;
                if (intent !== "move" || !delta || !selection) return;
                let frames = selectedFrames();
                if (ImageFile.moveKeyframes(frames,delta,trackIndex)){
                    // keep the moved block selected so it can be nudged again
                    setSelection(trackIndex, selection.from + delta, selection.to + delta);
                }
                me.list();
            };
        }
    }

    // Dims the whole selected block while it is being dragged, not just the grabbed cell.
    function markDragging(on){
        if (!contentPanel) return;
        contentPanel.querySelectorAll(".timeline-cell.selected").forEach(cell=>{
            cell.classList.toggle("dragging",!!on);
        });
    }

    function lastKeyAtOrBefore(keys,frame){
        let result;
        keys.forEach(key=>{
            if (key.frame <= frame && (!result || key.frame > result.frame)) result = key;
        });
        return result;
    }

    // Cell context menu. Enablement mirrors the timelineUtils guards exactly, so a menu item
    // is only clickable when the operation would actually succeed.
    function showCellMenu(trackIndex,frame,key){
        ImageFile.activateTrack(trackIndex);
        ImageFile.activateFrame(Math.min(frame, ImageFile.getFrameCount()-1));

        let canProperty = ImageFile.canInsertPropertyKeyframe(frame);
        let canTweenHere = ImageFile.canTweenKeyframe(frame);
        let items = [
            {label:"Insert Keyframe", disabled: !!key, action:()=>ImageFile.addKeyframe(frame)},
            {label:"Insert Keyframe (copy)", disabled: !!key,
                action:()=>ImageFile.addKeyframe(frame,{copy:true})},
            {label:"Insert Property Keyframe", disabled: !canProperty,
                action:()=>ImageFile.addPropertyKeyframe(frame)},
            {label: key && key.tween ? "Tween Off" : "Tween On", disabled: !canTweenHere,
                action:()=>ImageFile.setKeyTween(frame)},
            {label:"Remove Keyframe", disabled: !key, action:()=>removeKeyframeWithConfirm(frame)},
            {label:"Add Track", command: COMMAND.ADDTRACK},
            {label:"Remove Track", disabled: ImageFile.getTracks().length <= 1,
                action:()=>ImageFile.removeTrack(trackIndex)},
        ];
        ContextMenu.show(items);
    }

    // A MULTI-frame selection on this track limits the convert to those frames. A single
    // selected cell does not: clicking a cell selects it, so treating that as a range would
    // silently turn every menu use into a one-frame convert.
    function convertRange(trackIndex){
        if (!selection || selection.trackIndex !== trackIndex) return undefined;
        if (selection.to <= selection.from) return undefined;
        return {from: selection.from, to: selection.to};
    }

    function convertLabel(trackIndex){
        return convertRange(trackIndex) ? "Convert Selection to Frames" : "Convert to Frames";
    }

    // "Convert to Frames" bakes a track's animation into one content key per frame, each
    // holding a single flattened canvas. That throws away the layer stack, the tweens and the
    // property keys it covers, so it always confirms first.
    function convertTrackToFramesWithConfirm(trackIndex){
        let range = convertRange(trackIndex);
        let plan = ImageFile.getConvertToFramesPlan(trackIndex,range);
        if (!plan.canApply) return;
        let count = plan.frameCount;
        let frames = count + " frame" + (count === 1 ? "" : "s");

        let text = plan.whole
            ? "This bakes \"" + plan.trackName + "\" into " + frames + ", one content " +
              "keyframe each holding a single flattened canvas. Layers, tweens and property " +
              "keyframes on this track are replaced by the pixels they produce."
            : "This bakes frames " + plan.from + " to " + plan.to + " of \"" + plan.trackName +
              "\" into " + frames + ", one content keyframe each holding a single flattened " +
              "canvas. Keys outside the range are kept, though a tween running into the range " +
              "can no longer reach past it.";
        // A property key outside the range can lose the layers it animates: it addresses them
        // by id, and a baked cel has fresh ones. It is kept (removing it could shorten the
        // animation) but it will not do anything, so say so rather than let it puzzle later.
        if (plan.orphanedCount){
            text += " " + plan.orphanedCount + " property keyframe" +
                (plan.orphanedCount === 1 ? "" : "s") + " after the range will stop animating: " +
                "the layers " + (plan.orphanedCount === 1 ? "it addresses are" : "they address are") +
                " replaced by baked pixels.";
        }

        Modal.show(DIALOG.OPTION,{
            title: plan.whole ? "Convert to Frames" : "Convert Selection to Frames",
            width: 380,
            text: text,
            buttons:[
                {label:"Convert " + frames,
                    onclick:()=>ImageFile.convertTrackToFrames(trackIndex,range)},
                {label:"Cancel"}
            ]
        });
    }

    // Removing a content key takes the property keys it governs with it — confirm first when
    // that would delete more than the clicked cell.
    function removeKeyframeWithConfirm(frame){
        let count = ImageFile.getKeyframeRemovalCount(frame);
        if (count <= 1){
            ImageFile.removeKeyframe(frame);
            return;
        }
        Modal.show(DIALOG.OPTION,{
            title: "Remove Keyframe",
            width: 340,
            text: "This content keyframe governs " + (count-1) + " property keyframe" +
                ((count-1) === 1 ? "" : "s") + ". Removing it removes " + count +
                " keyframes in total.",
            buttons:[
                {label:"Remove " + count + " keyframes", onclick:()=>ImageFile.removeKeyframe(frame)},
                {label:"Cancel"}
            ]
        });
    }

    // Cheap refresh: playhead position and the active cell highlight only.
    me.update = ()=>{
        if (!contentPanel) return;
        let frame = ImageFile.getActiveFrameIndex();
        let activeTrackIndex = ImageFile.getActiveTrackIndex();
        if (playhead){
            playhead.style.left = (frame * cellWidth) + "px";
            playhead.style.width = cellWidth + "px";
            playhead.style.height = (ImageFile.getTracks().length * ROW_HEIGHT + RULER_HEIGHT) + "px";
        }
        if (frameInput && document.activeElement !== frameInput) frameInput.value = frame;
        if (fpsRange && document.activeElement !== fpsInput){
            fpsRange.value = ImageFile.getFps();
            fpsInput.value = ImageFile.getFps();
        }
        contentPanel.querySelectorAll(".timeline-cell.playhead").forEach(cell=>cell.classList.remove("playhead"));
        trackRows.forEach((rowElm,trackIndex)=>{
            if (!rowElm) return;
            rowElm.classList.toggle("active",trackIndex === activeTrackIndex);
            let cell = rowElm.children[frame];
            if (cell) cell.classList.add("playhead");
        });
        headerColumn.querySelectorAll(".timeline-trackheader").forEach(elm=>{
            elm.classList.toggle("active",elm.trackIndex === activeTrackIndex);
        });
    }

    // Stop playback if it is running (a scrub, a frame edit, or a second Play press).
    me.stopPlayback = ()=>{
        if (playbackDriver && playbackDriver.isRunning()){
            playbackDriver.stop(performance.now());
        }
        isPlaying = false;
    };

    // Playback is driven by an elapsed-time clock (playbackClock: follows wall-clock time, so a
    // stall jumps to the frame that time demands instead of replaying every frame) wrapped in a
    // generation-safe rAF driver (playbackDriver: a rapid stop/start can't leave two loops
    // running, and the same frame is never presented twice).
    //
    // Each tick presents via activateFrame. The app has no present-only display path yet, so the
    // frame you SEE is still the active editing frame; the presented-vs-active split
    // (presentationState) waits on a compositor that can show a frame without retargeting edits.
    me.togglePlay = ()=>{
        if (playbackDriver && playbackDriver.isRunning()){
            me.stopPlayback();
            return;
        }
        let count = ImageFile.getFrameCount();
        if (count < 2){ isPlaying = false; return; } // nothing to play
        playbackClock = createPlaybackClock({
            fps: ImageFile.getFps(),
            loopStart: 0,
            loopEnd: count - 1,
            startFrame: ImageFile.getActiveFrameIndex()
        });
        playbackDriver = createPlaybackDriver({
            clock: playbackClock,
            requestFrame: (fn)=>requestAnimationFrame(fn),
            cancelFrame: (id)=>cancelAnimationFrame(id),
            now: ()=>performance.now(),
            presentFrame: (frame)=>ImageFile.activateFrame(frame),
            onStop: ()=>{ isPlaying = false; }
        });
        isPlaying = true;
        playbackDriver.play(performance.now(), ImageFile.getActiveFrameIndex());
    }

    me.isPlaying = ()=>isPlaying;

    // Structure changes rebuild the rows; a playhead move only needs the cheap update.
    EventBus.on(EVENT.timelineChanged,me.list);
    EventBus.on(EVENT.imageSizeChanged,me.list);
    EventBus.on(EVENT.framesChanged,()=>{
        // Track count OR frame count can change without a timelineChanged (undo, an opened
        // animation), and either one changes the grid, so compare both against what is drawn
        // and only fall back to the cheap playhead update when the shape still matches.
        if (!contentPanel){
            return;
        }
        let rows = gridColumn.querySelectorAll(".timeline-row");
        let drawnColumns = rows.length ? rows[0].querySelectorAll(".timeline-cell").length : 0;
        if (rows.length !== ImageFile.getTracks().length || drawnColumns !== columns()){
            me.list();
        }else{
            me.update();
        }
    });

    return me;
}();

export default TimelinePanel;
