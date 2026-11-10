import { afterEach, describe, expect, it, vi } from "vitest";
import { Bone, Float32BufferAttribute, type Mesh, MeshStandardMaterial, type Object3D, OrthographicCamera, PerspectiveCamera,
  Quaternion, Skeleton, SkinnedMesh, Texture, Uint16BufferAttribute, Vector3 } from "three";
import type { KillEvent } from "../../shared/api/types";
import type { Replay } from "../replay/engine/replay";
import { F, type PlayerState } from "../replay/engine/state";
import { DROP_AHEAD, DROP_RIGHT } from "./agentAnim";
import { AgentLayer, FAR } from "./agentLayer";
import { AgentRig, WEAPON_SPHERE } from "./agentRig";
import { AgentLibrary, type AgentLoad, MAX_EQUIPPED } from "./agents";
import { parseGlbAnimated } from "./loader";
import { agentGlb, animsGlb, COMMON_CLIPS, mondeGlb } from "./testGlb";
import type { VmFile } from "./viewmodel";

// appels d'agentPose notés (steamid de chacun), la fonction elle-même inchangée
const posed = vi.hoisted(() => [] as string[]);
vi.mock("./agentAnim", async (orig) => {
  const m = await orig<typeof import("./agentAnim")>();
  return { ...m, agentPose: (...a: Parameters<typeof m.agentPose>) => { posed.push(a[2]); return m.agentPose(...a); } };
});
const calls = (sid: string) => posed.filter((x) => x === sid).length;

const FILES: Record<string, () => Uint8Array<ArrayBuffer>> = {
  "agent-ct": agentGlb, "agent-t": agentGlb, "anims-rifle": () => animsGlb(), "anims-pistol": () => animsGlb(),
  "anims-knife": () => animsGlb(), "anims-communes": () => animsGlb(COMMON_CLIPS), "monde-ak47": mondeGlb,
};
const until = (ok: () => boolean) => vi.waitFor(() => { if (!ok()) throw new Error("pas encore"); });
/** Bibliothèque des fichiers de test, tous arrivés ; `edit` retouche un fichier lu (clip, arme…). */
async function library(files = FILES, edit: (name: string, f: VmFile) => void = () => {}) {
  const load: AgentLoad = async (name) => {
    if (!files[name]) return null;
    const f = await parseGlbAnimated(files[name]().buffer);
    edit(name, f);
    return f;
  };
  const lib = new AgentLibrary(load, () => {});
  lib.preload(["CT", "T"], ["rifle", "pistol", "knife", "communes"]);
  if (files["monde-ak47"]) lib.weapon("ak47");
  // 2 modèles et 4 jeux de clips (arrivés ou absents), et l'arme
  await until(() => lib.version === 6 + (files["monde-ak47"] ? 1 : 0));
  return lib;
}
const state = (steamid: string, x: number, o: Partial<PlayerState> = {}): PlayerState => ({
  steamid, name: steamid, side: "CT", slot: 1, x, y: 0, z: 0, yaw: 0, hp: 100, armor: 100, alive: true, helmet: false,
  defuser: false, hasBomb: false, defusing: false, scoped: false, flash: 0, money: 0, weapon: "AK-47", inventory: ["AK-47"],
  equip: 0, pitch: 0, duck: 0, airborne: false, clip: null, reserve: null, zoom: 0, keys: 0, crosshair: null, fov: 0,
  viewmodel: null, ...o });
type At<T> = (i: number, j: number) => T;
/** Replay immobile : a en x = 0 et b en x = 300 (CT tous deux), vivants, regard +X ; `kills` : morts du round ; `o` :
 *  autres positions, inventaires, lacets (degrés). */
function replay(kills: Partial<KillEvent>[] = [], dead: At<boolean> = () => false,
  o: { x?: At<number>; inventory?: At<string[]>; yaw?: At<number>; agents?: (string | null)[] } = {}): Replay {
  const x = o.x ?? ((_i, j) => [0, 300][j]), yaw = o.yaw ?? (() => 0);
  return {
    ticks: Int32Array.from({ length: 400 }, (_, i) => 2 * i), n: 400, m: 2, tickrate: 64,
    players: [{ steamid: "a", name: "a", side: "CT", slot: 1, index: 0 }, { steamid: "b", name: "b", side: "CT", slot: 2, index: 1 }],
    has: () => false,
    value: (k: string, i: number, j: number) => (k === "x" ? x(i, j) : k === "yaw" ? yaw(i, j) : k === "flags" ? (dead(i, j) ? 0 : F.ALIVE) : 0),
    weaponAt: () => "AK-47", inventoryAt: o.inventory ?? (() => ["AK-47"]), agentOf: (j: number) => o.agents?.[j] ?? null,
    payload: { kills, damages: [], bomb: [] },
  } as unknown as Replay;
}
/** Caméra à `dist` unités derrière les joueurs (x = −dist), regard +X ; `away` : regard −X, les joueurs dans le dos. */
function camera(away = false, dist = 400, fov = 70) {
  const cam = new PerspectiveCamera(fov, 1, 1, 40000);
  cam.up.set(0, 0, 1);
  cam.position.set(-dist, 0, 60);
  cam.lookAt(away ? -dist - 1000 : 0, 0, 60);
  cam.updateMatrixWorld();
  return cam;
}
/** Vue de dessus (orthographique) sur l'origine, `half` unités de demi-hauteur (comme rig.ts). */
function topCamera(half: number) {
  const cam = new OrthographicCamera(-half, half, half, -half, 1, 60000);
  cam.position.set(0, 0, 10000);
  cam.lookAt(0, 0, 9999);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();
  return cam;
}
const all = (o: Object3D) => { const out: Object3D[] = []; o.traverse((x) => { out.push(x); }); return out; };
/** Objets de la couche hors modèles des joueurs : les armes au sol. */
const drops = (layer: AgentLayer, sids: string[]) =>
  layer.group.children.filter((o) => !sids.map((s) => layer.rig(s)?.group).includes(o as never));
