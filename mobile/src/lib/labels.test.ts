import { describe, expect, it } from "vitest";

import { mapLabel, placeLabel, weaponLabel } from "./labels";

describe("libellés", () => {
  it("rend lisibles les noms de lieux du jeu", () => {
    expect(placeLabel("CTSpawn")).toBe("CT Spawn");
    expect(placeLabel("BombsiteB")).toBe("Bombsite B");
    expect(placeLabel("LongDoors")).toBe("Long Doors");
    expect(placeLabel("Middle")).toBe("Middle");
    expect(placeLabel("Mid")).toBe("Mid");
    expect(placeLabel(null)).toBe("");
  });
  it("noms d'armes et de cartes", () => {
    expect(weaponLabel("m4a1_silencer")).toBe("M4A1-S");
    expect(weaponLabel("knife_karambit")).toBe("Couteau");
    expect(mapLabel("de_dust2")).toBe("Dust2");
    expect(mapLabel("de_dust2", "Dust II")).toBe("Dust II");
  });
});
