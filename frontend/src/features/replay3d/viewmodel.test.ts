import { afterEach, describe, expect, it, vi } from "vitest";
import { ACESFilmicToneMapping, AnimationClip, Bone, BufferGeometry, type DirectionalLight, Float32BufferAttribute, Group,
  type HemisphereLight, type Material, Mesh, MeshStandardMaterial, NoToneMapping, type Object3D, PerspectiveCamera,
  Quaternion, QuaternionKeyframeTrack, Skeleton, SkinnedMesh, Texture, type ToneMapping, Uint16BufferAttribute, Vector3,
  VectorKeyframeTrack, type WebGLRenderer } from "three";
import type { Replay } from "../replay/engine/replay";
import type { PlayerState } from "../replay/engine/state";
import { disposeTree } from "./dispose";
import { parseGlbAnimated } from "./loader";
import { armsGlb, SRC_Q, WPN_IDLE, weaponGlb } from "./testGlb";
import { sceneLights } from "./viewer";
import { bobWave, horizontalSpeed, INCH, SEEK_S, VM_ENV, VM_ENV_WEAPON, VM_KEEP, VM_LIGHTING, type VmFile, type VmLoad,
  vmFov, type VmLighting, vmLighting, VmMotion, vmOffset, vmPlacement, vmPreloadKeys, type VmView, vmView, ViewModel } from "./viewmodel";
import type { VmClip, VmPose, VmRecoil } from "./viewmodelAnim";

// pas de WebGL : faux PMREMGenerator (reflets de mapEnv), qui note les cibles de rendu rendues et leur libération
const pmrem = vi.hoisted(() => ({ targets: [] as { texture: Texture; freed: number; dispose(): void }[] }));
vi.mock("three", async (importOriginal) => {
  const three = await importOriginal<typeof import("three")>();
  return {
    ...three,
    PMREMGenerator: class {
      fromScene() {
        const t = { texture: new three.Texture(), freed: 0, dispose() { t.freed++; } };
        pmrem.targets.push(t);
        return t;
      }
      dispose() {}
    },
  };
});

afterEach(() => vi.restoreAllMocks());

const read = (b: Uint8Array<ArrayBuffer>) => parseGlbAnimated(b.buffer);
/** Serveur factice : bras des deux camps (glb de test, ou `arms`), et l'arme de test (ou `extra[clé]`) pour les clés données. */
const files = (keys = ["ak47"], extra: Record<string, () => VmFile> = {}, arms?: () => VmFile) => {
  const asked: string[] = [];
  const load: VmLoad = async (name) => {
    asked.push(name);
    if (name.startsWith("bras-")) return arms ? arms() : read(armsGlb());
    const key = name.replace(/^arme-/, "");
    if (extra[key]) return extra[key]();
    return keys.includes(key) ? read(weaponGlb()) : null;
  };
  return { asked, load };
};
const until = (ok: () => boolean) => vi.waitFor(() => { if (!ok()) throw new Error("pas encore"); });
const world = (o: Object3D) => o.getWorldPosition(new Vector3());
const find = (vm: ViewModel, name: string) => {
  let hit: Object3D | null = null;
  vm.scene.traverse((o) => { if (!hit && ((o.userData.name as string | undefined) ?? o.name) === name) hit = o; });
  return hit as Object3D | null;
};
/** Visible à l'écran : lui et tous ses parents. */
const shown = (o: Object3D) => { for (let p: Object3D | null = o; p; p = p.parent) if (!p.visible) return false; return true; };
const round4 = (v: Vector3) => v.toArray().map((x) => +x.toFixed(4) + 0);
const NO_RECOIL: VmRecoil = { pitch: 0, yaw: 0, roll: 0, back: 0, up: 0 };
const at = (clip: VmClip, t: number) => ({ from: null, to: { clip, t }, w: 1, hideWeaponModel: false });
const pose = (weapon: string, p: Partial<VmPose> = {}): VmPose =>
  ({ weapon, from: null, to: { clip: "idle", t: 0 }, w: 1, hideWeaponModel: false, recoil: NO_RECOIL, ...p });
const view = (p: Partial<VmView> = {}): VmView => ({ steamid: "a", side: "CT", tick: 0, tickrate: 64, yaw: 0, pitch: 0,
  speed: 0, settings: null, inventory: [], view: new Quaternion(), ...p });
const rad = (d: number) => (d * Math.PI) / 180;
const SRC = new Quaternion(...SRC_Q);
// repère des fichiers (regard +Z, droite −X) → caméra des bras (regard −Z, droite +X) : 180° autour de Y
const toCam = (v: number[]) => [-v[0], v[1], -v[2]];
// racine par défaut (viewmodel_offset 2,5 / 0 / −1,5 : x à droite, y en avant, z en haut) dans le repère de la caméra
const ROOT0 = [2.5 * INCH, -1.5 * INCH, 0];

/** Faux rendu : note l'effacement de la profondeur et chaque rendu (scène, caméra, réglages de couleur au moment du rendu). */
function fakeRenderer(vm: ViewModel, compile = true, toneMapping: ToneMapping = NoToneMapping, upload = false) {
  const calls: string[] = [];
  const r = {
    autoClear: true, toneMapping, toneMappingExposure: 1.7, outputColorSpace: "srgb",
    clearDepth: () => calls.push("profondeur"),
    render: (scene: unknown, cam: unknown) =>
      calls.push(`rendu ${scene === vm.scene && cam === vm.camera} ${r.autoClear} ${r.toneMapping} ${r.toneMappingExposure} ${r.outputColorSpace}`),
    compileAsync: compile ? vi.fn(async (_o: Object3D, _c: unknown, _s: unknown) => {}) : undefined,
    initTexture: upload ? vi.fn((_t: Texture) => {}) : undefined,  // envoi d'une texture au GPU
  };
  return { calls, r, gl: r as unknown as WebGLRenderer };
}

// Bras et armes construits à la main (sans glb) : mains, peau, armes à deux mains — même forme que les fichiers exportés
// (vérifiée sur les vrais exports des Dual Berettas et de la molotov : wpn reste à l'origine, les os weapon_hand_r / _l
// des clips tombent pile sur les mains hand_R / hand_L).
const HAND_R = [-0.136, -0.16, 0.304], HAND_L = [0.146, -0.152, 0.292];
const bone = (name: string, pos: number[] = [0, 0, 0], ...kids: Object3D[]) => {
  const b = new Bone();
  b.name = name;
  b.position.fromArray(pos);
  if (kids.length) b.add(...kids);
  return b;
};
const skinned = (name: string, bones: Bone[]) => {
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute([0, 0, 0.3, 0.05, 0, 0.3, 0, 0.05, 0.3], 3));
  g.setAttribute("skinIndex", new Uint16BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 4));
  g.setAttribute("skinWeight", new Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  const m = new SkinnedMesh(g, new MeshStandardMaterial());
  m.name = name;
  m.bind(new Skeleton(bones));
  return m;
};
/** Bras avec mains et maillage à peau (os racine, wpn, hand_R, hand_L). */
function handArms(): VmFile {
  const wpn = bone("wpn"), hr = bone("hand_R", HAND_R), hl = bone("hand_L", HAND_L), rm = bone("root_motion", [0, 0, 0], wpn, hr, hl);
  const root = new Group();
  root.name = "bras";
  root.add(rm, skinned("gants", [rm, wpn, hr, hl]));
  return { scene: root, clips: [] };
}
/** Nœud du squelette des clips renommé par GLTFLoader (« weapon_1 »), son nom d'origine dans userData. */
const copy = (name: string, ...kids: Object3D[]) => { const b = bone(`${name}_1`, [0, 0, 0], ...kids); b.userData.name = name; return b; };
const v3 = (name: string, ...frames: number[][]) => new VectorKeyframeTrack(name, frames.map((_, k) => k), frames.flat());
const q4 = (name: string, ...frames: Quaternion[]) => new QuaternionKeyframeTrack(name, frames.map((_, k) => k), frames.flatMap((q) => q.toArray()));
const QX90 = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2);
/** Arme à deux mains, comme les Dual Berettas (`weapon_l` / `weapon_r` sous `weapon_hand_l` / `weapon_hand_r`) ou la
 *  molotov (`lighter` / `molotov`) : clips idle (mains au repos) et draw (main droite tournée de 90° autour de X). */
