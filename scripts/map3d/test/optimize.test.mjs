import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { Document, getBounds, NodeIO } from "@gltf-transform/core";
import { KHRLightsPunctual } from "@gltf-transform/extensions";
import sharp from "sharp";
import { makeIO, optimize } from "../lib/optimize.mjs";
import { tmpDir } from "./tmp.mjs";

/** Tétraèdre texturé (image 2048 px) écrit en .gltf, comme une sortie de Source 2 Viewer en miniature. */
async function texturedModel(dir) {
  const doc = new Document(), buf = doc.createBuffer();
  const png = await sharp({ create: { width: 2048, height: 2048, channels: 3, background: { r: 200, g: 120, b: 40 } } }).png().toBuffer();
  const tex = doc.createTexture("mur").setImage(png).setMimeType("image/png").setURI("mur.png");
  const mat = doc.createMaterial("mur").setBaseColorTexture(tex);
  const pos = doc.createAccessor().setType("VEC3").setBuffer(buf).setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]));
  const uv = doc.createAccessor().setType("VEC2").setBuffer(buf).setArray(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]));
  const idx = doc.createAccessor().setType("SCALAR").setBuffer(buf).setArray(new Uint16Array([0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2]));
  const prim = doc.createPrimitive().setAttribute("POSITION", pos).setAttribute("TEXCOORD_0", uv).setIndices(idx).setMaterial(mat);
  doc.createScene().addChild(doc.createNode("modele").setMesh(doc.createMesh("modele").addPrimitive(prim)));
  const file = path.join(dir, "carte.gltf");
  await new NodeIO().write(file, doc);
  return file;
}

/** Le même, avec ce que Source 2 Viewer ajoute : soleil de la carte, vapeur additive, volume d'outils, matériau métallique. */
async function sourceModel(dir) {
  const file = await texturedModel(dir), io = new NodeIO().registerExtensions([KHRLightsPunctual]);
  const doc = await io.read(file), root = doc.getRoot(), [mesh] = root.listMeshes(), [prim] = mesh.listPrimitives();
  prim.getMaterial().setMetallicFactor(1).setMetallicRoughnessTexture(root.listTextures()[0]);
  const buf = root.listBuffers()[0], n = prim.getAttribute("POSITION").getCount();
  prim.setAttribute("TANGENT", doc.createAccessor().setType("VEC4").setBuffer(buf).setArray(new Float32Array(n * 4).fill(1)));
  prim.setAttribute("_TEXCOORD_4", doc.createAccessor().setType("VEC4").setBuffer(buf).setArray(new Float32Array(n * 4)));
  // couleur propre : sinon dedup() les fond avec « mur » et le test ne verrait pas s'ils restent
  for (const name of ["steam_001_additive", "toolsblocklight", "lightshaft_001", "dust_002"]) {
    mesh.addPrimitive(prim.clone().setMaterial(doc.createMaterial(name).setBaseColorTexture(root.listTextures()[0])
      .setBaseColorFactor([0.5, 0.5, 0.5, 1])));
  }
  // sans texture, avec couleurs de sommets : effet (poussière) et eau ; couleurs de sommets aussi sur le mur
  const colors = () => doc.createAccessor().setType("VEC4").setBuffer(buf).setArray(new Float32Array(n * 4).fill(0.5));
  prim.setAttribute("COLOR_0", colors());
  for (const name of ["dust_001", "anubis_water_canal"]) mesh.addPrimitive(prim.clone().setMaterial(doc.createMaterial(name)).setAttribute("COLOR_0", colors()));
  // toile de fond noire, exportée en blanc, et eau sans couleurs de sommets (Ancient) : pas des effets
  for (const name of ["black_simple", "hr_aztec_water_shallow"]) {
    mesh.addPrimitive(prim.clone().setMaterial(doc.createMaterial(name)).setAttribute("COLOR_0", null));
  }
  const sun = doc.createExtension(KHRLightsPunctual).createLight("sun").setType("directional").setIntensity(1639);
  root.listScenes()[0].addChild(doc.createNode("light_environment").setExtension("KHR_lights_punctual", sun));
  await io.write(file, doc);
  return file;
}

