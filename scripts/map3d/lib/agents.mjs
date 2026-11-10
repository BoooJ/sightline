// Joueurs vus de l'extérieur (node scripts/map3d/export.mjs joueurs) : modèles d'agents (SAS pour CT, Phoenix pour T),
// clips de déplacement par classe d'arme, clips exportés seuls (morts, atterrissages) et armes du monde, et leur
// préparation pour le navigateur (frontend/src/features/replay3d/agents.ts). Ce fichier ne contient que des noms et des
// chemins : aucun fichier de Valve dans le dépôt.
import { compactPrimitive, mergeDocuments, weld } from "@gltf-transform/functions";
import { MeshoptSimplifier } from "meshoptimizer";
import { AGENTS, cut, drop, named, prepareArms, WEAPON_NODE, weaponModel, wrapScene } from "./viewmodel.mjs";

/** Classes de déplacement (dossiers animation/anims/world/<classe>/_default_<classe>). */
export const CLASSES = ["rifle", "pistol", "knife"];
const DIRS8 = ["n", "ne", "e", "se", "s", "sw", "w", "nw"], AIR = ["stand", "n", "e", "s", "w"];
const W = "animation/anims/world";
const GLB = ["-d", "--gltf_export_format", "glb"];
/** Maillages de troisième personne gardés (le kit de désamorçage n'existe que chez les CT). */
export const AGENT_MESHES = "thirdperson_body,thirdperson_default_gloves,defusekit";
// sans clip, Source 2 Viewer exporte certains agents sans squelette : un clip d'une image est demandé puis retiré
const SKELETON_CLIP = `${W}/rifle/_default_rifle/idle_rifle`;

/** Clips d'une classe par rôle (nom lu par le navigateur, agentAnim.ts) → chemin complet dans le VPK. Repos, pas dans
 *  les 8 directions (marche, course, accroupi), saut et vol (arrêté et 4 directions, debout et accroupi), désamorçage (debout
 *  et accroupi) ; couteau : pose du C4 en plus (le C4 se tient avec les clips du couteau). */
export function classClips(cls) {
  const d = `${W}/${cls}/_default_${cls}`, out = { idle: `${d}/idle_${cls}`, idle_crouch: `${d}/idle_crouch_${cls}` };
  for (const k of DIRS8) for (const g of ["walk", "run", "crouch"]) out[`${g}_${k}`] = `${d}/${g}_${k}_${cls}`;
  for (const k of AIR) for (const g of ["jump", "jump_crouch", "inair", "inair_crouch"]) out[`${g}_${k}`] = `${d}/${g}_${k}_${cls}`;
  out.defuse_enter = `${W}/shared/defuse/defuse_enter_${cls}`;
  out.defuse = `${W}/shared/defuse/defuse_loop_${cls}`;
  out.defuse_crouch_enter = `${W}/shared/defuse/defuse_crouch_enter_${cls}`;
  out.defuse_crouch = `${W}/shared/defuse/defuse_crouch_loop_${cls}`;
  if (cls === "knife") Object.assign(out, { plant: `${W}/equipment/c4/planting`, plant_crouch: `${W}/equipment/c4/planting_crouch` });
  return out;
}
/** Rôles sans lesquels une classe n'est pas envoyée : repos et pas dans les 8 directions. Les autres sont facultatifs
 *  (le navigateur s'en passe). */
export const REQUIRED = ["idle", "idle_crouch", ...DIRS8.flatMap((k) => [`walk_${k}`, `run_${k}`, `crouch_${k}`])];
/** Clips absents de la liste d'animations des agents, exportés seuls (squelette worldmodel) puis réunis dans
 *  anims-communes : morts (tâche 0.1) et atterrissages (fichiers « +non_additive » : la version additive du jeu est mal
 *  composée à l'export, rapport-jeu.md § 1.7). */
