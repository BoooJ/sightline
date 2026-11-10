import { Group, Mesh, BufferGeometry, Float32BufferAttribute } from "three";
import { describe, expect, it } from "vitest";
import { buildGrid, collisionFromScene, GRID_CELL, localWorld, trianglesInBox } from "./collision";

const W2M = [0, 0.0254, 0, 0, 0, 0, 0.0254, 0, 0.0254, 0, 0, 0, 0, 0, 0, 1];
/** Carreaux de 100 u à plat (z = h) de x0 à x1 et de y0 à y1, deux triangles chacun. */
function tiles(x0: number, x1: number, y0: number, y1: number, h = 0): number[] {
  const out: number[] = [];
  for (let x = x0; x < x1; x += 100) for (let y = y0; y < y1; y += 100) {
    out.push(x, y, h, x + 100, y, h, x + 100, y + 100, h, x, y, h, x + 100, y + 100, h, x, y + 100, h);
  }
  return out;
}

describe("collision de la carte", () => {
  it("fichier collision → triangles du jeu : matrices des nœuds puis inverse de world_to_model (comme la carte)", () => {
    // un triangle en mètres dans le repère de l'export (x = y du jeu, y = z, z = x), sous un nœud décalé de 1 m en Y
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute([0, 0, 0, 0.0254 * 10, 0, 0, 0, 0, 0.0254 * 20], 3));
    const root = new Group(), node = new Group();
    node.position.set(0, 1, 0);
    node.add(new Mesh(g));
    root.add(node);
    const tri = collisionFromScene(root, W2M);
    expect(tri.length).toBe(9);
    const r = Array.from(tri, (v) => Math.round(v * 1000) / 1000), up = 1 / 0.0254;
    expect(r).toEqual([0, 0, +up.toFixed(3), 0, 10, +up.toFixed(3), 20, 0, +up.toFixed(3)]);
  });
  it("grille : les triangles d'une boîte, chacun une fois, rien au loin ; carte vide comprise", () => {
    const g = buildGrid(new Float32Array([...tiles(0, 1000, 0, 1000), ...tiles(5000, 5100, 5000, 5100, 300)]));
    expect(g.cell).toBe(GRID_CELL);
    const out: number[] = [];
    const n = trianglesInBox(g, [150, 150, -10], [250, 250, 10], out);
    const got = out.slice(0, n);
    expect(new Set(got).size).toBe(n);  // chacun une fois, même à cheval sur plusieurs cellules
    expect(n).toBe(8);  // les carreaux qui touchent la boîte (100 à 300 u en x et y)
    expect(trianglesInBox(g, [5000, 5000, 0], [5100, 5100, 100], out)).toBe(0);  // le carreau du haut est à z 300
    expect(trianglesInBox(g, [5000, 5000, 250], [5100, 5100, 350], out)).toBe(2);
    expect(trianglesInBox(buildGrid(new Float32Array(0)), [0, 0, 0], [1, 1, 1], out)).toBe(0);
  });
  it("monde local d'une mort : triangles à moins de r, requêtes du solveur dans la grille fine", () => {
    const g = buildGrid(new Float32Array(tiles(-2000, 2000, -2000, 2000)));
    const w = localWorld(g, 0, 0, 30);
    expect(w.count).toBeGreaterThan(0);
    expect(w.count).toBeLessThanOrEqual(2 * 8 * 8);  // carreaux de −300 à 300 au plus (r = 256, boîtes à cheval)
    const out: number[] = [];
    const k = w.near(0, 0, 4, 5, out);
    expect(k).toBeGreaterThan(0);
    expect(out.slice(0, k).every((t) => t >= 0 && t < w.count)).toBe(true);
    expect(w.near(0, 0, 100, 5, out)).toBe(0);  // trop haut : aucun triangle
  });
  it("sommet non fini ou carte démesurée : erreur claire, pas de grille vide muette", () => {
    expect(() => buildGrid(new Float32Array([0, 0, 0, NaN, 0, 0, 0, 1, 0]))).toThrow(/non fini/);
    expect(() => buildGrid(new Float32Array([0, 0, 0, Infinity, 0, 0, 0, 1, 0]))).toThrow(/non fini/);
    expect(() => buildGrid(new Float32Array([0, 0, 0, 1e9, 0, 0, 0, 1e9, 0]))).toThrow(/trop grande/);
  });
  it("boîte entièrement hors carte : aucun triangle ; triangle plus grand qu'une cellule : rendu une fois", () => {
    const g = buildGrid(new Float32Array([0, 0, 0, 1000, 0, 0, 0, 1000, 0]));  // 8 × 8 cellules de 128 u
    const out: number[] = [];
    expect(trianglesInBox(g, [-500, -500, -10], [-400, -400, 10], out)).toBe(0);
    expect(trianglesInBox(g, [5000, 5000, -10], [5100, 5100, 10], out)).toBe(0);
    expect(trianglesInBox(g, [-10, -10, -10], [2000, 2000, 10], out)).toBe(1);
  });
});
