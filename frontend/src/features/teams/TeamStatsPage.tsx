import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../shared/api/client";
import type { PlaybookRoundT, Side, TeamBaseline, TeamBlock, TeamMapStats, TeamPlayer } from "../../shared/api/types";
import { ContextBar } from "../../shared/context/ContextBar";
import { useComparison } from "../../shared/context/comparison";
import { useContextFilters } from "../../shared/context/useContextFilters";
import { useUrlParams } from "../../shared/useUrlParams";
import { Comp } from "../../shared/ui/Comp";
import { EmptyState } from "../../shared/ui/EmptyState";
import { Icon } from "../../shared/ui/Icon";
import { Spinner } from "../../shared/ui/Spinner";
import { ratingTone } from "../match/StatsPanels";
import { EdgeRoleBadges, useRoleLabels } from "../players/Filters";
import { EarlyHeat } from "../scouting/ScoutingPage";
import "../match/match.css";
import "../players/players.css";
import "../scouting/scouting.css";
import "./teamstats.css";

const TABS: [string, string][] = [["overview", "Vue d'ensemble"], ["players", "Joueurs"], ["positions", "Positions"], ["sites", "Sites"], ["maps", "Cartes"]];
const p0 = (v: number) => `${v.toFixed(0)}%`, f2 = (v: number) => v.toFixed(2), f1 = (v: number) => v.toFixed(1);

/** Indicateurs d'un bloc (une carte × un camp, ou le total), avec la référence d'équipe. */
const BLOCK: [string, keyof TeamBlock, (v: number) => string, string][] = [
  ["Pistols gagnés", "pistol_pct", p0, "Rounds pistol gagnés"],
  ["Premier kill", "opening_pct", p0, "Part des rounds où l'équipe fait le premier kill"],
  ["Morts tradées", "trade_pct", p0, "Part des morts vengées dans les 4 s"],
  ["4v5 gagnés", "v4_pct", p0, "Rounds gagnés après avoir perdu le premier duel"],
  ["5v4 gagnés", "v5_pct", p0, "Rounds gagnés après avoir gagné le premier duel"],
  ["Flash assists / round", "far", f2, "Adversaire aveuglé puis tué pendant l'effet"],
  ["Dégâts utilitaires / round", "udr", f1, "Dégâts des grenades par round"],
];

function useTeamBaseline(ctx: ReturnType<typeof useContextFilters>) {
  const { settings } = useComparison();
  const teams = settings.mode === "teams" ? settings.teams : [];
  const q = useQuery({ queryKey: ["team-baseline", teams, settings.months, ctx.params.side, ctx.params.map, ctx.params.econ, ctx.params.opp_econ, ctx.params.kind],
    queryFn: () => api.teamBaseline({ cmp_teams: teams.join(","), cmp_months: String(settings.months), side: ctx.params.side, map: ctx.params.map, econ: ctx.params.econ, opp_econ: ctx.params.opp_econ, kind: ctx.params.kind }),
    enabled: teams.length > 0, staleTime: 60_000 });
  return teams.length ? q.data : undefined;
}

function SideColumn({ label, side, b, base }: { label: string; side: Side; b?: TeamBlock; base?: TeamBaseline }) {
  return (
    <div className={`tst-side ${side.toLowerCase()}`}>
      <h3 className="ts-h3"><span className={side === "CT" ? "sc-ct" : "sc-t"}>{side}</span> {label}</h3>
      {!b ? <p className="st-legend">Aucun round.</p> : (<>
        <div className="tst-kpi"><b className="mono">{p0(b.win_pct)}</b><span>rounds gagnés · {b.won}/{b.rounds}</span></div>
        <ul className="tst-list">
          {BLOCK.map(([l, k, fmt, hint]) => (
            <li key={k} title={hint}><span>{l}</span><b className="mono">{fmt(Number(b[k]))}</b>
              {base && <Comp value={Number(b[k])} base={Number(base[k])} rounds={base.rounds} fmt={fmt} compact />}</li>
          ))}
        </ul>
      </>)}
    </div>
  );
}

