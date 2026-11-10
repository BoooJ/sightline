// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Box3, Vector3 } from "three";
import type { PlayerState } from "../replay/engine/state";
import { POV_FOV, povPose, vfovFrom43 } from "./cameras";
import { CameraRig, PERSP_FOV, PERSP_NEAR, POV_NEAR } from "./rig";

// jsdom n'a pas PointerEvent : un MouseEvent du même nom porte les mêmes champs utiles (button, buttons)
const ptr = (type: string, button: number, buttons: number) => {
  const e = new MouseEvent(type, { bubbles: true, button, buttons });
  Object.defineProperty(e, "pointerId", { value: 1 });
  return e;
};
const key = (type: "keydown" | "keyup", code: string, repeat = false) =>
  new KeyboardEvent(type, { code, key: code.slice(3).toLowerCase(), repeat, bubbles: true, cancelable: true });

const cleanups: (() => void)[] = [];
const WINDOW = { w: window.innerWidth, h: window.innerHeight };  // taille de la fenêtre avant les tests
afterEach(() => {
  cleanups.splice(0).forEach((f) => f());
  win(WINDOW.w, WINDOW.h);
});

/** Fixe la taille de la fenêtre du navigateur (jsdom ne la fait pas varier) ; `resize` : l'événement du navigateur. */
function win(w: number, h: number, resize = false) {
  Object.assign(window, { innerWidth: w, innerHeight: h });
  if (resize) window.dispatchEvent(new Event("resize"));
}

/** Caméra libre sur un élément de la page ; `seen` : touches parvenues aux raccourcis du replay (écoute ordinaire). */
function setup() {
  const el = document.createElement("div");
  document.body.append(el);
  el.setPointerCapture = () => {};
  let redraws = 0;
  const rig = new CameraRig(el, () => { redraws++; });
  rig.setMode("free");
  const seen: string[] = [];
  const onKey = (e: KeyboardEvent) => { seen.push(e.code); };
  window.addEventListener("keydown", onKey);
  cleanups.push(() => { rig.dispose(); window.removeEventListener("keydown", onKey); el.remove(); });
  const press = (code: string, repeat = false) => { const e = key("keydown", code, repeat); document.body.dispatchEvent(e); return e; };
  const release = (code: string) => document.body.dispatchEvent(key("keyup", code));
  const moving = () => rig.update(0.016, [], null, null);
  return { el, rig, seen, press, release, moving, redraws: () => redraws };
}

describe("clavier de la caméra libre", () => {
  it("une touche enfoncée pendant le clic droit reste avalée jusqu'à son keyup, même clic relâché", () => {
    const { el, seen, press, release, moving } = setup();
    el.dispatchEvent(ptr("pointerdown", 2, 2));
    expect(press("KeyS").defaultPrevented).toBe(true);
    expect(moving()).toBe(true);
    window.dispatchEvent(ptr("pointerup", 2, 0));
    expect(moving()).toBe(false);
    // répétition de la touche encore tenue : ni signet, ni déplacement
    expect(press("KeyS", true).defaultPrevented).toBe(true);
    expect(moving()).toBe(false);
    expect(seen).toEqual([]);
    release("KeyS");
    press("KeyS");
    expect(seen).toEqual(["KeyS"]);
  });
  it("perte du focus de la fenêtre : plus de déplacement, touches rendues aux raccourcis", () => {
    const { el, seen, press, moving } = setup();
    el.dispatchEvent(ptr("pointerdown", 2, 2));
    press("KeyW");
    window.dispatchEvent(new Event("blur"));
    expect(moving()).toBe(false);
    press("KeyW");
    expect(seen).toEqual(["KeyW"]);
  });
  it("capture du pointeur perdue : clic droit considéré comme relâché", () => {
    const { el, seen, press, moving } = setup();
    el.dispatchEvent(ptr("pointerdown", 2, 2));
    press("KeyW");
    el.dispatchEvent(new Event("lostpointercapture"));
    expect(moving()).toBe(false);
    press("KeyD");
    expect(seen).toEqual(["KeyD"]);
  });
  it("droit relâché pendant que le gauche reste enfoncé : on se fie à e.buttons", () => {
    const { el, seen, press, moving } = setup();
    el.dispatchEvent(ptr("pointerdown", 2, 2));
    el.dispatchEvent(ptr("pointermove", -1, 3));  // gauche ajouté
    el.dispatchEvent(ptr("pointermove", 2, 1));   // droit relâché : pas de pointerup
    // avant tout pointerup (qui relâche de toute façon) : seul e.buttons dit que le droit n'est plus enfoncé
    press("KeyW");
    expect(moving()).toBe(false);
    expect(seen).toEqual(["KeyW"]);
  });
  it("droit ajouté pendant que le gauche est enfoncé : le clavier déplace la caméra", () => {
    const { el, seen, press, moving } = setup();
    el.dispatchEvent(ptr("pointerdown", 0, 1));
    el.dispatchEvent(ptr("pointermove", 2, 3));
    press("KeyW");
    expect(moving()).toBe(true);
    expect(seen).toEqual([]);
  });
});

