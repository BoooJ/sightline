// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Replay } from "../replay/engine/replay";
import { collisionFromScene } from "./collision";
import { fetchGlb, LoadError } from "./loader";
import Scene3D, { type Scene3DProps, shouldRefreshAssets } from "./Scene3D";
import type { Map3d } from "./types";

describe("shouldRefreshAssets (fichier « vue » en échec : relire la liste ?)", () => {
  it("fichier introuvable (404 : ré-exporté, nouvelle adresse) : oui", () => {
    expect(shouldRefreshAssets(new LoadError("erreur 404", 404))).toBe(true);
  });

  it("session expirée (401) : non, la liste relue ouvrirait l'écran de connexion", () => {
    expect(shouldRefreshAssets(new LoadError("erreur 401", 401))).toBe(false);
  });

  it("autres erreurs : non, la liste relue ne donnerait pas d'autre adresse (relue sinon toutes les 10 s, sans fin)", () => {
    expect(shouldRefreshAssets(new LoadError("erreur 403", 403))).toBe(false);
    expect(shouldRefreshAssets(new LoadError("erreur 500", 500))).toBe(false);
    expect(shouldRefreshAssets(new LoadError("connexion interrompue"))).toBe(false);  // pas de réponse : statut 0
    expect(shouldRefreshAssets(new LoadError("fichier 3D illisible"))).toBe(false);
    expect(shouldRefreshAssets(new Error("autre"))).toBe(false);
    expect(shouldRefreshAssets({ status: 404 })).toBe(false);  // seule une LoadError porte le statut HTTP
  });
});

/** Chargeur factice de `vmLoader` : les adresses des fichiers qu'il chargerait (triées). */
type FakeLoad = { urls: string[] };
interface FakeViewer {
  calls: string[];
  /** fichiers « joueurs » reçus (`setAgents`) : adresses du chargeur, null pour aucun */
  agents: (string[] | null)[];
  onAgents?: (shown: boolean) => void;
  onAgentsError?: (name: string, err: unknown) => void;
  /** collisions reçues (`setCollision`) : « carte:nombres », null pour aucune */
  collisions: (string | null)[];
  lose(): void;
}
// pas de WebGL sous jsdom : un Viewer factice note ce qu'on lui demande ; la carte est « téléchargée » et « lue » sans
// rien faire (comptée) ; ni bras, ni noms de zones. `lose()` : contexte graphique rendu alors que des images de la carte
// avaient été libérées après leur envoi (carte cachée, `onMapLost`). Liste des fichiers 3D : celle de `fake.list`, lue
// par une vraie requête de react-query (`fake.reads` : lectures), sans fichiers par défaut
const fake = vi.hoisted(() => ({ viewers: [] as FakeViewer[], ro: null as ResizeObserverCallback | null,
  list: (): object => ({}), reads: 0 }));
vi.mock("./viewer", () => ({
  Viewer: class {
    calls: string[] = [];
    agents: (string[] | null)[] = [];
    collisions: (string | null)[] = [];
    onMapLost?: () => void;
    private map: string | null = null;
    constructor() { fake.viewers.push(this as unknown as FakeViewer); }
    lose() { this.map = null; this.onMapLost?.(); }
    shown() { return this.map; }
    setMap(_root: unknown, _w2m: unknown, name: string) { this.map = name; this.calls.push(`carte ${name}`); }
    setFrame(_r: unknown, tick: number) { this.calls.push(`instant ${tick}`); }
    setMode() {}
    setViewmodel() {}
    setAgents(load: FakeLoad | null) { this.agents.push(load ? load.urls : null); }
    setCollision(map: string, tri: Float32Array | null) { this.collisions.push(tri ? `${map}:${tri.length}` : null); }
    resize(w: number, h: number) { this.calls.push(`taille ${w}×${h}`); }
    recenter() { this.calls.push("recentrer"); }
    pause() { this.calls.push("pause"); }
    resume() { this.calls.push("reprise"); }
    dispose() { this.calls.push("libéré"); }
    pick() { return null; }
  },
}));
vi.mock("./loader", async (orig) => ({ ...(await orig<typeof import("./loader")>()),
  fetchGlb: vi.fn(async () => new ArrayBuffer(0)), parseGlb: vi.fn(async () => ({})) }));
