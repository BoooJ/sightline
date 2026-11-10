/** Réticule du joueur suivi : code de partage de CS2 (« CS… » ou « CSGO-… »),
 *  anciens codes de CS:GO, réticule fixe sans code, formes en pixels. Décodage des codes actuels relu dans client.dll
 *  (build 2000935) ; anciens codes : disposition publique du code de réticule de CS:GO. Aucune image ni aucun fichier de
 *  Valve. */
import type { PlayerState } from "../replay/engine/state";
import { isSniper } from "../replay/hud";
import type { ScopeKind } from "./cameras";

export type Rgba = [number, number, number, number];

/** Code « pixel » (« CS… » et « CSGO-… » de version 3 ou plus) : les tailles valent pour un écran de `screenHeight` px. */
export interface PixelCrosshair {
  kind: "pixel";
  style: number;         // cl_crosshairstyle, 0 à 9
  length: number;        // cl_crosshair_length : longueur d'une branche, en pixels sur un écran de `screenHeight` px
  gap: number;           // cl_crosshair_gap : écart entre le centre et les branches
  thickness: number;     // cl_crosshair_thickness
  dot: boolean;          // cl_crosshairdot
  tStyle: boolean;       // cl_crosshair_t : pas de branche du haut
  outline: number;       // cl_crosshair_drawoutline : 0 aucun, 1 complet, 2 moitié
  color: Rgba;           // cl_crosshaircolor_r/g/b/a
  outlineColor: Rgba;    // cl_crosshairoutline_r/g/b/a
  screenHeight: number;  // cl_crosshair_screen_height : hauteur d'écran où les tailles ont été réglées
}

/** Ancien code de CS:GO (« CSGO-… » de version 1 ou 2) : tailles pour un écran de 480 px de haut, écart compté à partir de
 *  4 px (puis 1 px de plus avant les branches, voir `CLASSIC_CENTER`), toujours statique (le style du code est ignoré). */
export interface ClassicCrosshair {
  kind: "classic";
  size: number;          // longueur d'une branche, en pixels sur un écran de 480 px
  thickness: number;     // épaisseur, idem
  gap: number;           // écart (signé), ajouté à 4 px ; pas mis à l'échelle
  dot: boolean;
  tStyle: boolean;       // pas de branche du haut
  outline: number;       // épaisseur du contour en pixels, pas mise à l'échelle ; 0 : pas de contour
  color: Rgba;           // trait tel que dessiné : couleur prédéfinie ou celle du code ; opacité 200 sans « use alpha »
}

/** Pas de code (ou code illisible) : le réticule fixe, sans échelle (voir `FIXED_SHAPE`). */
export interface FixedCrosshair { kind: "fixed" }

export type Crosshair = PixelCrosshair | ClassicCrosshair | FixedCrosshair;

export const FIXED_CROSSHAIR: FixedCrosshair = { kind: "fixed" };

/** Valeurs par défaut des convars, lues dans client.dll (build 2000935). Plus affichées sans code (c'est `FIXED_CROSSHAIR`) ;
 *  gardées comme référence du décodage et des tests. */
export const DEFAULT_CROSSHAIR: PixelCrosshair = {
  kind: "pixel", style: 7, length: 8, gap: 4, thickness: 2, dot: false, tStyle: false, outline: 1,
  color: [0, 255, 0, 255], outlineColor: [0, 0, 0, 255], screenHeight: 1080,
};

const ALPHABET = "ABCDEFGHJKLMNOPQRSTUVWXYZabcdefhijkmnopqrstuvwxyz23456789";

/** Caractères en base 57, le dernier de poids fort → `size` octets gros-boutistes (octet 0 = poids fort). null :
 *  caractère hors de l'alphabet ou nombre trop grand. */
function toBytes(chars: string, size: number): Uint8Array | null {
  let n = 0n;
  for (let i = chars.length - 1; i >= 0; i--) {
    const k = ALPHABET.indexOf(chars[i]);
    if (k < 0) return null;
    n = n * 57n + BigInt(k);
  }
  if (n >> BigInt(8 * size)) return null;
  const out = new Uint8Array(size);
  for (let i = size - 1; i >= 0; i--) { out[i] = Number(n & 0xffn); n >>= 8n; }
  return out;
}

