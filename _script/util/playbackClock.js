// Elapsed-time playback clock for spec 016 (Editor Performance), phase 7.1, design §8.
//
// Playback must follow WALL-CLOCK time, not a "advance one frame per rAF" counter: if the
// main thread stalls, playback jumps to the frame that elapsed time demands rather than
// replaying every intermediate frame. This is the pure math for that (no rAF, no DOM); the
// panel owns the rAF registration (playbackDriver.js). For a fixed fps and an inclusive
// non-empty loop:
//
//   loopLength = loopEnd - loopStart + 1
//   frame = loopStart + ((startOffset + floor((now - epoch) * fps / 1000)) % loopLength)
//
//   - START anchors at the current frame and presents it immediately (not an unconditional
//     next frame);
//   - PAUSE stores the frame + sub-frame phase; RESUME rebases the epoch so no time jump;
//   - FPS / LOOP changes preserve the currently shown valid frame and rebase;
//   - SCRUB pauses and selects the requested editing frame;
//   - a hidden tab pauses and stays paused until Play;
//   - empty documents/ranges reject playback; fps and indices are finite and validated.
//
// `now` (a millisecond timestamp) is passed in by the caller, so the clock is deterministic
// under an injected clock in tests.

function isFiniteNumber(v) { return typeof v === "number" && isFinite(v); }

export function createPlaybackClock(options) {
    options = options || {};
    let fps = options.fps != null ? options.fps : 12; // 0 must stay 0 (invalid), not default to 12
    let loopStart = options.loopStart | 0;
    let loopEnd = options.loopEnd != null ? options.loopEnd | 0 : loopStart;
    let shownFrame = options.startFrame != null ? options.startFrame | 0 : loopStart;

    let playing = false;
    let epoch = 0;              // ms timestamp playback (re)based at
    let startOffset = 0;        // frames into the loop at epoch
    let remainderMs = 0;        // sub-frame phase preserved across pause/resume

    function validRange() { return loopEnd >= loopStart && loopStart >= 0; }
    function validConfig() { return validRange() && isFiniteNumber(fps) && fps > 0; }
    function loopLength() { return loopEnd - loopStart + 1; }
    function clampToLoop(frame) {
        if (frame < loopStart) return loopStart;
        if (frame > loopEnd) return loopEnd;
        return frame;
    }

    // Start (or restart) playback anchored at `fromFrame` (defaults to the current frame).
    // Returns the start frame to present immediately, or null if playback is not permitted.
    function start(now, fromFrame) {
        if (!validConfig() || !isFiniteNumber(now)) return null;
        const anchor = clampToLoop(fromFrame != null ? fromFrame | 0 : shownFrame);
        epoch = now;
        remainderMs = 0;
        startOffset = ((anchor - loopStart) % loopLength() + loopLength()) % loopLength();
        playing = true;
        shownFrame = anchor;
        return shownFrame; // present now, not the next frame
    }

    // The frame for `now`. A large gap (a stall) maps straight to the correct elapsed frame
    // via the modulo — intermediate frames are NOT replayed.
    function frameAt(now) {
        if (!playing || !validConfig() || !isFiniteNumber(now)) return shownFrame;
        const steps = Math.floor((now - epoch) * fps / 1000);
        const len = loopLength();
        shownFrame = loopStart + ((startOffset + steps) % len + len) % len;
        return shownFrame;
    }

    function pause(now) {
        if (!playing) return shownFrame;
        if (isFiniteNumber(now)) {
            const stepMs = 1000 / fps;
            const elapsed = now - epoch;
            const steps = Math.floor(elapsed * fps / 1000);
            remainderMs = elapsed - steps * stepMs;   // preserve sub-frame phase
            const len = loopLength();
            shownFrame = loopStart + ((startOffset + steps) % len + len) % len;
            startOffset = ((shownFrame - loopStart) % len + len) % len;
        }
        playing = false;
        return shownFrame;
    }

    function resume(now) {
        if (playing || !validConfig() || !isFiniteNumber(now)) return shownFrame;
        epoch = now - remainderMs; // rebase, keeping the stored sub-frame phase
        remainderMs = 0;
        playing = true;
        return shownFrame;
    }

    // Change fps mid-playback, preserving the currently shown frame and rebasing.
    function setFps(newFps, now) {
        if (!isFiniteNumber(newFps) || newFps <= 0) return false;
        const cur = frameAt(now);
        fps = newFps;
        if (playing && isFiniteNumber(now)) {
            epoch = now;
            remainderMs = 0;
            startOffset = ((cur - loopStart) % loopLength() + loopLength()) % loopLength();
        }
        return true;
    }

    // Change the loop, preserving the shown frame if it is still valid (else clamp) and
    // rebasing so time continues from there.
    function setLoop(newStart, newEnd, now) {
        if (!(newEnd >= newStart && newStart >= 0)) return false;
        const cur = frameAt(now);
        loopStart = newStart | 0;
        loopEnd = newEnd | 0;
        const kept = clampToLoop(cur);
        shownFrame = kept;
        if (playing && isFiniteNumber(now)) {
            epoch = now;
            remainderMs = 0;
            startOffset = ((kept - loopStart) % loopLength() + loopLength()) % loopLength();
        }
        return true;
    }

    // Scrub pauses playback and selects an editing frame (clamped to the loop range).
    function scrub(frame) {
        playing = false;
        remainderMs = 0;
        shownFrame = clampToLoop(frame | 0);
        return shownFrame;
    }

    // A hidden tab pauses; visibility restoration does NOT auto-resume (Play required).
    function hide(now) { return pause(now); }

    return {
        start,
        frameAt,
        pause,
        resume,
        setFps,
        setLoop,
        scrub,
        hide,
        isPlaying: () => playing,
        getFrame: () => shownFrame,
        getFps: () => fps,
        getLoop: () => ({ start: loopStart, end: loopEnd }),
        isValid: () => validConfig(),
    };
}
