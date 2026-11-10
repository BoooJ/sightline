import { expect, test } from "@playwright/test";

/** Page de scouting d'une équipe : mode avancé puis onglet « Toutes les données » (anciennes sections). */
async function openScoutData(page: import("@playwright/test").Page) {
  await page.getByRole("radio", { name: "Avancé" }).click();
  await page.getByTestId("ts-tab-donnees").click();
}

test("bibliothèque → match → replay", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("match-row")).toHaveCount(1);
  await expect(page.getByTestId("match-row")).toContainText("Nuke");
  await page.getByTestId("match-row").click();
  await expect(page.getByTestId("round-cell")).toHaveCount(23);
  await expect(page.getByTestId("economy-chart")).toBeVisible();
  await expect(page.locator(".rs-bomb")).toHaveCount(10);
  await page.getByTestId("round-cell").nth(1).click();
  await expect(page.getByTestId("radar")).toBeVisible();
  await expect(page.getByTestId("team-ct")).toContainText("FaZe");
  const clock = page.getByTestId("round-clock");
  const before = await clock.textContent();
  await page.getByTestId("play").click();
  await page.waitForTimeout(1500);
  await page.getByTestId("play").click();
  expect(await clock.textContent()).not.toBe(before);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("N");
  await expect(page).toHaveURL(/replay\/3$/);
});

test("import : upload par morceaux jusqu'à l'analyse", async ({ page }) => {
  await page.goto("/");
  // 9 Mo → 2 morceaux ; contenu factice : l'analyse échoue, mais tout le trajet d'upload est parcouru
  const buffer = Buffer.alloc(9 * 1024 * 1024, 7);
  await page.locator('input[type="file"]').setInputFiles({ name: `e2e-${Date.now()}.dem`, mimeType: "application/octet-stream", buffer });
  await expect(page.locator(".notice")).toContainText("1 démo(s) ajoutée(s)", { timeout: 30_000 });
  await expect(page.getByTestId("import-row").filter({ hasText: "e2e-" })).toContainText("Erreur", { timeout: 60_000 });
  await page.getByTestId("import-row").filter({ hasText: "e2e-" }).getByRole("button").last().click();
});

test("match : onglets de stats et filtre de camp", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await page.getByTestId("match-row").click();
  await page.getByRole("tab", { name: "Joueurs" }).click();
  await expect(page.getByTestId("stats-row")).toHaveCount(10);
  await page.screenshot({ path: "test-results/shots/stats-players.png", fullPage: true });
  await page.getByRole("button", { name: "CT", exact: true }).click();
  await expect(page).toHaveURL(/side=CT/);
  await expect(page.getByTestId("stats-row")).toHaveCount(10);
  await page.getByRole("tab", { name: "Équipes" }).click();
  await expect(page.getByText("Duels d'ouverture gagnés")).toBeVisible();
  await page.screenshot({ path: "test-results/shots/stats-teams.png", fullPage: true });
  await page.getByRole("tab", { name: "Duels" }).click();
  await expect(page.getByRole("button", { name: "CT", exact: true })).toHaveCount(0);
  await expect(page.locator("td.duel")).toHaveCount(25);
  await page.screenshot({ path: "test-results/shots/stats-duels.png", fullPage: true });
});

test("joueurs : classement, fiche et filtres", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await page.getByRole("link", { name: "Joueurs", exact: true }).click();
  await expect(page.getByTestId("player-row")).toHaveCount(10);
  await page.screenshot({ path: "test-results/shots/players.png", fullPage: true });
  await page.getByTestId("player-row").first().getByRole("link").click();
  await expect(page.getByTestId("recent-row")).toHaveCount(1);
  await expect(page.getByText("Duels d'ouverture")).toBeVisible();
  await page.getByTestId("context-bar").getByRole("radio", { name: "T", exact: true }).click();
  await expect(page).toHaveURL(/side=T/);
  await expect(page.locator(".pl-sub")).not.toContainText("23 rounds");
  await page.screenshot({ path: "test-results/shots/player.png", fullPage: true });
});

test("rounds : filtres, playlist et lecture enchaînée", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/rounds");
  await expect(page.getByTestId("round-hit")).toHaveCount(23);
  await page.getByTestId("more-filters").click();  // filtres secondaires repliés par défaut
  await page.getByRole("group", { name: "Bombe" }).getByRole("button", { name: "Posée", exact: true }).click();
  await expect(page.getByTestId("round-hit")).toHaveCount(10);
  await page.getByRole("group", { name: "Bombe" }).getByRole("button", { name: "Toutes" }).click();
  await page.getByRole("group", { name: "Camp" }).getByRole("button", { name: "CT", exact: true }).click();
  await page.getByRole("group", { name: "Résultat" }).getByRole("button", { name: "Gagnés" }).click();
  await expect(page).toHaveURL(/side=CT.*result=won|result=won.*side=CT/);
  const n = await page.getByTestId("round-hit").count();
  expect(n).toBeGreaterThan(0);
  await page.screenshot({ path: "test-results/shots/rounds.png", fullPage: true });
  await page.getByTestId("round-hit").nth(0).getByRole("checkbox").check();
  await page.getByTestId("round-hit").nth(1).getByRole("checkbox").check();
  await page.getByRole("button", { name: "Ajouter à une playlist" }).click();
  const name = `Retakes ${Date.now()}`;
  await page.getByLabel("Nom de la nouvelle playlist").fill(name);
  await page.getByRole("button", { name: "Créer" }).click();
  await expect(page.locator(".notice")).toContainText("2 round(s) ajouté(s)");
  await page.getByRole("link", { name: "Playlists" }).click();
  await page.getByTestId("playlist-card").filter({ hasText: name }).click();
  await expect(page.getByTestId("playlist-item")).toHaveCount(2);
  await page.getByTestId("playlist-item").nth(1).getByRole("button", { name: "Monter" }).click();
  await page.getByLabel("Note du round 1").fill("timing du flash");
  await page.getByLabel("Note du round 1").blur();
  await page.screenshot({ path: "test-results/shots/playlist.png", fullPage: true });
  await page.getByRole("button", { name: "Lire" }).click();
  await expect(page.getByTestId("playlist-bar")).toContainText("1/2");
  await expect(page.getByTestId("radar")).toBeVisible();
  await page.screenshot({ path: "test-results/shots/playlist-replay.png" });
  await page.keyboard.press("N");
  await expect(page.getByTestId("playlist-bar")).toContainText("2/2");
  await page.getByTestId("playlist-bar").getByRole("link").click();
});

test("grenades : lineups, filtres, setpos et replay", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/grenades");
  await expect(page.getByTestId("nade-map")).toBeVisible();
  await expect(page.getByTestId("lineup-item").first()).toBeVisible();
  await page.getByRole("button", { name: /^Flash/ }).click();
  await page.getByRole("button", { name: /^Molotov/ }).click();
  await page.screenshot({ path: "test-results/shots/grenades.png" });
  await page.getByRole("group", { name: "Camp" }).getByRole("button", { name: "T", exact: true }).click();
  await expect(page).toHaveURL(/side=T/);
  await page.getByTestId("lineup-item").first().click();
  await expect(page.getByTestId("lineup-detail")).toBeVisible();
  await expect(page.getByTestId("setpos")).toContainText("setpos ");
  await page.screenshot({ path: "test-results/shots/grenade-detail.png" });
  await page.getByTestId("lineup-detail").getByRole("link").first().click();
  await expect(page).toHaveURL(/replay\/\d+\?t=\d+/);
  await expect(page.getByTestId("radar")).toBeVisible();
});

test("filtres par équipe : grenades et heatmaps", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/grenades?type=smoke,flash,he,molotov,incendiary,decoy&mode=throws");
  const count = page.getByTestId("grenade-count");
  await expect(count).not.toContainText("· 0 lancer(s)");
  const total = Number((await count.textContent())!.match(/(\d+) lancer\(s\)$/)![1]);
  await page.getByLabel("Équipe").selectOption({ label: "FaZe" });
  await expect(page).toHaveURL(/team=\d+/);
  const faze = Number((await count.textContent())!.match(/(\d+) lancer\(s\)$/)![1]);
  expect(faze).toBeGreaterThan(0);
  expect(faze).toBeLessThan(total);
  await page.getByLabel("Joueur").selectOption({ index: 1 });
  await expect(page).toHaveURL(/team=\d+.*player=|player=.*team=\d+/);
  await page.goto("/heatmaps");
  await expect(page.getByTestId("heat-count")).toContainText("23 round(s)");
  await page.getByLabel("Équipe").selectOption({ label: "FaZe" });
  await expect(page).toHaveURL(/team=\d+/);
  await page.getByLabel("Carte").selectOption({ label: "Nuke" });
  await expect(page).toHaveURL(/map=de_nuke/);
});

test("QA filtres : rounds", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/rounds");
  const total = page.locator(".lib-count");
  const rows = page.getByTestId("round-hit");
  await expect(rows).toHaveCount(23);
  await page.getByLabel("Équipe").selectOption({ label: "FaZe (1)" });
  await expect(rows).toHaveCount(23);
  await page.getByRole("group", { name: "Résultat" }).getByRole("button", { name: "Gagnés" }).click();
  await expect(total).toHaveText("10");
  await page.getByTestId("more-filters").click();
  await page.getByLabel("Adversaire").selectOption({ label: "3DMAX" });
  await expect(total).toHaveText("10");
  await page.getByRole("group", { name: "Résultat" }).getByRole("button", { name: "Tous" }).click();
  await page.getByRole("group", { name: "Camp" }).getByRole("button", { name: "T", exact: true }).click();
  await expect(total).toHaveText("11");
  await page.getByRole("group", { name: "Camp" }).getByRole("button", { name: "Tous" }).click();
  await page.getByRole("group", { name: "Mi-temps" }).getByRole("button", { name: "2e" }).click();
  await expect(total).toHaveText("11");
  await page.getByRole("group", { name: "Mi-temps" }).getByRole("button", { name: "Toutes" }).click();
  await page.getByRole("group", { name: "Achat", exact: true }).getByRole("button", { name: "Pistol" }).click();
  await expect(total).toHaveText("2");
  await page.getByRole("group", { name: "Achat", exact: true }).getByRole("button", { name: "Full" }).click();
  await expect.poll(async () => Number(await total.textContent())).toBeGreaterThan(2);
  await page.getByRole("group", { name: "Carte" }).getByRole("button", { name: "Dust II" }).click();
  await expect(total).toHaveText("0");
  await page.getByRole("button", { name: "Réinitialiser" }).click();
  await expect(rows).toHaveCount(23);
  await expect(page).toHaveURL(/\/rounds$/);
});

test("QA filtres : joueurs, match et scouting", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/players");
  const rows = page.getByTestId("player-row");
  await expect(rows).toHaveCount(10);
  const bar = page.getByTestId("context-bar");
  await bar.getByLabel("Carte", { exact: true }).selectOption("de_dust2");
  await expect(rows).toHaveCount(0);
  await bar.getByLabel("Carte", { exact: true }).selectOption("de_nuke");
  await expect(rows).toHaveCount(10);
  await bar.getByRole("radio", { name: "CT", exact: true }).click();
  await expect(page).toHaveURL(/map=de_nuke.*side=CT|side=CT.*map=de_nuke/);
  await page.getByPlaceholder("Rechercher un joueur ou une équipe…").fill("faze");
  await expect(rows).toHaveCount(5);
  await page.getByPlaceholder("Rechercher un joueur ou une équipe…").fill("");
  await bar.getByLabel("Rôle", { exact: true }).selectOption("entry");
  await expect(rows).toHaveCount(2);
  await bar.getByLabel("Notre achat").selectOption("vs_eco");
  await expect(page).toHaveURL(/econ=vs_eco/);
  await bar.getByLabel("Rôle", { exact: true }).selectOption("");
  await rows.first().getByRole("link").click();
  await page.getByRole("tab", { name: "Détails" }).click();
  await expect(page.getByTestId("economy")).toContainText("Pistols");
  await page.screenshot({ path: "test-results/shots/player-econ.png", fullPage: true });
  // match : chaque onglet s'affiche avec chaque camp
  await page.goto("/");
  await page.getByTestId("match-row").click();
  for (const tab of ["Joueurs", "Équipes"]) {
    await page.getByRole("tab", { name: tab }).click();
    for (const side of ["T", "CT", "Tous"]) {
      await page.getByRole("group", { name: "Camp" }).getByRole("button", { name: side, exact: true }).click();
      await expect(page.locator(".section").last()).not.toContainText("Chargement");
    }
  }
  await page.getByRole("tab", { name: "Duels" }).click();
  await expect(page.locator("td.duel")).toHaveCount(25);
  await page.getByRole("tab", { name: "Joueurs" }).click();
  await page.getByRole("group", { name: "Économie" }).getByRole("button", { name: "Pistol" }).click();
  await expect(page).toHaveURL(/econ=pistol/);
  await expect(page.getByTestId("stats-row")).toHaveCount(10);
  await page.getByRole("tab", { name: "Aperçu" }).click();
  await expect(page.getByTestId("round-cell")).toHaveCount(23);
  // scouting : 3DMAX
  await page.goto("/scouting");
  await page.getByTestId("scout-team").filter({ hasText: "3DMAX" }).click();
  // onglet Carte : fins du default (R3, seul default de la fixture), prise des sites ; pas de rotation CT sur Nuke
  // (sites A et B superposés : non mesurable)
  await page.getByTestId("ts-tab-carte").click();
  await expect(page.getByTestId("ts-default-kinds")).toContainText(/puis (exécution|prise) 1 \(1 gagné\)/);
  await expect(page.getByTestId("ts-engage")).toContainText(/prise du site [AB] vers \d:\d\d/);
  await expect(page.getByTestId("ts-styles")).toBeVisible();
  await expect(page.getByTestId("ts-ct-rotation")).toHaveCount(0);
  await openScoutData(page);
  await expect(page.getByTestId("scout-player")).toHaveCount(5);
  await page.getByTestId("ts-bar").getByRole("tab").first().click();
  await expect(page).toHaveURL(/map=de_nuke/);
  await expect(page.getByTestId("playbook")).toBeVisible();
  await expect(page.getByTestId("pb-group").first()).toBeVisible();
  const kinds = page.getByTestId("pb-default-kinds");
  await expect(kinds.getByTestId("pb-kind")).toHaveCount(1);
  await expect(kinds).toContainText(/puis (exécution|prise)/);
  await expect(kinds).toContainText("1/1");
  await expect(kinds.getByTestId("pb-kind-rounds")).toHaveAttribute("href", /tactic=t%3Adefault%3A%3A(exec|take)/);
  await expect(page.getByTestId("site-engage")).toContainText(/Site [AB]\s*\d+ prises?/);
  await expect(page.getByTestId("pb-ct-rotation")).toHaveCount(0);
  await page.getByTestId("playbook").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/shots/playbook.png" });
  await page.getByTestId("playbook").getByText("Détail des rounds T").click();
  await expect(page.getByTestId("playbook").getByRole("columnheader", { name: "Prise", exact: true })).toBeVisible();
  await expect(page.getByTestId("playbook").getByRole("columnheader", { name: "Rotation CT", exact: true })).toBeVisible();
  const r3 = page.getByTestId("pb-t-row").filter({ hasText: /^R3/ });
  await expect(r3.getByTestId("pb-engage")).toHaveText(/^\d+ s · [AB]$/);
  await expect(r3).toContainText(/Default\s*puis (exécution|prise)/);
  await expect(r3.getByTestId("pb-rotation")).toHaveText("—");
  await expect(r3.getByTestId("pb-rotation")).toHaveAttribute("title", "Non mesurable : les sites A et B sont trop proches sur cette carte");
  // contrat d'API : nouveaux champs sur chaque round T, sous-type seulement pour les defaults, prise avant la pose,
  // rotation non mesurable sur Nuke
  const dmax = (await (await page.request.get("/api/scouting/teams")).json()).find((t: { name: string }) => t.name === "3DMAX");
  const pb = await (await page.request.get(`/api/scouting/teams/${dmax.id}/playbook?map=de_nuke`)).json();
  expect(pb.t.list.every((x: Record<string, unknown>) => ["engage_s", "engage_site", "default_kind", "pressure_s", "ct_rotation_s", "rotation_measurable"].every((k) => k in x))).toBe(true);
  expect(pb.t.list.filter((x: { category: string }) => x.category !== "default").every((x: { default_kind: unknown }) => x.default_kind === null)).toBe(true);
  expect(pb.t.list.every((x: { rotation_measurable: unknown; ct_rotation_s: unknown }) => x.rotation_measurable === false && x.ct_rotation_s === null)).toBe(true);
  const row3 = pb.t.list.find((x: { number: number }) => x.number === 3);
  expect(row3.category).toBe("default");
  expect(["exec", "take"]).toContain(row3.default_kind);
  expect(row3.engage_s).toBeLessThanOrEqual(row3.plant_s);
  expect(pb.t.default_kinds.reduce((a: number, k: { n: number }) => a + k.n, 0)).toBe(1);
  expect(pb.t.categories.map((c: { key: string }) => c.key)).toEqual(["execute", "default", "eco"]);
  const brief = await (await page.request.get(`/api/scouting/teams/${dmax.id}/brief?map=de_nuke`)).json();
  expect(brief.ct_rotation).toBeNull();
  await page.getByTestId("pb-group").first().getByRole("button", { name: "Superposer" }).click();
  await expect(page).toHaveURL(/\/replay\/\d+/);
});

test("QA filtres : heatmaps et grenades", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/heatmaps");
  const info = page.getByTestId("heat-count");
  await expect(info).toContainText("23 round(s)");
  const all = await info.textContent();
  await page.getByLabel("Joueur").selectOption({ label: "rain" });
  await expect(page).toHaveURL(/player=/);
  await expect(info).not.toHaveText(all!);
  await page.getByLabel("Joueur").selectOption({ label: "Tous" });
  await page.getByRole("group", { name: "Achat" }).getByRole("button", { name: "Pistol" }).click();
  await expect(info).toContainText("2 round(s)");
  await page.getByRole("group", { name: "Achat" }).getByRole("button", { name: "Tous" }).click();
  await page.getByRole("group", { name: "Moment du round" }).getByRole("button", { name: "1:35 – 1:15" }).click();
  await expect(page).toHaveURL(/win=20-40/);
  await page.getByRole("group", { name: "Données" }).getByRole("button", { name: "Kills" }).click();
  await page.getByRole("group", { name: "Camp" }).getByRole("button", { name: "T", exact: true }).click();
  await expect(info).toContainText("événement");
  await expect(page.locator(".gr-occ b.gr-ct")).toHaveCount(0);
  await page.getByRole("group", { name: "Niveau" }).getByRole("button", { name: "Bas" }).click();
  await expect(page.getByTestId("heatmap")).toBeVisible();
  // grenades : type, camp, joueur, affichage
  await page.goto("/grenades");
  const count = page.getByTestId("grenade-count");
  await expect(count).not.toContainText("· 0 lancer(s)");
  const smokes = await count.textContent();
  await page.getByRole("button", { name: /^HE/ }).click();
  await expect(count).not.toHaveText(smokes!);
  await page.getByRole("group", { name: "Camp" }).getByRole("button", { name: "CT", exact: true }).click();
  await page.getByLabel("Joueur").selectOption({ index: 1 });
  await expect(page).toHaveURL(/player=/);
  await page.getByRole("group", { name: "Affichage" }).getByRole("button", { name: "Tous les lancers" }).click();
  await expect(page).toHaveURL(/mode=throws/);
  await page.getByLabel("Carte").selectOption({ label: "Dust II" });
  await expect(page.getByText("Aucune grenade")).toBeVisible();
});