const sorted = (s: ReadonlySet<string>) => [...s].sort();
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("joueurs en modèles d'agents", () => {
  it("sans fichiers : aucun modèle (les silhouettes restent)", () => {
    const layer = new AgentLayer();
    layer.update([state("a", 0)], null);
    expect(layer.animate(replay(), 100, camera(), 0).size).toBe(0);
    expect(layer.group.children).toHaveLength(0);
  });
  it("modèle posé à la position et au lacet des états, arme en main ; rien sous les pieds (pas d'anneau d'équipe)", async () => {
    const layer = new AgentLayer();
    layer.setLibrary(await library());
    layer.update([state("a", 0, { yaw: 90 }), state("b", 300)], null);
    expect(sorted(layer.animate(replay(), 100, camera(), 0))).toEqual(["a", "b"]);
    expect(layer.rig("a")!.group.rotation.z).toBeCloseTo(Math.PI / 2, 9);
    expect(layer.rig("b")!.group.position.x).toBe(300);
    expect(layer.rig("a")!.weapon()).not.toBeNull();  // AK-47 en main
    // décision du 05/11 : aucun anneau ; la couche ne contient que les deux modèles
    expect(layer.group.children).toEqual([layer.rig("a")!.group, layer.rig("b")!.group]);
    expect(all(layer.group).some((o) => (o as Mesh).geometry?.type === "RingGeometry")).toBe(false);
  });
  it("vue du joueur : le joueur caché n'est pas dessiné ; de retour, le même modèle, sans pose refaite", async () => {
    const layer = new AgentLayer(), r = replay();
    layer.setLibrary(await library());
    layer.update([state("a", 0), state("b", 300)], null);
    layer.animate(r, 100, camera(), 0);
    const a = layer.rig("a")!, apply = vi.spyOn(a, "apply");
    layer.update([state("a", 0), state("b", 300)], "a");
    expect([...layer.animate(r, 100, camera(), 1)]).toEqual(["b"]);
    expect(a.group.visible).toBe(false);
    layer.update([state("a", 0), state("b", 300)], null);
    expect(sorted(layer.animate(r, 100, camera(), 2))).toEqual(["a", "b"]);
    expect(layer.rig("a")).toBe(a);
    expect(a.group.visible).toBe(true);
    expect(apply).not.toHaveBeenCalled();  // même instant : déjà posé
  });
  it("joueur sans clips chargés (agentPose null) : pas de modèle, sa silhouette reste ; un joueur parti (autre round) est retiré", async () => {
    const layer = new AgentLayer();
    layer.setLibrary(await library({ "agent-ct": agentGlb }));
    layer.update([state("a", 0)], null);
    expect(layer.animate(replay(), 100, camera(), 0).size).toBe(0);
    expect(layer.rig("a")?.group.visible ?? false).toBe(false);
    const full = new AgentLayer();
    full.setLibrary(await library());
    full.update([state("a", 0), state("b", 300)], null);
    full.animate(replay(), 100, camera(), 0);
    const b = full.rig("b")!, gone = vi.spyOn(b, "dispose");
    full.update([state("a", 0)], null);
    expect(full.rig("b")).toBeUndefined();
    expect(gone).toHaveBeenCalledWith(false);
    expect(b.group.parent).toBeNull();
  });
  it("plus rien à poser (mort sans kill enregistré : agentPose null) : retiré de l'ensemble rendu, sa silhouette ou sa croix reviennent", async () => {
    const layer = new AgentLayer(), r = replay([], (i, j) => j === 1 && i >= 50);
    layer.setLibrary(await library());
    layer.update([state("a", 0), state("b", 300)], null);
    expect(sorted(layer.animate(r, 50, camera(), 0))).toEqual(["a", "b"]);
    layer.update([state("a", 0), state("b", 300, { alive: false })], null);
    expect([...layer.animate(r, 300, camera(), 1)]).toEqual(["a"]);
    expect(layer.rig("b")!.group.visible).toBe(false);
  });
  it("ensemble rendu : le même objet d'une image à l'autre, au contenu de l'image (le copier pour le garder)", async () => {
    const layer = new AgentLayer(), r = replay();
    layer.setLibrary(await library());
    layer.update([state("a", 0), state("b", 300)], null);
    const first = layer.animate(r, 100, camera(), 0);
    expect(sorted(first)).toEqual(["a", "b"]);
    layer.update([state("a", 0), state("b", 300)], "b");
    const second = layer.animate(r, 102, camera(), 1);
    expect(second).toBe(first);
    expect([...second]).toEqual(["a"]);
  });
  it("bibliothèque posée : modèles des deux camps et quatre jeux de clips demandés ; armes des inventaires demandées d'avance", async () => {
    const load = vi.fn<AgentLoad>(async () => null), layer = new AgentLayer();
    layer.setLibrary(new AgentLibrary(load, () => {}));
    expect(load.mock.calls.map((c) => c[0]).sort()).toEqual(["agent-ct", "agent-t", "anims-communes", "anims-knife", "anims-pistol", "anims-rifle"]);
    layer.update([state("a", 0, { inventory: ["AK-47", "Glock-18", "Smoke Grenade"] }), state("b", 0, { side: "T", inventory: ["knife"] })], null);
    expect(load.mock.calls.slice(6).map((c) => c[0]).sort()).toEqual(["monde-ak47", "monde-glock", "monde-knife_t", "monde-smokegrenade"]);
    const other = vi.fn<AgentLoad>(async () => null);  // autre bibliothèque : tout est redemandé
    layer.setLibrary(new AgentLibrary(other, () => {}));
    layer.update([state("a", 0, { inventory: ["AK-47"] })], null);
    expect(other.mock.calls.map((c) => c[0])).toContain("monde-ak47");
  });
  it("autre camp : autre modèle (l'ancien libéré) ; camp sans modèle sur le serveur : pas de modèle, sa silhouette reste", async () => {
    const { "agent-t": _t, ...noT } = FILES, layer = new AgentLayer(), r = replay();
    layer.setLibrary(await library(noT));
    layer.update([state("a", 0)], null);
    layer.animate(r, 100, camera(), 0);
    const ct = layer.rig("a")!, gone = vi.spyOn(ct, "dispose");
    expect(ct.file).toBe("agent-ct");
    layer.update([state("a", 0, { side: "T" })], null);
    expect(layer.animate(r, 102, camera(), 1).size).toBe(0);
    expect(gone).toHaveBeenCalledWith(false);
    expect(layer.rig("a")).toBeUndefined();
    const both = new AgentLayer();
    both.setLibrary(await library());
    both.update([state("a", 0, { side: "T" })], null);
    both.animate(r, 100, camera(), 0);
    expect([both.rig("a")!.file, both.rig("a")!.side]).toEqual(["agent-t", "T"]);
  });
  it("kit de désamorçage : montré pour un CT vivant qui en a un", async () => {
    const layer = new AgentLayer(), r = replay();
    layer.setLibrary(await library());
    const kit = () => { let k: Object3D | undefined; layer.rig("a")!.root.traverse((o) => { if (o.name === "defusekit") k = o; }); return k!.visible; };
    layer.update([state("a", 0, { defuser: true })], null);
    layer.animate(r, 100, camera(), 0);
    expect(kit()).toBe(true);
    layer.update([state("a", 0)], null);
    layer.animate(r, 102, camera(), 1);
    expect(kit()).toBe(false);
  });
});

