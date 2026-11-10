import { describe, expect, it } from "vitest";
import type { BombEvent, KillEvent } from "../../shared/api/types";
import type { Replay } from "../replay/engine/replay";
import { F } from "../replay/engine/state";
import {
  ACT_FADE, type AgentPose, agentPose, AIR_IN, AIR_OUT, bearing, CLASS_FADE, type ClipDur, cycleLen, DEATH_FADE, DIRS8, DROP_AHEAD,
  DROP_RIGHT,
  dirWeights8, droppedWeapons, dyingPose, GROUND_BELOW, GAIT, GAIT_BACK, GAIT_SIDE, gaitPhase, JUMP_S, LAND_FADE, LAND_HOLD, locoClass, MIN_AIR_S, PICK_DZ, PICK_R, PLANT_S, RUN_V, TELEPORT,
  velocityAt, WALK_V, warmAgentAnim,
} from "./agentAnim";
import { vmVariant } from "./viewmodelAnim";

const R = 64;
// durées des clips de test (s), comme dans le jeu : idle 0 (une image), marche 1, course 0,7333, accroupi 0,8…
const DUR: Record<string, number> = { idle: 0, idle_crouch: 0, jump_stand: 0.4, inair_stand: 0.3333, defuse_enter: 1, defuse: 2,
  defuse_crouch_enter: 1, defuse_crouch: 2,
  plant: 3.3, plant_crouch: 3.3, land_rifle: 0.6333, land_pistol: 0.6333, land_knife: 0.6333, mort_chest_a: 2.5, mort_chest_b: 2.4, mort_gut_a: 2,
  mort_gut_b: 2, mort_rknee_a: 2, mort_rknee_b: 2, mort_rshoulder: 2 };
for (const d of DIRS8) Object.assign(DUR, { [`walk_${d}`]: 1, [`run_${d}`]: 0.7333, [`crouch_${d}`]: 0.8 });
for (const d of ["stand", "n", "e", "s", "w"]) Object.assign(DUR, { [`jump_${d}`]: 0.4, [`inair_${d}`]: 0.3333, [`jump_crouch_${d}`]: 0.4, [`inair_crouch_${d}`]: 0.4 });
/** Durées : tous les clips de test, sauf ceux de `missing` (« clip » ou « jeu:clip »). */
const mkDur = (missing: string[] = []): ClipDur => (set, clip) =>
  missing.includes(clip) || missing.includes(`${set}:${clip}`) ? null : DUR[clip] ?? null;
const dur = mkDur();

interface Fake {
  x?: (i: number) => number; y?: (i: number) => number; yaw?: (i: number) => number; pitch?: (i: number) => number;
  duck?: (i: number) => number; flags?: (i: number) => number; weapon?: (i: number) => string; inv?: (i: number, j: number) => string[];
  kills?: Partial<KillEvent>[]; damages?: { tick: number; victim: string; hitgroup: string }[]; bomb?: Partial<BombEvent>[];
  noDuck?: boolean; side?: "CT" | "T"; bFlags?: (i: number) => number; step?: number; tickAt?: (i: number) => number;
  /** Un troisième joueur « c » (indice 2, CT), immobile en (x, y, z), en vie ; son inventaire vient de `inv(i, 2)`. */
  third?: { x: number; y: number; z?: number };
}
// 64 ticks/s, une image tous les 2 ticks (32 images/s ; `step` : autre cadence ; `tickAt` : ticks irréguliers) : l'image i
// est au tick 2i ; « b » (indice 1) : un autre joueur immobile en (5000, 5000), en vie sauf `bFlags`, pour les ramassages
function replay(o: Fake, n = 640): Replay {
  const f: Record<string, (i: number, j: number) => number> = {
    x: (i, j) => (j === 2 ? o.third!.x : j ? 5000 : o.x?.(i) ?? 0), y: (i, j) => (j === 2 ? o.third!.y : j ? 5000 : o.y?.(i) ?? 0),
    z: (_i, j) => (j === 2 ? o.third!.z ?? 0 : 0), yaw: (i, j) => (j ? 0 : o.yaw?.(i) ?? 0),
    pitch: (i, j) => (j ? 0 : o.pitch?.(i) ?? 0),
    flags: (i, j) => (j === 2 ? F.ALIVE : j ? o.bFlags?.(i) ?? F.ALIVE : o.flags?.(i) ?? F.ALIVE),
  };
  if (!o.noDuck) f.duck = (i, j) => (j ? 0 : Math.round((o.duck?.(i) ?? 0) * 255));
  return {
    ticks: Int32Array.from({ length: n }, (_, i) => o.tickAt?.(i) ?? (o.step ?? 2) * i), n, m: o.third ? 3 : 2, tickrate: R,
    players: [{ steamid: "a", name: "a", side: o.side ?? "T", slot: 1, index: 0 }, { steamid: "b", name: "b", side: "CT", slot: 1, index: 1 },
      ...(o.third ? [{ steamid: "c", name: "c", side: "CT" as const, slot: 2, index: 2 }] : [])],
    has: (k: string) => k in f, value: (k: string, i: number, j: number) => f[k](i, j),
    weaponAt: (i: number, j: number) => (j ? "AK-47" : o.weapon?.(i) ?? "AK-47"),
    inventoryAt: (i: number, j: number) => o.inv?.(i, j) ?? [],
    payload: { kills: o.kills ?? [], damages: o.damages ?? [], bomb: o.bomb ?? [] },
  } as unknown as Replay;
}
const pose = (r: Replay, tick: number, d = dur) => agentPose(r, tick, "a", d)!;
/** Poids par clip (« jeu:clip »), arrondis. */
const weights = (p: AgentPose) => Object.fromEntries(p.layers.map((l) => [`${l.set}:${l.clip}`, +l.w.toFixed(4)]));
const total = (p: AgentPose) => p.layers.reduce((s, l) => s + l.w, 0);
/** Avance de `speed` unités/s le long du lacet `yaw` (degrés), à partir de l'image 0. */
const moving = (speed: number, dirDeg = 0) => ({
  x: (i: number) => (Math.cos((dirDeg * Math.PI) / 180) * speed * 2 * i) / R,
  y: (i: number) => (Math.sin((dirDeg * Math.PI) / 180) * speed * 2 * i) / R,
});

describe("classe de déplacement et directions", () => {
  it("classe d'après l'arme : fusils et PM → rifle, pistolets et Zeus → pistol, le reste → knife", () => {
    expect(["AK-47", "AWP", "MP9", "Nova", "Negev"].map(locoClass)).toEqual(["rifle", "rifle", "rifle", "rifle", "rifle"]);
    expect(["Glock-18", "Desert Eagle", "Zeus x27"].map(locoClass)).toEqual(["pistol", "pistol", "pistol"]);
    expect(["Karambit", "knife_t", "Smoke Grenade", "C4 Explosive", ""].map(locoClass)).toEqual(["knife", "knife", "knife", "knife", "knife"]);
  });
  it("direction par rapport au regard : 0 devant, 90 à droite, 180 derrière, 270 à gauche (Y du jeu à gauche de X)", () => {
    expect(bearing(1, 0, 0)).toBeCloseTo(0, 9);
    expect(bearing(0, -1, 0)).toBeCloseTo(90, 9);
    expect(bearing(-1, 0, 0)).toBeCloseTo(180, 9);
    expect(bearing(0, 1, 0)).toBeCloseTo(270, 9);
    expect(bearing(0, 1, 90)).toBeCloseTo(0, 9);  // regard +Y, mouvement +Y : devant
  });
  it("8 directions : deux voisines mélangées, de somme 1 ; un multiple de 45° n'en donne qu'une", () => {
    expect(dirWeights8(0)).toEqual([[0, 1]]);
    expect(dirWeights8(90)).toEqual([[2, 1]]);
    const w = dirWeights8(22.5);
    expect(w.map(([k]) => k)).toEqual([0, 1]);
    expect(w[0][1]).toBeCloseTo(0.5, 9);
    const back = dirWeights8(350);  // entre nw (7) et n (0)
    expect(back.map(([k]) => k)).toEqual([7, 0]);
    expect(back[1][1]).toBeCloseTo(35 / 45, 9);  // 10° de n : 35/45 pour n
  });
});

