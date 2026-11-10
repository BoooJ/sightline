export function sampleIndex(ticks: Int32Array, tick: number): { i: number; t: number } {
  const n = ticks.length;
  if (n === 0 || tick <= ticks[0]) return { i: 0, t: 0 };
  if (tick >= ticks[n - 1]) return { i: n - 1, t: 0 };
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ticks[mid] <= tick) lo = mid; else hi = mid; }
  return { i: lo, t: (tick - ticks[lo]) / (ticks[hi] - ticks[lo]) };
}
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export function lerpAngle(a: number, b: number, t: number): number {
  let d = ((b - a + 540) % 360) - 180;
  if (d === -180) d = 180;
  return a + d * t;
}
/** Deux demi-intervalles linéaires par l'échantillon du milieu : `a` en t = 0, `mid` en t = 0,5, `b` en t = 1. */
export const lerpMid = (a: number, mid: number, b: number, t: number) => (t < 0.5 ? lerp(a, mid, t * 2) : lerp(mid, b, t * 2 - 1));
/** Comme lerpMid pour un lacet : chaque demi-intervalle prend le plus court chemin. */
export const lerpAngleMid = (a: number, mid: number, b: number, t: number) =>
  t < 0.5 ? lerpAngle(a, mid, t * 2) : lerpAngle(mid, b, t * 2 - 1);
