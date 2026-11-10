import { afterEach, describe, expect, it, vi } from "vitest";
import { AnimationClip, BooleanKeyframeTrack, Bone, BufferGeometry, Float32BufferAttribute, Group, InterpolateDiscrete, InterpolateSmooth, type KeyframeTrack,
  Mesh, MeshStandardMaterial, type Object3D, Quaternion, QuaternionKeyframeTrack, Skeleton, SkinnedMesh, Texture,
  Uint16BufferAttribute, Vector3, VectorKeyframeTrack } from "three";
import type { AgentPose, ClipRef } from "./agentAnim";
import { AgentRig, BODY_SPHERE, MODEL_TO_GAME, WEAPON_SPHERE } from "./agentRig";
import { parseGlbAnimated } from "./loader";
import { agentGlb, animsGlb, mondeGlb } from "./testGlb";

const read = (b: Uint8Array<ArrayBuffer>) => parseGlbAnimated(b.buffer);
async function setup() {
  const model = (await read(agentGlb())).scene, clips = new Map((await read(animsGlb())).clips.map((c) => [c.name, c]));
  const weapon = (await read(mondeGlb())).scene.getObjectByName("sl_arme")!;
  weapon.traverse((o) => { if (o.name === "weapon") o.position.set(0, 0, 0); });  // comme AgentLibrary
  const rig = new AgentRig(model, "CT"), scene = new Group().add(rig.group);
  const clipOf = (_set: string, name: string): AnimationClip | null => clips.get(name) ?? null;
  return { rig, scene, weapon, clipOf, model };
}
const pose = (layers: Partial<ClipRef>[], aim = 0): AgentPose =>
  ({ layers: layers.map((l) => ({ set: "rifle", t: 0, w: 1, ...l }) as ClipRef), aim, weapon: null, body: null });
const world = (o: Object3D) => { o.updateWorldMatrix(true, false); return o.getWorldPosition(new Vector3()); };

