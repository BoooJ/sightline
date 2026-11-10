import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CrosshairView } from "./CrosshairView";

// `windowHeight` : hauteur de la fenêtre (renommé en 3.9a : c'est elle, et non la vue 3D, qui règle la taille)
const html = (code: string | null, windowHeight = 1080) => renderToStaticMarkup(createElement(CrosshairView, { code, windowHeight }));

describe("réticule à l'écran", () => {
  it("sans code, ou code illisible : réticule fixe, vert, contour noir dessous", () => {
    const h = html(null);
    expect(h).toContain('data-testid="crosshair"');
    expect(h).toContain('data-kind="fixed"');
    expect(h.match(/<rect /g)).toHaveLength(8);  // 4 branches et leurs 4 contours
    expect(h.indexOf('fill="rgba(0,0,0,0.55)"')).toBeLessThan(h.indexOf('fill="rgb(61,245,61)"'));
    expect(html("CSGO-y9Qw8-sCzPb-jORFu-ov6L8-GwMXM")).toBe(h);  // somme de contrôle fausse
    expect(html("n'importe quoi")).toBe(h);
  });
  it("code du joueur : son style et sa couleur", () => {
    const h = html("CSohmNeMMuTzAfiY9uKnjsqpQBsvmeqAhKuCwMQP3NR7qi", 1440);
    expect(h).toContain('data-kind="pixel"');
    expect(h).toContain('data-style="4"');
    expect(h).toContain('fill="rgba(255,0,255,0.784)"');
    expect(h.match(/<rect /g)).toHaveLength(8);  // en T avec point : 3 branches + point, et leurs contours
  });
  it("ancien code (démos de 2026) : lu comme un code classique, à l'échelle H / 480, sans contour", () => {
    // taille 2, épaisseur 0,5, écart −3,7 : à H = 768, longueur 3, épaisseur 1, écart tronc(0,3) + 1 = 1
    const h = html("CSGO-7qiux-EiAUN-f2ezV-bwbyK-mypxA", 768);
    expect(h).toContain('data-kind="classic"');
    expect(h).toContain('fill="rgba(0,255,0,1)"');
    expect(h.match(/<rect /g)).toHaveLength(4);
    expect(h).toContain('x="-4" y="-0.5" width="3" height="1"');
  });
  it("taille : sans échelle sans code ; selon la hauteur de la fenêtre avec un code", () => {
    expect(html(null, 1080)).toContain('width="28"');
    expect(html(null, 2160)).toContain('width="28"');
    expect(html("CSohmNeMMuTzAfiY9uKnjsqpQBsvmeqAhKuCwMQP3NR7qi", 1440)).not.toBe(html("CSohmNeMMuTzAfiY9uKnjsqpQBsvmeqAhKuCwMQP3NR7qi", 2880));
  });
  it("fenêtre pas encore mesurée : rien", () => {
    expect(html(null, 0)).toBe("");
  });
});
