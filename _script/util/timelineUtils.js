// Pure timeline model helpers for the multi-row timeline (spec 004).
//
// This module is the counterpart of layerUtils.js for the *time* axis: every timeline
// computation lives here so it can be unit-tested without DOM, Layer or image.js.
// It only ever reads/writes plain data (plus the layer tree, through isGroup).
//
// ── Data shapes ──────────────────────────────────────────────────────────────────
//
//   timeline = {
//       fps: number,
//       tracks: [ track ]              // index 0 = BOTTOM of the z-order
//   }
//
//   track = {
//       name: string,
//       visible: boolean,
//       locked: boolean,
//       keys: [ key ]                  // sorted by .frame, at most one key per frame
//   }
//
//   key (content) = {
//       frame: int,
//       type: "content",
//       tween: boolean,
//       cel: { layers: [LayerNode...], activeLayerIndex }   // exactly the old frame shape
//   }
//
//   key (property) = {
//       frame: int,
//       type: "property",
//       tween: boolean,
//       props: { [layerId]: {x, y, opacity} }   // ABSOLUTE overrides, not deltas
//   }
//
// Invariants maintained by the mutators below:
//   - keys are sorted by frame and unique per frame
//   - the first key of a track is always a content key (a property key must be governed
//     by a preceding content key on its own track)
//   - a property key never changes the layer set; that is fixed by its governing content key
//
// Frames that carry no key are *derived*: they show the previous key's resolved state
// (held), or a linear interpolation when the previous key has `tween: true` and the next
// key on the track is a property key.

import {isGroup} from "./layerUtils.js";
import {edgeHandleOffsets} from "./vectorUtils.js";

const CONTENT = "content";
const PROPERTY = "property";

// A bone pose is the deformation delta (spec 005): rotation about the pivot, a world-space
// translation, an axial stretch. Identity = rest = no deformation. Used wherever a bone lacks a
// pose so a one-sided keyframe still has something to interpolate against (spec 006).
export const IDENTITY_POSE = {angle: 0, x: 0, y: 0, scale: 1};

// A bone-layer node, checked by the string tag so this pure module needs no Layer import.
function isBoneNode(node) {
    return !!node && node.type === "bone";
}

// A vector-layer node, checked by the string tag (same reason as isBoneNode). Its geometry lives
// in node.vector (spec 008); its points are animated by a per-key `nodes` overlay (spec 012).
function isVectorNode(node) {
    return !!node && node.type === "vector";
}

// The base node-position map of a vector document, keyed by node id: { [nodeId]: {x,y} }. Nodes
// without coordinates are skipped. This is to a vector layer what poseMapOf is to an armature: the
// base a property key's `nodes` overlay merges over (spec 012).
function nodeMapOf(vector) {
    let map = {};
    if (!vector || !vector.nodes) return map;
    Object.keys(vector.nodes).forEach(id => {
        let n = vector.nodes[id];
        if (n && typeof n.x === "number" && typeof n.y === "number") map[id] = {x: n.x, y: n.y};
    });
    return map;
}

// Merges a per-node overlay over a base node map: absolute per node AND per component, so a partial
// overlay ({N1:{x}}) keeps the base y for N1 and the whole base position for any node it does not
// mention (mirrors mergePoseMaps). Only positions are stored — bezier handles follow at apply time.
function mergeNodeMaps(baseNodes, overrideNodes) {
    let out = {};
    let base = baseNodes || {};
    Object.keys(base).forEach(id => { out[id] = {x: base[id].x, y: base[id].y}; });
    if (overrideNodes) {
        Object.keys(overrideNodes).forEach(id => {
            let b = base[id] || {x: 0, y: 0};
            let o = overrideNodes[id] || {};
            out[id] = {
                x: typeof o.x === "number" ? o.x : b.x,
                y: typeof o.y === "number" ? o.y : b.y
            };
        });
    }
    return out;
}

