import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Line, LineBasicMaterial, Mesh, MeshBasicMaterial, MeshLambertMaterial, type Object3D, Plane, Sprite, Vector3 } from "three";
import type { GrenadeEvent } from "../../shared/api/types";
import type { Replay } from "../replay/engine/replay";
import type { Theme } from "../replay/renderer/theme";
import { BombMarker, NadeLayer } from "./nadeLayer";

const theme: Theme = { ct: "#5d9cec", t: "#e8b04b", smoke: "#cccccc", fire: "#ff6a00", flash: "#ffffff", he: "#ff3b3b",
  fg: "#e6e9ec", bg: "#0c0f12", accent: "#2ee6a6" };
// grenade lancée et posée à la hauteur z
const nade = (id: number, type: GrenadeEvent["type"], detonate: number | null, z = 0): GrenadeEvent => ({
  id, type, thrower: "a", throw_tick: 0, throw_pos: [0, 0, z], detonate_tick: detonate, detonate_pos: [100, 0, z],
  end_tick: detonate === null ? null : detonate + 1000, trajectory: [[0, 0, 0, z], [50, 50, 0, z + 80], [100, 100, 0, z]] });
const replayOf = (grenades: GrenadeEvent[]) => ({ tickrate: 64, payload: { grenades } }) as unknown as Replay;

const meshes = (root: Object3D) => { const out: Mesh[] = []; root.traverse((o) => { if (o instanceof Mesh) out.push(o); }); return out; };
const lines = (root: Object3D) => { const out: Line[] = []; root.traverse((o) => { if (o instanceof Line) out.push(o); }); return out; };

// pas de canvas en node : un contexte 2D qui ne dessine rien suffit aux étiquettes
beforeEach(() => {
  const ctx = new Proxy({}, { get: () => () => {}, set: () => true });
  vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) });
});
afterEach(() => vi.unstubAllGlobals());

describe("coupe « au-dessus de » des grenades", () => {
  it("trajectoires coupées au plan partagé ; volumes, nappes et éclats jamais coupés en travers (creux vus d'en haut)", () => {
    const clip = [new Plane(new Vector3(0, 0, -1), 1e9)], layer = new NadeLayer(theme, clip);
    // smoke et feu posés, HE encore en vol à l'instant 120
    layer.update(replayOf([nade(1, "smoke", 100), nade(2, "molotov", 100), nade(3, "he", 200)]), 120);
    const trails = lines(layer.group), vols = meshes(layer.group);
    expect(trails).toHaveLength(3);
    for (const t of trails) {
      expect(t.material).toBeInstanceOf(LineBasicMaterial);
      expect((t.material as LineBasicMaterial).clippingPlanes).toBe(clip);  // le même tableau : un seul plan à déplacer
    }
    expect(vols.map((m) => m.material.constructor)).toEqual(expect.arrayContaining([MeshLambertMaterial, MeshBasicMaterial]));
    for (const m of vols) expect((m.material as MeshBasicMaterial).clippingPlanes ?? []).toHaveLength(0);
  });
  it("une grenade au-dessus de la coupe est cachée en entier, celle de l'étage suivi reste pleine", () => {
    const layer = new NadeLayer(theme, []), r = replayOf([nade(1, "smoke", 100, 0), nade(2, "smoke", 100, 400)]);
    const at = (z: number) => meshes(layer.group).find((m) => m.position.z > z - 50 && m.position.z < z + 200)!;
    layer.update(r, 120);
    expect([at(0).visible, at(400).visible]).toEqual([true, true]);
    layer.cutAbove(120);
    expect([at(0).visible, at(400).visible]).toEqual([true, false]);
    layer.update(r, 180);  // instant suivant : la coupe reste
    expect([at(0).visible, at(400).visible]).toEqual([true, false]);
    layer.cutAbove(Infinity);  // autre caméra
    expect([at(0).visible, at(400).visible]).toEqual([true, true]);
  });
});