test("replay : superposition multi-rounds", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  // la fixture réduite a les positions des rounds 2 et 3 : on superpose le 3 au 2
  await page.goto("/");
  await page.getByTestId("match-row").click();
  await page.getByTestId("round-cell").nth(1).click();
  await expect(page.getByTestId("radar")).toBeVisible();
  await page.getByTestId("layers-toggle").click();
  // filtres d'une équipe : achat full, les deux camps -> superpose tous les rounds correspondants d'un coup
  await page.getByTestId("layer-buys").getByRole("button", { name: "Full" }).click();
  await page.getByRole("button", { name: "Les deux" }).click();
  await expect(page.getByTestId("layers-apply")).toContainText(/Superposer ces \d+ round/);
  await page.getByTestId("layers-apply").click();
  await expect(page).toHaveURL(/layers=\d+/);
  await page.getByRole("dialog", { name: "Rounds superposés" }).getByRole("button", { name: "Aucun" }).click();
  await expect(page).not.toHaveURL(/layers=/);
  await page.getByTestId("layer-buys").getByRole("button", { name: "Tous" }).click();
  await page.getByTestId("layer-round").filter({ hasText: /^3\D*$/ }).click();
  await expect(page).toHaveURL(/layers=\d+/);
  await expect(page.getByTestId("layers-legend")).toContainText("3");
  await page.keyboard.press("Escape");
  await page.mouse.click(5, 500);
  await page.screenshot({ path: "test-results/shots/layers.png" });
  // la superposition suit la navigation entre rounds
  await page.keyboard.press("N");
  await expect(page).toHaveURL(/replay\/3\?layers=/);
  // depuis la page Rounds
  await page.goto("/rounds");
  await page.getByTestId("round-hit").nth(1).getByRole("checkbox").check();
  await page.getByTestId("round-hit").nth(2).getByRole("checkbox").check();
  await page.getByTestId("overlay-selection").click();
  await expect(page).toHaveURL(/replay\/2\?layers=\d+/);
  await expect(page.getByTestId("layers-legend")).toBeVisible();
});

test("veto : simulation BO3 et BO1", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/scouting");
  await page.getByTestId("scout-team").filter({ hasText: "FaZe" }).click();
  await page.getByRole("link", { name: "Préparer le veto" }).click();
  // pool actuel (juillet 2026) : Ancient, Anubis, Cache, Dust II, Inferno, Mirage, Nuke
  await expect(page.getByTestId("veto-map")).toHaveCount(7);
  await expect(page.getByRole("group", { name: "Pool" })).not.toContainText("Train");
  await expect(page.getByRole("group", { name: "Pool" })).toContainText("Cache");
  await expect(page.getByLabel("Adversaire")).toHaveValue(/\d+/);
  // un ban manuel puis simulation automatique : BO3 = 2 cartes choisies + décisive
  await page.getByTestId("veto-map").filter({ hasText: "Anubis" }).click();
  await page.getByTestId("veto-auto").click();
  await expect(page.getByTestId("veto-log").locator("li")).toHaveCount(7);
  await expect(page.getByTestId("veto-log").locator("li.decider")).toHaveCount(1);
  await expect(page.getByTestId("veto-result")).toBeVisible();
  await page.screenshot({ path: "test-results/shots/veto.png", fullPage: true });
  await page.getByRole("group", { name: "Format" }).getByRole("button", { name: "BO1" }).click();
  await page.getByTestId("veto-auto").click();
  await expect(page.getByTestId("veto-log").locator("li")).toHaveCount(7);
  await expect(page.getByTestId("veto-log").locator("li.decider")).toHaveCount(1);
});

function silentWav(seconds: number, rate = 8000): Buffer {
  const n = seconds * rate, b = Buffer.alloc(44 + n);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n, 4); b.write("WAVE", 8); b.write("fmt ", 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write("data", 36); b.writeUInt32LE(n, 40);
  b.fill(128, 44);
  return b;
}

test("replay : comms vocales synchronisées", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await page.getByTestId("match-row").click();
  await page.getByTestId("round-cell").nth(1).click();
  await expect(page.getByTestId("radar")).toBeVisible();
  await page.getByTestId("comms-toggle").click();
  await page.getByLabel("Nom de la piste").fill("FaZe");
  await page.getByTestId("comms-file").setInputFiles({ name: "comms.wav", mimeType: "audio/wav", buffer: silentWav(600) });
  await expect(page.getByTestId("comms-track")).toContainText("FaZe", { timeout: 20_000 });
  await page.getByRole("button", { name: "+1 s" }).click();
  await expect(page.getByTestId("comms-track")).toContainText("0:01.0");
  await page.screenshot({ path: "test-results/shots/comms.png" });
  await page.keyboard.press("Escape");
  await page.mouse.click(700, 500);
  const pos = () => page.evaluate(() => document.querySelector("audio")!.currentTime);
  await expect.poll(pos).toBeGreaterThan(1);
  const before = await pos();
  await page.keyboard.press("ArrowRight");  // +5 s dans le replay
  await expect.poll(async () => (await pos()) - before).toBeGreaterThan(4.5);
  expect((await pos()) - before).toBeLessThan(5.5);
});

test("replay : raccourcis personnalisables", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await page.getByTestId("match-row").click();
  await page.getByTestId("round-cell").nth(1).click();
  await expect(page.getByTestId("radar")).toBeVisible();
  await page.getByTestId("shortcuts-open").click();
  await expect(page.getByTestId("shortcut-row")).toHaveCount(29);
  await page.getByRole("button", { name: "Modifier le raccourci : Lecture / pause" }).click();
  await page.keyboard.press("k");
  await expect(page.getByRole("button", { name: "Modifier le raccourci : Lecture / pause" })).toHaveText("K");
  await page.screenshot({ path: "test-results/shots/shortcuts.png" });
  await page.getByRole("button", { name: "Terminé" }).click();
  const clock = page.getByTestId("round-clock");
  const before = await clock.textContent();
  await page.keyboard.press(" ");  // l'ancienne touche ne fait plus rien
  await page.waitForTimeout(800);
  expect(await clock.textContent()).toBe(before);
  await page.keyboard.press("k");
  await page.waitForTimeout(1200);
  await page.keyboard.press("k");
  expect(await clock.textContent()).not.toBe(before);
  // persistance après rechargement, puis remise par défaut
  await page.reload();
  await page.getByTestId("shortcuts-open").click();
  await expect(page.getByRole("button", { name: "Modifier le raccourci : Lecture / pause" })).toHaveText("K");
  await page.getByRole("button", { name: "Rétablir les touches par défaut" }).click();
  await expect(page.getByRole("button", { name: "Modifier le raccourci : Lecture / pause" })).toHaveText("Espace");
});

test("bibliothèque : dossiers, événements, étiquettes et période", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await page.getByRole("button", { name: "Organiser" }).first().click();
  const d = page.getByTestId("labels-dialog");
  await d.getByLabel("Dossier").selectOption("__new");
  await d.getByLabel("Nouveau dossier").fill("Scrims");
  await d.getByLabel("Événement").fill("Major Paris");
  await d.getByLabel(/Étiquettes/).fill("anti-eco, retake B");
  await d.getByLabel("Date du match").fill("2026-09-01");
  await d.getByRole("button", { name: "Enregistrer" }).click();
  await expect(page.getByTestId("match-row")).toContainText("Scrims");
  await expect(page.getByTestId("match-row")).toContainText("#retake B");
  await page.screenshot({ path: "test-results/shots/library-labels.png" });
  const rows = page.getByTestId("match-row");
  await page.getByTestId("lib-folder").selectOption({ label: "Scrims (1)" });
  await expect(rows).toHaveCount(1);
  await page.getByLabel("Du", { exact: true }).fill("2026-10-01");
  await expect(rows).toHaveCount(0);
  await page.getByRole("button", { name: "Effacer" }).click();
  await expect(rows).toHaveCount(1);
  await page.goto("/rounds");
  await page.getByTestId("more-filters").click();
  await page.getByLabel("Événement").selectOption({ label: "Major Paris (1)" });
  await expect(page.getByTestId("round-hit")).toHaveCount(23);
  await page.getByLabel("Du", { exact: true }).fill("2026-10-01");
  await expect(page.getByTestId("round-hit")).toHaveCount(0);
  await page.goto("/players?tag=anti-eco");
  await expect(page.getByTestId("player-row")).toHaveCount(10);
  await page.goto("/players?date_to=2026-08-01");
  await expect(page.getByTestId("player-row")).toHaveCount(0);
});

test("tableau de bord : joueur suivi, tendance, cartes, armes", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/dashboard");
  await expect(page.getByText("Choisissez votre joueur")).toBeVisible();
  await page.getByLabel("Joueur suivi").selectOption({ label: "rain · FaZe" });
  await expect(page.getByRole("heading", { name: "rain" })).toBeVisible();
  await expect(page.getByTestId("dash-trend")).toBeVisible();
  await expect(page.getByText("Points forts")).toBeVisible();
  await page.locator(".dash-dot").first().hover();
  await expect(page.locator(".dash-tip")).toContainText("vs 3DMAX");
  await page.screenshot({ path: "test-results/shots/dashboard.png", fullPage: true });
  await page.reload();
  await expect(page.getByRole("heading", { name: "rain" })).toBeVisible();
});

test("heatmaps et grenades : choix de la démo", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/heatmaps");
  await expect(page.getByTestId("heat-count")).toContainText("23 round(s)");
  await page.getByLabel("Démo").selectOption({ index: 1 });
  await expect(page).toHaveURL(/match=\d+/);
  await expect(page.getByTestId("heat-count")).toContainText("23 round(s)");
  await expect(page.getByLabel("Joueur").locator("option")).toHaveCount(11);
  await page.getByLabel("Joueur").selectOption({ label: "rain" });
  await expect(page).toHaveURL(/player=/);
  await page.goto("/grenades?type=smoke,flash,he,molotov,incendiary,decoy");
  const count = page.getByTestId("grenade-count");
  await expect(count).not.toContainText("· 0 lancer(s)");
  const before = await count.textContent();
  await page.getByLabel("Démo").selectOption({ index: 1 });
  await expect(page).toHaveURL(/match=\d+/);
  await expect(count).toHaveText(before!);  // une seule démo dans la base de test : mêmes lancers
});

test("replay : masquer et réafficher la barre de dessin", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await page.getByTestId("match-row").click();
  await page.getByTestId("round-cell").nth(1).click();
  await expect(page.getByTestId("draw-show")).toBeVisible();  // repliée par défaut
  await page.getByTestId("draw-show").click();
  await expect(page.getByTestId("draw-toolbar")).toBeVisible();
  await page.reload();  // mémorisé
  await expect(page.getByTestId("draw-toolbar")).toBeVisible();
  await page.getByTestId("draw-hide").click();
  await expect(page.getByTestId("draw-toolbar")).toHaveCount(0);
  await expect(page.getByTestId("draw-show")).toBeVisible();
  await page.keyboard.press("b");
  await expect(page.getByTestId("draw-toolbar")).toBeVisible();
});

test("rounds : préfiltres en un clic et arme", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/rounds");
  const total = page.locator(".lib-count");
  await expect(page.getByTestId("round-hit")).toHaveCount(23);
  const pre = page.getByRole("group", { name: "Préfiltres" });
  await pre.getByRole("button", { name: "2e rounds" }).click();
  await expect(total).toHaveText("2");
  await pre.getByRole("button", { name: "2e rounds" }).click();
  await pre.getByRole("button", { name: "Pistols" }).click();
  await expect(total).toHaveText("2");
  await expect(page).toHaveURL(/pistol=true/);
  await pre.getByRole("button", { name: "Pistols" }).click();
  await page.getByLabel("Équipe").selectOption({ label: "FaZe (1)" });
  await pre.getByRole("button", { name: "Ouverture gagnée" }).click();
  await expect(total).toHaveText("10");
  await pre.getByRole("button", { name: "Ouverture gagnée" }).click();
  await page.getByTestId("more-filters").click();
  await page.getByLabel("Arme").selectOption("awp");
  await expect(page).toHaveURL(/weapon=awp/);
  await expect.poll(async () => Number(await total.textContent())).toBeLessThan(23);
  await page.screenshot({ path: "test-results/shots/rounds-quick.png" });
  await page.goto("/heatmaps?kind=kills");
  await page.getByLabel("Arme").selectOption("awp");
  await expect(page.getByTestId("heat-count")).toContainText("événement");
  await expect(page.locator(".gr-occ li").first()).toContainText("awp");
});

test("replay : taille des pastilles, morts et plein écran", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/matches/1/replay/2?t=6500");
  await expect(page.getByTestId("radar")).toBeVisible();
  await page.getByLabel("Taille des pastilles").fill("1.6");
  await page.getByRole("checkbox", { name: "Morts" }).uncheck();
  await page.waitForTimeout(300);
  await page.locator(".rp-radar").screenshot({ path: "test-results/shots/replay-big-dots.png" });
  await page.getByRole("checkbox", { name: "Morts" }).check();
  await page.getByTestId("fullscreen").click();
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
  await page.keyboard.press("f");
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);
});

test("commentaires : personnel et dessin joint", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/matches/1/replay/3");
  const radar = page.getByTestId("radar");
  await expect(radar).toBeVisible();
  const box = (await radar.boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  if (await page.getByTestId("draw-show").count()) await page.getByTestId("draw-show").click();  // barre de dessin repliée par défaut
  await page.getByRole("button", { name: "Flèche" }).click();
  await page.mouse.move(cx - 100, cy); await page.mouse.down(); await page.mouse.move(cx, cy - 50, { steps: 4 }); await page.mouse.up();
  await page.keyboard.press("Escape");
  await page.getByTestId("toggle-comments").click();
  await page.getByLabel("Nouveau commentaire").fill("rotation trop tardive");
  await page.getByRole("checkbox", { name: /Joindre le dessin/ }).check();
  await page.getByRole("checkbox", { name: "Personnel" }).check();
  await page.getByRole("button", { name: "Publier" }).click();
  const item = page.getByTestId("comment").filter({ hasText: "rotation trop tardive" });
  await expect(item).toContainText("perso");
  await expect(item).toContainText("dessin");
  await page.getByRole("button", { name: "Tout effacer" }).click();
  await item.locator(".cm-time").click();
  await expect(page.getByTestId("comment-drawing")).toBeVisible();
  await page.screenshot({ path: "test-results/shots/comment-drawing.png" });
  await page.getByRole("button", { name: "Masquer le dessin du commentaire" }).click();
  await expect(page.getByTestId("comment-drawing")).toHaveCount(0);
});

test("exports de config CS2 : lineup, pack et positions", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/grenades");
  await page.getByTestId("lineup-item").first().click();
  const [one] = await Promise.all([page.waitForEvent("download"), page.getByTestId("cfg-lineup").click()]);
  const lineup = await (await one.createReadStream()).toArray().then((c) => Buffer.concat(c).toString());
  expect(one.suggestedFilename()).toMatch(/^lineup_de_nuke_\w+\.cfg$/);
  expect(lineup).toContain("setpos ");
  await page.getByRole("button", { name: "Fermer" }).click();
  const [pack] = await Promise.all([page.waitForEvent("download"), page.getByTestId("cfg-pack").click()]);
  expect((await (await pack.createReadStream()).toArray().then((c) => Buffer.concat(c).toString()))).toContain("alias lineup_1");
  await page.goto("/matches/1/replay/2?t=6000");
  await expect(page.getByTestId("radar")).toBeVisible();
  const [pos] = await Promise.all([page.waitForEvent("download"), page.getByTestId("cfg-positions").click()]);
  const text = await (await pos.createReadStream()).toArray().then((c) => Buffer.concat(c).toString());
  expect(pos.suggestedFilename()).toMatch(/^positions_de_nuke_r2_\d+s\.cfg$/);
  expect(text).toContain("alias pos_rain");
});

test("replay : grenades du round, lineup et pack .cfg", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/matches/1/replay/2");
  await expect(page.getByTestId("radar")).toBeVisible();
  // round 2 de la démo de test : 1 smoke, 1 flash, 2 HE, 2 incendiaires (leurres masqués)
  await expect(page.getByTestId("toggle-nades")).toContainText("6");
  await page.getByTestId("toggle-nades").click();
  const panel = page.getByTestId("round-nades");
  await expect(panel.getByTestId("round-nade")).toHaveCount(6);
  for (const k of ["Smoke", "Flash", "HE"]) await panel.getByRole("button", { name: k, exact: true }).click();
  await expect(panel.getByTestId("round-nade")).toHaveCount(2);
  await expect(panel.getByTestId("round-nade").first()).toContainText("Incendiaire");
  await panel.getByTestId("round-nade").first().click();
  await expect(panel.getByTestId("round-nade-detail")).toBeVisible();
  await expect(panel.getByTestId("round-nade-setpos")).toContainText("setpos ");
  const [pack] = await Promise.all([page.waitForEvent("download"), panel.getByTestId("round-nades-pack").click()]);
  expect(pack.suggestedFilename()).toBe("lineups_de_nuke_r2.cfg");
  const text = await (await pack.createReadStream()).toArray().then((c) => Buffer.concat(c).toString());
  expect(text).toContain("alias lineup_2");
  expect(text).not.toContain("alias lineup_3");
  // un seul tiroir à la fois : les commentaires remplacent le panneau des grenades
  await page.getByTestId("toggle-comments").click();
  await expect(panel).toBeHidden();
});

test("stratbook : création depuis le replay, édition, lineup, config", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/matches/1/replay/3?t=5200");
  const radar = page.getByTestId("radar");
  await expect(radar).toBeVisible();
  const box = (await radar.boundingBox())!;
  if (await page.getByTestId("draw-show").count()) await page.getByTestId("draw-show").click();  // barre de dessin repliée par défaut
  await page.getByRole("button", { name: "Flèche" }).click();
  await page.mouse.move(box.x + box.width / 2 - 80, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 60, { steps: 4 }); await page.mouse.up();
  await page.keyboard.press("Escape");
  await page.getByTestId("add-to-stratbook").click();
  const dlg = page.getByTestId("add-strat");
  await dlg.getByLabel("Nom de la stratégie").fill("Split B test");
  await dlg.getByRole("group", { name: "Camp de la stratégie" }).getByRole("button", { name: "T", exact: true }).click();
  await dlg.getByRole("button", { name: "Créer la stratégie" }).click();
  await expect(page).toHaveURL(/\/stratbook\?map=de_nuke&s=\d+$/);
  await expect(page.getByRole("heading", { name: "Split B test" })).toBeVisible();
  await expect(page.getByTestId("strat-map")).toBeVisible();
  await expect.poll(() => page.getByTestId("strat-position").count()).toBeGreaterThan(0);
  await page.getByTestId("strat-menu").click();
  await page.getByRole("menuitem", { name: "Modifier" }).click();
  await page.getByRole("textbox", { name: /^Plan/ }).fill("Smoke CT, flash pop, entrée à 3.");
  await page.getByRole("button", { name: "Enregistrer" }).click();
  await expect(page.locator(".sb-desc")).toContainText("flash pop");
  await page.screenshot({ path: "test-results/shots/strat.png", fullPage: true });
  const [cfg] = await Promise.all([page.waitForEvent("download"), page.getByTestId("strat-cfg").click()]);
  expect(await (await cfg.createReadStream()).toArray().then((c) => Buffer.concat(c).toString())).toContain("alias pos_");
  const before = await page.getByTestId("strat-grenades").locator("li").count();
  // lineup depuis la page Grenades vers cette stratégie (T, Nuke)
  await page.goto("/grenades?side=T&type=smoke,flash,he,molotov,incendiary");
  await page.getByTestId("lineup-item").first().click();
  await page.getByTestId("lineup-to-strat").click();
  await page.getByRole("menuitem", { name: /Split B test/ }).click();
  await expect(page.getByText("Ajouté à « Split B test »")).toBeVisible();
  await page.goto("/stratbook?map=de_nuke");
  await expect(page.getByTestId("strat-row")).toHaveCount(1);
  await page.getByTestId("strat-row").click();
  await page.getByTestId("sb-tab-grenades").click();
  await expect(page.getByTestId("strat-grenades").locator("li")).toHaveCount(before + 1);
});

