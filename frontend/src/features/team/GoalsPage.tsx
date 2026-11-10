import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import type { TeamGoalT } from "../../shared/api/types";
import { useUrlParams } from "../../shared/useUrlParams";
import { EmptyState } from "../../shared/ui/EmptyState";
import { Icon } from "../../shared/ui/Icon";
import { Spinner } from "../../shared/ui/Spinner";
import "../scouting/scouting.css";
import "./debrief.css";

/** Axes de travail d'une équipe : une mesure suivie à chaque match, comparée avant / après la création de l'axe.
 *  Principe des débriefs efficaces : peu d'objectifs, écrits, mesurés et revus au débrief suivant. */

const TEAM_KEY = "sl-goals-team";
const STATUS: Record<string, [string, string]> = {
  waiting: ["En attente d'un match", ""], early: ["Trop tôt pour conclure", ""],
  better: ["Progresse", "pos"], worse: ["Recule", "neg"], flat: ["Stable", ""],
};

function Chart({ g }: { g: TeamGoalT }) {
  const pts = (g.series ?? []).filter((p) => p.n > 0);
  if (!pts.length) return <p className="cm-empty">Aucune situation mesurée pour l'instant.</p>;
  const W = 100 / pts.length;
  return (
    <div className="gl-chart" role="img" aria-label={`${g.metric_label} match par match`}>
      {g.target != null && <i className="gl-target" style={{ bottom: `${g.target}%` }} title={`Objectif ${g.target} %`} />}
      {pts.map((p) => (
        <Link key={p.match_id} to={`/matches/${p.match_id}?tab=debrief&team=${g.team_id}`} className={`gl-bar ${p.after ? "after" : ""}`} style={{ width: `${W}%` }}
          title={`${p.opponent} · ${p.map.replace("de_", "")}${p.date ? ` · ${new Date(p.date).toLocaleDateString("fr-FR")}` : ""} : ${p.k}/${p.n} (${p.pct} %)${p.after ? " · après l'axe" : " · avant l'axe"}`}>
          <i style={{ height: `${Math.max(3, p.pct ?? 0)}%` }} />
        </Link>
      ))}
    </div>
  );
}

function GoalCard({ g }: { g: TeamGoalT }) {
  const qc = useQueryClient();
  const [edit, setEdit] = useState(false);
  const [title, setTitle] = useState(g.title);
  const [target, setTarget] = useState(g.target == null ? "" : String(g.target));
  const [note, setNote] = useState(g.note);
  const done = () => qc.invalidateQueries({ queryKey: ["goals"] });
  const upd = useMutation({ mutationFn: (p: Parameters<typeof api.updateGoal>[1]) => api.updateGoal(g.id, p), onSuccess: () => { setEdit(false); void done(); } });
  const del = useMutation({ mutationFn: () => api.deleteGoal(g.id), onSuccess: done });
  const [label, tone] = STATUS[g.status ?? "waiting"];
  const b = g.before, a = g.after;
  return (
    <section className="panel section gl-card" data-testid="goal-card">
      <header className="ts-block-head">
        <div>
          <h2 className="display ts-h">{g.title}</h2>
          <small className="st-legend">{g.metric_label}{g.target != null && ` · objectif ${g.better === "up" ? "≥" : "≤"} ${g.target} %`}
            {g.created_at && ` · depuis le ${new Date(g.created_at + "Z").toLocaleDateString("fr-FR")}`}</small>
        </div>
        <span className={`gl-status ${tone}`} data-testid="goal-status">{label}{g.reached ? " · objectif atteint" : ""}</span>
      </header>
      <div className="gl-compare">
        <div><span className="rf-label">Avant</span><b className="mono">{b && b.n ? `${b.pct} %` : "—"}</b><small className="rf-dim mono">{b ? `${b.k}/${b.n}` : ""}</small></div>
        <span className="gl-sep" aria-hidden="true">›</span>
        <div><span className="rf-label">Depuis</span><b className={`mono ${tone}`}>{a && a.n ? `${a.pct} %` : "—"}</b><small className="rf-dim mono">{a ? `${a.k}/${a.n}` : ""}</small></div>
      </div>
      <Chart g={g} />
      <p className="st-legend gl-legend"><i className="gl-key" /> avant l'axe <i className="gl-key after" /> après · un clic ouvre le débrief du match</p>
      {g.note && !edit && <p className="gl-note">{g.note}</p>}
      {edit ? (
        <div className="gl-form">
          <label><span className="rf-label">Titre</span><input className="rf-select" value={title} onChange={(e) => setTitle(e.target.value)} /></label>
          <label><span className="rf-label">Objectif (%)</span><input className="rf-select" inputMode="numeric" value={target} onChange={(e) => setTarget(e.target.value)} /></label>
          <label className="gl-wide"><span className="rf-label">Règle ou exercice</span><textarea className="rf-select" rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></label>
          <div className="db-actions">
            <button type="button" className="btn btn-sm btn-primary" onClick={() => upd.mutate({ title, note, target: target.trim() === "" ? null : Number(target) })}>Enregistrer</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEdit(false)}>Annuler</button>
          </div>
        </div>
      ) : (
        <div className="db-actions">
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEdit(true)}>Modifier</button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => upd.mutate({ archived: !g.archived })} data-testid="goal-archive">{g.archived ? "Réactiver" : "Terminer"}</button>
          {g.archived && <button type="button" className="btn btn-sm btn-ghost" onClick={() => del.mutate()}><Icon name="trash" />Supprimer</button>}
          {g.source_match_id && <Link className="pl-link" to={`/matches/${g.source_match_id}?tab=debrief&team=${g.team_id}`}>Débrief d'origine</Link>}
        </div>
      )}
      {(upd.isError || del.isError) && <p className="error">{((upd.error || del.error) as Error).message}</p>}
    </section>
  );
}