describe("vitesse et pas", () => {
  it("vitesse : différence des positions autour du tick, bornée à l'instant de la mort", () => {
    const r = replay(moving(200, 30));
    const [vx, vy] = velocityAt(r, 0, 100);
    expect(Math.hypot(vx, vy)).toBeCloseTo(200, 6);
    expect((Math.atan2(vy, vx) * 180) / Math.PI).toBeCloseTo(30, 6);
    const still = replay({ x: (i) => (i < 50 ? 0 : 1000) });  // déplacé d'un coup à l'image 50 (tick 100)
    expect(velocityAt(still, 0, 80, 90)).toEqual([0, 0]);
  });
  it("phase des pas : distance / longueur du cycle à la vitesse et à l'accroupissement, un saut de position ignoré", () => {
    const r = replay(moving(250));
    // 250 u/s pendant 2 s : 500 u, cycle de course
    expect(gaitPhase(r, 0, 128)).toBeCloseTo(500 / GAIT.run, 6);
    const walk = replay(moving(100));
    expect(gaitPhase(walk, 0, 64)).toBeCloseTo(100 / GAIT.walk, 6);
    const crouch = replay({ ...moving(80), duck: () => 1 });
    expect(gaitPhase(crouch, 0, 64)).toBeCloseTo(80 / GAIT.crouch, 2);
    const tp = replay({ x: (i) => (i < 10 ? 0 : 3000) });
    expect(gaitPhase(tp, 0, 200)).toBe(0);
    expect(cycleLen(160, 0)).toBeGreaterThan(GAIT.walk);
    expect(cycleLen(160, 0)).toBeLessThan(GAIT.run);
  });
  it("longueurs des pas réglées à l'essai réel (pieds posés suivis dans le monde) : marche 114, course 150, accroupi 70", () => {
    expect(GAIT).toEqual({ walk: 114, run: 150, crouch: 70 });
    // accroupi à 70 u/s pendant 1 s : un cycle de clip
    expect(gaitPhase(replay({ ...moving(70), duck: () => 1 }), 0, 64)).toBeCloseTo(1, 2);
  });
  it("cycle par direction (essai réel) : de côté marche 100 et course 130, en arrière 114 et 150 ; devant et accroupi inchangés ; mélange en cos² / sin² de la direction", () => {
    expect([GAIT_SIDE, GAIT_BACK]).toEqual([{ walk: 100, run: 130 }, { walk: 114, run: 150 }]);
    expect([cycleLen(250, 0, 0), cycleLen(250, 0, 90), cycleLen(250, 0, 270), cycleLen(250, 0, 180)]).toEqual([150, 130, 130, 150]);
    expect([cycleLen(100, 0, 0), cycleLen(100, 0, 90), cycleLen(100, 0, 180)]).toEqual([114, 100, 114]);
    expect(cycleLen(250, 0, 45)).toBeCloseTo((150 + 130) / 2, 9);
    expect(cycleLen(250, 0, 135)).toBeCloseTo((150 + 130) / 2, 9);
    expect(cycleLen(70, 1, 90)).toBe(70);  // accroupi : le même dans toutes les directions
    // pas de côté vers la droite (regard +X, déplacement −Y) à 250 u/s pendant 2 s : 500 u, cycle de côté
    expect(gaitPhase(replay(moving(250, -90)), 0, 128)).toBeCloseTo(500 / 130, 6);
    expect(gaitPhase(replay(moving(250, 180)), 0, 128)).toBeCloseTo(500 / 150, 6);  // en arrière
  });
  it("vitesse bornée au kill : positions figées après le tick 200, la vitesse d'avant reste entière", () => {
    const r = replay({ x: (i) => (Math.min(i, 100) * 250 * 2) / R });
    expect(velocityAt(r, 0, 200, 200)[0]).toBeCloseTo(250, 6);
    expect(velocityAt(r, 0, 200)[0]).toBeCloseTo(125, 6);  // sans borne : moyennée avec l'arrêt qui suit
  });
  it("phase des pas calculée une fois par replay et par joueur", () => {
    const r = replay(moving(250)), value = r.value.bind(r);
    let reads = 0;
    Object.assign(r, { value: (k: string, i: number, j: number) => (reads++, value(k, i, j)) });
    gaitPhase(r, 0, 100);
    expect(reads).toBeGreaterThan(0);
    reads = 0;
    expect(gaitPhase(r, 0, 300)).toBeCloseTo((250 * 300) / R / GAIT.run, 6);
    expect(reads).toBe(0);
  });
  it("vitesse : un saut de position de plus de TELEPORT dans la fenêtre est ignoré, comme pour les pas", () => {
    const tp = replay({ x: (i) => (i < 50 ? 0 : 3000) });  // déplacé d'un coup à l'image 50 (tick 100)
    expect(3000).toBeGreaterThan(TELEPORT);
    expect(velocityAt(tp, 0, 100)).toEqual([0, 0]);
    expect(weights(pose(tp, 100))).toEqual({ "rifle:idle": 1 });
  });
  it("phase des pas continue quand la vitesse franchit WALK_V puis RUN_V : elle avance de vitesse / cycle à chaque tick", () => {
    const acc = 24;  // u/s² : 100 u/s au tick 0, 250 u/s au tick 400
    const r = replay({ x: (i) => { const s = (2 * i) / R; return 100 * s + (acc * s * s) / 2; } });
    let prev = gaitPhase(r, 0, 1), crossed = 0;
    for (let tick = 2; tick <= 398; tick++) {
      const ph = gaitPhase(r, 0, tick), v = 100 + (acc * (tick - 0.5)) / R;
      expect((ph - prev) / (v / R / cycleLen(v, 0))).toBeCloseTo(1, 1);
      if ((v - WALK_V) * (v - acc / R - WALK_V) <= 0 || (v - RUN_V) * (v - acc / R - RUN_V) <= 0) crossed++;
      prev = ph;
    }
    expect(crossed).toBe(2);
  });
});