test("analyse : probabilité de victoire, raisons de mort, visée et rapport", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/matches/1?tab=analysis");
  await expect(page.getByTestId("analysis")).toBeVisible();
  await expect(page.getByTestId("impact-row")).toHaveCount(10);
  await expect(page.getByTestId("aim-table").locator("tbody tr")).toHaveCount(10);
  await expect(page.getByTestId("winprob-chart")).toBeVisible();
  await page.getByTestId("winprob-round").selectOption("3");
  await expect(page.getByTestId("winprob-chart")).toHaveAttribute("data-testid", "winprob-chart");
  const all = await page.getByTestId("death-list").locator("li").count();
  expect(all).toBeGreaterThan(10);
  await page.getByTestId("only-avoidable").check();
  await expect.poll(() => page.getByTestId("death-list").locator("li").count()).toBeLessThan(all);
  await page.getByTestId("only-avoidable").uncheck();
  await page.getByRole("button", { name: "Pris de côté" }).click();
  await expect.poll(() => page.getByTestId("death-list").locator("li").count()).toBeGreaterThan(0);
  await expect(page.getByTestId("death-list").locator("li").first()).toContainText("Pris de côté ·");
  await page.getByRole("button", { name: "Pris de côté" }).click();
  await expect(page.getByTestId("lost-advantages")).toBeVisible();
  await expect(page.getByTestId("econ-audit")).toHaveCount(2);
  await expect(page.getByTestId("econ-audit").first()).toContainText("Gardées en vie");
  await page.screenshot({ path: "test-results/shots/analysis.png", fullPage: true });
  // replay : bande de probabilité sous la frise
  await page.goto("/matches/1/replay/2");
  await expect(page.getByTestId("winprob-band")).toBeVisible();
  await expect(page.getByTestId("winprob-now")).toContainText("%");
  // rapport imprimable
  await page.goto("/matches/1");
  await page.getByTestId("report-link").click();
  await expect(page.getByTestId("match-report")).toBeVisible();
  await expect(page.locator(".report-summary li").first()).toContainText(" bat ");
  await expect(page.getByTestId("impact-row")).toHaveCount(10);
  await page.screenshot({ path: "test-results/shots/report.png", fullPage: true });
  // fiche joueur : impact, erreurs, visée
  await page.getByTestId("impact-row").first().getByRole("link").click();
  await page.getByRole("tab", { name: "Détails" }).click();
  await expect(page.getByTestId("player-advanced")).toContainText("Impact / round");
  await expect(page.getByTestId("player-advanced")).toContainText("Temps pour tuer");
});

test("revue perso : dernier match du tableau de bord → mes morts", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/dashboard");
  const pick = page.getByLabel("Joueur suivi");
  await pick.selectOption({ index: 1 });
  const name = (await pick.locator("option:checked").textContent())!.split(" · ")[0];
  await expect(page.getByTestId("dash-last")).toContainText("Morts évitables");
  await page.getByTestId("review-my-deaths").click();
  await expect(page).toHaveURL(/tab=analysis&player=\d+/);
  await expect(page.getByTestId("deaths-player")).toHaveValue(/\d+/);
  const rows = page.getByTestId("death-list").locator("li");
  await expect.poll(() => rows.count()).toBeGreaterThan(0);
  for (const t of await rows.locator(".an-desc b").allTextContents()) expect(t).toBe(name);
  await page.getByTestId("deaths-player").selectOption("");
  await expect.poll(() => rows.count()).toBeGreaterThan(30);
  await page.getByRole("navigation", { name: "Sections de l'analyse" }).getByRole("button", { name: "Visée" }).click();
  await expect(page.getByTestId("aim-table")).toBeInViewport();
});

test("revue perso : aperçu « En bref », morts suivantes dans le replay, mode joueur", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/dashboard");
  await page.getByLabel("Joueur suivi").selectOption({ index: 1 });
  await page.goto("/matches/1");
  await expect(page.getByTestId("brief")).toContainText(" bat ");
  await expect(page.getByTestId("brief-mine").locator("li")).toHaveCount(3);
  await page.goto("/matches/1/replay/1");
  const nav = page.getByTestId("death-nav");
  await expect(nav).toBeVisible();
  await page.getByTestId("next-death").click();
  await expect(nav).toContainText(/ 1\/\d+/);
  await page.keyboard.press("k");
  await expect(nav).toContainText(/ 2\/\d+/);
  await page.keyboard.press("j");
  await expect(nav).toContainText(/ 1\/\d+/);
  // mode joueur : outils d'analyse rangés dans « Plus »
  await expect(page.getByTestId("add-to-stratbook")).toBeVisible();
  await page.getByTestId("mode-toggle").click();
  await expect(page.getByTestId("add-to-stratbook")).toHaveCount(0);
  await expect(page.getByLabel("Traces")).toHaveCount(0);
  await page.getByTestId("more-tools").click();
  await expect(page.getByTestId("add-to-stratbook")).toBeVisible();
  await page.screenshot({ path: "test-results/shots/replay-player-mode.png" });
  await page.reload();
  await expect(page.getByTestId("mode-toggle")).toHaveText("Mode analyste");  // mémorisé
  await page.getByTestId("mode-toggle").click();
});

test("callouts : renommer un lieu de la carte", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/callouts?map=de_nuke&view=places");
  await expect.poll(() => page.getByTestId("callout-row").count()).toBeGreaterThan(5);
  const input = page.getByLabel("Nom d'équipe pour Outside");
  await input.fill("Dehors");
  await input.press("Enter");
  await expect(page.getByText("Enregistré")).toBeVisible();
  await expect(page.locator(".co-pin.custom text", { hasText: "Dehors" })).toHaveCount(1);
  await page.goto("/matches/1?tab=analysis");
  await expect(page.getByTestId("death-list")).toContainText("Dehors");
  await page.goto("/callouts?map=de_nuke&view=places");
  await page.getByLabel("Nom d'équipe pour Outside").fill("");
  await page.getByLabel("Nom d'équipe pour Outside").press("Enter");
  await expect(page.locator(".co-pin.custom")).toHaveCount(0);
});

test("moments forts : filtres et ajout à une playlist", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/highlights");
  await expect.poll(() => page.getByTestId("highlight-list").locator("li").count()).toBeGreaterThan(3);
  await page.getByRole("group", { name: "Type de moment" }).getByRole("button", { name: "3 kills" }).click();
  await expect(page).toHaveURL(/type=3k/);
  const badges = page.getByTestId("highlight-list").locator(".hl-badge");
  await expect.poll(() => badges.count()).toBeGreaterThan(0);
  expect(new Set(await badges.allTextContents())).toEqual(new Set(["3 kills"]));
  await page.getByLabel("Tout sélectionner").check();
  await page.getByRole("button", { name: "Ajouter à une playlist" }).click();
  await page.getByLabel("Nom de la nouvelle playlist").fill("Multi-kills e2e");
  await page.getByRole("button", { name: "Créer" }).click();
  await expect(page.locator(".hl-notice")).toContainText("Multi-kills e2e");
  await page.getByTestId("highlight-list").locator("li").first().getByRole("link").click();
  await expect(page).toHaveURL(/replay\/\d+\?t=\d+/);
  await expect(page.getByTestId("radar")).toBeVisible();
});

test("classements et comparaison de joueurs", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/leaderboards?min=1");
  // tableau principal (comme le classement PRO d'EDGE) : tri, colonnes, épinglage, top N
  await expect(page.getByTestId("lb-row")).toHaveCount(10);
  await expect(page.getByTestId("lb-table").locator("thead")).toContainText("FAR");
  await page.getByTestId("lb-table").getByRole("button", { name: /^ADR/ }).click();
  await expect(page).toHaveURL(/order_by=adr/);
  const firstAdr = await page.getByTestId("lb-row").first().locator("td").nth(3).textContent();
  expect(Number(firstAdr)).toBeGreaterThan(90);
  await page.getByTestId("lb-add-column").click();
  await page.getByRole("menuitem", { name: /^HS/ }).click();
  await expect(page.getByTestId("lb-table").locator("thead")).toContainText("HS");
  await page.getByLabel("Nombre de joueurs").selectOption("10");
  await page.getByRole("button", { name: /^Épingler karrigan/ }).click();
  await page.getByLabel("Nombre de joueurs").selectOption("10");
  await expect(page.getByTestId("lb-row").filter({ hasText: "karrigan" })).toHaveCount(1);
  await page.getByRole("tab", { name: "Par statistique" }).click();
  await expect(page.getByTestId("board-rating").locator("li")).toHaveCount(5);
  await expect(page.getByTestId("board-ttk").locator("li")).toHaveCount(5);
  await page.getByTestId("board-impact").getByRole("button", { name: "Tout voir" }).click();
  await expect(page.getByTestId("board-impact").locator("li")).toHaveCount(10);
  await page.screenshot({ path: "test-results/shots/leaderboards.png", fullPage: true });
  await page.getByRole("tab", { name: "Comparer deux joueurs" }).click();
  await expect.poll(() => page.getByTestId("cmp-row").count()).toBeGreaterThan(10);
  const b = page.getByTestId("cmp-b");
  const second = await b.locator("option").nth(4).getAttribute("value");
  await b.selectOption(second!);
  await expect(page).toHaveURL(new RegExp(`b=${second}`));
});

test("calendrier : événement et démo rattachée automatiquement", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  // horloge figée au matin du jour de la démo de test : l'événement proposé par défaut (ce jour-là à 20 h) reste
  // « à venir » et à un jour près de la démo, quelle que soit l'heure du lancement (passé 20 h, il serait déjà commencé)
  const [y, m, d] = ((await (await page.request.get("/api/matches/1")).json()).date as string).split("-").map(Number);
  await page.clock.setFixedTime(new Date(y, m - 1, d, 10));
  await page.goto("/calendar");
  await page.getByTestId("new-event").click();
  const dlg = page.getByTestId("event-dialog");
  await dlg.getByLabel("Titre").fill("Scrim e2e");
  await dlg.getByTestId("event-opponent").fill("faze");
  await dlg.getByRole("button", { name: "Enregistrer" }).click();
  await expect(dlg).toHaveCount(0);
  const ev = page.locator(".cal-ev", { hasText: "Scrim e2e" });
  await expect(ev).toHaveCount(1);
  await expect(page.locator(".cal-up")).toContainText("Scrim e2e");
  await ev.click();
  await expect(page.getByTestId("event-dialog")).toContainText("automatique");
  await page.getByTestId("event-dialog").getByRole("button", { name: "Supprimer" }).click();
  await expect(page.locator(".cal-ev", { hasText: "Scrim e2e" })).toHaveCount(0);
  // un simple clic sur un jour ouvre la création à cette date
  await page.locator('[data-testid=cal-day]').nth(16).click({ position: { x: 60, y: 70 } });
  const day = await page.locator('[data-testid=cal-day]').nth(16).getAttribute("data-date");
  await expect(page.getByTestId("event-dialog").getByLabel("Date")).toHaveValue(day!);
});

test("calendrier : match FACEIT avec ses cartes probables", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const at = new Date();
  at.setHours(20, 30, 0, 0);
  const ev = { id: 900, title: "ESEA vs. mskLANERS", kind: "match", opponent: "mskLANERS", maps: [], starts_at: at.toISOString(),
    notes: "S59 EU Main B - Regular Season\nBO1", source: "faceit", matches: [],
    likely_maps: { them: 4, us: 22, few: true, maps: [
      { map: "de_dust2", name: "Dust II", pct: 36, played: 2, won: 2 }, { map: "de_mirage", name: "Mirage", pct: 24, played: 1, won: 0 },
      { map: "de_nuke", name: "Nuke", pct: 12, played: 0, won: 0 }, { map: "de_anubis", name: "Anubis", pct: 2, played: 0, won: 0 }] } };
  await page.route(/\/api\/calendar(\?|$)/, (r) => r.fulfill({ json: [ev] }));
  await page.goto("/calendar");
  await page.locator(".cal-ev", { hasText: "ESEA vs. mskLANERS" }).first().click();
  const odds = page.getByTestId("event-odds");
  await expect(odds).toContainText("Dust II");
  await expect(odds).toContainText("36 %");
  await expect(odds).toContainText("eux 2/2");
  await expect(odds).toContainText("jamais jouée par eux");
  await expect(odds).not.toContainText("Anubis"); // sous 3 % : pas affichée
  await expect(odds).toContainText("leurs 4 matchs ESEA et nos 22");
  await expect(page.getByTestId("event-synced")).toContainText("Venu de FACEIT");
  await page.getByTestId("event-dialog").screenshot({ path: "test-results/calendar-odds.png" });
});

test("revue de groupe : le participant suit le meneur", async ({ page, context }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/matches/1/replay/2");
  await page.getByTestId("live-button").click();
  const link = await page.getByTestId("live-link").inputValue();
  expect(link).toMatch(/\?live=[A-Z0-9]{6}$/);
  const follower = await context.newPage();
  await follower.goto(link.replace("/replay/2", "/replay/5"));
  await expect(follower).toHaveURL(/replay\/2\?live=/);  // ramené sur le round du meneur
  await expect(follower.getByTestId("live-banner")).toContainText("Vous suivez");
  await expect(page.getByTestId("live-button")).toContainText("En direct · 1");
  await page.keyboard.press("Escape");
  await page.getByTestId("radar").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("N");
  await expect(follower).toHaveURL(/replay\/3\?live=/);
  await page.getByTestId("live-button").click();
  await page.getByTestId("live-end").click();
  await expect(follower.getByTestId("live-banner")).toContainText("terminée");
  await follower.close();
});

test("stratbook : créer une stratégie sur une carte et la dessiner", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/stratbook");
  await page.getByTestId("new-strat").click();
  const dlg = page.getByTestId("new-strat-dialog");
  await dlg.getByLabel("Nom").fill("Contrôle mid Mirage");
  await dlg.getByRole("group", { name: "Carte de la stratégie" }).getByRole("button", { name: "Mirage" }).click();
  await dlg.getByRole("group", { name: "Camp de la stratégie" }).getByRole("button", { name: "CT", exact: true }).click();
  await dlg.getByRole("button", { name: "Créer et dessiner" }).click();
  await expect(page).toHaveURL(/\/stratbook\?map=de_mirage&s=\d+&board=1$/);
  // le tableau de la stratégie affichée avant reste à l'écran le temps de charger la nouvelle : attendre celui de la nouvelle
  const board = page.getByTestId("strat-board").getByRole("img", { name: "Radar de la stratégie Contrôle mid Mirage" });
  await expect(board).toBeVisible();
  const box = (await board.boundingBox())!;
  const at = (fx: number, fy: number) => [box.x + box.width * fx, box.y + box.height * fy] as const;
  const drag = async (a: readonly [number, number], b: readonly [number, number]) => {
    await page.mouse.move(...a); await page.mouse.down(); await page.mouse.move(...b, { steps: 5 }); await page.mouse.up();
  };
  // 2 joueurs (le second avec une direction), une smoke, une flèche, un texte
  await page.getByTestId("board-player").click();
  await drag(at(0.45, 0.5), at(0.45, 0.5));
  await expect(page.getByTestId("strat-position")).toHaveCount(1);
  await drag(at(0.55, 0.55), at(0.6, 0.5));
  await expect(page.getByTestId("strat-position")).toHaveCount(2);
  await page.getByTestId("board-grenade").click();
  await drag(at(0.5, 0.6), at(0.5, 0.4));
  await expect(page.getByTestId("strat-grenades").locator("li")).toHaveCount(1);
  await page.getByTestId("board-arrow").click();
  await drag(at(0.4, 0.4), at(0.3, 0.35));
  await page.getByTestId("board-text").click();
  await page.mouse.click(...at(0.3, 0.3));
  await page.getByLabel("Texte sur la carte").fill("Rotation A");
  await page.getByLabel("Texte sur la carte").press("Enter");
  await expect(page.locator(".sb-svg text", { hasText: "Rotation A" })).toHaveCount(1);
  // nommer un joueur, effacer le second, annuler l'effacement
  await page.getByLabel("Nom du joueur 1").fill("AWPer");
  await page.getByLabel("Nom du joueur 1").blur();
  await page.getByTestId("board-erase").click();
  await page.getByTestId("strat-position").nth(1).click();
  await expect(page.getByTestId("strat-position")).toHaveCount(1);
  await page.getByRole("button", { name: "Annuler" }).first().click();
  await expect(page.getByTestId("strat-position")).toHaveCount(2);
  await page.screenshot({ path: "test-results/shots/strat-board.png" });
  // tout est enregistré : relecture et liste par carte
  await page.getByTestId("board-toggle").click();
  await page.reload();
  await expect(page.getByTestId("strat-position")).toHaveCount(2);
  await expect(page.locator(".sb-list").first()).toContainText("AWPer");
  await page.goto("/stratbook?map=de_mirage");
  const row = page.getByTestId("strat-row").filter({ hasText: "Contrôle mid Mirage" });
  await expect(row).toContainText("Exécution");
  await expect(row.locator(".sb-row-n")).toHaveText("1");  // grenades
  await expect(page.getByRole("group", { name: "Carte", exact: true }).getByRole("button", { name: /Mirage/ })).toContainText("1");
});

test("ergonomie : recherche rapide Ctrl+K, actions directes", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await expect(page.getByTestId("match-row")).toHaveCount(1);
  await page.keyboard.press("Control+k");
  const input = page.getByTestId("command-input");
  await expect(input).toBeFocused();
  await input.fill("classe");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/leaderboards/);
  await page.getByTestId("open-search").click();
  await page.getByTestId("command-input").fill("faze nuke");
  await expect(page.getByTestId("command-palette").locator(".cp-item.on")).toContainText("FaZe");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/matches\/\d+$/);
  await page.keyboard.press("Control+k");
  await page.getByTestId("command-input").fill("lien");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("import-url-dialog")).toBeVisible();
  await page.getByTestId("import-url-input").fill("http://exemple/demo.dem");
  await page.getByRole("button", { name: "Importer", exact: true }).click();
  await expect(page.getByTestId("import-url-error")).toContainText("https://");
});

test("import par lien : la fenêtre tient dans un petit écran, même avec un lien très long", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await page.goto("/?import=url");
  const dialog = page.getByTestId("import-url-dialog");
  await expect(dialog).toBeVisible();
  // lien HLTV très long : la commande d'import affichée sur une ligne élargissait la fenêtre au-delà de l'écran
  await page.getByTestId("import-url-input").fill("https://www.hltv.org/matches/2399999/" + "tres-long-nom-de-match-".repeat(12));
  await page.getByTestId("import-url-input").fill("https://demos.example.net/cs2/" + "x".repeat(400) + ".dem.zst?sig=" + "a".repeat(300));
  const box = await dialog.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(box!.y + box!.height).toBeLessThanOrEqual(640);
  const submit = page.getByRole("button", { name: "Importer", exact: true });
  await expect(submit).toBeInViewport();
  await expect(submit).toBeEnabled();
});

