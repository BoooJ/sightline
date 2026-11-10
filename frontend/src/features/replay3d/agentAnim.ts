/**
 * Animation des joueurs vus de l'extérieur (modèles d'agents de CS2), choisie d'après le replay : FONCTION PURE du replay
 * et du tick, comme viewmodelAnim.ts. Le même tick donne toujours la même pose : en lecture, à l'arrêt, en retour arrière
 * ou après un saut dans la ligne de temps.
 *
 * CONTRAT (consommé par agentLayer.ts) :
 *   agentPose(replay, tick, steamid, dur, rag = null) → AgentPose | null
 *     dur(jeu, clip) : durée (s) d'un clip chargé ; null s'il manque (fichier absent ou pas encore arrivé).
 *     rag : trajectoires des morts prêtes (ragdolls.ts) ; un mort dont la trajectoire est prête est posé en ragdoll
 *     (`ragdoll` : trajectoire et instant ; couches : sa pose vivante du tick du kill, pour les os hors du ragdoll ;
 *     `body` au milieu des corps, au sol), sinon il joue son clip de mort comme avant.
 *   dyingPose(replay, tick, steamid, kill, dur) : pose vivante du mourant (départ du ragdoll, ragdolls.ts).
 *   null = rien à poser : joueur absent du replay, aucun clip utile chargé, ou mort sans kill enregistré, ou mort sans clip
 *   de mort (la croix de la couche des joueurs reste alors).
 *   AgentPose = {
 *     layers : [{ set, clip, t, w }]  clips mélangés, poids de somme 1, instant t (s) déjà borné à [0, durée] ;
 *     aim    : degrés, positif vers le BAS (convention du jeu) : buste et tête penchés d'autant (agentRig.ts) ; 0 si mort ;
 *     weapon : clé de l'arme en main (fichier monde-<clé>.glb, table VM_WEAPONS de viewmodelAnim.ts) ; null : rien ;
 *     body   : { x, y, z, yaw } du corps d'un mort (au sol, à la position de sa mort) ; null pour un vivant.
 *   }
 *   droppedWeapons(replay) → DroppedWeapon[] : armes au sol, une par mort (`victim` : son steamid, identifiant unique),
 *     visibles du tick `from` (inclus) au tick `until` (exclu) ; calculées une fois par replay.
 *   warmAgentAnim(replay) : calcule d'avance les phases des pas et les armes au sol ; à appeler au chargement d'un round.
 *   Allocation : agentPose n'alloue que la pose rendue (l'objet, le tableau des couches, une couche par clip, le corps
 *   d'un mort) : une pose NEUVE à chaque appel, que l'appelant peut garder (agentLayer.ts garde la pose d'un corps au sol
 *   d'un tick à l'autre et compare les poses par identité pour savoir s'il faut reposer le modèle). Les étapes du calcul
 *   écrivent dans des tampons du module, jamais gardés d'un appel à l'autre (ni la fonction `dur`).
 *
 * Règles (vitesses en unités du jeu par seconde, temps en secondes) :
 *  - classe de déplacement d'après l'arme tenue : fusils, snipers, PM et armes lourdes → rifle ; pistolets et Zeus →
 *    pistol ; couteau, grenades, C4 ou rien → knife ; changement de classe fondu sur CLASS_FADE ;
 *  - vitesse : différence des positions à ±VEL_S (nulle sur un saut de position de plus de TELEPORT) ; direction du
 *    déplacement par rapport au regard en 8 directions (n = devant, e = à droite), deux voisines mélangées ; immobile sous
 *    IDLE_V, en mouvement au-delà de MOVE_V (fondu entre) ; marche sous WALK_V, course au-delà de RUN_V (fondu entre) ;
 *    accroupi mélangé selon duck (0 à 1) ;
 *  - pas : la phase des clips de marche, de course et accroupis avance avec la distance parcourue (un cycle de clip =
 *    GAIT.walk, GAIT.run ou GAIT.crouch unités devant, GAIT_SIDE et GAIT_BACK de côté et en arrière, mélangés comme les
 *    clips et selon la direction) ; tous les clips de pas sont lus à la même
 *    phase normalisée ;
 *  - en l'air (drapeau AIRBORNE des images) : saut (jump_*) pendant JUMP_S depuis le décollage, puis en l'air (inair_*)
 *    en boucle ; directions n, e, s, w (stand à l'arrêt) ; fondu d'entrée AIR_IN ; au sol, fondu de sortie AIR_OUT et
 *    clip d'atterrissage land_<classe> (jeu « communes ») après un vol d'au moins MIN_AIR_S, surtout à l'arrêt ;
 *  - pose du C4 (bomb « plant » du joueur) de « posé − PLANT_S » à « posé », puis fondu ; désamorçage (drapeau
 *    DEFUSING) : defuse_enter puis defuse en boucle (defuse_crouch_enter, defuse_crouch accroupi) ; corps entier,
 *    fondus ACT_FADE ;
 *  - mort (kill dont il est la victime) : fondu DEATH_FADE vers un clip de mort choisi par la zone touchée de sa dernière
 *    blessure (DEATH_BY_ZONE) et une variante (vmVariant du tick du kill), tenu sur sa dernière image jusqu'à la fin du
 *    replay ; corps à la position de la mort, au lacet de son dernier instant en vie (pendant le fondu : pose du tick du
 *    kill, arme du dernier instant en vie) ;
 *  - arme au sol : la meilleure arme à feu du mort (principale, à défaut pistolet), quelle que soit l'arme en main ; ni
 *    couteau, ni grenade, ni Zeus, ni C4 ; posée au sol devant et à droite du point de mort (pas du corps qui tombe),
 *    jusqu'à son ramassage.
 */
