import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { armsGlb, texturedMapGlb, weaponGlb } from "../src/features/replay3d/testGlb.ts";

/** Cartes et fichiers « vue » gardés dans le navigateur d'une visite à l'autre (Cache Storage, glbCache.ts). La base de
 *  test n'active pas le module replay3d : liste des cartes, fichiers « vue » et .glb sont servis par page.route (petits
 *  .glb fabriqués par testGlb.ts ; rien de Valve). Le nom du fichier le fait passer avant replay.spec.ts, dont le dernier
 *  test crée un compte (API verrouillée). */
const W2M = [0, 0.0254, 0, 0, 0, 0, 0.0254, 0, 0.0254, 0, 0, 0, 0, 0, 0, 1];
const KEYS = (JSON.parse(readFileSync(new URL("../../scripts/map3d/lib/weapons.json", import.meta.url), "utf8")).weapons as
  { key: string }[]).map((w) => w.key);

/** Carte de Nuke (grise et texturée) et fichiers « vue » ; `tags` : somme de chaque variante dans la liste (un nouvel
 *  export la change) ; `textured` : contenu de la texturée (sinon, comme la grise, un triangle sans texture). Renvoie les
 *  .glb demandés au réseau (chemins). */
async function mock(page: Page, tags: { gray: string; textured: string }, textured?: Buffer) {
  const map = Buffer.from(armsGlb()), tex = textured ?? map, arms = Buffer.from(armsGlb()), gun = Buffer.from(weaponGlb());
  const asked: string[] = [];
  page.on("request", (q) => { if (q.url().endsWith(".glb")) asked.push(new URL(q.url()).pathname); });
  await page.route("**/api/maps3d", (r) => r.fulfill({ json: [{ map: "de_nuke", build: "2000935", exported_at: "2026-10-30T10:00:00Z",
    checks: {}, world_to_model: W2M, variants: {
      gray: { url: `/api/maps3d/de_nuke/gray-${tags.gray}.glb`, size: map.length },
      textured: { url: `/api/maps3d/de_nuke/textured-${tags.textured}.glb`, size: tex.length } } }] }));
  await page.route("**/api/maps3d/de_nuke/*.glb", (r) =>
    r.fulfill({ body: r.request().url().includes("/textured-") ? tex : map, contentType: "model/gltf-binary" }));
  await page.route("**/api/assets3d", (r) => {
    const file = (name: string, size: number) => ({ url: `/api/assets3d/vue/${name}-000000000000.glb`, size });
    return r.fulfill({ json: { vue: { build: "2000935", exported_at: "2026-10-30T10:00:00Z",
      files: { "bras-ct": file("bras-ct", arms.length), "bras-t": file("bras-t", arms.length),
        ...Object.fromEntries(KEYS.map((k) => [`arme-${k}`, file(`arme-${k}`, gun.length)])) } } } });
  });
  await page.route("**/api/assets3d/vue/*.glb", (r) =>
    r.fulfill({ body: r.request().url().includes("/bras-") ? arms : gun, contentType: "model/gltf-binary" }));
  // états de la vue (« loading » puis « ready » : carte posée), relevés dès le chargement de chaque page
  await page.addInitScript(() => {
    const w = window as unknown as { states: string[] };
    w.states = [];
    new MutationObserver(() => {
      const s = document.querySelector('[data-testid="scene3d"]')?.getAttribute("data-state");
      if (s && s !== w.states.at(-1)) w.states.push(s);
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-state"] });
  });
  return asked;
}

/** Carte posée : passée par « loading », revenue à « ready ». */
async function posed(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const s = (window as unknown as { states: string[] }).states;
    return s.includes("loading") && s.at(-1) === "ready";
  }), { timeout: 30_000 }).toBe(true);
}

/** Carte posée, puis caméra « Joueur » avec ses bras. */
async function ready(page: Page) {
  await posed(page);
  await page.getByTestId("cam-pov").click();
  await expect(page.getByTestId("scene3d")).toHaveAttribute("data-arms", "on");
}

/** Part de la vue 3D (capture) couverte par le rouge de la carte texturée de `texturedMapGlb`, éclairé ou dans l'ombre. */
async function red(page: Page): Promise<number> {
  const png = (await page.getByTestId("scene3d").screenshot()).toString("base64");
  return page.evaluate(async (b64) => {
    const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = new OffscreenCanvas(img.width, img.height), g = c.getContext("2d")!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, img.width, img.height).data;
    let n = 0;
    for (let k = 0; k < d.length; k += 4) if (d[k] > 60 && d[k] > 2.5 * d[k + 1] && d[k] > 2.5 * d[k + 2]) n++;
    return n / (d.length / 4);
  }, png);
}

/** Chemins gardés dans le Cache Storage de la page. */
const stored = (page: Page) => page.evaluate(async () => {
  const out: string[] = [];
  for (const n of await caches.keys()) for (const q of await (await caches.open(n)).keys()) out.push(new URL(q.url).pathname);
  return out.sort();
});

