import { describe, expect, it } from "vitest";
import type { KillEvent } from "../../shared/api/types";
import type { Replay } from "../replay/engine/replay";
import type { PlayerState } from "../replay/engine/state";
import { CUT_ABOVE, CUT_FLOOR, CUT_KEEP, CUT_RADIUS, followPose, freeStep, grounded, orbitCut, playZone, POV_FOV, povFov,
  povPose, povVfov, SCOPES, scopeFov, scopeKind, topCut, tvTarget, vfovFrom43 } from "./cameras";

const player = (steamid: string, x: number, alive = true): PlayerState => ({
  steamid, name: steamid, side: "CT", slot: 1, x, y: 0, z: 0, yaw: 0, hp: 100, armor: 100, alive, helmet: false,
  defuser: false, hasBomb: false, defusing: false, scoped: false, flash: 0, money: 0, weapon: "", inventory: [], equip: 0,
  pitch: 0, duck: 0, airborne: false, clip: null, reserve: null, zoom: 0, keys: 0, crosshair: null,
  fov: 0, viewmodel: null });
const kill = (tick: number, attacker: string): KillEvent => ({
  tick, attacker, victim: "v", assister: null, weapon: "ak47", headshot: false, penetrated: 0, through_smoke: false,
  noscope: false, attacker_blind: false, flash_assist: false, attacker_pos: null, victim_pos: [0, 0, 0],
  is_opening: false, is_trade: false });
const players = [player("a", 0), player("b", 500), player("c", 1000)];
const none = { sid: null, since: 0 };

describe("caméra TV", () => {
  it("suit le tueur du prochain kill s'il survient dans les 5 s", () => {
    expect(tvTarget([kill(1000 + 64 * 4, "b")], players, null, 1000, 64, "a", none)).toEqual({ sid: "b", since: 1000 });
  });
  it("ignore un kill trop lointain et prend le joueur choisi", () => {
    expect(tvTarget([kill(1000 + 64 * 6, "b")], players, null, 1000, 64, "c", none).sid).toBe("c");
  });
  it("garde un plan au moins 3 s, sauf si son joueur meurt", () => {
    const shot = { sid: "a", since: 1000 };
    expect(tvTarget([kill(1100, "b")], players, null, 1000 + 64 * 2, 64, null, shot)).toBe(shot);
    const dead = [player("a", 0, false), players[1], players[2]];
    expect(tvTarget([kill(1200, "b")], dead, null, 1000 + 64, 64, null, shot).sid).toBe("b");
  });
  it("sans kill ni joueur choisi : le vivant le plus proche de la bombe", () => {
    expect(tvTarget([], players, [900, 0, 0], 1000, 64, null, none).sid).toBe("c");
  });
});

describe("poses", () => {
  it("vue du joueur à hauteur d'yeux", () => {
    expect(povPose(player("a", 10))).toEqual({ eye: [10, 0, 64], dir: [1, 0, 0] });
  });
  it("suivi : à la distance demandée du point visé, au-dessus de lui", () => {
    const { pos, look } = followPose(player("a", 0), 45, 30, 500);
    expect(Math.hypot(pos[0] - look[0], pos[1] - look[1], pos[2] - look[2])).toBeCloseTo(500, 6);
    expect(pos[2]).toBeGreaterThan(look[2]);
  });
  it("caméra libre : avance dans le sens du regard, se décale à droite, ×3 avec Maj", () => {
    const keys = { fwd: true, back: false, left: false, right: false, up: false, down: false };
    expect(freeStep({ pos: [0, 0, 0], yaw: 0, pitch: 0 }, keys, 1, false).pos[0]).toBeCloseTo(600, 6);
    const right = freeStep({ pos: [0, 0, 0], yaw: 90, pitch: 0 }, { ...keys, fwd: false, right: true }, 1, true).pos;
    expect(right[0]).toBeCloseTo(1800, 6);
  });
});

