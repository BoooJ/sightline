import type { MapMeta } from "@/api/types";

// Repris de frontend/src/features/replay/engine/coords.ts : les radars font 1024 px de côté.
export const RADAR_SIZE = 1024;

export function worldToRadar(m: MapMeta, x: number, y: number): [number, number] {
  return [(x - m.pos_x) / m.scale, (m.pos_y - y) / m.scale];
}

/** Position en fraction du radar (0 à 1) : indépendante de la taille d'affichage. */
export function toRadarFraction(m: MapMeta, x: number, y: number): [number, number] {
  const [px, py] = worldToRadar(m, x, y);
  return [px / RADAR_SIZE, py / RADAR_SIZE];
}

export function levelForZ(m: MapMeta, z: number): string {
  for (const l of m.levels) if (z >= l.z_min && z < l.z_max) return l.name;
  return m.levels[0]?.name ?? "default";
}

export function levelImage(m: MapMeta, level: string): string {
  return m.levels.find((l) => l.name === level)?.image ?? m.image;
}