import type { KillEvent } from "../../shared/api/types";
import { lerp } from "../replay/engine/interp";
import type { Replay, ReplayPlayer } from "../replay/engine/replay";
import { F } from "../replay/engine/state";
import { sortInventory, weaponClass } from "../replay/hud";
import type { RagdollTrack } from "./ragdollSolver";
import { vmVariant, weaponKey } from "./viewmodelAnim";

export type LocoClass = "rifle" | "pistol" | "knife";
/** Jeux de clips (fichiers anims-<jeu>.glb) : un par classe de déplacement, et « communes » (morts, atterrissages). */
export type AnimSet = LocoClass | "communes";
export const LOCO_CLASSES: readonly LocoClass[] = ["rifle", "pistol", "knife"];
export const ANIM_SETS: readonly AnimSet[] = [...LOCO_CLASSES, "communes"];
export const DIRS8 = ["n", "ne", "e", "se", "s", "sw", "w", "nw"] as const;
export const DIRS4 = ["n", "e", "s", "w"] as const;
/** Un clip, l'instant où le poser (s) et son poids. */
export interface ClipRef { set: AnimSet; clip: string; t: number; w: number }
export interface AgentBody { x: number; y: number; z: number; yaw: number }
/** Trajectoire d'une mort (ragdolls.ts) : celle du solveur et l'os de chaque corps (noms du fichier « ragdoll »). */
export interface DeathTrack extends RagdollTrack { bones: readonly string[] }
/** Mort en ragdoll : sa trajectoire et l'instant (secondes depuis la mort). */
export interface RagdollAt { track: DeathTrack; t: number }
/** Trajectoires prêtes : celle de la mort du joueur `sid` au tick `killTick`, ou null (pas encore là, refusée : clip). */
export interface RagdollLookup { track(r: Replay, sid: string, killTick: number): DeathTrack | null }
export interface AgentPose { layers: ClipRef[]; aim: number; weapon: string | null; body: AgentBody | null; ragdoll?: RagdollAt | null }
/** Durée (s) d'un clip chargé, null s'il manque. */
export type ClipDur = (set: AnimSet, clip: string) => number | null;

export const IDLE_V = 15, MOVE_V = 45, WALK_V = 135, RUN_V = 190;
/** Unités parcourues pendant un cycle complet de chaque clip de pas : vitesse du pied posé × durée du clip, mesurée le
 *  02/11/2026 sur les clips de SAS (walk_n 114 u/s sur 1 s ; run_n 191 à 222 u/s sur 0,7333 s). Accroupi réglé à l'essai
 *  réel (06/11/2026, vrais fichiers et vrais replays, pied posé suivi dans le monde) : 70 (avec 50, les pieds posés
 *  reculaient de 20 à 30 u/s pour un joueur à 65-75 u/s ; avec 70, 0 à 5 u/s). Marche et course vers l'avant : pieds
 *  posés immobiles à quelques u/s près. Ce sont les cycles de devant ; ceux de côté et de l'arrière suivent. */
export const GAIT = { walk: 114, run: 150, crouch: 70 };
/** Cycles de la marche et de la course de côté et vers l'arrière (cycleLen les mélange selon la direction) ; accroupi :
 *  GAIT.crouch partout. Réglés à l'essai réel (mêmes mesures, 63 tronçons de 11 rounds) : de côté, glissement médian des
 *  pieds posés en course 63 → 44 u/s, en diagonale 37-51 → 30-41, en marche 27 → 24 ; en arrière, 150 et 114 restent les
 *  meilleurs. Les clips de côté du jeu (pas croisés) glissent encore un peu à toute longueur de cycle. */
export const GAIT_SIDE = { walk: 100, run: 130 }, GAIT_BACK = { walk: 114, run: 150 };
export const VEL_S = 1 / 16;
export const CLASS_FADE = 0.25, AIR_IN = 0.1, AIR_OUT = 0.15, JUMP_S = 0.4, MIN_AIR_S = 0.2, LAND_HOLD = 0.15, LAND_FADE = 0.35;
export const ACT_FADE = 0.2, PLANT_S = 3.125, DEATH_FADE = 0.1;
/** Corps en ragdoll : place du joueur (ses pieds) sous l'os de corps le plus bas, de ce que mesurent les plus gros corps
 *  (rayons de 2 à 7 u) : la sphère de découpage et la coupe « au-dessus de » se calent sur elle. */
export const GROUND_BELOW = 8;
/** Clips de mort (jeu « communes ») par zone touchée de la dernière blessure ; deux variantes quand le jeu en a deux. */
export const DEATH_BY_ZONE: Record<string, readonly string[]> = {
  head: ["mort_chest_a", "mort_chest_b"], neck: ["mort_chest_a", "mort_chest_b"], chest: ["mort_chest_a", "mort_chest_b"],
  generic: ["mort_chest_a", "mort_chest_b"], left_arm: ["mort_chest_a", "mort_chest_b"], right_arm: ["mort_rshoulder"],
  stomach: ["mort_gut_a", "mort_gut_b"], left_leg: ["mort_rknee_a", "mort_rknee_b"], right_leg: ["mort_rknee_a", "mort_rknee_b"],
};
/** Unités entre deux images (ou dans la fenêtre de la vitesse) au-delà desquelles c'est un saut de position (début de
 *  round) : ignoré. */