// Linear interpolation of two node maps at t (mirrors interpolatePoseMaps). x/y are NOT rounded —
// vector geometry is sub-pixel and the rasterizer (and "sharp" mode hardening) handles pixels. A
// node present on only one side holds its value.
function interpolateNodeMaps(a, b, t) {
    let out = {};
    let ab = a || {}, bb = b || {};
    let ids = {};
    Object.keys(ab).forEach(id => { ids[id] = true; });
    Object.keys(bb).forEach(id => { ids[id] = true; });
    Object.keys(ids).forEach(id => {
        let pa = ab[id] || bb[id];
        let pb = bb[id] || pa;
        out[id] = {
            x: pa.x + (pb.x - pa.x) * t,
            y: pa.y + (pb.y - pa.y) * t
        };
    });
    return out;
}

// The base curve map of a vector document, keyed by edge id: { [edgeId]: {h1:{x,y}, h2:{x,y}} }
// where h1/h2 are handle OFFSETS from the edge's endpoints (see edgeHandleOffsets). EVERY edge is
// included — curved edges with their real offsets, straight edges with their "thirds" — so a tween
// always has a value on both sides and a straight→curved bend grows smoothly rather than popping.
// This is to a vector layer's curvature what nodeMapOf is to its point positions (spec 012).
function curveMapOf(vector) {
    let map = {};
    if (!vector || !vector.edges) return map;
    Object.keys(vector.edges).forEach(id => {
        let off = edgeHandleOffsets(vector, vector.edges[id]);
        if (off) map[id] = {h1: {x: off.h1.x, y: off.h1.y}, h2: {x: off.h2.x, y: off.h2.y}};
    });
    return map;
}

// Merges a per-edge curve overlay over a base curve map: absolute per edge, per handle, per
// component (a partial overlay {E1:{h1:{x}}} keeps the base y for h1 and the whole base h2, and any
// edge it does not mention keeps its base offsets). Mirrors mergeNodeMaps one level deeper.
function mergeCurveMaps(baseCurves, overrideCurves) {
    let out = {};
    let base = baseCurves || {};
    Object.keys(base).forEach(id => { out[id] = {h1: {...base[id].h1}, h2: {...base[id].h2}}; });
    if (overrideCurves) {
        Object.keys(overrideCurves).forEach(id => {
            let b = base[id] || {h1: {x: 0, y: 0}, h2: {x: 0, y: 0}};
            let o = overrideCurves[id] || {};
            let oh1 = o.h1 || {}, oh2 = o.h2 || {};
            out[id] = {
                h1: {x: typeof oh1.x === "number" ? oh1.x : b.h1.x, y: typeof oh1.y === "number" ? oh1.y : b.h1.y},
                h2: {x: typeof oh2.x === "number" ? oh2.x : b.h2.x, y: typeof oh2.y === "number" ? oh2.y : b.h2.y}
            };
        });
    }
    return out;
}

// Linear interpolation of two curve maps at t (mirrors interpolateNodeMaps). Handle offsets are NOT
// rounded — curvature is sub-pixel. An edge present on only one side holds its value.
function interpolateCurveMaps(a, b, t) {
    let out = {};
    let ab = a || {}, bb = b || {};
    let ids = {};
    Object.keys(ab).forEach(id => { ids[id] = true; });
    Object.keys(bb).forEach(id => { ids[id] = true; });
    Object.keys(ids).forEach(id => {
        let pa = ab[id] || bb[id];
        let pb = bb[id] || pa;
        out[id] = {
            h1: {x: pa.h1.x + (pb.h1.x - pa.h1.x) * t, y: pa.h1.y + (pb.h1.y - pa.h1.y) * t},
            h2: {x: pa.h2.x + (pb.h2.x - pa.h2.x) * t, y: pa.h2.y + (pb.h2.y - pa.h2.y) * t}
        };
    });
    return out;
}

