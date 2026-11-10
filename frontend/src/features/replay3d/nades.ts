import type { GrenadeEvent, Vec3 } from "../../shared/api/types";
import { SMOKE_RADIUS, type GrenadeView } from "../replay/engine/state";

export const FIRE_R = 120, FLASH_R = 250, HE_R = 350;  // mêmes rayons que le radar 2D (renderer/draw.ts)
export type NadeLook = { kind: "flight" | "smoke" | "fire" | "burst" | "decoy"; radius: number; opacity: number };

/** Apparence d'une grenade à l'instant ; `progress` va de 0 à 1 pendant l'effet (durées réelles, activeGrenades). */
export function nadeLook(g: GrenadeView): NadeLook {
  if (g.phase === "flying") return { kind: "flight", radius: 4, opacity: 1 };
  const p = Math.min(1, Math.max(0, g.progress));
  switch (g.type) {
    case "smoke": return { kind: "smoke", radius: SMOKE_RADIUS, opacity: 0.85 * Math.min(1, p / 0.05, (1 - p) / 0.1) };
    case "molotov": case "incendiary": return { kind: "fire", radius: FIRE_R, opacity: 0.6 * Math.min(1, (1 - p) / 0.1) };
    case "flash": return { kind: "burst", radius: FLASH_R * Math.min(1, p * 4), opacity: 1 - p };
    case "he": return { kind: "burst", radius: HE_R * Math.min(1, p * 4), opacity: 1 - p };
    default: return { kind: "decoy", radius: 8, opacity: 1 };
  }
}

/** Trajectoire en 3D jusqu'à l'instant (la vue du moteur ne garde que x et y). */
export function trail3d(g: GrenadeEvent, tick: number): Vec3[] {
  const out: Vec3[] = [];
  const tr = g.trajectory;
  for (let k = 0; k < tr.length; k++) {
    const [tk, x, y, z] = tr[k];
    if (tk > tick) {
      const [pt, px, py, pz] = tr[k - 1] ?? tr[k];
      const f = tk === pt ? 0 : (tick - pt) / (tk - pt);
      if (k > 0) out.push([px + (x - px) * f, py + (y - py) * f, pz + (z - pz) * f]);
      return out;
    }
    out.push([x, y, z]);
  }
  return out;
}
