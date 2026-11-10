import { describe, expect, it } from "vitest";
import {
  crosshairColors, crosshairShapes, crosshairShown, DEFAULT_CROSSHAIR, decodeCrosshair, FIXED_CROSSHAIR, outlineWidth, rgba,
  type ClassicCrosshair, type Rgba,
} from "./crosshair";

// Codes réels : celui que client.dll (build 2000935) affiche par défaut, et cinq codes de joueurs lus dans la colonne
// crosshair_code de deux démos de février 2026 (15 codes distincts, tous de version 1 : les anciens codes, avant la
// tâche 3.9a refusés, aujourd'hui lus). Codes « CS… » : fabriqués avec l'encodeur de référence (même
// disposition que client.dll) : valeurs par défaut ; style 4, point, en T, écart −2, couleurs et contour choisis, réglé
// à 1440 px.
const GAME_DEFAULT = "CSGO-y9Qw8-sCzPb-jORFu-ov6L8-GwMXL";
const REAL_2026 = {
  custom: "CSGO-7qiux-EiAUN-f2ezV-bwbyK-mypxA",    // couleur du code (vert), écart −3,7, taille 2, épaisseur 0,5
  outlined: "CSGO-DpxfH-VubCF-J3iQP-vLkxv-jfA6Q",  // contour de 1 px, cyan du code, écart −5, taille 1
  alpha200: "CSGO-T27Z6-ChTNW-6S4pV-3JpvF-WHFFN",  // blanc d'opacité 200, contour de 1 px, écart −2, taille 0,3
  yellow: "CSGO-pfudY-OGVdJ-4BSat-pBaEU-znjPK",    // couleur prédéfinie 2 (jaune), opacité 200, écart −3, taille 2
  gapHalf: "CSGO-zKfC4-mDqcY-uo3hd-fV5v8-6wxsP",   // prédéfinie 1 (vert), écart −4,5 (4 − 4,5 → −0), taille 1,1
};
const NEW_DEFAULTS = "CSpb9t3x5NtrX5fWaENsr8vusEtwpiURjzqauLkOiYHMqF";
const NEW_CUSTOM = "CSohmNeMMuTzAfiY9uKnjsqpQBsvmeqAhKuCwMQP3NR7qi";

// Encodeur de test d'un ancien code (disposition publique de CS:GO : 18 octets, somme des octets 1 à 15 dans l'octet 0,
// nombre en base 57 écrit en commençant par le chiffre de poids faible, cinq groupes de cinq caractères).
const ALPHABET = "ABCDEFGHJKLMNOPQRSTUVWXYZabcdefhijkmnopqrstuvwxyz23456789";
function oldCode(bytes: number[]): string {
  const b = [...bytes];
  b[0] = b.slice(1, 16).reduce((s, v) => s + v, 0) & 0xff;
  let n = b.reduce((acc, v) => (acc << 8n) | BigInt(v), 0n), chars = "";
  for (let i = 0; i < 25; i++) { chars += ALPHABET[Number(n % 57n)]; n /= 57n; }
  return `CSGO-${chars.match(/.{5}/g)!.join("-")}`;
}
interface Fields {
  version?: number; gap?: number; outline?: number; rgba?: [number, number, number, number]; preset?: number;
  outlineOn?: boolean; thickness?: number; style?: number; dot?: boolean; useAlpha?: boolean; t?: boolean; size?: number;
}
/** Un ancien code à partir de valeurs lisibles : écart, épaisseur et taille en dixièmes (comme le jeu), contour en demis. */
function classicCode(f: Fields = {}): string {
  const b = new Array<number>(18).fill(0);
  b[1] = f.version ?? 1;
  b[2] = (f.gap ?? 0) & 0xff;
  b[3] = f.outline ?? 0;
  [b[4], b[5], b[6], b[7]] = f.rgba ?? [0, 255, 0, 255];
  b[10] = (f.preset ?? 5) | (f.outlineOn ? 8 : 0);
  b[12] = f.thickness ?? 10;
  b[13] = ((f.style ?? 4) << 1) | (f.dot ? 0x10 : 0) | (f.useAlpha ? 0x40 : 0) | (f.t ? 0x80 : 0);
  b[14] = (f.size ?? 20) & 0xff;
  b[15] = (f.size ?? 20) >> 8;
  return oldCode(b);
}
const classic = (f?: Fields) => decodeCrosshair(classicCode(f))!;

