// Revision & edit transaction service for spec 016 (Editor Performance),
// phase 4.1, design §3.1/§4.
//
// This is the authority for "what changed and how recently" so that caches (hover,
// display variants, frame cache) can tell whether their inputs are still current. It
// owns:
//   - a documentGeneration that whole-document open/restore bumps (invalidating every
//     cache and cancelling in-flight work), plus a rebuilt runtime cel-identity map;
//   - per-target content revisions and a set of coarse document revisions
//     (structure/palette/mask/pose/filters/dimensions);
//   - scoped edit transactions: beginEdit -> beforeWrite/markChanged -> commit|cancel,
//     producing a ChangeSet, incrementing content revision while live pixels change and
//     the committed document revision on commit; cancel advances the content revision
//     again so pre-cancel preview caches cannot be reused;
//   - a legacy-event adapter that translates an uninstrumented change into conservative
//     FULL damage plus a content-revision bump, counted for diagnostics.
//
// It is pure and injectable: it holds no DOM and calls nothing global. The live app
// wires it up separately (behind the phase-2 scheduler flag); these semantics are
// exercised by unit tests with plain target objects. Byte capture/restore of pixels
// is the history service's job (phase 5) — this service reserves the *revision*
// bookkeeping and calls injected before/after hooks so the two compose without this
// module importing history.

import { fullDamage, mergeDamage, cloneDamage, emptyDamage } from "../util/damage.js";

const REVISION_KINDS = ["content", "structure", "palette", "mask", "pose", "filters", "dimensions"];

