/**
 * Animation des bras de la vue du joueur (viewmodel), choisie d'après le replay : FONCTION PURE du replay et du tick (aucun
 * état gardé). Le même tick donne toujours la même pose, en lecture, à l'arrêt, en retour arrière ou après un saut (un
 * pilote à état montrerait le repos au milieu d'une rafale après un saut). Les règles reproduisent le comportement
 * observé le 31/10/2026.
 *
 * CONTRAT (consommé par 3B.8, ViewModel, et 3B.9, 2e passe) :
 *
 *   viewmodelPose(replay, tick, steamid, dur) → VmPose | null
 *     dur(arme, clip) : durée (s) du clip de arme-<clé>.glb, null s'il n'existe pas ou n'est pas encore chargé
 *     (ViewModel.duration). Un rôle facultatif absent retombe sur le rôle de base (shoot_empty → shoot…).
 *
 *   null = RIEN À DESSINER : joueur absent ou mort, joueur EN LUNETTE (quelle que soit l'arme : remplace
 *   l'ancienne table VM_HIDE_SCOPED), arme sans bras (absente de weapons.json : seringue…). 3B.9 cache aussi les bras
 *   hors caméra « Joueur » et tant que bras et arme ne sont pas chargés.
 *
 *   VmPose = {
 *     weapon: string                 clé du fichier arme-<clé>.glb ;
 *     to:   { clip, t }              action courante : rôle du clip et instant (s, déjà borné à [0, durée] ; le repos boucle) ;
 *     from: { clip, t } | null       action précédente pendant un fondu (même arme), null hors fondu ;
 *     w: number                      poids de `to` (0..1), linéaire sur la durée du fondu ; 1 si from est null.
 *                                    Pose = mélange os par os : positions interpolées, rotations en slerp, from × (1 − w),
 *                                    to × w ;
 *     hideWeaponModel: boolean       cacher le modèle de l'arme, pas les bras : grenade lancée, du tick du lancer à la fin du
 *                                    fondu qui suit (la sortie de l'arme suivante coupe tout) ;
 *     recoil: { pitch, yaw, roll,    recul de la vue au tir (§ 4.3) : degrés, à ajouter à la rotation du sway (x, y, z) ;
 *               back, up }           pouces, vers l'arrière et vers le haut, sur la racine (application : § 4.1 de l'analyse,
 *                                    racine y − up, z − back ; sway x + pitch, y + yaw, z + roll) ;
 *   }
 *
 * Règles (temps en secondes ; « fondu » = fondu d'entrée de l'action, depuis l'action précédente) :
 *  - repos : idle (idle_empty si le chargeur des images est à 0), boucle sur le temps du replay ; fondu 0,2 ;
 *  - sortie d'arme (draw) : au premier échantillon montrant la nouvelle arme (pas au premier échantillon du round) ;
 *    coupe nette (0), tenue 1 ;
 *  - tir : à chaque tir enregistré du joueur (ShotEvent ; Zeus, absent des tirs : clic gauche) ; coupe nette, clip relancé
 *    à 0 ; tenu max(cadence, 0,5) ; dernier coup du chargeur (chargeur à 0 juste après) : shoot_empty ;
 *  - rechargement : le chargeur des images remonte vers 45 % du clip (WPN_RELOAD_ADD_AMMO), pas à la fin. Début = touche R
 *    si elle précède la remontée d'au plus une durée de clip, sinon remontée − 0,45 × durée ; jamais avant le dernier tir
 *    ni avant la sortie. Tenu durée + 0,15 (et au moins 0,55 × durée + 0,15 après la remontée) ; fondu 0,2 ; pas relancé
 *    s'il est déjà en cours (cartouches du fusil à pompe) ; chargeur à 0 au départ : reload_empty. Pas d'événement
 *    weapon_reload ni d'état « en rechargement » dans le replay (repli) ;
 *  - couteau : coup léger au clic gauche, lourd au clic droit (touches des images) ; touché (hit) ou dans le dos
 *    (backstab, dégâts bruts + armure ≥ 85) si une blessure du même attaquant tombe entre −3 et +14 ticks
 *    du coup ; une blessure sans coup détecté autour donne un coup (lourd si le clic gauche n'est pas tenu ;
 *    anciens replays sans touches : coups lourds déduits des blessures). Blessures retenues : celles dont
 *    l'arme (player_hurt : « knife », « knife_t », « bayonet », « knife_karambit »…) est un couteau ; replays d'avant le
 *    01/11/2026 (ni arme, ni dégâts bruts, ni armure) : dégâts réels seuls, brûlures de ses molotovs, explosion de ses
 *    HE et du C4 écartées par leur timing ;
 *    variante _alt par un hachage du tick du coup ; coupe nette, tenu 0,6 ;
 *  - grenade : dégoupillage (pullpin) au clic tant qu'il est tenu (dernière image gardée), gardé jusqu'au lancer s'il
 *    arrive dans les 70 ticks ; sans clic détecté, anticipé 70 ticks avant le lancer, après la sortie ; coupe nette ;
 *    lancer : au relâchement du clic s'il précède l'événement de la grenade (GrenadeEvent, apparition du projectile) de
 *    0,25 s au plus (5 à 7 ticks dans la démo G2–Astralis ; le lancer observé part au weapon_fire), sinon à
 *    l'événement ; coupe nette, tenu 0,9, modèle caché ; throw_underhand si seul le clic droit était tenu ;
 *  - C4 : pose (plant) de « posé − 3,125 » à « posé » (bomb_planted ; pas de bomb_beginplant dans le replay) ; fondu 0,2.
 * La plus récente action gagne ; une action finie laisse la place au repos.
 */
