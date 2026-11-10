// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Box3, BufferGeometry, Color, DirectionalLight, Float32BufferAttribute, Group, HemisphereLight, Line, type Material, Mesh,
  MeshLambertMaterial, type MeshStandardMaterial, type Object3D, type PerspectiveCamera, Quaternion, type Scene, ShaderLib,
  Sprite, Texture, Vector3, type WebGLProgramParametersWithUniforms, type WebGLRenderer } from "three";
import type { GrenadeEvent } from "../../shared/api/types";
import type { Replay } from "../replay/engine/replay";
import type { PlayerState } from "../replay/engine/state";
import type { Theme } from "../replay/renderer/theme";
import { warmAgentAnim } from "./agentAnim";
import { AgentLayer } from "./agentLayer";
import { AgentRig } from "./agentRig";
import { AgentLibrary, type AgentLoad } from "./agents";
import { NO_CUT } from "./cameras";
import { disposeTree } from "./dispose";
import { parseGlbAnimated } from "./loader";
import { RagdollEngine, type RagdollIn, type RagdollOut } from "./ragdollEngine";
import { type RagdollPort, Ragdolls } from "./ragdolls";
import { agentGlb, animsGlb, armsGlb, COMMON_CLIPS, mondeGlb, ragdollGlb, weaponGlb } from "./testGlb";
import { abovePlanes, applyCutaway, cutUniforms, disposeTree as viewerDisposeTree, followKey, sceneLights, setCut, Viewer,
  watchContext } from "./viewer";
import { type VmFile, type VmLoad, ViewModel } from "./viewmodel";

// pas de WebGL sous jsdom : un rendu factice note, à chaque image, la scène, la caméra, si la découpe locale est activée,
// l'effacement automatique et la chaîne de couleur (tone mapping, exposition, espace de couleur) ; et l'effacement de la
// profondeur (2e passe des bras). Reflets des bras (PMREM) sans WebGL : aucun, seulement comptés. Envoi des textures à la
// carte graphique comme three : celles des objets dessinés (visibles), une fois par contexte, leur image lue puis
// `onUpdate` ; sans image, rien n'est envoyé et la texture est notée dans `blank` (three avertit, à chaque image, et
// dessine une texture vide). Contexte rendu : tout est oublié, à renvoyer (écouteur posé par le rendu avant celui du
// Viewer, comme dans three)
const fake = vi.hoisted(() => ({
  renders: [] as { scene: unknown; camera?: unknown; local: boolean; autoClear?: boolean; color?: string }[],
  pmrem: 0,
  blank: [] as string[],
}));
vi.mock("three", async (importOriginal) => ({
  ...(await importOriginal<typeof import("three")>()),
  WebGLRenderer: class {
    localClippingEnabled = false;
    autoClear = true;
    toneMapping = 0;  // NoToneMapping, comme le vrai rendu
    toneMappingExposure = 1;
    outputColorSpace = "srgb";
    private sent = new WeakSet<object>();
    constructor(p: { canvas?: HTMLCanvasElement } = {}) {
      p.canvas?.addEventListener("webglcontextrestored", () => { this.sent = new WeakSet(); });
    }
    setPixelRatio() {}
    setSize() {}
    dispose() {}
    clearDepth() { fake.renders.push({ scene: "profondeur", local: this.localClippingEnabled }); }
    render(scene: Object3D, camera: unknown) {
      fake.renders.push({ scene, camera, local: this.localClippingEnabled, autoClear: this.autoClear,
        color: `${this.toneMapping} ${this.toneMappingExposure} ${this.outputColorSpace}` });
      scene.traverseVisible((o) => {
        const m = (o as Mesh).material;
        for (const mat of Array.isArray(m) ? m : m ? [m] : [])
          for (const t of Object.values(mat) as Texture[]) {
            if (!t?.isTexture || t.isRenderTargetTexture || this.sent.has(t)) continue;
            if (t.image === null) { fake.blank.push(t.name); continue; }
            this.sent.add(t);
            t.onUpdate?.(t);
          }
      });
    }
  },
  PMREMGenerator: class { fromScene() { fake.pmrem++; return { texture: null }; } dispose() {} },
}));
// préchauffage du round des modèles d'agents : le vrai, appels notés
vi.mock("./agentAnim", async (importOriginal) => {
  const m = await importOriginal<typeof import("./agentAnim")>();
  return { ...m, warmAgentAnim: vi.fn(m.warmAgentAnim) };
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); fake.renders.length = 0; fake.pmrem = 0; fake.blank.length = 0; });

// ImageBitmap absent de jsdom : image décodée factice (textures de la carte et des bras), qui compte ses fermetures
class Bitmap { width = 64; height = 64; closed = 0; close() { this.closed++; this.width = this.height = 0; } }

describe("coupe de la carte", () => {
  it("la coupe « au-dessus de » est dans le shader de la carte (uniforme, sans plan de découpe global)", () => {
    const mat = new MeshLambertMaterial(), root = new Group().add(new Mesh(undefined, mat)), u = cutUniforms();
    applyCutaway(root, u);
    const sh = { uniforms: {}, vertexShader: ShaderLib.lambert.vertexShader, fragmentShader: ShaderLib.lambert.fragmentShader };
    mat.onBeforeCompile(sh as unknown as WebGLProgramParametersWithUniforms, undefined as unknown as WebGLRenderer);
    expect(sh.uniforms).toMatchObject({ uCutAboveZ: u.uCutAboveZ, uCutR: u.uCutR });
    expect(sh.vertexShader).toContain("vCutPos = ");
    expect(sh.fragmentShader).toContain("uniform float uCutR, uCutFloorZ, uCutAboveZ;");
    expect(sh.fragmentShader).toContain("if (vCutPos.z > uCutAboveZ) discard;");
    expect(u.uCutAboveZ.value).toBeGreaterThanOrEqual(1e9);  // rien de coupé hors de la vue de dessus
  });
  it("mélanges par multiplication du jeu (sourceMaterials) : couleur neutre là où la texture est transparente", () => {
    const mat = new MeshLambertMaterial(), root = new Group().add(new Mesh(undefined, mat));
    applyCutaway(root, cutUniforms());
    const sh = { uniforms: {}, vertexShader: ShaderLib.basic.vertexShader, fragmentShader: ShaderLib.basic.fragmentShader };
    mat.onBeforeCompile(sh as unknown as WebGLProgramParametersWithUniforms, undefined as unknown as WebGLRenderer);
    // après l'encodage sRGB : le mélange se fait sur les valeurs écrites dans l'image
    expect(sh.fragmentShader).toMatch(/#include <colorspace_fragment>\s*#ifdef SL_BLEND_NEUTRAL\s*gl_FragColor\.rgb = mix\(vec3\(SL_BLEND_NEUTRAL\), gl_FragColor\.rgb, gl_FragColor\.a\);/);
  });
  // three jette un fragment quand distanceToPoint < 0 pour l'un des plans du matériau (clipping_planes_fragment)
  it("trajectoires et croix : leur plan garde ce qui est sous la coupe de la carte, et tout hors de la vue de dessus", () => {
    const u = cutUniforms(), above = abovePlanes(), plane = above[0];
    setCut(u, above, { ...NO_CUT, aboveZ: 620 });
    expect(u.uCutAboveZ.value).toBe(620);
    expect(plane.distanceToPoint(new Vector3(0, 0, 600))).toBeGreaterThan(0);
    expect(plane.distanceToPoint(new Vector3(0, 0, 640))).toBeLessThan(0);
    setCut(u, above, NO_CUT);
    // toujours le même plan, rejeté au loin : leur nombre ne change pas, les shaders ne sont pas recompilés
    expect(above).toEqual([plane]);
    expect(plane.distanceToPoint(new Vector3(0, 0, 1e6))).toBeGreaterThan(0);
  });
});

describe("vue de dessus : ce qui est au-dessus de la coupe", () => {
  // joueur suivi a au sol de l'étage du bas (z 500), joueur b à l'étage du dessus (z 900, x 1000) ; en haut aussi : une
  // smoke, une mort et la bombe (x -1000) ; en bas : une autre smoke
  const smoke = (id: number, z: number): GrenadeEvent => ({ id, type: "smoke", thrower: "a", throw_tick: 0,
    throw_pos: [0, 0, z], detonate_tick: 10, detonate_pos: [0, 0, z], end_tick: 1000, trajectory: [[0, 0, 0, z], [10, 0, 0, z]] });
  const replay = {
    ticks: new Int32Array([0, 640]), n: 2, tickrate: 64,
    players: [{ steamid: "a", name: "a", side: "CT", slot: 1, index: 0 }, { steamid: "b", name: "b", side: "T", slot: 2, index: 1 }],
    value: (k: string, _i: number, j: number) => ({ flags: 1, hp: 100, z: [500, 900][j], x: [0, 1000][j] } as Record<string, number>)[k] ?? 0,
    weaponAt: () => "", inventoryAt: () => [], has: () => false, crosshairOf: () => null, viewmodelOf: () => null,
    payload: { map_name: "de_nuke", grenades: [smoke(1, 500), smoke(2, 900)],
      kills: [{ tick: 5, attacker: "x", victim: "y", victim_pos: [0, 0, 900] }],
      bomb: [{ tick: 5, type: "plant", player: "b", site: "A", pos: [-1000, 0, 900] }] },
  } as unknown as Replay;
  const theme: Theme = { ct: "#5d9cec", t: "#e8b04b", smoke: "#cccccc", fire: "#ff6a00", flash: "#ffffff",
    he: "#ff3b3b", fg: "#e6e9ec", bg: "#0c0f12", accent: "#2ee6a6" };
  const planes = (o: Object3D) => (o as Mesh).material ? ((o as Mesh).material as Material).clippingPlanes ?? [] : [];
  // objets dessinés à la dernière image (eux et tous leurs parents visibles)
  const drawn = () => {
    const out: Object3D[] = [];
    (fake.renders.at(-1)!.scene as Object3D).traverse((o) => {
      if (!(o instanceof Mesh || o instanceof Line || o instanceof Sprite)) return;
      for (let x: Object3D | null = o; x; x = x.parent) if (!x.visible) return;
      out.push(o);
    });
    return out;
  };

  it("grenade et bombe cachées, trajectoires et croix coupées au plan, joueurs entiers ; rien hors de la vue de dessus", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => frames.push(f));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    // pas de canvas 2D sous jsdom : un contexte qui ne dessine rien suffit aux étiquettes
    const ctx = new Proxy({}, { get: () => () => {}, set: () => true });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as never);
    const gl = { isContextLost: () => false } as unknown as WebGL2RenderingContext, onFail = vi.fn();
    const v = new Viewer(document.createElement("canvas"), gl, theme, onFail);
    v.setFrame(replay, 320, "a");
    v.setMode("top");
    frames.at(-1)!(performance.now());
    expect(onFail).not.toHaveBeenCalled();
    expect(fake.renders.at(-1)!.local).toBe(true);  // sans quoi three ignore les plans des matériaux
    const clipped = drawn().filter((o) => planes(o).length);
    expect(clipped.filter((o) => o instanceof Line)).toHaveLength(2);  // trajectoires
    expect(clipped.filter((o) => o instanceof Mesh)).toHaveLength(2);  // les deux barres de la croix
    for (const o of clipped) expect(planes(o)[0].constant).toBe(620);  // joueur suivi + 120
    // au-dessus de la coupe, sans plan : le corps et l'étiquette du joueur b, rien d'autre (smoke du haut, bombe)
    const above = drawn().filter((o) => !planes(o).length && o.position.z > 620);
    expect(above).toHaveLength(2);
    for (const o of above) expect(o.position.x).toBe(1000);
    // la smoke de l'étage suivi reste pleine
    expect(drawn().some((o) => o instanceof Mesh && !o.userData.sid && o.position.z > 500 && o.position.z < 620)).toBe(true);

    v.setMode("follow");
    frames.at(-1)!(performance.now());
    expect(fake.renders).toHaveLength(2);
    for (const o of drawn().filter((x) => planes(x).length)) expect(planes(o)[0].constant).toBeGreaterThanOrEqual(1e9);
    expect(drawn().some((o) => o.position.x === -1000)).toBe(true);  // la bombe
    expect(drawn().filter((o) => !planes(o).length && o.position.z > 900 && o.position.x === 0)).toHaveLength(1);  // smoke du haut
    v.dispose();
  });
});

