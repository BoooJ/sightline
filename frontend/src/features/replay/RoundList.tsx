import { Link } from "react-router-dom";
import type { MatchDetail } from "../../shared/api/types";
import { END_REASON_LABEL } from "../../shared/format";

const isHalfBreak = (n: number) => n === 12 || (n > 24 && (n - 24) % 3 === 0);

/** Bande horizontale des rounds : une case par round, couleur du side gagnant, round courant en surbrillance. */
export function RoundList({ match, current, annotated = [] }: { match: MatchDetail; current: number; annotated?: number[] }) {
  return (
    <nav className="round-list" aria-label="Rounds">
      {match.rounds.map((r) => (
        <Link key={r.id} to={`/matches/${match.id}/replay/${r.number}`}
          className={`rl-cell ${r.winner_side === "CT" ? "ct" : r.winner_side === "T" ? "t" : ""} ${r.number === current ? "on" : ""} ${isHalfBreak(r.number) ? "rl-break" : ""}`}
          title={`Round ${r.number} — ${r.score_a_after}-${r.score_b_after} · ${END_REASON_LABEL[r.end_reason ?? ""] ?? r.end_reason ?? ""}`}>
          <span className="mono">{r.number}</span>
          {annotated.includes(r.number) && <i className="rl-note" aria-label="Round annoté" />}
        </Link>
      ))}
    </nav>
  );
}
