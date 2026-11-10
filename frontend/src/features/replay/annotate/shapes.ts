import type { Shape } from "../../../shared/api/types";

/** Une forme est visible tout le round, ou seulement entre from_tick et to_tick (dessin lié à un instant). */
export const visibleAt = (s: Shape, tick: number) =>
  (s.from_tick == null || tick >= s.from_tick) && (s.to_tick == null || tick <= s.to_tick);

/** Dessine les formes d'un niveau, en px radar (le contexte est déjà transformé ; k = 1 px écran). */
export function drawShapes(ctx: CanvasRenderingContext2D, shapes: Shape[], off: [number, number], k: number, tick: number, draft?: Shape | null) {
  const list = draft ? [...shapes, draft] : shapes;
  for (const s of list) {
    if (s !== draft && !visibleAt(s, tick)) continue;
    const pts = s.points.map(([x, y]) => [x + off[0], y + off[1]] as [number, number]);
    ctx.save();
    ctx.strokeStyle = ctx.fillStyle = s.color;
    ctx.lineWidth = s.width * k;
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.shadowColor = "rgba(0,0,0,.6)"; ctx.shadowBlur = 3 * k;
    const [a, b] = [pts[0], pts[pts.length - 1]];
    switch (s.tool) {
      case "pen":
        ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke(); break;
      case "line": case "arrow": {
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
        if (s.tool === "arrow") {
          const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), h = (10 + s.width * 2) * k;
          ctx.beginPath(); ctx.moveTo(b[0], b[1]);
          ctx.lineTo(b[0] - h * Math.cos(ang - 0.45), b[1] - h * Math.sin(ang - 0.45));
          ctx.lineTo(b[0] - h * Math.cos(ang + 0.45), b[1] - h * Math.sin(ang + 0.45));
          ctx.closePath(); ctx.fill();
        }
        break;
      }
      case "circle": {
        const r = Math.hypot(b[0] - a[0], b[1] - a[1]);
        ctx.beginPath(); ctx.arc(a[0], a[1], r, 0, Math.PI * 2); ctx.globalAlpha = 0.15; ctx.fill(); ctx.globalAlpha = 1; ctx.stroke(); break;
      }
      case "rect":
        ctx.globalAlpha = 0.15; ctx.fillRect(a[0], a[1], b[0] - a[0], b[1] - a[1]); ctx.globalAlpha = 1;
        ctx.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]); break;
      case "text":
        ctx.font = `700 ${(12 + s.width * 2) * k}px Inter, sans-serif`; ctx.textAlign = "left"; ctx.textBaseline = "middle";
        ctx.lineWidth = 3 * k; ctx.strokeStyle = "rgba(0,0,0,.75)"; ctx.shadowBlur = 0;
        ctx.strokeText(s.text ?? "", a[0], a[1]); ctx.fillText(s.text ?? "", a[0], a[1]); break;
    }
    ctx.restore();
  }
}

const segDist = (p: [number, number], a: [number, number], b: [number, number]) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
};

/** Forme visible la plus proche d'un point (px radar du niveau), à moins de `tol`, pour la gomme et le déplacement
 *  (`inside` : l'intérieur d'un cercle ou d'un rectangle compte aussi). */
export function hitShape(shapes: Shape[], level: string, p: [number, number], tol: number, tick: number, inside = false): string | null {
  let best: string | null = null, bestD = tol;
  for (const s of shapes) {
    if (s.level !== level || !visibleAt(s, tick)) continue;
    const a = s.points[0] as [number, number], b = s.points[s.points.length - 1] as [number, number];
    let d = Infinity;
    if (s.tool === "pen") for (let i = 1; i < s.points.length; i++) d = Math.min(d, segDist(p, s.points[i - 1] as [number, number], s.points[i] as [number, number]));
    else if (s.tool === "line" || s.tool === "arrow") d = segDist(p, a, b);
    else if (s.tool === "circle") {
      const r = Math.hypot(b[0] - a[0], b[1] - a[1]), c = Math.hypot(p[0] - a[0], p[1] - a[1]);
      d = inside && c <= r ? 0 : Math.abs(c - r);
    }
    else if (s.tool === "rect") {
      const c: [number, number][] = [a, [b[0], a[1]], b, [a[0], b[1]]];
      d = Math.min(...c.map((q, i) => segDist(p, q, c[(i + 1) % 4])));
      if (inside && p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0]) && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1])) d = 0;
    } else if (s.tool === "text") {
      const w = (s.text?.length ?? 4) * (6 + s.width);  // largeur approximative du texte (px radar)
      d = p[0] >= a[0] - 4 && p[0] <= a[0] + w && Math.abs(p[1] - a[1]) <= 10 + s.width ? 0 : Math.hypot(p[0] - a[0] - 20, p[1] - a[1]) - 20;
    }
    if (d < bestD) { bestD = d; best = s.id; }
  }
  return best;
}
