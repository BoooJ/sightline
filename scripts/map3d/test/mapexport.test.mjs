import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { exportMapFiles } from "../lib/mapexport.mjs";
import { tmpDir } from "./tmp.mjs";

// dépendances factices : pas de CS2, pas de Source 2 Viewer
function setup(t, { collisionFails = false } = {}) {
  const work = tmpDir(t, "mapexport-"), calls = [], logs = [], warns = [];
  const io = { read: async () => ({}), write: async (f) => fs.writeFileSync(f, "x") };
  const deps = {
    runS2v: (exe, args) => calls.push(["s2v", args.join(" ")]),
    findExports: () => ({ world: "w.gltf", physics: "p.glb" }),
    bombCenters: () => [],
    checkAlignment: () => ({ ok: true, checks: { a: 1 } }),
    optimize: async (_io, _w, out, v) => { fs.writeFileSync(out, v); return { size: 1024, textures: 0 }; },
    collisionOut: (out) => {
      if (collisionFails) throw new Error("Collision introuvable après l'export (x_physics.glb) : rien n'est envoyé.");
      return out;
    },
    buildCollision: async () => 42,
  };
  const args = (variants) => ({ map: "de_cache", mapMeta: {}, variants, work, exe: "s2v", vpk: "v.vpk", io, log: (m) => logs.push(m), warn: (m) => warns.push(m) });
  return { deps, args, calls, logs, warns };
}

test("export d'une carte : grise, texturée et collision produites ; pas d'avertissement", async (t) => {
  const s = setup(t);
  const { files, checks } = await exportMapFiles(s.args(["gray", "textured", "collision"]), s.deps);
  assert.deepEqual(Object.keys(files), ["gray", "textured", "collision"]);
  assert.deepEqual(checks, { a: 1 });
  assert.equal(s.warns.length, 0);
  assert.ok(s.logs.some((l) => /Collision : .* 42 triangles/.test(l)));
});

test("collision absente sans --only : avertissement clair, gray et textured partent quand même", async (t) => {
  const s = setup(t, { collisionFails: true });
  const { files } = await exportMapFiles(s.args(["gray", "textured", "collision"]), s.deps);
  assert.deepEqual(Object.keys(files), ["gray", "textured"]);
  assert.equal(s.warns.length, 1);
  assert.match(s.warns[0], /pas de collision pour de_cache : .*Collision introuvable.* ; carte envoyée sans/);
  assert.doesNotMatch(s.warns[0], /rien n'est envoyé/);
});

test("collision qui lève dans buildCollision sans --only : même avertissement, carte envoyée", async (t) => {
  const s = setup(t);
  s.deps.buildCollision = async () => { throw new Error("aucun nœud gardé"); };
  const { files } = await exportMapFiles(s.args(["gray", "textured", "collision"]), s.deps);
  assert.deepEqual(Object.keys(files), ["gray", "textured"]);
  assert.match(s.warns[0], /pas de collision pour de_cache : aucun nœud gardé ; carte envoyée sans/);
});

test("--only collision : l'échec reste dur (erreur, aucun fichier)", async (t) => {
  const s = setup(t, { collisionFails: true });
  await assert.rejects(exportMapFiles(s.args(["collision"]), s.deps), /Collision introuvable/);
  assert.equal(s.warns.length, 0);
  assert.equal(s.calls.length, 1);  // seule la collision a été demandée à la CLI
});

test("--only collision réussi : checks vides, pas d'alignement", async (t) => {
  const s = setup(t);
  const { files, checks } = await exportMapFiles(s.args(["collision"]), s.deps);
  assert.deepEqual(Object.keys(files), ["collision"]);
  assert.deepEqual(checks, {});
});

test("alignement refusé : erreur même avec la collision (rien n'est envoyé)", async (t) => {
  const s = setup(t);
  s.deps.checkAlignment = () => ({ ok: false, checks: {} });
  await assert.rejects(exportMapFiles(s.args(["gray", "textured", "collision"]), s.deps), /Alignement refusé/);
});