// The base pose map of an armature, keyed by bone id: { [boneId]: {angle,x,y,scale} }. Missing
// components default to identity so every entry is a full pose (spec 006 §3.1).
function poseMapOf(armature) {
    let map = {};
    if (!armature || !Array.isArray(armature.bones)) return map;
    armature.bones.forEach(b => {
        let p = b.pose || {};
        map[b.id] = {
            angle: p.angle || 0,
            x: p.x || 0,
            y: p.y || 0,
            scale: typeof p.scale === "number" ? p.scale : 1
        };
    });
    return map;
}

// Merges a per-bone pose overlay over a base pose map: absolute per bone id AND per component, so
// a partial overlay ({B1:{angle}}) keeps the base x/y/scale for B1 and the whole base pose for any
// bone it does not mention (spec 006 §3.2).
function mergePoseMaps(baseBones, overrideBones) {
    let out = {};
    let base = baseBones || {};
    Object.keys(base).forEach(id => { out[id] = {...base[id]}; });
    if (overrideBones) {
        Object.keys(overrideBones).forEach(id => {
            let b = base[id] || IDENTITY_POSE;
            out[id] = {...b, ...overrideBones[id]};
        });
    }
    return out;
}

// Linear interpolation of two pose maps at t (spec 006 §3.3). angle is linear on the stored
// absolute delta — NOT shortest-arc: pose.angle is an unbounded cumulative value, so a deliberate
// multi-turn spin must be preserved. x/y/scale are linear too. A bone on only one side holds its
// value. Bone x/y are NOT rounded (sub-pixel is fine — the deformer resamples anyway).
function interpolatePoseMaps(a, b, t) {
    let out = {};
    let ab = a || {}, bb = b || {};
    let ids = {};
    Object.keys(ab).forEach(id => { ids[id] = true; });
    Object.keys(bb).forEach(id => { ids[id] = true; });
    Object.keys(ids).forEach(id => {
        let pa = ab[id] || IDENTITY_POSE;
        let pb = bb[id] || pa;
        let sa = typeof pa.scale === "number" ? pa.scale : 1;
        let sb = typeof pb.scale === "number" ? pb.scale : 1;
        out[id] = {
            angle: pa.angle + (pb.angle - pa.angle) * t,
            x: pa.x + (pb.x - pa.x) * t,
            y: pa.y + (pb.y - pa.y) * t,
            scale: sa + (sb - sa) * t
        };
    });
    return out;
}

function byFrame(a, b) {
    return a.frame - b.frame;
}

function keysOf(track) {
    return (track && Array.isArray(track.keys)) ? track.keys : [];
}

// ── Queries ──────────────────────────────────────────────────────────────────────

// max(last key frame over all tracks) + 1, minimum 1 (timeline length is implicit)
export function timelineLength(timeline) {
    let last = 0;
    let tracks = (timeline && Array.isArray(timeline.tracks)) ? timeline.tracks : [];
    tracks.forEach(track => {
        keysOf(track).forEach(key => {
            if (key.frame > last) last = key.frame;
        });
    });
    return last + 1;
}

// the key exactly at frame f, or undefined
export function keyAt(track, f) {
    return keysOf(track).find(key => key.frame === f);
}

// nearest key at <= f, or undefined
export function previousKey(track, f) {
    let result;
    keysOf(track).forEach(key => {
        if (key.frame <= f && (!result || key.frame > result.frame)) result = key;
    });
    return result;
}

// nearest key at > f, or undefined
export function nextKey(track, f) {
    let result;
    keysOf(track).forEach(key => {
        if (key.frame > f && (!result || key.frame < result.frame)) result = key;
    });
    return result;
}

// nearest content key at <= f (property keys are skipped), or undefined
export function governingContentKey(track, f) {
    let result;
    keysOf(track).forEach(key => {
        if (key.type === CONTENT && key.frame <= f && (!result || key.frame > result.frame)) result = key;
    });
    return result;
}

// all content keys of a track, in frame order
export function contentKeys(track) {
    return keysOf(track).filter(key => key.type === CONTENT).sort(byFrame);
}

