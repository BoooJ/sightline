import assert from "node:assert/strict";
import { test } from "node:test";
import { Document } from "@gltf-transform/core";
import { apply, bombCenters, bombWorld, checkAlignment, invertAffine, SOURCE_TO_GLTF } from "../lib/align.mjs";

const NUKE = { pos_x: -3453, pos_y: 2887, scale: 7, bomb_a: [0.58, 0.48], bomb_b: [0.58, 0.58] };

test("site de bombe en coordonnées du jeu (comme registry.resolve_site)", () => {
  const [x, y] = bombWorld(NUKE, NUKE.bomb_a);
  assert.ok(Math.abs(x - 704.44) < 0.01 && Math.abs(y + 553.64) < 0.01);
});

test("aller-retour jeu → glTF → jeu", () => {
  const p = apply(invertAffine(SOURCE_TO_GLTF), apply(SOURCE_TO_GLTF, [704, -553, -400]));
  p.forEach((v, k) => assert.ok(Math.abs(v - [704, -553, -400][k]) < 1e-6));
});

/** Export physique factice : un volume « func_bomb_target » par point, en coordonnées glTF. */
function physics(points) {
  const doc = new Document(), buf = doc.createBuffer(), scene = doc.createScene();
  points.forEach((p, k) => {
    const a = apply(SOURCE_TO_GLTF, [p[0] - 50, p[1] - 50, p[2]]), b = apply(SOURCE_TO_GLTF, [p[0] + 50, p[1] + 50, p[2] + 80]);
    const pos = doc.createAccessor().setType("VEC3").setBuffer(buf).setArray(new Float32Array([...a, ...b, a[0], b[1], a[2]]));
    const mesh = doc.createMesh(`func_bomb_target_${k}`).addPrimitive(doc.createPrimitive().setAttribute("POSITION", pos));
    scene.addChild(doc.createNode(`func_bomb_target_${k}`).setMesh(mesh));
  });
  return doc;
}

test("alignement réussi puis raté", () => {
  const a = bombWorld(NUKE, NUKE.bomb_a), b = bombWorld(NUKE, NUKE.bomb_b);
  const good = checkAlignment(NUKE, bombCenters(physics([[a[0] + 30, a[1], -400], [b[0], b[1] - 20, -700]])));
  assert.equal(good.ok, true);
  assert.ok(good.checks.bomb_a < 31 && good.checks.bomb_b < 21);
  assert.equal(checkAlignment(NUKE, bombCenters(physics([[a[0] + 900, a[1], 0]]))).ok, false);
  assert.equal(checkAlignment(NUKE, []).ok, false);
});
