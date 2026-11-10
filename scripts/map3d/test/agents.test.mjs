import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { Document } from "@gltf-transform/core";
import sharp from "sharp";
import { absentRoles, ALONE, buildAlone, buildAnims, buildWorldWeapon, CLASSES, classClips, joueursArgs, lightenWorldWeapon, REQUIRED,
  WORLD_WEAPON_ERROR, WORLD_WEAPON_VERTS, WORLD_WEAPON_WEIGHTS } from "../lib/agents.mjs";
import { makeIO } from "../lib/optimize.mjs";
import { optimizeVm, WEAPON_NODE } from "../lib/viewmodel.mjs";
import { tmpDir } from "./tmp.mjs";

// En miniature, ce que Source 2 Viewer exporte : agent (racine « agents\…vmdl_c », os root_motion > pelvis), squelette
// d'arme et maillage POINTS ajoutés à la racine de la scène, maillage de l'agent, clips nommés par chemin complet avec une
// piste d'échelle à 1 sur chaque os (comme dans le jeu).
const acc = (doc, type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(doc.getRoot().listBuffers()[0]);
function track(doc, anim, node, pathName, times, values) {
  const type = pathName === "rotation" ? "VEC4" : "VEC3";
  const s = doc.createAnimationSampler().setInput(acc(doc, "SCALAR", new Float32Array(times)))
    .setOutput(acc(doc, type, new Float32Array(values))).setInterpolation("LINEAR");
  anim.addSampler(s).addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath(pathName).setSampler(s));
}
function mesh(doc, name) {
  const prim = doc.createPrimitive().setAttribute("POSITION", acc(doc, "VEC3", new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])));
  return doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim));
}
/** Document à la manière d'un export : `top` = nom de la racine du personnage ; `clips` : nom → hauteur du bassin. */
function exportDoc(top, clips, extraBone = null) {
  const doc = new Document();
  doc.createBuffer();
  const scene = doc.createScene(), pelvis = doc.createNode("pelvis"), rootMotion = doc.createNode("root_motion").addChild(pelvis);
  const extra = extraBone ? doc.createNode(extraBone) : null;
  if (extra) rootMotion.addChild(extra);
  scene.addChild(doc.createNode(top).addChild(rootMotion));
  const weapon = doc.createNode("weapon");
  scene.addChild(doc.createNode("animation/skeletons/weapons/m4a1_silencer.vnmskel").addChild(weapon));
  scene.addChild(mesh(doc, "animation/skeletons/weapons/m4a1_silencer.vnmskel.empty_mesh_reference"));
  scene.addChild(mesh(doc, `${top}.thirdperson_default_gloves`));
  for (const [name, y] of Object.entries(clips)) {
    const a = doc.createAnimation(name);
    track(doc, a, pelvis, "translation", [0, 0.5], [0, y, 0, 0, y + 0.02, 0]);
    track(doc, a, pelvis, "scale", [0], [1, 1, 1]);
    track(doc, a, weapon, "rotation", [0], [-0.5, -0.5, -0.5, 0.5]);
    if (extra) track(doc, a, extra, "translation", [0], [0, 1.8, 0]);
  }
  return doc;
}
const AGENT = "agents\\models\\ctm_sas\\ctm_sas.vmdl_c";
const under = (node) => { const out = []; const walk = (n) => { out.push(n); n.listChildren().forEach(walk); }; walk(node); return out; };

