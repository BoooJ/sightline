import type { RoundInfo, Side } from "../../shared/api/types";

/** Filtre des rounds à superposer, du point de vue d'une équipe : son camp, son achat, le résultat du round pour elle. */
export interface LayerFilter { team: number; side: "same" | "any"; buy: string | null; result: "any" | "won" | "lost" }

export const BUY_LAYERS: [string, string][] = [["pistol", "Pistol"], ["eco", "Eco (low)"], ["semi", "Semi (mid)"], ["force", "Force"], ["full", "Full"]];

export const sideOf = (r: RoundInfo, team: number): Side => (r.ct_team_id === team ? "CT" : "T");
export const buyOf = (r: RoundInfo, team: number): string => (r.ct_team_id === team ? r.ct_buy_type : r.t_buy_type);

/** Rounds (hors round courant) qui correspondent au filtre. */
export function matchingRounds(rounds: RoundInfo[], current: RoundInfo | undefined, f: LayerFilter): RoundInfo[] {
  const side = current ? sideOf(current, f.team) : null;
  return rounds.filter((r) => r.number !== current?.number
    && (f.side === "any" || side === null || sideOf(r, f.team) === side)
    && (f.buy === null || buyOf(r, f.team) === f.buy)
    && (f.result === "any" || (r.winner_team_id === f.team) === (f.result === "won")));
}
