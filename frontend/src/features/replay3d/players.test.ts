import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Line, type Material, Mesh, type Object3D, OrthographicCamera, PerspectiveCamera, Plane, Raycaster, Sprite, Vector3 } from "three";
import type { KillEvent, Vec3 } from "../../shared/api/types";
import type { PlayerState } from "../replay/engine/state";
import type { Theme } from "../replay/renderer/theme";
import { MODEL_TAG_Z, PlayerLayer, tagPx, unitsPerPx } from "./players";

const theme: Theme = { ct: "#5d9cec", t: "#e8b04b", smoke: "#cccccc", fire: "#ff6a00", flash: "#ffffff", he: "#ff3b3b",
  fg: "#e6e9ec", bg: "#0c0f12", accent: "#2ee6a6" };
const player = (steamid: string, x: number, alive = true): PlayerState => ({
  steamid, name: steamid, side: "CT", slot: 1, x, y: 0, z: 0, yaw: 0, hp: 100, armor: 100, alive, helmet: false,
  defuser: false, hasBomb: false, defusing: false, scoped: false, flash: 0, money: 0, weapon: "", inventory: [], equip: 0,
  pitch: 0, duck: 0, airborne: false, clip: null, reserve: null, zoom: 0, keys: 0, crosshair: null,
  fov: 0, viewmodel: null });
const kill = (victim_pos: Vec3): KillEvent => ({
  tick: 10, attacker: "a", victim: "v", assister: null, weapon: "ak47", headshot: false, penetrated: 0, through_smoke: false,
  noscope: false, attacker_blind: false, flash_assist: false, attacker_pos: null, victim_pos, is_opening: false, is_trade: false });

const all = (o: Object3D) => { const out: Object3D[] = []; o.traverse((x) => { out.push(x); }); return out; };
const sids = (l: PlayerLayer) => all(l.group).map((o) => o.userData.sid as string | undefined).filter(Boolean).sort();
// croix : les seules mailles sans joueur
const crossXs = (l: PlayerLayer) => all(l.group).filter((o) => o instanceof Mesh && !o.userData.sid).map((o) => o.position.x);

// pas de canvas en node : un contexte 2D qui ne dessine rien suffit aux étiquettes
beforeEach(() => {
  const ctx = new Proxy({}, { get: () => () => {}, set: () => true });
  vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) });
});
afterEach(() => vi.unstubAllGlobals());

describe("couche joueurs", () => {
  it("un joueur absent des états courants (autre round, autre match) disparaît de la scène", () => {
    const layer = new PlayerLayer(theme, []);
    layer.update([player("a", 0), player("b", 100)], [], null);
    expect(sids(layer)).toEqual(["a", "b"]);
    layer.update([player("c", 0)], [], null);
    expect(sids(layer)).toEqual(["c"]);
    layer.update([player("a", 0), player("c", 50)], [], null);
    expect(sids(layer)).toEqual(["a", "c"]);
  });
  it("étiquettes : taille donnée en pixels, posées au-dessus du joueur en vue de dessus, même créées ensuite", () => {
    const layer = new PlayerLayer(theme, []);
    layer.update([player("a", 0)], [], null);
    layer.setTagSize(4, 22, true);
    layer.update([player("a", 0), player("b", 100)], [], null);
    const labels = all(layer.group).filter((o): o is Sprite => o instanceof Sprite && !!o.material.map);
    expect(labels).toHaveLength(2);
    for (const l of labels) {
      expect(l.scale.y).toBeCloseTo(88, 6);
      expect(l.scale.x / l.scale.y).toBeCloseTo(5, 6);
      expect(l.center.y).toBeLessThan(0);  // le bas de l'étiquette au-dessus du point du joueur
    }
    layer.setTagSize(0.001, 22, false);
    expect(labels[0].center.y).toBe(0.5);
  });
  it("croix de mort : un autre round avec le même nombre de morts remplace les croix", () => {
    const layer = new PlayerLayer(theme, []);
    layer.update([], [kill([0, 0, 0])], null);
    expect(crossXs(layer)).toEqual([0, 0]);
    layer.update([], [kill([500, 0, 0])], null);
    expect(crossXs(layer)).toEqual([500, 500]);
    layer.update([], [], null);
    expect(crossXs(layer)).toEqual([]);
  });
  it("coupe « au-dessus de » : les croix prennent le plan partagé, jamais les joueurs, leur regard, étiquette ni halo", () => {
    const clip = [new Plane(new Vector3(0, 0, -1), 1e9)], layer = new PlayerLayer(theme, clip);
    layer.update([{ ...player("a", 0), flash: 1 }, player("b", 100)], [kill([0, 0, 0])], "a");  // a : choisi, flashé
    const objs = all(layer.group).filter((o): o is Mesh | Line | Sprite => o instanceof Mesh || o instanceof Line || o instanceof Sprite);
    const crosses = objs.filter((o) => o instanceof Mesh && !o.userData.sid), rest = objs.filter((o) => !crosses.includes(o));
    expect(crosses).toHaveLength(2);
    for (const o of crosses) expect((o.material as Material).clippingPlanes).toBe(clip);
    expect(rest).toHaveLength(8);  // corps, regard, étiquette et halo des deux joueurs
    for (const o of rest) expect((o.material as Material).clippingPlanes ?? []).toHaveLength(0);
  });
});