export const ALONE = {
  mort_chest_a: `${W}/shared/death_chest_a`, mort_chest_b: `${W}/shared/death_chest_b`,
  mort_gut_a: `${W}/shared/death_gut_a`, mort_gut_b: `${W}/shared/death_gut_b`,
  mort_rknee_a: `${W}/shared/death_rknee_a`, mort_rknee_b: `${W}/shared/death_rknee_b`, mort_rshoulder: `${W}/shared/death_rshoulder`,
  land_rifle: `${W}/shared/jump_additive_land_rifle.vnmclip+non_additive`,
  land_pistol: `${W}/shared/jump_additive_land_pistol.vnmclip+non_additive`,
  land_knife: `${W}/shared/jump_additive_land.vnmclip+non_additive`,
};

/** Modèle d'un agent équipé (« tm_leet_variantf ») : agents/models/<famille>/<agent>.vmdl_c, la famille étant le nom sans
 *  sa variante (« _variantf », « _varf1 »…) ; « ctm_fbi » n'en a pas. */
export const agentModel = (agent) => `agents/models/${agent.replace(/_var(iant)?[a-z0-9]*$/, "")}/${agent}.vmdl_c`;
/** Agents équipables listés par `Source2Viewer-CLI --vpk_list` (« agents/models/<famille>/<agent>.vmdl_c … », fins de
 *  ligne CRLF), sans les deux agents par défaut. */
export const agentsInList = (text) => [...new Set([...text.matchAll(/^agents\/models\/[a-z0-9_]+\/([a-z0-9_]+)\.vmdl_c\b/gm)].map((m) => m[1]))]
  .filter((a) => a !== "ctm_sas" && a !== "tm_phoenix").sort();

/** Lignes de commande de Source 2 Viewer 20.1. */
export const joueursArgs = {
  /** Agent d'un camp : maillages de 3e personne, matériaux PBR, squelette (un clip d'une image, retiré ensuite). */
  agent: (vpk, side, out) => joueursArgs.model(vpk, AGENTS[side], out),
  /** Modèle d'agent quelconque (agent équipé : agentModel). */
  model: (vpk, model, out) => ["-i", vpk, "-f", model, "-o", out, ...GLB, "--gltf_export_materials", "--gltf_textures_adapt",
    "--gltf_export_animations", "--gltf_mesh_list", AGENT_MESHES, "--gltf_animation_list", SKELETON_CLIP],
  /** Liste des modèles d'agents du VPK (agentsInList). */
  list: (vpk) => ["-i", vpk, "--vpk_list", "-f", "agents/models/"],
  /** Clips du monde sur le squelette de l'agent SAS (appliqués aussi à Phoenix, par nom d'os) ; sans matériaux. */
  clips: (vpk, clipPaths, out) => ["-i", vpk, "-f", AGENTS.ct, "-o", out, ...GLB, "--gltf_export_animations",
    "--gltf_mesh_list", "thirdperson_default_gloves", "--gltf_animation_list", clipPaths.join(",")],
  /** Un clip seul (sur son squelette worldmodel). */
  alone: (vpk, clipPath, out) => ["-i", vpk, "-f", `${clipPath}.vnmclip_c`, "-o", out, ...GLB, "--gltf_export_animations"],
};

/** Agent : maillages de 3e personne et squelette ; clip d'export et racines ajoutées par Source 2 Viewer retirés (même
 *  préparation que les bras de la vue du joueur). */
export const prepareAgent = prepareArms;

// racines ajoutées avec les clips : squelettes d'armes et maillages POINTS d'un sommet par os ; le squelette du personnage
// exporté seul (« …/skeletons/characters/worldmodel.vnmskel ») est gardé
const weaponHelper = (n) => /skeletons\/weapons\//.test(n.getName() ?? "") || named(n, ".empty_mesh_reference");
/** Piste d'échelle qui vaut 1 partout (toutes dans les clips du jeu : un tiers du poids pour rien). */
function unitScale(c) {
  if (c.getTargetPath() !== "scale") return false;
  const a = c.getSampler().getOutput().getArray();
  for (let k = 0; k < a.length; k++) if (Math.abs(a[k] - 1) > 1e-4) return false;
  return true;
}
const under = (top) => { const out = []; const walk = (n) => { out.push(n); n.listChildren().forEach(walk); }; walk(top); return out; };

