import { describe, expect, it } from "vitest";
import type { GrenadeEvent } from "../../shared/api/types";
import type { GrenadeView } from "../replay/engine/state";
import { nadeLook, trail3d } from "./nades";

const view = (type: GrenadeView["type"], phase: GrenadeView["phase"], progress: number): GrenadeView =>
  ({ id: 1, type, phase, pos: [0, 0, 0], path: [], progress, thrower: "a" });

describe("apparence des utilitaires", () => {
  it("en vol : petite grenade", () => {
    expect(nadeLook(view("smoke", "flying", 0))).toEqual({ kind: "flight", radius: 4, opacity: 1 });
  });
  it("smoke : 144 unités, apparaît puis s'efface", () => {
    expect(nadeLook(view("smoke", "active", 0.5))).toEqual({ kind: "smoke", radius: 144, opacity: 0.85 });
    expect(nadeLook(view("smoke", "active", 0.99)).opacity).toBeCloseTo(0.085, 6);
    expect(nadeLook(view("smoke", "active", 0)).opacity).toBe(0);
  });
  it("feu, flash, HE, leurre", () => {
    expect(nadeLook(view("molotov", "active", 0.5))).toEqual({ kind: "fire", radius: 120, opacity: 0.6 });
    expect(nadeLook(view("he", "active", 0.5))).toEqual({ kind: "burst", radius: 350, opacity: 0.5 });
    expect(nadeLook(view("flash", "active", 0.1)).radius).toBeCloseTo(100, 6);
    expect(nadeLook(view("decoy", "active", 0.5)).kind).toBe("decoy");
  });
});

describe("trajectoire 3D", () => {
  const g = { trajectory: [[100, 0, 0, 0], [110, 100, 0, 50], [120, 200, 0, 0]] } as unknown as GrenadeEvent;
  it("s'arrête à l'instant, point intermédiaire interpolé", () => {
    expect(trail3d(g, 105)).toEqual([[0, 0, 0], [50, 0, 25]]);
  });
  it("complète après la fin", () => {
    expect(trail3d(g, 999)).toHaveLength(3);
  });
});
