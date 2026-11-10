import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Document } from "@gltf-transform/core";
import { classClips } from "../lib/agents.mjs";
import { runJoueurs, selectJoueurs, TEXTURE_PX, TOOL } from "../lib/joueurs.mjs";
import { makeIO } from "../lib/optimize.mjs";
import { loadWeapons } from "../lib/weapons.mjs";
import { PHYS_RAGDOLL, PHYS_TEXT } from "./physText.mjs";
import { tmpDir } from "./tmp.mjs";

test("joueurs : tout par défaut ; --only choisit agents, clips d'une classe, clips communs et armes ; inconnu refusé", () => {
  const all = loadWeapons();
  assert.deepEqual(selectJoueurs(all, null), { agents: ["ct", "t"], classes: ["rifle", "pistol", "knife"], communes: true, weapons: all, equipped: [], ragdoll: true });
  const some = selectJoueurs(all, ["clips_knife", "ak47", "clips_communes"]);
  assert.deepEqual(some.agents, []);
  assert.deepEqual(some.classes, ["knife"]);
  assert.equal(some.communes, true);
  assert.deepEqual(some.weapons.map((w) => w.key), ["ak47"]);
  assert.deepEqual(selectJoueurs(all, ["agents"]), { agents: ["ct", "t"], classes: [], communes: false, weapons: [], equipped: [], ragdoll: false });
  // « knife » est le couteau CT du monde (clé de weapons.json), pas les clips du couteau
  assert.deepEqual(selectJoueurs(all, ["knife"]).weapons.map((w) => w.key), ["knife"]);
  assert.deepEqual(selectJoueurs(all, ["knife"]).classes, []);
  assert.throws(() => selectJoueurs(all, ["sas"]), /Inconnu : sas \(agents, clips_communes, clips_rifle, clips_pistol, clips_knife, agents_tous, ragdoll, agent_<nom> ou clés .*ak47/);
  assert.equal(TEXTURE_PX, 512);
});

test("export.mjs joueurs : aiguillé vers runJoueurs ; clé inconnue refusée avant tout (ni CS2, ni dossier, ni site)", () => {
  const exportJs = fileURLToPath(new URL("../export.mjs", import.meta.url));
  const r = spawnSync(process.execPath, [exportJs, "joueurs", "--only", "agents,sas", "--dry-run"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^Inconnu : sas \(agents, clips_communes/);
  assert.doesNotMatch(r.stdout, /Destination/);
});

const SAS = "agents/models/ctm_sas/ctm_sas.vmdl_c", ROLES = classClips("rifle"), LOST = ["jump_n", "defuse_crouch"];
const SITE = "http://127.0.0.1:9", URL_ANIMS = "/api/assets3d/joueurs/anims-rifle-0123456789ab.glb";

/** Export des clips de fusil à la manière de Source 2 Viewer, sans les rôles de LOST : agent > root_motion > pelvis, un
 *  clip par chemin (une piste du bassin). */
async function clipsGlb() {
  const doc = new Document(), buf = doc.createBuffer(), pelvis = doc.createNode("pelvis");
  doc.createScene().addChild(doc.createNode("agents\\models\\ctm_sas\\ctm_sas.vmdl_c").addChild(doc.createNode("root_motion").addChild(pelvis)));
  const acc = (type, a) => doc.createAccessor().setType(type).setArray(new Float32Array(a)).setBuffer(buf);
  for (const [role, clip] of Object.entries(ROLES)) {
    if (LOST.includes(role)) continue;
    const s = doc.createAnimationSampler().setInput(acc("SCALAR", [0, 0.5])).setOutput(acc("VEC3", [0, 1, 0, 0, 1.02, 0]));
    doc.createAnimation(clip).addSampler(s)
      .addChannel(doc.createAnimationChannel().setTargetNode(pelvis).setTargetPath("translation").setSampler(s));
  }
  return (await makeIO()).writeBinary(doc);
}

/** Faux CS2, Source 2 Viewer, site, session et envoi : chaque appel noté dans `calls`, dans l'ordre ; console captée
 *  dans `out` ; dossier de travail dans un dossier temporaire du test ; process.exitCode remis ensuite. */
async function fakes(t) {
  const glb = await clipsGlb(), io = await makeIO(), calls = [], out = { log: [], warn: [], error: [] };
  for (const k of Object.keys(out)) t.mock.method(console, k, (...a) => { out[k].push(a.join(" ")); });
  const exitCode = process.exitCode;
  t.after(() => { process.exitCode = exitCode; });
  const deps = {
    tmp: tmpDir(t, "map3d-joueurs-"),
    findCs2: () => ({ csgo: "C:/cs2/csgo", version: "9999999" }),  // pas la version réelle : un vrai findCs2 se verrait
    pakVpk: (csgo) => `${csgo}/pak01_dir.vpk`,
    runS2v: (exe, args) => {
      calls.push(["runS2v", exe, args[args.indexOf("-i") + 1], args[args.indexOf("-f") + 1]]);
      fs.writeFileSync(args[args.indexOf("-o") + 1], glb);
    },
    checkSite: async (site) => { calls.push(["checkSite", site]); },
    withSession: async (site, root, what, fn) => { calls.push(["withSession", site, root, what]); await fn("requête"); },
    uploadFile: async ({ request, base, begin, file, meta }) => {
      const clips = (await io.read(file)).getRoot().listAnimations().map((a) => a.getName());
      calls.push(["uploadFile", { request, base, begin, file: path.basename(file), tool: meta.tool, build: meta.build, clips: clips.length }]);
      return { files: { [path.basename(file, ".glb")]: { url: URL_ANIMS } } };
    },
  };
  return { deps, calls, out };
}

test("joueurs --dry-run : rien n'est envoyé (ni site, ni session, ni envoi) ; rôles facultatifs absents signalés sans arrêt", async (t) => {
  const { deps, calls, out } = await fakes(t);
  // reste d'un export interrompu (sans verrou, vieux de 2 h) : le ménage se fait dans le dossier donné, pas dans %TEMP%
  const old = path.join(deps.tmp, "sightline-map3d-ancien"), twoHoursAgo = (Date.now() - 2 * 3600_000) / 1000;
  fs.mkdirSync(old);
  fs.utimesSync(old, twoHoursAgo, twoHoursAgo);
  await runJoueurs({ site: SITE, s2v: "X:/s2v.exe", only: ["clips_rifle"], dryRun: true }, "R", deps);
  assert.deepEqual(out.error, []);
  assert.notEqual(process.exitCode, 1);
  assert.deepEqual(calls, [["runS2v", "X:/s2v.exe", "C:/cs2/csgo/pak01_dir.vpk", SAS]]);
  assert.ok(!fs.existsSync(old));
  // dossier de travail dans le dossier donné (supprimé à la sortie du processus, ici par le test)
  assert.equal(fs.readdirSync(deps.tmp).filter((n) => n.startsWith("sightline-map3d-")).length, 1);
  // les autres avertissements viennent de gltf-transform (« reorder: … » sur un fichier sans maillage)
  assert.deepEqual(out.warn.filter((w) => w.startsWith("anims-")),
    ["anims-rifle : pas de jump_n, defuse_crouch (facultatifs : fichier gardé, ces animations y manqueront)"]);
  assert.deepEqual(out.log.slice(0, 2), ["Destination : aucune (--dry-run, rien n'est envoyé)",
    `1 dossier(s) d'exports interrompus supprimé(s) de ${deps.tmp}.`]);
  assert.equal(out.log.at(-1), "--dry-run : rien n'est envoyé.");
});

test("joueurs sans --dry-run : site vérifié avant l'export, puis envoi par la session vers /api/assets3d/joueurs/<nom>", async (t) => {
  const { deps, calls, out } = await fakes(t);
  await runJoueurs({ site: SITE, s2v: "X:/s2v.exe", only: ["clips_rifle"], dryRun: false }, "R", deps);
  assert.deepEqual(out.error, []);
  assert.notEqual(process.exitCode, 1);
  assert.deepEqual(calls.map(([k]) => k), ["checkSite", "runS2v", "withSession", "uploadFile"]);
  assert.deepEqual(calls[0], ["checkSite", SITE]);
  assert.deepEqual(calls[2], ["withSession", SITE, "R", "de fichiers 3D"]);
  assert.deepEqual(calls[3][1], { request: "requête", base: `${SITE}/api/assets3d`, begin: "joueurs/anims-rifle/upload",
    file: "anims-rifle.glb", tool: TOOL, build: "9999999", clips: Object.keys(ROLES).length - LOST.length });
  assert.ok(out.log.includes(`\n  anims-rifle en place : ${SITE}${URL_ANIMS}`));
});

test("agents équipés : --only agent_<nom> ou agents_tous ; chemin du modèle ; liste du VPK", async () => {
  const { agentModel, agentsInList } = await import("../lib/agents.mjs");
  const all = loadWeapons();
  assert.deepEqual(selectJoueurs(all, ["agent_tm_leet_variantf", "agent_ctm_st6_varianti"]).equipped, ["tm_leet_variantf", "ctm_st6_varianti"]);
  assert.equal(selectJoueurs(all, ["agents_tous"]).equipped, "tous");
  assert.equal(agentModel("tm_leet_variantf"), "agents/models/tm_leet/tm_leet_variantf.vmdl_c");
  assert.equal(agentModel("tm_professional_varf1"), "agents/models/tm_professional/tm_professional_varf1.vmdl_c");
  assert.equal(agentModel("tm_jungle_raider_variantb2"), "agents/models/tm_jungle_raider/tm_jungle_raider_variantb2.vmdl_c");
  assert.equal(agentModel("ctm_fbi"), "agents/models/ctm_fbi/ctm_fbi.vmdl_c");
  const list = "agents/models/ctm_sas/ctm_sas.vmdl_c CRC:001 size:5\r\nagents/models/tm_leet/tm_leet_variantf.vmdl_c CRC:002 size:5\r\n"
    + "agents/models/shared/arms/glove_x/glove_x.vmdl_c CRC:004 size:5\r\n";
  assert.deepEqual(agentsInList(list), ["tm_leet_variantf"]);  // ni les agents par défaut, ni les gants
});

const sent = (calls) => calls.filter(([k]) => k === "withSession" || k === "uploadFile");

test("agents_tous : liste du VPK en échec (code de sortie, programme introuvable) ou vide : message clair, code 1, rien exporté ni envoyé", async (t) => {
  for (const [what, list, expected] of [
    ["code de sortie", () => { throw new Error("Liste des agents du VPK illisible (Source 2 Viewer a échoué, code 3) : rien n'est exporté ni envoyé."); }, /illisible .*code 3/],
    ["liste vide", () => "", /Aucun agent équipable dans la liste du VPK/],
    ["que des agents par défaut", () => "agents/models/ctm_sas/ctm_sas.vmdl_c CRC:001 size:5\r\n", /Aucun agent équipable/],
  ]) {
    const { deps, calls, out } = await fakes(t);
    await runJoueurs({ site: SITE, s2v: "X:/s2v.exe", only: ["agents_tous"], dryRun: false }, "R", { ...deps, listVpk: list });
    assert.equal(process.exitCode, 1, what);
    process.exitCode = undefined;  // remis avant le tour suivant (fakes le garde pour le rendre à la fin)
    assert.match(out.error.join("\n"), expected, what);
    assert.deepEqual(calls.map(([k]) => k), ["checkSite"], what);  // ni export (runS2v), ni session, ni envoi
    assert.deepEqual(sent(calls), [], what);
  }
});

test("agents_tous : le vrai appel de la liste (programme introuvable) échoue avec un message clair avant tout export", async (t) => {
  const { deps, calls, out } = await fakes(t);
  const { listVpk: _ignored, ...real } = deps;
  await runJoueurs({ site: SITE, s2v: path.join(deps.tmp, "absent", "s2v.exe"), only: ["agents_tous"], dryRun: true }, "R", real);
  assert.equal(process.exitCode, 1);
  assert.match(out.error.join("\n"), /Liste des agents du VPK illisible .*rien n'est exporté ni envoyé/);
  assert.deepEqual(calls, []);
});

test("agents_tous : liste normale (fins de ligne CRLF) → les agents équipables exportés, sans les agents par défaut ni les gants", async (t) => {
  const { deps, calls } = await fakes(t);
  const list = (exe, vpk) => {
    calls.push(["listVpk", exe, vpk]);
    return "agents/models/ctm_sas/ctm_sas.vmdl_c CRC:001 size:5\r\nagents/models/tm_leet/tm_leet_variantf.vmdl_c CRC:002 size:5\r\n"
      + "agents/models/ctm_fbi/ctm_fbi.vmdl_c CRC:003 size:5\r\nagents/models/shared/arms/glove_x/glove_x.vmdl_c CRC:004 size:5\r\n";
  };
  await runJoueurs({ site: SITE, s2v: "X:/s2v.exe", only: ["agents_tous"], dryRun: true }, "R", { ...deps, listVpk: list });
  assert.deepEqual(calls[0], ["listVpk", "X:/s2v.exe", "C:/cs2/csgo/pak01_dir.vpk"]);
  assert.deepEqual(calls.filter(([k]) => k === "runS2v").map((c) => c[3]),
    ["agents/models/ctm_fbi/ctm_fbi.vmdl_c", "agents/models/tm_leet/tm_leet_variantf.vmdl_c"]);
});

test("ragdoll : --only ragdoll lit le bloc PHYS de SAS en texte (aucun export glTF) et envoie le fichier « ragdoll »", async (t) => {
  const { deps, calls, out } = await fakes(t);
  const io = await makeIO(), seen = [];
  const s2vText = (exe, args) => { calls.push(["s2vText", exe, args[args.indexOf("-i") + 1], args[args.indexOf("-f") + 1], args[args.indexOf("-b") + 1]]); return PHYS_TEXT; };
  const uploadFile = async (o) => { seen.push((await io.read(o.file)).getRoot().listScenes()[0].getExtras()); return deps.uploadFile(o); };
  await runJoueurs({ site: SITE, s2v: "X:/s2v.exe", only: ["ragdoll"], dryRun: false }, "R", { ...deps, s2vText, uploadFile });
  assert.deepEqual(out.error, []);
  assert.deepEqual(calls.map(([k]) => k), ["checkSite", "s2vText", "withSession", "uploadFile"]);
  assert.deepEqual(calls[1], ["s2vText", "X:/s2v.exe", "C:/cs2/csgo/pak01_dir.vpk", SAS, "PHYS"]);
  assert.equal(calls[3][1].begin, "joueurs/ragdoll/upload");
  assert.deepEqual(seen, [{ sl_ragdoll: PHYS_RAGDOLL }]);
  assert.ok(out.log.some((l) => /^ragdoll : 2 corps, 1 articulation\(s\), [\d.]+ Ko$/.test(l)));
});

test("ragdoll : bloc PHYS illisible : message clair, code 1, rien envoyé", async (t) => {
  const { deps, calls, out } = await fakes(t);
  await runJoueurs({ site: SITE, s2v: "X:/s2v.exe", only: ["ragdoll"], dryRun: false }, "R", { ...deps, s2vText: () => "rien" });
  assert.equal(process.exitCode, 1);
  assert.match(out.error.join("\n"), /Bloc PHYS de .* introuvable/);
  assert.deepEqual(sent(calls), []);
});