import type { GrenadeEvent, Side } from "../../shared/api/types";
import { sampleIndex } from "../replay/engine/interp";
import type { Replay } from "../replay/engine/replay";
import { F, FIRE_S, KEYS } from "../replay/engine/state";
import { weaponClass } from "../replay/hud";

/** Rôles des clips (noms des animations de arme-<clé>.glb : ROLES de scripts/map3d/lib/weapons.mjs, vérifié par test).
 *  Couteau : matrice coup (attack = dans le vide, hit = touché, backstab = dans le dos) × suffixe : « » coup léger, « 2 »
 *  coup lourd, « _alt » 2e variante du léger, « 2_alt » 2e variante du lourd (aucune arme ne l'a dans le jeu actuel).
 *  On lit toujours le NOM DU RÔLE : backstab_alt vient du fichier light_backstab2_*, backstab2 de heavy_backstab_*. */
export const VM_CLIPS = [
  "idle", "draw", "shoot", "reload", "attack", "attack2", "pullpin", "throw",
  "shoot_empty", "reload_empty", "idle_empty", "attack_alt", "hit", "hit_alt", "backstab", "backstab_alt",
  "attack2_alt", "hit2", "hit2_alt", "backstab2", "backstab2_alt", "throw_underhand", "plant",
] as const;
export type VmClip = (typeof VM_CLIPS)[number];
/** Un clip et l'instant (s) où le poser. */
export interface VmClipAt { clip: VmClip; t: number }
/** Recul de la vue au tir : angles en degrés, déplacements en pouces (voir l'en-tête). */
export interface VmRecoil { pitch: number; yaw: number; roll: number; back: number; up: number }
/** Pose des bras : arme, action courante, action précédente pendant un fondu et poids de la courante (voir l'en-tête). */
export interface VmPose {
  weapon: string; from: VmClipAt | null; to: VmClipAt; w: number; hideWeaponModel: boolean; recoil: VmRecoil;
}
/** Durée d'un clip d'une arme (s), ou null s'il n'existe pas ou n'est pas encore chargé. */
export type VmDur = (weapon: string, clip: VmClip) => number | null;

/** Nom d'arme des images du replay (demoparser2) → clé des fichiers (arme-<clé>.glb). Même table que
 *  scripts/map3d/lib/weapons.json (le test vérifie qu'elles concordent ; « knife » et « knife_t » y sont des noms
 *  internes : les couteaux du replay, « Knife », « Karambit »…, passent par weaponClass et le camp). */
export const VM_WEAPONS: Record<string, string> = {
  "CZ75-Auto": "cz75a", "Desert Eagle": "deagle", "Dual Berettas": "elite", "Five-SeveN": "fiveseven", "Glock-18": "glock",
  P2000: "hkp2000", P250: "p250", "R8 Revolver": "revolver", "Tec-9": "tec9", "USP-S": "usp_silencer", "PP-Bizon": "bizon",
  "MAC-10": "mac10", "MP5-SD": "mp5sd", MP7: "mp7", MP9: "mp9", P90: "p90", "UMP-45": "ump45", "MAG-7": "mag7",
  Nova: "nova", "Sawed-Off": "sawedoff", XM1014: "xm1014", M249: "m249", Negev: "negev", "AK-47": "ak47", AUG: "aug",
  FAMAS: "famas", "Galil AR": "galilar", M4A4: "m4a1", "M4A1-S": "m4a1_silencer", "SG 553": "sg556", AWP: "awp",
  G3SG1: "g3sg1", "SCAR-20": "scar20", "SSG 08": "ssg08", "Zeus x27": "taser", knife: "knife", knife_t: "knife_t",
  "Decoy Grenade": "decoy", Flashbang: "flashbang", "High Explosive Grenade": "hegrenade", "Incendiary Grenade": "incgrenade",
  Molotov: "molotov", "Smoke Grenade": "smokegrenade", "C4 Explosive": "c4",
};