describe("coupe de la carte", () => {
  it("suivi : percée de la caméra jusqu'à 100 unités du buste, jamais sous les pieds", () => {
    const cut = orbitCut([0, 0, 0], [500, 0, 0], -48);
    expect(cut.from).toEqual([0, 0, 0]);
    expect(cut.to[0]).toBeCloseTo(500 - CUT_KEEP, 6);
    expect(cut.radius).toBe(CUT_RADIUS);
    expect(cut.floorZ).toBe(-48 + CUT_FLOOR);
    expect(cut.aboveZ).toBe(Infinity);
  });
  it("suivi : rien à percer si la caméra est déjà tout près", () => {
    expect(orbitCut([0, 0, 0], [CUT_KEEP / 2, 0, 0], -48).radius).toBe(0);
  });
  it("dessus : hauteur au sol, la plus basse des positions récentes (un saut ne déplace pas la coupe)", () => {
    const ps = [{ ...player("a", 0), z: 60 }, { ...player("b", 0), z: 10 }];
    const out = grounded(ps, (k) => (k === 0 ? [0, 30, 60] : [10, 20]));
    expect(out[0].z).toBe(0);
    expect(out[1]).toBe(ps[1]);
  });
  it("dessus : coupe au-dessus du joueur choisi, sinon de la hauteur médiane des vivants", () => {
    const ps = [{ ...player("a", 0), z: -400 }, { ...player("b", 0), z: 50 }, { ...player("c", 0, false), z: 900 },
      { ...player("d", 0), z: 300 }];
    expect(topCut(ps, "a").aboveZ).toBe(-400 + CUT_ABOVE);
    expect(topCut(ps, null).aboveZ).toBe(50 + CUT_ABOVE);
    expect(topCut(ps, "c").aboveZ).toBe(50 + CUT_ABOVE);
    expect(topCut([], null).aboveZ).toBe(Infinity);
    expect(topCut(ps, null).radius).toBe(0);
  });
});

describe("zone jouable", () => {
  // un joueur vivant, immobile en (100, 200, 10)
  const replay = (map_name: string) => ({ n: 16, payload: { map_name }, players: [{ index: 0 }],
    value: (f: string) => ({ flags: 1, x: 100, y: 200, z: 10 })[f] ?? 0 }) as unknown as Replay;
  it("positions des vivants du replay de la carte posée, élargies", () => {
    expect(playZone(replay("de_nuke"), "de_nuke")).toEqual({ min: [-1400, -1300, -390], max: [1600, 1700, 410] });
  });
  it("replay d'une autre carte (match précédent encore affiché pendant le chargement) : pas de zone", () => {
    expect(playZone(replay("de_mirage"), "de_nuke")).toBeNull();
    expect(playZone(null, "de_nuke")).toBeNull();
  });
});