describe("vue du joueur", () => {
  it("le joueur dont on prend la vue est caché (corps, regard, étiquette, halo), ses objets restent dans le groupe", () => {
    const layer = new PlayerLayer(theme, []);
    const a = { ...player("a", 300), flash: 1 }, b = player("b", 100);
    const objs = () => all(layer.group).filter((o): o is Mesh | Line | Sprite => o instanceof Mesh || o instanceof Line || o instanceof Sprite);
    // x des objets visibles ; celui du trait du regard est dans sa géométrie
    const xs = () => objs().filter((o) => o.visible)
      .map((o) => (o instanceof Line ? o.geometry.getAttribute("position").getX(0) : o.position.x)).sort((p, q) => p - q);
    layer.update([a, b], [], null, "a");
    expect(objs()).toHaveLength(8);
    expect(xs()).toEqual([100, 100, 100]);  // b : corps, regard, étiquette (pas de halo : pas flashé)
    layer.update([a, b], [], null, null);
    expect(xs()).toEqual([100, 100, 100, 300, 300, 300, 300]);  // a revient, halo compris
  });
});

describe("aides d'analyse (vue du joueur : rien que ce que voyait le joueur)", () => {
  const objs = (l: PlayerLayer) => all(l.group).filter((o): o is Mesh | Line | Sprite => o instanceof Mesh || o instanceof Line || o instanceof Sprite);
  // objets dessinés : eux et tous leurs parents visibles
  const drawn = (l: PlayerLayer) => objs(l).filter((o) => {
    for (let x: Object3D | null = o; x; x = x.parent) if (!x.visible) return false;
    return true;
  });
  const kinds = (l: PlayerLayer) => ({
    bodies: drawn(l).filter((o) => o instanceof Mesh && o.userData.sid).length,
    crosses: drawn(l).filter((o) => o instanceof Mesh && !o.userData.sid).length,
    looks: drawn(l).filter((o) => o instanceof Line).length,
    sprites: drawn(l).filter((o) => o instanceof Sprite).length });
  const flashed = { ...player("a", 300), flash: 1 };

  it("sans aides : les corps restent, mais ni noms et barres de vie, ni regards, ni halos, ni croix des morts", () => {
    const layer = new PlayerLayer(theme, []);
    layer.update([flashed, player("b", 100)], [kill([0, 0, 0])], null, null, false);
    expect(kinds(layer)).toEqual({ bodies: 2, crosses: 0, looks: 0, sprites: 0 });
  });
  it("avec les aides (autres caméras, et par défaut) : corps, regards, étiquettes, halo du flashé, croix", () => {
    const layer = new PlayerLayer(theme, []);
    layer.update([flashed, player("b", 100)], [kill([0, 0, 0])], null, null, true);
    expect(kinds(layer)).toEqual({ bodies: 2, crosses: 2, looks: 2, sprites: 3 });  // 2 étiquettes + 1 halo
    layer.update([flashed, player("b", 100)], [kill([0, 0, 0])], null, null);
    expect(kinds(layer)).toEqual({ bodies: 2, crosses: 2, looks: 2, sprites: 3 });
  });
  it("aides coupées puis remises sur le même instant : tout revient, à la bonne place", () => {
    const layer = new PlayerLayer(theme, []);
    layer.update([flashed, player("b", 100)], [kill([0, 0, 0])], null, null, false);
    const later = [{ ...flashed, x: 700 }, { ...player("b", 100), hp: 40 }];
    layer.update(later, [kill([0, 0, 0])], null, null, false);  // l'instant avance sans les aides
    layer.update(later, [kill([0, 0, 0])], null, null, true);
    expect(kinds(layer)).toEqual({ bodies: 2, crosses: 2, looks: 2, sprites: 3 });
    const labels = objs(layer).filter((o): o is Sprite => o instanceof Sprite && !!o.material.map).map((s) => s.position.x);
    expect(labels.sort((p, q) => p - q)).toEqual([100, 700]);
    const looks = objs(layer).filter((o): o is Line => o instanceof Line).map((l) => l.geometry.getAttribute("position").getX(0));
    expect(looks.sort((p, q) => p - q)).toEqual([100, 700]);
  });
  it("les croix suivent l'instant même sans aides : à leur retour, celles du bon instant", () => {
    const layer = new PlayerLayer(theme, []);
    layer.update([], [], null, null, false);
    layer.update([], [kill([500, 0, 0])], null, null, false);
    layer.update([], [kill([500, 0, 0])], null, null, true);
    expect(crossXs(layer)).toEqual([500, 500]);
    expect(kinds(layer).crosses).toBe(2);
  });
  it("sans aides, le joueur dont on prend la vue reste caché", () => {
    const layer = new PlayerLayer(theme, []);
    layer.update([player("a", 300), player("b", 100)], [], null, "a", false);
    expect(kinds(layer)).toEqual({ bodies: 1, crosses: 0, looks: 0, sprites: 0 });
  });
});