describe("modèle d'agent", () => {
  it("modèle → jeu : mètres → pouces, Y du modèle en Z du jeu, regard +Z du modèle en +X du jeu", () => {
    expect(new Vector3(0, 1, 0).applyMatrix4(MODEL_TO_GAME).toArray().map((x) => +x.toFixed(3))).toEqual([0, 0, 39.37]);
    expect(new Vector3(0, 0, 1).applyMatrix4(MODEL_TO_GAME).toArray().map((x) => +x.toFixed(3))).toEqual([39.37, 0, 0]);
    expect(new Vector3(1, 0, 0).applyMatrix4(MODEL_TO_GAME).toArray().map((x) => +x.toFixed(3))).toEqual([0, 39.37, 0]);  // gauche
    expect(MODEL_TO_GAME.determinant()).toBeGreaterThan(0);
  });
  it("clips mélangés à leur poids et à leur instant ; une action absente de la pose suivante s'arrête", async () => {
    const { rig, clipOf } = await setup(), pelvis = rig.node("pelvis")!;
    rig.apply(pose([{ clip: "idle", w: 0.5 }, { clip: "idle_crouch", w: 0.5 }]), clipOf);
    expect(world(pelvis).z).toBeCloseTo(0.8 / 0.0254, 3);
    rig.apply(pose([{ clip: "walk_n", t: 0.5 }]), clipOf);
    expect(world(pelvis).z).toBeCloseTo(1.02 / 0.0254, 3);
    rig.apply(pose([{ clip: "idle_crouch" }]), clipOf);
    expect(world(pelvis).z).toBeCloseTo(0.6 / 0.0254, 3);
  });
  it("position des pieds et lacet : le groupe du joueur dans le repère du jeu", async () => {
    const { rig, clipOf } = await setup();
    rig.group.position.set(100, 200, 10);
    rig.group.rotation.z = Math.PI / 2;  // regard +Y
    rig.apply(pose([{ clip: "idle" }]), clipOf);
    const head = world(rig.node("head_0")!);
    expect(head.toArray().map((x) => +x.toFixed(2))).toEqual([100, 200, +(10 + 1.65 / 0.0254).toFixed(2)]);
  });
  it("arme collée à la main droite, posée sur l'os wpn ; regard vers le bas : buste et tête penchés en avant, l'arme suit", async () => {
    const { rig, weapon, clipOf } = await setup();
    rig.setWeapon("ak47", weapon);
    rig.apply(pose([{ clip: "idle" }]), clipOf);
    const gun = rig.weapon()!, hand = rig.node("hand_R")!;
    expect(world(gun).distanceTo(world(rig.node("wpn")!))).toBeLessThan(1e-3);
    const handGun = world(hand).distanceTo(world(gun)), headX = world(rig.node("head_0")!).x;
    rig.apply(pose([{ clip: "idle" }], 40), clipOf);
    expect(world(rig.node("head_0")!).x).toBeGreaterThan(headX + 5);  // vers l'avant (+X du jeu)
    expect(world(hand).distanceTo(world(gun))).toBeCloseTo(handGun, 3);  // l'arme suit la main
    expect(world(gun).distanceTo(world(rig.node("wpn")!))).toBeGreaterThan(1);  // et quitte wpn, resté en place
  });
  it("arme : même clé sans rien refaire, modèle monté quand il arrive, null : plus d'arme ; kit caché par défaut", async () => {
    const { rig, weapon } = await setup();
    rig.setWeapon("ak47", null);
    expect(rig.weapon()).toBeNull();
    rig.setWeapon("ak47", weapon);
    const first = rig.weapon();
    expect(first).not.toBeNull();
    rig.setWeapon("ak47", weapon);
    expect(rig.weapon()).toBe(first);
    rig.setWeapon(null, null);
    expect(rig.weapon()).toBeNull();
    let kit: Object3D | undefined;
    rig.root.traverse((o) => { if (o.name === "defusekit") kit = o; });
    expect(kit!.visible).toBe(false);
    rig.setKit(true);
    expect(kit!.visible).toBe(true);
  });
  it("dispose : retiré de la scène", async () => {
    const { rig, scene } = await setup();
    rig.dispose();
    expect(scene.children).toHaveLength(0);
  });
});

