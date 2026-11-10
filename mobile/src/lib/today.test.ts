import { describe, expect, it } from "vitest";

import type { CalendarEvent, ProfileLine, ScoutTeam } from "@/api/types";

import { buildToday, likelyTop, nextEvent, readyFrom, type TodayInput } from "./today";

const now = new Date(2026, 9, 19, 18, 0);
const ev = (id: number, starts_at: string, kind: CalendarEvent["kind"] = "match", maps = ["de_inferno"]): CalendarEvent =>
  ({ id, title: "", kind, opponent: "MOUZ", maps, starts_at, notes: "", matches: [] });
const line = (match_id: number, date: string, map = "de_dust2"): ProfileLine => ({
  match_id, date, map, display_name: "Dust II", opponent: "MOUZ", score: [13, 9], won: true, kind: "official",
  poste: { t: null, ct: null }, rounds: 22, rating: 1.1, adr: 80, kpr: 0.8, dpr: 0.6, kast: 75, kills: 18, deaths: 13,
  assists: 4, utility_dmg: 50,
});
const teams: ScoutTeam[] = [{ id: 7, name: "MOUZ", matches: 3, wins: 1, maps: 3 }];
const trend = [{ match_id: 1, date: "2026-10-10", map: "de_dust2", rating: 1, adr: 80, won: true, opponent: "MOUZ" },
  { match_id: 2, date: "2026-10-12", map: "de_cache", rating: 1.2, adr: 90, won: false, opponent: "MOUZ" }];
const base: TodayInput = { now, events: [], teams, recent: [], trend: [], seen: new Set(), ready: [] };

describe("accueil", () => {
  it("trouve le prochain match (pas les entraînements, pas le passé)", () => {
    const events = [ev(1, "2026-10-19T12:00"), ev(2, "2026-10-25T20:00"), ev(3, "2026-10-20T20:00", "practice"),
      ev(4, "2026-10-21T20:00", "scrim")];
    expect(nextEvent(events, now)?.id).toBe(4);
  });
  it("ordre normal : préparation, bilan, forme, grenades du prochain match", () => {
    const cards = buildToday({ ...base, events: [ev(1, "2026-10-21T20:00")], recent: [line(2, "2026-10-12")], trend });
    expect(cards.map((c) => c.kind)).toEqual(["prep", "debrief", "form", "grenades"]);
    expect(cards[0]).toMatchObject({ kind: "prep", team: { id: 7 } });
    expect(cards[3]).toEqual({ kind: "grenades", map: "de_inferno" });
  });
  it("un bilan tout juste prêt et pas encore ouvert passe en premier", () => {
    const ready = [{ match_id: 2, at: new Date(2026, 9, 19, 16, 0) }];
    const cards = buildToday({ ...base, events: [ev(1, "2026-10-19T21:00")], recent: [line(2, "2026-10-19")], ready });
    expect(cards.map((c) => c.kind)).toEqual(["debrief", "prep", "grenades"]);
    expect(cards[0]).toMatchObject({ fresh: true });
    const seen = buildToday({ ...base, events: [ev(1, "2026-10-19T21:00")], recent: [line(2, "2026-10-19")], ready,
      seen: new Set([2]) });
    expect(seen.map((c) => c.kind)).toEqual(["prep", "debrief", "grenades"]);
  });
  it("sans match prévu : bilan, forme et grenades de la dernière carte", () => {
    const cards = buildToday({ ...base, recent: [line(2, "2026-10-12", "de_cache")], trend });
    expect(cards.map((c) => c.kind)).toEqual(["debrief", "form", "grenades"]);
    expect(cards[2]).toEqual({ kind: "grenades", map: "de_cache" });
  });
  it("lit les analyses terminées dans les notifications", () => {
    const n = (id: number, kind: string, link: string) => ({ id, kind, title: "", body: "", link, created_at: "2026-10-19T16:00:00" });
    expect(readyFrom([n(1, "match_ready", "/matches/42"), n(2, "comment", "/matches/42"), n(3, "match_ready", "/x")]))
      .toEqual([{ match_id: 42, at: new Date("2026-10-19T16:00:00Z") }]);
  });
  it("rien du tout : aucune carte", () => {
    expect(buildToday(base)).toEqual([]);
  });
});

describe("cartes probables", () => {
  it("garde les trois premières à 5 % et plus", () => {
    const maps = [["de_dust2", 36], ["de_mirage", 24], ["de_nuke", 12], ["de_ancient", 9], ["de_anubis", 2]]
      .map(([map, pct]) => ({ map: map as string, name: map as string, pct: pct as number, played: 0, won: 0 }));
    expect(likelyTop({ maps, them: 4, us: 22, few: true }).map((m) => m.pct)).toEqual([36, 24, 12]);
    expect(likelyTop({ maps: maps.slice(3), them: 4, us: 22, few: true }).map((m) => m.map)).toEqual(["de_ancient"]);
    expect(likelyTop(null)).toEqual([]);
  });
});