describe("code de réticule", () => {
  it("ancien format de version 3 : le code par défaut du jeu (style 7, vert, réglé à 1440 px)", () => {
    // mis à jour (3.9a) : le décodeur dit maintenant de quel modèle est le code (`kind`)
    expect(decodeCrosshair(GAME_DEFAULT)).toEqual({ kind: "pixel", style: 7, length: 11, gap: 5, thickness: 3, dot: false,
      tStyle: false, outline: 0, color: [0, 255, 0, 255], outlineColor: [0, 0, 0, 255], screenHeight: 1440 });
  });
  it("format actuel : les valeurs par défaut du jeu", () => {
    expect(decodeCrosshair(NEW_DEFAULTS)).toEqual(DEFAULT_CROSSHAIR);
  });
  it("format actuel : écart négatif, point, en T, couleurs et contour du joueur", () => {
    expect(decodeCrosshair(NEW_CUSTOM)).toEqual({ kind: "pixel", style: 4, length: 3, gap: -2, thickness: 1, dot: true,
      tStyle: true, outline: 2, color: [255, 0, 255, 200], outlineColor: [10, 20, 30, 128], screenHeight: 1440 });
  });
  it("format actuel : valeurs bornées comme dans le jeu (style 12, épaisseur 40, écart −4000, hauteur 100)", () => {
    expect(decodeCrosshair("CScLjubtQWwP8thuBcShKTPkDidWCTX9X47KmHUfKbeFhF"))
      .toMatchObject({ style: 9, thickness: 32, gap: -3840, screenHeight: 240 });
  });
  it("refusés : version ≠ 1, hauteur nulle, somme fausse, caractère hors alphabet, nombre trop grand, autre forme", () => {
    expect(decodeCrosshair("CSNPCCER9B2XwQaPGKJW7Z7MPWC5PTWS6hMDGmOkCrAFzi")).toBeNull();  // octet 1 = 2
    expect(decodeCrosshair("CSHC9wOAiBO9ZxvNQ2qjGBRHvitNzNmC8JrrcankhixvOK")).toBeNull();  // hauteur 0
    expect(decodeCrosshair("CSGO-y9Qw8-sCzPb-jORFu-ov6L8-GwMXM")).toBeNull();  // dernier caractère changé
    expect(decodeCrosshair("CSGO-y9Qw8-sCzPb-jORFu-ov6L8-GwMXl")).toBeNull();  // « l » n'est pas dans l'alphabet
    expect(decodeCrosshair(`CS${"9".repeat(44)}`)).toBeNull();                  // plus de 32 octets
    expect(decodeCrosshair(NEW_DEFAULTS.slice(0, 45))).toBeNull();
    expect(decodeCrosshair("CSGO-y9Qw8")).toBeNull();
    expect(decodeCrosshair("")).toBeNull();
  });
  it("espaces autour du code : ignorés", () => {
    expect(decodeCrosshair(` ${GAME_DEFAULT}\n`)?.kind).toBe("pixel");
  });
});

