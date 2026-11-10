/**
 * Collision des cartes 3D (fichier `collision` de /api/maps3d, scripts/map3d/lib/collision.mjs) : triangles dans le repère
 * du jeu, grille de recherche sur toute la carte, monde local d'une mort pour le solveur du ragdoll (ragdollSolver.ts).
 * Contrat partagé avec la vague 2 (fumées, molotovs) : `collisionFromScene`, `buildGrid` et `trianglesInBox` gardent ces
 * signatures ; elle ajoutera `segmentHit`. Aucun import de three à l'exécution (types seulement) : ce module part aussi
 * dans le worker du ragdoll (ragdollWorker.ts), qui n'embarque pas three.
 */
import type { BufferAttribute, InterleavedBufferAttribute, Mesh, Object3D } from "three";
import type { Vec3 } from "../../shared/api/types";
import type { World } from "./ragdollSolver";
import { invertAffine } from "./world";

/** Triangles d'un fichier `collision` (9 nombres par triangle, unités du jeu, Z en haut) : sommets des maillages pris dans
 *  le repère de la scène (matrices des nœuds, quantification de meshopt comprise : `getX` dénormalise), puis ramenés au
 *  jeu par l'inverse de `world_to_model` (comme la carte, Viewer.setMap). Deux passes : comptage, puis remplissage. */
export function collisionFromScene(scene: Object3D, worldToModel: number[]): Float32Array {
  scene.updateMatrixWorld(true);
  const g = invertAffine(worldToModel), meshes: Mesh[] = [];
  scene.traverse((o) => { if ((o as Mesh).isMesh) meshes.push(o as Mesh); });
  const count = (m: Mesh) => { const n = m.geometry.index ? m.geometry.index.count : m.geometry.getAttribute("position").count; return n - (n % 3); };
  let total = 0;
  for (const m of meshes) total += count(m);
  const tri = new Float32Array(total * 3);
  let k = 0;
  for (const m of meshes) {
    const e = m.matrixWorld.elements, idx = m.geometry.index;  // colonnes
    const pos = m.geometry.getAttribute("position") as BufferAttribute | InterleavedBufferAttribute;
    for (let i = 0, n = count(m); i < n; i++) {
      const v = idx ? idx.getX(i) : i, x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
      const mx = e[0] * x + e[4] * y + e[8] * z + e[12], my = e[1] * x + e[5] * y + e[9] * z + e[13], mz = e[2] * x + e[6] * y + e[10] * z + e[14];
      tri[k++] = g[0] * mx + g[1] * my + g[2] * mz + g[3];
      tri[k++] = g[4] * mx + g[5] * my + g[6] * mz + g[7];
      tri[k++] = g[8] * mx + g[9] * my + g[10] * mz + g[11];
    }
  }
  return tri;
}

/** Grille uniforme à plat (x, y) sur les triangles : pour chaque cellule de `cell` unités, les triangles dont la boîte la
 *  touche (`start` / `items`, rangés cellule par cellule) ; boîtes des triangles (`box` : x0 y0 z0 x1 y1 z1) ; `mark` et
 *  `stamp` : chaque triangle rendu une fois par requête. */
export interface CollisionGrid {
  tri: Float32Array; box: Float32Array; cell: number; ox: number; oy: number; nx: number; ny: number;
  start: Uint32Array; items: Uint32Array; mark: Int32Array; stamp: number;
}
/** Cellule de la grille de la carte (u) : ≈ 50 triangles par cellule sur Inferno simplifiée (sonde 0.4). */
export const GRID_CELL = 128;

/** Plafond de cellules de la grille (une carte réelle en a quelques centaines) : au-delà, un sommet aberrant. */
const MAX_CELLS = 4_000_000;