describe("au sol", () => {
  it("immobile : idle seul ; accroupi à 20 % : idle 0,8 et idle_crouch 0,2", () => {
    expect(weights(pose(replay({}), 200))).toEqual({ "rifle:idle": 1 });
    expect(weights(pose(replay({ duck: () => 0.2 }), 200))).toEqual({ "rifle:idle": 0.8, "rifle:idle_crouch": 0.2 });  // 51 / 255
  });
  it("course vers l'avant : run_n, à la phase des pas (instant = phase × durée) ; marche : walk_n", () => {
    const r = replay(moving(250)), p = pose(r, 200);
    expect(weights(p)).toEqual({ "rifle:run_n": 1 });
    const ph = gaitPhase(r, 0, 200);
    expect(p.layers[0].t).toBeCloseTo((ph - Math.floor(ph)) * 0.7333, 6);
    expect(weights(pose(replay(moving(100)), 200))).toEqual({ "rifle:walk_n": 1 });
  });
  it("pas de côté vers la droite en regardant devant : run_e ; en diagonale avant droite : ne", () => {
    expect(weights(pose(replay(moving(250, -90)), 200))).toEqual({ "rifle:run_e": 1 });
    expect(weights(pose(replay(moving(250, -45)), 200))).toEqual({ "rifle:run_ne": 1 });
    expect(weights(pose(replay({ ...moving(250, 180), yaw: () => 0 }), 200))).toEqual({ "rifle:run_s": 1 });
  });
  it("entre marche et course : les deux, à la même phase normalisée ; poids de somme 1", () => {
    const p = pose(replay(moving(162.5)), 200), w = weights(p);
    expect(w["rifle:walk_n"]).toBeCloseTo(0.5, 3);
    expect(w["rifle:run_n"]).toBeCloseTo(0.5, 3);
    expect(p.layers[0].t / 1).toBeCloseTo(p.layers[1].t / 0.7333, 6);
    expect(total(p)).toBeCloseTo(1, 9);
  });
  it("accroupi en mouvement : crouch_<direction>", () => {
    expect(weights(pose(replay({ ...moving(80), duck: () => 1 }), 200))).toEqual({ "rifle:crouch_n": 1 });
  });
  it("replay sans duck (analysé avant le 30/10/2026) : debout", () => {
    expect(weights(pose(replay({ noDuck: true }), 200))).toEqual({ "rifle:idle": 1 });
  });
  it("classe d'après l'arme tenue, fondue sur 0,25 s au changement d'arme", () => {
    const r = replay({ weapon: (i) => (i < 100 ? "AK-47" : "Glock-18") });  // pistolet à partir du tick 200
    expect(weights(pose(r, 199))).toEqual({ "rifle:idle": 1 });
    const mid = weights(pose(r, 200 + (CLASS_FADE * R) / 2));
    expect(mid["pistol:idle"]).toBeCloseTo(0.5, 6);
    expect(mid["rifle:idle"]).toBeCloseTo(0.5, 6);
    expect(weights(pose(r, 200 + CLASS_FADE * R + 2))).toEqual({ "pistol:idle": 1 });
  });
  it("fondu de classe : la nouvelle monte de 0 à 1 (au quart du fondu : 0,25)", () => {
    const q = weights(pose(replay({ weapon: (i) => (i < 100 ? "AK-47" : "Glock-18") }), 200 + (CLASS_FADE * R) / 4));
    expect(q["pistol:idle"]).toBeCloseTo(0.25, 6);
    expect(q["rifle:idle"]).toBeCloseTo(0.75, 6);
  });
  it("clip absent : les autres poids sont ramenés à 1 ; aucun clip : null", () => {
    const p = pose(replay(moving(162.5)), 200, mkDur(["run_n"]));
    expect(weights(p)).toEqual({ "rifle:walk_n": 1 });
    expect(agentPose(replay({}), 200, "a", () => null)).toBeNull();
    expect(agentPose(replay({}), 200, "inconnu", dur)).toBeNull();
  });
  it("regard vertical (positif vers le bas) et arme en main (clé des fichiers)", () => {
    const p = pose(replay({ pitch: () => 25, weapon: () => "M4A1-S" }), 200);
    expect(p.aim).toBe(25);
    expect(p.weapon).toBe("m4a1_silencer");
    expect(pose(replay({ weapon: () => "Karambit", side: "T" }), 200).weapon).toBe("knife_t");
    expect(p.body).toBeNull();
  });
  it("regard vertical borné à ±89°", () => {
    expect(pose(replay({ pitch: () => 120 }), 200).aim).toBe(89);
    expect(pose(replay({ pitch: () => -120 }), 200).aim).toBe(-89);
  });
});

describe("en l'air", () => {
  // décolle à l'image 100 (tick 200), retombe à l'image 140 (tick 280)
  const jumpFlags = (i: number) => F.ALIVE | (i >= 100 && i < 140 ? F.AIRBORNE : 0);
  it("saut sur place : jump_stand pendant 0,4 s depuis le décollage (fondu d'entrée 0,1 s), puis inair_stand en boucle", () => {
    const r = replay({ flags: jumpFlags });
    const early = pose(r, 200 + (AIR_IN * R) / 2);
    expect(weights(early)["rifle:jump_stand"]).toBeCloseTo(0.5, 6);
    expect(weights(early)["rifle:idle"]).toBeCloseTo(0.5, 6);
    const later = pose(r, 200 + 0.2 * R);
    expect(weights(later)).toEqual({ "rifle:jump_stand": 1 });
    expect(later.layers[0].t).toBeCloseTo(0.2, 9);
    const fall = pose(r, 200 + (JUMP_S + 0.05) * R);
    expect(weights(fall)).toEqual({ "rifle:inair_stand": 1 });
    expect(fall.layers[0].t).toBeCloseTo(0.05, 9);
  });
  it("atterrissage après 1,25 s de vol, à l'arrêt : land_<classe> du jeu « communes », puis retour au sol", () => {
    const r = replay({ flags: jumpFlags });
    const p = pose(r, 280 + 0.05 * R);
    expect(weights(p)["communes:land_rifle"]).toBe(1);
    expect(p.layers.find((l) => l.clip === "land_rifle")!.t).toBeCloseTo(0.05, 9);
    expect(weights(pose(r, 280 + 0.6 * R))).toEqual({ "rifle:idle": 1 });
  });
  it("saut en courant vers l'avant : jump_n", () => {
    const r = replay({ ...moving(250), flags: jumpFlags });
    expect(weights(pose(r, 200 + 0.2 * R))).toEqual({ "rifle:jump_n": 1 });
  });
  it("saut accroupi : jump_crouch_stand", () => {
    expect(weights(pose(replay({ flags: jumpFlags, duck: () => 1 }), 200 + 0.2 * R))).toEqual({ "rifle:jump_crouch_stand": 1 });
  });
  it("saut en pas de côté : 4 directions en l'air (jump_e ; en diagonale, jump_n et jump_e), 8 au sol pendant le fondu", () => {
    expect(weights(pose(replay({ ...moving(250, -90), flags: jumpFlags }), 200 + 0.2 * R))).toEqual({ "rifle:jump_e": 1 });
    expect(weights(pose(replay({ ...moving(250, -45), flags: jumpFlags }), 200 + 0.2 * R))).toEqual({ "rifle:jump_n": 0.5, "rifle:jump_e": 0.5 });
    const fade = pose(replay({ ...moving(250, -90), flags: jumpFlags }), 200 + (AIR_IN * R) / 2);
    expect(weights(fade)).toEqual({ "rifle:run_e": 0.5, "rifle:jump_e": 0.5 });
  });
  it("atterrissage à l'arrêt : land_<classe> tenu LAND_HOLD, puis effacé sur LAND_FADE", () => {
    const p = pose(replay({ flags: jumpFlags }), 280 + 0.3 * R);
    const x = (0.3 - LAND_HOLD) / LAND_FADE, wl = 1 - x * x * (3 - 2 * x);
    expect(weights(p)["communes:land_rifle"]).toBeCloseTo(wl, 3);
    expect(weights(p)["rifle:idle"]).toBeCloseTo(1 - wl, 3);
    expect(p.layers.find((l) => l.clip === "land_rifle")!.t).toBeCloseTo(0.3, 9);
  });
  it("vol plus court que MIN_AIR_S : pas d'atterrissage, le saut s'efface sur AIR_OUT", () => {
    // décolle au tick 200, retombe au tick 210
    const r = replay({ flags: (i) => F.ALIVE | (i >= 100 && i < 105 ? F.AIRBORNE : 0) });
    expect(10 / R).toBeLessThan(MIN_AIR_S);
    const w = weights(pose(r, 210 + 0.05 * R));
    expect(w["communes:land_rifle"]).toBeUndefined();
    expect(w["rifle:jump_stand"]).toBeCloseTo(1 - 0.05 / AIR_OUT, 3);
    expect(w["rifle:idle"]).toBeCloseTo(0.05 / AIR_OUT, 3);
  });
  it("atterrissage en courant : pas de clip d'atterrissage, le vol s'efface vers la course sur AIR_OUT", () => {
    const w = weights(pose(replay({ ...moving(250), flags: jumpFlags }), 280 + 0.05 * R));
    expect(w["communes:land_rifle"]).toBeUndefined();
    expect(w["rifle:inair_n"]).toBeCloseTo(1 - 0.05 / AIR_OUT, 3);
    expect(w["rifle:run_n"]).toBeCloseTo(0.05 / AIR_OUT, 3);
  });
});

