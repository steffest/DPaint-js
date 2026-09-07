// Compiled keyframe segments for spec 016 (Editor Performance), phase 8.4, design §8.
//
// Replaces a per-query linear scan of a track's keyframes with a compiled, sorted segment list
// resolved by binary search (random scrub) or a forward cursor (sequential playback). Both MUST
// resolve exactly the same state as the reference linear scan (`resolveTrackStateReference`
// here) — that parity is the whole point, so the fast path can never drift from the authored
// animation. Segments carry a `structureRevision`; a structural edit recompiles and replaces the
// signature rather than mutating in place.
//
// A keyframe: { frame, value, tween?, dependencies? }. `dependencies` (optional) declares
// { backdrop, mask, property } each 'static' | 'dynamic'; a held segment whose dependencies are
// all static is eligible for static output caching.

// Reference resolver (the authoritative linear scan). Returns the active segment for `frame`:
//   { index, keyframe, next, t } — index -1 / keyframe null before the first keyframe.
// `t` is the normalized position in [0,1) between `keyframe.frame` and `next.frame` when the
// active keyframe tweens into the next; otherwise 0 (held).
export function resolveTrackStateReference(keyframes, frame) {
    let idx = -1;
    for (let i = 0; i < keyframes.length; i++) {
        if (keyframes[i].frame <= frame) idx = i; else break;
    }
    return makeState(keyframes, idx, frame);
}

function makeState(keyframes, idx, frame) {
    if (idx < 0) return { index: -1, keyframe: null, next: null, t: 0 };
    const keyframe = keyframes[idx];
    const next = idx + 1 < keyframes.length ? keyframes[idx + 1] : null;
    let t = 0;
    if (keyframe.tween && next && next.frame > keyframe.frame) {
        t = (frame - keyframe.frame) / (next.frame - keyframe.frame);
        if (t < 0) t = 0; else if (t > 1) t = 1;
    }
    return { index: idx, keyframe, next, t };
}

// Compile a sorted, immutable segment view of the track for the given structure revision.
export function compileSegments(keyframes, structureRevision) {
    const sorted = keyframes.slice().sort((a, b) => a.frame - b.frame);
    const frames = sorted.map((k) => k.frame);

    // Binary search: greatest keyframe with frame <= query (equal to the linear-scan hold rule).
    function indexAt(frame) {
        let lo = 0, hi = frames.length - 1, ans = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (frames[mid] <= frame) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
        }
        return ans;
    }

    function resolve(frame) { return makeState(sorted, indexAt(frame), frame); }

    // Forward cursor for playback: advances/rewinds its held index without a fresh search, and
    // resolves the identical state as `resolve`.
    function createCursor() {
        let cur = -1;
        return {
            seek(frame) {
                // advance forward while the next keyframe starts at/under `frame`
                while (cur + 1 < sorted.length && sorted[cur + 1].frame <= frame) cur++;
                // rewind when scrubbing backward
                while (cur >= 0 && sorted[cur].frame > frame) cur--;
                return makeState(sorted, cur, frame);
            },
            index: () => cur,
        };
    }

    // A held segment (no tween into a next keyframe) whose declared dependencies are all static
    // is eligible for static output caching; a tweened or dynamic-dependency segment is not.
    function isStaticCacheable(frame) {
        const idx = indexAt(frame);
        if (idx < 0) return false;
        const kf = sorted[idx];
        const next = idx + 1 < sorted.length ? sorted[idx + 1] : null;
        if (kf.tween && next) return false; // interpolating -> not static
        const d = kf.dependencies;
        if (!d) return true;                 // no declared dynamic dependency
        return d.backdrop !== "dynamic" && d.mask !== "dynamic" && d.property !== "dynamic";
    }

    return {
        structureRevision: structureRevision | 0,
        keyframeCount: sorted.length,
        resolve,
        createCursor,
        isStaticCacheable,
    };
}

// True when compiled segments are stale against the current structure revision and must be
// recompiled (revision replacement of the signature).
export function needsRecompile(compiled, structureRevision) {
    return !compiled || compiled.structureRevision !== (structureRevision | 0);
}

// Bone bind cache: skinning bind data survives POSE-only updates (playback/keyed poses) and is
// invalidated only by rig / rest / source changes.
export function createBindCache() {
    let value = null;
    let valid = false;
    return {
        set(v) { value = v; valid = true; },
        get() { return valid ? value : null; },
        isValid: () => valid,
        // kind: 'pose' keeps the cache; 'rig' | 'rest' | 'source' invalidates it.
        noteUpdate(kind) {
            if (kind === "rig" || kind === "rest" || kind === "source") { valid = false; value = null; }
            return valid;
        },
    };
}
