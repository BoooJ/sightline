import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { Document } from "@gltf-transform/core";
import sharp from "sharp";
import { makeIO } from "../lib/optimize.mjs";
import { buildWeapon, CLIPS_NODE, optimizeVm, prepareArms, vueArgs, WEAPON_NODE } from "../lib/viewmodel.mjs";
import { tmpDir } from "./tmp.mjs";

// En miniature, ce que Source 2 Viewer exporte : modèle d'arme (squelette, corps body_hd et body_legacy skinnés, textures
// de 2048 px dont une normale RVBA à alpha nul, animations propres au modèle) et agent avec clips de vue (squelette de
// l'agent, squelette d'arme « .vnmskel », maillages skinnés, clips nommés par chemin complet).
const SRC = [-0.5, -0.5, -0.5, 0.5];
const DIR = "animation/anims/viewmodel/rifle/rifle_x";

const acc = (doc, type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(doc.getRoot().listBuffers()[0]);

function skinned(doc, name, joints, material = null) {
  const pos = acc(doc, "VEC3", new Float32Array([0, 0, 0, 0.1, 0, 0, 0, 0.1, 0]));
  const prim = doc.createPrimitive().setAttribute("POSITION", pos)
    .setAttribute("JOINTS_0", acc(doc, "VEC4", new Uint16Array(12)))
    .setAttribute("WEIGHTS_0", acc(doc, "VEC4", new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])));
  if (material) prim.setAttribute("TEXCOORD_0", acc(doc, "VEC2", new Float32Array([0, 0, 1, 0, 0, 1]))).setMaterial(material);
  const ibm = new Float32Array(16 * joints.length);
  joints.forEach((_, k) => ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 16 * k));
  const skin = doc.createSkin().setInverseBindMatrices(acc(doc, "MAT4", ibm));
  for (const j of joints) skin.addJoint(j);
  return doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim)).setSkin(skin);
}

function clip(doc, name, tracks) {
  const anim = doc.createAnimation(name);
  for (const [node, pathName, times, values] of tracks) {
    const type = pathName === "rotation" ? "VEC4" : "VEC3";
    const s = doc.createAnimationSampler().setInput(acc(doc, "SCALAR", new Float32Array(times)))
      .setOutput(acc(doc, type, new Float32Array(values))).setInterpolation("LINEAR");
    anim.addSampler(s).addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath(pathName).setSampler(s));
  }
  return anim;
}

async function modelDoc() {
  const doc = new Document();
  doc.createBuffer();
  const scene = doc.createScene();
  const clipBone = doc.createNode("clip").setTranslation([0, -0.05, 0.1]);
  const offset = doc.createNode("weapon_offset").addChild(clipBone);
  const weapon = doc.createNode("weapon").setTranslation([-0.0049, 0.0757, 0.0754]).setRotation(SRC).addChild(offset);
  scene.addChild(doc.createNode("weapons\\models\\x\\weapon_x.vmdl_c").addChild(weapon));
  const color = await sharp({ create: { width: 2048, height: 2048, channels: 3, background: { r: 90, g: 60, b: 30 } } }).png().toBuffer();
  const raw = Buffer.alloc(256 * 256 * 4);
  for (let k = 0; k < 256 * 256; k++) raw.set([k % 256, (k >> 8) % 256, 255, 0], 4 * k);  // normale RVBA, alpha nul
  const normal = await sharp(raw, { raw: { width: 256, height: 256, channels: 4 } }).png().toBuffer();
  const mat = doc.createMaterial("x_default").setBaseColorTexture(doc.createTexture("couleur").setImage(color).setMimeType("image/png"))
    .setNormalTexture(doc.createTexture("normale").setImage(normal).setMimeType("image/png"));
  for (const body of ["body_hd", "body_legacy"]) scene.addChild(skinned(doc, `weapons\\models\\x\\weapon_x.vmdl_c.${body}`, [weapon, offset, clipBone], mat));
  clip(doc, "shoot", [[offset, "translation", [0, 1], [0, 0, 0, 0, 0, -0.1]]]);  // animation propre au modèle : retirée
  return doc;
}