// the property keys governed by `contentKey`: every property key between it and the next
// content key on the same track. These are the keys that become invalid when the content
// key is removed (they would silently re-bind to an earlier cel with different layer ids).
export function propertyKeysGovernedBy(track, contentKey) {
    if (!contentKey || contentKey.type !== CONTENT) return [];
    let next = keysOf(track)
        .filter(key => key.type === CONTENT && key.frame > contentKey.frame)
        .sort(byFrame)[0];
    return keysOf(track)
        .filter(key => key.type === PROPERTY
            && key.frame > contentKey.frame
            && (!next || key.frame < next.frame))
        .sort(byFrame);
}

// ── State resolution ─────────────────────────────────────────────────────────────

// Absolute per-layer base values of a cel, keyed by layer id, including nested group
// children (a props override applies wherever the id matches, so animating a node inside
// a group works). Nodes without an id are skipped — they can't be addressed by props.
export function celBaseState(cel) {
    let state = {};
    if (!cel || !Array.isArray(cel.layers)) return state;
    (function walk(nodes) {
        nodes.forEach(node => {
            if (!node) return;
            if (node.id) {
                let entry = {
                    x: node.x || 0,
                    y: node.y || 0,
                    opacity: typeof node.opacity === "number" ? node.opacity : 100
                };
                // A bone layer also contributes its armature's base pose, so a property key can
                // overlay per-bone poses on top of it the same way it overlays x/y/opacity.
                if (isBoneNode(node)) entry.bones = poseMapOf(node.armature);
                // A vector layer contributes its base node positions AND its base curve offsets, so
                // a property key can overlay per-node {x,y} and per-edge handle offsets the same way
                // it overlays a bone pose (spec 012).
                if (isVectorNode(node)) { entry.nodes = nodeMapOf(node.vector); entry.curves = curveMapOf(node.vector); }
                // A group also contributes its runtime transform (spec 007), animatable the same
                // way — scaleX/scaleY/rotation replace-per-component under a property key.
                if (isGroup(node)) {
                    entry.scaleX = typeof node.scaleX === "number" ? node.scaleX : 1;
                    entry.scaleY = typeof node.scaleY === "number" ? node.scaleY : 1;
                    entry.rotation = typeof node.rotation === "number" ? node.rotation : 0;
                }
                state[node.id] = entry;
            }
            if (isGroup(node) && Array.isArray(node.layers)) walk(node.layers);
        });
    })(cel.layers);
    return state;
}

// Absolute per-layer {x,y,opacity} at a key: the governing cel's base values with the
// key's own props overlay REPLACING them per layer id (never added or multiplied).
export function keyState(track, key) {
    if (!key) return {};
    let gov = key.type === CONTENT ? key : governingContentKey(track, key.frame);
    let state = celBaseState(gov && gov.cel);
    if (key.props) {
        Object.keys(key.props).forEach(id => {
            let override = key.props[id] || {};
            let base = state[id] || {x: 0, y: 0, opacity: 100};
            let merged = {
                x: typeof override.x === "number" ? override.x : base.x,
                y: typeof override.y === "number" ? override.y : base.y,
                opacity: typeof override.opacity === "number" ? override.opacity : base.opacity
            };
            // A bone layer's pose overlay merges over its base pose map (per bone, per component).
            if (base.bones || override.bones) merged.bones = mergePoseMaps(base.bones, override.bones);
            // A vector layer's node overlay merges over its base node map (per node, per component).
            if (base.nodes || override.nodes) merged.nodes = mergeNodeMaps(base.nodes, override.nodes);
            // ...and its curve overlay merges over its base curve map (per edge, per handle, per component).
            if (base.curves || override.curves) merged.curves = mergeCurveMaps(base.curves, override.curves);
            // A group's transform overlay REPLACES per component (spec 007), like x/y/opacity.
            if (typeof base.scaleX === "number" || typeof override.scaleX === "number") {
                merged.scaleX = typeof override.scaleX === "number" ? override.scaleX
                    : (typeof base.scaleX === "number" ? base.scaleX : 1);
                merged.scaleY = typeof override.scaleY === "number" ? override.scaleY
                    : (typeof base.scaleY === "number" ? base.scaleY : 1);
                merged.rotation = typeof override.rotation === "number" ? override.rotation
                    : (typeof base.rotation === "number" ? base.rotation : 0);
            }
            state[id] = merged;
        });
    }
    return state;
}

