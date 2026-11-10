#!/usr/bin/env node
// Import d'une démo HLTV dans Sightline, depuis votre PC.
//
// HLTV (Cloudflare) bloque les serveurs : le site ne peut pas télécharger les démos lui-même. Ce script le fait sur
// votre PC, dans une vraie fenêtre de navigateur (connexion internet de particulier), puis :
//   1. récupère l'archive de la série (.rar) à la vitesse de votre connexion descendante ;
//   2. en extrait les démos, et ne garde que les cartes demandées (--carte) ;
//   3. les compresse (zstd, un tiers plus léger) et les envoie à Sightline par morceaux (reprise possible).
//
// Utilisation (depuis le dossier du projet) :
//   node scripts/hltv-import.mjs <lien du match HLTV> [--carte mirage,nuke] [--site https://sightline.example.com] [--garder]
// La première fois, connectez-vous à Sightline dans la fenêtre qui s'ouvre (la session est ensuite mémorisée).
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(ROOT, "frontend", "package.json"));
const { chromium } = require("@playwright/test");

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const link = args.find((a) => /^https?:\/\//.test(a) && /hltv\.org/.test(a));
const site = (opt("--site") ?? "https://sightline.example.com").replace(/\/$/, "");
const maps = (opt("--carte") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const keep = args.includes("--garder");
const CHUNK = 4 * 1024 * 1024;

if (!link) {
  console.log("Usage : node scripts/hltv-import.mjs <lien du match HLTV> [--carte mirage,nuke] [--site URL] [--garder]");
  process.exit(1);
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} Mo`;
const work = fs.mkdtempSync(path.join(os.tmpdir(), "sightline-hltv-"));
const profile = path.join(process.env.LOCALAPPDATA ?? os.homedir(), "sightline-hltv");

const ctx = await chromium.launchPersistentContext(profile, {
  headless: false, acceptDownloads: true, viewport: { width: 1100, height: 760 },
  args: ["--disable-blink-features=AutomationControlled"],
});
const page = ctx.pages()[0] ?? await ctx.newPage();
try {
  // 1. archive de la série
  console.log(`HLTV : ${link}`);
  await page.goto(link, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForFunction(() => !/Just a moment/i.test(document.title), null, { timeout: 120_000 })
    .catch(() => { throw new Error("Cloudflare n'a pas laissé passer : résolvez la vérification dans la fenêtre puis relancez."); });
  const demoHref = /\/download\/demo\//.test(link) ? new URL(link).pathname
    : await page.locator("a[href*='/download/demo/']").first().getAttribute("href", { timeout: 15_000 }).catch(() => null);
  if (!demoHref) throw new Error("Aucune démo sur cette page HLTV (la démo n'est peut-être pas encore publiée).");
  const dlP = page.waitForEvent("download", { timeout: 120_000 });
  await page.evaluate((href) => { const a = document.createElement("a"); a.href = href; document.body.appendChild(a); a.click(); }, demoHref);
  const dl = await dlP;
  const archive = path.join(work, dl.suggestedFilename() || "demo.rar");
  console.log(`Téléchargement de ${dl.suggestedFilename()}…`);
  const t0 = Date.now();
  const timer = setInterval(() => process.stdout.write("."), 5000);  // la taille n'est connue qu'à la fin
  await dl.saveAs(archive);
  clearInterval(timer);
  const size = fs.statSync(archive).size;
  console.log(`\nArchive reçue : ${mb(size)} en ${Math.round((Date.now() - t0) / 1000)} s`);

  // 2. extraction (bsdtar de Windows : rar, zip)
  const out = path.join(work, "dem");
  fs.mkdirSync(out);
  const tar = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "bsdtar";
  const r = spawnSync(tar, ["-xf", archive, "-C", out], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("Extraction impossible (archive .rar) : installez 7-Zip ou WinRAR et extrayez-la à la main.");
  const dems = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (e.name.toLowerCase().endsWith(".dem")) dems.push(p);
  });
  walk(out);
  const chosen = dems.filter((p) => !maps.length || maps.some((m) => path.basename(p).toLowerCase().includes(m)));
  console.log(`Démos dans l'archive : ${dems.map((p) => path.basename(p)).join(", ") || "aucune"}`);
  if (!chosen.length) throw new Error(`Aucune démo ne correspond à --carte ${maps.join(",")}`);

  // 3. session Sightline (connexion dans la fenêtre si besoin)
  await page.goto(site, { waitUntil: "domcontentloaded" });
  const me = async () => (await ctx.request.get(`${site}/api/auth/me`)).json();
  let m = await me();
  if (!m.user && !m.setup_required) {
    console.log("Connectez-vous à Sightline dans la fenêtre du navigateur (5 minutes)…");
    const until = Date.now() + 5 * 60_000;
    while (!m.user && Date.now() < until) { await page.waitForTimeout(2000); m = await me(); }
    if (!m.user) throw new Error("Pas de connexion à Sightline.");
  }

  // 4. compression puis envoi par morceaux (reprend là où il s'était arrêté si on relance)
  for (const dem of chosen) {
    const name = `${path.basename(dem)}.zst`;
    const zst = path.join(work, name);
    process.stdout.write(`Compression de ${path.basename(dem)} (${mb(fs.statSync(dem).size)})… `);
    await pipeline(fs.createReadStream(dem), zlib.createZstdCompress({ params: { [zlib.constants.ZSTD_c_compressionLevel]: 9 } }), fs.createWriteStream(zst));
    const total = fs.statSync(zst).size;
    console.log(mb(total));
    const id = crypto.createHash("sha1").update(`${name}:${total}`).digest("hex").slice(0, 32);
    let st = await (await ctx.request.post(`${site}/api/uploads`, { data: { id, name, size: total } })).json();
    if (!("received" in st)) throw new Error(`Envoi refusé : ${JSON.stringify(st)}`);
    const fd = fs.openSync(zst, "r");
    const start = Date.now(), from = st.received;
    for (let off = st.received; off < total; off += CHUNK) {
      const len = Math.min(CHUNK, total - off), buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, off);
      for (let attempt = 1; ; attempt++) {
        const res = await ctx.request.put(`${site}/api/uploads/${id}?offset=${off}`, { data: buf, headers: { "content-type": "application/octet-stream" }, timeout: 300_000 }).catch((e) => e);
        if (res?.ok?.()) break;
        if (attempt >= 5) throw new Error(`Envoi interrompu à ${mb(off)} : relancez la commande pour reprendre.`);
        await page.waitForTimeout(3000 * attempt);
      }
      const done = off + len, rate = (done - from) / Math.max(1, (Date.now() - start) / 1000);
      process.stdout.write(`\r  envoi ${mb(done)} / ${mb(total)} · ${(rate / 1024).toFixed(0)} Ko/s · reste ${Math.round((total - done) / Math.max(rate, 1) / 60)} min   `);
    }
    fs.closeSync(fd);
    const res = await ctx.request.post(`${site}/api/uploads/${id}/complete`);
    console.log(res.ok() ? `\n  ${name} : analyse lancée dans Sightline.` : `\n  ${name} : échec (${res.status()}) ${await res.text()}`);
  }
  console.log(`Terminé. Bibliothèque : ${site}/`);
} catch (e) {
  console.error(`\nErreur : ${e.message}`);
  process.exitCode = 1;
} finally {
  await ctx.close();
  if (!keep) fs.rmSync(work, { recursive: true, force: true });
  else console.log(`Fichiers gardés dans ${work}`);
}
