import { expect, test, type Page } from "@playwright/test";

/** Vue 3D du replay. La base de test n'active pas le module replay3d : la liste des cartes et le .glb sont servis par
 *  page.route. Le nom du fichier le fait passer avant replay.spec.ts, dont le dernier test crée un compte (API verrouillée). */
const W2M = [0, 0.0254, 0, 0, 0, 0, 0.0254, 0, 0.0254, 0, 0, 0, 0, 0, 0, 1];

/** Plus petit .glb utile : un grand triangle (coordonnées glTF) sous les joueurs de Nuke. */
function tinyGlb(): Buffer {
  const pos = new Float32Array([-150, -20, -150, 150, -20, -150, 0, -20, 150]);
  const bin = Buffer.from(pos.buffer);
  const json = { asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [-150, -20, -150], max: [150, -20, 150] }],
    bufferViews: [{ buffer: 0, byteLength: bin.length }], buffers: [{ byteLength: bin.length }] };
  let js = Buffer.from(JSON.stringify(json));
  js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const chunk = (type: number, data: Buffer) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(data.length, 0);
    h.writeUInt32LE(type, 4);
    return Buffer.concat([h, data]);
  };
  const body = Buffer.concat([chunk(0x4e4f534a, js), chunk(0x004e4942, bin)]);
  const head = Buffer.alloc(12);
  head.write("glTF", 0, "ascii");
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + body.length, 8);
  return Buffer.concat([head, body]);
}

/** Liste des cartes et .glb servis ; renvoie le nombre de .glb demandés. */
async function mockMaps(page: Page, glbStatus = 200) {
  const glb = tinyGlb(), asked = { n: 0 };
  const variant = (v: string) => ({ url: `/api/maps3d/de_nuke/${v}-000000000000.glb`, size: glb.length });
  await page.route("**/api/maps3d", (r) => r.fulfill({ json: [{ map: "de_nuke", build: "2000873", exported_at: "2026-10-26T18:00:00Z",
    checks: { bomb_a: 40, bomb_b: 35 }, world_to_model: W2M, variants: { gray: variant("gray"), textured: variant("textured") } }] }));
  await page.route("**/api/maps3d/de_nuke/*.glb", (r) => {
    asked.n++;
    return glbStatus === 200 ? r.fulfill({ body: glb, contentType: "model/gltf-binary" }) : r.fulfill({ status: glbStatus, body: "panne" });
  });
  return asked;
}

async function openRound(page: Page) {
  await page.goto("/");
  await page.getByTestId("match-row").click();
  await page.getByTestId("round-cell").nth(1).click();
  await expect(page.getByTestId("radar")).toBeVisible();
}

test("replay 3D : sans carte 3D, pas de bouton", async ({ page }) => {
  await openRound(page);
  await expect(page.getByTestId("view-3d")).toHaveCount(0);
});

test("replay 3D : bouton, scène, caméras, même instant", async ({ page }) => {
  await mockMaps(page);
  await openRound(page);
  const webgl = await page.evaluate(() => !!document.createElement("canvas").getContext("webgl2"));
  test.skip(!webgl, "WebGL 2 indisponible dans ce Chromium : seul le repli est testé");
  const clock = page.getByTestId("round-clock");
  const before = (await clock.textContent()) ?? "";
  await page.getByTestId("view-3d").click();
  await expect(page.getByTestId("scene3d")).toHaveAttribute("data-state", "ready");
  await expect(page.getByTestId("radar")).toHaveCount(0);
  await expect(clock).toHaveText(before);
  for (const id of ["free", "follow", "pov", "top", "tv"]) {
    await page.getByTestId(`cam-${id}`).click();
    await expect(page.getByTestId(`cam-${id}`)).toHaveAttribute("aria-pressed", "true");
  }
  await page.getByTestId("variant-textured").click();
  await expect(page.getByTestId("variant-textured")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("scene3d")).toHaveAttribute("data-state", "ready");
  await page.keyboard.press("ArrowRight");  // les raccourcis du replay marchent en 3D
  await expect(clock).not.toHaveText(before);
  await page.getByTestId("view-2d").click();
  await expect(page.getByTestId("radar")).toBeVisible();
});

