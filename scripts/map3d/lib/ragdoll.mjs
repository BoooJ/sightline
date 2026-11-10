// Ragdoll des agents (node scripts/map3d/export.mjs joueurs --only ragdoll) : bloc PHYS du modèle de SAS
// (Source2Viewer-CLI -b PHYS, texte KV3) → corps, formes, masses et articulations, en JSON dans les extras de la scène d'un
// .glb sans maillage (fichier « ragdoll » du type joueurs ; format : plan ragdoll, lot B). Identique pour SAS, Phoenix et
// les agents équipés (sonde 0.3) : un seul fichier pour tous. Données de Valve : jamais dans le dépôt (les tests en
// fabriquent de fausses, test/physText.mjs).
import { Document } from "@gltf-transform/core";
import { parseKv3 } from "./kv3.mjs";
import { AGENTS } from "./viewmodel.mjs";

export const RAGDOLL_FILE = "ragdoll";
export const RAGDOLL_VERSION = 1;
/** Ligne de commande de Source 2 Viewer 20.1 : contenu du bloc PHYS du modèle de SAS, en texte sur la sortie standard. */
export const ragdollArgs = (vpk) => ["-i", vpk, "-f", AGENTS.ct, "-b", "PHYS"];

/** Texte du bloc PHYS de `model` dans la sortie de la CLI (« [n/N] <chemin> » par fichier, puis
 *  « --- Data for block "PHYS" --- ») ; erreur claire s'il manque. */
export function physBlock(text, model = AGENTS.ct) {
  const sections = text.replace(/\r\n/g, "\n").split(/^\[\d+\/\d+\] /m).slice(1);
  const mine = sections.find((s) => s.startsWith(`${model}\n`));
  const at = mine ? mine.indexOf('--- Data for block "PHYS" ---') : -1;
  if (at < 0) throw new Error(`Bloc PHYS de ${model} introuvable dans la sortie de Source 2 Viewer : rien n'est exporté.`);
  return mine.slice(at);
}

/** KV3 du bloc PHYS → ragdoll (format du lot B) ; erreur claire si une forme n'est ni sphère ni capsule, ou si corps,
 *  pose de référence et articulations ne se correspondent pas. */
export function ragdollFromPhys(kv) {
  const bones = kv.m_boneNames ?? [], n = bones.length;
  const bad = (why) => new Error(`Ragdoll illisible (${why}) : rien n'est exporté.`);
  if (!n || (kv.m_parts ?? []).length !== n || (kv.m_bindPose ?? []).length !== n) throw bad("corps, formes et poses en nombres différents");
  const parts = kv.m_parts.map((p, i) => {
    const sh = p.m_rnShape ?? {};
    const spheres = (sh.m_spheres ?? []).map((x) => ({ c: x.m_Sphere.m_vCenter, r: x.m_Sphere.m_flRadius }));
    const capsules = (sh.m_capsules ?? []).map((x) => ({ a: x.m_Capsule.m_vCenter[0], b: x.m_Capsule.m_vCenter[1], r: x.m_Capsule.m_flRadius }));
    if (spheres.length + capsules.length === 0 || (sh.m_hulls ?? []).length || (sh.m_meshes ?? []).length) {
      throw new Error(`Corps ${bones[i]} : forme inattendue (ni sphère ni capsule) : rien n'est exporté.`);
    }
    return { mass: p.m_flMass, linDamp: p.m_flLinearDamping, angDamp: p.m_flAngularDamping, inertiaScale: p.m_flInertiaScale, spheres, capsules };
  });
  const joints = (kv.m_joints ?? []).map((j) => {
    if (!(j.m_nBody1 >= 0 && j.m_nBody1 < n && j.m_nBody2 >= 0 && j.m_nBody2 < n) || j.m_Frame1?.length !== 8 || j.m_Frame2?.length !== 8) {
      throw bad("articulation hors des corps");
    }
    return { type: j.m_nType, a: j.m_nBody1, b: j.m_nBody2, fa: j.m_Frame1, fb: j.m_Frame2,
      swing: j.m_bEnableSwingLimit ? j.m_SwingLimit.m_flMax : null,
      twist: j.m_bEnableTwistLimit ? [j.m_TwistLimit.m_flMin, j.m_TwistLimit.m_flMax] : null };
  });
  return { v: RAGDOLL_VERSION, bones, bindPose: kv.m_bindPose.map((r) => r.flat()), parts, joints };
}

/** Sortie de `ragdollArgs` → ragdoll. */
export const readRagdoll = (text) => ragdollFromPhys(parseKv3(physBlock(text)));

/** .glb du fichier « ragdoll » : une scène vide nommée sl_ragdoll, le ragdoll dans ses extras (le serveur n'accepte que du
 *  glTF binaire ; GLTFLoader range les extras de la scène dans userData). */
export function ragdollDoc(rag) {
  const doc = new Document();
  doc.getRoot().setDefaultScene(doc.createScene("sl_ragdoll").setExtras({ sl_ragdoll: rag }));
  return doc;
}