/** Squelette du personnage seul, pour un fichier de clips : racines d'armes et maillages retirés avec les pistes qui les
 *  visent ; peaux, matériaux et textures retirés ; pistes d'échelle à 1 retirées. */
function skeletonOnly(doc) {
  const root = doc.getRoot(), [scene] = root.listScenes(), keep = new Set();
  const holders = new Set(root.listNodes().filter((n) => n.getMesh()));
  for (const top of scene.listChildren()) if (!weaponHelper(top) && !holders.has(top)) for (const n of under(top)) keep.add(n);
  for (const a of root.listAnimations()) {
    for (const c of a.listChannels()) {
      if (keep.has(c.getTargetNode()) && !unitScale(c)) continue;
      const s = c.getSampler();
      c.dispose();
      if (s && !a.listChannels().some((x) => x.getSampler() === s)) s.dispose();
    }
  }
  for (const n of holders) n.setMesh(null).setSkin(null);
  for (const p of [...root.listSkins(), ...root.listMeshes(), ...root.listMaterials(), ...root.listTextures()]) p.dispose();
  for (const top of scene.listChildren()) if (!keep.has(top)) cut(top);
  return doc;
}

/** Clips d'une classe en un document : squelette du personnage sans maillage et clips renommés par rôle (`roles` : rôle →
 *  chemin, classClips) ; les autres animations, les pistes des os d'armes et d'échelle à 1 retirées. Erreur si un rôle
 *  obligatoire manque. */
export function buildAnims(doc, roles, required = REQUIRED) {
  const root = doc.getRoot(), role = new Map(Object.entries(roles).map(([r, p]) => [p, r]));
  for (const a of root.listAnimations()) if (role.has(a.getName())) a.setName(role.get(a.getName())); else drop(a);
  const have = new Set(root.listAnimations().map((a) => a.getName()));
  const missing = required.filter((r) => !have.has(r));
  if (missing.length) throw new Error(`Clips absents de l'export : ${missing.map((r) => roles[r] ?? r).join(", ")}`);
  return skeletonOnly(doc);
}

/** Rôles de `roles` (dans leur ordre) sans animation dans un fichier de clips préparé par buildAnims, à regarder après
 *  l'optimisation (prune() y retire une animation vidée de toutes ses pistes). Les obligatoires sont vérifiés par
 *  buildAnims : ce sont les facultatifs perdus à l'export (saut, vol, désamorçage…), que runJoueurs signale sans arrêter. */
export function absentRoles(doc, roles) {
  const have = new Set(doc.getRoot().listAnimations().map((a) => a.getName()));
  return Object.keys(roles).filter((r) => !have.has(r));
}

/** Clips exportés seuls (`entries` : [rôle, document d'un clip]) réunis en un document : le squelette du premier, les
 *  pistes des suivants reliées à ses os du même nom (une piste sans os de ce nom est retirée). */
export function buildAlone(entries) {
  if (!entries.length) throw new Error("Aucun clip exporté seul");
  const [[role0, base], ...rest] = entries, root = base.getRoot();
  const only = (doc, role) => {
    const anims = doc.getRoot().listAnimations();
    if (anims.length !== 1) throw new Error(`${role} : ${anims.length} animations dans l'export au lieu d'une`);
    anims[0].setName(role);
  };
  only(base, role0);
  for (const [role, doc] of rest) {
    only(doc, role);
    const before = new Set(root.listNodes()), byName = new Map();
    for (const n of before) if (!byName.has(n.getName())) byName.set(n.getName(), n);
    mergeDocuments(base, doc);
    for (const a of root.listAnimations()) {
      for (const c of a.listChannels()) {
        const n = c.getTargetNode();
        if (!n || before.has(n)) continue;
        const same = byName.get(n.getName());
        if (same) { c.setTargetNode(same); continue; }
        const s = c.getSampler();
        c.dispose();
        if (s) s.dispose();
      }
    }
    const [main, ...extra] = root.listScenes();
    for (const s of extra) { for (const top of s.listChildren()) cut(top); s.dispose(); }
    root.setDefaultScene(main);
  }
  return skeletonOnly(base);
}