describe("corps entier : pose du C4, désamorçage", () => {
  it("pose du C4 : plant de « posé − 3,125 s » à « posé », étiré sur la durée du clip, fondus de 0,2 s", () => {
    const r = replay({ weapon: () => "C4 Explosive", bomb: [{ tick: 400, type: "plant", player: "a", site: "A", pos: [0, 0, 0] }] });
    const start = 400 - PLANT_S * R;
    expect(weights(pose(r, start - 2))).toEqual({ "knife:idle": 1 });
    const mid = pose(r, (start + 400) / 2);
    expect(weights(mid)).toEqual({ "knife:plant": 1 });
    expect(mid.layers[0].t).toBeCloseTo(3.3 / 2, 6);
    expect(weights(pose(r, 400 + 0.1 * R))["knife:plant"]).toBeCloseTo(0.5, 6);
  });
  it("désamorçage : defuse_enter pendant sa durée, puis defuse en boucle", () => {
    const r = replay({ weapon: () => "knife", flags: (i) => F.ALIVE | (i >= 100 ? F.DEFUSING : 0) });
    expect(weights(pose(r, 200 + 0.5 * R))).toEqual({ "knife:defuse_enter": 1 });
    const loop = pose(r, 200 + 1.5 * R);
    expect(weights(loop)).toEqual({ "knife:defuse": 1 });
    expect(loop.layers[0].t).toBeCloseTo(0.5, 9);
    const crouched = replay({ weapon: () => "knife", duck: () => 1, flags: (i) => F.ALIVE | (i >= 100 ? F.DEFUSING : 0) });
    expect(weights(pose(crouched, 200 + 1.5 * R))).toEqual({ "knife:defuse_crouch": 1 });
  });
  it("pose du C4 : fondu d'entrée ; accroupi : plant_crouch s'il est chargé ; la pose d'un autre joueur ne compte pas", () => {
    const plant: Partial<BombEvent>[] = [{ tick: 400, type: "plant", player: "a", site: "A", pos: [0, 0, 0] }];
    const r = replay({ weapon: () => "C4 Explosive", bomb: plant });
    const w = weights(pose(r, 400 - PLANT_S * R + (ACT_FADE * R) / 2));
    expect(w["knife:plant"]).toBeCloseTo(0.5, 6);
    expect(w["knife:idle"]).toBeCloseTo(0.5, 6);
    const crouched = replay({ weapon: () => "C4 Explosive", duck: () => 1, bomb: plant });
    expect(weights(pose(crouched, 380))).toEqual({ "knife:plant_crouch": 1 });
    expect(weights(pose(crouched, 380, mkDur(["plant_crouch"])))).toEqual({ "knife:plant": 1 });
    const other = replay({ weapon: () => "C4 Explosive", bomb: [{ ...plant[0], player: "b" }] });
    expect(weights(pose(other, 380))).toEqual({ "knife:idle": 1 });
  });
  it("désamorçage : fondu d'entrée ; à l'arrêt, dernière pose tenue pendant le fondu de sortie ; classe de l'arme tenue", () => {
    // désamorce des images 100 à 159 (ticks 200 à 318), s'arrête à l'image 160 (tick 320)
    const flags = (i: number) => F.ALIVE | (i >= 100 && i < 160 ? F.DEFUSING : 0);
    const r = replay({ weapon: () => "knife", flags });
    const enter = weights(pose(r, 200 + (ACT_FADE * R) / 2));
    expect(enter["knife:defuse_enter"]).toBeCloseTo(0.5, 6);
    expect(enter["knife:idle"]).toBeCloseTo(0.5, 6);
    const end = pose(r, 320 + (ACT_FADE * R) / 2);
    expect(weights(end)["knife:defuse"]).toBeCloseTo(0.5, 6);
    expect(weights(end)["knife:idle"]).toBeCloseTo(0.5, 6);
    expect(end.layers.find((l) => l.clip === "defuse")!.t).toBeCloseTo(120 / R - 1, 9);  // 1,875 s de désamorçage, entrée de 1 s
    expect(weights(pose(r, 320 + ACT_FADE * R + 2))).toEqual({ "knife:idle": 1 });
    expect(weights(pose(replay({ flags }), 200 + 1.5 * R))).toEqual({ "rifle:defuse": 1 });  // AK-47 en main
  });
});

