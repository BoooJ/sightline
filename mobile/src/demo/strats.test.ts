import { describe, expect, it } from "vitest";

import type { Strat } from "@/api/types";

import fixtures from "./fixtures.json";
import strats from "./strats.json";

const list = strats as unknown as Strat[];
// même contrôle que le serveur (backend/app/api/strats.py, _SETPOS)
const SETPOS = /^setpos -?[\d.]+ -?[\d.]+ -?[\d.]+;\s*setang -?[\d.]+ -?[\d.]+ -?[\d.]+$/;

describe("stratégies de la démo", () => {
  it("cinq stratégies aux identifiants uniques, sur les cartes de la démo", () => {
    expect(list).toHaveLength(5);
    expect(new Set(list.map((s) => s.id)).size).toBe(5);
    const maps = new Set(fixtures.maps.map((m) => m.name));
    for (const s of list) expect(maps.has(s.map), s.name).toBe(true);
  });
  it("respectent les limites du serveur", () => {
    for (const s of list) {
      expect(s.positions.length, s.name).toBe(5);
      expect(s.grenades.length, s.name).toBeGreaterThanOrEqual(2);
      expect(s.grenades.length, s.name).toBeLessThanOrEqual(5);
      expect(s.shapes.length, s.name).toBeGreaterThanOrEqual(1);
      expect(s.description.split("\n").length, s.name).toBeLessThanOrEqual(4);
      for (const g of s.grenades) {
        expect(g.land, s.name).not.toBeNull();
        expect(g.trajectory.length, s.name).toBeLessThanOrEqual(64);
        if (g.setpos) expect(g.setpos, s.name).toMatch(SETPOS);
      }
    }
  });
  it("chaque grenade est lancée par un joueur de la stratégie", () => {
    for (const s of list) {
      const names = new Set(s.positions.map((p) => p.name));
      for (const g of s.grenades) expect(names.has(g.player), `${s.name} : ${g.player}`).toBe(true);
    }
  });
  it("renvoie vers un vrai match de la démo quand elle vient d'un replay", () => {
    const ids = new Set(Object.values(fixtures.matches).map((m) => m.id));
    const sourced = list.filter((s) => s.source);
    expect(sourced.length).toBeGreaterThan(0);
    for (const s of sourced) expect(ids.has(s.source!.match_id), s.name).toBe(true);
  });
});
