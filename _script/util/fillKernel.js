// Flood-fill / flood-select kernel for spec 016 (Editor Performance), design §6, R4.
//
// This is the pure numeric core of the paint-bucket / magic-wand flood operation
// that used to live inline in ui/components/selectbox.js. That version used a hash
// object for visitation and a plain array as a FIFO queue drained with shift()
// (O(n) per element → O(n²) on large regions). This replaces it with:
//   - a flat Uint8Array visitation buffer, and
//   - a scanline span fill that pushes at most one seed per contiguous run,
//     backed by an Int32Array seed stack with an explicit head index that grows
//     on demand and raises a controlled error at a capacity ceiling rather than
//     overwriting samples silently (design §6: "never overwrite silently").
//
// The matched set is exactly the 4- (or 8-) connected component of pixels whose
// ORIGINAL colour matches the seed within tolerance — identical to the previous
// breadth-first result, so wired callers keep byte-for-byte output. The matching
// predicate mirrors the old Color.toHex/Color.distance comparison numerically:
// an exact match requires all four RGBA channels equal; otherwise, when a
// tolerance is set, the Euclidean RGBA distance must be <= tolerance*2.

const DEFAULT_MAX_SEEDS = 1 << 24; // 16M seed ceiling before a controlled failure

// Build the seed-color match predicate shared by every mode. `data` is RGBA bytes.
function makeMatcher(data, seed, tolerance) {
    const sr = seed[0], sg = seed[1], sb = seed[2], sa = seed[3];
    const limit = tolerance > 0 ? (tolerance * 2) * (tolerance * 2) : 0; // compare squared distance
    return function matches(index) {
        const p = index * 4;
        const dr = data[p] - sr;
        const dg = data[p + 1] - sg;
        const db = data[p + 2] - sb;
        const da = data[p + 3] - sa;
        if (dr === 0 && dg === 0 && db === 0 && da === 0) return true;
        if (tolerance > 0) {
            return (dr * dr + dg * dg + db * db + da * da) <= limit;
        }
        return false;
    };
}

// A minimally-growing Int32Array stack with a head index. push() grows by doubling
// up to maxCapacity; exceeding it throws a controlled RangeError. The initial
// allocation never exceeds maxCapacity so the ceiling is always honoured.
function createSeedStack(initialCapacity, maxCapacity) {
    let buffer = new Int32Array(Math.min(Math.max(16, initialCapacity | 0), maxCapacity));
    let head = 0;
    return {
        get size() { return head; },
        push(value) {
            if (head >= buffer.length) {
                if (buffer.length >= maxCapacity) {
                    throw new RangeError('fillKernel: seed stack overflow at ' + maxCapacity);
                }
                const next = Math.min(buffer.length * 2, maxCapacity);
                const grown = new Int32Array(next);
                grown.set(buffer);
                buffer = grown;
            }
            buffer[head++] = value;
        },
        pop() { return buffer[--head]; },
    };
}

// Read the seed colour at a pixel index as an [r,g,b,a] array.
export function colorAt(data, index) {
    const p = index * 4;
    return [data[p], data[p + 1], data[p + 2], data[p + 3]];
}