function Overview({ s, base }: { s: ReturnType<typeof api.teamStats> extends Promise<infer T> ? T : never; base?: TeamBaseline }) {
  const labels = useRoleLabels();
  return (<>
    <section className="panel section">
      <h2 className="section-title">Camps</h2>
      <div className="tst-maps">
        {s.maps.map((m: TeamMapStats) => (
          <div key={m.map} className="tst-map panel" style={{ ["--radar" as string]: `url(/maps/${m.map}.png)` }} data-testid="tst-map">
            <div className="tst-map-head">
              <div><span className="eyebrow">{m.display_name}</span>
                <div className="tst-kpi big"><b className="mono">{p0(m.win_pct)}</b><span>rounds gagnés</span></div>
                {base && <Comp value={m.win_pct} base={base.win_pct} rounds={base.rounds} fmt={p0} />}
              </div>
              <div className="tst-kpi"><b className="mono">{m.rounds}</b><span>rounds joués · {m.matches} match{m.matches > 1 ? "s" : ""}</span></div>
            </div>
            <div className="tst-sides">
              <SideColumn label="attaque" side="T" b={m.sides.T} base={base} />
              <SideColumn label="défense" side="CT" b={m.sides.CT} base={base} />
            </div>
          </div>
        ))}
        {!s.maps.length && <p className="st-legend">Aucun round pour ces filtres.</p>}
      </div>
    </section>
    <section className="panel section">
      <h2 className="section-title">Joueurs</h2>
      <div className="tst-players">
        {s.players.map((p: TeamPlayer) => (
          <Link key={p.steamid} to={`/players/${p.steamid}`} className="tst-player panel" data-testid="tst-player">
            <b className="display tst-player-name">{p.name}</b>
            <span className="tst-player-roles">
              <span className="role-badge edge t"><b>T</b><span>{p.roles.t ? labels[p.roles.t] ?? p.roles.t : "—"}</span>{p.postes.t && <em>{p.postes.t}</em>}</span>
              <span className="role-badge edge ct"><b>CT</b><span>{p.roles.ct ? labels[p.roles.ct] ?? p.roles.ct : "—"}</span>{p.postes.ct && <em>{p.postes.ct}</em>}</span>
            </span>
            <span className={`tst-player-rating mono ${ratingTone(p.rating)}`}>{p.rating.toFixed(2)}</span>
            <span className="tst-player-stats mono">K/D {(p.dpr ? p.kpr / p.dpr : p.kills).toFixed(2)} · ADR {p.adr.toFixed(1)} · KPR {p.kpr.toFixed(2)} · DPR {p.dpr.toFixed(2)}</span>
          </Link>
        ))}
      </div>
    </section>
    <section className="panel section" data-testid="tst-overall">
      <h2 className="section-title">Statistiques globales</h2>
      <div className="pl-tiles">
        <div className="pl-tile"><span className="pl-tile-label">Cartes gagnées</span><b className="mono">{p0(s.map_win_pct)}</b><small className="mono">{s.won}/{s.matches}</small></div>
        <div className="pl-tile"><span className="pl-tile-label">Rounds gagnés</span><b className="mono">{p0(s.overall.win_pct)}</b><small className="mono">{s.overall.won}/{s.overall.rounds}</small>
          {base && <Comp value={s.overall.win_pct} base={base.win_pct} rounds={base.rounds} fmt={p0} compact />}</div>
        {BLOCK.map(([l, k, fmt]) => (
          <div key={k} className="pl-tile"><span className="pl-tile-label">{l}</span><b className="mono">{fmt(Number(s.overall[k]))}</b>
            {base && <Comp value={Number(s.overall[k])} base={Number(base[k])} rounds={base.rounds} fmt={fmt} compact />}</div>
        ))}
        <div className="pl-tile"><span className="pl-tile-label">Après pose gagnés</span><b className="mono">{p0(s.overall.post_plant_pct)}</b><small className="mono">{s.overall.post_plant_won}/{s.overall.plants} poses</small></div>
        <div className="pl-tile"><span className="pl-tile-label">Retakes gagnés</span><b className="mono">{p0(s.overall.retake_pct)}</b><small className="mono">{s.overall.retakes_won}/{s.overall.retakes}</small></div>
      </div>
      {base && <p className="st-legend">Référence : {base.n_teams} équipe{base.n_teams > 1 ? "s" : ""} de comparaison, {base.rounds} rounds.</p>}
    </section>
  </>);
}