describe("mort", () => {
  const kill = (tick: number): Partial<KillEvent> => ({ tick, victim: "a", attacker: "b", victim_pos: [100, 200, 30] });
  const deadAfter = (i0: number) => (i: number) => (i < i0 ? F.ALIVE : 0);
  it("fondu de 0,1 s vers le clip de mort de la zone touchée, puis tenu ; corps à la position de la mort", () => {
    const r = replay({ flags: deadAfter(101), yaw: () => 40, kills: [kill(201)], damages: [{ tick: 201, victim: "a", hitgroup: "stomach" }] });
    const half = pose(r, 201 + (DEATH_FADE * R) / 2);
    expect(Object.keys(weights(half)).sort()).toEqual([expect.stringMatching(/^communes:mort_gut_[ab]$/), "rifle:idle"].sort());
    const later = pose(r, 201 + 10 * R);
    expect(later.layers).toHaveLength(1);
    expect(later.layers[0].clip).toMatch(/^mort_gut_[ab]$/);
    expect(later.layers[0].t).toBe(2);  // tenu sur la dernière image
    expect(later.body).toEqual({ x: 100, y: 200, z: 30, yaw: 40 });
    expect(later.weapon).toBeNull();
    expect(later.aim).toBe(0);
  });
  it("clip de la zone absent : mort_chest_a ; aucun clip de mort : null (la croix reste) ; mort sans kill : null", () => {
    const r = replay({ flags: deadAfter(101), kills: [kill(201)], damages: [{ tick: 201, victim: "a", hitgroup: "right_arm" }] });
    expect(pose(r, 400, mkDur(["mort_rshoulder"])).layers[0].clip).toBe("mort_chest_a");
    expect(agentPose(r, 400, "a", mkDur(Object.keys(DUR).filter((k) => k.startsWith("mort_"))))).toBeNull();
    expect(agentPose(replay({ flags: deadAfter(101) }), 400, "a", dur)).toBeNull();
  });
  it("zone de la dernière blessure reçue jusqu'au kill (pas celle d'un autre joueur, ni celle d'après)", () => {
    const r = replay({ flags: deadAfter(101), kills: [kill(201)], damages: [
      { tick: 150, victim: "a", hitgroup: "stomach" }, { tick: 190, victim: "a", hitgroup: "right_leg" },
      { tick: 195, victim: "b", hitgroup: "stomach" }, { tick: 260, victim: "a", hitgroup: "stomach" }] });
    expect(pose(r, 400).layers[0].clip).toMatch(/^mort_rknee_[ab]$/);
  });
  it("variante du clip de mort : vmVariant du tick du kill", () => {
    const seen = new Set<string>();
    for (const t of [195, 196, 197, 198, 199, 200, 201]) {
      const r = replay({ flags: deadAfter(101), kills: [kill(t)], damages: [{ tick: t, victim: "a", hitgroup: "chest" }] });
      const clip = pose(r, 400).layers[0].clip;
      expect(clip).toBe(`mort_chest_${vmVariant(t) ? "b" : "a"}`);
      seen.add(clip);
    }
    expect(seen.size).toBe(2);
  });
  it("vivant jusqu'au tick du kill ; lacet du corps : celui du dernier instant en vie", () => {
    const r = replay({ flags: deadAfter(101), yaw: (i) => (i < 101 ? 40 : 200), kills: [kill(202)] });
    const before = pose(r, 200);
    expect(weights(before)).toEqual({ "rifle:idle": 1 });
    expect(before.body).toBeNull();
    expect(pose(r, 400).body!.yaw).toBe(40);
  });
  it("pendant le fondu, le corps garde la pose du tick du kill (vitesse bornée au kill, pas figés)", () => {
    // court à 250 u/s jusqu'au kill (tick 200), positions figées ensuite : course, pas marche
    const frozen = replay({ x: (i) => (Math.min(i, 100) * 250 * 2) / R, flags: deadAfter(101), kills: [kill(200)] });
    expect(weights(pose(frozen, 200 + (DEATH_FADE * R) / 2))["rifle:run_n"]).toBeCloseTo(0.5, 6);
    // positions qui continuent après la mort : la phase des pas reste celle du kill
    const r = replay({ ...moving(250), flags: deadAfter(101), kills: [kill(200)] });
    const p = pose(r, 200 + (DEATH_FADE * R) / 2), ph = gaitPhase(r, 0, 200);
    expect(p.layers.find((l) => l.clip === "run_n")!.t).toBeCloseTo((ph - Math.floor(ph)) * 0.7333, 6);
  });
  it("pendant le fondu, classe de l'arme du dernier instant en vie (l'image du kill, déjà mort, n'a plus d'arme)", () => {
    // kill au tick 203, entre l'image 101 (tick 202, déjà mort, sans arme) et l'image 102
    const r = replay({ flags: deadAfter(101), weapon: (i) => (i < 101 ? "AK-47" : ""), kills: [kill(203)] });
    const w = weights(pose(r, 203 + (DEATH_FADE * R) / 2));
    expect(w["rifle:idle"]).toBeCloseTo(0.5, 6);
    expect(w["knife:idle"]).toBeUndefined();
  });
});

describe("cycle de pas : changement de direction", () => {
  it("avant, puis de côté, puis en arrière à 250 u/s : phase croissante, sans saut au changement (seul le débit change)", () => {
    const v = (250 * 2) / R;  // unités par image
    const leg = (i: number) => Math.min(Math.floor(i / 100), 2);
    // regard +X ; image 0-99 : +X (devant), 100-199 : +Y (côté), 200-299 : −X (arrière)
    const pos = (i: number, axis: "x" | "y") => {
      let x = 0, y = 0;
      for (let k = 1; k <= i; k++) { const l = leg(k - 1); if (l === 0) x += v; else if (l === 1) y += v; else x -= v; }
      return axis === "x" ? x : y;
    };
    const r = replay({ x: (i) => pos(i, "x"), y: (i) => pos(i, "y") }, 320);
    const ph = (i: number) => gaitPhase(r, 0, 2 * i);
    const inc: number[] = [];
    for (let i = 2; i < 300; i++) inc.push(ph(i) - ph(i - 1));
    expect(Math.min(...inc)).toBeGreaterThan(0);  // monotone
    expect(Math.max(...inc)).toBeLessThan(v / GAIT.crouch);  // jamais plus qu'une image à la plus courte des longueurs de cycle
    // débit par direction : devant, côté, arrière (image milieu de chaque tronçon)
    expect(inc[50]).toBeCloseTo(v / GAIT.run, 6);
    expect(inc[150]).toBeCloseTo(v / GAIT_SIDE.run, 6);
    expect(inc[250]).toBeCloseTo(v / GAIT_BACK.run, 6);
    // aux changements : un pas d'image intermédiaire entre les deux débits, pas de saut
    for (const at of [99, 199]) {
      const [lo, hi] = [inc[at - 3], inc[at + 3]].sort((a, b) => a - b);
      for (const k of [at - 1, at, at + 1]) { expect(inc[k]).toBeGreaterThanOrEqual(lo - 1e-9); expect(inc[k]).toBeLessThanOrEqual(hi + 1e-9); }
    }
  });
});

