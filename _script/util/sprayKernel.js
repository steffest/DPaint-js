// Spray emission kernel for spec 016 (Editor Performance), design §6, R4.
//
// Extracted from paintTools/spray.js. The airbrush emits `count` particles per
// tick, each drawn immediately with three Math.random() draws (angle, radius, and
// — when pressure/opacity is on — pressure). This kernel produces the SAME ordered
// particle list from an injectable RNG, so:
//   - the live tool keeps identical output when handed Math.random (same draw
//     order, same rounding), and
//   - tests get deterministic seeded replay, and
//   - the caller can compute one batched damage rectangle per tick instead of
//     invalidating per particle.
//
// The draw order is load-bearing: angle = rng()*2π, radius = sqrt(rng())*size,
// then pressure = rng() only when useOpacity. Do not reorder — it would change
// every subsequent particle for a given RNG stream and break brush semantics.

// Emit `count` ordered particles around (x,y). rng() must return [0,1). Returns an
// array of { x, y, pressure } where pressure is a number in [0,1) when useOpacity,
// otherwise null (the caller leaves the brush pressure as previously set).
export function emitParticles(options) {
    const x = options.x;
    const y = options.y;
    const size = options.size;
    const count = options.count | 0;
    const useOpacity = !!options.useOpacity;
    const rng = options.rng || Math.random;

    const particles = new Array(Math.max(0, count));
    for (let i = 0; i < count; i++) {
        const angle = rng() * Math.PI * 2;
        const radius = Math.sqrt(rng()) * size;
        const px = Math.round(x + radius * Math.cos(angle));
        const py = Math.round(y + radius * Math.sin(angle));
        const pressure = useOpacity ? rng() : null;
        particles[i] = { x: px, y: py, pressure: pressure };
    }
    return particles;
}

// The half-open bounding rectangle covering a batch of emitted particle centres,
// optionally expanded by a brush radius, or null if empty. Lets the caller batch
// one damage region per tick (design §6: "Batch spray damage/setup").
export function particleBounds(particles, brushRadius) {
    if (!particles || !particles.length) return null;
    const pad = brushRadius > 0 ? Math.ceil(brushRadius) : 0;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
    }
    return {
        x: minX - pad,
        y: minY - pad,
        width: (maxX - minX) + 1 + pad * 2,
        height: (maxY - minY) + 1 + pad * 2,
    };
}

// Time-proportional emission count (design §6: "emission density against elapsed
// time"). A steady `ratePerSecond` produces `round(rate * elapsedMs / 1000)`
// particles for a frame of the given duration, so faster frames emit more and a
// stalled frame does not under-spray. `carry` accumulates the sub-particle
// remainder across frames so long-run density is exact; returns { count, carry }.
export function emissionCount(ratePerSecond, elapsedMs, carry) {
    const exact = ratePerSecond * (elapsedMs / 1000) + (carry || 0);
    const count = Math.floor(exact);
    return { count: count, carry: exact - count };
}