describe("vue du joueur", () => {
  it("regard exact : l'angle vertical de CS2 est positif vers le bas", () => {
    const { dir } = povPose({ ...player("a", 0), yaw: 90, pitch: 30 });
    expect(dir[0]).toBeCloseTo(0, 9);
    expect(dir[1]).toBeCloseTo(Math.cos(Math.PI / 6), 9);
    expect(dir[2]).toBeCloseTo(-0.5, 9);
    expect(povPose({ ...player("a", 0), pitch: -45 }).dir[2]).toBeCloseTo(Math.SQRT1_2, 9);
  });
  it("angle vertical nul : composante verticale 0, pas −0", () => {
    expect(Object.is(povPose({ ...player("a", 0), pitch: 0 }).dir[2], 0)).toBe(true);
  });
  // Recul de la caméra (Replay.punchAt) : [vertical, horizontal] en degrés, dans la convention de `pitch` (négatif = vers le
  // haut) ; relevé sur Nuke, rafale d'AK-47 : [-1,099, -0,568] au premier tir, [-1,932, 0,336] au sixième
  it("recul : s'ajoute tel quel au regard du joueur (AK-47 : vertical négatif = la vue monte ; lacet positif = vers la gauche)", () => {
    const flat = { ...player("a", 0), yaw: 0, pitch: 0 };
    expect(povPose(flat).dir).toEqual([1, 0, 0]);
    const { dir } = povPose(flat, [-1.099, -0.568]);
    const deg = Math.PI / 180;
    expect(dir[2]).toBeCloseTo(Math.sin(1.099 * deg), 9);  // plus haut qu'à plat
    expect(dir[1]).toBeCloseTo(Math.cos(1.099 * deg) * Math.sin(-0.568 * deg), 9);  // et un peu à droite
    // la somme des angles : pitch + recul, yaw + recul (joueur qui regarde déjà vers le bas et vers le nord)
    const sum = povPose({ ...player("a", 0), yaw: 90, pitch: 10 }, [-4, 2]).dir;
    const want = povPose({ ...player("a", 0), yaw: 92, pitch: 6 }).dir;
    sum.forEach((c, k) => expect(c).toBeCloseTo(want[k], 12));
  });
  it("sans recul : le regard exact d'avant ; composante verticale 0 et non −0 quand le recul annule l'angle", () => {
    const p = { ...player("a", 0), yaw: 33, pitch: 12 };
    expect(povPose(p, [0, 0])).toEqual(povPose(p));
    expect(Object.is(povPose({ ...player("a", 0), pitch: 2 }, [-2, 0]).dir[2], 0)).toBe(true);
  });
  it("regard + recul borné à ±89,9° : la vue ne passe jamais la verticale (pas de retournement pendant une rafale)", () => {
    const deg = Math.PI / 180;
    // regarde presque au zénith (−89 : CS2 positif vers le bas) et tire : −89 − 3 = −92 dépasserait la verticale
    const up = povPose({ ...player("a", 0), yaw: 0, pitch: -89 }, [-3, 0]).dir;
    expect(up[0]).toBeGreaterThan(0);  // toujours face au lacet du joueur, pas retourné vers l'arrière
    expect(up[0]).toBeCloseTo(Math.cos(89.9 * deg), 12);
    expect(up[2]).toBeCloseTo(Math.sin(89.9 * deg), 12);
    const down = povPose({ ...player("a", 0), yaw: 0, pitch: 89 }, [3, 0]).dir;
    expect(down[0]).toBeGreaterThan(0);
    expect(down[2]).toBeCloseTo(-Math.sin(89.9 * deg), 12);
    // dans les bornes : rien ne change
    const inside = povPose({ ...player("a", 0), yaw: 0, pitch: -80 }, [-5, 0]).dir;
    expect(inside[2]).toBeCloseTo(Math.sin(85 * deg), 12);
  });
  it("hauteur d'yeux selon l'accroupissement", () => {
    expect(povPose({ ...player("a", 0), z: 100, duck: 0 }).eye).toEqual([0, 0, 164]);
    expect(povPose({ ...player("a", 0), z: 100, duck: 1 }).eye).toEqual([0, 0, 146]);
    expect(povPose({ ...player("a", 0), z: 100, duck: 0.5 }).eye[2]).toBeCloseTo(155, 9);
  });
});