describe("recentrer", () => {
  it("remet le cadrage de la carte après un zoom de la vue de dessus", () => {
    const { el, rig } = setup();
    rig.setMode("top");
    rig.setBounds(new Box3(new Vector3(0, 0, 0), new Vector3(1000, 1000, 100)));
    rig.update(0.016, [], null, null);
    expect(rig.ortho.top).toBeCloseTo(525, 6);
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: 500, cancelable: true }));
    rig.update(0.016, [], null, null);
    expect(rig.ortho.top).not.toBeCloseTo(525, 6);
    rig.recenter();
    rig.update(0.016, [], null, null);
    expect(rig.ortho.top).toBeCloseTo(525, 6);
  });
  it("ramène la caméra libre à son point de départ", () => {
    const { el, rig, press, release } = setup();
    rig.setBounds(new Box3(new Vector3(0, 0, 0), new Vector3(1000, 1000, 100)));
    rig.update(0.016, [], null, null);
    const start = rig.persp.position.clone();
    el.dispatchEvent(ptr("pointerdown", 2, 2));
    press("KeyW");
    rig.update(0.1, [], null, null);
    release("KeyW");
    expect(rig.persp.position.distanceTo(start)).toBeGreaterThan(10);
    rig.recenter();
    rig.update(0.016, [], null, null);
    expect(rig.persp.position.distanceTo(start)).toBeCloseTo(0, 6);
  });
});

const player = (steamid: string, over: Partial<PlayerState> = {}): PlayerState => ({
  steamid, name: steamid, side: "CT", slot: 1, x: 0, y: 0, z: 0, yaw: 0, hp: 100, armor: 100, alive: true, helmet: false,
  defuser: false, hasBomb: false, defusing: false, scoped: false, flash: 0, money: 0, weapon: "AK-47", inventory: [], equip: 0,
  pitch: 0, duck: 0, airborne: false, clip: null, reserve: null, zoom: 0, keys: 0, crosshair: null,
  fov: 0, viewmodel: null, ...over });

