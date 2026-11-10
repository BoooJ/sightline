import { useState } from "react";
import type { AnalysisRound, WinEvent } from "../../shared/api/types";
import { weaponLabel } from "../../shared/format";
import type { PlaceLabel } from "../../shared/callouts";

const pct = (p: number) => `${Math.round(p * 100)} %`;

/** Libellé d'un événement de round (kill, pose, désamorçage) pour les infobulles et listes. */
export function eventLabel(e: WinEvent, names: Record<string, string>, place?: PlaceLabel): string {
  const n = (s: string | null) => (s ? names[s] ?? s : "?");
  if (e.type === "plant") return `${n(e.player)} pose la bombe`;
  if (e.type === "defuse") return `${n(e.player)} désamorce`;
  if (e.type === "explode") return "La bombe explose";
  const where = place ? place(e.place, e.pos) : e.place;
  return `${e.player ? n(e.player) : "Le monde"} élimine ${n(e.victim)}${e.weapon ? ` · ${weaponLabel(e.weapon)}` : ""}${where ? ` · ${where}` : ""}`;
}

/** Horloge du round pour un tick : temps restant, ou minuteur de la bombe (« C4 0:32 ») une fois posée. */
export function roundClockAt(r: Pick<AnalysisRound, "freeze_end_tick" | "events">, tick: number, tickrate: number): string {
  const plant = r.events.find((e) => e.type === "plant" && e.tick <= tick);
  const left = plant ? Math.max(0, Math.round(40 - (tick - plant.tick) / tickrate)) : Math.max(0, Math.round(115 - (tick - r.freeze_end_tick) / tickrate));
  return `${plant ? "C4 " : ""}${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}

/** Courbe de probabilité de victoire CT d'un round (en escalier), zones colorées par camp favori, points sur les kills.
 *  `compact` : bande fine sous la frise du replay, sans axes. */
export function WinProbChart({ round, tickrate, names, compact, tick, onSeek, place, range }: {
  round: AnalysisRound; tickrate: number; names: Record<string, string>; compact?: boolean; tick?: number;
  onSeek?: (t: number) => void; place?: PlaceLabel;
  /** intervalle de ticks affiché (par défaut : de la fin du freeze à la fin du round) */
  range?: [number, number];
}) {
  const [hover, setHover] = useState<WinEvent | null>(null);
  const W = 1000, H = compact ? 36 : 180, padL = compact ? 0 : 36, padR = compact ? 0 : 8, padT = compact ? 2 : 10, padB = compact ? 2 : 22;
  const t0 = range?.[0] ?? round.freeze_end_tick, t1 = Math.max(t0 + 1, range?.[1] ?? round.end_tick);
  const x = (t: number) => padL + ((Math.min(t1, Math.max(t0, t)) - t0) / (t1 - t0)) * (W - padL - padR);
  const y = (p: number) => padT + (1 - p) * (H - padT - padB);
  // escalier : la probabilité ne change qu'aux événements
  const pts: [number, number][] = [];
  round.curve.forEach(([t, p], i) => {
    if (i > 0) pts.push([x(t), pts[pts.length - 1][1]]);
    pts.push([x(t), y(p)]);
  });
  const line = pts.map((p) => p.join(",")).join(" ");
  const mid = y(0.5);
  const area = `${pts[0][0]},${mid} ${line} ${pts[pts.length - 1][0]},${mid}`;
  const last = round.curve[round.curve.length - 1]?.[1] ?? 0.5;
  return (
    <div className={`wp ${compact ? "wp-compact" : ""}`} data-testid={compact ? "winprob-band" : "winprob-chart"}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
        aria-label={`Probabilité de victoire CT au fil du round ${round.number} : ${pct(last)} à la fin`}>
        <defs>
          <clipPath id={`wp-ct-${round.number}-${compact ? 1 : 0}`}><rect x={0} y={0} width={W} height={mid} /></clipPath>
          <clipPath id={`wp-t-${round.number}-${compact ? 1 : 0}`}><rect x={0} y={mid} width={W} height={H - mid} /></clipPath>
        </defs>
        {!compact && [0, 0.25, 0.5, 0.75, 1].map((p) => (
          <g key={p}>
            <line x1={padL} x2={W - padR} y1={y(p)} y2={y(p)} className={p === 0.5 ? "wp-mid" : "wp-grid"} />
            <text x={padL - 6} y={y(p) + 4} textAnchor="end" className="wp-axis">{Math.round(p * 100)}</text>
          </g>
        ))}
        {compact && <line x1={0} x2={W} y1={mid} y2={mid} className="wp-mid" />}
        <polygon points={area} className="wp-area-ct" clipPath={`url(#wp-ct-${round.number}-${compact ? 1 : 0})`} />
        <polygon points={area} className="wp-area-t" clipPath={`url(#wp-t-${round.number}-${compact ? 1 : 0})`} />
        <polyline points={line} className="wp-line" vectorEffect="non-scaling-stroke" />
        {tick !== undefined && <line x1={x(tick)} x2={x(tick)} y1={0} y2={H} className="wp-now" vectorEffect="non-scaling-stroke" />}
      </svg>
      {/* points d'événements en HTML : cercles non déformés par l'étirement du SVG */}
      {round.events.filter((e) => e.type !== "explode").map((e, i) => (
        <button key={i} type="button" className={`wp-dot ${e.side === "CT" ? "ct" : "t"} ${e.type !== "kill" ? "wp-bomb" : ""}`}
          style={{ left: `${(x(e.tick) / W) * 100}%`, top: `${(y(e.p_after) / H) * 100}%` }}
          onMouseEnter={() => setHover(e)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(e)} onBlur={() => setHover(null)}
          onClick={() => onSeek?.(e.tick - 2 * tickrate)}
          aria-label={`${roundClockAt(round, e.tick, tickrate)} ${eventLabel(e, names, place)} (${e.swing >= 0 ? "+" : ""}${Math.round(e.swing * 100)} %)`} />
      ))}
      {hover && (
        <div className="wp-tip" style={{ left: `${(x(hover.tick) / W) * 100}%` }} role="tooltip">
          <span className="mono">{roundClockAt(round, hover.tick, tickrate)}</span> {eventLabel(hover, names, place)}
          <b className={hover.side === "CT" ? "wp-ct" : "wp-t"}> {hover.swing >= 0 ? "+" : ""}{Math.round(hover.swing * 100)} % {hover.side}</b>
          <span className="wp-tip-p">CT {pct(hover.p_before)} → {pct(hover.p_after)}</span>
        </div>
      )}
    </div>
  );
}

/** Probabilité de victoire CT à un instant du round (dernier point de la courbe atteint). */
export function probAt(round: AnalysisRound, tick: number): number {
  let p = round.curve[0]?.[1] ?? 0.5;
  for (const [t, v] of round.curve) { if (t > tick) break; p = v; }
  return p;
}
