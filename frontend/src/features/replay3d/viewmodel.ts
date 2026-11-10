/**
 * Bras et arme de la vue du joueur (viewmodel), dans leur propre scène et avec leur propre caméra, dessinés par-dessus la
 * carte (2e passe). Comportement et constantes calés sur des mesures (analyse du 31/10/2026, vérifications du
 * 01/11/2026).
 *
 * Repère de la caméra des bras (œil à l'origine, rotation nulle, regard −Z, haut +Y, droite +X ; mètres). Chaîne :
 *   scène → `vm_racine` (décalages du joueur + bob − recul, position) → `vm_sway` (sway + bob + recul, rotation Euler XYZ)
 *         → `vm_axes` (180° autour de Y : les fichiers regardent +Z) → bras du camp → os `wpn` → support (annule la
 *           rotation Source → glTF de l'os racine « weapon » des clips) → modèle de l'arme (`sl_arme`).
 * Les armes à deux mains (Dual Berettas, molotov…) n'ont pas de cas particulier : leurs clips laissent `wpn` à l'origine et
 * posent les os `weapon_hand_l` / `weapon_hand_r` du modèle exactement sur les mains (vérifié sur les vrais exports).
 *
 * CONTRAT pour 3B.9 (Viewer, 2e passe), à chaque image en vue du joueur :
 *   const pose = viewmodelPose(replay, tick, p.steamid, vm.duration);   // null : rien à dessiner (mort, lunette…)
 *   const drawn = !!pose && vm.update(pose, vmView(replay, tick, p, worldCamera.quaternion)) && vm.render(renderer);
 * - `update` monte le camp et l'arme (chargés à la demande, `onChange` prévient à l'arrivée : redessiner), précharge
 *   l'inventaire du joueur quand il change, applique FOV et décalages du joueur, sway, bob, recul, oriente la lumière de la
 *   carte dans le repère de la caméra, pose le mélange des deux clips ; faux tant que bras ou arme manquent.
 * - `render` : `autoClear` coupé, `clearDepth()`, rendu, `autoClear` remis ; tone mapping, exposition et espace de couleur
 *   du rendu du monde laissés tels quels (même chaîne de couleur) ; préchauffe les shaders des fichiers arrivés.
 * - `setLighting(vmLighting(hemi, soleil))` avec les lumières de la scène du monde (`sceneLights` de viewer.ts : c'est aussi
 *   la valeur par défaut, `VM_LIGHTING`) ; `resize(aspect du canvas)` ; `warm(renderer)` peut être appelé seul ;
 *   `dispose()` libère tout. `onError(nom, erreur)` : fichier en échec (401, 404 après un nouvel export…) ; sur un 404
 *   seulement, la vue relit la liste `["assets3d"]` et recrée le ViewModel si les adresses ont changé.
 */
import { type AnimationClip, BackSide, Color, DirectionalLight, Float32BufferAttribute, Group, HemisphereLight,
  type Interpolant, type KeyframeTrack, type Material, Mesh, MeshBasicMaterial, type MeshStandardMaterial, type Object3D,
  PerspectiveCamera, PMREMGenerator, PropertyBinding, Quaternion, Scene, SphereGeometry, type Texture, Vector3,
  type WebGLRenderer } from "three";
import type { Side } from "../../shared/api/types";
import { sampleIndex } from "../replay/engine/interp";
import type { Replay, Viewmodel } from "../replay/engine/replay";
import type { PlayerState } from "../replay/engine/state";
import { disposeTree, freeImages, freeImagesAfterUpload, imagesFreed } from "./dispose";
import { type VmClip, type VmClipAt, type VmDur, type VmPose, type VmRecoil, weaponKey } from "./viewmodelAnim";

type Vec3 = [number, number, number];
export const INCH = 0.0254;
const DEG = Math.PI / 180;
/** viewmodel_fov du joueur : borné 60–68, 68 s'il est inconnu (préréglage « classic » de CS2). */
export const VM_FOV_DEFAULT = 68;
const FOV_MIN = 60, FOV_MAX = 68;
/** viewmodel_offset_x / y / z du joueur (pouces ; x à droite, y en avant, z en haut), bornés ; défaut « classic ». */
export const VM_OFFSET_DEFAULT: Readonly<Vec3> = [2.5, 0, -1.5];
const OFFSET_RANGE: readonly (readonly [number, number])[] = [[-2, 2.5], [-2, 2], [-2, 2]];
/** Armes gardées en mémoire (les plus récentes) ; au-delà, la plus ancienne est libérée (≈ 20 Mo de textures chacune). */
export const VM_KEEP = 8;
/** Rotation que les clips donnent à l'os racine « weapon » (axes Source → glTF) : annulée par le support de l'arme. */
export const SRC_TO_GLTF = new Quaternion(-0.5, -0.5, -0.5, 0.5);
/** Repère des fichiers (regard +Z, droite −X) → caméra des bras (regard −Z, droite +X) : 180° autour de Y. */
export const VM_AXES = new Quaternion(0, 1, 0, 0);
/** Reflets faibles : environnement de la scène des bras (bras) et des armes (valeurs relevées : 0,2025 et 0,3). */
export const VM_ENV = 0.2, VM_ENV_WEAPON = 0.3;
// sway : vitesse angulaire de la vue (°/s) × −0,00035 rad, bornée ±0,045 (lacet) / ±0,04 (tangage), filtrée 1 − exp(−10 dt)
const SWAY_K = -0.00035, SWAY_YAW = 0.045, SWAY_PITCH = 0.04, SWAY_RATE = 10;
// bob : vitesse horizontale bornée 0–250 u/s, lissée 1 − exp(−8 dt) ; périodes 0,98 s (vertical) et 1,96 s (latéral)
const BOB_VMAX = 250, BOB_RATE = 8, BOB_UP = 0.98, BOB_SIDE = 1.96, BOB_AMP = 0.005, BOB_DROP = 1.05;
/** Au-delà de cet écart de temps du replay entre deux images (s), ou en arrière, c'est un saut : sway et bob repartent. */
export const SEEK_S = 1;

