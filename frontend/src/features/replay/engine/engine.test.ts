import { describe, expect, it } from "vitest";
import type { MapMeta, ReplayPayload, WireArray } from "../../../shared/api/types";
import { worldToRadar, levelForZ, validLevel } from "./coords";
import { lerpAngle, sampleIndex } from "./interp";
import { Replay } from "./replay";
import { F, KEYS, activeGrenades, bombStateAt, extinguishedMolotovs, playerStateAt, roundClock, smokeBreaks, timelineMarkers } from "./state";
import { decodeWireArray } from "./wire";

const wa = (arr: Float32Array | Uint8Array | Uint16Array | Uint32Array | Int32Array | Int16Array, dtype: string): WireArray =>
  ({ dtype, data: new Uint8Array(arr.buffer.slice(0)) });

function payload(): ReplayPayload {
  // 3 échantillons (ticks 1000, 1004, 1008), 2 joueurs
  const n = 3, m = 2;
  const f32 = (v: number[]) => wa(new Float32Array(v), "<f4");
  return {
    match_id: 1, map_name: "de_nuke", tickrate: 64,
    round: { id: 1, number: 1, winner_side: "CT", winner_team_id: 1, end_reason: "t_killed", ct_team_id: 1, t_team_id: 2,
      score_a_after: 1, score_b_after: 0, ct_buy_type: "pistol", t_buy_type: "pistol", ct_equip_value: 4000,
      t_equip_value: 4000, start_tick: 1000, freeze_end_tick: 1004, end_tick: 1008, duration_s: 0 },
    teams: { ct: { id: 1, name: "A" }, t: { id: 2, name: "B" } },
    players: [{ steamid: "1", name: "ct1", team_id: 1, side: "CT" }, { steamid: "2", name: "t1", team_id: 2, side: "T" }],
    frames: {
      v: 1, round: 1, n, m, ticks: wa(new Int32Array([1000, 1004, 1008]), "<i4"), players: ["1", "2"],
      fields: {
        x: f32([0, 100, 10, 100, 20, 100]), y: f32([0, 0, 0, 0, 0, 0]), z: f32([0, 0, 0, 0, 0, 0]),
        yaw: f32([170, 0, -170, 0, -170, 0]), flash: f32([0, 0, 0, 0, 0, 0]),
        hp: wa(new Uint8Array([100, 100, 100, 50, 100, 0]), "<u1"), armor: wa(new Uint8Array(6), "<u1"),
        flags: wa(new Uint8Array([1, 9, 1, 9, 1, 0]), "<u1"),
        weapon: wa(new Uint16Array([0, 1, 0, 1, 0, 1]), "<u2"), money: wa(new Uint16Array(6), "<u2"),
        equip: wa(new Uint16Array(6), "<u2"),
      },
      weapons: ["USP-S", "Glock-18"], inv_offsets: wa(new Uint32Array(n * m + 1), "<u4"), inv_items: wa(new Uint16Array(0), "<u2"),
    },
    kills: [{ tick: 1006, attacker: "1", victim: "2", assister: null, weapon: "usp_silencer", headshot: true, penetrated: 0,
      through_smoke: false, noscope: false, attacker_blind: false, flash_assist: false, attacker_pos: [10, 0, 0],
      victim_pos: [100, 0, 0], is_opening: true, is_trade: false }],
    shots: [], damages: [],
    grenades: [{ id: 9, type: "smoke", thrower: "2", throw_tick: 1000, throw_pos: [0, 0, 0], detonate_tick: 1004,
      detonate_pos: [50, 50, 0], end_tick: 1004 + 18 * 64, trajectory: [[1000, 0, 0, 0], [1002, 25, 25, 0], [1004, 50, 50, 0]] }],
    bomb: [{ tick: 1005, type: "plant", player: "2", site: "A", pos: [100, 0, 0] }],
    blinds: [],
  };
}

