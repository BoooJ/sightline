import { afterEach, describe, expect, it, vi } from "vitest";
import { type FakeCache, FakeCaches } from "./fakeCaches";
import { FILES3D_CACHE, forgetFiles3d, isGlb, keepFile3d, openFiles3d } from "./glbCache";
import { armsGlb } from "./testGlb";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const glb = armsGlb();
const L = glb.length;
async function stub() {
  const caches = new FakeCaches();
  vi.stubGlobal("caches", caches);
  const c = await openFiles3d();
  return { caches, c: c as unknown as FakeCache, keep: (url: string, budget?: number) => keepFile3d(c!, url, glb, budget) };
}
const map = (m: string, v: string, sha = "aaaaaaaaaaaa") => `/api/maps3d/${m}/${v}-${sha}.glb`;
const vue = (n: string, sha = "aaaaaaaaaaaa") => `/api/assets3d/vue/${n}-${sha}.glb`;

describe("fichiers 3D gardés dans le navigateur (Cache Storage)", () => {
  it("copie gardée seulement si entière : taille du manifeste, en-tête glTF 2 et longueur annoncée par l'en-tête", () => {
    expect(isGlb(glb, L)).toBe(true);
    expect(isGlb(glb, L + 1)).toBe(false);  // autre taille que celle du manifeste
    expect(isGlb(glb.slice(0, -4), L - 4)).toBe(false);  // tronquée : l'en-tête annonce plus
    const page = new TextEncoder().encode("<html>Connexion</html>");
    expect(isGlb(page, page.length)).toBe(false);  // page servie en 200 à la place du fichier
    const v1 = glb.slice();
    v1[4] = 1;
    expect(isGlb(v1, L)).toBe(false);  // glTF 1
    expect(isGlb(new Uint8Array(0), 0)).toBe(false);
  });

  it("nouvelle version d'un fichier (autre somme) : l'ancienne effacée ; les autres variantes, cartes et fichiers « vue » gardés", async () => {
    const { c, keep } = await stub();
    for (const u of [map("de_dust2", "gray"), map("de_dust2", "textured"), map("de_nuke", "gray"), vue("bras-ct"), vue("bras-t")]) await keep(u);
    await keep(map("de_dust2", "gray", "bbbbbbbbbbbb"));
    await keep(vue("bras-ct", "bbbbbbbbbbbb"));
    await vi.waitFor(() => expect(c.paths().sort()).toEqual([map("de_dust2", "gray", "bbbbbbbbbbbb"), map("de_dust2", "textured"),
      map("de_nuke", "gray"), vue("bras-ct", "bbbbbbbbbbbb"), vue("bras-t")].sort()));
    // « bras-t » n'est pas une version de « bras-ct » (nom entier comparé), ni « arme-m4a1-silencer » de « arme-m4a1 »
    await keep(vue("arme-m4a1"));
    await keep(vue("arme-m4a1-silencer", "cccccccccccc"));
    await vi.waitFor(() => expect(c.paths()).toContain(vue("arme-m4a1")));
    expect(c.paths()).toContain(vue("arme-m4a1-silencer", "cccccccccccc"));
  });

  it("cartes au-delà du budget : les moins récemment téléchargées effacées (grise et texturée ensemble), la dernière toujours gardée ; fichiers « vue » à part", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { c, keep } = await stub();
    const at = async (t: number, url: string) => { vi.setSystemTime(t); await keep(url, 3 * L); };
    await at(1000, map("de_dust2", "gray"));
    await at(2000, map("de_dust2", "textured"));
    await at(3000, vue("bras-ct"));
    await at(4000, map("de_nuke", "gray"));  // 3 cartes × L : dans le budget
    expect(c.paths()).toHaveLength(4);
    await at(5000, map("de_mirage", "gray"));  // 4 L : Dust2 (la plus ancienne) part, ses deux variantes
    await vi.waitFor(() => expect(c.paths().sort()).toEqual([map("de_mirage", "gray"), map("de_nuke", "gray"), vue("bras-ct")].sort()));
    await at(6000, map("de_dust2", "gray"));  // revenue : la plus récente ; 3 L, tout tient
    await vi.waitFor(() => expect(c.paths()).toHaveLength(4));
    await at(7000, map("de_ancient", "textured"));  // 4 L : Nuke, la plus ancienne, part
    await vi.waitFor(() => expect(c.paths().sort()).toEqual([map("de_ancient", "textured"), map("de_dust2", "gray"),
      map("de_mirage", "gray"), vue("bras-ct")].sort()));
    await keep(map("de_train", "textured"), L / 2);  // plus gros que le budget à elle seule : gardée quand même, seule
    await vi.waitFor(() => expect(c.paths().sort()).toEqual([map("de_train", "textured"), vue("bras-ct")].sort()));
  });

  it("quota plein : rien de gardé, aucune erreur ; Cache Storage absent (http hors localhost) ou refusé (navigation privée) : pas de cache", async () => {
    const { c, keep } = await stub();
    c.failPut = new DOMException("plein", "QuotaExceededError");
    await expect(keep(map("de_dust2", "textured"))).resolves.toBeUndefined();
    expect(c.paths()).toEqual([]);
    vi.stubGlobal("caches", undefined);
    expect(await openFiles3d()).toBeNull();
    const refused = new FakeCaches();
    refused.failOpen = new DOMException("refusé", "SecurityError");
    vi.stubGlobal("caches", refused);
    expect(await openFiles3d()).toBeNull();
  });

  it("déconnexion : tout est effacé ; sans Cache Storage, sur un échec ou un effacement qui traîne : rien ne bloque", async () => {
    const { caches, keep } = await stub();
    await keep(map("de_dust2", "gray"));
    expect(await caches.keys()).toEqual([FILES3D_CACHE]);
    await forgetFiles3d();
    expect(await caches.keys()).toEqual([]);
    vi.stubGlobal("caches", undefined);
    await expect(forgetFiles3d()).resolves.toBeUndefined();
    vi.stubGlobal("caches", { delete: async () => { throw new DOMException("refusé", "SecurityError"); } });
    await expect(forgetFiles3d()).resolves.toBeUndefined();
    vi.useFakeTimers();
    vi.stubGlobal("caches", { delete: () => new Promise(() => {}) });
    const done = vi.fn();
    void forgetFiles3d().then(done);
    await vi.advanceTimersByTimeAsync(1999);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalled();  // la page de connexion s'ouvre quand même
  });
});