/** Arme du monde : le modèle seul (body_hd s'il existe, sans ses animations) sous « sl_arme », comme dans arme-<clé> ;
 *  le navigateur le monte dans la main des joueurs et au sol. */
export function buildWorldWeapon(model) {
  weaponModel(model);
  wrapScene(model, WEAPON_NODE);
  return model;
}

/** Sommets visés pour une arme du monde, et erreur de forme admise (part de la taille du modèle) : vue de loin, dans la
 *  main de 10 joueurs, elle n'a pas besoin du détail des modèles « body_hd » du jeu (15 000 sommets pour le Desert Eagle,
 *  21 000 pour l'AK-47, 34 000 pour l'AWP, 54 000 pour le Negev), plus lourds que le corps d'un agent (≈ 10 000). */
export const WORLD_WEAPON_VERTS = 8000, WORLD_WEAPON_ERROR = 0.005;
// Relevé à l'œil (gros plans, AWP et Negev, les plus réduites) : 0,01 et la position seule déformaient la crosse, la poignée
// et la courroie ; avec les normales et les UV dans l'erreur et 0,005, la forme et la texture restent celles du jeu.

/** Poids des normales et des UV dans l'erreur de la simplification (la position vaut 1) : sans eux, les pièces fines
 *  (poignée, crosse) se déforment et la texture glisse (vu à l'œil sur l'AWP et le Negev). */
export const WORLD_WEAPON_WEIGHTS = { normal: 1, uv: 2 };

/** Arme du monde allégée : sommets identiques fusionnés, puis chaque maillage simplifié (meshoptimizer, en tenant compte
 *  des normales et des UV) vers `verts` sommets environ ; une arme déjà plus légère est laissée telle quelle. Squelette,
 *  nœuds et attributs (os, UV, normales) gardés. */
export async function lightenWorldWeapon(doc, verts = WORLD_WEAPON_VERTS, error = WORLD_WEAPON_ERROR, weights = WORLD_WEAPON_WEIGHTS) {
  const prims = () => doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives());
  const count = prims().reduce((s, p) => s + (p.getAttribute("POSITION")?.getCount() ?? 0), 0);
  if (count <= verts) return doc;
  await MeshoptSimplifier.ready;
  await doc.transform(weld());
  for (const prim of prims()) {
    const pos = prim.getAttribute("POSITION")?.getArray(), idx = prim.getIndices();
    if (prim.getMode() !== 4 || !idx || !(pos instanceof Float32Array)) continue;
    const nor = prim.getAttribute("NORMAL")?.getArray(), uv = prim.getAttribute("TEXCOORD_0")?.getArray();
    const parts = [[nor instanceof Float32Array ? nor : null, 3, weights.normal], [uv instanceof Float32Array ? uv : null, 2, weights.uv]]
      .filter(([a]) => a), stride = parts.reduce((s, [, n]) => s + n, 0), n = pos.length / 3, attrs = new Float32Array(n * stride);
    for (let v = 0, o = 0; v < n; v++) for (const [a, k] of parts) for (let c = 0; c < k; c++) attrs[o++] = a[v * k + c];
    const src = Uint32Array.from(idx.getArray()), target = Math.floor((verts / count) * src.length / 3) * 3;
    const [dst] = MeshoptSimplifier.simplifyWithAttributes(src, pos, 3, attrs, stride, parts.flatMap(([, k, w]) => Array(k).fill(w)), null,
      target, error, []);
    idx.setArray(dst);
    compactPrimitive(prim);
  }
  return doc;
}