/** Matériaux comme Source 2 Viewer les décrit (`extras.vmat`), chacun sur son tétraèdre décalé en x (de quoi voir dans
 *  la version grise ce qui reste) : outils, effets, overlays des différents modes de mélange du jeu. */
const SOURCE_MATERIALS = [
  // nom, vmat, décalage en x
  ["wrongway_timer", { Name: "materials/tools/wrongway_timer.vmat", ShaderName: "csgo_unlitgeneric.vfx", IntParams: { F_BLEND_MODE: 1 } }, 100],
  ["nuke_skylight_tint_001", { Name: "materials/de_nuke/nuke_skylight_tint_001.vmat", ShaderName: "csgo_effects.vfx" }, 110],
  ["caustics_001_decal", { ShaderName: "csgo_static_overlay.vfx", IntParams: { F_BLEND_MODE: 3, F_TEXTURE_ANIMATION: 1 },
    VectorParams: { g_vAnimationGrid: [8, 4, 0, 0] } }, 120],
  ["train_shipping_crate_decals_01", { ShaderName: "csgo_static_overlay.vfx", IntParams: { F_BLEND_MODE: 6 } }, 130],
  ["hr_nuke_parkingstripe", { ShaderName: "csgo_static_overlay.vfx", IntParams: { F_BLEND_MODE: 1 } }, 140],
  ["hr_plant_logo_001", { ShaderName: "csgo_static_overlay.vfx", IntParams: { F_BLEND_MODE: 2 }, FloatParams: { g_flAlphaTestReference: 0.3 } }, 150],
  ["scuffs_overlay_001", { ShaderName: "csgo_static_overlay.vfx", IntParams: { F_BLEND_MODE: 3 } }, 160],
  ["aztec_water_cascades_02", { ShaderName: "csgo_unlitgeneric.vfx", IntParams: { F_BLEND_MODE: 4 } }, 170],
  ["hr_nuke_parkingstripe_single", { ShaderName: "csgo_lightmappedgeneric.vfx", IntParams: { F_OVERLAY: 1, F_TRANSLUCENT: 1 } }, 180],
  ["window_illum_backing", { ShaderName: "csgo_unlitgeneric.vfx", IntParams: {} }, 10],
  // Mercedes de Dust2 (couvert du site A) : pas un effet malgré « dust_3… »
  ["dust_300d_color", { ShaderName: "csgo_vertexlitgeneric.vfx", IntParams: {} }, 20],
  // eau sans texture, avec couleurs de sommets, sans « water » dans le nom (fontaine d'Inferno)
  ["inferno_fountain", { ShaderName: "csgo_water_fancy.vfx", IntParams: {} }, 30, { plain: true, color0: true }],
  ["cargovan_glass", { ShaderName: "csgo_glass.vfx", IntParams: {} }, 190, { blend: true }],
  // opacité peinte sur les sommets par le mappeur (coulures effacées au pinceau)
  ["inferno_trim_decal_leakage_01", { ShaderName: "csgo_static_overlay.vfx", IntParams: { F_BLEND_MODE: 1, F_PAINT_VERTEX_COLORS: 1 } }, 200, { color0: true }],
  ["ch2_window_decal_01", { ShaderName: "csgo_static_overlay.vfx", IntParams: { F_BLEND_MODE: 1 }, FloatParams: { g_flOpacityScale: 0.5 } }, 210],
];