describe("corps au sol et armes lâchées", () => {
  // b meurt au tick 100 (image 50) à [310, 5, 0], regard +X
  const KILL: Partial<KillEvent>[] = [{ tick: 100, victim: "b", attacker: "a", victim_pos: [310, 5, 0] }];
  const deadB = (i: number, j: number) => j === 1 && i >= 50;
  const states = () => [state("a", 0), state("b", 0, { alive: false })];
  /** Clip de mort des fichiers de test retouché : le bassin finit 1,2 m en arrière (−Z du modèle), comme les vrais clips
   *  (0,9 à 1,8 m). */
  const backwards = (name: string, f: VmFile) => {
    if (name !== "anims-communes") return;
    const v = f.clips.find((c) => c.name === "mort_chest_a")!.tracks[0].values;
    v[v.length - 1] = -1.2;
  };
  /** Os racine « weapon » de l'arme au sol, et ses axes dans le repère du jeu. */
  const gunAxes = (drop: Object3D) => {
    let bone: Object3D | undefined;
    drop.traverse((o) => { if (o.name === "weapon") bone = o; });
    bone!.updateWorldMatrix(true, false);
    const q = bone!.getWorldQuaternion(new Quaternion());
    return { barrel: new Vector3(1, 0, 0).applyQuaternion(q), top: new Vector3(0, 0, 1).applyQuaternion(q),
      scale: bone!.getWorldScale(new Vector3()).x, z: bone!.getWorldPosition(new Vector3()).z };
  };

  it("mort : corps à la position de sa mort, sans arme ; son arme au sol tant qu'elle n'est pas ramassée ; avant la mort, rien", async () => {
    const layer = new AgentLayer(), r = replay(KILL, deadB);
    layer.setLibrary(await library());
    layer.update(states(), null);
    expect(layer.animate(r, 300, camera(), 0).has("b")).toBe(true);
    expect(layer.rig("b")!.group.position.toArray()).toEqual([310, 5, 0]);
    expect(layer.rig("b")!.weapon()).toBeNull();
    const d = drops(layer, ["a", "b"]);
    expect(d).toHaveLength(1);
    // clip de mort des fichiers de test : le bassin tombe sur place, l'arme reste à sa place de 2.1
    expect(d[0].position.x).toBeCloseTo(310 + DROP_AHEAD, 6);
    expect(d[0].position.y).toBeCloseTo(5 - DROP_RIGHT, 6);
    layer.update([state("a", 0), state("b", 300)], null);
    layer.animate(r, 50, camera(), 1);  // retour avant la mort
    expect(drops(layer, ["a", "b"])).toHaveLength(0);
    expect(d[0].parent).toBeNull();
  });
  it("vue de dessus avec coupe : corps et arme au sol au-dessus de la coupe cachés, en dessous visibles, vivants entiers ; sans coupe, rien ne change", async () => {
    const high: Partial<KillEvent>[] = [{ tick: 100, victim: "b", attacker: "a", victim_pos: [310, 5, 400] }];
    const layer = new AgentLayer(), r = replay(high, deadB);
    layer.setLibrary(await library());
    layer.update([state("a", 0, { z: 400 }), state("b", 0, { alive: false, z: 400 })], null);
    const cam = topCamera(1000), seen = () => ({ body: layer.rig("b")!.group.visible, alive: layer.rig("a")!.group.visible,
      gun: drops(layer, ["a", "b"])[0].visible });
    layer.animate(r, 300, cam, 0);
    expect(seen()).toEqual({ body: true, alive: true, gun: true });  // aucune coupe
    layer.cutAbove(200);
    layer.animate(r, 300, cam, 1);
    expect(seen()).toEqual({ body: false, alive: true, gun: false });
    layer.cutAbove(1000);  // coupe au-dessus de tout
    layer.animate(r, 300, cam, 2);
    expect(seen()).toEqual({ body: true, alive: true, gun: true });
    layer.cutAbove(Infinity);
    layer.animate(r, 300, cam, 3);
    expect(seen()).toEqual({ body: true, alive: true, gun: true });
  });
  it("arme au sol couchée sur le flanc, canon dans la direction de son lacet (axes Source de l'os racine), en unités du jeu", async () => {
    const layer = new AgentLayer(), r = replay(KILL, deadB);
    layer.setLibrary(await library());
    layer.update(states(), null);
    layer.animate(r, 300, camera(), 0);
    const { barrel, top, scale, z } = gunAxes(drops(layer, ["a", "b"])[0]);
    expect(z).toBeCloseTo(1 + 0.02 / 0.0254, 4);  // au sol (z de la mort + 1, 2.1), soulevée de 2 cm
    expect(Math.abs(barrel.z)).toBeLessThan(1e-6);  // canon à l'horizontale
    expect(Math.abs(top.z)).toBeLessThan(1e-6);  // dessus de l'arme sur le côté : couchée sur le flanc
    const yaw = (Math.atan2(barrel.y, barrel.x) * 180) / Math.PI;
    expect([65, 115].some((a) => Math.abs(yaw - a) < 1e-4)).toBe(true);  // lacet du mort + 90 ± 25 (agentAnim)
    expect(scale).toBeCloseTo(1 / 0.0254, 3);  // mètres → unités
  });
  it("arme au sol au point de mort (place de 2.1), pas déplacée par le corps qui tombe en arrière : la même pendant et après la chute", async () => {
    const layer = new AgentLayer(), r = replay(KILL, deadB);
    layer.setLibrary(await library(FILES, backwards));
    layer.update(states(), null);
    layer.animate(r, 104, camera(), 0);  // pendant la chute
    const d = drops(layer, ["a", "b"]);
    expect(d).toHaveLength(1);
    const back = 1.2 / 0.0254;
    expect(d[0].position.x).toBeCloseTo(310 + DROP_AHEAD, 4);
    expect(d[0].position.y).toBeCloseTo(5 - DROP_RIGHT, 4);
    // le corps est posé à l'instant affiché (début de la chute), pas à la fin du clip
    const pelvis = layer.rig("b")!.node("pelvis")!;
    pelvis.updateWorldMatrix(true, false);
    expect(pelvis.getWorldPosition(new Vector3()).x).toBeGreaterThan(310 - back / 2);
    layer.animate(r, 400, camera(), 1);  // corps au sol, 1,2 m en arrière : l'arme n'a pas bougé
    expect(d[0].position.x).toBeCloseTo(310 + DROP_AHEAD, 4);
    expect(d[0].position.y).toBeCloseTo(5 - DROP_RIGHT, 4);
    pelvis.updateWorldMatrix(true, false);
    expect(pelvis.getWorldPosition(new Vector3()).x).toBeCloseTo(310 - back, 3);
  });
  it("corps au loin, image où il attendrait : posé à l'instant affiché, jamais laissé à la fin de sa chute", async () => {
    const layer = new AgentLayer(), r = replay(KILL, deadB), far = camera(false, FAR + 500), back = 1.2 / 0.0254;
    layer.setLibrary(await library(FILES, backwards));
    layer.update([state("a", 0), state("b", 300)], null);
    layer.animate(r, 98, far, 0);  // b vivant, posé
    layer.update(states(), null);
    layer.animate(r, 104, far, 2);  // image paire : b (indice 1) attendrait
    const pelvis = layer.rig("b")!.node("pelvis")!;
    pelvis.updateWorldMatrix(true, false);
    expect(pelvis.getWorldPosition(new Vector3()).x).toBeGreaterThan(310 - back / 2);
  });
  it("corps au lacet de son dernier instant en vie (replay, pas les états) ; arme devant et à droite du point de mort, selon ce lacet", async () => {
    const layer = new AgentLayer(), r = replay(KILL, deadB, { yaw: (_i, j) => (j === 1 ? 90 : 0) });
    layer.setLibrary(await library(FILES, backwards));
    layer.update(states(), null);  // états : lacet 0
    layer.animate(r, 300, camera(), 0);
    expect(layer.rig("b")!.group.rotation.z).toBeCloseTo(Math.PI / 2, 9);
    const [d] = drops(layer, ["a", "b"]);
    // regard +Y : devant = +Y, droite = +X ; le corps tombe vers −Y, l'arme reste devant
    expect(d.position.x).toBeCloseTo(310 + DROP_RIGHT, 4);
    expect(d.position.y).toBeCloseTo(5 + DROP_AHEAD, 4);
  });
  it("corps au sol puis un autre round (replay) au même tick, où il vit : reposé vivant, à sa place, sans kit de mort", async () => {
    const layer = new AgentLayer(), r = replay(KILL, deadB);
    layer.setLibrary(await library());
    layer.update([state("a", 0), state("b", 0, { alive: false, defuser: true })], null);
    layer.animate(r, 300, camera(), 0);
    let kit: Object3D | undefined;
    layer.rig("b")!.root.traverse((o) => { if (o.name === "defusekit") kit = o; });
    expect(kit!.visible).toBe(false);  // un mort n'a pas de kit en main
    const pelvis = layer.rig("b")!.node("pelvis")!, apply = vi.spyOn(layer.rig("b")!, "apply");
    expect(pelvis.position.y).toBeCloseTo(0.15, 6);  // couché
    layer.update([state("a", 0), state("b", 300)], null);
    layer.animate(replay(), 300, camera(), 1);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(layer.rig("b")!.group.position.x).toBe(300);
    expect(pelvis.position.y).toBeCloseTo(1, 6);  // debout
  });
  it("pendant la chute : reposé à chaque instant", async () => {
    const layer = new AgentLayer(), r = replay(KILL, deadB);
    layer.setLibrary(await library());
    layer.update(states(), null);
    layer.animate(r, 104, camera(), 0);
    const apply = vi.spyOn(layer.rig("b")!, "apply");
    layer.animate(r, 110, camera(), 1);
    layer.animate(r, 130, camera(), 2);
    expect(apply).toHaveBeenCalledTimes(2);
  });
  it("clip de mort plus court que le fondu : pas tenu pour fini tant que le fondu dure", async () => {
    const short = (name: string, f: VmFile) => {
      if (name !== "anims-communes") return;
      const c = f.clips.find((x) => x.name === "mort_chest_a")!;
      c.duration = 0.05;
      c.tracks[0].times[1] = 0.05;
    };
    const layer = new AgentLayer(), r = replay(KILL, deadB);
    layer.setLibrary(await library(FILES, short));
    layer.update(states(), null);
    layer.animate(r, 104, camera(), 0);  // 0,06 s : clip fini, fondu de 0,1 s en cours
    const apply = vi.spyOn(layer.rig("b")!, "apply");
    layer.animate(r, 110, camera(), 1);  // fondu fini : autre pose
    expect(apply).toHaveBeenCalledTimes(1);
  });
  it("arme absente du serveur : rien au sol (le corps est là)", async () => {
    const { "monde-ak47": _w, ...noGun } = FILES, layer = new AgentLayer(), r = replay(KILL, deadB);
    layer.setLibrary(await library(noGun));
    layer.update(states(), null);
    expect(layer.animate(r, 300, camera(), 0).has("b")).toBe(true);
    expect(drops(layer, ["a", "b"])).toHaveLength(0);
  });
  it("arme ramassée (tick `until` de 2.1) : retirée ; un autre replay : celles du nouveau", async () => {
    // a arrive à l'arme et prend l'AK-47 à l'image 120 (tick 240)
    const x = (i: number, j: number) => (j === 0 ? (i >= 110 ? 320 : 0) : 300);
    const inv = (i: number, j: number) => (j === 0 && i < 120 ? [] : ["AK-47"]);
    const layer = new AgentLayer(), r = replay(KILL, deadB, { x, inventory: inv });
    layer.setLibrary(await library());
    layer.update(states(), null);
    layer.animate(r, 200, camera(), 0);
    const d = drops(layer, ["a", "b"]);
    expect(d).toHaveLength(1);
    layer.animate(r, 240, camera(), 1);
    expect(drops(layer, ["a", "b"])).toHaveLength(0);
    layer.animate(r, 238, camera(), 2);
    expect(drops(layer, ["a", "b"])).toHaveLength(1);
    layer.animate(replay(), 238, camera(), 3);  // autre round, personne de mort
    expect(drops(layer, ["a", "b"])).toHaveLength(0);
  });
  it("corps au sol : une fois le clip de mort fini, plus jamais reposé (même pose) ; revenu pendant la chute : reposé", async () => {
    const layer = new AgentLayer(), r = replay(KILL, deadB);
    layer.setLibrary(await library());
    layer.update(states(), null);
    layer.animate(r, 300, camera(), 0);  // 3,1 s après la mort : clip de 2,5 s fini
    const b = layer.rig("b")!, apply = vi.spyOn(b, "apply");
    for (let t = 302; t < 400; t += 2) layer.animate(r, t, camera(), t);
    expect(apply).not.toHaveBeenCalled();
    expect(layer.rig("b")!.group.position.toArray()).toEqual([310, 5, 0]);  // à la place de sa mort, pas à celle des états
    layer.animate(r, 120, camera(), 0);  // pendant la chute
    expect(apply).toHaveBeenCalledTimes(1);
  });
});

