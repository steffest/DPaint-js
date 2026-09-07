// Autosave gating for spec 016 (Editor Performance), design §3.2, R2.4.
//
// Autosave subscribes to *committed* document revisions. While a stroke is active
// it must save the latest committed snapshot rather than an inconsistent live
// canvas, and playback-only movement must not trigger a document autosave. These
// are pure decisions over a small revision state so they can be unit-tested with
// no timers or DOM.
//
// Revisions here are monotonic committed-revision counters (the committed branch
// of the design §4 Revision record); a higher number means a later commit.

// The revision an autosave should serialise: always the latest committed one,
// never a live in-progress revision — even mid-stroke.
export function selectAutosaveRevision(state = {}) {
    return state.committedRevision != null ? state.committedRevision : null;
}

// Whether an autosave should run now. It runs only when the committed revision has
// advanced past the last saved one, the change is not playback-only, and (when a
// debounce is configured) enough time has elapsed since the last save.
export function shouldAutosave(state = {}) {
    const {
        committedRevision = null,
        lastSavedRevision = null,
        playbackOnly = false,
        now = null,
        lastSavedAt = null,
        debounceMs = 0,
    } = state;

    if (playbackOnly) return false;
    if (committedRevision == null) return false;
    if (lastSavedRevision != null && committedRevision <= lastSavedRevision) return false;
    if (debounceMs > 0 && now != null && lastSavedAt != null && (now - lastSavedAt) < debounceMs) return false;
    return true;
}
