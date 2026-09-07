// Ordered input-sample buffer and commit/cancel barrier for spec 016, design §3.1,
// R2.2/R2.3. Pure module: the buffer keeps every required stroke sample in order
// (position, pressure, timing, brush state) and resolves through the defined
// barrier policy. Silently dropping paint samples is unacceptable, so overflow is
// an explicit error, not a quiet discard.
//
// This is deliberately NOT EventBus hold/release: that mechanism retains only the
// latest payload per event (see eventbus.js), which would collapse a stroke to its
// last sample.

// Barrier policy (design §3.1):
//   pointerup / toolswitch / undo / save / export -> commit pending input
//   cancel                                         -> discard the transaction
//   captureloss                                    -> per the tool (configurable)
export function barrierAction(reason, opts = {}) {
    switch (reason) {
        case 'pointerup':
        case 'toolswitch':
        case 'undo':
        case 'save':
        case 'export':
            return 'commit';
        case 'cancel':
            return 'cancel';
        case 'captureloss':
            return opts.captureLossCommits === false ? 'cancel' : 'commit';
        default:
            // Unknown reasons commit rather than lose input.
            return 'commit';
    }
}

export function createInputBarrier(options = {}) {
    const maxSamples = options.maxSamples || 1_000_000;
    const captureLossCommits = options.captureLossCommits !== false; // default: commit

    let samples = [];
    let active = false;

    // Begin a fresh transaction (pointer-down). Any prior un-resolved samples are
    // an error in the caller, so we assert rather than silently drop them.
    function begin() {
        if (active && samples.length) throw new Error('input transaction already active with pending samples');
        active = true;
        samples = [];
    }

    // Append one ordered sample. Returns true if retained. Outside an active
    // transaction it is ignored (returns false); overflow throws.
    function push(sample) {
        if (!active) return false;
        if (samples.length >= maxSamples) throw new RangeError('input sample overflow: ' + maxSamples);
        samples.push(sample);
        return true;
    }

    function peek() { return samples.slice(); }

    // Resolve the barrier for a reason. On commit, returns the ordered samples and
    // clears the buffer; on cancel, returns them under `discarded` and clears.
    function resolve(reason, opts = {}) {
        const action = barrierAction(reason, {
            captureLossCommits: opts.captureLossCommits !== undefined ? opts.captureLossCommits : captureLossCommits,
        });
        const collected = samples;
        samples = [];
        active = false;
        return {
            reason,
            action,
            samples: action === 'commit' ? collected : [],
            discarded: action === 'cancel' ? collected : [],
        };
    }

    return {
        begin,
        push,
        peek,
        resolve,
        get active() { return active; },
        get size() { return samples.length; },
    };
}
