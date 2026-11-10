/**
 * Un joueur en modèle d'agent : clone du modèle du camp (squelette propre, maillages et matériaux partagés), mélange des
 * clips de sa pose, arme du monde dans la main droite.
 *
 * Repères : `group` est dans le repère du jeu (unités, Z en haut) : position des pieds et lacet (rotation autour de Z).
 * Dessous, `MODEL_TO_GAME` ramène le modèle (glTF : mètres, Y en haut, regard +Z, gauche +X) au jeu (regard +X, gauche +Y).
 * Tout est mis à jour par three comme d'habitude (matrices recalculées d'après position, rotation et échelle) : aucune
 * matrice posée à la main, que three ne reprendrait qu'avec `matrixWorldNeedsUpdate` et que `getWorldPosition` laisserait
 * périmée quand le groupe bouge.
 *
 * `apply(pose, clipOf)` (pose de agentAnim.ts) :
 *  1. les clips de la pose, à leur instant et à leur poids, mélangés os par os : positions et échelles en moyenne pondérée,
 *     rotations en somme pondérée normalisée (signes alignés) ; clés lues en linéaire, rotations en slerp, comme les
 *     interpolants de three. Poids ramenés à leur somme (1 avec agentPose ; un clip absent ne laisse pas de trou) : jamais
 *     de mélange avec la pose de référence, dont la base diffère de celle des clips. Un os déjà animé qu'aucun clip de la
 *     pose n'anime (ou dont la rotation lue est inutilisable : longueur nulle ou NaN) reprend sa valeur de référence (comme
 *     avec l'AnimationMixer) : la pose ne dépend que de la pose demandée, pas des précédentes (même instant, même pose,
 *     après un saut dans la ligne de temps compris). Mouvement de racine : aucun traitement, les clips du jeu n'en ont pas
 *     (root_motion immobile à l'origine dans tous les clips relevés le 06/11/2026 : marche, course, accroupi, saut, vol,
 *     pose du C4, désamorçage, morts, atterrissage) ; la position du joueur vient du replay (`group`) ;
 *  2. l'arme suit l'os « wpn » des clips (là où le jeu la tient) mais est COLLÉE À LA MAIN DROITE : son support est un
 *     enfant de hand_R placé à inverse(hand_R) × wpn (repère du clone), pris avant l'étape 3 ;
 *  3. visée : AIM_BONES penchés autour de l'axe gauche du modèle, chacun d'une part de l'angle vertical (vers le bas pour
 *     un angle positif) ; les mains suivent le buste, l'arme suit la main droite. La rotation de ces os d'avant la visée
 *     est gardée et remise au début de la pose suivante : la visée ne s'ajoute jamais à celle d'avant (os qu'aucun clip
 *     ne réécrit).
 *  4. mort en ragdoll (`pose.ragdoll`) : les os des corps du ragdoll (noms du fichier « ragdoll », comparés sans casse :
 *     « hand_r » y est « hand_R » ici) sont posés dans le monde à la trajectoire, parents d'abord (position et rotation
 *     locales déduites de celles, à jour, du parent) ; les autres os gardent la pose des clips (la pose vivante du tick du
 *     kill) et suivent leurs parents. Leurs valeurs d'avant sont gardées et remises au début de la pose suivante : un
 *     retour avant la mort ne garde rien du ragdoll.
 * `boneStates(noms, out)` : position et rotation de ces os dans le repère du jeu (départ du ragdoll, ragdolls.ts).
 * Mélange fait ici, comme celui des bras (ViewModel.pose), et pas par l'AnimationMixer de three : mesuré le 06/11/2026
 * (squelette réel de 75 os, 225 pistes par clip, 10 joueurs à 4 clips), le mélangeur alloue environ 230 Ko par image (un
 * nombre mis en boîte à chaque appel de chaque piste) et coûte un tiers de plus ; il ne réécrit pas un os inchangé (la
 * visée s'y cumulait) et mêle la pose de référence dès que la somme des poids, en flottants, passe sous 1.
 * Sans allocation à chaque pose (10 joueurs, puce graphique intégrée) : pistes de chaque clip préparées une fois et
 * partagées par les joueurs (`sampled`), tampons du mélange gardés par joueur, l'instant lu passé par un tableau (un
 * nombre à virgule passé en argument à une fonction que V8 n'intègre pas est alloué) ; seules la première lecture d'un
 * clip par un joueur, une interpolation autre que linéaire ou par marches (son interpolant de three) et le montage d'une
 * arme allouent.
 * Pistes reliées par nom aux os relevés à la construction, avant toute arme : un nœud de l'arme montée du même nom
 * qu'un os du modèle ne prend jamais sa place.
 * `setWeapon(clé, modèle)` (avant `apply`) monte un clone de l'arme (support qui annule la rotation des axes Source de
 * son os racine, comme dans la vue du joueur) ; `setKit(oui)` montre le kit de désamorçage (CT) ; `dispose()` libère les
 * squelettes (maillages, matériaux et textures appartiennent à AgentLibrary) ; `dispose(true)` : contexte graphique perdu
 * (MEM3D), retiré de la scène et images encore gardées fermées, sans rien libérer sur la carte graphique.
 */
