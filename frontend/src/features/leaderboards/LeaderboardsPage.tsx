import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import type { CareerStats, PlayerExtras } from "../../shared/api/types";
import { formatMoney } from "../../shared/format";
import { useUrlParams } from "../../shared/useUrlParams";
import { ContextBar } from "../../shared/context/ContextBar";
import { useContextFilters, type ContextState } from "../../shared/context/useContextFilters";
import { EmptyState } from "../../shared/ui/EmptyState";
import { Spinner } from "../../shared/ui/Spinner";
import { useBaseline } from "../../shared/context/comparison";
import { EdgeRoleBadges } from "../players/Filters";
import { ratingTone } from "../match/StatsPanels";
import "../match/match.css";
import "./leaderboards.css";

type Row = CareerStats & { x?: PlayerExtras };
type Metric = { key: string; label: string; hint: string; get: (r: Row) => number | null | undefined; fmt: (v: number) => string; lowIsBest?: boolean };

const f2 = (v: number) => v.toFixed(2), f1 = (v: number) => v.toFixed(1), p0 = (v: number) => `${v.toFixed(0)} %`, p1 = (v: number) => `${v.toFixed(1)} %`;
export const METRICS: Metric[] = [
  { key: "rating", label: "Rating", hint: "Rating (formule HLTV 1.0)", get: (r) => r.rating, fmt: f2 },
  { key: "impact", label: "Impact", hint: "Probabilité de victoire gagnée par round (points de %)", get: (r) => r.x?.impact, fmt: (v) => `${v > 0 ? "+" : ""}${v.toFixed(1)}` },
  { key: "adr", label: "ADR", hint: "Dégâts par round", get: (r) => r.adr, fmt: f1 },
  { key: "kpr", label: "Kills / round", hint: "Kills par round", get: (r) => r.kpr, fmt: f2 },
  { key: "kast", label: "KAST", hint: "Rounds avec kill, assist, survie ou mort échangée", get: (r) => r.kast, fmt: p0 },
  { key: "opening", label: "Duels d'ouverture", hint: "Duels d'ouverture gagnés", get: (r) => (r.opening_kills + r.opening_deaths ? r.opening_pct : null), fmt: p0 },
  { key: "hs", label: "Headshots", hint: "Kills à la tête", get: (r) => r.hs_pct, fmt: p0 },
  { key: "clutch", label: "Clutchs gagnés", hint: "Clutchs gagnés sur clutchs joués", get: (r) => (r.clutches_played ? (100 * r.clutches_won) / r.clutches_played : null), fmt: p0 },
  { key: "utility", label: "Dégâts utilitaires", hint: "Dégâts des grenades par round", get: (r) => r.utility_dmg / Math.max(1, r.rounds), fmt: f1 },
  { key: "avoidable", label: "Morts évitables", hint: "Part des morts jugées évitables (moins = mieux)", get: (r) => (r.x?.deaths ? r.x.avoidable_pct : null), fmt: p0, lowIsBest: true },
  { key: "unused", label: "Grenades perdues", hint: "Grenades encore en poche à la mort, par round (moins = mieux)", get: (r) => r.x?.unused_utility_pr, fmt: (v) => formatMoney(v), lowIsBest: true },
  { key: "accuracy", label: "Précision", hint: "Tirs qui touchent un adversaire", get: (r) => r.x?.aim?.accuracy, fmt: p1 },
  { key: "first_bullet", label: "Première balle", hint: "Précision de la première balle", get: (r) => r.x?.aim?.first_bullet, fmt: p1 },
  { key: "counter_strafe", label: "Tirs à l'arrêt", hint: "Premières balles tirées à l'arrêt (contre-strafe)", get: (r) => r.x?.aim?.counter_strafe, fmt: p1 },
  { key: "ttk", label: "Temps pour tuer", hint: "Du premier dégât au kill (moins = mieux)", get: (r) => r.x?.aim?.ttk_ms, fmt: (v) => `${Math.round(v)} ms`, lowIsBest: true },
];