describe("vue du joueur", () => {
  it("à hauteur d'yeux, regard exact, FOV de CS2, plan proche à 4 ; 70° et 4 dans les autres caméras", () => {
    const { rig } = setup();
    win(1024, 768);
    rig.resize(1024, 768);  // vue 3D = fenêtre : le FOV de CS2 sans correction
    rig.setMode("pov");
    rig.update(0.016, [player("a", { x: 100, z: 10, yaw: 90, pitch: 30, duck: 1 })], "a", null);
    expect(rig.persp.position.toArray()).toEqual([100, 0, 56]);
    const d = rig.persp.getWorldDirection(new Vector3());
    expect(d.x).toBeCloseTo(0, 6);
    expect(d.y).toBeCloseTo(Math.cos(Math.PI / 6), 6);
    expect(d.z).toBeCloseTo(-0.5, 6);
    expect(rig.persp.fov).toBeCloseTo(POV_FOV, 9);
    expect(rig.persp.fov).toBeCloseTo(73.74, 2);
    expect(rig.persp.near).toBe(4);
    expect(POV_NEAR).toBe(4);
    rig.setMode("follow");
    rig.update(0.016, [player("a")], "a", null);
    expect([rig.persp.fov, rig.persp.near]).toEqual([PERSP_FOV, PERSP_NEAR]);
  });
  it("lunette (replay sans FOV) : FOV du niveau de zoom, projection recalculée", () => {
    const { rig } = setup();
    win(1024, 768);
    rig.resize(1024, 768);
    rig.setMode("pov");
    rig.update(0.016, [player("a")], null, null);
    const before = rig.persp.projectionMatrix.clone();
    rig.update(0.016, [player("a", { weapon: "AWP", scoped: true, zoom: 2 })], null, null);
    expect(rig.persp.fov).toBeCloseTo(vfovFrom43(10), 9);
    expect(rig.persp.projectionMatrix.equals(before)).toBe(false);
    rig.update(0.016, [player("a", { weapon: "AWP", scoped: false, zoom: 0 })], null, null);
    expect(rig.persp.fov).toBeCloseTo(POV_FOV, 9);
  });
  it("joueur suivi : le choisi s'il vit, sinon le premier vivant ; la cible TV ; personne en libre et de dessus", () => {
    const { rig } = setup();
    rig.setMode("pov");
    rig.update(0.016, [player("a"), player("b")], "b", null);
    expect(rig.target).toBe("b");
    rig.update(0.016, [player("a"), player("b", { alive: false })], "b", null);
    expect(rig.target).toBe("a");
    rig.update(0.016, [player("a", { alive: false })], "a", null);
    expect(rig.target).toBeNull();
    rig.setMode("tv");
    rig.update(0.016, [player("a"), player("b")], "a", "b");
    expect(rig.target).toBe("b");
    rig.setMode("top");
    rig.update(0.016, [player("a"), player("b")], "a", "b");
    expect(rig.target).toBeNull();
    rig.setMode("free");
    rig.update(0.016, [player("a")], "a", null);
    expect(rig.target).toBeNull();
  });
  it("le joueur suivi meurt : un coéquipier vivant plutôt qu'un adversaire, sinon le premier vivant", () => {
    const { rig } = setup();
    for (const mode of ["pov", "follow", "tv"] as const) {
      rig.setMode(mode);
      const sel = mode === "tv" ? null : "t1", tv = mode === "tv" ? "t1" : null;
      // l'adversaire vivant vient en premier dans la liste : il ne doit pas être pris
      const ps = [player("ct1"), player("t1", { side: "T", alive: false }), player("ct2"), player("t2", { side: "T" })];
      rig.update(0.016, ps, sel, tv);
      expect(rig.target).toBe("t2");
      // plus aucun coéquipier vivant : le premier vivant, comme avant
      rig.update(0.016, [player("ct1"), player("t1", { side: "T", alive: false }), player("t2", { side: "T", alive: false })], sel, tv);
      expect(rig.target).toBe("ct1");
      // personne de choisi : le premier vivant
      rig.update(0.016, [player("t2", { side: "T", alive: false }), player("ct2")], null, null);
      expect(rig.target).toBe("ct2");
    }
  });
});