function Players({ players }: { players: TeamPlayer[] }) {
  const avg = (k: (p: TeamPlayer) => number) => players.length ? players.reduce((s, p) => s + k(p) * p.rounds, 0) / Math.max(1, players.reduce((s, p) => s + p.rounds, 0)) : 0;
  const tot = (k: (p: TeamPlayer) => number) => players.reduce((s, p) => s + k(p), 0);
  const clutch = (p: TeamPlayer, k: string) => p.clutches[k] ?? { played: 0, won: 0 };
  return (<>
    <section className="panel section">
      <h2 className="section-title">Performance</h2>
      <table className="st-table pf-table" data-testid="tst-performance">
        <thead><tr><th className="sb-name">Joueur</th><th>Rating</th><th>KPR</th><th>K/D</th><th>DPR</th><th>ADR</th><th>KAST</th><th>UDR</th><th>FAR</th><th>HS</th><th>Rounds</th></tr></thead>
        <tbody>
          {players.map((p) => (
            <tr key={p.steamid}>
              <td className="sb-name"><Link className="pl-link" to={`/players/${p.steamid}`}>{p.name}</Link><div className="tst-cell-roles"><EdgeRoleBadges edge={{ t: { role: p.roles.t, poste: p.postes.t, rounds: p.rounds }, ct: { role: p.roles.ct, poste: p.postes.ct, rounds: p.rounds } }} compact /></div></td>
              <td className={`mono st-rating ${ratingTone(p.rating)}`}>{p.rating.toFixed(2)}</td><td className="mono">{p.kpr.toFixed(2)}</td>
              <td className="mono">{(p.dpr ? p.kpr / p.dpr : p.kills).toFixed(2)}</td><td className="mono">{p.dpr.toFixed(2)}</td><td className="mono">{p.adr.toFixed(1)}</td>
              <td className="mono">{p.kast.toFixed(0)}%</td><td className="mono">{(p.utility_dmg / Math.max(1, p.rounds)).toFixed(2)}</td>
              <td className="mono">{(p.flash_assists / Math.max(1, p.rounds)).toFixed(2)}</td><td className="mono">{p.hs_pct.toFixed(0)}%</td><td className="mono">{p.rounds}</td>
            </tr>
          ))}
          <tr className="st-ref"><td className="sb-name">Moyenne</td><td className="mono">{avg((p) => p.rating).toFixed(2)}</td><td className="mono">{avg((p) => p.kpr).toFixed(2)}</td>
            <td className="mono">{(avg((p) => p.dpr) ? avg((p) => p.kpr) / avg((p) => p.dpr) : 0).toFixed(2)}</td><td className="mono">{avg((p) => p.dpr).toFixed(2)}</td><td className="mono">{avg((p) => p.adr).toFixed(1)}</td>
            <td className="mono">{avg((p) => p.kast).toFixed(0)}%</td><td className="mono">{avg((p) => p.utility_dmg / Math.max(1, p.rounds)).toFixed(2)}</td><td className="mono">{avg((p) => p.flash_assists / Math.max(1, p.rounds)).toFixed(2)}</td>
            <td className="mono">{avg((p) => p.hs_pct).toFixed(0)}%</td><td className="mono">{tot((p) => p.rounds)}</td></tr>
        </tbody>
      </table>
    </section>
    <section className="panel section">
      <h2 className="section-title">Duels d'ouverture</h2>
      <table className="st-table pf-table" data-testid="tst-opening">
        <thead><tr><th className="sb-name">Joueur</th><th>Tentatives</th><th>Kills</th><th>Morts</th><th>K/D d'ouverture</th><th>Mort tradée</th><th>K+T / D</th><th>Round gagné après</th><th>Rounds</th></tr></thead>
        <tbody>
          {players.map((p) => { const o = p.opening; return (
            <tr key={p.steamid}><td className="sb-name">{p.name}</td>
              <td className="mono">{o.attempts_pct.toFixed(0)}% <small className="rf-dim">({o.attempts})</small></td>
              <td className="mono">{o.kill_pct.toFixed(0)}% <small className="rf-dim">({o.kills})</small></td>
              <td className="mono">{o.death_pct.toFixed(0)}% <small className="rf-dim">({o.deaths})</small></td>
              <td className="mono">{o.kd.toFixed(2)} <small className="rf-dim">({o.kills}/{o.deaths})</small></td>
              <td className="mono">{o.traded_pct.toFixed(0)}%</td><td className="mono">{o.ktd.toFixed(2)}</td><td className="mono">{o.won_after_kill_pct.toFixed(0)}%</td><td className="mono">{p.rounds}</td></tr>
          ); })}
          <tr className="st-ref"><td className="sb-name">Total</td><td className="mono">{tot((p) => p.opening.attempts)}</td><td className="mono">{tot((p) => p.opening.kills)}</td><td className="mono">{tot((p) => p.opening.deaths)}</td>
            <td className="mono">{(tot((p) => p.opening.deaths) ? tot((p) => p.opening.kills) / tot((p) => p.opening.deaths) : 0).toFixed(2)}</td><td /><td /><td /><td className="mono">{tot((p) => p.rounds)}</td></tr>
        </tbody>
      </table>
    </section>
    <section className="panel section">
      <h2 className="section-title">Clutchs</h2>
      <table className="st-table pf-table" data-testid="tst-clutch">
        <thead><tr><th className="sb-name">Joueur</th>{["1v1", "1v2", "1v3", "1v4", "1v5"].map((k) => <th key={k}>{k}</th>)}<th>Rounds</th></tr></thead>
        <tbody>
          {players.map((p) => (
            <tr key={p.steamid}><td className="sb-name">{p.name}</td>
              {["1v1", "1v2", "1v3", "1v4", "1v5"].map((k) => { const c = clutch(p, k); return <td key={k} className="mono">{c.played ? `${Math.round((100 * c.won) / c.played)}%` : "—"} <small className="rf-dim">({c.won}/{c.played})</small></td>; })}
              <td className="mono">{p.rounds}</td></tr>
          ))}
          <tr className="st-ref"><td className="sb-name">Total</td>
            {["1v1", "1v2", "1v3", "1v4", "1v5"].map((k) => { const w = tot((p) => clutch(p, k).won), n = tot((p) => clutch(p, k).played); return <td key={k} className="mono">{n ? `${Math.round((100 * w) / n)}%` : "—"} <small className="rf-dim">({w}/{n})</small></td>; })}
            <td className="mono">{tot((p) => p.rounds)}</td></tr>
        </tbody>
      </table>
    </section>
  </>);
}