/** Lève une erreur si un sommet n'est pas fini ou si la carte est démesurée (jamais de grille vide muette). */
export function buildGrid(tri: Float32Array, cell = GRID_CELL): CollisionGrid {
  const n = (tri.length / 9) | 0, box = new Float32Array(6 * n);
  let ox = Infinity, oy = Infinity, mx = -Infinity, my = -Infinity;
  for (let t = 0; t < n; t++) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let c = 0; c < 3; c++) {
      const x = tri[9 * t + 3 * c], y = tri[9 * t + 3 * c + 1], z = tri[9 * t + 3 * c + 2];
      if (!Number.isFinite(x + y + z)) throw new Error(`sommet non fini (triangle ${t})`);
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); z0 = Math.min(z0, z); x1 = Math.max(x1, x); y1 = Math.max(y1, y); z1 = Math.max(z1, z);
    }
    box.set([x0, y0, z0, x1, y1, z1], 6 * t);
    ox = Math.min(ox, x0); oy = Math.min(oy, y0); mx = Math.max(mx, x1); my = Math.max(my, y1);
  }
  if (!n) { ox = oy = 0; mx = my = 0; }
  const nx = Math.floor((mx - ox) / cell) + 1, ny = Math.floor((my - oy) / cell) + 1;
  if (nx * ny > MAX_CELLS) throw new Error(`carte trop grande (${nx} × ${ny} cellules)`);
  const start = new Uint32Array(nx * ny + 1);
  const span = (t: number, f: (c: number) => void) => {
    const i0 = Math.floor((box[6 * t] - ox) / cell), i1 = Math.floor((box[6 * t + 3] - ox) / cell);
    const j0 = Math.floor((box[6 * t + 1] - oy) / cell), j1 = Math.floor((box[6 * t + 4] - oy) / cell);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) f(i + j * nx);
  };
  for (let t = 0; t < n; t++) span(t, (c) => { start[c + 1]++; });
  for (let c = 0; c < nx * ny; c++) start[c + 1] += start[c];
  const fill = start.slice(), items = new Uint32Array(start[nx * ny]);
  for (let t = 0; t < n; t++) span(t, (c) => { items[fill[c]++] = t; });
  return { tri, box, cell, ox, oy, nx, ny, start, items, mark: new Int32Array(n), stamp: 0 };
}

/** Triangles dont la boîte touche la boîte [min, max] : leurs indices dans `out` (chacun une fois), leur nombre. */
export function trianglesInBox(g: CollisionGrid, min: Vec3, max: Vec3, out: number[]): number {
  const st = ++g.stamp, cell = g.cell, box = g.box;
  const i0 = Math.max(0, Math.floor((min[0] - g.ox) / cell)), i1 = Math.min(g.nx - 1, Math.floor((max[0] - g.ox) / cell));
  const j0 = Math.max(0, Math.floor((min[1] - g.oy) / cell)), j1 = Math.min(g.ny - 1, Math.floor((max[1] - g.oy) / cell));
  let n = 0;
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
    const c = i + j * g.nx;
    for (let q = g.start[c]; q < g.start[c + 1]; q++) {
      const t = g.items[q], b = 6 * t;
      if (g.mark[t] === st) continue;
      g.mark[t] = st;
      if (box[b] > max[0] || box[b + 3] < min[0] || box[b + 1] > max[1] || box[b + 4] < min[1] || box[b + 2] > max[2] || box[b + 5] < min[2]) continue;
      out[n++] = t;
    }
  }
  return n;
}

/** Monde local d'une mort : triangles à moins de LOCAL_R unités du point de départ (en x, y et z) ; grille fine de
 *  LOCAL_CELL unités pour les requêtes du solveur (une par sphère et par image). Valeurs du banc d'essai (sonde 0.6). */
export const LOCAL_R = 256, LOCAL_CELL = 24;

export function localWorld(g: CollisionGrid, x: number, y: number, z: number, r = LOCAL_R, cell = LOCAL_CELL): World & { count: number } {
  const keep: number[] = [];
  const count = trianglesInBox(g, [x - r, y - r, z - r], [x + r, y + r, z + r], keep);
  const tri = new Float32Array(count * 9), zr = new Float32Array(2 * count);
  for (let k = 0; k < count; k++) {
    tri.set(g.tri.subarray(9 * keep[k], 9 * keep[k] + 9), 9 * k);
    zr[2 * k] = g.box[6 * keep[k] + 2];
    zr[2 * k + 1] = g.box[6 * keep[k] + 5];
  }
  const n = Math.ceil((2 * r) / cell), ox = x - r, oy = y - r, cells: number[][] = Array.from({ length: n * n }, () => []);
  for (let k = 0; k < count; k++) {
    const b = 6 * keep[k];
    for (let i = Math.max(0, Math.floor((g.box[b] - ox) / cell)); i <= Math.min(n - 1, Math.floor((g.box[b + 3] - ox) / cell)); i++)
      for (let j = Math.max(0, Math.floor((g.box[b + 1] - oy) / cell)); j <= Math.min(n - 1, Math.floor((g.box[b + 4] - oy) / cell)); j++) cells[i + j * n].push(k);
  }
  const mark = new Int32Array(count).fill(-1);
  let stamp = 0;
  return {
    tri, count,
    near(px, py, pz, pr, out) {
      stamp++;
      let m = 0;
      for (let i = Math.max(0, Math.floor((px - pr - ox) / cell)); i <= Math.min(n - 1, Math.floor((px + pr - ox) / cell)); i++)
        for (let j = Math.max(0, Math.floor((py - pr - oy) / cell)); j <= Math.min(n - 1, Math.floor((py + pr - oy) / cell)); j++)
          for (const t of cells[i + j * n]) {
            if (mark[t] === stamp || zr[2 * t] > pz + pr || zr[2 * t + 1] < pz - pr) continue;
            mark[t] = stamp;
            out[m++] = t;
          }
      return m;
    },
  };
}