// Resolves what a track shows at frame f.
//   → null                       before the track's first key ("empty cells")
//   → { cel, props, key, tweening }
// `props` holds the absolute per-layer values to apply on top of the cel; `key` is the
// key the state is held from (the edit target for decision 2).
export function resolveTrackState(track, f) {
    let prev = previousKey(track, f);
    if (!prev) return null;
    let gov = governingContentKey(track, f);
    if (!gov) return null; // a property key can never be the first key on a track

    let state = keyState(track, prev);
    let next = nextKey(track, prev.frame);

    if (prev.tween && next && next.type === PROPERTY && next.frame > f && next.frame > prev.frame) {
        let t = (f - prev.frame) / (next.frame - prev.frame);
        let target = keyState(track, next);
        let interpolated = {};
        Object.keys(state).forEach(id => {
            let a = state[id];
            let b = target[id] || a;
            let entry = {
                // x/y snap to whole pixels (this is a pixel editor), opacity stays on 0..100
                x: Math.round(a.x + (b.x - a.x) * t),
                y: Math.round(a.y + (b.y - a.y) * t),
                opacity: a.opacity + (b.opacity - a.opacity) * t
            };
            // Bone poses interpolate per bone (angle/x/y/scale) — see interpolatePoseMaps.
            if (a.bones || b.bones) entry.bones = interpolatePoseMaps(a.bones, b.bones, t);
            // Vector node positions interpolate per node (x/y) — see interpolateNodeMaps (spec 012).
            if (a.nodes || b.nodes) entry.nodes = interpolateNodeMaps(a.nodes, b.nodes, t);
            // ...and curve handle offsets interpolate per edge — see interpolateCurveMaps (spec 012).
            if (a.curves || b.curves) entry.curves = interpolateCurveMaps(a.curves, b.curves, t);
            // A group's transform tweens linearly (rotation linear, not shortest-arc, so a
            // deliberate multi-turn spin is preserved — same rule as a bone's angle). A side that
            // has no transform holds identity so a one-sided key still interpolates (spec 007).
            if (typeof a.scaleX === "number" || typeof b.scaleX === "number") {
                let ax = typeof a.scaleX === "number" ? a.scaleX : 1;
                let ay = typeof a.scaleY === "number" ? a.scaleY : 1;
                let ar = typeof a.rotation === "number" ? a.rotation : 0;
                let bx = typeof b.scaleX === "number" ? b.scaleX : ax;
                let by = typeof b.scaleY === "number" ? b.scaleY : ay;
                let br = typeof b.rotation === "number" ? b.rotation : ar;
                entry.scaleX = ax + (bx - ax) * t;
                entry.scaleY = ay + (by - ay) * t;
                entry.rotation = ar + (br - ar) * t;
            }
            interpolated[id] = entry;
        });
        return {cel: gov.cel, props: interpolated, key: prev, tweening: true};
    }

    return {cel: gov.cel, props: state, key: prev, tweening: false};
}

// ── Guards ───────────────────────────────────────────────────────────────────────

// A property key needs a governing content key at its frame and an empty slot.
export function canInsertPropertyKey(track, f) {
    if (!Number.isInteger(f) || f < 0) return false;
    if (keyAt(track, f)) return false;
    return !!governingContentKey(track, f);
}

// The tween flag is storable on any key but only *acts* when the next key on the track is
// a property key; the UI disables the toggle otherwise.
export function canTween(track, key) {
    if (!key) return false;
    let next = nextKey(track, key.frame);
    return !!next && next.type === PROPERTY;
}

// Maps every property key of `keys` to the content key that governs it (object identity).
// A property key with no preceding content key maps to undefined = invalid arrangement.
function governanceMap(keys) {
    let map = new Map();
    let current;
    keys.slice().sort(byFrame).forEach(key => {
        if (key.type === CONTENT) {
            current = key;
        } else {
            map.set(key, current);
        }
    });
    return map;
}

