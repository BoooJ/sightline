import fs from "node:fs";
import path from "node:path";

export const DEFAULT_STEAM = "C:\\Program Files (x86)\\Steam";
const CS2 = path.join("steamapps", "common", "Counter-Strike Global Offensive", "game", "csgo");

/** Dossiers des bibliothèques Steam (clés "path" de libraryfolders.vdf, barres obliques inverses doublées). */
export function parseLibraryFolders(text) {
  return [...text.matchAll(/"path"\s+"([^"]+)"/g)].map((m) => m[1].replace(/\\\\/g, "\\"));
}

/** Dossier game/csgo de CS2 (celui qui contient des cartes) et sa version (ClientVersion de steam.inf). */
export function findCs2(steamRoot = process.env.STEAM_PATH || DEFAULT_STEAM) {
  const vdf = path.join(steamRoot, "steamapps", "libraryfolders.vdf");
  const libs = fs.existsSync(vdf) ? parseLibraryFolders(fs.readFileSync(vdf, "utf8")) : [];
  for (const lib of [steamRoot, ...libs]) {
    const csgo = path.join(lib, CS2);
    if (!fs.existsSync(path.join(csgo, "maps"))) continue;
    const inf = path.join(csgo, "steam.inf");
    const version = fs.existsSync(inf) ? (fs.readFileSync(inf, "utf8").match(/^ClientVersion=(\S+)/m)?.[1] ?? "") : "";
    return { csgo, version };
  }
  throw new Error(`CS2 introuvable dans ${steamRoot} ni dans ses bibliothèques Steam. Si Steam est installé ailleurs, `
    + "indiquez son dossier dans la variable STEAM_PATH (PowerShell : $env:STEAM_PATH = \"D:\\Steam\") puis relancez ; "
    + "sinon, installez ou mettez à jour Counter-Strike 2 dans Steam (les cartes sont dans game/csgo/maps).");
}

/** Archive principale du jeu (agents, armes, animations : bras et armes de la vue du joueur). */
export function pakVpk(csgo) {
  const vpk = path.join(csgo, "pak01_dir.vpk");
  if (!fs.existsSync(vpk)) throw new Error(`pak01_dir.vpk introuvable dans CS2 (${vpk}) : vérifiez les fichiers du jeu dans Steam.`);
  return vpk;
}

export function mapVpk(csgo, map) {
  const vpk = path.join(csgo, "maps", `${map}.vpk`);
  if (!fs.existsSync(vpk)) throw new Error(`Carte introuvable dans CS2 : ${vpk}`);
  return vpk;
}