/** Les mêmes 3 images × 2 joueurs avec les champs de la vue du joueur, tels que les envoie le serveur depuis le
 *  30/10/2026 : pitch quantifié en différences par joueur (enc « dpm », échelle 100), le reste brut. */
function viewPayload(): ReplayPayload {
  const p = payload();
  const fr = p.frames!;
  // pitch : joueur 0 → 10, 20, 30 ; joueur 1 → -5 partout (rangé joueur par joueur, différences successives × 100)
  fr.fields.pitch = { ...wa(new Int16Array([1000, 1000, 1000, -500, 0, 0]), "<i2"), enc: "dpm", scale: 100 };
  fr.fields.duck = wa(new Uint8Array([0, 255, 255, 255, 255, 0]), "|u1");
  fr.fields.clip = wa(new Uint16Array([12, 65535, 11, 65535, 10, 65535]), "<u2");
  fr.fields.reserve = wa(new Uint16Array([24, 65535, 24, 65535, 24, 65535]), "<u2");
  fr.fields.zoom = wa(new Uint8Array([0, 1, 0, 2, 0, 0]), "|u1");
  fr.fields.keys = wa(new Uint16Array([KEYS.FORWARD | KEYS.FIRE, KEYS.DUCK | KEYS.WALK, 0, 0, 0, 0]), "<u2");
  fr.fields.flags = wa(new Uint8Array([1 | F.AIRBORNE, 9, 1, 9, 1, 0]), "<u1");
  fr.xhair = ["CSGO-aaaaa-bbbbb-ccccc-ddddd-eeeee", null];
  return p;
}

/** viewPayload() + le FOV réel de la caméra (champ « fov », octets bruts) et les réglages des bras (« vm »).
 *  FOV par image [joueur 0, joueur 1] : image 0 = [0, 90], image 1 = [90, 10], image 2 = [40, 0] (le joueur 1 meurt). */
function fovPayload(): ReplayPayload {
  const p = viewPayload();
  p.frames!.fields.fov = wa(new Uint8Array([0, 90, 90, 10, 40, 0]), "|u1");
  p.frames!.vm = [[68, 2.5, 0, -1.5], null];
  return p;
}

/** viewPayload() + les angles du milieu (« yawm » / « pitchm » : l'angle au tick situé entre deux images) et les tirs avec
 *  leur recul de caméra (« punch »). Images aux ticks 1000, 1004, 1008 (milieux : 1002 et 1006), tickrate 64.
 *  Lacet du joueur 0 : 170 → [milieu -178 = 182] → -170 → [milieu -165] → -170 ; joueur 1 : 0 → [30] → 0 → [40] → 0 (il meurt
 *  à l'image 2). Vertical du joueur 0 : 10 → [12] → 20 → [26] → 30 ; joueur 1 : -5 → [0] → -5 → [-5] → -5. */
function midPayload(): ReplayPayload {
  const p = viewPayload();
  const f32 = (v: number[]) => wa(new Float32Array(v), "<f4");
  p.frames!.fields.yawm = f32([-178, 30, -165, 40, -170, 0]);
  p.frames!.fields.pitchm = f32([12, 0, 26, -5, 30, -5]);
  // [tick, joueur, vertical, horizontal], pas triés ; deux entrées suivies du recul de visée (qui ne sert pas à la caméra)
  p.frames!.punch = [[1032, 0, -3, -2, -7, 9], [1000, 0, -2, 1], [1010, 1, -1, 0.5, -0.25, 0.125]];
  return p;
}
/** Différence d'angle ramenée dans [-180, 180) : deux lacets égaux modulo 360 donnent 0. */
const angDiff = (a: number, b: number) => ((a - b + 540) % 360) - 180;

const NUKE: MapMeta = { name: "de_nuke", display_name: "Nuke", pos_x: -3453, pos_y: 2887, scale: 7, image: "de_nuke.png",
  levels: [{ name: "upper", image: "de_nuke.png", z_min: -495, z_max: 10000 }, { name: "lower", image: "de_nuke_lower.png", z_min: -10000, z_max: -495 }],
  bomb_a: null, bomb_b: null };

