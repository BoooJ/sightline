import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../shared/api/client";
import type { ScoutPlayerRow, ShortlistT } from "../../shared/api/types";
import { useUrlParams } from "../../shared/useUrlParams";
import { Button } from "../../shared/ui/Button";
import { EmptyState } from "../../shared/ui/EmptyState";
import { Icon } from "../../shared/ui/Icon";
import { Spinner } from "../../shared/ui/Spinner";
import { EdgeRoleBadges, useRoleLabels } from "../players/Filters";
import "../library/library.css";
import "../match/match.css";
import "../rounds/rounds.css";
import "./scouting.css";

const T_ROLES = ["lurk", "half_lurk", "pack", "t_allround"];
const CT_ROLES = ["anchor", "rotation", "ct_allround"];
const RECENT_KEY = "sl-scout-recent";
type Search = { map: string; role_t: string; role_ct: string; min_rating: string; min_matches: string; q: string };

/** Scouting Tool joueurs (comme EDGE) : recherche de joueurs de la bibliothèque par rôle recherché sur une carte, rating HLTV,
 *  rating relatif, matchs minimum ; recherches récentes ; shortlists. */
export function PlayerScoutPage() {
  const [params, set] = useUrlParams();
  const qc = useQueryClient();
  const labels = useRoleLabels();
  const maps = useQuery({ queryKey: ["maps"], queryFn: api.maps, staleTime: Infinity });
  const search: Search = { map: params.get("map") ?? "", role_t: params.get("role_t") ?? "", role_ct: params.get("role_ct") ?? "",
    min_rating: params.get("min_rating") ?? "", min_matches: params.get("min_matches") ?? "1", q: params.get("q") ?? "" };
  const [q, setQ] = useState(search.q);
  useEffect(() => { const t = setTimeout(() => { if (q !== search.q) set("q", q || undefined); }, 250); return () => clearTimeout(t); }, [q]);  // eslint-disable-line react-hooks/exhaustive-deps
  const res = useQuery({ queryKey: ["scout-players", search], queryFn: () => api.scoutPlayers({ map: search.map || undefined, role_t: search.role_t || undefined, role_ct: search.role_ct || undefined,
    min_rating: search.min_rating || undefined, min_matches: search.min_matches || undefined, q: search.q || undefined }), placeholderData: (p) => p });
  const lists = useQuery({ queryKey: ["shortlists"], queryFn: api.shortlists });
  const [recent, setRecent] = useState<Search[]>(() => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"); } catch { return []; } });
  useEffect(() => {
    if (!res.data) return;
    const key = JSON.stringify(search);
    setRecent((r) => { const next = [search, ...r.filter((x) => JSON.stringify(x) !== key)].slice(0, 10); try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* stockage indisponible */ } return next; });
  }, [res.data]);  // eslint-disable-line react-hooks/exhaustive-deps
  const [listName, setListName] = useState("");
  const [adding, setAdding] = useState<ScoutPlayerRow | null>(null);
  const [openList, setOpenList] = useState<number | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["shortlists"] });
  const mapName = (n: string) => maps.data?.find((m) => m.name === n)?.display_name ?? n;
  const describe = (s: Search) => [s.map ? mapName(s.map) : "Toutes cartes", s.role_t ? `T ${labels[s.role_t] ?? s.role_t}` : "", s.role_ct ? `CT ${labels[s.role_ct] ?? s.role_ct}` : "",
    s.min_rating ? `HLTV ≥ ${s.min_rating}` : "", s.min_matches && s.min_matches !== "1" ? `≥ ${s.min_matches} matchs` : "", s.q ? `« ${s.q} »` : ""].filter(Boolean).join(" · ");
  const inList = (sid: string) => (lists.data ?? []).filter((l) => l.items.some((i) => i.steamid === sid));
  const addTo = async (list: ShortlistT, p: ScoutPlayerRow) => { await api.addToShortlist(list.id, { steamid: p.steamid, name: p.name }); setAdding(null); refresh(); };
  const createAndAdd = async () => {
    const v = listName.trim(); if (!v) return;
    const l = await api.createShortlist(v); setListName("");
    if (adding) await addTo(l, adding); else refresh();
  };
  return (
    <div className="page">
      <div className="lib-head">
        <div><div className="eyebrow">Adversaires</div><h1 className="display">Scouting de joueurs</h1></div>
        <div className="lib-tools"><Link className="btn btn-ghost" to="/scouting"><Icon name="scout" />Scouting d'équipes</Link></div>
      </div>
      <section className="panel rf-panel">
        <div className="rf-row">
          <label className="rf-group"><span className="rf-label">Carte</span>
            <select className="rf-select" value={search.map} onChange={(e) => set("map", e.target.value || undefined)} aria-label="Carte recherchée" data-testid="ps-map">
              <option value="">Toutes</option>{maps.data?.map((m) => <option key={m.name} value={m.name}>{m.display_name}</option>)}
            </select></label>
          <label className="rf-group"><span className="rf-label">Rôle T recherché</span>
            <select className="rf-select" value={search.role_t} onChange={(e) => set("role_t", e.target.value || undefined)} aria-label="Rôle T recherché" disabled={!search.map} data-testid="ps-role-t">
              <option value="">Tous</option>{T_ROLES.map((r) => <option key={r} value={r}>{labels[r] ?? r}</option>)}
            </select></label>
          <label className="rf-group"><span className="rf-label">Rôle CT recherché</span>
            <select className="rf-select" value={search.role_ct} onChange={(e) => set("role_ct", e.target.value || undefined)} aria-label="Rôle CT recherché" disabled={!search.map} data-testid="ps-role-ct">
              <option value="">Tous</option>{CT_ROLES.map((r) => <option key={r} value={r}>{labels[r] ?? r}</option>)}
            </select></label>
          <label className="rf-group"><span className="rf-label">HLTV minimum</span>
            <input type="number" step={0.05} min={0} max={3} className="rf-select ps-num" value={search.min_rating} onChange={(e) => set("min_rating", e.target.value || undefined)} aria-label="HLTV minimum" placeholder="ex. 1.05" /></label>
          <label className="rf-group"><span className="rf-label">Matchs minimum</span>
            <input type="number" min={1} className="rf-select ps-num" value={search.min_matches} onChange={(e) => set("min_matches", e.target.value || undefined)} aria-label="Matchs minimum" /></label>
          <label className="rf-group"><span className="rf-label">Nom ou équipe</span>
            <input className="rf-select" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Nom ou équipe" placeholder="Rechercher…" /></label>
        </div>
        {!search.map && <p className="st-legend">Choisissez une carte pour filtrer par rôle recherché (rôles détectés sur cette carte).</p>}
        {recent.length > 1 && (
          <div className="rf-group"><span className="rf-label">Recherches récentes</span>
            <div className="map-pills">{recent.slice(0, 8).map((s, i) => <button key={i} type="button" className="pill" onClick={() => { set({ map: s.map || null, role_t: s.role_t || null, role_ct: s.role_ct || null, min_rating: s.min_rating || null, min_matches: s.min_matches !== "1" ? s.min_matches : null, q: s.q || null }); setQ(s.q); }}>{describe(s)}</button>)}</div></div>
        )}
      </section>
      <div className="ps-layout">
        <section className="panel section">
          <h2 className="section-title">Joueurs{res.data && <span className="rf-dim"> · {res.data.players.length} · rating moyen {res.data.mean_rating.toFixed(2)}</span>}</h2>
          {res.isLoading ? <Spinner /> : !res.data?.players.length ? <EmptyState icon="user" title="Aucun joueur ne correspond">Élargissez les critères ou importez d'autres démos.</EmptyState> : (
            <div className="table-wrap">
              <table className="sb-table ps-table" data-testid="ps-table">
                <thead><tr><th>Joueur</th><th>Équipe</th><th>Rôles{search.map ? ` (${mapName(search.map)})` : ""}</th><th>Matchs</th><th title="Rating HLTV 2.0">HLTV</th><th title="Rating moins la moyenne des joueurs listés">Relatif</th><th>ADR</th><th>KAST</th><th>Ouvert.</th><th /></tr></thead>
                <tbody>
                  {res.data.players.map((p) => (
                    <tr key={p.steamid} data-testid="ps-row">
                      <td className="sb-name"><Link className="pl-link" to={`/players/${p.steamid}`}>{p.name}</Link>{inList(p.steamid).length > 0 && <Icon name="star" size={12} />}</td>
                      <td>{p.team}</td>
                      <td><EdgeRoleBadges edge={p.edge_roles} compact /></td>
                      <td className="mono">{p.matches}</td>
                      <td className={`mono ${p.rating >= 1 ? "pos" : "neg"}`}>{p.rating.toFixed(2)}</td>
                      <td className={`mono ${p.relative >= 0 ? "pos" : "neg"}`}>{p.relative > 0 ? "+" : ""}{p.relative.toFixed(2)}</td>
                      <td className="mono">{p.adr.toFixed(0)}</td>
                      <td className="mono">{Math.round(p.kast <= 1 ? p.kast * 100 : p.kast)} %</td>
                      <td className="mono">{Math.round(p.opening_pct)} %</td>
                      <td><Button size="sm" variant="ghost" onClick={() => setAdding(adding?.steamid === p.steamid ? null : p)} aria-label={`Ajouter ${p.name} à une liste`} data-testid="ps-add"><Icon name="star" /></Button>
                        {adding?.steamid === p.steamid && (
                          <div className="pl-menu panel ps-menu" role="menu">
                            {(lists.data ?? []).map((l) => <button key={l.id} type="button" role="menuitem" onClick={() => addTo(l, p)}><span>{l.name}</span><span className="mono">{l.count}</span></button>)}
                            {!lists.data?.length && <div className="pl-menu-empty">Aucune liste.</div>}
                            <form className="pl-menu-new" onSubmit={(e) => { e.preventDefault(); void createAndAdd(); }}>
                              <input placeholder="Nouvelle liste…" value={listName} onChange={(e) => setListName(e.target.value)} aria-label="Nom de la nouvelle liste" />
                              <Button size="sm" type="submit" disabled={!listName.trim()}>Créer</Button>
                            </form>
                          </div>
                        )}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="st-legend">Relatif : rating moins la moyenne des joueurs affichés. Pays et région : non disponibles dans les démos.</p>
        </section>
        <aside className="panel section ps-lists" data-testid="ps-shortlists">
          <h2 className="section-title">Listes</h2>
          {!lists.data?.length && <p className="cm-empty">Aucune liste. Cliquez l'étoile d'un joueur pour en créer une.</p>}
          {lists.data?.map((l) => (
            <div key={l.id} className="ps-list" data-testid="ps-shortlist">
              <button type="button" className="ps-list-head" onClick={() => setOpenList(openList === l.id ? null : l.id)} aria-expanded={openList === l.id}><b>{l.name}</b><span className="mono rf-dim">{l.count} joueur{l.count > 1 ? "s" : ""}</span></button>
              {openList === l.id && (
                <div className="ps-list-body">
                  {!l.items.length && <p className="cm-empty">Vide.</p>}
                  {l.items.map((it) => (
                    <div key={it.id} className="ps-item" data-testid="ps-item">
                      <Link className="pl-link" to={`/players/${it.steamid}`}>{it.name || it.steamid}</Link>
                      <input className="pli-note" defaultValue={it.note} placeholder="Note…" aria-label={`Note sur ${it.name}`} onBlur={async (e) => { if (e.target.value !== it.note) { await api.addToShortlist(l.id, { steamid: it.steamid, note: e.target.value }); refresh(); } }} onKeyDown={(e) => e.stopPropagation()} />
                      <Button size="sm" variant="ghost" aria-label={`Retirer ${it.name}`} onClick={async () => { await api.removeFromShortlist(l.id, it.id); refresh(); }}><Icon name="trash" /></Button>
                    </div>
                  ))}
                  <Button size="sm" variant="ghost" onClick={async () => { await api.deleteShortlist(l.id); refresh(); }}>Supprimer la liste</Button>
                </div>
              )}
            </div>
          ))}
        </aside>
      </div>
    </div>
  );
}