describe("taille des étiquettes à l'écran", () => {
  it("vue de dessus (orthographique) : en unités du jeu, selon la demi-hauteur de la vue", () => {
    expect(unitsPerPx(new OrthographicCamera(-1500, 1500, 1000, -1000), 500)).toBeCloseTo(4, 9);
  });
  it("perspective : en hauteur de vue (three multiplie par la distance)", () => {
    expect(unitsPerPx(new PerspectiveCamera(70), 700)).toBeCloseTo((2 * Math.tan((35 * Math.PI) / 180)) / 700, 9);
  });
  it("au moins 22 px de haut (texte d'environ 11 px), même sur un petit canvas", () => {
    expect(tagPx(375)).toBe(22);
    expect(tagPx(2000)).toBe(40);
  });
});

describe("joueurs en modèles d'agents (setModelled)", () => {
  it("silhouette cachée sous le modèle mais toujours cliquable ; pas de croix sous un corps au sol", () => {
    const layer = new PlayerLayer(theme, []), dead = { ...kill([300, 0, 0]), victim: "b" };
    layer.update([player("a", 0), player("b", 300, false)], [dead], null);
    expect(crossXs(layer)).toEqual([300, 300]);
    layer.setModelled(new Set(["a", "b"]));
    const body = all(layer.group).find((o) => o instanceof Mesh && o.userData.sid === "a")!;
    expect(body.visible).toBe(false);
    expect(crossXs(layer)).toEqual([]);
    const ray = new Raycaster(new Vector3(0, -500, 36), new Vector3(0, 1, 0));
    expect(layer.pick(ray)).toBe("a");
    layer.update([player("a", 0), player("b", 300, false)], [dead], null);  // instant suivant : toujours cachée
    expect(body.visible).toBe(false);
    layer.setModelled(new Set());
    expect(body.visible).toBe(true);
    expect(crossXs(layer)).toEqual([300, 300]);
  });
  it("même contenu : rien de refait (croix gardées)", () => {
    const layer = new PlayerLayer(theme, []), dead = { ...kill([300, 0, 0]), victim: "b" };
    layer.update([player("a", 0), player("b", 300, false)], [dead], null);
    layer.setModelled(new Set(["a"]));
    const bars = all(layer.group).filter((o) => o instanceof Mesh && !o.userData.sid);
    expect(bars).toHaveLength(2);
    layer.setModelled(new Set(["a"]));
    expect(all(layer.group).filter((o) => o instanceof Mesh && !o.userData.sid)).toEqual(bars);
  });
  it("clic : jamais un mort ni le joueur dont on prend la vue, modèle ou non", () => {
    const layer = new PlayerLayer(theme, []), ray = () => new Raycaster(new Vector3(0, -500, 36), new Vector3(0, 1, 0));
    layer.update([player("a", 0, false)], [], null);
    layer.setModelled(new Set(["a"]));
    expect(layer.pick(ray())).toBeNull();  // corps au sol
    layer.update([player("a", 0)], [], null, "a");
    expect(layer.pick(ray())).toBeNull();  // vue du joueur
    layer.update([player("a", 0)], [], null);
    expect(layer.pick(ray())).toBe("a");
  });
  it("ensemble réécrit en place par l'appelant (agentLayer.ts le garde d'une image à l'autre) : changement vu quand même", () => {
    const layer = new PlayerLayer(theme, []), sids = new Set<string>(["a"]);
    layer.update([player("a", 0), player("b", 300)], [], null);
    layer.setModelled(sids);
    const body = (sid: string) => all(layer.group).find((o) => o instanceof Mesh && o.userData.sid === sid)!;
    expect([body("a").visible, body("b").visible]).toEqual([false, true]);
    sids.clear();
    sids.add("b");
    layer.setModelled(sids);
    expect([body("a").visible, body("b").visible]).toEqual([true, false]);
  });
  it("joueur dessiné en modèle : bas de sa barre de vie ancré à 73 unités au-dessus des pieds, debout comme accroupi (même hauteur au-dessus de la tête à toute distance) ; silhouette et vue de dessus : comme avant", () => {
    expect(MODEL_TAG_Z).toBe(73);
    const layer = new PlayerLayer(theme, []), crouched = { ...player("a", 0), z: 10, duck: 1 };
    const label = () => all(layer.group).find((o): o is Sprite => o instanceof Sprite && !!o.material.map)!;
    layer.setTagSize(0.001, 22, false);
    layer.update([crouched], [], null);
    const capsule = [label().position.z, label().center.y];
    expect(capsule).toEqual([10 + 72 + 26, 0.5]);  // silhouette : centre de l'étiquette 26 u au-dessus d'elle
    layer.setModelled(new Set(["a"]));
    // ancre du sprite au bas de la barre de vie (ligne 48 du canvas de 52) : posé à 73 u au-dessus des pieds
    expect([label().position.z, label().center.y]).toEqual([10 + 73, 4 / 52]);
    layer.update([{ ...crouched, duck: 0 }], [], null);
    expect(label().position.z).toBe(10 + 73);  // debout : la même
    layer.setTagSize(0.002, 30, false);  // autre caméra (plus loin ou plus près) : même ancre
    expect(label().center.y).toBe(4 / 52);
    layer.setTagSize(2, 22, true);  // vue de dessus : au-dessus du point du joueur, comme les autres
    expect(label().center.y).toBeLessThan(0);
    layer.setTagSize(0.001, 22, false);
    layer.setModelled(new Set());
    expect([label().position.z, label().center.y]).toEqual(capsule);
  });
  it("joueur choisi : son nom à la couleur d'accent (repère sous son modèle, qui n'a pas d'anneau) ; les autres en blanc", () => {
    const painted: string[] = [];  // couleur de chaque texte écrit
    const ctx = new Proxy({ fillStyle: "" } as Record<string, unknown>, {
      get: (o, k) => (k === "fillText" ? () => painted.push(o.fillStyle as string) : k in o ? o[k as string] : () => {}),
      set: (o, k, v) => { o[k as string] = v; return true; } });
    vi.stubGlobal("document", { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) });
    const layer = new PlayerLayer(theme, []);
    layer.update([player("a", 0), player("b", 300)], [], "b");
    expect(painted).toEqual(["#ffffff", theme.accent]);
    layer.update([player("a", 0), player("b", 300)], [], "a");  // autre choix : les deux étiquettes refaites
    expect(painted.slice(2).sort()).toEqual([theme.accent, "#ffffff"].sort());
    layer.update([player("a", 0), player("b", 300)], [], "a");
    expect(painted).toHaveLength(4);  // rien de changé : rien de refait
  });
});
