import { Link } from "react-router-dom";
import type { BriefLine, BriefPistols, BriefPlayer, DefaultKind, PrepWidget, Stat } from "../../shared/api/types";
import { Count, DefaultKinds, Dots, EngageSites } from "../scouting/scoutUi";
import { clockHint, gameClock } from "../../shared/roundTime";

const NADE_COLOR: Record<string, string> = { Smoke: "#b8c2cc", Flash: "#f5e16a", Molotov: "#ff7a3d", HE: "#7bd389", smoke: "#b8c2cc", flash: "#f5e16a", molotov: "#ff7a3d", he: "#7bd389" };
const clock = gameClock;  // horloge du jeu (1:55 au début du round), calculée depuis le temps écoulé
const BUY_LABEL: Record<string, string> = { pistol: "Pistol", eco: "Eco", semi: "Semi", force: "Force", full: "Full" };
const BUY_ORDER = ["full", "force", "semi", "eco", "pistol"];
const pc = (k: number, n: number) => (n ? `${Math.round((100 * k) / n)} %` : "—");
type SiteSplitD = { rounds: number; A: number; B: number; none: number };
type ZoneD = { place: string; rounds: number; pct: number; median_s: number; p25_s: number; p75_s: number; players: number };

function Lines({ lines }: { lines: BriefLine[] }) {
  if (!lines.length) return <p className="cm-empty">Pas assez de rounds pour en tirer des tendances.</p>;
  return (
    <ul className="ts-lines">
      {lines.map((l, i) => (
        <li key={i} className={`ts-line ${l.side === "CT" ? "ct" : "t"}`}>
          <span className={`ts-side ${l.side === "CT" ? "sc-ct" : "sc-t"}`}>{l.side}</span>
          <span className="ts-line-text">{l.text}</span>
          <span className="ts-line-meta"><Dots s={l.stat} /></span>
        </li>
      ))}
    </ul>
  );
}

function Pistol({ side, p }: { side: "T" | "CT"; p: BriefPistols }) {
  return (
    <div className={`ts-block ${side === "CT" ? "ct" : "t"}`}>
      <h3 className="ts-h3"><span className={side === "CT" ? "sc-ct" : "sc-t"}>{side}</span> Pistol {side === "T" ? "en attaque" : "en défense"}</h3>
      <p>Gagnés : <Count s={p.result} mode="simple" /></p>
      {!!p.plays.length && <ul className="ts-list">{p.plays.map((x) => <li key={x.key}><span>{x.label}</span><Count s={x.count} mode="simple" of="fois sur" /></li>)}</ul>}
      {p.after_won && <p>Pistol gagné → round suivant gagné : <Count s={p.after_won.won} mode="simple" /></p>}
      {p.after_lost_planted && <p>Pistol T perdu avec la bombe posée → ils achètent : <Count s={p.after_lost_planted.bought} mode="simple" /></p>}
      {p.after_lost_unplanted && <p>Pistol T perdu sans poser → ils achètent : <Count s={p.after_lost_unplanted.bought} mode="simple" /></p>}
      {p.after_lost && !p.after_lost_planted && !p.after_lost_unplanted && <p>Pistol perdu → ils forcent : <Count s={p.after_lost.bought} mode="simple" /></p>}
    </div>
  );
}