test("cartes et fichiers « vue » gardés : à la visite suivante, aucun .glb redemandé ; nouvel export : seul le nouveau fichier téléchargé, l'ancien effacé", async ({ page }) => {
  test.setTimeout(60_000);  // trois chargements de la page avec la 3D (≈ 20 s sur le PC de l'équipe)
  const tags = { gray: "000000000000", textured: "000000000000" };
  const asked = await mock(page, tags);
  await page.goto("/");
  await page.getByTestId("match-row").click();
  await page.getByTestId("round-cell").nth(1).click();
  await expect(page.getByTestId("radar")).toBeVisible();
  const webgl = await page.evaluate(() => !!document.createElement("canvas").getContext("webgl2"));
  test.skip(!webgl, "WebGL 2 indisponible dans ce Chromium");
  await page.getByTestId("view-3d").click();
  await expect.poll(() => asked.length).toBeGreaterThan(0);  // la grise (variante par défaut)
  await page.getByTestId("variant-textured").click();
  await expect(page.getByTestId("variant-textured")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => asked).toContain("/api/maps3d/de_nuke/textured-000000000000.glb");
  await ready(page);
  // 1re visite : grise, texturée, bras et armes de l'inventaire (préchargées), chacun téléchargé une fois puis gardé ;
  // on attend que tout ce qui a été demandé soit gardé, et plus rien demandé depuis 1 s
  let first: string[] = [];
  await expect.poll(async () => {
    const n = asked.length, s = await stored(page);
    await page.waitForTimeout(1000);
    first = s;
    return asked.length === n && s.join() === [...new Set(asked)].sort().join();
  }, { timeout: 30_000 }).toBe(true);
  expect(first).toEqual(expect.arrayContaining(["/api/maps3d/de_nuke/gray-000000000000.glb",
    "/api/maps3d/de_nuke/textured-000000000000.glb"]));
  expect(first.some((p) => p.startsWith("/api/assets3d/vue/bras-"))).toBe(true);
  expect(asked).toHaveLength(first.length);  // une requête par fichier

  // visite suivante (page rechargée ; 3D et texturée retenues par la page) : tout vient des copies, même instant
  asked.length = 0;
  await page.reload();
  await ready(page);
  await page.waitForTimeout(1000);  // préchargement des armes de l'inventaire
  expect(asked).toEqual([]);

  // nouvel export de la grise (autre somme) : elle seule est téléchargée ; l'ancienne copie est effacée
  tags.gray = "111111111111";
  asked.length = 0;
  await page.reload();
  await ready(page);
  await page.waitForTimeout(1000);
  expect(asked).toEqual(["/api/maps3d/de_nuke/gray-111111111111.glb"]);
  await expect.poll(() => stored(page)).toEqual(first.map((p) => p.replace("gray-000000000000", "gray-111111111111")).sort());
});

// three garde l'image décodée de chaque texture pour la renvoyer à la carte graphique ; elle est libérée après le premier
// envoi (dispose.ts), et un contexte graphique perdu puis rendu fait relire la carte (viewer.ts, `restored`)
test("contexte graphique perdu puis rendu : la carte texturée, dont les images ont été libérées, est relue depuis ses copies (aucun .glb redemandé) et redessinée", async ({ page }) => {
  test.setTimeout(60_000);
  const textured = "/api/maps3d/de_nuke/textured-000000000000.glb";
  const asked = await mock(page, { gray: "000000000000", textured: "000000000000" }, Buffer.from(texturedMapGlb()));
  const warned: string[] = [];  // texture dessinée sans image, ou ressource d'un contexte perdu libérée dans le nouveau
  page.on("console", (m) => { if (/no image data|does not belong/.test(m.text())) warned.push(m.text()); });
  await page.goto("/");
  await page.getByTestId("match-row").click();
  await page.getByTestId("round-cell").nth(1).click();
  await expect(page.getByTestId("radar")).toBeVisible();
  const webgl = await page.evaluate(() => !!document.createElement("canvas").getContext("webgl2"));
  test.skip(!webgl, "WebGL 2 indisponible dans ce Chromium");
  await page.getByTestId("view-3d").click();
  await expect.poll(() => asked.length).toBeGreaterThan(0);
  await page.getByTestId("variant-textured").click();
  await expect.poll(() => asked).toContain(textured);
  await posed(page);
  await expect.poll(() => red(page), { timeout: 15_000 }).toBeGreaterThan(0.05);  // texture dessinée
  await expect.poll(() => stored(page)).toContain(textured);  // copie écrite (en arrière-plan)

  asked.length = 0;
  await page.evaluate(() => { (window as unknown as { states: string[] }).states = []; });
  await page.evaluate(async () => {
    const lose = document.querySelector<HTMLCanvasElement>(".r3-canvas")!.getContext("webgl2")!.getExtension("WEBGL_lose_context")!;
    lose.loseContext();
    await new Promise((r) => setTimeout(r, 300));
    lose.restoreContext();
  });
  // relue (« loading », puis « ready ») depuis ses copies : aucune requête ; puis dessinée de nouveau, texture comprise
  await posed(page);
  await expect.poll(() => red(page), { timeout: 15_000 }).toBeGreaterThan(0.05);
  expect(asked).toEqual([]);
  expect(warned).toEqual([]);
});
