import { useState } from "react";
import type { MatchDetail } from "../../shared/api/types";
import { BUY_LABEL, formatMoney } from "../../shared/format";

// couleurs d'équipe (tokens --team-a vert / --team-b gris clair), les mêmes que sur les barres de comparaison et le veto
const COLORS = ["var(--team-a)", "var(--team-b)"];

/** Valeur d'équipement des deux équipes, round par round (comme le graphique d'économie de PRACC). */
export function EconomyChart({ m }: { m: MatchDetail }) {
  const [hover, setHover] = useState<number | null>(null);
  const teams = [m.team_a, m.team_b];
  const series = teams.map((t) => m.rounds.map((r) => (r.ct_team_id === t.id ? r.ct_equip_value : r.t_equip_value)));
  const buys = teams.map((t) => m.rounds.map((r) => (r.ct_team_id === t.id ? r.ct_buy_type : r.t_buy_type)));
  const W = 900, H = 220, pad = { l: 52, r: 70, t: 12, b: 26 };
  const n = m.rounds.length;
  const max = Math.max(5000, ...series.flat()) * 1.08;
  const x = (i: number) => pad.l + (n <= 1 ? 0 : (i * (W - pad.l - pad.r)) / (n - 1));
  const y = (v: number) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
  const ticks = [0, 10000, 20000, 30000].filter((v) => v <= max);
  const halves = m.rounds.map((r, i) => (r.number === 12 || (r.number > 24 && (r.number - 24) % 3 === 0) ? i : -1)).filter((i) => i >= 0 && i < n - 1);
  const h = hover;
  return (
    <div className="eco" data-testid="economy-chart">
      <div className="eco-legend">
        {teams.map((t, k) => <span key={t.id}><i style={{ background: COLORS[k] }} />{t.name}</span>)}
      </div>
      <div className="eco-plot">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Valeur d'équipement par round" onMouseLeave={() => setHover(null)}>
          {ticks.map((v) => (
            <g key={v}>
              <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className="eco-grid" />
              <text x={pad.l - 8} y={y(v)} textAnchor="end" dominantBaseline="middle" className="eco-axis">{v ? `${v / 1000}k` : "0"}</text>
            </g>
          ))}
          {halves.map((i) => <line key={i} x1={(x(i) + x(i + 1)) / 2} x2={(x(i) + x(i + 1)) / 2} y1={pad.t} y2={H - pad.b} className="eco-half" />)}
          {m.rounds.map((r, i) => (i % 2 === 0 || n < 16) && <text key={r.id} x={x(i)} y={H - 8} textAnchor="middle" className="eco-axis">{r.number}</text>)}
          {series.map((s, k) => (
            <g key={k}>
              <polyline points={s.map((v, i) => `${x(i)},${y(v)}`).join(" ")} fill="none" stroke={COLORS[k]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {s.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r={hover === i ? 5 : 3.5} fill={COLORS[k]} stroke="var(--bg-1)" strokeWidth={2} />)}
              <text x={W - pad.r + 8} y={y(s[n - 1] ?? 0) + (k ? 8 : -6)} className="eco-label" dominantBaseline="middle">{teams[k].name}</text>
            </g>
          ))}
          {m.rounds.map((r, i) => (
            <rect key={r.id} x={x(i) - (W - pad.l - pad.r) / Math.max(1, n - 1) / 2} y={pad.t} width={(W - pad.l - pad.r) / Math.max(1, n - 1)}
              height={H - pad.t - pad.b} fill="transparent" onMouseEnter={() => setHover(i)} />
          ))}
          {h != null && <line x1={x(h)} x2={x(h)} y1={pad.t} y2={H - pad.b} className="eco-cross" />}
        </svg>
        {h != null && (
          <div className="eco-tip" style={{ left: `${(100 * x(h)) / W}%` }}>
            <b>Round {m.rounds[h].number}</b>
            {teams.map((t, k) => (
              <span key={t.id}><i style={{ background: COLORS[k] }} />{t.name} <b className="mono">{formatMoney(series[k][h])}</b> <small>{BUY_LABEL[buys[k][h]] ?? buys[k][h]}</small></span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
