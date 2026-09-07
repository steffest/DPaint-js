// Timeline virtualization math for spec 016 (Editor Performance), phase 9.1, design §8.
//
// A long timeline (thousands of frames × many tracks) must only ever materialize the cells in
// the visible viewport plus a small overscan margin — the number of live cells is bounded by the
// viewport size, NOT by the total timeline length. This is the pure geometry for that: the
// visible window, the total scroll extents, and logical<->pixel coordinate mapping. It has no
// DOM; the panel builds cells from `computeVisibleWindow` and maps pointer events through
// `pointToCell` to LOGICAL track/frame indices (never DOM child indices).

function clampInt(v, lo, hi) { v = v | 0; if (v < lo) return lo; if (v > hi) return hi; return v; }

// The visible logical window for the current scroll offset. `overscan` extra rows/cols on each
// side keep recycling smooth. All indices are clamped to the content; counts are bounded by the
// viewport + 2*overscan regardless of totalFrames/totalTracks.
export function computeVisibleWindow(params) {
    const frameWidth = Math.max(1, params.frameWidth | 0);
    const rowHeight = Math.max(1, params.rowHeight | 0);
    const totalFrames = Math.max(0, params.totalFrames | 0);
    const totalTracks = Math.max(0, params.totalTracks | 0);
    const overscan = Math.max(0, params.overscan != null ? params.overscan | 0 : 2);

    if (totalFrames === 0 || totalTracks === 0) {
        return { firstFrame: 0, lastFrame: -1, firstTrack: 0, lastTrack: -1, frameCount: 0, trackCount: 0 };
    }

    const scrollX = Math.max(0, params.scrollX || 0);
    const scrollY = Math.max(0, params.scrollY || 0);
    const vw = Math.max(0, params.viewportWidth || 0);
    const vh = Math.max(0, params.viewportHeight || 0);

    const rawFirstFrame = Math.floor(scrollX / frameWidth) - overscan;
    const rawLastFrame = Math.floor((scrollX + vw) / frameWidth) + overscan;
    const rawFirstTrack = Math.floor(scrollY / rowHeight) - overscan;
    const rawLastTrack = Math.floor((scrollY + vh) / rowHeight) + overscan;

    const firstFrame = clampInt(rawFirstFrame, 0, totalFrames - 1);
    const lastFrame = clampInt(rawLastFrame, 0, totalFrames - 1);
    const firstTrack = clampInt(rawFirstTrack, 0, totalTracks - 1);
    const lastTrack = clampInt(rawLastTrack, 0, totalTracks - 1);

    return {
        firstFrame, lastFrame, firstTrack, lastTrack,
        frameCount: lastFrame - firstFrame + 1,
        trackCount: lastTrack - firstTrack + 1,
    };
}

// Total scrollable extents — the scroll container's logical size (independent of what's rendered).
export function totalExtent(totalFrames, totalTracks, frameWidth, rowHeight) {
    return {
        width: Math.max(0, totalFrames | 0) * Math.max(1, frameWidth | 0),
        height: Math.max(0, totalTracks | 0) * Math.max(1, rowHeight | 0),
    };
}

// Logical <-> pixel mapping (content space, offset by scroll).
export function frameToX(frame, frameWidth, scrollX) { return (frame | 0) * Math.max(1, frameWidth | 0) - (scrollX || 0); }
export function trackToY(track, rowHeight, scrollY) { return (track | 0) * Math.max(1, rowHeight | 0) - (scrollY || 0); }

// Map a viewport-relative pointer to a LOGICAL {track, frame}, or null if outside the content.
export function pointToCell(point, params) {
    const frameWidth = Math.max(1, params.frameWidth | 0);
    const rowHeight = Math.max(1, params.rowHeight | 0);
    const totalFrames = Math.max(0, params.totalFrames | 0);
    const totalTracks = Math.max(0, params.totalTracks | 0);
    const frame = Math.floor((point.x + (params.scrollX || 0)) / frameWidth);
    const track = Math.floor((point.y + (params.scrollY || 0)) / rowHeight);
    if (frame < 0 || frame >= totalFrames || track < 0 || track >= totalTracks) return null;
    return { track, frame };
}
