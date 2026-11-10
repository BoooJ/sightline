// Bras et armes de la vue du joueur : exports de Source 2 Viewer (pak01_dir.vpk de CS2) et leur préparation pour le
// navigateur (essai de la vue première personne du 30/10/2026 : squelette et animations gardés, positions des os
// identiques au millimètre après optimisation).
import { dedup, meshopt, mergeDocuments, prune, resample, textureCompress, unpartition } from "@gltf-transform/functions";
import { MeshoptEncoder } from "meshoptimizer";
import sharp from "sharp";

export const AGENTS = { ct: "agents/models/ctm_sas/ctm_sas.vmdl_c", t: "agents/models/tm_phoenix/tm_phoenix.vmdl_c" };
const FP_MESHES = "firstperson_default_gloves_arms,firstperson_sleeves";
// sans clip, Source 2 Viewer exporte les bras Phoenix sans squelette : un clip d'une image, retiré ensuite
const SKELETON_CLIP = "animation/anims/viewmodel/rifle/rifle_ak/idle_ak";
export const WEAPON_NODE = "sl_arme";  // modèle de l'arme, monté sous l'os wpn des bras par le navigateur
export const CLIPS_NODE = "sl_clips";  // squelette des clips (bras + arme), qui ne sert qu'à nommer les pistes
const GLB = ["-d", "--gltf_export_format", "glb"];

/** Lignes de commande de Source 2 Viewer 20.1 (essai du 30/10/2026, `exp/*\/cmd.txt`). */
export const vueArgs = {
  /** Bras d'un camp (SAS pour CT, Phoenix pour T) : maillages de première personne, matériaux PBR (ORM), squelette. */
  arms: (vpk, side, out) => ["-i", vpk, "-f", AGENTS[side], "-o", out, ...GLB, "--gltf_export_materials",
    "--gltf_textures_adapt", "--gltf_export_animations", "--gltf_mesh_list", FP_MESHES, "--gltf_animation_list", SKELETON_CLIP],
  /** Modèle d'une arme, tous ses corps (body_hd est choisi ensuite) ; « animations » pour avoir son squelette. */
  model: (vpk, model, out) => ["-i", vpk, "-f", model, "-o", out, ...GLB, "--gltf_export_materials", "--gltf_textures_adapt",
    "--gltf_export_animations"],
  /** Clips de vue d'une arme, sur le squelette de l'agent SAS (appliqués aussi aux bras T, par nom d'os) ; sans matériaux :
   *  aucune texture écrite, le maillage est retiré ensuite. */
  clips: (vpk, clipPaths, out) => ["-i", vpk, "-f", AGENTS.ct, "-o", out, ...GLB, "--gltf_export_animations",
    "--gltf_mesh_list", "firstperson_sleeves", "--gltf_animation_list", clipPaths.join(",")],
};

/** Retire une animation avec ses canaux et ses échantillonneurs : sans eux, leurs accessors resteraient attachés et
 *  prune() ne les enlèverait pas (bras : 2 471 accessors orphelins, 370 Ko de JSON). */
export const drop = (a) => { for (const p of [...a.listChannels(), ...a.listSamplers(), a]) p.dispose(); };
export const named = (n, suffix) => (n.getName() ?? "").endsWith(suffix);
// racines que Source 2 Viewer ajoute avec les clips : squelette d'arme (« …vnmskel ») et maillage POINTS d'un sommet par os
const helper = (n) => named(n, ".vnmskel") || named(n, ".empty_mesh_reference");
/** Retire un nœud et ses descendants (détachés seulement, ils resteraient dans le fichier, hors de la scène). */
export const cut = (n) => { for (const c of n.listChildren()) cut(c); n.dispose(); };

/** Bras : maillages et squelette, sans le clip ni les racines ajoutées avec lui (les clips viennent des armes). */
export function prepareArms(doc) {
  const root = doc.getRoot();
  for (const a of root.listAnimations()) drop(a);
  for (const n of root.listNodes()) if (!n.isDisposed() && helper(n)) cut(n);
  return doc;
}

