#!/usr/bin/env node
// Import des démos FACEIT d'une équipe (saison ESEA…) dans Sightline, depuis votre PC.
//
// L'API Downloads de FACEIT (téléchargement par un serveur) n'est accordée qu'au cas par cas. Mais sur faceit.com,
// connecté, le bouton « Regarder la démo » d'un match donne un lien de téléchargement signé et temporaire. Ce script :
//   1. lit dans Sightline les matchs de l'équipe dont la démo n'est pas encore importée ;
//   2. ouvre chaque match sur faceit.com dans une fenêtre de navigateur où vous êtes connecté à FACEIT, et récupère
//      ce lien (sans télécharger le fichier sur votre PC) ;
//   3. le transmet à Sightline, qui télécharge la démo lui-même et la rattache au match et à l'équipe.
//
// Utilisation (depuis le dossier du projet) :
//   node scripts/faceit-import.mjs <lien de l'équipe FACEIT | lien(s) de match FACEIT> [--max 10] [--tous] [--site URL]
//     --max   nombre de matchs au plus (les plus récents d'abord, défaut 10)
//     --tous  tous les matchs d'équipe, pas seulement la saison ESEA
// La première fois, connectez-vous à FACEIT puis à Sightline dans la fenêtre qui s'ouvre (sessions mémorisées).
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(ROOT, "frontend", "package.json"));
const { chromium } = require("@playwright/test");

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const site = (opt("--site") ?? "https://sightline.example.com").replace(/\/$/, "");
const max = Number(opt("--max") ?? 10);
const scope = args.includes("--tous") ? "all" : "esea";
const team = args.map((a) => a.match(new RegExp(`faceit\\.com/(?:[a-z]{2}(?:-[a-z]{2})?/)?teams/(${UUID})`, "i"))?.[1]).find(Boolean);
const rooms = args.map((a) => a.match(new RegExp(`(1-${UUID})`, "i"))?.[1]).filter(Boolean);
const WATCH = /regarder la d[ée]mo|watch demo|ver demo|demo ansehen/i;

if (!team && !rooms.length) {
  console.log("Usage : node scripts/faceit-import.mjs <lien de l'équipe FACEIT | lien(s) de match> [--max 10] [--tous] [--site URL]");
  process.exit(1);
}

const profile = path.join(process.env.LOCALAPPDATA ?? os.homedir(), "sightline-faceit");
const ctx = await chromium.launchPersistentContext(profile, {
  headless: false, viewport: { width: 1200, height: 800 }, args: ["--disable-blink-features=AutomationControlled"],
});
// le bouton « Regarder la démo » ouvre le lien signé dans un nouvel onglet : on le note au lieu de télécharger
await ctx.addInitScript(() => {
  window.__sightline = [];
  window.open = (u) => { window.__sightline.push(String(u)); return null; };
});
const page = ctx.pages()[0] ?? await ctx.newPage();

async function waitUntil(check, message, minutes = 5) {
  if (await check()) return;
  console.log(message);
  const until = Date.now() + minutes * 60_000;
  while (Date.now() < until) {
    await page.waitForTimeout(2000);
    if (await check()) return;
  }
  throw new Error("Délai dépassé.");
}

