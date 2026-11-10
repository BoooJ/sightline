import { describe, expect, it } from "vitest";

import { loadFontFaces, type FontEnv } from "./fontFaces";

interface Fake { family: string; url: string; settle(ok: boolean): void; load(): Promise<unknown> }

/** Environnement factice : chaque police reste en attente jusqu'à ce que le test la règle. */
function fakeEnv() {
  const faces: Fake[] = [];
  const added: Fake[] = [];
  let tick = () => {};
  const env: FontEnv<Fake> = {
    create(family, url) {
      let settle = (_ok: boolean) => {};
      const loading = new Promise((res, rej) => { settle = (ok) => (ok ? res(null) : rej(new Error(family))); });
      const face = { family, url, settle: (ok: boolean) => settle(ok), load: () => loading };
      faces.push(face);
      return face;
    },
    add: (f) => added.push(f),
    wait: () => new Promise<void>((res) => { tick = res; }),
  };
  return { env, faces, added, timeout: () => tick() };
}

const URLS = { Saira_700Bold: "/app/a.ttf", JetBrainsMono_500Medium: "/app/b.ttf" };
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("loadFontFaces", () => {
  it("déclare toutes les polices d'un coup, sans attendre la précédente", () => {
    const { env, faces, added } = fakeEnv();
    void loadFontFaces(URLS, env, 4000);
    expect(faces.map((f) => [f.family, f.url])).toEqual([["Saira_700Bold", "/app/a.ttf"], ["JetBrainsMono_500Medium", "/app/b.ttf"]]);
    expect(added).toEqual(faces);
  });

  it("se termine quand toutes sont chargées", async () => {
    const { env, faces } = fakeEnv();
    let done = false;
    void loadFontFaces(URLS, env, 4000).then(() => { done = true; });
    faces[0].settle(true);
    await flush();
    expect(done).toBe(false);
    faces[1].settle(true);
    await flush();
    expect(done).toBe(true);
  });

  it("une police en échec ne bloque pas l'app (police de secours)", async () => {
    const { env, faces } = fakeEnv();
    const p = loadFontFaces(URLS, env, 4000);
    faces[0].settle(false);
    faces[1].settle(true);
    await expect(p).resolves.toBeUndefined();
  });

  it("une police qui ne répond jamais n'empêche pas l'app de s'afficher après le délai", async () => {
    const { env, faces, timeout } = fakeEnv();
    let done = false;
    void loadFontFaces(URLS, env, 4000).then(() => { done = true; });
    faces[0].settle(true);
    await flush();
    expect(done).toBe(false);
    timeout();
    await flush();
    expect(done).toBe(true);
  });
});
