// Viewport visibility-refresh planning for spec 016 (Editor Performance), phase 9.3, design §8.
//
// When the timeline (or a document viewport) scrolls, only the NEWLY EXPOSED region needs a
// render — the cells that were already visible are unchanged. And a hidden panel must not do
// render work at all: it refreshes lazily on reattachment, and only if its data revision changed
// while it was hidden. Pure planning helpers, no DOM.

// The logical cells that entered the window between `prev` and `next` (windows are the
// `computeVisibleWindow` shape). Cells present in both are omitted (already rendered). Used to
// damage only the freshly exposed band on scroll instead of repainting the whole viewport.
export function newlyExposedCells(prev, next) {
    const inPrev = (track, frame) => prev && frame >= prev.firstFrame && frame <= prev.lastFrame && track >= prev.firstTrack && track <= prev.lastTrack;
    const out = [];
    if (!next || next.frameCount <= 0 || next.trackCount <= 0) return out;
    for (let t = next.firstTrack; t <= next.lastTrack; t++) {
        for (let f = next.firstFrame; f <= next.lastFrame; f++) {
            if (!inPrev(t, f)) out.push({ track: t, frame: f });
        }
    }
    return out;
}

// Whether a panel should refresh now. A hidden panel never refreshes; a visible panel refreshes
// only when its current data revision differs from what it last rendered — so a scroll or a
// no-op reattachment does no work, but reattaching after an edit (revision bumped) does.
export function shouldRefresh(state) {
    if (!state.visible) return false;
    return state.revision !== state.lastRenderedRevision;
}

// Tracks a secondary panel's visibility + render revision so `shouldRefresh` can be evaluated and
// the "rendered" state advanced once a refresh actually happens.
export function createPanelRefreshState(initialRevision) {
    let visible = false;
    let revision = initialRevision != null ? initialRevision : 0;
    let lastRenderedRevision = null; // never rendered yet

    return {
        setVisible(v) { visible = !!v; },
        setRevision(r) { revision = r; },
        // Returns true and advances the rendered revision if a refresh is due; else false.
        refreshIfNeeded() {
            if (!shouldRefresh({ visible, revision, lastRenderedRevision })) return false;
            lastRenderedRevision = revision;
            return true;
        },
        isVisible: () => visible,
        getRevision: () => revision,
        getLastRenderedRevision: () => lastRenderedRevision,
    };
}
