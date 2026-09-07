// Pure, DOM-free armature math for the bones feature (spec 005). The counterpart of
// timelineUtils.js / layerUtils.js for the rig — unit-testable in isolation, zero dependencies.
//
// A bone (see layer.js Layer.makeBones / design §1.2):
//   { id, name, parentId, rest:{x,y,angle,length}, pose:{angle,x,y}, actionRadius }
//   - rest.x/rest.y are the pivot in SCOPE coords (absolute, not relative to the parent).
//   - rest.angle is radians; the tip is pivot + (cos,sin)*length.
//   - pose is a delta from rest: pose.angle rotates the bone about its pivot; pose.x/pose.y
//     translate the bone (and its subtree) in world/scope space; pose.scale (default 1) stretches
//     the bone axially along its length. Identity pose ⇒ deformation is the identity (R20/R22).
//
// All matrices are 2×3 affine [a,b,c,d,e,f] in the canvas convention:
//   x' = a·x + c·y + e,  y' = b·x + d·y + f
// i.e. the 3×3
//   | a c e |
//   | b d f |
//   | 0 0 1 |

// ── matrix primitives ──────────────────────────────────────────────────────────────

export const IDENTITY = [1, 0, 0, 1, 0, 0];

export function matTranslate(tx, ty) {
    return [1, 0, 0, 1, tx, ty];
}

export function matRotate(angle) {
    let c = Math.cos(angle);
    let s = Math.sin(angle);
    return [c, s, -s, c, 0, 0];
}

export function matScale(sx, sy) {
    return [sx, 0, 0, sy, 0, 0];
}

// Composition a∘b: the matrix that applies b first, then a. (a·b as 3×3 products.)
export function matMul(a, b) {
    return [
        a[0] * b[0] + a[2] * b[1],
        a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3],
        a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4],
        a[1] * b[4] + a[3] * b[5] + a[5]
    ];
}

// Inverse of a 2×3 affine. Returns IDENTITY for a degenerate (zero-determinant) matrix.
export function matInverse(m) {
    let det = m[0] * m[3] - m[1] * m[2];
    if (!det) return IDENTITY.slice();
    let ia = m[3] / det;
    let ib = -m[1] / det;
    let ic = -m[2] / det;
    let id = m[0] / det;
    return [
        ia, ib, ic, id,
        -(ia * m[4] + ic * m[5]),
        -(ib * m[4] + id * m[5])
    ];
}