describe("vue du joueur : joueur suivi caché, HUD prévenu", () => {
  // a (choisi) en x 0, b en x 500, vivants ; `hp` : vie de a
  const replay = (hp: number) => ({
    ticks: new Int32Array([0, 640]), n: 2, tickrate: 64,
    players: [{ steamid: "a", name: "a", side: "CT", slot: 1, index: 0 }, { steamid: "b", name: "b", side: "T", slot: 1, index: 1 }],
    value: (k: string, _i: number, j: number) => ({ flags: 1, hp: [hp, 100][j], x: [0, 500][j] } as Record<string, number>)[k] ?? 0,
    weaponAt: () => "AK-47", inventoryAt: () => [], has: () => false, crosshairOf: () => null, viewmodelOf: () => null, agentOf: () => null, punchAt: () => [0, 0],
    freezeEndTick: 0, endTick: 640,
    payload: { map_name: "de_nuke", grenades: [], kills: [], bomb: [], players: [] },
  }) as unknown as Replay;
  const theme: Theme = { ct: "#5d9cec", t: "#e8b04b", smoke: "#cccccc", fire: "#ff6a00", flash: "#ffffff",
    he: "#ff3b3b", fg: "#e6e9ec", bg: "#0c0f12", accent: "#2ee6a6" };
  const setup = () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => frames.push(f));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const ctx = new Proxy({}, { get: () => () => {}, set: () => true });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as never);
    const gl = { isContextLost: () => false } as unknown as WebGL2RenderingContext;
    const v = new Viewer(document.createElement("canvas"), gl, theme, vi.fn());
    const seen: (string | null)[] = [];
    v.onFollow = (p) => { seen.push(p ? `${p.steamid}:${p.hp}` : null); };
    return { v, seen, frame: () => frames.at(-1)!(performance.now()) };
  };
  // corps dessinés à la dernière image (eux et leurs parents visibles)
  const bodies = () => {
    const out: string[] = [];
    (fake.renders.at(-1)!.scene as Object3D).traverse((o) => {
      for (let x: Object3D | null = o; x; x = x.parent) if (!x.visible) return;
      if (o.userData.sid) out.push(o.userData.sid as string);
    });
    return out.sort();
  };

  it("le joueur suivi n'est pas dessiné en vue du joueur ; il revient dans les autres caméras", () => {
    const { v, frame } = setup();
    v.setFrame(replay(100), 320, "a");
    v.setMode("pov");
    frame();
    expect(v.followed()?.steamid).toBe("a");
    expect(bodies()).toEqual(["b"]);
    v.setFrame(replay(100), 320, "b");  // autre joueur choisi, sans changer d'instant ni de caméra
    frame();
    expect(bodies()).toEqual(["a"]);
    v.setMode("follow");
    frame();
    expect(bodies()).toEqual(["a", "b"]);
    v.dispose();
  });

  it("onFollow : une fois par changement de joueur ou de ce que montre le HUD, pas à chaque image", () => {
    const { v, seen, frame } = setup();
    v.setFrame(replay(100), 320, "a");
    v.setMode("pov");
    frame();
    frame();
    v.setFrame(replay(100), 400, "a");  // autre instant, même HUD
    frame();
    expect(seen).toEqual(["a:100"]);
    v.setFrame(replay(80), 410, "a");
    frame();
    expect(seen).toEqual(["a:100", "a:80"]);
    v.setMode("top");
    frame();
    expect(seen).toEqual(["a:100", "a:80", null]);
    expect(v.followed()).toBeNull();
    v.dispose();
  });

  it("onBoard (barre de score, fil des kills) : en vue du joueur seulement, une fois par changement de ce qu'il montre", () => {
    const { v, frame } = setup();
    const boards: string[] = [];
    v.onBoard = (b) => { boards.push(`${b.clock.label} ${b.ct.map((p) => p.hp)}|${b.t.map((p) => p.hp)}`); };
    v.setFrame(replay(100), 320, "a");
    v.setMode("follow");
    frame();
    expect(boards).toEqual([]);  // hors vue du joueur : rien n'est calculé
    v.setMode("pov");
    frame();
    frame();
    expect(boards).toEqual(["1:50 100|100"]);
    v.setFrame(replay(100), 330, "a");  // autre instant, même seconde affichée, mêmes joueurs
    frame();
    expect(boards).toHaveLength(1);
    v.setFrame(replay(80), 340, "a");
    frame();
    expect(boards).toEqual(["1:50 100|100", "1:50 80|100"]);
    v.setFrame(replay(80), 64 * 6, "a");  // une seconde de moins à l'horloge
    frame();
    expect(boards.at(-1)).toBe("1:49 80|100");
    v.dispose();
  });

  it("cadrage sur la fenêtre : la vue 3D redimensionnée, puis la fenêtre seule, refont l'image avec le bon angle", () => {
    const { v, frame } = setup();
    const before = [window.innerWidth, window.innerHeight];
    try {
      Object.assign(window, { innerWidth: 1024, innerHeight: 768 });
      v.resize(948, 627);
      v.setFrame(replay(100), 320, "a");
      v.setMode("pov");
      frame();
      expect(v.rig.persp.fov).toBeCloseTo(66.96, 2);
      const n = fake.renders.length;
      frame();
      expect(fake.renders).toHaveLength(n);  // rien n'a changé : pas de nouvelle image
      Object.assign(window, { innerWidth: 1280, innerHeight: 720 });
      window.dispatchEvent(new Event("resize"));  // la vue 3D garde sa taille, la fenêtre non
      frame();
      expect(fake.renders).toHaveLength(n + 1);
      expect(v.rig.persp.fov).toBeCloseTo(82.82, 2);
      expect(v.rig.persp.near).toBe(4);
    } finally {
      Object.assign(window, { innerWidth: before[0], innerHeight: before[1] });
      v.dispose();
    }
  });

  it("clé du HUD : ni la position ni le regard, mais la vie, l'arme, les munitions et la lunette", () => {
    const base: PlayerState = { steamid: "a", name: "a", side: "CT", slot: 1, x: 0, y: 0, z: 0, yaw: 0, hp: 100,
      armor: 100, alive: true, helmet: false, defuser: false, hasBomb: false, defusing: false, scoped: false, flash: 0,
      money: 800, weapon: "AK-47", inventory: ["AK-47"], equip: 0, pitch: 0, duck: 0, airborne: false, clip: 30,
      reserve: 90, zoom: 0, keys: 0, crosshair: null, fov: 0, viewmodel: null };
    const k = followKey(base);
    expect(followKey({ ...base, x: 50, yaw: 90, pitch: 10, duck: 1, keys: 64, flash: 1 })).toBe(k);
    for (const over of [{ hp: 99 }, { clip: 29 }, { reserve: null }, { weapon: "USP-S" }, { scoped: true }, { zoom: 2 },
      { money: 0 }, { inventory: [] }, { crosshair: "CSGO-y9Qw8-sCzPb-jORFu-ov6L8-GwMXL" }, { helmet: true },
      { slot: 2 }, { hasBomb: true }, { defuser: true }]) {
      expect(followKey({ ...base, ...over })).not.toBe(k);
    }
    expect(followKey(null)).toBe("");
  });
});

describe("vue du joueur : recul de la caméra et voile blanc des flashs", () => {
  // images toutes les 64 ticks (1 s) de 0 à 640 ; a (joueur 0) est aveuglé 3 s dès le tick 128 (champ « flash » brut : 3, tenu
  // pendant ≈ 1,4 fois la durée), b non. Recul de a : -2° à la verticale du tick 128 au tick 256, rien ensuite (comme punchAt)
  const punchAt = vi.fn((j: number, tick: number): [number, number] => (j === 0 && tick >= 128 && tick <= 256 ? [-2, 0] : [0, 0]));
  const replay = () => ({
    ticks: Int32Array.from({ length: 11 }, (_, i) => i * 64), n: 11, tickrate: 64,
    players: [{ steamid: "a", name: "a", side: "CT", slot: 1, index: 0 }, { steamid: "b", name: "b", side: "T", slot: 1, index: 1 }],
    value: (k: string, i: number, j: number) => ({ flags: 1, hp: 100, x: [0, 500][j], flash: j === 0 && i >= 2 && i <= 6 ? 3 : 0 } as Record<string, number>)[k] ?? 0,
    weaponAt: () => "AK-47", inventoryAt: () => [], has: (k: string) => k === "flash", crosshairOf: () => null, viewmodelOf: () => null,
    punchAt, freezeEndTick: 0, endTick: 640,
    payload: { map_name: "de_nuke", grenades: [], kills: [], bomb: [], players: [] },
  }) as unknown as Replay;
  const theme: Theme = { ct: "#5d9cec", t: "#e8b04b", smoke: "#cccccc", fire: "#ff6a00", flash: "#ffffff",
    he: "#ff3b3b", fg: "#e6e9ec", bg: "#0c0f12", accent: "#2ee6a6" };
  const setup = () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => frames.push(f));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(new Proxy({}, { get: () => () => {}, set: () => true }) as never);
    const gl = { isContextLost: () => false } as unknown as WebGL2RenderingContext;
    const v = new Viewer(document.createElement("canvas"), gl, theme, vi.fn());
    const veil: number[] = [];
    v.onFlash = (o) => { veil.push(+o.toFixed(4)); };
    const look = () => v.rig.persp.getWorldDirection(new Vector3());
    return { v, veil, look, frame: () => frames.at(-1)!(performance.now()) };
  };
  const r = replay();

  it("recul : le regard du joueur + punchAt(joueur, tick affiché) en vue du joueur ; 2 s après, son propre regard", () => {
    punchAt.mockClear();
    const { v, look, frame } = setup();
    v.setFrame(r, 128, "a");
    v.setMode("pov");
    frame();
    expect(punchAt).toHaveBeenCalledWith(0, 128);  // l'indice du joueur suivi (a), le tick affiché
    expect(punchAt).not.toHaveBeenCalledWith(1, expect.anything());
    expect(look().z).toBeCloseTo(Math.sin((2 * Math.PI) / 180), 6);  // la vue est montée de 2° (AK : recul négatif)
    v.setFrame(r, 128 + 129, "a");  // plus de 2 s après le tir, punchAt rend [0, 0]
    frame();
    expect(look().angleTo(new Vector3(1, 0, 0))).toBeCloseTo(0, 6);  // joueur à plat vers +X
    v.dispose();
  });

  it("recul : seulement en vue du joueur (punchAt n'est pas interrogé dans les autres caméras)", () => {
    punchAt.mockClear();
    const { v, frame } = setup();
    v.setFrame(r, 128, "a");
    for (const mode of ["free", "follow", "top", "tv"] as const) { v.setMode(mode); frame(); }
    expect(punchAt).not.toHaveBeenCalled();
    v.dispose();
  });

  it("voile : onFlash à chaque changement d'opacité (palier 0,92, fondu), 0 à la fin, jamais deux fois la même valeur", () => {
    const { v, veil, frame } = setup();
    v.setFrame(r, 64, "a");
    v.setMode("pov");
    frame();
    expect(veil).toEqual([]);  // pas encore aveuglé : rien (0 au départ)
    v.setFrame(r, 128, "a");
    frame();
    frame();  // même instant : pas de nouvel appel
    v.setFrame(r, 192, "a");  // 1 s après : fin du palier de 1 s (3 - 2)
    frame();
    v.setFrame(r, 256, "a");  // 2 s : mi-fondu
    frame();
    v.setFrame(r, 320, "a");  // 3 s : fini, alors que le champ brut vaut encore 3
    frame();
    v.setFrame(r, 384, "a");
    frame();
    expect(veil).toEqual([0.92, 0.46, 0]);
    v.dispose();
  });

  it("voile : nul hors vue du joueur et quand on change de caméra, pour un autre joueur aveuglé ou non", () => {
    const { v, veil, frame } = setup();
    v.setFrame(r, 128, "a");
    v.setMode("follow");
    frame();
    expect(veil).toEqual([]);  // aveuglé, mais pas en vue du joueur
    v.setMode("pov");
    frame();
    expect(veil).toEqual([0.92]);
    v.setMode("top");
    frame();
    expect(veil).toEqual([0.92, 0]);
    v.setFrame(r, 128, "b");  // le joueur b n'est pas aveuglé
    v.setMode("pov");
    frame();
    expect(veil).toEqual([0.92, 0]);
    v.dispose();
  });
});