test("EDGE : filtre par tactique et signets", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  // tactique depuis le playbook d'une équipe → page Rounds filtrée
  await page.goto("/scouting");
  await page.getByTestId("scout-team").first().click();
  await openScoutData(page);
  const link = page.getByTestId("pb-rounds").first();
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(/\/rounds\?.*tactic=/);
  await expect(page.getByTestId("tactic-filter")).not.toHaveValue("");
  await expect.poll(() => page.getByTestId("round-hit").count()).toBeGreaterThan(0);
  // fins du default → filtre « t:default::<sous-type> » (R3 de 3DMAX, seul default de la fixture), à côté des formats
  // « t:<cat> » et « t:<cat>:<site> »
  const dmax = (await (await page.request.get("/api/scouting/teams")).json()).find((t: { name: string }) => t.name === "3DMAX");
  const pbT = (await (await page.request.get(`/api/scouting/teams/${dmax.id}/playbook?map=de_nuke`)).json()).t;
  const row3 = pbT.list.find((x: { number: number }) => x.number === 3);
  const total = async (tactic: string) => {
    const r = await page.request.get(`/api/rounds/search?${new URLSearchParams({ team: String(dmax.id), map: "de_nuke", tactic })}`);
    expect(r.status()).toBe(200);
    return (await r.json()).total as number;
  };
  expect(await total(`t:default::${row3.default_kind}`)).toBe(1);
  expect(await total(`t:default:${row3.site}`)).toBe(1);
  expect(await total("t:default::duels")).toBe(0);
  await page.goto(`/rounds?team=${dmax.id}&map=de_nuke&tactic=t:default::${row3.default_kind}`);
  await expect(page.getByTestId("tactic-filter")).toHaveValue(`t:default::${row3.default_kind}`);
  await expect.poll(() => page.getByTestId("round-hit").count()).toBe(1);
  await expect(page.getByTestId("tactic-filter").locator("option:checked")).toHaveText(/^T · Default puis (exécution|prise) \(1\)$/);
  // signet : touche S dans le replay, repère sur la frise, page Signets
  await page.goto("/matches/1/replay/2?t=4000");
  await expect(page.getByTestId("radar")).toBeVisible();
  await page.keyboard.press("s");
  await expect(page.getByTestId("bookmark-toast")).toContainText("Signet ajouté");
  await expect(page.getByTestId("tl-bookmark")).toHaveCount(1);
  await page.goto("/bookmarks");
  const row = page.getByTestId("bookmark-row").first();
  await row.getByLabel("Nom du signet").fill("Rotation trop lente");
  await row.getByLabel("Nom du signet").press("Enter");
  await page.reload();
  await expect(page.getByTestId("bookmark-row").first().getByLabel("Nom du signet")).toHaveValue("Rotation trop lente");
  await page.getByTestId("bookmark-row").first().getByRole("link", { name: "Revoir" }).click();
  await expect(page).toHaveURL(/replay\/2\?t=\d+/);
});

test("carte des timings d'une équipe", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/scouting");
  await page.getByTestId("scout-team").first().click();
  await openScoutData(page);
  const tm = page.getByTestId("timings");
  await tm.scrollIntoViewIfNeeded();
  // la fixture n'a des positions que pour 3 rounds : selon l'équipe, l'un des deux camps en a
  for (const side of ["T", "CT"]) {
    await tm.getByRole("group", { name: "Camp des timings" }).getByRole("button", { name: side, exact: true }).click();
    if (await page.getByTestId("timing-row").count()) break;
  }
  await expect.poll(() => page.getByTestId("timing-row").count()).toBeGreaterThan(0);
  const slider = page.getByTestId("timings-slider");
  await slider.fill("10");
  await expect(tm.locator(".tm-clock")).toHaveText("1:45");  // 10 s de jeu = 1:45 à l'horloge
  await page.screenshot({ path: "test-results/shots/timings.png", fullPage: true });
});

test("suppression de matchs : sélection, confirmation claire, depuis la page du match", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await page.getByTestId("match-check").first().check();
  await expect(page.getByTestId("selection-bar")).toContainText("1 match sélectionné");
  await page.getByTestId("delete-selected").click();
  const dlg = page.getByTestId("delete-dialog");
  await expect(dlg).toContainText("Supprimer ce match ?");
  await expect(dlg).toContainText("Conservé");
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
  await expect(page.getByTestId("match-row")).toHaveCount(1);
  await page.getByLabel("Tout sélectionner").uncheck();
  await expect(page.getByTestId("selection-bar")).toHaveCount(0);
  await page.getByTestId("match-row").click();
  await page.getByTestId("delete-match-page").click();
  await expect(page.getByTestId("delete-dialog")).toBeVisible();
  await page.getByTestId("delete-dialog").getByRole("button", { name: "Annuler" }).click();
  await expect(page.getByTestId("delete-dialog")).toHaveCount(0);
});

test("callouts : toutes les cartes et callouts placés à la main", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/callouts?view=places");
  const pills = page.getByRole("group", { name: "Carte" });
  for (const name of ["Cache", "Train", "Vertigo", "Overpass", "Mirage"]) await expect(pills.getByRole("button", { name })).toBeVisible();
  await pills.getByRole("button", { name: "Nuke" }).click();
  await page.getByTestId("place-callout").click();
  const box = (await page.getByTestId("callout-map").boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.getByTestId("callout-draft").fill("Cabane du T");
  await page.getByTestId("callout-draft").press("Enter");
  await expect(page.getByTestId("custom-pin")).toHaveCount(1);
  await expect(page.getByTestId("custom-row")).toHaveCount(1);
  // renommer puis supprimer
  await page.getByLabel("Nom du callout Cabane du T").fill("Cabane");
  await page.getByLabel("Nom du callout Cabane du T").press("Enter");
  await expect(page.getByTestId("custom-pin")).toContainText("Cabane");
  await page.getByLabel("Supprimer le callout Cabane").click();
  await expect(page.getByTestId("custom-pin")).toHaveCount(0);
  // une carte sans match : radar affiché, on peut y placer un callout
  await pills.getByRole("button", { name: "Cache" }).click();
  await expect(page.getByTestId("callout-map")).toBeVisible();
  await expect(page.getByText("Ils apparaîtront après l'import d'un match sur cette carte.")).toBeVisible();
});

test("replay : zoom du radar (boutons et clavier) ; Rounds : choix d'une démo", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/matches/1/replay/2");
  await expect(page.getByTestId("radar")).toBeVisible();
  const level = page.getByTestId("zoom-level");
  // le cadrage automatique se fait après la première mesure du radar et l'arrivée de la frise : on attend qu'il soit posé
  await expect.poll(async () => level.textContent()).not.toBe("100%");
  await page.waitForTimeout(500);
  const start = parseInt((await level.textContent())!);
  await page.getByTestId("zoom-in").click();
  await expect.poll(async () => parseInt((await level.textContent())!)).toBeGreaterThan(start);
  await page.getByTestId("zoom-out").click();
  await page.getByTestId("zoom-out").click();
  await expect.poll(async () => parseInt((await level.textContent())!)).toBeLessThan(start);
  await page.keyboard.press("0");  // retour au cadrage automatique (qui peut avoir bougé de quelques % si la page s'est encore ajustée)
  await expect.poll(async () => parseInt((await level.textContent())!)).toBeGreaterThan(start * 0.9);
  const reset = parseInt((await level.textContent())!);
  await page.keyboard.press("+");
  await expect.poll(async () => parseInt((await level.textContent())!)).toBeGreaterThan(reset);
  // Rounds : une seule démo
  await page.goto("/rounds");
  const demo = page.getByTestId("demo-select");
  await expect(demo.locator("option")).toHaveCount(2);
  await demo.selectOption({ index: 1 });
  await expect(page).toHaveURL(/match=\d+/);
  await expect(page.getByTestId("round-hit")).toHaveCount(23);
});

test("enchaîner mes morts : de mort en mort puis arrêt", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/dashboard");
  await page.getByLabel("Joueur suivi").selectOption({ index: 1 });
  await page.getByTestId("reel-my-deaths").click();
  const reel = page.getByTestId("death-reel");
  await expect(reel).toContainText(/Enchaînement 1\/\d+/);
  await page.getByRole("button", { name: "8×" }).click();
  await expect(reel).toContainText(/Enchaînement 2\/\d+/, { timeout: 15000 });
  await expect(page).toHaveURL(/reel=1/);
  await reel.click();
  await expect(reel).toContainText("Enchaîner");
  await expect(page).not.toHaveURL(/reel=1/);
});

test("grenades : combinaisons répétées (pattern finder)", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/grenades?map=de_nuke");
  await page.getByTestId("mode-combos").click();
  await expect(page.getByTestId("grenade-count")).toContainText(/[1-9]\d* combinaison/);
  const first = page.getByTestId("combo-item").first();
  const n = Number((await first.locator(".gr-item-n").textContent())!.replace("×", ""));
  expect(n).toBeGreaterThanOrEqual(2);
  await first.click();
  await expect(page.getByTestId("combo-detail").locator(".gr-occ li")).toHaveCount(n);
  await page.getByTestId("combo-detail").locator(".gr-occ a").first().click();
  await expect(page).toHaveURL(/\/replay\/\d+\?t=\d+/);
});

test("apprendre un poste : choix, comparaison, conseils et séance d'étude", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/dashboard");
  await page.getByLabel("Joueur suivi").selectOption({ index: 1 });
  await page.goto("/learn/expert?map=de_nuke&side=CT");
  const postes = page.getByTestId("postes").getByRole("button");
  await expect.poll(() => postes.count()).toBeGreaterThan(1);  // zones de callouts : moins de postes, plus larges
  // postes habituels du joueur suivi (sur l'un des deux camps)
  const myPostes = page.getByTestId("my-postes").getByRole("button");
  await page.waitForTimeout(300);
  if (!(await myPostes.count())) await page.goto("/learn/expert?map=de_nuke&side=T");
  await myPostes.first().click();
  await expect(page.getByTestId("poste-compare")).not.toContainText("aucun round");
  await page.goto("/learn/expert?map=de_nuke&side=CT");
  await expect.poll(() => postes.count()).toBeGreaterThan(1);  // zones de callouts : moins de postes, plus larges
  await postes.first().click();
  await postes.nth(1).click();
  await expect(page).toHaveURL(/place=[^&]+%2C|place=[^&]+,/);
  const cmp = page.getByTestId("poste-compare");
  await expect(cmp).toContainText("Survie");
  await expect(page.getByTestId("poste-tips").locator("li").first()).toBeVisible();
  await page.screenshot({ path: "test-results/shots/learn.png" });
  // situation : bombe posée ailleurs → moins de rounds
  const legend = page.getByTestId("poste-detail").locator("p.st-legend").first();
  await page.getByRole("group", { name: "Site attaqué" }).getByRole("button", { name: /Pas posée/ }).click();
  await expect(legend).toContainText("filtrés sur");
  await page.getByTestId("situ-reset").click();
  await expect(legend).not.toContainText("filtrés sur");
  // onglets
  await page.getByTestId("tab-flow").click();
  await expect(page.getByTestId("poste-timeline")).toBeVisible();
  await expect.poll(() => page.getByTestId("poste-chrono").locator("li").count()).toBeGreaterThan(1);
  await page.getByTestId("poste-spots").getByRole("button").first().click();
  await expect(legend).toContainText("filtrés sur");
  await page.getByTestId("situ-reset").click();
  await page.getByTestId("tab-duels").click();
  await expect.poll(() => page.getByTestId("deaths-from").locator("li").count()).toBeGreaterThan(0);
  await page.getByTestId("tab-players").click();
  await page.getByTestId("poste-players").getByRole("button", { name: "Modèle" }).first().click();
  await expect(page.getByTestId("poste-players").getByRole("button", { name: "✕" })).toBeVisible();
  await page.getByTestId("poste-players").getByRole("button", { name: "✕" }).click();
  await page.getByTestId("tab-plan").click();
  const score = page.getByTestId("plan-score");
  const before = Number((await score.textContent())!.split("/")[0]);
  await page.getByTestId("poste-plan").getByRole("checkbox").first().check();
  await expect(score).toContainText(`${before + 1}/`);
  // curseur de temps
  await page.getByLabel("Instant du round").fill("40");
  await expect(page.getByTestId("time-bar")).toContainText("1:15");  // 40 s de jeu = 1:15 à l'horloge
  await page.getByTestId("tab-util").click();
  const dl = page.waitForEvent("download");
  await page.getByTestId("poste-cfg").click();
  expect((await dl).suggestedFilename()).toMatch(/^poste_de_nuke_CT_.*\.cfg$/);
  await page.getByTestId("study-poste").click();
  const bar = page.getByTestId("study-bar");
  await expect(bar).toContainText(/1\/\d+/);
  await expect(page).toHaveURL(/study=1&i=0.*focus=\d+/);
  await page.getByTestId("study-next").click();
  await expect(bar).toContainText(/2\/\d+/);
  // pauses commentées : le replay s'arrête sur un moment clé avec son explication
  await expect(page.getByTestId("study-pauses")).toBeChecked();
  await page.getByRole("button", { name: "8×" }).click();
  await expect(page.getByTestId("study-mark")).toBeVisible({ timeout: 20000 });
  await page.getByTestId("study-continue").click();
  await expect(page.getByTestId("study-mark")).toHaveCount(0);
  await bar.getByRole("link").click();
  await expect(page).toHaveURL(/\/learn\/expert\?.*place=/);
});

test("dessins : déplacer une forme sur le radar du replay et du stratbook", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/matches/1/replay/2");
  const radar = page.getByTestId("radar");
  await expect(radar).toBeVisible();
  const box = (await radar.boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  if (await page.getByTestId("draw-show").count()) await page.getByTestId("draw-show").click();  // barre de dessin repliée par défaut
  await page.getByRole("button", { name: "Rectangle" }).click();
  await page.mouse.move(cx - 60, cy - 40); await page.mouse.down(); await page.mouse.move(cx + 60, cy + 40, { steps: 4 }); await page.mouse.up();
  const roundId = await page.evaluate(async () => (await (await fetch("/api/matches/1")).json()).rounds.find((r: { number: number }) => r.number === 2).id);
  const shapes = async () => (await (await page.request.get(`/api/rounds/${roundId}/annotations`)).json()).shapes as { points: number[][] }[];
  await expect.poll(async () => (await shapes()).length).toBe(1);
  const before = (await shapes())[0].points[0];
  // outil Déplacer (touche V) : glisser l'intérieur du rectangle
  await page.keyboard.press("v");
  await expect(page.getByRole("button", { name: "Déplacer un dessin" })).toHaveAttribute("aria-pressed", "true");
  await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 120, cy + 50, { steps: 6 }); await page.mouse.up();
  await expect.poll(async () => (await shapes())[0].points[0][0]).toBeGreaterThan(before[0] + 5);
  // annuler (Ctrl+Z) remet la forme en place
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await shapes())[0].points[0][0]).toBeCloseTo(before[0], 0);
  await page.getByRole("button", { name: "Tout effacer" }).click();

  // stratbook : une flèche déplacée avec l'outil Déplacer
  await page.goto("/stratbook");
  await page.getByTestId("new-strat").click();
  const dlg = page.getByTestId("new-strat-dialog");
  await dlg.getByLabel("Nom").fill("Déplacement de dessins");
  await dlg.getByRole("group", { name: "Carte de la stratégie" }).getByRole("button", { name: "Mirage" }).click();
  await dlg.getByRole("group", { name: "Camp de la stratégie" }).getByRole("button", { name: "T", exact: true }).click();
  await dlg.getByRole("button", { name: "Créer et dessiner" }).click();
  // le tableau de la stratégie affichée avant reste à l'écran le temps de charger la nouvelle : attendre celui de la nouvelle
  const sbMap = page.getByTestId("strat-board").getByRole("img", { name: "Radar de la stratégie Déplacement de dessins" });
  await expect(sbMap).toBeVisible();
  const sb = (await sbMap.boundingBox())!;
  const at = (fx: number, fy: number) => [sb.x + sb.width * fx, sb.y + sb.height * fy] as const;
  await page.getByTestId("board-arrow").click();
  await page.mouse.move(...at(0.4, 0.5)); await page.mouse.down(); await page.mouse.move(...at(0.6, 0.5), { steps: 5 }); await page.mouse.up();
  const line = page.getByTestId("strat-shape").last().locator("polyline").first();
  await expect(page.getByTestId("strat-shape")).toHaveCount(1);
  const p0 = await line.getAttribute("points");
  await page.getByTestId("board-move").click();
  await page.mouse.move(...at(0.5, 0.5)); await page.mouse.down(); await page.mouse.move(...at(0.5, 0.65), { steps: 6 }); await page.mouse.up();
  await expect.poll(() => line.getAttribute("points")).not.toBe(p0);
});

test("assistant IA : configuration, conversation (réponses simulées) et liens vers les rounds", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/assistant");
  // sans clé : formulaire d'activation ; une clé mal formée est refusée
  await expect(page.getByTestId("ai-setup")).toBeVisible();
  await page.getByTestId("ai-key").fill("pas-une-cle");
  await page.getByRole("button", { name: "Enregistrer" }).click();
  await expect(page.getByTestId("ai-setup").getByRole("alert")).toContainText("Clé API invalide");
  // assistant actif (réponses de l'API Anthropic simulées)
  await page.route("**/api/ai/status", (r) => r.fulfill({ json: { enabled: true, model: "claude-opus-5-5", source: "app",
    models: { "claude-opus-5-5": "Claude Opus 5.5 (le plus précis)" }, provider: "anthropic", providers: ["anthropic"], can_configure: true } }));
  const ev = (o: object) => `data: ${JSON.stringify(o)}\n\n`;
  let sent: { messages: { content: string }[]; context: { match?: number } } | null = null;
  await page.route("**/api/ai/chat", async (r) => {
    sent = r.request().postDataJSON();
    await r.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body:
      ev({ type: "step", label: "Liste des matchs" }) + ev({ type: "step", label: "Stats du match (side=CT)" }) +
      ev({ type: "text", text: "## Résumé\n\n**FaZe** perd 10-13. Rounds clés :\n\n- [R3](/matches/1/replay/3) : retake raté\n" }) +
      ev({ type: "text", text: "- [R10](/matches/1/replay/10)\n\n| Joueur | Rating |\n|---|---|\n| frozen | 1.21 |\n" }) +
      ev({ type: "done", usage: { input: 1200, output: 300 }, model: "claude-opus-5-5" }) });
  });
  await page.goto("/matches/1");
  await page.getByTestId("ask-assistant").click();
  await expect(page).toHaveURL(/\/assistant\?match=1/);
  await expect(page.getByTestId("ai-question")).toHaveValue(/Analyse ce match/);
  await page.getByTestId("ai-send").click();
  const answer = page.getByTestId("ai-assistant").last();
  await expect(answer.getByRole("heading", { name: "Résumé" })).toBeVisible();
  await expect(answer.locator("strong", { hasText: "FaZe" })).toBeVisible();
  await expect(answer.getByRole("cell", { name: "frozen" })).toBeVisible();
  await expect(answer).toContainText("2 données consultées");
  await expect(answer).toContainText("1 200 / 300 jetons");
  expect(sent!.context.match).toBe(1);
  expect(sent!.messages[0].content).toContain("Analyse ce match");
  await page.screenshot({ path: "test-results/shots/assistant.png" });
  // les liens ouvrent le round dans le replay
  await answer.getByRole("link", { name: "R3" }).click();
  await expect(page).toHaveURL(/\/matches\/1\/replay\/3$/);
  // la conversation est conservée
  await page.goto("/assistant");
  await expect(page.getByTestId("ai-assistant")).toHaveCount(1);
  await page.getByTestId("ai-new").click();
  await expect(page.getByTestId("ai-assistant")).toHaveCount(0);
});

