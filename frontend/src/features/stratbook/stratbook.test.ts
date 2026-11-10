import { describe, expect, it } from "vitest";
import { smoothStroke } from "./StratBoard";
import { STRAT_CATEGORIES, hostLabel } from "./strat";

describe("smoothStroke", () => {
  it("garde les extrémités et retire le tremblement d'un trait presque droit", () => {
    const shaky: [number, number][] = Array.from({ length: 60 }, (_, i) => [i * 5, 100 + (i % 2 ? 1 : -1)]);
    const out = smoothStroke(shaky);
    expect(out[0]).toEqual([0, 99]);
    expect(out[out.length - 1]).toEqual([295, 101]);
    expect(out.length).toBeLessThan(10);
  });
  it("garde un trait fermé (fin au point de départ) au lieu de l'effacer", () => {
    const loop: [number, number][] = [[0, 0], [40, 0], [40, 40], [0, 40], [0, 0]];
    expect(smoothStroke(loop).length).toBeGreaterThan(4);
  });
  it("arrondit un angle au lieu de le supprimer", () => {
    const corner: [number, number][] = [[0, 0], [50, 0], [100, 0], [100, 50], [100, 100]];
    const out = smoothStroke(corner);
    expect(out.length).toBeGreaterThan(3);
    expect(out.some(([x, y]) => x > 60 && x < 100 && y > 0 && y < 40)).toBe(true);
  });
});

describe("code couleur", () => {
  it("donne un libellé et une couleur à chaque genre de round", () => {
    for (const c of Object.values(STRAT_CATEGORIES)) expect(c.color).toMatch(/^#[0-9a-f]{6}$/);
  });
  it("nomme un lien par son libellé ou son site", () => {
    expect(hostLabel({ url: "https://www.cs2lens.com/match/x", label: "" })).toBe("cs2lens.com");
    expect(hostLabel({ url: "https://pracc.com/replay", label: "PRACC" })).toBe("PRACC");
  });
});