vi.mock("./collision", () => ({ collisionFromScene: vi.fn(() => new Float32Array(9)) }));
vi.mock("./assets", async () => {
  const { useQuery } = await import("@tanstack/react-query");
  return {
    useAssets3d: () => useQuery({ queryKey: ["assets3d"], queryFn: async () => { fake.reads++; return fake.list(); }, retry: false,
      staleTime: Infinity }),
    vmLoader: (files: Record<string, { url: string }>): FakeLoad => ({ urls: Object.values(files).map((f) => f.url).sort() }),
  };
});
vi.mock("../../shared/callouts", () => ({ usePlaceAt: () => () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Root[] = [];
afterEach(() => {
  act(() => roots.splice(0).forEach((r) => r.unmount()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.mocked(fetchGlb).mockClear();
  fake.viewers.length = 0;
  fake.ro = null;
  fake.list = () => ({});
  fake.reads = 0;
});

describe("vue 3D cachée pendant la 2D, puis de nouveau affichée", () => {
  const replay = { payload: { map_name: "de_nuke", match_id: 1, round: { number: 2 } } } as unknown as Replay;
  const map3d = { map: "de_nuke", build: "1", exported_at: "", checks: {}, world_to_model: [],
    variants: { gray: { url: "/api/maps3d/de_nuke/gray-000000000000.glb", size: 10 },
      textured: { url: "/api/maps3d/de_nuke/textured-000000000000.glb", size: 40 } } } as Map3d;
  const props = (tick: number, active: boolean, over: Partial<Scene3DProps> = {}): Scene3DProps => ({ replay, map3d,
    variant: "gray", onVariant: () => {}, tick, selected: null, onSelect: () => {}, onFail: () => {}, radar: null,
    score: { ct: 0, t: 0 }, active, ...over });
  /** Téléchargement suivant de `fetchGlb` tenu en attente : `done()` le termine, `fail(e)` le fait échouer. */
  const held = () => {
    let done!: () => void, fail!: (e: Error) => void;
    vi.mocked(fetchGlb).mockImplementationOnce(() => new Promise<ArrayBuffer>((ok, ko) => {
      done = () => ok(new ArrayBuffer(0));
      fail = ko;
    }));
    return { done: () => act(async () => done()), fail: (e: Error) => act(async () => fail(e)) };
  };
  const mount = async (p: Scene3DProps) => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as never);
    vi.stubGlobal("ResizeObserver", class { constructor(cb: ResizeObserverCallback) { fake.ro = cb; } observe() {} disconnect() {} });
    const div = document.createElement("div"), root = createRoot(div), qc = new QueryClient();
    roots.push(root);
    const render = async (q: Scene3DProps) => {
      await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(Scene3D, q))));
    };
    await render(p);
    return { scene: () => div.querySelector<HTMLElement>('[data-testid="scene3d"]')!, render };
  };
  const size = (w: number, h: number) => act(() => fake.ro!([{ contentRect: { width: w, height: h } } as ResizeObserverEntry], {} as ResizeObserver));

  it("même Viewer et carte chargée une seule fois ; en pause pendant la 2D, reprise à l'instant courant au retour", async () => {
    const { scene, render } = await mount(props(100, true));
    expect(scene().dataset.state).toBe("ready");
    await render(props(100, false));  // passage en 2D
    expect(scene().hidden).toBe(true);
    await render(props(180, false));  // lecture en 2D (la page ne la rend plus : `LazyScene3D` ; ici, au cas où)
    await render(props(250, true));  // retour en 3D, plus loin dans le round
    expect(scene().hidden).toBe(false);
    expect(scene().dataset.state).toBe("ready");
    expect(fake.viewers).toHaveLength(1);
    expect(fetchGlb).toHaveBeenCalledTimes(1);
    // 1re reprise : à la création (déjà en marche, sans effet sur un vrai Viewer)
    expect(fake.viewers[0].calls).toEqual(["reprise", "instant 100", "carte de_nuke", "pause", "reprise", "instant 250"]);
  });

  it("cachée : rien à faire pour la taille nulle de la vue, ni pour « Recentrer » (0) ; de nouveau affichée : les deux", async () => {
    const { render } = await mount(props(100, true));
    const v = fake.viewers[0];
    size(800, 600);
    await render(props(100, false));
    size(0, 0);  // vue cachée
    act(() => { window.dispatchEvent(new CustomEvent("radar-zoom", { detail: "reset" })); });  // recentre le radar 2D seul
    expect(v.calls.filter((c) => c.startsWith("taille") || c === "recentrer")).toEqual(["taille 800×600"]);
    await render(props(100, true));
    size(800, 600);
    act(() => { window.dispatchEvent(new CustomEvent("radar-zoom", { detail: "reset" })); });
    expect(v.calls.filter((c) => c.startsWith("taille") || c === "recentrer")).toEqual(["taille 800×600", "taille 800×600", "recentrer"]);
  });

  // le chargement de la carte continue pendant la 2D (il n'est annulé qu'en quittant la page ou en changeant de carte) : la
  // carte est prête au retour
  it("chargement fini pendant la 2D : « ready » au retour, aucun nouveau téléchargement", async () => {
    const glb = held();
    const { scene, render } = await mount(props(100, true));
    expect(scene().dataset.state).toBe("loading");
    await render(props(100, false));
    await glb.done();
    expect(fake.viewers[0].calls).toContain("carte de_nuke");  // posée pendant la cachette, dessinée au retour
    expect(scene().dataset.state).toBe("ready");
    await render(props(140, true));
    expect(scene().dataset.state).toBe("ready");
    expect(fetchGlb).toHaveBeenCalledTimes(1);
    expect(fake.viewers).toHaveLength(1);
  });

  it("texturée en échec pendant la 2D : repli sur la grise par la fonction du dernier rendu (celle d'une page en 2D)", async () => {
    // la grise s'affiche d'abord, la texturée arrive ensuite ; on repasse en 2D entre les deux
    vi.mocked(fetchGlb).mockImplementationOnce(async () => new ArrayBuffer(0));
    const textured = held();
    const shown = vi.fn(), in2d = vi.fn();
    const { scene, render } = await mount(props(100, true, { variant: "textured", onVariant: shown }));
    expect(scene().dataset.state).toBe("loading");
    await render(props(100, false, { variant: "textured", onVariant: in2d }));
    await textured.fail(new LoadError("connexion interrompue"));
    expect(shown).not.toHaveBeenCalled();  // elle remettait la page en 3D (`setVariant` d'un rendu en 3D)
    expect(in2d).toHaveBeenCalledWith("gray");
    expect(scene().dataset.state).toBe("ready");
  });

  it("collision de la carte (morts en ragdoll) : téléchargée une fois la carte affichée, posée sur la vue ; sans collision : aucune", async () => {
    const col = { ...map3d, variants: { ...map3d.variants, collision: { url: "/api/maps3d/de_nuke/collision-000000000000.glb", size: 5 } } } as Map3d;
    await mount(props(100, true, { map3d: col }));
    await vi.waitFor(() => expect(fake.viewers[0].collisions).toEqual(["de_nuke:9"]));
    expect(vi.mocked(fetchGlb).mock.calls.map(([u]) => u)).toEqual(["/api/maps3d/de_nuke/gray-000000000000.glb", "/api/maps3d/de_nuke/collision-000000000000.glb"]);
    expect(vi.mocked(collisionFromScene).mock.calls[0][1]).toEqual(col.world_to_model);
    await mount(props(100, true));
    await vi.waitFor(() => expect(fake.viewers[1].collisions).toEqual([null]));
  });

  const withCollision = { ...map3d, variants: { ...map3d.variants, collision: { url: "/api/maps3d/de_nuke/collision-000000000000.glb", size: 5 } } } as Map3d;

  it("collision en échec (téléchargement ou fichier illisible) : un seul avertissement, ni collision posée ni onFail ; la 3D reste prête", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onFail = vi.fn();
    vi.mocked(fetchGlb).mockImplementationOnce(async () => new ArrayBuffer(0));  // la carte
    vi.mocked(fetchGlb).mockImplementationOnce(async () => { throw new LoadError("erreur 500", 500); });  // sa collision
    const a = await mount(props(100, true, { map3d: withCollision, onFail }));
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(String(warn.mock.calls[0][0])).toMatch(/Collision 3D non chargée/);
    expect([fake.viewers[0].collisions, a.scene().dataset.state]).toEqual([[], "ready"]);
    vi.mocked(collisionFromScene).mockImplementationOnce(() => { throw new Error("pas de maillage sl_collision"); });
    const b = await mount(props(100, true, { map3d: withCollision, onFail }));
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect([fake.viewers[1].collisions, b.scene().dataset.state, warn.mock.calls.length]).toEqual([[], "ready", 2]);
    expect(onFail).not.toHaveBeenCalled();
  });

  it("changement de carte pendant le téléchargement de la collision : annulé, celle de l'ancienne carte n'est jamais posée", async () => {
    const read = vi.mocked(collisionFromScene).mock.calls.length;
    vi.mocked(fetchGlb).mockImplementationOnce(async () => new ArrayBuffer(0));  // carte de_nuke
    const collision = held();  // sa collision, tenue
    const { render } = await mount(props(100, true, { map3d: withCollision }));
    await vi.waitFor(() => expect(fetchGlb).toHaveBeenCalledTimes(2));
    const signal = vi.mocked(fetchGlb).mock.calls[1][3] as AbortSignal;
    expect(signal.aborted).toBe(false);
    const dust = { ...map3d, map: "de_dust2", variants: { gray: { url: "/api/maps3d/de_dust2/gray-000000000000.glb", size: 10 } } } as Map3d;
    await render(props(100, true, { map3d: dust }));
    expect(signal.aborted).toBe(true);
    await collision.done();  // arrivée trop tard
    await vi.waitFor(() => expect(fake.viewers[0].calls).toContain("carte de_dust2"));
    await vi.waitFor(() => expect(fake.viewers[0].collisions).toEqual([null]));  // de_dust2 : sans collision
    expect(vi.mocked(collisionFromScene).mock.calls.length).toBe(read);  // jamais lue
  });
});

