import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../shared/api/client";
import type { MapMeta, NoteFilter, NoteInput, NoteT } from "../../shared/api/types";
import { formatDate } from "../../shared/format";
import { Button } from "../../shared/ui/Button";
import { Icon } from "../../shared/ui/Icon";
import { Spinner } from "../../shared/ui/Spinner";
import { useAuth } from "../team/auth";
import "../team/team.css";
import "./notes.css";

const MAX = 2000;
type Side = "T" | "CT" | null;

/** Notes des joueurs (écrites aussi depuis l'app) : celles du contexte (carte, adversaire, match, stratégie), privées ou
 *  partagées avec l'équipe. Seul l'auteur modifie ; un admin peut retirer une note d'équipe. */
export function NotesPanel({ title, filter, draft, empty, className = "" }: {
  title: string; filter: NoteFilter;
  /** valeurs d'une nouvelle note (la carte, l'adversaire, le match ou la stratégie du contexte) */
  draft: Partial<NoteInput>;
  empty: string; className?: string;
}) {
  const qc = useQueryClient();
  const notes = useQuery({ queryKey: ["notes", filter], queryFn: () => api.notes(filter) });
  const maps = useQuery({ queryKey: ["maps"], queryFn: api.maps, staleTime: Infinity });
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const done = () => { setEditing(null); void qc.invalidateQueries({ queryKey: ["notes"] }); };
  const list = notes.data ?? [];
  return (
    <section className={`panel section nt-panel ${className}`} data-testid="notes-panel">
      <header className="nt-head">
        <h2 className="section-title">{title} <span className="mono rf-dim">{list.length || ""}</span></h2>
        {editing !== "new" && <Button size="sm" variant="ghost" onClick={() => setEditing("new")} data-testid="note-new"><Icon name="plus" size={14} />Nouvelle note</Button>}
      </header>
      {editing === "new" && (
        <NoteEditor maps={maps.data ?? []} initial={{ map: "", body: "", side: null, shared: false, ...draft }} links={null}
          onSave={(p) => api.createNote(p)} onDone={done} onCancel={() => setEditing(null)} />
      )}
      {notes.isLoading ? <Spinner /> : (
        <ul className="cm-list">
          {list.map((n) => editing === n.id ? (
            <li key={n.id}>
              <NoteEditor maps={maps.data ?? []} links={n}
                initial={{ map: n.map, body: n.body, side: n.side, shared: n.shared, match_id: n.match?.id ?? null, team_id: n.team?.id ?? null, strat_id: n.strat?.id ?? null }}
                onSave={(p) => api.updateNote(n.id, p)} onDone={done} onCancel={() => setEditing(null)} />
            </li>
          ) : <NoteItem key={n.id} n={n} maps={maps.data ?? []} onEdit={() => setEditing(n.id)} onDeleted={done} />)}
          {!list.length && editing !== "new" && <li className="cm-empty">{empty}</li>}
        </ul>
      )}
    </section>
  );
}

function NoteItem({ n, maps, onEdit, onDeleted }: { n: NoteT; maps: MapMeta[]; onEdit: () => void; onDeleted: () => void }) {
  const { user } = useAuth();
  const [confirm, setConfirm] = useState(false);
  // mêmes règles que le serveur : l'auteur, ou un admin pour une note d'équipe
  const canDelete = n.mine || (n.shared && !!user && user.role !== "member");
  const del = useMutation({ mutationFn: () => api.deleteNote(n.id), onSuccess: onDeleted });
  const mapName = maps.find((m) => m.name === n.map)?.display_name ?? n.map;
  return (
    <li className="cm-item nt-item" data-testid="note">
      <div className="cm-head">
        {n.side && <span className={`sb-side ${n.side.toLowerCase()}`}>{n.side}</span>}
        <b>{n.author}</b>
        <span className="rf-dim">{mapName}</span>
        {n.team && <Link className="mlab" to={`/scouting/${n.team.id}?map=${n.map}`}>contre {n.team.name}</Link>}
        {n.match && <Link className="mlab" to={`/matches/${n.match.id}?tab=debrief`}>match{n.match.date ? ` du ${formatDate(n.match.date)}` : ""}</Link>}
        {n.strat && <Link className="mlab" to={`/stratbook/${n.strat.id}`}>strat {n.strat.name}</Link>}
        {n.shared ? <span className="cm-badge draw" title="Visible par toute l'équipe">équipe</span>
          : <span className="cm-badge" title="Visible par vous seulement">perso</span>}
        <small>{formatDate(n.updated_at)}</small>
        <span className="nt-actions">
          {n.mine && <button type="button" className="nt-link" onClick={onEdit}>Modifier</button>}
          {confirm ? (<>
            <Button size="sm" variant="danger" onClick={() => del.mutate()} disabled={del.isPending}>Supprimer ?</Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>Non</Button>
          </>) : canDelete && (
            <button type="button" className="cm-del" aria-label="Supprimer la note" onClick={() => setConfirm(true)}><Icon name="trash" size={13} /></button>
          )}
        </span>
      </div>
      <p>{n.body}</p>
      {del.isError && <p className="nt-error">{(del.error as Error).message}</p>}
    </li>
  );
}