describe("champ de vision", () => {
  it("FOV de CS2 (largeur sur un écran 4:3) → angle vertical de three.js", () => {
    expect(vfovFrom43(90)).toBeCloseTo(73.7398, 3);
    expect(POV_FOV).toBe(vfovFrom43(90));
    expect(vfovFrom43(40)).toBeCloseTo(30.5369, 3);
  });
  it("cadrage selon la fenêtre : le FOV horizontal est celui de CS2 plein écran sur un écran de la forme de la fenêtre", () => {
    const win = 1024 / 768;
    // vue = fenêtre : inchangé
    expect(povVfov(90, win, win)).toBeCloseTo(POV_FOV, 9);
    // valeurs relevées (fenêtre 1024 × 768)
    expect(povVfov(90, win, 948 / 627)).toBeCloseTo(66.96, 2);
    expect(povVfov(90, win, 588 / 535)).toBeCloseTo(84.6, 2);
    expect(povVfov(40, win, 948 / 627)).toBeCloseTo(27.07, 2);
    expect(povVfov(10, win, 948 / 627)).toBeCloseTo(6.62, 2);
    // vue plus large que la fenêtre : angle vertical plus étroit ; plus haute : plus large
    expect(povVfov(90, win, 2 * win)).toBeLessThan(POV_FOV);
    expect(povVfov(90, win, win / 2)).toBeGreaterThan(POV_FOV);
  });
  it("taille inconnue ou nulle (vue pas encore mesurée) : pas de correction", () => {
    expect(povVfov(90, 0, 1.5)).toBeCloseTo(POV_FOV, 9);
    expect(povVfov(90, 1.5, 0)).toBeCloseTo(POV_FOV, 9);
    expect(povVfov(90, NaN, 1.5)).toBeCloseTo(POV_FOV, 9);
  });
  it("FOV de la vue du joueur : celui de la démo d'abord, puis la lunette de l'arme, puis 90", () => {
    const awp = { weapon: "AWP", scoped: true, zoom: 2 };
    expect(povFov({ ...awp, fov: 40 })).toBe(40);  // la démo l'emporte sur la table (10)
    expect(povFov({ ...awp, fov: 0 })).toBe(10);  // replay sans FOV : la table
    expect(povFov({ ...awp, scoped: false, fov: 0 })).toBe(90);
    expect(povFov({ weapon: "AK-47", scoped: false, zoom: 0, fov: 120 })).toBe(120);  // réglage inhabituel : suivi tel quel
    expect(povFov({ weapon: "AK-47", scoped: false, zoom: 0, fov: 0 })).toBe(90);
  });
  it("FOV de la démo illisible (négatif, 180 et plus, NaN) : repli sur la table", () => {
    const awp = { weapon: "AWP", scoped: true, zoom: 1 };
    for (const fov of [-5, 180, 255, NaN]) expect(povFov({ ...awp, fov })).toBe(40);
  });
  it("lunettes : deux zooms pour les snipers, un seul pour AUG et SG 553", () => {
    expect(Object.keys(SCOPES).sort()).toEqual(["AUG", "AWP", "G3SG1", "SCAR-20", "SG 553", "SSG 08"]);
    expect(scopeFov("AWP", 1, true)).toBe(40);
    expect(scopeFov("AWP", 2, true)).toBe(10);
    expect(scopeFov("SSG 08", 2, true)).toBe(15);
    expect(scopeFov("SCAR-20", 2, true)).toBe(15);
    expect(scopeFov("G3SG1", 1, true)).toBe(40);
    expect(scopeFov("AUG", 2, true)).toBe(45);
    expect(scopeFov("SG 553", 1, true)).toBe(45);
  });
  it("pas de visée, arme sans lunette : pas de zoom ; ancien replay sans niveau : zoom 1", () => {
    expect(scopeFov("AWP", 2, false)).toBeNull();
    expect(scopeFov("AK-47", 1, true)).toBeNull();
    expect(scopeFov("AWP", 0, true)).toBe(40);
  });
  it("cache noir pour les snipers, viseur pour AUG et SG 553", () => {
    expect(scopeKind("AWP", true)).toBe("sniper");
    expect(scopeKind("G3SG1", true)).toBe("sniper");
    expect(scopeKind("AUG", true)).toBe("sight");
    expect(scopeKind("SG 553", true)).toBe("sight");
    expect(scopeKind("AWP", false)).toBeNull();
    expect(scopeKind("M4A4", true)).toBeNull();
  });
});
