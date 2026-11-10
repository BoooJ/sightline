// Collision d'une carte (node scripts/map3d/export.mjs <carte>, variante « collision ») : maillage physique du monde
// exporté par Source 2 Viewer (maps/<carte>/world_physics.vmdl_c), réduit à ce qui arrête un corps, soudé, simplifié,
// compressé. Les sommets restent dans le repère de l'export (matrice SOURCE_TO_GLTF des nœuds), comme la carte : le
// navigateur les ramène au jeu par l'inverse de world_to_model (collision.ts). Fichier partagé avec la vague 2 (fumées et
// molotovs) : même contrat, un seul fichier par carte.
import fs from "node:fs";
import { getBounds } from "@gltf-transform/core";
import { flatten, join, meshopt, prune, simplify, weld } from "@gltf-transform/functions";
import { MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";

/** Fichier de world_physics dans le VPK de la carte. */
export const collisionPath = (map) => `maps/${map}/world_physics.vmdl_c`;
/** Ligne de commande de Source 2 Viewer 20.1 : le modèle physique seul, en glb (écrit dans <sortie>_physics.glb). */
export const collisionArgs = (vpk, map, out) => ["-i", vpk, "-f", collisionPath(map), "-o", out, "-d", "--gltf_export_format", "glb"];
/** Le .glb physique écrit par la CLI pour la sortie `out` ; erreur claire s'il manque. */
export function collisionOut(out) {
  const file = out.replace(/\.glb$/i, "_physics.glb");
  if (!fs.existsSync(file)) throw new Error(`Collision introuvable après l'export (${file}) : rien n'est envoyé.`);
  return file;
}
/** Erreur de simplification admise (unités du jeu) : les sphères du ragdoll ont 2 à 7 u de rayon. */
export const COLLISION_ERROR_U = 2;
/** Nœuds gardés : groupes de surface (`physics_group_*`) et surfaces que les balles traversent mais pas les corps
 *  (`physics_passbullets_*`) ; écartés : clips des joueurs et des grenades, ciel, groupes inconnus de l'export. */
export const keepCollisionNode = (name) => /^physics_(group|passbullets)/.test(name ?? "") && !/vrf_unknown/.test(name ?? "");

/** Document de l'export → collision prête : nœuds écartés retirés, un seul maillage « sl_collision », soudé, simplifié à
 *  COLLISION_ERROR_U près, compressé (meshopt) ; `extras.sl_collision` sur la scène. Rend le nombre de triangles. Les
 *  encodeurs de meshoptimizer doivent être prêts (makeIO l'attend). */
export async function buildCollision(doc) {
  const root = doc.getRoot(), [scene] = root.listScenes();
  for (const node of root.listNodes()) if (!keepCollisionNode(node.getName())) node.dispose();
  for (const mesh of root.listMeshes()) for (const p of mesh.listPrimitives()) {
    for (const s of p.listSemantics()) if (s !== "POSITION") p.setAttribute(s, null);
  }
  const { min, max } = getBounds(scene);
  const radius = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2;  // mètres (repère de l'export)
  await doc.transform(flatten(), join({ keepNamed: false }), weld(),
    simplify({ simplifier: MeshoptSimplifier, ratio: 0, error: (COLLISION_ERROR_U * 0.0254) / Math.max(radius, 1e-6) }),
    prune(), meshopt({ encoder: MeshoptEncoder, level: "medium" }));
  let tris = 0;
  for (const mesh of root.listMeshes()) {
    mesh.setName("sl_collision");
    for (const p of mesh.listPrimitives()) tris += (p.getIndices()?.getCount() ?? p.getAttribute("POSITION").getCount()) / 3;
  }
  scene.setExtras({ sl_collision: { v: 1, error_u: COLLISION_ERROR_U } });
  return tris;
}
