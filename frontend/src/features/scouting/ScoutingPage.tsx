import { usePrefetch } from "../../shared/api/prefetch";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../shared/api/client";
import { formatDate } from "../../shared/format";
import type { ScoutMap, ScoutReport, SideBlock, SiteSplit } from "../../shared/api/types";
import { EmptyState } from "../../shared/ui/EmptyState";
import { Icon } from "../../shared/ui/Icon";
import { Spinner } from "../../shared/ui/Spinner";
import { Skeleton } from "../../shared/ui/Skeleton";
import { NADE } from "../grenades/GrenadesPage";
import { HeatCanvas } from "../heatmaps/HeatmapsPage";
import { COLS, ratingTone } from "../match/StatsPanels";
import "../grenades/grenades.css";
import "../heatmaps/heatmaps.css";
import "../match/match.css";
import { PlaybookSection } from "./PlaybookSection";
import { TimingsSection } from "./TimingsSection";
import "./scouting.css";

const BUY_LABEL: Record<string, string> = { pistol: "Pistol", eco: "Eco", semi: "Semi", force: "Force", full: "Full" };
const BUY_ORDER = ["pistol", "eco", "semi", "force", "full"];

export function ScoutingPage() {
  const [q, setQ] = useState("");
  const prefetch = usePrefetch();
  const teams = useQuery({ queryKey: ["scout-teams"], queryFn: api.scoutTeams });
  const rows = (teams.data ?? []).filter((t) => !q || t.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="page">
      <div className="lib-head">
        <div><div className="eyebrow">Adversaires</div><h1 className="display">Scouting <span className="lib-count mono">{rows.length}</span></h1></div>
        <div className="fc-head-actions">
          <Link className="btn btn-primary" to="/scouting/faceit" data-testid="faceit-entry"><Icon name="scout" />Équipe FACEIT (ESEA)</Link>
          <label className="search"><Icon name="search" /><input placeholder="Rechercher une équipe…" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        </div>
      </div>
      <p className="st-legend sc-intro">Chaque équipe présente dans vos démos a une fiche : ce qu'il faut retenir, leur attaque, leur défense, leurs joueurs. De là, préparez le match (rapport imprimable) ou le veto.</p>
      {teams.isLoading ? <Skeleton rows={4} /> : !rows.length ? <section className="panel section"><EmptyState title="Aucune équipe">Importez des démos pour scouter vos adversaires.</EmptyState></section> : (
        <div className="sc-teams">
          {rows.map((t) => {
            const losses = t.matches - t.wins;
            return (
              <article key={t.id} className="sc-team panel" onPointerEnter={() => prefetch.scout(t.id)}>
                <Link to={`/scouting/${t.id}`} className="sc-team-main" data-testid="scout-team" onFocus={() => prefetch.scout(t.id)}>
                  <span className="sc-team-initial display">{t.name.slice(0, 2).toUpperCase()}</span>
                  <span className="sc-team-head">
                    <span className="sc-team-name display">{t.name}</span>
                    <span className="sc-team-record"><b className={t.wins >= losses ? "pos" : "neg"}>{t.wins}V</b> <b className="rf-dim">·</b> <b className={losses > t.wins ? "neg" : ""}>{losses}D</b><small className="rf-dim"> · {t.matches} match{t.matches > 1 ? "s" : ""}{t.last_date ? ` · dernier le ${formatDate(t.last_date)}` : ""}</small></span>
                  </span>
                  {!!t.recent?.length && <span className="sc-form" aria-label="Forme récente">{t.recent.map((r, i) => <span key={i} className={`sc-chip ${r}`}>{r === "W" ? "V" : r === "L" ? "D" : "N"}</span>)}</span>}
                </Link>
                <div className="sc-team-maps">
                  {(t.map_list ?? []).slice(0, 6).map((m) => <Link key={m.map} to={`/scouting/${t.id}?map=${m.map}`} className="sc-mapchip" title={`${m.won} victoire${m.won > 1 ? "s" : ""} sur ${m.played} match${m.played > 1 ? "s" : ""}`}>{m.display_name} <b className={m.played && m.won / m.played >= 0.5 ? "pos" : "neg"}>{m.played ? Math.round((100 * m.won) / m.played) : 0} %</b><small>{m.played}</small></Link>)}
                </div>
                <div className="sc-team-actions">
                  <Link className="btn btn-sm btn-primary" to={`/scouting/${t.id}`}>Fiche</Link>
                  <Link className="btn btn-sm" to={`/match-prep`} title="Rapport de préparation imprimable">Préparer le match</Link>
                  <Link className="btn btn-sm btn-ghost" to={`/veto?b=${t.id}`}>Veto</Link>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Bar({ value, tone }: { value: number; tone?: "ct" | "t" }) {
  return <div className={`sc-bar ${tone ?? ""}`}><i style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></div>;
}

export function MapCard({ m, on, onClick }: { m: ScoutMap; on: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`sc-map panel ${on ? "on" : ""}`} onClick={onClick} style={{ ["--radar" as string]: `url(/maps/${m.map}.png)` }} data-testid="scout-map">
      <span className="sc-map-name display">{m.display_name}</span>
      <span className={`sc-map-pct display ${m.win_pct >= 50 ? "pos" : "neg"}`}>{m.win_pct.toFixed(0)}%</span>
      <span className="sc-map-rec mono">{m.won}V – {m.lost}D · {m.played} joué{m.played > 1 ? "s" : ""} · {m.rounds_won}:{m.rounds_lost}</span>
      <span className="sc-map-side"><b className="sc-ct">CT</b><Bar value={m.ct.win_pct} tone="ct" /><span className="mono">{m.ct.win_pct.toFixed(0)}%</span></span>
      <span className="sc-map-side"><b className="sc-t">T</b><Bar value={m.t.win_pct} tone="t" /><span className="mono">{m.t.win_pct.toFixed(0)}%</span></span>
    </button>
  );
}

function SideCard({ label, tone, s }: { label: string; tone: "ct" | "t"; s: SideBlock }) {
  return (
    <div className={`sc-side ${tone}`}>
      <div className="sc-side-head"><b className={`sc-${tone}`}>{label}</b><span className="display">{s.win_pct.toFixed(0)}%</span><small className="mono">{s.won}/{s.rounds} rounds</small></div>
      <dl className="sc-kv">
        <dt>Pistols</dt><dd className="mono">{s.pistols_won}/{s.pistols}</dd>
        <dt>Duels d'ouverture</dt><dd className="mono">{s.opening_pct.toFixed(0)}%</dd>
        {tone === "t" ? (<><dt>Rounds avec pose</dt><dd className="mono">{s.plants}/{s.rounds}</dd><dt>Gagnés après pose</dt><dd className="mono">{s.post_plant_won}/{s.plants}</dd></>)
          : (<><dt>Retakes gagnés</dt><dd className="mono">{s.retakes_won}/{s.retakes}</dd></>)}
      </dl>
      <div className="sc-buys">
        {BUY_ORDER.filter((b) => s.buy[b]).map((b) => (
          <div key={b} className="sc-buy"><span>{BUY_LABEL[b]}</span><Bar value={s.buy[b].win_pct} tone={tone} /><span className="mono">{s.buy[b].won}/{s.buy[b].played}</span></div>
        ))}
      </div>
    </div>
  );
}

function Sites({ total, byBuy }: { total: SiteSplit; byBuy: Record<string, SiteSplit> }) {
  const row = (label: string, s: SiteSplit) => (
    <div key={label} className="sc-site-row">
      <span>{label}</span>
      <div className="sc-stack">
        {(["A", "B", "none"] as const).map((k) => s[k] > 0 && <i key={k} className={`s-${k}`} style={{ flex: s[k] }} title={`${k === "none" ? "Pas de pose" : `Site ${k}`} : ${s[k]}`}>{s[k]}</i>)}
      </div>
      <span className="mono">{s.rounds}</span>
    </div>
  );
  return (
    <div className="sc-sites">
      <div className="sc-legend"><span><i className="s-A" />Site A</span><span><i className="s-B" />Site B</span><span><i className="s-none" />Pas de pose</span></div>
      {row("Total", total)}
      {BUY_ORDER.filter((b) => byBuy[b]).map((b) => row(BUY_LABEL[b], byBuy[b]))}
    </div>
  );
}

export function EarlyHeat({ mapName, teamId, side }: { mapName: string; teamId: number; side: "CT" | "T" }) {
  const maps = useQuery({ queryKey: ["maps"], queryFn: api.maps, staleTime: Infinity });
  const map = maps.data?.find((m) => m.name === mapName);
  const heat = useQuery({ queryKey: ["heatmap", mapName, "presence", side, String(teamId), undefined, undefined, "0-20"],
    queryFn: () => api.heatmap({ map: mapName, kind: "presence", side, team: String(teamId), t_from: "0", t_to: "20" }) });
  const lvl = map?.levels[0]?.name ?? "";
  return (
    <div className="sc-heat">
      <div className="sc-heat-head"><b className={side === "CT" ? "sc-ct" : "sc-t"}>{side}</b> placements 1:55 – 1:35
        <Link className="pl-link" to={`/heatmaps?map=${mapName}&team=${teamId}&side=${side}&win=0-20`}>Ouvrir ›</Link></div>
      {!map || !heat.data ? <Spinner /> : !(heat.data.levels[lvl] ?? []).length ? <p className="cm-empty">Aucune position enregistrée pour ce camp.</p> : <HeatCanvas map={map} level={lvl} kind="presence" cells={heat.data.levels[lvl] ?? []} bin={heat.data.bin} gamma={0.55} points={[]} />}
    </div>
  );
}

/** Toutes les données d'une carte (vue « avancée » de la page de scouting) : tendances, playbook, timings, heatmaps,
 * utilitaires et tableau des joueurs. */
export function ScoutData({ teamId, r, mapName }: { teamId: number; r: ScoutReport; mapName: string | undefined }) {
  const sel = r.maps.find((m) => m.map === mapName);
  const util = useQuery({ queryKey: ["scout-util", teamId, mapName], queryFn: () => api.scoutUtility(teamId, mapName!), enabled: !!mapName });
  const allMaps = useQuery({ queryKey: ["maps"], queryFn: api.maps, staleTime: Infinity });
  const timingMap = allMaps.data?.find((m) => m.name === mapName);
  const [sort, setSort] = useState("rating");
  const players = useMemo(() => {
    const col = COLS.find((c) => c.key === sort)!;
    return [...r.players].sort((a, b) => col.get(b) - col.get(a));
  }, [r, sort]);
  return (
    <div>
      {sel && (
        <section className="panel section sc-detail" data-testid="scout-detail">
          <h2 className="section-title">{sel.display_name} · tendances</h2>
          <div className="sc-detail-grid">
            <SideCard label="CT" tone="ct" s={sel.ct} />
            <SideCard label="T" tone="t" s={sel.t} />
            <div className="sc-side">
              <div className="sc-side-head"><b className="sc-t">T</b><span className="sc-small">Sites de pose par achat</span></div>
              <Sites total={sel.sites.total} byBuy={sel.sites.by_buy} />
            </div>
          </div>
          <h3 className="cmp-sub sc-left">Playbook</h3>
          <PlaybookSection teamId={teamId} mapName={sel.map} />
          <h3 className="cmp-sub sc-left">Carte des timings</h3>
          {timingMap && <TimingsSection teamId={teamId} map={timingMap} />}
          <div className="sc-heats">
            <EarlyHeat mapName={sel.map} teamId={teamId} side="T" />
            <EarlyHeat mapName={sel.map} teamId={teamId} side="CT" />
          </div>
          <h3 className="cmp-sub sc-left">Utilitaires récurrents</h3>
          <div className="sc-util">
            {(["T", "CT"] as const).map((side) => (
              <div key={side}>
                <div className="sc-heat-head"><b className={side === "CT" ? "sc-ct" : "sc-t"}>{side}</b>
                  <Link className="pl-link" to={`/grenades?map=${sel.map}&team=${teamId}&side=${side}&type=smoke,flash,molotov,incendiary,he`}>Voir sur la carte ›</Link></div>
                <ul className="gr-occ">
                  {(util.data?.[side] ?? []).map((lu, k) => (
                    <li key={k}><span><i className="sc-dot" style={{ background: NADE[lu.type].color }} /><b>{NADE[lu.type].label}</b> <small>{lu.players.join(", ")}</small></span><span className="mono">×{lu.count}</span></li>
                  ))}
                  {util.data && !util.data[side].length && <li className="cm-empty">Aucun lancer.</li>}
                </ul>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="panel section">
        <h2 className="section-title">Joueurs</h2>
        <div className="st-tables">
          <table className="st-table">
            <thead><tr><th className="sb-name">Joueur</th><th>Matchs</th>
              {COLS.map((c) => <th key={c.key} title={c.title} className={sort === c.key ? "sorted" : ""}><button type="button" onClick={() => setSort(c.key)}>{c.label}</button></th>)}</tr></thead>
            <tbody>
              {players.map((p) => (
                <tr key={p.steamid} data-testid="scout-player">
                  <td className="sb-name"><Link className="pl-link" to={`/players/${p.steamid}`}>{p.name}</Link></td>
                  <td className="mono">{p.matches}</td>
                  {COLS.map((c) => { const v = c.get(p); return <td key={c.key} className={`mono ${c.key === "rating" ? `st-rating ${ratingTone(v)}` : ""}`}>{(c.fmt ?? String)(v)}</td>; })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
