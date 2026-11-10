import { describe, expect, it } from "vitest";
import { revealShift } from "./draw";

describe("revealShift", () => {
  it("ne bouge pas une trajectoire déjà visible à gauche du panneau", () => {
    expect(revealShift(100, 500, 800)).toBe(0);
  });

  it("décale vers la gauche une trajectoire cachée sous le panneau", () => {
    expect(revealShift(600, 900, 800)).toBe(800 - 24 - 900);
  });

  it("ne pousse pas le début de la trajectoire hors de l'écran", () => {
    expect(revealShift(100, 1200, 800)).toBe(24 - 100);
  });

  it("ramène une trajectoire sortie à gauche", () => {
    expect(revealShift(-200, -50, 800)).toBe(224);
  });

  it("ne fait rien quand le panneau couvre presque tout le radar", () => {
    expect(revealShift(600, 900, 120)).toBe(0);
  });
});
