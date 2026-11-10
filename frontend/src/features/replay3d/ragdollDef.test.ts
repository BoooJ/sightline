import { describe, expect, it } from "vitest";
import { ragdollDef, readRagdollFile } from "./ragdollDef";
import { FILE } from "./testRagdoll";

describe("définition du ragdoll", () => {
  it("corps : masses, amortissements, centre de masse et inertie inverse de la première forme, sphères de collision", () => {
    const d = ragdollDef(FILE);
    expect(d.bones).toEqual(["pelvis", "head_0"]);
    expect(d.mass).toEqual([4, 2]);
    expect([d.linDamp, d.angDamp]).toEqual([[0, 0.5], [2, 1]]);
    expect(d.com).toEqual([[5, 0, 0], [1, 0, 0]]);
    // capsule le long de X : axiale m r² / 2 = 8 ; perpendiculaire m (L² / 12 + r² / 4) = 4 (100 / 12 + 1)
    const perp = 4 * (100 / 12 + 1);
    [1 / 8, 0, 0, 0, 1 / perp, 0, 0, 0, 1 / perp].forEach((v, k) => expect(d.inertia[0][k]).toBeCloseTo(v, 9));
    [1 / 7.2, 0, 0, 0, 1 / 7.2, 0, 0, 0, 1 / 7.2].forEach((v, k) => expect(d.inertia[1][k]).toBeCloseTo(v, 9));
    // capsule de 10 u, rayon 2 : 5 sphères (tous les 2,5 u), puis la sphère du second corps
    expect(d.spheres.map((s) => [s.body, s.c[0], s.r])).toEqual([[0, 0, 2], [0, 2.5, 2], [0, 5, 2], [0, 7.5, 2], [0, 10, 2], [1, 1, 3]]);
    expect(d.joints).toEqual([{ a: 0, b: 1, type: 4, swing: 0.4, twist: [-0.2, 0.3],
      fa: { p: [10, 0, 0], q: [0, 0, 0, 1] }, fb: { p: [0, 0, 0], q: [0, 0, 0.7071068, 0.7071068] } }]);
  });
  it("échelle d'inertie : l'inertie est multipliée avant inversion", () => {
    const d = ragdollDef({ ...FILE, parts: [FILE.parts[0], { ...FILE.parts[1], inertiaScale: 7 }] });
    expect(d.inertia[1][0]).toBeCloseTo(1 / (7.2 * 7), 9);
  });
  it("fichier lu : version, corps, formes et articulations contrôlés ; erreur claire sinon", () => {
    expect(readRagdollFile(structuredClone(FILE))).toEqual(FILE);
    for (const bad of [null, { ...FILE, v: 2 }, { ...FILE, bones: [] }, { ...FILE, parts: [FILE.parts[0]] },
      { ...FILE, parts: [FILE.parts[0], { ...FILE.parts[1], spheres: [] }] }, { ...FILE, parts: [FILE.parts[0], { ...FILE.parts[1], mass: 0 }] },
      { ...FILE, joints: [{ ...FILE.joints[0], b: 5 }] }, { ...FILE, joints: [{ ...FILE.joints[0], fa: [0, 0, 0] }] }]) {
      expect(() => readRagdollFile(bad)).toThrow(/fichier ragdoll illisible/);
    }
  });
  it("valeurs non finies et éléments mal formés : erreur claire, pas de TypeError brut", () => {
    const P = FILE.parts[1];
    for (const bad of [{ ...FILE, parts: [FILE.parts[0], { ...P, mass: Infinity }] }, { ...FILE, parts: [FILE.parts[0], { ...P, mass: NaN }] },
      { ...FILE, parts: [FILE.parts[0], { ...P, inertiaScale: Infinity }] }, { ...FILE, parts: [FILE.parts[0], { ...P, spheres: [{ c: [0, 0, 0], r: Infinity }] }] },
      { ...FILE, parts: [null, null] }, { ...FILE, parts: [FILE.parts[0], { ...P, spheres: [null] }] },
      { ...FILE, parts: [FILE.parts[0], { ...P, spheres: [], capsules: [null] }] }, { ...FILE, joints: [null] }, { ...FILE, bindPose: [null, null], bones: [1, 2] }]) {
      expect(() => readRagdollFile(bad)).toThrow(/fichier ragdoll illisible/);
    }
  });
});