/** Armes à feu : [cadence m_flCycleTime, m_flRecoveryTimeStandFinal] (s), lues dans scripts/weapons.vdata du CS2 du
 *  propriétaire (1.41.9.2, extrait du spike de la vue) : absentes d'armes.json, donc pas encore dans weapons.json. La
 *  cadence tient le tir (max(cadence, 0,5 s)) ; la récupération règle la fenêtre du recul. Glock, Five-SeveN, P250 :
 *  [0,15 ; 0,3] dans le fichier (2e valeur : rafale) ; R8 : [0,5 ; 0,4] ; on garde la 1re. */
export const VM_GUNS: Record<string, readonly [cycle: number, recovery: number]> = {
  cz75a: [0.1, 0.345], deagle: [0.225, 0.811], elite: [0.12, 0.525], fiveseven: [0.15, 0.5], glock: [0.15, 0.33],
  hkp2000: [0.17, 0.35], p250: [0.15, 0.345], revolver: [0.5, 0.811], tec9: [0.12, 0.391], usp_silencer: [0.17, 0.35],
  bizon: [0.08, 0.332], mac10: [0.075, 0.4], mp5sd: [0.08, 0.437], mp7: [0.08, 0.437], mp9: [0.07, 0.258],
  p90: [0.07, 0.372], ump45: [0.09, 0.35], mag7: [0.85, 0.4], nova: [0.88, 0.461], sawedoff: [0.85, 0.461],
  xm1014: [0.35, 0.507], m249: [0.08, 0.829], negev: [0.075, 0.1], ak47: [0.1, 0.506], aug: [0.1, 0.43],
  famas: [0.09, 0.5], galilar: [0.09, 0.5], m4a1: [0.09, 0.466], m4a1_silencer: [0.1, 0.466], sg556: [0.11, 0.453],
  awp: [1.455, 0.345], g3sg1: [0.25, 0.544], scar20: [0.25, 0.544], ssg08: [1.25, 0.142],
};
/** Échelle du recul de la vue : valeurs connues par l'analyse pour trois armes ; 1 pour les autres (valeurs
 *  inconnues ; l'intensité de chaque tir vient déjà de son recul enregistré, propre à l'arme). */
const RECOIL_SCALE: Record<string, number> = { ak47: 1.08, m4a1: 0.92, m4a1_silencer: 0.78 };

/** Fondu par défaut (repos, rechargement, pose du C4) ; 0 à l'entrée du tir, de la sortie, du coup de couteau, du
 *  dégoupillage et du lancer (§ 1.3 : entrée des attaques à 0 s dans les graphes des armes, du couteau et des grenades). */
export const VM_FADE = 0.2;
/** Au-delà, toute action est finie : plus long rechargement (M249, 5,7 s) + 0,15 s tenu + fondu, avec de la marge. */
export const LOOKBACK_S = 6.5;
const DRAW_HOLD = 1, FIRE_HOLD = 0.5, KNIFE_HOLD = 0.6, THROW_HOLD = 0.9, RELOAD_EXTRA = 0.15, PLANT_S = 3.125;
const RELOAD_AMMO_AT = 0.45;  // le chargeur des images remonte vers 45 % du clip de rechargement
// le projectile d'une grenade apparaît 5 à 7 ticks (au plus 14) après le relâchement du clic qui la lance (démo G2–Astralis)
const THROW_RELEASE = 0.25;
// fenêtres relevées en ticks d'une démo à 64 ticks/s, ramenées en secondes
const HIT_BEFORE = 3 / 64, HIT_AFTER = 14 / 64, PULLPIN_LEAD = 70 / 64, NADE_HURT = 2 / 64;
const BACKSTAB_DMG = 85, UNKNOWN = 65535;  // chargeur inconnu (images v3)
const BTN = KEYS.FIRE | KEYS.RIGHTCLICK;

const NADES: Record<GrenadeEvent["type"], string> = { smoke: "smokegrenade", flash: "flashbang", he: "hegrenade",
  molotov: "molotov", incendiary: "incgrenade", decoy: "decoy" };
const NADE_KEYS = new Set(Object.values(NADES));
type Kind = "gun" | "zeus" | "knife" | "nade" | "c4";
const kindOf = (key: string): Kind =>
  key === "knife" || key === "knife_t" ? "knife" : key === "c4" ? "c4" : key === "taser" ? "zeus" : NADE_KEYS.has(key) ? "nade" : "gun";
