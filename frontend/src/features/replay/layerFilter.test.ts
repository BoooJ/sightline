import { describe, expect, it } from "vitest";
import type { RoundInfo } from "../../shared/api/types";
import { matchingRounds, type LayerFilter } from "./layerFilter";

const R = (number: number, ct: number, ctBuy: string, tBuy: string, winner: number): RoundInfo => ({
  id: number, number, winner_side: winner === ct ? "CT" : "T", winner_team_id: winner, end_reason: null, ct_team_id: ct, t_team_id: ct === 1 ? 2 : 1,
  score_a_after: 0, score_b_after: 0, ct_buy_type: ctBuy, t_buy_type: tBuy, ct_equip_value: 0, t_equip_value: 0,
  start_tick: 0, freeze_end_tick: 0, end_tick: 0, duration_s: 0,
});
// équipe 1 en CT sur les rounds 1 à 4, en T ensuite
const rounds = [R(1, 1, "pistol", "pistol", 1), R(2, 1, "full", "eco", 1), R(3, 1, "full", "force", 2), R(4, 1, "eco", "full", 2),
  R(5, 2, "pistol", "pistol", 1), R(6, 2, "full", "full", 1)];
const F = (o: Partial<LayerFilter>): LayerFilter => ({ team: 1, side: "same", buy: null, result: "any", ...o });
const nums = (f: LayerFilter, cur = rounds[1]) => matchingRounds(rounds, cur, f).map((r) => r.number);

describe("rounds à superposer", () => {
  it("garde le camp de l'équipe au round courant", () => {
    expect(nums(F({}))).toEqual([1, 3, 4]);
    expect(nums(F({ side: "any" }))).toEqual([1, 3, 4, 5, 6]);
  });
  it("filtre par achat de l'équipe choisie", () => {
    expect(nums(F({ buy: "full" }))).toEqual([3]);
    expect(nums(F({ buy: "full", side: "any" }))).toEqual([3, 6]);
    expect(nums(F({ team: 2, buy: "full" }), rounds[3])).toEqual([]);  // équipe 2 en T au round 4 : full au round 4 seulement
    expect(nums(F({ team: 2, buy: "full", side: "any" }), rounds[1])).toEqual([4, 6]);
  });
  it("filtre par résultat pour l'équipe", () => {
    expect(nums(F({ result: "won" }))).toEqual([1]);
    expect(nums(F({ result: "lost", side: "any" }))).toEqual([3, 4]);
  });
});