describe("engine", () => {
  it("decodeWireArray", () => {
    const a = decodeWireArray(wa(new Float32Array([1.5, 2.5]), "<f4"));
    expect(a).toBeInstanceOf(Float32Array);
    expect(Array.from(a)).toEqual([1.5, 2.5]);
  });
  it("sampleIndex", () => {
    const t = new Int32Array([1000, 1004, 1008]);
    expect(sampleIndex(t, 1002)).toEqual({ i: 0, t: 0.5 });
    expect(sampleIndex(t, 900)).toEqual({ i: 0, t: 0 });
    expect(sampleIndex(t, 2000)).toEqual({ i: 2, t: 0 });
  });
  it("lerpAngle prend le chemin court", () => {
    expect(lerpAngle(170, -170, 0.5)).toBeCloseTo(180);
  });
  it("Replay.has et crosshairOf : champs et réticules présents ou absents", () => {
    const old = new Replay(payload()); // replay d'avant la vue du joueur : ni pitch ni xhair
    expect(old.has("x")).toBe(true);
    expect(old.has("pitch")).toBe(false);
    expect(old.has("toString")).toBe(false); // pas une clé héritée d'Object
    expect(old.crosshairOf(0)).toBeNull();
    const p = payload();
    p.frames!.xhair = ["CSGO-aaaaa-bbbbb-ccccc-ddddd-eeeee", null];
    const r = new Replay(p);
    expect(r.crosshairOf(0)).toBe("CSGO-aaaaa-bbbbb-ccccc-ddddd-eeeee");
    expect(r.crosshairOf(1)).toBeNull();
    expect(r.crosshairOf(5)).toBeNull(); // indice hors liste
    p.frames!.xhair = ["", null];
    expect(new Replay(p).crosshairOf(0)).toBeNull(); // code vide = inconnu
  });
  it("Replay.viewmodelOf : réglages des bras par joueur, null si inconnus ou absents", () => {
    const old = new Replay(payload()); // replay d'avant les réglages des bras : pas de vm
    expect(old.viewmodelOf(0)).toBeNull();
    const r = new Replay(fovPayload());
    expect(r.viewmodelOf(0)).toEqual({ fov: 68, x: 2.5, y: 0, z: -1.5 });
    expect(r.viewmodelOf(1)).toBeNull(); // joueur sans réglage connu
    expect(r.viewmodelOf(7)).toBeNull(); // indice hors liste
    expect(r.has("fov")).toBe(true);
    expect(old.has("fov")).toBe(false);
  });
  it("playerStateAt : fov interpolé linéairement, 0 compris comme 90 avant l'interpolation", () => {
    const r = new Replay(fovPayload());
    expect(playerStateAt(r, 1000).map((s) => s.fov)).toEqual([90, 90]); // 0 → 90 (défaut du jeu)
    // image 0 → 1 : le joueur 0 passe de 0 (= 90) à 90 : 90, et non 45 (interpolation faite avant 0 → 90)
    expect(playerStateAt(r, 1002)[0].fov).toBe(90);
    expect(playerStateAt(r, 1002)[1].fov).toBeCloseTo(50); // 90 → 10
    expect(playerStateAt(r, 1001)[1].fov).toBeCloseTo(70); // t = 0,25
    expect(playerStateAt(r, 1006)[0].fov).toBeCloseTo(65); // 90 → 40
    expect(playerStateAt(r, 1006)[1].fov).toBe(10); // pas d'interpolation vers la mort
    expect(playerStateAt(r, 1008).map((s) => s.fov)).toEqual([40, 90]); // joueur mort, FOV 0 → 90
  });
  it("playerStateAt : réglages des bras", () => {
    const r = new Replay(fovPayload());
    const [a, b] = playerStateAt(r, 1002);
    expect(a.viewmodel).toEqual({ fov: 68, x: 2.5, y: 0, z: -1.5 });
    expect(b.viewmodel).toBeNull();
  });
  it("Replay.has : angles du milieu présents ou absents", () => {
    expect(new Replay(midPayload()).has("yawm")).toBe(true);
    expect(new Replay(midPayload()).has("pitchm")).toBe(true);
    expect(new Replay(viewPayload()).has("yawm")).toBe(false);
  });
  it("playerStateAt : lacet et angle vertical passent par l'échantillon du milieu (deux demi-intervalles)", () => {
    const r = new Replay(midPayload());
    const at = (tick: number) => playerStateAt(r, tick);
    // image 0 → 1 (ticks 1000 → 1004), milieu à 1002
    expect(at(1000).map((s) => s.yaw)).toEqual([170, 0]);
    expect(at(1001)[0].yaw).toBeCloseTo(176); // 170 → -178 par le chemin court (+12°) : à mi-chemin du premier demi-intervalle
    expect(at(1001)[1].yaw).toBeCloseTo(15); // 0 → 30
    expect(angDiff(at(1002)[0].yaw, -178)).toBeCloseTo(0); // au milieu : exactement l'échantillon (182 ≡ -178)
    expect(at(1002)[1].yaw).toBeCloseTo(30);
    expect(at(1003)[0].yaw).toBeCloseTo(-174); // -178 → -170
    expect(at(1003)[1].yaw).toBeCloseTo(15); // 30 → 0
    expect(at(1001)[0].pitch).toBeCloseTo(11); expect(at(1002)[0].pitch).toBeCloseTo(12); expect(at(1003)[0].pitch).toBeCloseTo(16);
    expect(at(1001)[1].pitch).toBeCloseTo(-2.5); expect(at(1002)[1].pitch).toBeCloseTo(0); expect(at(1003)[1].pitch).toBeCloseTo(-2.5);
    // image 1 → 2 (ticks 1004 → 1008), milieu à 1006 ; sur les images elles-mêmes, la valeur de l'image
    expect(at(1004).map((s) => s.yaw)).toEqual([-170, 0]);
    expect(at(1005)[0].yaw).toBeCloseTo(-167.5); expect(at(1006)[0].yaw).toBeCloseTo(-165); expect(at(1007)[0].yaw).toBeCloseTo(-167.5);
    expect(at(1005)[0].pitch).toBeCloseTo(23); expect(at(1006)[0].pitch).toBeCloseTo(26); expect(at(1007)[0].pitch).toBeCloseTo(28);
    expect(at(1008)[0].yaw).toBeCloseTo(-170);
  });
  it("playerStateAt : pas d'interpolation vers la mort, le milieu non plus", () => {
    const r = new Replay(midPayload()); // le joueur 1 meurt à l'image 2 : son milieu (40, -5) ne sert pas
    for (const tick of [1005, 1006, 1007]) {
      const b = playerStateAt(r, tick)[1];
      expect(b.alive).toBe(true);
      expect(b.yaw).toBe(0);
      expect(b.pitch).toBeCloseTo(-5);
    }
  });
  it("playerStateAt : sans angles du milieu, interpolation linéaire comme avant", () => {
    const [a, b] = playerStateAt(new Replay(viewPayload()), 1001);
    expect(a.yaw).toBeCloseTo(175); // 170 → -170 par le chemin court, t = 0,25
    expect(a.pitch).toBeCloseTo(12.5);
    expect(b.yaw).toBeCloseTo(0);
    const p = midPayload();
    delete p.frames!.fields.pitchm; // un seul des deux champs : l'autre angle reste linéaire
    const [c] = playerStateAt(new Replay(p), 1001);
    expect(c.yaw).toBeCloseTo(176);
    expect(c.pitch).toBeCloseTo(12.5);
  });
  it("angles du milieu transmis en différences quantifiées (dpm), comme yaw et pitch", () => {
    const p = midPayload();
    // lacet du milieu, joueur par joueur, ×100 puis différences successives : [-178, -165, -170] et [30, 40, 0]
    p.frames!.fields.yawm = { ...wa(new Int16Array([-17800, 1300, -500, 3000, 1000, -4000]), "<i2"), enc: "dpm", scale: 100 };
    const r = new Replay(p);
    expect([r.value("yawm", 0, 0), r.value("yawm", 1, 0), r.value("yawm", 2, 0)].map((x) => Math.round(x * 100) / 100)).toEqual([-178, -165, -170]);
    expect(playerStateAt(r, 1003)[0].yaw).toBeCloseTo(-174);
  });
  it("Replay.punchAt : recul du dernier tir, décroissance exp(-18·dt) (vertical, horizontal)", () => {
    const r = new Replay(midPayload());
    expect(r.punchAt(0, 999)).toEqual([0, 0]); // avant le premier tir
    expect(r.punchAt(0, 1000)).toEqual([-2, 1]); // dt = 0 : la valeur enregistrée
    const k = Math.exp(-18 * 0.25); // 16 ticks = 0,25 s
    const [v, h] = r.punchAt(0, 1016);
    expect(v).toBeCloseTo(-2 * k, 10); expect(h).toBeCloseTo(1 * k, 10);
    expect(r.punchAt(1, 1010)).toEqual([-1, 0.5]); // un autre joueur, son propre tir
    expect(r.punchAt(1, 1005)).toEqual([0, 0]); // son tir est dans le futur
  });
  it("Replay.punchAt : seul le dernier tir compte (pas de cumul), même si la liste n'est pas triée", () => {
    const r = new Replay(midPayload());
    const k = Math.exp(-18 * 0.125); // 8 ticks après le tir de 1032
    const [v, h] = r.punchAt(0, 1040);
    expect(v).toBeCloseTo(-3 * k, 10); expect(h).toBeCloseTo(-2 * k, 10); // et rien du tir de 1000
    expect(r.punchAt(0, 1032)).toEqual([-3, -2]);
    expect(r.punchAt(0, 1031)[0]).toBeCloseTo(-2 * Math.exp(-18 * 31 / 64), 10); // juste avant : le tir précédent
  });
  it("Replay.punchAt : coupé après 2 s, joueur sans tir, replay sans tirs", () => {
    const r = new Replay(midPayload());
    const edge = r.punchAt(1, 1010 + 128); // exactement 2 s : encore compté, mais exp(-36) ≈ 0
    expect(Math.abs(edge[0])).toBeLessThan(1e-12); expect(Math.abs(edge[1])).toBeLessThan(1e-12);
    const after = r.punchAt(1, 1010 + 129);
    expect(after).toEqual([0, 0]); // plus de 2 s : exactement [0, 0]
    expect(Object.is(after[0], 0) && Object.is(after[1], 0)).toBe(true); // jamais −0
    expect(r.punchAt(0, 1032 + 129)).toEqual([0, 0]);
    expect(r.punchAt(7, 1000)).toEqual([0, 0]); // indice hors liste
    expect(r.punchAt(-1, 1000)).toEqual([0, 0]);
    const old = new Replay(viewPayload()); // replay sans tirs (analysé avant la tâche) ou round sans tir
    expect(old.punchAt(0, 1000)).toEqual([0, 0]);
    const p = midPayload();
    p.frames!.punch = [];
    expect(new Replay(p).punchAt(0, 1000)).toEqual([0, 0]);
  });
  it("playerStateAt interpole", () => {
    const r = new Replay(payload());
    const s = playerStateAt(r, 1002);
    expect(s[0].x).toBeCloseTo(5);
    expect(s[0].weapon).toBe("USP-S");
    expect(s[1].hasBomb).toBe(true);
    expect(playerStateAt(r, 1008)[1].alive).toBe(false);
  });
  it("playerStateAt : vue du joueur (regard vertical interpolé, posture, munitions, touches, réticule)", () => {
    const r = new Replay(viewPayload());
    const [a, b] = playerStateAt(r, 1002);
    expect(a.pitch).toBeCloseTo(15); // lerp(10, 20, 0,5), convention CS2 gardée (positif = vers le bas)
    expect(a.duck).toBeCloseTo(0.5);
    expect(a).toMatchObject({ airborne: true, clip: 12, reserve: 24, zoom: 0, keys: KEYS.FORWARD | KEYS.FIRE,
      crosshair: "CSGO-aaaaa-bbbbb-ccccc-ddddd-eeeee" });
    expect(b.pitch).toBeCloseTo(-5);
    expect(b.duck).toBe(1);
    expect(b).toMatchObject({ airborne: false, clip: null, reserve: null, zoom: 1, crosshair: null });
    expect(b.keys & KEYS.DUCK).not.toBe(0);
    expect(playerStateAt(r, 1004)[0].airborne).toBe(false);
  });
  it("ancien replay (sans les champs de la vue du joueur) : valeurs par défaut", () => {
    const [a] = playerStateAt(new Replay(payload()), 1002);
    expect(a).toMatchObject({ pitch: 0, duck: 0, airborne: false, clip: null, reserve: null, zoom: 0, keys: 0, crosshair: null,
      fov: 0, viewmodel: null }); // fov 0 : le moteur 3D retombe sur ses tables d'armes
    expect(Object.is(a.pitch, 0)).toBe(true); // jamais −0 (toEqual distingue −0 et 0)
    expect(a.x).toBeCloseTo(5); // le reste est inchangé
  });
  it("bits exportés, identiques au serveur (backend/app/parsing/model.py)", () => {
    expect(F).toEqual({ ALIVE: 1, HELMET: 2, DEFUSER: 4, BOMB: 8, DEFUSING: 16, SCOPED: 32, AIRBORNE: 64, LADDER: 128 });
    expect(KEYS).toEqual({ FORWARD: 1, BACK: 2, LEFT: 4, RIGHT: 8, JUMP: 16, WALK: 32, FIRE: 64, RIGHTCLICK: 128,
      RELOAD: 256, USE: 512, INSPECT: 1024, DUCK: 2048 });
  });
  it("coordonnées radar", () => {
    expect(worldToRadar(NUKE, -3453 + 700, 2887 - 1400)).toEqual([100, 200]);
    expect(levelForZ(NUKE, -600)).toBe("lower");
  });
  it("grenades et bombe", () => {
    const r = new Replay(payload());
    const g1 = activeGrenades(r, 1002)[0];
    expect(g1.phase).toBe("flying");
    expect(g1.pos[0]).toBeCloseTo(25);
    expect(activeGrenades(r, 1100)[0].phase).toBe("active");
    expect(bombStateAt(r, 1004).state).toBe("carried");
    expect(bombStateAt(r, 1006)).toMatchObject({ state: "planted", plantTick: 1005, site: "A" });
  });
  it("horloge et marqueurs", () => {
    const r = new Replay(payload());
    expect(roundClock(r, 1004).phase).toBe("live");
    expect(roundClock(r, 1004).label).toBe("1:55");
    expect(roundClock(r, 1006).phase).toBe("planted");
    expect(timelineMarkers(r).map((x) => x.kind)).toEqual(["plant", "kill"]);
  });
});