/** Coups du couteau : [léger, léger 2e variante, lourd, lourd 2e variante]. */
const KNIFE_ROLES: Record<"attack" | "hit" | "backstab", readonly [VmClip, VmClip, VmClip, VmClip]> = {
  attack: ["attack", "attack_alt", "attack2", "attack2_alt"],
  hit: ["hit", "hit_alt", "hit2", "hit2_alt"],
  backstab: ["backstab", "backstab_alt", "backstab2", "backstab2_alt"],
};

/** Clé de fichier de l'arme tenue, d'après son nom dans les images ; null si elle n'est pas dans la liste des armes. */
export const weaponKey = (name: string, side: Side): string | null =>
  weaponClass(name) === "knife" ? (side === "T" ? "knife_t" : "knife") : Object.hasOwn(VM_WEAPONS, name) ? VM_WEAPONS[name] : null;

/** Variante (0 ou 1) d'une action commencée au tick `tick` : hachage multiplicatif du tick, stable. */
export const vmVariant = (tick: number): 0 | 1 => (Math.imul(Math.round(tick) | 0, 0x9e3779b1) >>> 31) as 0 | 1;

// recul enregistré au tir (degrés) : horizontal et norme du recul de visée s'il a été lu, sinon du recul de la caméra
interface HShot { tick: number; yaw: number; norm: number }
interface Hist { shots: HShot[]; throws: { tick: number; key: string }[]; hurts: { tick: number; dmg: number }[]; plants: { tick: number }[] }
const hist = new WeakMap<Replay, Map<string, Hist>>();

/** Événements d'un joueur, triés par tick (calculés une fois par replay et par joueur). */
function histOf(r: Replay, sid: string, j: number): Hist {
  let bySid = hist.get(r);
  if (!bySid) hist.set(r, (bySid = new Map()));
  let h = bySid.get(sid);
  if (h) return h;
  const p = r.payload, rate = r.tickrate, byTick = <T extends { tick: number }>(xs: T[]) => xs.sort((a, b) => a.tick - b.tick);
  const punch = new Map<number, [number, number]>();
  // recul de visée (6 valeurs : nul au 1er tir d'une rafale) ; anciens payloads : recul de la caméra
  for (const row of p.frames?.punch ?? []) if (row[1] === j) punch.set(row[0], row.length === 6 ? [row[4], row[5]] : [row[2], row[3]]);
  const shotTicks = [...new Set(p.shots.filter((s) => s.shooter === sid).map((s) => s.tick))];
  const own = p.grenades.filter((g) => g.thrower === sid);
  const near = (t: number, at: number) => Math.abs(t - at) <= NADE_HURT * rate;
  const explode = p.bomb.filter((b) => b.type === "explode").map((b) => b.tick);
  // replays sans l'arme des blessures : écarte par leur timing la brûlure de ses molotovs, l'explosion de ses HE, du C4
  const notKnife = (t: number) => explode.some((e) => near(t, e)) || own.some((g) => g.detonate_tick != null && (
    g.type === "molotov" || g.type === "incendiary"
      ? t >= g.detonate_tick - NADE_HURT * rate && t <= (g.end_tick ?? g.detonate_tick + FIRE_S * rate) + NADE_HURT * rate
      : g.type === "he" && near(t, g.detonate_tick)));
  h = {
    shots: shotTicks.sort((a, b) => a - b).map((tick) => {
      const pu = punch.get(tick);
      return { tick, yaw: pu?.[1] ?? 0, norm: pu ? Math.hypot(pu[0], pu[1]) : 0 };
    }),
    throws: byTick(own.map((g) => ({ tick: g.throw_tick, key: NADES[g.type] }))),
    hurts: byTick(p.damages
      .filter((d) => d.attacker === sid && d.victim !== sid && (d.weapon !== undefined ? weaponClass(d.weapon) === "knife" : !notKnife(d.tick)))
      .map((d) => ({ tick: d.tick, dmg: (d.raw ?? d.dmg) + (d.armor ?? 0) }))),  // dégâts bruts + armure (sinon réels)
    plants: byTick(p.bomb.filter((b) => b.type === "plant" && b.player === sid).map((b) => ({ tick: b.tick }))),
  };
  bySid.set(sid, h);
  return h;
}

/** Nombre d'éléments de `list` (trié) de tick ≤ t (ou < t si strict). */
function count(list: { tick: number }[], t: number, strict = false): number {
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (strict ? list[mid].tick < t : list[mid].tick <= t) lo = mid + 1; else hi = mid; }
  return lo;
}

