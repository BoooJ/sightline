import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { GroupStats, PlayerProfile, ProfileLine, ProfileRole, Side } from "../../../shared/api/types";
import { formatDate, weaponLabel } from "../../../shared/format";
import { Comp } from "../../../shared/ui/Comp";
import { ratingTone } from "../../match/StatsPanels";
import { useRoleLabels } from "../Filters";

export const f1 = (v: number) => v.toFixed(1), f2 = (v: number) => v.toFixed(2), p0 = (v: number) => `${v.toFixed(0)}%`;
const MIN = 6;  // rounds : en dessous, la ligne est grisée

export function Tile({ label, value, hint, wide, comp, tone }: { label: string; value: string; hint?: string; wide?: boolean; comp?: ReactNode; tone?: string }) {
  return <div className={`pl-tile ${wide ? "wide" : ""}`}><span className="pl-tile-label">{label}</span><b className={`mono ${tone ?? ""}`}>{value}</b>{hint && <small className="mono">{hint}</small>}{comp}</div>;
}

const SIDE_LABEL: Record<string, string> = { T: "T", CT: "CT" };

/** Carte « Rôle #1 / #2 » : poste, carte, camp, rating sur ces rounds, lien vers le classement filtré sur ce rôle. */
function RoleCard({ r, rank, mapName, base, baseRounds }: { r: ProfileRole; rank: number; mapName: (m: string) => string; base?: number; baseRounds: number }) {
  return (
    <div className="pf-card panel" data-testid="role-card">
      <span className="ctx-label">Rôle #{rank}</span>
      <b className="display pf-card-title">{mapName(r.map)} {r.poste}</b>
      <span className={`role-badge edge ${r.side.toLowerCase()}`}><b>{SIDE_LABEL[r.side]}</b>{r.role_label && <span>{r.role_label}</span>}</span>
      <div className="pf-card-stat"><span className="pl-tile-label">Rating</span><b className={`mono ${ratingTone(r.rating)}`}>{r.rating.toFixed(2)}</b>
        <Comp value={r.rating} base={base} rounds={baseRounds} compact /></div>
      <small className="rf-dim mono">{r.rounds} rounds</small>
      {r.role && <Link className="pl-link pf-card-link" to={`/leaderboards?role=${r.role}&map=${r.map}&side=${r.side}`}>Voir ce rôle au classement ›</Link>}
    </div>
  );
}

const SERIES: [keyof ProfileLine, string, (v: number) => string][] = [
  ["rating", "Rating", f2], ["adr", "ADR", f1], ["kpr", "KPR", f2], ["dpr", "DPR", f2], ["kast", "KAST", p0], ["utility_dmg", "UD", (v) => v.toFixed(0)],
];

