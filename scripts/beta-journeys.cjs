// Usage : backend sur 8000 (SKYBOX_DATA_DIR=%TEMP%sl-realdemo ou data-e2e) + npm run dev sur 5173, puis `node scripts/beta-journeys.cjs` → .ui-audit/beta/
// Bêta-test : parcours utilisateurs multiples sur la vraie démo. Relève erreurs console, exceptions, requêtes >= 400,
// débordement horizontal et chevauchements de textes ; capture chaque étape dans .ui-audit/beta/.
const { chromium } = require("C:/dev/skybox_cs/frontend/node_modules/@playwright/test");
const fs = require("fs");
const OUT = "C:/dev/skybox_cs/.ui-audit/beta/";
fs.mkdirSync(OUT, { recursive: true });
const BASE = "http://localhost:5173", API = "http://127.0.0.1:8000";
const findings = [];
const note = (journey, step, kind, detail) => findings.push({ journey, step, kind, detail: String(detail).slice(0, 300) });

async function audit(page, journey, step) {
  const r = await page.evaluate(() => {
    const ovX = document.documentElement.scrollWidth > window.innerWidth + 2;
    const els = [...document.querySelectorAll("body *")].filter((e) => {
      if (e.closest("svg, canvas, .radar-wrap, .zc, .hm-canvas")) return false;
      const t = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
      if (!t) return false;
      const s = getComputedStyle(e);
      if (s.visibility === "hidden" || s.display === "none" || +s.opacity === 0) return false;
      const b = e.getBoundingClientRect();
      return b.width > 2 && b.height > 2 && b.bottom > 0 && b.top < window.innerHeight && b.right > 0 && b.left < window.innerWidth;
    }).slice(0, 700);
    const rects = els.map((e) => ({ e, b: e.getBoundingClientRect() }));
    const over = [];
    for (let i = 0; i < rects.length && over.length < 6; i++) for (let j = i + 1; j < rects.length && over.length < 6; j++) {
      const a = rects[i], c = rects[j];
      if (a.e.contains(c.e) || c.e.contains(a.e)) continue;
      const w = Math.min(a.b.right, c.b.right) - Math.max(a.b.left, c.b.left), h = Math.min(a.b.bottom, c.b.bottom) - Math.max(a.b.top, c.b.top);
      if (w > 4 && h > 4) {
        const za = getComputedStyle(a.e.closest("[role=dialog], .pl-menu, .ctx-pop, .dialog, .rp-toast") || a.e).position;
        const zc = getComputedStyle(c.e.closest("[role=dialog], .pl-menu, .ctx-pop, .dialog, .rp-toast") || c.e).position;
        if (a.e.closest(".pl-menu, .ctx-pop, .dialog, [role=dialog]") || c.e.closest(".pl-menu, .ctx-pop, .dialog, [role=dialog]")) continue;  // menus ouverts : par-dessus, voulu
        over.push(`« ${a.e.textContent.trim().slice(0, 30)} » ⟂ « ${c.e.textContent.trim().slice(0, 30)} » (${Math.round(w)}×${Math.round(h)} px) ${za}/${zc}`);
      }
    }
    const clipped = [...document.querySelectorAll("button, a, .pill, .btn")].filter((e) => {
      const b = e.getBoundingClientRect(); return b.width > 0 && e.scrollWidth > e.clientWidth + 3 && getComputedStyle(e).overflow !== "visible" && e.textContent.trim().length > 2;
    }).slice(0, 4).map((e) => e.textContent.trim().slice(0, 40));
    const empty = !document.querySelector("main")?.innerText.trim();
    return { ovX, over, clipped, empty, h1: document.querySelector("h1")?.textContent?.trim() };
  });
  if (r.ovX) note(journey, step, "débordement horizontal", "la page défile horizontalement");
  for (const o of r.over) note(journey, step, "chevauchement", o);
  for (const c of r.clipped) note(journey, step, "texte coupé", c);
  if (r.empty) note(journey, step, "page vide", "main sans texte");
  const name = `${journey}_${step}`.replace(/[^\w-]+/g, "_");
  await page.screenshot({ path: OUT + name + ".png", fullPage: false });
}

