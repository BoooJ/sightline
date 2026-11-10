import { describe, expect, it } from "vitest";
import type { BombEvent, GrenadeEvent, ShotEvent } from "../../shared/api/types";
import type { Replay } from "../replay/engine/replay";
import { F, KEYS } from "../replay/engine/state";
import {
  LOOKBACK_S, VM_CLIPS, VM_FADE, VM_GUNS, VM_WEAPONS, type VmClip, type VmDur, type VmPose, viewmodelPose, vmVariant,
  weaponKey,
} from "./viewmodelAnim";
// liste des armes et rôles des clips du script d'export (lus tels quels par vite, sans types de Node)
import weaponsJson from "../../../../scripts/map3d/lib/weapons.json?raw";
import weaponsMjs from "../../../../scripts/map3d/lib/weapons.mjs?raw";

const R = 64;
// durées des clips de l'arme de test (s) ; les 2es variantes des coups lourds n'existent pas (comme dans le jeu)
const DUR: Partial<Record<VmClip, number>> = {
  idle: 2, draw: 0.8, shoot: 0.77, shoot_empty: 0.6, reload: 2.4, reload_empty: 2.8, idle_empty: 1.5, attack: 1,
  attack_alt: 1, attack2: 1.2, hit: 1, hit_alt: 1, backstab: 1.1, backstab_alt: 1.1, hit2: 1.2, backstab2: 1.3,
  pullpin: 0.97, throw: 0.73, throw_underhand: 0.7, plant: 3,
};
const C4_CLIPS = new Set<VmClip>(["idle", "draw", "plant"]);
/** Durées des clips : `over` par rôle (« shoot ») ou par arme et rôle (« awp.shoot ») ; null = clip absent. */
const mkDur = (over: Record<string, number | null> = {}): VmDur => (w, c) => {
  const k = `${w}.${c}`;
  if (k in over) return over[k];
  if (c in over) return over[c];
  if (w === "c4" && !C4_CLIPS.has(c)) return null;
  return DUR[c] ?? null;
};
const dur = mkDur();

type Dmg = { tick: number; attacker: string | null; victim: string; dmg: number; raw?: number; armor?: number; weapon?: string; hitgroup: string };
interface Fake {
  weapon: (i: number) => string; keys?: (i: number) => number; clip?: (i: number) => number;
  dead?: (i: number) => boolean; scoped?: (i: number) => boolean; side?: "CT" | "T";
  shots?: Partial<ShotEvent>[]; grenades?: Partial<GrenadeEvent>[]; damages?: Dmg[]; bomb?: Partial<BombEvent>[];
  punch?: ([number, number, number, number] | [number, number, number, number, number, number])[];
}
// 64 ticks/s, un échantillon tous les 2 ticks (32 images/s) : l'échantillon i est au tick 2i
function replay(o: Fake, n = 1200): Replay {
  const fields: Record<string, (i: number) => number> = {
    flags: (i) => (o.dead?.(i) ? 0 : F.ALIVE | (o.scoped?.(i) ? F.SCOPED : 0)),
  };
  if (o.keys) fields.keys = o.keys;
  if (o.clip) fields.clip = o.clip;
  return {
    ticks: Int32Array.from({ length: n }, (_, i) => 2 * i), n, m: 2, tickrate: R,
    // « b » (indice 1) : un autre joueur, pour les filtres par joueur (ses champs sont ceux de « a »)
    players: [{ steamid: "a", name: "a", side: o.side ?? "T", slot: 1, index: 0 }, { steamid: "b", name: "b", side: "CT", slot: 1, index: 1 }],
    has: (k: string) => k in fields, value: (k: string, i: number) => fields[k](i), weaponAt: (i: number) => o.weapon(i),
    payload: { shots: o.shots ?? [], grenades: o.grenades ?? [], damages: o.damages ?? [], bomb: o.bomb ?? [],
      frames: { punch: o.punch ?? [] } },
  } as unknown as Replay;
}
const shot = (tick: number, shooter = "a"): Partial<ShotEvent> => ({ tick, shooter, weapon: "ak47" });
const hurt = (tick: number, dmg: number, attacker = "a"): Dmg => ({ tick, attacker, victim: "v", dmg, hitgroup: "chest" });
/** Blessure d'un replay récent : dégâts réels (bornés à la vie), bruts, à l'armure, et arme de player_hurt. */
const hurtW = (tick: number, dmg: number, raw: number, armor: number, weapon: string): Dmg =>
  ({ tick, attacker: "a", victim: "v", dmg, raw, armor, weapon, hitgroup: "generic" });
/** Touches tenues : [premier échantillon, dernier échantillon, bits]. */
const held = (...spans: [number, number, number][]) => (i: number) =>
  spans.reduce((k, [a, b, bits]) => (i >= a && i <= b ? k | bits : k), 0);
/** Instant du repos (clip qui boucle sur le temps du replay). */
const idleT = (tick: number, d = 2) => (tick / R) % d;
const pose = (r: Replay, tick: number, d = dur) => viewmodelPose(r, tick, "a", d);