function twoHands(left: string, right: string): VmFile {
  const hl = bone("weapon_hand_l", [0, 0.508, 0.0051], bone(left, [0.05, 0, 0.067]));
  const hr = bone("weapon_hand_r", [0, 0, 0], bone(right, [0.05, 0, 0.072]));
  const weapon = bone("weapon", [0, 0.0036, 0.0348], hl, hr);
  weapon.quaternion.copy(SRC);
  const arme = new Group();
  arme.name = "sl_arme";
  arme.add(weapon, skinned("corps", [weapon, hl, hr]));
  const clips = new Group();
  clips.name = "sl_clips";
  clips.add(bone("root_motion", [0, 0, 0], bone("wpn"), bone("hand_R"), bone("hand_L")), copy("weapon", copy("weapon_hand_l"), copy("weapon_hand_r")));
  const scene = new Group();
  scene.add(arme, clips);
  const I = new Quaternion();
  const still = [v3("wpn.position", [0, 0, 0]), q4("wpn.quaternion", I), v3("weapon_1.position", [0, 0, 0]), q4("weapon_1.quaternion", SRC),
    v3("hand_L.position", HAND_L), v3("weapon_hand_l_1.position", HAND_L)];
  const idle = new AnimationClip("idle", 0, [...still, v3("hand_R.position", HAND_R), v3("weapon_hand_r_1.position", HAND_R),
    q4("hand_R.quaternion", I), q4("weapon_hand_r_1.quaternion", I)]);
  const draw = new AnimationClip("draw", 1, [...still, v3("hand_R.position", HAND_R, HAND_R), v3("weapon_hand_r_1.position", HAND_R, HAND_R),
    q4("hand_R.quaternion", I, QX90), q4("weapon_hand_r_1.quaternion", I, QX90)]);
  const thr = new AnimationClip("throw", 1, [...still, v3("hand_R.position", HAND_R, [-0.1, 0.1, 0.5]),
    v3("weapon_hand_r_1.position", HAND_R, [-0.1, 0.1, 0.5])]);
  return { scene, clips: [idle, draw, thr] };
}