export function createEditService(options) {
    options = options || {};
    // Injected side effects (all optional): a monotonic clock for ordering, and hooks
    // the history layer supplies to actually snapshot/restore pixels on commit/cancel.
    const now = options.now || (() => Date.now());

    let documentGeneration = 0;
    // Per-target content revision, keyed by resolved cel/layer identity.
    const contentRevisions = new Map(); // identity -> integer
    // Coarse document-wide revisions.
    const documentRevisions = newRevisionRecord();
    // Runtime cel identity registry: maps a live cel/layer object to a stable string id
    // for THIS generation. Rebuilt on open/restore so a recycled object never inherits a
    // previous document's identity.
    let identityByObject = new WeakMap();
    let identityCounter = 0;

    // Diagnostics (design §13): count conservative fallbacks so a spike is visible.
    const diagnostics = { legacyFallbacks: 0, commits: 0, cancels: 0, opens: 0 };

    let activeTransactions = new Set();

    function newRevisionRecord() {
        const r = {};
        for (const k of REVISION_KINDS) r[k] = 0;
        return r;
    }

    // Resolve a target to its stable identity for this generation. A target may carry an
    // explicit stable layer id (layer.id like "L3"); otherwise we mint a per-object id.
    // Resolving by identity — not by an index that structural edits shuffle — is the
    // whole point (design §3.1: "resolve by identity rather than whichever key occupies
    // an index").
    function identityOf(target) {
        if (target == null) return null;
        if (typeof target === "string") return target;
        if (target.id != null) return "id:" + target.id;
        let existing = identityByObject.get(target);
        if (!existing) {
            existing = "cel:" + documentGeneration + ":" + (++identityCounter);
            identityByObject.set(target, existing);
        }
        return existing;
    }

    function getContentRevision(target) {
        return contentRevisions.get(identityOf(target)) || 0;
    }

    function bumpContentRevision(target) {
        const key = identityOf(target);
        const next = (contentRevisions.get(key) || 0) + 1;
        contentRevisions.set(key, next);
        return next;
    }

    function getDocumentRevisions() {
        return Object.assign({}, documentRevisions);
    }

    function bumpDocumentRevision(kind) {
        if (REVISION_KINDS.indexOf(kind) < 0) throw new Error("editService: unknown revision kind " + kind);
        return ++documentRevisions[kind];
    }

    // Whole-document open/restore: new generation, dropped identities and content
    // revisions, and a structure+dimensions bump so every dependent cache misses.
    // Returns the new generation. Callers cancel jobs / drop caches keyed on the old
    // generation.
    function openDocument() {
        documentGeneration++;
        contentRevisions.clear();
        identityByObject = new WeakMap();
        identityCounter = 0;
        // A fresh document invalidates every coarse revision consumer too.
        for (const k of REVISION_KINDS) documentRevisions[k]++;
        // Any transactions from the previous document are void.
        activeTransactions.clear();
        diagnostics.opens++;
        return documentGeneration;
    }

    function getGeneration() { return documentGeneration; }

    // Begin a scoped edit. The returned transaction increments the target's content
    // revision on first markChanged/beforeWrite (live pixels are changing), accumulates
    // local damage, and on commit bumps the committed document revision + returns a
    // ChangeSet. Cancel restores (via injected hook) and advances the content revision
    // again so caches built during the cancelled preview are invalidated.
    function beginEdit(spec) {
        spec = spec || {};
        const target = spec.target;
        const identity = identityOf(target);
        const startGeneration = documentGeneration;
        const startTime = now();
        let localDamage = emptyDamage();
        let changedThisEdit = false;
        let state = "open"; // open -> committed | cancelled
        // Optional hooks: history reserves/captures before pixels here.
        const beforeWriteHook = spec.beforeWrite || options.beforeWrite;
        const restoreHook = spec.restore || options.restore;

        function ensureOpen(op) {
            if (state !== "open") throw new Error("editService: " + op + " after " + state);
            if (documentGeneration !== startGeneration) throw new Error("editService: transaction outlived its document generation");
        }

        function noteChange() {
            if (!changedThisEdit) {
                changedThisEdit = true;
                bumpContentRevision(target);
            }
        }

        const transaction = {
            id: "edit:" + startGeneration + ":" + (++identityCounter),
            target,
            identity,
            operation: spec.operation,
            get state() { return state; },
            // Called before any read-modify-write; reserves/captures before pixels through
            // the injected hook, and marks the content revision dirty.
            beforeWrite(localRect) {
                ensureOpen("beforeWrite");
                noteChange();
                if (beforeWriteHook) beforeWriteHook(target, localRect);
                return transaction;
            },
            markChanged(localRect) {
                ensureOpen("markChanged");
                noteChange();
                localDamage = mergeDamage(localDamage, rectFromLocal(localRect));
                return transaction;
            },
            commit(extra) {
                ensureOpen("commit");
                state = "committed";
                activeTransactions.delete(transaction);
                bumpDocumentRevision("content" in (extra || {}) ? extra.revisionKind : "structure");
                diagnostics.commits++;
                return {
                    target,
                    identity,
                    revision: { content: getContentRevision(target), document: getDocumentRevisions() },
                    localDamage: cloneDamage(localDamage),
                    committed: true,
                    durationMs: now() - startTime,
                    generation: startGeneration,
                    flags: (extra && extra.flags) || {},
                };
            },
            cancel() {
                if (state !== "open") return; // idempotent
                state = "cancelled";
                activeTransactions.delete(transaction);
                if (restoreHook) restoreHook(target);
                // Advancing again means any preview cache keyed on the mid-edit content
                // revision is now stale — the pixels reverted, which is itself a change.
                if (changedThisEdit) bumpContentRevision(target);
                diagnostics.cancels++;
            },
        };
        activeTransactions.add(transaction);
        return transaction;
    }

    function rectFromLocal(localRect) {
        if (!localRect) return emptyDamage();
        return { kind: "rects", rects: [normalize(localRect)] };
    }
    function normalize(r) {
        const x = Math.floor(r.x), y = Math.floor(r.y);
        const width = Math.ceil(r.x + r.width) - x;
        const height = Math.ceil(r.y + r.height) - y;
        return { x, y, width, height };
    }

    // Adapter for an uninstrumented legacy mutation (design §3.1): we do not know what
    // it touched, so it becomes conservative FULL damage plus a content bump, counted.
    // Returns a ChangeSet-shaped object the scheduler/renderer can consume identically.
    function recordLegacyChange(target, changeKind) {
        diagnostics.legacyFallbacks++;
        bumpContentRevision(target);
        const kind = changeKind && REVISION_KINDS.indexOf(changeKind) >= 0 ? changeKind : "structure";
        bumpDocumentRevision(kind);
        return {
            target,
            identity: identityOf(target),
            revision: { content: getContentRevision(target), document: getDocumentRevisions() },
            localDamage: fullDamage(),
            committed: true,
            legacy: true,
            generation: documentGeneration,
            flags: { legacy: true },
        };
    }

    return {
        openDocument,
        getGeneration,
        identityOf,
        getContentRevision,
        bumpContentRevision,
        getDocumentRevisions,
        bumpDocumentRevision,
        beginEdit,
        recordLegacyChange,
        activeTransactionCount: () => activeTransactions.size,
        getDiagnostics: () => Object.assign({}, diagnostics),
    };
}