/** Arme de vue en un seul document : le modèle (body_hd s'il existe, sinon ses corps tels quels ; sans ses propres
 *  animations) sous « sl_arme », le squelette des clips (sans maillage) sous « sl_clips », et les clips de `roles`
 *  ({rôle: chemin complet}) renommés par rôle (idle, draw, shoot…). `model` reçoit tout et est renvoyé. */
export function buildWeapon(model, clips, roles) {
  const mr = model.getRoot(), cr = clips.getRoot();
  weaponModel(model);

  const role = new Map(Object.entries(roles).map(([r, p]) => [p, r]));
  for (const a of cr.listAnimations()) if (role.has(a.getName())) a.setName(role.get(a.getName())); else drop(a);
  const missing = Object.keys(roles).filter((r) => !cr.listAnimations().some((a) => a.getName() === r));
  if (missing.length) throw new Error(`Clips absents de l'export : ${missing.map((r) => roles[r]).join(", ")}`);
  for (const n of cr.listNodes()) if (n.getMesh() || n.getSkin()) n.setMesh(null).setSkin(null);
  for (const p of [...cr.listSkins(), ...cr.listMeshes(), ...cr.listMaterials(), ...cr.listTextures()]) p.dispose();

  wrapScene(model, WEAPON_NODE);
  wrapScene(clips, CLIPS_NODE);
  mergeDocuments(model, clips);
  const [main, ...rest] = mr.listScenes();
  for (const s of rest) {
    for (const c of s.listChildren()) { s.removeChild(c); main.addChild(c); }
    s.dispose();
  }
  mr.setDefaultScene(main);
  return model;
}

/** Modèle d'arme : ses propres animations retirées, body_hd gardé s'il existe (sinon ses corps tels quels, ex. couteaux :
 *  body_legacy seul), marqueurs retirés. Sert à la vue du joueur (arme-<clé>) et aux joueurs (monde-<clé>). */
export function weaponModel(model) {
  const mr = model.getRoot();
  for (const a of mr.listAnimations()) drop(a);
  const bodies = mr.listNodes().filter((n) => n.getMesh());
  const hd = bodies.some((n) => named(n, ".body_hd"));
  for (const n of bodies) if (named(n, ".empty_mesh_reference") || (hd && !named(n, ".body_hd"))) n.dispose();
  return model;
}

/** Racines de la scène par défaut regroupées sous un nœud `name`. */
export function wrapScene(doc, name) {
  const [scene] = doc.getRoot().listScenes(), node = doc.createNode(name);
  for (const c of scene.listChildren()) { scene.removeChild(c); node.addChild(c); }
  scene.addChild(node);
}

/** libwebp (avec perte) jette le RVB sous un alpha nul : la normale de l'AK-47 (RVBA, A = 0 partout) devenait plate.
 *  L'alpha est retiré de toute texture qui n'est pas la couleur d'un matériau BLEND ou MASK. */
const stripUnusedAlpha = () => async (doc) => {
  const keep = new Set(doc.getRoot().listMaterials().filter((m) => m.getAlphaMode() !== "OPAQUE").map((m) => m.getBaseColorTexture()));
  for (const t of doc.getRoot().listTextures()) {
    if (keep.has(t) || !t.getImage()) continue;
    if ((await sharp(t.getImage()).metadata()).hasAlpha) {
      t.setImage(await sharp(t.getImage()).removeAlpha().png().toBuffer()).setMimeType("image/png");
    }
  }
};

/** Optimisation qui garde squelette et animations (contrairement à celle des cartes : ni flatten, ni join, ni
 *  simplify) : un seul tampon, doublons fusionnés, clés redondantes retirées, alpha inutile retiré, textures WebP de
 *  `size` px au plus (1024 pour la vue du joueur, 512 pour les joueurs vus de loin), géométrie et animations compressées
 *  (meshopt « medium »). */
export async function optimizeVm(doc, size = 1024) {
  await doc.transform(
    unpartition(), dedup(), resample(), prune(), stripUnusedAlpha(),
    textureCompress({ encoder: sharp, targetFormat: "webp", resize: [size, size] }),
    meshopt({ encoder: MeshoptEncoder, level: "medium" }),
  );
  return doc;
}
