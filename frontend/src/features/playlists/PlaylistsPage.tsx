import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../../shared/api/client";
import type { PlaylistDetail, PlaylistHead, PlaylistItem } from "../../shared/api/types";
import { useUrlParams } from "../../shared/useUrlParams";
import { formatDate } from "../../shared/format";
import { Button } from "../../shared/ui/Button";
import { EmptyState } from "../../shared/ui/EmptyState";
import { Icon } from "../../shared/ui/Icon";
import { Spinner } from "../../shared/ui/Spinner";
import { FolderPicker } from "../library/LibraryFilters";
import { END_REASON } from "../rounds/RoundsPage";
import "../match/match.css";
import "./playlists.css";

/** URL de lecture d'un élément : replay du round, avec le contexte de playlist pour enchaîner. */
export const playUrl = (pid: number, items: PlaylistItem[], index: number): string | null => {
  const it = items[index];
  return it?.match && it.round ? `/matches/${it.match.id}/replay/${it.round_number}?playlist=${pid}&i=${index}` : null;
};

const RAIL_ALL = "", RAIL_FAV = "__fav", RAIL_NONE = "__none";

/** Playlists (comme EDGE) : rail de dossiers (Toutes, Favoris, Sans dossier, vos dossiers), favoris, tableau
 *  playlist / dossier / cartes / rounds / auteur / mise à jour, filtres carte et étiquette. */