describe("vue du joueur : ni aides d'analyse, ciel clair", () => {
  // a (suivi) et b vivants, b aveuglé ; une smoke posée (trajectoire et nuage) et une mort ; pas de bombe
  const replay = () => ({
    ticks: new Int32Array([0, 640]), n: 2, tickrate: 64,
    players: [{ steamid: "a", name: "a", side: "CT", slot: 1, index: 0 }, { steamid: "b", name: "b", side: "T", slot: 1, index: 1 }],
    value: (k: string, _i: number, j: number) => ({ flags: 1, hp: 100, x: [0, 500][j], flash: j === 1 ? 20 : 0 } as Record<string, number>)[k] ?? 0,
    weaponAt: () => "AK-47", inventoryAt: () => [], has: () => false, crosshairOf: () => null, viewmodelOf: () => null, agentOf: () => null, punchAt: () => [0, 0],
    freezeEndTick: 0, endTick: 640,
    payload: { map_name: "de_nuke", players: [], bomb: [],
      grenades: [{ id: 1, type: "smoke", thrower: "a", throw_tick: 0, throw_pos: [0, 0, 0], detonate_tick: 100, detonate_pos: [100, 100, 0],
        end_tick: 1000, trajectory: [[0, 0, 0, 0], [100, 100, 100, 0]] }],
      kills: [{ tick: 5, attacker: "a", victim: "x", victim_pos: [0, 0, 0] }] },
  }) as unknown as Replay;
  const theme: Theme = { ct: "#5d9cec", t: "#e8b04b", smoke: "#cccccc", fire: "#ff6a00", flash: "#ffffff",
    he: "#ff3b3b", fg: "#e6e9ec", bg: "#0c0f12", accent: "#2ee6a6" };
  const setup = () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => frames.push(f));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(new Proxy({}, { get: () => () => {}, set: () => true }) as never);
    const gl = { isContextLost: () => false } as unknown as WebGL2RenderingContext;
    return { v: new Viewer(document.createElement("canvas"), gl, theme, vi.fn()), frame: () => frames.at(-1)!(performance.now()) };
  };
  // ce qui est dessiné à la dernière image (les objets et tous leurs parents visibles)
  const drawn = () => {
    const out: Object3D[] = [];
    (fake.renders.at(-1)!.scene as Object3D).traverse((o) => {
      if (!(o instanceof Mesh || o instanceof Line || o instanceof Sprite)) return;
      for (let x: Object3D | null = o; x; x = x.parent) if (!x.visible) return;
      out.push(o);
    });
    return out;
  };
  const count = () => ({
    bodies: drawn().filter((o) => o instanceof Mesh && o.userData.sid).length,
    other: drawn().filter((o) => o instanceof Mesh && !o.userData.sid).length,  // croix (2 barres) et nuage de la smoke
    lines: drawn().filter((o) => o instanceof Line).length,                     // regards et trajectoire
    sprites: drawn().filter((o) => o instanceof Sprite).length });              // étiquettes et halos
  const sky = () => ((fake.renders.at(-1)!.scene as Scene).background as Color).getHexString();

  it("vue du joueur : les corps et le nuage de la smoke restent ; ni noms, ni regards, ni halos, ni croix, ni trajectoires", () => {
    const { v, frame } = setup();
    v.setFrame(replay(), 320, "a");
    v.setMode("pov");
    frame();
    expect(count()).toEqual({ bodies: 1, other: 1, lines: 0, sprites: 0 });  // b ; le nuage
    v.dispose();
  });

  it("autres caméras : tout est là (regards, trajectoire, noms, halo, croix) ; retour en vue du joueur sans nouvel instant", () => {
    const { v, frame } = setup();
    v.setFrame(replay(), 320, "a");
    for (const mode of ["free", "follow", "top", "tv"] as const) {
      v.setMode(mode);
      frame();
      // tv : personne n'est suivi sans tueur (la caméra reste), mais les aides sont là quand même
      expect(count(), mode).toEqual({ bodies: 2, other: 3, lines: 3, sprites: 3 });  // 2 corps ; croix et nuage ; 2 regards et 1 trajectoire ; 2 noms et 1 halo
    }
    v.setMode("pov");
    frame();
    expect(count()).toEqual({ bodies: 1, other: 1, lines: 0, sprites: 0 });
    v.setMode("follow");
    frame();  // rien n'a changé côté données : les aides reviennent quand même, à jour
    expect(count()).toEqual({ bodies: 2, other: 3, lines: 3, sprites: 3 });
    v.dispose();
  });

  it("bombe posée : en vue du joueur, le repère sans son étiquette ; ailleurs, l'étiquette revient", () => {
    const { v, frame } = setup();
    const r = replay() as unknown as { payload: { bomb: unknown[] } };
    r.payload.bomb = [{ tick: 5, type: "plant", player: "b", site: "A", pos: [-1000, 0, 0] }];
    v.setFrame(r as unknown as Replay, 320, "a");
    v.setMode("pov");
    frame();
    expect(count()).toEqual({ bodies: 1, other: 2, lines: 0, sprites: 0 });  // b ; le nuage et la bombe
    v.setMode("follow");
    frame();
    expect(count()).toEqual({ bodies: 2, other: 4, lines: 3, sprites: 4 });  // + l'étiquette de la bombe
    v.dispose();
  });

  it("ciel : couleur claire en vue du joueur, fond du thème dans les autres caméras (aller et retour)", () => {
    const { v, frame } = setup();
    v.setFrame(replay(), 320, "a");
    frame();
    expect(sky()).toBe("0c0f12");
    v.setMode("pov");
    frame();
    expect(sky()).toBe("c4f4fd");
    v.setFrame(replay(), 330, "a");  // un autre instant en vue du joueur : le ciel ne change pas
    frame();
    expect(sky()).toBe("c4f4fd");
    for (const mode of ["follow", "top", "free"] as const) {
      v.setMode("pov");
      frame();
      v.setMode(mode);
      frame();
      expect(sky(), mode).toBe("0c0f12");
    }
    v.dispose();
  });
});

describe("éclairage", () => {
  it("lumière hémisphérique : ciel en +Z (le haut de la scène), pas en +Y", () => {
    const hemi = sceneLights().find((l) => l instanceof HemisphereLight)!;
    expect(hemi.position.clone().normalize().distanceTo(new Vector3(0, 0, 1))).toBeCloseTo(0, 6);
  });
});

describe("contexte WebGL perdu", () => {
  const setup = () => {
    vi.useFakeTimers();
    const canvas = document.createElement("canvas"), giveUp = vi.fn(), restored = vi.fn();
    const stop = watchContext(canvas, giveUp, restored, 3000);
    const lose = () => { const e = new Event("webglcontextlost", { cancelable: true }); canvas.dispatchEvent(e); return e; };
    return { canvas, giveUp, restored, stop, lose };
  };
  it("rendu dans le délai : on redessine, la 3D reste", () => {
    const { canvas, giveUp, restored, lose } = setup();
    expect(lose().defaultPrevented).toBe(true);  // demande au navigateur de le rendre
    vi.advanceTimersByTime(2000);
    canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(restored).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(5000);
    expect(giveUp).not.toHaveBeenCalled();
  });
  it("jamais rendu : abandon (retour au radar 2D)", () => {
    const { giveUp, lose } = setup();
    lose();
    vi.advanceTimersByTime(2999);
    expect(giveUp).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(giveUp).toHaveBeenCalledOnce();
  });
  it("démontage : plus d'écoute ni de minuterie", () => {
    const { giveUp, stop, lose } = setup();
    lose();
    stop();
    lose();
    vi.advanceTimersByTime(10000);
    expect(giveUp).not.toHaveBeenCalled();
  });
});

describe("vue 3D cachée (replay en 2D) : boucle de dessin arrêtée, reprise à l'image courante", () => {
  const theme: Theme = { ct: "#5d9cec", t: "#e8b04b", smoke: "#cccccc", fire: "#ff6a00", flash: "#ffffff",
    he: "#ff3b3b", fg: "#e6e9ec", bg: "#0c0f12", accent: "#2ee6a6" };
  const replay = {
    ticks: new Int32Array([0, 640]), n: 2, tickrate: 64,
    players: [{ steamid: "a", name: "a", side: "CT", slot: 1, index: 0 }],
    value: (k: string) => ({ flags: 1, hp: 100 } as Record<string, number>)[k] ?? 0,
    weaponAt: () => "AK-47", inventoryAt: () => [], has: () => false, crosshairOf: () => null, viewmodelOf: () => null, agentOf: () => null, punchAt: () => [0, 0],
    freezeEndTick: 0, endTick: 640,
    payload: { map_name: "de_nuke", grenades: [], kills: [], bomb: [], players: [] },
  } as unknown as Replay;
  // images demandées au navigateur et pas annulées ; `next()` les lui fait jouer (une image de l'écran)
  const setup = () => {
    const frames = new Map<number, FrameRequestCallback>();
    let id = 0;
    vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => { frames.set(++id, f); return id; });
    vi.stubGlobal("cancelAnimationFrame", (k: number) => { frames.delete(k); });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(new Proxy({}, { get: () => () => {}, set: () => true }) as never);
    const gl = { isContextLost: () => false } as unknown as WebGL2RenderingContext;
    const v = new Viewer(document.createElement("canvas"), gl, theme, vi.fn());
    const next = () => { const due = [...frames.values()]; frames.clear(); for (const f of due) f(performance.now()); };
    return { v, frames, next };
  };

  it("pause : plus aucune image demandée ni dessinée, même avec un nouvel instant ; reprise : l'instant courant tout de suite", () => {
    const { v, frames, next } = setup();
    v.setFrame(replay, 320, "a");
    next();
    expect(fake.renders).toHaveLength(1);
    expect(frames.size).toBe(1);  // la boucle tourne
    v.pause();
    expect(frames.size).toBe(0);  // image déjà demandée : annulée
    v.setFrame(replay, 400, "a");
    v.resize(800, 600);
    for (let k = 0; k < 5; k++) next();
    expect(frames.size).toBe(0);
    expect(fake.renders).toHaveLength(1);  // rien de dessiné en pause
    v.resume();
    expect(frames.size).toBe(1);
    next();
    expect(fake.renders).toHaveLength(2);  // l'instant 400, dessiné à la reprise
    next();
    expect(fake.renders).toHaveLength(2);  // puis rien de neuf : pas d'autre image
    expect(frames.size).toBe(1);  // la boucle tourne de nouveau
    v.dispose();
  });

  it("reprise sans rien de neuf : une image quand même (la vue a pu être vidée ou redimensionnée pendant qu'elle était cachée)", () => {
    const { v, next } = setup();
    v.setFrame(replay, 320, "a");
    next();
    next();
    expect(fake.renders).toHaveLength(1);
    v.pause();
    v.resume();
    next();
    expect(fake.renders).toHaveLength(2);
    v.dispose();
  });

  it("pauses et reprises répétées : une seule boucle (jamais deux images demandées à la fois) ; démontage en pause : rien ne repart", () => {
    const { v, frames, next } = setup();
    v.resume();  // déjà en marche : rien
    expect(frames.size).toBe(1);
    v.pause();
    v.pause();
    expect(frames.size).toBe(0);
    v.resume();
    v.resume();
    expect(frames.size).toBe(1);
    next();
    expect(frames.size).toBe(1);
    v.pause();
    v.dispose();
    v.resume();  // après dispose : plus rien
    expect(frames.size).toBe(0);
  });
});

