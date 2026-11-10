import { useQuery } from "@tanstack/react-query";
import type { DeathReason } from "../../shared/api/types";
import { formatMoney } from "../../shared/format";
import { AIM_COLS } from "../match/AnalysisPanel";
import { Link, useParams } from "react-router-dom";
import { api } from "../../shared/api/client";
import { EmptyState } from "../../shared/ui/EmptyState";
import { Icon } from "../../shared/ui/Icon";
import { Spinner } from "../../shared/ui/Spinner";
import { ratingTone } from "../match/StatsPanels";
import { ECON_LABEL, EdgeRoleBadges, RoleBadges, useRoleLabels } from "./Filters";
import { ContextBar } from "../../shared/context/ContextBar";
import { useBaseline } from "../../shared/context/comparison";
import { useContextFilters } from "../../shared/context/useContextFilters";
import { Comp } from "../../shared/ui/Comp";
import { useUrlParams } from "../../shared/useUrlParams";
import { BuyTypesTab, IntroTab, KindsTab, MapsTab, RolesTab, Tile, WeaponsTab, f1, f2, p0 } from "./profile/ProfileTabs";
import "../match/match.css";
import "./players.css";

const TABS: [string, string][] = [["intro", "Intro"], ["roles", "Rôles"], ["weapons", "Armes"], ["buytypes", "Achats"], ["maps", "Cartes"], ["kinds", "Officiel vs entraînement"], ["details", "Détails"]];

export const REASON_LABEL: Record<DeathReason, string> = {
  untraded: "Non échangé", isolated: "Isolé", behind: "Pris à revers", blind: "Aveuglé", outnumbered: "En infériorité",
  utility: "Utilitaires non utilisés", opening: "Duel d'ouverture perdu", lost_cause: "Round déjà perdu", saveable: "Aurait dû sauver",
  side: "Pris de côté", unchecked: "Angle jamais regardé", dry: "Duel à sec",
};