function NoteEditor({ maps, initial, links, onSave, onDone, onCancel }: {
  maps: MapMeta[]; initial: NoteInput; links: Pick<NoteT, "match" | "team" | "strat"> | null;
  onSave: (p: NoteInput) => Promise<NoteT>; onDone: () => void; onCancel: () => void;
}) {
  const [body, setBody] = useState(initial.body);
  const [map, setMap] = useState(initial.map);
  const [side, setSide] = useState<Side>(initial.side ?? null);
  const [shared, setShared] = useState(!!initial.shared);
  const [ids, setIds] = useState({ match_id: initial.match_id ?? null, team_id: initial.team_id ?? null, strat_id: initial.strat_id ?? null });
  const save = useMutation({ mutationFn: () => onSave({ map, body: body.trim(), side, shared, ...ids }), onSuccess: onDone });
  const choices = maps.filter((m) => m.active_duty || m.name === map);
  const chips = [
    ids.team_id !== null && { key: "team_id" as const, label: links?.team ? `contre ${links.team.name}` : "adversaire" },
    ids.match_id !== null && { key: "match_id" as const, label: links?.match ? `match${links.match.date ? ` du ${formatDate(links.match.date)}` : ""}` : "ce match" },
    ids.strat_id !== null && { key: "strat_id" as const, label: links?.strat ? `strat ${links.strat.name}` : "cette stratégie" },
  ].filter((c): c is { key: "team_id" | "match_id" | "strat_id"; label: string } => !!c);
  const submit = () => { if (body.trim() && map && !save.isPending) save.mutate(); };
  return (
    <form className="cm-form nt-editor" onSubmit={(e) => { e.preventDefault(); submit(); }} data-testid="note-editor">
      <textarea autoFocus value={body} maxLength={MAX} aria-label="Texte de la note"
        placeholder="Ce que vous voulez retenir : un timing, une habitude adverse, un contre…"
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit(); if (e.key === "Escape") onCancel(); }} />
      <div className="nt-opts">
        <select value={map} onChange={(e) => setMap(e.target.value)} aria-label="Carte de la note" className="nt-select">
          {!map && <option value="">Carte…</option>}
          {choices.map((m) => <option key={m.name} value={m.name}>{m.display_name}</option>)}
        </select>
        <div className="map-pills" role="group" aria-label="Camp de la note">
          {([["T", "T"], ["CT", "CT"], [null, "Les deux"]] as [Side, string][]).map(([v, l]) => (
            <button key={l} type="button" className={`pill ${side === v ? "on" : ""} ${v ? `pill-${v.toLowerCase()}` : ""}`} onClick={() => setSide(v)}>{l}</button>
          ))}
        </div>
        {chips.map((c) => (
          <span key={c.key} className="mlab nt-chip">{c.label}
            <button type="button" aria-label={`Retirer « ${c.label} »`} onClick={() => setIds((x) => ({ ...x, [c.key]: null }))}><Icon name="close" size={11} /></button>
          </span>
        ))}
        <label className="hm-check" title="Visible par tous les comptes de l'équipe, sur le site et dans l'app">
          <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />Partager avec l'équipe
        </label>
        {body.length >= MAX - 200 && <small className="mono nt-count">{body.length} / {MAX}</small>}
      </div>
      {save.isError && <p className="nt-error">{(save.error as Error).message}</p>}
      <div className="cm-actions">
        <small className="rf-dim">Ctrl + Entrée pour enregistrer</small>
        <span className="nt-actions">
          <Button size="sm" variant="ghost" onClick={onCancel}>Annuler</Button>
          <Button type="submit" size="sm" variant="primary" disabled={!body.trim() || !map || save.isPending} data-testid="note-save">Enregistrer</Button>
        </span>
      </div>
    </form>
  );
}