export const TELEPORT = 64;
const LOOK_AIR = 3, LOOK_DEFUSE = 12;  // s : recherche du décollage, du début du désamorçage

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (x: number) => { const t = clamp01(x); return t * t * (3 - 2 * t); };
const frac = (x: number) => x - Math.floor(x);
export const moveWeight = (v: number) => smooth((v - IDLE_V) / (MOVE_V - IDLE_V));
export const runWeight = (v: number) => smooth((v - WALK_V) / (RUN_V - WALK_V));
/** Unités par cycle de pas à la vitesse v, à l'accroupissement duck (0 à 1) et dans la direction b (degrés, bearing :
 *  0 devant, 90 à droite) : cycles de devant, de côté et de l'arrière mélangés en cos² / sin² de la direction. */
export function cycleLen(v: number, duck: number, b = 0): number {
  const c = Math.cos((b * Math.PI) / 180), cc = c * c, front = c > 0 ? cc : 0, back = c < 0 ? cc : 0, side = 1 - cc;
  const walk = GAIT.walk * front + GAIT_SIDE.walk * side + GAIT_BACK.walk * back;
  const run = GAIT.run * front + GAIT_SIDE.run * side + GAIT_BACK.run * back;
  return lerp(lerp(walk, run, runWeight(v)), GAIT.crouch, clamp01(duck));
}

/** Classe de déplacement d'après le nom de l'arme des images ; gardée par nom (weaponClass recrée une expression
 *  régulière à chaque appel pour les noms hors de sa table : couteaux, grenades, C4). */
const LOCO = new Map<string, LocoClass>();
export function locoClass(weapon: string): LocoClass {
  let cls = LOCO.get(weapon);
  if (cls === undefined) {
    const c = weaponClass(weapon);
    cls = c === "pistol" || c === "zeus" ? "pistol" : c === null || c === "knife" ? "knife" : "rifle";
    LOCO.set(weapon, cls);
  }
  return cls;
}

/** Direction du déplacement par rapport au regard, en degrés dans le sens des aiguilles d'une montre vu de dessus :
 *  0 = devant, 90 = à droite, 180 = derrière, 270 = à gauche (lacet du jeu : 0° = +X, 90° = +Y, à gauche de +X). */
export function bearing(vx: number, vy: number, yawDeg: number): number {
  const a = (Math.atan2(vy, vx) * 180) / Math.PI;
  return (((yawDeg - a) % 360) + 360) % 360;
}

// ─── Calcul sans allocation ───────────────────────────────────────────────────────────────────────────────────────────
// agentPose n'alloue que la pose rendue (voir l'en-tête). Ses étapes écrivent leurs résultats dans S (nombres, écrits en
// place) et dans la liste des couches en cours (OUT_*), que l'appelant lit aussitôt : rien n'y reste d'un appel à l'autre
// (un seul appel à la fois : le navigateur n'a qu'un fil, et `dur` ne rappelle pas agentPose).

/** Résultats des étapes. */
const S = {
  t: NaN,                                                        // sampleAt : part vers l'image suivante
  px: NaN, py: NaN, vx: NaN, vy: NaN,                            // posInto, velInto
  v: NaN, b: NaN, duck: NaN, phase: NaN,                         // motionInto : vitesse, direction, accroupi, pas
  airW: NaN, since: NaN, land: NaN, flight: NaN, landed: false,  // airInto (`land` : valable si `landed`)
  k0: 0, w0: NaN, k1: 0, w1: NaN, nd: 0,                         // dirInto : une ou deux directions voisines
};

/** sampleIndex (engine/interp) sans objet rendu : même calcul ; rang de l'image, part vers la suivante dans S.t. */
function sampleAt(ticks: Int32Array, tick: number): number {
  const n = ticks.length;
  if (n === 0 || tick <= ticks[0]) { S.t = 0; return 0; }
  if (tick >= ticks[n - 1]) { S.t = 0; return n - 1; }
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ticks[mid] <= tick) lo = mid; else hi = mid; }
  S.t = (tick - ticks[lo]) / (ticks[hi] - ticks[lo]);
  return lo;
}

/** Directions voisines dans S : `nd` = 1 (k0, poids w0 = 1) ou 2 (k0, w0 ; k1, w1), de somme 1. */
function dirInto(b: number, n: number) {
  const x = ((((b % 360) + 360) % 360) * n) / 360, k = Math.floor(x) % n, f = x - Math.floor(x);
  S.k0 = k;
  if (f < 1e-9) { S.nd = 1; S.w0 = 1; return; }
  S.nd = 2; S.w0 = 1 - f; S.k1 = (k + 1) % n; S.w1 = f;
}
/** Poids des directions voisines : [indice dans DIRS8 (ou DIRS4), poids], une ou deux entrées, de somme 1. */
function dirWeights(b: number, n: number): [number, number][] {
  dirInto(b, n);
  return S.nd === 1 ? [[S.k0, S.w0]] : [[S.k0, S.w0], [S.k1, S.w1]];
}
export const dirWeights8 = (b: number) => dirWeights(b, 8);
export const dirWeights4 = (b: number) => dirWeights(b, 4);

/** Position horizontale du joueur j au tick, dans S.px, S.py. */
function posInto(r: Replay, j: number, tick: number) {
  const i = sampleAt(r.ticks, tick), t = S.t, i2 = Math.min(i + 1, r.n - 1);
  S.px = lerp(r.value("x", i, j), r.value("x", i2, j), t);
  S.py = lerp(r.value("y", i, j), r.value("y", i2, j), t);
}

