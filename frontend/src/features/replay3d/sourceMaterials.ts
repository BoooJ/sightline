import { AdditiveBlending, CustomBlending, DstColorFactor, type Material, type Mesh, MeshBasicMaterial,
  type MeshStandardMaterial, type Object3D, OneFactor, OneMinusSrcAlphaFactor, SrcColorFactor, ZeroFactor } from "three";

/** Matériau du jeu décrit par Source 2 Viewer (`extras.vmat` du fichier, recopié par GLTFLoader dans `userData`). */
interface Vmat { ShaderName?: string; IntParams?: Record<string, number> }

/** Couleur de la source qui ne change rien à l'image, par mode de mélange du jeu (`F_BLEND_MODE`) : Mod2x (3,
 *  2 × source × destination) et multiplication (5, source × destination). Là où la texture est transparente, la source
 *  la prend (shader de la carte : `applyCutaway`). */
const NEUTRAL: Record<number, string> = { 3: "0.5", 5: "1.0" };

/** Ce que glTF ne sait pas dire des matériaux du jeu (l'export a déjà retiré outils et effets, et posé translucide et
 *  test alpha) : les mélanges Mod2x, additif, multiplication et ModThenAdd (salissures, marquages au sol de Nuke,
 *  cascade et étiquettes de caisses d'Ancient), sans éclairage dans le jeu ; et les décalcomanies, posées à plat sur les
 *  murs et les sols, rapprochées un peu de la caméra pour ne pas se battre avec eux (rayures qui scintillent). À appeler
 *  avant `applyCutaway`. */
export function adaptSourceMaterials(root: Object3D) {
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material)) return;  // carte : un matériau par maillage
    const mat = mesh.material as MeshStandardMaterial, vmat = mat.userData?.vmat as Vmat | undefined;
    if (!vmat) return;
    const mode = vmat.IntParams?.F_BLEND_MODE ?? 0;
    let out: Material = mat;
    // alpha de l'image inchangé : le canvas du site n'est pas opaque, son fond réapparaissait sous les marquages
    const keepAlpha = { blendSrcAlpha: ZeroFactor, blendDstAlpha: OneFactor };
    // ModThenAdd : destination × (1 − alpha), puis source ajoutée (état de mélange du shader du jeu, DstBlend
    // InvSrcAlpha) ; étiquettes des caisses d'Ancient, d'alpha 1 : opaques, éclairées comme la carte (sans éclairage,
    // comme dans le jeu, le papier brillait dans l'ombre de la vue)
    if (mode === 6) Object.assign(mat, { blending: CustomBlending, blendSrc: OneFactor, blendDst: OneMinusSrcAlphaFactor, ...keepAlpha });
    if (mode >= 3 && mode <= 5) {
      const basic = new MeshBasicMaterial({ name: mat.name, map: mat.map, color: mat.color.clone(), opacity: mat.opacity,
        vertexColors: mat.vertexColors, transparent: true, depthWrite: false });
      basic.userData = mat.userData;
      if (mode === 4) basic.blending = AdditiveBlending;
      else {
        Object.assign(basic, { blending: CustomBlending, blendSrc: DstColorFactor, blendDst: mode === 3 ? SrcColorFactor : ZeroFactor, ...keepAlpha });
        basic.defines = { SL_BLEND_NEUTRAL: NEUTRAL[mode] };
      }
      mat.dispose();  // la texture reste, reprise par le nouveau matériau
      out = basic;
    }
    if (vmat.ShaderName === "csgo_static_overlay.vfx" || vmat.IntParams?.F_OVERLAY) {
      Object.assign(out, { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 });
      // posées sur une surface opaque : dessinées avant fumées et volumes (tri des transparents par le centre du maillage,
      // qui regroupe toute la carte : sinon elles passaient devant la fumée)
      if (out.transparent) mesh.renderOrder = -1;
    }
    mesh.material = out;
  });
}
