// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { use3dView, type View3d } from "./Toggle3d";
import type { Map3d } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Root[] = [];
afterEach(() => { act(() => roots.splice(0).forEach((r) => r.unmount())); localStorage.clear(); });

/** use3dView sur Nuke (grise et texturée) ; `views` : ce que le crochet a rendu, du premier au dernier rendu. */
function mount() {
  const qc = new QueryClient();
  qc.setQueryData<Map3d[]>(["maps3d"], [{ map: "de_nuke", build: "1", exported_at: "", checks: {}, world_to_model: [],
    variants: { gray: { url: "/g.glb", size: 1 }, textured: { url: "/t.glb", size: 1 } } }]);
  const views: View3d[] = [];
  const Probe = () => { views.push(use3dView("de_nuke")); return null; };
  const root = createRoot(document.createElement("div"));
  roots.push(root);
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(Probe))));
  return { views, last: () => views.at(-1)! };
}
const stored = () => JSON.parse(localStorage.getItem("sightline.replay3d") ?? "null");

describe("choix 2D / 3D et variante", () => {
  it("variante changée par une fonction d'un rendu où la 3D était affichée, après le retour en 2D : la page reste en 2D", () => {
    // la vue 3D cachée continue de charger en 2D ; si la texturée échoue, elle se rabat sur la grise avec la fonction
    // qu'elle tenait au début du chargement (3D affichée)
    const { last } = mount();
    act(() => last().setVariant("textured"));
    act(() => last().setOn(true));
    const whileShown = last().setVariant;
    act(() => last().setOn(false));
    act(() => whileShown("gray"));
    expect(last().on).toBe(false);
    expect(last().variant).toBe("gray");
    expect(stored()).toEqual({ on: false, variant: "gray" });
  });

  it("2D / 3D par une fonction d'un rendu antérieur : la variante choisie depuis est gardée", () => {
    const { last } = mount();
    const before = last().setOn;
    act(() => last().setVariant("textured"));
    act(() => before(true));
    expect(last().on).toBe(true);
    expect(last().variant).toBe("textured");
    expect(stored()).toEqual({ on: true, variant: "textured" });
  });
});