describe("ancien code « classique » (version < 3), disposition publique de CS:GO", () => {
  const real = (c: string, f: Partial<ClassicCrosshair>) => expect(decodeCrosshair(c)).toEqual({ kind: "classic",
    size: 1, thickness: 0.5, gap: 0, dot: false, tStyle: false, outline: 0, color: [0, 255, 0, 255], ...f });
  it("vrais codes de démos de 2026 (version 1, octet 1 = 1) : valeurs décodées", () => {
    // octets 2 = 219 (écart −3,7), 12 = 5 (épaisseur 0,5), 14-15 = 20 (taille 2), couleur du code (0, 255, 0), « use alpha »
    real(REAL_2026.custom, { size: 2, gap: -3.7 });
    // octet 10 = 5 + 8 : couleur du code (0, 255, 255) et contour, de l'épaisseur de l'octet 3 (2) / 2 = 1 px
    real(REAL_2026.outlined, { gap: -5, outline: 1, color: [0, 255, 255, 255] });
    real(REAL_2026.alpha200, { size: 0.3, gap: -2, outline: 1, color: [255, 255, 255, 200] });
    // octet 10 = 2 : jaune prédéfini (la couleur du code, 255, 255, 0, est ignorée), opacité 200 du code (use alpha)
    real(REAL_2026.yellow, { size: 2, thickness: 1, gap: -3, color: [250, 250, 50, 200] });
    // octet 10 = 1 : vert prédéfini ; le bit contour est éteint : pas de contour, malgré l'épaisseur de l'octet 3
    real(REAL_2026.gapHalf, { size: 1.1, thickness: 1, gap: -4.5, color: [50, 250, 50, 255] });
  });
  it("l'encodeur de test redonne exactement un vrai code", () => {
    expect(oldCode([0, 1, 219, 2, 0, 255, 0, 255, 3, 30, 5, 170, 5, 72, 20, 0, 0, 0])).toBe(REAL_2026.custom);
  });
  it("écart signé en dixièmes, épaisseur de contour en demis, point, T, taille sur 13 bits", () => {
    expect(classic({ gap: -40, size: 5, thickness: 10 })).toMatchObject({ gap: -4, size: 0.5, thickness: 1 });
    expect(classic({ gap: 25 })).toMatchObject({ gap: 2.5 });
    expect(classic({ size: 0x1fff })).toMatchObject({ size: 819.1 });  // (31 << 8) + 255 = 8191 dixièmes
    expect(classic({ dot: true, t: true })).toMatchObject({ dot: true, tStyle: true });
    expect(classic({ dot: false, t: false })).toMatchObject({ dot: false, tStyle: false });
    expect(classic({ outlineOn: true, outline: 3 })).toMatchObject({ outline: 1.5 });
    expect(classic({ outlineOn: false, outline: 3 })).toMatchObject({ outline: 0 });
  });
  it("style ignoré : toujours le même réticule statique", () => {
    for (let style = 0; style < 8; style++) expect(classic({ style })).toEqual(classic({ style: 4 }));
  });
  it("couleurs prédéfinies 0 à 4, 5 = celle du code, 6 et 7 = vert ; opacité 200/255 sans « use alpha »", () => {
    const color = (f: Fields) => (classic({ rgba: [9, 8, 7, 77], ...f }) as { color: number[] }).color;
    expect([0, 1, 2, 3, 4].map((preset) => color({ preset, useAlpha: true }).slice(0, 3))).toEqual(
      [[250, 50, 50], [50, 250, 50], [250, 250, 50], [50, 50, 250], [50, 250, 250]]);
    expect(color({ preset: 5, useAlpha: true })).toEqual([9, 8, 7, 77]);
    expect(color({ preset: 6, useAlpha: true })).toEqual([50, 250, 50, 77]);
    expect(color({ preset: 7, useAlpha: true })).toEqual([50, 250, 50, 77]);
    expect(color({ preset: 5, useAlpha: false })).toEqual([9, 8, 7, 200]);
    expect(rgba(color({ preset: 1, useAlpha: false }) as Rgba)).toBe("rgba(50,250,50,0.784)");
  });
  it("somme de contrôle fausse : refusé ; version 2 : classique ; version 3 : modèle « pixel » (inchangé)", () => {
    const bad = REAL_2026.custom.slice(0, -1) + "B";
    expect(decodeCrosshair(bad)).toBeNull();
    expect(decodeCrosshair(classicCode({ version: 2 }))).toMatchObject({ kind: "classic" });
    expect(decodeCrosshair(classicCode({ version: 3 }))).toMatchObject({ kind: "pixel" });
  });
});