describe("aides d'analyse (vue du joueur : trajectoires cachées, effets visibles gardés)", () => {
  // smoke et feu posés, HE encore en vol à l'instant 120
  const r = replayOf([nade(1, "smoke", 100), nade(2, "molotov", 100), nade(3, "he", 200)]);
  const visible = (root: Object3D) => ({ trails: lines(root).filter((l) => l.visible).length,
    volumes: meshes(root).filter((m) => m.visible).length });
  it("sans aides : plus de trajectoires, mais la fumée, le feu et la grenade en vol restent visibles", () => {
    const layer = new NadeLayer(theme, []);
    layer.setAids(false);
    layer.update(r, 120);
    expect(visible(layer.group)).toEqual({ trails: 0, volumes: 3 });
  });
  it("avec les aides (autres caméras, et par défaut) : une trajectoire par grenade", () => {
    const layer = new NadeLayer(theme, []);
    layer.update(r, 120);
    expect(visible(layer.group)).toEqual({ trails: 3, volumes: 3 });
    layer.setAids(true);
    layer.update(r, 120);
    expect(visible(layer.group)).toEqual({ trails: 3, volumes: 3 });
  });
  it("changer de caméra sans nouvel instant : les trajectoires disparaissent puis reviennent aussitôt", () => {
    const layer = new NadeLayer(theme, []);
    layer.update(r, 120);
    layer.setAids(false);
    expect(visible(layer.group)).toEqual({ trails: 0, volumes: 3 });
    layer.update(r, 140);  // l'instant avance : toujours sans trajectoires
    expect(visible(layer.group)).toEqual({ trails: 0, volumes: 3 });
    layer.setAids(true);
    expect(visible(layer.group)).toEqual({ trails: 3, volumes: 3 });
    expect(lines(layer.group).every((l) => (l.geometry.getAttribute("position")?.count ?? 0) > 1)).toBe(true);  // à jour, pas vides
  });
});

describe("coupe « au-dessus de » de la bombe", () => {
  it("au-dessus de la coupe : repère et étiquette cachés ensemble ; en dessous ou sans coupe : visibles", () => {
    const bomb = new BombMarker(theme), planted = (z: number) => ({ state: "planted", pos: [0, 0, z] as [number, number, number], plantTick: 0 });
    bomb.update(planted(400), 64, 64);
    expect(bomb.group.visible).toBe(true);
    bomb.cutAbove(120);
    expect(bomb.group.visible).toBe(false);
    bomb.update(planted(400), 128, 64);  // instant suivant : la coupe reste
    expect(bomb.group.visible).toBe(false);
    bomb.update(planted(100), 128, 64);
    expect(bomb.group.visible).toBe(true);
    bomb.update({ state: "carried", pos: null, plantTick: null }, 128, 64);
    expect(bomb.group.visible).toBe(false);
    bomb.update(planted(400), 128, 64);
    bomb.cutAbove(Infinity);
    expect(bomb.group.visible).toBe(true);
  });
});

describe("bombe en vue du joueur (la bombe se voit, sans étiquette à travers les murs)", () => {
  it("sans aides : l'étiquette (« C4 » ou secondes) est cachée, le repère reste ; les aides reviennent : l'étiquette aussi", () => {
    const bomb = new BombMarker(theme);
    const label = () => bomb.group.children.find((o) => o instanceof Sprite)!;
    const box = () => bomb.group.children.find((o) => o instanceof Mesh)!;
    bomb.update({ state: "planted", pos: [0, 0, 0], plantTick: 0 }, 64, 64);
    expect([bomb.group.visible, box().visible, label().visible]).toEqual([true, true, true]);
    bomb.setAids(false);
    expect([bomb.group.visible, box().visible, label().visible]).toEqual([true, true, false]);
    bomb.update({ state: "planted", pos: [0, 0, 0], plantTick: 0 }, 128, 64);  // instant suivant : toujours cachée
    expect(label().visible).toBe(false);
    bomb.setAids(true);
    expect(label().visible).toBe(true);
  });
});
