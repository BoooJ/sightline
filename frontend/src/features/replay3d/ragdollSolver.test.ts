import { describe, expect, it } from "vitest";
import { closest, DT, GRAVITY, MAX_S, MAX_V, type RagdollDef, type RagdollStart, simulate, SUBSTEPS, TWIST_AXIS,
  type World } from "./ragdollSolver";

/** Corps synthétiques (aucune valeur du jeu) : sphères de rayon r, masse m, centre de masse à l'origine de l'os. */
function spheres(n: number, r = 5, m = 10): RagdollDef {
  const inv = 1 / (0.4 * m * r * r);
  return { bones: Array.from({ length: n }, (_, i) => `b${i}`), mass: Array(n).fill(m), com: Array.from({ length: n }, () => [0, 0, 0]),
    inertia: Array.from({ length: n }, () => [inv, 0, 0, 0, inv, 0, 0, 0, inv]), linDamp: Array(n).fill(0), angDamp: Array(n).fill(1),
    spheres: Array.from({ length: n }, (_, i) => ({ body: i, c: [0, 0, 0] as [number, number, number], r })), joints: [] };
}
/** Sol plat à z = 0 (deux triangles de 2000 u de côté, normale +Z) ; `none` : aucun triangle. */
const FLOOR: World = { tri: new Float32Array([-1000, -1000, 0, 1000, -1000, 0, 1000, 1000, 0, -1000, -1000, 0, 1000, 1000, 0, -1000, 1000, 0]),
  near: (_x, _y, _z, _r, out) => { out[0] = 0; out[1] = 1; return 2; } };
const NONE: World = { tri: new Float32Array(0), near: () => 0 };
function start(ps: number[][], vs: number[][] = [], qs: number[][] = []): RagdollStart {
  const n = ps.length;
  return { p: Float64Array.from(ps.flat()), v: Float64Array.from(Array.from({ length: n }, (_, i) => vs[i] ?? [0, 0, 0]).flat()),
    q: Float64Array.from(Array.from({ length: n }, (_, i) => qs[i] ?? [0, 0, 0, 1]).flat()), w: new Float64Array(3 * n) };
}
const z = (t: { p: Float32Array; bodies: number }, f: number, i = 0) => t.p[(f * t.bodies + i) * 3 + 2];