async function run(browser, journey, viewport, fn) {
  const ctx = await browser.newContext({ viewport, locale: "fr-FR", acceptDownloads: true });
  const page = await ctx.newPage();
  let step = "start";
  page.on("console", (m) => { if (m.type() === "error" && !/Future Flag|favicon/.test(m.text())) note(journey, step, "erreur console", m.text()); });
  page.on("pageerror", (e) => note(journey, step, "exception JS", e.message));
  page.on("response", (r) => { const u = r.url(); if (r.status() >= 400 && u.includes("/api/") && !/\/api\/auth\/me|faceit/.test(u)) note(journey, step, `HTTP ${r.status()}`, `${r.request().method()} ${u.replace(BASE, "").replace(API, "")}`); });
  const go = async (s, f) => {
    step = s;
    try { await f(); await page.waitForTimeout(500); await audit(page, journey, s); }
    catch (e) { note(journey, s, "échec du parcours", e.message.split("\n")[0]); try { await page.screenshot({ path: OUT + `${journey}_${s}_FAIL.png` }); } catch {} }
  };
  const t0 = Date.now();
  await fn(page, go);
  note(journey, "fin", "durée", `${Math.round((Date.now() - t0) / 1000)} s`);
  await ctx.close();
}

(async () => {
  const j = async (p) => (await fetch(API + p)).json();
  const teams = await j("/api/scouting/teams");
  const faze = teams.find((t) => t.name === "FaZe"), max = teams.find((t) => t.name === "3DMAX");
  const players = await j("/api/players");
  const sid = players[0].steamid;
  const browser = await chromium.launch();
  const D = { width: 1440, height: 900 }, L = { width: 1280, height: 720 }, M = { width: 390, height: 844 };

  // 1. Coach qui découvre l'appli
  await run(browser, "1-coach-decouverte", D, async (page, go) => {
    await go("bibliotheque", () => page.goto(BASE + "/", { waitUntil: "networkidle" }));
    await go("match", async () => { await page.getByTestId("match-row").first().click(); await page.waitForURL(/\/matches\/\d+$/); });
    await go("match-joueurs", () => page.getByRole("tab", { name: "Joueurs" }).click());
    await go("match-analyse", () => page.getByRole("tab", { name: /Analyse/ }).click());
    await go("replay", async () => { await page.getByRole("link", { name: /Replay/ }).first().click(); await page.getByTestId("radar").waitFor(); });
    await go("replay-play", async () => { await page.keyboard.press(" "); await page.waitForTimeout(1500); await page.keyboard.press(" "); });
    await go("replay-round-suivant", () => page.keyboard.press("n"));
    await go("rapport", () => page.goto(BASE + "/matches/1/report", { waitUntil: "networkidle" }));
  });

  // 2. Analyste qui prépare un adversaire
  await run(browser, "2-prepa-adversaire", D, async (page, go) => {
    await go("scouting", () => page.goto(BASE + "/scouting", { waitUntil: "networkidle" }));
    await go("fiche", async () => { await page.getByTestId("scout-team").filter({ hasText: "FaZe" }).click(); await page.getByTestId("ts-kpis").waitFor(); });
    await go("fiche-carte", () => page.getByTestId("ts-tab-carte").click());
    await go("fiche-armes", () => page.getByRole("radio", { name: "Armés contre armés" }).click());
    await go("fiche-joueurs", () => page.getByTestId("ts-tab-joueurs").click());
    await go("fiche-avance", async () => { await page.getByRole("radio", { name: "Avancé" }).click(); await page.getByTestId("ts-tab-donnees").click(); });
    await go("revoir-round", async () => { await page.getByTestId("ts-tab-resume").click(); await page.locator(".ts-linkbtn").first().click(); await page.locator(".ts-round").first().click(); await page.waitForURL(/replay/); });
    await go("retour-fiche", async () => { await page.getByTestId("replay-back").click(); await page.getByTestId("ts-kpis").waitFor(); });
    await go("preparer-match", async () => { await page.getByTestId("ts-prep").click(); await page.waitForURL(/match-prep/); });
    await go("generer", async () => {
      await page.getByTestId("prep-new").click(); await page.getByTestId("prep-team").selectOption(String(faze.id)); await page.getByTestId("prep-map").selectOption("de_nuke");
      await page.getByTestId("prep-generate").click(); await page.waitForURL(/match-prep\/\d+/); await page.getByTestId("prep-report").waitFor();
    });
    await go("rapport-bas", () => page.mouse.wheel(0, 3000));
    await go("veto", () => page.goto(BASE + `/veto?b=${faze.id}`, { waitUntil: "networkidle" }));
    await go("veto-simule", () => page.getByTestId("veto-auto").click());
    await go("veto-scenarios", () => page.getByTestId("veto-tab-scenarios").click());
  });

  // 3. Joueur qui veut progresser
  await run(browser, "3-joueur-progression", D, async (page, go) => {
    await go("dashboard", () => page.goto(BASE + "/dashboard", { waitUntil: "networkidle" }));
    await go("joueurs", () => page.goto(BASE + "/players", { waitUntil: "networkidle" }));
    await go("fiche-joueur", async () => { await page.getByTestId("player-row").first().getByRole("link").first().click(); await page.waitForURL(/players\/\d+/); });
    for (const t of ["Rôles", "Armes", "Achats", "Cartes"]) await go(`onglet-${t}`, () => page.getByRole("tab", { name: t, exact: true }).click());
    await go("apprendre", () => page.goto(BASE + "/learn", { waitUntil: "networkidle" }));
    await go("apprendre-demo", async () => { await page.getByTestId("story-demos").locator("button, a").first().click(); });
    await go("apprendre-joueur", async () => { await page.getByTestId("story-players").locator("button, a").first().click(); await page.getByTestId("story-transport").waitFor(); });
    await go("apprendre-suivant", async () => { await page.getByTestId("story-next").click(); await page.getByTestId("story-next").click(); });
    await go("apprendre-routine", () => page.getByTestId("view-routine").click());
    await go("poste", () => page.goto(BASE + "/learn/expert?map=de_nuke&side=CT", { waitUntil: "networkidle" }));
    await go("poste-choisi", async () => { await page.getByTestId("postes").locator(".ln-poste").first().click(); await page.getByTestId("poste-detail").waitFor(); });
    await go("role", () => page.getByTestId("mode-role").click());
    await go("classements", () => page.goto(BASE + "/leaderboards", { waitUntil: "networkidle" }));
  });

  // 4. Tacticien : playbook, tactiques, pattern finder
  await run(browser, "4-tacticien", D, async (page, go) => {
    await go("playbook", () => page.goto(BASE + `/playbook?team=${faze.id}&map=de_nuke`, { waitUntil: "networkidle" }));
    await go("playbook-rounds", () => page.getByRole("tab", { name: "Round par round" }).click());
    await go("pattern", () => page.goto(BASE + `/pattern-finder?team=${faze.id}&map=de_nuke&side=T`, { waitUntil: "networkidle" }));
    await go("pattern-exemple", () => page.getByRole("button", { name: /Exécution A/ }).click());
    await go("pattern-rounds-tab", () => page.getByRole("tab", { name: "Rounds" }).click());
    await go("pattern-enregistrer", async () => { await page.getByTestId("pf-save").click(); await page.getByTestId("tactic-editor").waitFor(); });
    await go("tactique-nommee", async () => { await page.getByTestId("tactic-name").fill("Beta exec A"); await page.getByTestId("tactic-save").click(); await page.waitForURL(/playbook\?/); });
    await go("pattern-rejouer", async () => { await page.goto(BASE + `/pattern-finder?team=${faze.id}&map=de_nuke&side=T`, { waitUntil: "networkidle" }); await page.getByTestId("pf-replay").click(); await page.waitForURL(/replay/); });
    await go("callouts", () => page.goto(BASE + "/callouts?map=de_nuke", { waitUntil: "networkidle" }));
    await go("stratbook", () => page.goto(BASE + "/stratbook", { waitUntil: "networkidle" }));
    await go("grenades", () => page.goto(BASE + "/grenades?map=de_nuke", { waitUntil: "networkidle" }));
    await go("heatmaps", () => page.goto(BASE + "/heatmaps?map=de_nuke", { waitUntil: "networkidle" }));
    // nettoyage
    const ts = await (await fetch(API + "/api/tactics")).json();
    for (const t of ts.filter((x) => x.name === "Beta exec A")) await fetch(API + `/api/tactics/${t.id}`, { method: "DELETE" });
  });

  // 5. Organisation de la bibliothèque
  await run(browser, "5-organisation", L, async (page, go) => {
    await go("bibliotheque", () => page.goto(BASE + "/", { waitUntil: "networkidle" }));
    await go("selection", () => page.locator(".match-select").first().click());
    await go("dossier", async () => { await page.getByTestId("bulk-folder-open").click(); await page.getByTestId("bulk-folder").selectOption("__new"); await page.getByLabel("Nouveau dossier").fill("Beta dossier test long"); await page.getByTestId("bulk-folder-apply").click(); });
    await go("filtre-dossier", () => page.getByTestId("lib-folder").selectOption({ index: 1 }));
    await go("filtre-equipe", async () => { await page.getByTestId("lib-folder").selectOption(""); await page.getByTestId("lib-team").selectOption({ index: 1 }); });
    await go("playlists", () => page.goto(BASE + "/playlists", { waitUntil: "networkidle" }));
    await go("rounds", () => page.goto(BASE + "/rounds", { waitUntil: "networkidle" }));
    await go("moments-forts", () => page.goto(BASE + "/highlights", { waitUntil: "networkidle" }));
    await go("signets", () => page.goto(BASE + "/bookmarks", { waitUntil: "networkidle" }));
    await fetch(API + "/api/matches/labels/bulk", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: [1], folder: "" }) });
  });

  // 6. Stats d'équipe et comparaison
  await run(browser, "6-stats", D, async (page, go) => {
    await go("equipe", () => page.goto(BASE + `/team-stats?team=${max.id}&map=de_nuke`, { waitUntil: "networkidle" }));
    for (const t of ["Joueurs", "Positions", "Sites", "Cartes"]) await go(`onglet-${t}`, () => page.getByRole("tab", { name: t }).click());
    await go("comparaison", () => page.getByRole("button", { name: "Modifier" }).first().click());
    await go("filtres", async () => { await page.keyboard.press("Escape"); await page.getByRole("button", { name: /Filtres/ }).click(); });
  });

  // 7. Utilisateur avancé du replay
  await run(browser, "7-replay-avance", D, async (page, go) => {
    await go("replay", async () => { await page.goto(BASE + "/matches/1/replay/3", { waitUntil: "networkidle" }); await page.getByTestId("radar").waitFor(); });
    await go("preferences", () => page.getByTestId("prefs-open").click());
    await go("overlay-site", async () => { await page.getByTestId("pref-bombsite").check(); await page.getByRole("button", { name: "Terminé" }).click(); });
    await go("superposer", () => page.getByTestId("layers-toggle").click());
    await go("partage", async () => { await page.keyboard.press("Escape"); await page.mouse.click(700, 500); await page.getByTestId("share-open").click(); });
    await go("gif", async () => { await page.keyboard.press("Escape"); await page.getByTestId("gif-open").click(); });
    await go("raccourcis", async () => { await page.getByRole("button", { name: "Fermer" }).last().click(); await page.getByTestId("shortcuts-open").click(); });
    await page.evaluate(() => localStorage.removeItem("replay-prefs"));
  });

  // 8. Mobile
  await run(browser, "8-mobile", M, async (page, go) => {
    for (const [n, u] of [["bibliotheque", "/"], ["match", "/matches/1"], ["replay", "/matches/1/replay/2"], ["scouting", "/scouting"], ["fiche", `/scouting/${faze.id}`],
      ["match-prep", "/match-prep"], ["veto", "/veto"], ["joueurs", "/players"], ["pattern", `/pattern-finder?team=${faze.id}&map=de_nuke&side=T`], ["apprendre", "/learn"], ["equipe", `/team-stats?team=${faze.id}&map=de_nuke`]])
      await go(n, () => page.goto(BASE + u, { waitUntil: "networkidle" }));
  });

  await browser.close();
  fs.writeFileSync(OUT + "findings.json", JSON.stringify(findings, null, 1));
  const by = {};
  for (const f of findings) (by[f.kind] ??= []).push(f);
  for (const [k, v] of Object.entries(by)) { console.log(`\n## ${k} (${v.length})`); for (const f of v.slice(0, 40)) console.log(`- [${f.journey} / ${f.step}] ${f.detail}`); }
})();
