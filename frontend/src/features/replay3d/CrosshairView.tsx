import { useMemo } from "react";
import {
  type Crosshair, crosshairColors, crosshairShapes, decodeCrosshair, FIXED_CROSSHAIR, outlineWidth, type XhairShape,
} from "./crosshair";

/** Une forme, élargie de `o` px de chaque côté (le contour est dessiné dessous, à cette taille). */
function draw(s: XhairShape, o: number, color: string, key: string) {
  return s.kind === "rect"
    ? <rect key={key} x={s.x - o} y={s.y - o} width={s.w + 2 * o} height={s.h + 2 * o} fill={color} />
    : <circle key={key} r={s.r} fill="none" stroke={color} strokeWidth={s.w + 2 * o} />;
}

/** Distance du centre au point le plus éloigné des formes. */
const reach = (shapes: XhairShape[]) => Math.max(1, ...shapes.map((s) => (s.kind === "rect"
  ? Math.max(Math.abs(s.x), Math.abs(s.y), Math.abs(s.x + s.w), Math.abs(s.y + s.h)) : s.r + s.w / 2)));

/** Réticule du joueur suivi, au centre de la vue 3D (SVG) : son code s'il est lisible (ancien ou actuel),
 *  sinon le réticule fixe. `windowHeight` : hauteur de la fenêtre en pixels CSS (pas celle de la vue 3D : c'est elle qui
 *  règle la taille) ; 0 (pas encore mesurée) : rien. */
export function CrosshairView({ code, windowHeight }: { code: string | null; windowHeight: number }) {
  const c = useMemo<Crosshair>(() => (code && decodeCrosshair(code)) || FIXED_CROSSHAIR, [code]);
  if (windowHeight <= 0) return null;
  const shapes = crosshairShapes(c, windowHeight), o = outlineWidth(c), { fill, outline } = crosshairColors(c);
  const half = Math.ceil(reach(shapes) + o) + 1, size = 2 * half;
  return (
    <svg className="r3-xhair" data-testid="crosshair" data-kind={c.kind} data-style={c.kind === "pixel" ? c.style : undefined}
      width={size} height={size} viewBox={`${-half} ${-half} ${size} ${size}`} shapeRendering="crispEdges" aria-hidden="true">
      {o > 0 && shapes.map((s, i) => draw(s, o, outline, `o${i}`))}
      {shapes.map((s, i) => draw(s, 0, fill, `c${i}`))}
    </svg>
  );
}
