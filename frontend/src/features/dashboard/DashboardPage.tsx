import { useState } from "react";
import { Icon } from "../../shared/ui/Icon";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../shared/api/client";
import type { Dashboard, DeathReason } from "../../shared/api/types";
import { REASON_LABEL } from "../players/PlayerPage";
import { formatDate, weaponLabel } from "../../shared/format";
import { EmptyState } from "../../shared/ui/EmptyState";
import { Spinner } from "../../shared/ui/Spinner";
import { ratingTone } from "../match/StatsPanels";
import { ECON_LABEL, RoleBadges } from "../players/Filters";
import { useAuth } from "../team/auth";
import "../match/match.css";
import "../players/players.css";
import "./dashboard.css";

const LOCAL = "dashboard-player";
const loadLocal = () => { try { return localStorage.getItem(LOCAL); } catch { return null; } };
const saveLocal = (v: string) => { try { localStorage.setItem(LOCAL, v); } catch { /* stockage indisponible */ } };

/** Tableau de bord personnel (équivalent du Dashboard d'EDGE). */
export function DashboardPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const players = useQuery({ queryKey: ["players", "all", "all", "all", "all", {}], queryFn: () => api.players() });
  const [localSid, setLocalSid] = useState<string | null>(loadLocal);
  const sid = user?.steamid ?? localSid ?? undefined;
  const dash = useQuery({ queryKey: ["dashboard", sid], queryFn: () => api.dashboard(sid!), enabled: !!sid, retry: false });
  const choose = async (v: string) => {
    if (user) { await api.updateMe({ steamid: v || null }); qc.invalidateQueries({ queryKey: ["me"] }); }
    else { saveLocal(v); setLocalSid(v || null); }
  };
  const picker = (
    <select className="rf-select" value={sid ?? ""} onChange={(e) => void choose(e.target.value)} aria-label="Joueur suivi">
      <option value="">Choisir un joueur…</option>
      {players.data?.slice().sort((a, b) => a.name.localeCompare(b.name)).map((p) => <option key={p.steamid} value={p.steamid}>{p.name} · {p.team}</option>)}
    </select>
  );
  return (
    <div className="page">
      <div className="lib-head">
        <div><div className="eyebrow">Tableau de bord</div><h1 className="display">{dash.data ? dash.data.player.name : "Mon joueur"}</h1></div>
        {sid && <label className="rf-group"><span className="rf-label">Joueur suivi</span>{picker}</label>}
      </div>
      {!sid ? <section className="panel section"><EmptyState icon="user" title="Choisissez votre joueur">Le tableau de bord suit un joueur de la bibliothèque (le vôtre, en général). {user ? "Ce choix est lié à votre compte." : "Ce choix est mémorisé dans ce navigateur."}</EmptyState>
          <div className="dash-pick">{picker}</div></section>
        : dash.isLoading ? <Spinner /> : !dash.data ? <EmptyState title="Aucune donnée pour ce joueur" /> : <Dash d={dash.data} />}
    </div>
  );
}

