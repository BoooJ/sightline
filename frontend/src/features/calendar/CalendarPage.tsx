import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import type { CalendarEvent, EventKind, LikelyMaps, MatchSummary } from "../../shared/api/types";
import { useUrlParams } from "../../shared/useUrlParams";
import { Button } from "../../shared/ui/Button";
import { Icon } from "../../shared/ui/Icon";
import "./calendar.css";

export const KIND_LABEL: Record<EventKind, string> = { match: "Match officiel", scrim: "Scrim", tournament: "Tournoi", practice: "Entraînement", other: "Autre" };
const SOURCES: Record<string, string> = { pracc: "PRACC", faceit: "FACEIT" };
const DAYS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
// heures du serveur en UTC (« …Z ») : affichées et saisies dans l'heure locale (l'équipe est sur plusieurs fuseaux)
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const time = (s: string) => hhmm(new Date(s));

/** Calendrier de l'équipe : grille du mois (événements et matchs importés), prochains événements, édition. */
export function CalendarPage() {
  const [params, set] = useUrlParams();
  const now = new Date();
  const month = params.get("month") ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const [y, mo] = month.split("-").map(Number);
  const first = new Date(y, mo - 1, 1);
  const gridStart = new Date(y, mo - 1, 1 - ((first.getDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, i) => new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i));
  const gridEnd = new Date(days[41].getFullYear(), days[41].getMonth(), days[41].getDate() + 1);
  const events = useQuery({ queryKey: ["calendar", iso(gridStart)], queryFn: () => api.calendar(gridStart.toISOString(), gridEnd.toISOString()) });
  const upcoming = useQuery({ queryKey: ["calendar", "upcoming"], queryFn: () => api.calendar(now.toISOString(), new Date(now.getTime() + 60 * 864e5).toISOString()) });
  const matches = useQuery({ queryKey: ["matches", "calendar"], queryFn: () => api.matches() });
  const [edit, setEdit] = useState<Partial<CalendarEvent> | null>(null);
  useEffect(() => { if (params.get("new") === "1") { setEdit({ kind: "scrim", starts_at: `${iso(new Date())}T20:00` }); set("new"); } }, [params]);  // eslint-disable-line react-hooks/exhaustive-deps
  const shift = (n: number) => { const d = new Date(y, mo - 1 + n, 1); set("month", `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); };
  const byDay = (d: Date) => (events.data ?? []).filter((e) => iso(new Date(e.starts_at)) === iso(d));
  const linkedIds = new Set((events.data ?? []).flatMap((e) => e.matches.map((m) => m.id)));
  const playedOn = (d: Date) => (matches.data ?? []).filter((m) => m.date === iso(d) && !linkedIds.has(m.id));
  const title = first.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  return (
    <div className="page">
      <div className="lib-head">
        <div><div className="eyebrow">Équipe</div><h1 className="display">Calendrier</h1></div>
        <Button variant="primary" onClick={() => setEdit({ kind: "scrim", starts_at: `${iso(now)}T20:00` })} data-testid="new-event"><Icon name="calendar" />Nouvel événement</Button>
      </div>
      <div className="cal-layout">
        <section className="panel cal-month">
          <header className="cal-head">
            <Button size="sm" variant="ghost" onClick={() => shift(-1)} aria-label="Mois précédent"><Icon name="prev" /></Button>
            <h2 className="cal-title">{title}</h2>
            <Button size="sm" variant="ghost" onClick={() => shift(1)} aria-label="Mois suivant"><Icon name="next" /></Button>
            <Button size="sm" onClick={() => set("month")}>Aujourd'hui</Button>
          </header>
          <div className="cal-grid" role="grid" aria-label={title}>
            {DAYS.map((d) => <div key={d} className="cal-dow" role="columnheader">{d}</div>)}
            {days.map((d) => {
              const out = d.getMonth() !== mo - 1, today = iso(d) === iso(now);
              return (
                <div key={iso(d)} role="gridcell" className={`cal-day ${out ? "out" : ""} ${today ? "today" : ""}`} data-testid="cal-day" data-date={iso(d)}
                  onClick={(e) => { if (!(e.target as HTMLElement).closest("a, button")) setEdit({ kind: "scrim", starts_at: `${iso(d)}T20:00` }); }}>
                  <span className="cal-num">{d.getDate()}</span>
                  {byDay(d).map((e) => (
                    <button key={e.id} type="button" className={`cal-ev cal-${e.kind}`} onClick={() => setEdit(e)} title={`${KIND_LABEL[e.kind]} · ${e.title}`}>
                      <span className="mono">{time(e.starts_at)}</span> {e.title}{e.matches.length > 0 && <i className="cal-dot" title={`${e.matches.length} démo(s)`} />}
                    </button>
                  ))}
                  {playedOn(d).map((m) => (
                    <Link key={m.id} to={`/matches/${m.id}`} className="cal-played" title="Match importé">{m.team_a.name} {m.score_a}–{m.score_b} {m.team_b.name}</Link>
                  ))}
                </div>
              );
            })}
          </div>
          <p className="st-legend">Cliquez sur un jour pour y créer un événement. En gris : matchs importés ce jour-là sans événement.</p>
        </section>
        <aside className="panel cal-side">
          <h2 className="section-title">Prochains événements</h2>
          {!upcoming.data?.length && <p className="st-legend">Rien de prévu dans les 60 prochains jours.</p>}
          <ul className="cal-up">
            {upcoming.data?.map((e) => (
              <li key={e.id}><button type="button" onClick={() => setEdit(e)}>
                <span className={`cal-kind cal-${e.kind}`}>{KIND_LABEL[e.kind]}</span>
                <b>{e.title}</b>{e.opponent && <span className="st-legend"> contre {e.opponent}</span>}
                <span className="mono st-legend">{new Date(e.starts_at).toLocaleDateString("fr-FR", { weekday: "short", day: "2-digit", month: "short" })} · {time(e.starts_at)}</span>
              </button></li>
            ))}
          </ul>
        </aside>
      </div>
      {edit && <EventDialog ev={edit} matches={matches.data ?? []} onClose={() => setEdit(null)} />}
    </div>
  );
}

/** Cartes probables du BO1 : la carte jouée est celle qu'aucune équipe ne bannit, donc une carte où les deux finissent
 *  souvent. Calculées par la synchro FACEIT à partir des matchs ESEA des deux équipes. */
function Odds({ odds }: { odds: LikelyMaps }) {
  const shown = odds.maps.filter((m) => m.pct >= 3);
  return (
    <section className="cal-odds" aria-label="Cartes probables" data-testid="event-odds">
      <h3 className="cal-odds-title">Cartes probables</h3>
      <ul>
        {shown.map((m) => (
          <li key={m.map}>
            <span className="cal-odds-name">{m.name}</span>
            <span className="cal-odds-bar" aria-hidden><span style={{ width: `${Math.min(100, m.pct * 2)}%` }} /></span>
            <b className="cal-odds-pct">{m.pct} %</b>
            <span className="st-legend">{m.played ? `eux ${m.won}/${m.played}` : "jamais jouée par eux"}</span>
          </li>
        ))}
      </ul>
      <p className="st-legend">D'après leurs {odds.them} matchs ESEA et nos {odds.us}. FACEIT ne donne pas les bans, seulement la carte jouée : c'est une tendance, pas une certitude.{odds.few ? " Peu de matchs chez eux : à prendre avec prudence." : ""}</p>
    </section>
  );
}

function EventDialog({ ev, matches, onClose }: { ev: Partial<CalendarEvent>; matches: MatchSummary[]; onClose: () => void }) {
  const qc = useQueryClient();
  const maps = useQuery({ queryKey: ["maps"], queryFn: api.maps, staleTime: Infinity });
  const at = ev.starts_at ? new Date(ev.starts_at) : null;
  const [f, setF] = useState({ title: ev.title ?? "", kind: (ev.kind ?? "scrim") as EventKind, opponent: ev.opponent ?? "",
    date: at ? iso(at) : "", time: at ? hhmm(at) : "20:00", notes: ev.notes ?? "", maps: ev.maps ?? [] });
  const [manual, setManual] = useState<number[]>((ev.matches ?? []).filter((m) => m.manual).map((m) => m.id));
  const [err, setErr] = useState<string | null>(null);
  const auto = (ev.matches ?? []).filter((m) => !m.manual);
  const save = async () => {
    setErr(null);
    const start = new Date(`${f.date}T${f.time}`);  // heure locale de celui qui saisit, envoyée en UTC
    if (Number.isNaN(start.getTime())) { setErr("Date invalide"); return; }
    const payload = { title: f.title.trim() || (f.opponent ? `${KIND_LABEL[f.kind]} contre ${f.opponent}` : KIND_LABEL[f.kind]), kind: f.kind,
      opponent: f.opponent, starts_at: start.toISOString(), notes: f.notes, maps: f.maps, match_ids: manual };
    try {
      if (ev.id) await api.updateEvent(ev.id, payload); else await api.createEvent(payload);
      await qc.invalidateQueries({ queryKey: ["calendar"] });
      onClose();
    } catch (e) { setErr((e as Error).message); }
  };
  const remove = async () => { await api.deleteEvent(ev.id!); await qc.invalidateQueries({ queryKey: ["calendar"] }); onClose(); };
  const k = (e: React.KeyboardEvent) => e.stopPropagation();
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="dialog panel cal-dialog" role="dialog" aria-label={ev.id ? "Modifier l'événement" : "Nouvel événement"} data-testid="event-dialog"
        onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="cal-dialog-head"><h2 className="display">{ev.id ? "Modifier l'événement" : "Nouvel événement"}</h2>
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="Fermer">✕</Button></div>
        {ev.source && <p className="st-legend" data-testid="event-synced">Venu de {SOURCES[ev.source] ?? ev.source} : il se met à jour tout seul, et une modification faite ici sera remplacée à la prochaine synchro.</p>}
        {ev.likely_maps && <Odds odds={ev.likely_maps} />}
        <div className="map-pills" role="group" aria-label="Type">
          {(Object.keys(KIND_LABEL) as EventKind[]).map((x) => <button key={x} type="button" className={`pill ${f.kind === x ? "on" : ""}`} onClick={() => setF({ ...f, kind: x })}>{KIND_LABEL[x]}</button>)}
        </div>
        <label className="cal-field"><span>Titre</span><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} onKeyDown={k} placeholder="ex. Scrim contre Team X" autoFocus /></label>
        <label className="cal-field"><span>Adversaire (rattache automatiquement les démos du jour)</span><input value={f.opponent} onChange={(e) => setF({ ...f, opponent: e.target.value })} onKeyDown={k} data-testid="event-opponent" /></label>
        <div className="cal-row">
          <label className="cal-field"><span>Date</span><input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} required /></label>
          <label className="cal-field"><span>Heure</span><input type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} required /></label>
        </div>
        <div className="cal-field"><span>Cartes</span>
          <div className="map-pills">{maps.data?.map((m) => (
            <button key={m.name} type="button" className={`pill ${f.maps.includes(m.name) ? "on" : ""}`}
              onClick={() => setF({ ...f, maps: f.maps.includes(m.name) ? f.maps.filter((x) => x !== m.name) : [...f.maps, m.name] })}>{m.display_name}</button>
          ))}</div></div>
        <label className="cal-field"><span>Notes (plan de jeu, consignes…)</span><textarea rows={3} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} onKeyDown={k} /></label>
        <div className="cal-field"><span>Démos rattachées</span>
          <ul className="cal-links">
            {auto.map((m) => <li key={m.id}><Link to={`/matches/${m.id}`}>{m.team_a.name} {m.score_a}–{m.score_b} {m.team_b.name} · {m.map_display_name}</Link><span className="st-legend">automatique</span></li>)}
            {manual.map((id) => { const m = matches.find((x) => x.id === id); return m ? (
              <li key={id}><Link to={`/matches/${id}`}>{m.team_a.name} {m.score_a}–{m.score_b} {m.team_b.name} · {m.map_display_name}</Link>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setManual(manual.filter((x) => x !== id))} aria-label="Retirer">✕</button></li>) : null; })}
          </ul>
          <select className="rf-select" value="" onChange={(e) => e.target.value && setManual([...manual, Number(e.target.value)])} aria-label="Rattacher une démo">
            <option value="">Rattacher une démo…</option>
            {matches.filter((m) => !manual.includes(m.id) && !auto.some((a) => a.id === m.id)).map((m) => (
              <option key={m.id} value={m.id}>{m.date ?? ""} · {m.team_a.name} vs {m.team_b.name} · {m.map_display_name}</option>))}
          </select>
        </div>
        {err && <p className="auth-error">{err}</p>}
        <div className="cal-dialog-foot">
          {ev.id ? <Button variant="ghost" onClick={remove}><Icon name="trash" />Supprimer</Button> : <span />}
          <Button type="submit" variant="primary">Enregistrer</Button>
        </div>
      </form>
    </div>
  );
}