/** Une action : clip, début (tick), fin (tick, Infinity si tenue), fondu d'entrée (s). */
interface Act { clip: VmClip; start: number; end: number; fade: number; hide?: boolean; idle?: boolean }
interface Ctx {
  r: Replay; j: number; rate: number; tick: number; i: number; s0: number; key: string; h: Hist;
  since: number;  // tick depuis lequel les actions de cette arme comptent : sortie, ou début de la fenêtre
  drawTick: number | null; dur: VmDur; keys: ((s: number) => number) | null;
  same: (s: number) => boolean;  // l'échantillon s montre-t-il la même arme ?
  pick: (...roles: VmClip[]) => VmClip | null;  // 1er rôle dont le clip existe
}

/**
 * Pose des bras du joueur `sid` au tick `tick` (voir l'en-tête : contrat, règles et données utilisées). Pure : ne dépend
 * que du replay, du tick et des durées des clips.
 */
export function viewmodelPose(r: Replay, tick: number, sid: string, dur: VmDur): VmPose | null {
  const pl = r.players.find((p) => p.steamid === sid);
  if (!pl) return null;
  const j = pl.index, rate = r.tickrate, { i } = sampleIndex(r.ticks, tick);
  const flags = r.value("flags", i, j);
  if ((flags & F.ALIVE) === 0 || (flags & F.SCOPED) !== 0) return null;
  const name = r.weaponAt(i, j), key = weaponKey(name, pl.side);
  if (!key) return null;
  const same = (s: number) => { const n = r.weaponAt(s, j); return n === name || weaponKey(n, pl.side) === key; };
  const lo = sampleIndex(r.ticks, tick - LOOKBACK_S * rate).i;
  let s0 = i;
  while (s0 > lo && same(s0 - 1)) s0--;
  const drawTick = s0 > 0 && !same(s0 - 1) ? r.ticks[s0] : null;
  const c: Ctx = {
    r, j, rate, tick, i, s0, key, h: histOf(r, sid, j), since: drawTick ?? tick - LOOKBACK_S * rate, drawTick, dur,
    keys: r.has("keys") ? (s) => r.value("keys", s, j) : null, same,
    pick: (...roles) => roles.find((x) => dur(key, x) != null) ?? null,
  };

  const acts: Act[] = [];
  const draw = drawTick !== null ? c.pick("draw") : null;
  if (draw) acts.push({ clip: draw, start: drawTick!, end: drawTick! + DRAW_HOLD * rate, fade: 0 });
  const kind = kindOf(key);
  if (kind === "gun") { gunActs(c, acts); reloadActs(c, acts); }
  else if (kind === "zeus") zeusActs(c, acts);
  else if (kind === "knife") knifeActs(c, acts);
  else if (kind === "nade") nadeActs(c, acts);
  else c4Acts(c, acts);

  // enchaînement : chaque action coupe la précédente ; une action finie laisse le repos (fondu 0,2 s)
  acts.sort((a, b) => a.start - b.start);
  const idle = (start: number): Act => ({ clip: "idle", start, end: Infinity, fade: start === -Infinity ? 0 : VM_FADE, idle: true });
  let prev: Act | null = null, cur = idle(-Infinity);
  for (const a of acts) {
    if (a.start > tick) break;
    if (!cur.idle && cur.end < a.start) { prev = cur; cur = idle(cur.end); }
    prev = cur;
    cur = a;
  }
  if (!cur.idle && cur.end <= tick) { prev = cur; cur = idle(cur.end); }

  const at = (a: Act): VmClipAt => a.idle ? idleAt(c) : { clip: a.clip, t: Math.min(Math.max((tick - a.start) / rate, 0), dur(key, a.clip) ?? 0) };
  const fade = cur.fade * rate;
  let from: VmClipAt | null = null, w = 1;
  if (prev && fade > 0 && tick - cur.start < fade) { w = (tick - cur.start) / fade; from = at(prev); }
  return {
    weapon: key, from, to: at(cur), w, hideWeaponModel: !!cur.hide || (from !== null && !!prev?.hide),
    recoil: kind === "gun" ? recoilAt(c) : { pitch: 0, yaw: 0, roll: 0, back: 0, up: 0 },
  };
}

/** Repos : idle_empty si le chargeur est à 0 (et que le clip existe), sinon idle ; boucle sur le temps du replay. */
function idleAt(c: Ctx): VmClipAt {
  const ammo = c.r.has("clip") ? c.r.value("clip", c.i, c.j) : UNKNOWN;
  const clip = (ammo === 0 ? c.pick("idle_empty", "idle") : null) ?? "idle";
  const d = c.dur(c.key, clip) ?? 0;
  return { clip, t: d > 0 ? (c.tick / c.rate) % d : 0 };
}