import { type AnimationClip, Group, type Interpolant, InterpolateDiscrete, InterpolateLinear, type KeyframeTrack, Matrix4,
  type Mesh, type Object3D, PropertyBinding, Quaternion, type SkinnedMesh, Sphere, Vector3 } from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { Side } from "../../shared/api/types";
import { type AgentPose, type AnimSet, type RagdollAt, trackAt } from "./agentAnim";
import { freeImages } from "./dispose";
import { SRC_TO_GLTF } from "./viewmodel";

const INCH = 0.0254, DEG = Math.PI / 180;
/** Modèle (glTF) → jeu : x_jeu = z, y_jeu = x, z_jeu = y, en pouces (inverse de SOURCE_TO_GLTF de
 *  scripts/map3d/lib/align.mjs). Rotation propre (déterminant positif) : pas de miroir. */
export const MODEL_TO_GAME = new Matrix4().set(
  0, 0, 1 / INCH, 0,
  1 / INCH, 0, 0, 0,
  0, 1 / INCH, 0, 0,
  0, 0, 0, 1);
/** Os penchés selon l'angle vertical du regard et part de l'angle pour chacun : buste 0,6, tête 0,3 (réglés à l'essai
 *  réel, tâche 5.1). Parents avant enfants. */
export const AIM_BONES: readonly (readonly [string, number])[] = [["spine_1", 0.2], ["spine_2", 0.25], ["spine_3", 0.15], ["head_0", 0.3]];
/** Sphères de découpage fixes (mètres, repère du modèle) : la boîte d'un maillage à peau est celle de sa pose de
 *  référence, pas celle de la pose jouée (couché compris). */
export const BODY_SPHERE = new Sphere(new Vector3(0, 1, 0), 2.4);
export const WEAPON_SPHERE = new Sphere(new Vector3(0, 0, 0), 0.8);
const LEFT = new Vector3(1, 0, 0);  // gauche du modèle
const QP = new Quaternion(), QR = new Quaternion(), QT = new Quaternion(), MH = new Matrix4(), MW = new Matrix4(), ML = new Matrix4();
const MP = new Matrix4(), QPAR = new Quaternion(), QB = new Quaternion(), VP = new Vector3(), VS = new Vector3(), RT = new Float64Array(7);
/** Matrice de `o` dans la scène (position, rotation, échelle de chaque nœud jusqu'en haut) : à jour même juste après le
 *  mélange (voir matrixIn). */
function worldIn(o: Object3D, out: Matrix4): Matrix4 {
  out.identity();
  for (let x: Object3D | null = o; x; x = x.parent) out.premultiply(ML.compose(x.position, x.quaternion, x.scale));
  return out;
}