/** velocityAt dans S.vx, S.vy. */
function velInto(r: Replay, j: number, tick: number, maxTick: number) {
  const h = VEL_S * r.tickrate, t0 = tick - h, t1 = Math.min(tick + h, maxTick);
  S.vx = 0;
  S.vy = 0;
  if (t1 <= t0) return;
  posInto(r, j, t0);
  const ax = S.px, ay = S.py;
  posInto(r, j, t1);
  const dt = (t1 - t0) / r.tickrate, dx = S.px - ax, dy = S.py - ay;
  if (Math.hypot(dx, dy) > TELEPORT) return;
  S.vx = dx / dt;
  S.vy = dy / dt;
}
/** Vitesse horizontale (unités/s) du joueur j au tick : positions à tick ± VEL_S, sans dépasser `maxTick` (mort) ; nulle
 *  si la fenêtre contient un saut de position (plus de TELEPORT unités), comme pour les pas. */
export function velocityAt(r: Replay, j: number, tick: number, maxTick = Infinity): [number, number] {
  velInto(r, j, tick, maxTick);
  return [S.vx, S.vy];
}

const phases = new WeakMap<Replay, Map<number, Float64Array>>();
/** Phases des pas du joueur j à chaque image (calculées une fois par replay et par joueur). */
function phaseTable(r: Replay, j: number): Float64Array {
  let byJ = phases.get(r);
  if (!byJ) phases.set(r, (byJ = new Map()));
  let p = byJ.get(j);
  if (!p) {
    p = new Float64Array(r.n);
    const duck = r.has("duck");
    for (let s = 1; s < r.n; s++) {
      const dx = r.value("x", s, j) - r.value("x", s - 1, j), dy = r.value("y", s, j) - r.value("y", s - 1, j), d = Math.hypot(dx, dy);
      const dt = (r.ticks[s] - r.ticks[s - 1]) / r.tickrate;
      p[s] = p[s - 1] + (d > TELEPORT || dt <= 0 || d === 0 ? 0
        : d / cycleLen(d / dt, duck ? r.value("duck", s, j) / 255 : 0, bearing(dx, dy, r.value("yaw", s, j))));
    }
    byJ.set(j, p);
  }
  return p;
}
/** Phase des pas (en cycles, croissante) du joueur j au tick : distance parcourue divisée par la longueur du cycle à
 *  chaque image (calculée une fois par replay et par joueur). */
export function gaitPhase(r: Replay, j: number, tick: number): number {
  const p = phaseTable(r, j), i = sampleAt(r.ticks, tick);
  return lerp(p[i], p[Math.min(i + 1, r.n - 1)], S.t);
}

/** En l'air : drapeau AIRBORNE, sauf sur une échelle (LADDER : le joueur grimpe, il ne saute ni ne tombe). */
const isAir = (r: Replay, j: number, s: number) => { const f = r.value("flags", s, j); return (f & F.AIRBORNE) !== 0 && (f & F.LADDER) === 0; };
/** Tick du décollage du vol qui contient l'image e (recherche bornée à l'image lo). */
function airStart(r: Replay, j: number, e: number, lo: number): number {
  let s = e;
  while (s > lo && isAir(r, j, s - 1)) s--;
  return r.ticks[s];
}
/** En l'air, dans S : poids (fondus) `airW`, temps depuis le décollage `since`, temps depuis l'atterrissage `land`
 *  (`landed` faux en vol ou loin du sol), durée du vol `flight`. */
function airInto(r: Replay, j: number, tick: number) {
  const rate = r.tickrate, i = sampleAt(r.ticks, tick), lo = sampleAt(r.ticks, tick - LOOK_AIR * rate);
  S.landed = false;
  S.land = 0;
  if (isAir(r, j, i)) {
    const since = Math.max(0, (tick - airStart(r, j, i, lo)) / rate);
    S.airW = Math.min(1, since / AIR_IN);
    S.since = since;
    S.flight = since;
    return;
  }
  const back = sampleAt(r.ticks, tick - (LAND_HOLD + LAND_FADE) * rate);
  let e = i;
  while (e > back && !isAir(r, j, e)) e--;
  if (!isAir(r, j, e)) { S.airW = 0; S.since = 0; S.flight = 0; return; }
  const landTick = r.ticks[e + 1], t0 = airStart(r, j, e, lo), land = Math.max(0, (tick - landTick) / rate);
  S.airW = Math.max(0, 1 - land / AIR_OUT);
  S.since = (tick - t0) / rate;
  S.landed = true;
  S.land = land;
  S.flight = (landTick - t0) / rate;
}

/** Couches en cours : jeu, clip, instant, poids (au plus 2 classes × 15 clips, plus une action ou une mort). */
const CAP = 64;
const OUT_SET: AnimSet[] = Array.from({ length: CAP }, () => "knife"), OUT_CLIP: string[] = Array.from({ length: CAP }, () => "");
const OUT_T = new Float64Array(CAP), OUT_W = new Float64Array(CAP);
const NO_DUR: ClipDur = () => null;
let outN = 0, curDur: ClipDur = NO_DUR;
function push(set: AnimSet, clip: string, t: number, w: number) {
  if (outN === CAP) return;
  OUT_SET[outN] = set;
  OUT_CLIP[outN] = clip;
  OUT_T[outN] = t;
  OUT_W[outN] = w;
  outN++;
}
/** Clip posé à l'instant t (borné à sa durée), s'il est chargé et que son poids compte. */
function at(set: AnimSet, clip: string, t: number, w: number) {
  if (w < 1e-4) return;
  const d = curDur(set, clip);
  if (d !== null) push(set, clip, Math.min(Math.max(t, 0), d), w);
}
/** Clip en boucle : instant = phase (en cycles) × durée. */
function cyc(set: AnimSet, clip: string, phase: number, w: number) {
  if (w < 1e-4) return;
  const d = curDur(set, clip);
  if (d !== null) push(set, clip, frac(phase) * d, w);
}
/** Clip en boucle : instant = secondes modulo la durée. */
function loop(set: AnimSet, clip: string, s: number, w: number) {
  if (w < 1e-4) return;
  const d = curDur(set, clip);
  if (d !== null) push(set, clip, d > 0 ? ((s % d) + d) % d : 0, w);
}
/** Couches rendues : les couches en cours, poids ramenés à une somme de 1 (un clip absent ne laisse pas de trou : three
 *  mélangerait la pose de référence). Seule allocation d'agentPose, avec l'objet de la pose. */
