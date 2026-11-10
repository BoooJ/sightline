import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import type { DebriefRow, MatchDebriefT, MatchDetail } from "../../shared/api/types";
import { fromHere } from "../../shared/backLink";
import { useMyPlayer } from "../../shared/myPlayer";
import { useUrlParams } from "../../shared/useUrlParams";
import { Icon } from "../../shared/ui/Icon";
import { Spinner } from "../../shared/ui/Spinner";
import { Dots } from "../scouting/scoutUi";
import "../scouting/scouting.css";
import "./debrief.css";

/** Débrief d'un match pour une équipe, dans l'ordre d'un débrief d'équipe (after-action review) :
 *  où le match s'est joué, 3 problèmes au plus, 5 rounds à revoir, axes de travail, conclusions écrites. */

const QUESTIONS = [
  "Quelle était la condition de victoire du round ?",
  "Quelle information avions-nous vraiment ?",
  "Les positions et le timing étaient-ils logiques pour la situation ?",
  "Les grenades ont-elles créé de l'espace, du temps, de l'info ou un isolement ?",
  "Chaque joueur était-il à portée d'échange de ses coéquipiers ?",
];

function RoundChips({ m, nums, max = 14 }: { m: MatchDetail; nums: number[]; max?: number }) {
  if (!nums.length) return null;
  return (
    <span className="ts-round-list db-chips">
      {nums.slice(0, max).map((n) => <Link key={n} className="ts-round l" to={`/matches/${m.id}/replay/${n}?${fromHere()}`} title={`Revoir le round ${n}`}>R{n}</Link>)}
      {nums.length > max && <small className="rf-dim">+{nums.length - max}</small>}
    </span>
  );
}

function gapOf(r: DebriefRow): { txt: string; tone: string } | null {
  if (r.usual == null || r.stat.pct == null) return null;
  const d = r.stat.pct - r.usual;
  const good = r.better === "up" ? d : -d;
  return { txt: `${d > 0 ? "+" : ""}${d} pts`, tone: good >= 10 ? "pos" : good <= -10 ? "neg" : "" };
}

function Notes({ d, matchId, team }: { d: MatchDebriefT; matchId: number; team: number }) {
  const qc = useQueryClient();
  const [form, setForm] = useState(d.notes);
  useEffect(() => setForm(d.notes), [d.notes]);
  const save = useMutation({
    mutationFn: () => api.saveDebrief(matchId, team, form),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["debrief", matchId, team] }),
  });
  const dirty = form.worked !== d.notes.worked || form.change !== d.notes.change || form.actions !== d.notes.actions;
  const field = (k: "worked" | "change" | "actions", label: string, hint: string) => (
    <label className="db-note">
      <span className="rf-label">{label}</span>
      <textarea className="rf-select" rows={3} value={form[k]} placeholder={hint} onChange={(e) => setForm({ ...form, [k]: e.target.value })} data-testid={`db-note-${k}`} />
    </label>
  );
  return (
    <section className="panel section db-card db-wide" data-testid="db-notes">
      <h2 className="display ts-h">Conclusions de l'équipe</h2>
      <p className="st-legend">Écrites ensemble juste après le match. Commencez par ce qui a marché, gardez peu de points, et notez des actions concrètes pour le prochain entraînement.</p>
      <div className="db-notes">
        {field("worked", "Ce qui a marché (à garder)", "Ex. pistols CT, exécution B avec 2 smokes…")}
        {field("change", "Ce qu'il faut changer", "Ex. on se fait prendre seuls en Mid après la première élimination…")}
        {field("actions", "Actions pour le prochain entraînement", "Ex. 20 min de retakes B, règle « à 5v4 on se regroupe »…")}
      </div>
      <div className="db-actions">
        <button type="button" className="btn btn-primary btn-sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()} data-testid="db-save">
          {save.isPending ? "Enregistrement…" : "Enregistrer"}</button>
        {!dirty && d.notes.updated_at && <small className="st-legend">Enregistré le {new Date(d.notes.updated_at + "Z").toLocaleString("fr-FR")}</small>}
        {save.isError && <small className="error">{(save.error as Error).message}</small>}
      </div>
    </section>
  );
}

