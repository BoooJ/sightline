import type { CalloutPlace, Vec3 } from "@/api/types";

import { placeLabel } from "./labels";

/** « setpos x y z;setang pitch yaw 0 » → position et angles de visée. */
export function parseSetpos(s: string | null | undefined): { pos: Vec3; pitch: number; yaw: number } | null {
  const m = /setpos\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+);\s*setang\s+(-?[\d.]+)\s+(-?[\d.]+)/.exec(s ?? "");
  if (!m) return null;
  const n = m.slice(1).map(Number);
  return { pos: [n[0], n[1], n[2]], pitch: n[3], yaw: n[4] };
}

const MAX_DIST = 900; // unités de jeu : au-delà, le lieu le plus proche ne décrit plus le point

/** Nom (celui de l'équipe s'il existe) du lieu connu le plus proche d'un point, pour décrire un lineup. */
export function nearestPlace(places: CalloutPlace[], p: Vec3): string | null {
  let best: CalloutPlace | null = null;
  let bestD = MAX_DIST * MAX_DIST;
  for (const c of places) {
    if (!c.pos) continue;
    const d = (c.pos[0] - p[0]) ** 2 + (c.pos[1] - p[1]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best ? best.label ?? placeLabel(best.place) : null;
}