async function sourceMaterialsModel(dir) {
  const file = await texturedModel(dir), io = new NodeIO();
  const doc = await io.read(file), root = doc.getRoot(), [mesh] = root.listMeshes(), [prim] = mesh.listPrimitives();
  const buf = root.listBuffers()[0], src = prim.getAttribute("POSITION").getArray(), n = src.length / 3;
  for (const [i, [name, vmat, x, opts = {}]] of SOURCE_MATERIALS.entries()) {
    const pos = Float32Array.from(src, (v, k) => (k % 3 === 0 ? v + x : v));
    // couleur propre à chacun : sinon dedup() les fond
    const mat = doc.createMaterial(name).setBaseColorFactor([0.5, 0.5, i / 20, 1])
      .setAlphaMode(vmat.IntParams?.F_TRANSLUCENT || opts.blend ? "BLEND" : "OPAQUE").setExtras({ vmat });
    if (!opts.plain) mat.setBaseColorTexture(root.listTextures()[0]);
    const p = prim.clone().setMaterial(mat).setAttribute("POSITION", doc.createAccessor().setType("VEC3").setBuffer(buf).setArray(pos));
    if (opts.color0) p.setAttribute("COLOR_0", doc.createAccessor().setType("VEC4").setBuffer(buf)
      .setArray(Float32Array.from({ length: n * 4 }, (_, k) => (k % 4 === 3 ? (k >> 2) % 2 : 0.8))));
    mesh.addPrimitive(p);
  }
  await io.write(file, doc);
  return file;
}

test("matériaux du jeu : outils et effets retirés ; mode de mélange du jeu respecté ; animés à leur première image", async (t) => {
  const dir = tmpDir(t, "map3d-opt-"), io = await makeIO();
  await optimize(io, await sourceMaterialsModel(dir), path.join(dir, "textured.glb"), "textured");
  const root = (await io.read(path.join(dir, "textured.glb"))).getRoot();
  const mats = new Map(root.listMaterials().map((m) => [m.getName(), m]));
  assert.deepEqual([...mats.keys()].sort(), ["aztec_water_cascades_02", "cargovan_glass", "caustics_001_decal",
    "ch2_window_decal_01", "dust_300d_color", "eau", "hr_nuke_parkingstripe", "hr_nuke_parkingstripe_single",
    "hr_plant_logo_001", "inferno_trim_decal_leakage_01", "mur", "scuffs_overlay_001", "train_shipping_crate_decals_01",
    "window_illum_backing"]);
  // opacité du jeu (g_flOpacityScale), que Source 2 Viewer ne reporte pas
  assert.equal(mats.get("ch2_window_decal_01").getBaseColorFactor()[3], 0.5);
  // opacité peinte sur les sommets des overlays mélangés : gardée (COLOR_0) ; ailleurs, couleurs de sommets retirées
  const color0 = (name) => root.listMeshes().flatMap((m) => m.listPrimitives())
    .filter((p) => p.getMaterial()?.getName() === name).map((p) => !!p.getAttribute("COLOR_0"));
  assert.deepEqual(color0("inferno_trim_decal_leakage_01"), [true]);
  assert.deepEqual(color0("eau"), [false]);
  // planche de 8 × 4 images (reflets d'eau, télé de Mirage, flamme de bougie d'Ancient) : la première, pas toute la planche
  const tt = mats.get("caustics_001_decal").getBaseColorTextureInfo().getExtension("KHR_texture_transform");
  assert.deepEqual(tt?.getScale(), [1 / 8, 1 / 4]);
  assert.equal(mats.get("mur").getBaseColorTextureInfo().getExtension("KHR_texture_transform"), null);
  assert.equal(mats.get("hr_nuke_parkingstripe").getAlphaMode(), "BLEND");
  assert.equal(mats.get("hr_plant_logo_001").getAlphaMode(), "MASK");
  assert.equal(mats.get("hr_plant_logo_001").getAlphaCutoff(), 0.3);
  // Mod2x, Additive, ModThenAdd (étiquettes des caisses d'Ancient) : dessinés après les opaques ; la vue 3D pose
  // l'équation de mélange (d'après les extras, gardés)
  assert.equal(mats.get("scuffs_overlay_001").getAlphaMode(), "BLEND");
  assert.equal(mats.get("train_shipping_crate_decals_01").getAlphaMode(), "BLEND");
  assert.equal(mats.get("aztec_water_cascades_02").getAlphaMode(), "BLEND");
  assert.equal(mats.get("scuffs_overlay_001").getExtras().vmat.IntParams.F_BLEND_MODE, 3);
  assert.equal(mats.get("hr_nuke_parkingstripe_single").getAlphaMode(), "BLEND");
  assert.equal(mats.get("window_illum_backing").getAlphaMode(), "OPAQUE");
});