export function DebriefPanel({ m }: { m: MatchDetail }) {
  const me = useMyPlayer();
  const [params, set] = useUrlParams();
  const mine = m.players.find((p) => p.steamid === me)?.team_id;
  const team = Number(params.get("team")) || mine || m.team_a.id;
  const nav = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["debrief", m.id, team], queryFn: () => api.debrief(m.id, team), placeholderData: (p) => p });
  const [made, setMade] = useState<string[]>([]);
  const goal = useMutation({
    mutationFn: (g: { metric: string; title: string }) => api.createGoal(team, { ...g, source_match_id: m.id }),
    onSuccess: (_, g) => { setMade((x) => [...x, g.metric]); void qc.invalidateQueries({ queryKey: ["debrief", m.id, team] }); void qc.invalidateQueries({ queryKey: ["goals"] }); },
  });
  const playlist = useMutation({
    mutationFn: async (ids: number[]) => {
      const name = `Débrief ${d?.teams.find((t) => t.id === team)?.name ?? ""} · ${m.map_display_name} · ${m.team_a.name} ${m.score_a}–${m.score_b} ${m.team_b.name}`;
      const pl = await api.createPlaylist(name.slice(0, 120), "Rounds à revoir, choisis par le débrief du match.");
      await api.addToPlaylist(pl.id, ids);
      return pl;
    },
    onSuccess: (pl) => nav(`/playlists/${pl.id}`),
  });
  const d = q.data;
  if (!d) return <section className="panel section"><Spinner /></section>;
  const teamName = d.teams.find((t) => t.id === team)?.name ?? "";
  const ids = d.review.map((r) => r.round_id);
  const goalMetrics = new Set(d.goals.map((g) => g.metric));
  return (
    <div className={`db ${q.isPlaceholderData ? "ts-stale" : ""}`} data-testid="debrief">
      <div className="db-bar panel">
        <div className="ts-seg" role="radiogroup" aria-label="Équipe débriefée">
          {d.teams.map((t) => <button key={t.id} type="button" role="radio" aria-checked={t.id === team} className={t.id === team ? "on" : ""} onClick={() => set("team", String(t.id))}>{t.name}</button>)}
        </div>
        <ol className="db-steps" aria-label="Étapes du débrief">
          <li>Où le match s'est joué</li><li>3 points à travailler</li><li>5 rounds à revoir</li><li>Conclusions et axes</li>
        </ol>
        <small className="st-legend">{d.matches_compared ? `Comparé aux ${d.matches_compared} autres matchs de ${teamName}.` : `Premier match de ${teamName} dans la bibliothèque : comparé à des repères fixes.`}</small>
      </div>

      <div className="db-grid">
        <section className="panel section db-card" data-testid="db-phases">
          <h2 className="display ts-h"><b className="ts-num">1</b> Où le match s'est joué</h2>
          <table className="ts-table db-table">
            <thead><tr><th>Phase</th><th>Ce match</th><th>D'habitude</th><th>Rounds</th></tr></thead>
            <tbody>
              {[...d.sides, ...d.phases].map((r) => {
                const g = gapOf(r);
                return (
                  <tr key={r.key}>
                    <td className="ts-td-label">{r.label}</td>
                    <td className="mono"><b className={r.stat.tone}>{r.stat.k}/{r.stat.n}</b> <small className="rf-dim">({r.stat.pct ?? 0} %)</small> <Dots s={r.stat} /></td>
                    <td className="mono">{r.usual != null ? <>{r.usual} % {g && <small className={g.tone}>{g.txt}</small>}</> : <span className="rf-dim">—</span>}</td>
                    <td><RoundChips m={m} nums={r.bad} max={6} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="st-legend">Les rounds listés sont ceux où la phase a mal tourné pour {teamName}. Ordre de lecture des analystes : pistols, puis rounds armés, puis avantages numériques et fins de round.</p>
        </section>

        <section className="panel section db-card" data-testid="db-issues">
          <h2 className="display ts-h"><b className="ts-num">2</b> À travailler <small className="st-legend">3 points au plus</small></h2>
          {d.issues.length ? (
            <ol className="db-issues">
              {d.issues.map((i) => (
                <li key={i.key} className="db-issue" data-testid="db-issue">
                  <p className="db-issue-text">{i.text} <Dots s={i.stat} /></p>
                  {i.question && <p className="db-issue-q"><b>Dans la démo :</b> {i.question}</p>}
                  {i.drill && <p className="db-issue-q"><b>À l'entraînement :</b> {i.drill}</p>}
                  <div className="db-issue-foot">
                    <RoundChips m={m} nums={i.bad_rounds} max={8} />
                    {goalMetrics.has(i.key) || made.includes(i.key)
                      ? <Link className="pl-link" to={`/goals?team=${team}`}><Icon name="crosshair" size={13} /> Axe de travail en cours</Link>
                      : <button type="button" className="btn btn-sm btn-ghost" disabled={goal.isPending} onClick={() => goal.mutate({ metric: i.key, title: i.label })} data-testid="db-make-goal">
                        <Icon name="crosshair" />En faire un axe de travail</button>}
                  </div>
                </li>
              ))}
            </ol>
          ) : <p className="cm-empty">Aucun écart net sur ce match par rapport {d.matches_compared ? "à votre forme habituelle" : "aux repères"}. Revoyez quand même les rounds ci-dessous : un bon résultat peut cacher de mauvaises habitudes.</p>}
        </section>

        <section className="panel section db-card" data-testid="db-review">
          <div className="ts-block-head"><h2 className="display ts-h"><b className="ts-num">3</b> Rounds à revoir</h2>
            <span className="db-actions">
              {d.review.length > 0 && <Link className="btn btn-sm btn-primary" to={`/matches/${m.id}/replay/${d.review[0].number}?${ids.length > 1 ? `layers=${ids.slice(1).join(",")}&` : ""}${fromHere()}`} data-testid="db-overlay"><Icon name="layers" />Superposés</Link>}
              <button type="button" className="btn btn-sm btn-ghost" disabled={!ids.length || playlist.isPending} onClick={() => playlist.mutate(ids)} data-testid="db-playlist"><Icon name="playlist" />Playlist</button>
            </span></div>
          <ul className="db-rounds">
            {d.review.map((r) => (
              <li key={r.number} data-testid="db-round">
                <Link className={`ts-round ${r.won ? "w" : "l"}`} to={`/matches/${m.id}/replay/${r.number}?${fromHere()}`} title={r.won ? "Round gagné" : "Round perdu"}>R{r.number}<span className="sr-only">{r.won ? " gagné" : " perdu"}</span></Link>
                <span className={r.side === "CT" ? "sc-ct" : "sc-t"}>{r.side}</span>
                <span><b>{r.label}</b><br /><small className="st-legend">{r.why}</small></span>
              </li>
            ))}
          </ul>
          <details className="db-questions">
            <summary>5 questions à se poser sur chaque round</summary>
            <ol>{QUESTIONS.map((x) => <li key={x}>{x}</li>)}</ol>
          </details>
        </section>

        <section className="panel section db-card" data-testid="db-goals">
          <div className="ts-block-head"><h2 className="display ts-h"><b className="ts-num">4</b> Axes de travail en cours</h2>
            <Link className="pl-link" to={`/goals?team=${team}`}>Tout le suivi</Link></div>
          {d.goals.length ? (
            <ul className="db-goal-list">
              {d.goals.map((g) => {
                const h = g.here;
                const ok = g.target != null && h?.pct != null ? (g.better === "up" ? h.pct >= g.target : h.pct <= g.target) : null;
                return (
                  <li key={g.id}><b>{g.title}</b> <small className="st-legend">{g.metric_label}</small>
                    <span className="mono">{h && h.n ? <>ce match <b className={ok == null ? "" : ok ? "pos" : "neg"}>{h.k}/{h.n} ({h.pct} %)</b></> : <span className="rf-dim">pas de situation sur ce match</span>}
                      {g.target != null && <small className="rf-dim"> · objectif {g.better === "up" ? "≥" : "≤"} {g.target} %</small>}</span>
                  </li>
                );
              })}
            </ul>
          ) : <p className="cm-empty">Aucun axe de travail. Transformez un point de la section 2 en axe : sa mesure sera suivie aux matchs suivants.</p>}
        </section>

        <Notes d={d} matchId={m.id} team={team} />
      </div>
    </div>
  );
}