function Dash({ d }: { d: Dashboard }) {
  const p = d.player;
  return (<>
    <header className="pl-hero panel">
      <div>
        <div className="eyebrow">{p.team}</div>
        <div className="pl-sub mono">{p.matches} match{p.matches > 1 ? "s" : ""} · {p.rounds} rounds · {p.kills} K / {p.deaths} D</div>
        <div className="pl-roles"><RoleBadges roles={d.roles} /></div>
        <Link className="pl-link dash-more" to={`/players/${p.steamid}`}>Fiche complète ›</Link>
      </div>
      <div className="dash-tiles">
        {[["ADR", p.adr.toFixed(1)], ["KAST", `${p.kast.toFixed(0)}%`], ["HS", `${p.hs_pct.toFixed(0)}%`], ["Ouvertures", `${p.opening_pct.toFixed(0)}%`]].map(([l, v]) => (
          <div key={l} className="pl-tile"><span className="pl-tile-label">{l}</span><b className="mono">{v}</b></div>
        ))}
      </div>
      <div className="pl-rating"><span>Rating</span><b className={`display ${ratingTone(p.rating)}`}>{p.rating.toFixed(2)}</b></div>
    </header>

    <LastMatch d={d} />
    <section className="panel section" data-testid="dash-trend">
      <h2 className="section-title">Rating par match</h2>
      <TrendChart trend={d.trend} />
    </section>

    <div className="dash-grid">
      <section className="panel section">
        <h2 className="section-title">Points forts</h2>
        <CompareList rows={d.strengths} empty="Aucun indicateur au-dessus de la moyenne." />
        <h2 className="section-title dash-gap">Axes de progrès</h2>
        <CompareList rows={d.weaknesses} empty="Aucun indicateur sous la moyenne." />
        <p className="st-legend">Comparaison à la moyenne des joueurs de la bibliothèque (10 rounds minimum).</p>
      </section>
      <section className="panel section">
        <h2 className="section-title">Cartes</h2>
        <Bars rows={d.maps.map((m) => ({ key: m.map, label: m.display_name, value: m.win_pct, max: 100, text: `${m.win_pct.toFixed(0)}% V · ${m.won}/${m.matches}`, sub: `rating ${m.rating.toFixed(2)}` }))} />
      </section>
      <section className="panel section">
        <h2 className="section-title">Armes</h2>
        <Bars rows={d.weapons.map((w) => ({ key: w.weapon, label: weaponLabel(w.weapon), value: w.share, max: Math.max(...d.weapons.map((x) => x.share)), text: `${w.kills} kills`, sub: `${w.hs_pct.toFixed(0)}% HS` }))} />
      </section>
      <section className="panel section">
        <h2 className="section-title">Selon l'économie</h2>
        <table className="st-table econ-table">
          <thead><tr><th className="sb-name">Contexte</th><th>Rounds</th><th>Rating</th><th>ADR</th></tr></thead>
          <tbody>{["all", "buy", "eco", "vs_eco", "pistol"].filter((k) => d.economy[k]).map((k) => (
            <tr key={k}><td>{ECON_LABEL[k]}</td><td className="mono">{d.economy[k].rounds}</td>
              <td className={`mono st-rating ${ratingTone(d.economy[k].rating)}`}>{d.economy[k].rating.toFixed(2)}</td><td className="mono">{d.economy[k].adr.toFixed(1)}</td></tr>
          ))}</tbody>
        </table>
      </section>
    </div>
  </>);
}

function CompareList({ rows, empty }: { rows: Dashboard["strengths"]; empty: string }) {
  if (!rows.length) return <p className="cm-empty">{empty}</p>;
  return (
    <ul className="dash-cmp">
      {rows.map((c) => (
        <li key={c.key}>
          <span>{c.label}</span>
          <span className="mono rf-dim">{fmt(c.key, c.value)} <small>moy. {fmt(c.key, c.average)}</small></span>
          <b className={`mono ${c.delta_pct > 0 ? "pos" : "neg"}`}>{c.delta_pct > 0 ? "▲" : "▼"} {Math.abs(c.delta_pct).toFixed(0)}%</b>
        </li>
      ))}
    </ul>
  );
}
const fmt = (key: string, v: number) => (["kast", "hs_pct", "opening_pct", "clutch_pct"].includes(key) ? `${v.toFixed(0)}%` : key === "adr" || key === "utility_pr" ? v.toFixed(1) : v.toFixed(2));

/** Barres horizontales (une seule série : couleur d'accent, valeurs en texte neutre). */
function Bars({ rows }: { rows: { key: string; label: string; value: number; max: number; text: string; sub?: string }[] }) {
  if (!rows.length) return <p className="cm-empty">Aucune donnée.</p>;
  return (
    <div className="dash-bars">
      {rows.map((r) => (
        <div key={r.key} className="dash-bar" title={`${r.label} : ${r.text}${r.sub ? ` · ${r.sub}` : ""}`}>
          <span className="dash-bar-label">{r.label}</span>
          <span className="dash-bar-track"><i style={{ width: `${Math.max(2, (100 * r.value) / Math.max(1e-9, r.max))}%` }} /></span>
          <span className="mono dash-bar-val">{r.text}{r.sub && <small>{r.sub}</small>}</span>
        </div>
      ))}
    </div>
  );
}

