// Export d'une carte de CS2 en 3D pour le replay de Sightline, depuis votre PC (CS2 installé). Lancé à la main
// seulement : rien ne l'appelle automatiquement.
// Usage : node scripts/map3d/export.mjs nuke [--site https://…] [--s2v <chemin>] [--only gray|textured|collision] [--dry-run]
//   0. vérifie que le site répond et que le module 3D y est activé (sauf --dry-run), avant tout le reste ;
//   1. trouve CS2 (bibliothèques Steam, ou STEAM_PATH) et exporte la carte avec Source 2 Viewer CLI 20.1 (à télécharger une fois) ;
//   2. vérifie l'alignement sur les sites de bombe connus de Sightline (sinon : rien n'est envoyé) ;
//   3. produit deux versions optimisées (grise, texturée) et la collision (world_physics simplifié : corps des morts) dans
//      un dossier temporaire, supprimé à la fin ; --only collision : la collision seule, sans l'export de la carte ;
//   4. les envoie par morceaux, avec reprise, avec votre session Sightline (propriétaire ou admin).
// La première fois, connectez-vous à Sightline dans la fenêtre qui s'ouvre (la session est ensuite mémorisée).
// Les fichiers exportés sont ceux de Valve : ils ne vont que sur votre Sightline, jamais dans le dépôt.
// « node scripts/map3d/export.mjs vue » : bras et armes de la vue du joueur (lib/vue.mjs) ; « … joueurs » : joueurs vus de
// l'extérieur, modèles d'agents, clips et armes du monde (lib/joueurs.mjs).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCE_TO_GLTF } from "./lib/align.mjs";
import { parseCli } from "./lib/cli.mjs";
import { exportMapFiles } from "./lib/mapexport.mjs";
import { makeIO } from "./lib/optimize.mjs";
import { DEFAULT_S2V } from "./lib/s2v.mjs";
import { runJoueurs } from "./lib/joueurs.mjs";
import { withSession } from "./lib/session.mjs";
import { findCs2, mapVpk } from "./lib/steam.mjs";
import { checkSite, uploadVariant } from "./lib/upload.mjs";
import { runVue } from "./lib/vue.mjs";
import { cleanOldWork, guardWork, makeWork } from "./lib/work.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let cli;
try {
  cli = parseCli(process.argv.slice(2));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
if (cli.vue || cli.joueurs) {
  await (cli.vue ? runVue : runJoueurs)(cli, ROOT);
  process.exit();  // code de sortie posé par runVue ou runJoueurs
}
const { map, site, s2v, variants, dryRun } = cli;
const metaPath = path.join(ROOT, "maps", `${map}.json`);
if (!fs.existsSync(metaPath)) {
  console.error(`Carte inconnue de Sightline (${map}).`);
  process.exit(1);
}
const mapMeta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
const mb = (n) => `${(n / 1024 ** 2).toFixed(1)} Mo`;

console.log(dryRun ? "Destination : aucune (--dry-run, rien n'est envoyé)" : `Destination : ${site}`);
const cleaned = cleanOldWork();
if (cleaned) console.log(`${cleaned} dossier(s) d'exports interrompus supprimé(s) de ${os.tmpdir()}.`);
if (!dryRun) {
  // avant l'export (plusieurs minutes) : un module coupé ne se découvrirait sinon qu'à l'envoi (405)
  try {
    await checkSite(site);
  } catch (e) {
    console.error(`\n${e.message}`);
    process.exit(1);
  }
}

// marqué du PID (un autre lancement n'y touche pas) et supprimé à la sortie, Ctrl+C compris
const work = makeWork();
const stopped = guardWork(work);

try {
  const { csgo, version } = findCs2();
  console.log(`CS2 : ${csgo} (version ${version || "inconnue"})`);
  const exe = s2v ?? DEFAULT_S2V, vpk = mapVpk(csgo, map), io = await makeIO();
  const { files, checks } = await exportMapFiles({ map, mapMeta, variants, work, exe, vpk, io },
    { warn: (m) => console.warn(String.fromCharCode(10) + m) });
  if (dryRun) console.log("--dry-run : rien n'est envoyé.");
  else await send(files, { build: version, exported_at: new Date().toISOString(), tool: "map3d 1", world_to_model: SOURCE_TO_GLTF, checks });
} catch (e) {
  // Ctrl+C pendant Source 2 Viewer (la CLI s'arrête avant que notre écouteur tourne), ou pendant l'envoi (Chromium déjà
  // fermé par Playwright) : « Interrompu. » et 130, pas un faux message d'échec
  if (e.interrupted || stopped()) process.exit(130);
  console.error(`\n${e.message}`);
  process.exitCode = 1;
}

async function send(files, meta) {
  await withSession(site, ROOT, "de carte 3D", async (request) => {
    for (const [v, file] of Object.entries(files)) {
      const res = await uploadVariant({ request, site, map, variant: v, file, meta,
        log: (done, total) => process.stdout.write(`\r  ${v} : ${mb(done)} / ${mb(total)}   `) });
      console.log(`\n  ${v} en place : ${site}${res.variants[v].url}`);
    }
  });
  console.log(`Terminé : ouvrez un replay sur ${mapMeta.display_name} et choisissez 3D.`);
}
