import type { MapMeta } from "../../../shared/api/types";
export const RADAR_SIZE = 1024;
export function worldToRadar(m: MapMeta, x: number, y: number): [number, number] {
  return [(x - m.pos_x) / m.scale, (m.pos_y - y) / m.scale];
}
export function levelForZ(m: MapMeta, z: number): string {
  for (const l of m.levels) if (z >= l.z_min && z < l.z_max) return l.name;
  return m.levels[0]?.name ?? "default";
}
/** Niveau à afficher : le niveau mémorisé s'il existe sur cette carte, sinon le premier. Un niveau d'une autre
 *  carte (« upper » de Nuke sur Mirage) ferait passer tous les joueurs pour hors niveau, donc atténués. */
export function validLevel(m: MapMeta, level: string | null | undefined): string {
  return level && m.levels.some((l) => l.name === level) ? level : m.levels[0]?.name ?? "default";
}