test("clips d'une classe : repos, 8 directions de marche, course et accroupi, saut et vol, désamorçage ; C4 pour le couteau", () => {
  const rifle = classClips("rifle");
  assert.equal(rifle.walk_ne, "animation/anims/world/rifle/_default_rifle/walk_ne_rifle");
  assert.equal(rifle.inair_crouch_stand, "animation/anims/world/rifle/_default_rifle/inair_crouch_stand_rifle");
  assert.equal(rifle.defuse, "animation/anims/world/shared/defuse/defuse_loop_rifle");
  assert.equal(Object.keys(rifle).length, 2 + 24 + 20 + 4);
  assert.equal(rifle.defuse_crouch, "animation/anims/world/shared/defuse/defuse_crouch_loop_rifle");
  assert.equal(classClips("knife").plant, "animation/anims/world/equipment/c4/planting");
  assert.equal(classClips("pistol").plant, undefined);
  assert.deepEqual(CLASSES, ["rifle", "pistol", "knife"]);
  for (const r of REQUIRED) assert.ok(rifle[r], r);
  assert.equal(REQUIRED.length, 2 + 24);  // repos et pas (marche, course, accroupi) dans les 8 directions
  assert.equal(ALONE.land_rifle, "animation/anims/world/shared/jump_additive_land_rifle.vnmclip+non_additive");
});

test("lignes de commande de Source 2 Viewer : agent, clips sur l'agent SAS, clip seul", () => {
  const vpk = "X:/csgo/pak01_dir.vpk", common = ["-d", "--gltf_export_format", "glb"];
  assert.deepEqual(joueursArgs.agent(vpk, "t", "w/agent.glb"), ["-i", vpk, "-f", "agents/models/tm_phoenix/tm_phoenix.vmdl_c", "-o",
    "w/agent.glb", ...common, "--gltf_export_materials", "--gltf_textures_adapt", "--gltf_export_animations", "--gltf_mesh_list",
    "thirdperson_body,thirdperson_default_gloves,defusekit", "--gltf_animation_list", "animation/anims/world/rifle/_default_rifle/idle_rifle"]);
  assert.deepEqual(joueursArgs.clips(vpk, ["a/x", "a/y"], "w/clips.glb"), ["-i", vpk, "-f", "agents/models/ctm_sas/ctm_sas.vmdl_c", "-o",
    "w/clips.glb", ...common, "--gltf_export_animations", "--gltf_mesh_list", "thirdperson_default_gloves", "--gltf_animation_list", "a/x,a/y"]);
  assert.deepEqual(joueursArgs.alone(vpk, ALONE.mort_chest_a, "w/m.glb"), ["-i", vpk, "-f",
    "animation/anims/world/shared/death_chest_a.vnmclip_c", "-o", "w/m.glb", ...common, "--gltf_export_animations"]);
});

test("clips d'une classe : squelette du personnage seul, clips renommés par rôle, pistes d'arme et d'échelle à 1 retirées", async (t) => {
  const roles = classClips("rifle"), clips = Object.fromEntries(Object.values(roles).map((p) => [p, 1]));
  clips["animation/anims/world/rifle/_default_rifle/turn_left_45_rifle"] = 1;  // non demandé
  const dir = tmpDir(t, "map3d-ag-"), io = await makeIO(), out = path.join(dir, "anims-rifle.glb");
  await io.write(out, await optimizeVm(buildAnims(exportDoc(AGENT, clips), roles)));
  const root = (await io.read(out)).getRoot();
  assert.deepEqual(root.listAnimations().map((a) => a.getName()).sort(), Object.keys(roles).sort());
  assert.equal(root.listMeshes().length + root.listSkins().length + root.listMaterials().length, 0);
  const [scene] = root.listScenes(), kept = new Set(scene.listChildren().flatMap(under));
  assert.deepEqual(scene.listChildren().map((n) => n.getName()), [AGENT]);
  for (const a of root.listAnimations()) {
    assert.deepEqual(a.listChannels().map((c) => `${c.getTargetNode().getName()}.${c.getTargetPath()}`), ["pelvis.translation"]);
    for (const c of a.listChannels()) assert.ok(kept.has(c.getTargetNode()));
  }
  const walk = root.listAnimations().find((a) => a.getName() === "walk_n").listChannels()[0].getSampler();
  assert.deepEqual([...walk.getOutput().getArray()].map((v) => +v.toFixed(3)), [0, 1, 0, 0, 1.02, 0]);
});