/** Postes par carte (comme l'onglet Roles d'EDGE) : lieu tenu le plus souvent, rôle EDGE, rounds observés. */
function Positions({ positions }: { positions?: Record<string, { T: { role: string | null; poste: string | null; rounds: number; places?: Record<string, number> }; CT: { role: string | null; poste: string | null; rounds: number; places?: Record<string, number> } }> }) {
  const labels = useRoleLabels();
  const maps = useQuery({ queryKey: ["maps"], queryFn: api.maps, staleTime: Infinity });
  const rows = Object.entries(positions ?? {}).sort((a, b) => (b[1].T.rounds + b[1].CT.rounds) - (a[1].T.rounds + a[1].CT.rounds));
  if (!rows.length) return null;
  const name = (m: string) => maps.data?.find((x) => x.name === m)?.display_name ?? m.replace("de_", "");
  const share = (s: { poste: string | null; rounds: number; places?: Record<string, number> }) => s.poste && s.places?.[s.poste] ? `${Math.round((100 * s.places[s.poste]) / s.rounds)} % des rounds` : "";
  return (
    <section className="panel section" data-testid="player-positions">
      <h2 className="section-title">Postes par carte</h2>
      <table className="st-table pos-table">
        <thead><tr><th className="sb-name">Carte</th><th className="sb-name">T · rôle</th><th className="sb-name">T · poste</th><th>Rounds</th><th className="sb-name">CT · rôle</th><th className="sb-name">CT · poste</th><th>Rounds</th></tr></thead>
        <tbody>
          {rows.map(([m, s]) => (
            <tr key={m}>
              <td className="sb-name"><b>{name(m)}</b></td>
              <td className="sb-name">{s.T.role ? <span className="role-badge edge t"><span>{labels[s.T.role] ?? s.T.role}</span></span> : <span className="rf-dim">—</span>}</td>
              <td className="sb-name">{s.T.poste ?? <span className="rf-dim">polyvalent</span>} <small className="rf-dim">{share(s.T)}</small></td>
              <td className="mono">{s.T.rounds}</td>
              <td className="sb-name">{s.CT.role ? <span className="role-badge edge ct"><span>{labels[s.CT.role] ?? s.CT.role}</span></span> : <span className="rf-dim">—</span>}</td>
              <td className="sb-name">{s.CT.poste ?? <span className="rf-dim">polyvalent</span>} <small className="rf-dim">{share(s.CT)}</small></td>
              <td className="mono">{s.CT.rounds}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="st-legend">Poste = lieu où le joueur est le plus souvent entre 15 et 45 s (T) ou 10 et 30 s (CT) après le début du round ; rôle d'après son isolement (T) ou la stabilité de sa position (CT). Rien n'est attribué sous 6 rounds observés.</p>
    </section>
  );
}

export function PlayerPage() {
  const steamid = useParams().steamid!;
  const ctx = useContextFilters();
  const q = useQuery({ queryKey: ["player", steamid, ctx.key], queryFn: () => api.player(steamid, ctx.params), placeholderData: (prev) => prev, retry: false });
  const extras = useQuery({ queryKey: ["player-extras", ctx.map ?? "all", ctx.lib], queryFn: () => api.playerExtras({ map: ctx.map, ...ctx.lib }), placeholderData: (prev) => prev });
  const base = useBaseline(ctx, steamid);
  const S = base.stats, R = base.rounds;
  const x = extras.data?.[steamid];
  const [params, setParam] = useUrlParams();
  const tab = TABS.some(([k]) => k === params.get("tab")) ? params.get("tab")! : "intro";
  const profile = useQuery({ queryKey: ["player-profile", steamid, ctx.key], queryFn: () => api.playerProfile(steamid, ctx.params), placeholderData: (prev) => prev, retry: false });
  const maps = useQuery({ queryKey: ["maps"], queryFn: api.maps, staleTime: Infinity });
  const mapName = (m: string) => maps.data?.find((x) => x.name === m)?.display_name ?? m.replace("de_", "");
  if (q.isLoading) return <div className="page"><Spinner /></div>;
  const p = q.data;
  const pr = profile.data;
  return (
    <div className="page">
      <Link to={`/players?${ctx.search}`} className="back-link"><Icon name="back" />Joueurs</Link>
      {!p ? (<>
        <ContextBar ctx={ctx} steamid={steamid} />
        <EmptyState title="Aucune donnée">Ce joueur n'a pas de match pour ces filtres.</EmptyState>
      </>) : (<>
        <header className="pl-hero panel">
          <div>
            <div className="eyebrow">{p.team}</div>
            <h1 className="display pl-name">{p.name}</h1>
            <div className="pl-sub mono">{p.matches} match{p.matches > 1 ? "s" : ""} · {p.rounds} rounds</div>
            <div className="pl-roles"><EdgeRoleBadges edge={p.edge_roles} /><RoleBadges roles={p.roles} /></div>
          </div>
          <div className="pl-rating"><span>Rating</span><b className={`display ${ratingTone(p.rating)}`}>{p.rating.toFixed(2)}</b><Comp value={p.rating} base={S.rating} rounds={R} /></div>
        </header>
        <ContextBar ctx={ctx} steamid={steamid} />
        <nav className="tabs pf-tabs" role="tablist" data-testid="player-tabs">
          {TABS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={`tab ${tab === k ? "on" : ""}`} onClick={() => setParam("tab", k === "intro" ? null : k)}>{l}</button>)}
        </nav>
        {tab !== "details" && !pr && (profile.isLoading ? <Spinner /> : <EmptyState title="Profil indisponible">Pas de match pour ces filtres.</EmptyState>)}
        {tab === "intro" && pr && (
          <IntroTab pr={pr} mapName={mapName} S={S} R={R}>
            <div className="pl-grid">
              <section className="panel section">
                <h2 className="section-title">Général</h2>
                <div className="pl-tiles">
                  <Tile label="K / D / A" value={`${p.kills} / ${p.deaths} / ${p.assists}`} hint={`${p.diff > 0 ? "+" : ""}${p.diff}`} wide />
                  <Tile label="ADR" value={p.adr.toFixed(1)} comp={<Comp value={p.adr} base={S.adr} rounds={R} fmt={f1} compact />} />
                  <Tile label="KAST" value={`${p.kast.toFixed(1)}%`} comp={<Comp value={p.kast} base={S.kast} rounds={R} fmt={p0} compact />} />
                  <Tile label="HS" value={`${p.hs_pct.toFixed(0)}%`} comp={<Comp value={p.hs_pct} base={S.hs_pct} rounds={R} fmt={p0} compact />} />
                  <Tile label="Kills / round" value={p.kpr.toFixed(2)} comp={<Comp value={p.kpr} base={S.kpr} rounds={R} fmt={f2} compact />} />
                  <Tile label="Morts / round" value={p.dpr.toFixed(2)} comp={<Comp value={p.dpr} base={S.dpr} rounds={R} fmt={f2} lowIsBest compact />} />
                </div>
              </section>
              <section className="panel section">
                <h2 className="section-title">Entrée et trades</h2>
                <div className="pl-tiles">
                  <Tile label="Duels d'ouverture" value={`${p.opening_pct.toFixed(0)}%`} hint={`${p.opening_kills} FK · ${p.opening_deaths} FD`} comp={<Comp value={p.opening_pct} base={S.opening_pct} rounds={R} fmt={p0} compact />} />
                  <Tile label="Kills de trade" value={String(p.trade_kills)} />
                  <Tile label="Morts tradées" value={String(p.traded_deaths)} />
                  <Tile label="Dégâts utilitaires / round" value={(p.utility_dmg / Math.max(1, p.rounds)).toFixed(1)} comp={<Comp value={p.utility_dmg / Math.max(1, p.rounds)} base={S.utility_pr} rounds={R} fmt={f1} compact />} />
                </div>
              </section>
            </div>
          </IntroTab>
        )}
        {tab === "roles" && pr && <RolesTab pr={pr} me={p} mapName={mapName} S={S} R={R} />}
        {tab === "weapons" && pr && <WeaponsTab pr={pr} S={S} R={R} />}
        {tab === "buytypes" && pr && <BuyTypesTab pr={pr} S={S} R={R} />}
        {tab === "maps" && pr && <MapsTab pr={pr} S={S} R={R} />}
        {tab === "kinds" && pr && <KindsTab pr={pr} />}
        {tab === "details" && (<>
        <div className="pl-grid">
          <section className="panel section">
            <h2 className="section-title">Général</h2>
            <div className="pl-tiles">
              <Tile label="K / D / A" value={`${p.kills} / ${p.deaths} / ${p.assists}`} hint={`${p.diff > 0 ? "+" : ""}${p.diff}`} wide />
              <Tile label="ADR" value={p.adr.toFixed(1)} comp={<Comp value={p.adr} base={S.adr} rounds={R} fmt={f1} compact />} />
              <Tile label="KAST" value={`${p.kast.toFixed(1)}%`} comp={<Comp value={p.kast} base={S.kast} rounds={R} fmt={p0} compact />} />
              <Tile label="HS" value={`${p.hs_pct.toFixed(0)}%`} comp={<Comp value={p.hs_pct} base={S.hs_pct} rounds={R} fmt={p0} compact />} />
              <Tile label="Kills / round" value={p.kpr.toFixed(2)} comp={<Comp value={p.kpr} base={S.kpr} rounds={R} fmt={f2} compact />} />
              <Tile label="Morts / round" value={p.dpr.toFixed(2)} comp={<Comp value={p.dpr} base={S.dpr} rounds={R} fmt={f2} lowIsBest compact />} />
            </div>
          </section>
          <section className="panel section">
            <h2 className="section-title">Entrée et trades</h2>
            <div className="pl-tiles">
              <Tile label="Duels d'ouverture" value={`${p.opening_pct.toFixed(0)}%`} hint={`${p.opening_kills} FK · ${p.opening_deaths} FD`} comp={<Comp value={p.opening_pct} base={S.opening_pct} rounds={R} fmt={p0} compact />} />
              <Tile label="Kills de trade" value={String(p.trade_kills)} />
              <Tile label="Morts tradées" value={String(p.traded_deaths)} />
              <Tile label="Poses / désamorçages" value={`${p.plants} / ${p.defuses}`} />
            </div>
          </section>
          <section className="panel section" data-testid="economy">
            <h2 className="section-title">Selon l'économie</h2>
            <table className="st-table econ-table">
              <thead><tr><th className="sb-name">Contexte</th><th>Rounds</th><th>Rating</th><th>K/round</th><th>ADR</th><th>KAST</th><th>Ouvertures</th></tr></thead>
              <tbody>
                {["all", "buy", "eco", "vs_eco", "pistol"].filter((k) => p.economy[k]).map((k) => {
                  const e = p.economy[k];
                  return (
                    <tr key={k}><td>{ECON_LABEL[k]}</td><td className="mono">{e.rounds}</td>
                      <td className={`mono st-rating ${ratingTone(e.rating)}`}>{e.rating.toFixed(2)}</td><td className="mono">{e.kpr.toFixed(2)}</td>
                      <td className="mono">{e.adr.toFixed(1)}</td><td className="mono">{e.kast.toFixed(0)}%</td><td className="mono">{e.opening_pct.toFixed(0)}%</td></tr>
                  );
                })}
              </tbody>
            </table>
          </section>
          <section className="panel section">
            <h2 className="section-title">Clutchs</h2>
            <div className="pl-bars">
              {Object.entries(p.clutches).map(([k, c]) => (
                <div key={k} className="pl-bar-row">
                  <span className="mono">{k}</span>
                  <div className="cmp-bar"><i className="a" style={{ width: `${c.played ? (100 * c.won) / c.played : 0}%` }} /></div>
                  <span className="mono">{c.won}/{c.played}</span>
                </div>
              ))}
            </div>
          </section>
          <section className="panel section">
            <h2 className="section-title">Multi-kills et utilitaires</h2>
            <div className="pl-tiles">
              {(["2k", "3k", "4k", "5k"] as const).map((k) => <Tile key={k} label={k.toUpperCase()} value={String(p.multi[k])} />)}
              <Tile label="Dégâts utilitaires" value={String(p.utility_dmg)} hint={`${(p.utility_dmg / Math.max(1, p.rounds)).toFixed(1)} / round`} comp={<Comp value={p.utility_dmg / Math.max(1, p.rounds)} base={S.utility_pr} rounds={R} fmt={f1} compact />} />
              <Tile label="Adversaires flashés" value={String(p.enemies_flashed)} hint={`${p.blind_time.toFixed(1)} s`} />
              <Tile label="Flash assists" value={String(p.flash_assists)} />
            </div>
          </section>
        </div>
        {x && (
          <div className="pl-grid" data-testid="player-advanced">
            <section className="panel section">
              <h2 className="section-title">Impact et erreurs</h2>
              <div className="pl-tiles">
                <Tile label="Impact / round" value={`${x.impact > 0 ? "+" : ""}${x.impact.toFixed(1)}`} hint="points de probabilité de victoire" />
                <Tile label="Morts évitables" value={`${x.avoidable_pct.toFixed(0)}%`} hint={`${Math.round(x.avoidable_pr * x.rounds)} sur ${x.deaths} morts`} />
                <Tile label="Grenades perdues / round" value={formatMoney(x.unused_utility_pr)} />
              </div>
              <div className="pl-reasons">
                {(Object.entries(x.reasons) as [DeathReason, number][]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
                  <div key={k} className="pl-reason"><span>{REASON_LABEL[k]}</span>
                    <span className="an-bar"><i className="neg" style={{ width: `${(100 * v) / Math.max(1, x.deaths)}%` }} /></span>
                    <b className="mono">{Math.round((100 * v) / Math.max(1, x.deaths))}%</b></div>
                ))}
              </div>
              <p className="st-legend">Part des morts concernées par chaque raison (une mort peut en cumuler plusieurs). Côté et économie non filtrés.</p>
              {x.duels && Object.keys(x.duels).length > 0 && (
                <div className="pl-reasons" data-testid="player-duels">
                  <h3 className="an-sub">Duels selon l'écart de visée</h3>
                  {(["viseur", "champ", "cote", "dos"] as const).filter((z) => x.duels[z]).map((z) => {
                    const [w, l] = x.duels[z]!;
                    return (
                      <div key={z} className="pl-reason"><span>{{ viseur: "≤ 10°", champ: "10–45°", cote: "45–110°", dos: "> 110°" }[z]}</span>
                        <span className="an-bar"><i className="pos" style={{ width: `${(100 * w) / Math.max(1, w + l)}%` }} /></span>
                        <b className="mono">{w} gagnés · {l} perdus</b></div>
                    );
                  })}
                </div>
              )}
            </section>
            <section className="panel section">
              <h2 className="section-title">Visée</h2>
              <div className="pl-tiles">
                {AIM_COLS.map((c) => <Tile key={c.key} label={c.label} value={x.aim?.[c.key] == null ? "—" : `${x.aim[c.key]}${c.unit}`} hint={c.hint} />)}
                <Tile label="Tirs analysés" value={String(x.aim?.shots ?? 0)} />
              </div>
            </section>
          </div>
        )}
        <Positions positions={p.positions} />
        <section className="panel section">
          <h2 className="section-title">Matchs</h2>
          <table className="st-table">
            <thead><tr><th className="sb-name">Match</th><th className="sb-name">Carte</th><th>Score</th><th>Rating</th><th>K</th><th>D</th><th>A</th><th>+/−</th><th>ADR</th><th>KAST</th><th>HS</th></tr></thead>
            <tbody>
              {p.history.map((h) => {
                const m = h.match;
                if (!m) return null;
                const mine = m.team_a.id === h.team_id ? [m.score_a, m.score_b] : [m.score_b, m.score_a];
                const opp = m.team_a.id === h.team_id ? m.team_b.name : m.team_a.name;
                return (
                  <tr key={m.id} data-testid="history-row">
                    <td className="sb-name"><Link className="pl-link" to={`/matches/${m.id}?tab=players`}>vs {opp}</Link></td>
                    <td className="sb-name">{m.map_display_name}</td>
                    <td className={`mono ${mine[0] > mine[1] ? "pos" : mine[0] < mine[1] ? "neg" : ""}`}>{mine[0]}:{mine[1]}</td>
                    <td className={`mono st-rating ${ratingTone(h.rating)}`}>{h.rating.toFixed(2)}</td>
                    <td className="mono">{h.kills}</td><td className="mono">{h.deaths}</td><td className="mono">{h.assists}</td>
                    <td className={`mono ${h.diff > 0 ? "pos" : h.diff < 0 ? "neg" : ""}`}>{h.diff > 0 ? `+${h.diff}` : h.diff}</td>
                    <td className="mono">{h.adr.toFixed(1)}</td><td className="mono">{h.kast.toFixed(0)}%</td><td className="mono">{h.hs_pct.toFixed(0)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
        </>)}
      </>)}
    </div>
  );
}