// grise seule ; texturée choisie avant la 2D (la grise d'abord, puis la texturée : 2 fichiers à l'aller, aucun au retour)
for (const textured of [false, true]) test(`replay 3D : retour de la 2D sans recharger la carte${textured ? " texturée" : ""} (même vue, même caméra, aucun chargement)`, async ({ page }) => {
  const asked = await mockMaps(page), files = textured ? 2 : 1;
  await openRound(page);
  const webgl = await page.evaluate(() => !!document.createElement("canvas").getContext("webgl2"));
  test.skip(!webgl, "WebGL 2 indisponible dans ce Chromium : seul le repli est testé");
  const scene = page.getByTestId("scene3d"), clock = page.getByTestId("round-clock"), pageFeed = page.getByTestId("killfeed");
  await page.getByTestId("view-3d").click();
  await expect.poll(() => asked.n).toBe(1);  // la grise (variante par défaut)
  await expect(scene).toHaveAttribute("data-state", "ready");
  if (textured) {
    await page.getByTestId("variant-textured").click();
    await expect.poll(() => asked.n).toBe(2);
    await expect(page.getByTestId("variant-textured")).toHaveAttribute("aria-pressed", "true");
    await expect(scene).toHaveAttribute("data-state", "ready");
  }
  // juste après le premier kill (le fil des kills de la page en montre une ligne), caméra « Joueur » : HUD à la place
  await page.locator(".tl-marker.tl-kill").first().dispatchEvent("mousedown");
  await page.keyboard.press("ArrowRight");
  await page.getByTestId("cam-pov").click();
  await expect(page.getByTestId("pov-hud")).toBeVisible();
  await expect(pageFeed).toBeHidden();
  const hudClock = page.locator(".r3-clock"), shown = (await hudClock.textContent()) ?? "";
  // à partir d'ici : chaque changement de l'état de la vue (absente comprise), et sa toile (même contexte WebGL au retour)
  await page.evaluate(() => {
    const w = window as unknown as { states: string[]; canvas: Element | null };
    const now = () => document.querySelector('[data-testid="scene3d"]')?.getAttribute("data-state") ?? "absente";
    let last = now();
    w.states = [];
    w.canvas = document.querySelector('[data-testid="scene3d"] canvas');
    new MutationObserver(() => { const s = now(); if (s !== last) w.states.push(last = s); })
      .observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-state"] });
  });
  await page.getByTestId("view-2d").click();
  await expect(page.getByTestId("radar")).toBeVisible();
  await expect(scene).toBeHidden();
  await expect(page.getByTestId("pov-hud")).toHaveCount(0);  // ni HUD ni petit radar en 2D
  await expect(pageFeed.locator(".kf-row").first()).toBeVisible();  // le fil des kills de la page revient
  const before = (await clock.textContent()) ?? "";
  await page.keyboard.press("ArrowRight");  // l'instant change en 2D
  await expect(clock).not.toHaveText(before);
  await page.getByTestId("view-3d").click();
  await expect(scene).toBeVisible();
  await expect(scene).toHaveAttribute("data-state", "ready");
  await expect(page.getByTestId("cam-pov")).toHaveAttribute("aria-pressed", "true");  // même caméra
  await expect(page.getByTestId(textured ? "variant-textured" : "variant-gray")).toHaveAttribute("aria-pressed", "true");  // même variante
  await expect(page.getByTestId("pov-hud")).toBeVisible();
  await expect(hudClock).not.toHaveText(shown);  // reprise à l'instant courant (5 s plus tard), pas à celui du départ
  await expect(page.getByTestId("radar")).toHaveCount(0);
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  expect(asked.n).toBe(files);  // carte pas redemandée
  expect(await page.evaluate(() => {
    const w = window as unknown as { states: string[]; canvas: Element | null };
    return { states: w.states, sameCanvas: document.querySelector('[data-testid="scene3d"] canvas') === w.canvas };
  })).toEqual({ states: [], sameCanvas: true });  // jamais démontée ni repassée par « loading »
});

test("replay 3D : carte en erreur → message et retour au radar", async ({ page }) => {
  await mockMaps(page, 500);
  await openRound(page);
  await page.getByTestId("view-3d").click();
  await expect(page.getByTestId("view3d-error")).toContainText("Vue 3D indisponible");
  await expect(page.getByTestId("radar")).toBeVisible();
});

test("replay 3D : vue du joueur, HUD et réticule", async ({ page }) => {
  await mockMaps(page);
  await openRound(page);
  const webgl = await page.evaluate(() => !!document.createElement("canvas").getContext("webgl2"));
  test.skip(!webgl, "WebGL 2 indisponible dans ce Chromium : seul le repli est testé");
  await page.getByTestId("view-3d").click();
  await expect(page.getByTestId("scene3d")).toHaveAttribute("data-state", "ready");
  await page.getByTestId("cam-pov").click();
  const hud = page.getByTestId("pov-hud");
  await expect(hud).toBeVisible();
  // vie du joueur suivi (en bas au centre ; la barre de score a aussi une vie par joueur)
  await expect(page.getByTestId("pov-vitals").locator('[aria-label$="points de vie"]')).toBeVisible();
  await expect(page.getByTestId("pov-money")).toContainText("$");
  // début du round 2 de la base de test : le joueur suivi (premier vivant) tient un pistolet ou un couteau (réticule
  // affiché même avec le C4, depuis 3.9a) ; son code est lu (ancien ou actuel), ou le réticule fixe s'il n'y en a pas
  await expect(page.getByTestId("crosshair")).toBeVisible();
  await page.getByTestId("cam-follow").click();
  await expect(hud).toHaveCount(0);
  await expect(page.getByTestId("crosshair")).toHaveCount(0);
});

