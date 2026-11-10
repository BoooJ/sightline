/** Valeur de référence (« Comp. ») et écart, comme sur EDGE : « Comp. 1,23 · 4 % de plus ». */
export type Tone = "pos" | "neg" | "flat";
export interface Delta { pct: number; tone: Tone; label: string }

export const MIN_ROUNDS = 20;  // en dessous, la référence est affichée en gris : trop peu de rounds pour conclure

export function compDelta(value: number, base: number, lowIsBest = false): Delta {
  if (!Number.isFinite(value) || !Number.isFinite(base) || base === 0) return { pct: 0, tone: "flat", label: "—" };
  const pct = Math.round((100 * (value - base)) / Math.abs(base));
  if (Math.abs(pct) < 1) return { pct: 0, tone: "flat", label: "égal" };
  const better = lowIsBest ? pct < 0 : pct > 0;
  return { pct, tone: better ? "pos" : "neg", label: `${Math.abs(pct)} % de ${pct > 0 ? "plus" : "moins"}` };
}

export function Comp({ value, base, rounds, fmt = (v) => v.toFixed(2), lowIsBest, compact }:
  { value: number; base: number | undefined; rounds?: number; fmt?: (v: number) => string; lowIsBest?: boolean; compact?: boolean }) {
  if (base === undefined || !Number.isFinite(base)) return null;
  const d = compDelta(value, base, lowIsBest);
  const weak = (rounds ?? MIN_ROUNDS) < MIN_ROUNDS;
  return (
    <span className={`comp ${weak ? "weak" : d.tone}`} title={weak ? `Référence sur ${rounds} rounds seulement` : undefined}>
      <span className="comp-base">Comp. <b className="mono">{fmt(base)}</b></span>
      {!compact && <span className="comp-delta">{d.tone === "flat" ? "" : d.pct > 0 ? "▲ " : "▼ "}{d.label}</span>}
    </span>
  );
}
