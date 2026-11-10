/**
 * Fichier `ragdoll` (type « joueurs », scripts/map3d/lib/ragdoll.mjs : extras « sl_ragdoll » de la scène) → définition du
 * solveur (ragdollSolver.ts). Calcul du banc d'essai (SPX/proto/run.ts, sonde 0.6) : par corps, centre de masse et inertie
 * de sa première forme (capsule comme un cylindre, sphère pleine), multipliée par `inertiaScale` puis inversée ; capsule
 * découpée en sphères (tous les 1,5 rayons au plus) pour les contacts. Repères : ceux des os (pouces = unités du jeu).
 */
import type { Vec3 } from "../../shared/api/types";
import type { RagdollDef } from "./ragdollSolver";

export interface RagdollPart {
  mass: number; linDamp: number; angDamp: number; inertiaScale: number;
  spheres: { c: Vec3; r: number }[]; capsules: { a: Vec3; b: Vec3; r: number }[];
}
export interface RagdollFileJoint { type: 3 | 4; a: number; b: number; fa: number[]; fb: number[]; swing: number | null; twist: [number, number] | null }
export interface RagdollFile { v: number; bones: string[]; bindPose: number[][]; parts: RagdollPart[]; joints: RagdollFileJoint[] }

const num = (x: unknown) => typeof x === "number" && Number.isFinite(x);
const vec = (x: unknown, n = 3) => Array.isArray(x) && x.length === n && x.every(num);

/** Fichier lu (extras de la scène) contrôlé ; erreur « fichier ragdoll illisible : … » sinon. */
export function readRagdollFile(x: unknown): RagdollFile {
  const f = x as RagdollFile | null, bad = (why: string) => new Error(`fichier ragdoll illisible : ${why}`);
  if (!f || f.v !== 1) throw bad("version");
  const n = Array.isArray(f.bones) ? f.bones.length : 0;
  if (!n || !f.bones.every((b) => typeof b === "string")) throw bad("corps");
  if (!Array.isArray(f.parts) || f.parts.length !== n || !Array.isArray(f.bindPose) || f.bindPose.length !== n) throw bad("formes");
  const obj = (o: unknown) => typeof o === "object" && o !== null;
  const pos = (x: unknown) => num(x) && (x as number) > 0;
  for (const p of f.parts) {
    if (!obj(p) || !Array.isArray(p.spheres ?? []) || !Array.isArray(p.capsules ?? [])) throw bad("forme");
    const spheres = p.spheres ?? [], capsules = p.capsules ?? [];
    if (!pos(p.mass) || !num(p.linDamp) || !num(p.angDamp) || !pos(p.inertiaScale) || !(spheres.length + capsules.length)) throw bad("masse ou forme");
    if (!spheres.every((s) => obj(s) && vec(s.c) && pos(s.r)) || !capsules.every((c) => obj(c) && vec(c.a) && vec(c.b) && pos(c.r))) throw bad("forme");
    p.spheres = spheres;
    p.capsules = capsules;
  }
  if (!Array.isArray(f.joints)) throw bad("articulations");
  for (const j of f.joints) {
    if (!obj(j) || !(j.a >= 0 && j.a < n && j.b >= 0 && j.b < n) || (j.type !== 3 && j.type !== 4) || !vec(j.fa, 8) || !vec(j.fb, 8)) throw bad("articulation");
    if (j.swing !== null && !num(j.swing)) throw bad("limite");
    if (j.twist !== null && !vec(j.twist, 2)) throw bad("limite");
  }
  return f;
}

function inv3(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m, A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

export function ragdollDef(r: RagdollFile): RagdollDef {
  const def: RagdollDef = { bones: [...r.bones], mass: [], com: [], inertia: [], linDamp: [], angDamp: [], spheres: [], joints: [] };
  r.parts.forEach((p, i) => {
    const m = p.mass;
    // Limite connue : seule la première forme du corps (capsule, sinon sphère) sert à l'inertie ET à la collision ; les
    // suivantes sont ignorées (à juger à l'essai réel si le fichier en émet plusieurs par partie).
    let com: [number, number, number], I: number[];
    if (p.capsules.length) {
      const { a, b, r: rad } = p.capsules[0];
      com = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L = Math.hypot(d[0], d[1], d[2]), u = d.map((x) => x / (L || 1));
      const ia = (m * rad * rad) / 2, ip = m * ((L * L) / 12 + (rad * rad) / 4);
      I = [0, 1, 2].flatMap((rr) => [0, 1, 2].map((cc) => ip * (rr === cc ? 1 : 0) + (ia - ip) * u[rr] * u[cc]));
      const n = Math.max(2, Math.ceil(L / (1.5 * rad)) + 1);
      for (let k = 0; k < n; k++) {
        const t = k / (n - 1);
        def.spheres.push({ body: i, c: [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t], r: rad });
      }
    } else {
      const { c, r: rad } = p.spheres[0];
      com = [c[0], c[1], c[2]];
      const is = 0.4 * m * rad * rad;
      I = [is, 0, 0, 0, is, 0, 0, 0, is];
      def.spheres.push({ body: i, c: [c[0], c[1], c[2]], r: rad });
    }
    def.mass.push(m);
    def.com.push(com);
    def.inertia.push(inv3(I.map((x) => x * p.inertiaScale)));
    def.linDamp.push(p.linDamp);
    def.angDamp.push(p.angDamp);
  });
  def.joints = r.joints.map((j) => ({ a: j.a, b: j.b, type: j.type, swing: j.swing, twist: j.twist,
    fa: { p: [j.fa[0], j.fa[1], j.fa[2]], q: [j.fa[4], j.fa[5], j.fa[6], j.fa[7]] },
    fb: { p: [j.fb[0], j.fb[1], j.fb[2]], q: [j.fb[4], j.fb[5], j.fb[6], j.fb[7]] } }));
  return def;
}