describe("dessin d'un ancien code (hauteur de la fenêtre H, k = H / 480)", () => {
  // code relevé à l'écran : taille 1, épaisseur 1, écart −4 ; fenêtre de 768 px de haut → quatre carrés 2 × 2 px autour d'un
  // trou de 2 × 2 px (6 × 6 px au total) : les branches commencent à tronc(4 + écart) + 1 px du centre
  const NERTZ = { size: 10, thickness: 10, gap: -40, preset: 1 };
  it("taille 1, épaisseur 1, écart −4 à H = 768 : quatre carrés de 2 × 2 px autour d'un trou de 2 × 2 px, sans contour", () => {
    const c = classic(NERTZ);
    expect(crosshairShapes(c, 768)).toEqual([
      { kind: "rect", x: -3, y: -1, w: 2, h: 2 }, { kind: "rect", x: 1, y: -1, w: 2, h: 2 },
      { kind: "rect", x: -1, y: -3, w: 2, h: 2 }, { kind: "rect", x: -1, y: 1, w: 2, h: 2 }]);
    expect(outlineWidth(c)).toBe(0);
    expect(crosshairColors(c).fill).toBe("rgba(50,250,50,0.784)");
  });
  it("code à point (phzy) : point de 2 × 2 px, branches de 1 px séparées du point par 1 px, 6 × 6 px au total", () => {
    // taille 0,6 (0,96 px → 1), épaisseur 1 (1,6 → 2), écart −3 : tronc(1) + 1 = 2 px du centre ; le point n'est pas déplacé
    expect(crosshairShapes(classic({ size: 6, thickness: 10, gap: -30, dot: true }), 768)).toEqual([
      { kind: "rect", x: -3, y: -1, w: 1, h: 2 }, { kind: "rect", x: 2, y: -1, w: 1, h: 2 },
      { kind: "rect", x: -1, y: -3, w: 2, h: 1 }, { kind: "rect", x: -1, y: 2, w: 2, h: 1 },
      { kind: "rect", x: -1, y: -1, w: 2, h: 2 }]);
  });
  it("vrais codes de 2026 dessinés : taille 2, épaisseur 0,5, écart −3,7 à H = 768 puis 1080", () => {
    const c = decodeCrosshair(REAL_2026.custom)!;
    // longueur 3,2 → 3 ; épaisseur 0,8 → 1 ; écart tronc(0,3) + 1 = 1
    expect(crosshairShapes(c, 768)).toEqual([
      { kind: "rect", x: -4, y: -0.5, w: 3, h: 1 }, { kind: "rect", x: 1, y: -0.5, w: 3, h: 1 },
      { kind: "rect", x: -0.5, y: -4, w: 1, h: 3 }, { kind: "rect", x: -0.5, y: 1, w: 1, h: 3 }]);
    // longueur 4,5 → 4 (au pair) ; épaisseur 1,125 → 1
    expect(crosshairShapes(c, 1080)).toEqual([
      { kind: "rect", x: -5, y: -0.5, w: 4, h: 1 }, { kind: "rect", x: 1, y: -0.5, w: 4, h: 1 },
      { kind: "rect", x: -0.5, y: -5, w: 1, h: 4 }, { kind: "rect", x: -0.5, y: 1, w: 1, h: 4 }]);
  });
  it("vrai code d'écart −5 : tronc(4 − 5) + 1 = 0 px, les branches partent du centre sans se recouvrir ; contour de 1 px", () => {
    const c = decodeCrosshair(REAL_2026.outlined)!;
    expect(crosshairShapes(c, 1080)).toEqual([
      { kind: "rect", x: -2, y: -0.5, w: 2, h: 1 }, { kind: "rect", x: 0, y: -0.5, w: 2, h: 1 },
      { kind: "rect", x: -0.5, y: -2, w: 1, h: 2 }, { kind: "rect", x: -0.5, y: 0, w: 1, h: 2 }]);
    expect(outlineWidth(c)).toBe(1);
    expect(crosshairColors(c)).toEqual({ fill: "rgba(0,255,255,1)", outline: "rgba(0,0,0,1)" });
  });
  it("vrai code d'écart −4,5 : 4 − 4,5 = −0,5 est tronqué à 0, puis + 1 ; opacité 200 d'un code qui l'impose", () => {
    const shapes = crosshairShapes(decodeCrosshair(REAL_2026.gapHalf)!, 1080);
    expect((shapes[1] as { x: number }).x).toBe(1);   // le +1 vient après le tronc : une base de 5 donnerait tronc(0,5) = 0
    expect(crosshairColors(decodeCrosshair(REAL_2026.yellow)!).fill).toBe("rgba(250,250,50,0.784)");
  });
  it("H = 768 : longueur et épaisseur suivent H / 480 ; l'écart (tronc(4 + valeur) + 1) ne suit pas", () => {
    // taille 5, épaisseur 2, écart +1,5 : longueur 8, épaisseur 3 (3,2), écart tronc(5,5) + 1 = 6
    expect(crosshairShapes(classic({ size: 50, thickness: 20, gap: 15 }), 768)).toEqual([
      { kind: "rect", x: -14, y: -1.5, w: 8, h: 3 }, { kind: "rect", x: 6, y: -1.5, w: 8, h: 3 },
      { kind: "rect", x: -1.5, y: -14, w: 3, h: 8 }, { kind: "rect", x: -1.5, y: 6, w: 3, h: 8 }]);
  });
  it("H = 1080 : longueur 11 (11,25), épaisseur 4 (4,5 arrondi au pair), même écart de 6 px", () => {
    expect(crosshairShapes(classic({ size: 50, thickness: 20, gap: 15 }), 1080)).toEqual([
      { kind: "rect", x: -17, y: -2, w: 11, h: 4 }, { kind: "rect", x: 6, y: -2, w: 11, h: 4 },
      { kind: "rect", x: -2, y: -17, w: 4, h: 11 }, { kind: "rect", x: -2, y: 6, w: 4, h: 11 }]);
  });
  it("arrondi au pair sur ,5 (4,5 → 4, 2,5 → 2, 3,5 → 4) et épaisseur d'au moins 1 px", () => {
    const w = (f: Fields, h: number) => (crosshairShapes(classic(f), h)[0] as { w: number }).w;
    expect(w({ size: 20 }, 1080)).toBe(4);   // 2 × 2,25 = 4,5
    expect(w({ size: 50 }, 240)).toBe(2);    // 5 × 0,5 = 2,5
    expect(w({ size: 70 }, 240)).toBe(4);    // 7 × 0,5 = 3,5
    expect((crosshairShapes(classic({ size: 30, thickness: 1 }), 480)[0] as { h: number }).h).toBe(1);  // 0,1 px → 1
  });
  it("écart = tronc(4 + valeur) + 1, sans échelle, quelle que soit la fenêtre ; négatif accepté", () => {
    const gapAt = (gap: number, h: number) => (crosshairShapes(classic({ gap, size: 10 }), h)[1] as { x: number }).x;
    for (const h of [480, 768, 1080, 1440]) expect(gapAt(-37, h)).toBe(1);  // 4 − 3,7 = 0,3 → 0, plus 1
    expect(gapAt(-45, 1080)).toBe(1);      // −0,5 → 0, plus 1 (une base de 5 donnerait 0,5 → 0 : faux)
    expect(gapAt(-35, 1080)).toBe(1);      // 0,5 → 0, plus 1
    expect(gapAt(12, 768)).toBe(6);        // 5,2 → 5, plus 1
    expect(gapAt(-80, 768)).toBe(-3);      // −4, plus 1
  });
  it("en T : pas de branche du haut ; point : carré épaisseur × épaisseur au centre", () => {
    // H = 480 : longueur 3, épaisseur 1, écart 4 + 1 ; le point reste au centre
    expect(crosshairShapes(classic({ size: 30, thickness: 10, gap: 0, t: true, dot: true }), 480)).toEqual([
      { kind: "rect", x: -8, y: -0.5, w: 3, h: 1 }, { kind: "rect", x: 5, y: -0.5, w: 3, h: 1 },
      { kind: "rect", x: -0.5, y: 5, w: 1, h: 3 }, { kind: "rect", x: -0.5, y: -0.5, w: 1, h: 1 }]);
  });
  it("contour : épaisseur du code en px, sans échelle, noir de l'opacité du trait ; seulement si le bit est mis", () => {
    const withOutline = classic({ outlineOn: true, outline: 3, rgba: [9, 8, 7, 77], useAlpha: true });
    expect(outlineWidth(withOutline)).toBe(1.5);
    expect(crosshairColors(withOutline)).toEqual({ fill: "rgba(9,8,7,0.302)", outline: "rgba(0,0,0,0.302)" });
    expect(outlineWidth(classic({ outlineOn: false, outline: 3 }))).toBe(0);
  });
  it("opacité 200/255 sans « use alpha », celle du code avec", () => {
    expect(crosshairColors(classic({ rgba: [0, 255, 0, 100], useAlpha: false })).fill).toBe("rgba(0,255,0,0.784)");
    expect(crosshairColors(classic({ rgba: [0, 255, 0, 100], useAlpha: true })).fill).toBe("rgba(0,255,0,0.392)");
  });
});

