// Armes de la vue du joueur (lib/weapons.json) : lecture, et fabrication de la liste depuis des données extraites de
// CS2 (noms, chemins de modèles et de clips : aucun fichier de Valve).
import fs from "node:fs";

export const WEAPONS_FILE = new URL("./weapons.json", import.meta.url);

/** Rôle d'un clip de vue d'après son nom (dernier segment du chemin). Parmi les noms qui conviennent, le plus court gagne
 *  (draw_revolver plutôt que draw_2_revolver) ; les variantes « _lgcy » (anciens modèles du SSG 08) sont écartées.
 *  Rôles obligatoires d'abord (rolesFor), puis facultatifs (optionalRolesFor : présents seulement si l'arme a le clip).
 *  Couteau : sans suffixe = coup léger (clic gauche), suffixe 2 = coup lourd (clic droit, comme attack2) ; « _alt » = 2e
 *  variante du même coup ; attack = dans le vide, hit = touché, backstab = dans le dos. */
export const ROLES = {
  idle: /^idle1?_(?!slide|left|from)/,  // pas idle_slide_back, idle_leftempty (Dual Berettas), idle_from_activity
  draw: /^draw_/,
  shoot: /^shoot(1|_right1)_/,  // shoot_right1_elite : Dual Berettas
  reload: /^reload_(?!empty)/,
  attack: /^light_miss1_/,
  attack2: /^heavy_miss1_/,
  pullpin: /^pullpin_/,
  throw: /^throw_overhand_/,
  // facultatifs
  shoot_empty: /^shoot_(empty|rightlast)_/,  // dernier coup du chargeur ; Dual Berettas : dernier coup de la main droite (comme shoot)
  reload_empty: /^reload_empty_/,  // pas reload2_empty_ (CZ75-Auto : 2e variante)
  idle_empty: /^idle_(slide_back|leftrightempty)_/,  // glissière en arrière ; Dual Berettas : les deux glissières (idle_leftempty : une seule)
  attack_alt: /^light_miss2_/,
  hit: /^light_hit1_/,
  hit_alt: /^light_hit2_/,
  backstab: /^light_backstab_/,
  backstab_alt: /^light_backstab2_/,
  attack2_alt: /^heavy_miss2_/,  // coups lourds : seuls heavy_hit1 et heavy_backstab existent dans CS2 (1.41.9.2)
  hit2: /^heavy_hit1_/,
  hit2_alt: /^heavy_hit2_/,
  backstab2: /^heavy_backstab_/,
  backstab2_alt: /^heavy_backstab2_/,
  throw_underhand: /^throw_underhand_/,  // lancer par-dessous (clic droit)
  plant: /^plant_/,  // pose du C4
};

/** Rôles obligatoires selon la catégorie de l'arme (champ « categorie » d'armes.json) : la génération échoue si l'un manque. */
export function rolesFor(category) {
  if (category === "couteau") return ["idle", "draw", "attack", "attack2"];
  if (category === "grenade") return ["idle", "draw", "pullpin", "throw"];
  if (category === "C4") return ["idle", "draw"];
  if (category === "zeus") return ["idle", "draw", "shoot"];
  return ["idle", "draw", "shoot", "reload"];
}

/** Rôles facultatifs selon la catégorie : exportés seulement si l'arme a le clip (pistolets : à vide ; couteau : touché,
 *  dans le dos et 2es variantes ; grenade : par-dessous ; C4 : pose). */
export function optionalRolesFor(category) {
  if (category === "couteau") return ["attack_alt", "hit", "hit_alt", "backstab", "backstab_alt", "attack2_alt", "hit2", "hit2_alt", "backstab2", "backstab2_alt"];
  if (category === "grenade") return ["throw_underhand"];
  if (category === "C4") return ["plant"];
  if (category === "zeus") return [];
  return ["shoot_empty", "reload_empty", "idle_empty"];
}

/** Chemins des clips de vue cités dans un texte : liste des animations de l'agent (anim_names.tsv) ou sortie de
 *  `Source2Viewer-CLI --vpk_list` (le « .vnmclip_c » final n'est pas pris). */
export const clipPathsIn = (text) => [...new Set(text.match(/animation\/anims\/viewmodel\/[a-z0-9_/]+/g) ?? [])];

/** Pour chaque rôle, le chemin complet du clip pris dans le dossier de clips de l'arme. */
export function pickClips(folder, clipPaths, roles) {
  const names = clipPaths.filter((p) => p.startsWith(`${folder}/`) && !p.slice(folder.length + 1).includes("/"))
    .map((p) => p.slice(folder.length + 1)).filter((n) => !n.endsWith("_lgcy"));
  const out = {};
  for (const role of roles) {
    const hit = names.filter((n) => ROLES[role].test(n)).sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
    if (hit) out[role] = `${folder}/${hit}`;
  }
  return out;
}

/** Contenu de lib/weapons.json depuis armes.json (valeurs extraites du jeu : voir tools/weapons-gen.mjs) et la liste des
 *  clips. Erreur, au nom de l'arme, si elle n'a pas tous les clips obligatoires de sa catégorie (rolesFor) ; les clips
 *  facultatifs (optionalRolesFor) sont ajoutés quand ils existent. */
export function buildWeapons(armes, clipPaths, source) {
  const weapons = armes.armes.map((a) => {
    const key = a.nom_interne.replace(/^weapon_/, "");
    const folder = a.dossiers_clips_vue?.[0]?.dossier;  // le dossier le plus fourni (armes.json les trie ainsi)
    const clips = folder ? pickClips(folder, clipPaths, [...rolesFor(a.categorie), ...optionalRolesFor(a.categorie)]) : {};
    const missing = rolesFor(a.categorie).filter((r) => !clips[r]);
    if (missing.length) throw new Error(`${key} : clips ${missing.join(", ")} introuvables (${folder ?? "aucun dossier"})`);
    return { key, name: a.nom_demoparser2, category: a.categorie, model: a.modele,
      hideScoped: !!a.zoom?.cache_le_bras_en_zoom, clips };
  });
  return { _source: source, weapons };
}

/** Armes de lib/weapons.json. */
export const loadWeapons = (file = WEAPONS_FILE) => JSON.parse(fs.readFileSync(file, "utf8")).weapons;
