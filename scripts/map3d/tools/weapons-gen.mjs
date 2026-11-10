// Fabrique lib/weapons.json (armes de la vue du joueur, leur modèle et leurs clips de vue) depuis des données extraites
// de CS2 : armes.json (modèles, catégories, noms de demoparser2, dossiers de clips) et la liste des clips. Ne lit ni
// n'écrit aucun fichier de Valve : seulement des noms et des chemins. À relancer après une mise à jour de CS2 qui
// ajoute ou renomme des armes ou des clips. Erreur, au nom de l'arme, si un clip obligatoire de sa catégorie manque
// (lib/weapons.mjs : rolesFor) ; les clips facultatifs (optionalRolesFor : à vide, couteau touché ou dans le dos, lancer
// par-dessous, pose du C4) ne sont gardés que s'ils existent. Nouveau rôle : ROLES, rolesFor ou optionalRolesFor, test.
//
// Usage : node scripts/map3d/tools/weapons-gen.mjs <armes.json> <liste des clips (anim_names.tsv, ou sortie de --vpk_list)>
//
// Refaire les deux entrées (elles sont hors dépôt : elles contiennent des valeurs du jeu, prix, chargeurs, zoom).
// Tout part de pak01_dir.vpk (dossier csgo de CS2) lu avec Source2Viewer-CLI 20.1 (%LOCALAPPDATA%/sightline-map3d/) :
//
// 1. Liste des clips. `Source2Viewer-CLI.exe -i <csgo>/pak01_dir.vpk --vpk_list > vpk_list.txt` (fins de ligne CRLF, une
//    ligne « chemin CRC:… size:… » par fichier ; seuls les « animation/anims/viewmodel/… » servent). Un tableau
//    chemin / durée / images des clips (anim_names.tsv) donne la même liste de chemins.
//
// 2. armes.json = { _sources: { version_jeu }, armes: [ … ] }, une entrée par arme du replay : les 42 armes de
//    frontend/src/features/replay/hud.tsx (ICON_BY_NAME) plus weapon_knife et weapon_knife_t (pas les couteaux de
//    collection, ni dose de soin, charge d'effraction, bouclier). Champs lus ici, les autres sont ignorés :
//      nom_interne     clé de scripts/weapons.vdata_c, p. ex. « weapon_ak47 » (les armes sans m_szName sont écartées)
//      nom_demoparser2 nom de l'arme dans les images du replay (« AK-47 », « M4A4 », « knife_t »). Table index de
//                      définition (scripts/items/items_game.txt, section « items », nom « weapon_… ») -> nom, lue dans
//                      le binaire de demoparser2 (backend/.venv, demoparser2*.pyd : entrées clé u64 / pointeur /
//                      longueur) et vérifiée en lançant demoparser2 sur une démo (active_weapon_name, inventory)
//      categorie       m_WeaponType de weapons.vdata_c : fusil, sniper, pistolet, pistolet-mitrailleur, mitrailleuse,
//                      fusil à pompe (WEAPONTYPE_SHOTGUN), couteau, grenade, C4, zeus (WEAPONTYPE_TASER)
//      modele          m_szWorldModel + « _c » (le .vmdl_c, présent dans le VPK)
//      zoom            null, ou { cache_le_bras_en_zoom: m_bHideViewModelWhenZoomed } si m_nZoomLevels > 0
//      dossiers_clips_vue  [{ dossier, clips_references }] : dossiers « animation/anims/viewmodel/… » cités par le graphe
//                      de vue de l'arme (animation/graphs/viewmodel/viewmodel_gun.vnmgraph+<arme>, viewmodel_knife…,
//                      viewmodel_grenade… ; .vnmgraph_c lus avec -d), triés par nombre de références décroissant. Le lien
//                      arme -> graphe se fait par nom de fichier. Le graphe du C4 (viewmodel.vnmgraph) est partagé avec la
//                      dose de soin : garder seulement equipment/c4. USP-S et M4A1-S n'ont que les dossiers _default_*.
//    Le script de construction d'essai (analyse du 30/10/2026) était jetable et n'est pas dans le dépôt : ces champs
//    suffisent à le refaire. La version du jeu (steam.inf : ClientVersion, PatchVersion, VersionDate) va dans
//    _sources.version_jeu ; elle est reprise dans le champ _source de weapons.json.
//
// 3. Lancer le générateur, relire le diff de lib/weapons.json (clips obligatoires et facultatifs), puis `npm test`
//    (test/weapons.test.mjs fige le nombre d'armes et quelques clips) et refaire l'export de la vue (export.mjs vue).
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { buildWeapons, clipPathsIn, WEAPONS_FILE } from "../lib/weapons.mjs";

const [armesFile, clipsFile] = process.argv.slice(2);
if (!armesFile || !clipsFile) {
  console.error("Usage : node scripts/map3d/tools/weapons-gen.mjs <armes.json> <liste des clips>");
  process.exit(1);
}
const armes = JSON.parse(fs.readFileSync(armesFile, "utf8"));
const version = armes._sources?.version_jeu ?? "version inconnue";
const out = buildWeapons(armes, clipPathsIn(fs.readFileSync(clipsFile, "utf8")),
  `généré par tools/weapons-gen.mjs depuis armes.json et la liste des clips de vue de CS2 (${version})`);
fs.writeFileSync(WEAPONS_FILE, `${JSON.stringify(out, null, 1)}\n`);
console.log(`${out.weapons.length} armes écrites dans ${fileURLToPath(WEAPONS_FILE)}`);
