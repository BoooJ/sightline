// Bras et armes de la vue du joueur (node scripts/map3d/export.mjs vue) : Source 2 Viewer sur pak01_dir.vpk de CS2,
// préparation (lib/viewmodel.mjs), envoi par morceaux vers /api/assets3d (type « vue »), avec la même vérification du
// site et du compte que les cartes. Ce sont des fichiers de Valve : ils ne vont que sur votre Sightline, jamais dans le
// dépôt (dossier de travail temporaire, supprimé à la fin).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeIO } from "./optimize.mjs";
import { DEFAULT_S2V, runS2v } from "./s2v.mjs";
import { withSession } from "./session.mjs";
import { findCs2, pakVpk } from "./steam.mjs";
import { checkSite, uploadFile } from "./upload.mjs";
import { buildWeapon, optimizeVm, prepareArms, vueArgs } from "./viewmodel.mjs";
import { loadWeapons } from "./weapons.mjs";
import { cleanOldWork, guardWork, makeWork } from "./work.mjs";

export const TOOL = "vue 1";
const mb = (n) => `${(n / 1024 ** 2).toFixed(1)} Mo`;

/** Ce qu'il faut exporter : tout (bras des deux camps et toutes les armes), ou ce que liste --only (clés d'armes de
 *  lib/weapons.json, « bras » pour les bras des deux camps). */
export function selectVue(weapons, only) {
  if (!only) return { arms: ["ct", "t"], weapons };
  const keys = new Set(weapons.map((w) => w.key));
  const unknown = only.filter((k) => k !== "bras" && !keys.has(k));
  if (unknown.length) throw new Error(`Arme inconnue : ${unknown.join(", ")} (clés de scripts/map3d/lib/weapons.json : ${[...keys].join(", ")})`);
  return { arms: only.includes("bras") ? ["ct", "t"] : [], weapons: weapons.filter((w) => only.includes(w.key)) };
}

/** Export, contrôles et envoi ; code de sortie dans process.exitCode (130 : interrompu). */
export async function runVue({ site, s2v, only, dryRun }, root) {
  let pick;
  try {
    pick = selectVue(loadWeapons(), only);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
    return;
  }
  console.log(dryRun ? "Destination : aucune (--dry-run, rien n'est envoyé)" : `Destination : ${site}`);
  const cleaned = cleanOldWork();
  if (cleaned) console.log(`${cleaned} dossier(s) d'exports interrompus supprimé(s) de ${os.tmpdir()}.`);
  if (!dryRun) {
    try {
      await checkSite(site);  // avant l'export (environ 47 min pour tout)
    } catch (e) {
      console.error(`\n${e.message}`);
      process.exitCode = 1;
      return;
    }
  }
  const work = makeWork(), stopped = guardWork(work);
  try {
    const { csgo, version } = findCs2();
    const vpk = pakVpk(csgo), exe = s2v ?? DEFAULT_S2V, io = await makeIO(), files = {};
    console.log(`CS2 : ${csgo} (version ${version || "inconnue"}) ; ${pick.arms.length} bras, ${pick.weapons.length} arme(s)`);
    const s2vTo = (args, out) => { fs.mkdirSync(path.dirname(out), { recursive: true }); runS2v(exe, args); return out; };
    const keep = async (name, doc) => {
      files[name] = path.join(work, `${name}.glb`);
      await io.write(files[name], await optimizeVm(doc));
      console.log(`${name} : ${mb(fs.statSync(files[name]).size)}`);
    };
    for (const side of pick.arms) {
      const raw = path.join(work, "export", `bras-${side}`, "bras.glb");
      await keep(`bras-${side}`, prepareArms(await io.read(s2vTo(vueArgs.arms(vpk, side, raw), raw))));
      fs.rmSync(path.dirname(raw), { recursive: true, force: true });  // export brut : ~30 Mo de PNG
    }
    for (const w of pick.weapons) {
      const dir = path.join(work, "export", w.key), model = path.join(dir, "modele", "arme.glb"), clips = path.join(dir, "clips", "clips.glb");
      s2vTo(vueArgs.model(vpk, w.model, model), model);
      s2vTo(vueArgs.clips(vpk, Object.values(w.clips), clips), clips);
      await keep(`arme-${w.key}`, buildWeapon(await io.read(model), await io.read(clips), w.clips));
      fs.rmSync(dir, { recursive: true, force: true });  // export brut : jusqu'à 60 Mo (textures 4096²)
    }
    const total = Object.values(files).reduce((s, f) => s + fs.statSync(f).size, 0);
    console.log(`Total : ${mb(total)} pour ${Object.keys(files).length} fichier(s).`);
    if (dryRun) {
      console.log("--dry-run : rien n'est envoyé.");
      return;
    }
    const meta = { build: version, exported_at: new Date().toISOString(), tool: TOOL };
    await withSession(site, root, "de fichiers 3D", async (request) => {
      for (const [name, file] of Object.entries(files)) {
        const res = await uploadFile({ request, base: `${site}/api/assets3d`, begin: `vue/${name}/upload`, file, meta,
          log: (got, size) => process.stdout.write(`\r  ${name} : ${mb(got)} / ${mb(size)}   `) });
        console.log(`\n  ${name} en place : ${site}${res.files[name].url}`);
      }
    });
    console.log("Terminé : ouvrez un replay en 3D et choisissez la caméra « Joueur ».");
  } catch (e) {
    // Ctrl+C pendant Source 2 Viewer ou pendant l'envoi : « Interrompu. » et 130, pas un faux message d'échec
    if (e.interrupted || stopped()) process.exit(130);
    console.error(`\n${e.message}`);
    process.exitCode = 1;
  }
}