interface Want { weapon?: string; to: [VmClip, number]; from?: [VmClip, number]; w?: number; hide?: boolean }
/** Pose attendue : clip courant et instant ; clip précédent, instant et poids pendant un fondu (sinon aucun, poids 1). */
function expectPose(p: VmPose | null, want: Want) {
  expect(p).not.toBeNull();
  const q = p!;
  if (want.weapon) expect(q.weapon).toBe(want.weapon);
  expect(q.to.clip).toBe(want.to[0]);
  expect(q.to.t).toBeCloseTo(want.to[1], 9);
  if (want.from) {
    expect(q.from?.clip).toBe(want.from[0]);
    expect(q.from!.t).toBeCloseTo(want.from[1], 9);
    expect(q.w).toBeCloseTo(want.w!, 9);
  } else {
    expect(q.from).toBeNull();
    expect(q.w).toBe(1);
  }
  expect(q.hideWeaponModel).toBe(want.hide ?? false);
}

describe("clé de l'arme tenue et tables", () => {
  it("noms des images ; couteaux par weaponClass et le camp ; armes absentes de la liste : pas d'arme", () => {
    expect(weaponKey("AK-47", "T")).toBe("ak47");
    expect(weaponKey("M4A4", "CT")).toBe("m4a1");
    expect(weaponKey("Zeus x27", "CT")).toBe("taser");
    expect(weaponKey("C4 Explosive", "T")).toBe("c4");
    expect(weaponKey("Karambit", "T")).toBe("knife_t");
    expect(weaponKey("Knife", "T")).toBe("knife_t");
    expect(weaponKey("Butterfly Knife", "CT")).toBe("knife");
    expect(weaponKey("Healthshot", "CT")).toBeNull();
    expect(weaponKey("constructor", "CT")).toBeNull();  // pas les propriétés du prototype de la table
    expect(weaponKey("toString", "T")).toBeNull();
    expect(weaponKey("", "CT")).toBeNull();
  });

  it("même table que scripts/map3d/lib/weapons.json ; rôles = ROLES de weapons.mjs ; cadence et récupération des armes à feu", () => {
    const list = JSON.parse(weaponsJson).weapons as { key: string; name: string; category: string; clips: Record<string, string> }[];
    expect(VM_WEAPONS).toEqual(Object.fromEntries(list.map((w) => [w.name, w.key])));
    const block = weaponsMjs.slice(weaponsMjs.indexOf("export const ROLES = {"), weaponsMjs.indexOf("};", weaponsMjs.indexOf("export const ROLES = {")));
    const roles = [...block.matchAll(/^\s+(\w+): \//gm)].map((m) => m[1]);
    expect([...VM_CLIPS].sort()).toEqual([...roles].sort());
    for (const w of list) for (const c of Object.keys(w.clips)) expect(VM_CLIPS).toContain(c);
    const guns = list.filter((w) => !["couteau", "grenade", "C4", "zeus"].includes(w.category)).map((w) => w.key);
    expect(Object.keys(VM_GUNS).sort()).toEqual(guns.sort());
    expect(VM_GUNS.awp[0]).toBe(1.455);  // m_flCycleTime
    expect(VM_GUNS.ak47[1]).toBe(0.506);  // m_flRecoveryTimeStandFinal (valeur citée par l'analyse)
  });

  it("variante d'un coup : 0 ou 1, fonction du seul tick, les deux arrivent", () => {
    const v = Array.from({ length: 64 }, (_, t) => vmVariant(t));
    expect(new Set(v)).toEqual(new Set([0, 1]));
    expect(Array.from({ length: 64 }, (_, t) => vmVariant(t))).toEqual(v);
  });
});

describe("rien à dessiner", () => {
  it("joueur absent ou mort, arme sans bras, lunette quelle que soit l'arme", () => {
    expect(pose(replay({ weapon: () => "AK-47", dead: (i) => i >= 100 }), 300)).toBeNull();
    expect(pose(replay({ weapon: () => "Healthshot" }), 300)).toBeNull();
    expect(viewmodelPose(replay({ weapon: () => "AK-47" }), 300, "inconnu", dur)).toBeNull();
    for (const w of ["AUG", "SG 553", "AK-47", "AWP", "SSG 08"])
      expect(pose(replay({ weapon: () => w, scoped: (i) => i >= 140 }), 300)).toBeNull();
    expect(pose(replay({ weapon: () => "AUG", scoped: (i) => i >= 160 }), 300)?.weapon).toBe("aug");
  });
});

describe("repos et sortie d'arme", () => {
  it("repos : boucle sur le temps du replay ; chargeur vide : repos à vide s'il existe", () => {
    expectPose(pose(replay({ weapon: () => "AK-47" }), 300), { weapon: "ak47", to: ["idle", idleT(300)] });
    const empty = replay({ weapon: () => "Glock-18", clip: () => 0 });
    expectPose(pose(empty, 300), { weapon: "glock", to: ["idle_empty", idleT(300, 1.5)] });
    expectPose(pose(empty, 300, mkDur({ idle_empty: null })), { to: ["idle", idleT(300)] });
    expectPose(pose(replay({ weapon: () => "Glock-18", clip: () => 65535 }), 300), { to: ["idle", idleT(300)] });
  });

  it("sortie : coupe nette au premier échantillon de la nouvelle arme, tenue 1 s, puis fondu linéaire de 0,2 s vers le repos", () => {
    const r = replay({ weapon: (i) => (i < 100 ? "Glock-18" : "AK-47") });
    expectPose(pose(r, 199), { weapon: "glock", to: ["idle", idleT(199)] });
    expectPose(pose(r, 200), { weapon: "ak47", to: ["draw", 0] });
    expectPose(pose(r, 232), { weapon: "ak47", to: ["draw", 0.5] });
    expectPose(pose(r, 263), { to: ["draw", 0.8] });  // clip fini (0,8 s), tenu jusqu'à 1 s
    expectPose(pose(r, 270.4), { to: ["idle", idleT(270.4)], from: ["draw", 0.8], w: 0.5 });
    expectPose(pose(r, 280), { to: ["idle", idleT(280)] });
    expectPose(pose(replay({ weapon: () => "AK-47" }), 10), { to: ["idle", idleT(10)] });  // pas de sortie au début
  });

  it("arme pas encore chargée (aucun clip) : repos à l'instant 0", () => {
    const none: VmDur = () => null;
    expectPose(pose(replay({ weapon: () => "AK-47", shots: [shot(200)] }), 210, none), { to: ["idle", 0] });
  });
});

describe("armes à feu", () => {
  it("tir : clip relancé à chaque tir du joueur, tenu max(cadence, 0,5 s) après le coup, puis 0,2 s vers le repos", () => {
    const r = replay({ weapon: () => "AK-47", shots: [shot(200), shot(240), shot(260, "b")] });
    expectPose(pose(r, 210), { to: ["shoot", 10 / R] });
    expectPose(pose(r, 236), { to: ["idle", idleT(236)], from: ["shoot", 36 / R], w: 4 / 12.8 });
    expectPose(pose(r, 240), { to: ["shoot", 0] });
    expectPose(pose(r, 265), { to: ["shoot", 25 / R] });  // le tir de « b » ne compte pas
    expectPose(pose(r, 278.4), { to: ["idle", idleT(278.4)], from: ["shoot", 0.6], w: 0.5 });
    expectPose(pose(r, 300), { to: ["idle", idleT(300)] });
  });

  it("tir à cadence lente (AWP, 1,455 s) : tenu toute la cadence", () => {
    const d = mkDur({ "awp.shoot": 1.5 });
    const r = replay({ weapon: () => "AWP", shots: [shot(200)] });
    expectPose(pose(r, 289.6, d), { weapon: "awp", to: ["shoot", 1.4] });
    expectPose(pose(r, 296, d), { to: ["idle", idleT(296)], from: ["shoot", 1.5], w: 2.88 / 12.8 });
  });

  it("dernier coup du chargeur : tir à vide puis repos à vide (s'ils existent)", () => {
    const clip = (i: number) => (i < 100 ? 2 : i < 105 ? 1 : 0);  // 1 dès le tick 200, 0 dès le tick 210
    const r = replay({ weapon: () => "Glock-18", clip, shots: [shot(199), shot(209)] });
    expectPose(pose(r, 205), { to: ["shoot", 6 / R] });
    expectPose(pose(r, 215), { to: ["shoot_empty", 6 / R] });
    expectPose(pose(r, 247.4), { to: ["idle_empty", idleT(247.4, 1.5)], from: ["shoot_empty", 0.6], w: 0.5 });
    const plain = mkDur({ shoot_empty: null, idle_empty: null });
    expectPose(pose(r, 215, plain), { to: ["shoot", 6 / R] });
    expectPose(pose(r, 247.4, plain), { to: ["idle", idleT(247.4)], from: ["shoot", 0.6], w: 0.5 });
  });

  it("rechargement : début à la touche R, fondu d'entrée 0,2 s, tenu durée du clip + 0,15 s, puis 0,2 s vers le repos", () => {
    const keys = held([115, 117, KEYS.RELOAD]);  // R aux ticks 230 à 234
    const clip = (i: number) => (i < 150 ? 5 : 30);  // le chargeur remonte au tick 300 (vers 45 % du clip)
    const r = replay({ weapon: () => "AK-47", keys, clip });
    expectPose(pose(r, 229), { to: ["idle", idleT(229)] });
    expectPose(pose(r, 236), { to: ["reload", 6 / R], from: ["idle", idleT(236)], w: 6 / 12.8 });
    expectPose(pose(r, 300), { to: ["reload", 70 / R] });
    expectPose(pose(r, 394), { to: ["reload", 2.4] });  // fin : max(230 + 2,55 s, 300 + 0,55 × 2,4 s + 0,15 s) = 394,08
    expectPose(pose(r, 400), { to: ["idle", idleT(400)], from: ["reload", 2.4], w: (400 - 394.08) / 12.8 });
    // R chargeur plein (rien ne remonte) : pas de rechargement
    expectPose(pose(replay({ weapon: () => "AK-47", keys, clip: () => 30 }), 300), { to: ["idle", idleT(300)] });
  });

  it("rechargement sans touche R : début déduit, le chargeur des images remontant à 45 % du clip ; à vide : reload_empty", () => {
    const r = replay({ weapon: () => "AK-47", clip: (i) => (i < 150 ? 5 : 30) });
    const start = 300 - 0.45 * 2.4 * R;  // 230,88
    expectPose(pose(r, 230), { to: ["idle", idleT(230)] });
    expectPose(pose(r, 236), { to: ["reload", (236 - start) / R], from: ["idle", idleT(236)], w: (236 - start) / 12.8 });
    expectPose(pose(r, 260), { to: ["reload", (260 - start) / R] });
    const empty = replay({ weapon: () => "AK-47", clip: (i) => (i < 150 ? 0 : 30) });
    expectPose(pose(empty, 260), { to: ["reload_empty", (260 - (300 - 0.45 * 2.8 * R)) / R] });
    expectPose(pose(empty, 260, mkDur({ reload_empty: null })), { to: ["reload", (260 - start) / R] });
  });

  it("rechargement qui suit une rafale : il commence après le dernier coup, fondu de 0,2 s depuis le tir", () => {
    const r = replay({ weapon: () => "AK-47", clip: (i) => (i < 130 ? 27 : 30), shots: [shot(200), shot(206), shot(212)] });
    expectPose(pose(r, 220), { to: ["reload", 7 / R], from: ["shoot", 8 / R], w: 7 / 12.8 });
  });

  it("fusil à pompe (une cartouche à la fois) : un seul rechargement, pas relancé à chaque cartouche", () => {
    const clip = (i: number) => (i < 150 ? 3 : i < 170 ? 4 : i < 190 ? 5 : 6);  // remonte aux ticks 300, 340, 380
    const r = replay({ weapon: () => "Nova", clip });
    const d = mkDur({ "nova.reload": 0.9 });
    const end = 380 + (0.55 * 0.9 + 0.15) * R;  // 421,28
    expectPose(pose(r, 360, d), { weapon: "nova", to: ["reload", 0.9] });
    expectPose(pose(r, 420, d), { to: ["reload", 0.9] });
    expectPose(pose(r, 430, d), { to: ["idle", idleT(430)], from: ["reload", 0.9], w: (430 - end) / 12.8 });
  });

  it("Zeus (absent des tirs) : tir au clic gauche", () => {
    const r = replay({ weapon: () => "Zeus x27", keys: held([100, 101, KEYS.FIRE]) });
    expectPose(pose(r, 210), { weapon: "taser", to: ["shoot", 10 / R] });
  });
});

describe("couteau", () => {
  const light = (t: number): VmClip => (vmVariant(t) ? "attack_alt" : "attack");

  it("coup léger au clic gauche, lourd au clic droit (sans 2e variante : rôle de base) ; tenu 0,6 s puis 0,2 s vers le repos", () => {
    const r = replay({ weapon: () => "Karambit", keys: held([50, 51, KEYS.FIRE], [100, 101, KEYS.RIGHTCLICK]) });
    expectPose(pose(r, 110), { weapon: "knife_t", to: [light(100), 10 / R] });
    expectPose(pose(r, 144.8), { to: ["idle", idleT(144.8)], from: [light(100), 0.7], w: 0.5 });
    expectPose(pose(r, 210), { to: ["attack2", 10 / R] });
    expect(pose(replay({ weapon: () => "Knife", side: "CT" }), 10)?.weapon).toBe("knife");
  });

  it("touché ou dans le dos : blessure du même attaquant entre −3 et +14 ticks du coup, dans le dos si ≥ 85 ; variantes par le tick", () => {
    const keys = held([50, 50, KEYS.FIRE], [150, 150, KEYS.FIRE], [250, 250, KEYS.FIRE], [350, 350, KEYS.RIGHTCLICK],
      [450, 450, KEYS.RIGHTCLICK], [550, 550, KEYS.FIRE], [650, 650, KEYS.FIRE], [850, 850, KEYS.FIRE], [950, 950, KEYS.FIRE],
      [1000, 1000, KEYS.FIRE], [1050, 1050, KEYS.RIGHTCLICK], [1100, 1100, KEYS.RIGHTCLICK]);
    const r = replay({
      weapon: () => "Karambit", keys,
      damages: [hurt(105, 34), hurt(297, 90), hurt(515, 40), hurt(714, 65), hurt(901, 153), hurt(1105, 100, "b"), hurt(1305, 8),
        hurt(1701, 30), hurt(1901, 90), hurt(1996, 34), hurt(2105, 84), hurt(2205, 85)],
      grenades: [{ id: 1, type: "molotov", thrower: "a", throw_tick: 1150, detonate_tick: 1200, end_tick: 1600 },
        { id: 2, type: "he", thrower: "a", throw_tick: 1600, detonate_tick: 1700, end_tick: 1700 }],
      bomb: [{ tick: 1900, type: "explode", player: null, site: "A", pos: null }],
    });
    expectPose(pose(r, 110), { to: [vmVariant(100) ? "hit_alt" : "hit", 10 / R] });
    expectPose(pose(r, 310), { to: [vmVariant(300) ? "backstab_alt" : "backstab", 10 / R] });
    expectPose(pose(r, 510), { to: [light(500), 10 / R] });  // blessure à +15 ticks : coup dans le vide
    expectPose(pose(r, 520), { to: ["hit2", 5 / R] });  // … et la blessure seule donne un coup (lourd : aucun clic tenu)
    expectPose(pose(r, 710), { to: ["hit2", 10 / R] });  // coup lourd touché (pas de 2e variante)
    expectPose(pose(r, 910), { to: ["backstab2", 10 / R] });
    expectPose(pose(r, 1110), { to: [light(1100), 10 / R] });  // blessure d'un autre joueur : ignorée
    expectPose(pose(r, 1310), { to: [light(1300), 10 / R] });  // brûlure de sa molotov : pas un coup de couteau
    expectPose(pose(r, 1710), { to: [light(1700), 10 / R] });  // explosion de sa HE : non plus
    expectPose(pose(r, 1910), { to: [light(1900), 10 / R] });  // ni celle du C4
    expectPose(pose(r, 1998), { to: ["hit2", 2 / R] });  // blessure à −4 ticks du coup suivant : hors fenêtre, coup à part
    expectPose(pose(r, 2010), { to: [light(2000), 10 / R] });  // … et ce coup reste dans le vide
    expectPose(pose(r, 2110), { to: ["hit2", 10 / R] });  // 84 : touché
    expectPose(pose(r, 2210), { to: ["backstab2", 10 / R] });  // 85 : dans le dos
    const noHit = mkDur({ hit: null, hit_alt: null });
    expectPose(pose(r, 110, noHit), { to: [light(100), 10 / R] });  // clip absent : coup de base
  });

  it("dégâts bruts + armure ≥ 85 : dans le dos ; avec l'arme des blessures, seules celles du couteau comptent", () => {
    const keys = held([50, 50, KEYS.FIRE], [150, 150, KEYS.RIGHTCLICK], [250, 250, KEYS.FIRE], [350, 350, KEYS.FIRE],
      [450, 450, KEYS.FIRE], [550, 550, KEYS.FIRE]);
    const r = replay({
      weapon: () => "Karambit", keys,
      damages: [hurtW(103, 76, 76, 7, "knife"), hurtW(305, 40, 180, 0, "knife_karambit"), hurtW(504, 34, 34, 3, "knife"),
        hurtW(702, 8, 8, 0, "inferno"), hurtW(903, 60, 90, 0, "bayonet"), hurtW(1103, 78, 78, 8, "knife")],
      grenades: [{ id: 1, type: "molotov", thrower: "a", throw_tick: 400, detonate_tick: 450, end_tick: 900 }],
    });
    expectPose(pose(r, 110), { to: [vmVariant(100) ? "hit_alt" : "hit", 10 / R] });  // léger sur armure : 76 + 7 = 83
    expectPose(pose(r, 310), { to: ["backstab2", 10 / R] });  // tue un joueur à 40 PV : 180 bruts
    expectPose(pose(r, 510), { to: [vmVariant(500) ? "hit_alt" : "hit", 10 / R] });  // vrai coup pendant sa molotov
    expectPose(pose(r, 710), { to: [vmVariant(700) ? "attack_alt" : "attack", 10 / R] });  // brûlure : pas un coup
    expectPose(pose(r, 910), { to: [vmVariant(900) ? "backstab_alt" : "backstab", 10 / R] });  // couteau décoré, bruts 90
    expectPose(pose(r, 1110), { to: [vmVariant(1100) ? "backstab_alt" : "backstab", 10 / R] });  // 78 + 8 d'armure = 86
    // ancien replay (dégâts réels seulement) : le même coup qui tue à 40 PV reste « touché »
    const old = replay({ weapon: () => "Karambit", keys, damages: [hurt(305, 40)] });
    expectPose(pose(old, 310), { to: ["hit2", 10 / R] });
  });

  it("ancien replay sans touches : coups déduits des blessures (lourds)", () => {
    const r = replay({ weapon: () => "Knife", side: "CT", damages: [hurt(400, 34), hurt(600, 120)] });
    expectPose(pose(r, 410), { weapon: "knife", to: ["hit2", 10 / R] });
    expectPose(pose(r, 610), { to: ["backstab2", 10 / R] });
  });
});

describe("grenades", () => {
  const smoke = (throw_tick: number): Partial<GrenadeEvent> => ({ id: throw_tick, type: "smoke", thrower: "a", throw_tick });

  it("dégoupillage tant que le clic est tenu, lancer au tick du lancer (grenade cachée), coupé par la sortie de l'arme suivante", () => {
    const r = replay({ weapon: (i) => (i < 200 ? "Smoke Grenade" : "AK-47"), keys: held([150, 198, KEYS.FIRE]),
      grenades: [smoke(398)] });
    expectPose(pose(r, 350), { weapon: "smokegrenade", to: ["pullpin", 50 / R] });
    expectPose(pose(r, 390), { to: ["pullpin", 0.97] });  // tenu à sa dernière image
    expectPose(pose(r, 398), { to: ["throw", 0], hide: true });
    expectPose(pose(r, 399), { to: ["throw", 1 / R], hide: true });
    expectPose(pose(r, 400), { weapon: "ak47", to: ["draw", 0] });
    expectPose(pose(r, 446), { weapon: "ak47", to: ["draw", 46 / R] });
    // clic relâché 30 ticks avant le lancer (plus de 0,25 s : ce n'est pas le lancer) : dégoupillage gardé jusqu'au lancer
    const early = replay({ weapon: () => "Smoke Grenade", keys: held([150, 183, KEYS.FIRE]), grenades: [smoke(398)] });
    expectPose(pose(early, 395), { to: ["pullpin", 0.97] });
    expectPose(pose(early, 398), { to: ["throw", 0], hide: true });
    // grenade gardée dégoupillée plus longtemps que la fenêtre de recherche : toujours dégoupillée
    const long = replay({ weapon: () => "Smoke Grenade", keys: held([10, 600, KEYS.FIRE]), grenades: [smoke(1202)] });
    expectPose(pose(long, 1000), { to: ["pullpin", 0.97] });
  });

  it("lancer dès le relâchement du clic quand il précède l'événement de la grenade de 0,25 s au plus, même si l'arme suivante sort avant l'événement", () => {
    // démo G2–Astralis : le clic est relâché 5 à 7 ticks avant l'apparition de la grenade (médiane 6, au plus 14, 484
    // lancers) ; le lancer observé part au weapon_fire, au relâchement (NertZ : 14234, notre événement : 14241)
    const r = replay({ weapon: (i) => (i < 200 ? "Smoke Grenade" : "AK-47"), keys: held([150, 195, KEYS.FIRE]),
      grenades: [smoke(398)] });  // relâché au tick 392 (échantillon 196), événement au tick 398
    expectPose(pose(r, 391), { to: ["pullpin", 0.97] });
    expectPose(pose(r, 392), { to: ["throw", 0], hide: true });
    expectPose(pose(r, 396), { to: ["throw", 4 / R], hide: true });
    // un seul lancer : à l'événement (398), le clip continue, il ne repart pas de 0
    expectPose(pose(r, 398), { to: ["throw", 6 / R], hide: true });
    expectPose(pose(r, 399), { to: ["throw", 7 / R], hide: true });
    expectPose(pose(r, 400), { weapon: "ak47", to: ["draw", 0] });
    // frontière de 0,25 s (16 ticks) : relâché 16 ticks avant l'événement, le lancer part du relâchement ; 18 ticks avant,
    // de l'événement (le dégoupillage est gardé jusque-là)
    const at16 = replay({ weapon: () => "Smoke Grenade", keys: held([150, 191, KEYS.FIRE]), grenades: [smoke(400)] });
    expectPose(pose(at16, 385), { to: ["throw", 1 / R], hide: true });  // relâché au tick 384
    const at18 = replay({ weapon: () => "Smoke Grenade", keys: held([150, 190, KEYS.FIRE]), grenades: [smoke(400)] });
    expectPose(pose(at18, 385), { to: ["pullpin", 0.97] });  // relâché au tick 382
    expectPose(pose(at18, 400), { to: ["throw", 0], hide: true });
    // un clic de l'arme suivante (sortie avant l'événement) n'est pas pris pour le relâchement de la grenade
    const next = replay({ weapon: (i) => (i < 198 ? "Smoke Grenade" : "AK-47"),
      keys: held([150, 195, KEYS.FIRE], [198, 198, KEYS.FIRE]), grenades: [smoke(400)] });
    expectPose(pose(next, 393), { weapon: "smokegrenade", to: ["throw", 1 / R], hide: true });  // relâché au tick 392
    // l'arme suivante sort avant l'événement (NertZ au tick 14241 ; 22 % des lancers de la démo) : le lancer est montré
    const cut = replay({ weapon: (i) => (i < 198 ? "Smoke Grenade" : "AK-47"), keys: held([150, 195, KEYS.FIRE]),
      grenades: [smoke(400)] });
    expectPose(pose(cut, 394), { to: ["throw", 2 / R], hide: true });
    expectPose(pose(cut, 396), { weapon: "ak47", to: ["draw", 0] });
    // par-dessous : clic droit seul, relâché avant l'événement
    const under = replay({ weapon: () => "Smoke Grenade", keys: held([150, 195, KEYS.RIGHTCLICK]), grenades: [smoke(398)] });
    expectPose(pose(under, 394), { to: ["throw_underhand", 2 / R], hide: true });
    // par-dessous, l'arme suivante sortie avant l'événement avec le clic gauche tenu : seuls les clics de la grenade comptent
    const underNext = replay({ weapon: (i) => (i < 198 ? "Smoke Grenade" : "AK-47"),
      keys: held([150, 195, KEYS.RIGHTCLICK], [198, 200, KEYS.FIRE]), grenades: [smoke(400)] });
    expectPose(pose(underNext, 394), { weapon: "smokegrenade", to: ["throw_underhand", 2 / R], hide: true });
  });

  it("lancer tenu 0,9 s puis 0,2 s vers le repos (grenade cachée jusqu'au bout) ; par-dessous au clic droit", () => {
    const r = replay({ weapon: () => "Smoke Grenade", keys: held([150, 198, KEYS.RIGHTCLICK]), grenades: [smoke(398)] });
    expectPose(pose(r, 410), { to: ["throw_underhand", 12 / R], hide: true });
    expectPose(pose(r, 462), { to: ["idle", idleT(462)], from: ["throw_underhand", 0.7], w: 0.5, hide: true });
    expectPose(pose(r, 470), { to: ["idle", idleT(470)] });
    expectPose(pose(r, 410, mkDur({ throw_underhand: null })), { to: ["throw", 12 / R], hide: true });
  });

  it("sans touches : dégoupillage anticipé 70 ticks avant le lancer, au repos seulement (après la sortie)", () => {
    const weapon = (i: number) => (i < 50 ? "Glock-18" : "Smoke Grenade");  // sortie au tick 100, tenue jusqu'à 164
    const soon = replay({ weapon, grenades: [smoke(200)] });
    expectPose(pose(soon, 150), { to: ["draw", 0.78125] });
    expectPose(pose(soon, 170), { to: ["pullpin", 6 / R] });
    expectPose(pose(soon, 201), { to: ["throw", 1 / R], hide: true });
    const later = replay({ weapon, grenades: [smoke(300)] });
    expectPose(pose(later, 200), { to: ["idle", idleT(200)] });
    expectPose(pose(later, 240), { to: ["pullpin", 10 / R] });
    // avec les touches : le clic fait foi, pas d'anticipation
    const keyed = replay({ weapon, keys: held([140, 149, KEYS.FIRE]), grenades: [smoke(300)] });
    expectPose(pose(keyed, 240), { to: ["idle", idleT(240)] });
    expectPose(pose(keyed, 285), { to: ["pullpin", 5 / R] });
  });
});

describe("C4", () => {
  const weapon = (i: number) => (i < 300 ? "C4 Explosive" : "Knife");
  it("pose de « posé − 3,125 s » au tick de la pose, fondu d'entrée 0,2 s ; sans clip de pose ou pour un autre joueur : repos", () => {
    const r = replay({ weapon, bomb: [{ tick: 600, type: "plant", player: "a", site: "A", pos: null }] });
    expectPose(pose(r, 399), { weapon: "c4", to: ["idle", idleT(399)] });
    expectPose(pose(r, 410), { to: ["plant", 10 / R], from: ["idle", idleT(410)], w: 10 / 12.8 });
    expectPose(pose(r, 500), { to: ["plant", 100 / R] });
    expectPose(pose(r, 500, mkDur({ plant: null })), { to: ["idle", idleT(500)] });
    const other = replay({ weapon, bomb: [{ tick: 600, type: "plant", player: "b", site: "A", pos: null }] });
    expectPose(pose(other, 500), { to: ["idle", idleT(500)] });
    // clic gauche avec le C4 sans pose enregistrée : rien
    expectPose(pose(replay({ weapon, keys: (i) => (i > 100 ? KEYS.FIRE : 0) }), 300), { to: ["idle", idleT(300)] });
  });
});

describe("recul de la vue au tir (calcul pur)", () => {
  /** Formule de la § 4.3 de l'analyse : un tir vieux de y ticks, d'intensité E et de recul horizontal yaw. */
  const one = (y: number, E: number, yaw: number, a: number, scale: number) => {
    const M = (y < 1.5 ? y / 1.5 : 1) * Math.exp(-Math.max(0, y - 1.5) / Math.max(4, 0.28 * a)) * scale;
    return { pitch: -0.32 * E * M, yaw: 0.18 * yaw * M, roll: -0.1 * yaw * M, back: 0.12 * E * M, up: 0.045 * E * M };
  };
  const sum = (xs: ReturnType<typeof one>[]) => xs.reduce((s, x) => ({ pitch: s.pitch + x.pitch, yaw: s.yaw + x.yaw,
    roll: s.roll + x.roll, back: s.back + x.back, up: s.up + x.up }), { pitch: 0, yaw: 0, roll: 0, back: 0, up: 0 });
  const close = (got: object, want: object, digits = 9) => {
    for (const [k, v] of Object.entries(want)) expect((got as Record<string, number>)[k]).toBeCloseTo(v, digits);
  };
  const a = 0.75 * 64 * 0.506;  // AK : fenêtre de 24,3 ticks

  it("un tir : montée en 1,5 tick, décroissance, rien au-delà de la fenêtre ; E du recul enregistré (borné à 3,2)", () => {
    // recul de « b » au même tick, après celui de « a » : seul celui du joueur suivi compte
    const r = replay({ weapon: () => "AK-47", shots: [shot(200), shot(200, "b")], punch: [[200, 0, -2, 0.5], [200, 1, -0.1, 0]] });
    const E = Math.min(3.2, 2 * Math.hypot(2, 0.5));
    close(pose(r, 210)!.recoil, one(10, E, 0.5, a, 1.08));
    close(pose(r, 200.75)!.recoil, one(0.75, E, 0.5, a, 1.08));
    close(pose(r, 225)!.recoil, { pitch: 0, yaw: 0, roll: 0, back: 0, up: 0 });
    close(pose(r, 199)!.recoil, { pitch: 0, yaw: 0, roll: 0, back: 0, up: 0 });
  });

  it("sans recul enregistré : E = 0,6 + 0,12 × rang dans la rafale ; tirs d'avant la sortie de l'arme ignorés", () => {
    const r = replay({ weapon: () => "AK-47", shots: [shot(200), shot(206), shot(212)] });
    close(pose(r, 214)!.recoil, sum([one(14, 0.6, 0, a, 1.08), one(8, 0.72, 0, a, 1.08), one(2, 0.84, 0, a, 1.08)]));
    const sw = replay({ weapon: (i) => (i < 104 ? "M4A4" : "AK-47"), shots: [shot(200), shot(212)] });
    close(pose(sw, 214)!.recoil, one(2, 0.6, 0, a, 1.08));
    close(pose(replay({ weapon: () => "Knife", shots: [shot(200)] }), 210)!.recoil, { pitch: 0, back: 0, up: 0 });
  });

  it("ancien payload (recul de la caméra seulement, 4 valeurs) : E de ce recul ; 5 tirs à 1,42° : −1,42°, 0,53 et 0,20 pouce", () => {
    const ticks = [346, 352, 359, 365, 372];
    const r = replay({ weapon: () => "AK-47", shots: ticks.map((t) => shot(t)), punch: ticks.map((t) => [t, 0, -1.42, 0]) });
    close(pose(r, 374)!.recoil, { pitch: -1.42, back: 0.53, up: 0.2 }, 2);
    close(pose(r, 400)!.recoil, { pitch: 0, back: 0, up: 0 });
  });

  // rafale d'AK de NertZ (G2–Astralis, ticks 16346 à 16372, ici − 16000) : recul de la caméra et recul de visée lus au
  // tir par le parseur sur la vraie démo (01/11/2026), [tick, joueur, caméra V, caméra H, visée V, visée H]
  const NERTZ: [number, number, number, number, number, number][] = [[346, 0, -1.099, -0.568, 0, 0],
    [352, 0, -1.357, 0.248, -0.098, -0.051], [359, 0, -1.533, -0.077, -0.624, 0.001], [365, 0, -1.696, -0.055, -1.439, -0.073],
    [372, 0, -1.82, 0.399, -2.305, -0.097]];
  const burst = () => replay({ weapon: () => "AK-47", shots: NERTZ.map(([t]) => shot(t)), punch: NERTZ });

  it("recul de visée au tir (6 valeurs) : E = 2 × |visée|, 0,6 au 1er tir (visée nulle) ; table relevée retrouvée", () => {
    const r = burst();
    // tick : [tangage °, recul arrière, montée (pouces)] du tableau relevé par l'analyse (arrondis au centième)
    const table: [number, number, number, number][] = [[347, -0.14, 0.05, 0.02], [366, -0.89, 0.33, 0.13],
      [374, -1.42, 0.53, 0.2], [380, -0.59, 0.22, 0.08], [390, -0.1, 0.04, 0.01], [400, 0, 0, 0]];
    for (const [t, pitch, back, up] of table) {
      const got = pose(r, t)!.recoil;
      for (const [k, v] of Object.entries({ pitch, back, up })) expect(Math.abs(got[k as "pitch"] - v), `${t} ${k}`).toBeLessThanOrEqual(0.006);
    }
    // 1er tir : visée nulle → repli 0,6 (et non le recul de la caméra de ce tir, −1,10 / −0,57)
    close(pose(r, 347)!.recoil, one(1, 0.6, 0, a, 1.08));
  });

  it("round mêlant les deux formats : recul de visée pour les entrées à 6 valeurs, de la caméra pour celles à 4", () => {
    const r = replay({ weapon: () => "AK-47", shots: [shot(200), shot(206)],
      punch: [[200, 0, -2, 0.5, -0.3, 0.1], [206, 0, -1.5, -0.4]] });
    const E = (v: number, h: number) => Math.min(3.2, Math.max(0.35, 2 * Math.hypot(v, h)));
    close(pose(r, 210)!.recoil, sum([one(10, E(-0.3, 0.1), 0.1, a, 1.08), one(4, E(-1.5, -0.4), -0.4, a, 1.08)]));
  });

  it("recul de visée : le lacet et le roulis suivent aussi son horizontale", () => {
    const at = 374, E = (v: number, h: number) => Math.hypot(v, h) > 0 ? Math.min(3.2, Math.max(0.35, 2 * Math.hypot(v, h))) : 0.6;
    const want = sum(NERTZ.filter(([t]) => at - t < a).map(([t, , , , v, h]) => one(at - t, E(v, h), h, a, 1.08)));
    close(pose(burst(), at)!.recoil, want);
  });
});

describe("anciens replays et pureté", () => {
  it("ancien replay sans touches ni chargeur : sortie et tirs seulement, sans erreur", () => {
    const r = replay({ weapon: (i) => (i < 50 ? "USP-S" : "AK-47"), shots: [shot(300)] });
    expectPose(pose(r, 110), { to: ["draw", 10 / R] });
    expectPose(pose(r, 310), { to: ["shoot", 10 / R] });
  });

  it("fenêtre de recherche : le plus long rechargement (M249, 5,7 s) tenu + 0,15 s et son fondu y tiennent", () => {
    expect(LOOKBACK_S).toBeGreaterThanOrEqual(5.7 + 0.15 + VM_FADE);
    const r = replay({ weapon: () => "M249", clip: (i) => (i < 400 ? 0 : 100) }, 1200);  // remonte au tick 800
    const d = mkDur({ "m249.reload_empty": 5.7 });
    const start = 800 - 0.45 * 5.7 * R, end = 800 + (0.55 * 5.7 + 0.15) * R;
    expectPose(pose(r, end - 1, d), { to: ["reload_empty", 5.7] });
    expect(pose(r, end + 1, d)?.from?.clip).toBe("reload_empty");
    expect(start).toBeGreaterThan(0);
  });

  it("déterministe : même pose pour un même tick, quel que soit l'ordre (lecture, retour arrière, sauts)", () => {
    const make = () => replay({
      weapon: (i) => (i < 100 ? "Glock-18" : i < 400 ? "AK-47" : i < 500 ? "Flashbang" : "Karambit"),
      keys: held([115, 117, KEYS.RELOAD], [430, 470, KEYS.FIRE], [560, 560, KEYS.FIRE]),
      clip: (i) => (i < 150 ? 30 : i < 300 ? 4 : 30),
      shots: [shot(260), shot(266), shot(272), shot(700)], punch: [[260, 0, -1, 0.2], [266, 0, -1.5, -0.3]],
      grenades: [{ id: 1, type: "flash", thrower: "a", throw_tick: 960 }], damages: [hurt(1125, 90)],
    });
    const r = make();
    const ticks = Array.from({ length: 400 }, (_, k) => 150 + k * 3.3);
    const forward = ticks.map((t) => pose(r, t));
    const backward = [...ticks].reverse().map((t) => pose(r, t)).reverse();
    expect(backward).toEqual(forward);
    const order = ticks.map((_, k) => (k * 7919) % ticks.length);  // sauts dans le désordre
    for (const k of order) expect(pose(r, ticks[k])).toEqual(forward[k]);
    const fresh = make();
    expect(ticks.map((t) => pose(fresh, t))).toEqual(forward);  // sans cache
    expect(new Set(forward.map((p) => p?.to.clip)).size).toBeGreaterThan(5);
  });
});
