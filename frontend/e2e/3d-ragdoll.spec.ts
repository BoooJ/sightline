import { readFileSync } from "node:fs";
import { decode } from "@msgpack/msgpack";
import { expect, test, type Page } from "@playwright/test";
import type { ReplayPayload } from "../src/shared/api/types.ts";
import { agentGlb, animsGlb, collisionGlb, COMMON_CLIPS, mondeGlb, ragdollGlb } from "../src/features/replay3d/testGlb.ts";

/** Morts en ragdoll, de bout en bout (Chromium, vrai worker). Même montage que 3d-joueurs.spec.ts (page.route, petits .glb
 *  fabriqués en mémoire, rien de Valve), avec le fichier « ragdoll » des agents de test et, si `collision`, la collision de
 *  la carte : un sol sous chaque mort des replays reçus (positions lues dans leurs réponses, au format msgpack). */
const W2M = [0, 0.0254, 0, 0, 0, 0, 0.0254, 0, 0.0254, 0, 0, 0, 0, 0, 0, 1];
const KEYS = (JSON.parse(readFileSync(new URL("../../scripts/map3d/lib/weapons.json", import.meta.url), "utf8")).weapons as
  { key: string }[]).map((w) => w.key);
const COLLISION = "/api/maps3d/de_nuke/collision-000000000000.glb";

async function mock(page: Page, collision: boolean) {
  const map = Buffer.from(agentGlb()), spots: [number, number, number][] = [], asked: string[] = [];
  const files: Record<string, Buffer> = { "agent-ct": Buffer.from(agentGlb()), "agent-t": Buffer.from(agentGlb()),
    "anims-rifle": Buffer.from(animsGlb()), "anims-pistol": Buffer.from(animsGlb()), "anims-knife": Buffer.from(animsGlb()),
    "anims-communes": Buffer.from(animsGlb(COMMON_CLIPS)), ragdoll: Buffer.from(ragdollGlb()) };
  for (const k of KEYS) files[`monde-${k}`] = Buffer.from(mondeGlb());
  await page.route("**/api/rounds/*/replay", async (r) => {
    try {
      const res = await r.fetch(), body = await res.body();
      for (const k of (decode(body) as ReplayPayload).kills) spots.push(k.victim_pos);
      await r.fulfill({ response: res, body });
    } catch (e) {
      // test fini pendant le préchargement d'un round voisin (« Test ended », page fermée, ou réponse déjà libérée par la
      // fermeture du contexte : « Response has been disposed » pendant res.body()) : rien à rendre
      if (page.isClosed() || /Test ended|has been closed|has been disposed/.test(String(e))) return;
      // autre échec (serveur en panne, réponse illisible…) : requête refusée tout de suite, la cause dans le rapport
      await r.abort().catch(() => {});
      throw e;
    }
  });
  await page.route("**/api/maps3d", (r) => r.fulfill({ json: [{ map: "de_nuke", build: "2000939", exported_at: "2026-11-08T10:00:00Z",
    checks: {}, world_to_model: W2M, variants: { gray: { url: "/api/maps3d/de_nuke/gray-000000000000.glb", size: map.length },
      ...(collision ? { collision: { url: COLLISION, size: 1 } } : {}) } }] }));
  await page.route("**/api/maps3d/de_nuke/*.glb", (r) => {
    asked.push(new URL(r.request().url()).pathname);
    return r.fulfill({ body: r.request().url().endsWith(COLLISION) ? Buffer.from(collisionGlb(spots)) : map, contentType: "model/gltf-binary" });
  });
  await page.route("**/api/assets3d", (r) => r.fulfill({ json: { joueurs: { build: "2000939", exported_at: "2026-11-08T10:00:00Z",
    files: Object.fromEntries(Object.entries(files).map(([n, b]) => [n, { url: `/api/assets3d/joueurs/${n}-000000000000.glb`, size: b.length }])) } } }));
  await page.route("**/api/assets3d/joueurs/*.glb", (r) => {
    const name = new URL(r.request().url()).pathname.split("/").pop()!.replace(/-[0-9a-f]{12}\.glb$/, "");
    return r.fulfill({ body: files[name], contentType: "model/gltf-binary" });
  });
  return { spots, asked };
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

test("ragdoll : avec la collision de la carte et le fichier « ragdoll », les morts du round sont calculées dans le worker", async ({ page }) => {
  const { spots, asked } = await mock(page, true);
  await open3d(page);
  expect(spots.length).toBeGreaterThan(0);  // le round choisi a des morts
  const scene = page.getByTestId("scene3d");
  await expect(scene).toHaveAttribute("data-agents", "on");
  await expect(scene).toHaveAttribute("data-ragdolls", /^[1-9]\d*$/, { timeout: 15_000 });
  expect(asked).toContain(COLLISION);
});

test("ragdoll : sans collision de la carte, aucune trajectoire ; les morts gardent leurs clips, la 3D marche", async ({ page }) => {
  const { asked } = await mock(page, false);
  await open3d(page);
  const scene = page.getByTestId("scene3d");
  await expect(scene).toHaveAttribute("data-agents", "on");
  await page.waitForTimeout(1000);
  await expect(scene).toHaveAttribute("data-ragdolls", "0");
  expect(asked).not.toContain(COLLISION);
});
