import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { armsGlb, weaponGlb } from "../src/features/replay3d/testGlb.ts";

/** Vue du joueur avec bras et arme. La base de test n'active pas le module replay3d : liste des cartes, fichiers « vue » et
 *  .glb sont servis par page.route (petits .glb animés fabriqués en mémoire par testGlb.ts, au format de scripts/map3d ;
 *  rien de Valve). Le nom du fichier le fait passer avant replay.spec.ts, dont le dernier test crée un compte (API
 *  verrouillée). */
const W2M = [0, 0.0254, 0, 0, 0, 0, 0.0254, 0, 0.0254, 0, 0, 0, 0, 0, 0, 1];
const KEYS = (JSON.parse(readFileSync(new URL("../../scripts/map3d/lib/weapons.json", import.meta.url), "utf8")).weapons as
  { key: string }[]).map((w) => w.key);

/** Fichiers « vue » servis : `list(n)` répond à la n-ième lecture de la liste (1, 2…) : statut (200 par défaut) et suffixe
 *  des adresses (un nouvel export les change) ; `file(url)` : statut d'un .glb (200 par défaut), ou « illisible » (200 et
 *  des octets qui ne sont pas un .glb). */
interface Vue { list?: (n: number) => { status?: number; tag?: string }; file?: (url: string) => number | "illisible" }

/** Carte (un triangle suffit), et fichiers « vue » si `vue` : bras des deux camps et une arme par clé de weapons.json ;
 *  sans : liste en 404 (module coupé). Renvoie le nombre de lectures de la liste. */
async function mock(page: Page, vue: Vue | null) {
  const map = Buffer.from(armsGlb()), arms = Buffer.from(armsGlb()), gun = Buffer.from(weaponGlb());
  const reads = { n: 0 };
  await page.route("**/api/maps3d", (r) => r.fulfill({ json: [{ map: "de_nuke", build: "2000935", exported_at: "2026-10-30T10:00:00Z",
    checks: {}, world_to_model: W2M, variants: { gray: { url: "/api/maps3d/de_nuke/gray-000000000000.glb", size: map.length } } }] }));
  await page.route("**/api/maps3d/de_nuke/*.glb", (r) => r.fulfill({ body: map, contentType: "model/gltf-binary" }));
  await page.route("**/api/assets3d", (r) => {
    reads.n++;
    if (!vue) return r.fulfill({ status: 404, json: { detail: "Not Found" } });
    const { status = 200, tag = "000000000000" } = vue.list?.(reads.n) ?? {};
    if (status !== 200) return r.fulfill({ status, json: { detail: "refusé" } });
    const file = (name: string, size: number) => ({ url: `/api/assets3d/vue/${name}-${tag}.glb`, size });
    return r.fulfill({ json: { vue: { build: "2000935", exported_at: "2026-10-30T10:00:00Z",
      files: { "bras-ct": file("bras-ct", arms.length), "bras-t": file("bras-t", arms.length),
        ...Object.fromEntries(KEYS.map((k) => [`arme-${k}`, file(`arme-${k}`, gun.length)])) } } } });
  });
  await page.route("**/api/assets3d/vue/*.glb", (r) => {
    const url = r.request().url(), status = vue?.file?.(url) ?? 200;
    if (status === "illisible") return r.fulfill({ body: "pas un glb", contentType: "model/gltf-binary" });
    return status === 200 ? r.fulfill({ body: url.includes("/bras-") ? arms : gun, contentType: "model/gltf-binary" })
      : r.fulfill({ status, json: { detail: "refusé" } });
  });
  return reads;
}

async function open3d(page: Page) {
  await page.goto("/");
  await page.getByTestId("match-row").click();
  await page.getByTestId("round-cell").nth(1).click();
  await expect(page.getByTestId("radar")).toBeVisible();
  const webgl = await page.evaluate(() => !!document.createElement("canvas").getContext("webgl2"));
  test.skip(!webgl, "WebGL 2 indisponible dans ce Chromium");
  await page.getByTestId("view-3d").click();
  await expect(page.getByTestId("scene3d")).toHaveAttribute("data-state", "ready");
}

/** Deux images du navigateur : la boucle de la vue 3D a dessiné l'instant affiché, `data-arms` suit (rendu React). */
const twoFrames = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