/** Pistes de position, rotation et échelle d'un clip prêtes à lire, partagées par tous les joueurs : instants et valeurs
 *  (Float32Array de three), taille (3, ou 4 pour une rotation), lecture par marches (valeur tenue jusqu'à la clé
 *  suivante), interpolant de three pour une autre interpolation (spline cubique du glTF : alloue), nœud et propriété
 *  visés (0 position, 1 rotation, 2 échelle) ; `hint` : clé de la dernière lecture (l'instant avance peu d'une image à
 *  l'autre). */
interface Sampled {
  times: Float32Array[]; values: Float32Array[]; size: number[]; step: boolean[]; interp: (Interpolant | null)[];
  nodes: string[]; props: number[]; hint: Int32Array;
}
// posé par KeyframeTrack.setInterpolation (absent des types de three)
type Track = KeyframeTrack & { createInterpolant(): Interpolant; getInterpolation(): number | undefined };
const PROPS = ["position", "quaternion", "scale"];
const SAMPLED = new WeakMap<AnimationClip, Sampled>();

/** Pistes d'un clip prêtes à lire (une fois par clip ; voir `Sampled`). Les autres pistes (matériaux, morphes…) sont
 *  ignorées. */
function sampled(clip: AnimationClip): Sampled {
  let sp = SAMPLED.get(clip);
  if (sp) return sp;
  sp = { times: [], values: [], size: [], step: [], interp: [], nodes: [], props: [], hint: new Int32Array(clip.tracks.length) };
  for (const t of clip.tracks as Track[]) {
    const p = PropertyBinding.parseTrackName(t.name), prop = PROPS.indexOf(p.propertyName), mode = t.getInterpolation();
    if (prop < 0 || p.objectName !== undefined || p.propertyIndex !== undefined) continue;
    sp.times.push(t.times as Float32Array);
    sp.values.push(t.values as Float32Array);
    sp.size.push(t.getValueSize());
    sp.step.push(mode === InterpolateDiscrete);
    sp.interp.push(mode === InterpolateLinear || mode === InterpolateDiscrete ? null : t.createInterpolant());
    sp.nodes.push(p.nodeName);
    sp.props.push(prop);
  }
  SAMPLED.set(clip, sp);
  return sp;
}

/** Instant lu par `sample` (passé par ce tableau, voir l'en-tête) et valeur lue. */
const CLOCK = new Float64Array(1), V = new Float64Array(4);
/** Valeur de la piste `k` de `sp` à l'instant CLOCK[0], dans V : avant la première clé, sa valeur ; après la dernière,
 *  la sienne ; entre deux, interpolation linéaire (slerp pour une rotation, comme QuaternionLinearInterpolant) ou valeur
 *  de gauche (marches). */
function sample(sp: Sampled, k: number) {
  const t = CLOCK[0], interp = sp.interp[k];
  if (interp) {
    const r = interp.evaluate(t);
    for (let c = 0; c < r.length; c++) V[c] = r[c];
    return;
  }
  const times = sp.times[k], vals = sp.values[k], n = times.length, size = sp.size[k];
  let i = 0, a = 0;  // clé de gauche, part de la clé de droite
  if (n > 1 && t > times[0]) {
    if (t >= times[n - 1]) i = n - 1;
    else {
      i = sp.hint[k];
      if (!(i < n - 1 && times[i] <= t && t < times[i + 1])) {
        let lo = 0, hi = n - 1;  // times[lo] <= t < times[hi]
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          if (times[mid] <= t) lo = mid;
          else hi = mid;
        }
        i = sp.hint[k] = lo;
      }
      if (!sp.step[k]) a = (t - times[i]) / (times[i + 1] - times[i]);
    }
  }
  const p = i * size, q = p + size;
  if (a === 0) {
    for (let c = 0; c < size; c++) V[c] = vals[p + c];
  } else if (size !== 4) {
    for (let c = 0; c < size; c++) V[c] = vals[p + c] + (vals[q + c] - vals[p + c]) * a;
  } else {
    let x1 = vals[q], y1 = vals[q + 1], z1 = vals[q + 2], w1 = vals[q + 3];
    const x0 = vals[p], y0 = vals[p + 1], z0 = vals[p + 2], w0 = vals[p + 3];
    let dot = x0 * x1 + y0 * y1 + z0 * z1 + w0 * w1, s0 = 1 - a, s1 = a;
    if (dot < 0) { x1 = -x1; y1 = -y1; z1 = -z1; w1 = -w1; dot = -dot; }
    if (dot < 0.9995) {
      const th = Math.acos(dot), sin = Math.sin(th);
      s0 = Math.sin(s0 * th) / sin;
      s1 = Math.sin(a * th) / sin;
    }
    const x = x0 * s0 + x1 * s1, y = y0 * s0 + y1 * s1, z = z0 * s0 + z1 * s1, w = w0 * s0 + w1 * s1;
    const f = 1 / Math.sqrt(x * x + y * y + z * z + w * w);
    V[0] = x * f; V[1] = y * f; V[2] = z * f; V[3] = w * f;
  }
}