/** Ticks des appuis (bit absent à l'échantillon d'avant) sur `bits` dans les échantillons ]s0, sTo] de la même arme. */
function edges(c: Ctx, bits: number, sTo: number): number[] {
  const out: number[] = [];
  if (!c.keys) return out;
  for (let s = c.s0 + 1; s <= sTo && s < c.r.n && c.same(s); s++)
    if ((c.keys(s) & bits) !== 0 && (c.keys(s - 1) & bits) === 0) out.push(c.r.ticks[s]);
  return out;
}

/** Tirs : clip relancé à chaque tir, tenu max(cadence, 0,5 s) ; dernier coup du chargeur : shoot_empty. */
function gunActs(c: Ctx, acts: Act[]) {
  const { r, h, rate } = c, hold = Math.max(VM_GUNS[c.key]?.[0] ?? 0, FIRE_HOLD) * rate;
  for (let k = count(h.shots, c.since, true), b = count(h.shots, c.tick); k < b; k++) {
    const t0 = h.shots[k].tick;
    let s = sampleIndex(r.ticks, t0).i;  // chargeur juste après le tir
    if (r.ticks[s] <= t0) s++;
    const empty = r.has("clip") && s < r.n && c.same(s) && r.value("clip", s, c.j) === 0;
    const clip = empty ? c.pick("shoot_empty", "shoot") : c.pick("shoot");
    if (clip) acts.push({ clip, start: t0, end: t0 + hold, fade: 0 });
  }
}

/** Rechargements d'après le chargeur qui remonte (repli : pas d'événement de rechargement dans le replay). */
function reloadActs(c: Ctx, acts: Act[]) {
  const { r, h, rate, tick } = c;
  if (!r.has("clip")) return;
  const dMax = Math.max(c.dur(c.key, "reload") ?? 0, c.dur(c.key, "reload_empty") ?? 0);
  if (dMax <= 0) return;
  const clip = (s: number) => r.value("clip", s, c.j);
  const sEnd = sampleIndex(r.ticks, tick + dMax * rate).i;  // une remontée après `tick` peut finir un rechargement commencé
  const presses = edges(c, KEYS.RELOAD, sEnd);
  let last: Act | null = null;
  for (let k = c.s0 + 1; k <= sEnd && c.same(k); k++) {
    const a = clip(k - 1), b = clip(k);
    if (a === UNKNOWN || b === UNKNOWN || b <= a) continue;
    const role = a === 0 ? c.pick("reload_empty", "reload") : c.pick("reload");
    if (!role) continue;
    const d = c.dur(c.key, role)! * rate, rise = r.ticks[k];
    const press = presses.filter((p) => p <= rise && p >= rise - d).at(-1);
    let start = press ?? rise - RELOAD_AMMO_AT * d;
    const shotIdx = count(h.shots, rise, true) - 1;  // pas de rechargement pendant les tirs : il suit le dernier coup
    if (shotIdx >= 0 && h.shots[shotIdx].tick >= c.since && start <= h.shots[shotIdx].tick) start = h.shots[shotIdx].tick + 1;
    if (c.drawTick !== null) start = Math.max(start, c.drawTick);
    const end = Math.max(start + d + RELOAD_EXTRA * rate, rise + (1 - RELOAD_AMMO_AT) * d + RELOAD_EXTRA * rate);
    if (last && start < last.end) { last.end = Math.max(last.end, end); continue; }  // déjà en cours : pas relancé
    if (start > tick) break;
    acts.push(last = { clip: role, start, end, fade: VM_FADE });
  }
}

/** Zeus (absent des tirs enregistrés) : tir au clic gauche. */
function zeusActs(c: Ctx, acts: Act[]) {
  const clip = c.pick("shoot");
  if (clip) for (const t of edges(c, KEYS.FIRE, c.i)) acts.push({ clip, start: t, end: t + FIRE_HOLD * c.rate, fade: 0 });
}

