import { describe, expect, it } from "vitest";

import type { DemoNote } from "@/api/demo";

import fixtures from "./fixtures.json";
import notes from "./notes.json";
import strats from "./strats.json";

const list = notes as unknown as DemoNote[];

describe("notes de la démo", () => {
  it("des identifiants uniques, des textes dans la limite du serveur", () => {
    expect(new Set(list.map((n) => n.id)).size).toBe(list.length);
    for (const n of list) {
      expect(n.body.trim().length, String(n.id)).toBeGreaterThan(0);
      expect(n.body.length, String(n.id)).toBeLessThanOrEqual(2000);
      expect([null, "T", "CT"]).toContain(n.side);
    }
  });
  it("chaque rattachement existe dans les données de la démo", () => {
    const maps = new Set(fixtures.maps.map((m) => m.name));
    const teams = new Set(fixtures.teams.map((t) => t.id));
    const stratIds = new Set(strats.map((s) => s.id));
    for (const n of list) {
      expect(maps.has(n.map), String(n.id)).toBe(true);
      if (n.match_id !== null) expect(Object.keys(fixtures.matches), String(n.id)).toContain(String(n.match_id));
      if (n.team_id !== null) expect(teams.has(n.team_id), String(n.id)).toBe(true);
      if (n.strat_id !== null) {
        expect(stratIds.has(n.strat_id), String(n.id)).toBe(true);
        expect(strats.find((s) => s.id === n.strat_id)?.map, String(n.id)).toBe(n.map);
      }
    }
  });
  it("au moins une note d'un coéquipier, partagée, pour montrer la lecture seule", () => {
    expect(list.some((n) => n.shared && n.author_id !== fixtures.me.id)).toBe(true);
  });
});
