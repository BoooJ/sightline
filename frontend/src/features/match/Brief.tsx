import { Link } from "react-router-dom";
import type { MatchAnalysis, MatchDetail } from "../../shared/api/types";
import { usePlaceLabel } from "../../shared/callouts";
import { weaponLabel } from "../../shared/format";
import { useMyPlayer } from "../../shared/myPlayer";
import { Icon } from "../../shared/ui/Icon";
import { reportSummary } from "./ReportPage";
import { roundClockAt } from "./WinProbChart";

/** « En bref » de l'aperçu : points clés du match et, pour le joueur suivi, ses 3 morts les plus coûteuses. */
export function Brief({ m, a }: { m: MatchDetail; a: MatchAnalysis }) {
  const place = usePlaceLabel(m.map_name);
  const me = useMyPlayer();
  const mine = me ? a.players.find((p) => p.steamid === me) : undefined;
  const worst = mine ? a.deaths.filter((d) => d.victim === me).sort((x, y) => y.cost - x.cost).slice(0, 3) : [];
  const rounds = new Map(a.rounds.map((r) => [r.number, r]));
  return (
    <section className="panel section brief" data-testid="brief">
      <div>
        <h2 className="section-title">En bref</h2>
        <ul className="brief-points">{reportSummary(m, a, place).slice(0, 4).map((t, i) => <li key={i}>{t}</li>)}</ul>
      </div>
      {mine && (
        <div data-testid="brief-mine">
          <h2 className="section-title">Tes morts les plus coûteuses · {mine.name}</h2>
          {worst.length === 0 ? <p className="st-legend">Aucune mort sur ce match.</p> : (
            <ul className="an-deaths">
              {worst.map((d) => (
                <li key={`${d.round}-${d.tick}`} className={d.avoidable ? "avoidable" : ""}>
                  <span className="an-round mono">R{d.round} · {rounds.get(d.round) ? roundClockAt(rounds.get(d.round)!, d.tick, a.tickrate) : ""}</span>
                  <span className="an-desc">par {d.attacker_name || "?"} · {weaponLabel(d.weapon)}{place(d.place, d.pos) ? ` · ${place(d.place, d.pos)}` : ""}
                    <span className="an-tags">{d.reasons.slice(0, 3).map((r) => <span key={r} className="kf-tag">{a.reasons[r]}</span>)}</span></span>
                  <span className="mono neg">−{Math.round(d.cost * 100)} %</span>
                  <Link className="btn btn-sm btn-ghost" to={`/matches/${m.id}/replay/${d.round}?t=${Math.max(0, d.tick - 3 * a.tickrate)}`} aria-label="Voir dans le replay"><Icon name="play" /></Link>
                </li>
              ))}
            </ul>
          )}
          <Link className="btn btn-sm brief-all" to={`/matches/${m.id}?tab=analysis&player=${me}`}>Toutes mes morts ({mine.deaths}, dont {mine.avoidable} évitables)</Link>
        </div>
      )}
    </section>
  );
}
