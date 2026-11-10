import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PREFIX = "sightline-map3d-";  // dossiers de travail dans %TEMP% (0,3 à 0,6 Go chacun)
export const LOCK = "lancement.pid";  // PID du lancement qui utilise le dossier
const OLD_MS = 3600_000;  // dossier sans verrou lisible : plus d'une heure, aucun export ne dure si longtemps

/** Dossier de travail d'un lancement, marqué de son PID : les autres lancements n'y touchent pas tant qu'il tourne. */
export function makeWork(tmp = os.tmpdir(), pid = process.pid) {
  const dir = fs.mkdtempSync(path.join(tmp, PREFIX));
  fs.writeFileSync(path.join(dir, LOCK), String(pid));
  return dir;
}

/** Dossier supprimé à la sortie, quelle qu'elle soit : fin normale, erreur, process.exit, Ctrl+C ou console fermée
 *  (0,3 à 0,6 Go). Renvoie stopped() : un Ctrl+C a-t-il été reçu ? */
export function guardWork(dir, log = console.error) {
  let stopped = false;
  process.once("exit", (code) => {
    if (code === 130) log("\nInterrompu.");
    removeDir(dir);
  });
  // Sans écouteur, Node s'arrêterait sans passer par « exit ». Pendant l'envoi, Playwright pose aussi le sien au
  // lancement de Chromium : il ferme le navigateur proprement, puis sort en 130. Le nôtre, appelé avant (posé avant),
  // le laisse alors faire : process.exit ici ferait tuer Chromium net (taskkill /F).
  const stop = (signal) => {
    stopped = true;
    if (process.listenerCount(signal) === 1) process.exit(130);
  };
  process.on("SIGINT", stop);
  process.on("SIGHUP", stop);
  return () => stopped;
}

/** Le processus tourne-t-il encore ? Le signal 0 n'envoie rien ; EPERM : il existe, mais sans droit sur lui. */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** PID du verrou, ou null s'il manque ou n'est pas un entier que process.kill accepte (sinon il lève, vivant ou non). */
function lockPid(dir) {
  try {
    const s = fs.readFileSync(path.join(dir, LOCK), "utf8").trim();
    return /^[1-9]\d{0,9}$/.test(s) && Number(s) <= 2 ** 31 - 1 ? Number(s) : null;
  } catch {
    return null;
  }
}

/** Supprime un dossier sans lever : sous Windows, un antivirus peut tenir un fichier ouvert un instant (EBUSY, EPERM). */
export function removeDir(dir, warn = console.warn) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    return true;
  } catch (e) {
    warn(`Dossier temporaire non supprimé (${dir}) : ${e.code ?? e.message}. Supprimez-le à la main.`);
    return false;
  }
}

/** Restes d'exports interrompus (Ctrl+C, console fermée, plantage) : dossiers sightline-map3d-* dont le lancement ne
 *  tourne plus (PID du verrou). Celui d'un lancement vivant n'est jamais supprimé : son mtime ne dit rien, l'export et
 *  l'envoi écrivent dans des sous-dossiers ou pas du tout. Sans verrou lisible (ancienne version, arrêt juste après la
 *  création) : plus d'une heure. */
export function cleanOldWork(tmp = os.tmpdir(), now = Date.now(), warn = console.warn) {
  let entries, n = 0;
  try {
    entries = fs.readdirSync(tmp, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith(PREFIX)) continue;
    const dir = path.join(tmp, e.name), pid = lockPid(dir);
    let over;
    if (pid !== null) over = !isAlive(pid);
    else {
      try {
        over = now - fs.statSync(dir).mtimeMs > OLD_MS;
      } catch {
        continue;
      }
    }
    if (over && removeDir(dir, warn)) n++;
  }
  return n;
}