function layersOut(): ClipRef[] {
  let s = 0;
  for (let k = 0; k < outN; k++) s += OUT_W[k];
  const out = new Array<ClipRef>(outN);
  for (let k = 0; k < outN; k++) out[k] = { set: OUT_SET[k], clip: OUT_CLIP[k], t: OUT_T[k], w: s > 0 ? OUT_W[k] / s : OUT_W[k] };
  return out;
}

// noms des clips, faits une fois
const WALK = DIRS8.map((d) => `walk_${d}`), RUN = DIRS8.map((d) => `run_${d}`), CROUCH = DIRS8.map((d) => `crouch_${d}`);
/** En l'air : 0 = arrêté (stand), 1 à 4 = DIRS4 ; [debout, accroupi]. */
const AIR_DIRS = ["stand", ...DIRS4];
const JUMP = [AIR_DIRS.map((d) => `jump_${d}`), AIR_DIRS.map((d) => `jump_crouch_${d}`)];
const INAIR = [AIR_DIRS.map((d) => `inair_${d}`), AIR_DIRS.map((d) => `inair_crouch_${d}`)];
const LAND: Record<LocoClass, string> = { rifle: "land_rifle", pistol: "land_pistol", knife: "land_knife" };

/** Ce qui décrit le déplacement d'un vivant à un instant, dans S (v, b, duck, phase, et l'état en l'air d'airInto). */
function motionInto(r: Replay, j: number, tick: number, maxTick: number) {
  const i = sampleAt(r.ticks, tick), t = S.t, i2 = Math.min(i + 1, r.n - 1);
  velInto(r, j, tick, maxTick);
  const vx = S.vx, vy = S.vy, yaw = r.value("yaw", i, j);
  S.v = Math.hypot(vx, vy);
  S.b = bearing(vx, vy, yaw);
  const p = phaseTable(r, j);
  S.phase = lerp(p[i], p[i2], t);  // gaitPhase(r, j, tick), même image et même part
  airInto(r, j, tick);
  S.duck = r.has("duck") ? lerp(r.value("duck", i, j), r.value("duck", i2, j), t) / 255 : 0;
}

/** Corps d'un vivant pour une classe, poids k : au sol, en l'air, atterrissage (déplacement : S, de motionInto). */
function living(cls: LocoClass, k: number) {
  const m = moveWeight(S.v), d = clamp01(S.duck);
  const wl = S.landed && S.flight >= MIN_AIR_S ? (1 - smooth((S.land - LAND_HOLD) / LAND_FADE)) * (1 - m) : 0;
  const ka = k * S.airW * (1 - wl), kg = k * (1 - S.airW) * (1 - wl);
  // au sol
  const run = runWeight(S.v);
  at(cls, "idle", 0, kg * (1 - m) * (1 - d));
  at(cls, "idle_crouch", 0, kg * (1 - m) * d);
  if (kg * m >= 1e-4) {
    dirInto(S.b, 8);
    for (let q = 0; q < S.nd; q++) {
      const k8 = q ? S.k1 : S.k0, w = q ? S.w1 : S.w0;
      cyc(cls, WALK[k8], S.phase, kg * m * (1 - d) * (1 - run) * w);
      cyc(cls, RUN[k8], S.phase, kg * m * (1 - d) * run * w);
      cyc(cls, CROUCH[k8], S.phase, kg * m * d * w);
    }
  }
  // en l'air : arrêté (stand) ou dans l'une des 4 directions ; accroupi selon duck
  if (ka >= 1e-4) {
    dirInto(S.b, 4);
    for (let q = -1; q < S.nd; q++) {
      const di = q < 0 ? 0 : 1 + (q ? S.k1 : S.k0), w = q < 0 ? 1 - m : m * (q ? S.w1 : S.w0);
      for (let cr = 0; cr < 2; cr++) {
        const wc = cr ? d : 1 - d;
        if (S.since < JUMP_S) at(cls, JUMP[cr][di], S.since, ka * w * wc);
        else loop(cls, INAIR[cr][di], S.since - JUMP_S, ka * w * wc);
      }
    }
  }
  at("communes", LAND[cls], S.landed ? S.land : 0, k * wl);
}

/** Corps d'un vivant au tick, avec le fondu d'un changement de classe d'arme ; arme lue au plus à l'image `wi` (pendant le
 *  fondu de mort : la dernière image en vie, celle du kill n'a plus d'arme). */
function body(r: Replay, j: number, tick: number, k: number, maxTick = Infinity, wi = Infinity) {
  const rate = r.tickrate, i = Math.min(sampleAt(r.ticks, tick), wi), cls = locoClass(r.weaponAt(i, j));
  motionInto(r, j, tick, maxTick);
  const lo = sampleAt(r.ticks, tick - CLASS_FADE * rate);
  for (let s = i; s > lo; s--) {
    const prev = locoClass(r.weaponAt(s - 1, j));
    if (prev === cls) continue;
    const w = clamp01((tick - r.ticks[s]) / (CLASS_FADE * rate));
    living(cls, k * w);
    living(prev, k * (1 - w));
    return;
  }
  living(cls, k);
}