test("clips d'une classe, avant optimisation : personnage seul dans la scène, piste d'échelle autre que 1 gardée", () => {
  const roles = classClips("knife"), doc = exportDoc(AGENT, Object.fromEntries(Object.values(roles).map((p) => [p, 1])));
  const root = doc.getRoot(), pelvis = root.listNodes().find((n) => n.getName() === "pelvis");
  track(doc, root.listAnimations().find((a) => a.getName() === roles.idle), pelvis, "scale", [0, 0.5], [1, 1, 1, 1.1, 1, 1]);
  buildAnims(doc, roles);
  assert.deepEqual(root.listScenes()[0].listChildren().map((n) => n.getName()), [AGENT]);  // sans compter sur prune()
  assert.equal(root.listNodes().filter((n) => n.getMesh() || n.getSkin()).length, 0);
  const tracks = (role) => root.listAnimations().find((a) => a.getName() === role).listChannels()
    .map((c) => `${c.getTargetNode()?.getName()}.${c.getTargetPath()}`);
  assert.deepEqual(tracks("idle"), ["pelvis.translation", "pelvis.scale"]);
  assert.deepEqual(tracks("plant"), ["pelvis.translation"]);
});

test("clips d'une classe : un rôle obligatoire absent arrête tout, au nom de son clip", () => {
  const roles = classClips("pistol"), clips = Object.fromEntries(Object.values(roles).filter((p) => !p.endsWith("/run_sw_pistol")).map((p) => [p, 1]));
  assert.throws(() => buildAnims(exportDoc(AGENT, clips), roles), /Clips absents de l'export : animation\/anims\/world\/pistol\/_default_pistol\/run_sw_pistol/);
});

test("clips d'une classe : rôles facultatifs absents de l'export, ou vidés puis retirés à l'optimisation, listés dans l'ordre", async () => {
  const roles = classClips("rifle"), all = Object.values(roles).map((p) => [p, 1]);
  assert.deepEqual(absentRoles(buildAnims(exportDoc(AGENT, Object.fromEntries(all)), roles), roles), []);
  const lost = new Set([roles.jump_n, roles.defuse_crouch]), doc = exportDoc(AGENT, Object.fromEntries(all.filter(([p]) => !lost.has(p))));
  // inair_e : plus que l'échelle à 1 du bassin et l'os d'arme, retirés par buildAnims ; l'animation vide part au prune()
  for (const c of doc.getRoot().listAnimations().find((a) => a.getName() === roles.inair_e).listChannels()) {
    if (c.getTargetPath() === "translation") c.dispose();
  }
  buildAnims(doc, roles);
  assert.deepEqual(absentRoles(doc, roles), ["jump_n", "defuse_crouch"]);
  await optimizeVm(doc);
  assert.deepEqual(absentRoles(doc, roles), ["jump_n", "inair_e", "defuse_crouch"]);
});

test("clips exportés seuls : un document, le squelette du premier, pistes reliées par nom d'os, os inconnus retirés", async (t) => {
  const SKEL = "animation/skeletons/characters/worldmodel.vnmskel";
  const a = exportDoc(SKEL, { [`${ALONE.mort_chest_a}`]: 1 }), b = exportDoc(SKEL, { [`${ALONE.land_rifle}`]: 0.8 }, "camera");
  const dir = tmpDir(t, "map3d-ag-"), io = await makeIO(), out = path.join(dir, "anims-communes.glb");
  await io.write(out, await optimizeVm(buildAlone([["mort_chest_a", a], ["land_rifle", b]])));
  const root = (await io.read(out)).getRoot();
  assert.equal(root.listScenes().length, 1);
  assert.deepEqual(root.listAnimations().map((x) => x.getName()), ["mort_chest_a", "land_rifle"]);
  assert.equal(root.listNodes().filter((n) => n.getName() === "pelvis").length, 1);
  assert.ok(!root.listNodes().some((n) => /camera|vnmskel\.empty|skeletons\/weapons/.test(n.getName())));
  const land = root.listAnimations()[1].listChannels();
  assert.deepEqual(land.map((c) => c.getTargetNode().getName()), ["pelvis"]);
  assert.throws(() => buildAlone([]), /Aucun clip/);
  const two = exportDoc(SKEL, { x: 1, y: 1 });
  assert.throws(() => buildAlone([["mort_gut_a", two]]), /mort_gut_a : 2 animations/);
});

test("arme du monde : le modèle seul sous sl_arme (body_hd), sans ses animations", () => {
  const doc = new Document();
  doc.createBuffer();
  const scene = doc.createScene(), top = doc.createNode("weapons\\models\\x\\weapon_x.vmdl_c");
  for (const b of ["body_hd", "body_legacy"]) top.addChild(mesh(doc, `weapons\\models\\x\\weapon_x.vmdl_c.${b}`));
  scene.addChild(top);
  const a = doc.createAnimation("reload");
  track(doc, a, top, "translation", [0], [0, 0, 0]);
  const root = buildWorldWeapon(doc).getRoot();
  assert.deepEqual(root.listScenes()[0].listChildren().map((n) => n.getName()), [WEAPON_NODE]);
  assert.deepEqual(root.listNodes().filter((n) => n.getMesh()).map((n) => n.getName().split(".").pop()), ["body_hd"]);
  assert.equal(root.listAnimations().length, 0);
});

test("arme du monde sans body_hd (couteaux) : ses corps tels quels ; textures de 512 px au plus pour les joueurs", async (t) => {
  const doc = new Document();
  doc.createBuffer();
  const scene = doc.createScene(), top = doc.createNode("weapons\\models\\knife\\knife.vmdl_c");
  const body = mesh(doc, "weapons\\models\\knife\\knife.vmdl_c.body_legacy");
  const raw = Buffer.alloc(1024 * 1024 * 3);
  for (let k = 0; k < 1024 * 1024; k++) raw.set([k % 256, (k >> 10) % 256, 128], 3 * k);  // dégradé : prune() remplace une couleur unie par un facteur
  const image = await sharp(raw, { raw: { width: 1024, height: 1024, channels: 3 } }).png().toBuffer();
  body.getMesh().listPrimitives()[0].setAttribute("TEXCOORD_0", acc(doc, "VEC2", new Float32Array([0, 0, 1, 0, 0, 1])))
    .setMaterial(doc.createMaterial("knife").setBaseColorTexture(doc.createTexture("couleur").setImage(image).setMimeType("image/png")));
  scene.addChild(top.addChild(body));
  const dir = tmpDir(t, "map3d-ag-"), io = await makeIO(), out = path.join(dir, "monde-knife.glb");
  await io.write(out, await optimizeVm(buildWorldWeapon(doc), 512));
  const root = (await io.read(out)).getRoot();
  assert.deepEqual(root.listNodes().filter((n) => n.getMesh()).map((n) => n.getName().split(".").pop()), ["body_legacy"]);
  const meta = await sharp(Buffer.from(root.listTextures()[0].getImage())).metadata();
  assert.ok(meta.width <= 512 && meta.height <= 512, `${meta.width} × ${meta.height}`);
});

// Grille de n × n carrés (2 triangles chacun), à peine ondulée : beaucoup de sommets, que la simplification peut réduire.
function grid(doc, name, n) {
  const pos = [], idx = [];
  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) pos.push(x / n, y / n, 0.002 * Math.sin(x) * Math.cos(y));
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const a = y * (n + 1) + x, b = a + 1, c = a + n + 1, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  const prim = doc.createPrimitive().setAttribute("POSITION", acc(doc, "VEC3", new Float32Array(pos)))
    .setIndices(acc(doc, "SCALAR", new Uint32Array(idx)));
  return doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim));
}
const vertices = (doc) => doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives()).reduce((s, p) => s + p.getAttribute("POSITION").getCount(), 0);

