import { useState } from "react";
import { Link } from "react-router-dom";
import type { MatchDetail, MatchStats, PlayerStats, TeamStats } from "../../shared/api/types";

export type StatLine = Omit<PlayerStats, "steamid" | "name" | "team_id">;
export type Col = { key: string; label: string; title: string; get: (p: StatLine) => number; fmt?: (v: number) => string; lowIsBest?: boolean };
const f1 = (v: number) => v.toFixed(1), f2 = (v: number) => v.toFixed(2), sign = (v: number) => (v > 0 ? `+${v}` : `${v}`);

export const COLS: Col[] = [
  { key: "rating", label: "Rating", title: "Rating (formule HLTV 1.0)", get: (p) => p.rating, fmt: f2 },
  { key: "kills", label: "K", title: "Kills", get: (p) => p.kills },
  { key: "deaths", label: "D", title: "Morts", get: (p) => p.deaths, lowIsBest: true },
  { key: "assists", label: "A", title: "Assists", get: (p) => p.assists },
  { key: "diff", label: "+/−", title: "Différence kills − morts", get: (p) => p.diff, fmt: sign },
  { key: "adr", label: "ADR", title: "Dégâts moyens par round", get: (p) => p.adr, fmt: f1 },
  { key: "kast", label: "KAST", title: "% de rounds avec kill, assist, survie ou mort tradée", get: (p) => p.kast, fmt: (v) => `${v.toFixed(0)}%` },
  { key: "hs", label: "HS", title: "% de kills à la tête", get: (p) => p.hs_pct, fmt: (v) => `${v.toFixed(0)}%` },
  { key: "fk", label: "FK", title: "Kills d'ouverture (premier kill du round)", get: (p) => p.opening_kills },
  { key: "fd", label: "FD", title: "Morts d'ouverture", get: (p) => p.opening_deaths, lowIsBest: true },
  { key: "tk", label: "Trades", title: "Kills de trade", get: (p) => p.trade_kills },
  { key: "mk", label: "MK", title: "Rounds à 3 kills ou plus", get: (p) => p.multi["3k"] + p.multi["4k"] + p.multi["5k"] },
  { key: "cl", label: "1vX", title: "Clutchs gagnés", get: (p) => p.clutches_won },
  { key: "ud", label: "UD", title: "Dégâts des grenades (HE, molotov)", get: (p) => p.utility_dmg },
  { key: "ef", label: "EF", title: "Adversaires flashés", get: (p) => p.enemies_flashed },
];

export const ratingTone = (r: number) => (r >= 1.1 ? "pos" : r < 0.9 ? "neg" : "");

