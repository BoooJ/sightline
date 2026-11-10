import type { MapMeta, Shape, Side, Strat, StratGrenade, StratPosition, StratSummary, Vec3 } from "@/api/types";

import { parseUtc, shortDate } from "./format";
import { levelForZ, RADAR_SIZE, toRadarFraction } from "./radar";

export type SideFilter = "all" | Side;

/** Un élément et son numéro dans la stratégie (celui de la carte et des listes, même filtré par étage). */
export interface Numbered<T> { item: T; n: number }

/** Stratégies d'une carte (`null` : toutes) et d'un côté, dans l'ordre reçu. */
export function filterStrats<T extends StratSummary>(list: T[], map: string | null, side: SideFilter): T[] {
  return list.filter((s) => (map === null || s.map === map) && (side === "all" || s.side === side));
}

/** Cartes qui ont au moins une stratégie, dans l'ordre de la liste. */
export function mapsOf(list: StratSummary[]): string[] {
  return [...new Set(list.map((s) => s.map))];
}

/** Groupes par carte, dans l'ordre de la liste (le serveur trie par carte, côté, nom). */
export function groupByMap<T extends StratSummary>(list: T[]): { map: string; items: T[] }[] {
  const groups: { map: string; items: T[] }[] = [];
  for (const s of list) {
    const g = groups.find((x) => x.map === s.map);
    if (g) g.items.push(s);
    else groups.push({ map: s.map, items: [s] });
  }
  return groups;
}

/** Le résumé que renvoie GET /api/strats (la démo le calcule). */
export function toSummary(s: Strat): StratSummary {
  return {
    id: s.id, name: s.name, map: s.map, side: s.side, type: s.type, tags: s.tags, author: s.author, updated_at: s.updated_at,
    counts: { positions: s.positions.length, grenades: s.grenades.length, shapes: s.shapes.length },
  };
}

/** Étage où se trouvent le plus de joueurs ; le premier étage de la carte sinon. */
export function initialLevel(s: Strat, m: MapMeta): string {
  const counts = new Map<string, number>();
  for (const p of s.positions) {
    const l = levelForZ(m, p.pos[2]);
    counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  let best = m.levels[0]?.name ?? "default";
  let most = 0;
  for (const [l, c] of counts) if (c > most) { best = l; most = c; }
  return best;
}

/** Point du monde à l'étage affiché ? (point inconnu ou carte à un étage : oui) */
function onLevel(m: MapMeta, level: string, v: Vec3 | null): boolean {
  return !v || m.levels.length < 2 || levelForZ(m, v[2]) === level;
}

export function positionsOn(s: Strat, m: MapMeta, level: string): Numbered<StratPosition>[] {
  return s.positions.map((item, i) => ({ item, n: i + 1 })).filter(({ item }) => onLevel(m, level, item.pos));
}

/** Une grenade est à l'étage de son impact, à défaut de son lancer. */
export function grenadesOn(s: Strat, m: MapMeta, level: string): Numbered<StratGrenade>[] {
  return s.grenades.map((item, i) => ({ item, n: i + 1 })).filter(({ item }) => onLevel(m, level, item.land ?? item.throw));
}

/** Dessins de l'étage affiché, plus ceux tracés pour tous les étages (`"default"`). */
export function shapesOn(s: Strat, m: MapMeta, level: string): Shape[] {
  return s.shapes.filter((x) => m.levels.length < 2 || x.level === level || x.level === "default");
}

/** Points à cadrer, en fractions du radar : joueurs, lancers et impacts, points des dessins. */
export function stratPoints(s: Strat, m: MapMeta): [number, number][] {
  const world = [...s.positions.map((p) => p.pos), ...s.grenades.flatMap((g) => [g.throw, g.land])]
    .filter((v): v is Vec3 => !!v)
    .map((v) => toRadarFraction(m, v[0], v[1]));
  const drawn = s.shapes.flatMap((x) => x.points.map(([px, py]): [number, number] => [px / RADAR_SIZE, py / RADAR_SIZE]));
  return [...world, ...drawn];
}

/** Pointe d'une flèche (triangle) au bout du segment a → b, de longueur `size`. */
export function arrowHead(a: [number, number], b: [number, number], size: number): [number, number][] {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const bx = b[0] - ux * size, by = b[1] - uy * size;
  const half = size * 0.55;
  return [[b[0], b[1]], [bx - uy * half, by + ux * half], [bx + uy * half, by - ux * half]];
}

/** Pour chaque point : un autre point est-il à moins de `minDist` ? (nom du joueur masqué, son numéro suffit) */
export function crowded(points: [number, number][], minDist: number): boolean[] {
  return points.map((p, i) => points.some((q, j) => j !== i && Math.hypot(p[0] - q[0], p[1] - q[1]) < minDist));
}

const pad = (n: number) => String(n).padStart(2, "0");

/** « hier », « 10 oct. » : jour local d'un horodatage du serveur (UTC). */
export function updatedDay(iso: string, now: Date): string {
  const d = parseUtc(iso);
  return shortDate(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, now);
}
