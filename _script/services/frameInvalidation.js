// Frame-range dependency invalidation for spec 016 (Editor Performance), phase 8.3, design §8.
//
// Turns a model change into the exact set of cached frames that must be dropped, so warm
// playback keeps as many valid frames as possible instead of clearing the whole cache on every
// edit. The staged safety net: unknown mutations fall back to whole-cache invalidation, and a
// palette-global change invalidates everything (palette affects all output).
//
// Pure: it consumes a `model` of read-only lookups (celRange, trackFrames, tweenIntervals,
// rigDependentFrames, totalFrames) and returns a scope, so it is testable with a fake model and
// then applied to any cache exposing `invalidate(predicate)`.

// Compute the affected scope for a change. Returns either:
//   { scope: 'all' }                              -> drop everything
//   { scope: 'frames', frames: Set<number> }      -> drop only those frame indices
export function computeAffected(change, model) {
    change = change || {};
    const frames = new Set();
    const addRange = (start, end) => { for (let f = start; f <= end; f++) frames.add(f); };
    const addList = (list) => { if (list) for (const f of list) frames.add(f); };

    switch (change.kind) {
        case "cel": {
            // A cel edit affects every frame across which that cel is HELD (displayed).
            const r = model.celRange(change.celId);
            if (!r) return { scope: "all" };
            addRange(r.start, r.end);
            return { scope: "frames", frames };
        }
        case "tween-endpoint": {
            // Editing a keyframe endpoint affects the intervals adjoining it on both sides.
            const intervals = model.tweenIntervals(change.trackId, change.keyIndex);
            if (!intervals) return { scope: "all" };
            for (const iv of intervals) addRange(iv.start, iv.end);
            return { scope: "frames", frames };
        }
        case "mask": {
            // A masked track's change affects the whole track's frames.
            addList(model.trackFrames(change.trackId));
            return { scope: "frames", frames };
        }
        case "rig":
        case "rest":
        case "source": {
            // Rig/rest/source edits affect every frame that depends on the rig.
            addList(model.rigDependentFrames(change.rigId));
            return { scope: "frames", frames };
        }
        case "pose": {
            // A pose-only change affects only the poses keyed on the given frames (bind cache
            // stays valid — see keySegments bind cache).
            addList(change.frames);
            return { scope: "frames", frames };
        }
        case "palette-global":
            return { scope: "all" }; // palette change affects all rendered output
        default:
            return { scope: "all" }; // unknown mutation -> conservative whole-cache invalidation
    }
}

// Apply a computed scope to a frame cache. Returns the number of entries dropped. Matches
// cached entries by their `frameIndex` (parsed from the key by the provided `frameOf`), so it
// works with the string keys `frameCache.makeFrameKey` produces.
export function applyInvalidation(cache, scope, frameOf) {
    if (scope.scope === "all") return cache.invalidate(true);
    if (scope.frames.size === 0) return 0;
    return cache.invalidate((key) => scope.frames.has(frameOf(key)));
}

// Default parser for `makeFrameKey` output ("g#|f#|variant|..."): extracts the frame index.
export function frameIndexFromKey(key) {
    const parts = String(key).split("|");
    for (const p of parts) if (p[0] === "f") return parseInt(p.slice(1), 10);
    return NaN;
}
