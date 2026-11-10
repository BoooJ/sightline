import { usePrefetch } from "../../shared/api/prefetch";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../shared/api/client";
import { EmptyState } from "../../shared/ui/EmptyState";
import { Icon } from "../../shared/ui/Icon";
import { Skeleton } from "../../shared/ui/Skeleton";
import { COLS, ratingTone } from "../match/StatsPanels";
import { EdgeRoleBadges, RoleBadges } from "./Filters";
import { ContextBar } from "../../shared/context/ContextBar";
import { useBaseline } from "../../shared/context/comparison";
import { useContextFilters } from "../../shared/context/useContextFilters";
import "../match/match.css";
import "./players.css";

export function PlayersPage() {
  const ctx = useContextFilters();
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: string; desc: boolean }>({ key: "rating", desc: true });
  const prefetch = usePrefetch();
  const players = useQuery({ queryKey: ["players", ctx.key], queryFn: () => api.players(ctx.params), placeholderData: (prev) => prev });
  const base = useBaseline(ctx);
  const REF: Record<string, string> = { rating: "rating", adr: "adr", kast: "kast", hs: "hs_pct" };
  const col = COLS.find((c) => c.key === sort.key);
  const getter = sort.key === "matches" ? (p: { matches: number }) => p.matches : col!.get;
  const rows = (players.data ?? [])
    .filter((p) => !q || `${p.name} ${p.team}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (sort.desc ? getter(b) - getter(a) : getter(a) - getter(b)));
  const th = (key: string, label: string, title: string, lowIsBest = false) => (
    <th key={key} title={title} className={sort.key === key ? "sorted" : ""}>
      <button type="button" onClick={() => setSort({ key, desc: sort.key === key ? !sort.desc : !lowIsBest })}>
        {label}{sort.key === key && <i>{sort.desc ? "▾" : "▴"}</i>}
      </button>
    </th>
  );
  return (
    <div className="page pl-page">
      <div className="lib-head">
        <div>
          <div className="eyebrow">Joueurs</div>
          <h1 className="display">Statistiques des joueurs <span className="lib-count mono">{rows.length}</span></h1>
        </div>
        <label className="search"><Icon name="search" />
          <input placeholder="Rechercher un joueur ou une équipe…" value={q} onChange={(e) => setQ(e.target.value)} /></label>
      </div>
      <ContextBar ctx={ctx} roles />
      <section className="panel section" aria-busy={players.isFetching}>
        {players.isLoading ? <Skeleton rows={10} /> : !rows.length ? <EmptyState title="Aucun joueur">Importez des démos pour voir les statistiques.</EmptyState> : (
          <div className="st-tables">
            <table className="st-table">
              <thead><tr><th className="sb-name">Joueur</th><th className="sb-name">Équipe</th><th className="sb-name">Rôles</th>{th("matches", "Matchs", "Matchs joués")}
                {COLS.map((c) => th(c.key, c.label, c.title, c.lowIsBest))}</tr></thead>
              <tbody>
                {base.enabled && base.rounds > 0 && (
                  <tr className="st-ref" data-testid="players-reference" title="Référence de comparaison (moyenne pondérée par les rounds)">
                    <td className="sb-name">Référence</td>
                    <td className="sb-name pl-team">{base.settings.mode === "self" ? "forme passée" : `${base.baseline?.players ?? 0} joueurs`} · {base.rounds} rounds</td>
                    <td className="sb-name" /><td className="mono" />
                    {COLS.map((c) => <td key={c.key} className="mono">{REF[c.key] && base.stats[REF[c.key]] !== undefined ? (c.fmt ?? String)(base.stats[REF[c.key]]) : "—"}</td>)}
                  </tr>
                )}
                {rows.map((p) => (
                  <tr key={p.steamid} data-testid="player-row">
                    <td className="sb-name"><Link className="pl-link" to={`/players/${p.steamid}?${ctx.search}`} onPointerEnter={() => prefetch.player(p.steamid, ctx.key)} onFocus={() => prefetch.player(p.steamid, ctx.key)}>{p.name}</Link></td>
                    <td className="sb-name pl-team">{p.team}</td>
                    <td className="sb-name pl-rolecell"><EdgeRoleBadges edge={p.edge_roles} /><RoleBadges roles={p.roles} /></td>
                    <td className="mono">{p.matches}</td>
                    {COLS.map((c) => {
                      const v = c.get(p);
                      return <td key={c.key} className={`mono ${c.key === "rating" ? `st-rating ${ratingTone(v)}` : c.key === "diff" ? (v > 0 ? "pos" : v < 0 ? "neg" : "") : ""}`}>{(c.fmt ?? String)(v)}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
