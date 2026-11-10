import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ScopeKind } from "./cameras";
import { SCOPE_R, ScopeOverlay } from "./ScopeOverlay";

const html = (kind: ScopeKind) => renderToStaticMarkup(createElement(ScopeOverlay, { kind }));

/** Les déclarations `style` de la première balise portant cette classe, sous forme de table propriété → valeur. */
function styleOf(h: string, cls: string): Record<string, string> {
  const m = h.match(new RegExp(`<div class="${cls}"[^>]* style="([^"]*)"`));
  if (!m) throw new Error(`pas de <div class="${cls}" style> dans ${h}`);
  return Object.fromEntries(m[1].split(";").filter(Boolean).map((d) => {
    const i = d.indexOf(":");
    return [d.slice(0, i), d.slice(i + 1)];
  }));
}
const count = (h: string, cls: string) => h.split(`class="${cls}"`).length - 1;
/** `k` fois vmin (1 vmin entier = `--r3-vmin`), comme le calque l'écrit. */
const vmin = (k: number, px = 0) => `calc(var(--r3-vmin) * ${k}${px ? ` + ${px}px` : ""})`;

describe("lunette (dimensions relevées, en fractions de vmin, vmin = min(largeur, hauteur) de la fenêtre)", () => {
  it("disque transparent de rayon 0,34 vmin ; tout l'extérieur noir à 98,4 %, bord adouci d'un pixel", () => {
    expect(SCOPE_R).toBe(0.34);
    const h = html("sniper");
    expect(h).toContain('data-testid="scope"');
    const s = styleOf(h, "r3-scope-lens");
    expect(s.background).toBe(
      `radial-gradient(circle at 50% 50%, transparent ${vmin(0.34)}, rgb(0 0 0 / 0.984) ${vmin(0.34, 1)})`);
  });

  it("l'unité vmin est celle de la fenêtre, sans jamais dépasser ce que la vue peut afficher", () => {
    const v = styleOf(html("sniper"), "r3-scope-lens")["--r3-vmin"];
    // le disque (diamètre 0,68 vmin) tient dans la vue : 0,68 × unité ≤ min(largeur, hauteur) de la vue (100 cqmin)
    expect(v).toBe("min(100vmin, 100cqmin / 0.68)");
  });

  it("anneau de diamètre 0,68 vmin : bordure noire de 2 px à 95 %, liseré intérieur blanc de 1 px à 10 %", () => {
    const s = styleOf(html("sniper"), "r3-scope-ring");
    expect(s.width).toBe(vmin(0.68));
    expect(s.height).toBe(vmin(0.68));
    expect(s["border-radius"]).toBe("50%");
    expect(s.border).toBe("2px solid rgb(0 0 0 / 0.95)");
    expect(s["box-shadow"]).toBe("inset 0 0 0 1px rgb(255 255 255 / 0.1)");
  });

  it("deux lignes noires de 1 px à 90 %, qui se croisent au centre et s'arrêtent au bord du disque (0,68 vmin)", () => {
    const h = html("sniper");
    expect(count(h, "r3-scope-line h")).toBe(1);
    expect(count(h, "r3-scope-line v")).toBe(1);
    const hl = styleOf(h, "r3-scope-line h"), vl = styleOf(h, "r3-scope-line v");
    expect(hl.width).toBe(vmin(0.68));
    expect(hl.height).toBe("1px");
    expect(vl.width).toBe("1px");
    expect(vl.height).toBe(vmin(0.68));
    expect(hl.background).toBe("rgb(0 0 0 / 0.9)");
    expect(vl.background).toBe("rgb(0 0 0 / 0.9)");
  });

  it("flou de lentille de 2,5 px dans la couronne intérieure 0,30 → 0,34 vmin (montée à 0,325, plein jusqu'au bord du disque)", () => {
    const s = styleOf(html("sniper"), "r3-scope-blur");
    expect(s["backdrop-filter"]).toBe("blur(2.5px)");
    expect(s["-webkit-backdrop-filter"]).toBe("blur(2.5px)");
    // le masque s'arrête net au bord du disque (0,34) : rien ne se floute sur le noir de l'extérieur, qui, lui, est à 0 dans le
    // relevé (un masque qui descendait jusqu'à 0,355 laissait un halo clair de 4 à 6 px autour de l'anneau)
    const mask = `radial-gradient(circle at 50% 50%, transparent ${vmin(0.3)}, #000 ${vmin(0.325)}, #000 ${vmin(0.34)}, transparent ${vmin(0.34)})`;
    expect(s["mask-image"]).toBe(mask);
    expect(s["-webkit-mask-image"]).toBe(mask);
  });

  it("la boîte du flou est le carré du disque, ni plus : jamais de flou au-delà de l'anneau (0,68 vmin)", () => {
    const h = html("sniper"), s = styleOf(h, "r3-scope-blur"), ring = styleOf(h, "r3-scope-ring");
    expect(s.width).toBe(vmin(0.68));   // pas toute la vue (moins de pixels à flouter à chaque image), ni 0,71 (débordait du disque)
    expect(s.height).toBe(vmin(0.68));
    expect(s.width).toBe(ring.width);
    expect(s.height).toBe(ring.height);
  });

  it("le même dessin pour les snipers et pour l'AUG / SG 553 (seul data-kind change)", () => {
    const sniper = html("sniper"), sight = html("sight");
    expect(sniper).toContain('data-kind="sniper"');
    expect(sight).toContain('data-kind="sight"');
    expect(sight.replace('data-kind="sight"', 'data-kind="sniper"')).toBe(sniper);
    // ni point rouge, ni viseur : ni <circle>, ni <svg>
    expect(sight).not.toMatch(/<svg|<circle|ff3030/);
  });

  it("ne prend aucun clic ; le calque est le conteneur dont la taille borne l'unité", () => {
    const s = styleOf(html("sniper"), "r3-scope");
    expect(s["pointer-events"]).toBe("none");
    // `cqmin` (unité de la vue) se lit sur le plus proche ancêtre `container-type: size` : le calque lui-même
    expect(s["container-type"]).toBe("size");
  });
});