// Au-delà du brief : visée sans cumul, repères jamais périmés, clones, sphères de découpage, libération (normale et
// contexte perdu, amendements du 05/11).
describe("modèle d'agent : règles de la pose", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("poids quelconques (somme 1) : moyenne pondérée ; clip absent (clipOf null) ignoré, les autres ramenés à leur somme ; pas de pose encore : rien d'attendu", async () => {
    const { rig, clipOf } = await setup(), pelvis = rig.node("pelvis")!;
    expect(rig.posed).toBe("");
    rig.apply(pose([{ clip: "idle", w: 0.25 }, { clip: "idle_crouch", w: 0.75 }]), clipOf);
    expect(world(pelvis).z).toBeCloseTo((0.25 * 1 + 0.75 * 0.6) / 0.0254, 3);
    rig.apply(pose([{ clip: "absent", w: 0.5 }, { clip: "walk_n", t: 1, w: 0.5 }]), clipOf);
    expect(world(pelvis).z).toBeCloseTo(1.04 / 0.0254, 3);  // pas de moitié de pose de référence
  });
  it("visée : la même pose reposée ne penche pas davantage ; sans visée, buste, tête et arme reviennent", async () => {
    // les clips ne réécrivent pas un os dont la valeur n'a pas changé (AnimationMixer) : la visée de la pose d'avant ne
    // doit pas rester sous la suivante
    const { rig, weapon, clipOf } = await setup();
    rig.setWeapon("ak47", weapon);
    rig.apply(pose([{ clip: "idle" }]), clipOf);
    const head0 = world(rig.node("head_0")!), gun0 = world(rig.weapon()!);
    rig.apply(pose([{ clip: "idle" }], 40), clipOf);
    const head40 = world(rig.node("head_0")!), gun40 = world(rig.weapon()!);
    rig.apply(pose([{ clip: "idle" }], 40), clipOf);
    expect(world(rig.node("head_0")!).distanceTo(head40)).toBeLessThan(1e-6);
    expect(world(rig.weapon()!).distanceTo(gun40)).toBeLessThan(1e-6);
    rig.apply(pose([{ clip: "idle" }], -30), clipOf);
    expect(world(rig.node("head_0")!).x).toBeLessThan(head0.x - 3);  // regard vers le haut : penché en arrière
    rig.apply(pose([{ clip: "idle" }]), clipOf);
    expect(world(rig.node("head_0")!).distanceTo(head0)).toBeLessThan(1e-6);
    expect(world(rig.weapon()!).distanceTo(gun0)).toBeLessThan(1e-6);
  });
  it("groupe déplacé et tourné après une première lecture des positions : modèle et arme suivent (rien de périmé)", async () => {
    const { rig, weapon, clipOf } = await setup();
    rig.setWeapon("ak47", weapon);
    rig.apply(pose([{ clip: "idle" }]), clipOf);
    world(rig.node("head_0")!);
    world(rig.weapon()!);
    rig.group.position.set(-50, 30, 4);
    rig.group.rotation.z = Math.PI;
    expect(world(rig.node("head_0")!).toArray().map((x) => +x.toFixed(2))).toEqual([-50, 30, +(4 + 1.65 / 0.0254).toFixed(2)]);
    expect(world(rig.weapon()!).distanceTo(world(rig.node("wpn")!))).toBeLessThan(1e-3);
  });
  it("première lecture d'un clip arme en main : ses pistes vont aux os du modèle, jamais à un nœud de l'arme du même nom ; os qu'aucun clip de la pose n'anime : valeur de référence", async () => {
    const { rig, weapon, clipOf } = await setup(), w = weapon.clone();
    w.getObjectByName("weapon")!.add(Object.assign(new Group(), { name: "wpn" }));  // trouvé avant l'os wpn du modèle
    rig.setWeapon("ak47", w);
    const up = new AnimationClip("wpn_haut", 1, [new VectorKeyframeTrack("wpn.position", [0], [-0.2, 0.25, 0.3])]);
    rig.apply(pose([{ clip: "wpn_haut" }]), () => up);
    expect(rig.node("wpn")!.position.y).toBeCloseTo(0.25, 6);
    expect(world(rig.weapon()!).distanceTo(world(rig.node("wpn")!))).toBeLessThan(1e-3);
    rig.apply(pose([{ clip: "idle" }]), clipOf);
    expect(rig.node("wpn")!.position.y).toBeCloseTo(-0.05, 6);  // os qu'aucun clip de la pose n'anime : valeur de référence
    rig.apply(pose([{ clip: "wpn_haut" }]), () => up);
    expect(rig.node("wpn")!.position.y).toBeCloseTo(0.25, 6);
  });
  it("axes de l'arme : ceux de l'os wpn (rotation des axes Source de son os racine annulée par le support)", async () => {
    const { rig, weapon, clipOf } = await setup();
    rig.setWeapon("ak47", weapon);
    rig.apply(pose([{ clip: "idle" }]), clipOf);
    const q = (o: Object3D) => { o.updateWorldMatrix(true, false); return o.getWorldQuaternion(new Quaternion()); };
    expect(q(rig.weapon()!.getObjectByName("weapon")!).angleTo(q(rig.node("wpn")!))).toBeLessThan(1e-6);
  });
  it("chaque joueur a son clone : le modèle de la bibliothèque n'est ni déplacé ni posé, deux joueurs posés à part", async () => {
    const { rig, clipOf, model, weapon } = await setup(), other = new AgentRig(model, "T", "agent-t"), home = weapon.parent;
    expect([rig.file, other.file, other.side]).toEqual(["", "agent-t", "T"]);
    rig.setWeapon("ak47", weapon);
    other.setWeapon("ak47", weapon);
    expect(rig.weapon()).not.toBe(other.weapon());
    expect(model.parent).toBeNull();
    expect(weapon.parent).toBe(home);
    rig.apply(pose([{ clip: "idle_crouch" }]), clipOf);
    other.apply(pose([{ clip: "idle" }]), clipOf);
    expect(world(rig.node("pelvis")!).z).toBeCloseTo(0.6 / 0.0254, 3);
    expect(world(other.node("pelvis")!).z).toBeCloseTo(1 / 0.0254, 3);
    expect(model.getObjectByName("pelvis")!.position.y).toBe(1);  // pose de référence du fichier
  });
});

