import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeCache, FakeCaches } from "./fakeCaches";
import { FILES3D_CACHE } from "./glbCache";
import { fetchGlb, LoadError, parseGlb, parseGlbAnimated } from "./loader";
import { armsGlb, weaponGlb } from "./testGlb";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const get = () => fetchGlb("/api/maps3d/de_nuke/gray-1.glb", 8, () => {}, new AbortController().signal);

describe("téléchargement d'une carte 3D", () => {
  it("contenu complet et progression", async () => {
    vi.stubGlobal("fetch", async () => new Response(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])));
    const seen: number[] = [];
    const buf = await fetchGlb("/x.glb", 8, (got) => seen.push(got), new AbortController().signal);
    expect([...new Uint8Array(buf)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(seen[seen.length - 1]).toBe(8);
  });
  it("fichier absent : « erreur 404 », code gardé pour relire la liste des cartes", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 404 }));
    const e = await get().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(LoadError);
    expect((e as LoadError).message).toBe("erreur 404");
    expect((e as LoadError).status).toBe(404);
  });
  it("réseau coupé : « connexion interrompue », pas le message anglais du navigateur", async () => {
    vi.stubGlobal("fetch", async () => { throw new TypeError("Failed to fetch"); });
    await expect(get()).rejects.toThrow("connexion interrompue");
  });
  it("coupure pendant le téléchargement : « connexion interrompue »", async () => {
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(4)); c.error(new TypeError("network error")); } });
    vi.stubGlobal("fetch", async () => new Response(body));
    await expect(get()).rejects.toThrow("connexion interrompue");
  });
  it("annulation (passage en 2D, autre version) : l'AbortError passe telle quelle", async () => {
    vi.stubGlobal("fetch", async () => { throw new DOMException("annulé", "AbortError"); });
    await expect(get()).rejects.toMatchObject({ name: "AbortError" });
  });
  it("fichier illisible : message en français", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(parseGlb(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer)).rejects.toThrow("fichier de carte illisible");
  });
  it("fichier animé (bras, arme) : scène et clips, que la lecture d'une carte laisse de côté", async () => {
    const buf = weaponGlb().buffer as ArrayBuffer;
    const { scene, clips } = await parseGlbAnimated(buf);
    expect(clips.map((c) => c.name)).toEqual(["idle", "draw", "shoot"]);
    expect(clips[2].duration).toBe(0.5);
    expect(scene.getObjectByName("sl_arme")).toBeTruthy();
    expect((await parseGlb(buf)).getObjectByName("sl_clips")).toBeTruthy();  // la carte : scène seule, inchangée
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(parseGlbAnimated(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer)).rejects.toThrow("fichier 3D illisible");
  });
});