export function PlaylistsPage() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [params, set] = useUrlParams();
  const [name, setName] = useState("");
  const lists = useQuery({ queryKey: ["playlists"], queryFn: api.playlists });
  const maps = useQuery({ queryKey: ["maps"], queryFn: api.maps, staleTime: Infinity });
  const rail = params.get("folder") ?? RAIL_ALL;
  const map = params.get("map") ?? "", tag = params.get("tag") ?? "";
  const all = lists.data ?? [];
  const folders = useMemo(() => [...new Set(all.map((p) => p.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [all]);
  const tags = useMemo(() => [...new Set(all.flatMap((p) => p.tags))].sort((a, b) => a.localeCompare(b)), [all]);
  const shown = all.filter((p) => (rail === RAIL_ALL || (rail === RAIL_FAV ? p.favorite : rail === RAIL_NONE ? !p.folder : p.folder === rail))
    && (!map || p.maps.includes(map)) && (!tag || p.tags.includes(tag)));
  const create = async () => {
    const v = name.trim();
    if (!v) return;
    const p = await api.createPlaylist(v, "", { folder: rail && !rail.startsWith("__") ? rail : "" });
    setName("");
    qc.invalidateQueries({ queryKey: ["playlists"] });
    nav(`/playlists/${p.id}`);
  };
  const star = async (p: PlaylistHead) => { await api.updatePlaylist(p.id, { favorite: !p.favorite }); qc.invalidateQueries({ queryKey: ["playlists"] }); };
  const mapName = (n: string) => maps.data?.find((m) => m.name === n)?.display_name ?? n;
  const railItem = (key: string, label: string, n: number, icon?: "star" | "folder") => (
    <button key={key || "all"} type="button" className={`pls-rail-item ${rail === key ? "on" : ""}`} onClick={() => set("folder", key || undefined)} data-testid="pls-rail">
      {icon && <Icon name={icon} size={14} />}<span>{label}</span><span className="mono rf-dim">{n}</span></button>
  );
  return (
    <div className="page">
      <div className="lib-head">
        <div>
          <div className="eyebrow">Matchs</div>
          <h1 className="display">Playlists <span className="lib-count mono">{all.length}</span></h1>
        </div>
        <form className="lib-tools" onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <label className="search"><Icon name="playlist" />
            <input placeholder="Nom de la nouvelle playlist…" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <Button variant="primary" type="submit" disabled={!name.trim()}>Créer</Button>
        </form>
      </div>
      {lists.isLoading ? <Spinner /> : !all.length ? (
        <section className="panel section">
          <EmptyState icon="playlist" title="Aucune playlist">Créez-en une ici, sélectionnez des rounds dans <Link className="pl-link" to="/rounds">Rounds</Link>, ou des matchs entiers dans la <Link className="pl-link" to="/">bibliothèque</Link>.</EmptyState>
        </section>
      ) : (
        <div className="pls-layout">
          <aside className="panel pls-rail" aria-label="Dossiers de playlists">
            {railItem(RAIL_ALL, "Toutes", all.length)}
            {railItem(RAIL_FAV, "Favoris", all.filter((p) => p.favorite).length, "star")}
            {railItem(RAIL_NONE, "Sans dossier", all.filter((p) => !p.folder).length)}
            {folders.map((f) => railItem(f, f, all.filter((p) => p.folder === f).length, "folder"))}
          </aside>
          <section className="panel pls-main">
            <div className="pls-filters">
              <label className="libf-field"><span className="rf-label">Carte</span>
                <select className="rf-select" value={map} onChange={(e) => set("map", e.target.value)} aria-label="Carte">
                  <option value="">Toutes</option>{[...new Set(all.flatMap((p) => p.maps))].sort().map((m) => <option key={m} value={m}>{mapName(m)}</option>)}
                </select></label>
              {tags.length > 0 && (
                <label className="libf-field"><span className="rf-label">Étiquette</span>
                  <select className="rf-select" value={tag} onChange={(e) => set("tag", e.target.value)} aria-label="Étiquette de playlist">
                    <option value="">Toutes</option>{tags.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select></label>
              )}
            </div>
            <div className="pls-table" role="table">
              <div className="pls-thead" role="row"><span /><span>Playlist</span><span>Dossier</span><span>Cartes</span><span className="th-right">Rounds</span><span>Auteur</span><span>Mis à jour</span></div>
              {shown.map((p) => (
                <div key={p.id} className="pls-row" role="row" data-testid="playlist-card" onClick={(e) => { if (!(e.target as HTMLElement).closest("button, a")) nav(`/playlists/${p.id}`); }}>
                  <button type="button" className={`pls-star ${p.favorite ? "on" : ""}`} onClick={() => star(p)} aria-pressed={p.favorite} aria-label={p.favorite ? `Retirer ${p.name} des favoris` : `Mettre ${p.name} en favori`} data-testid="pls-star"><Icon name="star" size={15} /></button>
                  <Link to={`/playlists/${p.id}`} className="pls-name-cell">
                    <span className="pls-name">{p.name}</span>
                    {(p.description || p.tags.length > 0) && <span className="pls-desc">{p.description}{p.tags.map((t) => <span key={t} className="mlab">#{t}</span>)}</span>}
                  </Link>
                  <span className="pls-cell">{p.folder ? <span className="mlab folder">{p.folder}</span> : <span className="rf-dim">—</span>}</span>
                  <span className="pls-cell pls-maps">{p.maps.length ? p.maps.map((m) => <span key={m} className="mlab">{mapName(m)}</span>) : <span className="rf-dim">—</span>}</span>
                  <span className="pls-cell mono th-right">{p.count}</span>
                  <span className="pls-cell">{p.author ?? <span className="rf-dim">—</span>}</span>
                  <span className="pls-cell rf-dim">{formatDate(p.updated_at)}</span>
                </div>
              ))}
              {!shown.length && <p className="cm-empty">Aucune playlist ne correspond.</p>}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

export function PlaylistPage() {
  const id = Number(useParams().playlistId);
  const qc = useQueryClient();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ["playlist", id], queryFn: () => api.playlist(id), retry: false });
  const [confirm, setConfirm] = useState(false);
  const [editing, setEditing] = useState(false);
  const put = (d: PlaylistDetail) => { qc.setQueryData(["playlist", id], d); qc.invalidateQueries({ queryKey: ["playlists"] }); };
  const patch = async (p: Parameters<typeof api.updatePlaylist>[1]) => {
    await api.updatePlaylist(id, p);
    qc.invalidateQueries({ queryKey: ["playlist", id] });
    qc.invalidateQueries({ queryKey: ["playlists"] });
  };
  if (q.isLoading) return <div className="page"><Spinner /></div>;
  if (!q.data) return <EmptyState title="Playlist introuvable" />;
  const p = q.data;
  const first = playUrl(p.id, p.items, 0);
  return (
    <div className="page">
      <Link to="/playlists" className="back-link"><Icon name="back" />Playlists</Link>
      <header className="pl-hero panel">
        {editing ? <EditHead p={p} onSave={async (v) => { await patch(v); setEditing(false); }} onCancel={() => setEditing(false)} /> : (
          <div>
            <div className="eyebrow">Playlist{p.folder ? <> · <span className="mlab folder">{p.folder}</span></> : null}{p.author ? <span className="rf-dim"> · par {p.author}</span> : null}</div>
            <h1 className="display pl-name">
              <button type="button" className={`pls-star big ${p.favorite ? "on" : ""}`} onClick={() => patch({ favorite: !p.favorite })} aria-pressed={p.favorite} aria-label={p.favorite ? "Retirer des favoris" : "Mettre en favori"} data-testid="pl-star"><Icon name="star" size={20} /></button>
              {p.name}</h1>
            <div className="pl-sub">{p.description || <span className="mono">{p.count} round{p.count > 1 ? "s" : ""}</span>}{p.tags.map((t) => <span key={t} className="mlab">#{t}</span>)}</div>
          </div>
        )}
        <div className="lib-tools">
          {!editing && <Button variant="ghost" onClick={() => setEditing(true)} data-testid="pl-edit">Modifier</Button>}
          {confirm ? (<>
            <Button variant="danger" onClick={async () => { await api.deletePlaylist(id); qc.invalidateQueries({ queryKey: ["playlists"] }); nav("/playlists"); }}>Supprimer ?</Button>
            <Button variant="ghost" onClick={() => setConfirm(false)}>Non</Button>
          </>) : <Button variant="ghost" onClick={() => setConfirm(true)}><Icon name="trash" /></Button>}
          <Button variant="primary" disabled={!first} onClick={() => first && nav(first)}><Icon name="play" />Lire</Button>
        </div>
      </header>
      <section className="panel section">
        {!p.items.length ? <EmptyState icon="playlist" title="Playlist vide">Ajoutez des rounds depuis la page <Link className="pl-link" to="/rounds">Rounds</Link>, le replay, ou des matchs entiers depuis la <Link className="pl-link" to="/">bibliothèque</Link>.</EmptyState> : (
          <ol className="pli-list">
            {p.items.map((it, k) => (
              <ItemRow key={it.id} it={it} index={k} last={k === p.items.length - 1} url={playUrl(p.id, p.items, k)}
                onMove={async (to) => put(await api.updatePlaylistItem(id, it.id, { position: to }))}
                onNote={async (note) => put(await api.updatePlaylistItem(id, it.id, { note }))}
                onRemove={async () => put(await api.removePlaylistItem(id, it.id))} />
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function EditHead({ p, onSave, onCancel }: { p: PlaylistDetail; onSave: (v: { name: string; description: string; folder: string; tags: string[] }) => void; onCancel: () => void }) {
  const [name, setName] = useState(p.name), [desc, setDesc] = useState(p.description);
  const [folder, setFolder] = useState(p.folder), [tags, setTags] = useState(p.tags.join(", "));
  const lists = useQuery({ queryKey: ["playlists"], queryFn: api.playlists });
  const folders = [...new Set((lists.data ?? []).map((x) => x.folder).filter(Boolean))].sort().map((n) => ({ name: n }));
  return (
    <form className="pls-edit" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSave({ name: name.trim(), description: desc, folder, tags: tags.split(",").map((t) => t.trim()).filter(Boolean) }); }} data-testid="pl-edit-form">
      <input className="rf-select" value={name} onChange={(e) => setName(e.target.value)} aria-label="Nom" autoFocus />
      <input className="rf-select" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Description (facultative)" aria-label="Description" />
      <FolderPicker value={folder} onChange={setFolder} folders={folders} label="Dossier de la playlist" />
      <input className="rf-select" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="Étiquettes, séparées par des virgules" aria-label="Étiquettes" />
      <div className="lib-tools"><Button type="submit" variant="primary" size="sm">Enregistrer</Button><Button size="sm" variant="ghost" onClick={onCancel}>Annuler</Button></div>
    </form>
  );
}

function ItemRow({ it, index, last, url, onMove, onNote, onRemove }: {
  it: PlaylistItem; index: number; last: boolean; url: string | null;
  onMove: (to: number) => void; onNote: (n: string) => void; onRemove: () => void;
}) {
  const [note, setNote] = useState(it.note);
  const m = it.match, r = it.round;
  const name = (tid: number) => (m && tid === m.team_a.id ? m.team_a.name : m?.team_b.name ?? "");
  return (
    <li className="pli" data-testid="playlist-item">
      <span className="pli-num mono">{index + 1}</span>
      {m && r ? (
        <div className="pli-main">
          <span className="rf-map"><img src={`/maps/${m.map_name}.png`} alt="" loading="lazy" />{m.map_display_name}</span>
          <span className="pli-title">{m.team_a.name} vs {m.team_b.name} · <b>Round {it.round_number}</b></span>
          <span className="pli-sub">
            {r.winner_side && <span className={`rf-winner ${r.winner_side.toLowerCase()}`}>{name(r.winner_team_id!)}</span>}
            <span className="rf-dim"> · {END_REASON[r.end_reason ?? ""] ?? r.end_reason}</span>
          </span>
        </div>
      ) : <div className="pli-main rf-dim">Round {it.round_number} indisponible (démo supprimée ou en cours d'analyse)</div>}
      <input className="pli-note" placeholder="Note…" value={note} onChange={(e) => setNote(e.target.value)}
        onBlur={() => note !== it.note && onNote(note)} aria-label={`Note du round ${index + 1}`} />
      <div className="pli-actions">
        <Button size="sm" variant="ghost" disabled={index === 0} onClick={() => onMove(index - 1)} title="Monter" aria-label="Monter"><Icon name="up" /></Button>
        <Button size="sm" variant="ghost" disabled={last} onClick={() => onMove(index + 1)} title="Descendre" aria-label="Descendre"><Icon name="down" /></Button>
        <Button size="sm" variant="ghost" onClick={onRemove} title="Retirer" aria-label="Retirer"><Icon name="trash" /></Button>
        {url ? <Link className="btn btn-sm btn-primary" to={url} title="Lire depuis ce round"><Icon name="play" /></Link> : <span />}
      </div>
    </li>
  );
}