describe("validLevel", () => {
  const mirage = { levels: [{ name: "default" }] } as unknown as MapMeta;
  const nuke = { levels: [{ name: "upper" }, { name: "lower" }] } as unknown as MapMeta;
  it("ignore un niveau qui n'existe pas sur la carte (pastilles atténuées sinon)", () => {
    expect(validLevel(mirage, "upper")).toBe("default");
    expect(validLevel(nuke, "lower")).toBe("lower");
    expect(validLevel(nuke, "")).toBe("upper");
  });
});

describe("fumées percées et molotovs éteints", () => {
  const withNades = () => {
    const p = payload();
    p.grenades.push(
      { id: 10, type: "he", thrower: "1", throw_tick: 1100, throw_pos: [0, 0, 0], detonate_tick: 1200, detonate_pos: [60, 40, 0], end_tick: 1200, trajectory: [[1100, 0, 0, 0], [1200, 60, 40, 0]] },
      { id: 11, type: "molotov", thrower: "2", throw_tick: 1300, throw_pos: [0, 0, 0], detonate_tick: 1400, detonate_pos: [400, 400, 0], end_tick: 1460, trajectory: [[1300, 0, 0, 0], [1400, 400, 400, 0]] },
      { id: 12, type: "smoke", thrower: "1", throw_tick: 1400, throw_pos: [0, 0, 0], detonate_tick: 1440, detonate_pos: [420, 380, 0], end_tick: 1440 + 18 * 64, trajectory: [[1400, 0, 0, 0], [1440, 420, 380, 0]] },
      { id: 13, type: "molotov", thrower: "2", throw_tick: 1300, throw_pos: [0, 0, 0], detonate_tick: 1400, detonate_pos: [-2000, 0, 0], end_tick: 1400 + 7 * 64, trajectory: [[1300, 0, 0, 0], [1400, -2000, 0, 0]] },
    );
    p.shots = [{ tick: 1500, shooter: "1", weapon: "ak47", pos: [-500, 50, 0], yaw: 0, pitch: 0 }];
    return new Replay(p);
  };
  it("une HE ouvre la fumée puis le trou se referme", () => {
    const r = withNades();
    expect(smokeBreaks(r, 1100).size).toBe(0);
    expect(smokeBreaks(r, 1210).get(9)!.holes[0].strength).toBe(1);
    const later = smokeBreaks(r, 1200 + 2 * 64).get(9)!.holes[0].strength;
    expect(later).toBeGreaterThan(0); expect(later).toBeLessThan(1);
    expect(smokeBreaks(r, 1200 + 4 * 64).get(9)).toBeUndefined();
  });
  it("une balle creuse un tunnel à travers la fumée", () => {
    const r = withNades();
    const t = smokeBreaks(r, 1510).get(9)!.tunnels[0];
    expect(t.a[0]).toBeLessThan(50); expect(t.b[0]).toBeGreaterThan(50);
    expect(smokeBreaks(r, 1500 + 2 * 64).get(9)).toBeUndefined();
  });
  it("molotov éteint par une fumée, l'autre non", () => {
    const ex = extinguishedMolotovs(withNades());
    expect(ex.get(11)).toBe(1460);
    expect(ex.has(13)).toBe(false);
  });
});

describe("agent équipé par joueur", () => {
  it("agentOf : nom du modèle, null pour l'agent par défaut ou un replay plus ancien", () => {
    const p = payload();
    expect(new Replay(p).agentOf(0)).toBeNull();
    const r = new Replay({ ...p, frames: { ...p.frames!, agents: ["tm_leet_variantf", null] } });
    expect(r.agentOf(0)).toBe("tm_leet_variantf");
    expect(r.agentOf(1)).toBeNull();
  });
});

describe("force de la mort", () => {
  it("deathForce : celle de la démo au tick du kill, null ailleurs ou dans un replay plus ancien", () => {
    const p = payload();
    expect(new Replay(p).deathForce(1, 1006)).toBeNull();
    const r = new Replay({ ...p, frames: { ...p.frames!, forces: [[1006, 1, 24000, -1.5, 300], [1006, 7, 1, 1, 1]] } });
    expect(r.deathForce(1, 1006)).toEqual([24000, -1.5, 300]);
    expect(r.deathForce(1, 1005)).toBeNull();
    expect(r.deathForce(0, 1006)).toBeNull();
  });
});