describe("carte ou fichier « vue » gardé dans le navigateur d'une visite à l'autre (Cache Storage)", () => {
  const URL1 = "/api/maps3d/de_dust2/textured-aaaaaaaaaaaa.glb";
  const glb = weaponGlb(), N = glb.length;
  // en-tête et taille justes, contenu abîmé : JSON illisible
  const corrupt = () => { const b = glb.slice(); b.fill(0x78, 20, 40); return b; };
  let caches: FakeCaches, asked: string[];
  const kept = () => caches.stores.get(FILES3D_CACHE) as FakeCache;
  /** Serveur : `answer` (octets servis en 200, ou réponse) à chaque requête, notée. */
  const serve = (answer: Uint8Array | (() => Response)) => vi.stubGlobal("fetch", async (url: string) => {
    asked.push(url);
    return typeof answer === "function" ? answer() : new Response(answer.slice());
  });
  const load = (onProgress: (got: number, total: number) => void = () => {}, signal = new AbortController().signal, total = N) =>
    fetchGlb(URL1, total, onProgress, signal);
  beforeEach(() => { caches = new FakeCaches(); vi.stubGlobal("caches", caches); asked = []; });

  it("1re visite : téléchargé puis gardé ; visite suivante : lu dans le navigateur, sans requête, progression complète", async () => {
    serve(glb);
    expect([...new Uint8Array(await load())]).toEqual([...glb]);
    expect(kept().paths()).toEqual([URL1]);
    const seen: number[] = [];
    const again = await load((got, total) => seen.push(got / total));
    expect(asked).toEqual([URL1]);
    expect([...new Uint8Array(again)]).toEqual([...glb]);
    expect(seen.at(-1)).toBe(1);
    expect((await parseGlbAnimated(again)).clips.map((c) => c.name)).toEqual(["idle", "draw", "shoot"]);
  });

  it("autre taille que celle du manifeste, ou pas un .glb (page servie en 200) : rendu comme avant, jamais gardé", async () => {
    serve(glb);
    await load(undefined, undefined, N + 8);
    const page = new TextEncoder().encode("<html>Connexion</html>");
    serve(page);
    await load(undefined, undefined, page.length);
    serve(glb.slice(0, -4));  // réponse plus courte que l'en-tête ne l'annonce
    await load(undefined, undefined, N - 4);
    expect(kept().puts).toEqual([]);
  });

  it("refus (401, 403) ou fichier absent (404) : erreur avec son code, rien de gardé", async () => {
    for (const status of [401, 403, 404]) {
      serve(() => new Response(glb.slice(), { status }));
      const e = await load().catch((x: unknown) => x);
      expect(e).toBeInstanceOf(LoadError);
      expect((e as LoadError).status).toBe(status);
    }
    expect(kept()?.puts ?? []).toEqual([]);
  });

  it("réponse redirigée (servie par une autre adresse que celle demandée) : rendue comme avant, jamais gardée", async () => {
    serve(() => Object.defineProperty(new Response(glb.slice()), "redirected", { value: true }));
    expect([...new Uint8Array(await load())]).toEqual([...glb]);
    expect(kept().puts).toEqual([]);
  });

  it("copie gardée tronquée ou d'une autre taille : effacée, fichier retéléchargé et gardé de nouveau", async () => {
    serve(glb);
    for (const bad of [glb.slice(0, -4), new Uint8Array([...glb, 0, 0, 0, 0])]) {
      (await caches.open(FILES3D_CACHE)).seed(URL1, bad);
      asked = [];
      expect([...new Uint8Array(await load())]).toEqual([...glb]);
      expect(asked).toEqual([URL1]);
      expect(await kept().bytes(URL1)).toEqual([...glb]);
    }
  });

  it("copie gardée illisible à la lecture : effacée, fichier retéléchargé une fois, lu et gardé", async () => {
    (await caches.open(FILES3D_CACHE)).seed(URL1, corrupt());
    vi.spyOn(console, "warn").mockImplementation(() => {});
    serve(glb);
    const buf = await load();
    expect(asked).toEqual([]);  // l'en-tête ne disait rien : lue telle quelle
    const { clips } = await parseGlbAnimated(buf);
    expect(clips.map((c) => c.name)).toEqual(["idle", "draw", "shoot"]);
    expect(asked).toEqual([URL1]);
    expect(await kept().bytes(URL1)).toEqual([...glb]);
  });

  it("illisible aussi depuis le serveur : une seule requête de plus, erreur en français, rien de gardé", async () => {
    (await caches.open(FILES3D_CACHE)).seed(URL1, corrupt());
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    serve(corrupt());
    await expect(load().then(parseGlb)).rejects.toThrow("fichier de carte illisible");
    expect(asked).toEqual([URL1]);
    await vi.waitFor(() => expect(kept().paths()).toEqual([]));
    // téléchargé illisible (pas de copie gardée) : pas redemandé, et la copie écrite entre-temps effacée
    asked = [];
    await expect(load().then(parseGlb)).rejects.toThrow("fichier de carte illisible");
    expect(asked).toEqual([URL1]);
    await vi.waitFor(() => expect(kept().paths()).toEqual([]));
  });

  it("quota plein : la carte se charge, rien n'est gardé, aucune erreur", async () => {
    (await caches.open(FILES3D_CACHE)).failPut = new DOMException("plein", "QuotaExceededError");
    serve(glb);
    expect([...new Uint8Array(await load())]).toEqual([...glb]);
    expect([...new Uint8Array(await load())]).toEqual([...glb]);
    expect(asked).toEqual([URL1, URL1]);
    expect(kept().paths()).toEqual([]);
  });

  it("sans Cache Storage (http hors localhost) ou stockage refusé (navigation privée) : téléchargé à chaque fois, comme avant", async () => {
    serve(glb);
    vi.stubGlobal("caches", undefined);
    await load();
    await load();
    const refused = new FakeCaches();
    refused.failOpen = new DOMException("refusé", "SecurityError");
    vi.stubGlobal("caches", refused);
    expect([...new Uint8Array(await load())]).toEqual([...glb]);
    expect(asked).toEqual([URL1, URL1, URL1]);
  });

  it("annulation (passage en 2D, autre version) pendant la lecture de la copie gardée : AbortError, aucune requête", async () => {
    (await caches.open(FILES3D_CACHE)).seed(URL1, glb);
    serve(glb);
    const ctl = new AbortController();
    ctl.abort();
    await expect(load(undefined, ctl.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(asked).toEqual([]);
    expect(kept().paths()).toEqual([URL1]);  // copie bonne : gardée
  });

  it("fichiers « vue » : même chemin (bras, arme)", async () => {
    const arms = armsGlb(), url = "/api/assets3d/vue/bras-ct-0123456789ab.glb";
    serve(arms);
    await fetchGlb(url, arms.length, () => {}, new AbortController().signal);
    await fetchGlb(url, arms.length, () => {}, new AbortController().signal);
    expect(asked).toEqual([url]);
  });
});