describe("dessin d'un code « pixel » (CS… ou version ≥ 3)", () => {
  it("réticule par défaut sur une fenêtre de 1080 px : quatre branches de 8 × 2 px à 4 px du centre", () => {
    expect(crosshairShapes(DEFAULT_CROSSHAIR, 1080)).toEqual([
      { kind: "rect", x: -12, y: -1, w: 8, h: 2 }, { kind: "rect", x: 4, y: -1, w: 8, h: 2 },
      { kind: "rect", x: -1, y: -12, w: 2, h: 8 }, { kind: "rect", x: -1, y: 4, w: 2, h: 8 }]);
  });
  it("tailles selon la hauteur de la fenêtre, rapportée à la hauteur du réglage", () => {
    expect(crosshairShapes(DEFAULT_CROSSHAIR, 2160)[0]).toEqual({ kind: "rect", x: -24, y: -2, w: 16, h: 4 });
    // code par défaut du jeu réglé à 1440 px (écart 5, longueur 11, épaisseur 3) : à 1080, les défauts des convars
    expect(crosshairShapes(decodeCrosshair(GAME_DEFAULT)!, 1080)).toEqual(crosshairShapes(DEFAULT_CROSSHAIR, 1080));
  });
  it("l'écart est mis à l'échelle lui aussi, sans écart de base (0 reste 0 ; 3 → 1,5 à moitié, 6 au double)", () => {
    const right = (gap: number, h: number) => (crosshairShapes({ ...DEFAULT_CROSSHAIR, gap }, h)[1] as { x: number }).x;
    expect(right(0, 1080)).toBe(0);
    expect(right(3, 2160)).toBe(6);
    expect(right(6, 540)).toBe(3);
    expect(right(-2, 2160)).toBe(-4);
  });
  it("épaisseur d'au moins 1 px ; en T : pas de branche du haut ; point au centre", () => {
    // fenêtre de 540 px : longueur 4, écart 2, épaisseur 1
    expect(crosshairShapes({ ...DEFAULT_CROSSHAIR, thickness: 0, tStyle: true, dot: true }, 540)).toEqual([
      { kind: "rect", x: -6, y: -0.5, w: 4, h: 1 }, { kind: "rect", x: 2, y: -0.5, w: 4, h: 1 },
      { kind: "rect", x: -0.5, y: 2, w: 1, h: 4 }, { kind: "rect", x: -0.5, y: -0.5, w: 1, h: 1 }]);
  });
  it("styles : croix et « Quad » (0, 2, 4, 5, 7, 9), cercle (1, 3), point seul (6), carré (8)", () => {
    const shapes = (style: number) => crosshairShapes({ ...DEFAULT_CROSSHAIR, style }, 1080);
    for (const st of [0, 2, 4, 5, 7, 9]) expect(shapes(st)).toEqual(shapes(7));
    for (const st of [1, 3]) expect(shapes(st)).toEqual([{ kind: "ring", r: 5, w: 2 }]);
    expect(shapes(6)).toEqual([{ kind: "rect", x: -1, y: -1, w: 2, h: 2 }]);
    expect(shapes(8)).toEqual([
      { kind: "rect", x: -6, y: -6, w: 12, h: 2 }, { kind: "rect", x: -6, y: 4, w: 12, h: 2 },
      { kind: "rect", x: -6, y: -4, w: 2, h: 8 }, { kind: "rect", x: 4, y: -4, w: 2, h: 8 }]);
  });
  it("couleurs du jeu en CSS ; contour complet 1 px, moitié 0,5 px", () => {
    expect(rgba([0, 255, 0, 255])).toBe("rgba(0,255,0,1)");
    expect(rgba([255, 0, 255, 200])).toBe("rgba(255,0,255,0.784)");
    expect([0, 1, 2].map((outline) => outlineWidth({ ...DEFAULT_CROSSHAIR, outline }))).toEqual([0, 1, 0.5]);
    expect(crosshairColors(DEFAULT_CROSSHAIR)).toEqual({ fill: "rgba(0,255,0,1)", outline: "rgba(0,0,0,1)" });
  });
});

