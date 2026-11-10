// Joueurs vus de l'extérieur (node scripts/map3d/export.mjs joueurs) : Source 2 Viewer sur pak01_dir.vpk de CS2,
// préparation (lib/agents.mjs), envoi par morceaux vers /api/assets3d (type « joueurs »), avec la même vérification du
// site et du compte que les cartes. Ce sont des fichiers de Valve : ils ne vont que sur votre Sightline, jamais dans le
// dépôt (dossier de travail temporaire, supprimé à la fin).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { absentRoles, agentModel, agentsInList, ALONE, buildAlone, buildAnims, buildWorldWeapon, CLASSES, classClips, joueursArgs, lightenWorldWeapon,
  prepareAgent } from "./agents.mjs";
import { makeIO } from "./optimize.mjs";
import { RAGDOLL_FILE, ragdollArgs, ragdollDoc, readRagdoll } from "./ragdoll.mjs";
import { DEFAULT_S2V, runS2v, s2vText } from "./s2v.mjs";
import { withSession } from "./session.mjs";
import { findCs2, pakVpk } from "./steam.mjs";
import { checkSite, uploadFile } from "./upload.mjs";
import { optimizeVm, vueArgs } from "./viewmodel.mjs";
import { loadWeapons } from "./weapons.mjs";
import { cleanOldWork, guardWork, makeWork } from "./work.mjs";

export const TOOL = "joueurs 1";
/** Textures des agents et des armes du monde (px) : vus de loin, 512 suffisent et ménagent la puce graphique intégrée. */
export const TEXTURE_PX = 512;
const mb = (n) => `${(n / 1024 ** 2).toFixed(1)} Mo`;

/** Ce qu'il faut exporter : tout, ou ce que liste --only : « agents » (les deux camps), clips_<classe> (clips_rifle,
 *  clips_pistol, clips_knife), « clips_communes » (morts et atterrissages), des clés d'armes de lib/weapons.json (armes du
 *  monde ; « knife » est le couteau CT, pas les clips du couteau), « ragdoll » (corps et articulations du ragdoll des agents,
 *  fichier ragdoll), agent_<nom> (agent équipé, ex. agent_tm_leet_variantf ;
 *  fichier agent-<nom>), « agents_tous » (les agents équipables du VPK, sans SAS ni Phoenix). */
export function selectJoueurs(weapons, only) {
  if (!only) return { agents: ["ct", "t"], classes: [...CLASSES], communes: true, weapons, equipped: [], ragdoll: true };
  const keys = new Set(weapons.map((w) => w.key)), words = new Set(["agents", "clips_communes", ...CLASSES.map((c) => `clips_${c}`)]);
  words.add("agents_tous").add("ragdoll");
  const unknown = only.filter((k) => !words.has(k) && !keys.has(k) && !/^agent_[a-z0-9_]{2,40}$/.test(k));
  if (unknown.length) {
    throw new Error(`Inconnu : ${unknown.join(", ")} (${[...words].join(", ")}, agent_<nom> ou clés de scripts/map3d/lib/weapons.json : ${[...keys].join(", ")})`);
  }
  return { agents: only.includes("agents") ? ["ct", "t"] : [], classes: CLASSES.filter((c) => only.includes(`clips_${c}`)),
    communes: only.includes("clips_communes"), weapons: weapons.filter((w) => only.includes(w.key)),
    equipped: only.includes("agents_tous") ? "tous" : only.filter((k) => k.startsWith("agent_")).map((k) => k.slice(6)),
    ragdoll: only.includes("ragdoll") };
}

/** Ce qui touche CS2, Source 2 Viewer, le site, la session et l'envoi : remplacé par des faux dans les tests
 *  (test/joueurs.test.mjs), qui établissent ainsi que --dry-run n'appelle ni checkSite, ni withSession, ni uploadFile. */
const REAL = { findCs2, pakVpk, runS2v, s2vText, listVpk, checkSite, withSession, uploadFile };

/** Liste des fichiers d'agents du VPK (texte de `--vpk_list`, voir agentsInList) ; erreur claire si Source 2 Viewer ne
 *  démarre pas ou sort en erreur. */
function listVpk(exe, vpk) {
  const r = spawnSync(exe, joueursArgs.list(vpk), { encoding: "utf8", maxBuffer: 64 * 1024 ** 2 });
  if (r.error || r.status !== 0) {
    throw new Error(`Liste des agents du VPK illisible (${r.error?.message ?? `Source 2 Viewer a échoué, code ${r.status}`}) : `
      + "rien n'est exporté ni envoyé. Vérifiez --s2v et relancez.");
  }
  return r.stdout ?? "";
}

/** Export, contrôles et envoi ; code de sortie dans process.exitCode (130 : interrompu). `deps` : remplacements de REAL
 *  et `tmp` (dossier des dossiers de travail, %TEMP% par défaut), pour les tests seulement. */