/** Somme de contrôle : octets `from` à `to` compris, modulo 256. */
function checksum(b: Uint8Array, from: number, to: number): number {
  let s = 0;
  for (let i = from; i <= to; i++) s += b[i];
  return s & 0xff;
}
const u16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const int8 = (v: number) => (v << 24) >> 24;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Bornes que le jeu applique après le décodage. */
const bounded = (c: PixelCrosshair): PixelCrosshair => ({ ...c, style: Math.min(9, c.style), thickness: Math.min(32, c.thickness),
  outline: Math.min(2, c.outline), gap: clamp(c.gap, -3840, 3840), screenHeight: Math.max(240, c.screenHeight) });

/** Format actuel : « CS » + 44 caractères = 32 octets ; octet 1 = 1, hauteur ≠ 0, octet 0 = somme des octets 1 à 31. */
function decodeNew(chars: string): PixelCrosshair | null {
  const b = toBytes(chars, 32);
  if (!b || b[1] !== 1 || u16(b, 2) === 0 || b[0] !== checksum(b, 1, 31)) return null;
  return bounded({
    kind: "pixel", style: b[4] & 0x1f, dot: (b[4] & 0x40) !== 0, tStyle: (b[4] & 0x80) !== 0,
    color: [b[5], b[6], b[7], b[8]], outlineColor: [b[9], b[10], b[11], b[12]],
    thickness: b[13] & 0x3f, outline: b[13] >> 6, gap: (u16(b, 14) << 16) >> 16, length: b[16], screenHeight: u16(b, 2),
  });
}

/** Version 3 ou plus de l'ancien format : modèle « pixel ». Contour : bit 5 de l'octet 2 en version 3, bits 28-29 du mot
 *  des octets 10 à 13 ensuite. */
function pixelFromOld(b: Uint8Array): PixelCrosshair {
  let d = (b[10] | (b[11] << 8) | (b[12] << 16) | (b[13] << 24)) >>> 0;
  if (b[1] === 3) d = ((d & 0xcfffffff) | ((b[2] & 0x20) << 23)) >>> 0;
  return bounded({
    kind: "pixel", style: b[2] & 0x0f, dot: (b[2] & 0x40) !== 0, tStyle: (b[2] & 0x80) !== 0,
    color: [b[3], b[4], b[5], b[6]], outlineColor: [0, 0, 0, b[6]],
    gap: b[7], length: b[8], thickness: (d >>> 23) & 0x1f, outline: (d >>> 28) & 3, screenHeight: u16(b, 14),
  });
}

/** Couleurs prédéfinies 0 à 4 des anciens codes ; 5 : celle du code ; au-delà : vert. */
const CLASSIC_PRESETS: [number, number, number][] = [[250, 50, 50], [50, 250, 50], [250, 250, 50], [50, 50, 250], [50, 250, 250]];
const CLASSIC_GREEN: [number, number, number] = [50, 250, 50];
/** Opacité des anciens codes sans « use alpha ». */
const CLASSIC_ALPHA = 200;

/** Version 1 ou 2 de l'ancien format (disposition publique de CS:GO, 18 octets) : octet 2 = écart (signé) / 10 ; octet 3 =
 *  épaisseur du contour / 2 ; octets 4 à 7 = R, V, B, opacité ; octet 10 : bits 0-2 = couleur prédéfinie, bit 3 = contour ;
 *  octet 12 = épaisseur / 10 ; octet 13 : bit 4 = point, bit 6 = « use alpha », bit 7 = en T (bits 1-3 : style, ignoré) ;
 *  octets 14-15 : taille / 10 sur 13 bits. */