describe("vue du joueur : recul de la caméra au tir", () => {
  const dir = (rig: CameraRig) => rig.persp.getWorldDirection(new Vector3());
  const ps = [player("a", { yaw: 0, pitch: 0 }), player("b", { x: 500, yaw: 0, pitch: 0 })];
  it("en vue du joueur : le regard du joueur suivi + son recul ; l'AK fait monter la vue, retour au regard du joueur sans recul", () => {
    const { rig } = setup();
    rig.setMode("pov");
    const punchOf = vi.fn((sid: string): [number, number] => (sid === "a" ? [-1.099, -0.568] : [-9, 9]));
    rig.update(0.016, ps, "a", null, ps, punchOf);
    const up = dir(rig);
    expect(punchOf).toHaveBeenCalledWith("a");
    expect(punchOf).not.toHaveBeenCalledWith("b");  // seul le joueur suivi est interrogé
    expect(up.z).toBeGreaterThan(0.0191);  // sin(1,099°) : au-dessus de l'horizontale
    expect(up.y).toBeLessThan(0);          // lacet négatif : vers la droite
    // 2 s plus tard : Replay.punchAt renvoie [0, 0], on revient au regard du joueur (plat, vers +X)
    rig.update(0.016, ps, "a", null, ps, () => [0, 0]);
    expect(dir(rig).angleTo(new Vector3(1, 0, 0))).toBeCloseTo(0, 6);
    rig.update(0.016, ps, "a", null, ps);  // sans fonction de recul : pareil
    expect(dir(rig).angleTo(new Vector3(1, 0, 0))).toBeCloseTo(0, 6);
  });
  it("le recul se compose avec le regard du joueur (vers le bas et vers la gauche)", () => {
    const { rig } = setup();
    rig.setMode("pov");
    const p = [player("a", { yaw: 90, pitch: 10 })];
    rig.update(0.016, p, "a", null, p, () => [-4, 2]);
    const want = new Vector3(...povPose(player("a", { yaw: 92, pitch: 6 })).dir);
    expect(dir(rig).angleTo(want)).toBeCloseTo(0, 6);
  });
  it("hors vue du joueur : aucun recul (suivi, TV, libre, dessus), la fonction n'est même pas appelée", () => {
    const { rig } = setup();
    const punchOf = vi.fn((): [number, number] => [-3, 3]);
    for (const mode of ["follow", "tv", "free", "top"] as const) {
      rig.setMode(mode);
      rig.update(0.016, ps, "a", "a", ps, punchOf);
    }
    expect(punchOf).not.toHaveBeenCalled();
    // le suivi regarde le buste du joueur : sa visée n'y entre pas, le recul non plus
    rig.setMode("follow");
    rig.update(0.016, ps, "a", null, ps, () => [-3, 3]);
    const withPunch = rig.persp.position.toArray();
    rig.update(0.016, ps, "a", null, ps);
    expect(rig.persp.position.toArray()).toEqual(withPunch);
  });
});

/** Vue du joueur d'un joueur au FOV donné (`player` du fichier), fenêtre et vue 3D aux tailles données. */
function povRig(fenetre: [number, number], view: [number, number]) {
  const t = setup();
  win(...fenetre);
  t.rig.resize(...view);
  t.rig.setMode("pov");
  return { ...t, look: (over: Partial<PlayerState>) => { t.rig.update(0.016, [player("a", over)], "a", null); return t.rig.persp.fov; } };
}