/** Performance récente : une statistique au choix, un point par match (plein = gagné). */
export function RecentChart({ lines }: { lines: ProfileLine[] }) {
  const [key, setKey] = useState<keyof ProfileLine>("rating");
  const [hover, setHover] = useState<number | null>(null);
  const s = SERIES.find((x) => x[0] === key)!;
  if (!lines.length) return <p className="cm-empty">Aucun match.</p>;
  const vals = lines.map((l) => Number(l[key]));
  const W = 900, H = 200, pad = { l: 44, r: 16, t: 14, b: 26 };
  const lo = Math.min(...vals) * 0.9, hi = Math.max(...vals) * 1.1 || 1;
  const x = (i: number) => pad.l + (lines.length === 1 ? (W - pad.l - pad.r) / 2 : (i * (W - pad.l - pad.r)) / (lines.length - 1));
  const y = (v: number) => pad.t + ((hi - v) * (H - pad.t - pad.b)) / (hi - lo || 1);
  const h = hover != null ? lines[hover] : null;
  return (
    <div className="dash-chart">
      <div className="ts-seg pf-series" role="radiogroup" aria-label="Statistique">
        {SERIES.map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={key === k} className={key === k ? "on" : ""} onClick={() => setKey(k)}>{l}</button>)}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${s[1]} par match`} onMouseLeave={() => setHover(null)}>
        {[lo, (lo + hi) / 2, hi].map((v, i) => (
          <g key={i}><line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className="dash-grid-line" />
            <text x={pad.l - 8} y={y(v)} className="dash-axis" textAnchor="end" dominantBaseline="middle">{s[2](v)}</text></g>
        ))}
        {lines.length > 1 && <polyline points={lines.map((l, i) => `${x(i)},${y(Number(l[key]))}`).join(" ")} className="dash-line" />}
        {lines.map((l, i) => (
          <g key={i} onMouseEnter={() => setHover(i)}>
            <rect x={x(i) - 14} y={pad.t} width={28} height={H - pad.t - pad.b} fill="transparent" />
            <circle cx={x(i)} cy={y(Number(l[key]))} r={hover === i ? 6 : 4.5} className={`dash-dot ${l.won ? "won" : "lost"}`} />
          </g>
        ))}
      </svg>
      {h && (
        <div className="dash-tip" style={{ left: `${(100 * x(hover!)) / W}%` }}>
          <b className="mono">{s[2](Number(h[key]))}</b>
          <span>{h.won ? "Victoire" : "Défaite"} {h.score[0]}:{h.score[1]} vs {h.opponent}</span>
          <small>{h.display_name} · {formatDate(h.date)}</small>
        </div>
      )}
    </div>
  );
}

/** Progression : les N derniers matchs contre les N précédents (flèches = mieux / moins bien, pas un rang). */
export function Progression({ p }: { p: PlayerProfile["progression"] }) {
  if (!p.recent) return null;
  const rows: [string, keyof NonNullable<typeof p.recent>, (v: number) => string, boolean][] = [
    ["Rating", "rating", f2, false], ["ADR", "adr", f1, false], ["KPR", "kpr", f2, false], ["DPR", "dpr", f2, true], ["KAST", "kast", p0, false], ["UDR", "udr", f2, false],
  ];
  return (
    <section className="panel section" data-testid="progression">
      <h2 className="section-title">Progression</h2>
      {!p.previous ? <p className="st-legend">Il faut plus de {p.n} matchs pour comparer les {p.n} derniers aux {p.n} précédents.</p> : (
        <div className="pl-tiles">
          {rows.map(([label, k, fmt, low]) => {
            const a = Number(p.recent![k]), b = Number(p.previous![k]);
            const up = a > b, same = Math.abs(a - b) < 1e-9;
            const good = same ? "" : (up !== low) ? "pos" : "neg";
            return <Tile key={k} label={label} value={fmt(a)} tone={good} hint={`${same ? "=" : up ? "▲" : "▼"} ${fmt(b)} avant`} />;
          })}
        </div>
      )}
      <p className="st-legend">{p.recent.matches} match{p.recent.matches > 1 ? "s" : ""} récents ({p.recent.rounds} rounds){p.previous ? ` contre ${p.previous.matches} précédents (${p.previous.rounds} rounds)` : ""}.</p>
    </section>
  );
}

export function IntroTab({ pr, mapName, S, R, children }: { pr: PlayerProfile; mapName: (m: string) => string; S: Record<string, number>; R: number; children?: ReactNode }) {
  const bt = pr.buytypes.matrix;
  const cell = (own: string, opps: string[]) => {
    const rows = bt.filter((b) => b.own === own && opps.includes(b.opp));
    const rounds = rows.reduce((s, b) => s + b.rounds, 0);
    return rounds ? { rating: rows.reduce((s, b) => s + b.rating * b.rounds, 0) / rounds, rounds } : null;
  };
  const cards: [string, ReturnType<typeof cell>][] = [["Achat complet vs achat complet", cell("full", ["full"])], ["Achat complet vs demi / eco", cell("full", ["half", "eco"])], ["Rounds pistol", cell("pistol", ["pistol"])]];
  return (<>
    <div className="pf-intro">
      <section className="panel section">
        <h2 className="section-title">Introduction</h2>
        <div className="pf-intro-grid">
          <div className="pf-facts">
            <Tile label="Équipe" value={pr.intro.team} />
            <Tile label="Dernier match" value={pr.intro.last_match ? formatDate(pr.intro.last_match) : "—"} />
            <Tile label="Rounds gagnés" value={`${pr.intro.round_win_pct}%`} hint={`${pr.intro.rounds} rounds · ${pr.intro.matches} match${pr.intro.matches > 1 ? "s" : ""}`} />
          </div>
          <div className="pf-cards">
            {pr.intro.top_roles.length ? pr.intro.top_roles.map((r, i) => <RoleCard key={`${r.map}-${r.side}-${r.poste}`} r={r} rank={i + 1} mapName={mapName} base={S.rating} baseRounds={R} />)
              : <p className="st-legend">Pas encore assez de rounds à un même poste (6 au moins) pour nommer un rôle.</p>}
          </div>
        </div>
      </section>
      <section className="panel section">
        <h2 className="section-title">Performance par type d'achat</h2>
        <div className="pl-tiles">
          {cards.map(([label, c]) => <Tile key={label} label={label} value={c ? c.rating.toFixed(2) : "—"} tone={c ? ratingTone(c.rating) : ""} hint={c ? `${c.rounds} rounds` : "aucun round"} />)}
        </div>
      </section>
    </div>
    {children}
    <section className="panel section" data-testid="recent-performance">
      <h2 className="section-title">Performance récente</h2>
      <RecentChart lines={pr.recent} />
      <table className="st-table pf-recent">
        <thead><tr><th className="sb-name">Carte</th><th className="sb-name">Date</th><th className="sb-name">Adversaire</th><th>Score</th><th className="sb-name">Poste</th><th>Rating</th><th>K</th><th>D</th><th>ADR</th><th>Type</th></tr></thead>
        <tbody>
          {[...pr.recent].reverse().map((l) => (
            <tr key={l.match_id} data-testid="recent-row">
              <td className="sb-name"><Link className="pl-link" to={`/matches/${l.match_id}?tab=players`}>{l.display_name}</Link></td>
              <td className="sb-name mono">{formatDate(l.date)}</td>
              <td className="sb-name">{l.opponent}</td>
              <td className={`mono ${l.won ? "pos" : "neg"}`}>{l.score[0]}:{l.score[1]}</td>
              <td className="sb-name pf-poste">{[l.poste.t && `T ${l.poste.t}`, l.poste.ct && `CT ${l.poste.ct}`].filter(Boolean).join(" · ") || "—"}</td>
              <td className={`mono st-rating ${ratingTone(l.rating)}`}>{l.rating.toFixed(2)}</td>
              <td className="mono">{l.kills}</td><td className="mono">{l.deaths}</td><td className="mono">{l.adr.toFixed(1)}</td>
              <td className="sb-name rf-dim">{l.kind === "official" ? "Officiel" : "Entraînement"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
    <Progression p={pr.progression} />
  </>);
}

/** Toile d'araignée joueur vs référence (rating, ADR, K/D, KPR, KAST), chaque axe normalisé par le plus grand des deux. */
function Radar({ me, base, refRounds }: { me: GroupStats & { kd: number }; base?: Record<string, number>; refRounds: number }) {
  const axes: [string, number, number | undefined][] = [
    ["Rating", me.rating, base?.rating], ["ADR", me.adr, base?.adr], ["K/D", me.kd, base ? (base.dpr ? base.kpr / base.dpr : undefined) : undefined],
    ["KPR", me.kpr, base?.kpr], ["KAST", me.kast, base?.kast],
  ];
  const W = 320, C = 160, Rr = 118;
  const pt = (i: number, v: number) => { const a = -Math.PI / 2 + (i * 2 * Math.PI) / axes.length; return [C + Rr * v * Math.cos(a), C + Rr * v * Math.sin(a)]; };
  const norm = (v: number, r?: number) => { const m = Math.max(v, r ?? 0) * 1.15 || 1; return Math.min(1, v / m); };
  const mine = axes.map((a, i) => pt(i, norm(a[1], a[2])));
  const theirs = base ? axes.map((a, i) => pt(i, a[2] === undefined ? 0 : norm(a[2], a[1]))) : null;
  return (
    <div className="pf-radar" data-testid="role-radar">
      <svg viewBox={`0 0 ${W} ${W}`} role="img" aria-label="Joueur contre référence">
        {[0.25, 0.5, 0.75, 1].map((r) => <polygon key={r} points={axes.map((_, i) => pt(i, r).join(",")).join(" ")} className="pf-radar-grid" />)}
        {axes.map((_, i) => <line key={i} x1={C} y1={C} x2={pt(i, 1)[0]} y2={pt(i, 1)[1]} className="pf-radar-grid" />)}
        {theirs && <polygon points={theirs.map((p) => p.join(",")).join(" ")} className="pf-radar-ref" />}
        <polygon points={mine.map((p) => p.join(",")).join(" ")} className="pf-radar-me" />
        {axes.map((a, i) => { const [x, y] = pt(i, 1.18); return <text key={a[0]} x={x} y={y} className="pf-radar-label" textAnchor="middle" dominantBaseline="middle">{a[0]}</text>; })}
      </svg>
      <ul className="pf-radar-legend">
        {axes.map(([l, v, r]) => <li key={l}><span>{l}</span><b className="mono">{l === "KAST" ? p0(v) : l === "ADR" ? f1(v) : f2(v)}</b>{r !== undefined && <small className="mono">réf. {l === "KAST" ? p0(r) : l === "ADR" ? f1(r) : f2(r)}{refRounds < 20 ? " ·" : ""}</small>}</li>)}
      </ul>
    </div>
  );
}

export function RolesTab({ pr, me, mapName, S, R }: { pr: PlayerProfile; me: GroupStats; mapName: (m: string) => string; S: Record<string, number>; R: number }) {
  const labels = useRoleLabels();
  const [side, setSide] = useState<"" | Side>("");
  const rows = pr.roles.filter((r) => !side || r.side === side);
  return (<>
    <div className="pf-two">
      <section className="panel section">
        <h2 className="section-title">Performance par rôle</h2>
        <p className="st-legend">Le joueur (plein) contre la référence « Comparé à » (contour){R && R < 20 ? " — référence sur peu de rounds" : ""}.</p>
        <Radar me={{ ...me, kd: me.dpr ? me.kpr / me.dpr : me.kills }} base={Object.keys(S).length ? S : undefined} refRounds={R} />
      </section>
      <section className="panel section">
        <div className="lb-head"><h2 className="section-title">Par poste et par carte</h2>
          <div className="ts-seg" role="radiogroup" aria-label="Camp">
            {([["", "Les deux"], ["CT", "CT"], ["T", "T"]] as const).map(([v, l]) => <button key={v} type="button" role="radio" aria-checked={side === v} className={side === v ? "on" : ""} onClick={() => setSide(v)}>{l}</button>)}
          </div></div>
        <table className="st-table pf-table">
          <thead><tr><th className="sb-name">Poste</th><th className="sb-name">Carte</th><th className="sb-name">Rôle</th><th>Rating</th><th>ADR</th><th>K/D</th><th>KPR</th><th>Rounds</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.map}-${r.side}-${r.poste}`} className={r.rounds < MIN ? "pf-weak" : ""} data-testid="role-row">
                <td className="sb-name"><span className={`role-badge ${r.side.toLowerCase()}`}>{r.side}</span> <b>{r.poste}</b></td>
                <td className="sb-name">{mapName(r.map)}</td>
                <td className="sb-name">{r.role ? labels[r.role] ?? r.role : "—"}</td>
                <td className={`mono st-rating ${ratingTone(r.rating)}`}>{r.rating.toFixed(2)}</td>
                <td className="mono">{r.adr.toFixed(1)}</td><td className="mono">{(r.dpr ? r.kpr / r.dpr : r.kills).toFixed(2)}</td><td className="mono">{r.kpr.toFixed(2)}</td>
                <td className="mono">{r.rounds}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={8} className="st-legend">Aucun poste observé pour ces filtres.</td></tr>}
          </tbody>
        </table>
        <p className="st-legend">Lignes grisées : moins de {MIN} rounds, à lire avec prudence.</p>
      </section>
    </div>
  </>);
}

