import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const RELEASES = "https://github.com/ValveResourceFormat/ValveResourceFormat/releases";
// version avec laquelle l'export a été réglé (options, repère, noms de matériaux) : pas la dernière, celle-ci
export const S2V_ZIP = `${RELEASES}/download/20.1/cli-windows-x64.zip`;
export const DEFAULT_S2V = path.join(process.env.LOCALAPPDATA ?? "", "sightline-map3d", "Source2Viewer-CLI.exe");
const STATUS_CONTROL_C_EXIT = 0xC000013A;  // code de sortie d'un programme Windows arrêté par Ctrl+C

/** Commande du guide « Exporting Maps » de Source 2 Viewer. La CLI 20.1 refuse le glTF sans `-d`, et n'écrit les textures
 *  qu'avec `--gltf_export_materials` (essai sur Nuke, tâche 0). */
export const s2vArgs = (vpk, map, outFile) =>
  ["-i", vpk, "-f", `maps/${map}.vmap_c`, "-o", outFile, "-d", "--gltf_export_format", "gltf", "--gltf_export_materials",
    "--gltf_textures_adapt"];

function needS2v(exe) {
  if (!fs.existsSync(exe)) {
    throw new Error(`Source 2 Viewer CLI introuvable (${exe}) : téléchargez la version 20.1 (${S2V_ZIP}) et `
      + `décompressez-le dans ${path.dirname(exe)}, ou passez --s2v <chemin>.`);
  }
}
const stoppedBy = (r) => r.status === STATUS_CONTROL_C_EXIT || ["SIGINT", "SIGHUP", "SIGTERM"].includes(r.signal);

/** Comme runS2v, mais rend la sortie standard (blocs en texte : `-b PHYS`) au lieu de l'afficher ; mêmes erreurs. */
export function s2vText(exe, args) {
  needS2v(exe);
  const r = spawnSync(exe, args, { encoding: "utf8", maxBuffer: 64 * 1024 ** 2 });
  if (stoppedBy(r)) throw Object.assign(new Error("Interrompu."), { interrupted: true });
  if (r.error || r.status !== 0) throw new Error(`Source 2 Viewer a échoué (${r.error?.message ?? `code ${r.status}`}).`);
  return r.stdout ?? "";
}

export function runS2v(exe, args) {
  needS2v(exe);
  const r = spawnSync(exe, args, { stdio: "inherit" });
  // Ctrl+C ou console fermée : la CLI (même console) s'arrête aussi, avant que notre écouteur SIGINT puisse tourner
  // (spawnSync bloque la boucle) ; ce n'est pas un échec de l'export
  if (stoppedBy(r)) {
    throw Object.assign(new Error("Interrompu."), { interrupted: true });
  }
  if (r.status !== 0) throw new Error(`Source 2 Viewer a échoué (code ${r.status}).`);
}

/** Fichiers produits : la carte (.gltf) et ses volumes physiques (« _physics »). */
export function findExports(dir) {
  const all = fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(".gltf"));
  const physics = all.find((f) => /_physics\.gltf$/i.test(f));
  const world = all.find((f) => !/_physics\.gltf$/i.test(f));
  if (!world) throw new Error(`Aucun .gltf exporté dans ${dir}`);
  return { world: path.join(dir, world), physics: physics ? path.join(dir, physics) : null };
}
