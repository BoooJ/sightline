import { describe, expect, it } from "vitest";

import { clock, countdown, gameClock, longDate, num, parseLocal, parseUtc, pct, secs, shortDate, signed, time } from "./format";

describe("format", () => {
  it("lit un moment du round à l'horloge du jeu", () => {
    expect(gameClock(0)).toBe("1:55");
    expect(gameClock(13)).toBe("1:42");
    expect(gameClock(130)).toBe("0:00");
    expect(gameClock(null)).toBe("—");
  });
  it("écrit les nombres à la française", () => {
    expect(num(1.1234)).toBe("1,12");
    expect(num(87.6, 0)).toBe("88");
    expect(num(-0.5)).toBe("−0,50");
    expect(num(null)).toBe("—");
    expect(num(Number.NaN)).toBe("—");
  });
  it("met une espace fine avant le pourcentage", () => {
    expect(pct(54.4)).toBe("54 %");
    expect(pct(undefined)).toBe("—");
  });
  it("signe les écarts", () => {
    expect(signed(3.04)).toBe("+3,0");
    expect(signed(-12, 0)).toBe("−12");
    expect(signed(0)).toBe("0,0");
  });
  it("affiche les durées", () => {
    expect(secs(42.4)).toBe("42 s");
    expect(clock(83)).toBe("1:23");
    expect(clock(5)).toBe("0:05");
    expect(clock(null)).toBe("—");
  });
  it("lit une date locale sans fuseau", () => {
    const d = parseLocal("2026-10-21T20:05");
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([2026, 9, 21, 20, 5]);
    expect(parseLocal("2026-10-21").getHours()).toBe(0);
  });
  it("lit un événement du calendrier en UTC comme un instant (heure locale de chacun)", () => {
    expect(parseLocal("2026-10-28T19:30:00Z").toISOString()).toBe("2026-10-28T19:30:00.000Z");
    expect(parseLocal("2026-10-28T20:30:00+01:00").toISOString()).toBe("2026-10-28T19:30:00.000Z");
  });
  it("lit les horodatages UTC du serveur (sans fuseau)", () => {
    expect(parseUtc("2026-10-19T16:00:00").toISOString()).toBe("2026-10-19T16:00:00.000Z");
    expect(parseUtc("2026-10-19T16:00:00Z").toISOString()).toBe("2026-10-19T16:00:00.000Z");
    expect(parseUtc("2026-10-19T18:00:00+02:00").toISOString()).toBe("2026-10-19T16:00:00.000Z");
  });
  it("compte à rebours", () => {
    const now = new Date(2026, 9, 19, 18, 0);
    expect(countdown(new Date(2026, 9, 19, 18, 12), now)).toBe("dans 12 min");
    expect(countdown(new Date(2026, 9, 19, 23, 0), now)).toBe("dans 5 h");
    expect(countdown(new Date(2026, 9, 21, 20, 0), now)).toBe("dans 2 j");
    expect(countdown(new Date(2026, 9, 19, 17, 0), now)).toBe("commencé");
  });
  it("date courte", () => {
    const now = new Date(2026, 9, 19, 18, 0);
    expect(shortDate("2026-10-19", now)).toBe("aujourd'hui");
    expect(shortDate("2026-10-18T22:00", now)).toBe("hier");
    expect(shortDate("2026-10-20", now)).toBe("demain");
    expect(shortDate("2026-10-12", now)).toBe("12 oct.");
    expect(shortDate("2025-03-02", now)).toBe("2 mars 2025");
    expect(shortDate(null, now)).toBe("—");
    expect(time(new Date(2026, 9, 19, 9, 5))).toBe("09:05");
    expect(longDate(new Date(2026, 9, 20))).toBe("mardi 20 octobre");
  });
});
