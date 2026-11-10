import { describe, expect, it } from "vitest";

import type { MapMeta } from "@/api/types";

import { levelForZ, levelImage, toRadarFraction, worldToRadar } from "./radar";

const nuke: MapMeta = {
  name: "de_nuke", display_name: "Nuke", pos_x: -3453, pos_y: 2887, scale: 7, image: "de_nuke.png",
  levels: [{ name: "upper", image: "de_nuke.png", z_min: -495, z_max: 99999 },
    { name: "lower", image: "de_nuke_lower.png", z_min: -99999, z_max: -495 }],
  bomb_a: null, bomb_b: null,
};

describe("radar", () => {
  it("passe du monde au radar 1024 px", () => {
    expect(worldToRadar(nuke, -3453, 2887)).toEqual([0, 0]);
    expect(worldToRadar(nuke, -3453 + 7 * 512, 2887 - 7 * 256)).toEqual([512, 256]);
    expect(toRadarFraction(nuke, -3453 + 7 * 512, 2887 - 7 * 1024)).toEqual([0.5, 1]);
  });
  it("choisit l'étage selon la hauteur", () => {
    expect(levelForZ(nuke, 0)).toBe("upper");
    expect(levelForZ(nuke, -600)).toBe("lower");
    expect(levelImage(nuke, "lower")).toBe("de_nuke_lower.png");
    expect(levelImage(nuke, "inconnu")).toBe("de_nuke.png");
  });
});