function classicFrom(b: Uint8Array): ClassicCrosshair {
  const preset = b[10] & 7;
  const [r, g, bl] = preset === 5 ? [b[4], b[5], b[6]] : CLASSIC_PRESETS[preset] ?? CLASSIC_GREEN;
  return {
    kind: "classic", size: (((b[15] & 31) << 8) + b[14]) / 10, thickness: b[12] / 10, gap: int8(b[2]) / 10,
    dot: (b[13] & 0x10) !== 0, tStyle: (b[13] & 0x80) !== 0, outline: (b[10] & 8) !== 0 ? b[3] / 2 : 0,
    color: [r, g, bl, (b[13] & 0x40) !== 0 ? b[7] : CLASSIC_ALPHA],
  };
}

/** Ancien format « CSGO-xxxxx-…-xxxxx » : 25 caractères = 18 octets ; octet 0 = somme des octets 1 à 15 (les octets 16 et 17
 *  sont nuls dans tous les vrais codes vus : 1 à 17 donnerait la même somme). Version (octet 1) ≥ 3 : modèle « pixel » ;
 *  1 et 2 (démos de 2026) : modèle « classique ». */
function decodeOld(chars: string): PixelCrosshair | ClassicCrosshair | null {
  const b = toBytes(chars, 18);
  if (!b || b[0] !== checksum(b, 1, 15)) return null;
  return b[1] < 3 ? classicFrom(b) : pixelFromOld(b);
}

/** Réticule d'un code de partage. null : code illisible (le réticule fixe s'affiche alors). */
export function decodeCrosshair(code: string): PixelCrosshair | ClassicCrosshair | null {
  const s = code.trim();
  if (s.length === 46 && s.startsWith("CS")) return decodeNew(s.slice(2));
  const old = /^CSGO((?:-[A-Za-z0-9]{5}){5})$/.exec(s);
  return old ? decodeOld(old[1].replaceAll("-", "")) : null;
}

export type XhairShape = { kind: "rect"; x: number; y: number; w: number; h: number } | { kind: "ring"; r: number; w: number };

const CROSS = new Set([0, 2, 4, 5, 7, 9]), CIRCLE = new Set([1, 3]);

/** Réticule fixe (sans code) : branches de 8 × 2 px à 4 px du centre, vert rgb(61, 245, 61), contour de 1 px
 *  rgba(0, 0, 0, 0,55), sans point, sans échelle. */
const FIXED_SHAPE = { length: 8, thickness: 2, gap: 4 };
const FIXED_COLORS = { fill: "rgb(61,245,61)", outline: "rgba(0,0,0,0.55)" };
/** Anciens codes : tailles pour un écran de 480 px de haut ; l'écart est compté à partir de 4 px, puis les branches
 *  partent 1 px plus loin (`CLASSIC_CENTER`, ajouté APRÈS la troncature : relevé à l'écran, pour des écarts entiers
 *  comme −4 et non entiers comme −4,5). */
const CLASSIC_SCREEN = 480, CLASSIC_GAP_BASE = 4, CLASSIC_CENTER = 1;

/** Arrondi au pair sur ,5 (4,5 → 4, 5,5 → 6), relevé à l'écran. */
const roundEven = (x: number) => { const r = Math.round(x); return (Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r) + 0; };
/** `v` pixels réglés pour un écran de `ref` px de haut, sur un écran de `h` px de haut. */
const scaled = (v: number, h: number, ref: number) => roundEven((v * h) / ref);

const rect = (x: number, y: number, w: number, h: number): XhairShape => ({ kind: "rect", x, y, w, h });
/** Les branches : gauche, droite, haut (sauf en T), bas ; `len` > 0. */
const bars = (len: number, t: number, gap: number, tStyle: boolean): XhairShape[] => {
  const h = t / 2;
  return [rect(-gap - len, -h, len, t), rect(gap, -h, len, t), ...(tStyle ? [] : [rect(-h, -gap - len, t, len)]),
    rect(-h, gap, t, len)];
};
const dotOf = (t: number) => rect(-t / 2, -t / 2, t, t);

