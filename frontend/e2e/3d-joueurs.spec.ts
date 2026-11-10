import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { agentGlb, animsGlb, COMMON_CLIPS, mondeGlb } from "../src/features/replay3d/testGlb.ts";

/** Joueurs en modèles d'agents. La base de test n'active pas le module replay3d : liste des cartes, fichiers « joueurs »
 *  et .glb sont servis par page.route (petits .glb fabriqués en mémoire par testGlb.ts, au format de scripts/map3d ; rien
 *  de Valve). Le nom du fichier le fait passer avant replay.spec.ts, dont le dernier test crée un compte (API verrouillée). */
const W2M = [0, 0.0254, 0, 0, 0, 0, 0.0254, 0, 0.0254, 0, 0, 0, 0, 0, 0, 1];
const KEYS = (JSON.parse(readFileSync(new URL("../../scripts/map3d/lib/weapons.json", import.meta.url), "utf8")).weapons as
  { key: string }[]).map((w) => w.key);

/** Carte (un triangle), et fichiers « joueurs » si `joueurs` : deux agents, quatre jeux de clips et une arme du monde par clé
 *  de weapons.json, servis avec le statut `status` ; sans : liste en 404 (aucun fichier 3D). Renvoie les fichiers demandés
 *  et le nombre de lectures de la liste. */
async function mock(page: Page, joueurs: boolean, status = 200) {
  const map = Buffer.from(agentGlb()), asked: string[] = [], reads = { n: 0 };
  const files: Record<string, Buffer> = { "agent-ct": Buffer.from(agentGlb()), "agent-t": Buffer.from(agentGlb()),
    "anims-rifle": Buffer.from(animsGlb()), "anims-pistol": Buffer.from(animsGlb()), "anims-knife": Buffer.from(animsGlb()),
    "anims-communes": Buffer.from(animsGlb(COMMON_CLIPS)) };
  for (const k of KEYS) files[`monde-${k}`] = Buffer.from(mondeGlb());
  await page.route("**/api/maps3d", (r) => r.fulfill({ json: [{ map: "de_nuke", build: "2000939", exported_at: "2026-11-02T10:00:00Z",
    checks: {}, world_to_model: W2M, variants: { gray: { url: "/api/maps3d/de_nuke/gray-000000000000.glb", size: map.length } } }] }));
  await page.route("**/api/maps3d/de_nuke/*.glb", (r) => r.fulfill({ body: map, contentType: "model/gltf-binary" }));
  await page.route("**/api/assets3d", (r) => {
    reads.n++;
    return joueurs
      ? r.fulfill({ json: { joueurs: { build: "2000939", exported_at: "2026-11-02T10:00:00Z", files: Object.fromEntries(Object.entries(files)
        .map(([n, b]) => [n, { url: `/api/assets3d/joueurs/${n}-000000000000.glb`, size: b.length }])) } } })
      : r.fulfill({ status: 404, json: { detail: "Not Found" } });
  });
  await page.route("**/api/assets3d/joueurs/*.glb", (r) => {
    const name = new URL(r.request().url()).pathname.split("/").pop()!.replace(/-[0-9a-f]{12}\.glb$/, "");
    asked.push(name);
    return status === 200 ? r.fulfill({ body: files[name], contentType: "model/gltf-binary" }) : r.fulfill({ status, json: { detail: "refusé" } });
  });
  return { asked, reads };
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

/** Deux images du navigateur : la boucle de la vue 3D a dessiné l'instant affiché, `data-agents` suit (rendu React). */
const twoFrames = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

// `data-agents` vaut « on » quand au moins un joueur est dessiné en modèle à la dernière image (Viewer.onAgents, depuis la
// boucle de dessin) : il est attendu (toHaveAttribute réessaie), pas lu une fois. Dans toutes les caméras, des joueurs
// autres que celui dont on prend la vue sont dans le round
test("joueurs : modèles d'agents à la place des silhouettes quand les fichiers « joueurs » sont là, dans toutes les caméras", async ({ page }) => {
  const { asked } = await mock(page, true);
  await open3d(page);
  const scene = page.getByTestId("scene3d");
  await expect(scene).toHaveAttribute("data-agents", "on");
  for (const cam of ["cam-free", "cam-top", "cam-pov", "cam-follow"]) {
    await page.getByTestId(cam).click();
    await expect(page.getByTestId(cam)).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("ArrowRight");
    await twoFrames(page);
    await expect(scene).toHaveAttribute("data-agents", "on");
  }
  expect(asked).toEqual(expect.arrayContaining(["agent-ct", "agent-t", "anims-rifle", "anims-pistol", "anims-knife", "anims-communes"]));
});

test("sans fichiers « joueurs » : silhouettes, aucun fichier demandé, la 3D marche", async ({ page }) => {
  const { asked } = await mock(page, false);
  await open3d(page);
  await page.keyboard.press("ArrowRight");
  await twoFrames(page);
  const scene = page.getByTestId("scene3d");
  await expect(scene).toHaveAttribute("data-agents", "off");
  await expect(scene).toHaveAttribute("data-state", "ready");
  expect(asked).toEqual([]);
});

test("fichiers « joueurs » en erreur serveur : silhouettes, la 3D marche, liste pas relue (la bibliothèque réessaie seule)", async ({ page }) => {
  const failed = page.waitForEvent("console", (m) => /Joueurs 3D : \S+ non chargé/.test(m.text()));
  const { reads } = await mock(page, true, 500);
  await open3d(page);
  await failed;  // `onAgentsError` part juste après ce message
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(500);  // une relecture de la liste partirait tout de suite après l'échec
  const scene = page.getByTestId("scene3d");
  await expect(scene).toHaveAttribute("data-agents", "off");
  await expect(scene).toHaveAttribute("data-state", "ready");
  expect(reads.n).toBe(1);
});
