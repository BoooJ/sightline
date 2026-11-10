import fs from "node:fs";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, KHRTextureTransform } from "@gltf-transform/extensions";
import { dedup, flatten, join, meshopt, prune, simplify, textureCompress, weld } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";
import sharp from "sharp";

export async function makeIO() {
  await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready]);
  return new NodeIO().registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ "meshopt.decoder": MeshoptDecoder, "meshopt.encoder": MeshoptEncoder });
}

/** Ce que la vue 3D ne doit pas montrer (Nuke, tâche 7) : le soleil de la carte (intensité 1 639, il sature l'éclairage de
 *  la vue), la vapeur additive (opaque et noire en glTF), les volumes d'outils, les blocages du mode retakes, les rayons
 *  de lumière (plaques grises) et les cartes de poussière et de vapeur (dalles opaques ; Mirage : `dust_002`, texturée). */
// `_0\d` et pas `_\d` : la Mercedes de Dust2 et d'Anubis (`dust_300d_*`, couvert du site A) n'est pas un effet
const HIDDEN = /additive|^tools|^retakes_|lightshaft|(^|_)(dust|steam)_0\d/i;
const WATER = /water/i;
const BLACK = /^black/i;  // toiles de fond noires (`black_simple`), exportées en blanc

/** Matériau du jeu tel que Source 2 Viewer le décrit (`extras.vmat` : chemin, shader, paramètres). Son mode de mélange
 *  (`F_BLEND_MODE` de csgo_static_overlay et csgo_unlitgeneric : 0 opaque, 1 translucide, 2 test alpha, 3 Mod2x,
 *  4 additif, 5 multiplication, 6 ModThenAdd) est ignoré par Source 2 Viewer 20.1, qui exporte ces matériaux opaques :
 *  leurs parties transparentes devenaient des bandes et des rectangles (chronomètres de Mirage, logos et marquages de
 *  Nuke, panneaux de Cache et d'Inferno, cascade d'Ancient). */
const vmatOf = (mat) => mat?.getExtras()?.vmat ?? {};
const blendMode = (mat) => vmatOf(mat).IntParams?.F_BLEND_MODE ?? 0;
const isDecal = (mat) => vmatOf(mat).ShaderName === "csgo_static_overlay.vfx" || !!vmatOf(mat).IntParams?.F_OVERLAY;

/** Ce que les noms ne disent pas : repères d'outils et de modes de jeu (`materials/tools/`, dont les chronomètres
 *  « wrongway » de Mirage) et effets (csgo_effects : poussière, vapeur, rayons, teintes de verrière). Dans la version
 *  grise, en plus, décalcomanies et matériaux mélangés : sans leur texture, des aplats gris. */
function hiddenSource(mat, variant) {
  const v = vmatOf(mat);
  return /^materials\/tools\//.test(v.Name ?? "") || v.ShaderName === "csgo_effects.vfx"
    || (variant === "gray" && (isDecal(mat) || blendMode(mat) > 0 || mat?.getAlphaMode() === "BLEND"));
}

/** Opacité peinte sur les sommets par le mappeur (overlays mélangés avec F_PAINT_VERTEX_COLORS : coulures effacées au
 *  pinceau) : leurs couleurs de sommets restent. */
const paintedOpacity = (mat) => vmatOf(mat).ShaderName === "csgo_static_overlay.vfx"
  && !!vmatOf(mat).IntParams?.F_PAINT_VERTEX_COLORS && blendMode(mat) > 0;

