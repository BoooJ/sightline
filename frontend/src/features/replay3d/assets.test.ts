import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAssets3d, vmLoader } from "./assets";
import { type FakeCache, FakeCaches } from "./fakeCaches";
import { FILES3D_CACHE } from "./glbCache";
import { armsGlb } from "./testGlb";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("fichiers 3D de la vue du joueur", () => {
  it("module coupé (404) : aucun ; erreur serveur remontée en français ; liste servie telle quelle", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 404 }));
    expect(await fetchAssets3d()).toEqual({});
    vi.stubGlobal("fetch", async () => new Response("", { status: 500 }));
    await expect(fetchAssets3d()).rejects.toThrow("erreur 500");
    const vue = { build: "2000935", exported_at: "2026-10-30T10:00:00Z", files: { "bras-ct": { url: "/api/assets3d/vue/bras-ct-0123456789ab.glb", size: 3 } } };
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ vue }), { headers: { "content-type": "application/json" } }));
    expect(await fetchAssets3d()).toEqual({ vue });
  });
  it("session expirée (401) : l'écran de connexion est demandé une fois, et l'erreur remontée", async () => {
    const win = new EventTarget(), asked = vi.fn();  // environnement node : la fenêtre se réduit à ses événements
    win.addEventListener("auth-required", asked);
    vi.stubGlobal("window", win);
    vi.stubGlobal("fetch", async () => new Response("", { status: 401 }));
    await expect(fetchAssets3d()).rejects.toThrow("erreur 401");
    expect(asked).toHaveBeenCalledTimes(1);
    for (const status of [403, 404, 500]) {  // les autres réponses ne le demandent pas
      vi.stubGlobal("fetch", async () => new Response("", { status }));
      await fetchAssets3d().catch(() => {});
    }
    expect(asked).toHaveBeenCalledTimes(1);
  });
  it("chargeur : fichier de la liste lu avec ses clips ; nom absent : null, sans requête", async () => {
    const body = armsGlb(), seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { seen.push(url); return new Response(body); });
    const load = vmLoader({ "bras-ct": { url: "/api/assets3d/vue/bras-ct-0123456789ab.glb", size: body.length } });
    const f = await load("bras-ct", new AbortController().signal);
    expect(f?.scene.getObjectByName("wpn")).toBeTruthy();
    expect(f?.clips).toEqual([]);
    expect(await load("arme-awp", new AbortController().signal)).toBeNull();
    expect(seen).toEqual(["/api/assets3d/vue/bras-ct-0123456789ab.glb"]);
  });
  it("gardés dans le navigateur : à la visite suivante, lus sans requête ; nouvel export : ancienne version effacée", async () => {
    const caches = new FakeCaches(), body = armsGlb(), seen: string[] = [];
    vi.stubGlobal("caches", caches);
    vi.stubGlobal("fetch", async (url: string) => { seen.push(url); return new Response(body.slice()); });
    const files = (tag: string) => ({ "bras-ct": { url: `/api/assets3d/vue/bras-ct-${tag}.glb`, size: body.length } });
    const signal = new AbortController().signal;
    await vmLoader(files("0123456789ab"))("bras-ct", signal);
    const later = await vmLoader(files("0123456789ab"))("bras-ct", signal);  // autre page, même liste
    expect(later?.scene.getObjectByName("wpn")).toBeTruthy();
    expect(seen).toEqual(["/api/assets3d/vue/bras-ct-0123456789ab.glb"]);
    await vmLoader(files("ba9876543210"))("bras-ct", signal);
    expect(seen).toHaveLength(2);
    const kept = caches.stores.get(FILES3D_CACHE) as FakeCache;
    await vi.waitFor(() => expect(kept.paths()).toEqual(["/api/assets3d/vue/bras-ct-ba9876543210.glb"]));
  });
});
