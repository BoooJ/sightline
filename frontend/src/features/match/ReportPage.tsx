import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import type { MatchAnalysis, MatchDetail } from "../../shared/api/types";
import { formatDate, formatDuration, formatMoney } from "../../shared/format";
import { usePlaceLabel, type PlaceLabel } from "../../shared/callouts";
import { Button } from "../../shared/ui/Button";
import { EmptyState } from "../../shared/ui/EmptyState";
import { Icon } from "../../shared/ui/Icon";
import { Spinner } from "../../shared/ui/Spinner";
import { AnalysisPanel } from "./AnalysisPanel";
import { EconomyChart } from "./EconomyChart";
import { RoundStrip } from "./RoundStrip";
import { Scoreboard } from "./Scoreboard";
import { eventLabel } from "./WinProbChart";
import "./match.css";
import "./report.css";

/** Points clés du match, rédigés à partir de l'analyse automatique. */
export function reportSummary(m: MatchDetail, a: MatchAnalysis, place: PlaceLabel): string[] {
  const teams = [m.team_a, m.team_b];
  const winner = m.score_a > m.score_b ? m.team_a : m.team_b, loser = winner === m.team_a ? m.team_b : m.team_a;
  const out = [`${winner.name} bat ${loser.name} ${Math.max(m.score_a, m.score_b)}–${Math.min(m.score_a, m.score_b)} sur ${m.map_display_name}.`];
  const pistols = m.rounds.filter((r) => r.number === 1 || r.number === 13 && m.rounds.length > 13);
  if (pistols.length) {
    out.push(`Rounds pistol : ${pistols.map((r) => `R${r.number} pour ${teams.find((t) => t.id === r.winner_team_id)?.name ?? "?"}`).join(", ")}.`);
  }
  const best = a.players[0], worst = a.players[a.players.length - 1];
  if (best) out.push(`Joueur le plus décisif : ${best.name} (${best.impact > 0 ? "+" : ""}${best.impact.toFixed(1)} points de probabilité de victoire par round).`);
  if (worst && worst !== best && worst.impact < 0) out.push(`Impact le plus faible : ${worst.name} (${worst.impact.toFixed(1)} par round, ${worst.avoidable} mort${worst.avoidable > 1 ? "s" : ""} évitable${worst.avoidable > 1 ? "s" : ""}).`);
  const top = a.key_moments[0];
  if (top) out.push(`Tournant du match : round ${top.round}, ${eventLabel(top, a.names, place)} (+${Math.round(top.swing * 100)} % pour les ${top.side}).`);
  for (const t of teams) {
    const adv = a.advantages[String(t.id)], eco = a.economy.teams[String(t.id)];
    const lost = a.lost_advantages.filter((l) => l.team_id === t.id);
    const avoid = a.deaths.filter((d) => d.team_id === t.id && d.avoidable).length;
    const parts: string[] = [];
    if (adv?.had) parts.push(`convertit ${adv.won}/${adv.had} avantages numériques${lost.length ? ` (perdus : ${lost.map((l) => `${l.state} R${l.round}`).join(", ")})` : ""}`);
    parts.push(`${avoid} mort${avoid > 1 ? "s" : ""} évitable${avoid > 1 ? "s" : ""}`);
    if (eco) parts.push(`${formatMoney(eco.unused_utility)} de grenades non utilisées`);
    if (eco?.force) parts.push(`forces gagnés ${eco.force_won}/${eco.force}`);
    out.push(`${t.name} : ${parts.join(", ")}.`);
  }
  return out;
}

export function ReportPage() {
  const id = Number(useParams().matchId);
  const q = useQuery({ queryKey: ["match", id], queryFn: () => api.match(id) });
  const an = useQuery({ queryKey: ["match-analysis", id], queryFn: () => api.matchAnalysis(id) });
  const place = usePlaceLabel(q.data?.map_name);
  if (q.isLoading || an.isLoading) return <div className="page"><Spinner /></div>;
  if (!q.data || !an.data) return <EmptyState title="Match introuvable" />;
  const m = q.data, a = an.data;
  return (
    <div className="page report" data-testid="match-report">
      <div className="report-actions rp-noprint">
        <Link to={`/matches/${m.id}`} className="back-link"><Icon name="back" />Match</Link>
        <Button variant="primary" onClick={() => window.print()}><Icon name="print" />Imprimer ou PDF</Button>
      </div>
      <header className="report-head">
        <div className="eyebrow">Rapport de match · {m.map_display_name}</div>
        <h1 className="display">{m.team_a.name} <span className="mono">{m.score_a}–{m.score_b}</span> {m.team_b.name}</h1>
        <p className="st-legend">{formatDate(m.labels?.played_on ?? m.played_at ?? m.imported_at)} · {formatDuration(m.duration_s)} · mi-temps {m.halves.map((h) => `${h.a}–${h.b}`).join(" / ")}
          {m.labels?.event ? ` · ${m.labels.event}` : ""}</p>
      </header>
      <section className="panel section report-summary">
        <h2 className="section-title">Résumé</h2>
        <ul>{reportSummary(m, a, place).map((s, i) => <li key={i}>{s}</li>)}</ul>
      </section>
      <section className="panel section"><h2 className="section-title">Rounds</h2><RoundStrip m={m} /></section>
      <section className="panel section"><h2 className="section-title">Économie</h2><EconomyChart m={m} /></section>
      <section className="panel section"><h2 className="section-title">Tableau des scores</h2><Scoreboard m={m} /></section>
      <section className="panel section"><AnalysisPanel m={m} a={a} report /></section>
    </div>
  );
}
