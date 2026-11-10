import type { RagdollFile } from "./ragdollDef";

/** Ragdoll synthétique des tests (aucune valeur du jeu) : une capsule le long de X (10 u, rayon 2, masse 4) et une sphère
 *  (rayon 3, masse 2), une rotule à l'extrémité de la capsule. */
export const FILE: RagdollFile = {
  v: 1, bones: ["pelvis", "head_0"], bindPose: [[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 40], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 60]],
  parts: [{ mass: 4, linDamp: 0, angDamp: 2, inertiaScale: 1, spheres: [], capsules: [{ a: [0, 0, 0], b: [10, 0, 0], r: 2 }] },
    { mass: 2, linDamp: 0.5, angDamp: 1, inertiaScale: 1, spheres: [{ c: [1, 0, 0], r: 3 }], capsules: [] }],
  joints: [{ type: 4, a: 0, b: 1, fa: [10, 0, 0, 1, 0, 0, 0, 1], fb: [0, 0, 0, 1, 0, 0, 0.7071068, 0.7071068], swing: 0.4, twist: [-0.2, 0.3] }],
};
