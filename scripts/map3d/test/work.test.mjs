import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { cleanOldWork, LOCK, makeWork, PREFIX, removeDir } from "../lib/work.mjs";
import { tmpDir } from "./tmp.mjs";

const twoHoursAgo = () => (Date.now() - 2 * 3600_000) / 1000;

/** Lancement simulé dans un processus à part : dossier gardé par guardWork, puis Ctrl+C (process.emit). `playwright` :
 *  un écouteur SIGINT posé après le nôtre, comme celui de Playwright au lancement de Chromium (fermeture, puis sortie 130). */
function interrupted(tmp, playwright) {
  const work = new URL("../lib/work.mjs", import.meta.url).href;
  const code = `import { guardWork, makeWork } from ${JSON.stringify(work)};
    const stopped = guardWork(makeWork(${JSON.stringify(tmp)}));
    ${playwright ? 'process.on("SIGINT", () => setTimeout(() => { console.log("chromium fermé"); process.exit(130); }, 50));' : ""}
    process.emit("SIGINT", "SIGINT");
    console.log("après le signal", stopped());`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
}

test("Ctrl+C : sortie en 130 avec « Interrompu. », dossier supprimé", (t) => {
  const tmp = tmpDir(t, "map3d-work-");
  const r = interrupted(tmp, false);
  assert.equal(r.status, 130, r.stderr);
  assert.equal(r.stdout, "");  // sortie immédiate
  assert.match(r.stderr, /Interrompu\./);
  assert.deepEqual(fs.readdirSync(tmp), []);
});

test("Ctrl+C pendant l'envoi : Playwright ferme Chromium avant la sortie, le dossier part quand même", (t) => {
  const tmp = tmpDir(t, "map3d-work-");
  const r = interrupted(tmp, true);
  assert.equal(r.status, 130, r.stderr);
  assert.equal(r.stdout.replace(/\r/g, ""), "après le signal true\nchromium fermé\n");
  assert.match(r.stderr, /Interrompu\./);
  assert.deepEqual(fs.readdirSync(tmp), []);
});

test("au démarrage : les restes d'exports sans verrou lisible (plus d'une heure) sont supprimés, pas le reste", (t) => {
  const tmp = tmpDir(t, "map3d-work-");
  const old = path.join(tmp, `${PREFIX}ancien`), fresh = path.join(tmp, `${PREFIX}recent`), other = path.join(tmp, "autre-ancien");
  const broken = path.join(tmp, `${PREFIX}verrou-abime`);
  for (const d of [old, fresh, other, broken]) {
    fs.mkdirSync(path.join(d, "export"), { recursive: true });
    fs.writeFileSync(path.join(d, "export", "de_nuke.gltf"), "{}");
  }
  fs.writeFileSync(path.join(broken, LOCK), "");
  for (const d of [old, other, broken]) fs.utimesSync(d, twoHoursAgo(), twoHoursAgo());
  assert.equal(cleanOldWork(tmp), 2);
  assert.deepEqual([old, fresh, other, broken].map((d) => fs.existsSync(d)), [false, true, true, false]);
  assert.equal(cleanOldWork(path.join(tmp, "absent")), 0);
});

test("dossier d'un lancement encore vivant : jamais supprimé, même vieux ; lancement terminé : supprimé tout de suite", (t) => {
  const tmp = tmpDir(t, "map3d-work-");
  const live = makeWork(tmp);  // ce processus : un export en cours, dont le dossier racine ne bouge plus (mtime ancien)
  const dead = makeWork(tmp, 2147483647);  // PID qui ne tourne pas : lancement arrêté net (console fermée, plantage)
  assert.ok(path.basename(live).startsWith(PREFIX));
  assert.equal(fs.readFileSync(path.join(live, LOCK), "utf8"), String(process.pid));
  fs.utimesSync(live, twoHoursAgo(), twoHoursAgo());
  assert.equal(cleanOldWork(tmp), 1);
  assert.deepEqual([fs.existsSync(live), fs.existsSync(dead)], [true, false]);
});

test("suppression du dossier temporaire : un échec avertit au lieu de lever", (t) => {
  const warnings = [];
  assert.equal(removeDir("a\0b", (m) => warnings.push(m)), false);
  assert.match(warnings[0], /non supprimé/);
  const dir = tmpDir(t, "map3d-work-");
  assert.equal(removeDir(dir), true);
  assert.equal(fs.existsSync(dir), false);
});