describe("armes au sol", () => {
  it("arme tenue à la mort, devant et à droite du corps ; ramassée par un joueur proche qui l'ajoute à son inventaire", () => {
    const r = replay({
      flags: (i) => (i < 101 ? F.ALIVE : 0), kills: [{ tick: 201, victim: "a", victim_pos: [5000, 5000 + 40, 0] }],
      weapon: () => "AWP", inv: (i, j) => (j === 1 && i >= 150 ? ["AK-47", "AWP"] : j === 1 ? ["AK-47"] : ["AWP"]),
    });
    const [d] = droppedWeapons(r);
    expect(d).toMatchObject({ key: "awp", from: 201, until: 300 });
    // regard +X : 10 devant, 4 à droite (−Y) : médiane des armes au sol mesurées dans une démo (essai réel 5.1)
    expect([DROP_AHEAD, DROP_RIGHT]).toEqual([10, 4]);
    expect(d.x).toBeCloseTo(5000 + 10, 6);
    expect(d.y).toBeCloseTo(5040 - 4, 6);
  });
  it("ni couteau, ni C4 : couteau en main avec une AK, l'AK tombe ; sans inventaire, couteau : rien ; jamais ramassée : jusqu'à la fin", () => {
    const knife = replay({ flags: (i) => (i < 101 ? F.ALIVE : 0), kills: [{ tick: 201, victim: "a", victim_pos: [0, 0, 0] }], weapon: () => "knife" });
    expect(droppedWeapons(knife)).toEqual([]);
    const withAk = replay({ flags: (i) => (i < 101 ? F.ALIVE : 0), kills: [{ tick: 201, victim: "a", victim_pos: [0, 0, 0] }],
      weapon: () => "knife", inv: (_i, j) => (j ? [] : ["knife", "AK-47"]) });
    expect(droppedWeapons(withAk)).toMatchObject([{ victim: "a", key: "ak47", until: Infinity }]);
    const gun = replay({ flags: (i) => (i < 101 ? F.ALIVE : 0), kills: [{ tick: 201, victim: "a", victim_pos: [0, 0, 0] }], weapon: () => "Glock-18" });
    expect(droppedWeapons(gun)[0]).toMatchObject({ key: "glock", until: Infinity });
  });
  it("arme lâchée : la meilleure arme à feu (principale, à défaut pistolet), quelle que soit l'arme en main ; sans arme à feu : rien", () => {
    const drop = (held: string, inv: string[]) => droppedWeapons(replay({ flags: (i) => (i < 101 ? F.ALIVE : 0),
      kills: [{ tick: 201, victim: "a", victim_pos: [0, 0, 0] }], weapon: () => held, inv: (_i, j) => (j ? [] : inv) })).map((d) => d.key);
    expect(drop("knife", ["knife", "Glock-18", "AK-47"])).toEqual(["ak47"]);
    expect(drop("Glock-18", ["knife", "Glock-18", "AWP"])).toEqual(["awp"]);
    expect(drop("Smoke Grenade", ["knife", "USP-S", "Smoke Grenade"])).toEqual(["usp_silencer"]);
    expect(drop("C4 Explosive", ["knife", "Tec-9", "C4 Explosive"])).toEqual(["tec9"]);
    expect(drop("Flashbang", ["knife", "Flashbang", "Zeus x27"])).toEqual([]);  // grenades, Zeus : pas dans cette tâche
    // vieux replay sans inventaire : l'arme tenue, si c'est une arme à feu
    expect(drop("Zeus x27", [])).toEqual([]);
    expect(drop("Smoke Grenade", [])).toEqual([]);
  });
  it("arme choisie dans l'inventaire du dernier instant en vie ; ramassage de cette arme (pas de celle en main)", () => {
    const r = replay({ flags: (i) => (i < 101 ? F.ALIVE : 0), weapon: () => "knife", kills: [{ tick: 202, victim: "a", victim_pos: [5000, 5040, 0] }],
      inv: (i, j) => (j === 1 ? (i >= 150 ? ["Glock-18", "AK-47"] : ["Glock-18"]) : i < 101 ? ["knife", "AK-47"] : []) });
    expect(droppedWeapons(r)).toMatchObject([{ victim: "a", key: "ak47", from: 202, until: 300 }]);
  });
  it("une arme par mort, repérée par son steamid : deux morts au même tick avec la même arme donnent deux armes", () => {
    const r = replay({ flags: (i) => (i < 101 ? F.ALIVE : 0), bFlags: (i) => (i < 101 ? F.ALIVE : 0), inv: () => ["AWP"],
      kills: [{ tick: 201, victim: "a", victim_pos: [0, 0, 0] }, { tick: 201, victim: "b", victim_pos: [500, 0, 0] },
        { tick: 201, victim: "a", victim_pos: [0, 0, 0] }] });  // kill en double : ignoré
    expect(droppedWeapons(r).map((d) => [d.victim, d.key, d.from])).toEqual([["a", "awp", 201], ["b", "awp", 201]]);
  });
  it("arme du dernier instant en vie, lacet et hauteur ; liste calculée une fois par replay", () => {
    const r = replay({ flags: (i) => (i < 101 ? F.ALIVE : 0), yaw: () => 30, kills: [{ tick: 202, victim: "a", victim_pos: [0, 0, 10] }],
      weapon: (i) => (i < 101 ? "AWP" : "Glock-18") });
    const [d] = droppedWeapons(r);
    expect(d.key).toBe("awp");
    expect(d.z).toBe(11);
    expect(d.yaw).toBe(30 + 90 + (vmVariant(202) ? 25 : -25));
    expect(droppedWeapons(r)).toBe(droppedWeapons(r));
  });
  it("ni C4 ; pas ramassée par un joueur loin, mort, ou qui l'avait déjà", () => {
    const kills: Partial<KillEvent>[] = [{ tick: 201, victim: "a", victim_pos: [5000, 5040, 0] }];
    const base = { flags: (i: number) => (i < 101 ? F.ALIVE : 0), kills, weapon: () => "AWP" };
    expect(droppedWeapons(replay({ ...base, weapon: () => "C4 Explosive" }))).toEqual([]);
    const gains = (i: number, j: number) => (j === 1 && i >= 150 ? ["AK-47", "AWP"] : j === 1 ? ["AK-47"] : ["AWP"]);
    const far = replay({ ...base, inv: gains, kills: [{ ...kills[0], victim_pos: [5000, 5300, 0] }] });
    expect(droppedWeapons(far)[0].until).toBe(Infinity);
    expect(droppedWeapons(replay({ ...base, inv: gains, bFlags: (i) => (i < 120 ? F.ALIVE : 0) }))[0].until).toBe(Infinity);
    expect(droppedWeapons(replay({ ...base, inv: () => ["AWP"] }))[0].until).toBe(Infinity);
  });
  it("un ramassage ne retire qu'une arme : deux armes de même nom à 150 u, un seul gain, seule la plus proche disparaît", () => {
    // « a » et « b » meurent au tick 201 avec une AWP (armes en (10, −4) et (160, −4)) ; « c », en (−60, 0), gagne une AWP à l'image 150
    const r = replay({ flags: (i) => (i < 101 ? F.ALIVE : 0), bFlags: (i) => (i < 101 ? F.ALIVE : 0), third: { x: -60, y: 0 },
      kills: [{ tick: 201, victim: "a", victim_pos: [0, 0, 0] }, { tick: 201, victim: "b", victim_pos: [150, 0, 0] }],
      inv: (i, j) => (j === 2 ? (i >= 150 ? ["AWP"] : []) : ["AWP"]) });
    expect(droppedWeapons(r).map((d) => [d.victim, d.until])).toEqual([["a", 300], ["b", Infinity]]);
  });
  it("deux gains successifs de la même arme : chacun retire une arme, la plus proche encore au sol, dans l'ordre", () => {
    const r = replay({ flags: (i) => (i < 101 ? F.ALIVE : 0), bFlags: (i) => (i < 101 ? F.ALIVE : 0), third: { x: -60, y: 0 },
      kills: [{ tick: 201, victim: "a", victim_pos: [0, 0, 0] }, { tick: 201, victim: "b", victim_pos: [150, 0, 0] }],
      inv: (i, j) => (j === 2 ? (i >= 150 && i < 180) || i >= 200 ? ["AWP"] : [] : ["AWP"]) });
    expect(droppedWeapons(r).map((d) => [d.victim, d.until])).toEqual([["a", 300], ["b", 400]]);
  });
  it("le ramasseur le plus proche, pas le premier de la liste : le gain de « b » (proche) ne retire pas l'arme de « a » (loin)", () => {
    // « a » meurt en (0, 0) ; « b » (en vie, en (5000, 5000)) est loin ; « c », en (200, 0), gagne l'AWP : elle part au tick 300
    const r = replay({ flags: (i) => (i < 101 ? F.ALIVE : 0), third: { x: 200, y: 0 }, kills: [{ tick: 201, victim: "a", victim_pos: [0, 0, 0] }],
      inv: (i, j) => (j === 2 ? (i >= 150 ? ["AWP"] : []) : ["AWP"]) });
    expect(droppedWeapons(r)[0].until).toBe(300);
  });
  it("altitude : un joueur à un autre étage ne ramasse pas l'arme, même à portée à l'horizontale", () => {
    expect(PICK_DZ).toBe(128);
    const at = (dz: number) => droppedWeapons(replay({ flags: (i) => (i < 101 ? F.ALIVE : 0), third: { x: 100, y: 0, z: 1 + dz },
      kills: [{ tick: 201, victim: "a", victim_pos: [0, 0, 0] }], inv: (i, j) => (j === 2 ? (i >= 150 ? ["AWP"] : []) : ["AWP"]) }))[0];
    expect(at(0).until).toBe(300);
    expect(at(120).until).toBe(300);     // escalier, pente : même étage
    expect(at(-120).until).toBe(300);
    expect(at(200).until).toBe(Infinity);   // autre étage
    expect(at(-200).until).toBe(Infinity);
  });
  it("ramassée de loin, comme dans le jeu (essai réel : jusqu'à 250 unités de l'arme) : PICK_R = 256", () => {
    expect(PICK_R).toBe(256);
    // regard +X : arme 10 devant et 4 à droite de la mort ; « b », immobile en (5000, 5000), gagne l'AWP à l'image 150
    const at = (d: number) => droppedWeapons(replay({ flags: (i) => (i < 101 ? F.ALIVE : 0), weapon: () => "AWP",
      kills: [{ tick: 201, victim: "a", victim_pos: [5000 - DROP_AHEAD, 5000 + DROP_RIGHT + d, 0] }],
      inv: (i, j) => (j === 1 && i >= 150 ? ["AK-47", "AWP"] : j === 1 ? ["AK-47"] : ["AWP"]) }))[0];
    expect(at(250).until).toBe(300);
    expect(at(255).until).toBe(300);
    expect(at(258).until).toBe(Infinity);
  });
});

