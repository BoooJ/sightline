/**
 * Moteur du ragdoll : ragdoll (fichier « ragdoll »), collision de la carte affichée et simulation d'une mort, par messages
 * (ragdollWorker.ts le fait tourner dans un worker ; les tests l'appellent directement). Pur hors de la mesure du temps
 * (`ms`, jamais dans la trajectoire) : même mort, même trajectoire. Une trajectoire est contrôlée avant d'être rendue
 * (`trackProblem`) : refusée, le mort garde son clip de mort.
 */
import { buildGrid, type CollisionGrid, localWorld } from "./collision";
import { ragdollDef, type RagdollFile, readRagdollFile } from "./ragdollDef";
import { type RagdollDef, type RagdollStart, type RagdollTrack, simulate } from "./ragdollSolver";

export type RagdollIn =
  | { type: "def"; file: RagdollFile }
  | { type: "map"; key: string; tri: Float32Array }
  /** Collision retirée (carte sans collision, autre carte) : grille et clé oubliées (mémoire libérée). */
  | { type: "unmap" }
  | { type: "death"; id: number; key: string; start: RagdollStart };
export interface RagdollOut { type: "track"; id: number; track: RagdollTrack | null; ms: number; why: string | null }

/** Chute (u) au-delà de laquelle une trajectoire est refusée : le corps est passé sous la carte (collision absente ou
 *  trouée à cet endroit). Le banc d'essai a vu des chutes réelles de 40 à 137 u depuis un rebord (sonde 0.6). */
export const MAX_DROP = 300;

/** Pourquoi refuser une trajectoire (null : bonne) : un nombre non fini, ou une chute de plus de MAX_DROP (hauteur moyenne
 *  des corps, première image contre dernière). */
export function trackProblem(t: RagdollTrack): string | null {
  for (let k = 0; k < t.p.length; k++) if (!Number.isFinite(t.p[k])) return "nombres non finis";
  for (let k = 0; k < t.q.length; k++) if (!Number.isFinite(t.q[k])) return "nombres non finis";
  let z0 = 0, z1 = 0;
  const last = t.frames - 1;
  for (let i = 0; i < t.bodies; i++) { z0 += t.p[i * 3 + 2]; z1 += t.p[(last * t.bodies + i) * 3 + 2]; }
  return (z0 - z1) / t.bodies > MAX_DROP ? `chute de plus de ${MAX_DROP} u (sol absent)` : null;
}

export class RagdollEngine {
  private def: RagdollDef | null = null;
  private defWhy = "";
  private key = "";
  private grid: CollisionGrid | null = null;

  /** Toujours une réponse pour une mort ; pour `map`, une réponse (sans trajectoire) seulement si la grille ne se construit
   *  pas, et l'état d'avant reste alors intact (clé et grille) ; `def` et `unmap` : jamais de réponse. Une exception ne
   *  sort jamais d'ici. */
  handle(m: RagdollIn): RagdollOut | null {
    const t0 = performance.now();
    const no = (id: number, why: string): RagdollOut => ({ type: "track", id, track: null, ms: performance.now() - t0, why });
    const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
    if (m.type === "def") {
      try {
        this.def = ragdollDef(readRagdollFile(m.file));
        this.defWhy = "";
      } catch (e) {
        this.def = null;  // fichier inattendu : pas de ragdoll, les morts gardent leurs clips
        this.defWhy = msg(e);
      }
      return null;
    }
    if (m.type === "map") {
      try {
        const grid = buildGrid(m.tri);  // clé et grille ne changent qu'ensemble, une fois la construction réussie
        this.grid = grid;
        this.key = m.key;
      } catch (e) {
        return no(-1, `collision illisible (${m.key}) : ${msg(e)}`);
      }
      return null;
    }
    if (m.type === "unmap") {
      this.grid = null;
      this.key = "";
      return null;
    }
    if (!this.def) return no(m.id, this.defWhy ? `ragdoll absent (${this.defWhy})` : "ragdoll absent");
    if (!this.grid || m.key !== this.key) return no(m.id, "collision absente");
    try {
      const s = m.start;
      for (const a of [s.p, s.q, s.v, s.w]) for (let k = 0; k < a.length; k++) if (!Number.isFinite(a[k])) return no(m.id, "nombres non finis au départ");
      const n = this.def.mass.length;
      for (let i = 0; i < n; i++) if (!(Math.hypot(s.q[4 * i], s.q[4 * i + 1], s.q[4 * i + 2], s.q[4 * i + 3]) > 1e-9)) return no(m.id, "quaternion de départ nul");
      let cx = 0, cy = 0, cz = 0;
      for (let i = 0; i < n; i++) { cx += s.p[3 * i] / n; cy += s.p[3 * i + 1] / n; cz += s.p[3 * i + 2] / n; }
      const track = simulate(this.def, s, localWorld(this.grid, cx, cy, cz));
      const why = trackProblem(track);
      return why ? no(m.id, why) : { type: "track", id: m.id, track, ms: performance.now() - t0, why: null };
    } catch (e) {
      return no(m.id, `erreur : ${msg(e)}`);
    }
  }
}