// Compute the matched pixel set. Returns { matched: Uint8Array(w*h) of 0/1, count,
// bounds:{minX,minY,maxX,maxY}|null }.
//
// options:
//   data        RGBA byte array (Uint8ClampedArray/Uint8Array), length w*h*4
//   width,height
//   startIndex  seed pixel index (row-major); ignored when global
//   seed        optional explicit [r,g,b,a]; defaults to the colour at startIndex
//   tolerance   0 = exact; >0 uses Euclidean RGBA distance <= tolerance*2
//   connectivity 4 (default) or 8
//   global      true = match every pixel to the seed (no connectivity walk)
//   region      optional Uint8Array(w*h) mask; only pixels with region[i] truthy
//               are eligible (an active selection). null = whole image.
//   maxSeeds    seed-stack ceiling (controlled failure). default 16M.
export function computeFloodRegion(options) {
    const data = options.data;
    const width = options.width | 0;
    const height = options.height | 0;
    const total = width * height;
    const tolerance = options.tolerance || 0;
    const connectivity = options.connectivity === 8 ? 8 : 4;
    const region = options.region || null;
    const maxSeeds = options.maxSeeds || DEFAULT_MAX_SEEDS;

    const matched = new Uint8Array(total);
    if (total === 0) return { matched, count: 0, bounds: null };

    const startIndex = options.startIndex | 0;
    const seed = options.seed || colorAt(data, options.global ? startIndex : startIndex);
    const matches = makeMatcher(data, seed, tolerance);
    const eligible = region ? (i => region[i] && matches(i)) : matches;

    let count = 0;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const mark = (index, x, y) => {
        matched[index] = 1;
        count++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
    };

    if (options.global) {
        for (let i = 0; i < total; i++) {
            if (eligible(i)) mark(i, i % width, (i / width) | 0);
        }
        return { matched, count, bounds: count ? { minX, minY, maxX, maxY } : null };
    }

    if (startIndex < 0 || startIndex >= total || !eligible(startIndex)) {
        return { matched, count: 0, bounds: null };
    }

    // Scanline span fill. Seeds are the y-rows to scan; each push records one pixel
    // on a not-yet-visited run. head-index storage avoids O(n) shift().
    const seeds = createSeedStack(Math.min(1024, total), maxSeeds);
    seeds.push(startIndex);

    const eligibleAt = (x, y) => {
        const i = y * width + x;
        return !matched[i] && eligible(i);
    };

    while (seeds.size) {
        const s = seeds.pop();
        let x = s % width;
        const y = (s / width) | 0;

        // Walk left to the start of this contiguous eligible run.
        let lx = x;
        while (lx > 0 && eligibleAt(lx - 1, y)) lx--;

        let spanAbove = false;
        let spanBelow = false;
        const walkDiagonals = connectivity === 8;

        for (let cx = lx; cx < width && eligibleAt(cx, y); cx++) {
            const i = y * width + cx;
            mark(i, cx, y);

            if (y > 0) {
                const up = eligibleAt(cx, y - 1);
                if (up && !spanAbove) { seeds.push((y - 1) * width + cx); spanAbove = true; }
                else if (!up) spanAbove = false;
            }
            if (y < height - 1) {
                const down = eligibleAt(cx, y + 1);
                if (down && !spanBelow) { seeds.push((y + 1) * width + cx); spanBelow = true; }
                else if (!down) spanBelow = false;
            }

            // 8-connectivity: also seed the diagonal neighbours that the span walk
            // above/below would otherwise miss at run boundaries.
            if (walkDiagonals) {
                if (y > 0) {
                    if (cx > 0 && eligibleAt(cx - 1, y - 1)) seeds.push((y - 1) * width + (cx - 1));
                    if (cx < width - 1 && eligibleAt(cx + 1, y - 1)) seeds.push((y - 1) * width + (cx + 1));
                }
                if (y < height - 1) {
                    if (cx > 0 && eligibleAt(cx - 1, y + 1)) seeds.push((y + 1) * width + (cx - 1));
                    if (cx < width - 1 && eligibleAt(cx + 1, y + 1)) seeds.push((y + 1) * width + (cx + 1));
                }
            }
        }
    }

    return { matched, count, bounds: count ? { minX, minY, maxX, maxY } : null };
}

// Reference breadth-first flood used as a differential oracle in tests and kept as
// the documented semantics of the optimized kernel (design §6: "Preserve old
// functions as differential references"). Deliberately simple and O(n²)-ish.
export function computeFloodRegionReference(options) {
    const data = options.data;
    const width = options.width | 0;
    const height = options.height | 0;
    const total = width * height;
    const tolerance = options.tolerance || 0;
    const connectivity = options.connectivity === 8 ? 8 : 4;
    const region = options.region || null;

    const matched = new Uint8Array(total);
    if (total === 0) return { matched, count: 0 };

    const startIndex = options.startIndex | 0;
    const seed = options.seed || colorAt(data, startIndex);
    const matches = makeMatcher(data, seed, tolerance);
    const eligible = region ? (i => region[i] && matches(i)) : matches;

    let count = 0;
    const put = (i) => { matched[i] = 1; count++; };

    if (options.global) {
        for (let i = 0; i < total; i++) if (eligible(i)) put(i);
        return { matched, count };
    }
    if (startIndex < 0 || startIndex >= total || !eligible(startIndex)) return { matched, count: 0 };

    const queue = [startIndex];
    put(startIndex);
    const neighbours4 = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    const neighbours8 = neighbours4.concat([[-1, -1], [1, -1], [-1, 1], [1, 1]]);
    const deltas = connectivity === 8 ? neighbours8 : neighbours4;

    while (queue.length) {
        const i = queue.shift();
        const x = i % width;
        const y = (i - x) / width;
        for (const [dx, dy] of deltas) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const ni = ny * width + nx;
            if (!matched[ni] && eligible(ni)) { put(ni); queue.push(ni); }
        }
    }
    return { matched, count };
}