describe("préchauffage du round", () => {
  it("warmAgentAnim calcule les pas de chaque joueur et les armes au sol : la première pose ne les refait pas", () => {
    const r = replay({ ...moving(250), flags: (i) => (i < 101 ? F.ALIVE : 0), inv: () => ["AWP"],
      kills: [{ tick: 201, victim: "a", victim_pos: [5000, 5040, 0] }] });
    const value = r.value.bind(r);
    let reads = 0;
    Object.assign(r, { value: (k: string, i: number, j: number) => (reads++, value(k, i, j)) });
    warmAgentAnim(r);
    expect(reads).toBeGreaterThan(4 * r.n);
    reads = 0;
    expect(agentPose(r, 300, "b", dur)).not.toBeNull();  // « b » : en vie ; ses pas sont déjà calculés
    expect(reads).toBeLessThan(100);
    reads = 0;
    expect(droppedWeapons(r)).toHaveLength(1);
    expect(reads).toBe(0);
  });
});

describe("gardes : ordre des appels, replays distincts, cadence, vieux replays", () => {
  const rich = (): Fake => ({
    ...moving(250, 30), yaw: (i) => (i * 3) % 360, duck: (i) => (i > 300 && i < 400 ? 1 : 0), weapon: (i) => (i < 200 ? "AK-47" : "Glock-18"),
    flags: (i) => (i >= 500 ? 0 : F.ALIVE | (i >= 100 && i < 140 ? F.AIRBORNE : 0) | (i >= 420 && i < 480 ? F.DEFUSING : 0)),
    kills: [{ tick: 999, victim: "a", attacker: "b", victim_pos: [0, 0, 0] }], damages: [{ tick: 990, victim: "a", hitgroup: "stomach" }],
    inv: () => ["AK-47"],
  });
  it("ordre des appels : A, puis B, puis A donnent la même pose que sur un replay neuf", () => {
    const ticks = [150, 230, 285, 401, 650, 803, 870, 1001, 1200];
    const r = replay(rich());
    for (const [a, b] of [[150, 1200], [1001, 230], [650, 285], [870, 401], [803, 150]]) {
      const first = pose(r, a), other = pose(r, b);
      expect(pose(r, a)).toEqual(first);
      expect(first).toEqual(pose(replay(rich()), a));
      expect(other).toEqual(pose(replay(rich()), b));
    }
    expect(ticks.map((t) => pose(r, t))).toEqual(ticks.map((t) => pose(replay(rich()), t)));
  });
  it("deux Replay ne partagent rien : pas et armes au sol de chacun", () => {
    const dead = { flags: (i: number) => (i < 101 ? F.ALIVE : 0), kills: [{ tick: 201, victim: "a", victim_pos: [0, 0, 0] as [number, number, number] }] };
    const fast = replay({ ...moving(250), ...dead, inv: () => ["AWP"] }), slow = replay({ ...moving(100), ...dead, inv: () => ["Glock-18"] });
    expect(gaitPhase(fast, 0, 100)).toBeCloseTo((250 * 100) / R / GAIT.run, 6);
    expect(gaitPhase(slow, 0, 100)).toBeCloseTo((100 * 100) / R / GAIT.walk, 6);
    expect(droppedWeapons(fast).map((d) => d.key)).toEqual(["awp"]);
    expect(droppedWeapons(slow).map((d) => d.key)).toEqual(["glock"]);
  });
  it("sur une échelle (drapeau LADDER, le plus souvent avec AIRBORNE) : ni saut ni vol ni atterrissage, debout au repos", () => {
    const climb = (i: number) => F.ALIVE | (i >= 100 && i < 140 ? F.AIRBORNE | F.LADDER : 0);
    const r = replay({ flags: climb });
    for (let tick = 0; tick < 400; tick += 5) {
      const p = pose(r, tick);
      expect(p.layers.filter((l) => /^(jump|inair|land)/.test(l.clip))).toEqual([]);
    }
    expect(weights(pose(r, 200 + 0.2 * R))).toEqual({ "rifle:idle": 1 });
    expect(weights(pose(r, 280 + 0.05 * R))).toEqual({ "rifle:idle": 1 });  // pas d'atterrissage en quittant l'échelle
  });
  it("replay sans le bit LADDER : le vol est joué comme avant", () => {
    const r = replay({ flags: (i) => F.ALIVE | (i >= 100 && i < 140 ? F.AIRBORNE : 0) });
    expect(weights(pose(r, 200 + 0.2 * R))).toEqual({ "rifle:jump_stand": 1 });
  });
  it("replay sans le drapeau AIRBORNE (toujours 0) : jamais de saut, de vol ni d'atterrissage", () => {
    const r = replay({ ...moving(250), flags: () => F.ALIVE });
    for (let tick = 0; tick < 1280; tick += 7) expect(pose(r, tick).layers.filter((l) => /^(jump|inair|land)/.test(l.clip))).toEqual([]);
  });
  it("replay à 16 images/s (une image tous les 4 ticks) : vitesse, pas, saut, atterrissage", () => {
    const walk = replay({ step: 4, x: (i) => (100 * 4 * i) / R }, 320);
    expect(velocityAt(walk, 0, 100)[0]).toBeCloseTo(100, 6);
    expect(gaitPhase(walk, 0, 128)).toBeCloseTo(200 / GAIT.walk, 6);
    expect(weights(pose(walk, 101))).toEqual({ "rifle:walk_n": 1 });
    // court à 250 u/s ; en l'air des images 50 à 69 (ticks 200 à 276), au sol au tick 280
    const run = replay({ step: 4, x: (i) => (250 * 4 * i) / R, flags: (i) => F.ALIVE | (i >= 50 && i < 70 ? F.AIRBORNE : 0) }, 320);
    expect(weights(pose(run, 100))).toEqual({ "rifle:run_n": 1 });
    expect(weights(pose(run, 200 + 0.2 * R))).toEqual({ "rifle:jump_n": 1 });
    expect(weights(pose(run, 280 + 0.05 * R))["rifle:inair_n"]).toBeCloseTo(1 - 0.05 / AIR_OUT, 3);
  });
  it("valeurs prises entre deux images, images irrégulières : regard, accroupi et phase des pas interpolés au tick", () => {
    const tk = (i: number) => 3 * i - (i % 2);  // ticks 0, 2, 6, 8, 12, 14… : intervalles de 2 et 4 ticks
    // court à 250 u/s, regard qui descend, accroupi à partir de l'image 101 ; image 100 au tick 300, image 101 au tick 302
    const r = replay({ tickAt: tk, x: (i) => (250 * tk(i)) / R, pitch: (i) => i / 10, duck: (i) => (i >= 101 ? 1 : 0) });
    const p = pose(r, 301.5), ph = gaitPhase(r, 0, 301.5);  // aux trois quarts de l'intervalle
    expect(p.aim).toBeCloseTo(10.075, 9);
    expect(weights(p)).toEqual({ "rifle:run_n": 0.25, "rifle:crouch_n": 0.75 });
    expect(p.layers.find((l) => l.clip === "run_n")!.t).toBeCloseTo((ph - Math.floor(ph)) * 0.7333, 9);
  });
  it("aucun état gardé d'un appel à l'autre : une pose ne dépend pas de l'appel précédent", () => {
    const r = replay({
      x: (i) => (Math.min(Math.max(i - 150, 0), 40) * 200) / R, weapon: (i) => (i < 250 ? "AK-47" : "knife"), duck: (i) => (i >= 400 && i < 450 ? 1 : 0),
      flags: (i) => (i >= 501 ? 0 : F.ALIVE | ((i >= 100 && i < 140) || (i >= 200 && i < 206) ? F.AIRBORNE : 0) | (i >= 300 && i < 360 ? F.DEFUSING : 0)),
      kills: [{ tick: 1001, victim: "a", attacker: "b", victim_pos: [1, 2, 3] }], damages: [{ tick: 990, victim: "a", hitgroup: "stomach" }],
    });
    // en vol (0,08 s, 0,47 s), atterrissage (0,05 s, 0,3 s), marche, petit saut et juste après, désamorçage et sa fin,
    // accroupi, fondu de mort, mort
    const ticks = [205, 230, 283.2, 299.2, 340, 405, 415, 650, 725, 820, 1003.4, 1100];
    for (const b of ticks) {
      const ref = pose(r, b);
      for (const a of ticks) {
        pose(r, a);
        expect(pose(r, b), `${b} après ${a}`).toEqual(ref);
      }
    }
  });
});

