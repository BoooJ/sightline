import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { Document, getBounds } from "@gltf-transform/core";
import { buildCollision, COLLISION_ERROR_U, collisionArgs, collisionOut, collisionPath, keepCollisionNode } from "../lib/collision.mjs";
import { makeIO } from "../lib/optimize.mjs";
import { tmpDir } from "./tmp.mjs";

// SOURCE_TO_GLTF en colonnes (glTF) : les nœuds de l'export de world_physics portent cette matrice, sommets en unités du jeu
const S = [0, 0, 0.0254, 0, 0.0254, 0, 0, 0, 0, 0.0254, 0, 0, 0, 0, 0, 1];

/** Export de world_physics à la manière de Source 2 Viewer, inventé : un sol plat de 20 × 20 carreaux (800 u de côté, z 0)
 *  avec normales dans un groupe gardé, une surface traversée par les balles, et un clip des joueurs en hauteur (écarté). */
function physicsDoc() {
  const doc = new Document(), buf = doc.createBuffer();
  const mesh = (name, tris) => {
    const pos = tris.flat(), nrm = pos.map((_, k) => (k % 3 === 2 ? 1 : 0));
    const p = doc.createPrimitive()
      .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(new Float32Array(pos)).setBuffer(buf))
      .setAttribute("NORMAL", doc.createAccessor().setType("VEC3").setArray(new Float32Array(nrm)).setBuffer(buf));
    return doc.createNode(name).setMatrix(S).setMesh(doc.createMesh(name).addPrimitive(p));
  };
  const floor = [];
  for (let i = 0; i < 20; i++) for (let j = 0; j < 20; j++) {
    const [x0, y0, x1, y1] = [i * 40, j * 40, i * 40 + 40, j * 40 + 40];
    floor.push([x0, y0, 0], [x1, y0, 0], [x1, y1, 0], [x0, y0, 0], [x1, y1, 0], [x0, y1, 0]);
  }
  const scene = doc.createScene();
  scene.addChild(mesh("physics_group_0", floor));
  scene.addChild(mesh("physics_passbullets_1", [[0, 0, 0], [40, 0, 0], [0, 40, 0]]));
  scene.addChild(mesh("physics_npcclip_playerclip_2", [[0, 0, 400], [40, 0, 400], [0, 40, 400]]));
  return doc;
}

test("collision : chemin dans le VPK de la carte, ligne de commande, nœuds gardés", () => {
  assert.equal(collisionPath("de_dust2"), "maps/de_dust2/world_physics.vmdl_c");
  assert.deepEqual(collisionArgs("X:/de_dust2.vpk", "de_dust2", "out/de_dust2.glb"),
    ["-i", "X:/de_dust2.vpk", "-f", "maps/de_dust2/world_physics.vmdl_c", "-o", "out/de_dust2.glb", "-d", "--gltf_export_format", "glb"]);
  for (const n of ["physics_group_0", "physics_passbullets_3"]) assert.ok(keepCollisionNode(n), n);
  for (const n of ["physics_npcclip_playerclip_1", "physics_csgo_grenadeclip", "physics_sky", "physics_group_vrf_unknown_2", "", undefined, null]) {
    assert.ok(!keepCollisionNode(n), String(n));
  }
  assert.equal(COLLISION_ERROR_U, 2);
});

test("collision : un maillage sl_collision (POSITION seule), simplifié, clips écartés, même repère ; relu après meshopt", async (t) => {
  const io = await makeIO(), doc = physicsDoc();  // makeIO attend les encodeurs et le simplificateur de meshoptimizer
  const tris = await buildCollision(doc);
  assert.ok(tris >= 2 && tris < 100, `${tris} triangles (sol plat : presque tout se simplifie)`);
  const dir = tmpDir(t, "map3d-collision-"), file = path.join(dir, "collision.glb");
  await io.write(file, doc);
  const back = await io.read(file), meshes = back.getRoot().listMeshes();
  assert.deepEqual([...new Set(meshes.map((m) => m.getName()))], ["sl_collision"]);  // joints en un seul, en principe
  assert.deepEqual(meshes[0].listPrimitives().map((p) => p.listSemantics()), [["POSITION"]]);
  const [scene] = back.getRoot().listScenes();
  assert.deepEqual(scene.getExtras(), { sl_collision: { v: 1, error_u: 2 } });
  const { min, max } = getBounds(scene);  // mètres, repère de l'export : x = y du jeu, y = z du jeu, z = x du jeu
  for (const [got, want] of [[min, [0, 0, 0]], [max, [800 * 0.0254, 0, 800 * 0.0254]]]) {
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(got[k] - want[k]) < 0.01, `${got} ≈ ${want}`);
  }
  assert.ok(fs.statSync(file).size < 20_000);
});

test("collision : le .glb physique de Source 2 Viewer (« <sortie>_physics.glb ») ; absent : erreur claire", (t) => {
  const dir = tmpDir(t, "map3d-collision-"), out = path.join(dir, "de_dust2.glb");
  assert.throws(() => collisionOut(out), /Collision introuvable après l'export .*de_dust2_physics\.glb/);
  fs.writeFileSync(path.join(dir, "de_dust2_physics.glb"), "x");
  assert.equal(collisionOut(out), path.join(dir, "de_dust2_physics.glb"));
});
