import { getBounds } from "@gltf-transform/core";

/** Coordonnées du jeu → glTF, ligne par ligne : Source 2 Viewer 20.1 (GltfModelExporter) multiplie par 0,0254 et
 *  permute les axes (x_gltf = y, y_gltf = z, z_gltf = x). À confirmer par l'essai sur Nuke (tâche 0). */
export const SOURCE_TO_GLTF = [0, 0.0254, 0, 0, 0, 0, 0.0254, 0, 0.0254, 0, 0, 0, 0, 0, 0, 1];
export const MAX_SITE_ERR = 300;  // unités du jeu, à plat

export const apply = (m, [x, y, z]) =>
  [m[0] * x + m[1] * y + m[2] * z + m[3], m[4] * x + m[5] * y + m[6] * z + m[7], m[8] * x + m[9] * y + m[10] * z + m[11]];

/** Inverse d'une matrice affine (même calcul que frontend/src/features/replay3d/world.ts). */
export function invertAffine(m) {
  const [a, b, c, , d, e, f, , g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) throw new Error("Matrice non inversible");
  const r = [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
  const [tx, ty, tz] = [m[3], m[7], m[11]];
  return [r[0], r[1], r[2], -(r[0] * tx + r[1] * ty + r[2] * tz), r[3], r[4], r[5], -(r[3] * tx + r[4] * ty + r[5] * tz),
    r[6], r[7], r[8], -(r[6] * tx + r[7] * ty + r[8] * tz), 0, 0, 0, 1];
}

/** Site de bombe de maps/<carte>.json (fractions du radar 1024 px) en coordonnées du jeu, comme registry.resolve_site. */
export const bombWorld = (meta, rel) => [meta.pos_x + rel[0] * 1024 * meta.scale, meta.pos_y - rel[1] * 1024 * meta.scale];

/** Centres (coordonnées du jeu) des volumes de site de bombe d'un export physique. */
export function bombCenters(doc) {
  const toWorld = invertAffine(SOURCE_TO_GLTF), out = [];
  for (const node of doc.getRoot().listNodes()) {
    if (!node.getMesh() || !/bomb_target/i.test(`${node.getName()} ${node.getMesh().getName()}`)) continue;
    const { min, max } = getBounds(node);
    out.push(apply(toWorld, [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]));
  }
  return out;
}

/** Écart à plat entre chaque site connu de Sightline et le volume exporté le plus proche ; ok si tous ≤ 300. */
export function checkAlignment(meta, centers) {
  const checks = {};
  for (const [key, rel] of [["bomb_a", meta.bomb_a], ["bomb_b", meta.bomb_b]]) {
    if (!rel || !centers.length) continue;
    const [bx, by] = bombWorld(meta, rel);
    checks[key] = Math.round(Math.min(...centers.map(([x, y]) => Math.hypot(x - bx, y - by))) * 10) / 10;
  }
  const values = Object.values(checks);
  return { checks, ok: values.length > 0 && values.every((v) => v <= MAX_SITE_ERR) };
}