describe("bras et arme de la vue du joueur : chargement, montage, pose", () => {
  it("bras du camp et arme chargés à la demande ; l'arme suit l'os wpn (clip de repos), sous la racine du placement", async () => {
    const { asked, load } = files(), changed = vi.fn();
    const vm = new ViewModel(load, changed, () => null);
    vm.setSide("CT");
    vm.setWeapon("ak47");
    expect(vm.ready()).toBe(false);
    await until(() => vm.ready());
    expect(asked.sort()).toEqual(["arme-ak47", "bras-ct"]);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(vm.pose(at("idle", 0))).toBe(true);
    vm.scene.updateMatrixWorld(true);
    const wpn = find(vm, "wpn")!, gun = find(vm, "corps")!.parent!;  // os racine « weapon » du modèle
    expect(round4(world(wpn))).toEqual(toCam(WPN_IDLE).map((v, k) => +(v + ROOT0[k]).toFixed(4) + 0));
    expect(world(gun).distanceTo(world(wpn))).toBeLessThan(1e-6);  // décalage de référence remplacé par la piste
    const q = gun.getWorldQuaternion(new Quaternion());
    expect(q.angleTo(wpn.getWorldQuaternion(new Quaternion()))).toBeLessThan(1e-6);  // conversion d'axes annulée
  });

  it("pose : interpolation des pistes, instant borné à la durée ; durée par clip (utilisable telle quelle comme VmDur)", async () => {
    const { load } = files();
    const vm = new ViewModel(load, () => {}, () => null);
    vm.setSide("T");
    vm.setWeapon("ak47");
    await until(() => vm.ready());
    const z = () => find(vm, "wpn")!.position.z;
    vm.pose(at("shoot", 0.25));
    expect(z()).toBeCloseTo(WPN_IDLE[2] - 0.035, 6);
    vm.pose(at("shoot", 9));
    expect(z()).toBeCloseTo(WPN_IDLE[2] - 0.07, 6);
    vm.pose(at("shoot", -1));
    expect(z()).toBeCloseTo(WPN_IDLE[2], 6);
    const dur = vm.duration;  // détachée : passée telle quelle à viewmodelPose
    expect(dur("ak47", "shoot")).toBe(0.5);
    expect(dur("ak47", "draw")).toBe(1);
    expect(dur("ak47", "reload")).toBeNull();
    expect(vm.pose(at("reload", 0))).toBe(false);
    expect(dur("awp", "idle")).toBeNull();
  });

  it("mélange de deux clips (poids de 3B.7) : positions interpolées, from × (1 − w) + to × w ; même clip à deux instants", async () => {
    const { load } = files();
    const vm = new ViewModel(load, () => {}, () => null);
    vm.setSide("CT");
    vm.setWeapon("ak47");
    await until(() => vm.ready());
    const wpn = find(vm, "wpn")!;
    // de « shoot » à 0,5 s (z − 0,07) vers « draw » à 0 (y − 0,3), poids 0,25
    vm.pose({ from: { clip: "shoot", t: 0.5 }, to: { clip: "draw", t: 0 }, w: 0.25, hideWeaponModel: false });
    expect(wpn.position.y).toBeCloseTo(WPN_IDLE[1] - 0.3 * 0.25, 6);
    expect(wpn.position.z).toBeCloseTo(WPN_IDLE[2] - 0.07 * 0.75, 6);
    // le même clip à deux instants (les interpolants partagent leur tampon : le mélange ne doit pas s'y perdre)
    vm.pose({ from: { clip: "shoot", t: 0 }, to: { clip: "shoot", t: 0.5 }, w: 0.5, hideWeaponModel: false });
    expect(wpn.position.z).toBeCloseTo(WPN_IDLE[2] - 0.035, 6);
    vm.pose({ from: { clip: "shoot", t: 0.5 }, to: { clip: "draw", t: 0 }, w: 0, hideWeaponModel: false });
    expect(wpn.position.toArray().map((v) => +v.toFixed(6))).toEqual([WPN_IDLE[0], WPN_IDLE[1], +(WPN_IDLE[2] - 0.07).toFixed(6)]);
    // `from` dont le clip manque : `to` seul
    vm.pose({ from: { clip: "reload", t: 0 }, to: { clip: "draw", t: 0 }, w: 0.5, hideWeaponModel: false });
    expect(wpn.position.y).toBeCloseTo(WPN_IDLE[1] - 0.3, 6);
  });

  it("mélange des rotations par slerp, os par os", async () => {
    const { load } = files([], { elite: () => twoHands("weapon_l", "weapon_r") }, handArms);
    const vm = new ViewModel(load, () => {}, () => null);
    vm.setSide("CT");
    vm.setWeapon("elite");
    await until(() => vm.ready());
    vm.pose({ from: { clip: "idle", t: 0 }, to: { clip: "draw", t: 1 }, w: 0.25, hideWeaponModel: false });
    const hand = find(vm, "hand_R")!;
    expect(hand.quaternion.angleTo(new Quaternion())).toBeCloseTo(Math.PI / 8, 6);  // 25 % de 90°
    expect(find(vm, "weapon_hand_r")!.quaternion.angleTo(new Quaternion())).toBeCloseTo(Math.PI / 8, 6);
  });

  it("changement de camp : l'arme passe sous les bras de l'autre camp, ses clips animent leurs os", async () => {
    const { asked, load } = files();
    const vm = new ViewModel(load, () => {}, () => null);
    vm.setSide("CT");
    vm.setWeapon("ak47");
    await until(() => vm.ready());
    vm.setSide("T");
    expect(vm.ready()).toBe(false);
    await until(() => vm.ready());
    expect(asked).toContain("bras-t");
    let arms = 0;
    vm.scene.traverse((o) => { if (o.name === "bras") arms++; });
    expect(arms).toBe(1);  // seuls les bras T sont dans la scène
    vm.pose(at("draw", 0));
    expect(find(vm, "wpn")!.position.y).toBeCloseTo(WPN_IDLE[1] - 0.3, 6);
    expect(find(vm, "corps")!.parent!.parent!.parent!.parent).toBe(find(vm, "wpn"));  // corps < weapon < sl_arme < support < wpn
  });

  it("arme sans fichier ou en échec : pas prête, sans erreur ; l'échec est signalé (onError) pour relire la liste", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = Object.assign(new Error("erreur 404"), { status: 404 });
    const load: VmLoad = async (name) => {
      if (name === "arme-awp") throw err;
      if (name === "arme-scout") throw Object.assign(new Error("annulé"), { name: "AbortError" });
      return name.startsWith("bras-") ? read(armsGlb()) : null;
    };
    const changed = vi.fn(), vm = new ViewModel(load, changed, () => null), failed = vi.fn();
    vm.onError = failed;
    vm.setSide("CT");
    vm.setWeapon("awp");
    await until(() => changed.mock.calls.length === 2);
    expect(vm.ready()).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    expect(failed).toHaveBeenCalledWith("arme-awp", err);
    vm.setWeapon("deagle");
    await until(() => changed.mock.calls.length === 3);
    expect(vm.ready()).toBe(false);
    vm.setWeapon("scout");  // annulation : ni avertissement ni signalement
    await until(() => changed.mock.calls.length === 4);
    expect(warn).toHaveBeenCalledOnce();
    expect(failed).toHaveBeenCalledOnce();
  });

  it("échec transitoire (réseau, 5xx) : pas mémorisé ; nouvelle demande au plus toutes les 10 s, onError une fois par échec ; puis les bras s'affichent", async () => {
    // heure pilotée à la main (une fausse horloge avancerait pendant vi.waitFor)
    const clock = { now: 1_000_000 };
    vi.spyOn(Date, "now").mockImplementation(() => clock.now);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let down = true;
    const asked: string[] = [];
    const load: VmLoad = async (name) => {
      asked.push(name);
      if (name === "arme-ak47" && down) throw new Error("erreur 503");
      return name.startsWith("bras-") ? read(armsGlb()) : read(weaponGlb());
    };
    const changed = vi.fn(), vm = new ViewModel(load, changed, () => null), failed = vi.fn();
    vm.onError = failed;
    const frame = () => vm.update(pose("ak47"), view());
    const tries = () => asked.filter((n) => n === "arme-ak47").length;
    frame();
    await until(() => changed.mock.calls.length === 2);  // bras arrivés, arme en échec
    expect([tries(), failed.mock.calls.length, vm.ready()]).toEqual([1, 1, false]);
    clock.now = 1_000_000 + 9_999;
    for (let k = 0; k < 5; k++) frame();  // images suivantes, dans le délai : pas de nouvelle demande
    vm.setWeapon(null);
    vm.setWeapon("ak47");  // redemandée dans le délai : non plus
    expect(tries()).toBe(1);
    clock.now = 1_000_000 + 10_000;
    frame();
    frame();
    expect(tries()).toBe(2);  // une seule nouvelle demande
    await until(() => failed.mock.calls.length === 2);  // encore en échec : signalé une fois de plus
    frame();
    expect(tries()).toBe(2);  // délai compté depuis ce 2e échec
    down = false;
    clock.now = 1_000_000 + 20_000;
    frame();
    expect(tries()).toBe(3);
    await until(() => vm.ready());
    expect(frame()).toBe(true);  // les bras s'affichent
    expect(failed).toHaveBeenCalledTimes(2);
    expect(asked.filter((n) => n === "bras-ct")).toHaveLength(1);  // les bras, arrivés, ne sont jamais redemandés
  });

  it("préparation qui lève une exception (nom d'origine illisible…) : comme un échec — fichier libéré, signalé une fois, nouvel essai après 10 s seulement", async () => {
    const clock = { now: 1_000_000 };
    vi.spyOn(Date, "now").mockImplementation(() => clock.now);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const asked: string[] = [], freed = vi.fn();
    const load: VmLoad = async (name) => {
      asked.push(name);
      if (name.startsWith("bras-")) return read(armsGlb());
      const f = await read(weaponGlb());
      f.scene.getObjectByName("sl_arme")!.userData.name = 42;  // pas une chaîne : sanitizeNodeName lève une TypeError
      f.scene.traverse((o) => (o as Mesh).geometry?.addEventListener("dispose", freed));
      return f;
    };
    const changed = vi.fn(), vm = new ViewModel(load, changed, () => null), failed = vi.fn();
    vm.onError = failed;
    const frame = () => vm.update(pose("ak47"), view());
    const tries = () => asked.filter((n) => n === "arme-ak47").length;
    frame();
    await until(() => failed.mock.calls.length === 1);
    expect(failed.mock.calls[0][0]).toBe("arme-ak47");
    expect((failed.mock.calls[0][1] as Error).name).toBe("TypeError");
    expect(freed).toHaveBeenCalled();
    await until(() => changed.mock.calls.length === 2);  // bras arrivés, arme en échec
    for (let k = 0; k < 5; k++) frame();  // images suivantes, dans le délai : pas de nouvelle demande
    expect([tries(), vm.ready()]).toEqual([1, false]);
    clock.now += 10_000;
    frame();
    expect(tries()).toBe(2);
    await until(() => failed.mock.calls.length === 2);
  });

  it("mémoire : au-delà de VM_KEEP armes la plus ancienne est libérée ; dispose libère tout et annule les chargements", async () => {
    const keys = Array.from({ length: VM_KEEP + 1 }, (_, k) => `arme${k}`);
    const { load } = files(keys), vm = new ViewModel(load, () => {}, () => null);
    vm.setSide("CT");
    const freed = vi.spyOn(BufferGeometry.prototype, "dispose");
    for (const k of keys) {
      vm.setWeapon(k);
      await until(() => vm.ready());
    }
    expect(freed).toHaveBeenCalledTimes(1);  // le triangle de la première arme
    expect(vm.duration("arme0", "idle")).toBeNull();
    expect(vm.duration(keys[VM_KEEP], "idle")).toBe(0);
    let signal: AbortSignal | null = null;
    const asked = vi.fn((_n: string, s: AbortSignal) => { signal = s; return new Promise<null>(() => {}); });
    const slow = new ViewModel(asked, () => {}, () => null);
    slow.setSide("CT");
    slow.dispose();
    expect(signal!.aborted).toBe(true);
    slow.setSide("T");  // après dispose : plus rien n'est demandé
    expect(asked).toHaveBeenCalledOnce();
    vm.dispose();
    expect(freed).toHaveBeenCalledTimes(1 + VM_KEEP + 1);  // les armes restantes et les bras, chacun une seule fois
  });

  it("maillages des bras et de l'arme jamais écartés hors du cadre (frustumCulled = false : la boîte de la pose de liaison ment)", async () => {
    const { load } = files([], { elite: () => twoHands("weapon_l", "weapon_r") }, handArms);
    const vm = new ViewModel(load, () => {}, () => null);
    vm.setSide("CT");
    vm.setWeapon("elite");
    await until(() => vm.ready());
    const meshes: Mesh[] = [];
    vm.scene.traverse((o) => { if ((o as Mesh).isMesh) meshes.push(o as Mesh); });
    expect(meshes.map((m) => [m.name, (m as SkinnedMesh).isSkinnedMesh, m.frustumCulled]).sort()).toEqual([
      ["corps", true, false], ["gants", true, false]]);
  });

  it("disposeTree libère aussi les squelettes des maillages à peau (texture des os) ; à dispose, bras et arme compris", async () => {
    const arms = handArms(), mesh = arms.scene.getObjectByName("gants") as SkinnedMesh;
    mesh.skeleton.computeBoneTexture();
    const bones = vi.spyOn(mesh.skeleton.boneTexture!, "dispose");
    disposeTree(arms.scene);
    expect(bones).toHaveBeenCalledOnce();
    expect(mesh.skeleton.boneTexture).toBeNull();

    const freed = vi.spyOn(Skeleton.prototype, "dispose");
    const { load } = files([], { elite: () => twoHands("weapon_l", "weapon_r") }, handArms);
    const vm = new ViewModel(load, () => {}, () => null);
    vm.setSide("CT");
    vm.setWeapon("elite");
    await until(() => vm.ready());
    vm.dispose();
    expect(freed).toHaveBeenCalledTimes(2);  // gants (bras) et corps (arme)
  });
});