describe("images des textures libérées après leur envoi (mémoire) ; contexte graphique rendu : carte relue", () => {
  const theme: Theme = { ct: "#5d9cec", t: "#e8b04b", smoke: "#cccccc", fire: "#ff6a00", flash: "#ffffff",
    he: "#ff3b3b", fg: "#e6e9ec", bg: "#0c0f12", accent: "#2ee6a6" };
  const replay = {
    ticks: new Int32Array([0, 640]), n: 2, tickrate: 64,
    players: [{ steamid: "a", name: "a", side: "CT", slot: 1, index: 0 }],
    value: (k: string) => ({ flags: 1, hp: 100 } as Record<string, number>)[k] ?? 0,
    weaponAt: () => "AK-47", inventoryAt: () => [], has: () => false, crosshairOf: () => null, viewmodelOf: () => null, agentOf: () => null, punchAt: () => [0, 0],
    freezeEndTick: 0, endTick: 640,
    payload: { map_name: "de_nuke", grenades: [], kills: [], bomb: [], players: [] },
  } as unknown as Replay;
  const ID = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const triangle = () => new BufferGeometry().setAttribute("position", new Float32BufferAttribute([0, 0, 0, 100, 0, 0, 0, 100, 0], 3));
  /** Carte de trois maillages texturés (images décodées factices) ; le 3e n'est jamais dessiné (hors du champ : caché).
   *  `freed()` : géométries, matériaux et textures libérés (`dispose`) sur la carte graphique. */
  const texturedMap = (tag: string) => {
    const bitmaps = [new Bitmap(), new Bitmap(), new Bitmap()], freed = vi.fn();
    const meshes = bitmaps.map((b, k) => {
      const map = Object.assign(new Texture(b), { name: `${tag}-${k}` }), m = new Mesh(triangle(), new MeshLambertMaterial({ map }));
      for (const x of [m.geometry, m.material, map]) x.addEventListener("dispose", freed);
      return m;
    });
    meshes[2].visible = false;
    return { root: new Group().add(...meshes), closed: () => bitmaps.map((b) => b.closed), freed: () => freed.mock.calls.length };
  };
  const setup = () => {
    vi.stubGlobal("ImageBitmap", Bitmap);
    const frames = new Map<number, FrameRequestCallback>();
    let id = 0;
    vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => { frames.set(++id, f); return id; });
    vi.stubGlobal("cancelAnimationFrame", (k: number) => { frames.delete(k); });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(new Proxy({}, { get: () => () => {}, set: () => true }) as never);
    const canvas = document.createElement("canvas"), lost = vi.fn();
    const v = new Viewer(canvas, { isContextLost: () => false } as unknown as WebGL2RenderingContext, theme, vi.fn());
    v.onMapLost = lost;
    v.setFrame(replay, 320, "a");
    // une image de l'écran ; contexte graphique perdu puis rendu par le navigateur
    const next = () => { const due = [...frames.values()]; frames.clear(); for (const f of due) f(performance.now()); };
    const restore = () => canvas.dispatchEvent(new Event("webglcontextrestored"));
    return { v, lost, next, restore };
  };

  it("carte : images libérées à son premier rendu, jamais avant, ni celles d'un maillage pas encore dessiné ; dispose : toutes", () => {
    const s = setup(), map = texturedMap("carte");
    s.v.setMap(map.root, ID, "de_nuke");
    expect(map.closed()).toEqual([0, 0, 0]);  // posée, pas encore dessinée
    s.next();
    expect(map.closed()).toEqual([1, 1, 0]);
    s.v.setFrame(replay, 400, "a");
    s.next();
    expect(map.closed()).toEqual([1, 1, 0]);
    expect(fake.blank).toEqual([]);  // jamais dessinée sans ses images
    s.v.dispose();
    expect(map.closed()).toEqual([1, 1, 1]);  // la dernière fermée aussi, les autres pas deux fois
    expect(map.freed()).toBe(9);
  });

  it("contexte rendu après l'envoi : carte cachée (jamais dessinée sans ses images) et redemandée une fois ; la nouvelle est dessinée", () => {
    const s = setup(), first = texturedMap("carte-1");
    s.v.setMap(first.root, ID, "de_nuke");
    s.next();
    expect(s.v.shown()).toBe("de_nuke");
    s.restore();
    expect(s.lost).toHaveBeenCalledOnce();
    expect(s.v.shown()).toBeNull();  // cachée : Scene3D la recharge comme au premier affichage
    const n = fake.renders.length;
    s.next();
    expect(fake.renders).toHaveLength(n + 1);  // l'instant courant redessiné, sans la carte
    expect(fake.blank).toEqual([]);
    s.restore();  // de nouveau pendant la relecture : déjà demandée
    expect(s.lost).toHaveBeenCalledOnce();
    const second = texturedMap("carte-2");
    s.v.setMap(second.root, ID, "de_nuke");
    expect(s.v.shown()).toBe("de_nuke");
    // l'ancienne : ses images encore gardées fermées ; rien de libéré sur la carte graphique, ses ressources sont parties
    // avec le contexte perdu (les libérer avertirait : « object does not belong to this context »)
    expect(first.closed()).toEqual([1, 1, 1]);
    expect(first.freed()).toBe(0);
    s.next();
    expect(second.closed()).toEqual([1, 1, 0]);
    expect(fake.blank).toEqual([]);
    s.v.dispose();
    expect([first.freed(), second.freed()]).toEqual([0, 9]);
  });

  it("démontage pendant la relecture : la carte perdue avec le contexte n'est pas libérée sur la carte graphique, ses images si", () => {
    const s = setup(), map = texturedMap("carte");
    s.v.setMap(map.root, ID, "de_nuke");
    s.next();
    s.restore();
    s.v.dispose();
    expect(map.closed()).toEqual([1, 1, 1]);
    expect(map.freed()).toBe(0);
  });

  it("contexte rendu avant tout envoi (carte posée pendant la 2D) ou carte sans texture (grise) : rien n'est relu", () => {
    const s = setup(), map = texturedMap("carte");
    s.v.setMap(new Group().add(new Mesh(triangle(), new MeshLambertMaterial())), ID, "de_nuke");
    s.next();
    s.restore();
    expect(s.lost).not.toHaveBeenCalled();
    s.v.pause();
    s.v.setMap(map.root, ID, "de_nuke");
    s.restore();
    expect(s.lost).not.toHaveBeenCalled();
    expect(s.v.shown()).toBe("de_nuke");
    s.v.resume();
    s.next();
    expect(map.closed()).toEqual([1, 1, 0]);  // envoyée au retour depuis ses images, puis libérée
    expect(fake.blank).toEqual([]);
    s.v.dispose();
  });

  // three ne regarde pas `visible` quand il lance un rayon : la carte cachée pendant sa relecture serait touchée si la
  // sélection lançait ses rayons sur la scène ; elle ne vise que les joueurs (`PlayerLayer.pick`)
  it("sélection pendant la relecture : le joueur visé est choisi, la carte cachée n'est jamais touchée par le rayon", () => {
    const s = setup(), map = texturedMap("carte"), hit = vi.fn();
    s.v.setMap(map.root, ID, "de_nuke");
    s.next();
    s.restore();
    expect(s.v.shown()).toBeNull();  // cachée, en attendant d'être relue
    map.root.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh) m.raycast = (...a) => { hit(); Mesh.prototype.raycast.apply(m, a); };
    });
    s.v.resize(800, 600);
    s.next();
    // le joueur à l'écran : centre de son corps, projeté par la caméra
    let body: Object3D | undefined;
    (s.v as unknown as { players: { group: Object3D } }).players.group.traverse((o) => { if (o.userData.sid === "a") body = o; });
    const cam = s.v.rig.camera(), at = new Box3().setFromObject(body!).getCenter(new Vector3()).project(cam);
    expect(s.v.pick((at.x + 1) * 400, (1 - at.y) * 300, 800, 600)).toBe("a");
    expect(s.v.pick(5, 5, 800, 600)).toBeNull();
    expect(hit).not.toHaveBeenCalled();
    s.v.dispose();
  });
});

