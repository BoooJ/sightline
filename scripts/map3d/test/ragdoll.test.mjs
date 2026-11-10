import assert from "node:assert/strict";
import { test } from "node:test";
import { parseKv3 } from "../lib/kv3.mjs";
import { makeIO } from "../lib/optimize.mjs";
import { physBlock, RAGDOLL_FILE, ragdollArgs, ragdollDoc, ragdollFromPhys, readRagdoll } from "../lib/ragdoll.mjs";
import { PHYS_RAGDOLL, PHYS_TEXT } from "./physText.mjs";

const SAS = "agents/models/ctm_sas/ctm_sas.vmdl_c";

test("ragdoll : ligne de commande (bloc PHYS de SAS en texte), bloc du bon fichier, JSON attendu", () => {
  assert.equal(RAGDOLL_FILE, "ragdoll");
  assert.deepEqual(ragdollArgs("X:/pak01_dir.vpk"), ["-i", "X:/pak01_dir.vpk", "-f", SAS, "-b", "PHYS"]);
  const block = physBlock(PHYS_TEXT);
  assert.match(block, /^--- Data for block "PHYS" ---\n/);
  assert.doesNotMatch(block, /autre/);  // pas le bloc du fichier précédent
  assert.deepEqual(readRagdoll(PHYS_TEXT), PHYS_RAGDOLL);
  assert.deepEqual(ragdollFromPhys(parseKv3(block)), PHYS_RAGDOLL);
});

test("ragdoll : bloc absent, forme autre que sphère ou capsule, corps ou articulations incohérents : erreur claire", () => {
  assert.throws(() => physBlock(PHYS_TEXT.replace("[2/2] agents/models/ctm_sas/ctm_sas.vmdl_c", "[2/2] autre.vmdl_c")), /Bloc PHYS de .*ctm_sas\.vmdl_c introuvable/);
  const kv = parseKv3(physBlock(PHYS_TEXT));
  const hull = structuredClone(kv);
  hull.m_parts[1].m_rnShape.m_hulls = [{}];
  assert.throws(() => ragdollFromPhys(hull), /Corps head_0 : forme inattendue/);
  const short = structuredClone(kv);
  short.m_boneNames.pop();
  assert.throws(() => ragdollFromPhys(short), /Ragdoll illisible/);
  const joint = structuredClone(kv);
  joint.m_joints[0].m_nBody2 = 7;
  assert.throws(() => ragdollFromPhys(joint), /Ragdoll illisible/);
});

test("ragdoll : .glb sans maillage, ragdoll dans les extras de la scène sl_ragdoll, relu à l'identique", async () => {
  const io = await makeIO(), back = await io.readBinary(await io.writeBinary(ragdollDoc(PHYS_RAGDOLL)));
  const [scene] = back.getRoot().listScenes();
  assert.equal(scene.getName(), "sl_ragdoll");
  assert.equal(back.getRoot().listMeshes().length, 0);
  assert.deepEqual(scene.getExtras(), { sl_ragdoll: PHYS_RAGDOLL });
  assert.equal(back.getRoot().getDefaultScene(), scene);
});
