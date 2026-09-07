import EventBus from "../util/eventbus.js";
import { EVENT } from "../enum.js";
import ImageFile from "../image.js";
import HistoryService from "../services/historyservice.js";
import { isBones } from "../util/layerUtils.js";
import { tipOf, poseWorld, applyMatrix, segmentDistance } from "../util/boneUtils.js";

// Modal bone tool (spec 005 §5.1). One singleton owning all bone interaction, mirroring the
// meshWarp.js modal contract (start/commit/cancel, handleDown/Move/Hover/Up, pick, drawOverlay).
// Three modes:
//   select    — edit the REST rig: drag pivot / tip / action-radius handles (re-binds the deformer)
//   add       — draw a new bone (down = pivot, drag = tip); parented to the selected bone
//   transform — POSE: rotate a bone about its pivot (roots can translate); children follow (FK)
//
// Bones live in SCOPE coords (the layers[] array the bone layer sits in). The tool receives
// DOCUMENT coords and maps them through the bone layer's resolved offset (which is the scope
// offset, since a bone layer carries no offset of its own).
let BoneTool = function () {
    let me = {};

    const HANDLE = 6;            // on-screen px radius for pivot/tip hit-testing (divided by zoom)
    const RADIUS_HANDLE = 6;     // hit tolerance band for the action-radius ring

    let active = false;
    let layer;                   // the bone layer
    let mode = "select";
    let selectedId = null;       // current bone (parent for Add; target for handle edits)
    let snapshot;                // deep copy of the armature (base rig + base pose), for cancel
    let overlaySnapshot;         // deep copy of this frame's timeline pose overlays, for cancel
    let drag = null;             // active gesture: {kind, boneId, ...}
    let renderScheduled = false;
    let historyOpen = false;
    let stretch = false;         // when on, dragging a bone's tip in transform mode also scales it
    let lastScale = 1;           // 1/zoom from the last overlay draw, so hit-tests match the drawing

    function bones() { return (layer && layer.armature && layer.armature.bones) || []; }
    function boneById(id) { return bones().find(b => b.id === id); }

    // The pose the tool should DISPLAY and hit-test against at the playhead: on a keyed frame the
    // resolved (held/tweened) pose, else the base pose. Overlay + FK fold read this so the handles
    // sit on the pixels the deformer actually draws (spec 006 §5.2). A shallow bone copy carries
    // the display pose while sharing the rest geometry, so poseWorld folds the whole chain.
    // Always address the bone layer the tool is modal on (never ImageFile's active layer, which a
    // timeline scrub or keyframe add can move off the rig).
    function editPoses() { return ImageFile.getEditBonePoses ? ImageFile.getEditBonePoses(layer) : null; }
    function displayBones() {
        let ep = editPoses();
        if (!ep) return bones();
        return bones().map(b => {
            let p = ep[b.id];
            if (!p) return b;
            return {
                id: b.id, name: b.name, parentId: b.parentId,
                rest: b.rest, actionRadius: b.actionRadius,
                pose: {
                    angle: p.angle || 0, x: p.x || 0, y: p.y || 0,
                    scale: typeof p.scale === "number" ? p.scale : 1
                }
            };
        });
    }
    function scopeOffset() { return ImageFile.getLayerOffset(); }

    function docToScope(p) { let o = scopeOffset(); return { x: p.x - o.x, y: p.y - o.y }; }

    function cloneArmature(a) {
        return {
            nextBoneId: a.nextBoneId,
            bones: a.bones.map(b => ({
                id: b.id, name: b.name, parentId: b.parentId,
                rest: { ...b.rest }, pose: { ...b.pose }, actionRadius: b.actionRadius
            }))
        };
    }

    me.isActive = function () { return active; };
    me.getMode = function () { return mode; };
    me.getSelectedId = function () { return selectedId; };
    me.setSelected = function (id) {
        if (id === selectedId) return;
        selectedId = id;
        EventBus.trigger(EVENT.bonesChanged);
    };

    me.setMode = function (m) {
        if (m === mode) return;
        mode = m;
        EventBus.trigger(EVENT.bonesChanged);
    };

    me.getStretch = function () { return stretch; };
    me.setStretch = function (v) { stretch = !!v; };

    // Engage on a bone layer (defaults to the active layer). Returns false if that layer is not a
    // bone layer. Idempotent: re-starting on the same layer keeps the selection.
    me.start = function (boneLayer) {
        let l = boneLayer || ImageFile.getActiveLayer();
        if (!isBones(l)) return false;
        if (active && l === layer) return true;
        layer = l;
        active = true;
        selectedId = bones().length ? bones()[bones().length - 1].id : null;
        drag = null;
        EventBus.trigger(EVENT.bonesChanged);
        return true;
    };

    me.commit = function () {
        if (!active) return;
        endGesture(true);
        cleanup();
    };

    me.cancel = function () {
        if (!active) return;
        // A gesture in progress is rolled back from the snapshot; a completed one already ended.
        if (historyOpen && snapshot) {
            restoreSnapshot();
            HistoryService.neverMind();
            historyOpen = false;
            overlaySnapshot = undefined;
        }
        drag = null;
        cleanup();
        EventBus.trigger(EVENT.bonesChanged);
    };

    function cleanup() {
        active = false;
        layer = undefined;
        drag = null;
        snapshot = undefined;
        EventBus.trigger(EVENT.bonesChanged);
    }

    // ── hit-testing ──────────────────────────────────────────────────────────────────
    // Returns {kind:"pivot"|"tip"|"radius"|"bone", boneId} for the nearest thing under a SCOPE
    // point within tolerance, or null. Handles of the selected bone win over other bones' segments.
    me.pick = function (scopePoint, tol) {
        let sel = boneById(selectedId);
        if (sel) {
            let pivot = poseOrigin(sel);
            let tip = poseTip(sel);
            if (dist(scopePoint, pivot) <= tol) return { kind: "pivot", boneId: sel.id };
            if (dist(scopePoint, tip) <= tol) return { kind: "tip", boneId: sel.id };
            // the arrow's short back edge (shoulder line) is a radius grab handle in rest-edit mode;
            // gated to "select" so it never intercepts a Transform pose (where the body = translate).
            if (mode === "select" && shoulderLineDist(scopePoint, sel) <= tol)
                return { kind: "radiusline", boneId: sel.id };
            // action-radius handle: near the capsule outline (distance-to-segment ≈ actionRadius)
            let dr = Math.abs(segmentDistancePosed(scopePoint, sel) - sel.actionRadius);
            if (dr <= tol) return { kind: "radius", boneId: sel.id };
        }
        // nearest bone segment
        let best = null, bestD = tol;
        bones().forEach(b => {
            let d = segmentDistancePosed(scopePoint, b);
            if (d <= bestD) { bestD = d; best = b; }
        });
        if (best) return { kind: "bone", boneId: best.id };
        return null;
    };

    me.handleDown = function (point, tolerance) {
        if (!active) return;
        let sp = docToScope(point);
        let tol = tolerance || HANDLE;

        if (mode === "add") {
            beginHistory();
            drag = { kind: "add", pivot: sp, tip: sp };
            return;
        }

        let hit = me.pick(sp, tol);
        if (mode === "select") {
            if (!hit) { selectedId = null; EventBus.trigger(EVENT.bonesChanged); return; }
            selectedId = hit.boneId;
            if (hit.kind === "bone") { EventBus.trigger(EVENT.bonesChanged); return; }
            beginHistory();
            if (hit.kind === "radiusline") {
                // Drag the shoulder line to resize the action radius RELATIVE to where it was grabbed,
                // so the radius does not jump to the (small) handle distance on the first pointer-down.
                let b = boneById(hit.boneId);
                // Record which side of the axis was grabbed (grabSign) so pulling the handle further
                // OUT from the bone grows the radius and pushing it back IN (toward/through the axis)
                // shrinks it — a directional drag, not the absolute distance-to-segment.
                let grabProj = signedNormalDist(sp, b);
                drag = { kind: "radiusdrag", boneId: hit.boneId,
                    startRadius: b.actionRadius, grabProj: grabProj,
                    grabSign: grabProj < 0 ? -1 : 1 };
            } else {
                drag = { kind: hit.kind, boneId: hit.boneId };
            }
        } else if (mode === "transform") {
            if (!hit) return;
            selectedId = hit.boneId;
            let b = boneById(hit.boneId);
            beginHistory();
            // Pose the RIGHT target for this frame: on a keyed frame this is that key's overlay
            // entry, else the base pose. Mutating it directly keeps the live preview correct even
            // when an overlay already masks the base pose (spec 006 §5.2).
            let target = (ImageFile.getBonePoseObject && ImageFile.getBonePoseObject(layer, b.id)) || b.pose;
            if (typeof target.scale !== "number") target.scale = 1;
            if (hit.kind === "tip") {
                // drag the tip end → rotate the bone about its pivot (children follow); when the
                // stretch option is on, also scale the bone axially so the tip reaches the cursor.
                let pivot = poseOrigin(b);
                drag = { kind: "rotate", boneId: b.id, pose: target, pivot,
                    startAngle: target.angle || 0, grabAngle: Math.atan2(sp.y - pivot.y, sp.x - pivot.x) };
                if (stretch) {
                    drag.stretch = true;
                    drag.startScale = target.scale || 1;
                    drag.grabDist = Math.max(1e-3, dist(sp, pivot));
                }
            } else {
                // drag the pivot end (or the bone body) → translate the bone in XY (children follow)
                drag = { kind: "translate", boneId: b.id, pose: target, startX: target.x || 0, startY: target.y || 0, grab: sp };
            }
        }
        EventBus.trigger(EVENT.bonesChanged);
    };

    me.handleMove = function (point) {
        if (!active || !drag) return;
        let sp = docToScope(point);
        let b = boneById(drag.boneId);

        if (drag.kind === "add") {
            drag.tip = sp;
        } else if (drag.kind === "pivot") {
            // move the whole bone: keep angle+length, shift the pivot (rest edit)
            b.rest.x = sp.x; b.rest.y = sp.y;
        } else if (drag.kind === "tip") {
            let dx = sp.x - b.rest.x, dy = sp.y - b.rest.y;
            b.rest.angle = Math.atan2(dy, dx);
            b.rest.length = Math.max(1, Math.hypot(dx, dy));
        } else if (drag.kind === "radius") {
            // distance to the whole segment, so the capsule grows uniformly along the bone
            b.actionRadius = Math.max(1, segmentDistancePosed(sp, b));
        } else if (drag.kind === "radiusdrag") {
            // shoulder-line handle: move the radius by how far the grab point has travelled OUT from
            // the axis (relative + signed), so dragging away from the bone grows it and dragging back
            // across the axis shrinks it. grabSign anchors "out" to the side the handle was grabbed on.
            let out = drag.grabSign * signedNormalDist(sp, b);
            let startOut = drag.grabSign * drag.grabProj;
            b.actionRadius = Math.max(1, drag.startRadius + (out - startOut));
        } else if (drag.kind === "rotate") {
            let a = Math.atan2(sp.y - drag.pivot.y, sp.x - drag.pivot.x);
            drag.pose.angle = drag.startAngle + (a - drag.grabAngle);
            if (drag.stretch) {
                // scale proportional to how far the tip is dragged from the pivot vs the grab point
                drag.pose.scale = Math.max(0.05, drag.startScale * (dist(sp, drag.pivot) / drag.grabDist));
            }
        } else if (drag.kind === "translate") {
            drag.pose.x = drag.startX + (sp.x - drag.grab.x);
            drag.pose.y = drag.startY + (sp.y - drag.grab.y);
        }
        scheduleRender();
    };

    // Report what is under the pointer so the caller can pick a cursor. Returns the pick `kind`
    // ("pivot"/"tip"/"radiusline"/"radius"/"bone") or null. Cheap: no state change, no repaint.
    me.handleHover = function (point, tolerance) {
        if (!active) return null;
        let hit = me.pick(docToScope(point), tolerance || HANDLE);
        return hit ? hit.kind : null;
    };

    me.handleUp = function () {
        if (!active || !drag) return;

        if (drag.kind === "add") {
            let dx = drag.tip.x - drag.pivot.x, dy = drag.tip.y - drag.pivot.y;
            let length = Math.hypot(dx, dy);
            if (length >= 2) {
                let a = layer.armature;
                let id = "B" + (a.nextBoneId++);
                a.bones.push({
                    id, name: "bone " + a.bones.length,
                    parentId: selectedId,          // parent = the bone selected when drawing began
                    rest: { x: drag.pivot.x, y: drag.pivot.y, angle: Math.atan2(dy, dx), length },
                    pose: { angle: 0, x: 0, y: 0 },
                    actionRadius: Math.max(4, length * 0.6)
                });
                selectedId = id;                   // chain naturally from the new bone
                endGesture(true);
            } else {
                endGesture(false);                 // a click with no drag creates nothing
            }
        } else {
            let posed = drag.kind === "rotate" || drag.kind === "translate";
            endGesture(true);
            // A pose commit may have written into a timeline property key's overlay; let the
            // timeline panel / read-outs reflect it.
            if (posed) EventBus.trigger(EVENT.timelineChanged);
        }
        drag = null;
        EventBus.trigger(EVENT.bonesChanged);
    };

    // Delete the selected bone; its children re-parent to its parent (R11).
    me.deleteSelected = function () {
        if (!active || !selectedId) return;
        let b = boneById(selectedId);
        if (!b) return;
        beginHistory();
        let a = layer.armature;
        a.bones.forEach(c => { if (c.parentId === b.id) c.parentId = b.parentId; });
        a.bones = a.bones.filter(x => x.id !== b.id);
        selectedId = a.bones.length ? a.bones[a.bones.length - 1].id : null;
        endGesture(true);
        EventBus.trigger(EVENT.bonesChanged);
    };

    // Reset every bone to its rest pose (R20). Routed through setBonePoses so a reset on a KEYED
    // frame writes identity into that frame's overlay (resolving to rest) rather than touching the
    // base pose; on a content-derived frame it resets the base pose as before. One undo step.
    me.resetPose = function () {
        if (!active) return;
        if (ImageFile.setBonePoses) {
            let map = {};
            bones().forEach(b => { map[b.id] = { angle: 0, x: 0, y: 0, scale: 1 }; });
            ImageFile.setBonePoses(layer, map);
        } else {
            beginHistory();
            bones().forEach(b => { b.pose = { angle: 0, x: 0, y: 0, scale: 1 }; });
            endGesture(true);
        }
        EventBus.trigger(EVENT.bonesChanged);
    };

    // Live-preview the selected bone's action radius while a slider is being dragged — no history
    // entry, just a re-bind + repaint. The committed value is recorded once via setActionRadius.
    me.previewActionRadius = function (r) {
        let b = boneById(selectedId);
        if (!b) return;
        b.actionRadius = Math.max(1, r);
        EventBus.trigger(EVENT.bonesChanged);
    };

    // Commit the selected bone's action radius (one undo step). Used on slider release.
    me.setActionRadius = function (r) {
        let b = boneById(selectedId);
        if (!b) return;
        beginHistory();
        b.actionRadius = Math.max(1, r);
        endGesture(true);
        EventBus.trigger(EVENT.bonesChanged);
    };

    me.getSelectedActionRadius = function () {
        let b = boneById(selectedId);
        return b ? b.actionRadius : 0;
    };

    // ── history bracketing (one undo step per gesture) ────────────────────────────────
    function beginHistory() {
        if (historyOpen) return;
        // Capture BOTH sides of a pose before anything is mutated: the armature (rig + base pose)
        // and the timeline pose overlays for this frame (getBonePoseObject may create an overlay
        // entry during the drag). neverMind() drops the pending step without restoring, so a
        // cancel has to put both back by hand.
        snapshot = cloneArmature(layer.armature);
        overlaySnapshot = ImageFile.cloneBoneOverlayState ? ImageFile.cloneBoneOverlayState(layer) : undefined;
        HistoryService.start(EVENT.imageHistory);
        historyOpen = true;
    }
    function restoreSnapshot() {
        if (snapshot) layer.armature = snapshot;
        if (overlaySnapshot && ImageFile.restoreBoneOverlayState) ImageFile.restoreBoneOverlayState(overlaySnapshot);
    }
    function endGesture(keep) {
        if (!historyOpen) return;
        if (keep) HistoryService.end();
        else { restoreSnapshot(); HistoryService.neverMind(); }
        historyOpen = false;
        snapshot = undefined;
        overlaySnapshot = undefined;
    }

    // ── overlay ────────────────────────────────────────────────────────────────────
    // Draw the armature on the shared overlay (DOCUMENT coords). `zoom` keeps handle sizes and
    // line widths constant on screen.
    me.drawOverlay = function (octx, zoom) {
        if (!active) return;
        let s = 1 / (zoom || 1);
        lastScale = s;              // remembered so hit-testing the shoulder line matches what is drawn
        let o = scopeOffset();
        octx.clearRect(0, 0, octx.canvas.width, octx.canvas.height);
        octx.save();

        // live "add" rubber-band
        if (drag && drag.kind === "add") {
            drawArrow(octx, drag.pivot, drag.tip, o, s, "rgba(255,204,0,0.35)", "#ffcc00", Math.max(0.6, 1.2 * s));
            dot(octx, drag.pivot, o, 3 * s, "#ffffff");
            dot(octx, drag.tip, o, 2.5 * s, "#ffcc00");
        }

        bones().forEach(b => {
            let selected = b.id === selectedId;
            let pivot = poseOrigin(b);
            let tip = poseTip(b);
            // The bone body is a pointy arrow (kite) pointing pivot → tip, so start and end read at
            // a glance: three corners cluster at the start (pivot + two shoulders), one at the tip.
            drawArrow(octx, pivot, tip, o, s,
                selected ? "rgba(255,90,0,0.4)" : "rgba(0,150,255,0.32)",
                selected ? "#ff5a00" : "rgba(0,150,255,0.9)",
                Math.max(0.6, (selected ? 1.5 : 1.1) * s));
            // The "short section" of the arrow — the edge between the two shoulders. It closes the
            // kite so the arrowhead reads clearly, and for the selected bone in rest-edit ("select")
            // mode it is the grab handle for the action radius (drag it out/in to resize).
            let m = arrowMetrics(pivot, tip, s);
            let handle = selected && mode === "select";
            strokeLine(octx, m.s1, m.s2, o,
                handle ? "#ffcc00" : (selected ? "#ff5a00" : "rgba(0,150,255,0.9)"),
                Math.max(handle ? 1.2 : 0.6, (handle ? 2.2 : 1.1) * s));
            if (selected) {
                // action-radius region: a capsule (stadium) of radius actionRadius around the whole
                // bone segment — this mirrors the deformer's falloff, which measures distance to the
                // bone SEGMENT (not the pivot), so influence hugs the entire bone with rounded caps.
                strokeCapsule(octx, pivot, tip, b.actionRadius, o, "rgba(255,90,0,0.5)", Math.max(0.4, s));
            }
            dot(octx, pivot, o, 3.5 * s, selected ? "#ffffff" : "rgba(0,150,255,0.9)");
            dot(octx, tip, o, 2.5 * s, selected ? "#ffcc00" : "rgba(0,120,220,0.8)");
        });
        octx.restore();
    };

    // The kite geometry of a bone drawn from a (start/pivot) to b (tip): the two "shoulders" set
    // back from the tip and spread to either side. Shoulder set-back and width scale with the bone
    // length but keep a screen-space minimum (via `s`) so short bones stay visible; the set-back is
    // capped so even stubby bones keep a point. Shared by the overlay draw, the shoulder-line
    // handle, and its hit-test so all three agree pixel-for-pixel. The factors are kept small so the
    // arrow stays a slim marker rather than covering the pixels it deforms.
    function arrowMetrics(a, b, s) {
        let dx = b.x - a.x, dy = b.y - a.y;
        let L = Math.hypot(dx, dy) || 1;
        let ux = dx / L, uy = dy / L;      // unit vector along the bone
        let nx = -uy, ny = ux;             // unit perpendicular
        let base = Math.min(L * 0.5, Math.max(3 * s, L * 0.22)); // shoulder distance from the pivot
        let half = Math.max(2 * s, L * 0.10);                    // half-width at the shoulders
        let sx = a.x + ux * base, sy = a.y + uy * base;          // point on the axis at the shoulders
        return {
            s1: { x: sx + nx * half, y: sy + ny * half },        // shoulder 1
            s2: { x: sx - nx * half, y: sy - ny * half }         // shoulder 2
        };
    }

    // A bone drawn as a sharp arrow/kite: pivot → shoulder1 → tip → shoulder2. The two shoulders are
    // the pair of corners closest together (the "short section" / back edge of the arrowhead).
    function drawArrow(octx, a, b, o, s, fill, stroke, lw) {
        let m = arrowMetrics(a, b, s);
        octx.beginPath();
        octx.moveTo(a.x + o.x, a.y + o.y);           // pivot (start)
        octx.lineTo(m.s1.x + o.x, m.s1.y + o.y);     // shoulder 1
        octx.lineTo(b.x + o.x, b.y + o.y);           // tip (end)
        octx.lineTo(m.s2.x + o.x, m.s2.y + o.y);     // shoulder 2
        octx.closePath();
        octx.fillStyle = fill;
        octx.fill();
        octx.strokeStyle = stroke;
        octx.lineWidth = lw;
        octx.lineJoin = "round";
        octx.stroke();
    }
    // A straight stroked line between two scope points (used for the shoulder / radius-handle edge).
    function strokeLine(octx, p1, p2, o, color, lw) {
        octx.beginPath();
        octx.moveTo(p1.x + o.x, p1.y + o.y);
        octx.lineTo(p2.x + o.x, p2.y + o.y);
        octx.strokeStyle = color;
        octx.lineWidth = lw;
        octx.lineCap = "round";
        octx.stroke();
    }
    // Outline of the capsule (stadium): the set of points within distance `r` of segment a→b.
    // Two semicircular caps (radius r) at a and b, joined by the offset sides.
    function strokeCapsule(octx, a, b, r, o, color, lw) {
        let ang = Math.atan2(b.y - a.y, b.x - a.x);
        octx.beginPath();
        octx.arc(b.x + o.x, b.y + o.y, r, ang - Math.PI / 2, ang + Math.PI / 2);
        octx.arc(a.x + o.x, a.y + o.y, r, ang + Math.PI / 2, ang + 3 * Math.PI / 2);
        octx.closePath();
        octx.strokeStyle = color;
        octx.lineWidth = lw;
        octx.stroke();
    }
    function dot(octx, p, o, r, color) {
        octx.beginPath();
        octx.arc(p.x + o.x, p.y + o.y, r, 0, Math.PI * 2);
        octx.fillStyle = color;
        octx.fill();
        octx.lineWidth = Math.max(0.4, r * 0.25);
        octx.strokeStyle = "rgba(0,0,40,0.9)";
        octx.stroke();
    }

    function scheduleRender() {
        if (renderScheduled) return;
        renderScheduled = true;
        requestAnimationFrame(function () {
            renderScheduled = false;
            if (!active) return;
            EventBus.trigger(EVENT.bonesChanged); // one composite + overlay per animation frame
        });
    }

    // ── posed-world helpers (the bone's CURRENT pivot/tip in scope coords) ────────────
    // Overlay + hit-testing reason about the POSED bone, so a posed chain is grabbable where it is
    // drawn. poseWorld folds the whole hierarchy; the origin of a bone's matrix is its posed pivot.
    function poseOrigin(bone) {
        let pw = poseWorld(displayBones());
        let m = pw.get(bone.id);
        return m ? { x: m[4], y: m[5] } : { x: bone.rest.x, y: bone.rest.y };
    }
    function poseTip(bone) {
        let pw = poseWorld(displayBones());
        let m = pw.get(bone.id);
        if (!m) return tipOf(bone);
        // tip is the rest tip carried by the bone's skin (pose∘inv(rest)); simplest: transform the
        // local (length,0) point by the posed matrix.
        return applyMatrix(m, bone.rest.length, 0);
    }
    function segmentDistancePosed(p, bone) {
        // distance to the POSED segment
        let a = poseOrigin(bone), b = poseTip(bone);
        return pointSegDist(p.x, p.y, a.x, a.y, b.x, b.y);
    }
    // SIGNED perpendicular distance from a scope point to the bone's posed axis. Positive on one side
    // of the axis, negative on the other, so the shoulder-line drag can grow the radius when the
    // pointer moves away from the axis and shrink it when the pointer moves back across it.
    function signedNormalDist(p, bone) {
        let a = poseOrigin(bone), b = poseTip(bone);
        let dx = b.x - a.x, dy = b.y - a.y;
        let L = Math.hypot(dx, dy) || 1;
        let nx = -dy / L, ny = dx / L;   // unit normal (same orientation as arrowMetrics' shoulders)
        return (p.x - a.x) * nx + (p.y - a.y) * ny;
    }
    // distance from a scope point to the bone's shoulder line (the arrow's short back edge), using
    // the scale from the last overlay draw so the grab region matches the drawn line.
    function shoulderLineDist(p, bone) {
        let a = poseOrigin(bone), b = poseTip(bone);
        let m = arrowMetrics(a, b, lastScale);
        return pointSegDist(p.x, p.y, m.s1.x, m.s1.y, m.s2.x, m.s2.y);
    }

    function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
    function pointSegDist(px, py, ax, ay, bx, by) {
        let dx = bx - ax, dy = by - ay;
        let l2 = dx * dx + dy * dy;
        let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        let cx = ax + t * dx, cy = ay + t * dy;
        return Math.hypot(px - cx, py - cy);
    }

    return me;
}();

export default BoneTool;