describe("armes à deux mains et grenades", () => {
  it("Dual Berettas : chaque pistolet suit sa main (os weapon_hand_l / weapon_hand_r posés par les pistes), en position et en rotation", async () => {
    const { load } = files([], { elite: () => twoHands("weapon_l", "weapon_r") }, handArms);
    const vm = new ViewModel(load, () => {}, () => null);
    vm.setSide("T");
    vm.setWeapon("elite");
    await until(() => vm.ready());
    for (const p of [at("idle", 0), at("draw", 1), { from: { clip: "idle" as const, t: 0 }, to: { clip: "draw" as const, t: 0.5 }, w: 0.5, hideWeaponModel: false }]) {
      vm.pose(p);
      vm.scene.updateMatrixWorld(true);
      for (const [gun, hand] of [["weapon_hand_r", "hand_R"], ["weapon_hand_l", "hand_L"]]) {
        const g = find(vm, gun)!, h = find(vm, hand)!;
        expect(world(g).distanceTo(world(h))).toBeLessThan(1e-6);
        expect(g.getWorldQuaternion(new Quaternion()).angleTo(h.getWorldQuaternion(new Quaternion()))).toBeLessThan(1e-6);
      }
      expect(shown(find(vm, "weapon_l")!) && shown(find(vm, "weapon_r")!)).toBe(true);
    }
    // le pistolet gauche n'est pas l'os homonyme du squelette des clips : c'est celui du modèle, sous wpn
    expect(find(vm, "weapon_hand_l")!.parent!.parent!.name).toBe("sl_arme");
  });

  it("molotov : bouteille en main droite, briquet en main gauche ; modèle caché au lancer (bras visibles), remontré ensuite", async () => {
    const { load } = files([], { molotov: () => twoHands("lighter", "molotov") }, handArms);
    const vm = new ViewModel(load, () => {}, () => null), { r, gl } = fakeRenderer(vm);
    vm.setSide("CT");
    vm.setWeapon("molotov");
    await until(() => vm.ready());
    vm.pose(at("idle", 0));
    vm.scene.updateMatrixWorld(true);
    expect(world(find(vm, "weapon_hand_r")!).distanceTo(world(find(vm, "hand_R")!))).toBeLessThan(1e-6);
    expect(world(find(vm, "weapon_hand_l")!).distanceTo(world(find(vm, "hand_L")!))).toBeLessThan(1e-6);
    expect(shown(find(vm, "molotov")!)).toBe(true);
    vm.pose({ from: null, to: { clip: "throw", t: 0.2 }, w: 1, hideWeaponModel: true });
    expect(shown(find(vm, "molotov")!)).toBe(false);
    expect(shown(find(vm, "lighter")!)).toBe(false);
    expect(shown(find(vm, "gants")!)).toBe(true);
    expect(vm.render(gl)).toBe(true);  // les bras restent dessinés
    expect(r.autoClear).toBe(true);
    vm.pose(at("idle", 0));
    expect(shown(find(vm, "molotov")!)).toBe(true);
  });

  it("changement d'arme : les os des bras reprennent leur pose de repos (une piste absente de la nouvelle arme ne garde pas l'ancienne)", async () => {
    const { load } = files(["ak47"], { elite: () => twoHands("weapon_l", "weapon_r") }, handArms);
    const vm = new ViewModel(load, () => {}, () => null);
    vm.setSide("CT");
    vm.setWeapon("elite");
    await until(() => vm.ready());
    vm.pose(at("draw", 1));
    expect(find(vm, "hand_R")!.quaternion.angleTo(new Quaternion())).toBeCloseTo(Math.PI / 2, 6);
    vm.setWeapon("ak47");  // ses clips n'ont pas de piste pour hand_R
    await until(() => vm.ready());
    vm.pose(at("idle", 0));
    expect(find(vm, "hand_R")!.quaternion.angleTo(new Quaternion())).toBeLessThan(1e-9);
    expect(find(vm, "hand_R")!.position.toArray()).toEqual(HAND_R);
  });
});

describe("caméra, FOV et décalages du joueur", () => {
  it("FOV : viewmodel_fov du joueur borné 60–68 (défaut 68), règle 4:3 → 68 donne 53,67° vertical", () => {
    const v43 = (f: number) => (2 * Math.atan(0.75 * Math.tan(rad(f) / 2)) * 180) / Math.PI;
    expect(vmFov(null)).toBeCloseTo(53.668, 3);
    expect(vmFov({ fov: 68, x: 0, y: 0, z: 0 })).toBeCloseTo(53.668, 3);
    expect(vmFov({ fov: 60, x: 0, y: 0, z: 0 })).toBeCloseTo(v43(60), 9);
    expect(vmFov({ fov: 64, x: 0, y: 0, z: 0 })).toBeCloseTo(v43(64), 9);
    expect(vmFov({ fov: 90, x: 0, y: 0, z: 0 })).toBeCloseTo(53.668, 3);  // borné à 68
    expect(vmFov({ fov: 40, x: 0, y: 0, z: 0 })).toBeCloseTo(v43(60), 9);  // borné à 60
    expect(vmFov({ fov: Number.NaN, x: 0, y: 0, z: 0 })).toBeCloseTo(53.668, 3);
  });

  it("décalages : valeurs du joueur bornées (x −2…2,5, y −2…2, z −2…2), défaut 2,5 / 0 / −1,5", () => {
    expect(vmOffset(null)).toEqual([2.5, 0, -1.5]);
    expect(vmOffset({ fov: 68, x: 2.5, y: 2, z: -2 })).toEqual([2.5, 2, -2]);
    expect(vmOffset({ fov: 68, x: 3, y: -5, z: 2.5 })).toEqual([2.5, -2, 2]);
    expect(vmOffset({ fov: 68, x: -3, y: 9, z: -9 })).toEqual([-2, 2, -2]);
    expect(vmOffset({ fov: 68, x: Number.NaN, y: 1, z: Number.POSITIVE_INFINITY })).toEqual([2.5, 1, -1.5]);
  });

  it("caméra : œil à l'origine, regard −Z (repère de la caméra des bras), FOV 53,67° sans correction d'aspect ; racine aux décalages par défaut", () => {
    const vm = new ViewModel(async () => null, () => {}, () => null);
    vm.resize(16 / 9);
    expect(vm.camera.fov).toBeCloseTo(53.668, 3);
    expect(vm.camera.aspect).toBeCloseTo(16 / 9);
    vm.resize(4 / 3);
    expect(vm.camera.fov).toBeCloseTo(53.668, 3);  // l'aspect ne change pas le FOV vertical
    expect([vm.camera.near, vm.camera.far]).toEqual([0.01, 10]);
    expect(vm.camera.getWorldDirection(new Vector3()).toArray().map((v) => Math.round(v) + 0)).toEqual([0, 0, -1]);
    const root = vm.scene.getObjectByName("vm_racine")!;
    expect(root.parent).toBe(vm.scene);
    expect(round4(root.position)).toEqual(ROOT0.map((v) => +v.toFixed(4) + 0));
    // racine → sway → axes (180° autour de Y : repère des fichiers vers celui de la caméra) → bras
    const sway = root.children[0], axes = sway.children[0];
    expect([sway.name, axes.name]).toEqual(["vm_sway", "vm_axes"]);
    expect(axes.quaternion.angleTo(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI))).toBeLessThan(1e-9);
  });

  it("update : FOV et décalages du joueur appliqués (phzy : 68, 2,5 / 2 / −2), recul sur la racine et le sway", async () => {
    const { load } = files();
    const vm = new ViewModel(load, () => {}, () => null);
    const p = pose("ak47", { recoil: { pitch: -1.42, yaw: 0.3, roll: -0.05, back: 0.53, up: 0.2 } });
    const v = view({ settings: { fov: 60, x: 2.5, y: 2, z: -2 } });
    expect(vm.update(p, v)).toBe(false);  // fichiers en route : rien à dessiner
    await until(() => vm.ready());
    expect(vm.update(p, v)).toBe(true);
    expect(vm.camera.fov).toBeCloseTo((2 * Math.atan(0.75 * Math.tan(rad(30))) * 180) / Math.PI, 9);
    const root = vm.scene.getObjectByName("vm_racine")!, sway = vm.scene.getObjectByName("vm_sway")!;
    expect(round4(root.position)).toEqual([2.5, -2 - 0.2, -2 - 0.53].map((x) => +(x * INCH).toFixed(4) + 0));
    expect(sway.rotation.x).toBeCloseTo(rad(-1.42), 9);
    expect(sway.rotation.y).toBeCloseTo(rad(0.3), 9);
    expect(sway.rotation.z).toBeCloseTo(rad(-0.05), 9);
    expect(vm.update(pose("ak47", { to: { clip: "reload", t: 0 } }), v)).toBe(false);  // clip absent
  });

  it("placement : chaîne des bras (racine x = off_x + 0,5 L ; y = off_z + 0,1 C − D − montée ; z = −off_y − 0,1 C − recul), mesure du tick 16374", () => {
    const still = { swayX: 0, swayY: 0, C: 0, L: 0, D: 0 };
    const p0 = vmPlacement([2.5, 0, -1.5], still, NO_RECOIL);
    expect(p0.root.map((v) => +(v / INCH).toFixed(9) + 0)).toEqual([2.5, -1.5, 0]);
    expect(p0.rot.map((v) => v + 0)).toEqual([0, 0, 0]);
    // NertZ, 5e coup de la rafale : racine relevée (2,437 ; −2,070 ; −0,520) pouces
    const m = { swayX: 0.001, swayY: -0.002, C: -0.1, L: -0.126, D: 0.36 };
    const p = vmPlacement([2.5, 0, -1.5], m, { pitch: -1.42, yaw: 0.2, roll: 0.04, back: 0.53, up: 0.2 });
    expect(p.root.map((v) => +(v / INCH).toFixed(3))).toEqual([2.437, -2.07, -0.52]);
    expect(p.rot[0]).toBeCloseTo(0.001 + rad(0.4 * -0.1 - 1.42), 12);
    expect(p.rot[1]).toBeCloseTo(-0.002 + rad(-0.3 * -0.126 + 0.2), 12);
    expect(p.rot[2]).toBeCloseTo(rad(-0.5 * -0.1 + 0.04), 12);
  });
});