/** Couteau : coups aux clics (gauche léger, droit lourd) et aux blessures infligées sans coup détecté autour. */
function knifeActs(c: Ctx, acts: Act[]) {
  const { r, h, rate, tick } = c, before = HIT_BEFORE * rate, after = HIT_AFTER * rate;
  const swings: { tick: number; heavy: boolean; dmg: number | null }[] = [];
  if (c.keys) {
    const sTo = sampleIndex(r.ticks, tick + before).i;  // un coup juste après `tick` peut expliquer une blessure d'avant
    for (let s = c.s0 + 1; s <= sTo && c.same(s); s++) {
      const k = c.keys(s), p = c.keys(s - 1);
      const heavy = (k & KEYS.RIGHTCLICK) !== 0 && (p & KEYS.RIGHTCLICK) === 0;
      if (heavy || ((k & KEYS.FIRE) !== 0 && (p & KEYS.FIRE) === 0)) swings.push({ tick: r.ticks[s], heavy, dmg: null });
    }
  }
  for (let k = count(h.hurts, c.since - after, true), b = count(h.hurts, tick + after); k < b; k++) {
    const hu = h.hurts[k];
    const sw = swings.find((s) => hu.tick >= s.tick - before && hu.tick <= s.tick + after);
    if (sw) { sw.dmg ??= hu.dmg; continue; }
    if (hu.tick < c.since || hu.tick > tick) continue;
    const kk = c.keys ? c.keys(sampleIndex(r.ticks, hu.tick).i) : 0;
    swings.push({ tick: hu.tick, heavy: (kk & KEYS.FIRE) === 0 || (kk & KEYS.RIGHTCLICK) !== 0, dmg: hu.dmg });
  }
  for (const sw of swings) {
    if (sw.tick < c.since || sw.tick > tick) continue;
    const hit = sw.dmg === null ? "attack" : sw.dmg >= BACKSTAB_DMG ? "backstab" : "hit";
    const k = sw.heavy ? 2 : 0, alt = vmVariant(sw.tick) === 1, roles: VmClip[] = [];
    // rôle voulu, puis repli : dans le dos → touché → dans le vide ; 2e variante → 1re ; lourd → léger
    for (const base of hit === "backstab" ? (["backstab", "hit", "attack"] as const) : hit === "hit" ? (["hit", "attack"] as const) : (["attack"] as const)) {
      if (alt) roles.push(KNIFE_ROLES[base][k + 1]);
      roles.push(KNIFE_ROLES[base][k]);
    }
    const clip = c.pick(...roles, "attack");
    if (clip) acts.push({ clip, start: sw.tick, end: sw.tick + KNIFE_HOLD * rate, fade: 0 });
  }
}

/** Grenade : lancers (modèle caché), dégoupillage au clic ou anticipé avant le lancer. */
function nadeActs(c: Ctx, acts: Act[]) {
  const { r, rate, tick, key } = c;
  // débuts des lancers de cette grenade : ceux de la fenêtre et le premier à venir (un lancer dont l'événement tombe dans
  // les THROW_RELEASE s qui suivent `tick` peut déjà avoir commencé). La boucle passe sur les lancers du joueur depuis le
  // début du round (une vingtaine au plus) ; seuls les balayages des touches (throwStart) sont limités à ceux-là
  const ahead = tick + THROW_RELEASE * rate, events: number[] = [];
  for (const t of c.h.throws) {
    if (t.key !== key || t.tick < c.since) continue;
    events.push(t.tick);
    if (t.tick > ahead) break;  // triés par tick : le premier au-delà suffit
  }
  const mine = events.map((at) => throwStart(c, at));
  let lastThrow = -Infinity;
  for (const at of mine) {
    if (at < c.since || at > tick) continue;
    const clip = underhand(c, at) ? c.pick("throw_underhand", "throw") : c.pick("throw");
    if (clip) acts.push({ clip, start: at, end: at + THROW_HOLD * rate, fade: 0, hide: true });
    lastThrow = at;
  }
  const pin = c.pick("pullpin");
  if (!pin) return;
  const lead = PULLPIN_LEAD * rate, next = mine.find((at) => at > tick) ?? null;
  const sNext = next !== null ? sampleIndex(r.ticks, next).i : -1;
  // lancer dans les 70 ticks, l'arme restant en main jusque-là (balayage seulement dans ce cas)
  let soon = next !== null && next - tick <= lead;
  for (let s = c.i + 1; soon && s <= sNext; s++) if (!c.same(s)) soon = false;
  const holding = c.keys !== null && (c.keys(c.i) & BTN) !== 0;
  let press = edges(c, BTN, c.i).filter((t) => t > lastThrow).at(-1);
  // clic tenu depuis avant la fenêtre de recherche (grenade gardée dégoupillée) : dégoupillée depuis le début de la fenêtre
  if (press === undefined && holding && c.drawTick === null && (c.keys!(c.s0) & BTN) !== 0) press = r.ticks[c.s0];
  if (press !== undefined) {
    const end = holding ? Infinity : soon ? next! : press + (c.dur(key, pin) ?? 0) * rate;
    acts.push({ clip: pin, start: press, end, fade: 0 });
    return;
  }
  if (!soon || edges(c, BTN, sNext).some((t) => t > tick)) return;  // le clic, plus tard, fera foi
  // sans clic détecté : anticipé 70 ticks avant le lancer, au repos seulement (après la sortie)
  const start = Math.max(next! - lead, c.drawTick !== null ? c.drawTick + DRAW_HOLD * rate : -Infinity);
  if (start <= tick) acts.push({ clip: pin, start, end: next!, fade: 0 });
}