export async function runJoueurs({ site, s2v, only, dryRun }, root, deps = {}) {
  const d = { ...REAL, tmp: os.tmpdir(), ...deps };
  let pick;
  try {
    pick = selectJoueurs(loadWeapons(), only);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
    return;
  }
  console.log(dryRun ? "Destination : aucune (--dry-run, rien n'est envoyé)" : `Destination : ${site}`);
  const cleaned = cleanOldWork(d.tmp);
  if (cleaned) console.log(`${cleaned} dossier(s) d'exports interrompus supprimé(s) de ${d.tmp}.`);
  if (!dryRun) {
    try {
      await d.checkSite(site);  // avant l'export (plusieurs minutes)
    } catch (e) {
      console.error(`\n${e.message}`);
      process.exitCode = 1;
      return;
    }
  }
  const work = makeWork(d.tmp), stopped = guardWork(work);
  try {
    const { csgo, version } = d.findCs2();
    const vpk = d.pakVpk(csgo), exe = s2v ?? DEFAULT_S2V, io = await makeIO(), files = {};
    // agents équipés : fichiers agent-<nom> (ceux de --only, ou tous ceux du VPK) ; liste lue avant tout export
    let equipped = pick.equipped;
    if (equipped === "tous") {
      equipped = agentsInList(d.listVpk(exe, vpk));
      if (equipped.length === 0) {
        throw new Error("Aucun agent équipable dans la liste du VPK (agents_tous) : rien n'est exporté ni envoyé. "
          + "Vérifiez la version de Source 2 Viewer (20.1) et de CS2.");
      }
    }
    console.log(`CS2 : ${csgo} (version ${version || "inconnue"}) ; ${pick.agents.length + equipped.length} agent(s), ${pick.classes.length} classe(s), `
      + `${pick.communes ? "clips communs, " : ""}${pick.weapons.length} arme(s) du monde`);
    const s2vTo = (args, out) => { fs.mkdirSync(path.dirname(out), { recursive: true }); d.runS2v(exe, args); return out; };
    const raw = (name, file) => path.join(work, "export", name, file);
    const keep = async (name, doc, size) => {
      files[name] = path.join(work, `${name}.glb`);
      const done = await optimizeVm(doc, size);
      await io.write(files[name], done);
      fs.rmSync(path.join(work, "export", name), { recursive: true, force: true });  // export brut : textures en 2048 px
      console.log(`${name} : ${mb(fs.statSync(files[name]).size)}`);
      return done;
    };
    for (const side of pick.agents) {
      const out = raw(`agent-${side}`, "agent.glb");
      await keep(`agent-${side}`, prepareAgent(await io.read(s2vTo(joueursArgs.agent(vpk, side, out), out))), TEXTURE_PX);
    }
    for (const agent of equipped) {
      const out = raw(`agent-${agent}`, "agent.glb");
      await keep(`agent-${agent}`, prepareAgent(await io.read(s2vTo(joueursArgs.model(vpk, agentModel(agent), out), out))), TEXTURE_PX);
    }
    if (pick.ragdoll) {
      // bloc PHYS de SAS lu en texte (aucun export glTF) ; le même ragdoll pour tous les agents
      const rag = readRagdoll(d.s2vText(exe, ragdollArgs(vpk)));
      files[RAGDOLL_FILE] = path.join(work, `${RAGDOLL_FILE}.glb`);
      await io.write(files[RAGDOLL_FILE], ragdollDoc(rag));
      console.log(`${RAGDOLL_FILE} : ${rag.bones.length} corps, ${rag.joints.length} articulation(s), `
        + `${(fs.statSync(files[RAGDOLL_FILE]).size / 1024).toFixed(1)} Ko`);
    }
    for (const cls of pick.classes) {
      const roles = classClips(cls), out = raw(`anims-${cls}`, "clips.glb");
      const doc = await keep(`anims-${cls}`, buildAnims(await io.read(s2vTo(joueursArgs.clips(vpk, Object.values(roles), out), out)), roles));
      // une mise à jour de CS2 qui renommerait les sauts ou le désamorçage : le fichier part, mais cela se voit
      const absent = absentRoles(doc, roles);
      if (absent.length) console.warn(`anims-${cls} : pas de ${absent.join(", ")} (facultatifs : fichier gardé, ces animations y manqueront)`);
    }
    if (pick.communes) {
      const entries = [];
      for (const [role, clip] of Object.entries(ALONE)) {
        const out = raw("anims-communes", `${role}.glb`);
        entries.push([role, await io.read(s2vTo(joueursArgs.alone(vpk, clip, out), out))]);
      }
      await keep("anims-communes", buildAlone(entries));
    }
    for (const w of pick.weapons) {
      const out = raw(`monde-${w.key}`, "arme.glb");
      const model = buildWorldWeapon(await io.read(s2vTo(vueArgs.model(vpk, w.model, out), out)));
      await keep(`monde-${w.key}`, await lightenWorldWeapon(model), TEXTURE_PX);
    }
    const total = Object.values(files).reduce((s, f) => s + fs.statSync(f).size, 0);
    console.log(`Total : ${mb(total)} pour ${Object.keys(files).length} fichier(s).`);
    if (dryRun) {
      console.log("--dry-run : rien n'est envoyé.");
      return;
    }
    const meta = { build: version, exported_at: new Date().toISOString(), tool: TOOL };
    await d.withSession(site, root, "de fichiers 3D", async (request) => {
      for (const [name, file] of Object.entries(files)) {
        const res = await d.uploadFile({ request, base: `${site}/api/assets3d`, begin: `joueurs/${name}/upload`, file, meta,
          log: (got, size) => process.stdout.write(`\r  ${name} : ${mb(got)} / ${mb(size)}   `) });
        console.log(`\n  ${name} en place : ${site}${res.files[name].url}`);
      }
    });
    console.log("Terminé : ouvrez un replay en 3D, les joueurs y sont en modèles d'agents.");
  } catch (e) {
    // Ctrl+C pendant Source 2 Viewer ou pendant l'envoi : « Interrompu. » et 130, pas un faux message d'échec
    if (e.interrupted || stopped()) process.exit(130);
    console.error(`\n${e.message}`);
    process.exitCode = 1;
  }
}