test("apprendre un rôle : profils, indicateurs, joueurs modèles et étude", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/dashboard");
  await page.getByLabel("Joueur suivi").selectOption({ index: 1 });
  await page.goto("/learn/expert?map=de_nuke&side=CT");
  await page.getByTestId("mode-role").click();
  await expect(page).toHaveURL(/mode=role/);
  await expect(page.getByTestId("role-players").locator("li")).toHaveCount(10);
  await page.getByTestId("role-tabs").getByRole("tab", { name: /Ancre A/ }).click();
  await expect(page.getByTestId("role-detail")).toContainText("Ancre A");
  await expect(page.getByTestId("role-kpis")).toContainText("Sur le site A à 0:25");
  await expect(page.getByTestId("my-role")).toContainText("Ton profil ici");
  await page.getByRole("group", { name: "Camp" }).getByRole("button", { name: "T", exact: true }).click();
  await page.getByTestId("role-tabs").getByRole("tab", { name: /Lurker/ }).click();
  await expect(page.getByTestId("role-kpis")).toContainText("Distance au groupe");
  await page.screenshot({ path: "test-results/shots/learn-role.png" });
  await page.waitForLoadState("networkidle");
  await page.getByTestId("role-models").getByRole("button", { name: "Étudier" }).and(page.locator(":enabled")).first().click();
  // séance d'étude ouverte sur les rounds du joueur modèle, en le suivant (la démo de test n'a pas les positions de tous les rounds)
  await expect(page).toHaveURL(/\/replay\/\d+\?study=1&i=0.*focus=\d+/);
});

test("apprendre un rôle (simple) : démo, joueur, histoire d'un round étape par étape", async ({ page }) => {
  await page.goto("/learn");
  await page.getByTestId("story-demos").getByRole("button").first().click();
  await page.getByTestId("story-players").getByRole("button").first().click();
  await expect(page.getByTestId("story-rounds").getByRole("button").first()).toBeVisible();
  await expect(page.getByTestId("story-map")).toBeVisible();
  const card = page.getByTestId("story-card");
  await expect(card).toContainText(/Achat/);
  await expect(page.getByTestId("story-marker").first()).toBeVisible();
  // coéquipiers et ennemis à l'instant de l'étape ; calques et légende réunis dans « Affichage » (replié : la carte d'abord)
  await expect(page.getByTestId("story-mate").first()).toBeVisible();
  await expect(page.getByTestId("story-enemy").first()).toBeVisible();
  await expect(page.getByTestId("story-legend")).toHaveCount(0);
  await page.getByTestId("legend-toggle").click();
  await expect(page.getByTestId("utility-legend")).toContainText("Smoke");
  await page.getByTestId("show-enemies").uncheck();
  await expect(page.getByTestId("story-enemy")).toHaveCount(0);
  await page.getByTestId("show-enemies").check();
  await page.getByTestId("show-traces").uncheck();
  await page.getByTestId("show-traces").check();
  await expect(page.getByTestId("show-utility")).toBeChecked();
  // noms des lieux et des joueurs retirables, choix mémorisé (les zones restent)
  await page.getByTestId("show-place-names").uncheck();
  await expect(page.getByTestId("story-callout").first()).toBeVisible();
  await expect(page.getByTestId("story-callout").locator("text")).toHaveCount(0);
  await page.getByTestId("show-player-names").uncheck();
  await expect(page.getByTestId("story-map").locator(".sy-plabel")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("story-map").locator(".sy-plabel")).toHaveCount(0);
  await expect(page.getByTestId("story-callout").locator("text")).toHaveCount(0);
  await page.getByTestId("legend-toggle").click();
  await page.getByTestId("show-place-names").check();
  await page.getByTestId("show-player-names").check();
  await expect(page.getByTestId("story-callout").locator("text").first()).toBeVisible();
  await page.getByTestId("legend-toggle").click();
  await expect(page.getByTestId("story-legend")).toHaveCount(0);
  // horloge du jeu (1:55 qui descend) et situation autour du joueur
  await expect(page.getByTestId("story-steps")).toContainText("1:55");
  await expect(page.getByTestId("story-situation")).toContainText(/en vie contre/);
  // coach, assistant et aide : repliés sous « Aller plus loin », l'étape en cours d'abord
  await expect(page.getByTestId("story-help")).toBeHidden();
  await page.getByTestId("story-more").locator("summary").click();
  await expect(page.getByTestId("story-help")).toBeVisible();
  // lineup d'une grenade : trajectoire sur la carte et position de lancer
  const nadeStep = page.getByTestId("story-steps").getByRole("button", { name: /Lance/ }).first();
  if (await nadeStep.count()) {
    await nadeStep.click();
    await expect(page.getByTestId("story-lineup")).toBeVisible();
    await expect(page.getByTestId("story-lineup-box")).toBeVisible();
  }
  await page.getByTestId("story-steps").getByRole("button").first().click();
  await page.getByTestId("story-next").click();
  await expect(page).toHaveURL(/step=1/);
  await expect(card).not.toContainText(/Achat/);
  await page.keyboard.press("ArrowLeft");
  await expect(card).toContainText(/Achat/);
  // enchaîner les rounds : pastilles, touches N / P, et « Suivant » à la dernière étape
  if (await page.getByTestId("story-rounds").locator(".sy-round").count() > 1) {
    const r0 = new URL(page.url()).searchParams.get("round");
    await page.keyboard.press("n");
    await expect(page).not.toHaveURL(new RegExp(`round=${r0}(&|$)`));
    await page.keyboard.press("p");
    await page.getByTestId("story-timeline").getByRole("button").last().click();
    await expect(page.getByTestId("story-next")).toHaveText(/Round \d+/);
    await page.getByTestId("story-next").click();
    await expect(page.getByTestId("story-card")).toContainText(/Achat/);
    await page.keyboard.press("p");
  }
  // plein écran de toute la vue (rounds, carte, étapes) ; repli en vue étendue si le navigateur refuse
  await page.getByTestId("story-full").click();
  await expect(page.getByTestId("story-full")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("story-transport")).toBeVisible();
  await expect(page.getByTestId("story-rounds")).toBeVisible();
  await page.getByTestId("story-full").click();
  await expect(page.getByTestId("story-full")).toHaveAttribute("aria-pressed", "false");
  // rounds armés par défaut (s'il y en a), « Tous » montre aussi pistols et ecos ; chaque round dit son type d'achat
  const filter = page.getByTestId("rounds-filter");
  if (await filter.count()) {
    const armedN = await page.getByTestId("story-rounds").locator(".sy-round").count();
    await filter.getByRole("button", { name: /Tous/ }).click();
    await expect(page).toHaveURL(/rounds=all/);
    expect(await page.getByTestId("story-rounds").locator(".sy-round").count()).toBeGreaterThanOrEqual(armedN);
    await filter.getByRole("button", { name: /Rounds armés/ }).click();
  }
  // chaque pastille de round dit son type d'achat, son issue et son poste (infobulle)
  await expect(page.getByTestId("story-rounds").locator(".sy-round").first()).toHaveAttribute("title", /Pistol|Eco|Semi|Force|Armé/);
  // frise du round : un clic sur une étape y amène
  const dotsTl = page.getByTestId("story-timeline").getByRole("button");
  await expect(dotsTl.first()).toBeVisible();
  await dotsTl.nth(1).click();
  await expect(page).toHaveURL(/step=1/);
  // zoom : le cadrage se resserre, « recentrer » revient au round entier ; suivre le joueur
  const svg = page.getByTestId("story-map");
  const before = await svg.getAttribute("viewBox");
  await page.getByTestId("story-zoom").getByRole("button", { name: "Zoomer", exact: true }).click();
  const zoomed = await svg.getAttribute("viewBox");
  expect(Number(zoomed!.split(" ")[2])).toBeLessThan(Number(before!.split(" ")[2]));
  await page.getByTestId("story-zoom").getByRole("button", { name: "Recentrer" }).click();
  await expect(svg).toHaveAttribute("viewBox", before!);
  await page.getByTestId("story-follow").click();
  await expect(page.getByTestId("story-follow")).toHaveAttribute("aria-pressed", "true");
  // zones des lieux en fond, masquables
  await page.getByTestId("legend-toggle").click();
  await page.getByTestId("show-callouts").uncheck();
  await expect(page.getByTestId("story-callout")).toHaveCount(0);
  await page.getByTestId("show-callouts").check();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("story-legend")).toHaveCount(0);
  // coach IA (réponse simulée) : récit du round
  await page.route("**/api/scouting/coach", (r) => r.fulfill({ json: { kind: "round", model: "claude-haiku-5-5", cost_usd: 0.004, cached: false,
    checks: { removed_sentences: 0 }, facts: {}, blocks: [{ title: "Ce qui se passe", text: "- À 1:45, il prend son poste.", fact_ids: ["step2"] }] } }));
  await page.getByTestId("story-more").evaluate((d) => { (d as HTMLDetailsElement).open = true; });
  await page.getByTestId("coach-ask").first().click();
  await expect(page.getByTestId("coach-note")).toContainText("il prend son poste");
  // sa routine : postes dans le temps, grenades, et retour vers un round
  await page.getByTestId("view-routine").click();
  await expect(page).toHaveURL(/view=routine/);
  await expect(page.getByTestId("routine")).toBeVisible();
  await page.getByTestId("routine").getByLabel(/Rounds armés/).uncheck();
  await expect(page.getByTestId("routine-times")).toContainText("1:45");
  await expect(page.getByTestId("routine-map")).toBeVisible();
  await page.getByTestId("routine-times").locator(".ts-round").first().click();
  await expect(page).not.toHaveURL(/view=routine/);
  await expect(page.getByTestId("story-map")).toBeVisible();
  await page.screenshot({ path: "test-results/shots/learn-story.png" });
  // anciens liens : vers l'analyse détaillée
  await page.goto("/learn?map=de_nuke&side=CT");
  await expect(page).toHaveURL(/\/learn\/expert\?map=de_nuke/);
  await page.goBack();
  await page.goto("/learn");
  await page.getByTestId("story-demos").getByRole("button").first().click();
  await page.getByTestId("story-players").getByRole("button").first().click();
  await page.getByTestId("story-replay").click();
  await expect(page).toHaveURL(/\/replay\/\d+\?study=1&i=0.*focus=\d+/);
  await expect(page.getByTestId("study-pauses")).toBeChecked();
});

test("heatmaps : présence, contrôle et morts", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/heatmaps");
  await expect(page.getByTestId("heatmap")).toBeVisible();
  await expect(page.getByTestId("heat-count")).toContainText("23 round(s)");
  await page.waitForTimeout(300);
  await page.screenshot({ path: "test-results/shots/heat-presence.png" });
  await page.getByRole("group", { name: "Données" }).getByRole("button", { name: "Contrôle" }).click();
  await expect(page).toHaveURL(/kind=control/);
  await page.waitForTimeout(500);
  await page.screenshot({ path: "test-results/shots/heat-control.png" });
  await page.getByRole("group", { name: "Données" }).getByRole("button", { name: "Morts" }).click();
  await expect(page.getByTestId("heat-count")).toContainText("événement");
  await page.getByRole("group", { name: "Moment du round" }).getByRole("button", { name: "1:55 – 1:35" }).click();
  await expect(page).toHaveURL(/win=0-20/);
  await page.waitForTimeout(500);
  await page.screenshot({ path: "test-results/shots/heat-deaths.png" });
});

test("replay : dessin, note et enregistrement", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await page.getByTestId("match-row").click();
  await page.getByTestId("round-cell").nth(1).click();  // la fixture réduite a les positions du round 2
  const radar = page.getByTestId("radar");
  await expect(radar).toBeVisible();
  const box = (await radar.boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  if (await page.getByTestId("draw-show").count()) await page.getByTestId("draw-show").click();  // barre de dessin repliée par défaut
  await page.getByRole("button", { name: "Flèche" }).click();
  await page.mouse.move(cx - 120, cy); await page.mouse.down(); await page.mouse.move(cx, cy - 60, { steps: 5 }); await page.mouse.up();
  await page.keyboard.press("t");
  await page.mouse.click(cx + 40, cy + 80);
  await page.getByTestId("draw-text-input").fill("smoke ici");
  await page.getByTestId("draw-text-input").press("Enter");
  await page.getByRole("button", { name: "Note du round" }).click();
  await page.getByTestId("round-note").fill("rotation B trop tôt");
  await expect(page.locator(".draw-status.saved")).toBeVisible({ timeout: 5000 });
  await page.screenshot({ path: "test-results/shots/draw.png" });
  // persistance : on recharge la page
  await page.reload();
  await expect(page.locator(".rl-cell.on .rl-note")).toBeVisible();
  await page.getByRole("button", { name: "Note du round" }).click();
  await expect(page.getByTestId("round-note")).toHaveValue("rotation B trop tôt");
  await page.getByTestId("round-note").fill("");
  // gomme puis annulation
  await page.keyboard.press("Escape");
  await radar.click({ position: { x: 5, y: 5 } });
  await page.getByRole("button", { name: "Gomme" }).click();
  await page.mouse.click(cx - 60, cy - 30);
  await page.keyboard.press("Control+z");
  await page.getByRole("button", { name: "Tout effacer" }).click();
  await expect(page.getByRole("button", { name: "Tout effacer" })).toBeDisabled();
  await expect(page.locator(".draw-status.saved")).toBeVisible({ timeout: 5000 });
});

test("scouting : pool de cartes, tendances et joueurs", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await page.getByRole("link", { name: "Scouting" }).click();
  await expect(page.getByTestId("scout-team")).toHaveCount(2);
  // rapport de l'IA simulé : synthèse + carte choisie, sources dépliables, résultat du contrôle
  await page.route("**/api/scouting/teams/*/report", (r) => r.request().method() === "GET" ? r.fulfill({ json: {
    id: 1, team_id: 1, status: "done", model: "claude-sonnet-5-5", error: null, tokens_in: 9000, tokens_out: 2000, cost_usd: 0.038, latency_s: 41,
    created_at: "2026-10-13T20:00:00", checks: { numbers_checked: 12, first_pass_issues: 1, removed_sentences: 0 },
    content: { facts: { "nuke.T.pistol": { id: "nuke.T.pistol", map: "de_nuke", side: "T", topic: "pistol", label: "Nuke : pistols gagnés en attaque (T)", k: 1, n: 1, pct: 100, lo: 27, hi: 100, level: "anecdotal", examples: ["R1 contre 3DMAX, gagné"] } },
      sections: [{ key: "summary", title: "Synthèse", map: null, blocks: [{ title: "À retenir", text: "- Pistol T gagné 1 fois sur 1 (à confirmer).", fact_ids: ["nuke.T.pistol"] }] },
        { key: "map:de_nuke", title: "Nuke", map: "de_nuke", blocks: [{ title: "Pistols et économie", text: "Sur seulement 1 round : rush.", fact_ids: ["nuke.T.pistol"] }] }] },
  } }) : r.continue());
  await page.getByTestId("scout-team").filter({ hasText: "FaZe" }).click();
  await expect(page.getByTestId("ts-team")).toHaveText("FaZe");
  await expect(page.getByTestId("ai-section")).toHaveCount(1);  // synthèse seule, analyse de la carte repliée
  await page.getByTestId("ai-open-map").click();
  await expect(page.getByTestId("ai-section")).toHaveCount(2);
  await expect(page.getByTestId("ai-report")).toContainText("Pistol T gagné 1 fois sur 1");
  await expect(page.getByTestId("ai-checks")).toContainText("12 chiffres vérifiés");
  await page.getByTestId("ai-report").getByRole("button", { name: /D'où viennent ces chiffres/ }).first().click();
  await expect(page.getByTestId("ai-report")).toContainText("R1 contre 3DMAX");
  await expect(page.getByTestId("ts-bar").getByRole("tab")).toHaveCount(1);
  // mode simple (par défaut) : à retenir, pistes, puis carte et joueurs avec comptages « k sur n »
  await expect(page.getByTestId("ts-takeaways").locator(".ts-line").first()).toBeVisible();
  await expect(page.getByTestId("ts-takeaways")).toContainText(/fois sur|sur \d/);
  await expect(page.getByTestId("ts-tab-donnees")).toHaveCount(0);
  await page.screenshot({ path: "test-results/shots/scouting.png", fullPage: true });
  await page.getByTestId("ts-tab-carte").click();
  await expect(page.getByTestId("ts-attack")).toContainText("Leur façon d'attaquer");
  await expect(page.getByTestId("ts-defense")).toContainText("placement");
  await expect(page.getByTestId("util-radar").first()).toBeVisible();
  // heatmaps de la carte à un moment choisi (horloge du jeu), T et CT côte à côte
  await expect(page.getByTestId("ts-heat-T")).toBeVisible();
  await expect(page.getByTestId("ts-heat-CT")).toBeVisible();
  const early = page.getByTestId("ts-heat-win").getByRole("radio", { name: "1:55 – 1:45" });
  await early.click();
  await expect(early).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("ts-heat-T").getByRole("link")).toHaveAttribute("href", /win=0-10/);
  await page.getByRole("radio", { name: "Leur défense (CT)" }).click();
  await expect(page.getByTestId("ts-attack")).toHaveCount(0);
  await expect(page.getByTestId("ts-heat-T")).toHaveCount(0);
  // rounds à revoir : groupes façon analyste (le filtre CT masque les groupes T), rejouables superposés
  await page.getByTestId("ts-tab-revoir").click();
  await expect(page.getByTestId("ts-review-group").first()).toBeVisible();
  await expect(page.getByTestId("ts-review")).not.toContainText("Plants perdus");
  await expect(page.getByTestId("ts-review")).not.toContainText("en attaque");
  await expect(page.getByTestId("ts-review")).toContainText("Pistols en défense");
  await expect(page.getByTestId("ts-review-overlay").first()).toHaveAttribute("href", /\/replay\/\d+\?.*from=/);
  await page.getByTestId("ts-tab-joueurs").click();
  await expect(page.getByTestId("ts-player")).toHaveCount(5);
  await expect(page.getByText("1er duel").first()).toBeVisible();
  await expect(page.getByTestId("spots-radar")).toBeVisible();
  await expect(page.getByTestId("ts-ai")).toHaveAttribute("href", /\/assistant\?q=.*brief/);
  // mode avancé : toutes les données (anciennes sections)
  await openScoutData(page);
  await expect(page.getByTestId("scout-detail")).toContainText("Sites de pose");
  await expect(page.getByTestId("scout-player")).toHaveCount(5);
});

