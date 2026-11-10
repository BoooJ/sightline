import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { checkAdmin, readBody, reason } from "./upload.mjs";

/** Session Sightline du script : Chromium de Playwright (chargé depuis frontend/, `root` = racine du dépôt) avec un
 *  profil mémorisé ; la première fois, connexion à la main dans la fenêtre (5 minutes). Compte propriétaire ou admin
 *  exigé (`what` : ce qui sera envoyé, pour le message). `fn(request)` envoie avec cette session ; Chromium est fermé
 *  ensuite, même en cas d'erreur. */
export async function withSession(site, root, what, fn) {
  const require = createRequire(path.join(root, "frontend", "package.json"));
  const { chromium } = require("@playwright/test");
  const profile = path.join(process.env.LOCALAPPDATA ?? os.homedir(), "sightline-map3d", "profile");
  // Ctrl+C à partir d'ici : l'écouteur de Playwright ferme Chromium proprement puis sort (guardWork le laisse faire)
  const ctx = await chromium.launchPersistentContext(profile, { headless: false });
  try {
    const page = ctx.pages()[0] ?? await ctx.newPage();
    await page.goto(site, { waitUntil: "domcontentloaded" });
    const me = async () => {
      const r = await ctx.request.get(`${site}/api/auth/me`);
      const body = await readBody(r);
      if (!r.ok()) throw new Error(`Connexion à Sightline impossible (${r.status()}) : ${reason(body)}`);
      return body;
    };
    let m = await me();
    if (!m.user && !m.setup_required) {
      console.log("Connectez-vous à Sightline dans la fenêtre du navigateur (5 minutes)…");
      const until = Date.now() + 5 * 60_000;
      while (!m.user && Date.now() < until) { await page.waitForTimeout(2000); m = await me(); }
      if (!m.user) throw new Error("Pas de connexion à Sightline.");
    }
    checkAdmin(m, ` Pour changer de compte, supprimez ${profile} (session mémorisée) puis relancez.`, what);
    return await fn(ctx.request);
  } finally {
    await ctx.close();
  }
}