test("replay 3D : HUD complet en caméra « Joueur » (score, fil des kills, armes), rien hors « Joueur »", async ({ page }) => {
  await mockMaps(page);
  await openRound(page);
  const webgl = await page.evaluate(() => !!document.createElement("canvas").getContext("webgl2"));
  test.skip(!webgl, "WebGL 2 indisponible dans ce Chromium : seul le repli est testé");
  await page.getByTestId("view-3d").click();
  await expect(page.getByTestId("scene3d")).toHaveAttribute("data-state", "ready");
  // juste après le premier kill du round : repère de la frise (1 s avant le kill), puis + 5 s ; le fil des kills de la
  // page (5 dernières secondes) en montre une ligne
  await page.locator(".tl-marker.tl-kill").first().dispatchEvent("mousedown");
  await page.keyboard.press("ArrowRight");
  const pageFeed = page.getByTestId("killfeed");
  await expect(pageFeed.locator(".kf-row").first()).toBeVisible();
  await page.getByTestId("cam-pov").click();
  const blocks = ["pov-board", "pov-killfeed", "pov-weapons", "pov-radar", "pov-money", "pov-vitals"];
  for (const id of blocks) await expect(page.getByTestId(id)).toBeVisible();
  const board = page.getByTestId("pov-board");
  await expect(board.locator(".r3-team.ct [data-sid]").first()).toBeVisible();
  await expect(board.locator(".r3-team.t [data-sid]").first()).toBeVisible();
  await expect(board.locator(".r3-card.me")).toHaveCount(1);  // joueur suivi
  await expect(page.getByTestId("pov-killfeed").locator(".r3-kill").first()).toBeVisible();
  await expect(pageFeed).toBeHidden();  // remplacé par celui du HUD
  await expect(page.getByTestId("pov-hud")).toHaveCSS("pointer-events", "none");  // aucun clic intercepté
  await expect(page.getByTestId("pov-label")).toHaveText(/^POV \d+$/);
  // HUD à l'échelle de la vue (hauteur / 1080), radar collé en haut à gauche de la vue
  const geo = await page.evaluate(() => {
    const scene = document.querySelector('[data-testid="scene3d"]') as HTMLElement;
    const s = scene.getBoundingClientRect(), r = document.querySelector('[data-testid="pov-radar"]')!.getBoundingClientRect();
    return { k: Number(scene.style.getPropertyValue("--r3-k")), expected: Math.min(s.height / 1080, s.width / 1440),
      dx: Math.abs(r.left - s.left), dy: Math.abs(r.top - s.top) };
  });
  expect(geo.k).toBeCloseTo(geo.expected, 3);
  expect(geo.dx).toBeLessThan(1);
  expect(geo.dy).toBeLessThan(1);
  // ADR du joueur suivi : un nombre, une fois le round 1 dans le cache (la page précharge le match ; mêmes clés de requêtes)
  await expect(page.locator(".r3-adr b")).toHaveText(/^\d+$/, { timeout: 30_000 });
  // la barre des caméras ne recouvre pas le HUD : transparente et sans clics loin de la souris (un clic au-dessus du radar
  // atteint la vue), elle revient quand la souris s'en approche
  const bar = page.locator(".r3-bar");
  const near = async () => { const b = (await page.getByTestId("cam-pov").boundingBox())!; await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); };
  await page.mouse.move(1, 1);
  await expect(bar).toHaveCSS("opacity", "0");
  await expect(bar).toHaveCSS("pointer-events", "none");
  const hit = await page.evaluate(() => {
    const r = document.querySelector('[data-testid="cam-pov"]')!.getBoundingClientRect();
    return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.tagName;
  });
  expect(hit).toBe("CANVAS");  // pas de bouton invisible sous la souris
  await near();
  await expect(bar).toHaveCSS("opacity", "1");
  await expect(bar).toHaveCSS("pointer-events", "auto");
  await page.mouse.move(1, 1);
  await expect(bar).toHaveCSS("opacity", "0");
  // au clavier : Tab jusqu'à un bouton de la barre, elle redevient visible
  let inBar = false;
  for (let i = 0; i < 120 && !inBar; i++) {
    await page.keyboard.press("Tab");
    inBar = await page.evaluate(() => !!document.activeElement?.closest(".r3-bar"));
  }
  expect(inBar).toBe(true);
  await expect(bar).toHaveCSS("opacity", "1");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(bar).toHaveCSS("opacity", "0");
  await near();
  await page.getByTestId("cam-follow").click();
  for (const id of ["pov-hud", ...blocks]) await expect(page.getByTestId(id)).toHaveCount(0);
  await page.mouse.move(1, 1);
  await expect(bar).toHaveCSS("opacity", "1");  // hors caméra « Joueur » : barre toujours visible
  await expect(pageFeed.locator(".kf-row").first()).toBeVisible();
});

