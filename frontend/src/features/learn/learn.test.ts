import { describe, expect, it } from "vitest";
import type { LearnEntry } from "../../shared/api/types";
import { metrics, nadeSpots, tips } from "./learn";

const E = (o: Partial<LearnEntry>): LearnEntry => ({
  match_id: 1, round_number: 1, steamid: "a", name: "A", team: "X", opponent: "Y", won: true, pos: [0, 0, 0], yaw: 0,
  start_tick: 0, end_tick: 100, path: [], left_s: null, kills: 0, first_kill_s: null, opening_kill: false, damage: 0,
  grenades: [], death: null, rate: 64, kills_detail: [], bomb_site: null, plant_s: null, buy: "full", opp_buy: "full",
  played_at: null, round_end_s: 100, contact_s: null, ...o,
});
const death = (time_s: number, opening = false) => ({ time_s, tick: 0, pos: [0, 0, 0] as [number, number, number], attacker_pos: null,
  attacker_place: "Palace", weapon: "ak47", opening, traded: false });

describe("apprendre un poste", () => {
  it("calcule survie, kills et utilitaires par round", () => {
    const m = metrics([E({ kills: 2, damage: 150 }), E({ death: death(30), won: false }), E({ kills: 1, grenades: [{ type: "smoke", time_s: 5, throw: [0, 0, 0], land: [1, 1, 0], setpos: null, tick: 1 }] })]);
    expect(m.survivePct).toBeCloseTo(66.67, 1);
    expect(m.kpr).toBe(1);
    expect(m.winPct).toBeCloseTo(66.67, 1);
    expect(m.nadesPerRound).toBeCloseTo(1 / 3);
    expect(m.deathS).toBe(30);
  });

  it("regroupe les utilitaires et signale mes écarts", () => {
    const smoke = (x: number) => ({ type: "smoke" as const, time_s: 10, throw: [0, 0, 0] as [number, number, number], land: [x / 2, 0, 0] as [number, number, number], setpos: "setpos 1 2 3", tick: 1 });
    const others = [1, 2, 3, 4].map((k) => E({ steamid: "o", name: "O", grenades: [smoke(100 * k)], death: k < 3 ? death(45) : null }));
    expect(nadeSpots(others)[0].count).toBe(4);
    const mine = [E({ death: death(20, true) }), E({ death: death(22, true) })];
    const t = tips(others, mine, (p) => p ?? "Ici", () => "Smoke");
    expect(t.some((x) => x.kind === "work" && x.text.includes("meurs plus tôt"))).toBe(true);
    expect(t.some((x) => x.text.includes("utilitaires"))).toBe(true);
  });
});
