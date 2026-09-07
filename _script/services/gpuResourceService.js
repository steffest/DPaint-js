// GPU resource service for spec 016 (Editor Performance), design §6, R4/R8.
//
// Owns the lifecycle of GPU objects the quantizer and RotSprite create per call
// today (programs, shader locations, vertex buffers, textures) so they can be
// created once and reused across invocations, with source/palette/pattern updated
// independently and only when their revision changes. Everything talks to an
// injected `gl` façade, so the whole service is unit-testable with a fake GPU that
// counts create/update/dispose calls — no real WebGL context required (design §6:
// "an injectable GPU interface").
//
// Lifecycle rules (design §5/§6):
//   - Textures reuse stable-size storage; a resize deletes the old texture and
//     creates a new descriptor. Same-size reuse never reallocates.
//   - Source/palette/pattern uploads are revision-gated: no re-upload when the
//     revision is unchanged.
//   - release()/disposeAll() are idempotent and NEVER touch borrowed canvases
//     (the caller still owns those).
//   - Context loss bumps a generation, releases every accounting record, and lets
//     resources be recreated lazily from CPU sources. Repeated failures select the
//     reference (CPU) backend.

const DEFAULT_MAX_FAILURES = 3;

export function createGpuResourceService(options = {}) {
    const gl = options.gl;
    if (!gl) throw new Error('gpuResourceService requires an injected gl interface');
    const maxFailures = options.maxFailures || DEFAULT_MAX_FAILURES;

    let generation = 0;
    let failures = 0;
    let useReference = false;

    const programs = new Map();   // key -> { program, locations:Map }
    const buffers = new Map();    // key -> buffer
    const textures = new Map();   // key -> { texture, width, height, revision }
    const borrowed = new Set();   // canvases the service must never delete/resize

    const counters = {
        programCreates: 0, programDisposes: 0,
        bufferCreates: 0, bufferDisposes: 0,
        textureCreates: 0, textureDisposes: 0,
        textureUploads: 0,
        contextLosses: 0,
    };

    function getProgram(key, sources) {
        let entry = programs.get(key);
        if (!entry) {
            const program = gl.createProgram(sources.vertex, sources.fragment);
            entry = { program, locations: new Map() };
            programs.set(key, entry);
            counters.programCreates++;
        }
        return entry.program;
    }

    // Cache uniform/attrib locations per program key. `resolver(name)` calls into gl.
    function getLocation(programKey, name, resolver) {
        const entry = programs.get(programKey);
        if (!entry) throw new Error('gpuResourceService: unknown program ' + programKey);
        if (!entry.locations.has(name)) {
            entry.locations.set(name, resolver(entry.program, name));
        }
        return entry.locations.get(name);
    }

    function getBuffer(key, dataFactory) {
        let buffer = buffers.get(key);
        if (!buffer) {
            buffer = gl.createBuffer(dataFactory ? dataFactory() : undefined);
            buffers.set(key, buffer);
            counters.bufferCreates++;
        }
        return buffer;
    }

    // Get (creating or resizing) a texture of the given size. Reuses the existing
    // texture when the size is unchanged; a resize disposes the old one first.
    function getTexture(key, width, height) {
        let entry = textures.get(key);
        if (entry && entry.width === width && entry.height === height) {
            return entry.texture;
        }
        if (entry) {
            gl.deleteTexture(entry.texture);
            counters.textureDisposes++;
        }
        const texture = gl.createTexture();
        textures.set(key, { texture, width, height, revision: null });
        counters.textureCreates++;
        return texture;
    }

    // Upload source pixels to a texture only when the revision changes. Returns
    // true if an upload happened. `uploader(texture)` performs the actual texImage.
    function updateTextureSource(key, revision, uploader) {
        const entry = textures.get(key);
        if (!entry) throw new Error('gpuResourceService: texture not created ' + key);
        if (entry.revision === revision && revision != null) return false;
        uploader(entry.texture);
        entry.revision = revision;
        counters.textureUploads++;
        return true;
    }

    function registerBorrowed(canvas) { borrowed.add(canvas); }
    function isBorrowed(canvas) { return borrowed.has(canvas); }

    // Idempotent release of one keyed resource. Borrowed canvases are never deleted.
    function releaseTexture(key) {
        const entry = textures.get(key);
        if (!entry) return false;
        gl.deleteTexture(entry.texture);
        textures.delete(key);
        counters.textureDisposes++;
        return true;
    }

    function disposeAll() {
        textures.forEach(e => { gl.deleteTexture(e.texture); counters.textureDisposes++; });
        textures.clear();
        buffers.forEach(b => { gl.deleteBuffer(b); counters.bufferDisposes++; });
        buffers.clear();
        programs.forEach(e => { gl.deleteProgram(e.program); counters.programDisposes++; });
        programs.clear();
        // Borrowed canvases are the caller's; we only forget our references.
        borrowed.clear();
    }

    // Context loss: bump generation, release GPU accounting, and let the caller
    // recreate lazily from CPU sources on the next getX call. Does not itself call
    // delete* on a lost context (the objects are already gone), but clears caches.
    function notifyContextLost() {
        generation++;
        counters.contextLosses++;
        // objects are invalid on a lost context; drop references without delete*
        textures.clear();
        buffers.clear();
        programs.clear();
        // borrowed canvases survive a context loss (CPU-side)
    }

    function recordFailure() {
        failures++;
        if (failures >= maxFailures) useReference = true;
        return useReference;
    }
    function recordSuccess() { failures = 0; }

    return {
        getProgram,
        getLocation,
        getBuffer,
        getTexture,
        updateTextureSource,
        registerBorrowed,
        isBorrowed,
        releaseTexture,
        disposeAll,
        notifyContextLost,
        recordFailure,
        recordSuccess,
        getGeneration: () => generation,
        shouldUseReference: () => useReference,
        getCounters: () => Object.assign({}, counters),
        // introspection for tests
        stats: () => ({ programs: programs.size, buffers: buffers.size, textures: textures.size, borrowed: borrowed.size }),
    };
}
