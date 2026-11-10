import type { GrenadeThrow, GrenadeType, Side, Vec3 } from "../../shared/api/types";

/** Mêmes règles que backend/app/stats/grenades.py:cluster (regroupé côté client pour filtrer instantanément). */
export const THROW_R = 48, LAND_R = 160;

export interface Group {
  key: string; type: GrenadeType; side: Side; throw: Vec3; land: Vec3; trajectory: Vec3[]; throws: GrenadeThrow[]; players: string[];
}

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function cluster(throws: GrenadeThrow[]): Group[] {
  const groups: Group[] = [];
  for (const t of throws) {
    if (!t.land) continue;
    const g = groups.find((g) => g.type === t.type && g.side === t.side && dist(g.throw, t.throw) <= THROW_R && dist(g.land, t.land!) <= LAND_R);
    if (g) {
      g.throws.push(t);
      if (!g.players.includes(t.thrower_name)) g.players.push(t.thrower_name);
    } else {
      groups.push({ key: `g${t.id}`, type: t.type, side: t.side, throw: t.throw, land: t.land, trajectory: t.trajectory, throws: [t], players: [t.thrower_name] });
    }
  }
  return groups.sort((a, b) => b.throws.length - a.throws.length);
}