// délai des tests au-delà de celui des attentes de fichiers (LOAD) : une attente ratée donne son propre message, et le
// test s'arrête proprement au lieu de laisser son attente dessiner pendant le suivant
describe("vue du joueur : bras et arme (2e passe)", { timeout: 20_000 }, () => {
  const theme: Theme = { ct: "#5d9cec", t: "#e8b04b", smoke: "#cccccc", fire: "#ff6a00", flash: "#ffffff",
    he: "#ff3b3b", fg: "#e6e9ec", bg: "#0c0f12", accent: "#2ee6a6" };
  // a (choisi, CT) et b (CT, ou `sideB`), immobiles, un Glock en main (ou `weapon`), aucun tir ; leur regard tourne de 90°
  // entre les deux images (10 s) : l'arme traîne derrière (sway). Pas de touches ni de chargeur (ancien replay).
  // `flagsA` / `flagsB` : vivant (1), en lunette (1 | 32), mort (0) ; `t0` : 1er tick (ticks du match : un autre round
  // commence plus loin)
  const replay = ({ flagsA = 1, flagsB = 1, weapon = "Glock-18", sideB = "CT", t0 = 0 } = {}) => ({
    ticks: new Int32Array([t0, t0 + 640]), n: 2, tickrate: 64,
    players: [{ steamid: "a", name: "a", side: "CT", slot: 1, index: 0 }, { steamid: "b", name: "b", side: sideB, slot: 2, index: 1 }],
    value: (k: string, i: number, j: number) => ({ flags: [flagsA, flagsB][j], hp: 100, x: [0, 300][j], yaw: 90 * i } as Record<string, number>)[k] ?? 0,
    has: () => false, weaponAt: () => weapon, inventoryAt: () => [], crosshairOf: () => null, viewmodelOf: () => null,
    agentOf: () => null, punchAt: () => [0, 0], freezeEndTick: t0, endTick: t0 + 640,
    payload: { map_name: "de_nuke", grenades: [], kills: [], bomb: [], shots: [], damages: [], players: [] },
  }) as unknown as Replay;
  const read = (b: Uint8Array<ArrayBuffer>): Promise<VmFile> => parseGlbAnimated(b.buffer);
  // fichiers « vue » : bras des deux camps et le Glock (`gun` : autre contenu de son fichier) ; noms demandés notés
  const files = (gun: () => Promise<VmFile | null> = () => read(weaponGlb())) => {
    const asked: string[] = [];
    const load: VmLoad = async (name) => {
      asked.push(name);
      return name.startsWith("bras-") ? read(armsGlb()) : name === "arme-glock" ? gun() : null;
    };
    return { asked, load };
  };
  const setup = () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => frames.push(f));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(new Proxy({}, { get: () => () => {}, set: () => true }) as never);
    const canvas = document.createElement("canvas"), onFail = vi.fn(), arms = vi.fn();
    const v = new Viewer(canvas, { isContextLost: () => false } as unknown as WebGL2RenderingContext, theme, onFail);
    v.onArms = arms;
    // une image (à l'arrêt : sans nouvel instant) ; un instant, puis une image
    const frame = () => frames.at(-1)!(performance.now());
    const draw = (r = replay(), tick = 320, sid = "a") => { v.setFrame(r, tick, sid); frame(); };
    return { v, canvas, onFail, arms, frame, draw };
  };
  type Setup = ReturnType<typeof setup>;
  // attente des fichiers (petits GLB lus pour de bon) : de la marge sous la charge de la suite complète
  const LOAD = { timeout: 5000 };
  // passes de la dernière image : la carte (la scène du monde, la 1re rendue), puis, s'il y en a, l'effacement de la
  // profondeur et les bras
  const image = () => fake.renders.slice(fake.renders.map((x) => x.scene).lastIndexOf(fake.renders[0].scene));
  // images jusqu'à l'arrivée des fichiers : bras dessinés
  const armsOn = (s: Setup, r = replay(), tick = 320, sid = "a") =>
    vi.waitFor(() => { s.draw(r, tick, sid); expect(s.arms).toHaveBeenLastCalledWith(true); }, LOAD);
  // scène et caméra des bras à la dernière image
  const vmPass = () => {
    const img = image();
    expect(img.map((x) => x.scene === "profondeur")).toEqual([false, true, false]);
    return { scene: img[2].scene as Scene, camera: img[2].camera as PerspectiveCamera };
  };

  it("2e passe après la carte (profondeur effacée, image gardée, même chaîne de couleur), en vue du joueur et fichiers chargés", async () => {
    const s = setup(), { asked, load } = files();
    s.v.setMode("pov");
    s.draw();
    expect(image()).toHaveLength(1);  // sans fichiers : la carte seule
    // lecture à l'arrêt (aucun nouvel instant) : l'image est refaite pour demander les bras CT et le Glock, rien n'est
    // dessiné tant qu'ils ne sont pas arrivés, puis à leur arrivée
    s.v.setViewmodel(load);
    s.frame();
    expect(asked).toEqual(["bras-ct", "arme-glock"]);
    expect(image()).toHaveLength(1);
    await vi.waitFor(() => { s.frame(); expect(s.arms).toHaveBeenLastCalledWith(true); }, LOAD);
    const [map, depth, vm] = image();
    expect(depth.scene).toBe("profondeur");
    expect(vm.scene).not.toBe(map.scene);
    expect(vm.autoClear).toBe(false);  // la carte reste à l'image
    expect(vm.color).toBe(map.color);  // même tone mapping, même exposition, même espace de couleur que le monde
    s.draw(replay(), 330);
    expect(image()[0].autoClear).toBe(true);  // remis pour l'image suivante
    expect(image()).toHaveLength(3);
    expect(s.arms).toHaveBeenCalledOnce();  // au changement seulement, pas à chaque image
    s.v.setMode("follow");
    s.draw();
    expect(s.arms).toHaveBeenLastCalledWith(false);
    expect(image()).toHaveLength(1);
    s.v.setMode("pov");
    s.draw();
    expect(s.arms).toHaveBeenLastCalledWith(true);
    s.v.setViewmodel(null);  // fichiers retirés : plus de bras, même à l'arrêt
    s.frame();
    expect(image()).toHaveLength(1);
    expect(s.arms.mock.calls).toEqual([[true], [false], [true], [false]]);
    expect(asked).toHaveLength(2);  // rien n'est redemandé
    expect(s.onFail).not.toHaveBeenCalled();
    s.v.dispose();
  });

  it("hors de la vue du joueur : aucun appel au ViewModel (coût nul), aucun fichier demandé", () => {
    const update = vi.spyOn(ViewModel.prototype, "update"), render = vi.spyOn(ViewModel.prototype, "render");
    const s = setup(), { asked, load } = files();
    s.v.setViewmodel(load);
    // tv : a est suivi (personne n'a tué), mais ce n'est pas la vue du joueur
    for (const mode of ["free", "follow", "top", "tv"] as const) { s.v.setMode(mode); s.draw(); }
    expect([update.mock.calls.length, render.mock.calls.length, asked.length]).toEqual([0, 0, 0]);
    expect(s.arms).not.toHaveBeenCalled();
    s.v.setMode("pov");
    s.draw();
    expect(update).toHaveBeenCalledOnce();
    expect(asked).toEqual(["bras-ct", "arme-glock"]);
    s.v.dispose();
  });

  it("ni en lunette, ni sans arme à bras, ni sans personne en vie ; joueur choisi mort : les bras du joueur suivi à sa place", async () => {
    const s = setup(), { asked, load } = files();
    s.v.setMode("pov");
    s.v.setViewmodel(load);
    await armsOn(s);
    s.draw(replay({ flagsA: 1 | 32 }));  // en lunette, quelle que soit l'arme
    expect(s.arms).toHaveBeenLastCalledWith(false);
    expect(image()).toHaveLength(1);
    s.draw(replay({ weapon: "" }));  // rien en main (ou une arme absente de weapons.json)
    expect(image()).toHaveLength(1);
    // a mort, aucun CT en vie : la vue est celle de b (T), ses bras aussi
    await armsOn(s, replay({ flagsA: 0, sideB: "T" }));
    expect(s.v.followed()?.steamid).toBe("b");
    expect(asked).toContain("bras-t");
    s.draw(replay({ flagsA: 0, flagsB: 0 }));
    expect(s.arms).toHaveBeenLastCalledWith(false);
    expect(image()).toHaveLength(1);
    expect(s.onFail).not.toHaveBeenCalled();
    s.v.dispose();
  });

  it("bras et arme chargés mais sans le clip à jouer : rien n'est dessiné (update faux, pas de render)", async () => {
    const pose = vi.spyOn(ViewModel.prototype, "pose"), render = vi.spyOn(ViewModel.prototype, "render");
    const s = setup();
    s.v.setMode("pov");
    s.v.setViewmodel(files(() => read(weaponGlb()).then((f) => ({ ...f, clips: f.clips.filter((c) => c.name !== "idle") }))).load);
    await vi.waitFor(() => { s.draw(); expect(pose).toHaveBeenCalled(); }, LOAD);  // fichiers arrivés : la pose est tentée
    expect(pose).toHaveLastReturnedWith(false);
    expect(render).not.toHaveBeenCalled();
    expect(image()).toHaveLength(1);
    expect(s.arms).not.toHaveBeenCalled();
    s.v.dispose();
  });

  it("lumière : les deux lumières de la scène du monde ; caméra des bras : aspect du canvas, à la création et à chaque taille", async () => {
    const s = setup();
    s.v.resize(800, 400);
    s.v.setMode("pov");
    s.draw();
    const world = fake.renders[0].scene as Scene;
    const hemi = world.children.find((o) => o instanceof HemisphereLight)!, sun = world.children.find((o) => o instanceof DirectionalLight)!;
    hemi.intensity = 0.5;  // lumière propre à la carte (vague 2 : lightmaps) : le ViewModel la reprend
    sun.color.set("#ff0000");
    s.v.setViewmodel(files().load);
    await armsOn(s);
    const { scene, camera } = vmPass();
    expect(camera.aspect).toBe(2);
    expect(scene.children.find((o) => o instanceof HemisphereLight)!.intensity).toBe(0.5);
    const vmSun = scene.children.find((o) => o instanceof DirectionalLight)!;
    expect(vmSun.color.getHexString()).toBe("ff0000");
    // soleil ramené dans le repère de la caméra de la vue du joueur (sa rotation dans le monde)
    const toSun = sun.position.clone().sub(sun.target.position).normalize().applyQuaternion(s.v.rig.persp.quaternion.clone().invert());
    expect(s.v.rig.persp.quaternion.angleTo(new Quaternion())).toBeGreaterThan(0.1);  // regard non trivial
    expect(vmSun.position.distanceTo(toSun)).toBeLessThan(1e-9);
    s.v.resize(1000, 250);
    s.draw();
    expect(vmPass().camera.aspect).toBe(4);
    s.v.dispose();
  });

  it("saut dans le temps : le sway repart de zéro (saut, retour arrière, autre joueur, autre round), pas en lecture continue", async () => {
    const s = setup(), r = replay();
    s.v.setMode("pov");
    s.v.setViewmodel(files().load);
    await armsOn(s, r, 320);
    const sway = () => vmPass().scene.getObjectByName("vm_sway")!.rotation.y;  // lacet : ni bob (immobiles) ni recul
    const play = (tick: number, sid = "a", rr = r) => { s.draw(rr, tick, sid); return sway(); };
    expect(Math.abs(play(336))).toBeGreaterThan(1e-3);  // 0,25 s de lecture : le regard a tourné, l'arme traîne
    expect(play(336 + 128)).toBeCloseTo(0, 12);         // saut de 2 s
    expect(Math.abs(play(480))).toBeGreaterThan(1e-3);
    expect(play(470)).toBeCloseTo(0, 12);               // retour arrière
    expect(Math.abs(play(486))).toBeGreaterThan(1e-3);
    expect(play(486, "b")).toBeCloseTo(0, 12);          // autre joueur suivi, même instant
    play(624);
    expect(Math.abs(play(640))).toBeGreaterThan(1e-3);  // fin des images du round
    // round suivant : ses images commencent plus de 1 s après (5 s gardées après la fin du round, 7 s avant le suivant)
    expect(play(768, "a", replay({ t0: 768 }))).toBeCloseTo(0, 12);
    s.v.dispose();
  });

  it("fichier « vue » en échec : onVmError (nom, erreur), la vue du joueur reste sans bras, jamais onFail", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = setup(), err = new Error("404");
    s.v.setMode("pov");
    s.v.setViewmodel(async (name) => { if (name === "arme-glock") throw err; return name.startsWith("bras-") ? read(armsGlb()) : null; });
    const errors: unknown[][] = [];
    s.v.onVmError = (name, e) => { errors.push([name, e]); };  // posé après : relayé quand même
    s.draw();
    await vi.waitFor(() => expect(errors).toEqual([["arme-glock", err]]), LOAD);
    s.draw();
    s.draw(replay(), 330);
    expect(image()).toHaveLength(1);
    expect(s.arms).not.toHaveBeenCalled();
    expect(s.onFail).not.toHaveBeenCalled();
    s.v.dispose();
  });

  it("erreur dans la 2e passe : bras retirés (ViewModel libéré une fois), la carte continue, jamais onFail ; d'autres fichiers les rendent", async () => {
    const s = setup();
    s.v.setMode("pov");
    s.v.setViewmodel(files().load);
    await armsOn(s);
    const dispose = vi.spyOn(ViewModel.prototype, "dispose");
    const render = vi.spyOn(ViewModel.prototype, "render").mockImplementation(() => { throw new Error("os manquant"); });
    vi.spyOn(console, "error").mockImplementation(() => {});
    s.draw(replay(), 330);
    expect(s.arms).toHaveBeenLastCalledWith(false);
    expect(dispose).toHaveBeenCalledOnce();
    s.draw(replay(), 340);
    expect(render).toHaveBeenCalledOnce();  // toujours en vue du joueur : pas de nouvel essai, pas d'erreur en rafale
    expect(image()).toHaveLength(1);
    render.mockRestore();
    s.v.setViewmodel(files().load);  // nouvelle liste de fichiers : bras de nouveau
    await armsOn(s);
    s.v.dispose();
    // chacun des deux ViewModel libéré une seule fois : celui de l'erreur ne l'est pas de nouveau
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(new Set(dispose.mock.contexts).size).toBe(2);
    expect(s.onFail).not.toHaveBeenCalled();
  });

  it("après une erreur de la 2e passe : ViewModel recréé à la prochaine entrée en vue du joueur, 3 fois au plus par chargeur", async () => {
    const s = setup(), { asked, load } = files();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const vms = () => asked.filter((n) => n === "bras-ct").length;  // un ViewModel neuf redemande ses fichiers
    const reenter = () => { s.v.setMode("follow"); s.draw(); s.v.setMode("pov"); s.draw(); };
    s.v.setMode("pov");
    s.v.setViewmodel(load);
    await armsOn(s);
    // erreur passagère, et la libération du ViewModel en échec lève aussi : la 3D continue
    const render = vi.spyOn(ViewModel.prototype, "render").mockImplementationOnce(() => { throw new Error("passagère"); });
    vi.spyOn(ViewModel.prototype, "dispose").mockImplementationOnce(() => { throw new Error("libération"); });
    s.draw(replay(), 330);
    expect(s.arms).toHaveBeenLastCalledWith(false);
    s.draw(replay(), 340);  // toujours en vue du joueur : pas de nouvel essai
    expect(vms()).toBe(1);
    reenter();
    await armsOn(s);  // nouvelle entrée en vue du joueur : bras de nouveau
    expect(vms()).toBe(2);
    // erreur durable : 2e, 3e et 4e échecs, une reprise à chaque entrée entre eux, puis plus d'essai
    render.mockImplementation(() => { throw new Error("durable"); });
    for (let fail = 2; fail <= 4; fail++) {
      const n = render.mock.calls.length;
      await vi.waitFor(() => { s.draw(); expect(render).toHaveBeenCalledTimes(n + 1); }, LOAD);
      reenter();
    }
    expect(vms()).toBe(4);  // le 1er et 3 reprises
    s.draw();
    reenter();
    expect(vms()).toBe(4);
    expect(image()).toHaveLength(1);
    expect(s.onFail).not.toHaveBeenCalled();
    s.v.dispose();
  });

  it("setViewmodel avec le même chargeur : sans effet (cache des armes gardé, rien de redemandé)", async () => {
    const s = setup(), { asked, load } = files();
    s.v.setMode("pov");
    s.v.setViewmodel(load);
    await armsOn(s);
    const dispose = vi.spyOn(ViewModel.prototype, "dispose");
    s.v.setViewmodel(load);
    s.draw(replay(), 330);
    expect(dispose).not.toHaveBeenCalled();
    expect(image()).toHaveLength(3);
    expect(asked).toEqual(["bras-ct", "arme-glock"]);
    expect(s.arms.mock.calls).toEqual([[true]]);
    s.v.dispose();
  });

  it("setViewmodel remplace et libère le précédent ; null et dispose() libèrent", () => {
    const dispose = vi.spyOn(ViewModel.prototype, "dispose");
    const s = setup(), first = files(), second = files();
    s.v.setMode("pov");
    s.v.setViewmodel(first.load);
    s.v.setViewmodel(second.load);
    expect(dispose).toHaveBeenCalledOnce();
    s.draw();
    expect([first.asked, second.asked]).toEqual([[], ["bras-ct", "arme-glock"]]);
    s.v.setViewmodel(null);
    expect(dispose).toHaveBeenCalledTimes(2);
    s.v.setViewmodel(first.load);
    s.v.dispose();
    expect(dispose).toHaveBeenCalledTimes(3);
  });

  it("après dispose() : setViewmodel ne fait rien (aucun ViewModel créé, aucun fichier demandé)", async () => {
    const s = setup(), { asked, load } = files();
    s.v.setMode("pov");
    s.draw();
    s.v.dispose();
    const made = vi.spyOn(ViewModel.prototype, "setLighting");  // appelé par le constructeur du ViewModel
    s.v.setViewmodel(load);
    await new Promise((ok) => setTimeout(ok, 20));
    expect((s.v as unknown as { vm: unknown }).vm).toBeNull();
    expect(made).not.toHaveBeenCalled();
    expect(asked).toEqual([]);
  });

  it("contexte graphique rendu : les reflets des bras (rendus, perdus avec le contexte) sont refaits", async () => {
    const s = setup();
    s.v.setMode("pov");
    s.v.setViewmodel(files().load);
    await armsOn(s);
    s.draw(replay(), 330);
    expect(fake.pmrem).toBe(1);  // une fois, au 1er rendu des bras
    s.canvas.dispatchEvent(new Event("webglcontextrestored"));
    s.draw(replay(), 330);
    expect(fake.pmrem).toBe(2);
    expect(image()).toHaveLength(3);
    s.v.dispose();
  });

  it("bras et arme : images libérées à leur envoi ; contexte rendu : ViewModel recréé, fichiers relus, bras redessinés", async () => {
    vi.stubGlobal("ImageBitmap", Bitmap);
    const s = setup(), { asked, load } = files(), bitmaps: Bitmap[] = [], freed = vi.fn();
    // fichiers « vue » texturés : une image décodée par maillage ; libérations sur la carte graphique notées (`dispose`)
    const textured: VmLoad = async (name, signal) => {
      const f = await load(name, signal);
      f?.scene.traverse((o) => {
        const m = o as Mesh;
        if (!m.isMesh) return;
        const b = new Bitmap(), map = Object.assign(new Texture(b), { name: "vue" });
        bitmaps.push(b);
        (m.material as MeshStandardMaterial).map = map;
        for (const x of [m.geometry, m.material as MeshStandardMaterial, map]) x.addEventListener("dispose", () => freed(bitmaps.indexOf(b)));
      });
      return f;
    };
    s.v.setMode("pov");
    s.v.setViewmodel(textured);
    await armsOn(s);
    expect(bitmaps.map((b) => b.closed)).toEqual([1, 1]);  // bras et Glock dessinés : envoyés, puis libérés
    s.canvas.dispatchEvent(new Event("webglcontextrestored"));
    s.draw(replay(), 330);
    expect(s.arms).toHaveBeenLastCalledWith(false);  // ViewModel neuf : ses fichiers sont relus
    await armsOn(s, replay(), 340);
    expect(asked).toEqual(["bras-ct", "arme-glock", "bras-ct", "arme-glock"]);
    expect(bitmaps.map((b) => b.closed)).toEqual([1, 1, 1, 1]);
    expect(fake.blank).toEqual([]);  // jamais dessinés sans leurs images
    expect(s.onFail).not.toHaveBeenCalled();
    // les premiers, perdus avec le contexte : rien de libéré sur la carte graphique ; les suivants, au démontage
    expect(freed).not.toHaveBeenCalled();
    s.v.dispose();
    expect(new Set(freed.mock.calls.map(([k]) => k))).toEqual(new Set([2, 3]));
  });

  it("disposeTree : celui de dispose.ts, réexporté (plus de copie)", () => {
    expect(viewerDisposeTree).toBe(disposeTree);
  });
});