/** Agent avec clips de vue : idle (1 clé), shoot (3 clés sur 0,5 s), lookat01 (non demandé). */
function agentDoc(meshes = ["firstperson_sleeves"]) {
  const doc = new Document();
  doc.createBuffer();
  const scene = doc.createScene();
  const wpn = doc.createNode("wpn"), rootMotion = doc.createNode("root_motion").addChild(wpn);
  scene.addChild(doc.createNode("agents\\models\\ctm_sas\\ctm_sas.vmdl_c").addChild(rootMotion));
  const clipBone = doc.createNode("clip"), offset = doc.createNode("weapon_offset").addChild(clipBone);
  const weapon = doc.createNode("weapon").addChild(offset);
  scene.addChild(doc.createNode("animation/skeletons/weapons/x.vnmskel").addChild(weapon));
  for (const m of meshes) scene.addChild(skinned(doc, `agents\\models\\ctm_sas\\ctm_sas.vmdl_c.${m}`, [rootMotion, wpn]));
  scene.addChild(skinned(doc, "animation/skeletons/weapons/x.vnmskel.empty_mesh_reference", [weapon, offset]));
  const still = [[weapon, "rotation", [0], SRC], [weapon, "translation", [0], [0, 0, 0]]];
  clip(doc, `${DIR}/idle_x`, [[wpn, "translation", [0], [-0.1315, -0.063, 0.3749]], ...still]);
  clip(doc, `${DIR}/shoot1_x`, [[wpn, "translation", [0, 0.25, 0.5], [-0.1315, -0.063, 0.3749, -0.137, -0.052, 0.281, -0.1315, -0.063, 0.3749]],
    [clipBone, "translation", [0, 0.5], [0, 0, 0, 0, -0.02, 0]], ...still]);
  clip(doc, `${DIR}/lookat01_x`, [[wpn, "translation", [0, 1], [0, 0, 0, 0, 1, 0]]]);
  return doc;
}

const under = (node) => { const out = []; const walk = (n) => { out.push(n); n.listChildren().forEach(walk); }; walk(node); return out; };
const near = (a, b, eps = 1e-3) => a.length === b.length && a.every((v, k) => Math.abs(v - b[k]) < eps);

test("arme de vue : body_hd sous sl_arme, squelette des clips sous sl_clips, clips renommés par rôle, rien d'autre", async (t) => {
  const dir = tmpDir(t, "map3d-vm-"), io = await makeIO(), out = path.join(dir, "arme-x.glb");
  const doc = buildWeapon(await modelDoc(), agentDoc(), { idle: `${DIR}/idle_x`, shoot: `${DIR}/shoot1_x` });
  await io.write(out, await optimizeVm(doc));
  const root = (await io.read(out)).getRoot();
  const [scene] = root.listScenes();
  assert.equal(root.listScenes().length, 1);
  assert.deepEqual(scene.listChildren().map((n) => n.getName()), [WEAPON_NODE, CLIPS_NODE]);
  const [arme, clips] = scene.listChildren();
  assert.deepEqual(under(arme).filter((n) => n.getMesh()).map((n) => n.getName()), ["weapons\\models\\x\\weapon_x.vmdl_c.body_hd"]);
  assert.ok(under(clips).every((n) => !n.getMesh() && !n.getSkin()));  // squelette seul : ni maillage ni peau
  assert.ok(under(clips).some((n) => n.getName() === "wpn") && under(clips).some((n) => n.getName() === "weapon"));
  assert.equal(root.listSkins().length, 1);
  const anims = Object.fromEntries(root.listAnimations().map((a) => [a.getName(), a]));
  assert.deepEqual(Object.keys(anims).sort(), ["idle", "shoot"]);  // lookat01 et l'animation propre au modèle retirés
  assert.equal(anims.shoot.listChannels().length, 4);
  const inClips = new Set(under(clips));
  for (const a of Object.values(anims)) for (const c of a.listChannels()) assert.ok(inClips.has(c.getTargetNode()));
  const wpn = anims.shoot.listChannels().find((c) => c.getTargetNode().getName() === "wpn").getSampler();
  assert.ok(near([...wpn.getInput().getArray()], [0, 0.25, 0.5]));
  assert.ok(near([...wpn.getOutput().getArray()].slice(3, 6), [-0.137, -0.052, 0.281]));  // positions au millimètre
  assert.ok(root.listExtensionsUsed().some((e) => e.extensionName === "EXT_meshopt_compression"));
  for (const tex of root.listTextures()) {
    const meta = await sharp(Buffer.from(tex.getImage())).metadata();
    assert.equal(tex.getMimeType(), "image/webp");
    assert.ok(meta.width <= 1024 && meta.height <= 1024);
  }
  const normal = root.listMaterials()[0].getNormalTexture();
  const stats = await sharp(Buffer.from(normal.getImage())).stats();
  assert.equal(stats.channels.length, 3);  // alpha retiré avant WebP : sinon le RVB de la normale était jeté (plate)
  assert.ok(stats.channels[0].mean > 100 && stats.channels[2].mean > 200, JSON.stringify(stats.channels.map((c) => c.mean)));
});

