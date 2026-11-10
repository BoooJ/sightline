import { afterEach, describe, expect, it, vi } from "vitest";
import { BufferGeometry, type Camera, Group, Mesh, MeshStandardMaterial, type Object3D, Scene, Texture, VectorKeyframeTrack,
  type WebGLRenderer } from "three";
import { AgentLibrary, type AgentLoad, agentNameFile, COMPILE_TIMEOUT_MS, MAX_EQUIPPED, RETRY_MS, WARM_PER_FRAME } from "./agents";
import { LoadError, parseGlbAnimated } from "./loader";
import { AGENT_RAGDOLL, agentGlb, animsGlb, COMMON_CLIPS, mondeGlb, ragdollGlb, SRC_Q } from "./testGlb";
import type { VmFile } from "./viewmodel";

const read = (b: Uint8Array<ArrayBuffer>) => parseGlbAnimated(b.buffer);
const FILES: Record<string, () => Uint8Array<ArrayBuffer>> = {
  "agent-ct": agentGlb, "agent-t": agentGlb, "anims-rifle": () => animsGlb(), "anims-communes": () => animsGlb(COMMON_CLIPS),
  "monde-ak47": mondeGlb, "agent-tm_leet_variantf": agentGlb,
  ragdoll: () => ragdollGlb(),
};
/** Chargeur des fichiers de test ; un nom absent de `files` : null (absent du serveur). */
const loader = (files = FILES) => vi.fn<AgentLoad>(async (name) => (files[name] ? read(files[name]()) : null));
const until = (ok: () => boolean) => vi.waitFor(() => { if (!ok()) throw new Error("pas encore"); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("fichiers « joueurs »", () => {
  it("modèle, clips et arme demandés au premier appel, une seule fois ; onChange et version à chaque arrivée", async () => {
    const load = loader(), changed = vi.fn(), lib = new AgentLibrary(load, changed);
    expect(lib.model("CT")).toBeNull();
    expect(lib.duration("rifle", "walk_n")).toBeNull();
    expect(lib.weapon("ak47")).toBeNull();
    lib.model("CT");
    await until(() => lib.model("CT") !== null && lib.duration("rifle", "walk_n") !== null && lib.weapon("ak47") !== null);
    expect(load.mock.calls.map((c) => c[0]).sort()).toEqual(["agent-ct", "anims-rifle", "monde-ak47"]);
    expect(changed).toHaveBeenCalledTimes(3);
    expect(lib.version).toBe(3);
    expect(lib.duration("rifle", "walk_n")).toBe(1);
    expect(lib.duration("rifle", "inconnu")).toBeNull();
  });
  it("modèle : os à leur nom d'origine, rien de caché hors première personne ; arme : os « weapon » remis à l'origine", async () => {
    const lib = new AgentLibrary(loader(), () => {});
    lib.preload(["CT"], []);
    await until(() => lib.model("CT") !== null && lib.weapon("ak47") !== null);
    expect([...lib.model("CT")!.nodes]).toEqual(expect.arrayContaining(["root_motion", "pelvis", "hand_R", "wpn"]));
    const w = lib.weapon("ak47")!;
    let bone: Object3D | undefined;
    w.traverse((o) => { if (o.name === "weapon") bone = o; });
    expect(w.name).toBe("sl_arme");
    expect(bone!.position.toArray()).toEqual([0, 0, 0]);
    expect(bone!.quaternion.toArray().map((x) => +x.toFixed(6))).toEqual(SRC_Q);
  });
  it("clip réduit aux os du modèle du camp (une piste sans os dans ce modèle est retirée)", async () => {
    const load = vi.fn<AgentLoad>(async (name) => {
      const f = FILES[name] ? await read(FILES[name]()) : null;
      if (f && name === "anims-rifle") f.clips.find((c) => c.name === "idle")!.tracks.push(new VectorKeyframeTrack("jiggle_hood.position", [0], [0, 0, 0]));
      return f;
    });
    const lib = new AgentLibrary(load, () => {});
    lib.preload(["T"], ["rifle"]);
    await until(() => lib.model("T") !== null && lib.duration("rifle", "idle") !== null);
    const m = lib.model("T")!, c = lib.clip(m, "rifle", "idle")!;
    expect(m.file).toBe("agent-t");
    expect(c.tracks.map((t) => t.name)).toEqual(["pelvis.position"]);
    expect(lib.clip(m, "rifle", "idle")).toBe(c);  // gardé
    expect(lib.clip(m, "rifle", "absent")).toBeNull();
  });
  it("fichier absent du serveur : mémorisé, jamais redemandé", async () => {
    const load = loader({}), lib = new AgentLibrary(load, () => {});
    lib.model("CT");
    await until(() => load.mock.calls.length === 1);
    await new Promise((r) => setTimeout(r, 0));
    lib.model("CT");
    lib.model("CT");
    expect(load).toHaveBeenCalledTimes(1);
    expect(lib.model("CT")).toBeNull();
  });
  it("échec (404 d'un fichier ré-exporté…) : signalé une fois, nouvel essai seulement après RETRY_MS", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const load = vi.fn<AgentLoad>(async () => { throw new LoadError("erreur 404", 404); });
    const lib = new AgentLibrary(load, () => {}), errors: string[] = [];
    lib.onError = (name) => errors.push(name);
    lib.model("T");
    await until(() => errors.length === 1);
    lib.model("T");
    expect(load).toHaveBeenCalledTimes(1);
    now += RETRY_MS;
    lib.model("T");
    expect(load).toHaveBeenCalledTimes(2);
    expect(errors).toEqual(["agent-t"]);
  });
  it("après dispose : rien n'est demandé, un fichier arrivé ensuite est libéré", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const freed = vi.fn();  // géométries du fichier arrivé en retard libérées
    const load = vi.fn<AgentLoad>(async (name) => {
      await gate;
      const f = await read(FILES[name]());
      f.scene.traverse((o) => (o as Mesh).geometry?.addEventListener("dispose", freed));
      return f;
    });
    const lib = new AgentLibrary(load, () => {});
    lib.model("CT");
    lib.dispose();
    lib.weapon("ak47");
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(load).toHaveBeenCalledTimes(1);
    expect(lib.model("CT")).toBeNull();
    expect(freed).toHaveBeenCalled();
  });

  it("préchargement : modèles des camps et jeux de clips demandés tout de suite ; dispose annule les chargements, puis plus rien n'est donné", async () => {
    const load = loader(), lib = new AgentLibrary(load, () => {});
    lib.preload(["CT", "T"], ["rifle", "communes"]);
    expect(load.mock.calls.map((c) => c[0])).toEqual(["agent-ct", "agent-t", "anims-rifle", "anims-communes"]);
    lib.weapon("ak47");
    await until(() => lib.version === 5);
    lib.dispose();
    expect(load.mock.calls.map((c) => c[1].aborted)).toEqual(Array(5).fill(true));
    expect([lib.model("CT"), lib.model("T"), lib.duration("rifle", "idle"), lib.duration("communes", "mort_chest_a"),
      lib.weapon("ak47")]).toEqual([null, null, null, null, null]);
    expect(load).toHaveBeenCalledTimes(5);
  });
  it("clip demandé avant l'arrivée de son jeu : rien de mémorisé ; réduit pour chaque modèle (os propre à un camp)", async () => {
    // agent-ct a un os de plus (jiggle_hood) que agent-t ; idle l'anime
    const load = vi.fn<AgentLoad>(async (name) => {
      const f = FILES[name] ? await read(FILES[name]()) : null;
      if (f && name === "agent-ct") f.scene.getObjectByName("spine_3")!.add(Object.assign(new Group(), { name: "jiggle_hood" }));
      if (f && name === "anims-rifle") f.clips.find((c) => c.name === "idle")!.tracks.push(new VectorKeyframeTrack("jiggle_hood.position", [0], [0, 0, 0]));
      return f;
    });
    const lib = new AgentLibrary(load, () => {});
    lib.preload(["CT", "T"], []);
    await until(() => lib.model("CT") !== null && lib.model("T") !== null);
    const ct = lib.model("CT")!, t = lib.model("T")!;
    expect(lib.clip(ct, "rifle", "idle")).toBeNull();  // jeu demandé, pas encore là
    await until(() => lib.duration("rifle", "idle") !== null);
    expect(lib.clip(ct, "rifle", "idle")!.tracks.map((x) => x.name)).toEqual(["pelvis.position", "jiggle_hood.position"]);
    expect(lib.clip(t, "rifle", "idle")!.tracks.map((x) => x.name)).toEqual(["pelvis.position"]);
  });
  it("noms rendus uniques par le chargeur (« pelvis_1 ») : os du modèle et pistes des clips ramenés au nom d'origine", async () => {
    // comme GLTFLoader quand deux nœuds portent le même nom : nom unique, nom d'origine dans userData.name
    const unique = (f: VmFile) => Object.assign(f.scene.getObjectByName("pelvis")!, { name: "pelvis_1" });
    const load = vi.fn<AgentLoad>(async (name) => {
      const f = FILES[name] ? await read(FILES[name]()) : null;
      if (f && name === "agent-ct") unique(f);
      if (f && name === "anims-rifle") {
        unique(f);
        for (const c of f.clips) for (const t of c.tracks) t.name = t.name.replace(/^pelvis\./, "pelvis_1.");
      }
      return f;
    });
    const lib = new AgentLibrary(load, () => {});
    lib.preload(["CT"], ["rifle"]);
    await until(() => lib.model("CT") !== null && lib.duration("rifle", "idle") !== null);
    const m = lib.model("CT")!;
    expect([m.nodes.has("pelvis"), m.nodes.has("pelvis_1"), m.root.getObjectByName("pelvis") !== undefined]).toEqual([true, false, true]);
    expect(lib.clip(m, "rifle", "idle")!.tracks.map((t) => t.name)).toEqual(["pelvis.position"]);
  });
  it("préparation qui lève une exception (nom d'origine illisible…) : comme un échec — fichier libéré, signalé une fois, nouvel essai après RETRY_MS seulement", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const freed = vi.fn<(name: string) => void>();
    // modèle et arme : un nœud dont le nom d'origine n'est pas une chaîne (sanitizeNodeName lève une TypeError)
    const load = vi.fn<AgentLoad>(async (name) => {
      const f = await read(FILES[name === "agent-t" ? "agent-t" : "monde-ak47"]());
      f.scene.getObjectByName(name === "agent-t" ? "pelvis" : "weapon")!.userData.name = 42;
      f.scene.traverse((o) => (o as Mesh).geometry?.addEventListener("dispose", () => freed(name)));
      return f;
    });
    const changed = vi.fn(), lib = new AgentLibrary(load, changed), errors: string[] = [];
    lib.onError = (name, e) => errors.push(`${name} ${(e as Error).name}`);
    lib.model("T");
    lib.weapon("ak47");
    await until(() => errors.length === 2);
    expect(errors.sort()).toEqual(["agent-t TypeError", "monde-ak47 TypeError"]);
    expect([...new Set(freed.mock.calls.map((c) => c[0]))].sort()).toEqual(["agent-t", "monde-ak47"]);  // libérés en entier
    expect(changed).toHaveBeenCalledTimes(2);
    expect(lib.version).toBe(0);
    for (let k = 0; k < 5; k++) { lib.model("T"); lib.weapon("ak47"); }  // images suivantes : pas de nouvelle demande
    expect(load).toHaveBeenCalledTimes(2);
    now += RETRY_MS;
    lib.model("T");
    lib.weapon("ak47");
    expect(load).toHaveBeenCalledTimes(4);
    await until(() => errors.length === 4);
  });
  it("absent : version et onChange comme une arrivée ; échec : onChange seul", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const changed = vi.fn(), load = vi.fn<AgentLoad>(async (name) => {
      if (name === "agent-t") throw new LoadError("erreur 500", 500);
      return null;
    });
    const lib = new AgentLibrary(load, changed);
    lib.model("CT");
    await until(() => changed.mock.calls.length === 1);
    expect(lib.version).toBe(1);
    lib.model("T");
    await until(() => changed.mock.calls.length === 2);
    expect(lib.version).toBe(1);
  });
});

