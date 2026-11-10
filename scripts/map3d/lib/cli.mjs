import { parseArgs } from "node:util";

export const DEFAULT_SITE = "https://sightline.example.com";
/** Fichiers d'une carte : versions grise et texturée, collision (corps des morts du replay 3D). */
export const MAP_FILES = ["gray", "textured", "collision"];
export const USAGE = `Usage : node scripts/map3d/export.mjs <carte> [--site https://…] [--s2v <chemin>] [--only gray|textured|collision] [--dry-run]
        node scripts/map3d/export.mjs vue [--only ak47,usp_silencer,bras] [--site https://…] [--s2v <chemin>] [--dry-run]
        node scripts/map3d/export.mjs joueurs [--only agents,clips_rifle,clips_communes,ak47] [--site https://…] [--s2v <chemin>] [--dry-run]
  <carte>    nuke, de_nuke… (une carte de Sightline)
  vue        bras et armes de la vue du joueur (pak01_dir.vpk de CS2 ; armes de scripts/map3d/lib/weapons.json)
  joueurs    joueurs vus de l'extérieur : agents SAS et Phoenix, clips de déplacement, morts, armes du monde (pak01_dir.vpk)
  --site     Sightline de destination (par défaut ${DEFAULT_SITE}) ; « --site=… » marche aussi
  --s2v      chemin de Source2Viewer-CLI.exe (par défaut %LOCALAPPDATA%\\sightline-map3d)
  --only     carte : un seul fichier, gray, textured ou collision ; vue : armes (clés de weapons.json) et « bras » ; joueurs : agents,
             clips_rifle, clips_pistol, clips_knife, clips_communes, armes, ragdoll, agent_<nom>, agents_tous ; séparés par des virgules
  --dry-run  exporte et vérifie, sans rien envoyer
  Steam installé ailleurs que C:\\Program Files (x86)\\Steam : donnez son dossier dans la variable STEAM_PATH.`;

const refuse = (why) => new Error(`${why}\n\n${USAGE}`);

/** Arguments de export.mjs, en mode strict : une option inconnue ou mal écrite (« --dryrun », « --sites ») arrête tout
 *  au lieu d'être ignorée, et l'envoi ne part jamais vers la prod par erreur. « vue » : bras et armes de la vue du
 *  joueur ({ vue: true, site, s2v, only, dryRun }) ; « joueurs » : joueurs vus de l'extérieur ({ joueurs: true, … }) ;
 *  sinon une carte ({ map, site, s2v, variants, dryRun }). */
export function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
      site: { type: "string" }, s2v: { type: "string" }, only: { type: "string" }, "dry-run": { type: "boolean" },
    } });
  } catch (e) {
    const opt = e.message.match(/'(-[^' ]+)/)?.[1] ?? "";
    if (e.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") throw refuse(`Option inconnue : ${opt}`);
    // même code pour « --site » sans valeur et pour « --dry-run=true » (option sans valeur qui en reçoit une)
    if (e.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
      throw refuse(/does not take an argument/.test(e.message) ? `${opt} ne prend pas de valeur` : `Valeur manquante pour ${opt}`);
    }
    throw refuse(e.message);
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1) throw refuse(positionals.length ? `Une seule carte à la fois (${positionals.join(", ")})` : "Carte manquante");
  const site = (values.site ?? DEFAULT_SITE).replace(/\/+$/, "");
  if (!/^https?:\/\/[^/\s]+/.test(site)) throw refuse(`--site invalide (${site}) : une adresse en http:// ou https://`);
  const kind = positionals[0].toLowerCase();
  if (kind === "vue" || kind === "joueurs") {
    // « --only= » (vide) refusé : il enverrait sinon tout sans rien dire
    const only = values.only === undefined ? null : values.only.split(",").map((k) => k.trim().toLowerCase());
    if (only && only.some((k) => !/^[a-z0-9_]{1,40}$/.test(k))) {
      throw refuse(`--only invalide (${values.only}) : ${kind === "vue" ? "clés d'armes séparées par des virgules (ak47,usp_silencer) ou bras"
        : "agents, clips_<classe>, clips_communes ou clés d'armes, séparés par des virgules"}`);
    }
    return { [kind]: true, site, s2v: values.s2v, only, dryRun: !!values["dry-run"] };
  }
  const name = positionals[0].toLowerCase();  // les cartes de Sightline sont en minuscules (Windows ignore la casse)
  const map = /^(de|cs)_/.test(name) ? name : `de_${name}`;
  if (!/^[a-z0-9_]{1,40}$/.test(map)) throw refuse(`Nom de carte invalide : ${positionals[0]}`);
  // « --only= » (valeur vide) est refusé aussi : il enverrait sinon les deux versions sans rien dire
  if (values.only !== undefined && !MAP_FILES.includes(values.only)) {
    throw refuse(`--only invalide (${values.only}) : gray, textured ou collision`);
  }
  return { map, site, s2v: values.s2v, variants: values.only ? [values.only] : [...MAP_FILES], dryRun: !!values["dry-run"] };
}
