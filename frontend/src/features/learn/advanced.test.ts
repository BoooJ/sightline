import { describe, expect, it } from "vitest";
import type { LearnEntry } from "../../shared/api/types";
import { applyFilter, byPlayer, chronology, duels, NO_FILTER, posAt, posteSite, programme, progression, spots, studyMarks, timeline } from "./advanced";

const E = (o: Partial<LearnEntry>): LearnEntry => ({
  match_id: 1, round_number: 1, steamid: "a", name: "A", team: "X", opponent: "Y", won: true, pos: [0, 0, 0], yaw: 0,
  start_tick: 0, end_tick: 100, path: [[0, 0, 0], [100, 0, 0], [200, 0, 0]], left_s: null, kills: 0, first_kill_s: null, opening_kill: false,
  damage: 0, grenades: [], death: null, rate: 64, kills_detail: [], bomb_site: null, plant_s: null, buy: "full", opp_buy: "full",
  played_at: null, round_end_s: 100, contact_s: null, ...o,
});
const death = (time_s: number) => ({ time_s, tick: time_s * 64, pos: [0, 0, 0] as [number, number, number], attacker_pos: [300, 400, 0] as [number, number, number],
  attacker_place: "Palace", weapon: "ak47", opening: false, traded: false });

describe("analyses avancées d'un poste", () => {
  it("site du poste, filtres de situation et placements", () => {
    const es = [E({ bomb_site: "A" }), E({ bomb_site: "B", buy: "eco" }), E({ pos: [1000, 0, 0] }), E({ steamid: "b" })];
    const site = posteSite(es, { A: [0, 0, 0], B: [5000, 0, 0] });
    expect(site).toBe("A");
    expect(applyFilter(es, { ...NO_FILTER, site: "this" }, site, [])).toHaveLength(1);
    expect(applyFilter(es, { ...NO_FILTER, site: "other" }, site, [])).toHaveLength(1);
    expect(applyFilter(es, { ...NO_FILTER, site: "none" }, site, [])).toHaveLength(2);
    expect(applyFilter(es, { ...NO_FILTER, buy: ["eco"] }, site, [])).toHaveLength(1);
    const sp = spots(es);
    expect(sp.map((s) => s.entries.length)).toEqual([3, 1]);
    expect(applyFilter(es, { ...NO_FILTER, spot: sp[1].id }, site, sp)).toHaveLength(1);
    expect(byPlayer(es)[0].entries).toHaveLength(3);
  });

  it("déroulé, chronologie, duels et position au fil du temps", () => {
    const es = [E({ death: death(10) }), E({ left_s: 4 }), E({ round_end_s: 6 })];
    const tl = timeline(es);
    expect(tl[0]).toMatchObject({ held: 1, left: 0, dead: 0 });
    const at12 = tl.find((c) => c.t === 12)!;
    expect(at12.dead + at12.left + at12.over).toBeCloseTo(1);
    const ch = chronology(es, () => "Ici", () => "Smoke");
    expect(ch.map((c) => c.kind)).toEqual(["left", "death"]);
    const d = duels(es, (p) => p ?? "?");
    expect(d.deathsFrom[0]).toEqual({ label: "Palace", n: 1 });
    expect(d.deathDist).toBe(500);
    expect(posAt(es[1], 1)).toEqual([50, 0, 0]);
    expect(posAt(es[0], 11)).toBeNull();
  });

  it("progression, pauses commentées et programme", () => {
    const mine = [E({ match_id: 2, opponent: "Z" }), E({ match_id: 1 })];
    expect(progression(mine).map((r) => r.key)).toEqual(["1", "2"]);
    const marks = studyMarks(E({ contact_s: 3, death: death(10), left_s: 5 }), (p) => p ?? "?", () => "Smoke");
    expect(marks.map((m) => m.tick)).toEqual([192, 320, 640]);
    const goals = programme([E({ death: death(40) })], [E({})], () => "Ici", () => "Smoke");
    expect(goals.find((g) => g.id === "g-survie")?.auto).toBe(true);
  });
});