describe("mort en ragdoll", () => {
  const kill = (tick: number): KillEvent => ({ tick, victim: "a", attacker: "b", victim_pos: [100, 200, 30] }) as KillEvent;
  const deadAfter = (i0: number) => (i: number) => (i < i0 ? F.ALIVE : 0);
  // trajectoire de 2 corps sur 3 images : corps en x 10 et 12, puis 20 et 22, puis 30 et 32 ; z 8, puis 6, puis 4
  const TRACK = { dt: 1 / 60, frames: 3, bodies: 2, bones: ["pelvis", "head_0"],
    p: Float32Array.from([10, 0, 8, 12, 0, 8, 20, 0, 6, 22, 0, 6, 30, 0, 4, 32, 0, 4]),
    q: Float32Array.from({ length: 24 }, (_, k) => (k % 4 === 3 ? 1 : 0)) };
  const lookup = (ready: boolean) => {
    const asked: [string, number][] = [];
    return { asked, track: (_r: Replay, sid: string, kt: number) => { asked.push([sid, kt]); return ready ? TRACK : null; } };
  };
  it("trajectoire prête : pose vivante du tick du kill, ragdoll à l'instant de la mort, corps au milieu des corps et au sol", () => {
    const r = replay({ flags: deadAfter(101), yaw: () => 40, kills: [kill(201)] }), rag = lookup(true);
    const p = agentPose(r, 201 + R / 60, "a", dur, rag)!;  // une image de trajectoire après la mort
    expect(weights(p)).toEqual({ "rifle:idle": 1 });
    expect(p.ragdoll!.track).toBe(TRACK);
    expect(p.ragdoll!.t).toBeCloseTo(1 / 60, 9);
    expect(p.body!.x).toBeCloseTo(21, 6);  // flottants : la fraction d'image vient de t / dt
    expect([p.body!.y, p.body!.yaw]).toEqual([0, 40]);
    expect(p.body!.z).toBeCloseTo(6 - GROUND_BELOW, 6);
    expect([p.weapon, p.aim]).toEqual([null, 0]);
    expect(rag.asked.at(-1)).toEqual(["a", 201]);
    const end = agentPose(r, 201 + 10 * R, "a", dur, rag)!;  // bien après la fin : dernière image
    expect(end.body!.x).toBeCloseTo(31, 6);
  });
  it("pas de trajectoire (pas encore là, refusée) ou pas de recherche : clip de mort comme avant ; un vivant ne demande rien", () => {
    const r = replay({ flags: deadAfter(101), kills: [kill(201)] }), rag = lookup(false);
    expect(agentPose(r, 400, "a", dur, rag)!.layers[0].clip).toMatch(/^mort_chest_[ab]$/);
    expect(agentPose(r, 400, "a", dur, rag)!.ragdoll ?? null).toBeNull();
    expect(agentPose(r, 400, "a", dur)!.layers[0].clip).toMatch(/^mort_chest_[ab]$/);
    const before = rag.asked.length;
    agentPose(r, 100, "a", dur, rag);  // encore en vie
    expect(rag.asked.length).toBe(before);
  });
  it("pose du mourant (départ du ragdoll) : vivante, au tick donné ou au kill, place du replay, lacet du dernier instant en vie", () => {
    const r = replay({ ...moving(250), flags: deadAfter(101), kills: [kill(201)] });
    const p = dyingPose(r, 197, "a", kill(201), dur)!;
    expect(weights(p)["rifle:run_n"]).toBeCloseTo(1, 6);
    expect(p.body!.x).toBeCloseTo((250 * 197) / R, 3);
    expect([p.body!.y, p.body!.z, p.body!.yaw, p.ragdoll]).toEqual([0, 0, 0, null]);
    expect(dyingPose(r, 400, "a", kill(201), dur)!.body!.x).toBeCloseTo((250 * 201) / R, 3);  // borné au kill
    expect(dyingPose(r, 197, "x", kill(201), dur)).toBeNull();
    expect(dyingPose(r, 197, "a", kill(201), mkDur(Object.keys(DUR)))).toBeNull();  // aucun clip
  });
});