// Clips faits à la main : rotations (le bassin des fichiers de test ne fait que monter et descendre), marches, spline.
describe("modèle d'agent : mélange des clips (rotations, clés, interpolations)", () => {
  const DEG = Math.PI / 180, Y = new Vector3(0, 1, 0);
  const rotY = (deg: number) => new Quaternion().setFromAxisAngle(Y, deg * DEG).toArray();
  /** Rotation de spine_0 autour de Y (degrés). */
  const angle = (rig: AgentRig) => { const q = rig.node("spine_0")!.quaternion; return (2 * Math.atan2(q.y, q.w)) / DEG; };
  const turn = (name: string, times: number[], values: number[]) =>
    new AnimationClip(name, -1, [new QuaternionKeyframeTrack("spine_0.quaternion", times, values)]);
  const lookup = (...clips: AnimationClip[]) => (_s: string, n: string) => clips.find((c) => c.name === n) ?? null;

  it("rotation entre deux clés : slerp ; avant la première et après la dernière : leur valeur ; instant qui recule : bonne clé", async () => {
    const { rig } = await setup(), clips = lookup(turn("tourne", [0.2, 1.2, 2.2], [...rotY(0), ...rotY(90), ...rotY(120)]));
    const at = (t: number) => { rig.apply(pose([{ clip: "tourne", t }]), clips); return angle(rig); };
    expect(at(0.45)).toBeCloseTo(22.5, 3);  // un quart de 90° (slerp ; une interpolation linéaire normalisée donnerait 21,6°)
    expect(at(1.7)).toBeCloseTo(105, 3);
    expect(at(0.45)).toBeCloseTo(22.5, 3);
    expect(at(0)).toBeCloseTo(0, 6);
    expect(at(3)).toBeCloseTo(120, 3);
    expect(at(1.2)).toBeCloseTo(90, 3);
    const flip = lookup(turn("tourne", [0, 1], [...rotY(0), ...rotY(90).map((x) => -x)]));  // clé suivante donnée en −q
    rig.apply(pose([{ clip: "tourne", t: 0.5 }]), flip);
    expect(angle(rig)).toBeCloseTo(45, 3);  // le plus court chemin
  });
  it("rotations de plusieurs clips : somme pondérée normalisée ; q et −q donnent la même pose", async () => {
    const { rig } = await setup(), q90 = rotY(90);
    const clips = lookup(turn("droit", [0], rotY(0)), turn("quart", [0], q90), turn("oppose", [0], q90.map((x) => -x)));
    rig.apply(pose([{ clip: "droit", w: 0.5 }, { clip: "quart", w: 0.5 }]), clips);
    expect(angle(rig)).toBeCloseTo(45, 3);
    rig.apply(pose([{ clip: "droit", w: 0.25 }, { clip: "quart", w: 0.75 }]), clips);
    expect(angle(rig)).toBeCloseTo((2 * Math.atan2(0.75 * Math.sin(Math.PI / 4), 0.25 + 0.75 * Math.cos(Math.PI / 4))) / DEG, 3);
    expect(rig.node("spine_0")!.quaternion.length()).toBeCloseTo(1, 9);  // rotation pure
    rig.apply(pose([{ clip: "droit", w: 0.5 }, { clip: "oppose", w: 0.5 }]), clips);
    expect(angle(rig)).toBeCloseTo(45, 3);
  });
  it("pistes d'autres propriétés (visibilité…) ignorées", async () => {
    const { rig } = await setup();
    const c = new AnimationClip("mixte", -1, [new BooleanKeyframeTrack("pelvis.visible", [0], [false]),
      new VectorKeyframeTrack("pelvis.position", [0], [0, 0.7, 0])]);
    rig.apply(pose([{ clip: "mixte" }]), lookup(c));
    expect(rig.node("pelvis")!.position.y).toBeCloseTo(0.7, 6);
    expect(rig.node("pelvis")!.visible).toBe(true);
  });
  it("un clip qui apporte beaucoup d'os d'un coup (tampons agrandis en pleine pose) : ce que les clips d'avant ont posé est gardé", () => {
    const template = new Group(), pelvis = Object.assign(new Group(), { name: "pelvis" });
    template.add(pelvis);
    const names = Array.from({ length: 70 }, (_, k) => `os_${k}`);
    for (const name of names) template.add(Object.assign(new Group(), { name }));
    const at = (name: string, y: number) => new VectorKeyframeTrack(`${name}.position`, [0], [0, y, 0]);
    const small = new AnimationClip("peu", -1, [at("pelvis", 1)]);
    const big = new AnimationClip("beaucoup", -1, [...names.map((n) => at(n, 2)), at("pelvis", 0.6)]);
    const rig = new AgentRig(template, "T");
    rig.apply(pose([{ clip: "peu", w: 0.5 }, { clip: "beaucoup", w: 0.5 }]), lookup(small, big));
    expect(rig.node("pelvis")!.position.y).toBeCloseTo(0.8, 6);
    expect(rig.node("os_69")!.position.y).toBeCloseTo(2, 6);
  });
  it("rotation inutilisable (clé NaN d'un fichier abîmé) : l'os reprend sa valeur de référence, sans rester figé ni NaN", async () => {
    const { rig } = await setup(), q = rig.node("spine_0")!.quaternion;
    const clips = lookup(turn("quart", [0], rotY(90)), turn("casse", [0], [NaN, NaN, NaN, NaN]));
    rig.apply(pose([{ clip: "quart" }]), clips);
    expect(angle(rig)).toBeCloseTo(90, 3);
    rig.apply(pose([{ clip: "casse" }]), clips);
    expect(q.toArray()).toEqual([0, 0, 0, 1]);  // pose de référence du fichier de test
    rig.apply(pose([{ clip: "quart" }]), clips);
    expect(angle(rig)).toBeCloseTo(90, 3);
  });
  it("interpolation par marches : valeur tenue jusqu'à la clé suivante ; autre interpolation (spline) : celle de three", async () => {
    const { rig } = await setup(), y = () => rig.node("pelvis")!.position.y;
    const step: KeyframeTrack = new VectorKeyframeTrack("pelvis.position", [0, 1, 2], [0, 0.5, 0, 0, 1.5, 0, 0, 2.5, 0], InterpolateDiscrete);
    const smooth: KeyframeTrack = new VectorKeyframeTrack("pelvis.position", [0, 1, 2, 3], [0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0], InterpolateSmooth);
    const clips = lookup(new AnimationClip("marches", -1, [step]), new AnimationClip("lisse", -1, [smooth]));
    rig.apply(pose([{ clip: "marches", t: 0.9 }]), clips);
    expect(y()).toBeCloseTo(0.5, 6);
    rig.apply(pose([{ clip: "marches", t: 1 }]), clips);
    expect(y()).toBeCloseTo(1.5, 6);  // pile sur une clé : la sienne
    rig.apply(pose([{ clip: "marches", t: 1.99 }]), clips);
    expect(y()).toBeCloseTo(1.5, 6);
    const ref = (smooth.clone() as KeyframeTrack & { createInterpolant(): { evaluate(t: number): ArrayLike<number> } }).createInterpolant();
    rig.apply(pose([{ clip: "lisse", t: 0.5 }]), clips);
    expect(y()).toBeCloseTo(ref.evaluate(0.5)[1], 6);
    expect(Math.abs(y() - 0.5)).toBeGreaterThan(0.01);  // pas la droite entre les deux clés
  });
});