function stripSourceExtras(doc, variant) {
  for (const ext of doc.getRoot().listExtensionsUsed()) if (ext.extensionName === "KHR_lights_punctual") ext.dispose();
  let eau = null;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial(), name = mat?.getName() ?? "";
      // sans texture mais avec couleurs de sommets : poussière, vapeur, halos (pointes et cônes opaques sur Dust2,
      // Inferno, Train…) ; l'eau sans texture (aplats blancs, avec ou sans couleurs de sommets) garde sa surface, en
      // bleu-gris translucide
      const plain = !!mat && !mat.getBaseColorTexture();
      const water = plain && (WATER.test(name) || vmatOf(mat).ShaderName === "csgo_water_fancy.vfx");  // fontaine d'Inferno
      if (HIDDEN.test(name) || hiddenSource(mat, variant) || (plain && !water && prim.getAttribute("COLOR_0"))) { prim.dispose(); continue; }
      if (water) {
        eau ??= doc.createMaterial("eau").setBaseColorFactor([0.2, 0.3, 0.34, 0.7]).setAlphaMode("BLEND").setRoughnessFactor(0.4);
        prim.setMaterial(eau);
      }
      // tangentes (three.js fait le relief sans elles) et attributs propres à Source 2 (`_TEXCOORD_4`) : inutiles à la
      // vue, ils pesaient près de la moitié des sommets (Train : 83 Mo sur 187 avant compression) et coupaient la soudure ;
      // couleurs de sommets : dans Source 2, poids de mélange des sols et vent du feuillage, pas des teintes (arbres roses)
      const keep = !water && paintedOpacity(mat) ? "COLOR_0" : null;
      for (const s of prim.listSemantics()) if (s === "TANGENT" || s.startsWith("_") || (s.startsWith("COLOR_") && s !== keep)) prim.setAttribute(s, null);
    }
    if (!mesh.listPrimitives().length) mesh.dispose();
  }
  // sans reflets d'environnement dans la vue, un matériau métallique est noir (feuillage, rampes) : tout est mat
  let transforms = null;
  for (const m of doc.getRoot().listMaterials()) {
    m.setMetallicFactor(0).setMetallicRoughnessTexture(null);
    if (BLACK.test(m.getName())) m.setBaseColorFactor([0.02, 0.02, 0.02, 1]).setBaseColorTexture(null);
    // mélange du jeu : translucide → BLEND, test alpha → MASK ; Mod2x, additif, multiplication, ModThenAdd → BLEND aussi
    // (dessinés après les opaques), la vue 3D posant l'équation de mélange d'après `extras.vmat` (`sourceMaterials.ts`)
    const bm = blendMode(m);
    if (bm === 1 || (bm >= 3 && bm <= 6)) m.setAlphaMode("BLEND");
    else if (bm === 2) m.setAlphaMode("MASK").setAlphaCutoff(vmatOf(m).FloatParams?.g_flAlphaTestReference ?? 0.5);
    const op = vmatOf(m).FloatParams?.g_flOpacityScale;  // opacité du jeu, que Source 2 Viewer ne reporte pas
    if (m.getAlphaMode() === "BLEND" && op != null && op !== 1) { const f = m.getBaseColorFactor(); m.setBaseColorFactor([f[0], f[1], f[2], f[3] * op]); }
    // texture animée : planche d'images (reflets d'eau 8 × 8, télé de Mirage 2 × 2, flamme de bougie d'Ancient 8 × 4),
    // UV de 0 à 1 sur les 7 cartes ; sans animation, toute la planche s'affichait en grille : on montre la première image
    const grid = vmatOf(m).VectorParams?.g_vAnimationGrid;
    if (vmatOf(m).IntParams?.F_TEXTURE_ANIMATION && grid?.[0] > 0 && grid?.[1] > 0 && m.getBaseColorTexture()) {
      transforms ??= doc.createExtension(KHRTextureTransform);
      m.getBaseColorTextureInfo().setExtension("KHR_texture_transform", transforms.createTransform().setScale([1 / grid[0], 1 / grid[1]]));
    }
  }
}

/** Grise : un seul matériau gris mat, ni textures ni couleurs de sommets. */
function stripTextures(doc) {
  const gray = doc.createMaterial("gris").setBaseColorFactor([0.62, 0.64, 0.66, 1]).setRoughnessFactor(1).setMetallicFactor(0);
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      prim.setMaterial(gray);
      for (const s of prim.listSemantics()) if (s.startsWith("TEXCOORD_") || s.startsWith("COLOR_")) prim.setAttribute(s, null);
    }
  }
  for (const t of doc.getRoot().listTextures()) t.dispose();
  for (const m of doc.getRoot().listMaterials()) if (m !== gray) m.dispose();
}

/** Optimise un export de Source 2 Viewer pour le navigateur ; réglages par défaut validés sur Nuke (tâche 0). */
// textures de 512 px au plus : en 1024, une fois décodées, elles prenaient 2 à 3 Go de mémoire graphique sur Inferno,
// Train ou Overpass (750 à 942 textures), de quoi caler un onglet ; en 512, 0,25 à 0,75 Go
export async function optimize(io, input, output, variant, { ratio = 0.5, error = 0.001, size = 512 } = {}) {
  const doc = await io.read(input);
  stripSourceExtras(doc, variant);
  if (variant === "gray") stripTextures(doc);
  await doc.transform(
    // flatten + join : une carte en quelques gros maillages (un par matériau). Sur Nuke, 4 605 appels de dessin → 13 en grise,
    // soit 21 → 123 i/s sur une puce graphique intégrée (essai, tâche 0) ; instance() laissait des milliers d'objets.
    dedup(), flatten(), join({ keepNamed: false }), weld(), simplify({ simplifier: MeshoptSimplifier, ratio, error }),
    ...(variant === "textured" ? [textureCompress({ encoder: sharp, targetFormat: "webp", resize: [size, size] })] : []),
    // « high » : filtres meshopt (normales, UV) en plus ; Nuke grise 13,8 → 9,2 Mo, texturée 54,7 → 48,0 Mo
    prune(), meshopt({ encoder: MeshoptEncoder, level: "high" }),
  );
  await io.write(output, doc);
  return { size: fs.statSync(output).size, textures: doc.getRoot().listTextures().length };
}