describe("niveau de détail (PC de l'équipe, 10 joueurs)", () => {
  it("hors du champ : pas reposé ; au loin : une image sur deux (deferred) ; même instant : pas refait", async () => {
    const layer = new AgentLayer(), r = replay();
    layer.setLibrary(await library());
    layer.update([state("a", 0)], null);
    layer.animate(r, 100, camera(true), 0);
    expect(layer.rig("a")!.posed).toBe("");
    expect(layer.deferred).toBe(false);  // hors du champ : rien à dessiner pour lui
    layer.animate(r, 100, camera(), 0);
    const first = layer.rig("a")!.posed;
    expect(first).toMatch(/^100\|/);
    const apply = vi.spyOn(layer.rig("a")!, "apply");
    layer.animate(r, 100, camera(), 1);
    expect(apply).not.toHaveBeenCalled();
    const far = camera(false, FAR + 500);
    layer.animate(r, 102, far, 1);  // image impaire, joueur d'indice 0 : attend
    expect(apply).not.toHaveBeenCalled();
    expect(layer.deferred).toBe(true);  // une image de plus à dessiner
    layer.animate(r, 104, far, 2);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(layer.deferred).toBe(false);
  });
  it("au loin : un joueur pas encore posé l'est tout de suite ; deux joueurs lointains, en alternance (pair, impair)", async () => {
    const layer = new AgentLayer(), r = replay(), far = camera(false, FAR + 500);
    const ticks = () => [layer.rig("a")!.posed, layer.rig("b")!.posed].map((k) => k.split("|")[0]);
    layer.setLibrary(await library());
    layer.update([state("a", 0), state("b", 0, { y: 40 })], null);
    layer.animate(r, 100, far, 1);
    expect(ticks()).toEqual(["100", "100"]);
    layer.animate(r, 102, far, 1);  // a (indice 0) attend, b (indice 1) est posé
    expect(ticks()).toEqual(["100", "102"]);
    layer.animate(r, 102, far, 2);
    expect(ticks()).toEqual(["102", "102"]);
    expect(layer.deferred).toBe(false);
  });
  it("en partie dans le champ (la sphère de découpage que three teste le touche) : posé", async () => {
    // caméra à 400 unités, 400 plus haut, regard horizontal : le bas de la vue passe à z = 400 − 400·tan 35° ≈ 120 au droit
    // du joueur ; sa sphère (centre à 1 m, rayon 2,4 m : 39 et 94 unités) monte à 134
    const layer = new AgentLayer(), r = replay(), cam = new PerspectiveCamera(70, 1, 1, 40000);
    cam.up.set(0, 0, 1);
    cam.position.set(-400, 0, 400);
    cam.lookAt(0, 0, 400);
    layer.setLibrary(await library());
    layer.update([state("a", 0)], null);
    layer.animate(r, 100, cam, 0);
    expect(layer.rig("a")!.posed).toMatch(/^100\|/);
    cam.position.z = 450;  // bas de la vue à 170 : hors du champ
    layer.animate(r, 102, cam, 1);
    expect(layer.rig("a")!.posed).toMatch(/^100\|/);
  });
  it("hors du champ : sa place suit quand même (three le découpe là où il est)", async () => {
    const layer = new AgentLayer(), r = replay();
    layer.setLibrary(await library());
    layer.update([state("a", 0)], null);
    layer.animate(r, 100, camera(), 0);
    layer.update([state("a", -900)], null);
    layer.animate(r, 102, camera(), 1);  // derrière la caméra
    expect(layer.rig("a")!.group.position.x).toBe(-900);
    expect(layer.rig("a")!.posed).toMatch(/^100\|/);
  });
  it("au loin selon la taille à l'écran : en lunette (champ étroit), pas au loin ; vue de dessus : selon son zoom", async () => {
    const layer = new AgentLayer(), r = replay();
    layer.setLibrary(await library());
    layer.update([state("a", 0)], null);
    layer.animate(r, 100, camera(), 0);
    const apply = vi.spyOn(layer.rig("a")!, "apply");
    layer.animate(r, 102, camera(false, FAR + 500, 15), 1);  // lunette : joueur grand à l'écran
    expect(apply).toHaveBeenCalledTimes(1);
    layer.animate(r, 104, topCamera(2000), 1);  // carte entière : joueurs petits
    expect(apply).toHaveBeenCalledTimes(1);
    layer.animate(r, 106, topCamera(400), 1);  // zoomée
    expect(apply).toHaveBeenCalledTimes(2);
  });
  it("agentPose seulement pour les joueurs posés à cette image (et une fois pour connaître un joueur ou le corps d'un mort)", async () => {
    // a devant la caméra, b dans son dos (x = −900) ; la caméra regarde +X depuis x = −400
    const layer = new AgentLayer(), r = replay();
    layer.setLibrary(await library());
    posed.length = 0;
    layer.update([state("a", 0), state("b", -900)], null);
    layer.animate(r, 100, camera(), 0);  // b : évalué une fois (dessiné ou non), pas posé
    layer.animate(r, 102, camera(), 1);
    layer.animate(r, 104, camera(), 2);
    expect([calls("a"), calls("b")]).toEqual([3, 1]);
    expect(layer.rig("b")!.posed).toBe("");
    expect(layer.animate(r, 104, camera(), 3).has("b")).toBe(true);  // toujours dessiné en modèle (silhouette cachée)
    layer.update([state("a", 0), state("b", -800)], null);
    layer.animate(r, 106, camera(), 3);
    expect(layer.rig("b")!.group.position.x).toBe(-800);  // sa place suit l'état
    expect(calls("b")).toBe(1);
    layer.animate(r, 106, camera(true), 4);  // même instant, caméra retournée : b entre dans le champ, posé avant le rendu
    expect([calls("a"), calls("b")]).toEqual([4, 2]);
    expect(layer.rig("b")!.posed).toMatch(/^106\|/);
  });
  it("agentPose : au loin, seulement le joueur posé à cette image ; le joueur caché, jamais", async () => {
    const layer = new AgentLayer(), r = replay(), far = camera(false, FAR + 500);
    layer.setLibrary(await library());
    layer.update([state("a", 0), state("b", 0, { y: 40 })], null);
    layer.animate(r, 100, far, 1);  // premier affichage : les deux
    posed.length = 0;
    layer.animate(r, 102, far, 1);  // a (indice 0) attend, b (indice 1) est posé
    expect([calls("a"), calls("b")]).toEqual([0, 1]);
    layer.animate(r, 102, far, 2);  // image suivante, même instant : a
    expect([calls("a"), calls("b")]).toEqual([1, 1]);
    layer.update([state("a", 0), state("b", 0, { y: 40 })], "a");
    layer.animate(r, 104, far, 3);
    layer.animate(r, 104, far, 4);
    expect([calls("a"), calls("b")]).toEqual([1, 2]);
  });
  it("fichier arrivé, joueur au loin sur son image d'attente : évalué (nouveaux fichiers), pas posé, image suivante demandée", async () => {
    const lib = await library(), layer = new AgentLayer(), r = replay(), far = camera(false, FAR + 500);
    layer.setLibrary(lib);
    layer.update([state("a", 0)], null);
    layer.animate(r, 100, far, 0);
    const apply = vi.spyOn(layer.rig("a")!, "apply");
    posed.length = 0;
    lib.version++;
    layer.animate(r, 100, far, 1);  // image impaire, joueur d'indice 0 : attend
    expect(calls("a")).toBe(1);
    expect(apply).not.toHaveBeenCalled();
    expect(layer.deferred).toBe(true);
    layer.animate(r, 100, far, 2);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(calls("a")).toBe(1);  // même instant : pose déjà évaluée
  });
  it("agentPose : un mort hors du champ évalué une fois (corps, arme au sol), puis plus, son corps à sa place", async () => {
    // b meurt au tick 100 à [310, 5, 0], dans le dos de la caméra (regard −X)
    const KILL: Partial<KillEvent>[] = [{ tick: 100, victim: "b", attacker: "a", victim_pos: [310, 5, 0] }];
    const layer = new AgentLayer(), r = replay(KILL, (i, j) => j === 1 && i >= 50);
    layer.setLibrary(await library());
    layer.update([state("a", 0), state("b", 300)], null);
    layer.animate(r, 98, camera(true), 0);
    posed.length = 0;
    layer.update([state("a", 0), state("b", 300, { alive: false })], null);
    for (let t = 102; t < 140; t += 2) layer.animate(r, t, camera(true), t);  // pendant la chute, hors du champ
    expect(calls("b")).toBe(1);
    expect(layer.rig("b")!.group.position.toArray()).toEqual([310, 5, 0]);
    expect(drops(layer, ["a", "b"])).toHaveLength(1);
    layer.animate(r, 140, camera(), 1);  // de nouveau dans le champ : posé à l'instant affiché
    expect(calls("b")).toBe(2);
    expect(layer.rig("b")!.posed).toMatch(/^140\|/);
  });
  it("fichier arrivé (version) ou autre replay au même instant : pose refaite", async () => {
    const lib = await library(), layer = new AgentLayer();
    layer.setLibrary(lib);
    layer.update([state("a", 0)], null);
    layer.animate(replay(), 100, camera(), 0);
    const apply = vi.spyOn(layer.rig("a")!, "apply"), other = replay();
    layer.animate(other, 100, camera(), 0);
    expect(apply).toHaveBeenCalledTimes(1);  // autre replay
    layer.animate(other, 100, camera(), 1);
    expect(apply).toHaveBeenCalledTimes(1);
    lib.version++;
    layer.animate(other, 100, camera(), 2);
    expect(apply).toHaveBeenCalledTimes(2);  // fichier arrivé
  });
});