// mêmes règles que la carte et les bras (dispose.ts) : image décodée fermée juste après son premier envoi à la carte
// graphique ; contexte graphique perdu puis rendu : la bibliothèque le dit (imagesFreed), le Viewer en recrée une
describe("fichiers « joueurs » : images des textures libérées après leur envoi", () => {
  // ImageBitmap absent sous Node : image décodée factice, qui compte ses fermetures
  class Bitmap { width = 8; height = 8; closed = 0; close() { this.closed++; } }
  afterEach(() => vi.unstubAllGlobals());
  const all = (names: string[]) => names.flatMap((n) => [`${n}:géométrie`, `${n}:matériau`, `${n}:texture`]).sort();

  /** Fichiers faits à la main, chaque maillage avec sa texture (image nommée comme lui) : agent-ct (corps et kit gardés,
   *  bras de première personne à retirer), monde-ak47 (modèle sous sl_arme, et un reste hors de sl_arme), monde-glock
   *  (sans sl_arme). `freed` : libérations sur la carte graphique (événements dispose), « maillage:quoi ». `hold` : les
   *  fichiers n'arrivent qu'à `release()`. */
  function setup(hold = false) {
    vi.stubGlobal("ImageBitmap", Bitmap);
    const images = new Map<string, Bitmap>(), textures = new Map<string, Texture>(), freed: string[] = [];
    const textured = (name: string) => {
      const b = new Bitmap(), map = new Texture(b as Bitmap & ImageBitmap), geo = new BufferGeometry();
      const mat = new MeshStandardMaterial({ map }), m = new Mesh(geo, mat);
      m.name = name;
      images.set(name, b);
      textures.set(name, map);
      geo.addEventListener("dispose", () => freed.push(`${name}:géométrie`));
      mat.addEventListener("dispose", () => freed.push(`${name}:matériau`));
      map.addEventListener("dispose", () => freed.push(`${name}:texture`));
      return m;
    };
    const node = (name: string, ...children: Object3D[]) => Object.assign(new Group(), { name }).add(...children);
    const files: Record<string, () => VmFile> = {
      "agent-ct": () => ({ scene: node("agent", node("root_motion", node("pelvis", textured("thirdperson_body"),
        textured("defusekit"))), textured("firstperson_arms")), clips: [] }),
      "monde-ak47": () => ({ scene: node("scene", node("sl_arme", node("weapon", textured("corps"))), textured("reste")), clips: [] }),
      "monde-glock": () => ({ scene: node("scene", textured("glock")), clips: [] }),
    };
    let open = () => {};
    const gate = new Promise<void>((r) => { open = r; });
    const load = vi.fn<AgentLoad>(async (name) => {
      if (hold) await gate;
      return files[name]?.() ?? null;
    });
    const closed = () => [...images].filter(([, b]) => b.closed > 0).map(([n]) => n).sort();
    /** Envoi d'une texture à la carte graphique, comme three : `onUpdate` juste après (WebGLTextures.uploadTexture). */
    const upload = (name: string) => { const t = textures.get(name)!; t.onUpdate?.(t); };
    const lib = new AgentLibrary(load, () => {});
    const loadAll = async () => {
      lib.preload(["CT"], []);
      lib.weapon("ak47");
      lib.weapon("glock");
      await until(() => lib.version === 3);
      freed.sort();
    };
    return { lib, load, images, freed, closed, upload, loadAll, release: () => open() };
  }

  it("arrivés : rien de libéré de ce qui sera dessiné ; bras de première personne, reste du fichier, arme sans sl_arme : tout de suite", async () => {
    const s = setup();
    await s.loadAll();
    expect(s.closed()).toEqual(["firstperson_arms", "glock", "reste"]);
    expect(s.freed).toEqual(all(["firstperson_arms", "glock", "reste"]));
    const names: string[] = [];
    s.lib.model("CT")!.root.traverse((o) => { if ((o as Mesh).isMesh) names.push(o.name); });
    expect(names.sort()).toEqual(["defusekit", "thirdperson_body"]);  // le kit reste (agentRig.ts le montre ou le cache)
    expect(s.lib.weapon("glock")).toBeNull();
    expect(s.lib.weapon("ak47")!.getObjectByName("reste")).toBeUndefined();
    expect(s.lib.imagesFreed()).toBe(false);
    expect(s.load).toHaveBeenCalledTimes(3);  // l'arme sans sl_arme : absente, mémorisée, pas redemandée
  });

  it("arme : image fermée à son premier envoi, jamais avant ; imagesFreed ; dispose : les autres fermées, tout libéré", async () => {
    const s = setup();
    await s.loadAll();
    s.freed.length = 0;
    s.upload("corps");
    expect(s.closed()).toEqual(["corps", "firstperson_arms", "glock", "reste"]);
    expect(s.lib.imagesFreed()).toBe(true);  // contexte rendu : le Viewer recréerait la bibliothèque
    s.lib.dispose();
    expect([...s.images.values()].map((b) => b.closed)).toEqual(Array(6).fill(1));  // chacune une fois
    expect(s.freed.sort()).toEqual(all(["corps", "defusekit", "thirdperson_body"]));
  });

  it("modèle : imagesFreed après son envoi ; contexte perdu (dispose(true)) : images encore gardées fermées, rien de libéré sur la carte graphique", async () => {
    const s = setup();
    await s.loadAll();
    s.upload("thirdperson_body");
    expect(s.closed()).toContain("thirdperson_body");
    expect(s.lib.imagesFreed()).toBe(true);
    s.freed.length = 0;
    s.lib.dispose(true);
    expect([...s.images.values()].map((b) => b.closed)).toEqual(Array(6).fill(1));
    expect(s.freed).toEqual([]);  // parties avec le contexte : les libérer avertirait (« object does not belong to this context »)
  });

  it("partie retirée qui partage avec la partie gardée (géométrie, matériau, texture, image) : rien de ce qui est gardé n'est libéré", async () => {
    vi.stubGlobal("ImageBitmap", Bitmap);
    const bitmap = () => new Bitmap() as Bitmap & ImageBitmap, freed: string[] = [];
    const watch = <T extends { addEventListener(type: "dispose", f: () => void): void }>(x: T, name: string) => {
      x.addEventListener("dispose", () => freed.push(name));
      return x;
    };
    const mesh = (name: string, geo: BufferGeometry, mat: MeshStandardMaterial) => Object.assign(new Mesh(geo, mat), { name });
    const node = (name: string, ...children: Object3D[]) => Object.assign(new Group(), { name }).add(...children);
    // agent : bras de première personne avec la géométrie et le matériau du corps, gants avec la texture du corps
    const bodyImg = bitmap(), ownImg = bitmap(), bodyMap = watch(new Texture(bodyImg), "texture du corps");
    const bodyGeo = watch(new BufferGeometry(), "géométrie du corps"), bodyMat = watch(new MeshStandardMaterial({ map: bodyMap }), "matériau du corps");
    const ownMap = watch(new Texture(ownImg), "normale des gants");
    const gloveMat = watch(new MeshStandardMaterial({ map: bodyMap, normalMap: ownMap }), "matériau des gants");
    const agent = node("agent", node("pelvis", mesh("thirdperson_body", bodyGeo, bodyMat)),
      mesh("firstperson_arms", bodyGeo, bodyMat), mesh("firstperson_gloves", watch(new BufferGeometry(), "géométrie des gants"), gloveMat));
    // arme : le reste du fichier a un clone de la texture du modèle (même image, autres réglages)
    const gunImg = bitmap(), gunMap = watch(new Texture(gunImg), "texture de l'arme"), cloneMap = gunMap.clone();
    const gun = mesh("corps", new BufferGeometry(), new MeshStandardMaterial({ map: gunMap }));
    const world = node("scene", node("sl_arme", node("weapon", gun)), mesh("reste", watch(new BufferGeometry(), "géométrie du reste"),
      new MeshStandardMaterial({ map: cloneMap })));
    const files: Record<string, VmFile> = { "agent-ct": { scene: agent, clips: [] }, "monde-ak47": { scene: world, clips: [] } };
    const lib = new AgentLibrary(async (name) => files[name] ?? null, () => {});
    lib.model("CT");
    lib.weapon("ak47");
    await until(() => lib.version === 2);
    expect(freed.sort()).toEqual(["géométrie des gants", "géométrie du reste", "matériau des gants", "normale des gants"]);
    expect([bodyImg.closed, gunImg.closed, ownImg.closed]).toEqual([0, 0, 1]);
    expect([bodyMap.image, gunMap.image]).toEqual([bodyImg, gunImg]);
    // la partie gardée suit ensuite la règle commune : image fermée à son premier envoi
    bodyMap.onUpdate?.(bodyMap);
    gunMap.onUpdate?.(gunMap);
    expect([bodyImg.closed, gunImg.closed]).toEqual([1, 1]);
  });

  it("fichier arrivé après dispose : libéré, images comprises (jamais dessiné)", async () => {
    const s = setup(true);
    s.lib.weapon("ak47");
    s.lib.dispose();
    s.release();
    await until(() => s.closed().length === 2);
    expect(s.closed()).toEqual(["corps", "reste"]);
    expect(s.freed.sort()).toEqual(all(["corps", "reste"]));
  });

  // préchauffage du premier affichage (essai réel : 488 puis 308 ms à la première image des agents sans lui)
  /** Rendu qui sait compiler (compilations tenues jusqu'à `done()`) et envoyer une texture (`onUpdate` ensuite, comme
   *  three) ; `sent()` : noms des maillages dont la texture est partie, dans l'ordre. */
  function warmer() {
    const opens: (() => void)[] = [];
    const r = {
      compileAsync: vi.fn((_o: Object3D, _c: unknown, _s: unknown) => new Promise<void>((ok) => { opens.push(ok); })),
      initTexture: vi.fn((t: Texture) => t.onUpdate?.(t)),
    };
    // texture → nom de son maillage (l'image est libérée à l'envoi : on ne peut pas la relire ensuite)
    const names = new Map<Texture, string>();
    const sent = () => r.initTexture.mock.calls.map(([t]) => names.get(t));
    const know = (...roots: Object3D[]) => roots.forEach((root) => root.traverse((o) => {
      const m = (o as Mesh).material as MeshStandardMaterial | undefined;
      if (m?.map) names.set(m.map, o.name);
    }));
    const done = async () => { opens.splice(0).forEach((ok) => ok()); await new Promise((ok) => setTimeout(ok, 0)); };
    return { r: r as unknown as WebGLRenderer & typeof r, sent, know, done };
  }
  const camera = new Group() as unknown as Camera, scene = new Scene();

  it("préchauffage : modèle et arme rendus seulement une fois compilés (dans la scène du monde) et leurs textures envoyées, WARM_PER_FRAME par image ; puis plus rien", async () => {
    const s = setup(), changed = vi.fn(), lib = new AgentLibrary(s.load, changed);
    lib.preload(["CT"], []);
    lib.weapon("ak47");
    lib.weapon("glock");
    await until(() => lib.version === 3);
    expect(lib.model("CT")).not.toBeNull();  // sans préchauffage (tests, faux rendus) : rendu tout de suite
    const w = warmer(), root = lib.model("CT")!.root, gun = lib.weapon("ak47")!;
    w.know(root, gun);
    changed.mockClear();
    expect(WARM_PER_FRAME).toBe(2);
    expect(lib.warm(w.r, camera, scene)).toBe(true);  // une texture de l'arme reste à envoyer
    expect(w.r.compileAsync.mock.calls).toEqual([[root, camera, scene], [gun, camera, scene]]);
    expect(w.sent()).toEqual(["thirdperson_body", "defusekit"]);  // deux par image
    expect(s.closed()).toContain("thirdperson_body");  // image libérée après l'envoi (MEM3D)
    expect([lib.model("CT"), lib.weapon("ak47"), lib.version]).toEqual([null, null, 3]);  // pas encore prêts
    expect(lib.warm(w.r, camera, scene)).toBe(false);  // tout envoyé, compilations en cours : rien à faire à l'image
    expect(w.sent()).toEqual(["thirdperson_body", "defusekit", "corps"]);
    expect([lib.model("CT"), lib.weapon("ak47")]).toEqual([null, null]);
    await w.done();
    expect(changed).toHaveBeenCalledTimes(2);  // une compilation finie : une image de plus
    expect(lib.warm(w.r, camera, scene)).toBe(false);
    expect(lib.model("CT")!.root).toBe(root);
    expect(lib.weapon("ak47")).toBe(gun);
    expect(lib.version).toBe(5);  // chaque prêt : poses refaites, arme montée
    lib.warm(w.r, camera, scene);
    expect([w.r.compileAsync.mock.calls.length, w.r.initTexture.mock.calls.length, lib.version]).toEqual([2, 3, 5]);
  });

  it("préchauffage : compileAsync qui lève tout de suite (exception synchrone) : le modèle est rendu quand même, la couche n'est pas retirée", async () => {
    const s = setup(), changed = vi.fn(), lib = new AgentLibrary(s.load, changed);
    lib.preload(["CT"], []);
    await until(() => lib.version === 1);
    const w = warmer();
    w.r.compileAsync.mockImplementationOnce(() => { throw new Error("contexte indisponible"); });
    expect(() => lib.warm(w.r, camera, scene)).not.toThrow();
    expect(lib.model("CT")).toBeNull();  // pas encore : l'échec est traité comme une fin de compilation, à l'image suivante
    await w.done();
    expect(changed).toHaveBeenCalled();
    lib.warm(w.r, camera, scene);
    expect(lib.model("CT")).not.toBeNull();
  });

  it("préchauffage : compilation qui ne se termine jamais : rendu quand même passé COMPILE_TIMEOUT_MS", async () => {
    const s = setup(), changed = vi.fn(), lib = new AgentLibrary(s.load, changed);
    lib.preload(["CT"], []);
    await until(() => lib.version === 1);
    const w = warmer();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      lib.warm(w.r, camera, scene);
      changed.mockClear();
      await vi.advanceTimersByTimeAsync(COMPILE_TIMEOUT_MS - 1);
      expect(changed).not.toHaveBeenCalled();
      lib.warm(w.r, camera, scene);
      expect(lib.model("CT")).toBeNull();  // toujours en attente
      await vi.advanceTimersByTimeAsync(2);
      expect(changed).toHaveBeenCalledTimes(1);  // une image de plus
      lib.warm(w.r, camera, scene);
      expect(lib.model("CT")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
    await w.done();  // la promesse se résout enfin : rien de plus
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("préchauffage : dispose(true) (contexte perdu) pendant une compilation : ni onChange, ni délai qui court, ni erreur", async () => {
    const s = setup(), changed = vi.fn(), lib = new AgentLibrary(s.load, changed);
    lib.preload(["CT"], []);
    await until(() => lib.version === 1);
    const w = warmer();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      lib.warm(w.r, camera, scene);
      changed.mockClear();
      const v = lib.version;
      lib.dispose(true);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(COMPILE_TIMEOUT_MS * 2);
      expect(changed).not.toHaveBeenCalled();
      expect(lib.version).toBe(v);
    } finally {
      vi.useRealTimers();
    }
    await w.done();  // la compilation se résout après coup : rien
    expect(changed).not.toHaveBeenCalled();
    expect(lib.warm(w.r, camera, scene)).toBe(false);
    expect(lib.model("CT")).toBeNull();
  });

  it("préchauffage : fichier arrivé après le premier préchauffage retenu jusqu'à prêt ; compilation en échec : prêt quand même ; rendu sans compileAsync ni initTexture : rien de retenu ; dispose pendant une compilation : plus d'onChange", async () => {
    const s = setup(), changed = vi.fn(), lib = new AgentLibrary(s.load, changed);
    lib.preload(["CT"], []);
    await until(() => lib.version === 1);
    const w = warmer();
    w.r.compileAsync.mockImplementationOnce(async () => { throw new Error("programme refusé"); });
    lib.warm(w.r, camera, scene);
    await w.done();
    lib.warm(w.r, camera, scene);
    expect(lib.model("CT")).not.toBeNull();  // compilé au premier affichage, comme sans préchauffage
    lib.weapon("ak47");
    await until(() => lib.version === 3);  // arrivée, puis le modèle prêt
    expect(lib.weapon("ak47")).toBeNull();  // préchauffage en cours : retenue
    lib.warm(w.r, camera, scene);
    await w.done();
    lib.warm(w.r, camera, scene);
    expect(lib.weapon("ak47")).not.toBeNull();
    // faux rendu des tests du Viewer : rien de retenu
    const fake = setup(), plain = new AgentLibrary(fake.load, () => {});
    plain.preload(["CT"], []);
    await until(() => plain.version === 1);
    expect(plain.warm({} as WebGLRenderer, camera, scene)).toBe(false);
    expect(plain.model("CT")).not.toBeNull();
    // dispose pendant une compilation : rien après
    const late = setup(), calls = vi.fn(), gone = new AgentLibrary(late.load, calls);
    gone.preload(["CT"], []);
    await until(() => gone.version === 1);
    const w2 = warmer();
    gone.warm(w2.r, camera, scene);
    calls.mockClear();
    gone.dispose();
    await w2.done();
    expect(calls).not.toHaveBeenCalled();
    expect(gone.warm(w2.r, camera, scene)).toBe(false);
  });
});

describe("agent équipé", () => {
  it("son modèle s'il est sur le serveur, sinon celui du camp ; nom inattendu : celui du camp", async () => {
    const load = loader(), lib = new AgentLibrary(load, () => {});
    expect(lib.model("T", "tm_leet_variantf")).toBeNull();
    await until(() => lib.model("T", "tm_leet_variantf")?.file === "agent-tm_leet_variantf");
    await until(() => lib.model("T", "tm_phoenix_varianth")?.file === "agent-t");  // absent du serveur : Phoenix
    expect(lib.model("T", "../x")?.file).toBe("agent-t");
    expect(load.mock.calls.map((c) => c[0]).sort()).toEqual(["agent-t", "agent-tm_leet_variantf", "agent-tm_phoenix_varianth"]);
  });
  it("appels répétés sur la même paire (camp, agent) : même résultat, aucune nouvelle demande, aucune validation refaite", async () => {
    const load = loader(), lib = new AgentLibrary(load, () => {});
    lib.model("T", "tm_leet_variantf");
    lib.model("T", "agent_inconnu");
    lib.model("T", "../x");
    await until(() => lib.model("T", "tm_leet_variantf") !== null && lib.model("T", "agent_inconnu") !== null);
    const asked = load.mock.calls.length, own = lib.model("T", "tm_leet_variantf"), camp = lib.model("T", "agent_inconnu");
    const test = vi.spyOn(RegExp.prototype, "test");
    for (let i = 0; i < 50; i++) {
      expect(lib.model("T", "tm_leet_variantf")).toBe(own);
      expect(lib.model("T", "agent_inconnu")).toBe(camp);
      expect(lib.model("T", "../x")).toBe(camp);
      expect(lib.model("T")).toBe(camp);
    }
    expect(test).not.toHaveBeenCalled();  // nom déjà validé : pas d'expression régulière
    expect(load).toHaveBeenCalledTimes(asked);
    expect(agentNameFile("../x")).toBeNull();
    expect(agentNameFile("tm_leet_variantf")).toBe("agent-tm_leet_variantf");
  });

  describe("plafond des agents équipés gardés", () => {
    const NAMES = Array.from({ length: MAX_EQUIPPED + 4 }, (_, i) => `a${i}`);
    const files = { ...FILES, ...Object.fromEntries(NAMES.map((n) => [`agent-${n}`, agentGlb])) };
    /** Géométries d'un modèle, et espions de leur libération. */
    const geoms = (root: Object3D) => { const g: BufferGeometry[] = []; root.traverse((o) => { if ((o as Mesh).isMesh) g.push((o as Mesh).geometry); }); return g; };
    const ask = async (lib: AgentLibrary, n: string) => { lib.model("T", n); await until(() => lib.model("T", n)?.file === `agent-${n}`); };
    it("au-delà du plafond, le moins récemment utilisé est libéré ; redemandé, il est rechargé ; les camps ne le sont jamais", async () => {
      const load = loader(files), lib = new AgentLibrary(load, () => {});
      await until(() => lib.model("T") !== null && lib.model("CT") !== null);
      const camp = [...geoms(lib.model("T")!.root), ...geoms(lib.model("CT")!.root)].map((g) => vi.spyOn(g, "dispose"));
      for (const n of NAMES.slice(0, MAX_EQUIPPED)) await ask(lib, n);
      const second = lib.model("T", "a1")!;
      for (const n of NAMES.slice(0, MAX_EQUIPPED)) if (n !== "a1") lib.model("T", n);  // tous redemandés sauf a1 : le plus ancien
      const first = lib.model("T", "a0")!;
      const gone = geoms(second.root).map((g) => vi.spyOn(g, "dispose")), kept = geoms(first.root).map((g) => vi.spyOn(g, "dispose"));
      await ask(lib, NAMES[MAX_EQUIPPED]);
      expect(gone.every((d) => d.mock.calls.length > 0)).toBe(true);
      expect(kept.every((d) => d.mock.calls.length === 0)).toBe(true);
      expect(lib.model("T", "a0")).toBe(first);
      const asked = load.mock.calls.length;
      expect(lib.model("T", "a1")?.file).toBe("agent-t");  // libéré : le camp en attendant
      await until(() => lib.model("T", "a1")?.file === "agent-a1");
      expect(load.mock.calls.length).toBe(asked + 1);
      expect(lib.model("T", "a1")).not.toBe(second);  // rechargé : modèle neuf
      expect(camp.every((d) => d.mock.calls.length === 0)).toBe(true);
    });
    it("jamais un modèle encore posé sur un joueur (inUse) ni un agent nommé comme un camp", async () => {
      const lib = new AgentLibrary(loader({ ...files, "agent-ct": agentGlb }), () => {});
      lib.inUse = (f) => f === "agent-a0";
      await ask(lib, "a0");
      const a0 = lib.model("T", "a0")!, g = geoms(a0.root).map((x) => vi.spyOn(x, "dispose"));
      for (const n of NAMES.slice(1)) await ask(lib, n);
      expect(lib.model("T", "a0")).toBe(a0);
      expect(g.every((d) => d.mock.calls.length === 0)).toBe(true);
      expect(lib.model("T", "ct")?.file).toBe("agent-t");  // « ct » valide mais est le fichier d'un camp, pas un agent équipé
    });
    it("un match entier (10 joueurs, 10 agents par camp, 20 en tout) : aller-retour à la mi-temps sans aucun rechargement", async () => {
      const load = loader(files), lib = new AgentLibrary(load, () => {});
      const first = NAMES.slice(0, 10), second = NAMES.slice(10, 20);
      let posed = new Set<string>();
      lib.inUse = (f) => posed.has(f);
      const half = async (names: string[]) => {
        posed = new Set(names.map((n) => `agent-${n}`));
        for (const n of names) await ask(lib, n);
      };
      await half(first);
      const models = new Map(first.map((n) => [n, lib.model("T", n)!]));
      await half(second);
      const asked = load.mock.calls.length;
      posed = new Set(first.map((n) => `agent-${n}`));
      for (const n of first) expect(lib.model("T", n)).toBe(models.get(n));  // mi-temps suivante : les mêmes, toujours là
      await half(second);
      expect(load.mock.calls.length).toBe(asked);
    });
  });
});

describe("fichier « ragdoll »", () => {
  it("lu au premier appel dans les extras de sa scène, une seule fois", async () => {
    const load = loader(), lib = new AgentLibrary(load, () => {});
    expect(lib.ragdoll()).toBeNull();
    await until(() => lib.ragdoll() !== null);
    expect(lib.ragdoll()).toEqual(AGENT_RAGDOLL);
    expect(load.mock.calls.filter((c) => c[0] === "ragdoll")).toHaveLength(1);
  });
  it("absent du serveur : null, jamais redemandé ; illisible : null, signalé (les morts gardent leurs clips)", async () => {
    const { ragdoll: _gone, ...rest } = FILES;
    const load = loader(rest), lib = new AgentLibrary(load, () => {});
    lib.ragdoll();
    await until(() => lib.version === 1);
    expect(lib.ragdoll()).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const bad = new AgentLibrary(loader({ ...FILES, ragdoll: () => ragdollGlb({ v: 9 }) }), () => {}), errors: string[] = [];
    bad.onError = (name) => { errors.push(name); };
    bad.ragdoll();
    await until(() => errors.length === 1);
    expect(errors).toEqual(["ragdoll"]);
    expect(bad.ragdoll()).toBeNull();
  });
  it("contenu refusé (readRagdollFile) : signalé une fois, jamais redemandé (même après RETRY_MS) ; erreur réseau : nouvel essai après RETRY_MS", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const load = loader({ ...FILES, ragdoll: () => ragdollGlb({ v: 9 }) }), bad = new AgentLibrary(load, () => {}), errors: string[] = [];
    bad.onError = (name) => { errors.push(name); };
    bad.ragdoll();
    await until(() => bad.version === 1);
    expect([bad.ragdoll(), errors]).toEqual([null, ["ragdoll"]]);
    now += 10 * RETRY_MS;
    for (let k = 0; k < 3; k++) bad.ragdoll();
    await new Promise((r) => setTimeout(r, 0));
    expect(load.mock.calls.filter((c) => c[0] === "ragdoll")).toHaveLength(1);
    expect([errors.length, warn.mock.calls.length]).toEqual([1, 1]);
    // erreur réseau (404 d'un fichier ré-exporté…) : transitoire, réessayée
    const net = vi.fn<AgentLoad>(async () => { throw new LoadError("erreur 404", 404); }), lib = new AgentLibrary(net, () => {});
    lib.onError = (name) => { errors.push(name); };
    lib.ragdoll();
    await until(() => errors.length === 2);
    lib.ragdoll();
    expect(net).toHaveBeenCalledTimes(1);
    now += RETRY_MS;
    lib.ragdoll();
    expect(net).toHaveBeenCalledTimes(2);
  });
});
