import { describe, expect, it } from "vitest";

import type { AnalysisDeath, MatchAnalysis } from "@/api/types";

import { costliestDeaths, reasonsOf } from "./deaths";

const death = (victim: string, cost: number, round: number): AnalysisDeath => ({
  round, tick: round * 100, victim, victim_name: victim, team_id: 1, side: "T", attacker: "x", attacker_name: "X",
  weapon: "ak47", place: "BombsiteA", cost, reasons: ["untraded", "dry"], avoidable: true, equip: 4700,
  unused_utility: 0, t0: null, aim_offset: 30, killer_aim_offset: 2, aim_zone: "champ", checked: true,
  help: { killer: [], victim: [] },
});

describe("morts", () => {
  it("garde les morts du joueur, les plus chères d'abord", () => {
    const a = { deaths: [death("me", 0.1, 1), death("other", 0.9, 2), death("me", 0.4, 3), death("me", 0.2, 4),
      death("me", 0.3, 5)] } as unknown as MatchAnalysis;
    expect(costliestDeaths(a, "me").map((d) => d.round)).toEqual([3, 5, 4]);
    expect(costliestDeaths(a, "me", 1).map((d) => d.round)).toEqual([3]);
    expect(costliestDeaths(a, "nobody")).toEqual([]);
  });
  it("traduit les raisons", () => {
    expect(reasonsOf(death("me", 0.1, 1))).toEqual(["Non échangé", "Duel à sec"]);
  });
});
