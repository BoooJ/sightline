import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { fetchMaps3d, find3d, freshUrl } from "./api";
import type { Map3d } from "./types";

const m = (map: string, variants: Map3d["variants"]): Map3d =>
  ({ map, build: "1", exported_at: "", checks: {}, world_to_model: [], variants });

afterEach(() => vi.unstubAllGlobals());

describe("cartes 3D", () => {
  it("module coupé (404) : aucune carte", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 404 }));
    expect(await fetchMaps3d()).toEqual([]);
  });
  it("une erreur serveur est remontée, en français (statusText est vide en HTTP/2)", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 500 }));
    await expect(fetchMaps3d()).rejects.toThrow("erreur 500");
  });
  it("le bouton 3D n'existe que pour une carte qui a au moins une variante", () => {
    const list = [m("de_nuke", { gray: { url: "/g", size: 1 } }), m("de_mirage", {})];
    expect(find3d(list, "de_nuke")?.map).toBe("de_nuke");
    expect(find3d(list, "de_mirage")).toBeNull();
    expect(find3d(list, "de_inferno")).toBeNull();
  });

  it("une carte qui n'a que sa collision (envoyée avant la carte) n'a pas de bouton 3D", () => {
    const list = [m("de_dust2", { collision: { url: "/c", size: 1 } }), m("de_nuke", { textured: { url: "/t", size: 1 }, collision: { url: "/c", size: 1 } })];
    expect(find3d(list, "de_dust2")).toBeNull();
    expect(find3d(list, "de_nuke")?.variants.collision?.url).toBe("/c");
  });
});

describe("carte ré-exportée (fichier en 404)", () => {
  const serve = (url: string) => vi.stubGlobal("fetch", async () =>
    new Response(JSON.stringify([m("de_nuke", { gray: { url, size: 1 } })]), { headers: { "content-type": "application/json" } }));
  it("la liste est relue et donne la nouvelle adresse du fichier", async () => {
    const qc = new QueryClient();
    serve("/api/maps3d/de_nuke/gray-aaa.glb");
    await qc.fetchQuery({ queryKey: ["maps3d"], queryFn: fetchMaps3d });
    serve("/api/maps3d/de_nuke/gray-bbb.glb");
    expect(await freshUrl(qc, "de_nuke", "gray", "/api/maps3d/de_nuke/gray-aaa.glb")).toBe("/api/maps3d/de_nuke/gray-bbb.glb");
    expect(qc.getQueryData<Map3d[]>(["maps3d"])?.[0].variants.gray?.url).toBe("/api/maps3d/de_nuke/gray-bbb.glb");
    qc.clear();
  });
  it("même adresse ou variante disparue : rien de neuf, l'échec est définitif", async () => {
    const qc = new QueryClient();
    serve("/api/maps3d/de_nuke/gray-aaa.glb");
    await qc.fetchQuery({ queryKey: ["maps3d"], queryFn: fetchMaps3d });
    expect(await freshUrl(qc, "de_nuke", "gray", "/api/maps3d/de_nuke/gray-aaa.glb")).toBeNull();
    expect(await freshUrl(qc, "de_nuke", "textured", "/api/maps3d/de_nuke/textured-aaa.glb")).toBeNull();
    qc.clear();
  });
});