/** Début d'un lancer : relâchement du clic (gauche ou droit) dans les THROW_RELEASE s qui précèdent l'événement de la
 *  grenade, sur les seuls échantillons de la grenade (l'arme suivante peut sortir avant l'événement : ses clics ne
 *  comptent pas) ; sans touches, ou sans relâchement si proche : l'événement. */
function throwStart(c: Ctx, at: number): number {
  if (!c.keys) return at;
  const lo = at - THROW_RELEASE * c.rate;
  for (let s = sampleIndex(c.r.ticks, at).i; s > c.s0 && c.r.ticks[s] >= lo; s--)
    if (c.same(s) && (c.keys(s) & BTN) === 0 && (c.keys(s - 1) & BTN) !== 0) return c.r.ticks[s];
  return at;
}

/** Lancer par-dessous : seul le clic droit était tenu (dernier échantillon de la grenade avec un clic, dans la seconde
 *  d'avant). Garde-fou : seuls les échantillons de l'arme tenue sont lus (aujourd'hui, `throwTick` ≤ tick donne déjà des
 *  échantillons de ]s0, i]). */
function underhand(c: Ctx, throwTick: number): boolean {
  if (!c.keys) return false;
  for (let s = sampleIndex(c.r.ticks, throwTick).i; s >= c.s0 && c.r.ticks[s] >= throwTick - c.rate; s--) {
    if (!c.same(s)) continue;
    const k = c.keys(s);
    if ((k & BTN) !== 0) return (k & KEYS.RIGHTCLICK) !== 0 && (k & KEYS.FIRE) === 0;
  }
  return false;
}

/** C4 : pose de « posé − 3,125 s » (au plus tôt à la sortie) à « posé ». */
function c4Acts(c: Ctx, acts: Act[]) {
  const clip = c.pick("plant"), span = PLANT_S * c.rate;
  if (!clip) return;
  for (const { tick: at } of c.h.plants) {
    if (at < c.since || at - span > c.tick) continue;
    acts.push({ clip, start: Math.max(at - span, c.drawTick ?? -Infinity), end: at, fade: VM_FADE });
  }
}

/** Recul de la vue au tir (§ 4.3) : somme sur les tirs de l'arme tenue dans une fenêtre de a = max(10 ; 48 × récupération)
 *  ticks (64/s) ; montée en 1,5 tick, décroissance exp(−(y − 1,5) / max(4 ; 0,28 a)) ; intensité E du recul enregistré au
 *  tir (2 × norme, bornée 0,35–3,2) : recul de visée (nul au 1er tir d'une rafale), ou recul de la caméra
 *  dans un payload plus ancien ; nul ou absent : 0,6 + 0,12 × rang dans la rafale (borné à 3,2). Lacet et roulis suivent
 *  l'horizontale du même recul. */
function recoilAt(c: Ctx): VmRecoil {
  const out: VmRecoil = { pitch: 0, yaw: 0, roll: 0, back: 0, up: 0 };
  const g = VM_GUNS[c.key];
  if (!g) return out;
  const a = Math.max(10, 0.75 * 64 * g[1]), tau = Math.max(4, 0.28 * a), scale = RECOIL_SCALE[c.key] ?? 1;
  const to64 = 64 / c.rate, shots = c.h.shots, gap = a / to64;
  for (let k = count(shots, c.tick) - 1; k >= 0; k--) {
    const s = shots[k], y = (c.tick - s.tick) * to64;
    if (y >= a || s.tick < c.since) break;
    let rank = 0;  // tirs d'avant dans la même rafale (écart ≤ a)
    while (rank < 64 && k - rank > 0 && shots[k - rank - 1].tick >= c.since && shots[k - rank].tick - shots[k - rank - 1].tick <= gap) rank++;
    const E = s.norm > 0 ? Math.min(3.2, Math.max(0.35, 2 * s.norm)) : Math.min(3.2, 0.6 + 0.12 * rank);
    const M = (y < 1.5 ? y / 1.5 : 1) * Math.exp(-Math.max(0, y - 1.5) / tau) * scale;
    out.pitch -= 0.32 * E * M;
    out.yaw += 0.18 * s.yaw * M;
    out.roll -= 0.1 * s.yaw * M;
    out.back += 0.12 * E * M;
    out.up += 0.045 * E * M;
  }
  return out;
}