test("vue du joueur : bras et arme quand les fichiers « vue » sont là, seulement dans cette caméra", async ({ page }) => {
  await mock(page, {});
  await open3d(page);
  const scene = page.getByTestId("scene3d"), clock = page.getByTestId("round-clock");
  await expect(scene).toHaveAttribute("data-arms", "off");
  await page.getByTestId("cam-pov").click();
  await expect(scene).toHaveAttribute("data-arms", "on");
  // un autre instant (5 s plus tard) : les bras restent. L'attribut vaut déjà « on » avant le saut : il est lu une fois,
  // après le dessin du nouvel instant (un retrait des bras, même passager, se verrait)
  const before = (await clock.textContent()) ?? "";
  await page.keyboard.press("ArrowRight");
  await expect(clock).not.toHaveText(before);
  await twoFrames(page);
  expect(await scene.getAttribute("data-arms")).toBe("on");
  await page.getByTestId("cam-follow").click();
  await expect(scene).toHaveAttribute("data-arms", "off");
});

test("vue du joueur sans fichiers « vue » : pas de bras, aucun fichier demandé, la vue marche", async ({ page }) => {
  const asked: string[] = [];
  page.on("request", (q) => { if (q.url().includes("/api/assets3d/vue/")) asked.push(q.url()); });
  await mock(page, null);
  await open3d(page);
  await page.getByTestId("cam-pov").click();
  await expect(page.getByTestId("cam-pov")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("scene3d")).toHaveAttribute("data-arms", "off");
  await expect(page.getByTestId("scene3d")).toHaveAttribute("data-state", "ready");
  expect(asked).toEqual([]);
});

test("vue du joueur : fichiers ré-exportés depuis la lecture de la liste (404) → liste relue, bras aux nouvelles adresses", async ({ page }) => {
  const reads = await mock(page, { list: (n) => ({ tag: n === 1 ? "000000000000" : "111111111111" }),
    file: (url) => (url.includes("-000000000000.glb") ? 404 : 200) });
  await open3d(page);
  await page.getByTestId("cam-pov").click();
  await expect(page.getByTestId("scene3d")).toHaveAttribute("data-arms", "on");
  expect(reads.n).toBeGreaterThanOrEqual(2);
});

test("vue du joueur : fichiers « vue » illisibles ou en erreur serveur → sans bras, liste pas relue (le ViewModel réessaie seul)", async ({ page }) => {
  // relue, la liste donnerait les mêmes adresses : avant, elle l'était à chaque essai (toutes les 10 s, sans fin)
  const reads = await mock(page, { file: (url) => (url.includes("/bras-") ? "illisible" : 500) });
  const failed = new Set<string>();  // fichiers signalés en échec par le ViewModel (`onError` juste après ce message)
  page.on("console", (m) => { const k = /Vue du joueur : (bras|arme)-\S+ non chargé/.exec(m.text()); if (k) failed.add(k[1]); });
  await open3d(page);
  await page.getByTestId("cam-pov").click();
  await expect.poll(() => [...failed].sort()).toEqual(["arme", "bras"]);
  // une relecture partirait au moment même de l'échec : on la guette encore 1,5 s
  const reread = await page.waitForRequest((q) => new URL(q.url()).pathname === "/api/assets3d", { timeout: 1500 })
    .then(() => true, () => false);
  expect(reread).toBe(false);
  expect(reads.n).toBe(1);
  const scene = page.getByTestId("scene3d");
  await expect(scene).toHaveAttribute("data-arms", "off");
  await expect(scene).toHaveAttribute("data-state", "ready");
  await expect(page.getByTestId("pov-hud")).toBeVisible();
});

test("vue du joueur : fichiers « vue » en 401 (session expirée) → sans bras, ni liste relue ni écran de connexion", async ({ page }) => {
  // demandes d'écran de connexion (la base de test n'a pas de compte : l'écran lui-même n'apparaîtrait pas)
  await page.addInitScript(() => {
    const w = window as unknown as { authAsked: number };
    w.authAsked = 0;
    window.addEventListener("auth-required", () => { w.authAsked++; });
  });
  const reads = await mock(page, { list: (n) => (n === 1 ? {} : { status: 401 }), file: () => 401 });
  await open3d(page);
  const refused = page.waitForResponse((q) => q.url().includes("/api/assets3d/vue/") && q.status() === 401);
  await page.getByTestId("cam-pov").click();
  await refused;
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(500);  // une relecture de la liste partirait tout de suite après l'échec
  const scene = page.getByTestId("scene3d");
  await expect(scene).toHaveAttribute("data-arms", "off");
  await expect(scene).toHaveAttribute("data-state", "ready");
  await expect(page.getByTestId("pov-hud")).toBeVisible();
  expect(reads.n).toBe(1);
  expect(await page.evaluate(() => (window as unknown as { authAsked: number }).authAsked)).toBe(0);
});
