// Deterministic benchmark fixture builders for spec 016 (Editor Performance),
// requirement R1.2. Pure ES module: descriptors are plain serialisable objects
// and pixel generation is driven by a seeded PRNG, so the same seed always
// produces byte-identical content. No DOM or editor state is required.
//
// The six workload families in R1.2:
//   small-art          320×256, 32 colours, pencil/fill overhead
//   multi-layer-lock   1024², 8 layers, palette lock composite/quantize
//   sparse-large       4096², sparse pencil stroke (work proportionality)
//   fill-filter        2048², flood + filter sliders (allocation, long tasks)
//   mixed-animation    300 frames, 3 tracks, masks/bones/vectors
//   long-export        long animation export pipeline buffering

// mulberry32: small, fast, fully deterministic 32-bit PRNG. Given the same seed
// it yields the same sequence, so fixtures are reproducible across runs/machines.
export function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// The immutable catalogue of fixture descriptors. Each entry is a factory taking
// an optional seed override so a family can be re-seeded without editing the base.
const FAMILIES = {
    'small-art': (seed) => ({
        name: 'small-art', family: 'small-art',
        width: 320, height: 256, colorCount: 32,
        layers: 1, frames: 1, tracks: 0,
        seed: seed ?? 0x5A1701,
        settings: { indexed: true, tool: 'pencil-fill', paletteLock: false },
    }),
    'multi-layer-lock': (seed) => ({
        name: 'multi-layer-lock', family: 'multi-layer-lock',
        width: 1024, height: 1024, colorCount: 16,
        layers: 8, frames: 1, tracks: 0,
        seed: seed ?? 0x108CE7,
        settings: { indexed: true, tool: 'brush', paletteLock: true, dither: 'bayer' },
    }),
    'sparse-large': (seed) => ({
        name: 'sparse-large', family: 'sparse-large',
        width: 4096, height: 4096, colorCount: 256,
        layers: 1, frames: 1, tracks: 0,
        seed: seed ?? 0x4096FF,
        settings: { indexed: false, tool: 'pencil', paletteLock: false, sparse: true },
    }),
    'fill-filter': (seed) => ({
        name: 'fill-filter', family: 'fill-filter',
        width: 2048, height: 2048, colorCount: 64,
        layers: 1, frames: 1, tracks: 0,
        seed: seed ?? 0x2048F1,
        settings: { indexed: false, tool: 'fill', filter: 'blur', paletteLock: false },
    }),
    'mixed-animation': (seed) => ({
        name: 'mixed-animation', family: 'mixed-animation',
        width: 512, height: 512, colorCount: 32,
        layers: 3, frames: 300, tracks: 3,
        seed: seed ?? 0x300A11,
        settings: { indexed: true, fps: 24, masks: true, bones: true, vectors: true },
    }),
    'long-export': (seed) => ({
        name: 'long-export', family: 'long-export',
        width: 640, height: 480, colorCount: 256,
        layers: 2, frames: 600, tracks: 2,
        seed: seed ?? 0x600E00,
        settings: { indexed: false, fps: 30, format: 'video', masks: false },
    }),
};

export const FIXTURE_NAMES = Object.freeze(Object.keys(FAMILIES));

// Build a fixture descriptor by name. Throws for an unknown family.
export function buildFixture(name, seed) {
    const factory = FAMILIES[name];
    if (!factory) throw new Error('unknown fixture family: ' + name);
    return factory(seed);
}

// Build every family (each with its default seed).
export function buildAllFixtures() {
    return FIXTURE_NAMES.map(n => buildFixture(n));
}

// Serialise a descriptor to a stable, order-independent JSON string. Keys are
// sorted recursively so two descriptors with the same values compare equal as
// strings regardless of property insertion order (R1.2 settings serialisation).
export function serializeFixture(descriptor) {
    return JSON.stringify(sortKeys(descriptor));
}

function sortKeys(value) {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === 'object') {
        const out = {};
        Object.keys(value).sort().forEach(k => { out[k] = sortKeys(value[k]); });
        return out;
    }
    return value;
}

// Generate deterministic indexed pixel bytes (one byte per pixel, values in
// [0, colorCount)) for a single frame of a descriptor. Optional frameIndex
// perturbs the seed so animation frames differ but stay reproducible.
export function generatePixels(descriptor, frameIndex = 0) {
    const { width, height, colorCount, seed } = descriptor;
    const total = width * height;
    if (!Number.isSafeInteger(total) || total <= 0) {
        throw new RangeError('invalid fixture dimensions: ' + width + 'x' + height);
    }
    const rand = mulberry32((seed ^ (frameIndex * 0x9E3779B1)) >>> 0);
    const out = new Uint8Array(total);
    if (descriptor.settings && descriptor.settings.sparse) {
        // Sparse workloads leave most pixels at index 0 and touch a small
        // deterministic subset, modelling a sparse pencil stroke on a big canvas.
        const touched = Math.max(1, Math.floor(total / 4096));
        for (let i = 0; i < touched; i++) {
            const p = Math.floor(rand() * total);
            out[p] = 1 + Math.floor(rand() * (colorCount - 1));
        }
        return out;
    }
    for (let i = 0; i < total; i++) {
        out[i] = Math.floor(rand() * colorCount);
    }
    return out;
}