// ImageBitmap absent sous Node : image décodée factice, qui compte ses fermetures (comme agents.test.ts)
class Bitmap { width = 8; height = 8; closed = 0; close() { this.closed++; } }

/** Modèle et arme faits à la main, à peau et texturés comme les vrais fichiers (le kit, un groupe « defusekit » et son
 *  maillage). `events` : libérations sur la carte graphique (événements dispose) des géométries, matériaux et textures
 *  de la bibliothèque, puis des textures des os des clones (`bones(rig)`, créées comme le ferait le rendu). */
function handmade() {
  vi.stubGlobal("ImageBitmap", Bitmap);
  const events: string[] = [], images: Bitmap[] = [];
  const watch = (name: string, o: { addEventListener(t: "dispose", f: () => void): void }) => o.addEventListener("dispose", () => events.push(name));
  const textured = <T extends Mesh>(name: string, make: (g: BufferGeometry, m: MeshStandardMaterial) => T): T => {
    const img = new Bitmap(), map = new Texture(img as Bitmap & ImageBitmap), geo = new BufferGeometry();
    geo.setAttribute("position", new Float32BufferAttribute([0, 0, 0, 0.1, 0, 0, 0, 0.1, 0], 3));
    geo.setAttribute("skinIndex", new Uint16BufferAttribute(new Array(12).fill(0), 4));
    geo.setAttribute("skinWeight", new Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
    const mat = new MeshStandardMaterial({ map }), m = make(geo, mat);
    m.name = name;
    images.push(img);
    watch(`${name}:géométrie`, geo);
    watch(`${name}:matériau`, mat);
    watch(`${name}:texture`, map);
    return m;
  };
  const bone = (name: string, x: number, y: number, z: number, ...children: Object3D[]) => {
    const b = new Bone();
    b.name = name;
    b.position.set(x, y, z);
    return children.length ? b.add(...children) : b;
  };
  const chain = bone("root_motion", 0, 0, 0, bone("pelvis", 0, 1, 0, bone("spine_1", 0, 0.2, 0, bone("spine_2", 0, 0.1, 0,
    bone("spine_3", 0, 0.1, 0, bone("head_0", 0, 0.25, 0), bone("hand_R", -0.2, -0.3, 0.25))))), bone("wpn", -0.2, 1.35, 0.3));
  const skin = (g: BufferGeometry, m: MeshStandardMaterial) => new SkinnedMesh(g, m);
  const body = textured("thirdperson_body", skin), kit = Object.assign(new Group(), { name: "defusekit" });
  kit.add(textured("kit_maillage", (g, m) => new Mesh(g, m)));
  const model = new Group().add(chain, body, kit);
  const bones: Bone[] = [];
  chain.traverse((o) => { if ((o as Bone).isBone) bones.push(o as Bone); });
  body.bind(new Skeleton(bones));
  const root = bone("weapon", 0, 0, 0), corps = textured("corps", skin);
  const weapon = Object.assign(new Group(), { name: "sl_arme" }).add(root, corps);
  corps.bind(new Skeleton([root]));
  return { model, weapon, events, images, closed: () => images.map((i) => i.closed) };
}
/** Textures des os des maillages à peau d'un clone, créées comme le fait le rendu ; leur libération est notée. */
function boneTextures(root: Object3D, events: string[]) {
  root.traverse((o) => {
    const s = (o as SkinnedMesh).skeleton;
    if (!(o as SkinnedMesh).isSkinnedMesh || !s) return;
    s.computeBoneTexture();
    s.boneTexture!.addEventListener("dispose", () => events.push(`os:${o.name}`));
  });
}

describe("modèle d'agent : sphères de découpage, kit, arme changée, libération", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sphères de découpage fixes (copies) : corps et arme ; kit (groupe « defusekit ») caché par défaut", () => {
    const h = handmade(), rig = new AgentRig(h.model, "CT");
    rig.setWeapon("ak47", h.weapon);
    const body = rig.root.getObjectByName("thirdperson_body") as SkinnedMesh, gun = rig.weapon()!.getObjectByName("corps") as SkinnedMesh;
    expect(body.boundingSphere).not.toBe(BODY_SPHERE);
    expect(body.boundingSphere!.equals(BODY_SPHERE)).toBe(true);
    expect(gun.boundingSphere!.equals(WEAPON_SPHERE)).toBe(true);
    expect(gun.boundingSphere).not.toBe(WEAPON_SPHERE);
    expect((h.model.getObjectByName("thirdperson_body") as SkinnedMesh).boundingSphere).toBeNull();  // modèle intact
    const kit = rig.root.getObjectByName("kit_maillage")!;
    expect(kit.visible).toBe(false);
    rig.setKit(true);
    expect(kit.visible).toBe(true);
    rig.setKit(false);
    expect(kit.visible).toBe(false);
  });
  it("os aux repères tournés (comme les vrais squelettes) : la visée penche le buste vers l'avant, pas sur le côté", () => {
    const h = handmade();
    h.model.getObjectByName("spine_1")!.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    h.model.getObjectByName("spine_3")!.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), 0.7);
    const rig = new AgentRig(h.model, "CT"), none = () => null;
    rig.apply(pose([]), none);
    const head0 = world(rig.node("head_0")!);
    rig.apply(pose([], 40), none);
    const d = world(rig.node("head_0")!).sub(head0);
    expect(d.x).toBeGreaterThan(2);  // vers l'avant (+X du jeu)
    expect(Math.abs(d.y)).toBeLessThan(1e-6);  // pas sur le côté (gauche du jeu : +Y)
    rig.apply(pose([]), none);
    expect(world(rig.node("head_0")!).distanceTo(head0)).toBeLessThan(1e-6);  // sans visée : rotations d'origine
  });
  it("modèle sans main droite : arme montée nulle part, libérée quand même avec le joueur", () => {
    const h = handmade();
    h.model.getObjectByName("hand_R")!.name = "hand_R_absente";
    const rig = new AgentRig(h.model, "CT");
    rig.setWeapon("ak47", h.weapon);
    boneTextures(rig.weapon()!, h.events);
    rig.dispose();
    expect(h.events).toEqual(["os:corps"]);
  });
  it("autre arme : l'ancienne retirée et son squelette libéré, la nouvelle montée ; rien de la bibliothèque libéré", () => {
    const h = handmade(), rig = new AgentRig(h.model, "CT");
    rig.setWeapon("ak47", h.weapon);
    const first = rig.weapon()!;
    boneTextures(first, h.events);
    rig.setWeapon("m4a1", h.weapon);
    expect(rig.weapon()).not.toBe(first);
    expect(first.parent).toBeNull();
    expect(h.events).toEqual(["os:corps"]);
    expect(h.closed()).toEqual([0, 0, 0]);
  });
  it("dispose : retiré de la scène, squelettes des clones libérés (corps et arme), rien de la bibliothèque", () => {
    const h = handmade(), rig = new AgentRig(h.model, "CT"), scene = new Group().add(rig.group);
    rig.setWeapon("ak47", h.weapon);
    boneTextures(rig.root, h.events);
    rig.dispose();
    expect(scene.children).toHaveLength(0);
    expect(h.events.sort()).toEqual(["os:corps", "os:thirdperson_body"]);
    expect(h.closed()).toEqual([0, 0, 0]);  // images de la bibliothèque : à elle
  });
  it("contexte perdu (dispose(true)) : retiré de la scène, images encore gardées fermées, rien de libéré sur la carte graphique", () => {
    const h = handmade(), rig = new AgentRig(h.model, "CT"), scene = new Group().add(rig.group);
    rig.setWeapon("ak47", h.weapon);
    boneTextures(rig.root, h.events);
    rig.dispose(true);
    expect(scene.children).toHaveLength(0);
    expect(h.events).toEqual([]);  // parties avec le contexte : les libérer avertirait (« object does not belong to this context »)
    expect(h.closed()).toEqual([1, 1, 1]);
  });
});

