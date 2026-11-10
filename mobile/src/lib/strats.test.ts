import { describe, expect, it } from "vitest";

import type { MapMeta, Shape, Strat, StratGrenade, StratPosition, StratSummary, Vec3 } from "@/api/types";

import { STRAT_TYPE_LABEL } from "./labels";
import {
  arrowHead, crowded, filterStrats, grenadesOn, groupByMap, initialLevel, mapsOf, positionsOn, shapesOn, stratPoints, toSummary,
  updatedDay,
} from "./strats";

// carte à un étage dont le repère monde = repère radar retourné (1 unité = 1 px)
const flat: MapMeta = {
  name: "de_dust2", display_name: "Dust II", pos_x: 0, pos_y: 1024, scale: 1, image: "de_dust2.png",
  levels: [{ name: "default", image: "de_dust2.png", z_min: -10000, z_max: 10000 }], bomb_a: null, bomb_b: null,
};
const nuke: MapMeta = {
  ...flat, name: "de_nuke", display_name: "Nuke",
  levels: [
    { name: "upper", image: "de_nuke.png", z_min: -495, z_max: 10000 },
    { name: "lower", image: "de_nuke_lower.png", z_min: -10000, z_max: -495 },
  ],
};

const strat = (over: Partial<Strat> = {}): Strat => ({
  id: 1, name: "Exécution B", map: "de_dust2", side: "T", type: "execute", tags: ["b"], author: "Paul",
  updated_at: "2026-10-18T12:00:00", counts: { positions: 0, grenades: 0, shapes: 0 },
  description: "", positions: [], grenades: [], shapes: [], source: null, ...over,
});
const pos = (z: number, name = "A"): StratPosition => ({ name, role: "", pos: [0, 0, z], yaw: 0 });
const nade = (land: Vec3 | null, thr: Vec3 | null = null): StratGrenade => ({
  type: "smoke", player: "", note: "", throw: thr, land, setpos: null, timing_s: null, trajectory: [],
});
const shape = (id: string, level: string, points: [number, number][] = [[0, 0], [10, 0]]): Shape => ({
  id, tool: "arrow", color: "#2ee6a6", width: 3, level, points,
});
const summary = (id: number, map: string, side: "T" | "CT"): StratSummary => toSummary(strat({ id, map, side }));

describe("stratégies : liste", () => {
  const list = [summary(1, "de_dust2", "T"), summary(2, "de_dust2", "CT"), summary(3, "de_inferno", "T")];
  it("filtre par carte et par côté, dans l'ordre reçu", () => {
    expect(filterStrats(list, null, "all").map((s) => s.id)).toEqual([1, 2, 3]);
    expect(filterStrats(list, "de_dust2", "all").map((s) => s.id)).toEqual([1, 2]);
    expect(filterStrats(list, null, "T").map((s) => s.id)).toEqual([1, 3]);
    expect(filterStrats(list, "de_inferno", "CT")).toEqual([]);
  });
  it("liste les cartes présentes, sans doublon", () => {
    expect(mapsOf(list)).toEqual(["de_dust2", "de_inferno"]);
  });
  it("groupe par carte sans changer l'ordre", () => {
    const mixed = [summary(1, "de_dust2", "T"), summary(2, "de_inferno", "T"), summary(3, "de_dust2", "CT")];
    expect(groupByMap(mixed).map((g) => [g.map, g.items.map((s) => s.id)])).toEqual([["de_dust2", [1, 3]], ["de_inferno", [2]]]);
  });
  it("résume une stratégie comme le serveur", () => {
    const s = toSummary(strat({ positions: [pos(0), pos(0)], grenades: [nade(null)], shapes: [] }));
    expect(s.counts).toEqual({ positions: 2, grenades: 1, shapes: 0 });
    expect(s).not.toHaveProperty("positions");
    expect(STRAT_TYPE_LABEL.execute).toBe("Exécution");
  });
});

describe("stratégies : étages", () => {
  it("ouvre l'étage qui a le plus de joueurs", () => {
    expect(initialLevel(strat({ positions: [pos(-600), pos(-600), pos(0)] }), nuke)).toBe("lower");
    expect(initialLevel(strat(), nuke)).toBe("upper");
    expect(initialLevel(strat({ positions: [pos(0)] }), flat)).toBe("default");
  });
  it("garde la numérotation de la stratégie en filtrant par étage", () => {
    const s = strat({ positions: [pos(0, "a"), pos(-600, "b"), pos(0, "c")] });
    expect(positionsOn(s, nuke, "upper").map((x) => [x.n, x.item.name])).toEqual([[1, "a"], [3, "c"]]);
    expect(positionsOn(s, flat, "default").map((x) => x.n)).toEqual([1, 2, 3]);
  });
  it("place une grenade par son impact, à défaut par son lancer", () => {
    const s = strat({ grenades: [nade([0, 0, -600]), nade(null, [0, 0, 0]), nade(null)] });
    expect(grenadesOn(s, nuke, "lower").map((x) => x.n)).toEqual([1, 3]);
    expect(grenadesOn(s, nuke, "upper").map((x) => x.n)).toEqual([2, 3]);
  });
  it("montre les dessins de l'étage et ceux de tous les étages", () => {
    const s = strat({ shapes: [shape("u", "upper"), shape("l", "lower"), shape("d", "default")] });
    expect(shapesOn(s, nuke, "lower").map((x) => x.id)).toEqual(["l", "d"]);
    expect(shapesOn(s, flat, "default").map((x) => x.id)).toEqual(["u", "l", "d"]);
  });
});

describe("stratégies : dessin", () => {
  it("cadre sur les joueurs, les grenades et les dessins (fractions du radar)", () => {
    const s = strat({ positions: [{ name: "a", role: "", pos: [512, 512, 0], yaw: 0 }], grenades: [nade(null, [0, 1024, 0])],
      shapes: [shape("x", "default", [[1024, 1024]])] });
    expect(stratPoints(s, flat)).toEqual([[0.5, 0.5], [0, 0], [1, 1]]);
  });
  it("calcule la pointe d'une flèche sur son dernier segment", () => {
    const [tip, left, right] = arrowHead([0, 0], [10, 0], 4);
    expect(tip).toEqual([10, 0]);
    expect(left[0]).toBeCloseTo(6);
    expect(left[1]).toBeCloseTo(2.2);
    expect(right[0]).toBeCloseTo(6);
    expect(right[1]).toBeCloseTo(-2.2);
  });
  it("repère les joueurs trop proches d'un autre pour afficher leur nom", () => {
    expect(crowded([[0, 0], [30, 0], [200, 0]], 40)).toEqual([true, true, false]);
    expect(crowded([[0, 0], [40, 0]], 40)).toEqual([false, false]);
    expect(crowded([[5, 5]], 40)).toEqual([false]);
  });
  it("date la mise à jour en jour local (le serveur écrit en UTC)", () => {
    const now = new Date(2026, 9, 19, 18, 0);
    expect(updatedDay("2026-10-18T12:00:00", now)).toBe("hier");
    expect(updatedDay("2026-10-10T12:00:00", now)).toBe("10 oct.");
  });
});