// ImageBitmap absent sous Node : image décodée factice, qui compte ses fermetures (comme agents.test.ts)
class Bitmap { width = 8; height = 8; closed = 0; close() { this.closed++; } }

describe("libération (contexte graphique perdu ou non, MEM3D)", () => {
  /** Arme de test à peau et texturée (comme les vraies), et ce qui est libéré sur la carte graphique. */
  async function texturedWeapon() {
    vi.stubGlobal("ImageBitmap", Bitmap);
    const img = new Bitmap(), events: string[] = [];
    const lib = await library(FILES, (name, f) => {
      if (name !== "monde-ak47") return;
      const bone = f.scene.getObjectByName("weapon")!, plain = f.scene.getObjectByName("corps") as Mesh;
      const g = plain.geometry;
      g.setAttribute("skinIndex", new Uint16BufferAttribute(new Array(12).fill(0), 4));
      g.setAttribute("skinWeight", new Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
      const skin = new SkinnedMesh(g, new MeshStandardMaterial({ map: new Texture(img as Bitmap & ImageBitmap) }));
      skin.name = "corps";
      plain.removeFromParent();
      bone.parent!.add(skin);
      skin.bind(new Skeleton([bone as Bone]));
    });
    /** Textures des os de l'arme au sol, créées comme le ferait le rendu ; leur libération est notée. */
    const bones = (drop: Object3D) => drop.traverse((o) => {
      const s = (o as SkinnedMesh).skeleton;
      if (!s) return;
      s.computeBoneTexture();
      s.boneTexture!.addEventListener("dispose", () => events.push("os"));
    });
    return { lib, img, events, bones };
  }
  const KILL: Partial<KillEvent>[] = [{ tick: 100, victim: "b", attacker: "a", victim_pos: [310, 5, 0] }];
  const deadB = (i: number, j: number) => j === 1 && i >= 50;

  for (const lost of [false, true]) {
    it(lost ? "contexte perdu (setLibrary(null, true)) : modèles et armes au sol retirés, aucun appel à la carte graphique, images fermées"
      : "bibliothèque retirée : modèles et armes au sol retirés, squelettes des clones libérés, images de la bibliothèque gardées", async () => {
      const w = await texturedWeapon(), layer = new AgentLayer(), rigDispose = vi.spyOn(AgentRig.prototype, "dispose");
      layer.setLibrary(w.lib);
      layer.update([state("a", 0), state("b", 0, { alive: false })], null);
      layer.animate(replay(KILL, deadB), 300, camera(), 0);
      const [drop] = drops(layer, ["a", "b"]), skin = drop.getObjectByName("corps") as SkinnedMesh;
      expect(skin.boundingSphere!.equals(WEAPON_SPHERE)).toBe(true);  // sphère de découpage fixe, à elle
      expect(skin.boundingSphere).not.toBe(WEAPON_SPHERE);
      w.bones(drop);
      layer.setLibrary(null, lost);
      expect(layer.group.children).toHaveLength(0);
      expect(rigDispose.mock.calls).toEqual([[lost], [lost]]);
      expect(w.events).toEqual(lost ? [] : ["os"]);
      expect(w.img.closed).toBe(lost ? 1 : 0);
    });
  }
  it("autre bibliothèque (contexte rendu, 4.1) : modèles refaits depuis la nouvelle, rien de l'ancienne", async () => {
    const layer = new AgentLayer(), r = replay(), first = await library(), second = await library();
    const body = (root: Object3D) => (root.getObjectByName("thirdperson_body") as Mesh).geometry;
    layer.setLibrary(first);
    layer.update([state("a", 0)], null);
    layer.animate(r, 100, camera(), 0);
    expect(body(layer.rig("a")!.root)).toBe(body(first.model("CT")!.root));
    layer.setLibrary(null, true);
    first.dispose(true);
    layer.setLibrary(second);
    layer.animate(r, 100, camera(), 1);
    expect(body(layer.rig("a")!.root)).toBe(body(second.model("CT")!.root));
    expect(layer.rig("a")!.weapon()!.getObjectByName("corps")).toBeDefined();
  });
  it("bibliothèque retirée : le replay n'est plus retenu par la couche (aucun de ses champs ne le garde)", async () => {
    const layer = new AgentLayer(), r = replay();
    layer.setLibrary(await library());
    layer.update([state("a", 0)], null);
    layer.animate(r, 100, camera(), 0);
    expect(Object.values(layer)).toContain(r);  // gardé tant que la couche pose (même instant : rien à refaire)
    layer.setLibrary(null);
    expect(Object.values(layer)).not.toContain(r);
  });
  it("dispose(true) : comme setLibrary(null, true)", async () => {
    const w = await texturedWeapon(), layer = new AgentLayer(), rigDispose = vi.spyOn(AgentRig.prototype, "dispose");
    layer.setLibrary(w.lib);
    layer.update([state("a", 0), state("b", 0, { alive: false })], null);
    layer.animate(replay(KILL, deadB), 300, camera(), 0);
    w.bones(drops(layer, ["a", "b"])[0]);
    layer.dispose(true);
    expect(layer.group.children).toHaveLength(0);
    expect(rigDispose.mock.calls).toEqual([[true], [true]]);
    expect(w.events).toEqual([]);
    expect(w.img.closed).toBe(1);
    expect(layer.animate(replay(), 100, camera(), 0).size).toBe(0);
  });
  it("agent équipé : le modèle du camp d'abord, l'agent à son arrivée (joueur recréé) ; l'autre joueur garde le sien", async () => {
    const files = { ...FILES, "agent-tm_leet_variantf": agentGlb }, layer = new AgentLayer(), r = replay([], () => false, { agents: ["tm_leet_variantf", null] });
    const lib = await library(files);
    layer.setLibrary(lib);
    layer.update([state("a", 0), state("b", 300)], null);
    layer.animate(r, 100, camera(), 0);
    expect(layer.rig("a")!.file).toBe("agent-ct");  // l'agent équipé n'est pas encore arrivé
    const camp = layer.rig("a")!, campGun = camp.weapon(), freed = vi.spyOn(camp, "dispose");
    expect(campGun).not.toBeNull();
    await until(() => lib.version > 0 && lib.model("CT", "tm_leet_variantf")?.file === "agent-tm_leet_variantf");
    layer.animate(r, 100, camera(), 1);
    expect(layer.rig("a")!.file).toBe("agent-tm_leet_variantf");
    // l'arme reste en main après la bascule : montée sur le nouveau rig, l'ancien (et son arme) libéré
    expect(layer.rig("a")).not.toBe(camp);
    expect(layer.rig("a")!.weapon()).not.toBeNull();
    expect(layer.rig("a")!.weapon()).not.toBe(campGun);
    expect(freed).toHaveBeenCalledTimes(1);
    expect(layer.rig("b")!.file).toBe("agent-ct");
  });
  it("plafond des agents équipés : celui d'un joueur posé n'est pas libéré ; une fois le joueur parti, il l'est, et son retour recrée le modèle", async () => {
    const others = Array.from({ length: MAX_EQUIPPED + 1 }, (_, i) => `y${i}`);
    const files = { ...FILES, "agent-x0": agentGlb, ...Object.fromEntries(others.map((n) => [`agent-${n}`, agentGlb])) };
    const layer = new AgentLayer(), r = replay([], () => false, { agents: ["x0", null] }), lib = await library(files);
    const ask = async (n: string) => { await until(() => lib.model("CT", n)?.file === `agent-${n}`); };
    const geoms = (root: Object3D) => { const g: object[] = []; root.traverse((o) => { if ((o as Mesh).isMesh) g.push((o as Mesh).geometry); }); return g; };
    layer.setLibrary(lib);
    layer.update([state("a", 0), state("b", 300)], null);
    layer.animate(r, 100, camera(), 0);
    await ask("x0");
    layer.animate(r, 100, camera(), 1);
    const rig = layer.rig("a")!, model = lib.model("CT", "x0")!, spies = geoms(model.root).map((g) => vi.spyOn(g as Mesh["geometry"], "dispose"));
    expect(rig.file).toBe("agent-x0");
    for (const n of others.slice(0, MAX_EQUIPPED)) await ask(n);  // x0 est le plus ancien, mais posé sur le joueur a
    expect(layer.rig("a")).toBe(rig);  // (sans redemander le modèle à la bibliothèque : ce serait le rendre récent)
    expect(spies.every((d) => d.mock.calls.length === 0)).toBe(true);
    layer.update([state("b", 300)], null);  // a n'est plus dans les états (autre round) : son modèle est libre
    expect(layer.rig("a")).toBeUndefined();
    await ask(others[MAX_EQUIPPED]);
    expect(spies.every((d) => d.mock.calls.length > 0)).toBe(true);
    layer.update([state("a", 0), state("b", 300)], null);  // a revient avec le même agent
    layer.animate(r, 100, camera(), 2);
    expect(layer.rig("a")!.file).toBe("agent-ct");  // libéré : le camp d'abord
    await until(() => lib.model("CT", "x0")?.file === "agent-x0");
    layer.animate(r, 100, camera(), 3);
    expect(layer.rig("a")!.file).toBe("agent-x0");
    expect(lib.model("CT", "x0")).not.toBe(model);  // modèle neuf, rig recréé dessus
  });
});

describe("morts en ragdoll", () => {
  const at = (o: Object3D) => { o.updateWorldMatrix(true, false); return o.getWorldPosition(new Vector3()); };
  // trajectoire de 3 images (1/30 s) : bassin et tête couchés en x 50 et 75, z 3
  const TRACK = { dt: 1 / 60, frames: 3, bodies: 2, bones: ["pelvis", "head_0"],
    p: Float32Array.from([50, 0, 3, 75, 0, 3, 50, 0, 3, 75, 0, 3, 50, 0, 3, 75, 0, 3]),
    q: Float32Array.from({ length: 24 }, (_, k) => (k % 4 === 3 ? 1 : 0)) };
  it("trajectoire arrivée : le mort est reposé (version), os du ragdoll à la trajectoire ; fini : plus reposé", async () => {
    const lib = await library(), layer = new AgentLayer(), ready = { on: false };
    const rag = { version: 0, track: (_r: Replay, sid: string, kt: number) => (ready.on && sid === "a" && kt === 100 ? TRACK : null) };
    layer.setLibrary(lib);
    layer.setRagdolls(rag);
    const r = replay([{ tick: 100, victim: "a", attacker: "b", victim_pos: [0, 0, 0] }], (i, j) => j === 0 && 2 * i >= 100);
    layer.update([state("a", 0, { alive: false }), state("b", 300)], null);
    layer.animate(r, 300, camera(), 0);
    expect(at(layer.rig("a")!.node("pelvis")!).x).toBeCloseTo(0, 3);  // clip de mort : sur place
    ready.on = true;
    rag.version = 1;
    layer.animate(r, 300, camera(), 1);
    expect(at(layer.rig("a")!.node("pelvis")!).x).toBeCloseTo(50, 3);
    expect(at(layer.rig("a")!.node("head_0")!).x).toBeCloseTo(75, 3);
    expect(layer.rig("a")!.posed).toMatch(/^300\|\d+\|1$/);
    const before = calls("a");
    layer.animate(r, 400, camera(), 2);  // trajectoire finie depuis longtemps : la pose ne change plus
    expect(calls("a")).toBe(before);
  });
});