// doit rester le dernier test : créer le propriétaire verrouille l'application
test("scouting FACEIT : clé, recherche, fiche ESEA et import d'une démo", async ({ page }) => {
  const TEAM = "11111111-1111-1111-1111-111111111111", M1 = "1-cccccccc-cccc-cccc-cccc-cccccccccccc";
  let configured = false, imported = 0, pasted = "";
  await page.route("**/api/faceit/status", (r) => r.fulfill({ json: { configured, source: configured ? "app" : null, can_configure: true, downloads: false } }));
  await page.route("**/api/faceit/config", (r) => { configured = true; return r.fulfill({ json: { configured: true, source: "app", can_configure: true, downloads: false } }); });
  await page.route("**/api/faceit/teams", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/faceit/search?**", (r) => r.fulfill({ json: [{ team_id: TEAM, name: "Les Ours", avatar: "", via: "player", player: "n1", matches: 3, esea_matches: 2 }] }));
  await page.route(`**/api/faceit/matches/${M1}/import`, (r) => { imported++; pasted = r.request().postDataJSON()?.url ?? ""; return r.fulfill({ json: [] }); });
  await page.route(`**/api/faceit/teams/${TEAM}?**`, (r) => r.fulfill({ json: {
    team: { team_id: TEAM, name: "Les Ours", avatar: "", url: "https://www.faceit.com/en/teams/" + TEAM, leader: "p1" }, scope: "esea",
    roster: [{ player_id: "p1", nickname: "n1", avatar: "", country: "fr", level: 10, elo: 2450, steamid: "76561198000000001", matches: 2, in_library: false }],
    regulars: [], record: { played: 2, won: 1 }, local_team_id: null, map_names: { de_mirage: "Mirage", de_inferno: "Inferno", de_nuke: "Nuke" },
    matches: [
      { match_id: M1, url: "https://www.faceit.com/en/cs2/room/" + M1, started_at: "2026-10-01T19:00:00+00:00", competition: "ESEA S55 EU Intermediate", esea: true,
        opponent: { name: "Rivaux", team_id: null }, won: true, maps: [{ map: "de_mirage", score: [13, 9], won: true }], demos: 1, imported: [] },
      { match_id: "1-dddddddd-dddd-dddd-dddd-dddddddddddd", url: "#", started_at: "2026-09-24T19:00:00+00:00", competition: "ESEA S55 EU Intermediate", esea: true,
        opponent: { name: "Autres", team_id: null }, won: false, maps: [{ map: "de_inferno", score: [10, 13], won: false }], demos: 0, imported: [] }],
    map_pool: [
      { map: "de_mirage", played: 1, won: 1, rounds_won: 13, rounds_lost: 9, last: "2026-10-01T19:00:00+00:00", faceit: { matches: 10, win_pct: 60 }, active: true, likely_ban: false },
      { map: "de_nuke", played: 0, won: 0, rounds_won: 0, rounds_lost: 0, last: null, faceit: null, active: true, likely_ban: true }],
  } }));
  await page.goto("/scouting");
  await page.getByTestId("faceit-entry").click();
  await page.getByTestId("faceit-key").fill("0f3c1b5e-1111-2222-3333-444455556666");
  await page.getByRole("button", { name: "Enregistrer" }).click();
  await page.getByTestId("faceit-search").fill("n1");
  await page.getByRole("button", { name: "Rechercher", exact: true }).click();
  await expect(page.getByTestId("faceit-hit")).toContainText("2 matchs ESEA");
  await page.getByTestId("faceit-hit").click();
  await expect(page.getByTestId("faceit-team-name")).toHaveText("Les Ours");
  await expect(page.getByTestId("faceit-pool")).toContainText("ban probable");
  await expect(page.getByTestId("faceit-match")).toHaveCount(2);
  await expect(page.getByTestId("faceit-match").first()).toContainText("Mirage 13-9");
  await expect(page.getByTestId("faceit-match").nth(1)).toContainText("Pas de démo");
  await expect(page.getByTestId("faceit-import-help")).toContainText(`faceit-import.mjs https://www.faceit.com/fr/teams/${TEAM}`);
  await page.getByTestId("faceit-paste").click();
  await page.getByTestId("faceit-paste-input").fill("https://demos.example.net/cs2/" + M1 + "-1-1.dem.zst?sig=1");
  await page.getByTestId("faceit-paste-input").press("Enter");
  await expect.poll(() => imported).toBe(1);
  expect(pasted).toContain(M1);
  await expect(page.getByRole("link", { name: "Rapport IA" })).toHaveAttribute("href", /\/assistant\?q=.*Les%20Ours/);
});

test("barre de contexte : sélection de matchs, voir les matchs, comparaison", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/players");
  const bar = page.getByTestId("context-bar");
  await expect(page.getByTestId("ctx-rounds")).toContainText("23");
  await bar.getByLabel("Nombre de matchs").selectOption("1");
  await expect(page).toHaveURL(/last_n=1/);
  await page.getByTestId("ctx-show-matches").click();
  await expect(page.getByTestId("ctx-matches").locator("tbody tr")).toHaveCount(1);
  await bar.getByLabel("Équipe", { exact: true }).selectOption({ label: "FaZe (1)" });
  await expect(page.getByTestId("player-row")).toHaveCount(5);
  await bar.getByLabel("Achat adverse").selectOption("eco");
  await expect(page).toHaveURL(/opp_econ=eco/);
  await bar.getByLabel("Achat adverse").selectOption("");
  // type de match : selon ce qu'un test précédent a étiqueté, le match est officiel ou d'entraînement
  const official = (await (await page.request.get("/api/context")).json()).official > 0;
  await page.getByTestId("ctx-filters").click();
  await page.getByRole("radio", { name: "Officiels" }).click();
  await expect(page.getByTestId("ctx-rounds")).toContainText(official ? "23" : "0 rounds");
  await page.getByRole("radio", { name: "Entraînement" }).click();
  await expect(page.getByTestId("ctx-rounds")).toContainText(official ? "0 rounds" : "23");
  await page.getByRole("radio", { name: "Tous", exact: true }).click();
  await expect(page.getByTestId("ctx-rounds")).toContainText("23");
  await page.keyboard.press("Escape");
  // comparaison : FaZe sur 12 mois → ligne de référence, puis « Comp. » sur la fiche
  await page.getByTestId("ctx-edit-comparison").click();
  const dlg = page.getByTestId("comparison-dialog");
  await dlg.getByRole("radio", { name: "12 mois" }).click();
  await dlg.getByLabel(/^FaZe/).check();
  await dlg.getByTestId("comparison-apply").click();
  await expect(page.getByTestId("ctx-comparison")).toContainText("FaZe · 12 mois");
  await expect(page.getByTestId("players-reference")).toBeVisible();
  await page.getByTestId("player-row").first().getByRole("link").click();
  await expect(page.locator(".comp").first()).toContainText("Comp.");
  await page.screenshot({ path: "test-results/shots/context-bar.png", fullPage: true });
  // mode « vous-même » : un seul match dans la bibliothèque, donc pas de forme passée, et pas d'erreur
  await page.getByTestId("ctx-edit-comparison").click();
  await page.getByTestId("comparison-dialog").getByRole("radio", { name: "Vous-même" }).click();
  await page.getByTestId("comparison-apply").click();
  await expect(page.getByTestId("ctx-comparison")).toContainText("vous-même");
  await expect(page.locator(".comp")).toHaveCount(0);
});

test("rôles EDGE et postes : colonne, filtre et postes par carte", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/players");
  await expect(page.getByTestId("player-row")).toHaveCount(10);
  // la fixture n'a des positions que pour quelques rounds : pas de rôle EDGE attribué (règle des 6 rounds), pas d'erreur
  await expect(page.locator(".pl-rolecell").first()).toBeVisible();
  const bar = page.getByTestId("context-bar");
  await bar.getByLabel("Rôle", { exact: true }).selectOption("anchor");
  await expect(page).toHaveURL(/role=anchor/);
  await expect(page.getByTestId("player-row")).toHaveCount(0);
  await bar.getByLabel("Rôle", { exact: true }).selectOption("");
  await page.getByTestId("player-row").first().getByRole("link").click();
  await page.getByRole("tab", { name: "Détails" }).click();
  await expect(page.getByTestId("player-positions")).toContainText("Nuke");
  await expect(page.getByTestId("player-positions")).toContainText("polyvalent");
});

test("fiche joueur : six onglets (intro, rôles, armes, achats, cartes, officiel vs entraînement)", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/players");
  await page.getByTestId("player-row").first().getByRole("link").click();
  await expect(page.getByTestId("player-tabs").getByRole("tab")).toHaveCount(7);
  await expect(page.getByTestId("recent-performance")).toContainText("Nuke");
  await expect(page.getByTestId("progression")).toContainText("Il faut plus de 20 matchs");
  await page.getByRole("tab", { name: "Rôles" }).click();
  await expect(page.getByTestId("role-radar")).toBeVisible();
  await expect(page).toHaveURL(/tab=roles/);
  await page.getByRole("tab", { name: "Armes" }).click();
  await expect(page.getByTestId("classes-table")).toBeVisible();
  await page.getByRole("tab", { name: "Achats" }).click();
  await expect(page.getByTestId("buytypes-table")).toContainText("Pistol vs Pistol");
  await page.getByRole("tab", { name: "Cartes" }).click();
  await expect(page.getByTestId("map-card")).toHaveCount(1);
  await expect(page.getByTestId("maps-table")).toContainText("Nuke");
  await page.getByRole("tab", { name: "Officiel vs entraînement" }).click();
  await expect(page.getByTestId("kinds")).toContainText("Entraînement (1 m · 23 r)");
  await page.getByRole("tab", { name: "Détails" }).click();
  await expect(page.getByTestId("history-row")).toHaveCount(1);
  await page.screenshot({ path: "test-results/shots/player-tabs.png", fullPage: true });
});

test("stats d'équipe : vue d'ensemble, joueurs, positions, sites, cartes", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/team-stats");
  await expect(page.getByText("Choisissez une équipe")).toBeVisible();
  await page.getByLabel("Équipe à analyser").selectOption({ label: "FaZe (1)" });
  await expect(page).toHaveURL(/team=\d+/);
  await expect(page.getByTestId("tst-map")).toHaveCount(1);
  await expect(page.getByTestId("tst-map")).toContainText("Nuke");
  await expect(page.getByTestId("tst-player")).toHaveCount(5);
  await expect(page.getByTestId("tst-overall")).toContainText("Rounds gagnés");
  await page.getByRole("tab", { name: "Joueurs" }).click();
  await expect(page.getByTestId("tst-performance").locator("tbody tr")).toHaveCount(6);
  await expect(page.getByTestId("tst-opening")).toContainText("Total");
  await expect(page.getByTestId("tst-clutch")).toContainText("1v5");
  await page.getByRole("tab", { name: "Positions" }).click();
  await expect(page.getByText("Choisissez une carte")).toBeVisible();
  await page.getByTestId("context-bar").getByLabel("Carte", { exact: true }).selectOption("de_nuke");
  await expect(page.getByTestId("tst-positions-CT")).toContainText("Positions de départ");
  await page.getByRole("tab", { name: "Sites" }).click();
  await expect(page.getByTestId("tst-tempo")).toContainText("1:55–1:30");
  await expect(page.getByTestId("tst-defense")).toContainText("Retakes gagnés");
  await page.getByRole("tab", { name: "Cartes" }).click();
  await expect(page.getByTestId("tst-maps")).toContainText("Nuke");
  // lien depuis la fiche de scouting
  await page.goto("/scouting");
  await page.getByTestId("scout-team").first().click();
  await page.getByTestId("ts-stats").click();
  await expect(page).toHaveURL(/\/team-stats\?team=/);
  await expect(page.getByTestId("tst-tabs")).toBeVisible();
});

test("playbook v2 : éditeur de tactique, détection, round par round, gestion", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/playbook");
  await expect(page.getByText("Choisissez une équipe et une carte")).toBeVisible();
  // la fixture n'a des trames que pour quelques rounds : on prend l'équipe qui a des rounds T observables
  const teams: { id: number; name: string }[] = await (await page.request.get("/api/teams")).json();
  let team = teams[0];
  for (const t of teams) if ((await (await page.request.get(`/api/playbook/${t.id}?map=de_nuke&side=T`)).json()).total > 0) team = t;
  await page.getByLabel("Équipe du playbook").selectOption({ label: team.name });
  await page.getByLabel("Carte du playbook").selectOption("de_nuke");
  await expect(page.getByTestId("pb2-tabs")).toBeVisible();
  await expect(page.getByTestId("pb2-category").first()).toBeVisible();  // classes automatiques
  // nouvelle tactique : zone immense (toute la carte) → vraie dans chaque round observé
  await page.getByTestId("pb2-new").click();
  await expect(page.getByTestId("tactic-editor")).toBeVisible();
  await page.getByTestId("tactic-name").fill("Partout e2e");
  const box = (await page.getByTestId("tactic-map").boundingBox())!;
  for (const [fx, fy] of [[0.1, 0.2], [0.9, 0.2], [0.9, 0.9], [0.1, 0.9]]) await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
  await expect(page.getByTestId("tactic-condition").first()).toContainText("4 points");
  await page.getByTestId("tactic-save").click();
  await expect(page).toHaveURL(/tab=manage/);
  await expect(page.getByTestId("pb2-manage-row")).toHaveCount(1);
  await expect(page.getByTestId("pb2-manage")).toContainText("Partout e2e");
  await page.getByRole("tab", { name: "Tactiques" }).click();
  const row = page.getByTestId("pb2-tactic").filter({ hasText: "Partout e2e" });
  await expect(row).toHaveCount(1);
  await row.locator(".pb2-name").click();
  await expect(page.getByTestId("pb2-rounds-of")).toBeVisible();
  await page.getByRole("tab", { name: "Round par round" }).click();
  await expect(page.getByTestId("pb2-round").first()).toBeVisible();
  // en T, colonne « Prise » (heure de la prise du site à l'horloge du jeu et site pris) et fin du default sur la puce
  // « Default (auto) » du R3 de 3DMAX
  await expect(page.getByTestId("pb2-rounds").getByRole("columnheader", { name: "Prise", exact: true })).toBeVisible();
  await expect(page.getByTestId("pb2-round").filter({ hasText: /Default \(auto\) · puis (exécution|prise)/ })).toHaveCount(1);
  await expect(page.getByTestId("pb2-round").filter({ hasText: /\d:\d\d · [AB]/ }).first()).toBeVisible();
  // suppression
  await page.getByRole("tab", { name: "Gérer" }).click();
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Supprimer Partout e2e" }).click();
  await expect(page.getByTestId("pb2-manage-row")).toHaveCount(0);
});

test("pattern finder : zone + filtres, négation, enregistrer comme tactique", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/pattern-finder");
  await expect(page.getByText("Choisissez une équipe et une carte")).toBeVisible();
  const teams: { id: number; name: string }[] = await (await page.request.get("/api/teams")).json();
  let team = teams[0];
  for (const t of teams) if ((await (await page.request.get(`/api/playbook/${t.id}?map=de_nuke&side=T`)).json()).total > 0) team = t;
  await page.getByLabel("Équipe à analyser").selectOption({ label: team.name });
  await page.getByLabel("Carte à analyser").selectOption("de_nuke");
  // sans motif : tous les rounds T observés
  await expect(page.getByTestId("pf-replay")).toContainText(/Rejouer (\d+)\/\1 rounds/);
  await expect(page.getByTestId("pf-rounds").locator("li").first()).toBeVisible();
  // zone de joueurs immense → toujours tous les rounds
  await page.getByRole("tab", { name: "Joueurs" }).click();
  await page.getByTestId("pf-add-players").click();
  const box = (await page.getByTestId("pf-map").boundingBox())!;
  for (const [fx, fy] of [[0.1, 0.2], [0.9, 0.2], [0.9, 0.9], [0.1, 0.9]]) await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
  await expect(page.getByTestId("pf-zone").first()).toContainText("4 pts");
  await expect(page.getByTestId("pf-replay")).toContainText(/Rejouer (\d+)\/\1 rounds/);
  // négation → plus rien
  await page.getByRole("tab", { name: "Rounds" }).click();
  await page.getByTestId("pf-negate").check();
  await expect(page.getByTestId("pf-replay")).toContainText(/Rejouer 0\/\d+ rounds/);
  await expect(page.getByText("Aucun round ne correspond")).toBeVisible();
  await page.getByTestId("pf-negate").uncheck();
  // enregistrer comme tactique → éditeur prérempli
  await page.getByTestId("pf-save").click();
  await expect(page.getByTestId("tactic-editor")).toBeVisible();
  await expect(page.getByTestId("tactic-condition").first()).toContainText("4 points");
});

