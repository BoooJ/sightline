import { useState } from "react";
import { Link } from "react-router-dom";
import type { AimStats, DeathReason, MatchAnalysis, MatchDetail } from "../../shared/api/types";
import { END_REASON_LABEL, formatMoney, weaponLabel } from "../../shared/format";
import { Icon } from "../../shared/ui/Icon";
import { usePlaceLabel } from "../../shared/callouts";
import { eventLabel, roundClockAt, WinProbChart } from "./WinProbChart";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import { HighlightList } from "../highlights/HighlightsPage";
import { useSearchParams } from "react-router-dom";
import { useMyPlayer } from "../../shared/myPlayer";

const signed = (v: number, d = 1) => `${v > 0 ? "+" : ""}${v.toFixed(d)}`;
const rate = (a: number, b: number) => (b ? `${a}/${b} (${Math.round((100 * a) / b)} %)` : "—");
export const AVOIDABLE_HELP = "Évitable : mort isolé sans échange, pris à revers, ou mort dans un round déjà perdu avec au moins 3 000 $ d'équipement.";

/** `report` : version figée pour le rapport imprimable (sans filtres ni sélection de round, morts évitables seulement). */
export function AnalysisPanel({ m, a, report }: { m: MatchDetail; a: MatchAnalysis; report?: boolean }) {
  const place = usePlaceLabel(m.map_name);
  const teamName = (id: number | null) => (id === m.team_a.id ? m.team_a.name : id === m.team_b.id ? m.team_b.name : "?");
  const roundOf = new Map(a.rounds.map((r) => [r.number, r]));
  const replay = (round: number, tick: number) => `/matches/${m.id}/replay/${round}?t=${Math.max(0, tick - 3 * a.tickrate)}`;
  const clock = (round: number, tick: number) => { const r = roundOf.get(round); return r ? roundClockAt(r, tick, a.tickrate) : ""; };
  const [roundSel, setRoundSel] = useState(a.key_moments[0]?.round ?? 1);
  const [reason, setReason] = useState<DeathReason | null>(null);
  const [onlyAvoidable, setOnlyAvoidable] = useState(!!report);
  // « mes morts » : joueur de l'URL (?player=), sinon le joueur suivi s'il a joué ce match
  const [search, setSearch] = useSearchParams();
  const me = useMyPlayer();
  const urlPlayer = search.get("player");
  const who = report ? null : urlPlayer === "all" ? null : urlPlayer ?? (me && a.players.some((p) => p.steamid === me) ? me : null);
  const setWho = (v: string) => setSearch((p) => { const n = new URLSearchParams(p); n.set("player", v || "all"); return n; }, { replace: true });
  const deaths = a.deaths.filter((d) => (!reason || d.reasons.includes(reason)) && (!onlyAvoidable || d.avoidable) && (!who || d.victim === who))
    .sort((x, y) => y.cost - x.cost);
  const maxImpact = Math.max(1, ...a.players.map((p) => Math.abs(p.impact)));
  const reasonKeys = Object.keys(a.reasons) as DeathReason[];
  const selRound = roundOf.get(roundSel);
  const hl = useQuery({ queryKey: ["highlights", "match", m.id], queryFn: () => api.highlights({ match: String(m.id), limit: "12" }) });

  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  return (
    <div className="an" data-testid="analysis">
      {!report && (
        <nav className="an-nav" aria-label="Sections de l'analyse">
          {[["an-deaths", who ? `Morts de ${a.players.find((p) => p.steamid === who)?.name ?? "?"}` : "Raisons de mort"], ["an-moments", "Moments clés"],
            ["an-winprob", "Probabilité"], ["an-impact", "Impact"], ["an-aim", "Visée"], ["an-adv", "Avantages et économie"]].map(([id, l]) => (
            <button key={id} type="button" className="pill" onClick={() => jump(id)}>{l}</button>
          ))}
        </nav>
      )}
      {!!hl.data?.items.length && (
        <section className="an-block">
          <div className="an-head"><h2 className="section-title">Moments forts</h2>
            {!report && <Link className="btn btn-sm btn-ghost" to={`/highlights?match=${m.id}&map=${m.map_name}`}>Tous les moments forts ({hl.data.total})</Link>}</div>
          <HighlightList items={hl.data.items} compact />
        </section>
      )}

      <section className="an-block" id="an-moments">
        <h2 className="section-title">Moments clés</h2>
        <p className="st-legend">Les actions qui ont le plus changé la probabilité de victoire du round.</p>
        <ol className="an-moments">
          {a.key_moments.map((e, i) => (
            <li key={i}>
              <span className="an-round mono">R{e.round} · {clock(e.round, e.tick)}</span>
              <span className="an-desc">{eventLabel(e, a.names, place)}</span>
              <b className={`an-swing ${e.side === "CT" ? "wp-ct" : "wp-t"}`}>+{Math.round(e.swing * 100)} % {e.side}</b>
              <Link className="btn btn-sm btn-ghost" to={replay(e.round, e.tick)} title="Voir dans le replay" aria-label="Voir dans le replay"><Icon name="play" /></Link>
            </li>
          ))}
        </ol>
      </section>

      {!report && <section className="an-block" id="an-winprob">
        <div className="an-head">
          <h2 className="section-title">Probabilité de victoire</h2>
          <label className="rf-group"><span className="rf-label">Round</span>
            <select className="rf-select" value={roundSel} onChange={(e) => setRoundSel(Number(e.target.value))} data-testid="winprob-round">
              {a.rounds.map((r) => <option key={r.number} value={r.number}>Round {r.number}{r.winner_side ? ` (${r.winner_side})` : ""}</option>)}
            </select></label>
        </div>
        {selRound && <WinProbChart round={selRound} tickrate={a.tickrate} names={a.names} place={place} />}
        <p className="st-legend">Probabilité de victoire CT (en haut, bleu) ou T (en bas, orange) après chaque action ; survolez un point pour le détail.
          Modèle : joueurs en vie, bombe, temps restant, équipement.</p>
      </section>}

      <section className="an-block" id="an-impact">
        <h2 className="section-title">Impact</h2>
        <table className="st-table an-table">
          <thead><tr>
            <th>Joueur</th><th title="Probabilité de victoire gagnée moins perdue, par round (points de %)">Impact / round</th>
            <th title="Probabilité gagnée par ses kills, poses et désamorçages">Gains</th><th title="Probabilité perdue par ses morts">Pertes</th>
            <th>Morts</th><th title={AVOIDABLE_HELP}>Évitables</th><th title="Valeur des grenades encore en poche à la mort">Utilitaires perdus</th>
            <th title="Équipement perdu en mourant dans un round déjà perdu">Équipement perdu</th>
          </tr></thead>
          <tbody>
            {a.players.map((p) => (
              <tr key={p.steamid} data-testid="impact-row">
                <td className="sb-name"><Link className="pl-link" to={`/players/${p.steamid}`}>{p.name}</Link> <span className="an-team">{teamName(p.team_id)}</span></td>
                <td className="mono an-impact">
                  <span className={p.impact >= 0 ? "pos" : "neg"}>{signed(p.impact)}</span>
                  <span className="an-bar"><i className={p.impact >= 0 ? "pos" : "neg"} style={{ width: `${(Math.abs(p.impact) / maxImpact) * 100}%` }} /></span>
                </td>
                <td className="mono">{signed(p.swing_plus, 0)}</td><td className="mono">−{p.swing_minus.toFixed(0)}</td>
                <td className="mono">{p.deaths}</td><td className="mono">{p.avoidable}</td>
                <td className="mono">{formatMoney(p.unused_utility)}</td><td className="mono">{formatMoney(p.lost_cause_gear)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="an-block" id="an-aim">
        <h2 className="section-title">Visée</h2>
        <AimTable rows={a.players.map((p) => ({ steamid: p.steamid, name: p.name, sub: teamName(p.team_id), aim: p.aim }))} />
      </section>

      <section className="an-block" id="an-deaths">
        <div className="an-head">
          <h2 className="section-title">Raisons de mort</h2>
          {!report && (
            <label className="rf-group"><span className="rf-label">Morts de</span>
              <select className="rf-select" value={who ?? ""} onChange={(e) => setWho(e.target.value)} data-testid="deaths-player">
                <option value="">Tous les joueurs</option>
                {a.players.map((p) => <option key={p.steamid} value={p.steamid}>{p.name}{p.steamid === me ? " (moi)" : ""}</option>)}
              </select></label>
          )}
        </div>
        <div className="an-matrix-wrap">
          <table className="an-matrix">
            <thead><tr><th>Joueur</th>{reasonKeys.map((k) => (
              <th key={k}><button type="button" className={`pill ${reason === k ? "on" : ""}`} onClick={() => setReason(reason === k ? null : k)}>{a.reasons[k]}</button></th>
            ))}</tr></thead>
            <tbody>
              {a.players.map((p) => {
                const max = Math.max(1, p.deaths);
                return (
                  <tr key={p.steamid} className={who === p.steamid ? "an-me" : ""}><td className="sb-name">{p.name}</td>
                    {reasonKeys.map((k) => <td key={k} className="mono" style={{ ["--a" as string]: p.reasons[k] / max }}>{p.reasons[k] || ""}</td>)}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!report && <div className="an-filters">
          <label className="hm-check"><input type="checkbox" checked={onlyAvoidable} onChange={(e) => setOnlyAvoidable(e.target.checked)} data-testid="only-avoidable" />Évitables seulement</label>
          <span className="st-legend">{AVOIDABLE_HELP} {deaths.length} mort{deaths.length > 1 ? "s" : ""}, triées par coût.</span>
        </div>}
        {report && <h3 className="an-sub">Morts évitables les plus coûteuses</h3>}
        <ul className="an-deaths" data-testid="death-list">
          {deaths.slice(0, report ? 15 : 60).map((d) => (
            <li key={`${d.round}-${d.tick}-${d.victim}`} className={d.avoidable ? "avoidable" : ""}>
              <span className="an-round mono">R{d.round} · {clock(d.round, d.tick)}</span>
              <span className="an-desc"><b className={d.side === "CT" ? "wp-ct" : "wp-t"}>{d.victim_name}</b> tué par {d.attacker_name || "?"} · {weaponLabel(d.weapon)}{place(d.place, d.pos) ? ` · ${place(d.place, d.pos)}` : ""}</span>
              <span className="an-tags">{d.reasons.map((r) => <span key={r} className="kf-tag">{a.reasons[r]}{r === "side" && d.aim_offset != null ? ` · ${Math.round(d.aim_offset)}°` : ""}</span>)}{d.avoidable && <span className="kf-tag an-avoid">Évitable</span>}</span>
              <span className="mono neg" title="Probabilité de victoire perdue par son équipe">−{Math.round(d.cost * 100)} %</span>
              <Link className="btn btn-sm btn-ghost" to={replay(d.round, d.tick)} aria-label="Voir dans le replay"><Icon name="play" /></Link>
            </li>
          ))}
        </ul>
      </section>

      <div className="an-grid" id="an-adv">
        <section className="an-block">
          <h2 className="section-title">Avantages numériques</h2>
          <div className="an-cards">
            {[m.team_a, m.team_b].map((t) => {
              const s = a.advantages[String(t.id)];
              return (
                <div key={t.id} className="an-card">
                  <div className="an-card-title">{t.name}</div>
                  <div><span className="st-legend">Avantage converti</span> <b className="mono">{rate(s?.won ?? 0, s?.had ?? 0)}</b></div>
                  <div><span className="st-legend">Avec 2 joueurs d'avance ou plus</span> <b className="mono">{rate(s?.won2 ?? 0, s?.had2 ?? 0)}</b></div>
                </div>
              );
            })}
          </div>
          <ul className="an-deaths" data-testid="lost-advantages">
            {a.lost_advantages.length === 0 && <li className="st-legend">Aucun avantage numérique perdu.</li>}
            {a.lost_advantages.map((l) => (
              <li key={`${l.round}-${l.team_id}`}>
                <span className="an-round mono">R{l.round}</span>
                <span className="an-desc"><b className={l.side === "CT" ? "wp-ct" : "wp-t"}>{teamName(l.team_id)}</b> perd un {l.state}
                  {l.end_reason ? ` (${END_REASON_LABEL[l.end_reason] ?? l.end_reason})` : ""}</span>
                {l.advantage >= 2 && <span className="kf-tag an-avoid">{l.advantage} joueurs d'avance</span>}
                <Link className="btn btn-sm btn-ghost" to={replay(l.round, l.tick)} aria-label="Voir dans le replay"><Icon name="play" /></Link>
              </li>
            ))}
          </ul>
        </section>

        <section className="an-block">
          <h2 className="section-title">Audit économique</h2>
          <div className="an-cards">
            {[m.team_a, m.team_b].map((t) => {
              const s = a.economy.teams[String(t.id)];
              // grenades gardées par les survivants : « en vie » passent au round suivant, « fin de mi-temps » sont perdues
              const mine = a.players.filter((p) => p.team_id === t.id).map((p) => a.utility?.players[p.steamid]);
              const alive = mine.reduce((n, u) => n + (u?.alive_value ?? 0), 0), halfEnd = mine.reduce((n, u) => n + (u?.half_end_value ?? 0), 0);
              return (
                <div key={t.id} className="an-card" data-testid="econ-audit">
                  <div className="an-card-title">{t.name}</div>
                  <div><span className="st-legend">Forces et semi-achats gagnés</span> <b className="mono">{rate(s?.force_won ?? 0, s?.force ?? 0)}</b></div>
                  <div><span className="st-legend">Écos gagnées</span> <b className="mono">{rate(s?.eco_won ?? 0, s?.eco ?? 0)}</b></div>
                  <div><span className="st-legend">Grenades non utilisées à la mort</span> <b className="mono">{formatMoney(s?.unused_utility ?? 0)}</b></div>
                  <div><span className="st-legend" title="Grenades encore en poche chez les survivants : elles passent au round suivant">Gardées en vie</span> <b className="mono">{formatMoney(alive)}</b></div>
                  <div><span className="st-legend" title="Grenades des survivants des rounds 12, 24 et du dernier round : perdues au changement de mi-temps">Perdues en fin de mi-temps</span> <b className="mono">{formatMoney(halfEnd)}</b></div>
                  <div><span className="st-legend">Équipement perdu dans des rounds perdus d'avance</span> <b className="mono">{formatMoney(s?.lost_cause_gear ?? 0)}</b></div>
                </div>
              );
            })}
          </div>
          <h3 className="an-sub">Achats à contre-courant</h3>
          <ul className="an-deaths">
            {a.economy.incoherent.length === 0 && <li className="st-legend">Aucun : chaque joueur a suivi l'achat de son équipe.</li>}
            {a.economy.incoherent.map((x) => (
              <li key={`${x.round}-${x.steamid}`}>
                <span className="an-round mono">R{x.round}</span>
                <span className="an-desc"><b className={x.side === "CT" ? "wp-ct" : "wp-t"}>{x.name}</b>{" "}
                  {x.kind === "eco_alone" ? `reste à ${formatMoney(x.equip)} pendant que l'équipe achète (${x.team_buy})` : `achète seul (${formatMoney(x.equip)}) pendant une éco`}</span>
                <Link className="btn btn-sm btn-ghost" to={`/matches/${m.id}/replay/${x.round}`} aria-label="Voir dans le replay"><Icon name="play" /></Link>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

export const AIM_COLS: { key: keyof AimStats; label: string; title: string; hint: string; unit: string; lowIsBest?: boolean }[] = [
  { key: "accuracy", label: "Précision", title: "Tirs qui touchent un adversaire", hint: "tirs qui touchent", unit: "%" },
  { key: "first_bullet", label: "1re balle", title: "Précision de la première balle (après 0,5 s sans tirer)", hint: "après 0,5 s sans tirer", unit: "%" },
  { key: "hs_accuracy", label: "HS touchés", title: "Part des tirs touchés qui touchent la tête", hint: "des tirs touchés", unit: "%" },
  { key: "counter_strafe", label: "À l'arrêt", title: "Premières balles tirées à l'arrêt (contre-strafe) : vitesse sous 34 % du maximum de l'arme", hint: "contre-strafe", unit: "%" },
  { key: "ttk_ms", label: "Temps pour tuer", title: "Temps moyen entre le premier dégât et le kill", hint: "1er dégât → kill", unit: " ms", lowIsBest: true },
];

/** Tableau de visée par joueur, meilleure valeur de chaque colonne en évidence. */
export function AimTable({ rows }: { rows: { steamid: string; name: string; sub?: string; aim: AimStats | null }[] }) {
  const best = Object.fromEntries(AIM_COLS.map((c) => {
    const vals = rows.map((r) => r.aim?.[c.key]).filter((v): v is number => typeof v === "number");
    return [c.key, vals.length ? (c.lowIsBest ? Math.min(...vals) : Math.max(...vals)) : null];
  }));
  return (
    <table className="st-table an-table" data-testid="aim-table">
      <thead><tr><th>Joueur</th>{AIM_COLS.map((c) => <th key={c.key} title={c.title}>{c.label}</th>)}<th title="Tirs d'armes à feu">Tirs</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.steamid}>
            <td className="sb-name"><Link className="pl-link" to={`/players/${r.steamid}`}>{r.name}</Link>{r.sub && <span className="an-team"> {r.sub}</span>}</td>
            {AIM_COLS.map((c) => {
              const v = r.aim?.[c.key];
              return <td key={c.key} className={`mono ${v != null && v === best[c.key] && rows.length > 1 ? "st-best" : ""}`}>{v == null ? "—" : `${v}${c.unit}`}</td>;
            })}
            <td className="mono">{r.aim?.shots ?? 0}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