const isDefusing = (r: Replay, j: number, s: number) => (r.value("flags", s, j) & F.DEFUSING) !== 0;
/** Actions du corps entier (pose du C4, désamorçage) : clips ajoutés et part du corps qu'elles prennent (0 à 1). */
function actions(r: Replay, j: number, sid: string, tick: number): number {
  const rate = r.tickrate, i = sampleAt(r.ticks, tick), t = S.t, i2 = Math.min(i + 1, r.n - 1);
  const duck = r.has("duck") ? lerp(r.value("duck", i, j), r.value("duck", i2, j), t) / 255 : 0;
  const bombs = r.payload.bomb;
  for (let q = 0; q < bombs.length; q++) {
    const b = bombs[q];
    if (b.type !== "plant" || b.player !== sid) continue;
    const start = b.tick - PLANT_S * rate, after = (tick - b.tick) / rate;
    if (tick < start || after > ACT_FADE) continue;
    const w = Math.min(clamp01((tick - start) / rate / ACT_FADE), after > 0 ? 1 - after / ACT_FADE : 1);
    const clip = duck > 0.5 && curDur("knife", "plant_crouch") !== null ? "plant_crouch" : "plant", d = curDur("knife", clip);
    if (d === null || w < 1e-4) return 0;
    at("knife", clip, clamp01((tick - start) / (b.tick - start)) * d, w);
    return w;
  }
  const lo = sampleAt(r.ticks, tick - LOOK_DEFUSE * rate);
  let e = i, w = 1;
  if (!isDefusing(r, j, i)) {
    // fin du désamorçage : fondu de sortie sur la dernière pose
    const back = sampleAt(r.ticks, tick - ACT_FADE * rate);
    while (e > back && !isDefusing(r, j, e)) e--;
    if (!isDefusing(r, j, e)) return 0;
    w = 1 - clamp01((tick - r.ticks[e + 1]) / rate / ACT_FADE);
  }
  let s0 = e;
  while (s0 > lo && isDefusing(r, j, s0 - 1)) s0--;
  const end = e === i ? tick : r.ticks[e + 1], since = (end - r.ticks[s0]) / rate;
  w = Math.min(w, clamp01((tick - r.ticks[s0]) / rate / ACT_FADE));
  if (w < 1e-4) return 0;
  const cls = locoClass(r.weaponAt(e, j)), crouch = duck > 0.5 && curDur(cls, "defuse_crouch") !== null;
  const pre = crouch ? "defuse_crouch" : "defuse", enterClip = crouch ? "defuse_crouch_enter" : "defuse_enter";
  const enter = curDur(cls, enterClip), n = outN;
  if (enter !== null && since < enter) at(cls, enterClip, since, w);
  else loop(cls, pre, since - (enter ?? 0), w);
  return outN > n ? w : 0;
}

/** Zone touchée de la dernière blessure reçue par `sid` jusqu'au tick (« generic » sans blessure). */
export function lastZone(r: Replay, sid: string, tick: number): string {
  const ds = r.payload.damages;
  let best: { tick: number; hitgroup: string } | null = null;
  for (let q = 0; q < ds.length; q++) {
    const d = ds[q];
    if (d.victim === sid && d.tick <= tick && (!best || d.tick >= best.tick)) best = d;
  }
  return best?.hitgroup || "generic";
}

/** Rang du dernier échantillon où le joueur j est en vie, au plus `i`. */
function lastAlive(r: Replay, j: number, i: number): number {
  let a = i;
  while (a > 0 && (r.value("flags", a, j) & F.ALIVE) === 0) a--;
  return a;
}

/** Clip de mort : la variante `v` des clips de la zone, sinon le premier chargé de la zone, sinon mort_chest_a ; null si
 *  aucun n'est chargé. */
function deathClip(roles: readonly string[], v: number): string | null {
  const first = roles[v % roles.length];
  if (curDur("communes", first) !== null) return first;
  for (let q = 0; q < roles.length; q++) if (curDur("communes", roles[q]) !== null) return roles[q];
  return curDur("communes", "mort_chest_a") !== null ? "mort_chest_a" : null;
}

/** Pose du joueur `sid` au tick (voir l'en-tête : contrat et règles). Pure : ne dépend que du replay, du tick et des
 *  durées des clips. */
export function agentPose(r: Replay, tick: number, sid: string, dur: ClipDur, rag: RagdollLookup | null = null): AgentPose | null {
  curDur = dur;
  outN = 0;
  try {
    return poseOf(r, tick, sid, rag);
  } finally {
    curDur = NO_DUR;  // la bibliothèque des clips n'est pas gardée entre deux appels
  }
}