describe("sway et bob (état de rendu, remis à zéro sur un saut)", () => {
  const input = (tick: number, p: { yaw?: number; pitch?: number; speed?: number; steamid?: string } = {}) =>
    ({ steamid: "a", tick, tickrate: 64, yaw: 0, pitch: 0, speed: 0, ...p });

  it("sway : vitesse angulaire (angles du jeu) × −0,00035 rad, filtré par 1 − exp(−10 dt) ; signes vérifiés sur une démo", () => {
    const m = new VmMotion();
    expect(m.step(input(0))).toEqual({ swayX: 0, swayY: 0, C: 0, L: 0, D: 0 });
    const a = 1 - Math.exp(-10);
    let s = m.step(input(64, { yaw: 10 }));  // 10°/s vers la gauche pendant 1 s : rotation y négative (l'arme traîne)
    expect(s.swayY).toBeCloseTo(-0.0035 * a, 12);
    expect(s.swayX).toBe(0);
    // regard qui monte de 20°/s (tangage du jeu : positif vers le bas) : rotation x POSITIVE, comme relevé (01/11/2026,
    // NertZ au tick 13829 : regard qui monte de 73° à 20°, sway x = +0,0261 rad relevé, −0,0305 avant ce correctif)
    s = m.step(input(128, { yaw: 10, pitch: -20 }));
    expect(s.swayX).toBeCloseTo(0.007 * a, 12);
    expect(s.swayY).toBeCloseTo(-0.0035 * a * (1 - a), 12);  // plus de rotation horizontale : retour vers 0
    s = m.step(input(128, { yaw: 10, pitch: -20 }));  // pause : rien ne bouge
    expect(s.swayX).toBeCloseTo(0.007 * a, 12);
  });

  it("sway borné ±0,045 rad (lacet) et ±0,04 rad (tangage) ; lacet par le plus court chemin (179° → −179° : +2°)", () => {
    const m = new VmMotion(), a = 1 - Math.exp(-10 / 64);
    m.step(input(0, { yaw: 179 }));
    let s = m.step(input(1, { yaw: -179 }));  // +2° en un tick : 128°/s
    expect(s.swayY).toBeCloseTo(Math.max(-0.045, -0.00035 * 128) * a, 12);
    s = m.step(input(2, { yaw: -9, pitch: 80 }));  // 170° et 80° (regard qui descend) en un tick : bornés
    expect(s.swayY).toBeCloseTo(-0.045 * a + (Math.max(-0.045, -0.00035 * 128) * a) * (1 - a), 12);
    expect(s.swayX).toBeCloseTo(-0.04 * a, 12);
  });

  it("saut dans le temps (retour arrière, bond de plus de SEEK_S, autre joueur) : sway remis à zéro", () => {
    for (const next of [input(30, { yaw: 50 }), input(64 * (SEEK_S + 0.1) + 40, { yaw: 50 }), input(41, { yaw: 50, steamid: "b" })]) {
      const m = new VmMotion();
      m.step(input(39));
      expect(m.step(input(40, { yaw: 1 })).swayY).not.toBe(0);
      expect(m.step(next).swayY).toBe(0);
    }
    const m = new VmMotion();
    m.step(input(0));
    expect(m.step(input(64 * SEEK_S - 1, { yaw: 1 })).swayY).not.toBe(0);  // en deçà : suivi normal
  });

  it("bob : sinus simple (0,98 s vertical, 1,96 s latéral), amplitude 0,005 v, abaissement 1,05 v / 250", () => {
    expect(bobWave(0.245, 0.98)).toBeCloseTo(1, 12);
    expect(bobWave(0.735, 0.98)).toBeCloseTo(-1, 12);
    expect(bobWave(0.49, 0.98)).toBeCloseTo(0, 12);
    expect(bobWave(0.98 + 0.245, 0.98)).toBeCloseTo(1, 9);
    // un sinus simple partout, pas deux demi-ondes de formes différentes : mesuré le 01/11/2026 (186 images en
    // course, NertZ ticks 50901 à 51060 : écart moyen au sinus 0,0003 en vertical, 0,0001 en latéral)
    for (const ph of [0.1, 0.33, 0.6, 0.9, 1.5, 1.93]) {
      expect(bobWave(ph, 0.98)).toBeCloseTo(Math.sin((2 * Math.PI * ph) / 0.98), 12);
      expect(bobWave(ph, 1.96)).toBeCloseTo(Math.sin((2 * Math.PI * ph) / 1.96), 12);
    }
    const m = new VmMotion();
    let s = m.step(input(0, { speed: 250 }));  // vitesse prise telle quelle au départ (après un saut aussi)
    expect([s.C, s.L, s.D].map((v) => +v.toFixed(9))).toEqual([0.375, 0.375, 1.05]);
    s = m.step(input(0.245 * 64, { speed: 400 }));  // bornée à 250 ; phase += dt · v / 250
    expect(s.C).toBeCloseTo(1.25, 9);
    expect(s.L).toBeCloseTo(1.25 * (0.3 + 0.7 * Math.sin(Math.PI / 4)), 9);
    expect(s.D).toBeCloseTo(1.05, 9);
  });

  it("bob : vitesse lissée par 1 − exp(−8 dt)", () => {
    const m = new VmMotion();
    m.step(input(0, { speed: 0 }));
    const s = m.step(input(6.4, { speed: 250 })), v = 250 * (1 - Math.exp(-0.8));
    expect(s.D).toBeCloseTo((1.05 * v) / 250, 9);
    const phase = (0.1 * v) / 250;
    expect(s.C).toBeCloseTo(0.005 * v * (0.3 + 0.7 * bobWave(phase, 0.98)), 9);
  });

  it("dans le ViewModel : sway et bob s'ajoutent au placement, et un retour arrière remet le sway à zéro", async () => {
    const { load } = files();
    const vm = new ViewModel(load, () => {}, () => null);
    vm.update(pose("ak47"), view({ tick: 0 }));
    await until(() => vm.ready());
    vm.update(pose("ak47"), view({ tick: 6.4, yaw: 5, speed: 200 }));
    const sway = vm.scene.getObjectByName("vm_sway")!, root = vm.scene.getObjectByName("vm_racine")!;
    expect(sway.rotation.y).toBeLessThan(0);
    expect(root.position.y).toBeLessThan(ROOT0[1]);  // abaissement du bob
    vm.update(pose("ak47"), view({ tick: 3.2, yaw: 5, speed: 200 }));  // retour arrière
    expect(sway.rotation.y).toBeCloseTo(rad(-0.3 * (0.005 * 200) * 0.3), 9);  // bob seul, repris à la phase 0 : L = 0,005 × 200 × 0,3
  });
});

