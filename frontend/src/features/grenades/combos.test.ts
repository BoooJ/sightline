import { describe, expect, it } from "vitest";
import type { GrenadeThrow, GrenadeType, Vec3 } from "../../shared/api/types";
import { findCombos } from "./combos";

let id = 0;
const T = (round: number, type: GrenadeType, land: Vec3, time_s: number, won: boolean | null = true, team_id = 1): GrenadeThrow => ({
  id: ++id, type, side: "T", thrower: "p", thrower_name: "P", team_id, team: "A", opponent: "B", match_id: 1, round_number: round,
  round_id: round, throw_tick: Math.round(time_s * 64), detonate_tick: null, throw: [0, 0, 0], land, yaw: null, pitch: null,
  setpos: null, trajectory: [], won, time_s,
});

describe("findCombos", () => {
  it("retrouve une exécution répétée et ignore les grenades isolées", () => {
    const ex = (r: number, won: boolean, dt = 0) => [T(r, "smoke", [1000, 0, 0], 30 + dt, won), T(r, "smoke", [1500 + dt, 200, 0], 32 + dt, won),
      T(r, "molotov", [0, 1200, 0], 35 + dt, won)];
    const combos = findCombos([...ex(1, true), ...ex(2, false, 20), ...ex(3, true, 5), T(4, "flash", [-3000, 0, 0], 10)]);
    expect(combos[0].items.map((i) => i.type)).toEqual(["smoke", "smoke", "molotov"]);
    expect(combos[0].rounds).toHaveLength(3);
    expect(combos[0].winRate).toBeCloseTo(2 / 3);
    // les sous-ensembles vus dans les mêmes rounds sont fusionnés dans la combinaison complète
    expect(combos).toHaveLength(1);
  });

  it("sépare les salves espacées et les équipes", () => {
    const r = (n: number) => [T(n, "smoke", [0, 0, 0], 5), T(n, "flash", [3000, 0, 0], 60)];
    expect(findCombos([...r(1), ...r(2)])).toHaveLength(0);
    const other = [T(1, "smoke", [0, 0, 0], 5, true, 2), T(2, "flash", [100, 0, 0], 6, true, 1)];
    expect(findCombos(other)).toHaveLength(0);
  });
});