/** Rendu d'un widget de rapport de préparation à partir de ses données figées. */
export function PrepWidgetView({ w, team }: { w: PrepWidget; team: { id: number; name: string } }) {
  const d = w.data as any;  // eslint-disable-line @typescript-eslint/no-explicit-any
  switch (w.type) {
    case "overview":
      return (<>
        <p><b>{d.wins}</b> victoire{d.wins > 1 ? "s" : ""} sur <b>{d.matches}</b> match{d.matches > 1 ? "s" : ""} analysé{d.matches > 1 ? "s" : ""}.</p>
        <div className="sc-form" aria-label="Derniers matchs">
          {(d.recent as { id: number; opponent: string; score: [number, number]; result: string; map: string }[]).map((m) => (
            <Link key={m.id} to={`/matches/${m.id}`} className={`sc-chip ${m.result}`} title={`${m.score[0]}:${m.score[1]} contre ${m.opponent} — ${m.map}`}>{m.result === "W" ? "V" : m.result === "L" ? "D" : "N"}</Link>
          ))}
        </div>
        <table className="prep-table"><thead><tr><th>Carte</th><th>Matchs</th><th>Gagnés</th><th>CT</th><th>T</th></tr></thead>
          <tbody>{(d.maps as { map: string; display_name: string; played: number; won: number; ct_win: number; t_win: number }[]).map((m) => (
            <tr key={m.map}><td>{m.display_name}</td><td className="mono">{m.played}</td><td className="mono">{m.won}</td><td className="mono">{m.ct_win} %</td><td className="mono">{m.t_win} %</td></tr>))}</tbody></table>
      </>);
    case "reads":
      return (<>
        <p className="st-legend">{team.name} sur cette carte : {d.matches} match{d.matches > 1 ? "s" : ""} ({d.sides.T.n} rounds en T, {d.sides.CT.n} en CT).</p>
        <h3 className="ts-h3">À retenir</h3><Lines lines={d.takeaways} />
        <h3 className="ts-h3">Comment les jouer</h3><Lines lines={d.counters} />
      </>);
    case "pistols":
      return (<>
        <div className="ts-cols"><Pistol side="T" p={d.pistols.T} /><Pistol side="CT" p={d.pistols.CT} /></div>
        <div className="ts-cols">{(["T", "CT"] as const).map((s) => <p key={s} className="ts-gun"><span className={s === "CT" ? "sc-ct" : "sc-t"}>{s}</span> premier gun round gagné : <Count s={d.first_gun[s].result as Stat} mode="simple" /></p>)}</div>
      </>);
    case "attack":
      return (<>
        <p>Rounds gagnés en T : <Count s={d.side} mode="simple" />{d.avg_contact_s != null && <> · premier contact vers <b className="mono" title={clockHint(d.avg_contact_s)}>{clock(d.avg_contact_s)}</b> <small className="rf-dim">({Math.round(d.avg_contact_s)} s de jeu)</small></>}<EngageSites e={d.engage_by_site} />{d.avg_plant_s != null && <> · plant vers <b className="mono">{clock(d.avg_plant_s)}</b></>}</p>
        <ul className="ts-list">
          {(d.styles as { key: string; label: string; count: Stat; won: Stat; sites: Record<string, number>; kinds?: { key: DefaultKind; label: string; count: Stat; won: Stat }[] }[]).map((s) => {
            const site = Object.entries(s.sites).sort((a, z) => z[1] - a[1])[0];
            return <li key={s.key}><span>{s.label}{site && site[0] !== "none" && <small> · surtout {site[0]} ({site[1]})</small>}{s.kinds && <DefaultKinds kinds={s.kinds} />}</span><Count s={s.count} mode="simple" of="fois sur" /><small className="st-legend">gagnés {s.won.k}/{s.won.n}</small></li>;
          })}
        </ul>
      </>);
    case "sites": {
      const rows: [string, SiteSplitD][] = [["Tous les rounds T", d.total], ...BUY_ORDER.filter((b) => d.by_buy[b]).map((b) => [BUY_LABEL[b], d.by_buy[b]] as [string, SiteSplitD])];
      const gun: SiteSplitD = { rounds: 0, A: 0, B: 0, none: 0 };
      for (const b of ["full", "force"]) { const s = d.by_buy[b]; if (s) { gun.rounds += s.rounds; gun.A += s.A; gun.B += s.B; gun.none += s.none; } }
      const fav = gun.rounds ? (gun.A === gun.B ? null : gun.A > gun.B ? "A" : "B") : null;
      return (<>
        {gun.rounds > 0 && <p><b>En round armé</b> (full et force, {gun.rounds} round{gun.rounds > 1 ? "s" : ""}) : ils posent {fav ? <>surtout sur <b>{fav}</b> ({pc(fav === "A" ? gun.A : gun.B, gun.rounds)} des rounds)</> : <>autant sur A que sur B</>}{gun.none ? <>, et ne posent pas dans {pc(gun.none, gun.rounds)} des rounds</> : null}.{d.avg_plant_s != null && <> Plant moyen vers <b className="mono">{clock(d.avg_plant_s)}</b>.</>}</p>}
        <table className="prep-table"><thead><tr><th>Achat</th><th>Rounds</th><th>Plant A</th><th>Plant B</th><th>Pas de plant</th></tr></thead>
          <tbody>{rows.map(([l, s]) => <tr key={l}><td>{l}</td><td className="mono">{s.rounds}</td><td className="mono">{pc(s.A, s.rounds)}</td><td className="mono">{pc(s.B, s.rounds)}</td><td className="mono">{pc(s.none, s.rounds)}</td></tr>)}</tbody></table>
        <p className="st-legend">En défense, sites tenus (pas de bombe posée, round gagné) : A <Count s={d.held.A as Stat} mode="simple" /> · B <Count s={d.held.B as Stat} mode="simple" /></p>
      </>);
    }
    case "zones":
      return (
        <div className="ts-cols">
          {(["T", "CT"] as const).map((s) => {
            const z = d[s] as { rounds: number; zones: ZoneD[] };
            return (
              <div key={s} className={`ts-block ${s === "CT" ? "ct" : "t"}`}>
                <h3 className="ts-h3"><span className={s === "CT" ? "sc-ct" : "sc-t"}>{s}</span> {s === "T" ? "Zones qu'ils prennent" : "Zones qu'ils occupent"} <small className="st-legend">{z.rounds} round{z.rounds > 1 ? "s" : ""} armé{z.rounds > 1 ? "s" : ""} contre armé{z.rounds > 1 ? "s" : ""}</small></h3>
                {!z.zones.length ? <p className="cm-empty">Aucun round armé avec positions.</p> : (
                  <table className="prep-table"><thead><tr><th>Zone</th><th>Rounds</th><th>Arrivée</th><th>Joueurs</th></tr></thead>
                    <tbody>{z.zones.map((x) => <tr key={x.place}><td>{x.place}</td><td className="mono">{x.rounds} <small className="rf-dim">({Math.round(x.pct)} %)</small></td><td className="mono" title={`entre ${clock(x.p25_s)} et ${clock(x.p75_s)} dans la moitié des cas`}>{clock(x.median_s)}</td><td className="mono">{x.players.toFixed(1)}</td></tr>)}</tbody></table>
                )}
              </div>
            );
          })}
        </div>
      );
    case "postplant":
      return (<>
        <div className="ts-cols">
          <div className="ts-block t"><h3 className="ts-h3"><span className="sc-t">T</span> Après avoir posé</h3>
            <p>Bombe posée dans <b>{d.t.plants}</b> round{d.t.plants > 1 ? "s" : ""} sur {d.t.rounds} ; round gagné ensuite : <b>{pc(d.t.post_plant_won, d.t.plants)}</b> ({d.t.post_plant_won}/{d.t.plants}).{d.avg_plant_s != null && <> Plant moyen vers <b className="mono">{clock(d.avg_plant_s)}</b>.</>}</p></div>
          <div className="ts-block ct"><h3 className="ts-h3"><span className="sc-ct">CT</span> Retakes</h3>
            <p>Retakes tentés : <b>{d.ct.retakes}</b>, réussis : <b>{pc(d.ct.retakes_won, d.ct.retakes)}</b> ({d.ct.retakes_won}/{d.ct.retakes}).</p>
            <p className="st-legend">Quand on pose contre eux : retake réussi sur A <Count s={d.retakes_against.A as Stat} mode="simple" /> · sur B <Count s={d.retakes_against.B as Stat} mode="simple" /></p></div>
        </div>
      </>);
    case "defense":
      return (<>
        <p>Rounds gagnés en CT : <Count s={d.side} mode="simple" /></p>
        <h3 className="ts-h3">Placement à 20 s</h3>
        <ul className="ts-list">{(d.setups as { setup: string; count: Stat; won: Stat }[]).map((s) => <li key={s.setup}><span className="mono">{s.setup}</span><Count s={s.count} mode="simple" of="fois sur" /><small className="st-legend">gagnés {s.won.k}/{s.won.n}</small></li>)}</ul>
        <h3 className="ts-h3">Sites tenus</h3>
        <ul className="ts-list">{(["A", "B"] as const).map((k) => <li key={k}><span>Site {k} tenu</span><Count s={d.sites[k].held} mode="simple" /></li>)}</ul>
      </>);
    case "utility":
      return (
        <div className="ts-cols">
          {(["T", "CT"] as const).map((s) => (
            <div key={s} className={`ts-block ${s === "CT" ? "ct" : "t"}`}>
              <h3 className="ts-h3"><span className={s === "CT" ? "sc-ct" : "sc-t"}>{s}</span> Grenades habituelles</h3>
              {!d[s].length ? <p className="cm-empty">Aucune grenade récurrente.</p> : (
                <ul className="ts-list">{(d[s] as { type: string; place: string; count: Stat; players: string[] }[]).map((u, i) => (
                  <li key={i}><span><i className="sc-dot" style={{ background: NADE_COLOR[u.type] ?? "#ccc" }} /><b>{u.type}</b> vers <b>{u.place}</b> <small>· {u.players.join(", ")}</small></span><Count s={u.count} mode="simple" of="rounds sur" /></li>
                ))}</ul>
              )}
            </div>
          ))}
        </div>
      );
    case "players":
      return (
        <div className="prep-players">
          {(d.players as BriefPlayer[]).map((p) => {
            const r = d.ratings?.[p.steamid];
            return (
              <div key={p.steamid} className="prep-player">
                <header><Link className="pl-link" to={`/players/${p.steamid}`}><b>{p.name}</b></Link>
                  <span className="ts-badges">{p.awper && <span className="ts-badge awp">AWP</span>}{d.entry === p.name && <span className="ts-badge entry">Entrée</span>}</span></header>
                {r && <p className="st-legend mono">rating {r.rating.toFixed(2)} · ADR {Math.round(r.adr)} · K/D {r.kills}/{r.deaths}</p>}
                {(["CT", "T"] as const).map((s) => (
                  <p key={s} className="ts-spot"><span className={s === "CT" ? "sc-ct" : "sc-t"}>{s}</span> à 20 s : {p.spots[s].length ? <>surtout <b>{p.spots[s][0].place}</b> <Count s={p.spots[s][0].count} mode="simple" of="rounds sur" /></> : <span className="cm-empty">pas de poste fixe</span>}</p>
                ))}
                <p>Ouvertures gagnées : <Count s={p.opening} mode="simple" /></p>
                {p.opening_attempts && <p>Prend le premier duel : <Count s={p.opening_attempts} mode="simple" of="rounds sur" /></p>}
              </div>
            );
          })}
        </div>
      );
    case "playbook":
      return (<>
        <p className="st-legend">{d.total} round{d.total > 1 ? "s" : ""} T observé{d.total > 1 ? "s" : ""} · sites : A {d.sites?.A ?? 0}, B {d.sites?.B ?? 0}, aucun {d.sites?.none ?? 0}.</p>
        {!(d.categories as unknown[]).length ? <p className="cm-empty">Aucune tactique détectée.</p> : (d.categories as { key: string; label: string; tactics: { name: string; used: number; pct: number; win_pct: number }[] }[]).map((c) => (
          <div key={c.key}><h3 className="ts-h3">{c.label}</h3>
            <ul className="ts-list">{c.tactics.map((t) => <li key={t.name}><span>{t.name}</span><span className="mono">{t.used} round{t.used > 1 ? "s" : ""} · {t.pct} % · gagnés {t.win_pct} %</span></li>)}</ul></div>
        ))}
      </>);
    case "notes":
      return d.text ? <p className="prep-notes-text">{d.text}</p> : <p className="cm-empty">Aucune note dans le modèle.</p>;
    default:
      return null;
  }
}
