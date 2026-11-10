import { describe, expect, it } from "vitest";

import type { CalloutPlace } from "@/api/types";

import { nearestPlace, parseSetpos } from "./lineups";

describe("lineups", () => {
  it("lit la commande setpos", () => {
    expect(parseSetpos("setpos 2035.97 1914.94 172.20;setang -38.71 -159.16 0"))
      .toEqual({ pos: [2035.97, 1914.94, 172.2], pitch: -38.71, yaw: -159.16 });
    expect(parseSetpos(null)).toBeNull();
    expect(parseSetpos("n'importe quoi")).toBeNull();
  });
  it("nomme un point par le lieu connu le plus proche", () => {
    const places: CalloutPlace[] = [
      { place: "BombsiteA", label: null, count: 40, pos: [100, 100, 0] },
      { place: "Middle", label: "Mid", count: 30, pos: [900, 900, 0] },
      { place: "Nowhere", label: null, count: 3, pos: null },
    ];
    expect(nearestPlace(places, [120, 90, 0])).toBe("Bombsite A");
    expect(nearestPlace(places, [850, 950, 0])).toBe("Mid");
    expect(nearestPlace(places, [5000, 5000, 0])).toBeNull(); // trop loin de tout lieu connu
    expect(nearestPlace([], [0, 0, 0])).toBeNull();
  });
});