describe("solveur du ragdoll", () => {
  it("réglages du banc d'essai (sonde 0.6)", () => {
    expect([GRAVITY, DT, SUBSTEPS, MAX_S, MAX_V, TWIST_AXIS]).toEqual([800, 1 / 60, 4, 3, 1500, 2]);
  });
  it("chute libre puis repos sur le sol : posé à son rayon, arrêté avant 3 s ; première image = départ", () => {
    const t = simulate(spheres(1), start([[0, 0, 50]]), FLOOR);
    expect(t.dt).toBe(DT);
    expect(z(t, 0)).toBe(50);
    expect(Math.abs(z(t, 15) - (50 - 0.5 * GRAVITY * 0.25 ** 2))).toBeLessThan(1);  // 0,25 s de chute libre
    expect(t.frames).toBeLessThan(MAX_S / DT);
    expect(Math.abs(z(t, t.frames - 1) - 5)).toBeLessThan(0.5);
    expect(t.p.length).toBe(3 * t.frames);
    expect(t.q.length).toBe(4 * t.frames);
  });
  it("déterministe : même entrée, mêmes nombres au bit près", () => {
    const def = spheres(2), s = start([[0, 0, 40], [12, 0, 60]], [[300, 0, 0], [-50, 80, 0]]);
    const a = simulate(def, s, FLOOR), b = simulate(def, s, FLOOR);
    expect(b.frames).toBe(a.frames);
    expect(Array.from(b.p)).toEqual(Array.from(a.p));
    expect(Array.from(b.q)).toEqual(Array.from(a.q));
  });
  it("articulation : les deux ancres restent ensemble quand les corps s'écartent", () => {
    const def = spheres(2);
    def.joints = [{ a: 0, b: 1, type: 4, fa: { p: [5, 0, 0], q: [0, 0, 0, 1] }, fb: { p: [-5, 0, 0], q: [0, 0, 0, 1] }, swing: null, twist: null }];
    const t = simulate(def, start([[0, 0, 0], [10, 0, 0]], [[-100, 0, 0], [100, 0, 0]]), NONE);
    let worst = 0;
    // corps sans rotation (impulsions dans l'axe des ancres) : ancres à +5 et −5 u en x de leur os
    for (let f = 0; f < t.frames; f++) worst = Math.max(worst, Math.abs(t.p[f * 6] + 5 - (t.p[f * 6 + 3] - 5)));
    expect(worst).toBeLessThan(1);
  });
  it("cône de la rotule : l'écart des axes de torsion revient sous la limite", () => {
    const def = spheres(2);
    def.joints = [{ a: 0, b: 1, type: 4, fa: { p: [0, 0, 6], q: [0, 0, 0, 1] }, fb: { p: [0, 0, -6], q: [0, 0, 0, 1] }, swing: 0.3, twist: null }];
    const h = 0.5, rot = [Math.sin(h), 0, 0, Math.cos(h)];  // 1 rad autour de X
    const t = simulate(def, start([[0, 0, 0], [0, -6 * Math.sin(1), 6 + 6 * Math.cos(1)]], [], [[0, 0, 0, 1], rot]), NONE);
    const f = t.frames - 1, qa = Array.from(t.q.slice(f * 8, f * 8 + 4)), qb = Array.from(t.q.slice(f * 8 + 4, f * 8 + 8));
    const zAxis = ([x, y, zz, w]: number[]) => [2 * (x * zz + w * y), 2 * (y * zz - w * x), 1 - 2 * (x * x + y * y)];
    const [za, zb] = [zAxis(qa), zAxis(qb)], dot = za[0] * zb[0] + za[1] * zb[1] + za[2] * zb[2];
    expect(Math.acos(Math.min(1, dot))).toBeLessThan(0.35);
  });
  it("vitesse bornée : une impulsion démesurée ne donne ni NaN ni, après le premier sous-pas, de saut de plus de MAX_V par seconde", () => {
    // la vitesse de départ n'est bornée qu'après le premier sous-pas : Ragdolls (tâche 4.3) borne celle qu'il donne
    const t = simulate(spheres(1), start([[0, 0, 100]], [[1e6, 0, 0]]), FLOOR);
    expect(Array.from(t.p).every(Number.isFinite)).toBe(true);
    for (let f = 2; f < t.frames; f++) expect(Math.abs(t.p[f * 3] - t.p[(f - 1) * 3])).toBeLessThan(MAX_V * DT + 1);
  });
  it("frottement : un corps qui glisse au sol s'arrête", () => {
    const t = simulate(spheres(1), start([[0, 0, 5]], [[300, 0, 0]]), FLOOR);
    expect(t.frames).toBeLessThan(MAX_S / DT);
    expect(t.p[(t.frames - 1) * 3]).toBeLessThan(200);
  });
  it("point le plus proche d'un triangle : dedans, au-delà d'un sommet, au-delà d'une arête", () => {
    const tri = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]), o = new Float64Array(3);
    closest(tri, 0, 2, 2, 5, o);
    [2, 2, 0].forEach((v, k) => expect(o[k]).toBeCloseTo(v, 9));
    closest(tri, 0, -5, -5, 0, o);
    expect(Array.from(o)).toEqual([0, 0, 0]);
    closest(tri, 0, 5, -3, 0, o);
    expect(Array.from(o)).toEqual([5, 0, 0]);
  });
  it("chute libre sans aucun triangle : s'arrête à MAX_S, nombres finis, pas de boucle sans fin", () => {
    const t = simulate(spheres(2), start([[0, 0, 0], [30, 0, 0]], [[10, 0, 0], [0, 0, 0]]), NONE);
    expect(t.frames).toBe(Math.round(MAX_S / DT));
    expect(Array.from(t.p).every(Number.isFinite)).toBe(true);
    expect(Array.from(t.q).every(Number.isFinite)).toBe(true);
    expect(z(t, t.frames - 1)).toBeLessThan(-3000);  // ½ g t² = 3600 u après 3 s
  });
  it("mise en sommeil : un corps posé sans vitesse s'arrête vite, et ne bouge plus", () => {
    const t = simulate(spheres(1), start([[0, 0, 5]]), FLOOR);
    expect(t.frames).toBeLessThanOrEqual(40);
    expect(Math.abs(z(t, t.frames - 1) - 5)).toBeLessThan(0.5);
  });
  it("triangle dégénéré (sommets alignés, ou réduit à un point) : aucun NaN", () => {
    for (const tri of [[-50, 0, 0, 0, 0, 0, 50, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0, 0]]) {
      const w: World = { tri: new Float32Array(tri), near: (_x, _y, _z, _r, out) => { out[0] = 0; return 1; } };
      const t = simulate(spheres(1), start([[0, 0, 12]], [[0, 0, -200]]), w);
      expect(Array.from(t.p).every(Number.isFinite)).toBe(true);
      expect(Array.from(t.q).every(Number.isFinite)).toBe(true);
    }
  });
  it("charnière (type 3) : les axes de torsion sont tenus alignés", () => {
    const def = spheres(2);
    def.joints = [{ a: 0, b: 1, type: 3, fa: { p: [0, 0, 6], q: [0, 0, 0, 1] }, fb: { p: [0, 0, -6], q: [0, 0, 0, 1] }, swing: 1.5, twist: null }];
    const h = 0.25, rot = [Math.sin(h), 0, 0, Math.cos(h)];  // 0,5 rad autour de X ; la limite 1,5 de la rotule serait ignorée
    const t = simulate(def, start([[0, 0, 0], [0, -6 * Math.sin(0.5), 6 + 6 * Math.cos(0.5)]], [], [[0, 0, 0, 1], rot]), NONE);
    const f = t.frames - 1, qa = Array.from(t.q.slice(f * 8, f * 8 + 4)), qb = Array.from(t.q.slice(f * 8 + 4, f * 8 + 8));
    const zAxis = ([x, y, zz, w]: number[]) => [2 * (x * zz + w * y), 2 * (y * zz - w * x), 1 - 2 * (x * x + y * y)];
    const [za, zb] = [zAxis(qa), zAxis(qb)], dot = za[0] * zb[0] + za[1] * zb[1] + za[2] * zb[2];
    expect(Math.acos(Math.min(1, dot))).toBeLessThan(0.05);
  });
  it("torsion : l'écart autour de l'axe Z revient dans [-0,2 ; 0,3]", () => {
    const def = spheres(2);
    def.joints = [{ a: 0, b: 1, type: 4, fa: { p: [0, 0, 6], q: [0, 0, 0, 1] }, fb: { p: [0, 0, -6], q: [0, 0, 0, 1] }, swing: 0.3, twist: [-0.2, 0.3] }];
    const h = 0.5, rot = [0, 0, Math.sin(h), Math.cos(h)];  // 1 rad autour de Z
    const t = simulate(def, start([[0, 0, 0], [0, 0, 12]], [], [[0, 0, 0, 1], rot]), NONE);
    const f = t.frames - 1, a = Array.from(t.q.slice(f * 8, f * 8 + 4)), b = Array.from(t.q.slice(f * 8 + 4, f * 8 + 8));
    // rotation relative conj(a) · b : angle autour de Z
    const rz = a[3] * b[2] - a[2] * b[3] + (a[0] * b[1] - a[1] * b[0]) * 0, rw = a[3] * b[3] + a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const twist = 2 * Math.atan2(rz, rw);
    expect(twist).toBeGreaterThan(-0.2 - 0.05);
    expect(twist).toBeLessThan(0.3 + 0.05);
    expect(twist).toBeLessThan(0.6);  // et on est bien parti de 1 rad
  });
});