/** Courbe du rating par match, avec la référence 1,00 ; infobulle au survol de chaque match. */
function TrendChart({ trend }: { trend: Dashboard["trend"] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!trend.length) return <p className="cm-empty">Aucun match.</p>;
  const W = 900, H = 200, pad = { l: 40, r: 16, t: 14, b: 26 };
  const vals = trend.map((t) => t.rating);
  const lo = Math.min(0.5, ...vals) - 0.1, hi = Math.max(1.5, ...vals) + 0.1;
  const x = (i: number) => pad.l + (trend.length === 1 ? (W - pad.l - pad.r) / 2 : (i * (W - pad.l - pad.r)) / (trend.length - 1));
  const y = (v: number) => pad.t + ((hi - v) * (H - pad.t - pad.b)) / (hi - lo);
  const ticks = [0.5, 1, 1.5].filter((v) => v > lo && v < hi);
  const h = hover != null ? trend[hover] : null;
  return (
    <div className="dash-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Rating par match" onMouseLeave={() => setHover(null)}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className={v === 1 ? "dash-ref" : "dash-grid-line"} />
            <text x={pad.l - 8} y={y(v)} className="dash-axis" textAnchor="end" dominantBaseline="middle">{v.toFixed(1)}</text>
          </g>
        ))}
        {trend.length > 1 && <polyline points={trend.map((t, i) => `${x(i)},${y(t.rating)}`).join(" ")} className="dash-line" />}
        {trend.map((t, i) => (
          <g key={i} onMouseEnter={() => setHover(i)}>
            <rect x={x(i) - 14} y={pad.t} width={28} height={H - pad.t - pad.b} fill="transparent" />
            <circle cx={x(i)} cy={y(t.rating)} r={hover === i ? 6 : 4.5} className={`dash-dot ${t.won ? "won" : "lost"}`} />
          </g>
        ))}
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} className="dash-cross" />}
      </svg>
      {h && (
        <div className="dash-tip" style={{ left: `${(100 * x(hover!)) / W}%` }}>
          <b className={`mono ${ratingTone(h.rating)}`}>{h.rating.toFixed(2)}</b>
          <span>{h.won ? "Victoire" : "Défaite"} vs {h.opponent}</span>
          <small>{h.map} · {formatDate(h.date)} · ADR {h.adr.toFixed(0)}</small>
        </div>
      )}
      <p className="st-legend">Point plein : match gagné · point creux : match perdu · ligne pointillée : rating 1,00.</p>
    </div>
  );
}

/** Dernier match du joueur suivi : ses chiffres clés et un accès direct à « mes morts » dans l'analyse. */
function LastMatch({ d }: { d: Dashboard }) {
  const last = [...d.trend].reverse().find((t) => t.match_id);
  const an = useQuery({ queryKey: ["match-analysis", last?.match_id], queryFn: () => api.matchAnalysis(last!.match_id!), enabled: !!last?.match_id });
  if (!last?.match_id) return null;
  const me = an.data?.players.find((p) => p.steamid === d.player.steamid);
  const top = me ? (Object.entries(me.reasons) as [DeathReason, number][]).sort((a, b) => b[1] - a[1])[0] : undefined;
  return (
    <section className="panel section dash-last" data-testid="dash-last">
      <div>
        <div className="eyebrow">Dernier match · {formatDate(last.date)}</div>
        <h2 className="dash-last-title">{last.map.replace("de_", "")} contre {last.opponent} <span className={last.won ? "pos" : "neg"}>{last.won ? "victoire" : "défaite"}</span></h2>
      </div>
      <div className="dash-tiles">
        <div className="pl-tile"><span className="pl-tile-label">Rating</span><b className={`mono ${ratingTone(last.rating)}`}>{last.rating.toFixed(2)}</b></div>
        {me && <div className="pl-tile"><span className="pl-tile-label">Impact / round</span><b className={`mono ${me.impact >= 0 ? "pos" : "neg"}`}>{me.impact > 0 ? "+" : ""}{me.impact.toFixed(1)}</b></div>}
        {me && <div className="pl-tile"><span className="pl-tile-label">Morts évitables</span><b className="mono">{me.avoidable}/{me.deaths}</b></div>}
        {top && top[1] > 0 && <div className="pl-tile"><span className="pl-tile-label">Erreur la plus fréquente</span><b className="dash-reason">{REASON_LABEL[top[0]]} ({top[1]})</b></div>}
      </div>
      <div className="dash-last-actions">
        <Link className="btn btn-primary" to={`/matches/${last.match_id}?tab=analysis&player=${d.player.steamid}`} data-testid="review-my-deaths">Revoir mes morts</Link>
        <Link className="btn btn-ghost" to={`/matches/${last.match_id}/replay/1?reel=1`} data-testid="reel-my-deaths" title="Toutes mes morts du match à la suite dans le replay (5 s avant, 2 s après)"><Icon name="play" />Enchaîner mes morts</Link>
        <Link className="btn" to={`/matches/${last.match_id}/replay/1`}>Replay</Link>
      </div>
    </section>
  );
}
