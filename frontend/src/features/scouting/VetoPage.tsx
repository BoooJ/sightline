import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import type { VetoStepT } from "../../shared/api/types";
import { useUrlParams } from "../../shared/useUrlParams";
import { formatDate } from "../../shared/format";
import { Button } from "../../shared/ui/Button";
import { EmptyState } from "../../shared/ui/EmptyState";
import { Icon } from "../../shared/ui/Icon";
import { Spinner } from "../../shared/ui/Spinner";
import { leaves, ORDERS, predict, scenarios, seriesWin, stepsFor, swap, value, type Done, type Format, type ScenarioNode, type Step } from "./vetoModel";
import "../match/match.css";
import "../rounds/rounds.css";
import "./scouting.css";

const pct = (p: number) => `${Math.round(p * 100)}%`;
type Tab = "timeline" | "stats" | "scenarios" | "records";

/** Simulateur de veto (comme EDGE) : ordre de séquence, timeline avec prédictions et override, statistiques Pick / Ban / Played,
 *  arbre de scénarios avec seuil de probabilité, vetos enregistrés. */
export function VetoPage() {
  const [params, set] = useUrlParams();
  const qc = useQueryClient();
  const teams = useQuery({ queryKey: ["scout-teams"], queryFn: api.scoutTeams });
  const maps = useQuery({ queryKey: ["maps"], queryFn: api.maps, staleTime: Infinity });
  const b = Number(params.get("b")) || teams.data?.[1]?.id;
  const a = Number(params.get("a")) || teams.data?.find((t) => t.id !== b)?.id;
  const format = (params.get("format") ?? "bo3") as Format;
  const orderKeys = Object.keys(ORDERS[format]);
  const orderKey = orderKeys.includes(params.get("order") ?? "") ? params.get("order")! : orderKeys[0];
  const first = (params.get("first") ?? "a") as "a" | "b";
  const tab = (params.get("tab") as Tab) || "timeline";
  // pool par défaut : les cartes du pool compétitif actuel (indiqué dans les fichiers de cartes)
  const [poolSel, setPool] = useState<string[] | null>(null);
  const pool = poolSel ?? (maps.data ?? []).filter((m) => m.active_duty).map((m) => m.name);
  const [done, setDone] = useState<Done[]>([]);
  const [threshold, setThreshold] = useState(0.03);
  const data = useQuery({ queryKey: ["veto", a, b, pool.join(",")], queryFn: () => api.veto(a!, b!, pool), enabled: !!a && !!b && a !== b && pool.length > 0 });
  const vetos = useQuery({ queryKey: ["vetos"], queryFn: () => api.vetos(), enabled: tab === "records" || tab === "stats" });
  const all = data.data?.maps ?? [];
  const order = useMemo(() => (first === "b" ? swap(ORDERS[format][orderKey]) : ORDERS[format][orderKey]), [format, orderKey, first]);
  const steps = useMemo(() => stepsFor(order, pool.length), [order, pool.length]);
  const used = new Set(done.map((d) => d.map));
  const left = all.filter((m) => !used.has(m.map));
  const step = steps[done.length];
  const finished = done.length > 0 && !step;
  const preds = step ? predict(left, step) : [];
  const rec = step && left.length > 1 ? preds[0] : null;
  const byName = useMemo(() => Object.fromEntries(all.map((m) => [m.map, m])), [all]);
  const label = (name: string) => maps.data?.find((m) => m.name === name)?.display_name ?? name;
  const teamName = (t: "a" | "b") => (t === "a" ? data.data?.team_a.name : data.data?.team_b.name) ?? "";
  const reset = () => setDone([]);
  const withDecider = (list: Done[]): Done[] => {
    const rest = all.filter((m) => !list.some((d) => d.map === m.map));
    return list.length === steps.length && rest.length ? [...list, { map: rest[0].map, team: "a", action: "decider" }] : list;
  };
  const apply = (map: string) => { if (step) setDone(withDecider([...done, { map, team: step.team, action: step.action }])); };
  /** override : remplace la carte de l'étape k (les étapes suivantes sont rejouées à vide) */
  const override = (k: number, map: string) => setDone(withDecider([...done.slice(0, k), { map, team: steps[k].team, action: steps[k].action }]));
  const auto = () => {
    let cur = done.filter((d) => d.action !== "decider");
    while (cur.length < steps.length) {
      const st = steps[cur.length];
      const rem = all.filter((m) => !cur.some((d) => d.map === m.map));
      if (rem.length <= 1) break;
      cur = [...cur, { map: predict(rem, st)[0].map, team: st.team, action: st.action }];
    }
    setDone(withDecider(cur));
  };
  const played = done.filter((d) => d.action !== "ban");
  const series = played.length ? seriesWin(played.map((d) => byName[d.map]?.p_a ?? 0.5)) : null;
  const tree = useMemo(() => (tab === "scenarios" && all.length ? scenarios(all, steps, done.filter((d) => d.action !== "decider"), threshold) : []), [tab, all, steps, done, threshold]);
  const TABS: [Tab, string][] = [["timeline", "Timeline"], ["stats", "Statistiques"], ["scenarios", "Scénarios"], ["records", "Vetos enregistrés"]];

  return (
    <div className="page">
      <div className="lib-head">
        <div><div className="eyebrow">Adversaires</div><h1 className="display">Simulateur de veto</h1></div>
        <div className="lib-tools">
          <Button variant="ghost" onClick={reset} disabled={!done.length}><Icon name="refresh" />Recommencer</Button>
          <Button variant="primary" onClick={auto} disabled={finished || !data.data} data-testid="veto-auto">Simuler le veto</Button>
        </div>
      </div>
      <section className="panel rf-panel">
        <div className="rf-row">
          <label className="rf-group"><span className="rf-label">Votre équipe</span>
            <select className="rf-select" value={a ?? ""} onChange={(e) => { set("a", e.target.value); reset(); }} aria-label="Votre équipe">
              {teams.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select></label>
          <label className="rf-group"><span className="rf-label">Adversaire</span>
            <select className="rf-select" value={b ?? ""} onChange={(e) => { set("b", e.target.value); reset(); }} aria-label="Adversaire">
              {teams.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select></label>
          <div className="rf-group"><span className="rf-label">Format</span>
            <div className="map-pills" role="group" aria-label="Format">
              {(["bo1", "bo3", "bo5"] as const).map((f) => <button key={f} type="button" className={`pill ${format === f ? "on" : ""}`} onClick={() => { set({ format: f, order: null }); reset(); }}>{f.toUpperCase()}</button>)}
            </div></div>
          <div className="rf-group"><span className="rf-label">Ordre</span>
            <div className="map-pills" role="group" aria-label="Ordre">
              {orderKeys.map((k) => <button key={k} type="button" className={`pill ${orderKey === k ? "on" : ""}`} onClick={() => { set("order", k); reset(); }} data-testid="veto-order">{k}</button>)}
              <button type="button" className={`pill ${first === "b" ? "on" : ""}`} onClick={() => { set("first", first === "a" ? "b" : undefined); reset(); }} title="Inverser qui commence" data-testid="veto-swap">
                <Icon name="refresh" size={12} /> {first === "a" ? teamName("a") || "Nous" : teamName("b") || "Eux"} commence{first === "a" ? "nt" : "nt"}</button>
            </div></div>
        </div>
        <div className="rf-group"><span className="rf-label">Pool de cartes</span>
          <div className="map-pills veto-pool" role="group" aria-label="Pool">
            {maps.data?.map((m) => (
              <button key={m.name} type="button" className={`pill ${pool.includes(m.name) ? "on" : ""}`} aria-pressed={pool.includes(m.name)}
                onClick={() => { setPool(pool.includes(m.name) ? pool.filter((x) => x !== m.name) : [...pool, m.name]); reset(); }}>{m.display_name}</button>
            ))}
          </div></div>
      </section>

      <nav className="tabs" role="tablist">
        {TABS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={`tab ${tab === k ? "on" : ""}`} onClick={() => set("tab", k === "timeline" ? undefined : k)} data-testid={`veto-tab-${k}`}>{l}</button>)}
      </nav>

      {a === b ? <EmptyState title="Choisissez deux équipes différentes" /> : data.isLoading ? <Spinner /> : !data.data ? null : tab === "timeline" ? (
        <div className="veto-grid">
          <section className="panel section">
            <h2 className="section-title">{step ? <>Au tour de <b className={step.team === "a" ? "tm-a" : "tm-b"}>{teamName(step.team)}</b> : {step.action === "ban" ? "bannir" : "choisir"} une carte</> : "Veto terminé"}</h2>
            <div className="veto-maps">
              {all.map((m) => {
                const d = done.find((x) => x.map === m.map);
                const isRec = rec?.map === m.map;
                const pr = preds.find((x) => x.map === m.map);
                return (
                  <button key={m.map} type="button" disabled={!!d || !step} onClick={() => apply(m.map)} data-testid="veto-map"
                    className={`veto-map ${d ? `is-${d.action}` : ""} ${isRec ? "rec" : ""}`} style={{ ["--radar" as string]: `url(/maps/${m.map}.png)` }}>
                    <span className="veto-name display">{label(m.map)}</span>
                    {d && <span className={`veto-state ${d.action}`}>{d.action === "ban" ? "Banni" : d.action === "pick" ? "Choisi" : "Décisive"}{d.action !== "decider" && ` · ${teamName(d.team)}`}</span>}
                    {pr && !d && <span className={isRec ? "veto-rec" : "veto-p"}>{pr.label} · {pct(pr.p)}</span>}
                    <span className="veto-line"><b>{data.data.team_a.name}</b><span className="mono">{m.a.played ? `${m.a.won}/${m.a.played} · ${m.a.win_pct.toFixed(0)}%` : "—"}</span></span>
                    <span className="veto-line"><b>{data.data.team_b.name}</b><span className="mono">{m.b.played ? `${m.b.won}/${m.b.played} · ${m.b.win_pct.toFixed(0)}%` : "—"}</span></span>
                    <span className="veto-prob"><i style={{ width: pct(m.p_a) }} /></span>
                    <span className="veto-p mono">{data.data.team_a.name} {pct(m.p_a)}</span>
                  </button>
                );
              })}
            </div>
            <p className="st-legend">Probabilités estimées à partir des démos (taux de victoire lissé, écart de rounds) et des habitudes des vetos enregistrés ({data.data.vetos.a} pour {data.data.team_a.name}, {data.data.vetos.b} pour {data.data.team_b.name}). Avec peu de matchs, elles restent proches de 50 %.</p>
          </section>
          <section className="panel section">
            <h2 className="section-title">Timeline du veto</h2>
            <ol className="veto-tl" data-testid="veto-timeline">
              {steps.map((st, k) => {
                const d = done[k];
                const remaining = all.filter((m) => !done.slice(0, k).some((x) => x.map === m.map));
                const p = k === done.length ? preds : d ? [] : predict(remaining, st);
                return (
                  <li key={k} className={`${st.team} ${k === done.length ? "current" : ""}`} data-testid="veto-tl-step">
                    <span className="mono">{k + 1}</span>
                    <span className="veto-who"><b>{teamName(st.team)}</b><span>{st.action === "ban" ? "bannit" : "choisit"}</span></span>
                    {d ? (
                      <span className="veto-over"><b>{label(d.map)}</b>
                        <select className="rf-select" value={d.map} aria-label={`Modifier l'étape ${k + 1}`} onChange={(e) => override(k, e.target.value)}>
                          {[...remaining].map((m) => <option key={m.map} value={m.map}>{label(m.map)}</option>)}
                        </select></span>
                    ) : (
                      <span className="veto-preds">
                        {p.slice(0, 3).map((x, i) => <button key={x.map} type="button" className={`veto-pred l${i + 1}`} disabled={k !== done.length} onClick={() => apply(x.map)} title={`${x.label} (${pct(x.p)})`}>{label(x.map)}<small>{x.label} · {pct(x.p)}</small></button>)}
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
            <h3 className="cmp-sub sc-left">Déroulé</h3>
            <ol className="veto-log" data-testid="veto-log">
              {done.map((d, k) => (
                <li key={k} className={d.action}><span className="mono">{k + 1}</span>
                  <span>{d.action === "decider" ? "Décisive" : `${teamName(d.team)} ${d.action === "ban" ? "bannit" : "choisit"}`}</span>
                  <b>{label(d.map)}</b>
                  {d.action !== "ban" && <span className="mono veto-lp">{pct(byName[d.map]?.p_a ?? 0.5)}</span>}</li>
              ))}
              {!done.length && <li className="cm-empty">Cliquez une carte, une prédiction, ou « Simuler le veto ».</li>}
            </ol>
            {finished && series != null && (
              <div className="veto-result" data-testid="veto-result">
                <span className="rf-label">Chances de {data.data.team_a.name} sur la série</span>
                <b className={`display ${series >= 0.5 ? "pos" : "neg"}`}>{pct(series)}</b>
              </div>
            )}
            {!!data.data.head_to_head.length && (<>
              <h3 className="cmp-sub sc-left">Confrontations directes</h3>
              <ul className="gr-occ">{data.data.head_to_head.map((h) => <li key={h.match_id}><span>{label(h.map)}</span><span className={`mono ${h.score[0] > h.score[1] ? "pos" : "neg"}`}>{h.score[0]}:{h.score[1]}</span></li>)}</ul>
            </>)}
          </section>
        </div>
      ) : tab === "stats" ? (
        <section className="panel section">
          <h2 className="section-title">Pick · Ban · Played par équipe</h2>
          <p className="st-legend">Pick % et Ban % viennent des vetos enregistrés ({data.data.vetos.a} pour {data.data.team_a.name}, {data.data.vetos.b} pour {data.data.team_b.name}) ; Joués et victoires viennent des démos de la bibliothèque.</p>
          <table className="veto-stats" data-testid="veto-stats">
            <thead><tr><th>Carte</th>
              <th className="ta">{data.data.team_a.name} Pick</th><th>Ban</th><th>Played</th><th>Démos</th><th>Vict.</th>
              <th className="tb">{data.data.team_b.name} Pick</th><th>Ban</th><th>Played</th><th>Démos</th><th>Vict.</th></tr></thead>
            <tbody>
              {all.map((m) => (
                <tr key={m.map}><td>{label(m.map)}</td>
                  {(["a", "b"] as const).map((t) => { const s = m[t]; const f = (v: number | null) => (v == null ? "—" : `${v} %`); return [
                    <td key={`${t}p`} className={`mono t${t}`}>{f(s.pick_pct)}</td>, <td key={`${t}b`} className="mono">{f(s.ban_pct)}</td>, <td key={`${t}l`} className="mono">{f(s.played_pct)}</td>,
                    <td key={`${t}d`} className="mono">{s.played}</td>, <td key={`${t}w`} className={`mono ${s.played ? (s.win_pct >= 50 ? "pos" : "neg") : ""}`}>{s.played ? `${s.win_pct.toFixed(0)} %` : "—"}</td>]; })}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : tab === "scenarios" ? (
        <section className="panel section">
          <div className="veto-scen-head">
            <h2 className="section-title">Arbre des scénarios</h2>
            <label className="rf-group"><span className="rf-label">Seuil de probabilité : {pct(threshold)}</span>
              <input type="range" min={0.01} max={0.25} step={0.01} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} aria-label="Seuil de probabilité" data-testid="veto-threshold" /></label>
            <span className="st-legend">Branches sous le seuil masquées · au plus 3 choix par étape · à partir de l'état courant de la timeline ({done.length} étape{done.length > 1 ? "s" : ""} fixée{done.length > 1 ? "s" : ""}).</span>
          </div>
          {!tree.length ? <p className="cm-empty">Aucun scénario au-dessus du seuil (ou veto déjà terminé).</p> : (
            <div className="ts-grid">
              <div><h3 className="ts-h3">Arbre</h3><Tree nodes={tree} label={label} teamName={teamName} /></div>
              <div><h3 className="ts-h3">Scénarios les plus probables</h3>
                <table className="veto-stats" data-testid="veto-scenarios">
                  <thead><tr><th>Séquence</th><th>Cartes jouées</th><th>Prob.</th><th>Série ({data.data.team_a.name})</th></tr></thead>
                  <tbody>
                    {leaves(tree).slice(0, 12).map(({ path, node }, i) => (
                      <tr key={i}>
                        <td><span className="veto-rec-steps">{path.map((n, k) => <span key={k} className={`veto-chip ${n.action}`}>{label(n.map)}</span>)}</span></td>
                        <td>{node.leaf ? node.leaf.played.map(label).join(", ") : <span className="rf-dim">suite sous le seuil…</span>}</td>
                        <td className="mono">{pct(node.cum)}</td>
                        <td className={`mono ${node.leaf ? (node.leaf.series >= 0.5 ? "pos" : "neg") : "rf-dim"}`}>{node.leaf ? pct(node.leaf.series) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
            </div>
          )}
        </section>
      ) : (
        <RecordsTab teamA={data.data.team_a} teamB={data.data.team_b} pool={pool} label={label} vetos={vetos.data ?? []} format={format} steps={steps}
          onChange={() => { qc.invalidateQueries({ queryKey: ["vetos"] }); qc.invalidateQueries({ queryKey: ["veto"] }); }} />
      )}
    </div>
  );
}

function Tree({ nodes, label, teamName }: { nodes: ScenarioNode[]; label: (m: string) => string; teamName: (t: "a" | "b") => string }) {
  return (
    <ul className="veto-tree">
      {nodes.map((n, i) => (
        <li key={i}>
          <span className={`veto-node ${n.action}`}>
            {n.step && <small>{teamName(n.step.team)} {n.action === "ban" ? "bannit" : "choisit"}</small>}{!n.step && <small>Décisive</small>}
            <b>{label(n.map)}</b><small>{pct(n.cum)}</small>
            {n.leaf && <span className="veto-leaf">· série {pct(n.leaf.series)}</span>}{n.truncated && <span className="veto-leaf">…</span>}
          </span>
          {n.children.length > 0 && <Tree nodes={n.children} label={label} teamName={teamName} />}
        </li>
      ))}
    </ul>
  );
}

function RecordsTab({ teamA, teamB, pool, label, vetos, format, steps, onChange }: {
  teamA: { id: number; name: string }; teamB: { id: number; name: string }; pool: string[]; label: (m: string) => string;
  vetos: import("../../shared/api/types").VetoRecordT[]; format: Format; steps: Step[]; onChange: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [picks, setPicks] = useState<string[]>([]);
  const [date, setDate] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const remainingAt = (k: number) => pool.filter((m) => !picks.slice(0, k).includes(m));
  const complete = steps.every((_, k) => !!picks[k]);
  const decider = complete ? pool.find((m) => !picks.includes(m)) : undefined;
  const save = async () => {
    const stepsOut: VetoStepT[] = steps.map((s, k) => ({ team: s.team, action: s.action, map: picks[k] }));
    if (decider) stepsOut.push({ team: "a", action: "decider", map: decider });
    try {
      await api.createVeto({ team_a: teamA.id, team_b: teamB.id, format, steps: stepsOut, played_on: date || null, note });
      setOpen(false); setPicks([]); setDate(""); setNote(""); setErr(null); onChange();
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <section className="panel section">
      <div className="prep-tpl-head">
        <p className="st-legend">Saisissez le veto réel de vos matchs : ces séquences nourrissent les Pick % / Ban % et les prédictions. L'ordre et le format sélectionnés ci-dessus servent de trame.</p>
        <Button size="sm" variant="primary" onClick={() => setOpen(!open)} data-testid="veto-rec-new">+ Enregistrer un veto</Button>
      </div>
      {open && (
        <form className="veto-form" onSubmit={(e) => { e.preventDefault(); void save(); }} data-testid="veto-form">
          <p className="st-legend"><b>{teamA.name}</b> contre <b>{teamB.name}</b> · {format.toUpperCase()}</p>
          <div className="veto-form-steps">
            {steps.map((s, k) => (
              <label key={k} className="veto-form-step"><span className="mono">{k + 1}</span><span>{s.team === "a" ? teamA.name : teamB.name} {s.action === "ban" ? "bannit" : "choisit"}</span>
                <select className="rf-select" value={picks[k] ?? ""} aria-label={`Étape ${k + 1}`} onChange={(e) => setPicks((p) => { const n = p.slice(0, k); n[k] = e.target.value; return n; })}>
                  <option value="">Carte…</option>{remainingAt(k).map((m) => <option key={m} value={m}>{label(m)}</option>)}
                </select></label>
            ))}
            {decider && <p className="veto-form-step"><span className="mono">{steps.length + 1}</span><span>Décisive</span><b>{label(decider)}</b></p>}
          </div>
          <div className="rf-row">
            <label className="rf-group"><span className="rf-label">Date</span><input type="date" className="rf-select" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date du veto" /></label>
            <label className="rf-group"><span className="rf-label">Note</span><input className="rf-select" value={note} onChange={(e) => setNote(e.target.value)} placeholder="ex. ESEA S52 semaine 3" aria-label="Note" /></label>
          </div>
          {err && <p className="auth-error">{err}</p>}
          <div className="lib-tools"><Button type="submit" variant="primary" size="sm" disabled={!complete} data-testid="veto-rec-save">Enregistrer</Button><Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Annuler</Button></div>
        </form>
      )}
      {!vetos.length ? <p className="cm-empty">Aucun veto enregistré.</p> : vetos.map((v) => (
        <div key={v.id} className="veto-rec" data-testid="veto-rec">
          <span><b>{v.team_a.name}</b> vs <b>{v.team_b.name}</b>{v.note && <small className="rf-dim"> · {v.note}</small>}</span>
          <span className="mono">{v.format.toUpperCase()}</span>
          <span className="veto-rec-steps">{v.steps.map((s, k) => <span key={k} className={`veto-chip ${s.action}`} title={`${s.team === "a" ? v.team_a.name : v.team_b.name} · ${s.action}`}>{label(s.map)}</span>)}</span>
          <span className="rf-dim">{formatDate(v.played_on)}</span>
          <Button size="sm" variant="ghost" aria-label="Supprimer ce veto" onClick={async () => { await api.deleteVeto(v.id); onChange(); }}><Icon name="trash" /></Button>
        </div>
      ))}
    </section>
  );
}

export { value };
