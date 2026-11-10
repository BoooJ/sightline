import { describe, expect, it } from "vitest";
import { AdditiveBlending, CustomBlending, DstColorFactor, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial,
  NormalBlending, OneFactor, OneMinusSrcAlphaFactor, SrcColorFactor, Texture, ZeroFactor } from "three";
import { adaptSourceMaterials } from "./sourceMaterials";

/** Matériau de carte tel que GLTFLoader le crée : `extras.vmat` de Source 2 Viewer recopié dans `userData`. */
function mapMesh(vmat?: object, transparent = true) {
  const mat = new MeshStandardMaterial({ name: "m", map: new Texture(), transparent, depthWrite: !transparent });
  if (vmat) mat.userData = { vmat };
  const mesh = new Mesh(undefined, mat);
  adaptSourceMaterials(new Group().add(mesh));
  return { before: mat, after: mesh.material as MeshBasicMaterial | MeshStandardMaterial };
}
const overlay = (mode: number) => ({ ShaderName: "csgo_static_overlay.vfx", IntParams: { F_BLEND_MODE: mode } });

describe("matériaux du jeu dans la vue 3D", () => {
  it("Mod2x : 2 × source × destination, gris neutre là où la texture est transparente, sans éclairage", () => {
    const { before, after } = mapMesh(overlay(3));
    expect(after).toBeInstanceOf(MeshBasicMaterial);
    expect(after).toMatchObject({ name: "m", map: before.map, transparent: true, depthWrite: false, blending: CustomBlending,
      blendSrc: DstColorFactor, blendDst: SrcColorFactor, defines: { SL_BLEND_NEUTRAL: "0.5" },
      blendSrcAlpha: ZeroFactor, blendDstAlpha: OneFactor });  // alpha du canvas inchangé
    expect(after.userData.vmat).toEqual(overlay(3));
  });
  it("multiplication : source × destination, blanc neutre ; additif : ajouté selon l'alpha", () => {
    const mul = mapMesh({ ShaderName: "csgo_unlitgeneric.vfx", IntParams: { F_BLEND_MODE: 5 } }).after;
    expect(mul).toMatchObject({ blending: CustomBlending, blendSrc: DstColorFactor, blendDst: ZeroFactor,
      defines: { SL_BLEND_NEUTRAL: "1.0" } });
    // ModThenAdd (étiquettes des caisses d'Ancient) : destination × (1 − alpha), puis source ajoutée (état de mélange du
    // shader du jeu : DstBlend InvSrcAlpha)
    // ; éclairées comme la carte (sans éclairage, le papier brillait dans l'ombre)
    const mta = mapMesh(overlay(6));
    expect(mta.after).toBe(mta.before);
    expect(mta.after).toMatchObject({ blending: CustomBlending, blendSrc: OneFactor, blendDst: OneMinusSrcAlphaFactor,
      blendSrcAlpha: ZeroFactor, blendDstAlpha: OneFactor });
    const add = mapMesh({ ShaderName: "csgo_unlitgeneric.vfx", IntParams: { F_BLEND_MODE: 4 } }).after;
    expect(add).toBeInstanceOf(MeshBasicMaterial);
    expect(add.blending).toBe(AdditiveBlending);
    expect(add.defines?.SL_BLEND_NEUTRAL).toBeUndefined();
  });
  it("décalcomanies (overlays, F_OVERLAY) : rapprochées de la caméra pour ne pas se battre avec le mur", () => {
    for (const vmat of [overlay(1), overlay(3), { ShaderName: "csgo_lightmappedgeneric.vfx", IntParams: { F_OVERLAY: 1 } }]) {
      const { after } = mapMesh(vmat);
      expect(after).toMatchObject({ polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 });
    }
    // translucide : glTF le dit déjà (BLEND), le matériau reste celui du fichier
    const t = mapMesh(overlay(1));
    expect(t.after).toBe(t.before);
    expect(t.after.blending).toBe(NormalBlending);
  });
  it("le reste ne change pas : matériaux sans vmat, opaques, ni décalcomanie ni mélange", () => {
    for (const vmat of [undefined, { ShaderName: "csgo_complex.vfx", IntParams: {} }]) {
      const { before, after } = mapMesh(vmat, false);
      expect(after).toBe(before);
      expect(after.polygonOffset).toBe(false);
    }
  });
});