function Positions({ teamId, ctx }: { teamId: number; ctx: ReturnType<typeof useContextFilters> }) {
  const labels = useRoleLabels();
  const q = useQuery({ queryKey: ["team-positions", teamId, ctx.lib, ctx.map ?? ""], queryFn: () => api.teamPositions(teamId, { ...ctx.lib, map: ctx.map }) });
  const sides: Side[] = ctx.side ? [ctx.side] : ["CT", "T"];
  const mapName = ctx.map;
  if (!mapName) return <EmptyState title="Choisissez une carte">Les positions de départ sont propres à chaque carte : sélectionnez-en une dans la barre.</EmptyState>;
  return (
    <div className="tst-positions">
      {sides.map((side) => (
        <section key={side} className="panel section" data-testid={`tst-positions-${side}`}>
          <h2 className="section-title"><span className={side === "CT" ? "sc-ct" : "sc-t"}>{side}</span> Positions de départ</h2>
          <div className="tst-pos-grid">
            <EarlyHeat mapName={mapName} teamId={teamId} side={side} />
            <table className="st-table pf-table">
              <thead><tr><th className="sb-name">Joueur</th><th className="sb-name">Poste</th><th className="sb-name">Rôle</th><th className="sb-name">Lieux</th><th>Rounds</th></tr></thead>
              <tbody>
                {(q.data ?? []).map((p) => { const s = p[side]; const places = Object.entries(s?.places ?? {}).sort((a, b) => b[1] - a[1]); return (
                  <tr key={p.steamid}><td className="sb-name"><b>{p.name}</b></td>
                    <td className="sb-name">{s?.poste ?? <span className="rf-dim">polyvalent</span>}</td>
                    <td className="sb-name">{s?.role ? labels[s.role] ?? s.role : "—"}</td>
                    <td className="sb-name tst-places">{places.slice(0, 4).map(([pl, n]) => <span key={pl} className="pill tst-place">{pl} <small className="mono">{s?.rounds ? Math.round((100 * n) / s.rounds) : 0}%</small></span>)}</td>
                    <td className="mono">{s?.rounds ?? 0}</td></tr>
                ); })}
              </tbody>
            </table>
          </div>
        </section>
      ))}
      <p className="st-legend">Lieu dominant entre 1:45 et 1:25 à l'horloge en CT (10 à 30 s de jeu), entre 1:40 et 1:10 en T (15 à 45 s) ; la heatmap montre les placements de 1:55 à 1:35.</p>
    </div>
  );
}

const TEMPO: [string, number, number][] = [["1:55–1:30", 0, 25], ["1:29–1:05", 25, 50], ["1:04–0:35", 50, 80], ["0:34–0:00", 80, 999]];