function PlayerTable({ team, side, players }: { team: string; side: "ct" | "t"; players: PlayerStats[] }) {
  const [sort, setSort] = useState<{ key: string; desc: boolean }>({ key: "rating", desc: true });
  const col = COLS.find((c) => c.key === sort.key)!;
  const rows = [...players].sort((a, b) => (sort.desc ? col.get(b) - col.get(a) : col.get(a) - col.get(b)));
  const best = Object.fromEntries(COLS.map((c) => {
    const vals = players.map(c.get);
    return [c.key, c.lowIsBest ? Math.min(...vals) : Math.max(...vals)];
  }));
  return (
    <table className="st-table">
      <thead>
        <tr>
          <th className={`sb-team sb-${side}`}>{team}</th>
          {COLS.map((c) => (
            <th key={c.key} title={c.title} className={sort.key === c.key ? "sorted" : ""} aria-sort={sort.key === c.key ? (sort.desc ? "descending" : "ascending") : undefined}>
              <button type="button" onClick={() => setSort({ key: c.key, desc: sort.key === c.key ? !sort.desc : !c.lowIsBest })}>
                {c.label}{sort.key === c.key && <i>{sort.desc ? "▾" : "▴"}</i>}
              </button>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => (
          <tr key={p.steamid} data-testid="stats-row">
            <td className="sb-name"><Link className="pl-link" to={`/players/${p.steamid}`}>{p.name}</Link></td>
            {COLS.map((c) => {
              const v = c.get(p);
              const cls = c.key === "rating" ? `st-rating ${ratingTone(v)}` : c.key === "diff" ? (v > 0 ? "pos" : v < 0 ? "neg" : "")
                : v === best[c.key] && players.length > 1 && v !== 0 ? "st-best" : "";
              return <td key={c.key} className={`mono ${cls}`}>{(c.fmt ?? String)(v)}</td>;
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function PlayersPanel({ m, stats }: { m: MatchDetail; stats: MatchStats }) {
  const sideOf = (teamId: number) => (m.rounds[0]?.ct_team_id === teamId ? "ct" : "t");
  return (
    <div className="st-tables">
      {[m.team_a, m.team_b].map((t) => (
        <PlayerTable key={t.id} team={t.name} side={sideOf(t.id)} players={stats.players.filter((p) => p.team_id === t.id)} />
      ))}
      <p className="st-legend">FK/FD : kills/morts d'ouverture · MK : rounds à 3+ kills · 1vX : clutchs gagnés · UD : dégâts utilitaires · EF : adversaires flashés</p>
    </div>
  );
}

const BUY_LABEL: Record<string, string> = { pistol: "Pistol", eco: "Eco", semi: "Semi-buy", force: "Force-buy", full: "Full buy" };

function Compare({ label, a, b, fmt = (v: number) => `${v.toFixed(0)}%`, sub }: {
  label: string; a: number; b: number; fmt?: (v: number) => string; sub?: [string, string];
}) {
  const tot = a + b || 1;
  return (
    <div className="cmp-row">
      <span className={`cmp-val ${a > b ? "lead" : ""}`}>{fmt(a)}{sub && <small>{sub[0]}</small>}</span>
      <div className="cmp-mid">
        <span className="cmp-label">{label}</span>
        <div className="cmp-bar"><i className="a" style={{ width: `${(100 * a) / tot}%` }} /><i className="b" style={{ width: `${(100 * b) / tot}%` }} /></div>
      </div>
      <span className={`cmp-val ${b > a ? "lead" : ""}`}>{fmt(b)}{sub && <small>{sub[1]}</small>}</span>
    </div>
  );
}

const pct = (won: number, played: number) => (played ? (100 * won) / played : 0);
const frac = (won: number, played: number) => `${won}/${played}`;

export function TeamsPanel({ stats }: { stats: MatchStats }) {
  const [a, b] = stats.teams as [TeamStats, TeamStats];
  const buys = ["pistol", "eco", "semi", "force", "full"].filter((k) => a.buy[k] || b.buy[k]);
  return (
    <div className="cmp">
      <div className="cmp-head"><span className="display">{a.name}</span><span className="display">{b.name}</span></div>
      <Compare label="Rounds gagnés" a={a.rounds_won} b={b.rounds_won} fmt={String} />
      {a.pistols + b.pistols > 0 && <Compare label="Pistols gagnés" a={a.pistols_won} b={b.pistols_won} fmt={String} />}
      <Compare label="Duels d'ouverture gagnés" a={a.opening_pct} b={b.opening_pct} sub={[frac(a.opening_won, a.rounds), frac(b.opening_won, b.rounds)]} />
      {a.plants + b.plants > 0 && <Compare label="Rounds gagnés après pose" a={a.post_plant_pct} b={b.post_plant_pct} sub={[frac(a.post_plant_won, a.plants), frac(b.post_plant_won, b.plants)]} />}
      {a.retakes + b.retakes > 0 && <Compare label="Retakes réussis" a={a.retake_pct} b={b.retake_pct} sub={[frac(a.retakes_won, a.retakes), frac(b.retakes_won, b.retakes)]} />}
      <h3 className="cmp-sub">Taux de victoire par type d'achat</h3>
      {buys.map((k) => {
        const x = a.buy[k] ?? { played: 0, won: 0 }, y = b.buy[k] ?? { played: 0, won: 0 };
        return <Compare key={k} label={BUY_LABEL[k] ?? k} a={pct(x.won, x.played)} b={pct(y.won, y.played)} sub={[frac(x.won, x.played), frac(y.won, y.played)]} />;
      })}
    </div>
  );
}

export function DuelsPanel({ m, stats }: { m: MatchDetail; stats: MatchStats }) {
  const rows = stats.players.filter((p) => p.team_id === m.team_a.id);
  const cols = stats.players.filter((p) => p.team_id === m.team_b.id);
  const k = (a: string, b: string) => stats.duels[a]?.[b] ?? 0;
  return (
    <div className="duels-wrap">
      <table className="duels">
        <thead>
          <tr><th className="duels-corner"><span>{m.team_a.name}</span><span>{m.team_b.name}</span></th>
            {cols.map((c) => <th key={c.steamid}>{c.name}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.steamid}>
              <th>{r.name}</th>
              {cols.map((c) => {
                const w = k(r.steamid, c.steamid), l = k(c.steamid, r.steamid);
                const tone = w > l ? "pos" : w < l ? "neg" : "";
                return (
                  <td key={c.steamid} className={`duel ${tone}`} title={`${r.name} ${w} – ${l} ${c.name}`}
                    style={{ ["--a" as string]: Math.min(1, Math.abs(w - l) / 4) }}>
                    <b>{w}</b><i>:</i><b>{l}</b>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="st-legend">Lecture : kills du joueur en ligne sur le joueur en colonne : kills subis.</p>
    </div>
  );
}