describe("lumière de la carte, chaîne de couleur, reflets", () => {
  it("lumière par défaut = celle de la scène du monde (sceneLights) ; ciel et soleil ramenés dans le repère de la caméra", async () => {
    const [hemi, sun] = sceneLights() as [HemisphereLight, DirectionalLight];
    const l = vmLighting(hemi, sun);
    expect(l.sky.getHex()).toBe(VM_LIGHTING.sky.getHex());
    expect(l.ground.getHex()).toBe(VM_LIGHTING.ground.getHex());
    expect([l.hemi, l.sunIntensity, l.sun.getHex()]).toEqual([VM_LIGHTING.hemi, VM_LIGHTING.sunIntensity, VM_LIGHTING.sun.getHex()]);
    expect(l.up.distanceTo(VM_LIGHTING.up)).toBeLessThan(1e-9);
    expect(l.toSun.distanceTo(VM_LIGHTING.toSun)).toBeLessThan(1e-9);
    expect(l.toSun.length()).toBeCloseTo(1, 12);

    const { load } = files(), vm = new ViewModel(load, () => {}, () => null);
    let h: HemisphereLight | null = null, d: DirectionalLight | null = null;
    vm.scene.traverse((o) => { if ((o as HemisphereLight).isHemisphereLight) h = o as HemisphereLight; if ((o as DirectionalLight).isDirectionalLight) d = o as DirectionalLight; });
    expect([h!.color.getHex(), h!.groundColor.getHex(), h!.intensity]).toEqual([hemi.color.getHex(), hemi.groundColor.getHex(), hemi.intensity]);
    expect([d!.color.getHex(), d!.intensity]).toEqual([sun.color.getHex(), sun.intensity]);
    // regard horizontal vers +X (lacet 0) : le ciel (+Z du monde) est en haut de l'image, le soleil (0,4 ; 0,3 ; 1)
    // à gauche (droite de la caméra = −Y du monde), devant
    const cam = new PerspectiveCamera();
    cam.up.set(0, 0, 1);
    cam.lookAt(1, 0, 0);
    vm.update(pose("ak47"), view({ view: cam.quaternion }));
    vm.scene.updateMatrixWorld(true);
    expect(round4(h!.position)).toEqual([0, 1, 0]);
    expect(round4(d!.position)).toEqual(round4(new Vector3(-0.3, 1, -0.4).normalize()));
    // regard 45° vers le bas : le ciel passe derrière et au-dessus
    cam.lookAt(1, 0, -1);
    vm.update(pose("ak47"), view({ view: cam.quaternion }));
    expect(round4(h!.position)).toEqual(round4(new Vector3(0, 1, 1).normalize()));
    expect(round4(new Vector3(0, 1, 0).applyEuler(vm.scene.environmentRotation))).toEqual(round4(new Vector3(0, 1, 1).normalize()));
  });

  it("rendu : 2e passe sans effacer l'image, profondeur effacée avant ; MÊME chaîne de couleur que le monde (rien n'est changé)", async () => {
    const { load } = files(), vm = new ViewModel(load, () => {}, () => null), { calls, r, gl } = fakeRenderer(vm);
    expect(vm.render(gl)).toBe(false);  // rien de chargé : rien dessiné
    expect(calls).toEqual([]);
    vm.setSide("CT");
    vm.setWeapon("ak47");
    await until(() => vm.ready());
    expect(vm.render(gl)).toBe(true);
    // tone mapping, exposition et espace de couleur du rendu du monde, tels quels : la carte n'a pas de tone mapping, les
    // bras non plus (plus d'ACES propre aux bras) ; et si le monde en avait un, les bras auraient le même
    expect(calls).toEqual(["profondeur", `rendu true false ${NoToneMapping} 1.7 srgb`]);
    expect(r.autoClear).toBe(true);
    expect(vm.scene.background).toBeNull();
    const aces = fakeRenderer(vm, true, ACESFilmicToneMapping);
    vm.render(aces.gl);
    expect(aces.calls).toEqual(["profondeur", `rendu true false ${ACESFilmicToneMapping} 1.7 srgb`]);
    expect(vm.render(fakeRenderer(vm, false).gl)).toBe(true);  // rendu sans compileAsync (faux rendus des tests du Viewer) : pas d'erreur
  });

  it("rendu qui lève une exception (contexte perdu…) : autoClear remis quand même", async () => {
    const { load } = files(), vm = new ViewModel(load, () => {}, () => null), { r, gl } = fakeRenderer(vm);
    vm.setSide("CT");
    vm.setWeapon("ak47");
    await until(() => vm.ready());
    r.render = () => { throw new Error("contexte perdu"); };
    expect(() => vm.render(gl)).toThrow("contexte perdu");
    expect(r.autoClear).toBe(true);
  });

  it("reflets de mapEnv : la cible de rendu PMREM (pas seulement sa texture) est libérée au remplacement et à dispose", async () => {
    pmrem.targets.length = 0;
    const { load } = files(), vm = new ViewModel(load, () => {}), { gl } = fakeRenderer(vm);  // reflets par défaut : mapEnv
    vm.setSide("CT");
    vm.setWeapon("ak47");
    await until(() => vm.ready());
    vm.render(gl);
    expect(pmrem.targets).toHaveLength(1);
    const [first] = pmrem.targets, freedTex = vi.spyOn(first.texture, "dispose");
    expect(vm.scene.environment).toBe(first.texture);
    vm.setLighting({ ...VM_LIGHTING, hemi: 0.5 });
    vm.render(gl);
    expect(pmrem.targets).toHaveLength(2);
    expect(vm.scene.environment).toBe(pmrem.targets[1].texture);
    expect([first.freed, pmrem.targets[1].freed]).toEqual([1, 0]);
    expect(freedTex).not.toHaveBeenCalled();  // la cible libère sa texture avec elle
    vm.dispose();
    expect([first.freed, pmrem.targets[1].freed]).toEqual([1, 1]);
  });

  it("reflets faibles d'après la carte : scène 0,2 (bras), armes 0,3 ; l'env n'est libéré qu'une fois, par le ViewModel", async () => {
    const keys = Array.from({ length: VM_KEEP + 1 }, (_, k) => `arme${k}`);
    const env = new Texture(), envFree = vi.spyOn(env, "dispose"), makeEnv = vi.fn(() => env);
    const { load } = files(keys), vm = new ViewModel(load, () => {}, makeEnv), { gl } = fakeRenderer(vm);
    vm.setSide("CT");
    vm.setWeapon(keys[0]);
    await until(() => vm.ready());
    vm.render(gl);
    expect(makeEnv).toHaveBeenCalledOnce();
    expect(makeEnv.mock.calls[0]).toEqual([gl, VM_LIGHTING]);
    expect(vm.scene.environment).toBe(env);
    expect(vm.scene.environmentIntensity).toBe(VM_ENV);
    expect([VM_ENV, VM_ENV_WEAPON]).toEqual([0.2, 0.3]);
    const mats = (name: string) => { const out: Material[] = []; find(vm, name)!.traverse((o) => { const m = (o as Mesh).material; if (m) out.push(...(Array.isArray(m) ? m : [m])); }); return out as MeshStandardMaterial[]; };
    expect(mats("sl_arme").map((m) => [m.envMap === env, m.envMapIntensity])).toEqual([[true, VM_ENV_WEAPON]]);
    expect(mats("gants").map((m) => m.envMap)).toEqual([null]);  // bras : env de la scène (0,2)
    for (const k of keys.slice(1)) {  // une arme libérée (la plus ancienne) : l'env partagé reste
      vm.setWeapon(k);
      await until(() => vm.ready());
    }
    expect(vm.duration(keys[0], "idle")).toBeNull();
    expect(mats("sl_arme")[0].envMap).toBe(env);  // arme arrivée après l'env : reflets posés aussi
    expect(envFree).not.toHaveBeenCalled();
    vm.render(gl);
    expect(makeEnv).toHaveBeenCalledOnce();
    vm.dispose();
    expect(envFree).toHaveBeenCalledOnce();
  });

  it("autre lumière (setLighting) : couleurs et intensités reprises, reflets refaits au rendu suivant, l'ancien libéré", async () => {
    const envs = [new Texture(), new Texture()];
    let made = 0;
    const makeEnv = vi.fn((_r: WebGLRenderer, _l: VmLighting) => envs[made++]);
    const { load } = files(), vm = new ViewModel(load, () => {}, makeEnv), { gl } = fakeRenderer(vm);
    vm.setSide("CT");
    vm.setWeapon("ak47");
    await until(() => vm.ready());
    vm.render(gl);
    const free = vi.spyOn(envs[0], "dispose");
    const l = { ...VM_LIGHTING, sunIntensity: 3, hemi: 0.4 };
    vm.setLighting(l);
    let h: HemisphereLight | null = null, d: DirectionalLight | null = null;
    vm.scene.traverse((o) => { if ((o as HemisphereLight).isHemisphereLight) h = o as HemisphereLight; if ((o as DirectionalLight).isDirectionalLight) d = o as DirectionalLight; });
    expect([h!.intensity, d!.intensity]).toEqual([0.4, 3]);
    vm.render(gl);
    expect(makeEnv).toHaveBeenCalledTimes(2);
    expect(makeEnv.mock.calls[1][1]).toBe(l);
    expect(vm.scene.environment).toBe(envs[1]);
    expect(free).toHaveBeenCalledOnce();
  });
});

