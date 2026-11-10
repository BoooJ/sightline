import type { AnalysisDeath, MatchAnalysis } from "@/api/types";

import { REASON_LABEL } from "./labels";

/** Les morts du joueur qui ont coûté le plus de chances de gagner le round (comme « Revoir mes morts » du site). */
export function costliestDeaths(a: MatchAnalysis, steamid: string, n = 3): AnalysisDeath[] {
  return a.deaths.filter((d) => d.victim === steamid).sort((x, y) => y.cost - x.cost).slice(0, n);
}

export function reasonsOf(d: AnalysisDeath): string[] {
  return d.reasons.map((r) => REASON_LABEL[r] ?? r);
}
