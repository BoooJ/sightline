import { usePrefetch } from "../../shared/api/prefetch";
import { Link } from "react-router-dom";
import type { MatchSummary } from "../../shared/api/types";
import { formatDate, formatDuration } from "../../shared/format";

/** Ligne de match de la bibliothèque. En mode sélection (`selecting`), un clic sur la ligne coche ou décoche au lieu d'ouvrir le
 *  match : on ne perd plus sa sélection en cliquant à côté de la case. */
export function MatchRow({ m, selecting, onToggle }: { m: MatchSummary; selecting?: boolean; onToggle?: (shift: boolean) => void }) {
  const prefetch = usePrefetch();
  const aWins = m.score_a > m.score_b;
  return (
    <Link to={`/matches/${m.id}`} className="match-row" data-testid="match-row" onPointerEnter={() => prefetch.match(m.id)} onFocus={() => prefetch.match(m.id)}
      onClick={(e) => { if (selecting && onToggle) { e.preventDefault(); onToggle(e.shiftKey); } }}
      aria-label={selecting ? `${m.team_a.name} contre ${m.team_b.name} (cocher ou décocher)` : undefined}>
      <span className="match-mapcell">
        <img className="match-thumb" src={`/maps/${m.map_name}.png`} alt="" loading="lazy" />
        <span className="match-map">{m.map_display_name}</span>
      </span>
      <span className="match-teams">
        <span className={`match-team ${aWins ? "win" : "lose"}`}>{m.team_a.name}</span>
        <span className="match-score mono">
          <b className={aWins ? "win" : "lose"}>{m.score_a}</b>
          <i>:</i>
          <b className={aWins ? "lose" : "win"}>{m.score_b}</b>
        </span>
        <span className={`match-team ${aWins ? "lose" : "win"}`}>{m.team_b.name}</span>
      </span>
      <span className="match-meta mono">{m.rounds_count}</span>
      <span className="match-meta mono">{formatDuration(m.duration_s)}</span>
      <span className="match-meta">
        {formatDate(m.date ?? m.imported_at)}
        {(m.labels?.folder || m.labels?.event || !!m.labels?.tags.length) && (
          <span className="match-labels">
            {m.labels?.folder && <span className="mlab folder">{m.labels.folder}</span>}
            {m.labels?.event && <span className="mlab event">{m.labels.event}</span>}
            {m.labels?.tags.map((t) => <span key={t} className="mlab">#{t}</span>)}
          </span>
        )}
      </span>
    </Link>
  );
}