describe("contexte graphique rendu, images de la carte libérées après leur envoi", () => {
  const replay = { payload: { map_name: "de_nuke", match_id: 1, round: { number: 2 } } } as unknown as Replay;
  const gray = "/api/maps3d/de_nuke/gray-000000000000.glb", textured = "/api/maps3d/de_nuke/textured-000000000000.glb";
  const map3d = { map: "de_nuke", build: "1", exported_at: "", checks: {}, world_to_model: [],
    variants: { gray: { url: gray, size: 10 }, textured: { url: textured, size: 40 } } } as Map3d;
  const props = (active: boolean): Scene3DProps => ({ replay, map3d, variant: "textured", onVariant: () => {}, tick: 100,
    selected: null, onSelect: () => {}, onFail: () => {}, radar: null, score: { ct: 0, t: 0 }, active });
  const mount = async (p: Scene3DProps) => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as never);
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const div = document.createElement("div"), root = createRoot(div), qc = new QueryClient();
    roots.push(root);
    const render = async (q: Scene3DProps) => {
      await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(Scene3D, q))));
    };
    await render(p);
    return { scene: () => div.querySelector<HTMLElement>('[data-testid="scene3d"]')!, render };
  };
  const urls = () => vi.mocked(fetchGlb).mock.calls.map(([u]) => u);
  const maps = () => fake.viewers[0].calls.filter((c) => c.startsWith("carte"));

  it("carte relue et reposée comme au premier affichage (grise, puis texturée : leurs copies du navigateur), même Viewer", async () => {
    const { scene } = await mount(props(true));
    await vi.waitFor(() => expect(maps()).toHaveLength(2));
    expect(urls()).toEqual([gray, textured]);
    await act(async () => fake.viewers[0].lose());
    await vi.waitFor(() => expect(maps()).toHaveLength(4));
    expect(urls()).toEqual([gray, textured, gray, textured]);
    expect(scene().dataset.state).toBe("ready");
    expect(fake.viewers).toHaveLength(1);
  });

  it("pendant la 2D aussi : relue cachée, prête au retour", async () => {
    const { scene, render } = await mount(props(true));
    await vi.waitFor(() => expect(maps()).toHaveLength(2));
    await render(props(false));
    await act(async () => fake.viewers[0].lose());
    await vi.waitFor(() => expect(maps()).toHaveLength(4));
    await render(props(true));
    expect(scene().dataset.state).toBe("ready");
    expect(urls()).toHaveLength(4);
  });
});

