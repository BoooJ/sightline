import { describe, expect, it } from "vitest";
import { MAX_DROP, RagdollEngine, type RagdollOut, trackProblem } from "./ragdollEngine";
import { FILE } from "./testRagdoll";
import type { RagdollStart } from "./ragdollSolver";

/** Sol plat à z = 0 de 4000 u de côté (carreaux de 500 u). */
function floor(h = 0): Float32Array {
  const out: number[] = [];
  for (let x = -2000; x < 2000; x += 500) for (let y = -2000; y < 2000; y += 500) {
    out.push(x, y, h, x + 500, y, h, x + 500, y + 500, h, x, y, h, x + 500, y + 500, h, x, y + 500, h);
  }
  return new Float32Array(out);
}
/** Les deux corps de FILE à 40 u au-dessus du sol, articulation en place (os de la tête au bout de la capsule, tourné
 *  pour que les repères de l'articulation coïncident : q = conj(fb.q)). */
const START = (): RagdollStart => ({ p: Float64Array.from([0, 0, 40, 10, 0, 40]), q: Float64Array.from([0, 0, 0, 1, 0, 0, -0.7071068, 0.7071068]),
  v: Float64Array.from([120, 0, 0, 120, 0, 0]), w: new Float64Array(6) });
const death = (e: RagdollEngine, id: number, key = "de_dust2", start = START()) => e.handle({ type: "death", id, key, start }) as RagdollOut;