/** Orientation de `o` dans le repère de `root` (produit des rotations locales jusqu'à `root` exclu). */
function quatIn(o: Object3D, root: Object3D, out: Quaternion): Quaternion {
  out.identity();
  for (let x: Object3D | null = o; x && x !== root; x = x.parent) out.premultiply(x.quaternion);
  return out;
}
/** Matrice de `o` dans le repère de `root`, d'après position, rotation et échelle de chaque nœud jusqu'à `root` exclu
 *  (leurs matrices locales datent du dernier rendu : les clips viennent de les changer). Deux chaînes d'os au lieu de
 *  tout le clone (`updateMatrixWorld`) : un dixième du coût. */
function matrixIn(o: Object3D, root: Object3D, out: Matrix4): Matrix4 {
  out.identity();
  for (let x: Object3D | null = o; x && x !== root; x = x.parent) out.premultiply(ML.compose(x.position, x.quaternion, x.scale));
  return out;
}
/** Squelettes des maillages à peau d'un clone (leur texture d'os) : à libérer avec lui (maillages et matériaux sont
 *  partagés avec le modèle d'origine). */
export function disposeSkeletons(root: Object3D) {
  root.traverse((o) => (o as SkinnedMesh).skeleton?.dispose());
}
const isKit = (o: Object3D) => /defusekit/i.test(o.name) || /defusekit/i.test(o.parent?.name ?? "");

export class AgentRig {
  /** Repère du jeu : position des pieds et lacet. */
  readonly group = new Group();
  /** Clone du modèle (repère glTF). */
  readonly root: Object3D;
  /** Clé de la dernière pose posée (agentLayer.ts : pas de pose refaite pour le même instant et les mêmes fichiers). */
  posed = "";
  // mélange : pistes de chaque clip lu reliées aux propriétés des os (`slots`, -1 : pas d'os de ce nom), et par propriété
  // (place s) : sa cible, rotation ou non, somme pondérée (acc[4s..4s+3]), somme des poids de la pose en cours, valeur de
  // référence (rest[4s..4s+3]) et écrite depuis (`moved`)
  private bound = new Map<AnimationClip, { sp: Sampled; slots: Int32Array }>();
  private slotOf = new Map<object, number>();
  private targets: (Vector3 | Quaternion)[] = [];
  private quat: boolean[] = [];
  private acc = new Float64Array(0);
  private wsum = new Float64Array(0);
  private rest = new Float64Array(0);
  private moved = new Uint8Array(0);
  private nodes = new Map<string, Object3D>();
  private hand: Object3D | null;
  private wpn: Object3D | null;
  private mount = new Group();
  private support = new Group();
  private weaponKey: string | null = null;
  private weaponObj: Object3D | null = null;
  private kit: Object3D[] = [];
  // os de la visée présents dans ce modèle, leur part de l'angle et leur rotation d'avant la visée
  private aimBones: Object3D[] = [];
  private aimParts: number[] = [];
  private aimRest: Quaternion[] = [];
  private aimed = false;
  // ragdoll : os par nom en minuscules ; os des corps de la dernière trajectoire posée (ordre parents d'abord) et leurs
  // valeurs d'avant le ragdoll (`saved`), remises au début de la pose suivante
  private lower = new Map<string, Object3D>();
  private rag: { bones: readonly string[]; nodes: (Object3D | null)[]; order: number[]; saved: { p: Vector3; q: Quaternion }[] } | null = null;
  private ragged = false;

