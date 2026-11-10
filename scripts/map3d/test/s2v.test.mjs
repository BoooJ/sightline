import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { findExports, runS2v, s2vArgs, s2vText } from "../lib/s2v.mjs";
import { tmpDir } from "./tmp.mjs";

test("ligne de commande du guide d'export", () => {
  assert.deepEqual(s2vArgs("X:/maps/de_nuke.vpk", "de_nuke", "out/de_nuke.gltf"),
    ["-i", "X:/maps/de_nuke.vpk", "-f", "maps/de_nuke.vmap_c", "-o", "out/de_nuke.gltf", "-d", "--gltf_export_format", "gltf",
      "--gltf_export_materials", "--gltf_textures_adapt"]);
});

test("repère la carte et ses volumes physiques", (t) => {
  const dir = tmpDir(t, "map3d-s2v-");
  fs.mkdirSync(path.join(dir, "sous"));
  fs.writeFileSync(path.join(dir, "sous", "de_nuke_d.gltf"), "{}");
  fs.writeFileSync(path.join(dir, "sous", "de_nuke_d_physics.gltf"), "{}");
  assert.deepEqual(findExports(dir), { world: path.join(dir, "sous", "de_nuke_d.gltf"), physics: path.join(dir, "sous", "de_nuke_d_physics.gltf") });
});

test("explique où trouver Source 2 Viewer s'il manque", () => {
  assert.throws(() => runS2v("Z:/absent/Source2Viewer-CLI.exe", []), /releases\/download\/20\.1\/cli-windows-x64\.zip/);
});

test("Ctrl+C pendant l'export, reçu aussi par la CLI : interruption reconnue, pas un échec", () => {
  // même console : sous Windows la CLI se termine en STATUS_CONTROL_C_EXIT (0xC000013A), ailleurs par le signal
  const stop = process.platform === "win32" ? "process.exit(0xC000013A)" : "process.kill(process.pid, 'SIGINT')";
  assert.throws(() => runS2v(process.execPath, ["-e", stop]), (e) => e.interrupted === true && !/échoué/.test(e.message));
  assert.throws(() => runS2v(process.execPath, ["-e", "process.exit(3)"]), (e) => !e.interrupted && /échoué \(code 3\)/.test(e.message));
});

test("sortie texte de la CLI (-b PHYS) : rendue telle quelle ; échec, programme absent ou Ctrl+C reconnus", () => {
  assert.equal(s2vText(process.execPath, ["-e", "process.stdout.write('bloc\\r\\nsuite')"]), "bloc\r\nsuite");
  assert.throws(() => s2vText(process.execPath, ["-e", "process.exit(3)"]), (e) => !e.interrupted && /échoué \(code 3\)/.test(e.message));
  assert.throws(() => s2vText("Z:/absent/Source2Viewer-CLI.exe", []), /releases\/download\/20\.1\/cli-windows-x64\.zip/);
  const stop = process.platform === "win32" ? "process.exit(0xC000013A)" : "process.kill(process.pid, 'SIGINT')";
  assert.throws(() => s2vText(process.execPath, ["-e", stop]), (e) => e.interrupted === true);
});
