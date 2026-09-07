// Presentation-vs-editing state synchronization for spec 016 (Editor Performance),
// phase 7.3, design §8.
//
// While playing, the frame the user SEES (presented) is decoupled from the frame edits/
// save/export operate on (active). Two rules must hold:
//
//   - presentation-only movement (playback advancing frames) NEVER triggers autosave and
//     never changes the active editing target on its own;
//   - beginning an edit / save / export SYNCHRONIZES: it stops playback and adopts the
//     presented frame as the active target, so there is no hidden active-frame mismatch —
//     you always edit the frame you are looking at.
//
// Injectable `stopPlayback`, `onActivate`, and `requestAutosave` keep it testable with no DOM.

export function createPresentationState(options) {
    options = options || {};
    const stopPlayback = options.stopPlayback || (() => {});
    const onActivate = options.onActivate || (() => {});
    const requestAutosave = options.requestAutosave || (() => {});

    let activeFrame = options.startFrame || 0; // edit/save/export target
    let presentedFrame = activeFrame;          // currently displayed frame
    let playing = false;
    let contentDirty = false;
    const counters = { presentations: 0, activations: 0, syncs: 0, autosaveRequests: 0 };

    // Playback presenting a frame: display + playhead only. No autosave, no target change.
    function present(frame, isPlaying) {
        presentedFrame = frame;
        if (isPlaying != null) playing = isPlaying;
        counters.presentations++;
    }

    // Full activation (a real editing frame switch): active and presented move together.
    function activate(frame) {
        playing = false;
        activeFrame = frame;
        presentedFrame = frame;
        counters.activations++;
        onActivate(frame);
        return frame;
    }

    // Stop playback and adopt the presented frame as the active target. The entry point for
    // beginning an edit, a save, or an export — guarantees the target matches what is shown.
    function synchronize(now) {
        if (playing) { stopPlayback(now); playing = false; }
        activeFrame = presentedFrame;
        counters.syncs++;
        return activeFrame;
    }

    // A content edit occurred: this — not presentation movement — arms autosave.
    function markContentEdit() {
        contentDirty = true;
        counters.autosaveRequests++;
        requestAutosave();
    }

    return {
        present,
        activate,
        synchronize,
        beginEdit: synchronize, // alias: an edit begins by synchronizing
        markContentEdit,
        // Consumers inspecting the visible frame use presented state while playing.
        getVisibleFrame: () => (playing ? presentedFrame : activeFrame),
        getTargetFrame: () => activeFrame,       // what edit/save/export operate on
        getPresentedFrame: () => presentedFrame,
        isPlaying: () => playing,
        isDirty: () => contentDirty,
        clearDirty: () => { contentDirty = false; },
        getCounters: () => Object.assign({}, counters),
    };
}
