import { Circle, G, Line, Polygon, Polyline, Rect, Text as SvgText } from "react-native-svg";

import type { MapMeta, Shape, Strat, Vec3 } from "@/api/types";
import { t } from "@/i18n/fr";
import { worldToRadar } from "@/lib/radar";
import { arrowHead, crowded, grenadesOn, positionsOn, shapesOn, stratPoints } from "@/lib/strats";
import { cropAround, Radar } from "@/ui/Radar";
import { color, font, NADE_COLOR } from "@/ui/theme";

const pts = (list: [number, number][]) => list.map((q) => q.join(",")).join(" ");

/** Carte d'une stratégie, comme StratMap du site : dessins, grenades (trajectoire, impact), joueurs numérotés.
 *  Cadrée sur son contenu ; tailles en points d'écran (`u`) pour rester lisible à tout zoom. Lecture seule. */
export function StratRadar({ strat, meta, level, uri, size }: { strat: Strat; meta: MapMeta; level: string; uri: string; size: number }) {
  const crop = cropAround(stratPoints(strat, meta), 0.35, 0.08);
  const side = strat.side === "CT" ? color.ct : color.t;
  const P = (v: Vec3) => worldToRadar(meta, v[0], v[1]);
  const players = positionsOn(strat, meta, level);
  return (
    <Radar uri={uri} size={size} crop={crop}
      label={t.strats.radarLabel(strat.name, strat.positions.length, strat.grenades.length)}>
      {(u) => {
        // noms qui se chevaucheraient (joueurs à moins de 40 points d'écran) : numéro seul, la liste donne le nom
        const packed = crowded(players.map(({ item }) => P(item.pos)), 40 * u);
        return (
          <G>
            {grenadesOn(strat, meta, level).map(({ item: g, n }) => {
              const c = NADE_COLOR[g.type] ?? color.text;
              const traj = g.trajectory.length ? g.trajectory : [g.throw, g.land].filter((v): v is Vec3 => !!v);
              const land = g.land ? P(g.land) : null;
              const from = g.throw ? P(g.throw) : null;
              return (
                <G key={`g${n}`}>
                  {traj.length > 1 ? (
                    <Polyline points={pts(traj.map(P))} fill="none" stroke={c} strokeWidth={1.5 * u} strokeDasharray={`${4 * u} ${3 * u}`} opacity={0.8} />
                  ) : null}
                  {from ? <Circle cx={from[0]} cy={from[1]} r={3.5 * u} fill={c} stroke={color.bg} strokeWidth={u} /> : null}
                  {land ? (
                    <G>
                      <Circle cx={land[0]} cy={land[1]} r={(g.type === "smoke" ? 14 : 9) * u} fill={c} fillOpacity={0.25} stroke={c} strokeWidth={1.5 * u} />
                      <MapText x={land[0]} y={land[1] + 3.6 * u} size={10 * u}>{String(n)}</MapText>
                    </G>
                  ) : null}
                </G>
              );
            })}
            {shapesOn(strat, meta, level).map((s) => <ShapeMark key={s.id} s={s} u={u} />)}
            {players.map(({ item: p, n }, i) => {
              const [x, y] = P(p.pos);
              const yaw = (p.yaw * Math.PI) / 180;
              return (
                <G key={`p${n}`}>
                  <Line x1={x} y1={y} x2={x + Math.cos(-yaw) * 17 * u} y2={y + Math.sin(-yaw) * 17 * u} stroke={side} strokeWidth={2 * u} strokeLinecap="round" />
                  <Circle cx={x} cy={y} r={9 * u} fill={side} stroke={color.bg} strokeWidth={1.5 * u} />
                  <SvgText x={x} y={y + 3.6 * u} textAnchor="middle" fontSize={10 * u} fontFamily={font.monoBold} fill={color.bg}>{String(n)}</SvgText>
                  {p.name && !packed[i] ? <MapText x={x} y={y + 21 * u} size={10 * u}>{p.name}</MapText> : null}
                </G>
              );
            })}
          </G>
        );
      }}
    </Radar>
  );
}

/** Texte sur la carte, détouré de la couleur du fond pour rester lisible sur le radar. */
function MapText({ x, y, size, children }: { x: number; y: number; size: number; children: string }) {
  return (
    <G>
      <SvgText x={x} y={y} textAnchor="middle" fontSize={size} fontWeight="700" fontFamily={font.body} fill={color.bg} stroke={color.bg}
        strokeWidth={size * 0.3} strokeLinejoin="round">{children}</SvgText>
      <SvgText x={x} y={y} textAnchor="middle" fontSize={size} fontWeight="700" fontFamily={font.body} fill={color.text}>{children}</SvgText>
    </G>
  );
}

/** Un dessin du site (coordonnées radar 0–1024) : trait, flèche, cercle, rectangle, texte. */
function ShapeMark({ s, u }: { s: Shape; u: number }) {
  const a = s.points[0];
  const b = s.points[s.points.length - 1];
  if (!a || !b) return null;
  const w = s.width * 0.75 * u;
  if (s.tool === "circle") {
    return <Circle cx={a[0]} cy={a[1]} r={Math.hypot(b[0] - a[0], b[1] - a[1])} fill={s.color} fillOpacity={0.15} stroke={s.color} strokeWidth={w} />;
  }
  if (s.tool === "rect") {
    return (
      <Rect x={Math.min(a[0], b[0])} y={Math.min(a[1], b[1])} width={Math.abs(b[0] - a[0])} height={Math.abs(b[1] - a[1])}
        fill={s.color} fillOpacity={0.15} stroke={s.color} strokeWidth={w} />
    );
  }
  if (s.tool === "text") {
    return <SvgText x={a[0]} y={a[1]} fontSize={(10 + s.width) * u} fontWeight="700" fontFamily={font.body} fill={s.color}>{s.text ?? ""}</SvgText>;
  }
  return (
    <G>
      <Polyline points={pts(s.tool === "pen" ? s.points : [a, b])} fill="none" stroke={s.color} strokeWidth={w}
        strokeLinecap="round" strokeLinejoin="round" />
      {s.tool === "arrow" ? <Polygon points={pts(arrowHead(a, b, Math.max(8 * u, w * 3)))} fill={s.color} /> : null}
    </G>
  );
}