function Sites({ teamId, ctx }: { teamId: number; ctx: ReturnType<typeof useContextFilters> }) {
  const q = useQuery({ queryKey: ["playbook", teamId, ctx.map], queryFn: () => api.playbook(teamId, ctx.map!), enabled: !!ctx.map });
  const pb = q.data;
  const tempo = useMemo(() => {
    const rounds = (pb?.t.list ?? []).filter((r: PlaybookRoundT) => r.category !== "eco");
    const at = (r: PlaybookRoundT) => r.plant_s ?? r.contact_s;
    const n = rounds.length || 1;
    return { n: rounds.length, buckets: TEMPO.map(([l, a, b]) => ({ label: l, n: rounds.filter((r) => { const t = at(r); return t != null && t >= a && t < b; }).length })),
      none: rounds.filter((r) => at(r) == null).length, sites: ["A", "B"].map((s) => ({ site: s, n: rounds.filter((r) => r.site === s).length })), none_site: rounds.filter((r) => !r.site).length, total: n };
  }, [pb]);
  if (!ctx.map) return <EmptyState title="Choisissez une carte">Le tempo et les sites sont propres à chaque carte : sélectionnez-en une dans la barre.</EmptyState>;
  if (q.isLoading || !pb) return <Spinner />;
  return (
    <div className="pl-grid">
      <section className="panel section" data-testid="tst-tempo">
        <h2 className="section-title">Tempo d'attaque (T)</h2>
        <p className="st-legend">Quand l'attaque arrive sur le site (pose, sinon premier contact), sur {tempo.n} rounds hors eco.</p>
        <div className="tst-bars">
          {tempo.buckets.map((b) => (
            <div key={b.label} className="tst-bar"><span className="mono">{b.label}</span><div className="tst-track"><i style={{ width: `${(100 * b.n) / Math.max(1, tempo.n)}%` }} /></div><b className="mono">{Math.round((100 * b.n) / Math.max(1, tempo.n))}%</b><small className="rf-dim mono">{b.n}</small></div>
          ))}
          <div className="tst-bar"><span className="mono">jamais</span><div className="tst-track"><i className="dim" style={{ width: `${(100 * tempo.none) / Math.max(1, tempo.n)}%` }} /></div><b className="mono">{Math.round((100 * tempo.none) / Math.max(1, tempo.n))}%</b><small className="rf-dim mono">{tempo.none}</small></div>
        </div>
      </section>
      <section className="panel section" data-testid="tst-attempts">
        <h2 className="section-title">Sites attaqués (T)</h2>
        <div className="tst-bars">
          {tempo.sites.map((s) => (
            <div key={s.site} className="tst-bar"><span className="mono">Site {s.site}</span><div className="tst-track"><i style={{ width: `${(100 * s.n) / Math.max(1, tempo.n)}%` }} /></div><b className="mono">{Math.round((100 * s.n) / Math.max(1, tempo.n))}%</b><small className="rf-dim mono">{s.n}</small></div>
          ))}
          <div className="tst-bar"><span className="mono">aucun</span><div className="tst-track"><i className="dim" style={{ width: `${(100 * tempo.none_site) / Math.max(1, tempo.n)}%` }} /></div><b className="mono">{Math.round((100 * tempo.none_site) / Math.max(1, tempo.n))}%</b><small className="rf-dim mono">{tempo.none_site}</small></div>
        </div>
        <p className="st-legend">Après pose : {pb.t.avg_plant_s != null ? `pose en moyenne à ${Math.round(pb.t.avg_plant_s)} s` : "aucune pose"} · premier contact {pb.t.avg_contact_s != null ? `vers ${Math.round(pb.t.avg_contact_s)} s` : "—"}.</p>
      </section>
      <section className="panel section" data-testid="tst-defense">
        <h2 className="section-title">Défense des sites (CT)</h2>
        <table className="st-table pf-table">
          <thead><tr><th className="sb-name">Site</th><th>Attaqué</th><th>Tenu sans pose</th><th>Poses subies</th><th>Retakes gagnés</th></tr></thead>
          <tbody>
            {Object.entries(pb.ct.sites).map(([site, s]) => (
              <tr key={site}><td className="sb-name"><b>{site}</b></td><td className="mono">{s.attacked}</td><td className="mono">{s.hold_pct.toFixed(0)}% <small className="rf-dim">({s.held})</small></td><td className="mono">{s.plants}</td><td className="mono">{s.retake_pct.toFixed(0)}% <small className="rf-dim">({s.retakes_won})</small></td></tr>
            ))}
          </tbody>
        </table>
        <h3 className="ts-h3">Setups fréquents</h3>
        <ul className="tst-setups">
          {pb.ct.setups.slice(0, 6).map((g) => <li key={g.key}><span>{g.label}</span><b className="mono">{g.pct}%</b><small className="rf-dim mono">{g.n} r · {g.win_pct}% gagnés</small></li>)}
          {!pb.ct.setups.length && <li className="st-legend">Pas assez de rounds CT.</li>}
        </ul>
      </section>
    </div>
  );
}