  /** `file` : fichier du modèle cloné (« agent-ct »…), pour reconnaître un autre modèle (autre camp, autre agent). */
  constructor(template: Object3D, readonly side: Side, readonly file = "") {
    this.root = cloneSkinned(template);
    const model = new Group();
    MODEL_TO_GAME.decompose(model.position, model.quaternion, model.scale);
    model.add(this.root);
    this.group.add(model);
    this.root.traverse((o) => {
      if ((o as SkinnedMesh).isSkinnedMesh) (o as SkinnedMesh).boundingSphere = BODY_SPHERE.clone();
      if ((o as Mesh).isMesh) {
        if (isKit(o)) { this.kit.push(o); o.visible = false; }
        return;
      }
      if (!this.nodes.has(o.name)) this.nodes.set(o.name, o);
      const low = o.name.toLowerCase();
      if (!this.lower.has(low)) this.lower.set(low, o);
    });
    this.hand = this.nodes.get("hand_R") ?? null;
    this.wpn = this.nodes.get("wpn") ?? null;
    for (const [name, part] of AIM_BONES) {
      const b = this.nodes.get(name);
      if (!b?.parent) continue;
      this.aimBones.push(b);
      this.aimParts.push(part);
      this.aimRest.push(new Quaternion());
    }
    this.support.quaternion.copy(SRC_TO_GLTF).invert();
    this.mount.add(this.support);
    this.hand?.add(this.mount);
  }

  /** Nœud du clone par nom d'origine (os), ou undefined. */
  node(name: string): Object3D | undefined { return this.nodes.get(name); }

  /** Pose (voir l'en-tête) ; `clipOf(jeu, clip)` : le clip réduit aux os de ce camp, null s'il manque (ignoré). Un clip
   *  rendu non null est relu tel quel aux poses suivantes (AgentLibrary.clip le garde). */
  apply(pose: AgentPose, clipOf: (set: AnimSet, name: string) => AnimationClip | null) {
    this.unaim();
    this.unragdoll();
    this.acc.fill(0);
    this.wsum.fill(0);
    const layers = pose.layers;
    for (let i = 0; i < layers.length; i++) {
      const l = layers[i], clip = clipOf(l.set, l.clip);
      if (!clip) continue;
      const { sp, slots } = this.bound.get(clip) ?? this.bind(clip), acc = this.acc, wsum = this.wsum, w = l.w;
      CLOCK[0] = l.t;
      for (let k = 0; k < slots.length; k++) {
        const s = slots[k];
        if (s < 0) continue;
        sample(sp, k);
        const o = 4 * s, rot = this.quat[s];
        // rotations : q et −q sont la même ; alignée sur la somme déjà faite
        const sw = rot && wsum[s] > 0 && acc[o] * V[0] + acc[o + 1] * V[1] + acc[o + 2] * V[2] + acc[o + 3] * V[3] < 0 ? -w : w;
        for (let c = 0, n = rot ? 4 : 3; c < n; c++) acc[o + c] += sw * V[c];
        wsum[s] += w;
      }
    }
    const acc = this.acc;
    for (let s = 0; s < this.targets.length; s++) {
      const ws = this.wsum[s], o = 4 * s;
      // rotation de longueur nulle ou NaN (clé illisible d'un fichier) : rien d'utilisable, comme sans clip
      const len = this.quat[s] ? Math.sqrt(acc[o] * acc[o] + acc[o + 1] * acc[o + 1] + acc[o + 2] * acc[o + 2] + acc[o + 3] * acc[o + 3]) : 1;
      if (!(ws > 0) || !(len > 0)) {
        if (this.moved[s]) { this.targets[s].fromArray(this.rest, o); this.moved[s] = 0; }
        continue;
      }
      this.moved[s] = 1;
      if (this.quat[s]) for (let c = 0; c < 4; c++) acc[o + c] /= len;
      else for (let c = 0; c < 3; c++) acc[o + c] /= ws;
      this.targets[s].fromArray(acc, o);
    }
    this.glue();
    if (pose.ragdoll) this.placeRagdoll(pose.ragdoll);
    this.aim(pose);
  }