try {
  // 1. session Sightline
  await page.goto(site, { waitUntil: "domcontentloaded" });
  const me = async () => (await ctx.request.get(`${site}/api/auth/me`)).json().catch(() => ({}));
  await waitUntil(async () => { const m = await me(); return !!m.user || (m.setup_required && !m.setup_code_required); },
    "Connectez-vous à Sightline dans la fenêtre du navigateur (5 minutes)…");

  // 2. matchs à importer
  let todo = rooms.map((id) => ({ match_id: id, label: id }));
  if (team) {
    console.log(`Équipe FACEIT ${team} : lecture des matchs ${scope === "esea" ? "ESEA" : "d'équipe"}…`);
    const r = await ctx.request.get(`${site}/api/faceit/teams/${team}?scope=${scope}`, { timeout: 180_000 });
    if (!r.ok()) throw new Error(`Sightline : ${r.status()} ${await r.text()}`);
    const rep = await r.json();
    console.log(`${rep.team.name} : ${rep.matches.length} match(s).`);
    todo = rep.matches.filter((m) => m.demos > m.imported.length).slice(0, max)
      .map((m) => ({ match_id: m.match_id, label: `${m.started_at?.slice(0, 10) ?? ""} vs ${m.opponent.name} (${m.maps.map((x) => x.map.replace("de_", "")).join(", ")})` }));
    if (!todo.length) console.log("Toutes les démos disponibles sont déjà importées.");
  }

  // 3. lien signé de chaque démo, transmis à Sightline
  let sent = 0;
  for (const [i, m] of todo.entries()) {
    console.log(`[${i + 1}/${todo.length}] ${m.label}`);
    await page.goto(`https://www.faceit.com/en/cs2/room/${m.match_id}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    const buttons = page.getByRole("button", { name: WATCH }).or(page.getByText(WATCH));
    const found = await buttons.first().waitFor({ timeout: 20_000 }).then(() => true).catch(() => false);
    if (!found) {
      const loggedOut = await page.getByText(/log ?in|sign ?in|se connecter/i).first().isVisible().catch(() => false);
      if (loggedOut || i === 0) {
        await waitUntil(async () => buttons.first().isVisible().catch(() => false),
          "Connectez-vous à FACEIT dans la fenêtre (puis revenez sur la page du match si besoin)…");
      } else { console.log("  pas de démo sur la page du match, ignoré"); continue; }
    }
    const links = [];
    const grab = async (click) => {
      const before = await page.evaluate(() => window.__sightline.length);
      await click();
      await page.waitForFunction((b) => window.__sightline.length > b, before, { timeout: 20_000 }).catch(() => {});
      for (const u of (await page.evaluate(() => window.__sightline.slice())).slice(before)) {
        if (/\.dem/i.test(u) && !links.includes(u)) links.push(u);
      }
    };
    // BO1 : le bouton donne le lien ; BO3 : il ouvre un menu « Démo 1 / Démo 2… », une entrée par carte
    const menu = page.getByText(/^\s*(d[ée]mo|demo)\s+\d+\s*$/i);
    const start = await page.evaluate(() => window.__sightline.length);
    await buttons.first().click().catch(() => {});
    await page.waitForTimeout(1500);
    const maps = await menu.count();
    if (!maps) {
      await page.waitForFunction((b) => window.__sightline.length > b, start, { timeout: 20_000 }).catch(() => {});
      for (const u of (await page.evaluate(() => window.__sightline.slice())).slice(start)) if (/\.dem/i.test(u)) links.push(u);
    }
    for (let k = 0; k < maps; k++) {
      if (!(await menu.nth(k).isVisible().catch(() => false))) { await buttons.first().click().catch(() => {}); await page.waitForTimeout(1000); }
      await grab(() => menu.nth(k).click().catch(() => {}));
    }
    if (!links.length) { console.log("  aucun lien de démo obtenu (démo expirée ou pas encore disponible)"); continue; }
    for (const url of links) {
      const res = await ctx.request.post(`${site}/api/faceit/matches/${m.match_id}/import`, { data: { url } });
      if (res.ok()) { sent++; console.log(`  ${new URL(url).pathname.split("/").pop()} : téléchargement lancé par Sightline`); }
      else console.log(`  refusé par Sightline : ${res.status()} ${await res.text()}`);
    }
  }
  console.log(`Terminé : ${sent} démo(s) en cours d'import. Suivi : ${site}/scouting/faceit${team ? `/${team}` : ""}`);
} catch (e) {
  console.error(`\nErreur : ${e.message}`);
  process.exitCode = 1;
} finally {
  await ctx.close();
}