export function WeaponsTab({ pr, S, R }: { pr: PlayerProfile; S: Record<string, number>; R: number }) {
  const heroes = pr.weapons.filter((w) => w.class !== "default_pistol").slice(0, 4);
  return (<>
    <section className="panel section">
      <h2 className="section-title">Armes principales</h2>
      <div className="pl-tiles">
        {heroes.map((w) => <Tile key={w.weapon} label={weaponLabel(w.weapon)} value={w.rating.toFixed(2)} tone={ratingTone(w.rating)} hint={`éco ${w.econ_rating.toFixed(2)} · ${w.rounds} rounds`} comp={<Comp value={w.rating} base={S.rating} rounds={R} compact />} />)}
        {!heroes.length && <p className="st-legend">Aucune arme identifiée (pas de positions dans ces démos).</p>}
      </div>
    </section>
    {[["Par arme", pr.weapons.map((w) => ({ ...w, key: w.weapon, label: weaponLabel(w.weapon) }))], ["Par classe", pr.weapon_classes.map((c) => ({ ...c, key: c.class }))]].map(([title, rows]) => (
      <section key={title as string} className="panel section">
        <h2 className="section-title">{title as string}</h2>
        <table className="st-table pf-table" data-testid={title === "Par arme" ? "weapons-table" : "classes-table"}>
          <thead><tr><th className="sb-name">Arme</th><th>Utilisée</th><th>Rating</th><th>Rating éco</th><th>ADR</th><th>Rounds gagnés</th><th>Ouvertures tentées</th><th>Rounds</th></tr></thead>
          <tbody>
            {(rows as (GroupStats & { key: string; label: string; share: number; econ_rating: number; round_win_pct: number; opening_attempts_pct: number })[]).map((w) => (
              <tr key={w.key} className={w.rounds < MIN ? "pf-weak" : ""}>
                <td className="sb-name"><b>{w.label}</b></td>
                <td className="mono"><span className="pf-share"><i style={{ width: `${w.share}%` }} /></span>{w.share}%</td>
                <td className={`mono st-rating ${ratingTone(w.rating)}`}>{w.rating.toFixed(2)}</td>
                <td className={`mono ${w.econ_rating >= 1 ? "pos" : ""}`}>{w.econ_rating.toFixed(2)}</td>
                <td className="mono">{w.adr.toFixed(1)}</td><td className="mono">{w.round_win_pct}%</td><td className="mono">{w.opening_attempts_pct}%</td><td className="mono">{w.rounds}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    ))}
    <p className="st-legend">Arme = celle tenue le plus souvent dans le round (fusils avant pistolets). Rating éco = valeur des armes des adversaires tués ÷ valeur de sa propre arme : au-dessus de 1, le joueur rapporte plus qu'il ne coûte.</p>
  </>);
}

export function BuyTypesTab({ pr, S, R }: { pr: PlayerProfile; S: Record<string, number>; R: number }) {
  const a = pr.buytypes.adr;
  return (<>
    <section className="panel section">
      <h2 className="section-title">Dégâts par round</h2>
      <div className="pl-tiles">
        <Tile label="ADR sans les frags sur eco" value={a.without_eco.toFixed(1)} hint={`${a.rounds_without_eco} rounds`} comp={<Comp value={a.without_eco} base={S.adr} rounds={R} fmt={f1} compact />} />
        <Tile label="ADR avec les frags sur eco" value={a.with_eco.toFixed(1)} comp={<Comp value={a.with_eco} base={S.adr} rounds={R} fmt={f1} compact />} />
      </div>
    </section>
    <section className="panel section">
      <h2 className="section-title">Nous contre eux</h2>
      <table className="st-table pf-table" data-testid="buytypes-table">
        <thead><tr><th className="sb-name">Situation</th><th>Rounds</th><th>Rating</th><th>ADR</th><th>KPR</th><th>KAST</th><th>Ouvertures</th></tr></thead>
        <tbody>
          {pr.buytypes.matrix.map((b) => (
            <tr key={b.label} className={b.rounds < MIN ? "pf-weak" : ""}>
              <td className="sb-name"><b>{b.label}</b></td><td className="mono">{b.rounds}</td>
              <td className={`mono st-rating ${ratingTone(b.rating)}`}>{b.rating.toFixed(2)}</td>
              <td className="mono">{b.adr.toFixed(1)}</td><td className="mono">{b.kpr.toFixed(2)}</td><td className="mono">{b.kast.toFixed(0)}%</td><td className="mono">{b.opening_pct.toFixed(0)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="st-legend">Achat complet = full ; demi-achat = force ou semi ; eco ; pistol. Lignes grisées : moins de {MIN} rounds.</p>
    </section>
  </>);
}

export function MapsTab({ pr, S, R }: { pr: PlayerProfile; S: Record<string, number>; R: number }) {
  return (<>
    <div className="pf-maps">
      {pr.maps.map((m) => (
        <section key={m.map} className="panel section pf-map" style={{ ["--radar" as string]: `url(/maps/${m.map}.png)` }} data-testid="map-card">
          <h2 className="display pf-map-title">{m.display_name}</h2>
          <p className="st-legend">{m.matches} match{m.matches > 1 ? "s" : ""} · {m.win_pct}% de victoires</p>
          <div className="pf-map-sides">
            {([["Les deux", m], ["CT", m.sides.CT], ["T", m.sides.T]] as [string, GroupStats | undefined][]).map(([l, s]) => (
              <div key={l} className="pf-map-side">
                <span className="pl-tile-label">{l}</span>
                {s ? <><b className={`mono ${ratingTone(s.rating)}`}>{s.rating.toFixed(2)}</b><small className="mono">ADR {s.adr.toFixed(1)} · {s.rounds} r</small></> : <small className="rf-dim">—</small>}
              </div>
            ))}
          </div>
          <Comp value={m.rating} base={S.rating} rounds={R} compact />
        </section>
      ))}
    </div>
    <section className="panel section">
      <table className="st-table pf-table" data-testid="maps-table">
        <thead><tr><th className="sb-name">Carte</th><th>Joués</th><th>Victoires</th><th>Rating</th><th>ADR</th><th>K/D</th><th>UDR</th><th>K / D / A moy.</th></tr></thead>
        <tbody>
          {pr.maps.map((m) => (
            <tr key={m.map}>
              <td className="sb-name"><b>{m.display_name}</b></td><td className="mono">{m.matches}</td><td className="mono">{m.win_pct}%</td>
              <td className={`mono st-rating ${ratingTone(m.rating)}`}>{m.rating.toFixed(2)}</td><td className="mono">{m.adr.toFixed(1)}</td>
              <td className="mono">{(m.dpr ? m.kpr / m.dpr : m.kills).toFixed(2)}</td><td className="mono">{m.udr.toFixed(2)}</td>
              <td className="mono">{m.avg_kda.join(" / ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  </>);
}

export function KindsTab({ pr }: { pr: PlayerProfile }) {
  const cols: [string, keyof GroupStats, (v: number) => string][] = [["Rating", "rating", f2], ["ADR", "adr", f1], ["KPR", "kpr", f2], ["DPR", "dpr", f2], ["KAST", "kast", p0], ["HS", "hs_pct", p0], ["Ouvertures", "opening_pct", p0]];
  const o = pr.kinds.official, p = pr.kinds.practice;
  return (
    <section className="panel section" data-testid="kinds">
      <h2 className="section-title">Officiel vs entraînement</h2>
      {!o && !p ? <p className="st-legend">Aucun match.</p> : (
        <table className="st-table pf-table">
          <thead><tr><th className="sb-name">Statistique</th><th>Officiels {o ? `(${o.matches} m · ${o.rounds} r)` : "(aucun)"}</th><th>Entraînement {p ? `(${p.matches} m · ${p.rounds} r)` : "(aucun)"}</th><th>Écart</th></tr></thead>
          <tbody>
            {cols.map(([l, k, fmt]) => {
              const a = o ? Number(o[k]) : null, b = p ? Number(p[k]) : null;
              const d = a !== null && b !== null ? a - b : null;
              const low = k === "dpr";
              return (
                <tr key={k}><td className="sb-name">{l}</td><td className="mono">{a === null ? "—" : fmt(a)}</td><td className="mono">{b === null ? "—" : fmt(b)}</td>
                  <td className={`mono ${d === null ? "" : (d > 0) !== low ? "pos" : d < 0 || d > 0 ? "neg" : ""}`}>{d === null ? "—" : `${d > 0 ? "+" : ""}${fmt(d)}`}</td></tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="st-legend">Officiel = événement renseigné (ou dossier « Officiels ») ; le reste est de l'entraînement. Organisez vos matchs depuis la bibliothèque.</p>
    </section>
  );
}