test("arme du monde allégée (vue de loin, 10 joueurs) : environ WORLD_WEAPON_VERTS sommets au plus ; une arme déjà légère : telle quelle", async () => {
  assert.deepEqual([WORLD_WEAPON_VERTS, WORLD_WEAPON_ERROR, WORLD_WEAPON_WEIGHTS], [8000, 0.005, { normal: 1, uv: 2 }]);  // ≈ le corps d'un agent (10 000) ou moins
  const heavy = new Document();
  heavy.createBuffer();
  heavy.createScene().addChild(grid(heavy, "weapon_x.vmdl_c.body_hd", 120));
  const before = vertices(heavy);
  assert.equal(before, 121 * 121);
  await lightenWorldWeapon(heavy, 2000);
  const after = vertices(heavy);
  assert.ok(after <= 2000 * 1.2 && after >= 500, `${before} → ${after}`);
  const light = new Document();
  light.createBuffer();
  light.createScene().addChild(grid(light, "knife", 20));
  await lightenWorldWeapon(light, 2000);
  assert.equal(vertices(light), 21 * 21);
});

test("arme du monde allégée : attributs (NORMAL, TEXCOORD_0, JOINTS_0, WEIGHTS_0) gardés, un par sommet, et nœuds nommés (sl_arme, os « weapon ») identiques", async () => {
  const doc = new Document();
  doc.createBuffer();
  const n = 120, g = grid(doc, "weapon_x.vmdl_c.body_hd", n), prim = g.getMesh().listPrimitives()[0];
  const count = prim.getAttribute("POSITION").getCount();
  const uv = [], nor = [], joints = [], weights = [];
  for (let i = 0; i < count; i++) {
    uv.push((i % (n + 1)) / n, Math.floor(i / (n + 1)) / n);
    nor.push(0, 0, 1);
    joints.push(0, 1, 0, 0);
    weights.push(0.75, 0.25, 0, 0);
  }
  prim.setAttribute("TEXCOORD_0", acc(doc, "VEC2", new Float32Array(uv))).setAttribute("NORMAL", acc(doc, "VEC3", new Float32Array(nor)))
    .setAttribute("JOINTS_0", acc(doc, "VEC4", new Uint16Array(joints))).setAttribute("WEIGHTS_0", acc(doc, "VEC4", new Float32Array(weights)));
  const arme = doc.createNode("sl_arme"), bone = doc.createNode("weapon"), root = doc.createNode("root").addChild(bone);
  g.addChild(arme);
  doc.createScene().addChild(g).addChild(root);
  const names = () => doc.getRoot().listNodes().map((x) => x.getName()).sort();
  const before = names();
  await lightenWorldWeapon(doc, 2000);
  const after = doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives());
  assert.ok(vertices(doc) < count / 2, `${count} → ${vertices(doc)}`);
  for (const p of after) {
    const c = p.getAttribute("POSITION").getCount();
    for (const a of ["NORMAL", "TEXCOORD_0", "JOINTS_0", "WEIGHTS_0"]) assert.equal(p.getAttribute(a)?.getCount(), c, a);
    // les valeurs suivent les sommets gardés : poids et os inchangés, UV dans le carré unité
    const w = p.getAttribute("WEIGHTS_0").getArray(), j = p.getAttribute("JOINTS_0").getArray(), t = p.getAttribute("TEXCOORD_0").getArray();
    for (let i = 0; i < c; i++) {
      assert.deepEqual([j[4 * i], j[4 * i + 1], w[4 * i], w[4 * i + 1]], [0, 1, 0.75, 0.25]);
      assert.ok(t[2 * i] >= 0 && t[2 * i] <= 1 && t[2 * i + 1] >= 0 && t[2 * i + 1] <= 1);
    }
  }
  assert.deepEqual(names(), before);
  assert.ok(names().includes("sl_arme") && names().includes("weapon"));
});