test("arme de vue : un clip demandé absent de l'export arrête tout", async () => {
  assert.throws(() => buildWeapon(new Document(), agentDoc(), { idle: `${DIR}/idle_x`, reload: `${DIR}/reload_x` }),
    /Clips absents de l'export : animation\/anims\/viewmodel\/rifle\/rifle_x\/reload_x/);
});

test("bras : maillages et squelette gardés, clip d'export et racines ajoutées retirés, pas d'accessors orphelins", async (t) => {
  const dir = tmpDir(t, "map3d-vm-"), io = await makeIO(), out = path.join(dir, "bras-ct.glb");
  const doc = prepareArms(agentDoc(["firstperson_default_gloves_arms", "firstperson_sleeves"]));
  await io.write(out, await optimizeVm(doc));
  const root = (await io.read(out)).getRoot();
  assert.equal(root.listAnimations().length, 0);
  assert.deepEqual(root.listNodes().filter((n) => n.getMesh()).map((n) => n.getName().split(".").pop()).sort(),
    ["firstperson_default_gloves_arms", "firstperson_sleeves"]);
  assert.ok(root.listNodes().some((n) => n.getName() === "wpn"));
  assert.ok(!root.listNodes().some((n) => /vnmskel|^weapon$/.test(n.getName())));
  // chaque maillage garde sa peau (les deux, identiques ici, fusionnées par dedup)
  assert.deepEqual(root.listNodes().filter((n) => n.getMesh()).map((n) => n.getSkin()?.listJoints().length), [2, 2]);
  assert.ok(root.listAccessors().length <= 14, `${root.listAccessors().length} accessors`);  // maillages et peaux seulement
});

test("lignes de commande de Source 2 Viewer (essai du 30/10/2026)", () => {
  const vpk = "X:/csgo/pak01_dir.vpk", common = ["-d", "--gltf_export_format", "glb"];
  assert.deepEqual(vueArgs.arms(vpk, "t", "w/bras.glb"), ["-i", vpk, "-f", "agents/models/tm_phoenix/tm_phoenix.vmdl_c", "-o", "w/bras.glb",
    ...common, "--gltf_export_materials", "--gltf_textures_adapt", "--gltf_export_animations", "--gltf_mesh_list",
    "firstperson_default_gloves_arms,firstperson_sleeves", "--gltf_animation_list", "animation/anims/viewmodel/rifle/rifle_ak/idle_ak"]);
  assert.deepEqual(vueArgs.model(vpk, "weapons/models/ak47/weapon_rif_ak47.vmdl_c", "w/arme.glb"), ["-i", vpk, "-f",
    "weapons/models/ak47/weapon_rif_ak47.vmdl_c", "-o", "w/arme.glb", ...common, "--gltf_export_materials", "--gltf_textures_adapt",
    "--gltf_export_animations"]);
  assert.deepEqual(vueArgs.clips(vpk, [`${DIR}/idle_x`, `${DIR}/shoot1_x`], "w/clips.glb"), ["-i", vpk, "-f",
    "agents/models/ctm_sas/ctm_sas.vmdl_c", "-o", "w/clips.glb", ...common, "--gltf_export_animations", "--gltf_mesh_list",
    "firstperson_sleeves", "--gltf_animation_list", `${DIR}/idle_x,${DIR}/shoot1_x`]);
});