describe("ragdoll", () => {
  const near = (v: Vector3 | number[]) => (Array.isArray(v) ? v : v.toArray()).map((x) => +x.toFixed(2));
  it("os des corps dans le monde, par nom sans casse ; os absent du modèle : faux", async () => {
    const { rig, clipOf } = await setup();
    rig.group.position.set(100, 200, 10);
    rig.group.rotation.z = Math.PI / 2;
    rig.apply(pose([{ clip: "idle" }]), clipOf);
    const out = new Float64Array(14), head = rig.node("head_0")!;
    expect(rig.boneStates(["pelvis", "HEAD_0"], out)).toBe(true);
    expect(near([out[7], out[8], out[9]])).toEqual(near(world(head)));
    const q = head.getWorldQuaternion(new Quaternion());
    expect(Math.abs(q.dot(new Quaternion(out[10], out[11], out[12], out[13])))).toBeCloseTo(1, 6);
    expect(rig.boneStates(["pelvis", "ankle_l"], out)).toBe(false);
  });
  it("mort en ragdoll : os des corps à la trajectoire (images mélangées), les autres suivent ; pose suivante sans ragdoll : rien ne reste", async () => {
    const { rig, clipOf } = await setup();
    rig.apply(pose([{ clip: "idle" }]), clipOf);
    const a = new Float64Array(14);
    rig.boneStates(["pelvis", "head_0"], a);
    // image 1 : corps couché, 20 u plus loin (bassin) et tête 25,6 u au-delà, à 5 u du sol ; rotations : celles de l'image 0
    const p = Float32Array.from([a[0], a[1], a[2], a[7], a[8], a[9], a[0] + 20, a[1], 5, a[0] + 45.6, a[1], 5]);
    const q = Float32Array.from([a[3], a[4], a[5], a[6], a[10], a[11], a[12], a[13], a[3], a[4], a[5], a[6], a[10], a[11], a[12], a[13]]);
    const track = { dt: 1 / 60, frames: 2, bodies: 2, p, q, bones: ["pelvis", "head_0"] };
    rig.apply({ ...pose([{ clip: "idle" }]), ragdoll: { track, t: 1 / 60 } }, clipOf);
    expect(near(world(rig.node("pelvis")!))).toEqual(near([a[0] + 20, a[1], 5]));
    expect(near(world(rig.node("head_0")!))).toEqual(near([a[0] + 45.6, a[1], 5]));
    rig.apply({ ...pose([{ clip: "idle" }]), ragdoll: { track, t: 1 / 120 } }, clipOf);  // à mi-chemin
    expect(world(rig.node("pelvis")!).x).toBeCloseTo(a[0] + 10, 3);
    rig.apply(pose([{ clip: "idle" }]), clipOf);  // revenu avant la mort (retour arrière) : la pose du clip, sans reste
    expect(near(world(rig.node("pelvis")!))).toEqual(near([a[0], a[1], a[2]]));
    expect(near(world(rig.node("head_0")!))).toEqual(near([a[7], a[8], a[9]]));
  });
});