test("version grise : ni outils, ni effets, ni décalcomanies, ni mélanges, ni translucides (aplats gris sans texture)", async (t) => {
  const dir = tmpDir(t, "map3d-opt-"), io = await makeIO();
  await optimize(io, await sourceMaterialsModel(dir), path.join(dir, "gray.glb"), "gray");
  const { max } = getBounds((await io.read(path.join(dir, "gray.glb"))).getRoot().listScenes()[0]);
  assert.ok(max[0] > 29 && max[0] < 40, `x max ${max[0]} : restent le mur, window_illum_backing, la voiture et l'eau (x + 30)`);
});

test("version grise : sans texture, un seul matériau, géométrie compressée", async (t) => {
  const dir = tmpDir(t, "map3d-opt-"), io = await makeIO();
  const st = await optimize(io, await texturedModel(dir), path.join(dir, "gray.glb"), "gray");
  const out = await io.read(path.join(dir, "gray.glb"));
  assert.equal(st.textures, 0);
  assert.equal(out.getRoot().listTextures().length, 0);
  assert.equal(out.getRoot().listMaterials().length, 1);
  assert.ok(out.getRoot().listExtensionsUsed().some((e) => e.extensionName === "EXT_meshopt_compression"));
});

test("version texturée : WebP de 512 px au plus, géométrie compressée", async (t) => {
  const dir = tmpDir(t, "map3d-opt-"), io = await makeIO();
  await optimize(io, await texturedModel(dir), path.join(dir, "textured.glb"), "textured");
  const out = await io.read(path.join(dir, "textured.glb"));
  const [tex] = out.getRoot().listTextures();
  assert.equal(tex.getMimeType(), "image/webp");
  const { width, height } = await sharp(Buffer.from(tex.getImage())).metadata();
  assert.ok(width <= 512 && height <= 512);
  assert.ok(out.getRoot().listExtensionsUsed().some((e) => e.extensionName === "EXT_meshopt_compression"));
});

test("retire le soleil de la carte, les effets, les outils, l'aspect métallique et les attributs inutiles", async (t) => {
  const dir = tmpDir(t, "map3d-opt-"), io = await makeIO();
  for (const variant of ["gray", "textured"]) {
    await optimize(io, await sourceModel(dir), path.join(dir, `${variant}.glb`), variant);
    const root = (await io.read(path.join(dir, `${variant}.glb`))).getRoot();
    assert.ok(!root.listExtensionsUsed().some((e) => e.extensionName === "KHR_lights_punctual"), variant);
    for (const m of root.listMaterials()) assert.ok(m.getMetallicFactor() === 0 && !m.getMetallicRoughnessTexture(), variant);
    for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) {
      assert.deepEqual(p.listSemantics().filter((s) => s === "TANGENT" || s.startsWith("_") || s.startsWith("COLOR_")), [], variant);
    }
    if (variant === "textured") {
      assert.deepEqual(root.listMaterials().map((m) => m.getName()).sort(), ["black_simple", "eau", "mur"]);
      assert.equal(root.listMaterials().find((m) => m.getName() === "eau").getAlphaMode(), "BLEND");
      assert.ok(root.listMaterials().find((m) => m.getName() === "black_simple").getBaseColorFactor()[0] < 0.05);
    }
  }
});
