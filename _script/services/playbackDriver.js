// Generation-safe playback driver for spec 016 (Editor Performance), phase 7.2, design §8.
//
// Owns the rAF registration around the pure playbackClock. The invariants:
//
//   - a GENERATION token guards every scheduled callback, so an obsolete frame callback from
//     a previous play/stop cycle does nothing (no double-driving after rapid stop/start);
//   - each tick calls the LIGHTWEIGHT `presentFrame(frame)` — resolved display + playhead
//     only, no structural notifications or autosave — never the full `activateFrame`;
//   - an unchanged frame is suppressed (presentFrame is not called for the same frame twice);
//   - stalls are visible as a SKIP COUNT (frames the clock jumped over, never presented);
//   - STOP invalidates pending callbacks and synchronizes editing state to the LAST PRESENTED
//     frame via `onStop`.
//
// Injectable `requestFrame`/`cancelFrame`/`now`/`presentFrame`/`onStop` make the whole driver
// deterministic under a fake scheduler + clock in tests.

export function createPlaybackDriver(options) {
    options = options || {};
    const clock = options.clock;
    if (!clock) throw new Error("playbackDriver: clock is required");
    const requestFrame = options.requestFrame || ((fn) => { fn(); return 0; });
    const cancelFrame = options.cancelFrame || (() => {});
    const nowFn = options.now || (() => Date.now());
    const presentFrame = options.presentFrame || (() => {});
    const onStop = options.onStop || (() => {});

    let generation = 0;
    let running = false;
    let rafId = null;
    let lastPresented = null;
    let skipCount = 0;
    let presentCount = 0;

    function present(frame) {
        if (frame == null) return;
        if (lastPresented === null) { presentFrame(frame); lastPresented = frame; presentCount++; return; }
        if (frame === lastPresented) return; // suppress a no-op repaint
        const loop = clock.getLoop();
        const len = loop.end - loop.start + 1;
        const advanced = ((frame - lastPresented) % len + len) % len; // 1..len
        if (advanced > 1) skipCount += advanced - 1; // frames the stall jumped over
        presentFrame(frame);
        lastPresented = frame;
        presentCount++;
    }

    function schedule(gen) { rafId = requestFrame(() => tick(gen)); }

    function tick(gen) {
        if (gen !== generation || !running) return; // obsolete callback
        present(clock.frameAt(nowFn()));
        schedule(gen);
    }

    // Start playback, presenting the anchor frame immediately.
    function play(now, fromFrame) {
        now = now != null ? now : nowFn();
        generation++;                 // invalidate any pending callback from a prior cycle
        const g = generation;
        lastPresented = null;
        skipCount = 0;
        presentCount = 0;
        const first = clock.start(now, fromFrame);
        if (first == null) { return null; } // invalid config/range: do not run
        running = true;
        present(first);
        schedule(g);
        return first;
    }

    // Stop playback: invalidate callbacks, pause the clock, and sync editing to the last
    // presented frame.
    function stop(now) {
        now = now != null ? now : nowFn();
        generation++;                 // any in-flight callback is now obsolete
        if (rafId != null) { cancelFrame(rafId); rafId = null; }
        running = false;
        clock.pause(now);
        const finalFrame = lastPresented != null ? lastPresented : clock.getFrame();
        onStop(finalFrame);
        return finalFrame;
    }

    return {
        play,
        stop,
        isRunning: () => running,
        getGeneration: () => generation,
        getSkipCount: () => skipCount,
        getPresentCount: () => presentCount,
        getLastPresented: () => lastPresented,
    };
}