describe("réticule sans code (ou code illisible)", () => {
  const FOUR = [
    { kind: "rect", x: -12, y: -1, w: 8, h: 2 }, { kind: "rect", x: 4, y: -1, w: 8, h: 2 },
    { kind: "rect", x: -1, y: -12, w: 2, h: 8 }, { kind: "rect", x: -1, y: 4, w: 2, h: 8 }];
  it("quatre branches de 8 × 2 px à 4 px du centre, sans point, sans échelle (même à 540, 1080 et 1440 px)", () => {
    for (const h of [540, 1080, 1440]) expect(crosshairShapes(FIXED_CROSSHAIR, h)).toEqual(FOUR);
  });
  it("rgb(61, 245, 61), contour de 1 px rgba(0, 0, 0, 0,55)", () => {
    expect(crosshairColors(FIXED_CROSSHAIR)).toEqual({ fill: "rgb(61,245,61)", outline: "rgba(0,0,0,0.55)" });
    expect(outlineWidth(FIXED_CROSSHAIR)).toBe(1);
  });
});

describe("réticule affiché", () => {
  const p = (weapon: string, alive = true) => ({ weapon, alive });
  it("affiché avec un fusil, un pistolet, le couteau, une grenade et le C4 (changé en 3.9a : le C4 le cachait)", () => {
    for (const w of ["AK-47", "Glock-18", "Karambit", "Flashbang", "C4 Explosive"]) expect(crosshairShown(p(w), null)).toBe(true);
  });
  it("caché avec l'AWP, le SSG 08, le SCAR-20 et le G3SG1, même sans lunette", () => {
    for (const w of ["AWP", "SSG 08", "SCAR-20", "G3SG1"]) expect(crosshairShown(p(w), null)).toBe(false);
  });
  it("caché sous une lunette (snipers, AUG, SG 553) et quand le joueur est mort", () => {
    expect(crosshairShown(p("AWP"), "sniper")).toBe(false);
    expect(crosshairShown(p("AUG"), "sight")).toBe(false);
    expect(crosshairShown(p("AK-47", false), null)).toBe(false);
    expect(crosshairShown(p("Karambit", false), null)).toBe(false);
  });
});