function poseOf(r: Replay, tick: number, sid: string, rag: RagdollLookup | null): AgentPose | null {
  const players = r.players;
  let pl: ReplayPlayer | null = null;
  for (let q = 0; q < players.length; q++) if (players[q].steamid === sid) { pl = players[q]; break; }
  if (!pl) return null;
  const j = pl.index, rate = r.tickrate, i = sampleAt(r.ticks, tick), t = S.t, kills = r.payload.kills;
  let kill: KillEvent | null = null;
  for (let q = 0; q < kills.length; q++) if (kills[q].victim === sid && kills[q].tick <= tick) { kill = kills[q]; break; }
  const alive = !kill && (r.value("flags", i, j) & F.ALIVE) !== 0;
  if (!alive) {
    if (!kill) return null;
    const a = lastAlive(r, j, sampleAt(r.ticks, kill.tick)), dead = (tick - kill.tick) / rate;
    const track = rag ? rag.track(r, sid, kill.tick) : null;
    if (track) {
      // pose vivante du tick du kill (os hors du ragdoll), puis les os des corps à la trajectoire (agentRig.ts)
      body(r, j, kill.tick, 1, kill.tick, a);
      if (!outN) return null;
      const t = Math.max(0, dead);
      return { layers: layersOut(), aim: 0, weapon: null, body: ragdollBody(track, t, r.value("yaw", a, j)), ragdoll: { track, t } };
    }
    const role = deathClip(DEATH_BY_ZONE[lastZone(r, sid, kill.tick)] ?? DEATH_BY_ZONE.generic, vmVariant(kill.tick));
    if (!role) return null;
    const wd = clamp01(dead / DEATH_FADE);
    at("communes", role, dead, Math.max(wd, 1e-4));
    if (wd < 1) body(r, j, kill.tick, 1 - wd, kill.tick, a);
    const pos = kill.victim_pos;
    return { layers: layersOut(), aim: 0, weapon: null, body: { x: pos[0], y: pos[1], z: pos[2], yaw: r.value("yaw", a, j) } };
  }
  const act = actions(r, j, sid, tick);
  body(r, j, tick, 1 - act);
  if (!outN) return null;
  const pitch = r.has("pitch") ? lerp(r.value("pitch", i, j), r.value("pitch", Math.min(i + 1, r.n - 1), j), t) : 0;
  return { layers: layersOut(), aim: Math.max(-89, Math.min(89, pitch)), weapon: weaponKey(r.weaponAt(i, j), pl.side), body: null };
}

/** Os du corps `i` de la trajectoire à `t` secondes de la mort, dans out[0..6] (position, rotation x y z w) : images
 *  voisines mélangées (positions en ligne droite, rotations normalisées, signes alignés) ; au-delà de la dernière, la
 *  dernière. Pure. */
export function trackAt(tr: RagdollTrack, t: number, i: number, out: Float64Array) {
  const f = Math.min(Math.max(t / tr.dt, 0), tr.frames - 1), f0 = Math.floor(f), f1 = Math.min(f0 + 1, tr.frames - 1), a = f - f0;
  const p0 = (f0 * tr.bodies + i) * 3, p1 = (f1 * tr.bodies + i) * 3, q0 = (f0 * tr.bodies + i) * 4, q1 = (f1 * tr.bodies + i) * 4;
  for (let c = 0; c < 3; c++) out[c] = tr.p[p0 + c] + (tr.p[p1 + c] - tr.p[p0 + c]) * a;
  let dot = 0, l = 0;
  for (let c = 0; c < 4; c++) dot += tr.q[q0 + c] * tr.q[q1 + c];
  const s = dot < 0 ? -1 : 1;
  for (let c = 0; c < 4; c++) { out[3 + c] = tr.q[q0 + c] * (1 - a) + s * tr.q[q1 + c] * a; l += out[3 + c] * out[3 + c]; }
  l = Math.sqrt(l) || 1;
  for (let c = 0; c < 4; c++) out[3 + c] /= l;
}

const TB = new Float64Array(7);
/** Place d'un corps en ragdoll : au milieu des corps (x, y), GROUND_BELOW sous le plus bas, lacet du dernier instant en vie. */
function ragdollBody(tr: RagdollTrack, t: number, yaw: number): AgentBody {
  let x = 0, y = 0, z = Infinity;
  for (let i = 0; i < tr.bodies; i++) { trackAt(tr, t, i, TB); x += TB[0]; y += TB[1]; z = Math.min(z, TB[2]); }
  return { x: x / tr.bodies, y: y / tr.bodies, z: z - GROUND_BELOW, yaw };
}

/** Pose vivante du joueur `sid` qui meurt au kill `kill`, au tick `min(tick, kill.tick)` : départ du ragdoll (ragdolls.ts,
 *  au tick du kill et START_DT avant). Vitesse bornée au kill, arme du dernier instant en vie, buste penché selon son
 *  regard ; `body` : sa place dans le replay à ce tick (positions interpolées ; z de la mort sans champ z), lacet du
 *  dernier instant en vie. null : joueur absent, ou aucun clip chargé. Pure, comme agentPose. */
export function dyingPose(r: Replay, tick: number, sid: string, kill: KillEvent, dur: ClipDur): AgentPose | null {
  curDur = dur;
  outN = 0;
  try {
    let pl: ReplayPlayer | null = null;
    for (let q = 0; q < r.players.length; q++) if (r.players[q].steamid === sid) { pl = r.players[q]; break; }
    if (!pl) return null;
    const j = pl.index, at = Math.min(tick, kill.tick), a = lastAlive(r, j, sampleAt(r.ticks, kill.tick));
    body(r, j, at, 1, kill.tick, a);
    if (!outN) return null;
    const layers = layersOut();
    posInto(r, j, at);
    const x = S.px, y = S.py, s0 = sampleAt(r.ticks, at), t = S.t, s1 = Math.min(s0 + 1, r.n - 1), i = Math.min(s0, a);
    const z = r.has("z") ? lerp(r.value("z", s0, j), r.value("z", s1, j), t) : kill.victim_pos[2];
    const pitch = r.has("pitch") ? r.value("pitch", i, j) : 0;
    return { layers, aim: Math.max(-89, Math.min(89, pitch)), weapon: null, body: { x, y, z, yaw: r.value("yaw", i, j) }, ragdoll: null };
  } finally {
    curDur = NO_DUR;
  }
}

/** Arme lâchée à la mort : steamid du mort (`victim`, identifiant de l'arme : une par mort), clé du fichier monde-<clé>,
 *  position au sol et lacet (degrés), du tick du kill (`from`) jusqu'à son ramassage (`until`, Infinity : jamais). */
