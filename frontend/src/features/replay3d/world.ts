import type { Vec3 } from "../../shared/api/types";

/** Matrices 4×4 rangées ligne par ligne (ordre de `Matrix4.set`), transformations affines seulement. */
export function apply(m: number[], [x, y, z]: Vec3): Vec3 {
  return [m[0] * x + m[1] * y + m[2] * z + m[3], m[4] * x + m[5] * y + m[6] * z + m[7], m[8] * x + m[9] * y + m[10] * z + m[11]];
}

/** Inverse d'une matrice affine (rotation, échelle, translation). */
export function invertAffine(m: number[]): number[] {
  const [a, b, c, , d, e, f, , g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) throw new Error("Matrice de la carte 3D non inversible");
  const r = [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ];
  const [tx, ty, tz] = [m[3], m[7], m[11]];
  return [
    r[0], r[1], r[2], -(r[0] * tx + r[1] * ty + r[2] * tz),
    r[3], r[4], r[5], -(r[3] * tx + r[4] * ty + r[5] * tz),
    r[6], r[7], r[8], -(r[6] * tx + r[7] * ty + r[8] * tz),
    0, 0, 0, 1,
  ];
}

/** Boîte englobant des positions, élargie de `margin` ; null s'il n'y en a pas. */
export function extent(points: Vec3[], margin: Vec3): { min: Vec3; max: Vec3 } | null {
  if (!points.length) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
  return { min: [min[0] - margin[0], min[1] - margin[1], min[2] - margin[2]], max: [max[0] + margin[0], max[1] + margin[1], max[2] + margin[2]] };
}

/** Yeux au-dessus des pieds (unités du jeu) : debout et accroupi. Valeurs usuelles de CS2, introuvables dans les fichiers
 *  du jeu (`m_vecViewOffset` est transmis par le serveur) : à confirmer à l'essai réel (capture de CS2). */
export const EYE_STAND = 64, EYE_DUCK = 46;
export const EYE_Z = EYE_STAND;  // trait du regard et halo des joueurs (vus de l'extérieur)
/** Hauteur des yeux selon l'accroupissement (`duck` : 0 debout … 1 accroupi). */
export const eyeZ = (duck: number) => EYE_STAND + (EYE_DUCK - EYE_STAND) * duck;
export const BODY_H = 72, BODY_R = 16;  // silhouette : 32 × 72, comme la boîte d'un joueur

/** Direction du regard : angle horizontal en degrés, 0° = +X, 90° = +Y (comme dans CS2). */
export const yawDir = (yawDeg: number): Vec3 => {
  const a = (yawDeg * Math.PI) / 180;
  return [Math.cos(a), Math.sin(a), 0];
};
