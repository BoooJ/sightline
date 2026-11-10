import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { api } from "../../shared/api/client";
import type { RolePlayer, Side } from "../../shared/api/types";
import { saveStudy, studyUrl } from "../../shared/study";
import { EmptyState } from "../../shared/ui/EmptyState";
import { Icon } from "../../shared/ui/Icon";
import { Spinner } from "../../shared/ui/Spinner";
import { KPI_LABEL, ROLE_GUIDE, type Kpi } from "./roleGuide";

const COLORS = ["var(--accent)", "#5b9dff", "#ffd23f", "var(--accent-deep)", "#ff8a5b", "#9aa3ad"];

/** Apprendre un rôle : profils de rôle (scores continus) des joueurs de la bibliothèque sur une carte et un camp,
 *  guide du rôle (recherche), indicateurs comparés à la référence et aux repères pros, joueurs modèles à étudier. */
export function RoleLearn({ mapName, mapLabel, side, role, setRole, me }: {
  mapName: string; mapLabel: string; side: Side; role: string | null; setRole: (r: string) => void; me: string | undefined;
}) {
  const q = useQuery({ queryKey: ["roles", mapName, side], queryFn: () => api.learnRoles(mapName, side) });
  const nav = useNavigate();
  const loc = useLocation();
  const [focus, setFocus] = useState<string | null>(null);
  if (q.isLoading) return <div className="rl"><Spinner /></div>;
  const d = q.data;
  if (!d || !d.players.length) return <div className="rl"><EmptyState icon="user" title="Aucune donnée sur cette carte">Importez des démos jouées sur {mapLabel}.</EmptyState></div>;
  const roles = d.roles;
  const current = role && roles.includes(role) ? role : roles[0];
  const guide = ROLE_GUIDE[`${side}:${current}`];
  const mine = d.players.find((p) => p.steamid === me);
  const bench = d.benchmarks[current];
  const models = [...d.players].filter((p) => p.reliable || d.players.length < 12).sort((a, b) => b.scores[current] - a.scores[current]).slice(0, 5);
  const study = (p: RolePlayer) => {
    const items = p.round_list.map(([match_id, round_number, start, end, won]) => ({
      match_id, round_number, steamid: p.steamid, start, end, label: `${p.name} (${p.team}) · R${round_number} · ${won ? "gagné" : "perdu"}`,
    }));
    if (!items.length) return;
    saveStudy({ title: `${guide.label} : ${p.name} — ${mapLabel} ${side}`, back: loc.pathname + loc.search, items });
    nav(studyUrl(items[0], 0));
  };
  return (
    <div className="rl">
      <section className="rl-main">
        <div className="rl-roles" role="tablist" aria-label="Rôle" data-testid="role-tabs">
          {roles.map((r) => {
            const g = ROLE_GUIDE[`${side}:${r}`];
            const n = d.players.filter((p) => p.primary === r).length;
            return (
              <button key={r} type="button" role="tab" aria-selected={r === current} className={`rl-role ${r === current ? "on" : ""}`} onClick={() => setRole(r)}>
                <b>{g?.label ?? r}</b><small>{n} joueur{n > 1 ? "s" : ""}{mine?.primary === r ? " · toi" : ""}</small>
              </button>
            );
          })}
        </div>
        <h3 className="ln-sub">Profils de rôle sur {mapLabel} ({side}) <small>un continuum : chaque joueur mélange plusieurs rôles</small></h3>
        <div className="rl-legend">{roles.map((r, k) => <span key={r}><i style={{ background: COLORS[k] }} />{ROLE_GUIDE[`${side}:${r}`]?.label ?? r}</span>)}</div>
        <ul className="rl-players" data-testid="role-players">
          {[...d.players].sort((a, b) => a.team.localeCompare(b.team) || b.scores[current] - a.scores[current]).map((p) => (
            <li key={p.steamid} className={`${p.steamid === me ? "mine" : ""} ${focus === p.steamid ? "on" : ""}`} onMouseEnter={() => setFocus(p.steamid)} onMouseLeave={() => setFocus(null)}>
              <span className="rl-name"><Link to={`/players/${p.steamid}`}>{p.name}</Link> <small>{p.team} · {p.rounds} r{p.reliable ? "" : " · peu de rounds"}</small></span>
              <span className="rl-bar" title={roles.map((r) => `${ROLE_GUIDE[`${side}:${r}`]?.label ?? r} ${Math.round(p.scores[r] * 100)} %`).join(" · ")}>
                {roles.map((r, k) => <i key={r} style={{ width: `${p.scores[r] * 100}%`, background: COLORS[k], opacity: r === current ? 1 : 0.45 }} />)}
              </span>
              <span className="rl-primary">{ROLE_GUIDE[`${side}:${p.primary}`]?.label ?? p.primary}</span>
            </li>
          ))}
        </ul>
      </section>

      <aside className="ln-detail rl-detail" data-testid="role-detail">
        <h2 className="display ln-h">{guide.label} <span className={side === "CT" ? "gr-ct" : "gr-t"}>{side}</span></h2>
        <p className="rl-summary">{guide.summary}</p>
        {guide.spots[mapName] && <p className="st-legend"><b>Sur {mapLabel} :</b> {guide.spots[mapName]}.</p>}

        <h3 className="ln-sub">Indicateurs</h3>
        <table className="ln-cmp" data-testid="role-kpis">
          <thead><tr><th /><th title={`Médiane des ${bench?.players ?? 0} joueurs de ce rôle dans la bibliothèque`}>Rôle ({bench?.players ?? 0})</th><th>{mine ? "Moi" : "Moi (–)"}</th></tr></thead>
          <tbody>
            {guide.kpis.map((k: Kpi) => {
              const [label, f] = KPI_LABEL[k];
              const ref = bench?.kpis[k] ?? null, my = mine?.kpis[k] ?? null, t = guide.targets[k];
              const ok = t && my !== null ? (t[1] === "min" ? my >= t[0] : my <= t[0]) : null;
              return (
                <tr key={k}>
                  <td>{label}{t && <small className="rl-target" title={t[2]}> · repère {f(t[0])}{t[1] === "min" ? "+" : " max"}</small>}</td>
                  <td className="mono">{ref === null ? "–" : f(ref)}</td>
                  <td className={`mono ${ok === true ? "up" : ok === false ? "down" : ""}`}>{my === null ? "–" : f(my)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="st-legend">Repères : [S] tirés d'une source (HLTV, Leetify…), [E] estimations d'usage courant. Survolez un repère pour sa source.</p>
        {mine ? (
          <p className="st-legend" data-testid="my-role">Ton profil ici : <b>{ROLE_GUIDE[`${side}:${mine.primary}`]?.label ?? mine.primary}</b> ·{" "}
            {roles.map((r) => `${ROLE_GUIDE[`${side}:${r}`]?.label ?? r} ${Math.round(mine.scores[r] * 100)} %`).join(" · ")}</p>
        ) : <p className="st-legend">Choisissez « Joueur suivi » sur le tableau de bord pour voir ton profil.</p>}

        <h3 className="ln-sub">Joueurs modèles</h3>
        <ul className="ln-rounds" data-testid="role-models">
          {models.map((p) => (
            <li key={p.steamid}>
              <span><b>{p.name}</b> <small>{p.team} · {Math.round(p.scores[current] * 100)} % {guide.label.toLowerCase()} · {p.rounds} rounds</small></span>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => study(p)} disabled={!p.round_list.length}
                title={p.round_list.length ? "Revoir ses rounds à la suite en le suivant" : "Aucun round rejouable (positions absentes) pour ce joueur ici"}><Icon name="play" />Étudier</button>
            </li>
          ))}
        </ul>

        <h3 className="ln-sub">Principes</h3>
        <ul className="rl-list">{guide.principles.map((x) => <li key={x}>{x}</li>)}</ul>
        <h3 className="ln-sub">Erreurs fréquentes</h3>
        <ul className="rl-list bad">{guide.mistakes.map((x) => <li key={x}>{x}</li>)}</ul>
        <h3 className="ln-sub">À regarder dans les démos</h3>
        <ul className="rl-list">{guide.watch.map((x) => <li key={x}>{x}</li>)}</ul>
      </aside>
    </div>
  );
}