/** Fichier lu (parseGlbAnimated). */
export interface VmFile { scene: Object3D; clips: AnimationClip[] }
/** Charge `bras-ct`, `bras-t` ou `arme-<clé>` ; null : fichier absent du serveur. */
export type VmLoad = (name: string, signal: AbortSignal) => Promise<VmFile | null>;
/** Lumière de la carte (celle de la scène du monde, repère du jeu : Z en haut). */
export interface VmLighting {
  sky: Color; ground: Color; hemi: number; up: Vector3;  // lumière hémisphérique : ciel, sol, intensité, direction du ciel
  sun: Color; sunIntensity: number; toSun: Vector3;        // soleil : couleur, intensité, direction vers le soleil
}
/** Reflets (environnement) d'après la lumière de la carte ; remplaçable dans les tests (pas de WebGL). */
export type VmEnv = (renderer: WebGLRenderer, lighting: VmLighting) => Texture | null;
/** Ce que `pose` mélange : action précédente (pendant un fondu), action courante, poids, modèle de l'arme caché. */
export type VmBlend = Pick<VmPose, "from" | "to" | "w" | "hideWeaponModel">;
/** Entrée du sway et du bob (état de rendu) : joueur, instant du replay, regard (degrés, convention du jeu : tangage
 *  positif vers le bas) et vitesse horizontale (unités/s). */
export interface VmMotionInput { steamid: string; tick: number; tickrate: number; yaw: number; pitch: number; speed: number }
/** Sway (rad) et bob (C vertical, L latéral, D abaissement : pouces, et degrés pour les rotations). */
export interface VmMotionState { swayX: number; swayY: number; C: number; L: number; D: number }
/** Entrée de `update` : regard et vitesse, camp, réglages des bras et inventaire du joueur, rotation de la caméra du monde. */
export interface VmView extends VmMotionInput {
  side: Side; settings: Viewmodel | null; inventory: readonly string[]; view: Quaternion;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** FOV horizontal sur un écran 4:3 → FOV vertical (degrés). */
const vfov43 = (deg: number) => (2 * Math.atan(0.75 * Math.tan((deg * Math.PI) / 360)) * 180) / Math.PI;

/** FOV vertical de la caméra des bras (degrés) : viewmodel_fov du joueur borné 60–68 (68 s'il manque), règle 4:3, SANS
 *  correction d'aspect (l'aspect du canvas élargit le champ horizontal) ; 68 → 53,67°. */
export function vmFov(s: Viewmodel | null): number {
  return vfov43(s && Number.isFinite(s.fov) && s.fov > 0 ? clamp(s.fov, FOV_MIN, FOV_MAX) : VM_FOV_DEFAULT);
}

/** Décalages des bras du joueur (pouces : droite, avant, haut), bornés ; valeur manquante → défaut « classic ». */
export function vmOffset(s: Viewmodel | null): Vec3 {
  const v = s ? [s.x, s.y, s.z] : VM_OFFSET_DEFAULT;
  return v.map((x, k) => (Number.isFinite(x) ? clamp(x, OFFSET_RANGE[k][0], OFFSET_RANGE[k][1]) : VM_OFFSET_DEFAULT[k])) as Vec3;
}

/** Onde du bob : sinus simple de période `period` (−1..1), mesuré le 01/11/2026 en course (écart moyen
 *  au sinus 0,0003). */
export function bobWave(phase: number, period: number): number {
  return Math.sin((2 * Math.PI * phase) / period);
}

/**
 * Sway et bob : petit ÉTAT DE RENDU (pas du replay), avancé avec le temps du replay (rien ne bouge à l'arrêt ; ×8 va
 * huit fois plus vite). Remis à zéro sur un saut (retour arrière, bond de plus de SEEK_S, autre joueur) : le sway repart de
 * 0, la vitesse du bob est reprise telle quelle et sa phase à 0.
 *  - sway : cible = vitesse angulaire de la vue (°/s, angles du jeu : lacet vers la gauche et tangage vers le BAS
 *    positifs) × −0,00035 rad, bornée ±0,04 (tangage) et ±0,045 (lacet), filtrée 1 − exp(−10 dt). Signes vérifiés sur
 *    une démo le 01/11/2026 (NertZ, ticks 13817 à 13837 : regard qui monte en tournant à gauche → rotation x positive,
 *    y négative) : en lacet l'arme traîne derrière le regard, en tangage elle le devance ;
 *  - bob : vitesse bornée à 250 et lissée 1 − exp(−8 dt) ; phase += dt · v / 250 ; P = 0,005 v ;
 *    C = P (0,3 + 0,7 sin(2π phase / 0,98)), L = P (0,3 + 0,7 sin(2π phase / 1,96)), D = 1,05 v / 250.
 */
export class VmMotion {
  private swayX = 0;
  private swayY = 0;
  private speed = 0;
  private phase = 0;
  private sid: string | null = null;
  private tick = 0;
  private yaw = 0;
  private pitch = 0;