/** Formes du réticule en pixels CSS ; centre en (0, 0), y vers le bas. `windowHeight` : hauteur de la FENÊTRE (et non de la
 *  vue 3D).
 *  - fixe (sans code) : toujours les mêmes, sans échelle ;
 *  - classique : k = H / 480 ; longueur et épaisseur (au moins 1 px) = taille · k arrondie au pair ; les branches partent à
 *    tronc(4 + écart) + 1 px du centre, sans échelle (NertZ : 4 carrés de 2 × 2 px autour d'un trou de 2 × 2 px) ; le point
 *    reste au centre ; le style du code est ignoré (toujours statique) ;
 *  - « pixel » : tout, écart compris (pas d'écart de base), suit H / hauteur du réglage. Styles dynamiques dessinés au repos
 *    (l'imprécision de l'arme n'est pas dans les démos). « Quad » (7, 9) : quatre branches comme la croix (dessin exact
 *    inconnu) ; cercle (1, 3) de rayon l'écart ; carré (8) de demi-côté l'écart ; point seul (6). */
export function crosshairShapes(c: Crosshair, windowHeight: number): XhairShape[] {
  if (c.kind === "fixed") return bars(FIXED_SHAPE.length, FIXED_SHAPE.thickness, FIXED_SHAPE.gap, false);
  if (c.kind === "classic") {
    const t = Math.max(1, scaled(c.thickness, windowHeight, CLASSIC_SCREEN)), len = scaled(c.size, windowHeight, CLASSIC_SCREEN);
    const gap = Math.trunc(CLASSIC_GAP_BASE + c.gap) + CLASSIC_CENTER;
    return [...(len > 0 ? bars(len, t, gap, c.tStyle) : []), ...(c.dot ? [dotOf(t)] : [])];
  }
  const t = Math.max(1, scaled(c.thickness, windowHeight, c.screenHeight)), len = scaled(c.length, windowHeight, c.screenHeight);
  const gap = scaled(c.gap, windowHeight, c.screenHeight), out: XhairShape[] = [];
  if (CROSS.has(c.style) && len > 0) {
    out.push(...bars(len, t, gap, c.tStyle));
  } else if (CIRCLE.has(c.style)) {
    out.push({ kind: "ring", r: Math.max(1, gap) + t / 2, w: t });
  } else if (c.style === 8) {
    const g = Math.max(1, gap);
    out.push(rect(-g - t, -g - t, 2 * (g + t), t),   // haut
      rect(-g - t, g, 2 * (g + t), t),               // bas
      rect(-g - t, -g, t, 2 * g),                    // gauche
      rect(g, -g, t, 2 * g));                        // droite
  }
  if (c.dot || c.style === 6) out.push(dotOf(t));
  return out;
}

/** Couleur CSS d'une couleur du jeu (opacité 0 à 255). */
export const rgba = ([r, g, b, a]: Rgba) => `rgba(${r},${g},${b},${+(a / 255).toFixed(3)})`;

/** Couleurs CSS du trait et de son contour. Ancien code : le contour est noir, de l'opacité du trait. */
export function crosshairColors(c: Crosshair): { fill: string; outline: string } {
  if (c.kind === "fixed") return FIXED_COLORS;
  if (c.kind === "classic") return { fill: rgba(c.color), outline: rgba([0, 0, 0, c.color[3]]) };
  return { fill: rgba(c.color), outline: rgba(c.outlineColor) };
}

/** Épaisseur du contour en pixels (jamais mise à l'échelle) : « pixel » : 1 (complet), 0,5 (« moitié » : dessin exact
 *  inconnu), 0 (aucun) ; ancien code : celle du code si son bit « contour » est mis ; fixe : 1. */
export const outlineWidth = (c: Crosshair) =>
  c.kind === "fixed" ? 1 : c.kind === "classic" ? c.outline : c.outline === 1 ? 1 : c.outline === 2 ? 0.5 : 0;

/** Réticule à dessiner : pas si le joueur est mort, ni sous une lunette (elle a ses propres repères), ni avec un sniper
 *  (`isSniper`, les quatre) même sans lunette ; oui avec le couteau, les grenades, le C4 (3.9a) et les
 *  pistolets. */
export const crosshairShown = (p: Pick<PlayerState, "alive" | "weapon">, scope: ScopeKind | null) =>
  p.alive && scope === null && !isSniper(p.weapon);
