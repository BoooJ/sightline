/** Sortie de `Source2Viewer-CLI -b PHYS` réduite et INVENTÉE (aucune valeur du jeu) : un autre fichier d'abord, puis SAS
 *  avec deux corps (une capsule, une sphère) et une articulation ; fins de ligne CRLF, comme sous Windows. */
export const PHYS_TEXT = [
  "--- Files in package:",
  "[1/2] agents/models/ctm_sas/ctm_sas_arms.vmdl_c",
  '--- Data for block "PHYS" ---',
  "<!-- kv3 encoding:text:version{0} format:generic:version{0} -->",
  '{ m_boneNames = [ "autre" ] }',
  "[2/2] agents/models/ctm_sas/ctm_sas.vmdl_c",
  "\tResource Type: Model [Version 1]",
  "",
  '--- Data for block "PHYS" ---',
  "<!-- kv3 encoding:text:version{0} format:generic:version{0} -->",
  "{",
  "\tm_nFlags = 0",
  '\tm_boneNames = [ "pelvis", "head_0" ]',
  "\tm_bindPose = [ [ 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 40.0 ], [ 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 60.0 ] ]",
  "\tm_parts = [",
  "\t\t{ m_flMass = 20.0 m_flLinearDamping = 0.0 m_flAngularDamping = 2.0 m_flInertiaScale = 5.0",
  "\t\t  m_rnShape = { m_spheres = [ ] m_capsules = [ { m_Capsule = { m_vCenter = [ [ 0.0, 0.0, -4.0 ], [ 0.0, 0.0, 6.0 ] ] m_flRadius = 5.0 } } ] m_hulls = [ ] m_meshes = [ ] } },",
  "\t\t{ m_flMass = 8.0 m_flLinearDamping = 0.0 m_flAngularDamping = 1.0 m_flInertiaScale = 5.0",
  "\t\t  m_rnShape = { m_spheres = [ { m_Sphere = { m_vCenter = [ 2.0, 0.0, 0.0 ] m_flRadius = 4.0 } } ] m_capsules = [ ] m_hulls = [ ] m_meshes = [ ] } },",
  "\t]",
  "\tm_joints = [",
  "\t\t{ m_nType = 4 m_nBody1 = 0 m_nBody2 = 1 m_Frame1 = [ 0.0, 0.0, 20.0, 1.0, 0.0, 0.0, 0.0, 1.0 ] m_Frame2 = [ 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0 ]",
  "\t\t  m_bEnableSwingLimit = true m_SwingLimit = { m_flMin = 0.0 m_flMax = 0.5 } m_bEnableTwistLimit = false m_TwistLimit = { m_flMin = -0.2 m_flMax = 0.2 } },",
  "\t]",
  "}",
].join("\r\n");

/** Le ragdoll attendu de PHYS_TEXT. */
export const PHYS_RAGDOLL = {
  v: 1, bones: ["pelvis", "head_0"],
  bindPose: [[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 40], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 60]],
  parts: [
    { mass: 20, linDamp: 0, angDamp: 2, inertiaScale: 5, spheres: [], capsules: [{ a: [0, 0, -4], b: [0, 0, 6], r: 5 }] },
    { mass: 8, linDamp: 0, angDamp: 1, inertiaScale: 5, spheres: [{ c: [2, 0, 0], r: 4 }], capsules: [] },
  ],
  joints: [{ type: 4, a: 0, b: 1, fa: [0, 0, 20, 1, 0, 0, 0, 1], fb: [0, 0, 0, 1, 0, 0, 0, 1], swing: 0.5, twist: null }],
};