// délai des tests au-delà de celui des attentes de fichiers (LOAD), comme pour les bras
describe("joueurs en modèles d'agents", { timeout: 20_000 }, () => {
  const FILES: Record<string, () => Uint8Array<ArrayBuffer>> = {
    "agent-ct": agentGlb, "agent-t": agentGlb, "anims-rifle": () => animsGlb(), "anims-pistol": () => animsGlb(),
    "anims-knife": () => animsGlb(), "anims-communes": () => animsGlb(COMMON_CLIPS), "monde-ak47": mondeGlb,
    ragdoll: () => ragdollGlb(),
  };
  const theme: Theme = { ct: "#5d9cec", t: "#e8b04b", smoke: "#cccccc", fire: "#ff6a00", flash: "#ffffff",
    he: "#ff3b3b", fg: "#e6e9ec", bg: "#0c0f12", accent: "#2ee6a6" };
  // fichiers « joueurs » de test (petits GLB lus pour de bon) ; noms demandés notés
  const files = () => {
    const asked: string[] = [];
    const load: AgentLoad = async (name) => {
      asked.push(name);
      return FILES[name] ? parseGlbAnimated(FILES[name]().buffer) : null;
    };
    return { asked, load };
  };
  // a (CT) en x 0, b (T) en x `xB`, vivants, regard +X, `weapon` en main (inventaire : elle et `more`)
  const replay = ({ xB = 500, weapon = "AK-47", more = [] as string[] } = {}) => ({
    ticks: new Int32Array([0, 640]), n: 2, tickrate: 64,
    players: [{ steamid: "a", name: "a", side: "CT", slot: 1, index: 0 }, { steamid: "b", name: "b", side: "T", slot: 1, index: 1 }],
    value: (k: string, _i: number, j: number) => ({ flags: 1, hp: 100, x: [0, xB][j] } as Record<string, number>)[k] ?? 0,
    weaponAt: () => weapon, inventoryAt: () => [weapon, ...more], has: () => false, crosshairOf: () => null,
    viewmodelOf: () => null, agentOf: () => null, punchAt: () => [0, 0], freezeEndTick: 0, endTick: 640,
    payload: { map_name: "de_nuke", grenades: [], kills: [], bomb: [], damages: [], shots: [], players: [] },
  }) as unknown as Replay;
  // images demandées au navigateur et pas annulées ; `next()` les lui fait jouer (une image de l'écran)
  const setup = (spawn?: () => RagdollPort | null) => {
    const frames = new Map<number, FrameRequestCallback>();
    let id = 0;
    vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => { frames.set(++id, f); return id; });
    vi.stubGlobal("cancelAnimationFrame", (k: number) => { frames.delete(k); });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(new Proxy({}, { get: () => () => {}, set: () => true }) as never);
    const canvas = document.createElement("canvas"), onFail = vi.fn(), on: boolean[] = [];
    const v = new Viewer(canvas, { isContextLost: () => false } as unknown as WebGL2RenderingContext, theme, onFail, spawn);
    v.onAgents = (shown) => { on.push(shown); };
    const next = () => { const due = [...frames.values()]; frames.clear(); for (const f of due) f(performance.now()); };
    const layer = (v as unknown as { agents: AgentLayer }).agents;
    // joueurs dessinés en modèle (leur groupe visible), triés
    const models = () => ["a", "b"].filter((sid) => layer.rig(sid)?.group.visible);
    return { v, canvas, onFail, on, next, layer, models };
  };
  type Setup = ReturnType<typeof setup>;
  const LOAD = { timeout: 5000 };
  // images jusqu'à l'arrivée des fichiers : joueurs dessinés en modèles
  const agentsOn = (s: Setup) => vi.waitFor(() => { s.next(); expect(s.on.at(-1)).toBe(true); }, LOAD);
  // silhouettes dessinées à la dernière image (elles et leurs parents visibles)
  const capsules = () => {
    const out: string[] = [];
    (fake.renders.at(-1)!.scene as Object3D).traverse((o) => {
      for (let x: Object3D | null = o; x; x = x.parent) if (!x.visible) return;
      if (o instanceof Mesh && o.userData.sid) out.push(o.userData.sid as string);
    });
    return out.sort();
  };
  // passes de la dernière image : la scène du monde, puis, s'il y en a, l'effacement de la profondeur et les bras
  const image = () => fake.renders.slice(fake.renders.map((x) => x.scene).lastIndexOf(fake.renders[0].scene));
  const warm = vi.mocked(warmAgentAnim);

  it("fichiers « joueurs » : modèles à la place des silhouettes (onAgents au changement seulement), clic par les silhouettes ; sans fichiers, silhouettes revenues", async () => {
    const s = setup(), { load } = files();
    s.v.resize(800, 600);
    s.v.setFrame(replay(), 320, null);
    s.next();
    expect(capsules()).toEqual(["a", "b"]);
    s.v.setAgents(load);
    await agentsOn(s);
    expect(capsules()).toEqual([]);
    expect(s.models()).toEqual(["a", "b"]);
    s.v.setFrame(replay(), 330, null);
    s.next();
    s.next();
    expect(s.on).toEqual([true]);
    // le clic passe toujours par les silhouettes, cachées sous les modèles : centre de celle de a, projeté par la caméra
    let body: Object3D | undefined;
    (s.v as unknown as { players: { group: Object3D } }).players.group.traverse((o) => { if (o.userData.sid === "a" && o instanceof Mesh) body = o; });
    const at = new Box3().setFromObject(body!).getCenter(new Vector3()).project(s.v.rig.camera());
    expect(s.v.pick((at.x + 1) * 400, (1 - at.y) * 300, 800, 600)).toBe("a");
    const animate = vi.spyOn(AgentLayer.prototype, "animate");
    s.v.setAgents(null);
    s.next();
    expect(s.on).toEqual([true, false]);
    expect(capsules()).toEqual(["a", "b"]);
    expect(s.layer.group.children).toHaveLength(0);
    s.v.setFrame(replay(), 340, null);
    s.next();
    expect(animate).not.toHaveBeenCalled();  // plus aucun appel à la couche
    expect(s.onFail).not.toHaveBeenCalled();
    s.v.dispose();
  });

  it("sans fichiers « joueurs » : la couche des agents ne travaille pas (ni pose, ni préchauffage), silhouettes comme avant", () => {
    warm.mockClear();
    const animate = vi.spyOn(AgentLayer.prototype, "animate"), update = vi.spyOn(AgentLayer.prototype, "update");
    const s = setup();
    for (const mode of ["follow", "pov", "top", "free"] as const) {
      s.v.setMode(mode);
      s.v.setFrame(replay(), 320, "a");
      s.next();
    }
    expect([animate.mock.calls.length, update.mock.calls.length, warm.mock.calls.length]).toEqual([0, 0, 0]);
    expect(capsules()).toEqual(["a", "b"]);
    expect(s.on).toEqual([]);
    s.v.dispose();
  });

  it("même chargeur : rien ; autre chargeur : modèles retirés puis l'ancienne bibliothèque libérée ; null et dispose() libèrent", async () => {
    const dispose = vi.spyOn(AgentLibrary.prototype, "dispose"), setLibrary = vi.spyOn(AgentLayer.prototype, "setLibrary");
    const layerDispose = vi.spyOn(AgentLayer.prototype, "dispose");
    const s = setup(), first = files(), second = files();
    s.v.setFrame(replay(), 320, null);
    s.v.setAgents(first.load);
    await agentsOn(s);
    const n = first.asked.length;
    s.v.setAgents(first.load);
    s.v.setFrame(replay(), 330, null);
    s.next();
    expect(dispose).not.toHaveBeenCalled();
    expect(first.asked).toHaveLength(n);
    expect(s.models()).toEqual(["a", "b"]);
    setLibrary.mockClear();
    s.v.setAgents(second.load);
    expect(dispose).toHaveBeenCalledOnce();
    // modèles retirés de la couche avant la libération de la bibliothèque dont ils partagent les ressources
    expect(setLibrary.mock.calls[0][0]).toBeNull();
    expect(setLibrary.mock.invocationCallOrder[0]).toBeLessThan(dispose.mock.invocationCallOrder[0]);
    expect(s.layer.group.children).toHaveLength(0);
    await vi.waitFor(() => { s.next(); expect(s.models()).toEqual(["a", "b"]); }, LOAD);
    expect(second.asked).toEqual(expect.arrayContaining(["agent-ct", "agent-t", "anims-rifle", "anims-communes", "monde-ak47"]));
    s.v.setAgents(null);
    expect(dispose).toHaveBeenCalledTimes(2);
    s.v.setAgents(first.load);
    s.v.dispose();
    expect(dispose).toHaveBeenCalledTimes(3);
    expect(layerDispose).toHaveBeenCalledOnce();
    expect(s.onFail).not.toHaveBeenCalled();
  });

  it("après dispose() : setAgents ne fait rien (aucune bibliothèque créée ni posée, aucun fichier demandé)", async () => {
    const s = setup(), { asked, load } = files();
    s.v.setFrame(replay(), 320, null);
    s.next();
    s.v.dispose();
    const setLibrary = vi.spyOn(AgentLayer.prototype, "setLibrary"), preload = vi.spyOn(AgentLibrary.prototype, "preload");
    s.v.setAgents(load);
    await new Promise((ok) => setTimeout(ok, 20));
    expect((s.v as unknown as { agentLib: unknown }).agentLib).toBeNull();
    expect([setLibrary.mock.calls.length, preload.mock.calls.length]).toEqual([0, 0]);
    expect(asked).toEqual([]);
  });

  it("joueurs lointains laissés pour l'image suivante (deferred) : une image de plus, au numéro suivant ; à l'arrêt, plus rien ensuite", async () => {
    const s = setup(), { load } = files(), r = replay({ xB: 6000 });
    s.v.setMode("pov");  // a suivi (caché), b loin devant lui
    s.v.setFrame(r, 320, "a");
    s.v.setAgents(load);
    await agentsOn(s);
    expect(s.models()).toEqual(["b"]);
    // instants suivants, jusqu'à celui où b, au loin, attend (une image sur deux)
    let tick = 320;
    do {
      s.v.setFrame(r, ++tick, "a");
      s.next();
    } while (!s.layer.deferred && tick < 330);
    expect(s.layer.deferred).toBe(true);
    expect(s.layer.rig("b")!.posed.split("|")[0]).not.toBe(String(tick));
    const n = fake.renders.length;
    for (let k = 0; k < 6; k++) s.next();
    expect(fake.renders).toHaveLength(n + 1);  // l'image de plus, puis plus aucune : la boucle de dessin s'arrête
    expect(s.layer.deferred).toBe(false);
    expect(s.layer.rig("b")!.posed.split("|")[0]).toBe(String(tick));  // posé à l'instant affiché
    s.v.dispose();
  });

  it("préchauffage des fichiers « joueurs » (premier affichage) : avant la pose de chaque image, avec le rendu, la caméra de l'image et la scène du monde ; une image de plus tant qu'il reste à faire, puis plus rien", async () => {
    const s = setup(), { load } = files();
    s.v.setFrame(replay(), 320, null);
    s.v.setAgents(load);
    await agentsOn(s);
    const v = s.v as unknown as { agentLib: AgentLibrary; renderer: unknown; scene: unknown };
    const calls: string[] = [];
    let busy = true;
    vi.spyOn(v.agentLib, "warm").mockImplementation((r, c, sc) => {
      calls.push(`warm ${r === v.renderer} ${c === s.v.rig.camera()} ${sc === v.scene}`);
      return busy;
    });
    const animate = AgentLayer.prototype.animate;
    vi.spyOn(AgentLayer.prototype, "animate").mockImplementation(function (this: AgentLayer, ...a) {
      calls.push("animate");
      return animate.apply(this, a);
    });
    s.v.setFrame(replay(), 330, null);
    s.next();
    expect(calls).toEqual(["warm true true true", "animate"]);
    s.next();
    s.next();
    expect(calls).toHaveLength(6);  // il reste à faire : une image à chaque fois, même à l'arrêt
    busy = false;
    s.next();
    const n = fake.renders.length;
    for (let k = 0; k < 4; k++) s.next();
    expect(calls).toHaveLength(8);
    expect(fake.renders).toHaveLength(n);  // fini : la boucle de dessin s'arrête
    s.v.dispose();
  });

  // la couche n'est plus appelée ensuite : son `deferred` de la dernière pose ne doit plus rien demander
  for (const how of ["fichiers retirés", "erreur de pose"] as const) {
    it(`${how} alors qu'un joueur lointain attendait : plus aucune image demandée ensuite, à l'arrêt`, async () => {
      const s = setup(), { load } = files(), r = replay({ xB: 6000 });
      s.v.setMode("pov");
      s.v.setFrame(r, 320, "a");
      s.v.setAgents(load);
      await agentsOn(s);
      if (how === "erreur de pose") {
        vi.spyOn(console, "error").mockImplementation(() => {});
        // erreur après qu'un joueur lointain a été laissé pour l'image suivante
        vi.spyOn(AgentLayer.prototype, "animate").mockImplementation(function (this: AgentLayer) {
          this.deferred = true;
          throw new Error("os manquant");
        });
        s.v.setFrame(r, 321, "a");
        s.next();
      } else {
        let tick = 320;
        do {
          s.v.setFrame(r, ++tick, "a");
          s.next();
        } while (!s.layer.deferred && tick < 330);
        expect(s.layer.deferred).toBe(true);
        s.v.setAgents(null);
      }
      s.next();
      const n = fake.renders.length;
      for (let k = 0; k < 4; k++) s.next();
      expect(fake.renders).toHaveLength(n);
      expect(capsules()).toEqual(["b"]);  // a, suivi, caché
      expect(s.onFail).not.toHaveBeenCalled();
      s.v.dispose();
    });
  }

  it("vue du joueur : le joueur suivi n'est ni modèle ni silhouette, l'autre en modèle, bras dessinés ; sortie de la vue sans nouvel instant", async () => {
    const s = setup(), { load } = files(), arms = vi.fn();
    const read = (b: Uint8Array<ArrayBuffer>): Promise<VmFile> => parseGlbAnimated(b.buffer);
    const vue: VmLoad = async (name) => (name.startsWith("bras-") ? read(armsGlb()) : name === "arme-glock" ? read(weaponGlb()) : null);
    s.v.onArms = arms;
    s.v.setMode("pov");
    s.v.setFrame(replay({ weapon: "Glock-18" }), 320, "a");
    s.v.setViewmodel(vue);
    s.v.setAgents(load);
    await vi.waitFor(() => { s.next(); expect(arms).toHaveBeenLastCalledWith(true); expect(s.on.at(-1)).toBe(true); }, LOAD);
    expect(s.models()).toEqual(["b"]);
    expect(capsules()).toEqual([]);
    expect(image().map((x) => x.scene === "profondeur")).toEqual([false, true, false]);  // 2e passe : les bras
    s.v.setMode("follow");  // la caméra seule change : le joueur caché aussi (track)
    s.next();
    expect(s.models()).toEqual(["a", "b"]);
    expect(capsules()).toEqual([]);
    s.v.setMode("pov");
    s.next();
    expect(s.models()).toEqual(["b"]);
    expect(image()).toHaveLength(3);
    expect(s.onFail).not.toHaveBeenCalled();
    s.v.dispose();
  });

  it("erreur dans la pose des modèles : retirés (bibliothèque libérée une fois, même si cela lève), silhouettes revenues, la 3D continue, jamais onFail ; d'autres fichiers les rendent", async () => {
    const s = setup(), first = files();
    s.v.setFrame(replay(), 320, null);
    s.v.setAgents(first.load);
    await agentsOn(s);
    const dispose = vi.spyOn(AgentLibrary.prototype, "dispose").mockImplementationOnce(() => { throw new Error("libération"); });
    const animate = vi.spyOn(AgentLayer.prototype, "animate").mockImplementation(() => { throw new Error("os manquant"); });
    vi.spyOn(console, "error").mockImplementation(() => {});
    s.v.setFrame(replay(), 330, null);
    s.next();
    expect(s.on).toEqual([true, false]);
    expect(capsules()).toEqual(["a", "b"]);
    expect(s.layer.group.children).toHaveLength(0);
    expect(dispose).toHaveBeenCalledOnce();
    const n = fake.renders.length;
    s.v.setFrame(replay(), 340, null);
    s.next();
    expect(fake.renders).toHaveLength(n + 1);  // la 3D continue
    expect(animate).toHaveBeenCalledOnce();  // pas de nouvel essai : pas d'erreur en rafale
    s.v.setAgents(first.load);  // même chargeur : rien
    s.v.setFrame(replay(), 350, null);
    s.next();
    expect(animate).toHaveBeenCalledOnce();
    expect(capsules()).toEqual(["a", "b"]);
    animate.mockRestore();
    s.v.setAgents(files().load);  // nouvelle liste de fichiers : modèles de nouveau
    await agentsOn(s);
    expect(capsules()).toEqual([]);
    expect(s.onFail).not.toHaveBeenCalled();
    s.v.dispose();
    expect(dispose).toHaveBeenCalledTimes(2);  // celle de l'erreur n'est pas libérée de nouveau
  });

  it("erreur de pose, et le retrait des modèles lève aussi : la bibliothèque est quand même libérée, la 3D continue", async () => {
    const s = setup(), { load } = files();
    s.v.setFrame(replay(), 320, null);
    s.v.setAgents(load);
    await agentsOn(s);
    const dispose = vi.spyOn(AgentLibrary.prototype, "dispose");
    vi.spyOn(AgentLayer.prototype, "animate").mockImplementation(() => { throw new Error("os manquant"); });
    vi.spyOn(AgentLayer.prototype, "setLibrary").mockImplementationOnce(() => { throw new Error("retrait"); });
    vi.spyOn(console, "error").mockImplementation(() => {});
    s.v.setFrame(replay(), 330, null);
    s.next();
    expect(dispose).toHaveBeenCalledOnce();
    expect(s.on).toEqual([true, false]);
    expect(capsules()).toEqual(["a", "b"]);
    const n = fake.renders.length;
    s.v.setFrame(replay(), 340, null);
    s.next();
    expect(fake.renders).toHaveLength(n + 1);
    expect(s.onFail).not.toHaveBeenCalled();
    s.v.dispose();
  });

  it("fichier « joueurs » en échec : onAgentsError (nom, erreur), ce camp en silhouettes, jamais onFail", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = setup(), err = new Error("404"), { load } = files();
    s.v.setAgents(async (name, signal) => { if (name === "agent-t") throw err; return load(name, signal); });
    const errors: unknown[][] = [];
    s.v.onAgentsError = (name, e) => { errors.push([name, e]); };  // posé après : relayé quand même
    s.v.setFrame(replay(), 320, null);
    await vi.waitFor(() => { s.next(); expect(errors).toEqual([["agent-t", err]]); expect(s.models()).toEqual(["a"]); }, LOAD);
    expect(capsules()).toEqual(["b"]);
    expect(s.on).toEqual([true]);
    expect(s.onFail).not.toHaveBeenCalled();
    s.v.dispose();
  });

  it("préchauffage (warmAgentAnim) au chargement de chaque round, une fois, avec des fichiers « joueurs » seulement", () => {
    warm.mockClear();
    const s = setup(), rounds = [replay(), replay(), replay()], which = () => warm.mock.calls.map(([r]) => rounds.indexOf(r));
    s.v.setFrame(rounds[0], 320, null);
    s.next();
    expect(warm).not.toHaveBeenCalled();  // sans fichiers « joueurs » : rien
    s.v.setAgents(files().load);  // fichiers posés après le round : préchauffé tout de suite
    expect(which()).toEqual([0]);
    s.v.setFrame(rounds[0], 330, null);
    s.next();
    expect(which()).toEqual([0]);  // même round
    s.v.setFrame(rounds[1], 320, null);  // nouveau round : avant sa première image
    expect(which()).toEqual([0, 1]);
    s.next();
    s.v.setAgents(null);
    s.v.setFrame(rounds[2], 320, null);
    s.next();
    expect(which()).toEqual([0, 1]);
    s.v.dispose();
  });

  it("vue cachée (replay en 2D) : rien — ni fichier demandé, ni préchauffage, ni arme d'inventaire ; à la reprise, tout, à l'instant courant", async () => {
    warm.mockClear();
    const s = setup(), { asked, load } = files(), r1 = replay(), r2 = replay({ more: ["Glock-18"] }), r3 = replay({ more: ["Desert Eagle"] });
    s.v.setFrame(r1, 320, null);
    s.next();
    s.v.pause();
    s.v.setAgents(load);
    s.v.setFrame(r2, 330, null);
    await new Promise((ok) => setTimeout(ok, 20));
    expect(asked).toEqual([]);
    expect(warm).not.toHaveBeenCalled();
    s.v.resume();
    expect(asked).toEqual(expect.arrayContaining(["agent-ct", "agent-t", "anims-rifle", "anims-pistol", "anims-knife",
      "anims-communes", "monde-ak47", "monde-glock"]));
    expect(warm.mock.calls.map(([r]) => r === r2)).toEqual([true]);
    await agentsOn(s);
    s.v.pause();
    const n = fake.renders.length;
    s.v.setFrame(r3, 340, null);  // en pause : la couche des agents n'en voit rien
    s.next();
    expect(asked).not.toContain("monde-deagle");
    expect(warm).toHaveBeenCalledOnce();
    expect(fake.renders).toHaveLength(n);
    s.v.resume();
    expect(asked).toContain("monde-deagle");
    expect(warm.mock.calls.map(([r]) => r === r3)).toEqual([false, true]);
    s.next();
    expect(s.models()).toEqual(["a", "b"]);
    expect(s.onFail).not.toHaveBeenCalled();
    s.v.dispose();
  });

  it("contexte rendu après l'envoi des textures : modèles retirés sans appel à la carte graphique, bibliothèque neuve, fichiers relus, modèles redessinés", async () => {
    vi.stubGlobal("ImageBitmap", Bitmap);
    const s = setup(), { asked, load } = files(), bitmaps: Bitmap[] = [], freed = vi.fn();
    // fichiers « joueurs » texturés : une image décodée par matériau ; libérations sur la carte graphique notées (`dispose`)
    const textured: AgentLoad = async (name, signal) => {
      const f = await load(name, signal);
      f?.scene.traverse((o) => {
        const m = o as Mesh, mat = m.material as MeshStandardMaterial;
        if (!m.isMesh || mat.map) return;
        const b = new Bitmap(), map = Object.assign(new Texture(b), { name });
        bitmaps.push(b);
        mat.map = map;
        for (const x of [m.geometry, mat, map]) x.addEventListener("dispose", () => freed(bitmaps.indexOf(b)));
      });
      return f;
    };
    s.v.setFrame(replay(), 320, null);
    s.v.setAgents(textured);
    // deux agents et l'AK-47 en main dessinés : envoyés, puis leurs images libérées
    await vi.waitFor(() => { s.next(); expect(bitmaps.map((b) => b.closed)).toEqual([1, 1, 1]); }, LOAD);
    const rigDispose = vi.spyOn(AgentRig.prototype, "dispose"), libDispose = vi.spyOn(AgentLibrary.prototype, "dispose");
    s.canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(rigDispose.mock.calls).toEqual([[true], [true]]);
    expect(libDispose.mock.calls).toEqual([[true]]);
    expect(s.layer.group.children).toHaveLength(0);
    s.next();
    expect(capsules()).toEqual(["a", "b"]);  // en attendant les fichiers relus
    await vi.waitFor(() => { s.next(); expect(bitmaps.map((b) => b.closed)).toEqual([1, 1, 1, 1, 1, 1]); }, LOAD);
    expect(s.models()).toEqual(["a", "b"]);
    for (const name of ["agent-ct", "agent-t", "anims-rifle", "monde-ak47"]) expect(asked.filter((x) => x === name), name).toHaveLength(2);
    expect(fake.blank).toEqual([]);  // jamais dessinés sans leurs images
    // les premiers, perdus avec le contexte : rien de libéré sur la carte graphique ; les suivants, au démontage
    expect(freed).not.toHaveBeenCalled();
    s.v.dispose();
    expect(new Set(freed.mock.calls.map(([k]) => k))).toEqual(new Set([3, 4, 5]));
    expect(s.onFail).not.toHaveBeenCalled();
  });

  it("contexte rendu sans image libérée : rien de refait (three renvoie géométries et textures), modèles gardés", async () => {
    const s = setup(), { asked, load } = files();
    s.v.setFrame(replay(), 320, null);
    s.v.setAgents(load);
    await agentsOn(s);
    const n = asked.length, dispose = vi.spyOn(AgentLibrary.prototype, "dispose"), rig = s.layer.rig("a");
    s.canvas.dispatchEvent(new Event("webglcontextrestored"));
    s.next();
    expect(dispose).not.toHaveBeenCalled();
    expect(asked).toHaveLength(n);
    expect(s.layer.rig("a")).toBe(rig);
    expect(capsules()).toEqual([]);
    s.v.dispose();
  });

  it("morts en ragdoll : collision de la carte et fichier « ragdoll » → chaque mort calculée hors du fil (worker), annoncée par onRagdolls ; dispose arrête le worker", async () => {
    const engine = new RagdollEngine(), sent: string[] = [];
    const port = { onmessage: null as ((e: MessageEvent<RagdollOut>) => void) | null, onerror: null, terminate: vi.fn(),
      postMessage(m: RagdollIn) { sent.push(m.type); const out = engine.handle(m); if (out) setTimeout(() => port.onmessage?.({ data: out } as MessageEvent<RagdollOut>)); } };
    const s = setup(() => port), { load } = files(), n: number[] = [];
    s.v.onRagdolls = (k) => { n.push(k); };
    const base = replay();
    const r = { ...base, deathForce: () => null,
      value: (k: string, i: number, j: number) => (k === "flags" ? (j === 0 && i === 1 ? 0 : 1) : base.value(k, i, j)),
      payload: { ...base.payload, kills: [{ tick: 320, victim: "a", attacker: "b", weapon: "ak47", victim_pos: [0, 0, 0], attacker_pos: [500, 0, 0] }] },
    } as unknown as Replay;
    s.v.setAgents(load);
    s.v.setCollision("de_nuke", new Float32Array([-2000, -2000, 0, 2000, -2000, 0, 2000, 2000, 0, -2000, -2000, 0, 2000, 2000, 0, -2000, 2000, 0]));
    s.v.setFrame(r, 400, null);
    await vi.waitFor(() => { s.next(); expect(n.at(-1)).toBe(1); }, LOAD);
    expect(sent).toEqual(["map", "def", "death"]);
    s.v.dispose();
    expect(port.terminate).toHaveBeenCalledTimes(1);
  });

  it("erreur du ragdoll : les modèles des joueurs restent, le ragdoll s'arrête pour ces fichiers (signalé une fois, plus d'essai)", async () => {
    const s = setup(), { load } = files();
    s.v.setFrame(replay(), 320, null);
    s.v.setAgents(load);
    await agentsOn(s);
    const pump = vi.spyOn(Ragdolls.prototype, "pump").mockImplementation(() => { throw new Error("ragdoll"); });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    s.v.setFrame(replay(), 330, null);
    s.next();
    s.v.setFrame(replay(), 340, null);
    s.next();
    expect(s.on).toEqual([true]);  // pas de retour aux silhouettes
    expect(capsules()).toEqual([]);
    expect(pump).toHaveBeenCalledOnce();  // pas de nouvel essai : pas d'erreur en rafale
    expect(error).toHaveBeenCalledOnce();
    s.v.dispose();
  });

  it("fichiers « joueurs » retirés : onRagdolls(0) (data-ragdolls à jour) ; autre carte affichée : collision de l'ancienne libérée dans le worker", async () => {
    const engine = new RagdollEngine(), sent: string[] = [];
    const port = { onmessage: null as ((e: MessageEvent<RagdollOut>) => void) | null, onerror: null, terminate: vi.fn(),
      postMessage(m: RagdollIn) { sent.push(m.type); const out = engine.handle(m); if (out) setTimeout(() => port.onmessage?.({ data: out } as MessageEvent<RagdollOut>)); } };
    const s = setup(() => port), { load } = files(), n: number[] = [];
    s.v.onRagdolls = (k) => { n.push(k); };
    const base = replay();
    const r = { ...base, deathForce: () => null,
      value: (k: string, i: number, j: number) => (k === "flags" ? (j === 0 && i === 1 ? 0 : 1) : base.value(k, i, j)),
      payload: { ...base.payload, kills: [{ tick: 320, victim: "a", attacker: "b", weapon: "ak47", victim_pos: [0, 0, 0], attacker_pos: [500, 0, 0] }] },
    } as unknown as Replay;
    const ID = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const land = () => new Group().add(new Mesh(new BufferGeometry().setAttribute("position", new Float32BufferAttribute([0, 0, 0, 100, 0, 0, 0, 100, 0], 3))));
    s.v.setMap(land(), ID, "de_nuke");
    s.v.setAgents(load);
    s.v.setCollision("de_nuke", new Float32Array([-2000, -2000, 0, 2000, -2000, 0, 2000, 2000, 0, -2000, -2000, 0, 2000, 2000, 0, -2000, 2000, 0]));
    s.v.setFrame(r, 400, null);
    await vi.waitFor(() => { s.next(); expect(n.at(-1)).toBe(1); }, LOAD);
    s.v.setAgents(null);
    s.next();
    expect(n).toEqual([1, 0]);
    s.v.setMap(land(), ID, "de_nuke");  // même carte (texturée après la grise) : collision gardée
    expect(sent).not.toContain("unmap");
    s.v.setMap(land(), ID, "de_dust2");
    expect(sent.at(-1)).toBe("unmap");
    s.v.dispose();
  });
});