describe("fichiers « joueurs » (modèles d'agents)", () => {
  const replay = { payload: { map_name: "de_nuke", match_id: 1, round: { number: 2 } } } as unknown as Replay;
  const map3d = { map: "de_nuke", build: "1", exported_at: "", checks: {}, world_to_model: [],
    variants: { gray: { url: "/api/maps3d/de_nuke/gray-000000000000.glb", size: 10 } } } as Map3d;
  const props = (active = true): Scene3DProps => ({ replay, map3d, variant: "gray", onVariant: () => {}, tick: 100,
    selected: null, onSelect: () => {}, onFail: () => {}, radar: null, score: { ct: 0, t: 0 }, active });
  /** Liste avec des fichiers « joueurs » aux adresses suffixées par `tag` (un nouvel export les change), exportés à `at`. */
  const joueurs = (tag: string, at = "2026-11-02T10:00:00Z") => ({ joueurs: { build: "2000939", exported_at: at, files: {
    "agent-ct": { url: `/api/assets3d/joueurs/agent-ct-${tag}.glb`, size: 1 },
    "agent-t": { url: `/api/assets3d/joueurs/agent-t-${tag}.glb`, size: 1 } } } });
  const urls = (tag: string) => [`/api/assets3d/joueurs/agent-ct-${tag}.glb`, `/api/assets3d/joueurs/agent-t-${tag}.glb`];
  const mount = async (p: Scene3DProps) => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as never);
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const div = document.createElement("div"), root = createRoot(div), qc = new QueryClient();
    roots.push(root);
    const render = async (q: Scene3DProps) => {
      await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(Scene3D, q))));
    };
    await render(p);
    return { scene: () => div.querySelector<HTMLElement>('[data-testid="scene3d"]')!, render, qc, v: fake.viewers[0] };
  };
  /** Liste relue (comme après 5 min), et la vue rendue avec ce qu'elle donne : react-query prévient ses abonnés au tour
   *  suivant de la boucle d'événements (setTimeout). */
  const reread = (qc: QueryClient) => act(async () => {
    await qc.invalidateQueries({ queryKey: ["assets3d"] });
    await new Promise((r) => setTimeout(r, 10));
  });
  /** Chargeurs donnés au Viewer (null : aucun fichier, sans effet sur un vrai Viewer qui n'en avait pas). */
  const loaders = (v: FakeViewer) => v.agents.filter((a) => a !== null);
  /** Échec d'un fichier « joueurs » signalé par le Viewer, puis le temps d'une éventuelle relecture de la liste et du
   *  rendu de ce qu'elle donne (voir `reread`). */
  const failAgent = (v: FakeViewer, err: unknown) => act(async () => {
    v.onAgentsError?.("agent-t", err);
    await new Promise((r) => setTimeout(r, 10));
  });

  it("sans fichiers « joueurs » (aucun fichier 3D, ou « vue » seulement) : aucun chargeur au Viewer, data-agents « off »", async () => {
    fake.list = () => ({ vue: { build: "1", exported_at: "", files: { "bras-ct": { url: "/api/assets3d/vue/bras-ct-0.glb", size: 1 } } } });
    const { scene, v } = await mount(props());
    await vi.waitFor(() => expect(fake.reads).toBe(1));
    expect(loaders(v)).toEqual([]);
    expect(scene().dataset.agents).toBe("off");
  });

  it("fichiers « joueurs » : leur chargeur au Viewer ; liste relue aux mêmes adresses : le même ; nouvelles adresses : un nouveau, vue cachée (2D) comprise", async () => {
    fake.list = () => joueurs("000000000000");
    const { render, qc, v } = await mount(props());
    await vi.waitFor(() => expect(loaders(v)).toEqual([urls("000000000000")]));
    // même contenu ré-envoyé (autre date d'export, mêmes adresses) : fichiers gardés, rien de redemandé
    fake.list = () => joueurs("000000000000", "2026-11-03T10:00:00Z");
    await reread(qc);
    expect(fake.reads).toBe(2);
    expect(loaders(v)).toEqual([urls("000000000000")]);
    // nouvel export pendant la 2D : le Viewer reçoit les nouveaux fichiers (il ne les demande qu'à la reprise)
    await render(props(false));
    fake.list = () => joueurs("111111111111");
    await reread(qc);
    expect(loaders(v)).toEqual([urls("000000000000"), urls("111111111111")]);
    // fichiers « joueurs » retirés du serveur : plus de chargeur, silhouettes
    fake.list = () => ({});
    await reread(qc);
    expect(v.agents.at(-1)).toBeNull();
  });

  it("data-agents suit les joueurs dessinés en modèles à la dernière image (Viewer.onAgents)", async () => {
    fake.list = () => joueurs("000000000000");
    const { scene, v } = await mount(props());
    expect(scene().dataset.agents).toBe("off");
    act(() => v.onAgents?.(true));
    expect(scene().dataset.agents).toBe("on");
    act(() => v.onAgents?.(false));
    expect(scene().dataset.agents).toBe("off");
  });

  it("fichier « joueurs » introuvable (404 : ré-exporté) : liste relue, nouveaux fichiers au Viewer", async () => {
    fake.list = () => joueurs("000000000000");
    const { v } = await mount(props());
    await vi.waitFor(() => expect(loaders(v)).toHaveLength(1));
    fake.list = () => joueurs("111111111111");
    await failAgent(v, new LoadError("erreur 404", 404));
    expect(loaders(v)).toEqual([urls("000000000000"), urls("111111111111")]);
    expect(fake.reads).toBe(2);
  });

  it("fichier « joueurs » en 401 (session expirée), 500, réseau coupé ou illisible : liste pas relue (la bibliothèque réessaie seule)", async () => {
    fake.list = () => joueurs("000000000000");
    const { v } = await mount(props());
    await vi.waitFor(() => expect(loaders(v)).toHaveLength(1));
    for (const err of [new LoadError("erreur 401", 401), new LoadError("erreur 500", 500), new LoadError("connexion interrompue"),
      new LoadError("fichier 3D illisible")]) await failAgent(v, err);
    expect(fake.reads).toBe(1);
    expect(loaders(v)).toHaveLength(1);
  });
});