function governanceChanged(before, after) {
    let changed = false;
    after.forEach((govAfter, key) => {
        if (!govAfter) changed = true;                  // orphaned property key
        if (before.get(key) !== govAfter) changed = true;
    });
    return changed;
}

// ── Mutators ─────────────────────────────────────────────────────────────────────

// Inserts `key` keeping `keys` sorted by frame; an existing key at the same frame is
// replaced. Rejected (returns false) for a non-integer/negative frame, or for a property
// key that would end up without a governing content key.
export function insertKey(track, key) {
    if (!track || !key) return false;
    if (!Number.isInteger(key.frame) || key.frame < 0) return false;
    if (!Array.isArray(track.keys)) track.keys = [];

    let existingIndex = track.keys.findIndex(k => k.frame === key.frame);
    if (key.type === PROPERTY) {
        // the governing check must ignore the key we are about to replace
        let candidates = track.keys.filter((k, i) => i !== existingIndex);
        let gov;
        candidates.forEach(k => {
            if (k.type === CONTENT && k.frame <= key.frame && (!gov || k.frame > gov.frame)) gov = k;
        });
        if (!gov) return false;
    }

    if (existingIndex >= 0) {
        track.keys.splice(existingIndex, 1, key);
    } else {
        track.keys.push(key);
    }
    track.keys.sort(byFrame);
    return true;
}

// Removes the key at frame f. Removing a *content* key also removes the property keys it
// governs (they would otherwise re-bind to an earlier cel with different layer ids).
// Returns the array of removed keys, or an empty array when there was nothing at f.
export function removeKey(track, f) {
    let key = keyAt(track, f);
    if (!key) return [];
    let doomed = [key];
    if (key.type === CONTENT) doomed = doomed.concat(propertyKeysGovernedBy(track, key));
    track.keys = keysOf(track).filter(k => doomed.indexOf(k) < 0);
    return doomed;
}

// Repositions the key at `fromF` to `toF`. Rejected (returns false, no mutation) when the
// target is occupied or when the move would change which content key governs any property
// key on the track (that is the "property/content boundary crossing" rule).
export function moveKey(track, fromF, toF) {
    if (!Number.isInteger(toF) || toF < 0) return false;
    if (fromF === toF) return false;
    let key = keyAt(track, fromF);
    if (!key) return false;
    if (keyAt(track, toF)) return false;

    let before = governanceMap(keysOf(track));
    key.frame = toF;
    let after = governanceMap(keysOf(track));
    if (governanceChanged(before, after)) {
        key.frame = fromF;
        track.keys.sort(byFrame);
        return false;
    }
    track.keys.sort(byFrame);
    return true;
}

// Moves every key sitting on one of `frames` by `delta`, all together or not at all. This is
// what a multi-frame selection drag in the timeline panel commits. Same rules as moveKey, with
// one addition: a target may land on a slot that another MOVING key is vacating, which is what
// makes shifting a whole block by one frame possible.
export function moveKeys(track, frames, delta) {
    if (!Number.isInteger(delta) || delta === 0) return false;
    let wanted = new Set(frames);
    let all = keysOf(track);
    let moving = all.filter(key => wanted.has(key.frame));
    if (!moving.length) return false;
    if (moving.some(key => key.frame + delta < 0)) return false;

    let movingSet = new Set(moving);
    let staying = new Set(all.filter(key => !movingSet.has(key)).map(key => key.frame));
    if (moving.some(key => staying.has(key.frame + delta))) return false;

    let before = governanceMap(all);
    moving.forEach(key => { key.frame += delta; });
    let after = governanceMap(keysOf(track));
    if (governanceChanged(before, after)) {
        moving.forEach(key => { key.frame -= delta; });
        track.keys.sort(byFrame);
        return false;
    }
    track.keys.sort(byFrame);
    return true;
}

export const KEY_TYPE = {CONTENT, PROPERTY};
