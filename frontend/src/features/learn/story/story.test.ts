import { describe, expect, it } from "vitest";
import type { StoryRound, StoryStep } from "../../../shared/api/types";
import { bestRound, BUY_LABEL, buyList, pathUntil, roundClock, situation, stepText } from "./story";

const name = (p: string | null | undefined) => (p ? p.replace("Bombsite", "Site ") : null);
const S = (o: Partial<StoryStep>): StoryStep => ({ kind: "end", t: 0, tick: 0, pos: [0, 0, 0], place: null, mates: [], enemies: [], enemy_utility: [], ...o });
const R = (o: Partial<StoryRound>): StoryRound => ({
  number: 1, side: "CT", won: true, kills: 0, died: false, buy: "full", poste: null, start_tick: 0, end_tick: 100,
  round_end_tick: 100, path: [], steps: [], plant_t: null, ...o,
});

describe("histoire d'un round", () => {
  it("conseille un round armé typique de sa routine (poste habituel)", () => {
    const rs = [R({ number: 1, buy: "pistol", won: true, kills: 3 }), R({ number: 4, buy: "full", poste: "Banana", won: true }),
      R({ number: 5, buy: "full", poste: "Banana", won: false }), R({ number: 6, buy: "full", poste: "Apps", won: true, kills: 2 }), R({ number: 7, buy: "full", poste: "Banana", won: true, kills: 1 })];
    expect(bestRound(rs)?.number).toBe(7);
    expect(bestRound([R({ number: 2, buy: "eco", won: true })])?.number).toBe(2);
    expect(BUY_LABEL.full).toBe("Armé");
  });
  it("regroupe les achats en double", () => {
    expect(buyList(["AK-47", "Flashbang", "Flashbang", "Kevlar & Helmet"])).toBe("AK-47, Flash ×2, Kevlar + casque");
  });
  it("raconte chaque étape en une phrase", () => {
    expect(stepText(S({ kind: "buy", items: [] }), name).text).toMatch(/N'achète rien/);
    expect(stepText(S({ kind: "buy", items: [], weapon: "AK-47" }), name).text).toContain("joue avec **AK-47**");
    expect(stepText(S({ kind: "place", first: true, place: "BombsiteB" }), name)).toEqual({ title: "Son poste", text: "Se place à **Site B**" });
    expect(stepText(S({ kind: "place", first: false, place: "Mini" }), name).title).toBe("Rotation");
    expect(stepText(S({ kind: "nade", nade: "incendiary", place: "Heaven", target_place: "Squeaky" }), name).text)
      .toBe("Lance une incendiaire vers **Squeaky** depuis Heaven");
    expect(stepText(S({ kind: "nade", nade: "decoy", place: null }), name).text).toBe("Lance un leurre");
    const k = stepText(S({ kind: "kill", victim: "ropz", weapon: "ak47", headshot: true, opening: true, place: "Outside" }), name);
    expect(k).toEqual({ title: "Premier kill du round", text: "Élimine **ropz** à AK-47 (headshot) depuis **Outside**" });
    expect(stepText(S({ kind: "death", attacker: "broky", weapon: "awp", place: "Ramp" }), name).text).toBe("Meurt contre **broky** (AWP) à **Ramp**");
    expect(stepText(S({ kind: "death", attacker: null, place: null }), name).text).toBe("Meurt");
    expect(stepText(S({ kind: "end", won: true, alive: true }), name).title).toBe("Round gagné");
    expect(stepText(S({ kind: "plant", site: "A" }), name).text).toBe("Pose la bombe sur le site **A**");
  });
  it("conseille un round gagné avec des kills et en vie", () => {
    const rs = [R({ number: 1, won: false, kills: 3 }), R({ number: 2, won: true, kills: 1, died: true }), R({ number: 3, won: true, kills: 2 })];
    expect(bestRound(rs)?.number).toBe(3);
    expect(bestRound([])).toBeUndefined();
  });
  it("coupe le trajet à l'instant de l'étape", () => {
    const r = R({ path: [[0, 1, 1, 0], [1, 2, 2, 0], [2, 3, 3, 0]] });
    expect(pathUntil(r, 1)).toEqual([[1, 1, 0], [2, 2, 0]]);
  });
  it("affiche l'horloge du jeu : 1:55 qui descend, puis la bombe", () => {
    expect(roundClock(0, null)).toEqual({ text: "1:55", bomb: false });
    expect(roundClock(11.2, null)).toEqual({ text: "1:44", bomb: false });
    expect(roundClock(130, null).text).toBe("0:00");
    expect(roundClock(70, 60)).toEqual({ text: "0:30", bomb: true });
    expect(roundClock(59, 60).bomb).toBe(false);
  });
  it("résume la situation autour du joueur", () => {
    const st = S({ kind: "place", pos: [0, 0, 0],
      mates: [{ name: "frozen", pos: [500, 0, 0] }, { name: "broky", pos: [2000, 0, 0] }],
      enemies: [{ name: "bodyy", pos: [0, 0, 0] }],
      enemy_utility: [{ type: "smoke", thrower: "bodyy", flying: false, pos: [10, 10, 0], trajectory: [] },
        { type: "flash", thrower: "Maka", flying: true, pos: null, trajectory: [] }] });
    const sit = situation(st, () => "Outside");
    expect(sit.mates).toBe(3);
    expect(sit.enemies).toBe(1);
    expect(sit.nearest).toEqual({ name: "frozen", meters: 10 });
    expect(sit.utility).toEqual([
      { type: "smoke", label: "smoke", flying: false, where: "Outside", thrower: "bodyy" },
      { type: "flash", label: "flash", flying: true, where: null, thrower: "Maka" },
    ]);
    expect(situation(S({ kind: "death", mates: [] }), () => null).mates).toBe(0);
  });
});