  /** Position et rotation (repère du jeu) des os `names` (sans casse) dans out (7 nombres par os) ; faux si l'un manque. */
  boneStates(names: readonly string[], out: Float64Array): boolean {
    for (let i = 0; i < names.length; i++) {
      const b = this.lower.get(names[i].toLowerCase());
      if (!b) return false;
      worldIn(b, MP).decompose(VP, QPAR, VS);
      out[7 * i] = VP.x; out[7 * i + 1] = VP.y; out[7 * i + 2] = VP.z;
      out[7 * i + 3] = QPAR.x; out[7 * i + 4] = QPAR.y; out[7 * i + 5] = QPAR.z; out[7 * i + 6] = QPAR.w;
    }
    return true;
  }

  /** Arme en main : clé (monde-<clé>) et modèle prêt à cloner ; null : rien. Le même appel répété ne refait rien ; le
   *  modèle arrivé après la clé est monté à l'appel suivant. */
  setWeapon(key: string | null, model: Object3D | null) {
    if (key === this.weaponKey && (this.weaponObj !== null || model === null)) return;
    if (this.weaponObj) disposeSkeletons(this.weaponObj);
    this.support.clear();
    this.weaponObj = null;
    this.weaponKey = key;
    if (!key || !model) return;
    const w = cloneSkinned(model);
    w.traverse((o) => { if ((o as SkinnedMesh).isSkinnedMesh) (o as SkinnedMesh).boundingSphere = WEAPON_SPHERE.clone(); });
    this.support.add(w);
    this.weaponObj = w;
  }

  /** Arme montée (clone), ou null. */
  weapon(): Object3D | null { return this.weaponObj; }

  /** Kit de désamorçage visible (CT qui en a un). */
  setKit(on: boolean) { for (const k of this.kit) k.visible = on; }

  /** Retire le joueur de la scène et libère ses squelettes (texture des os). `lost` : contexte graphique perdu depuis les
   *  rendus : rien n'est libéré sur la carte graphique (ces ressources sont parties avec lui, les libérer ferait avertir
   *  le navigateur), seules les images encore gardées sont fermées (`freeImages`) ; elles sont partagées avec
   *  AgentLibrary, libérée elle aussi dans ce cas (`dispose(true)`). */
  dispose(lost = false) {
    const drop = lost ? freeImages : disposeSkeletons;
    if (this.weaponObj) drop(this.weaponObj);  // sous la main, donc aussi sous root : une seconde fois sans effet
    drop(this.root);
    this.group.removeFromParent();
    this.bound.clear();
  }

  /** Pistes d'un clip pas encore lu par ce joueur reliées aux propriétés des os du même nom (voir l'en-tête). */
  private bind(clip: AnimationClip): { sp: Sampled; slots: Int32Array } {
    const sp = sampled(clip), slots = new Int32Array(sp.nodes.length);
    for (let k = 0; k < slots.length; k++) {
      const node = this.nodes.get(sp.nodes[k]);
      slots[k] = node ? this.slot([node.position, node.quaternion, node.scale][sp.props[k]], sp.props[k] === 1) : -1;
    }
    const b = { sp, slots };
    this.bound.set(clip, b);
    return b;
  }