test("replay EDGE : préférences, mode M, overlay, GIF, voix par joueur, séquenceur, lien public", async ({ page, browser }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const HUGE = [[-20000, -20000], [20000, -20000], [20000, 20000], [-20000, 20000]];
  const tactic = await (await page.request.post("/api/tactics", { data: { name: "Partout H", map: "de_nuke", side: "T",
    definition: { conditions: [{ kind: "players_in_zone", zone: HUGE, min_players: 1 }] } } })).json();
  await page.goto("/matches/1/replay/2?t=6500");
  await expect(page.getByTestId("radar")).toBeVisible();
  // préférences nommées et persistées
  await page.getByTestId("prefs-open").click();
  await expect(page.getByTestId("prefs-dialog")).toBeVisible();
  await page.getByTestId("pref-solidTeammates").check();
  await page.getByTestId("pref-bombsite").check();
  await page.getByRole("button", { name: "Terminé" }).click();
  await page.reload();
  await expect(page.getByTestId("radar")).toBeVisible();
  await page.getByTestId("prefs-open").click();
  await expect(page.getByTestId("pref-solidTeammates")).toBeChecked();
  await expect(page.getByTestId("pref-bombsite")).toBeChecked();
  await page.getByTestId("pref-bombsite").uncheck();
  await page.getByRole("button", { name: "Terminé" }).click();
  // overlay de site au clavier (O), mode déplacement des joueurs (M)
  await page.mouse.click(700, 500);
  await page.keyboard.press("o");
  await page.getByTestId("prefs-open").click();
  await expect(page.getByTestId("pref-bombsite")).toBeChecked();
  await page.getByRole("button", { name: "Terminé" }).click();
  await page.mouse.click(700, 500);
  await page.keyboard.press("m");
  await expect(page.locator(".radar-canvas.tool-players")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator(".rp-radar").screenshot({ path: "test-results/shots/replay-overlay.png" });
  // séquence des tactiques du round (tactique définie ci-dessus, vraie dans tout round observé)
  await expect(page.getByTestId("tactics-strip")).toContainText("Partout H");
  await page.getByTestId("tactics-strip").getByRole("listitem").first().click();
  // piste vocale rattachée à un joueur
  await page.getByTestId("comms-toggle").click();
  await page.getByLabel("Nom de la piste").fill("karrigan");
  await page.getByTestId("comms-file").setInputFiles({ name: "voice.wav", mimeType: "audio/wav", buffer: silentWav(300) });
  await expect(page.getByTestId("comms-track")).toContainText("karrigan", { timeout: 20_000 });
  await page.getByTestId("comms-player").selectOption({ index: 1 });
  await expect(page.getByTestId("comms-track").locator(".comms-player")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByTestId("comms-toggle").click();
  // GIF : court, petit
  await page.getByTestId("gif-open").click();
  await expect(page.getByTestId("gif-dialog")).toBeVisible();
  await page.getByRole("button", { name: "3 s" }).click();
  await page.getByRole("button", { name: "10", exact: true }).click();
  await page.getByRole("button", { name: "480 px" }).click();
  await page.getByTestId("gif-record").click();
  await expect(page.getByTestId("gif-download")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("gif-download")).toHaveAttribute("download", /\.gif$/);
  await page.getByRole("button", { name: "Fermer" }).last().click();
  // lien public : créé depuis le menu Partager, ouvert sans session dans un autre navigateur
  await page.getByTestId("share-open").click();
  await page.getByTestId("share-public").click();
  await expect(page.getByTestId("share-url")).toHaveValue(/\/s\/[\w-]+$/);
  await page.keyboard.press("Escape");
  const link = await (await page.request.post("/api/share", { data: { match_id: 1, round_number: 2, tick: 6500, layers: [] } })).json();
  const ctx = await browser.newContext();
  const pub = await ctx.newPage();
  await pub.goto(link.url);
  await expect(pub.getByTestId("radar")).toBeVisible();
  await expect(pub.getByTestId("share-round").first()).toBeVisible();
  await pub.getByTestId("share-round").nth(2).click();
  await expect(pub).toHaveURL(/r=3/);
  await expect(pub.getByTestId("round-clock")).toBeVisible();
  await pub.screenshot({ path: "test-results/shots/share.png" });
  await ctx.close();
  await page.request.delete(`/api/tactics/${tactic.id}`);
});

test("bibliothèque : sélection ergonomique, dossier et playlist en lot, filtre équipe", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await expect(page.getByTestId("match-row")).toHaveCount(1);
  // la zone de sélection est large ; une fois une ligne cochée, cliquer la ligne coche / décoche au lieu d'ouvrir le match
  await page.locator(".match-select").first().click();
  await expect(page.getByTestId("selection-bar")).toContainText("1 match sélectionné");
  await page.getByTestId("match-row").first().click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("selection-bar")).toHaveCount(0);
  await page.getByTestId("match-row").first().click({ position: { x: 160, y: 30 } });  // sans sélection : ouvre le match
  await expect(page).toHaveURL(/\/matches\/\d+$/);
  await page.goBack();
  // dossier en lot
  await page.getByTestId("match-check").first().check();
  await page.getByTestId("bulk-folder-open").click();
  await page.getByTestId("bulk-folder").selectOption("__new");
  await page.getByLabel("Nouveau dossier").fill("Officiels");
  await page.getByTestId("bulk-folder-apply").click();
  await expect(page.locator(".notice")).toContainText("placé(s) dans « Officiels »");
  await expect(page.getByTestId("match-row")).toContainText("Officiels");
  // la sélection survit à un aller-retour ; playlist à partir du match entier
  await page.goto("/matches/1");
  await page.goBack();
  await expect(page.getByTestId("selection-bar")).toContainText("1 match sélectionné");
  await page.getByTestId("add-to-playlist").click();
  await page.getByLabel("Nom de la nouvelle playlist").fill("Match entier");
  await page.getByRole("button", { name: "Créer" }).click();
  await expect(page.locator(".notice")).toContainText("23 round(s) ajouté(s)");
  await page.getByRole("button", { name: "Tout désélectionner" }).click();
  // filtre équipe
  await page.getByTestId("lib-team").selectOption({ label: "FaZe (1)" });
  await expect(page.getByTestId("match-row")).toHaveCount(1);
  await expect(page).toHaveURL(/team=\d+/);
  await page.getByRole("button", { name: "Effacer" }).click();
  await expect(page).not.toHaveURL(/team=/);
  await page.screenshot({ path: "test-results/shots/library-bulk.png" });
});

test("playlists EDGE : dossiers, favoris, étiquettes ; match : démo et lien public ; replay : ajout à une playlist", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.request.post("/api/playlists", { data: { name: "Anti-eco A", folder: "Attaque", tags: ["eco"] } });
  await page.request.post("/api/playlists", { data: { name: "Retakes B", favorite: true } });
  await page.goto("/playlists");
  const cards = page.getByTestId("playlist-card");
  await expect(cards.filter({ hasText: "Anti-eco A" })).toHaveCount(1);
  await page.getByTestId("pls-rail").filter({ hasText: "Favoris" }).click();
  await expect(cards.filter({ hasText: "Retakes B" })).toHaveCount(1);
  await expect(cards.filter({ hasText: "Anti-eco A" })).toHaveCount(0);
  await page.getByTestId("pls-rail").filter({ hasText: "Attaque" }).click();
  await expect(cards).toHaveCount(1);
  await expect(cards).toContainText("Anti-eco A");
  await expect(cards).toContainText("#eco");
  await page.getByTestId("pls-star").click();
  await page.getByTestId("pls-rail").filter({ hasText: "Favoris" }).click();
  await expect(cards.filter({ hasText: "Anti-eco A" })).toHaveCount(1);
  await page.getByLabel("Étiquette de playlist").selectOption("eco");
  await expect(cards).toHaveCount(1);
  await page.screenshot({ path: "test-results/shots/playlists-folders.png" });
  // fiche playlist : modifier dossier et étiquettes
  await page.getByTestId("playlist-card").click();
  await page.getByTestId("pl-edit").click();
  await page.getByLabel("Dossier de la playlist").selectOption("__new");
  await page.getByLabel("Nouveau dossier").fill("Défense");
  await page.getByLabel("Étiquettes").fill("eco, retake");
  await page.getByRole("button", { name: "Enregistrer" }).click();
  await expect(page.locator(".pl-hero")).toContainText("Défense");
  await expect(page.locator(".pl-hero")).toContainText("#retake");
  // page match : démo téléchargeable, lien public
  await page.goto("/matches/1");
  await expect(page.getByTestId("demo-download")).toHaveAttribute("href", /\/api\/demos\/\d+\/file/);
  await page.getByTestId("match-share").click();
  await expect(page.getByTestId("match-share-url")).toHaveValue(/\/s\/[\w-]+$/);
  // replay : ce round dans une playlist
  await page.goto("/matches/1/replay/2");
  await expect(page.getByTestId("radar")).toBeVisible();
  await page.getByTestId("add-to-playlist").click();
  await page.getByRole("menuitem", { name: /Retakes B/ }).click();
  await expect(page.getByTestId("bookmark-toast")).toContainText("1 round(s) ajouté(s)");
});

test("match prep : template à widgets, rapport généré, notes, impression", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/match-prep");
  await expect(page.getByText("Aucun rapport généré")).toBeVisible();
  // template personnalisé
  await page.getByTestId("prep-tab-templates").click();
  await expect(page.getByTestId("prep-tpl")).toHaveCount(1);  // « Rapport standard »
  await page.getByTestId("prep-tpl-new").click();
  await page.getByLabel("Nom du modèle").fill("Court");
  await page.getByLabel("Widget à ajouter").selectOption("reads");
  await page.getByTestId("prep-add-widget").click();
  await page.getByLabel("Widget à ajouter").selectOption("players");
  await page.getByTestId("prep-add-widget").click();
  await page.getByLabel("Widget à ajouter").selectOption("notes");
  await page.getByTestId("prep-add-widget").click();
  await page.getByLabel("Texte des notes").fill("Rappel : smoke mid à 1:40");
  await expect(page.getByTestId("prep-widget")).toHaveCount(3);
  await page.getByTestId("prep-tpl-save").click();
  await expect(page.getByTestId("prep-tpl")).toHaveCount(2);
  await expect(page.getByTestId("prep-tpl").filter({ hasText: "Court" })).toContainText("Lectures tactiques");
  // rapport généré : adversaire + carte + template
  await page.getByTestId("prep-new").click();
  await page.getByTestId("prep-team").selectOption({ label: "FaZe (1 match)" });
  await page.getByTestId("prep-map").selectOption("de_nuke");
  await page.getByTestId("prep-template").selectOption({ label: "Court (3 widgets)" });
  await page.getByTestId("prep-generate").click();
  await expect(page).toHaveURL(/\/match-prep\/\d+$/);
  await expect(page.getByTestId("prep-report")).toContainText("FaZe · Nuke");
  await expect(page.getByTestId("prep-widget-view")).toHaveCount(3);
  await expect(page.getByTestId("prep-widget-view").nth(2)).toContainText("smoke mid à 1:40");
  await page.getByTestId("prep-notes").fill("Jouer B lent");
  await page.getByTestId("prep-notes-save").click();
  await expect(page.getByTestId("prep-notes-save")).toContainText("Enregistré");
  await page.screenshot({ path: "test-results/shots/prep-report.png", fullPage: true });
  await page.emulateMedia({ media: "print" });
  await expect(page.getByTestId("prep-print")).toBeHidden();
  await page.emulateMedia({ media: "screen" });
  // liste des rapports
  await page.goto("/match-prep");
  await expect(page.getByTestId("prep-report-row")).toHaveCount(1);
  await expect(page.getByTestId("prep-report-row")).toContainText("Nuke");
});

test("veto EDGE : ordre et swap, timeline avec prédictions et override, statistiques, scénarios, vetos enregistrés", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/veto?format=bo1");
  await expect(page.getByTestId("veto-map")).toHaveCount(7);
  await expect(page.getByTestId("veto-order")).toHaveCount(3);
  await page.getByTestId("veto-order").filter({ hasText: "AABBBA" }).click();
  await expect(page).toHaveURL(/order=AABBBA/);
  await expect(page.getByTestId("veto-tl-step")).toHaveCount(6);
  await expect(page.getByTestId("veto-tl-step").nth(1)).toHaveClass(/\ba\b/);  // AABBBA : la 2e étape est aussi à « a »
  await page.getByTestId("veto-swap").click();
  await expect(page.getByTestId("veto-tl-step").nth(0)).toHaveClass(/\bb\b/);
  // prédiction : la première étape propose des cartes avec un libellé ; appliquer la première
  const firstPred = page.getByTestId("veto-tl-step").nth(0).locator(".veto-pred").first();
  await expect(firstPred).toContainText(/Très probable|Probable|Possible/);
  await firstPred.click();
  await expect(page.getByTestId("veto-log").locator("li")).toHaveCount(1);
  // override de l'étape 1 : on change la carte, les étapes suivantes repartent à zéro
  await page.getByTestId("veto-auto").click();
  await expect(page.getByTestId("veto-log").locator("li")).toHaveCount(7);
  await page.getByLabel("Modifier l'étape 1").selectOption({ index: 1 });
  await expect(page.getByTestId("veto-log").locator("li")).toHaveCount(1);
  // statistiques Pick / Ban / Played
  await page.getByTestId("veto-tab-stats").click();
  await expect(page.getByTestId("veto-stats").locator("tbody tr")).toHaveCount(7);
  // vetos enregistrés : saisie d'un BO1 complet, puis les habitudes apparaissent dans les statistiques
  await page.getByTestId("veto-tab-records").click();
  await page.getByTestId("veto-rec-new").click();
  const names = ["Ancient", "Anubis", "Cache", "Dust II", "Inferno", "Mirage"];
  for (let k = 0; k < 6; k++) await page.getByLabel(`Étape ${k + 1}`).selectOption({ label: names[k] });
  await page.getByLabel("Note").fill("e2e");
  await page.getByTestId("veto-rec-save").click();
  await expect(page.getByTestId("veto-rec")).toHaveCount(1);
  await expect(page.getByTestId("veto-rec")).toContainText("Nuke");
  await page.getByTestId("veto-tab-stats").click();
  await expect(page.getByTestId("veto-stats")).toContainText("100 %");
  // scénarios
  await page.getByTestId("veto-tab-scenarios").click();
  await expect(page.getByTestId("veto-scenarios").locator("tbody tr").first()).toBeVisible();
  await page.getByTestId("veto-threshold").fill("0.25");
  await page.screenshot({ path: "test-results/shots/veto-scenarios.png", fullPage: true });
  await page.getByTestId("veto-tab-records").click();
  await page.getByRole("button", { name: "Supprimer ce veto" }).click();
  await expect(page.getByTestId("veto-rec")).toHaveCount(0);
});

test("scouting de joueurs : filtres par carte et rôle, HLTV relatif, shortlists, recherches récentes", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/scouting/players");
  await expect(page.getByTestId("ps-row")).toHaveCount(10);
  await expect(page.getByTestId("ps-role-t")).toBeDisabled();
  await page.getByTestId("ps-map").selectOption("de_nuke");
  await expect(page.getByTestId("ps-role-t")).toBeEnabled();
  await expect(page.getByTestId("ps-table")).toContainText("Rôles (Nuke)");
  await page.getByLabel("HLTV minimum").fill("1.2");
  await expect(page).toHaveURL(/min_rating=1\.2/);
  await expect(page.getByTestId("ps-row")).not.toHaveCount(10);  // la liste se recharge avec le filtre
  const n = await page.getByTestId("ps-row").count();
  expect(n).toBeGreaterThan(0);
  // shortlist depuis la première ligne
  await page.getByTestId("ps-add").first().click();
  await page.getByLabel("Nom de la nouvelle liste").fill("AWP à recruter");
  await page.getByRole("button", { name: "Créer" }).click();
  await expect(page.getByTestId("ps-shortlist")).toHaveCount(1);
  await page.getByTestId("ps-shortlist").getByRole("button").first().click();
  await expect(page.getByTestId("ps-item")).toHaveCount(1);
  await page.getByTestId("ps-item").getByRole("textbox").fill("bon sur Nuke");
  await page.getByTestId("ps-item").getByRole("textbox").blur();
  await page.reload();
  await page.getByTestId("ps-shortlist").getByRole("button").first().click();
  await expect(page.getByTestId("ps-item").getByRole("textbox")).toHaveValue("bon sur Nuke");
  await page.screenshot({ path: "test-results/shots/scout-players.png", fullPage: true });
  await page.getByRole("button", { name: /^Retirer / }).click();
  await expect(page.getByTestId("ps-item")).toHaveCount(0);
  await page.getByRole("button", { name: "Supprimer la liste" }).click();
  await expect(page.getByTestId("ps-shortlist")).toHaveCount(0);
  // recherches récentes
  await expect(page.getByText("Recherches récentes")).toBeVisible();
});

test("scouting → replay → retour au scouting ; match prep : sites, zones, après le plant", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/scouting");
  await page.getByTestId("scout-team").filter({ hasText: "FaZe" }).click();
  await expect(page.getByTestId("ts-takeaways")).toBeVisible();
  await page.getByRole("radio", { name: "Avancé" }).click();
  const scoutUrl = page.url();
  // un round cité : « Revoir (n) » puis R<k> → replay avec un lien de retour « Scouting »
  await page.locator(".ts-linkbtn").first().click();
  await page.locator(".ts-round").first().click();
  await expect(page.getByTestId("replay-back")).toContainText("Scouting");
  if (await page.getByTestId("radar").count()) {  // round avec positions : le lien survit au changement de round
    await page.keyboard.press("n");
    await expect(page.getByTestId("replay-back")).toContainText("Scouting");
  }
  await page.getByTestId("replay-back").click();
  await expect(page).toHaveURL(scoutUrl);
  await expect(page.getByTestId("ts-takeaways")).toBeVisible();
  // chiffres clés en tuiles, puis filtre « armés contre armés »
  await expect(page.getByTestId("ts-kpis").locator(".ts-kpi")).toHaveCount(8);
  await page.getByRole("radio", { name: "Armés contre armés" }).click();
  await expect(page).toHaveURL(/armed=1/);
  await expect(page.locator(".ts-legend")).toContainText("armés contre armés");
  await page.getByTestId("ts-tab-carte").click();
  await expect(page.getByTestId("ts-styles")).toBeVisible();
  await expect(page.getByText("Pistols et économie")).toHaveCount(0);  // sans pistols en mode armés contre armés
  await page.getByRole("radio", { name: "Tous les rounds" }).click();
  // match prep avec le template standard : sites visés, zones prises, après le plant
  const faze = (await (await page.request.get("/api/scouting/teams")).json()).find((t: { name: string }) => t.name === "FaZe");
  const tpl = (await (await page.request.get("/api/prep/templates")).json())[0];
  const rep = await (await page.request.post("/api/prep/reports", { data: { team_id: faze.id, map: "de_nuke", template_id: tpl.id } })).json();
  await page.goto(`/match-prep/${rep.id}`);
  await expect(page.getByTestId("prep-widget-view")).toHaveCount(12);
  await expect(page.locator("[data-type=sites]")).toContainText("Plant A");
  await expect(page.locator("[data-type=zones]")).toContainText("Zones qu'ils prennent");
  await expect(page.locator("[data-type=postplant]")).toContainText("Après avoir posé");
  await page.locator("[data-type=sites]").screenshot({ path: "test-results/shots/prep-sites.png" });
  // widget d'attaque de 3DMAX (seule équipe avec des rounds T positionnés) : fin du default du R3, heure de la prise du site
  const dmax = (await (await page.request.get("/api/scouting/teams")).json()).find((t: { name: string }) => t.name === "3DMAX");
  const rep2 = await (await page.request.post("/api/prep/reports", { data: { team_id: dmax.id, map: "de_nuke", template_id: tpl.id } })).json();
  await page.goto(`/match-prep/${rep2.id}`);
  await expect(page.getByTestId("prep-widget-view")).toHaveCount(12);
  await expect(page.locator("[data-type=attack]")).toContainText(/puis (exécution|prise) 1/);
  await expect(page.locator("[data-type=attack]")).toContainText(/prise du site [AB] vers \d:\d\d/);
});

test("débrief de match : phases, rounds à revoir, conclusions par équipe, axe de travail suivi", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const m = await (await page.request.get("/api/matches/1")).json();
  const tid = m.team_a.id as number;
  await page.goto(`/matches/1?tab=debrief&team=${tid}`);
  await expect(page.getByTestId("db-phases")).toContainText("Pistols gagnés");
  const n = await page.getByTestId("db-round").count();
  expect(n).toBeGreaterThan(0);
  expect(n).toBeLessThanOrEqual(5);
  await expect(page.getByTestId("db-overlay")).toHaveAttribute("href", /\/matches\/1\/replay\/\d+\?.*from=/);
  // conclusions écrites, gardées par équipe
  const stamp = `e2e ${Date.now()}`;
  await page.getByTestId("db-note-worked").fill(stamp);
  await page.getByTestId("db-save").click();
  await expect(page.getByText(/Enregistré le/)).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("db-note-worked")).toHaveValue(stamp);
  await page.getByTestId("debrief").getByRole("radio", { name: m.team_b.name }).click();
  await expect(page.getByTestId("db-note-worked")).not.toHaveValue(stamp);
  // un point à travailler devient un axe (quand le match en signale un)
  await page.goto(`/matches/1?tab=debrief&team=${tid}`);
  if (await page.getByTestId("db-make-goal").count()) {
    await page.getByTestId("db-make-goal").first().click();
    await expect(page.getByTestId("db-issues").getByText("Axe de travail en cours").first()).toBeVisible();
  }
  // page des axes : création, suivi avant / après, fin, suppression
  await page.goto(`/goals?team=${tid}`);
  await page.getByTestId("goal-metric").selectOption("avoidable");
  await page.getByTestId("goal-title").fill(stamp);
  await page.getByTestId("goal-create").click();
  const card = page.getByTestId("goal-card").filter({ hasText: stamp });
  await expect(card).toBeVisible();
  await expect(card.getByTestId("goal-status")).toContainText("En attente d'un match");
  await card.getByTestId("goal-archive").click();
  await expect(card).toHaveCount(0);
  await page.getByRole("tab", { name: "Terminés" }).click();
  await expect(page.getByTestId("goal-card").filter({ hasText: stamp })).toBeVisible();
  // nettoyage : la base e2e est réutilisée d'un lancement à l'autre
  for (const archived of [false, true]) {
    for (const g of await (await page.request.get(`/api/teams/${tid}/goals${archived ? "?archived=true" : ""}`)).json()) await page.request.delete(`/api/goals/${g.id}`);
  }
  // phases tirées du playbook (3DMAX, seule équipe avec des rounds T positionnés) : « Defaults avec prise du site » pour
  // le R3 ; pas de ligne sur la rotation CT, non mesurable sur Nuke (sites A et B superposés)
  const dm = [m.team_a, m.team_b].find((t: { name: string }) => t.name === "3DMAX");
  await page.goto(`/matches/1?tab=debrief&team=${dm.id}`);
  await expect(page.getByTestId("db-phases")).toContainText("Defaults avec prise du site");
  await expect(page.getByTestId("db-phases")).not.toContainText("Pressions qui ont fait tourner un CT");
});