  step(v: VmMotionInput): VmMotionState {
    const dt = this.sid === null ? 0 : (v.tick - this.tick) / v.tickrate;
    const speed = clamp(Number.isFinite(v.speed) ? v.speed : 0, 0, BOB_VMAX);
    if (this.sid === null || this.sid !== v.steamid || !(dt >= 0) || dt > SEEK_S) {
      this.swayX = this.swayY = 0;
      this.speed = speed;
      this.phase = 0;
    } else if (dt > 0) {
      const dYaw = ((((v.yaw - this.yaw) % 360) + 540) % 360) - 180;  // plus court chemin
      const dPitch = v.pitch - this.pitch;                             // tangage du jeu tel quel (positif vers le bas)
      const tx = clamp(SWAY_K * (dPitch / dt), -SWAY_PITCH, SWAY_PITCH), ty = clamp(SWAY_K * (dYaw / dt), -SWAY_YAW, SWAY_YAW);
      const a = 1 - Math.exp(-SWAY_RATE * dt), b = 1 - Math.exp(-BOB_RATE * dt);
      this.swayX += (tx - this.swayX) * a;
      this.swayY += (ty - this.swayY) * a;
      this.speed += (speed - this.speed) * b;
      this.phase = (this.phase + (dt * this.speed) / BOB_VMAX) % BOB_SIDE;  // 1,96 = 2 × 0,98 : les deux ondes restent continues
    }
    this.sid = v.steamid;
    this.tick = v.tick;
    this.yaw = v.yaw;
    this.pitch = v.pitch;
    const P = BOB_AMP * this.speed;
    return { swayX: this.swayX, swayY: this.swayY, C: P * (0.3 + 0.7 * bobWave(this.phase, BOB_UP)),
      L: P * (0.3 + 0.7 * bobWave(this.phase, BOB_SIDE)), D: (BOB_DROP * this.speed) / BOB_VMAX };
  }
}

/** Placement, dans le repère de la caméra des bras : position de la racine (m) et rotation du sway (rad, XYZ).
 *  Racine (pouces) : x = off_x + 0,5 L ; y = off_z + 0,1 C − D − montée du recul ; z = −off_y − 0,1 C − recul arrière.
 *  Sway (degrés) : x = 0,4 C + tangage du recul ; y = −0,3 L + lacet du recul ; z = −0,5 C + roulis du recul ; plus le
 *  sway lui-même (rad) en x et y. Signes vérifiés sur la mesure du tick 16374 (racine 2,437 / −2,070 / −0,520). */
export function vmPlacement(off: Readonly<Vec3>, m: VmMotionState, r: VmRecoil): { root: Vec3; rot: Vec3 } {
  return {
    root: [(off[0] + 0.5 * m.L) * INCH, (off[2] + 0.1 * m.C - m.D - r.up) * INCH, (-off[1] - 0.1 * m.C - r.back) * INCH],
    rot: [m.swayX + DEG * (0.4 * m.C + r.pitch), m.swayY + DEG * (-0.3 * m.L + r.yaw), DEG * (-0.5 * m.C + r.roll)],
  };
}

/** Lumière de la carte d'après les lumières de la scène du monde (`sceneLights` de viewer.ts). */
export function vmLighting(hemi: HemisphereLight, sun: DirectionalLight): VmLighting {
  return { sky: hemi.color.clone(), ground: hemi.groundColor.clone(), hemi: hemi.intensity, up: hemi.position.clone().normalize(),
    sun: sun.color.clone(), sunIntensity: sun.intensity, toSun: sun.position.clone().sub(sun.target.position).normalize() };
}
/** Valeur par défaut : celle de `sceneLights` (viewer.ts) — un test vérifie qu'elles concordent. */
export const VM_LIGHTING: VmLighting = {
  sky: new Color(0xffffff), ground: new Color(0x8a9099), hemi: 1.1, up: new Vector3(0, 0, 1),
  sun: new Color(0xffffff), sunIntensity: 1.4, toSun: new Vector3(0.4, 0.3, 1).normalize(),
};

/** Reflets de la carte : dégradé du sol au ciel de sa lumière hémisphérique (pas de pièce neutre trop claire), flou. */
export const mapEnv: VmEnv = (renderer, l) => {
  const geo = new SphereGeometry(1, 24, 12), pos = geo.getAttribute("position"), colors: number[] = [];
  const sky = l.sky.clone().multiplyScalar(l.hemi), ground = l.ground.clone().multiplyScalar(l.hemi), c = new Color();
  for (let k = 0; k < pos.count; k++) {
    c.lerpColors(ground, sky, (pos.getY(k) + 1) / 2);  // +Y = ciel ; tourné vers le ciel de la carte par environmentRotation
    colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute("color", new Float32BufferAttribute(colors, 3));
  const mat = new MeshBasicMaterial({ vertexColors: true, side: BackSide }), scene = new Scene();
  scene.add(new Mesh(geo, mat));
  const pm = new PMREMGenerator(renderer), target = pm.fromScene(scene, 0.04), tex = target.texture;
  if (tex) ENV_TARGETS.set(tex, target);  // libérer la texture seule laisserait la cible de rendu (framebuffer)
  pm.dispose();
  geo.dispose();
  mat.dispose();
  return tex;
};
/** Cibles de rendu des reflets faits par `mapEnv`, par texture : c'est la cible qu'on libère. */
const ENV_TARGETS = new WeakMap<Texture, { dispose(): void }>();
/** Libère des reflets : leur cible de rendu s'ils viennent de `mapEnv` (texture comprise), sinon la texture. */
function releaseEnv(t: Texture | null) {
  if (!t) return;
  const target = ENV_TARGETS.get(t);
  ENV_TARGETS.delete(t);
  if (target) target.dispose();
  else t.dispose();
}

/** Clés des fichiers des armes d'un inventaire (noms des images), dans l'ordre, sans doublon ni arme sans bras. */
export function vmPreloadKeys(inventory: readonly string[], side: Side): string[] {
  const out: string[] = [];
  for (const name of inventory) {
    const k = weaponKey(name, side);
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
}

/** Vitesse horizontale (unités/s) du joueur d'indice `j` au tick : entre l'image du tick et la suivante (la dernière
 *  image prend l'intervalle d'avant). Fonction du tick seulement : même valeur à l'arrêt. */
export function horizontalSpeed(r: Replay, j: number, tick: number): number {
  if (r.n < 2) return 0;
  const i = Math.min(sampleIndex(r.ticks, tick).i, r.n - 2), dt = (r.ticks[i + 1] - r.ticks[i]) / r.tickrate;
  return dt > 0 ? Math.hypot(r.value("x", i + 1, j) - r.value("x", i, j), r.value("y", i + 1, j) - r.value("y", i, j)) / dt : 0;
}

/** Entrée de `update` pour le joueur suivi `p` (playerStateAt), au tick affiché ; `view` : rotation de la caméra du monde. */
export function vmView(r: Replay, tick: number, p: PlayerState, view: Quaternion): VmView {
  const j = r.players.find((x) => x.steamid === p.steamid)?.index;
  return { steamid: p.steamid, side: p.side, tick, tickrate: r.tickrate, yaw: p.yaw, pitch: p.pitch,
    speed: j === undefined ? 0 : horizontalSpeed(r, j, tick), settings: p.viewmodel, inventory: p.inventory, view };
}

interface Channel { obj: Vector3 | Quaternion; quat: boolean; interp: Interpolant }
// posé par KeyframeTrack.setInterpolation (absent des types de three) : linéaire, ou slerp pour les rotations
type Track = KeyframeTrack & { createInterpolant(): Interpolant };
interface Bound { duration: number; channels: Channel[]; byObj: Map<object, Channel> }
interface Arms {
  root: Object3D; wpn: Object3D; nodes: Map<string, Object3D>;
  rest: [Object3D, Vector3, Quaternion, Vector3][];  // pose de repos des os, remise à chaque changement d'arme
  textures: Texture[];  // de ses matériaux (préchauffage : envoi au GPU)
}
interface Weapon {
  model: Object3D; clips: Map<string, AnimationClip>; alias: Map<string, string>; nodes: Map<string, Object3D>;
  bound: Map<string, Bound>;  // par camp et clip (« CT:shoot ») : les os des bras changent avec le camp
  mats: MeshStandardMaterial[];  // reflets propres à l'arme (0,3)
  textures: Texture[];  // de ses matériaux, reflets partagés exclus (préchauffage : envoi au GPU)
}

const sane = (n: string) => PropertyBinding.sanitizeNodeName(n);
/** Nom d'origine (GLTFLoader rend les noms uniques : « weapon_1 ») débarrassé des caractères réservés de three. */
const original = (o: Object3D) => sane((o.userData.name as string | undefined) ?? o.name);
/** Nœuds d'un arbre par nom d'origine (os ou pas : l'os racine d'une arme n'est pas toujours un os de peau). */
function nodesOf(root: Object3D) {
  const m = new Map<string, Object3D>();
  root.traverse((o) => { if (!(o as Mesh).isMesh && !m.has(original(o))) m.set(original(o), o); });
  return m;
}
const materialsOf = (o: Object3D): Material[] => {
  const m = (o as Mesh).material;
  return Array.isArray(m) ? m : m ? [m] : [];
};
/** Jamais écartés hors du cadre : la boîte des maillages à peau est celle de la pose de liaison, pas de la pose jouée. */
const noCull = (root: Object3D) => root.traverse((o) => { if ((o as Mesh).isMesh) o.frustumCulled = false; });
/** Textures des matériaux d'un arbre, chacune une fois (une ORM sert à la rugosité et au métal), sans les reflets
 *  (`envMap` : texture de la scène des bras, partagée). */
function texturesOf(root: Object3D): Texture[] {
  const out = new Set<Texture>();
  root.traverse((o) => {
    for (const m of materialsOf(o))
      for (const [k, v] of Object.entries(m)) if (k !== "envMap" && (v as Texture | null)?.isTexture) out.add(v as Texture);
  });
  return [...out];
}
const TRS = new Set(["position", "quaternion", "scale"]);
const STILL: VmMotionState = { swayX: 0, swayY: 0, C: 0, L: 0, D: 0 };
const NO_RECOIL: VmRecoil = { pitch: 0, yaw: 0, roll: 0, back: 0, up: 0 };
const Y = new Vector3(0, 1, 0), TQ = new Quaternion(), EQ = new Quaternion();
const OUT = [0, 0, 0, 0], FROM = [0, 0, 0, 0], TO = [0, 0, 0, 0];
const DONE: Promise<void> = Promise.resolve();
/** Après un échec transitoire (réseau, 5xx, 401…), délai avant une nouvelle demande du même fichier (ms). */
const RETRY_MS = 10_000;

/**
 * Bras et arme de la vue du joueur (voir l'en-tête du fichier : repère, chaîne, contrat pour 3B.9). Les fichiers arrivent à
 * la demande : `setSide` (bras du camp), `setWeapon` (arme) et `preload` lancent leur chargement ; `onChange` prévient
 * quand un fichier est prêt. Les bras T (Phoenix) reçoivent les clips enregistrés sur les bras SAS, par nom d'os.
 */
export class ViewModel {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(vmFov(null), 1, 0.01, 10);
  /** Fichier en échec (hors annulation) : 401, 404 d'un fichier ré-exporté depuis la lecture de la liste, 500, réseau…
   *  Une fois par échec ; pas mémorisé : nouvel essai par `update` au plus tôt 10 s plus tard. */
  onError?: (name: string, error: unknown) => void;
  private root = new Group();
  private sway = new Group();
  private axes = new Group();
  private mount = new Group();
  private hemi = new HemisphereLight();
  private sun = new DirectionalLight();
  private light: VmLighting = VM_LIGHTING;
  private env: Texture | null = null;
  private envDirty = true;
  private cold = new Set<Object3D>();  // bras et armes arrivés, shaders pas encore préchauffés
  private unsent = new Set<Texture>();  // leurs textures pas encore envoyées au GPU (ordre d'arrivée)
  private arms = new Map<Side, Arms | null>();  // null : absent (pas de fichier, ou sans os wpn), mémorisé
  private weapons = new Map<string, Weapon | null>();  // ordre = du plus ancien au plus récent demandé
  private pending = new Set<string>();
  private failed = new Map<string, number>();  // fichier → instant (Date.now) de son dernier échec transitoire
  private side: Side | null = null;
  private weapon: string | null = null;
  private mounted: Arms | null = null;  // bras dans la scène
  private shown: { arms: Arms; weapon: Weapon } | null = null;
  private settings: Viewmodel | null | undefined = undefined;
  private offset: Vec3 = [...VM_OFFSET_DEFAULT];
  private motion = new VmMotion();
  private stocked = "";  // inventaire déjà préchargé (camp et noms)
  private abort = new AbortController();
  private disposed = false;

  constructor(private load: VmLoad, private onChange: () => void, private makeEnv: VmEnv = mapEnv) {
    this.root.name = "vm_racine";
    this.sway.name = "vm_sway";
    this.axes.name = "vm_axes";
    this.axes.quaternion.copy(VM_AXES);
    this.mount.quaternion.copy(SRC_TO_GLTF).invert();
    this.root.add(this.sway);
    this.sway.add(this.axes);
    this.scene.add(this.root, this.hemi, this.sun);
    this.scene.environmentIntensity = VM_ENV;
    this.setLighting(VM_LIGHTING);
    this.place(STILL, NO_RECOIL);
    this.orient(new Quaternion());
  }

  /** Durée d'un clip d'une arme chargée (s), null sinon ; détachable (`VmDur` de viewmodelPose). */
  readonly duration: VmDur = (key: string, clip: VmClip) => this.weapons.get(key)?.clips.get(clip)?.duration ?? null;

  /** Bras du camp du joueur suivi. */
  setSide(side: Side) {
    if (this.disposed || side === this.side) return;
    this.side = side;
    this.loadArms(side);
    this.remount();
  }

  /** Arme tenue (clé de arme-<clé>.glb) ; null : aucune. */
  setWeapon(key: string | null) {
    if (this.disposed || key === this.weapon) return;
    this.weapon = key;
    if (key) {
      this.touch(key);
      this.loadWeapon(key);
    }
    this.remount();
  }

  /** Charge à l'avance (sans les monter) des armes, VM_KEEP au plus, et des bras ; rien n'est demandé deux fois. */
  preload(keys: readonly string[], sides: readonly Side[] = []) {
    if (this.disposed) return;
    for (const s of sides) this.loadArms(s);
    for (const k of keys.slice(0, VM_KEEP)) {
      this.touch(k);
      this.loadWeapon(k);
    }
  }

  /** Bras et arme demandés tous deux chargés. */
  ready(): boolean { return this.shown !== null; }

  /** Vrai si l'image d'une texture des bras ou des armes chargés a été libérée après son envoi : three ne pourrait pas la
   *  renvoyer à un nouveau contexte graphique (le Viewer recrée alors le ViewModel). */
  imagesFreed(): boolean {
    for (const a of this.arms.values()) if (a && imagesFreed(a.root)) return true;
    for (const w of this.weapons.values()) if (w && imagesFreed(w.model)) return true;
    return false;
  }

  /** Lumière de la carte (lumières de la scène du monde, `vmLighting`) : couleurs et intensités tout de suite, directions à
   *  chaque `update`, reflets refaits au rendu suivant. */
  setLighting(l: VmLighting) {
    this.light = l;
    this.hemi.color.copy(l.sky);
    this.hemi.groundColor.copy(l.ground);
    this.hemi.intensity = l.hemi;
    this.sun.color.copy(l.sun);
    this.sun.intensity = l.sunIntensity;
    this.envDirty = true;
  }

  /** Une image en vue du joueur (voir l'en-tête) : vrai si bras et arme sont prêts et posés (le clip `to` existe). */
  update(pose: VmPose, v: VmView): boolean {
    if (this.disposed) return false;
    this.setSide(v.side);
    this.setWeapon(pose.weapon);
    // échec transitoire de ces fichiers : nouvel essai une fois le délai passé (setSide / setWeapon ne redemandent rien)
    if (!this.shown && this.failed.size > 0) this.retry();
    const stock = `${v.side}|${v.inventory.join(",")}`;
    if (stock !== this.stocked) {  // début du round, passage en vue du joueur, autre joueur, achat ou ramassage
      this.stocked = stock;
      this.preload(vmPreloadKeys(v.inventory, v.side));
    }
    if (v.settings !== this.settings) {  // objets créés une fois par replay (Replay.viewmodelOf)
      this.settings = v.settings;
      this.offset = vmOffset(v.settings);
      const fov = vmFov(v.settings);
      if (fov !== this.camera.fov) {
        this.camera.fov = fov;
        this.camera.updateProjectionMatrix();
      }
    }
    this.place(this.motion.step(v), pose.recoil);
    this.orient(v.view);
    return this.shown !== null && this.pose(pose);
  }

  /** Pose le mélange des clips, os par os (positions et échelles interpolées, rotations en slerp) : from × (1 − w) +
   *  to × w ; instants bornés aux durées ; un os animé par un seul des deux clips prend sa valeur. Cache le modèle de
   *  l'arme (pas les bras) si demandé. Faux si le clip `to` manque. */
  pose(p: VmBlend): boolean {
    const s = this.shown, side = this.side;
    if (!s || !side) return false;
    const to = this.bind(s.weapon, s.arms, side, p.to.clip);
    if (!to) return false;
    const from = p.from && p.w < 1 ? this.bind(s.weapon, s.arms, side, p.from.clip) : null;
    const w = clamp(p.w, 0, 1), tb = clamp(p.to.t, 0, to.duration), ta = from ? clamp((p.from as VmClipAt).t, 0, from.duration) : 0;
    for (const c of to.channels) {
      const b = c.interp.evaluate(tb), f = from?.byObj.get(c.obj);
      if (!f) { c.obj.fromArray(b); continue; }
      const n = c.quat ? 4 : 3;
      for (let k = 0; k < n; k++) TO[k] = b[k];  // même clip à deux instants : même interpolant, même tampon
      const a = f.interp.evaluate(ta);
      for (let k = 0; k < n; k++) FROM[k] = a[k];
      if (c.quat) Quaternion.slerpFlat(OUT, 0, FROM, 0, TO, 0, w);
      else for (let k = 0; k < n; k++) OUT[k] = FROM[k] + (TO[k] - FROM[k]) * w;
      c.obj.fromArray(OUT);
    }
    if (from) for (const c of from.channels) if (!to.byObj.has(c.obj)) c.obj.fromArray(c.interp.evaluate(ta));
    s.weapon.model.visible = !p.hideWeaponModel;
    return true;
  }

  /** Aspect du canvas ; le FOV vertical n'en dépend pas. */
  resize(aspect: number) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** 2e passe : par-dessus l'image déjà dessinée, après effacement de la profondeur (jamais coupés par un mur) ; seul
   *  `autoClear` est touché, puis remis : même tone mapping, exposition et espace de couleur que le monde. Faux (rien
   *  dessiné) si bras ou arme manquent. */
  render(renderer: WebGLRenderer): boolean {
    const s = this.shown;
    if (!s || this.disposed) return false;
    this.ensureEnv(renderer);
    for (const m of s.weapon.mats) m.envMapRotation.copy(this.scene.environmentRotation);
    // ce qui est dessiné est compilé et envoyé au GPU par ce rendu même ; les autres fichiers arrivés : un shader et une
    // texture par image (budget)
    this.cold.delete(s.arms.root);
    if (this.unsent.size > 0) this.sent(s.arms.textures);
    if (s.weapon.model.visible) {
      this.cold.delete(s.weapon.model);
      if (this.unsent.size > 0) this.sent(s.weapon.textures);
    }
    void this.warm(renderer, 1);
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    try {
      renderer.clearDepth();
      renderer.render(this.scene, this.camera);
    } finally {
      renderer.autoClear = autoClear;
    }
    return true;
  }

  /** Préchauffe les bras et les armes arrivés pas encore affichés, pour éviter l'à-coup de leur premier affichage :
   *  shaders (`compileAsync`, dans la scène des bras et avec sa caméra, reflets posés) et textures (`initTexture` : envoi au
   *  GPU, que `compileAsync` ne fait pas ; à-coup de 126 à 155 ms mesuré en 3B.11), `max` de chaque au plus. `render` en
   *  fait un de chaque par image ; appelé seul, tout. Sans `compileAsync` / `initTexture` (faux rendus des tests) : rien.
   *  Rien à faire : retour immédiat, sans allocation. Une texture envoyée n'est plus renvoyée. */
  warm(renderer: WebGLRenderer, max = Infinity): Promise<void> {
    if (this.disposed) return DONE;
    if (this.unsent.size > 0 && typeof renderer.initTexture === "function") this.upload(renderer, max);
    if (this.cold.size === 0 || typeof renderer.compileAsync !== "function") return DONE;
    this.ensureEnv(renderer);
    const todo: Object3D[] = [];
    for (const a of this.arms.values()) if (a && this.cold.has(a.root)) todo.push(a.root);
    for (const w of this.weapons.values()) if (w && this.cold.has(w.model)) todo.push(w.model);
    return Promise.all(todo.slice(0, max).map(async (o) => {
      this.cold.delete(o);
      try {
        await renderer.compileAsync(o, this.camera, this.scene);
      } catch {
        // dessiné quand même au premier affichage (compilation synchrone)
      }
    })).then(() => {});
  }

  /** Envoie au GPU `max` textures de la file au plus, dans l'ordre d'arrivée ; chacune sort de la file, même en échec. */
  private upload(renderer: WebGLRenderer, max: number) {
    let n = 0;
    for (const t of this.unsent) {
      if (n++ >= max) break;
      this.unsent.delete(t);
      try {
        renderer.initTexture(t);
      } catch {
        // envoyée quand même au premier affichage
      }
    }
  }

  /** Libère tout (géométries, matériaux, textures, reflets) et annule les chargements en cours. `lost` : contexte
   *  graphique perdu depuis les rendus (contexte rendu, ViewModel remplacé) : ressources parties avec lui, seules les
   *  images encore gardées sont fermées (`freeImages`). */
  dispose(lost = false) {
    this.disposed = true;
    this.abort.abort();
    const drop = lost ? freeImages : disposeTree;
    // armes d'abord, et support vidé avant les bras : sinon l'arme montée sous wpn serait libérée deux fois (reflets compris)
    for (const w of this.weapons.values()) if (w) this.free(w, drop);
    this.mount.clear();
    for (const a of this.arms.values()) if (a) drop(a.root);
    this.arms.clear();
    this.weapons.clear();
    this.cold.clear();
    this.unsent.clear();
    if (!lost) releaseEnv(this.env);
    this.env = this.scene.environment = null;
    this.shown = this.mounted = null;
  }

  /** Racine (décalages, bob, recul) et sway (rotation). */
  private place(m: VmMotionState, r: VmRecoil) {
    const p = vmPlacement(this.offset, m, r);
    this.root.position.fromArray(p.root);
    this.sway.rotation.set(p.rot[0], p.rot[1], p.rot[2], "XYZ");
  }

  /** Soleil, ciel et reflets de la carte ramenés dans le repère de la caméra des bras (= celui de la caméra du monde). */
  private orient(view: Quaternion) {
    TQ.copy(view).invert();
    this.sun.position.copy(this.light.toSun).applyQuaternion(TQ);
    this.hemi.position.copy(this.light.up).applyQuaternion(TQ);
    this.scene.environmentRotation.setFromQuaternion(EQ.setFromUnitVectors(Y, this.hemi.position));
  }

  /** Reflets refaits si la lumière a changé ; posés aussi sur les armes (0,3), dont les matériaux ont leur propre env. */
  private ensureEnv(renderer: WebGLRenderer) {
    if (!this.envDirty) return;
    this.envDirty = false;
    const old = this.env;
    try {
      this.env = this.makeEnv(renderer, this.light);
    } catch (e) {
      console.warn("Vue du joueur : reflets non créés", e);
      this.env = null;
    }
    this.scene.environment = this.env;
    for (const w of this.weapons.values()) if (w) for (const m of w.mats) m.envMap = this.env;
    releaseEnv(old);
  }

  private loadArms(side: Side) {
    this.fetch(`bras-${side.toLowerCase()}`, (f): Arms | null => {
      const wpn = f.scene.getObjectByName("wpn");
      if (!wpn) return null;
      const nodes = nodesOf(f.scene);
      noCull(f.scene);
      return { root: f.scene, wpn, nodes, textures: texturesOf(f.scene),
        rest: [...nodes.values()].map((o) => [o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]) };
    }, (v) => { this.arms.set(side, v); if (v) this.arrived(v.root, v.textures); }, () => this.arms.has(side));
  }

  private loadWeapon(key: string) {
    this.fetch(`arme-${key}`, (f): Weapon | null => {
      const model = f.scene.getObjectByName("sl_arme");
      if (!model) return null;
      const alias = new Map<string, string>();
      f.scene.traverse((o) => alias.set(o.name, original(o)));
      model.removeFromParent();
      noCull(model);
      // textures listées avant d'y poser les reflets (partagés, jamais envoyés comme texture d'arme)
      const textures = texturesOf(model), mats: MeshStandardMaterial[] = [];
      model.traverse((o) => {
        for (const m of materialsOf(o)) if ((m as MeshStandardMaterial).isMeshStandardMaterial && !mats.includes(m as MeshStandardMaterial)) mats.push(m as MeshStandardMaterial);
      });
      for (const m of mats) {
        m.envMapIntensity = VM_ENV_WEAPON;
        m.envMap = this.env;
      }
      return { model, alias, nodes: nodesOf(model), clips: new Map(f.clips.map((c) => [c.name, c])), bound: new Map(), mats, textures };
    }, (v) => { this.weapons.set(key, v); if (v) this.arrived(v.model, v.textures); this.evict(); }, () => this.weapons.has(key));
  }

  /** Fichier arrivé : shaders à compiler et textures à envoyer au GPU (préchauffage), leurs images libérées après l'envoi
   *  (`freeImagesAfterUpload` : 12 à 30 Mo par fichier). */
  private arrived(root: Object3D, textures: readonly Texture[]) {
    this.cold.add(root);
    for (const t of textures) this.unsent.add(t);
    freeImagesAfterUpload(root);
  }

  /** Textures sorties de la file d'envoi : envoyées par le rendu qui les dessine, ou libérées. */
  private sent(textures: readonly Texture[]) {
    for (let k = 0; k < textures.length; k++) this.unsent.delete(textures[k]);
  }

  /** Nouvel essai des bras et de l'arme demandés qui manquent (`fetch` respecte le délai après un échec). */
  private retry() {
    if (this.side && !this.arms.has(this.side)) this.loadArms(this.side);
    if (this.weapon && !this.weapons.has(this.weapon)) this.loadWeapon(this.weapon);
  }

  /** Arme demandée : la plus récente (LRU). */
  private touch(key: string) {
    const had = this.weapons.get(key);
    if (had !== undefined) {
      this.weapons.delete(key);
      this.weapons.set(key, had);
    }
  }

  /** Charge un fichier une fois. « Absent » (chargeur qui renvoie null, fichier sans os wpn ou sans sl_arme) est mémorisé ;
   *  un échec (exception : réseau, 5xx, 401, 404 d'un fichier ré-exporté…, ou préparation du fichier arrivé qui lève une
   *  exception) ne l'est pas : signalé une fois (`onError`), le fichier peut être redemandé RETRY_MS plus tard, pas avant
   *  (pas de tempête de requêtes). Un fichier mal préparé est libéré. */
  private fetch<T extends object>(name: string, make: (f: VmFile) => T | null, store: (v: T | null) => void, has: () => boolean) {
    if (this.disposed || has() || this.pending.has(name)) return;
    const failedAt = this.failed.get(name);
    if (failedAt !== undefined && Date.now() - failedAt < RETRY_MS) return;
    this.pending.add(name);
    const signal = this.abort.signal;
    this.load(name, signal).then((f) => {
      this.pending.delete(name);
      if (signal.aborted) { if (f) disposeTree(f.scene); return; }  // arrivé après dispose()
      let v: T | null;
      try {
        v = f ? make(f) : null;
      } catch (e) {
        if (f) disposeTree(f.scene);  // fichier mal préparé : rien n'en est gardé
        this.fail(name, e);
        return;
      }
      this.failed.delete(name);
      if (f && !v) disposeTree(f.scene);  // fichier sans os wpn ou sans sl_arme
      store(v);
      this.remount();
      this.onChange();
    }, (e: unknown) => {
      this.pending.delete(name);
      if (signal.aborted) return;  // dispose()
      this.fail(name, e);
    });
  }

  /** Échec d'un fichier : daté (pas de nouvelle demande avant RETRY_MS), signalé une fois (sauf annulation). */
  private fail(name: string, e: unknown) {
    this.failed.set(name, Date.now());
    if ((e as Error)?.name !== "AbortError") {
      console.warn(`Vue du joueur : ${name} non chargé (nouvel essai dans ${RETRY_MS / 1000} s)`, e);
      this.onError?.(name, e);
    }
    this.onChange();
  }

  /** Monte les bras du camp et l'arme demandés s'ils sont là ; une autre arme repart de la pose de repos des bras. */
  private remount() {
    const arms = this.side ? this.arms.get(this.side) ?? null : null;
    const weapon = this.weapon ? this.weapons.get(this.weapon) ?? null : null;
    if (this.mounted !== arms) {
      this.mounted?.root.removeFromParent();
      if (arms) { this.axes.add(arms.root); arms.wpn.add(this.mount); }
      this.mounted = arms;
    }
    const next = arms && weapon ? { arms, weapon } : null;
    if (next?.arms !== this.shown?.arms || next?.weapon !== this.shown?.weapon) {
      this.mount.clear();
      if (next) {
        for (const [o, p, q, s] of next.arms.rest) { o.position.copy(p); o.quaternion.copy(q); o.scale.copy(s); }
        next.weapon.model.visible = true;
        this.mount.add(next.weapon.model);
      }
    }
    this.shown = next;
  }

  /** Au-delà de VM_KEEP armes chargées, libère les plus anciennes (jamais celle tenue). */
  private evict() {
    for (const [key, w] of this.weapons) {
      if (this.weapons.size <= VM_KEEP) break;
      if (key === this.weapon) continue;
      this.weapons.delete(key);
      if (w) this.free(w);
    }
  }

  /** Libère une arme (`drop` : voir `dispose`) ; ses reflets (texture partagée avec la scène) ne sont pas à elle. */
  private free(w: Weapon, drop = disposeTree) {
    for (const m of w.mats) m.envMap = null;
    this.cold.delete(w.model);
    this.sent(w.textures);  // libérées avec elle : plus à envoyer
    drop(w.model);
  }

  /** Pistes du clip reliées aux os du même nom (arme puis bras du camp) ; pistes sans os (econ, muzzle…) ignorées. */
  private bind(w: Weapon, arms: Arms, side: Side, name: VmClip): Bound | null {
    const key = `${side}:${name}`;
    const done = w.bound.get(key);
    if (done) return done;
    const clip = w.clips.get(name);
    if (!clip) return null;
    const channels: Channel[] = [], byObj = new Map<object, Channel>();
    for (const track of clip.tracks) {
      const { nodeName, propertyName } = PropertyBinding.parseTrackName(track.name);
      if (!TRS.has(propertyName)) continue;
      const bone = w.alias.get(nodeName) ?? nodeName;
      const node = w.nodes.get(bone) ?? arms.nodes.get(bone);
      const obj = node?.[propertyName as "position" | "quaternion" | "scale"];
      if (!obj || byObj.has(obj)) continue;
      const c: Channel = { obj, quat: propertyName === "quaternion", interp: (track as Track).createInterpolant() };
      channels.push(c);
      byObj.set(obj, c);
    }
    const b = { duration: clip.duration, channels, byObj };
    w.bound.set(key, b);
    return b;
  }
}