describe("vue du joueur : cadrage et FOV sur la fenêtre", () => {
  it("vue plus petite que la fenêtre : le FOV horizontal reste celui de CS2 plein écran (fenêtre 1024 × 768)", () => {
    expect(povRig([1024, 768], [1024, 768]).look({ fov: 90 })).toBeCloseTo(73.74, 2);
    expect(povRig([1024, 768], [948, 627]).look({ fov: 90 })).toBeCloseTo(66.96, 2);
    expect(povRig([1024, 768], [588, 535]).look({ fov: 90 })).toBeCloseTo(84.6, 2);
  });
  it("lunette : le FOV de la démo (40 puis 10) avec la même correction", () => {
    const { look } = povRig([1024, 768], [948, 627]);
    expect(look({ weapon: "AWP", scoped: true, zoom: 1, fov: 40 })).toBeCloseTo(27.07, 2);
    expect(look({ weapon: "AWP", scoped: true, zoom: 2, fov: 10 })).toBeCloseTo(6.62, 2);
  });
  it("le FOV de la démo passe avant la table de l'arme ; sans lui (0), la table, puis 90", () => {
    const { look } = povRig([1024, 768], [948, 627]);
    // AWP au zoom 2 vaudrait 10 dans la table : la démo dit 40
    expect(look({ weapon: "AWP", scoped: true, zoom: 2, fov: 40 })).toBeCloseTo(27.07, 2);
    expect(look({ weapon: "AWP", scoped: true, zoom: 2, fov: 0 })).toBeCloseTo(6.62, 2);
    expect(look({ weapon: "AWP", scoped: false, zoom: 0, fov: 0 })).toBeCloseTo(66.96, 2);
    // FOV interpolé entre deux échantillons (90 → 40) : suivi tel quel
    expect(look({ weapon: "AWP", scoped: false, fov: 65 })).toBeCloseTo(2 * Math.atan(Math.tan((65 * Math.PI) / 360) * 0.75
      * (1024 / 768) / (948 / 627)) * (180 / Math.PI), 9);
  });
  it("FOV de la démo illisible (255) : la table, pas une caméra retournée", () => {
    const { look } = povRig([1024, 768], [948, 627]);
    expect(look({ weapon: "AWP", scoped: true, zoom: 1, fov: 255 })).toBeCloseTo(27.07, 2);
  });
  it("plan proche à 4 en vue du joueur, lunette comprise ; 70° et 4 dans les autres caméras, quelle que soit la fenêtre", () => {
    const { rig, look } = povRig([1280, 720], [948, 627]);
    look({ fov: 90 });
    expect(rig.persp.near).toBe(4);
    look({ weapon: "AWP", scoped: true, zoom: 1, fov: 40 });
    expect(rig.persp.near).toBe(4);
    for (const mode of ["follow", "tv", "free"] as const) {
      rig.setMode(mode);
      rig.update(0.016, [player("a")], "a", "a");
      expect([rig.persp.fov, rig.persp.near]).toEqual([PERSP_FOV, PERSP_NEAR]);
    }
  });
  it("la fenêtre seule change (la vue 3D garde sa taille) : l'événement resize refait le cadrage et redessine", () => {
    const { rig, look, redraws } = povRig([1024, 768], [948, 627]);
    expect(look({ fov: 90 })).toBeCloseTo(66.96, 2);
    const n = redraws();
    win(1280, 720, true);
    expect(redraws()).toBe(n + 1);
    expect(look({ fov: 90 })).toBeCloseTo(82.82, 2);  // 2·atan(0,75 · (1280/720) / (948/627))
    expect(rig.persp.aspect).toBeCloseTo(948 / 627, 9);  // l'image, elle, garde la forme de la vue
    // même forme de fenêtre (autre taille) : rien à refaire
    win(2560, 1440, true);
    expect(redraws()).toBe(n + 1);
    expect(look({ fov: 90 })).toBeCloseTo(82.82, 2);
  });
  it("redimensionnement de la vue : la forme de la fenêtre est relue en même temps", () => {
    const { rig, look } = povRig([1024, 768], [948, 627]);
    expect(look({ fov: 90 })).toBeCloseTo(66.96, 2);
    win(1280, 720);  // sans événement resize (observateur de taille passé en premier)
    rig.resize(588, 535);
    expect(look({ fov: 90 })).toBeCloseTo(2 * Math.atan(0.75 * (1280 / 720) / (588 / 535)) * (180 / Math.PI), 9);
  });
  it("projection recalculée seulement quand le FOV ou le plan proche change", () => {
    const { rig, look } = povRig([1024, 768], [948, 627]);
    look({ fov: 90 });
    const spy = vi.spyOn(rig.persp, "updateProjectionMatrix");
    look({ fov: 90 });
    look({ fov: 90, x: 500 });  // le joueur bouge, pas le FOV
    expect(spy).not.toHaveBeenCalled();
    look({ fov: 89 });
    expect(spy).toHaveBeenCalledTimes(1);
    look({ fov: 89 });
    expect(spy).toHaveBeenCalledTimes(1);
    win(1280, 720, true);
    look({ fov: 89 });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
