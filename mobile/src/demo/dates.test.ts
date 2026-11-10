import { describe, expect, it } from "vitest";

import fixtures from "./fixtures.json";

import { shiftDates } from "./dates";

describe("dates de la démo", () => {
  it("recalcule les dates relatives, laisse le reste", () => {
    const today = new Date(2026, 0, 2, 15, 0);
    expect(shiftDates({ a: "@-3", b: ["@0T19:00:00"], c: "Dust II", d: 4, e: null }, today))
      .toEqual({ a: "2025-12-30", b: ["2026-01-02T19:00:00"], c: "Dust II", d: 4, e: null });
  });
  it("les données capturées n'ont plus aucune date réelle", () => {
    const dates = JSON.stringify(fixtures).match(/"\d{4}-\d{2}-\d{2}/g) ?? [];
    expect(dates).toEqual([]);
  });
  it("les données capturées ont tout ce que lisent les écrans", () => {
    const f = fixtures as Record<string, any>;
    const sid = f.me.steamid;
    expect(sid).toBeTruthy();
    expect(f.profile.recent.length).toBeGreaterThanOrEqual(3);
    expect(f.dashboard.trend.length).toBeGreaterThanOrEqual(3);
    for (const r of f.profile.recent) {
      expect(f.matches[r.match_id]).toBeTruthy();
      expect(f.analyses[r.match_id].deaths.every((d: { victim: string }) => d.victim === sid)).toBe(true);
    }
    const opp = f.teams.find((t: { name: string }) => t.name === f.event.opponent);
    for (const map of f.event.maps) {
      expect(f.briefs[`${opp.id}:${map}`]).toBeTruthy();
      expect(f.grenades[map].lineups.length).toBeGreaterThan(0);
      expect(f.maps.some((m: { name: string }) => m.name === map)).toBe(true);
    }
    expect(f.matches[f.readyMatchId]).toBeTruthy();
  });
});
