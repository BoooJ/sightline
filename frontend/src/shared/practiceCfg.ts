/** Fichiers de config CS2 pour s'entraîner sur un serveur privé (sv_cheats) : lineups et positions d'un round. */

export const PRACTICE_SETTINGS = [
  "sv_cheats 1", "mp_warmup_end", "mp_freezetime 0", "mp_roundtime_defuse 60", "mp_buy_anywhere 1", "mp_maxmoney 60000",
  "mp_startmoney 60000", "sv_infinite_ammo 1", "ammo_grenade_limit_total 5", "sv_grenade_trajectory_prac_pipreview 1",
  "sv_showimpacts 0", "bot_kick", "mp_restartgame 1",
];

const GIVE: Record<string, string> = {
  smoke: "weapon_smokegrenade", flash: "weapon_flashbang", he: "weapon_hegrenade",
  molotov: "weapon_molotov", incendiary: "weapon_incgrenade", decoy: "weapon_decoy",
};

/** Nom d'alias sûr pour la console (lettres, chiffres, _). */
export const aliasName = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase() || "x";

const header = (title: string, lines: string[]) => [
  `// ${title}`, ...lines.map((l) => `// ${l}`),
  "// Copier dans .../game/csgo/cfg puis, en jeu sur un serveur privé : exec <nom du fichier>", "",
];

export interface LineupCfg { type: string; setpos: string; label: string }

/** Config d'un lineup : réglages d'entraînement, grenade en main, téléportation au point de lancer. */
export function lineupCfg(map: string, l: LineupCfg): string {
  return [
    ...header(`Lineup ${l.type} — ${map}`, [l.label]),
    ...PRACTICE_SETTINGS, `give ${GIVE[l.type] ?? "weapon_smokegrenade"}`, l.setpos, `echo "Lineup prêt : ${l.label.replace(/"/g, "'")}"`, "",
  ].join("\n");
}

/** Pack de lineups : un alias par lineup (lineup_1, lineup_2…), avec la grenade correspondante. */
export function lineupPackCfg(map: string, lineups: LineupCfg[]): string {
  const lines = lineups.map((l, k) => `alias lineup_${k + 1} "give ${GIVE[l.type] ?? "weapon_smokegrenade"}; ${l.setpos}; echo ${aliasName(l.label)}"`);
  const help = lineups.map((l, k) => `echo "lineup_${k + 1} : ${l.type} — ${l.label.replace(/"/g, "'")}"`);
  return [...header(`Pack de lineups — ${map} (${lineups.length})`, ["Tapez lineup_N dans la console pour vous placer."]),
    ...PRACTICE_SETTINGS, ...lines, ...help, ""].join("\n");
}

export interface PlayerPos { name: string; side: string; x: number; y: number; z: number; yaw: number }

/** Positions de tous les joueurs à un instant : un alias pos_<joueur> par joueur, à exécuter par chacun. */
export function positionsCfg(title: string, players: PlayerPos[]): string {
  const lines = players.map((p) => `alias pos_${aliasName(p.name)} "setpos ${p.x.toFixed(2)} ${p.y.toFixed(2)} ${p.z.toFixed(2)}; setang 0 ${p.yaw.toFixed(2)} 0; echo ${p.side} ${aliasName(p.name)}"`);
  const help = players.map((p) => `echo "pos_${aliasName(p.name)} (${p.side})"`);
  return [...header(title, ["Chaque joueur tape pos_<son nom> pour se placer à sa position de l'instant."]),
    ...PRACTICE_SETTINGS, ...lines, ...help, ""].join("\n");
}

/** Téléchargement d'un fichier texte généré dans le navigateur. */
export function downloadText(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url; a.download = fileName;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