function Maps({ maps }: { maps: TeamMapStats[] }) {
  const total = maps.reduce((s, m) => s + m.matches, 0) || 1;
  return (
    <section className="panel section">
      <table className="st-table pf-table" data-testid="tst-maps">
        <thead><tr><th className="sb-name">Carte</th><th>Jouée</th><th>Matchs</th><th>Cartes gagnées</th><th>Rounds gagnés</th><th>CT</th><th>T</th><th>Pistols</th><th>Rounds</th></tr></thead>
        <tbody>
          {maps.map((m) => (
            <tr key={m.map}><td className="sb-name"><b>{m.display_name}</b></td>
              <td className="mono">{Math.round((100 * m.matches) / total)}%</td><td className="mono">{m.matches}</td><td className="mono">{p0(m.map_win_pct)} <small className="rf-dim">({m.won}/{m.matches})</small></td>
              <td className="mono">{p0(m.win_pct)}</td><td className="mono">{m.sides.CT ? p0(m.sides.CT.win_pct) : "—"}</td><td className="mono">{m.sides.T ? p0(m.sides.T.win_pct) : "—"}</td>
              <td className="mono">{p0(m.pistol_pct)} <small className="rf-dim">({m.pistols_won}/{m.pistols})</small></td><td className="mono">{m.rounds}</td></tr>
          ))}
        </tbody>
      </table>
      <p className="st-legend">« Jouée » = part des matchs de la sélection sur cette carte. Les picks et bans de série ne sont pas connus des démos.</p>
    </section>
  );
}

export function TeamStatsPage() {
  const ctx = useContextFilters();
  const [params, set] = useUrlParams();
  const tab = TABS.some(([k]) => k === params.get("tab")) ? params.get("tab")! : "overview";
  const teams = useQuery({ queryKey: ["teams"], queryFn: api.teams, staleTime: 60_000 });
  const teamId = ctx.team;
  const stats = useQuery({ queryKey: ["team-stats", teamId, ctx.key], queryFn: () => api.teamStats(teamId!, ctx.params), enabled: !!teamId, placeholderData: (prev) => prev, retry: false });
  const base = useTeamBaseline(ctx);
  const s = stats.data;
  return (
    <div className="page">
      <div className="lib-head">
        <div><div className="eyebrow">Statistiques</div><h1 className="display">Stats d'équipe{s ? <> <span className="lib-count">{s.team.name}</span></> : ""}</h1></div>
        {teamId && <div className="lib-tools"><Link className="btn btn-ghost" to={`/scouting/${teamId}`}><Icon name="scout" />Fiche de scouting</Link></div>}
      </div>
      <ContextBar ctx={ctx} />
      {!teamId ? (
        <section className="panel section"><EmptyState icon="team" title="Choisissez une équipe">Sélectionnez une équipe de la bibliothèque dans la barre : la vôtre pour vous évaluer, un adversaire pour le préparer.</EmptyState>
          <div className="dash-pick"><select className="rf-select" value="" onChange={(e) => ctx.set("team", e.target.value)} aria-label="Équipe à analyser">
            <option value="">Choisir une équipe…</option>{teams.data?.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.matches})</option>)}</select></div>
        </section>
      ) : stats.isLoading ? <Spinner /> : !s ? <EmptyState title="Aucune donnée">Cette équipe n'a pas de match pour ces filtres.</EmptyState> : (<>
        <nav className="tabs" role="tablist" data-testid="tst-tabs">
          {TABS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={`tab ${tab === k ? "on" : ""}`} onClick={() => set("tab", k === "overview" ? null : k)}>{l}</button>)}
        </nav>
        {tab === "overview" && <Overview s={s} base={base} />}
        {tab === "players" && <Players players={s.players} />}
        {tab === "positions" && <Positions teamId={teamId} ctx={ctx} />}
        {tab === "sites" && <Sites teamId={teamId} ctx={ctx} />}
        {tab === "maps" && <Maps maps={s.maps} />}
      </>)}
    </div>
  );
}