describe("préchargement et préchauffage des shaders", () => {
  it("armes de l'inventaire du joueur suivi → clés des fichiers (couteaux par camp, inconnues écartées, sans doublon)", () => {
    expect(vmPreloadKeys(["Glock-18", "AK-47", "Karambit", "Flashbang", "Molotov", "C4 Explosive", "Syringe", "Glock-18"], "T"))
      .toEqual(["glock", "ak47", "knife_t", "flashbang", "molotov", "c4"]);
    expect(vmPreloadKeys(["Knife", "USP-S"], "CT")).toEqual(["knife", "usp_silencer"]);
  });

  it("preload : charge sans monter ni évincer l'arme tenue ; au plus VM_KEEP ; une seule demande par fichier", async () => {
    const { asked, load } = files(["ak47", "glock"]);
    const vm = new ViewModel(load, () => {}, () => null);
    vm.preload(["glock", "ak47"], ["CT"]);
    vm.preload(["glock", "ak47"], ["CT"]);
    await until(() => vm.duration("glock", "idle") === 0 && vm.duration("ak47", "idle") === 0);
    expect(asked.sort()).toEqual(["arme-ak47", "arme-glock", "bras-ct"]);
    expect(vm.ready()).toBe(false);  // rien n'est tenu
    vm.setSide("CT");
    vm.setWeapon("glock");
    expect(vm.ready()).toBe(true);  // déjà là : affiché tout de suite
    const many = Array.from({ length: VM_KEEP + 3 }, (_, k) => `x${k}`);
    vm.preload(many);
    expect(asked.filter((n) => n.startsWith("arme-x"))).toHaveLength(VM_KEEP);
  });

  it("preload qui dépasse VM_KEEP : l'arme tenue n'est jamais libérée, même devenue la plus ancienne", async () => {
    const keys = Array.from({ length: VM_KEEP + 1 }, (_, k) => `arme${k}`);
    const { load } = files(keys), changed = vi.fn(), vm = new ViewModel(load, changed, () => null);
    vm.setSide("CT");
    vm.setWeapon("arme0");
    await until(() => vm.ready());
    vm.preload(keys.slice(1));  // 8 de plus : 9 armes, arme0 (tenue) est la plus ancienne
    await until(() => changed.mock.calls.length === 2 + VM_KEEP);  // bras, arme0 et les 8 préchargées arrivées
    expect(vm.duration("arme0", "idle")).toBe(0);
    expect(keys.slice(1).filter((k) => vm.duration(k, "idle") === 0)).toHaveLength(VM_KEEP - 1);  // une autre libérée
    expect(vm.ready()).toBe(true);
    expect(vm.pose(at("idle", 0))).toBe(true);
  });

  it("update précharge l'inventaire du joueur suivi quand il change (début du round, passage en vue du joueur, autre joueur)", async () => {
    const { asked, load } = files(["ak47", "glock", "flashbang"]);
    const vm = new ViewModel(load, () => {}, () => null);
    vm.update(pose("ak47"), view({ inventory: ["AK-47", "Glock-18"] }));
    expect(asked.sort()).toEqual(["arme-ak47", "arme-glock", "bras-ct"]);
    vm.update(pose("ak47"), view({ inventory: ["AK-47", "Glock-18"] }));
    expect(asked).toHaveLength(3);
    vm.update(pose("ak47"), view({ inventory: ["AK-47", "Glock-18", "Flashbang"] }));  // achat, ramassage
    expect(asked).toContain("arme-flashbang");
    expect(asked).toHaveLength(4);
  });

  it("préchauffage : compileAsync (scène et caméra des bras) des fichiers arrivés ; warm() tout, le rendu un par image", async () => {
    const { load } = files(["ak47", "glock", "deagle"]);
    const vm = new ViewModel(load, () => {}, () => null), { r, gl } = fakeRenderer(vm);
    vm.setSide("CT");
    vm.setWeapon("ak47");
    await until(() => vm.ready());
    await vm.warm(gl);  // appelé seul (passage en vue du joueur) : tout ce qui est arrivé
    const armsRoot = vm.scene.getObjectByName("vm_axes")!.children[0], held = find(vm, "sl_arme");
    const compiled = () => r.compileAsync!.mock.calls.map(([o, c, s]) => [o === armsRoot ? "bras" : o === held ? "tenue" : o.name, c === vm.camera, s === vm.scene]);
    expect(compiled()).toEqual([["bras", true, true], ["tenue", true, true]]);
    vm.render(gl);
    expect(r.compileAsync).toHaveBeenCalledTimes(2);  // rien de nouveau
    vm.preload(["glock", "deagle"]);
    await until(() => vm.duration("glock", "idle") === 0 && vm.duration("deagle", "idle") === 0);
    vm.render(gl);
    expect(compiled().slice(2)).toEqual([["sl_arme", true, true]]);  // une arme préchargée par image…
    vm.render(gl);
    expect(compiled().slice(2)).toEqual([["sl_arme", true, true], ["sl_arme", true, true]]);  // … puis l'autre
    vm.render(gl);
    expect(r.compileAsync).toHaveBeenCalledTimes(4);
    expect(new Set(r.compileAsync!.mock.calls.slice(2).map(([o]) => o)).size).toBe(2);

    // ce qui est dessiné est compilé par le rendu lui-même : pas préchauffé en plus
    const other = new ViewModel(files().load, () => {}, () => null), o = fakeRenderer(other);
    other.setSide("T");
    other.setWeapon("ak47");
    await until(() => other.ready());
    other.render(o.gl);
    expect(o.r.compileAsync).not.toHaveBeenCalled();
    // rien à préchauffer : retour immédiat, sans allocation (même promesse déjà résolue à chaque appel)
    const idle = other.warm(o.gl);
    expect(other.warm(o.gl)).toBe(idle);
    expect(vm.warm(gl)).toBe(idle);
    expect(r.compileAsync).toHaveBeenCalledTimes(4);
  });
});