test("replay 3D : voile blanc des flashs en caméra « Joueur » (plein écran, au-dessus du HUD, sans clic), absent hors « Joueur »", async ({ page }) => {
  await mockMaps(page);
  await openRound(page);
  const webgl = await page.evaluate(() => !!document.createElement("canvas").getContext("webgl2"));
  test.skip(!webgl, "WebGL 2 indisponible dans ce Chromium : seul le repli est testé");
  await page.getByTestId("view-3d").click();
  await expect(page.getByTestId("scene3d")).toHaveAttribute("data-state", "ready");
  await expect(page.getByTestId("pov-flash")).toHaveCount(0);  // pas en caméra « Joueur »
  await page.getByTestId("cam-pov").click();
  const veil = page.getByTestId("pov-flash"), scene = page.getByTestId("scene3d");
  await expect(veil).toHaveCount(1);
  await expect(veil).toHaveCSS("pointer-events", "none");  // aucun clic intercepté
  await expect(veil).toHaveCSS("opacity", "0");  // aucun joueur aveuglé dans ce round : aucun voile
  // l'opacité suit la variable CSS que la vue 3D écrit sur le voile seul à chaque changement (Viewer.onFlash, veilWriter)
  await expect(veil).toHaveAttribute("style", /--r3-flash:\s*0/);  // posée sur le voile dès son apparition
  await veil.evaluate((el) => el.style.setProperty("--r3-flash", "0.46"));
  await expect(veil).toHaveCSS("opacity", "0.46");
  expect(await scene.evaluate((el) => el.style.getPropertyValue("--r3-flash"))).toBe("");  // pas sur la vue : rien d'autre à restyler
  // plein écran sur la vue 3D, au-dessus du canvas, du réticule et du HUD (dégradé compris) : un flash blanchit
  // tout uniformément (pas de bande grise du dégradé en bas pendant un flash)
  const [vb, sb] = [await veil.boundingBox(), await scene.boundingBox()];
  expect(vb).toEqual(sb);
  const order = await page.evaluate(() => {
    const q = (id: string) => document.querySelector(`[data-testid="${id}"]`)!;
    const before = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    const z = (e: Element) => getComputedStyle(e).zIndex;
    return { canvasBeforeVeil: before(q("scene3d").querySelector("canvas")!, q("pov-flash")), crosshairBeforeVeil: before(q("crosshair"), q("pov-flash")),
      hudBeforeVeil: before(q("pov-hud"), q("pov-flash")), shadeInHud: q("pov-hud").contains(q("pov-shade")), veilZ: z(q("pov-flash")),
      hudZ: z(q("pov-hud")) };
  });
  expect(order).toEqual({ canvasBeforeVeil: true, crosshairBeforeVeil: true, hudBeforeVeil: true, shadeInHud: true, veilZ: "2", hudZ: "1" });
  // ordre réel d'empilement en bas de la vue : le voile passe devant le dégradé (le temps du test, le voile et le HUD prennent
  // les clics pour être vus par elementsFromPoint, puis on rend leur réglage)
  const top = await page.evaluate(() => {
    const els = ["pov-flash", "pov-hud", "pov-shade"].map((id) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement);
    for (const e of els) e.style.pointerEvents = "auto";
    const r = document.querySelector('[data-testid="scene3d"]')!.getBoundingClientRect();
    const hit = document.elementsFromPoint(r.left + r.width / 2, r.bottom - 4).map((e) => e.getAttribute("data-testid"))
      .find((x) => x === "pov-flash" || x === "pov-shade");
    for (const e of els) e.style.pointerEvents = "";
    return hit;
  });
  expect(top).toBe("pov-flash");
  // un clic au centre traverse le voile : il atteint le canvas (choix d'un joueur, caméra)
  const hit = await page.evaluate(() => {
    const r = document.querySelector("canvas")!.getBoundingClientRect();
    return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.tagName;
  });
  expect(hit).toBe("CANVAS");
  await page.getByTestId("cam-follow").click();
  await expect(veil).toHaveCount(0);
});