test("callouts : zones éditables (renommer, dessiner, déplacer un point, masquer, réinitialiser)", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/callouts?map=de_mirage");
  await expect(page.getByTestId("zone-shape").first()).toBeVisible();
  const total = await page.getByTestId("zone-shape").count();
  expect(total).toBeGreaterThanOrEqual(30);
  // renommer Window
  await page.getByLabel("Nom de la zone Window").fill("Fenêtre");
  await page.getByTestId("zone-save").click();
  await expect(page.getByRole("status")).toContainText("Zones enregistrées");
  // dessiner une zone : trois coins, puis clic sur le premier pour fermer
  const box = (await page.getByTestId("zone-map").boundingBox())!;
  const at = (fx: number, fy: number) => [box.x + box.width * fx, box.y + box.height * fy] as const;
  await page.getByTestId("zone-new").click();
  for (const [fx, fy] of [[0.04, 0.04], [0.12, 0.04], [0.08, 0.12], [0.04, 0.04]]) await page.mouse.click(...at(fx, fy));
  await expect(page.getByTestId("zone-shape")).toHaveCount(total + 1);
  await page.getByLabel(/^Nom de la zone Zone \d+$/).fill("Coin test");
  // déplacer un point de la zone sélectionnée
  const v = page.getByTestId("zone-vertex").first();
  const vb = (await v.boundingBox())!;
  await page.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2);
  await page.mouse.down();
  await page.mouse.move(vb.x + 40, vb.y + 30, { steps: 4 });
  await page.mouse.up();
  await page.getByTestId("zone-save").click();
  await expect(page.getByRole("status")).toContainText("Zones enregistrées");
  const saved = await (await page.request.get("/api/maps/de_mirage/zones")).json();
  expect(saved.edited).toBe(true);
  const coin = saved.zones.find((z: { name: string }) => z.name === "Coin test");
  expect(coin.poly).toHaveLength(3);
  expect(saved.zones.some((z: { name: string }) => z.name === "Fenêtre")).toBe(true);
  // après rechargement : gardé pour l'équipe ; l'œil masque une zone (dans ce navigateur)
  await page.reload();
  await expect(page.getByLabel("Nom de la zone Fenêtre")).toBeVisible();
  await page.getByRole("button", { name: "Masquer Fenêtre" }).click();
  await expect(page.getByTestId("zone-shape")).toHaveCount(total);
  await page.reload();
  await expect(page.getByTestId("zone-shape")).toHaveCount(total);
  await page.getByRole("button", { name: "Afficher Fenêtre" }).click();
  // réinitialiser : retour aux zones de Sightline
  await page.getByTestId("zone-reset").click();
  await page.getByRole("button", { name: "Réinitialiser", exact: true }).click();
  await expect(page.getByLabel("Nom de la zone Window")).toBeVisible();
  await expect(page.getByTestId("zone-shape")).toHaveCount(total);
  // l'autre onglet garde le renommage des lieux du jeu et les callouts placés à la main
  await page.getByTestId("view-places").click();
  await expect(page.getByTestId("place-callout")).toBeVisible();
});

test("stratbook : calques Joueurs / Grenades / Tracés et focus sur un joueur", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const path = (i: number, x: number) => ({ id: `pracc-path-${i}`, tool: "pen", color: "#2ee6a6", width: 3, level: "default", points: [[x, 500], [x + 40, 420], [x + 60, 380]] });
  const created = await (await page.request.post("/api/strats", { data: {
    name: "Calques test", map: "de_nuke", side: "T", tags: ["pracc"],
    positions: [{ name: "Alpha", role: "", pos: [-400, -1200, -416], yaw: 0 }, { name: "Bravo", role: "", pos: [200, -900, -416], yaw: 0 }],
    grenades: [{ type: "smoke", player: "Alpha", throw: [-400, -1200, -416], land: [-200, -800, -416], trajectory: [] },
               { type: "flash", player: "Bravo", throw: [200, -900, -416], land: [300, -700, -416], trajectory: [] }],
    shapes: [path(0, 400), path(1, 520)],
  } })).json();
  await page.goto(`/stratbook/${created.id}`);
  await expect(page.getByTestId("strat-shape")).toHaveCount(2);
  // calque Tracés : retiré puis remis, et mémorisé
  await page.getByTestId("layer-paths").click();
  await expect(page.getByTestId("strat-shape")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("strat-position")).toHaveCount(2);
  await expect(page.getByTestId("strat-shape")).toHaveCount(0);
  await page.getByTestId("layer-paths").click();
  await expect(page.getByTestId("strat-shape")).toHaveCount(2);
  // focus : un joueur de la liste, son tracé en plein, celui de l'autre estompé ; ses grenades seules en clair
  await page.getByTestId("sb-tab-players").click();
  await page.getByTestId("strat-player").filter({ hasText: "Bravo" }).click();
  await expect(page.getByTestId("focus-clear")).toContainText("Bravo");
  const opacity = (i: number) => page.getByTestId("strat-shape").nth(i).locator("xpath=..").getAttribute("opacity");
  expect(await opacity(0)).toBe("0.12");
  expect(await opacity(1)).toBe("1");
  await page.getByTestId("sb-tab-grenades").click();
  await expect(page.getByTestId("strat-grenades").locator("li").nth(0)).toHaveClass(/sb-faded/);
  await expect(page.getByTestId("strat-grenades").locator("li").nth(1)).not.toHaveClass(/sb-faded/);
  await page.getByTestId("focus-clear").click();
  expect(await opacity(0)).toBe("1");
  // calque Grenades
  await page.getByTestId("layer-grenades").click();
  await expect(page.getByTestId("strat-map").locator(".sb-gnum")).toHaveCount(0);
  await page.getByTestId("layer-grenades").click();
  await page.request.delete(`/api/strats/${created.id}`);
});

test("stratbook : une seule page — liste T/CT, changer de stratégie sans changer de page, onglets, ancienne adresse", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const mk = async (name: string, side: "T" | "CT", type: string, grenades: number) => (await (await page.request.post("/api/strats", { data: {
    name, map: "de_ancient", side, type,
    positions: [{ name: "Alpha", role: "entry", pos: [-400, -1200, 0], yaw: 0 }],
    grenades: Array.from({ length: grenades }, () => ({ type: "smoke", player: "Alpha", throw: [-400, -1200, 0], land: [-300, -900, 0], trajectory: [] })),
  } })).json()).id as number;
  const a = await mk("Alpha exec", "T", "execute", 2), b = await mk("Bravo default", "T", "default", 1), c = await mk("Charlie setup", "CT", "other", 0);
  const sIs = (id: number) => new RegExp(`[?&]s=${id}(&|$)`);
  // carte sans stratégie : l'appel à créer ; puis la carte choisie dans la barre (avec son nombre de stratégies)
  await page.goto("/stratbook?map=de_dust2");
  await expect(page.getByTestId("new-strat-empty")).toBeVisible();
  const ancient = page.getByRole("group", { name: "Carte", exact: true }).getByRole("button", { name: /Ancient/ });
  await expect(ancient).toContainText("3");
  await ancient.click();
  await expect(page).toHaveURL(/[?&]map=de_ancient(&|$)/);
  // la liste : T puis CT ; la première est ouverte
  const rows = page.getByTestId("strat-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("Alpha exec");
  await expect(rows.nth(0)).toHaveAttribute("aria-current", "true");
  await expect(rows.nth(2)).toContainText("Charlie setup");
  await expect(rows.nth(2)).not.toContainText("Autre");  // type « Autre » : pas affiché
  await expect(page.getByRole("heading", { name: "Alpha exec" })).toBeVisible();
  // une autre stratégie : la page reste la même, seule l'adresse change
  await page.evaluate(() => { (window as unknown as { sbMark: number }).sbMark = 1; });
  await rows.nth(1).click();
  await expect(page).toHaveURL(sIs(b));
  await expect(page.getByRole("heading", { name: "Bravo default" })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { sbMark?: number }).sbMark)).toBe(1);
  // clavier : ↓ la suivante (la CT), ↑ la précédente
  await page.keyboard.press("ArrowDown");
  await expect(page).toHaveURL(sIs(c));
  await expect(page.getByRole("heading", { name: "Charlie setup" })).toBeVisible();
  await page.keyboard.press("ArrowUp");
  await expect(page).toHaveURL(sIs(b));
  // panneau de droite : Plan, Joueurs, Grenades, Notes ; l'onglet choisi reste en passant à une autre stratégie
  await expect(page.locator("#sb-tp-plan")).toBeVisible();
  await page.getByTestId("sb-tab-players").click();
  await expect(page.getByTestId("strat-player")).toHaveCount(1);
  await page.getByTestId("sb-tab-grenades").click();
  await expect(page.getByTestId("strat-grenades").locator("li")).toHaveCount(1);
  await rows.nth(0).click();
  await expect(page.getByTestId("strat-grenades").locator("li")).toHaveCount(2);
  await page.getByTestId("sb-tab-notes").click();
  await expect(page.getByTestId("notes-panel")).toBeVisible();
  // camp CT : la liste ne garde que la CT, qui s'ouvre
  await page.getByRole("group", { name: "Camp", exact: true }).getByRole("button", { name: "CT", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Charlie setup" })).toBeVisible();
  // ancienne adresse d'une stratégie : la page unique, sur sa carte, tableau tactique gardé
  await page.goto(`/stratbook/${a}?board=1`);
  await expect(page).toHaveURL(new RegExp(`/stratbook\\?map=de_ancient&s=${a}&board=1$`));
  await expect(page.getByTestId("strat-board")).toBeVisible();
  await page.getByTestId("board-toggle").click();
  await expect(page.getByTestId("strat-board")).toHaveCount(0);
  await page.screenshot({ path: "test-results/shots/stratbook-page.png" });
  // menu ⋯ : supprimer en deux temps ; la suivante s'ouvre
  await page.getByTestId("strat-menu").click();
  await page.getByRole("menuitem", { name: "Supprimer la stratégie" }).click();
  await page.locator(".sb-menu-confirm").getByRole("button", { name: "Supprimer" }).click();
  await expect(rows).toHaveCount(2);
  await expect(page.getByRole("heading", { name: "Bravo default" })).toBeVisible();
  for (const id of [b, c]) await page.request.delete(`/api/strats/${id}`);
});

test("menu : sections repliables, mémorisées, la page en cours reste visible", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Navigation principale" });
  const cartes = nav.getByRole("button", { name: "Cartes" });
  await expect(cartes).toHaveAttribute("aria-expanded", "true");
  await cartes.click();
  await expect(cartes).toHaveAttribute("aria-expanded", "false");
  await expect(nav.getByRole("link", { name: "Heatmaps" })).toHaveCount(0);
  await page.reload();
  await expect(nav.getByRole("link", { name: "Grenades" })).toHaveCount(0);  // mémorisé
  await expect(nav.getByRole("link", { name: "Joueurs", exact: true })).toBeVisible();  // les autres sections restent ouvertes
  await page.goto("/heatmaps");
  await expect(nav.getByRole("link", { name: "Heatmaps" })).toBeVisible();  // page en cours : son lien reste
  await expect(nav.getByRole("link", { name: "Grenades" })).toHaveCount(0);
  await nav.getByRole("button", { name: "Cartes" }).click();
  await expect(nav.getByRole("link", { name: "Grenades" })).toBeVisible();
});

test("équipe : propriétaire, commentaires, invitation et connexion", async ({ page, browser }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/team");
  await page.getByTestId("setup-form").getByLabel("Identifiant").fill("coach");
  await page.getByTestId("setup-form").getByLabel("Nom affiché").fill("Coach");
  await page.getByTestId("setup-form").getByLabel(/Mot de passe/).fill("motdepasse1");
  await page.getByRole("button", { name: "Créer le compte propriétaire" }).click();
  await expect(page.getByTestId("member-row")).toHaveCount(1);
  await expect(page.getByTestId("account")).toContainText("Coach");
  await page.getByRole("button", { name: "Créer un lien" }).click();
  const link = (await page.getByTestId("invite-link").textContent())!;
  await page.screenshot({ path: "test-results/shots/team.png" });
  // commentaire horodaté depuis le replay
  await page.goto("/");
  await page.getByTestId("match-row").click();
  await page.getByTestId("round-cell").nth(1).click();
  await page.getByTestId("toggle-comments").click();
  await page.getByLabel("Nouveau commentaire").fill("bon timing de flash");
  await page.getByRole("button", { name: "Publier" }).click();
  await expect(page.getByTestId("comment")).toContainText("bon timing de flash");
  await page.screenshot({ path: "test-results/shots/replay-comments.png" });
  await page.getByLabel("Nouveau commentaire").fill("rotation trop tardive");  // 2e notification, effacée plus bas
  await page.getByRole("button", { name: "Publier" }).click();
  await expect(page.getByTestId("comment")).toHaveCount(2);
  // notification d'équipe : le commentaire (et la démo prête) apparaissent dans la cloche
  await page.goto("/");  // la barre latérale est repliée dans le replay
  await expect(page.getByTestId("notif-count")).toBeVisible();
  await page.getByTestId("notif-bell").click();
  await expect(page.getByTestId("notif-item").first()).toContainText("rotation trop tardive");
  await page.keyboard.press("Escape");
  await page.mouse.click(700, 500);
  await expect(page.getByTestId("notif-count")).toHaveCount(0);
  // effacer une notification, puis toutes : dans ce navigateur seulement, et gardé au rechargement
  await page.getByTestId("notif-bell").click();
  const shown = await page.getByTestId("notif-item").count();
  expect(shown).toBeGreaterThan(1);
  await page.getByTestId("notif-item").first().hover();
  await page.getByTestId("notif-dismiss").first().click();
  await expect(page.getByTestId("notif-item")).toHaveCount(shown - 1);
  await page.getByTestId("notif-clear").click();
  await expect(page.getByTestId("notif-item")).toHaveCount(0);
  await page.reload();
  await page.getByTestId("notif-bell").click();
  await expect(page.getByTestId("notif-menu")).toContainText("Aucune notification");
  await page.mouse.click(700, 500);
  // réglages d'intégration (propriétaire)
  await page.goto("/team");
  await page.getByTestId("integ-webhook").fill("");
  await page.getByTestId("integ-save").click();
  await expect(page.getByTestId("integrations")).toContainText("Réglages enregistrés");
  await page.getByTestId("integ-steam").fill("76561198796378854");
  await page.getByRole("button", { name: "Enregistrer le SteamID" }).click();
  await expect(page.getByTestId("integrations")).toContainText("SteamID enregistré");
  // pseudo TeamSpeak (comms) et bloc des sessions du plugin
  await page.getByTestId("integ-ts").fill("sk1zy");
  await page.getByRole("button", { name: "Enregistrer le pseudo" }).click();
  await expect(page.getByTestId("integrations")).toContainText("Pseudo TeamSpeak enregistré");
  await expect(page.getByTestId("comms-panel")).toContainText("Aucune session");
  await expect(page.getByTestId("comms-panel")).toContainText("pas encore publié");
  // accès pour n8n : clé montrée une fois, révocation en deux clics, webhook avec son secret
  await page.getByTestId("key-name").fill("n8n");
  await page.getByRole("button", { name: "Créer la clé" }).click();
  await expect(page.getByTestId("key-secret")).toContainText("sl_");
  await expect(page.getByTestId("key-row")).toHaveCount(1);
  await page.getByTestId("key-row").getByRole("button", { name: "Révoquer" }).click();
  await page.getByTestId("key-row").getByRole("button", { name: "Confirmer" }).click();
  await expect(page.getByTestId("key-row")).toContainText("révoquée");
  await page.getByTestId("hook-url").fill("https://example.com/sightline");
  await page.getByRole("button", { name: "Ajouter le webhook" }).click();
  await expect(page.getByTestId("hook-secret")).toBeVisible();
  await expect(page.getByTestId("hook-row")).toContainText("example.com");
  // abonner un webhook existant à un événement sans le recréer (le secret reste le même)
  const commsBox = page.getByLabel("Webhook https://example.com/sightline : Comms ajoutées");
  await expect(commsBox).toBeChecked();
  await commsBox.click();
  await expect(commsBox).not.toBeChecked();
  await commsBox.click();
  await expect(commsBox).toBeChecked();
  await page.reload();
  await expect(page.getByLabel("Webhook https://example.com/sightline : Comms ajoutées")).toBeChecked();
  // clé du plugin TeamSpeak en un clic (portée comms seulement), montrée une fois
  await page.getByTestId("comms-key-create").click();
  await expect(page.getByTestId("comms-key")).toContainText("sl_");
  await expect(page.getByTestId("key-row").filter({ hasText: "Plugin TeamSpeak" })).toContainText("Envoyer les comms");
  await page.screenshot({ path: "test-results/shots/team-api-access.png" });
  // bot Discord : l'application enregistrée, l'adresse à coller dans le portail Discord s'affiche
  const bot = page.getByTestId("discord-bot");
  await expect(bot.getByTestId("faceit-queue")).toContainText("en attente d'un PC");
  await page.getByTestId("discord-app-id").fill("1234567890123456789");
  await bot.getByLabel("Clé publique").fill("a".repeat(64));
  await bot.getByRole("button", { name: "Enregistrer" }).click();
  await expect(bot).toContainText("ajoutez le jeton du bot");
  await expect(bot.getByTestId("discord-endpoint")).toContainText("/api/discord/interactions");
  await bot.screenshot({ path: "test-results/shots/team-discord-bot.png" });
  // un visiteur sans compte voit l'écran de connexion, puis rejoint via l'invitation
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const guest = await ctx.newPage();
  await guest.goto("/");
  await expect(guest.getByTestId("login-form")).toBeVisible();
  await guest.screenshot({ path: "test-results/shots/login.png" });
  await guest.goto(new URL(link).pathname);
  await guest.getByLabel("Identifiant").fill("joueur1");
  await guest.getByLabel("Nom affiché").fill("Joueur 1");
  await guest.getByLabel(/Mot de passe/).fill("motdepasse2");
  await guest.getByRole("button", { name: /Rejoindre l'équipe/ }).click();
  await expect(guest.getByTestId("match-row")).toHaveCount(1);
  await guest.getByTestId("match-row").click();
  await guest.getByRole("tab", { name: /Commentaires/ }).click();
  await expect(guest.getByTestId("comment").filter({ hasText: "bon timing de flash" })).toHaveCount(1);
  await ctx.close();
  await page.goto("/team");
  await expect(page.getByTestId("member-row")).toHaveCount(2);
});