export function GoalsPage() {
  const [params, set] = useUrlParams();
  const teams = useQuery({ queryKey: ["teams"], queryFn: api.teams });
  const metrics = useQuery({ queryKey: ["goal-metrics"], queryFn: api.goalMetrics, staleTime: Infinity });
  let saved: string | null = null;
  try { saved = localStorage.getItem(TEAM_KEY); } catch { /* stockage indisponible */ }
  const team = Number(params.get("team") || saved) || teams.data?.[0]?.id;
  const archived = params.get("archived") === "1";
  const goals = useQuery({ queryKey: ["goals", team, archived], queryFn: () => api.goals(team!, archived), enabled: !!team });
  const qc = useQueryClient();
  const [metric, setMetric] = useState("traded");
  const [title, setTitle] = useState("");
  const [target, setTarget] = useState("");
  const create = useMutation({
    mutationFn: () => api.createGoal(team!, { metric, title: title.trim() || (metrics.data?.find((x) => x.key === metric)?.label ?? metric), target: target.trim() === "" ? null : Number(target) }),
    onSuccess: () => { setTitle(""); setTarget(""); void qc.invalidateQueries({ queryKey: ["goals"] }); },
  });
  const pickTeam = (v: string) => { set("team", v); try { localStorage.setItem(TEAM_KEY, v); } catch { /* stockage indisponible */ } };
  const chosen = metrics.data?.find((x) => x.key === metric);
  return (
    <div className="page">
      <div className="lib-head">
        <div><div className="eyebrow">Équipe</div><h1 className="display">Axes de travail</h1></div>
        <select className="rf-select" value={team ?? ""} onChange={(e) => pickTeam(e.target.value)} aria-label="Équipe" data-testid="goals-team">
          {teams.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </div>
      <p className="st-legend gl-intro">Peu d'axes à la fois (deux ou trois), chacun relié à une mesure prise à chaque match. Les matchs joués après la création de l'axe sont comparés à ceux d'avant : vous voyez si le changement prend.
        Créez un axe depuis l'onglet « Débrief » d'un match, ou ici.</p>
      {team && (
        <section className="panel section gl-new" data-testid="goal-new">
          <h2 className="display ts-h">Nouvel axe</h2>
          <div className="gl-form">
            <label><span className="rf-label">Mesure suivie</span>
              <select className="rf-select" value={metric} onChange={(e) => setMetric(e.target.value)} data-testid="goal-metric">
                {metrics.data?.map((x) => <option key={x.key} value={x.key}>{x.label}{x.better === "down" ? " (le moins possible)" : ""}</option>)}
              </select></label>
            <label><span className="rf-label">Titre</span><input className="rf-select" value={title} placeholder={chosen?.label} onChange={(e) => setTitle(e.target.value)} data-testid="goal-title" /></label>
            <label><span className="rf-label">Objectif (%) facultatif</span><input className="rf-select" inputMode="numeric" value={target} onChange={(e) => setTarget(e.target.value)} /></label>
            <button type="button" className="btn btn-primary btn-sm" disabled={create.isPending} onClick={() => create.mutate()} data-testid="goal-create"><Icon name="crosshair" />Créer</button>
          </div>
          {chosen?.drill && <p className="st-legend"><b>Exercice proposé :</b> {chosen.drill}</p>}
          {create.isError && <p className="error">{(create.error as Error).message}</p>}
        </section>
      )}
      <nav className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={!archived} className={`tab ${!archived ? "on" : ""}`} onClick={() => set("archived", undefined)}>En cours</button>
        <button type="button" role="tab" aria-selected={archived} className={`tab ${archived ? "on" : ""}`} onClick={() => set("archived", "1")}>Terminés</button>
      </nav>
      {!goals.data ? (team ? <Spinner /> : <EmptyState title="Aucune équipe" />) : goals.data.length ? (
        <div className="gl-grid">{goals.data.map((g) => <GoalCard key={g.id} g={g} />)}</div>
      ) : <EmptyState icon="crosshair" title={archived ? "Aucun axe terminé" : "Aucun axe de travail en cours"}>Ouvrez l'onglet « Débrief » d'un match : chaque point à travailler peut devenir un axe suivi.</EmptyState>}
    </div>
  );
}
