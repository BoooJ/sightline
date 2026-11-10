import { describe, expect, it } from "vitest";
import type { GrenadeThrow, GrenadeType, Side, Vec3 } from "../../shared/api/types";
import { DEFAULT_TYPES, roundGrenades } from "./roundNades";

let id = 0;
const G = (round: number, type: GrenadeType, time_s: number, o: Partial<GrenadeThrow> = {}): GrenadeThrow => ({
  id: ++id, type, side: "T" as Side, thrower: "p", thrower_name: "P", team_id: 1, team: "A", opponent: "B", match_id: 1,
  round_number: round, round_id: round, throw_tick: Math.round(1000 + time_s * 64), detonate_tick: null,
  throw: [0, 0, 0] as Vec3, land: [1000, 0, 0] as Vec3, yaw: 10, pitch: -5, setpos: "setpos 0 0 0;setang -5 10 0",
  trajectory: [], won: true, time_s, ...o,
});

describe("roundGrenades", () => {
  it("garde les grenades du round, dans l'ordre du lancer, avec l'horloge du jeu, sans les leurres", () => {
    const flash = G(3, "flash", 40), smoke = G(3, "smoke", 5);
    const items = roundGrenades([G(2, "smoke", 1), flash, smoke, G(3, "decoy", 20)], 3, { types: DEFAULT_TYPES, side: null });
    expect(items.map((n) => n.t.id)).toEqual([smoke.id, flash.id]);
    expect(items.map((n) => n.clock)).toEqual(["1:50", "1:15"]);
  });

  it("filtre par type et par camp", () => {
    const ct = G(1, "smoke", 10, { side: "CT" }), t = G(1, "smoke", 12), molo = G(1, "molotov", 14);
    expect(roundGrenades([ct, t, molo], 1, { types: ["smoke"], side: "T" }).map((n) => n.t.id)).toEqual([t.id]);
    expect(roundGrenades([ct, t, molo], 1, { types: ["smoke", "molotov"], side: null })).toHaveLength(3);
  });

  it("compte les lancers du même lineup dans la bibliothèque (même type, camp, départ et arrivée proches)", () => {
    const here = G(5, "smoke", 30);
    const library = [
      here,
      G(9, "smoke", 31, { throw: [20, 10, 0], land: [1100, 50, 0] }),  // même lineup
      G(11, "smoke", 29, { throw: [30, 0, 0], land: [1000, 120, 0] }),  // même lineup
      G(12, "smoke", 30, { throw: [400, 0, 0] }),                     // autre point de lancer
      G(13, "smoke", 30, { land: [2000, 0, 0] }),                     // autre point d'arrivée
      G(14, "flash", 30),                                              // autre type
      G(15, "smoke", 30, { side: "CT" }),                              // autre camp
      G(16, "smoke", 30, { land: null }),                              // arrivée inconnue
    ];
    const [n] = roundGrenades([here], 5, { types: DEFAULT_TYPES, side: null }, library);
    expect(n.seen).toBe(3);
  });

  it("ne compte rien tant que la bibliothèque n'est pas chargée, et 1 pour un lancer sans arrivée connue", () => {
    const g = G(1, "smoke", 10), lost = G(1, "he", 12, { land: null });
    const items = roundGrenades([g, lost], 1, { types: DEFAULT_TYPES, side: null });
    expect(items.map((n) => n.seen)).toEqual([null, null]);
    expect(roundGrenades([lost], 1, { types: DEFAULT_TYPES, side: null }, [lost])[0].seen).toBe(1);
  });
});