const f0 = (v: number) => v.toFixed(0);
/** Colonnes du tableau principal (comme le classement PRO d'EDGE) ; `base` = clé de la référence de comparaison. */
const COLUMNS: (Metric & { base?: string })[] = [
  { key: "rating", label: "HLTV", hint: "Rating (formule HLTV 1.0)", get: (r) => r.rating, fmt: f2, base: "rating" },
  { key: "adr", label: "ADR", hint: "Dégâts par round", get: (r) => r.adr, fmt: f1, base: "adr" },
  { key: "kd", label: "K/D", hint: "Kills par mort", get: (r) => (r.dpr ? r.kpr / r.dpr : r.kills), fmt: f2 },
  { key: "kpr", label: "KPR", hint: "Kills par round", get: (r) => r.kpr, fmt: f2, base: "kpr" },
  { key: "dpr", label: "DPR", hint: "Morts par round (moins = mieux)", get: (r) => r.dpr, fmt: f2, lowIsBest: true, base: "dpr" },
  { key: "kast", label: "KAST", hint: "Rounds avec kill, assist, survie ou mort échangée", get: (r) => r.kast, fmt: p0, base: "kast" },
  { key: "udr", label: "UDR", hint: "Dégâts utilitaires par round", get: (r) => r.utility_dmg / Math.max(1, r.rounds), fmt: f2, base: "utility_pr" },
  { key: "far", label: "FAR", hint: "Flash assists par round", get: (r) => r.flash_assists / Math.max(1, r.rounds), fmt: f2 },
  { key: "hs", label: "HS", hint: "Kills à la tête", get: (r) => r.hs_pct, fmt: p0, base: "hs_pct" },
  { key: "opening", label: "Ouvertures", hint: "Duels d'ouverture gagnés", get: (r) => (r.opening_kills + r.opening_deaths ? r.opening_pct : null), fmt: p0, base: "opening_pct" },
  { key: "impact", label: "Impact", hint: "Probabilité de victoire gagnée par round (points de %)", get: (r) => r.x?.impact, fmt: (v) => `${v > 0 ? "+" : ""}${v.toFixed(1)}` },
  { key: "clutch", label: "Clutchs", hint: "Clutchs gagnés sur clutchs joués", get: (r) => (r.clutches_played ? (100 * r.clutches_won) / r.clutches_played : null), fmt: p0, base: "clutch_pct" },
  { key: "mk", label: "MK", hint: "Rounds à 3 kills ou plus", get: (r) => r.multi["3k"] + r.multi["4k"] + r.multi["5k"], fmt: f0 },
  { key: "avoidable", label: "Morts évitables", hint: "Part des morts jugées évitables (moins = mieux)", get: (r) => (r.x?.deaths ? r.x.avoidable_pct : null), fmt: p0, lowIsBest: true },
  { key: "unused", label: "Grenades perdues", hint: "Grenades encore en poche à la mort, par round (moins = mieux)", get: (r) => r.x?.unused_utility_pr, fmt: (v) => formatMoney(v), lowIsBest: true },
  { key: "accuracy", label: "Précision", hint: "Tirs qui touchent un adversaire", get: (r) => r.x?.aim?.accuracy, fmt: p1 },
  { key: "first_bullet", label: "1re balle", hint: "Précision de la première balle", get: (r) => r.x?.aim?.first_bullet, fmt: p1 },
  { key: "counter_strafe", label: "À l'arrêt", hint: "Premières balles tirées à l'arrêt", get: (r) => r.x?.aim?.counter_strafe, fmt: p1 },
  { key: "ttk", label: "TTK", hint: "Temps pour tuer (moins = mieux)", get: (r) => r.x?.aim?.ttk_ms, fmt: (v) => `${Math.round(v)} ms`, lowIsBest: true },
];
const DEFAULT_COLUMNS = ["rating", "adr", "kd", "kpr", "dpr", "kast", "udr", "far"];
const COLS_KEY = "sl-lb-columns", PIN_KEY = "sl-lb-pinned";
const loadList = (k: string, fallback: string[]) => { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as string[]) : fallback; } catch { return fallback; } };
const saveList = (k: string, v: string[]) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* stockage indisponible */ } };

