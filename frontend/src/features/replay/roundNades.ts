import type { GrenadeThrow, GrenadeType, Side } from "../../shared/api/types";
import { gameClock } from "../../shared/roundTime";
import { LAND_R, THROW_R } from "../grenades/cluster";

/** Grenades du round affichées par défaut dans le replay : tout sauf les leurres. */
export const DEFAULT_TYPES: GrenadeType[] = ["smoke", "flash", "he", "molotov", "incendiary"];

export interface RoundNade {
  t: GrenadeThrow;
  /** horloge du jeu au lancer (« 1:44 ») */
  clock: string;
  /** lancers du même lineup dans la bibliothèque (lui compris) ; null tant qu'elle n'est pas chargée */
  seen: number | null;
}

const near = (a: readonly number[], b: readonly number[], r: number) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= r;

/** Même lineup qu'en bibliothèque de grenades : même type et camp, départ et arrivée proches (cf. cluster.ts). */
function sameLineup(a: GrenadeThrow, b: GrenadeThrow): boolean {
  return a.type === b.type && a.side === b.side && !!a.land && !!b.land && near(a.throw, b.throw, THROW_R) && near(a.land, b.land, LAND_R);
}

/** Grenades lancées pendant un round, dans l'ordre, filtrées par type et camp, avec leur fréquence dans la bibliothèque. */
export function roundGrenades(throws: GrenadeThrow[], round: number, filter: { types: GrenadeType[]; side: Side | null },
  library?: GrenadeThrow[]): RoundNade[] {
  return throws
    .filter((t) => t.round_number === round && filter.types.includes(t.type) && (!filter.side || t.side === filter.side))
    .sort((a, b) => a.throw_tick - b.throw_tick)
    .map((t) => ({
      t, clock: gameClock(t.time_s),
      seen: library ? (t.land ? library.filter((o) => sameLineup(t, o)).length : 1) : null,
    }));
}
