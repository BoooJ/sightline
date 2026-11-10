/** Rendu des heatmaps : grille de cases → canvas radar 1024 px (flou gaussien puis palette). */
export const SIZE = 1024;

// palette « chaleur » : transparent → bleu → vert → jaune → rouge
const STOPS: [number, [number, number, number]][] = [[0, [30, 60, 200]], [0.35, [40, 200, 160]], [0.6, [230, 230, 60]], [0.8, [255, 140, 30]], [1, [255, 40, 40]]];
const LUT = (() => {
  const out = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const k = STOPS.findIndex(([s]) => s >= t);
    const [s1, c1] = STOPS[Math.max(0, k - 1)], [s2, c2] = STOPS[Math.max(0, k)];
    const f = s2 === s1 ? 0 : (t - s1) / (s2 - s1);
    for (let c = 0; c < 3; c++) out[i * 3 + c] = c1[c] + (c2[c] - c1[c]) * f;
  }
  return out;
})();

/** Grille de cases → une image de GRID px (1 px par case), agrandie à 1024 px avec un seul flou :
 *  un flou par case serait des centaines de fois plus lent (rendu logiciel sans GPU). */
function blurred(cells: number[][], bin: number, value: (c: number[]) => number, blur: number): ImageData {
  const grid = Math.round(SIZE / bin);
  const small = document.createElement("canvas");
  small.width = small.height = grid;
  const sctx = small.getContext("2d")!;
  const img = sctx.createImageData(grid, grid);
  for (const c of cells) {
    const v = value(c);
    if (v <= 0 || c[0] >= grid || c[1] >= grid) continue;
    const i = (c[1] * grid + c[0]) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
    img.data[i + 3] = Math.min(255, Math.round(v * 255));
  }
  sctx.putImageData(img, 0, 0);
  const cv = document.createElement("canvas");
  cv.width = cv.height = SIZE;
  const ctx = cv.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.filter = `blur(${blur}px)`;
  ctx.drawImage(small, 0, 0, SIZE, SIZE);
  return ctx.getImageData(0, 0, SIZE, SIZE);
}

/** Intensité normalisée par la case la plus haute (avec un gamma pour faire ressortir les zones peu fréquentées). */
export function drawHeat(ctx: CanvasRenderingContext2D, cells: number[][], bin: number, gamma: number, opacity: number) {
  const max = Math.max(1, ...cells.map((c) => c[2]));
  const img = blurred(cells, bin, (c) => Math.pow(c[2] / max, gamma), bin * 1.4);
  const d = img.data;
  let peak = 1;
  for (let i = 3; i < d.length; i += 4) peak = Math.max(peak, d[i]);
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (!a) continue;
    const k = Math.min(255, Math.round((a / peak) * 255));
    d[i] = LUT[k * 3]; d[i + 1] = LUT[k * 3 + 1]; d[i + 2] = LUT[k * 3 + 2];
    d[i + 3] = Math.min(255, k * 1.6) * opacity;
  }
  ctx.putImageData(img, 0, 0);
}

/** Zones de contrôle : teinte selon la part CT/T de chaque case, opacité selon la fréquentation. */
export function drawControl(ctx: CanvasRenderingContext2D, cells: number[][], bin: number, gamma: number, opacity: number,
  ct: [number, number, number], t: [number, number, number]) {
  const max = Math.max(1, ...cells.map((c) => c[2] + c[3]));
  const w = (c: number[]) => Math.pow((c[2] + c[3]) / max, gamma);
  const total = blurred(cells, bin, w, bin * 1.2);
  const ctOnly = blurred(cells, bin, (c) => w(c) * (c[2] / Math.max(1, c[2] + c[3])), bin * 1.2);
  const out = ctx.createImageData(SIZE, SIZE);
  let peak = 1;
  for (let i = 3; i < total.data.length; i += 4) peak = Math.max(peak, total.data[i]);
  for (let i = 0; i < out.data.length; i += 4) {
    const a = total.data[i + 3];
    if (!a) continue;
    const share = ctOnly.data[i + 3] / a; // part CT (0..1)
    for (let c = 0; c < 3; c++) out.data[i + c] = t[c] + (ct[c] - t[c]) * share;
    out.data[i + 3] = Math.min(255, (a / peak) * 255 * 1.5) * opacity * (0.35 + 0.65 * Math.abs(share - 0.5) * 2);
  }
  ctx.putImageData(out, 0, 0);
}

export const hexToRgb = (hex: string): [number, number, number] => {
  const h = hex.trim().replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
};