/** Tableau principal : rang, joueur avec rôles, colonnes choisies, tri, top N, épinglés en tête. */
function Table({ rows, minRounds, ctx }: { rows: Row[]; minRounds: number; ctx: ContextState }) {
  const [params, set] = useUrlParams();
  const [cols, setCols] = useState<string[]>(() => loadList(COLS_KEY, DEFAULT_COLUMNS).filter((k) => COLUMNS.some((c) => c.key === k)));
  const [pinned, setPinned] = useState<string[]>(() => loadList(PIN_KEY, []));
  const [adding, setAdding] = useState(false);
  const base = useBaseline(ctx);
  const orderBy = COLUMNS.find((c) => c.key === params.get("order_by")) ?? COLUMNS[0];
  const dir = params.get("dir") === "asc" ? "asc" : "desc";
  const top = Number(params.get("top") ?? 20);
  const update = (next: string[]) => { setCols(next); saveList(COLS_KEY, next); };
  const togglePin = (sid: string) => { const next = pinned.includes(sid) ? pinned.filter((x) => x !== sid) : [...pinned, sid]; setPinned(next); saveList(PIN_KEY, next); };
  const active = COLUMNS.filter((c) => cols.includes(c.key));
  const ranked = useMemo(() => {
    const ok = rows.filter((r) => r.rounds >= minRounds && typeof orderBy.get(r) === "number");
    const sign = (dir === "asc") !== !!orderBy.lowIsBest ? 1 : -1;
    return ok.sort((a, b) => sign * (orderBy.get(a)! - orderBy.get(b)!)).map((r, i) => ({ r, rank: i + 1 }));
  }, [rows, minRounds, orderBy, dir]);
  const shown = top > 0 ? ranked.slice(0, top) : ranked;
  const pinnedRows = ranked.filter(({ r }) => pinned.includes(r.steamid) && !shown.some((x) => x.r.steamid === r.steamid));
  const sortBy = (key: string) => { if (orderBy.key === key) set("dir", dir === "desc" ? "asc" : "desc"); else set({ order_by: key, dir: "desc" }); };
  const line = ({ r, rank }: { r: Row; rank: number }, pin: boolean) => (
    <tr key={r.steamid} className={pin ? "lb-pinned" : rank <= 3 ? "lb-podium" : ""} data-testid="lb-row">
      <td className="mono lb-rank-cell">{rank}</td>
      <td className="sb-name">
        <button type="button" className={`lb-pin ${pinned.includes(r.steamid) ? "on" : ""}`} onClick={() => togglePin(r.steamid)} aria-label={pinned.includes(r.steamid) ? `Désépingler ${r.name}` : `Épingler ${r.name}`} title="Épingler">★</button>
        <Link className="pl-link" to={`/players/${r.steamid}?${ctx.search}`}>{r.name}</Link> <span className="lb-team">{r.team}</span>
        <div className="lb-roles"><EdgeRoleBadges edge={r.edge_roles} compact /></div>
      </td>
      {active.map((c) => { const v = c.get(r); return <td key={c.key} className={`mono ${c.key === "rating" && typeof v === "number" ? `st-rating ${ratingTone(v)}` : ""}`}>{typeof v === "number" ? c.fmt(v) : "—"}</td>; })}
      <td className="mono rf-dim">{r.rounds}</td>
    </tr>
  );
  return (
    <section className="panel section lb-table-wrap">
      <div className="lb-toolbar">
        <label className="rf-group"><span className="rf-label">Top</span>
          <select className="rf-select ctx-narrow" value={top} onChange={(e) => set("top", e.target.value)} aria-label="Nombre de joueurs">
            {[10, 20, 30, 50].map((n) => <option key={n} value={n}>Top {n}</option>)}<option value={0}>Tous</option>
          </select></label>
        <label className="rf-group"><span className="rf-label">Rounds joués, au moins</span>
          <select className="rf-select ctx-narrow" value={minRounds} onChange={(e) => set("min", e.target.value)} data-testid="lb-min">
            {[1, 10, 20, 50, 100, 200].map((n) => <option key={n} value={n}>{n}</option>)}
          </select></label>
        <div className="rf-group lb-add"><span className="rf-label">Colonnes</span>
          <div className="lb-chips">
            {active.map((c) => <button key={c.key} type="button" className="pill on lb-chip" onClick={() => update(cols.filter((k) => k !== c.key))} title={`Retirer ${c.label}`}>{c.label} ✕</button>)}
            <button type="button" className="btn btn-sm" onClick={() => setAdding(!adding)} aria-expanded={adding} data-testid="lb-add-column">+ Ajouter une colonne</button>
          </div>
          {adding && (
            <div className="lb-menu panel" role="menu">
              {COLUMNS.filter((c) => !cols.includes(c.key)).map((c) => <button key={c.key} type="button" role="menuitem" className="lb-menu-item" onClick={() => { update([...cols, c.key]); setAdding(false); }}><b>{c.label}</b><small>{c.hint}</small></button>)}
              {COLUMNS.every((c) => cols.includes(c.key)) && <span className="st-legend">Toutes les colonnes sont affichées.</span>}
            </div>
          )}
        </div>
      </div>
      <div className="st-tables">
        <table className="st-table lb-table" data-testid="lb-table">
          <thead><tr>
            <th>#</th><th className="sb-name">Joueur</th>
            {active.map((c) => <th key={c.key} title={c.hint} className={orderBy.key === c.key ? "sorted" : ""}><button type="button" onClick={() => sortBy(c.key)}>{c.label}{orderBy.key === c.key && <i>{dir === "desc" ? "▾" : "▴"}</i>}</button></th>)}
            <th title="Rounds joués">Rounds</th>
          </tr></thead>
          <tbody>
            {base.enabled && base.rounds > 0 && (
              <tr className="st-ref" data-testid="lb-reference"><td /><td className="sb-name">Référence <span className="lb-team">{base.rounds} rounds</span></td>
                {active.map((c) => <td key={c.key} className="mono">{c.base && base.stats[c.base] !== undefined ? c.fmt(base.stats[c.base]) : "—"}</td>)}<td /></tr>
            )}
            {pinnedRows.map((x) => line(x, true))}
            {shown.map((x) => line(x, pinned.includes(x.r.steamid)))}
            {!shown.length && <tr><td colSpan={active.length + 3} className="st-legend">Aucun joueur avec au moins {minRounds} rounds.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="st-legend">{ranked.length} joueur{ranked.length > 1 ? "s" : ""} classé{ranked.length > 1 ? "s" : ""} · tri : {orderBy.label} · les épinglés (★) restent en tête avec leur rang.</p>
    </section>
  );
}

function useRows(ctx: ContextState) {
  const players = useQuery({ queryKey: ["players", ctx.key], queryFn: () => api.players(ctx.params), placeholderData: (prev) => prev });
  const extras = useQuery({ queryKey: ["player-extras", ctx.map ?? "all", ctx.lib], queryFn: () => api.playerExtras({ map: ctx.map, ...ctx.lib }), placeholderData: (prev) => prev });
  const rows = useMemo<Row[]>(() => (players.data ?? []).map((p) => ({ ...p, x: extras.data?.[p.steamid] })), [players.data, extras.data]);
  return { rows, loading: players.isLoading };
}

function ranked(rows: Row[], m: Metric, minRounds: number) {
  return rows.filter((r) => r.rounds >= minRounds && typeof m.get(r) === "number")
    .sort((a, b) => (m.lowIsBest ? m.get(a)! - m.get(b)! : m.get(b)! - m.get(a)!));
}

function Board({ m, rows, minRounds, full, onOpen }: { m: Metric; rows: Row[]; minRounds: number; full?: boolean; onOpen?: () => void }) {
  const list = ranked(rows, m, minRounds).slice(0, full ? undefined : 5);
  const vals = list.map((r) => m.get(r)!);
  const lo = Math.min(0, ...vals), hi = Math.max(...vals, 0.0001);
  const width = (v: number) => (m.lowIsBest ? (Math.min(...vals) / Math.max(v, 0.0001)) * 100 : ((v - lo) / (hi - lo || 1)) * 100);
  return (
    <section className={`panel lb-card ${full ? "full" : ""}`} data-testid={`board-${m.key}`}>
      <header className="lb-head">
        <h2 className="section-title" title={m.hint}>{m.label}</h2>
        {!full && onOpen && <button type="button" className="btn btn-sm btn-ghost" onClick={onOpen}>Tout voir</button>}
      </header>
      {full && <p className="st-legend">{m.hint}</p>}
      {!list.length ? <p className="st-legend">Pas assez de données.</p> : (
        <ol className="lb-list">
          {list.map((r, i) => (
            <li key={r.steamid} className={i < 3 ? `lb-top lb-${i + 1}` : ""}>
              <span className="lb-rank mono">{i + 1}</span>
              <Link className="pl-link lb-name" to={`/players/${r.steamid}`}>{r.name}</Link>
              <span className="lb-team">{r.team}</span>
              <span className="lb-bar"><i style={{ width: `${Math.max(2, width(m.get(r)!))}%` }} /></span>
              <b className="mono lb-val">{m.fmt(m.get(r)!)}</b>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Compare({ rows }: { rows: Row[] }) {
  const [params, set] = useUrlParams();
  const sorted = [...rows].sort((a, b) => a.name.localeCompare(b.name));
  const a = rows.find((r) => r.steamid === params.get("a")) ?? sorted[0], b = rows.find((r) => r.steamid === params.get("b")) ?? sorted[1];
  if (!a || !b) return <EmptyState title="Il faut au moins deux joueurs" />;
  const pick = (k: "a" | "b", v: Row) => (
    <select className="rf-select" value={v.steamid} onChange={(e) => set(k, e.target.value)} aria-label={k === "a" ? "Premier joueur" : "Second joueur"} data-testid={`cmp-${k}`}>
      {sorted.map((r) => <option key={r.steamid} value={r.steamid}>{r.name} ({r.team})</option>)}
    </select>
  );
  return (
    <section className="panel section lb-compare">
      <div className="lb-cmp-head">{pick("a", a)}<span className="st-legend">contre</span>{pick("b", b)}</div>
      <div className="cmp">
        <div className="cmp-head"><span>{a.name}</span><span>{b.name}</span></div>
        <p className="st-legend lb-cmp-sub">{a.matches} match{a.matches > 1 ? "s" : ""} · {a.rounds} rounds — {b.matches} match{b.matches > 1 ? "s" : ""} · {b.rounds} rounds</p>
        {METRICS.map((m) => {
          const va = m.get(a), vb = m.get(b);
          if (typeof va !== "number" || typeof vb !== "number") return null;
          const better = va === vb ? 0 : (va > vb) !== !!m.lowIsBest ? -1 : 1;
          // barres : part de chacun, inversée quand moins = mieux
          const sa = m.lowIsBest ? 1 / Math.max(va, 0.0001) : Math.max(0, va), sb = m.lowIsBest ? 1 / Math.max(vb, 0.0001) : Math.max(0, vb);
          const tot = sa + sb || 1;
          return (
            <div key={m.key} className="cmp-row" title={m.hint} data-testid="cmp-row">
              <span className={`cmp-val ${better < 0 ? "lead" : ""}`}>{m.fmt(va)}</span>
              <div className="cmp-mid"><span className="cmp-label">{m.label}</span>
                <div className="cmp-bar"><i className="a" style={{ width: `${(100 * sa) / tot}%` }} /><i className="b" style={{ width: `${(100 * sb) / tot}%` }} /></div></div>
              <span className={`cmp-val ${better > 0 ? "lead" : ""}`}>{m.fmt(vb)}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function LeaderboardsPage() {
  const [params, set] = useUrlParams();
  const tab = params.get("tab") === "compare" ? "compare" : params.get("tab") === "boards" ? "boards" : "table";
  const ctx = useContextFilters();
  const open = METRICS.find((m) => m.key === params.get("metric"));
  const minRounds = Number(params.get("min") ?? 20);
  const { rows, loading } = useRows(ctx);
  return (
    <div className="page">
      <div className="lib-head">
        <div><div className="eyebrow">Joueurs</div><h1 className="display">Classements</h1></div>
      </div>
      <nav className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "table"} className={`tab ${tab === "table" ? "on" : ""}`} onClick={() => set("tab")}>Tableau</button>
        <button type="button" role="tab" aria-selected={tab === "boards"} className={`tab ${tab === "boards" ? "on" : ""}`} onClick={() => set("tab", "boards")}>Par statistique</button>
        <button type="button" role="tab" aria-selected={tab === "compare"} className={`tab ${tab === "compare" ? "on" : ""}`} onClick={() => set("tab", "compare")}>Comparer deux joueurs</button>
      </nav>
      <ContextBar ctx={ctx} roles />
      <div className="lib-filters">
        {tab === "boards" && (
          <label className="rf-group"><span className="rf-label">Rounds joués, au moins</span>
            <select className="rf-select" value={minRounds} onChange={(e) => set("min", e.target.value)} data-testid="lb-min">
              {[1, 10, 20, 50, 100, 200].map((n) => <option key={n} value={n}>{n}</option>)}
            </select></label>
        )}
        {tab === "boards" && open && <button type="button" className="btn btn-sm" onClick={() => set("metric")}>Tous les classements</button>}
      </div>
      {loading ? <Spinner /> : !rows.length ? <EmptyState title="Aucun joueur" /> : tab === "table" ? <Table rows={rows} minRounds={minRounds} ctx={ctx} /> : tab === "compare" ? <Compare rows={rows} /> : open ? (
        <Board m={open} rows={rows} minRounds={minRounds} full />
      ) : (
        <div className="lb-grid">{METRICS.map((m) => <Board key={m.key} m={m} rows={rows} minRounds={minRounds} onOpen={() => set("metric", m.key)} />)}</div>
      )}
    </div>
  );
}
