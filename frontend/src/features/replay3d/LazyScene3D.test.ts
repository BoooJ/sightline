// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Guard3d, LazyScene3D, LOAD_FAILED, loadScene3d, RUN_FAILED } from "./LazyScene3D";
import type { Scene3DProps } from "./Scene3D";

// vue 3D remplacée par un composant qui note chacun de ses rendus : instant, et « caché » si `active` est faux
const seen = vi.hoisted(() => [] as string[]);
vi.mock("./Scene3D", () => ({
  default: (p: { tick: number; active: boolean }) => { seen.push(`${p.tick}${p.active ? "" : " caché"}`); return null; },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => { act(() => roots.splice(0).forEach((r) => r.unmount())); vi.restoreAllMocks(); seen.length = 0; });
function render(el: ReactElement) {
  const div = document.createElement("div");
  const root = createRoot(div);
  roots.push(root);
  act(() => root.render(el));
  return Object.assign(div, { root });
}
// laisse passer un tour de la boucle d'évènements dans `act` (rien d'attendu : le module ne doit rien monter)
const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));
// module de la vue 3D (import dynamique) arrivé et rendu : attente bornée, dans `act`, jusqu'à ce que `check` passe
const until = (check: () => void, a: typeof act = act) =>
  vi.waitFor(async () => { await a(() => new Promise<void>((r) => setTimeout(r, 0))); check(); });
const scene = (tick: number, active: boolean) => createElement(LazyScene3D, { tick, active, onFail: () => {} } as unknown as Scene3DProps);

describe("vue 3D gardée quand le replay repasse en 2D", () => {
  it("module encore en chargement quand on repasse en 2D : pas de roue par-dessus le radar ; arrivé, il se monte caché", async () => {
    // modules neufs (React compris, pour un seul React) : le `lazy` de la vue 3D n'a encore rien chargé, quel que soit
    // l'ordre des tests de ce fichier
    vi.resetModules();
    const React = await import("react"), { createRoot: freshRoot } = await import("react-dom/client");
    const { LazyScene3D: Fresh } = await import("./LazyScene3D");
    const el = (active: boolean) => React.createElement(Fresh, { tick: 1, active, onFail: () => {} } as unknown as Scene3DProps);
    const div = document.createElement("div"), root = freshRoot(div);
    try {
      React.act(() => root.render(el(true)));
      expect(div.querySelector(".rp-loading .spinner")).not.toBeNull();
      React.act(() => root.render(el(false)));
      expect(div.querySelector(".rp-loading")).toBeNull();
      await until(() => expect(seen).toEqual(["1 caché"]), React.act);
    } finally {
      React.act(() => root.unmount());
    }
  });

  it("jamais affichée : rien de monté (ni three.js, ni carte), même en lecture", async () => {
    const div = render(scene(1, false));
    for (let t = 2; t <= 4; t++) act(() => div.root.render(scene(t, false)));
    await settle();
    expect(seen).toEqual([]);
    expect(div.innerHTML).toBe("");
  });

  it("cachée : plus rendue à chaque image de la lecture ; de nouveau affichée : rendue à l'instant courant", async () => {
    const div = render(scene(1, true));
    await until(() => expect(seen).toEqual(["1"]));
    act(() => div.root.render(scene(1, false)));  // passage en 2D : un rendu, pour se cacher
    expect(seen).toEqual(["1", "1 caché"]);
    for (let t = 2; t <= 30; t++) act(() => div.root.render(scene(t, false)));  // lecture en 2D
    expect(seen).toEqual(["1", "1 caché"]);
    act(() => div.root.render(scene(31, true)));  // retour en 3D
    expect(seen).toEqual(["1", "1 caché", "31"]);
  });
});

describe("chargement de la vue 3D", () => {
  it("module introuvable (onglet ouvert avant un redéploiement) : onFail, pas de page d'erreur", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const mod = await loadScene3d(() => Promise.reject(new TypeError("Failed to fetch dynamically imported module")));
    const onFail = vi.fn();
    const div = render(createElement(mod.default, { onFail } as unknown as Scene3DProps));
    expect(onFail).toHaveBeenCalledWith(LOAD_FAILED);
    expect(div.innerHTML).toBe("");
  });
  it("module chargé : rendu tel quel", async () => {
    const Ok = () => createElement("p", null, "3D");
    const mod = await loadScene3d(() => Promise.resolve({ default: Ok }));
    expect(mod.default).toBe(Ok);
  });
  it("erreur pendant l'affichage de la 3D : onFail et rien d'affiché, la page tient", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Boom = () => { throw new Error("contexte WebGL"); };
    const onFail = vi.fn();
    const div = render(createElement(Guard3d, { onFail, children: createElement(Boom) }));
    expect(onFail).toHaveBeenCalledWith(RUN_FAILED);
    expect(div.innerHTML).toBe("");
  });
});