describe("moteur du ragdoll", () => {
  it("une mort : trajectoire qui s'arrête au sol ; même mort, mêmes nombres", () => {
    const e = new RagdollEngine();
    expect(e.handle({ type: "def", file: structuredClone(FILE) })).toBeNull();
    expect(e.handle({ type: "map", key: "de_dust2", tri: floor() })).toBeNull();
    const a = death(e, 1), b = death(e, 2);
    expect(a.type).toBe("track");
    expect([a.id, a.why]).toEqual([1, null]);
    expect(a.track!.bodies).toBe(2);
    expect(a.track!.frames).toBeLessThan(180);
    expect(a.ms).toBeGreaterThanOrEqual(0);
    expect(Array.from(b.track!.p)).toEqual(Array.from(a.track!.p));
    const last = a.track!.frames - 1;
    expect(a.track!.p[last * 6 + 2]).toBeLessThan(10);  // couché : bassin près du sol (capsule de rayon 2)
  });
  it("sans ragdoll, sans collision, ou collision d'une autre carte : pas de trajectoire, et pourquoi", () => {
    const e = new RagdollEngine();
    expect(death(e, 1)).toMatchObject({ id: 1, track: null, why: "ragdoll absent" });
    e.handle({ type: "def", file: structuredClone(FILE) });
    expect(death(e, 2)).toMatchObject({ track: null, why: "collision absente" });
    e.handle({ type: "map", key: "de_nuke", tri: floor() });
    expect(death(e, 3, "de_dust2")).toMatchObject({ track: null, why: "collision absente" });
  });
  it("collision retirée (unmap) : grille et clé oubliées, sans réponse ; morts suivantes : collision absente, jusqu'à la prochaine", () => {
    const e = new RagdollEngine();
    e.handle({ type: "def", file: structuredClone(FILE) });
    e.handle({ type: "map", key: "de_dust2", tri: floor() });
    expect(e.handle({ type: "unmap" })).toBeNull();
    expect(death(e, 1)).toMatchObject({ id: 1, track: null, why: "collision absente" });
    expect((e as unknown as { grid: unknown }).grid).toBeNull();  // libérée (plus aucune référence)
    expect(e.handle({ type: "unmap" })).toBeNull();  // déjà libérée : rien
    e.handle({ type: "map", key: "de_dust2", tri: floor() });
    expect(death(e, 2).why).toBeNull();
  });
  it("fichier illisible : refusé, le ragdoll d'avant n'est pas gardé", () => {
    const e = new RagdollEngine();
    e.handle({ type: "def", file: structuredClone(FILE) });
    e.handle({ type: "def", file: { ...structuredClone(FILE), v: 9 } });
    e.handle({ type: "map", key: "de_dust2", tri: floor() });
    expect(death(e, 1)).toMatchObject({ track: null, why: expect.stringMatching(/^ragdoll absent/) });
  });
  it("contrôle : départ illisible (NaN) ou sol absent sous le corps (chute de plus de MAX_DROP) : refusé", () => {
    const e = new RagdollEngine();
    e.handle({ type: "def", file: structuredClone(FILE) });
    e.handle({ type: "map", key: "de_dust2", tri: floor(-5000) });
    expect(death(e, 1).why).toMatch(/chute/);
    const bad = START();
    bad.v[0] = NaN;
    e.handle({ type: "map", key: "de_dust2", tri: floor() });
    expect(death(e, 2, "de_dust2", bad).why).toMatch(/nombres/);
    expect(MAX_DROP).toBe(300);
    expect(trackProblem({ dt: 1 / 60, frames: 1, bodies: 1, p: new Float32Array([0, 0, 0]), q: new Float32Array([0, 0, 0, 1]) })).toBeNull();
  });
  it("construction de la grille qui échoue : réponse avec raison, l'état d'avant reste intact (ancienne clé, ancienne grille)", () => {
    const e = new RagdollEngine();
    e.handle({ type: "def", file: structuredClone(FILE) });
    e.handle({ type: "map", key: "de_dust2", tri: floor() });
    const huge = new Float32Array([0, 0, 0, 1e9, 0, 0, 0, 1e9, 0]);
    const r = e.handle({ type: "map", key: "de_nuke", tri: huge });
    expect(r).toMatchObject({ type: "track", track: null });
    expect(r!.why).toMatch(/collision/);
    expect(death(e, 1, "de_dust2").why).toBeNull();  // l'ancienne carte sert toujours, sous son ancienne clé
    expect(death(e, 2, "de_nuke")).toMatchObject({ track: null, why: "collision absente" });
  });
  it("simulation qui lève : réponse pour le même id avec une raison ; le message suivant marche", () => {
    const e = new RagdollEngine();
    e.handle({ type: "def", file: structuredClone(FILE) });
    e.handle({ type: "map", key: "de_dust2", tri: floor() });
    const bad = START();
    bad.p = new Float64Array(2);  // trop court : lève dans le solveur ? (sinon NaN refusés au contrôle)
    (bad as { q: unknown }).q = null;  // lève (TypeError) dans simulate
    const r = death(e, 7, "de_dust2", bad);
    expect(r).toMatchObject({ id: 7, track: null });
    expect(r.why).toMatch(/erreur/);
    expect(death(e, 8).why).toBeNull();
  });
  it("fichier ragdoll illisible : la raison est gardée dans la réponse suivante", () => {
    const e = new RagdollEngine();
    e.handle({ type: "def", file: { ...structuredClone(FILE), v: 9 } });
    e.handle({ type: "map", key: "de_dust2", tri: floor() });
    expect(death(e, 1).why).toMatch(/ragdoll absent.*version/);
  });
  it("quaternion de départ nul : refusé ; non normalisé : même trajectoire que normalisé", () => {
    const e = new RagdollEngine();
    e.handle({ type: "def", file: structuredClone(FILE) });
    e.handle({ type: "map", key: "de_dust2", tri: floor() });
    const zero = START();
    zero.q.set([0, 0, 0, 0]);
    expect(death(e, 1, "de_dust2", zero)).toMatchObject({ track: null, why: expect.stringMatching(/quaternion/) });
    const big = START();
    for (let k = 0; k < big.q.length; k++) big.q[k] *= 4;
    const a = death(e, 2), b = death(e, 3, "de_dust2", big);
    expect(b.why).toBeNull();
    expect(Array.from(b.track!.p).every(Number.isFinite)).toBe(true);
    expect(Array.from(b.track!.p)).toEqual(Array.from(a.track!.p));
  });
});