describe("préchauffage des textures (envoi au GPU avant le premier affichage)", () => {
  /** Textures nommées `<tag>-<k>` : couleur, normale et ORM (partagée par rugosité et métal, comme les exports). */
  const maps = (tag: string) => [0, 1, 2].map((k) => Object.assign(new Texture(), { name: `${tag}-${k}` }));
  const material = (t: Texture[]) => new MeshStandardMaterial({ map: t[0], normalMap: t[1], roughnessMap: t[2], metalnessMap: t[2] });
  /** Arme simple à textures (clip idle sur wpn). */
  const texturedWeapon = (tag: string): VmFile => {
    const body = new Mesh(new BufferGeometry(), material(maps(tag))), arme = new Group(), scene = new Group();
    body.name = "corps";
    arme.name = "sl_arme";
    arme.add(body);
    scene.add(arme);
    return { scene, clips: [new AnimationClip("idle", 0, [v3("wpn.position", [0, 0, 0.4])])] };
  };
  /** Bras à mains dont le gant a ses textures. */
  const texturedArms = (): VmFile => {
    const f = handArms(), gants = f.scene.getObjectByName("gants") as SkinnedMesh;
    gants.material = material(maps("bras"));
    return f;
  };
  const setup = async (upload = true) => {
    const extra = Object.fromEntries(["ak47", "glock", "deagle"].map((k) => [k, () => texturedWeapon(k)]));
    const { load } = files([], extra, texturedArms);
    const vm = new ViewModel(load, () => {}, () => null), fake = fakeRenderer(vm, true, NoToneMapping, upload);
    vm.setSide("CT");
    vm.setWeapon("glock");
    vm.preload(["ak47", "deagle"]);
    await until(() => vm.ready() && vm.duration("ak47", "idle") === 0 && vm.duration("deagle", "idle") === 0);
    const sent = () => fake.r.initTexture?.mock.calls.map(([t]) => t.name) ?? [];
    return { vm, ...fake, sent };
  };

  it("textures des fichiers arrivés envoyées une par image, une seule fois chacune ; jamais celles des bras et de l'arme dessinés", async () => {
    const { vm, gl, sent } = await setup();
    const owner = (n: string) => n.split("-")[0];
    vm.render(gl);
    expect(sent()).toHaveLength(1);  // une par image
    for (let k = 0; k < 5; k++) vm.render(gl);
    expect(sent()).toHaveLength(6);
    expect(new Set(sent()).size).toBe(6);  // chacune une seule fois
    expect(new Set(sent().map(owner))).toEqual(new Set(["ak47", "deagle"]));  // les préchargées, ni « bras » ni « glock »
    for (let k = 0; k < 3; k++) vm.render(gl);
    expect(sent()).toHaveLength(6);  // plus rien à envoyer
    // l'arme suivante, déjà envoyée, ne renvoie rien ; rien à faire : même promesse résolue (sans allocation)
    vm.setWeapon("ak47");
    vm.render(gl);
    expect(sent()).toHaveLength(6);
    expect(vm.warm(gl)).toBe(vm.warm(gl));
    const walk = vi.spyOn(Set.prototype, Symbol.iterator);  // rien à faire : aucune file parcourue (sans allocation)
    vm.render(gl);
    expect(walk).not.toHaveBeenCalled();
  });

  it("les reflets (env de la scène des bras, partagé) ne sont jamais envoyés comme texture d'une arme", async () => {
    const env = Object.assign(new Texture(), { name: "env" });
    const extra = { glock: () => texturedWeapon("glock"), deagle: () => texturedWeapon("deagle") };
    const { load } = files([], extra, texturedArms), vm = new ViewModel(load, () => {}, () => env);
    const { r, gl } = fakeRenderer(vm, true, NoToneMapping, true);
    vm.setSide("CT");
    vm.setWeapon("glock");
    await until(() => vm.ready());
    vm.render(gl);  // reflets créés
    vm.preload(["deagle"]);  // arrivée après : son matériau reçoit les reflets
    await until(() => vm.duration("deagle", "idle") === 0);
    await vm.warm(gl);
    expect(r.initTexture!.mock.calls.map(([t]) => t.name).sort()).toEqual(["deagle-0", "deagle-1", "deagle-2"]);
  });

  it("appelé seul (warm), tout est envoyé d'un coup ; une arme cachée (grenade lancée) n'est pas dessinée : ses textures peuvent partir", async () => {
    const { vm, gl, sent } = await setup();
    vm.pose({ from: null, to: { clip: "idle", t: 0 }, w: 1, hideWeaponModel: true });
    vm.render(gl);
    expect(sent()).toHaveLength(1);
    await vm.warm(gl);
    expect([...sent()].sort()).toEqual(["ak47-0", "ak47-1", "ak47-2", "deagle-0", "deagle-1", "deagle-2", "glock-0", "glock-1", "glock-2"]);
  });

  it("rien n'est envoyé sans initTexture (faux rendus des tests du Viewer), ni après dispose, ni pour une arme libérée", async () => {
    const plain = await setup(false);
    for (let k = 0; k < 3; k++) expect(plain.vm.render(plain.gl)).toBe(true);
    await expect(plain.vm.warm(plain.gl)).resolves.toBeUndefined();
    const later = fakeRenderer(plain.vm, true, NoToneMapping, true);  // rien n'a été retiré de la file pour autant
    await plain.vm.warm(later.gl);
    expect(later.r.initTexture!.mock.calls.map(([t]) => t.name).sort()).toEqual(["ak47-0", "ak47-1", "ak47-2", "deagle-0", "deagle-1", "deagle-2"]);

    const { vm, gl, r, sent } = await setup();
    vm.dispose();
    await vm.warm(gl);
    expect(vm.render(gl)).toBe(false);
    expect(r.initTexture).not.toHaveBeenCalled();
    expect(sent()).toEqual([]);

    // arme évincée (VM_KEEP dépassé) avant l'envoi de ses textures : elles sortent de la file, libérées avec elle
    const keys = Array.from({ length: VM_KEEP }, (_, k) => `x${k}`);
    const extra = Object.fromEntries(["first", ...keys].map((k) => [k, () => texturedWeapon(k)]));
    const many = files([], extra, texturedArms), vm2 = new ViewModel(many.load, () => {}, () => null);
    const f2 = fakeRenderer(vm2, true, NoToneMapping, true);
    vm2.setSide("CT");
    vm2.setWeapon("x0");
    vm2.preload(["first"]);
    await until(() => vm2.duration("first", "idle") === 0);
    vm2.preload(keys.slice(1));  // « first » devient la plus ancienne non tenue : libérée
    await until(() => keys.every((k) => vm2.duration(k, "idle") === 0));
    expect(vm2.duration("first", "idle")).toBeNull();
    await vm2.warm(f2.gl);
    expect(f2.r.initTexture!.mock.calls.map(([t]) => t.name).filter((n) => n.startsWith("first"))).toEqual([]);
  });

  it("images des textures libérées après leur envoi (initTexture), jamais avant ; imagesFreed ; dispose : les autres fermées", async () => {
    // images décodées factices (ImageBitmap absent sous Node), une par texture des fichiers arrivés
    class Bitmap { width = 8; height = 8; closed = 0; close() { this.closed++; } }
    vi.stubGlobal("ImageBitmap", Bitmap);
    const images = new Map<string, Bitmap>();
    const withImages = (f: VmFile) => {
      f.scene.traverse((o) => {
        const m = (o as Mesh).material as MeshStandardMaterial | undefined;
        for (const t of [m?.map, m?.normalMap, m?.roughnessMap]) if (t && !images.has(t.name)) {
          const b = new Bitmap();
          images.set(t.name, b);
          t.image = b;
        }
      });
      return f;
    };
    const extra = { glock: () => withImages(texturedWeapon("glock")), ak47: () => withImages(texturedWeapon("ak47")) };
    const { load } = files([], extra, () => withImages(texturedArms()));
    const vm = new ViewModel(load, () => {}, () => null), { r, gl } = fakeRenderer(vm, true, NoToneMapping, true);
    r.initTexture!.mockImplementation((t: Texture) => t.onUpdate?.(t));  // envoi : `onUpdate` ensuite, comme three
    vm.setSide("CT");
    vm.setWeapon("glock");
    vm.preload(["ak47"]);
    await until(() => vm.ready() && vm.duration("ak47", "idle") === 0);
    const closed = () => [...images].filter(([, b]) => b.closed).map(([n]) => n).sort();
    expect(closed()).toEqual([]);  // arrivées, pas encore envoyées
    expect(vm.imagesFreed()).toBe(false);
    vm.render(gl);  // une préchargée envoyée (bras et Glock : par le rendu même, que ce faux rendu ne fait pas)
    expect(closed()).toHaveLength(1);
    expect(vm.imagesFreed()).toBe(true);
    await vm.warm(gl);
    expect(closed()).toEqual(["ak47-0", "ak47-1", "ak47-2"]);
    vm.dispose();
    expect([...images.values()].map((b) => b.closed)).toEqual(Array(9).fill(1));  // les autres fermées, chacune une fois
  });
});

describe("vue du joueur suivi → entrée de update", () => {
  it("vitesse horizontale d'après les images (unités/s), entre l'image du tick et la suivante", () => {
    const xs = [0, 100, 100], ys = [0, 0, 50];
    const r = { ticks: new Int32Array([0, 32, 64]), n: 3, tickrate: 64, players: [{ steamid: "a", index: 0 }],
      value: (k: string, i: number) => (k === "x" ? xs : ys)[i] } as unknown as Replay;
    expect(horizontalSpeed(r, 0, 10)).toBeCloseTo(200, 9);
    expect(horizontalSpeed(r, 0, 40)).toBeCloseTo(100, 9);
    expect(horizontalSpeed(r, 0, 64)).toBeCloseTo(100, 9);  // dernière image : intervalle d'avant
    const p = { steamid: "a", side: "T", yaw: 12, pitch: -3, viewmodel: { fov: 64, x: 1, y: 0, z: -1 }, inventory: ["AK-47"] } as PlayerState;
    const q = new Quaternion(0, 0, 1, 0);
    expect(vmView(r, 10, p, q)).toEqual({ steamid: "a", side: "T", tick: 10, tickrate: 64, yaw: 12, pitch: -3, speed: horizontalSpeed(r, 0, 10),
      settings: p.viewmodel, inventory: ["AK-47"], view: q });
  });
});