// Affine point transform.
export function applyMatrix(m, x, y) {
    return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

// ── hierarchy queries ──────────────────────────────────────────────────────────────

export function tipOf(bone) {
    return {
        x: bone.rest.x + Math.cos(bone.rest.angle) * bone.rest.length,
        y: bone.rest.y + Math.sin(bone.rest.angle) * bone.rest.length
    };
}

export function boneById(bones, id) {
    for (let i = 0; i < bones.length; i++) if (bones[i].id === id) return bones[i];
    return undefined;
}

export function childrenOf(bones, id) {
    return bones.filter(b => b.parentId === id);
}

export function rootBones(bones) {
    return bones.filter(b => b.parentId === null || b.parentId === undefined || !boneById(bones, b.parentId));
}

// Bones ordered parents-before-children (a stable topological sort). Cheap enough to run per
// edit, which keeps the world folds O(bones). Cycles (which the tools never create) are broken
// by appending any leftover bones so the result always contains every bone exactly once.
export function orderedBones(bones) {
    let out = [];
    let placed = new Set();
    let byId = new Map(bones.map(b => [b.id, b]));
    let isRoot = b => b.parentId === null || b.parentId === undefined || !byId.has(b.parentId);

    function place(b) {
        if (placed.has(b.id)) return;
        placed.add(b.id);
        out.push(b);
    }

    // Roots first, then a fixed-point sweep adding children of already-placed bones.
    bones.forEach(b => { if (isRoot(b)) place(b); });
    let changed = true;
    while (changed) {
        changed = false;
        bones.forEach(b => {
            if (!placed.has(b.id) && placed.has(b.parentId)) { place(b); changed = true; }
        });
    }
    // Any bone left (cycle) — append so callers never lose a bone.
    bones.forEach(b => place(b));
    return out;
}

// ── world transforms ─────────────────────────────────────────────────────────────

// Rest local→world for a single bone. Because rest pivots are absolute scope coords, this needs
// no parent fold: R = T(pivot) ∘ Rot(restAngle). Its origin is the pivot, x-axis along the bone.
function restMatrixOf(bone) {
    return matMul(matTranslate(bone.rest.x, bone.rest.y), matRotate(bone.rest.angle));
}

// Map<id, matrix> of each bone's rest world transform.
export function restWorld(bones) {
    let map = new Map();
    bones.forEach(b => map.set(b.id, restMatrixOf(b)));
    return map;
}

// Map<id, matrix> of each bone's POSED world transform, folded parent→child (forward kinematics).
//   base:  root   → R ∘ Rot(pose.angle)                         (rotate about own pivot)
//          child  → P_parent ∘ inv(R_parent) ∘ R ∘ Rot(pose.angle)  (follow parent)
//   P = T(pose.x,pose.y) ∘ base   — a world-space translation of the bone; because it sits on the
//   OUTSIDE (left), it is inherited by the whole subtree through the fold (children read P_parent).
// At rest (all poses identity) P == R, so skinMatrix is the identity everywhere (R22).
export function poseWorld(bones) {
    let rest = restWorld(bones);
    let pose = new Map();
    let byId = new Map(bones.map(b => [b.id, b]));

    orderedBones(bones).forEach(b => {
        let R = rest.get(b.id);
        // R ∘ Rot(pose.angle) ∘ Scale(pose.scale,1): stretch is an axial scale in the bone's own
        // frame (along its length), so the tip extends while the perpendicular thickness is kept.
        let scale = (b.pose && b.pose.scale) || 1;
        let local = matMul(R, matRotate((b.pose && b.pose.angle) || 0));
        if (scale !== 1) local = matMul(local, matScale(scale, 1));
        let parent = byId.has(b.parentId) ? b.parentId : undefined;
        let base;
        if (parent === undefined) {
            base = local;
        } else {
            let Pparent = pose.get(parent);
            let Rparent = rest.get(parent);
            base = matMul(matMul(Pparent, matInverse(Rparent)), local);
        }
        let px = (b.pose && b.pose.x) || 0;
        let py = (b.pose && b.pose.y) || 0;
        pose.set(b.id, (px || py) ? matMul(matTranslate(px, py), base) : base);
    });
    return pose;
}

// The skinning matrix for bone `id`: carries a rest-space (world) point to its posed position.
//   S = poseW[id] ∘ inv(restW[id])
export function skinMatrix(id, restW, poseW) {
    return matMul(poseW.get(id), matInverse(restW.get(id)));
}

// ── influence ────────────────────────────────────────────────────────────────────

// Distance from point (px,py) to the bone's rest segment (pivot→tip). The input to falloff().
export function segmentDistance(px, py, bone) {
    let ax = bone.rest.x;
    let ay = bone.rest.y;
    let tip = tipOf(bone);
    let bx = tip.x;
    let by = tip.y;
    let dx = bx - ax;
    let dy = by - ay;
    let len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    let cx = ax + t * dx;
    let cy = ay + t * dy;
    let ex = px - cx;
    let ey = py - cy;
    return Math.sqrt(ex * ex + ey * ey);
}

// Smooth, monotone influence falloff: 1 at the bone, 0 at (and beyond) the action radius,
// C¹ at the rim. Cheap per-vertex.
export function falloff(d, R) {
    if (!(R > 0) || d >= R) return 0;
    let k = 1 - d / R;
    return k * k;
}