export interface DroppedWeapon { victim: string; key: string; x: number; y: number; z: number; yaw: number; from: number; until: number }
/** Arme posée devant et à droite du point de mort (unités, au sol ; elle ne suit pas le corps qui tombe) ; ramassée par le
 *  premier autre joueur en vie à moins de PICK_R qui l'a dans son inventaire alors qu'il ne l'avait pas à l'image d'avant.
 *  Relevés de l'essai réel (06/11/2026, match G2–Astralis) : armes lâchées à la mort, au repos, à 10 devant et 4 à droite
 *  du point de mort en médiane (25 armes, ±25 u) ; le jeu ramasse de loin (touche « utiliser ») : 11 des 32 ramassages
 *  de l'arme d'un mort entre 100 et 250 unités de l'arme ; avec 96, ces armes restaient au sol jusqu'à la fin du round
 *  ou disparaissaient au ramassage d'une autre ; avec 256, les 32 au bon tick. */
export const DROP_AHEAD = 10, DROP_RIGHT = 4, PICK_R = 256;
/** Écart de hauteur maximal (unités) entre le ramasseur et l'arme : un joueur à un autre étage ne la ramasse pas. */
export const PICK_DZ = 128;
const drops = new WeakMap<Replay, DroppedWeapon[]>();

/** Arme lâchée par le joueur j mort après l'image `a` (sa dernière en vie) : sa meilleure arme à feu, la principale ou à
 *  défaut le pistolet, quelle que soit l'arme en main ; sans inventaire (vieux replays), l'arme tenue si c'est une arme à
 *  feu. Ni couteau, ni grenade, ni Zeus, ni C4 (la bombe a son propre repère). */
function droppedGun(r: Replay, j: number, a: number): string | null {
  const inv = r.inventoryAt(a, j);
  if (inv.length) { const { primary, pistol } = sortInventory(inv); return primary ?? pistol ?? null; }
  const held = r.weaponAt(a, j), c = weaponClass(held);
  return c !== null && c !== "knife" && c !== "zeus" ? held : null;
}

/** Armes lâchées par les morts du round (calculées une fois par replay ; une par mort, au premier kill du joueur).
 *  Les ramassages sont attribués dans l'ordre des images : un gain d'inventaire (un joueur en vie reçoit une arme qu'il
 *  n'avait pas à l'image d'avant) retire UNE seule arme, la plus proche de lui parmi celles de même nom encore au sol,
 *  à moins de PICK_R à l'horizontale et PICK_DZ en hauteur ; les autres restent au sol. */
export function droppedWeapons(r: Replay): DroppedWeapon[] {
  const done = drops.get(r);
  if (done) return done;
  const out: DroppedWeapon[] = [], seen = new Set<string>(), open: { d: DroppedWeapon; name: string; from: number; p: number }[] = [];
  for (const k of r.payload.kills) {
    const p = r.players.find((x) => x.steamid === k.victim);
    if (!p || seen.has(p.steamid)) continue;
    seen.add(p.steamid);
    const iT = sampleAt(r.ticks, k.tick), a = lastAlive(r, p.index, iT), name = droppedGun(r, p.index, a);
    const key = name === null ? null : weaponKey(name, p.side);
    if (name === null || !key) continue;
    const yaw = r.value("yaw", a, p.index), rad = (yaw * Math.PI) / 180, [vx, vy, vz] = k.victim_pos;
    const x = vx + Math.cos(rad) * DROP_AHEAD + Math.sin(rad) * DROP_RIGHT, y = vy + Math.sin(rad) * DROP_AHEAD - Math.cos(rad) * DROP_RIGHT;
    const d: DroppedWeapon = { victim: p.steamid, key, x, y, z: vz + 1, yaw: yaw + 90 + (vmVariant(k.tick) ? 25 : -25), from: k.tick, until: Infinity };
    out.push(d);
    open.push({ d, name, from: iT, p: p.index });
  }
  const hasZ = r.has("z");
  for (let s = open.length ? Math.min(...open.map((o) => o.from)) + 1 : r.n; s < r.n && open.length; s++) {
    for (const q of r.players) {
      if ((r.value("flags", s, q.index) & F.ALIVE) === 0) continue;
      const qx = r.value("x", s, q.index), qy = r.value("y", s, q.index);
      let inv: string[] | null = null;
      const used = new Set<string>();  // un gain d'inventaire ne retire qu'une arme
      for (;;) {
        let best = -1, bd = Infinity;
        for (let o = 0; o < open.length; o++) {
          const c = open[o];
          if (c.from >= s || c.p === q.index || used.has(c.name)) continue;
          const dist = Math.hypot(qx - c.d.x, qy - c.d.y);
          if (dist > PICK_R || dist >= bd) continue;
          if (hasZ && Math.abs(r.value("z", s, q.index) - c.d.z) > PICK_DZ) continue;
          inv ??= r.inventoryAt(s, q.index);
          if (inv.includes(c.name) && !r.inventoryAt(s - 1, q.index).includes(c.name)) { best = o; bd = dist; }
        }
        if (best < 0) break;
        open[best].d.until = r.ticks[s];
        used.add(open[best].name);
        open.splice(best, 1);
      }
    }
  }
  drops.set(r, out);
  return out;
}

/** Préchauffage d'un round : calcule d'avance ce que la première pose calculerait sinon d'un coup (phases des pas de
 *  chaque joueur, armes au sol : 9 à 17 ms mesurés le 05/11/2026 sur le PC de développement, pour 10 joueurs et un round de
 *  2 min 30). À appeler au chargement du replay. */
export function warmAgentAnim(r: Replay): void {
  for (const p of r.players) gaitPhase(r, p.index, 0);
  droppedWeapons(r);
}