  /** Place d'une propriété d'os dans les tampons du mélange (agrandis au besoin, valeurs de la pose en cours gardées) ;
   *  sa valeur de référence : celle qu'elle a encore quand le premier clip qui l'anime est relié (seul le mélange écrit
   *  une propriété, par sa place, et la visée est retirée au début de chaque pose, avant toute liaison). */
  private slot(target: Vector3 | Quaternion, rot: boolean): number {
    const known = this.slotOf.get(target);
    if (known !== undefined) return known;
    const s = this.targets.length;
    this.slotOf.set(target, s);
    this.targets.push(target);
    this.quat.push(rot);
    if (s >= this.wsum.length) {
      const n = Math.max(64, 2 * this.wsum.length), wsum = new Float64Array(n), acc = new Float64Array(4 * n);
      const rest = new Float64Array(4 * n), moved = new Uint8Array(n);
      wsum.set(this.wsum);
      acc.set(this.acc);
      rest.set(this.rest);
      moved.set(this.moved);
      [this.wsum, this.acc, this.rest, this.moved] = [wsum, acc, rest, moved];
    }
    target.toArray(this.rest, 4 * s);
    return s;
  }

  /** Rotation d'avant la visée remise (voir l'en-tête, étape 3). */
  private unaim() {
    if (!this.aimed) return;
    this.aimed = false;
    for (let i = 0; i < this.aimBones.length; i++) this.aimBones[i].quaternion.copy(this.aimRest[i]);
  }

  /** Os des corps du ragdoll posés à la trajectoire (voir l'en-tête, étape 4). */
  private placeRagdoll(at: RagdollAt) {
    const tr = at.track;
    let rag = this.rag;
    if (!rag || rag.bones !== tr.bones) {
      const nodes = tr.bones.map((b) => this.lower.get(b.toLowerCase()) ?? null);
      const depth = (o: Object3D | null) => { let d = 0; for (let x = o; x; x = x.parent) d++; return d; };
      const order = nodes.map((_, i) => i).sort((a, b) => depth(nodes[a]) - depth(nodes[b]) || a - b);
      rag = this.rag = { bones: tr.bones, nodes, order, saved: nodes.map(() => ({ p: new Vector3(), q: new Quaternion() })) };
    }
    for (const i of rag.order) {
      const b = rag.nodes[i];
      if (!b?.parent) continue;
      rag.saved[i].p.copy(b.position);
      rag.saved[i].q.copy(b.quaternion);
      trackAt(tr, at.t, i, RT);
      worldIn(b.parent, MP).decompose(VP, QPAR, VS);
      b.position.set(RT[0], RT[1], RT[2]).applyMatrix4(MP.invert());
      b.quaternion.copy(QPAR.invert()).multiply(QB.set(RT[3], RT[4], RT[5], RT[6]));
    }
    this.ragged = true;
  }

  /** Valeurs d'avant le ragdoll remises (enfants d'abord). */
  private unragdoll() {
    const rag = this.rag;
    if (!this.ragged || !rag) return;
    this.ragged = false;
    for (let k = rag.order.length - 1; k >= 0; k--) {
      const i = rag.order[k], b = rag.nodes[i];
      if (!b?.parent) continue;
      b.position.copy(rag.saved[i].p);
      b.quaternion.copy(rag.saved[i].q);
    }
  }

  /** Support de l'arme : enfant de hand_R placé sur wpn (voir l'en-tête, étape 2). */
  private glue() {
    if (!this.hand || !this.wpn) return;
    matrixIn(this.hand, this.root, MH).invert().multiply(matrixIn(this.wpn, this.root, MW))
      .decompose(this.mount.position, this.mount.quaternion, this.mount.scale);
  }

  /** Buste et tête penchés de `pose.aim` degrés (positif : vers le bas) autour de l'axe gauche du modèle (la pose plutôt
   *  que l'angle en argument : voir l'en-tête, allocation). */
  private aim(pose: AgentPose) {
    const deg = pose.aim;
    if (!deg) return;
    for (let i = 0; i < this.aimBones.length; i++) {
      const b = this.aimBones[i];
      this.aimRest[i].copy(b.quaternion);
      quatIn(b.parent!, this.root, QP);
      QR.setFromAxisAngle(LEFT, this.aimParts[i] * deg * DEG);
      // rotation QR du modèle exprimée dans le repère du parent : QP⁻¹ · QR · QP
      QT.copy(QP).invert().multiply(QR).multiply(QP);
      b.quaternion.premultiply(QT);
    }
    this.aimed = true;
  }
}
