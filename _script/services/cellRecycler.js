// Timeline cell recycling + logical selection/focus/drag for spec 016 (Editor Performance),
// phase 9.2, design §8.
//
// Virtualization reuses a small pool of cell objects as the timeline scrolls, so state that must
// survive recycling (selection, keyboard focus, an in-progress drag target) is tracked by
// LOGICAL (track, frame) identity, never by the recycled cell object or a DOM child index. An
// off-screen selected cell stays selected; a drag started on a cell that scrolls out of view
// keeps targeting the right logical cell.

const cellKey = (track, frame) => track + ":" + frame;

// Recycles a bounded pool of cell objects across visible windows. `bind(cell, track, frame)` is
// the caller's hook to (re)attach a cell object to a logical position (in the app, updating the
// DOM node). The pool only ever grows to the maximum window size, never the timeline length.
export function createCellRecycler(options) {
    options = options || {};
    const bind = options.bind || (() => {});
    const createCell = options.createCell || (() => ({}));

    const active = new Map(); // "track:frame" -> cell
    const free = [];
    let created = 0, rebinds = 0;

    // Reconcile the pool to a list of visible logical cells [{track, frame}]. Cells no longer
    // visible are recycled (moved to the free list) and reused for newly visible cells.
    function reconcile(visibleCells) {
        const wanted = new Map();
        for (const c of visibleCells) wanted.set(cellKey(c.track, c.frame), c);

        // Release cells that left the window.
        for (const [key, cell] of active) {
            if (!wanted.has(key)) { active.delete(key); free.push(cell); }
        }
        // Assign (reuse or create) cells for the wanted set.
        for (const [key, pos] of wanted) {
            if (active.has(key)) continue;
            let cell = free.pop();
            if (!cell) { cell = createCell(); created++; }
            bind(cell, pos.track, pos.frame);
            rebinds++;
            active.set(key, cell);
        }
        return { activeCount: active.size, poolSize: active.size + free.length };
    }

    return {
        reconcile,
        cellAt: (track, frame) => active.get(cellKey(track, frame)) || null,
        activeCount: () => active.size,
        poolSize: () => active.size + free.length,
        getStats: () => ({ created, rebinds }),
    };
}

// Logical selection + keyboard focus. All by (track, frame), so it survives recycling and can
// reference cells outside the visible window.
export function createTimelineSelection(bounds) {
    bounds = bounds || { totalFrames: 0, totalTracks: 0 };
    const selected = new Set();
    let focus = null; // {track, frame}

    const inBounds = (t, f) => t >= 0 && f >= 0 && t < bounds.totalTracks && f < bounds.totalFrames;

    function select(track, frame, additive) {
        if (!inBounds(track, frame)) return false;
        if (!additive) selected.clear();
        selected.add(cellKey(track, frame));
        focus = { track, frame };
        return true;
    }

    // Keyboard destination from the current focus. Returns the new LOGICAL cell (which may be
    // off-screen), clamped to bounds; null if there is no focus yet.
    function moveFocus(dir) {
        if (!focus) return null;
        let { track, frame } = focus;
        if (dir === "left") frame--;
        else if (dir === "right") frame++;
        else if (dir === "up") track--;
        else if (dir === "down") track++;
        if (!inBounds(track, frame)) return focus; // clamp: stay put at an edge
        focus = { track, frame };
        return focus;
    }

    return {
        select,
        moveFocus,
        isSelected: (track, frame) => selected.has(cellKey(track, frame)),
        getFocus: () => (focus ? { track: focus.track, frame: focus.frame } : null),
        size: () => selected.size,
        setBounds: (b) => { bounds = b; },
    };
}

// Drag capture that survives recycling: the drag target is resolved from the pointer through the
// coordinate mapping to a LOGICAL cell, so scrolling during the drag still targets correctly.
export function createDragCapture(pointToCell) {
    let dragging = false;
    let origin = null; // {track, frame}

    return {
        begin(track, frame) { dragging = true; origin = { track, frame }; },
        // `point`/`params` are passed through to the injected `pointToCell`; returns the logical
        // cell under the pointer regardless of the current scroll offset.
        targetAt(point, params) {
            if (!dragging) return null;
            return pointToCell(point, params);
        },
        end() { const wasDragging = dragging; dragging = false; return wasDragging; },
        isDragging: () => dragging,
        getOrigin: () => (origin ? { track: origin.track, frame: origin.frame } : null),
    };
}
