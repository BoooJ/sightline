import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { fromHere } from "../../shared/backLink";
import { api } from "../../shared/api/client";
import type { PatternResult, Side, TacticCondition } from "../../shared/api/types";
import { ContextBar } from "../../shared/context/ContextBar";
import { useContextFilters } from "../../shared/context/useContextFilters";
import { formatDate } from "../../shared/format";
import { Button } from "../../shared/ui/Button";
import { EmptyState } from "../../shared/ui/EmptyState";
import { Icon } from "../../shared/ui/Icon";
import { Spinner } from "../../shared/ui/Spinner";
import { ZoneCanvas } from "./ZoneCanvas";
import { clock } from "./PlaybookPage";
import "../callouts/callouts.css";
import "../scouting/scouting.css";
import "./playbook.css";

const GRENADES: [string, string][] = [["smoke", "Smoke"], ["flash", "Flash"], ["he", "HE"], ["molotov", "Molotov"], ["incendiary", "Incendiaire"], ["decoy", "Leurre"]];
const BUYS: [string, string][] = [["pistol", "Pistol"], ["eco", "Eco"], ["semi", "Semi"], ["force", "Force"], ["full", "Full"]];
const STAGES: [string, number, number][] = [["1:55–1:30", 0, 25], ["1:29–1:05", 25, 50], ["1:04–0:35", 50, 80], ["0:34–0:00", 80, 115]];
const TABS: [string, string][] = [["utility", "Grenades"], ["players", "Joueurs"], ["rounds", "Rounds"], ["tactics", "Tactiques"]];
const HELP_KEY = "sl-pf-help-seen";
/** Carré de ± 450 unités autour d'un site : zone « sur le site » pour les exemples. */
const siteZone = (c: [number, number]): [number, number][] => [[c[0] - 450, c[1] - 450], [c[0] + 450, c[1] - 450], [c[0] + 450, c[1] + 450], [c[0] - 450, c[1] + 450]];
type ZoneCond = Extract<TacticCondition, { zone: [number, number][] }>;
export const DRAFT_KEY = "sl-tactic-draft";

/** Pattern Finder : zones dessinées + filtres utilitaires / joueurs / rounds / tactiques → rounds correspondants, à rejouer superposés. */
export function PatternFinderPage() {
  const ctx = useContextFilters();
  const nav = useNavigate();
  const side: Side = ctx.side ?? "T";
  const teams = useQuery({ queryKey: ["teams"], queryFn: api.teams, staleTime: 60_000 });
  const maps = useQuery({ queryKey: ["maps"], queryFn: api.maps, staleTime: Infinity });
  const meta = maps.data?.find((m) => m.name === ctx.map);
  const roster = useQuery({ queryKey: ["team-stats", ctx.team, { map: ctx.map }], queryFn: () => api.teamStats(ctx.team!, { map: ctx.map }), enabled: !!ctx.team });
  const tactics = useQuery({ queryKey: ["tactics", ctx.map, side], queryFn: () => api.tactics({ map: ctx.map, side }), enabled: !!ctx.map });
  const [tab, setTab] = useState("utility");
  const [level, setLevel] = useState("");
  const [zones, setZones] = useState<ZoneCond[]>([]);
  const [active, setActive] = useState(0);
  const [buy, setBuy] = useState<string[]>([]);
  const [outcome, setOutcome] = useState<"" | "won" | "lost">("");
  const [stage, setStage] = useState<number | null>(null);
  const [minAlive, setMinAlive] = useState(0);
  const [maxGap, setMaxGap] = useState(0);
  const [negate, setNegate] = useState(false);
  const [include, setInclude] = useState<number[]>([]);
  const [exclude, setExclude] = useState<number[]>([]);
  const [help, setHelp] = useState(() => { try { return localStorage.getItem(HELP_KEY) !== "1"; } catch { return true; } });
  const closeHelp = () => { setHelp(false); try { localStorage.setItem(HELP_KEY, "1"); } catch { /* stockage indisponible */ } };
  /** exemples prêts à l'emploi : une zone sur un site + une condition */
  const example = (kind: "rush" | "execute", site: "A" | "B") => {
    const c = site === "A" ? meta?.bomb_a : meta?.bomb_b;
    if (!c) return;
    const zone = siteZone(c);
    const lvl = meta && meta.levels.length > 1 ? { level } : {};
    const z: ZoneCond = kind === "rush" ? { kind: "players_in_zone", zone, min_players: 3, from_s: 0, to_s: 30, ...lvl }
      : { kind: "utility_in_zone", zone, types: ["smoke"], min_count: 2, position: "land", from_s: 0, to_s: 115, ...lvl };
    setZones([z]); setActive(0); setStage(null); setNegate(false); setTab(kind === "rush" ? "players" : "utility");
  };
  useEffect(() => { if (meta && !meta.levels.some((l) => l.name === level)) setLevel(meta.levels[0]?.name ?? ""); }, [meta, level]);
  useEffect(() => { setZones([]); setActive(0); setInclude([]); setExclude([]); }, [ctx.map, side]);
  const ready = !!ctx.team && !!ctx.map;
  const conditions = useMemo(() => zones.filter((z) => z.zone.length >= 3).map((z) => (stage === null ? z : { ...z, from_s: STAGES[stage][1], to_s: STAGES[stage][2] })), [zones, stage]);
  const body = useMemo(() => ({ map: ctx.map, side, definition: { conditions }, filters: { buy, outcome: outcome || null, min_alive: minAlive || null, max_gap_s: maxGap || null, negate, include_tactics: include, exclude_tactics: exclude } }),
    [ctx.map, side, conditions, buy, outcome, minAlive, maxGap, negate, include, exclude]);
  const search = useMutation({ mutationFn: () => api.patternFinder(ctx.team!, body, ctx.lib) });
  const res: PatternResult | undefined = search.data;
  useEffect(() => { if (ready) search.mutate(); }, [ready, body, ctx.lib]);  // eslint-disable-line react-hooks/exhaustive-deps
  const addZone = (kind: "players_in_zone" | "utility_in_zone") => {
    const z: ZoneCond = kind === "players_in_zone" ? { kind, zone: [], min_players: 1, from_s: 0, to_s: 115 } : { kind, zone: [], types: ["smoke"], min_count: 1, position: "land", from_s: 0, to_s: 115 };
    setZones((zs) => [...zs, z]); setActive(zones.length); setTab(kind === "players_in_zone" ? "players" : "utility");
  };
  const update = (i: number, patch: Partial<ZoneCond>) => setZones((zs) => zs.map((z, j) => (j === i ? ({ ...z, ...patch } as ZoneCond) : z)));
  const overlay = async () => {
    if (!res?.ids.length) return;
    const first = await api.replay(res.ids[0]);
    nav(`/matches/${first.match_id}/replay/${first.round.number}?${res.ids.length > 1 ? `layers=${res.ids.slice(1, 25).join(",")}&` : ""}${fromHere()}`);
  };
  const saveAsTactic = () => {
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ map: ctx.map, side, conditions })); } catch { /* stockage indisponible */ }
    nav(`/playbook/editor?map=${ctx.map}&side=${side}&team=${ctx.team}&draft=1`);
  };
  const act = zones[active];
  return (
    <div className="page">
      <div className="lib-head">
        <div><div className="eyebrow">Adversaires</div><h1 className="display">Pattern Finder</h1></div>
      </div>
      <ContextBar ctx={ctx} />
      {!ready ? (
        <section className="panel section"><EmptyState icon="search" title="Choisissez une équipe et une carte">Dessinez ensuite des zones et combinez les filtres : les rounds qui correspondent se rejouent superposés.</EmptyState>
          <div className="dash-pick pb2-pick">
            <select className="rf-select" value={ctx.team ?? ""} onChange={(e) => ctx.set("team", e.target.value)} aria-label="Équipe à analyser"><option value="">Équipe…</option>{teams.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
            <select className="rf-select" value={ctx.map ?? ""} onChange={(e) => ctx.set("map", e.target.value)} aria-label="Carte à analyser"><option value="">Carte…</option>{maps.data?.map((m) => <option key={m.name} value={m.name}>{m.display_name}</option>)}</select>
          </div>
        </section>
      ) : (
        <div className="pf-layout">
          <aside className="panel section pf-panel">
            {help && (
              <div className="pf-help" data-testid="pf-help">
                <div className="sc-dialog-head"><b>Comment ça marche</b><button type="button" className="btn btn-sm btn-ghost" onClick={closeHelp} aria-label="Fermer l'aide">✕</button></div>
                <ol>
                  <li><b>Dessinez une zone</b> sur la carte (3 clics ou plus), par exemple un site ou un couloir.</li>
                  <li><b>Dites ce qui doit s'y passer</b> : des joueurs présents (« au moins 3 joueurs »), ou des grenades qui y atterrissent (« 2 smokes »), à un moment du round.</li>
                  <li><b>Les rounds qui correspondent</b> apparaissent dans la colonne des résultats : rejouez-les tous superposés, ou enregistrez le motif comme tactique du playbook.</li>
                </ol>
                <p className="st-legend">Sans zone ni filtre, tous les rounds de l'équipe sur cette carte sont listés.</p>
              </div>
            )}
            {meta?.bomb_a && (
              <div className="pf-examples" data-testid="pf-examples">
                <span className="rf-label">Exemples</span>
                <div className="map-pills">
                  <button type="button" className="pill" onClick={() => example("rush", "A")}>Rush A (3 joueurs sur A avant 0:30)</button>
                  {meta.bomb_b && <button type="button" className="pill" onClick={() => example("rush", "B")}>Rush B</button>}
                  <button type="button" className="pill" onClick={() => example("execute", "A")}>Exécution A (2 smokes sur A)</button>
                  {meta.bomb_b && <button type="button" className="pill" onClick={() => example("execute", "B")}>Exécution B</button>}
                </div>
              </div>
            )}
            <nav className="tabs pf-tabs" role="tablist">
              {TABS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={`tab ${tab === k ? "on" : ""}`} onClick={() => setTab(k)}>{l}</button>)}
            </nav>
            {tab === "utility" && (
              <div className="pf-tab">
                <p className="st-legend">Nos grenades qui atterrissent (ou sont lancées) dans une zone dessinée.</p>
                <Button size="sm" onClick={() => addZone("utility_in_zone")} data-testid="pf-add-utility">+ Zone de grenades</Button>
                {zones.map((z, i) => z.kind === "utility_in_zone" && (
                  <div key={i} className={`pb2-cond ${i === active ? "on" : ""}`} onClick={() => setActive(i)} data-testid="pf-zone">
                    <div className="pb2-cond-head"><b>Zone {i + 1} · {z.zone.length} pt{z.zone.length > 1 ? "s" : ""}{z.zone.length < 3 ? " (3 au moins)" : ""}</b>
                      <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setZones((zs) => zs.filter((_, j) => j !== i)); setActive(0); }} aria-label="Retirer la zone"><Icon name="trash" /></Button></div>
                    <div className="pb2-cond-row pb2-types">{GRENADES.map(([k, l]) => <label key={k} className="hm-check"><input type="checkbox" checked={z.types.includes(k)} onChange={(e) => update(i, { types: e.target.checked ? [...z.types, k] : z.types.filter((x) => x !== k) })} />{l}</label>)}</div>
                    <div className="pb2-cond-row"><label>Au moins <input type="number" className="input pb2-num" min={1} max={10} value={z.min_count} onChange={(e) => update(i, { min_count: Number(e.target.value) })} /></label>
                      <select className="rf-select" value={z.position} onChange={(e) => update(i, { position: e.target.value as "land" | "throw" })} aria-label="Position"><option value="land">qui atterrissent ici</option><option value="throw">lancées d'ici</option></select></div>
                  </div>
                ))}
              </div>
            )}
            {tab === "players" && (
              <div className="pf-tab">
                <p className="st-legend">Des joueurs (tous ou certains) présents dans une zone dessinée ; joueurs vivants minimum à l'instant du motif.</p>
                <Button size="sm" onClick={() => addZone("players_in_zone")} data-testid="pf-add-players">+ Zone de joueurs</Button>
                {zones.map((z, i) => z.kind === "players_in_zone" && (
                  <div key={i} className={`pb2-cond ${i === active ? "on" : ""}`} onClick={() => setActive(i)} data-testid="pf-zone">
                    <div className="pb2-cond-head"><b>Zone {i + 1} · {z.zone.length} pt{z.zone.length > 1 ? "s" : ""}{z.zone.length < 3 ? " (3 au moins)" : ""}</b>
                      <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setZones((zs) => zs.filter((_, j) => j !== i)); setActive(0); }} aria-label="Retirer la zone"><Icon name="trash" /></Button></div>
                    <div className="pb2-cond-row"><label>Au moins <input type="number" className="input pb2-num" min={1} max={5} value={z.min_players} onChange={(e) => update(i, { min_players: Number(e.target.value) })} /> joueur(s)</label></div>
                    <div className="pb2-cond-row pb2-types">
                      {(roster.data?.players ?? []).map((p) => <label key={p.steamid} className="hm-check"><input type="checkbox" checked={(z.players ?? []).includes(p.steamid)} onChange={(e) => { const cur = z.players ?? []; update(i, { players: e.target.checked ? [...cur, p.steamid] : cur.filter((x) => x !== p.steamid) } as Partial<ZoneCond>); }} />{p.name}</label>)}
                      {!(z.players ?? []).length && <span className="rf-dim">tous les joueurs</span>}
                    </div>
                  </div>
                ))}
                <label className="pb2-cond-row">Joueurs vivants minimum <input type="number" className="input pb2-num" min={0} max={5} value={minAlive} onChange={(e) => setMinAlive(Number(e.target.value))} aria-label="Joueurs vivants minimum" /></label>
              </div>
            )}
            {tab === "rounds" && (
              <div className="pf-tab">
                <div className="ctx-field"><span className="ctx-label">Tranche du round</span>
                  <div className="map-pills">
                    <button type="button" className={`pill ${stage === null ? "on" : ""}`} onClick={() => setStage(null)}>Tout</button>
                    {STAGES.map(([l], i) => <button key={l} type="button" className={`pill ${stage === i ? "on" : ""}`} onClick={() => setStage(i)}>{l}</button>)}
                  </div></div>
                <div className="ctx-field"><span className="ctx-label">Notre achat</span>
                  <div className="map-pills">{BUYS.map(([k, l]) => <button key={k} type="button" className={`pill ${buy.includes(k) ? "on" : ""}`} onClick={() => setBuy(buy.includes(k) ? buy.filter((x) => x !== k) : [...buy, k])}>{l}</button>)}</div></div>
                <div className="ctx-field"><span className="ctx-label">Issue</span>
                  <div className="ts-seg" role="radiogroup" aria-label="Issue">{([["", "Toutes"], ["won", "Gagnés"], ["lost", "Perdus"]] as const).map(([v, l]) => <button key={v} type="button" role="radio" aria-checked={outcome === v} className={outcome === v ? "on" : ""} onClick={() => setOutcome(v)}>{l}</button>)}</div></div>
                <label className="pb2-cond-row">Écart maximal entre les événements <input type="number" className="input pb2-num" min={0} max={115} value={maxGap} onChange={(e) => setMaxGap(Number(e.target.value))} aria-label="Écart maximal" /> s <span className="rf-dim">(0 = sans limite)</span></label>
                <label className="hm-check"><input type="checkbox" checked={negate} onChange={(e) => setNegate(e.target.checked)} data-testid="pf-negate" />Seulement les rounds qui ne correspondent pas</label>
              </div>
            )}
            {tab === "tactics" && (
              <div className="pf-tab">
                <p className="st-legend">Inclure ou exclure les rounds où une tactique du playbook est utilisée.</p>
                {(tactics.data ?? []).map((t) => (
                  <div key={t.id} className="pf-tactic-row"><span>{t.name}</span>
                    <div className="ts-seg" role="radiogroup" aria-label={`Tactique ${t.name}`}>
                      {([["", "—"], ["in", "Inclure"], ["out", "Exclure"]] as const).map(([v, l]) => { const id = Number(t.id); const cur = include.includes(id) ? "in" : exclude.includes(id) ? "out" : ""; return <button key={v} type="button" role="radio" aria-checked={cur === v} className={cur === v ? "on" : ""} onClick={() => { setInclude(include.filter((x) => x !== id).concat(v === "in" ? [id] : [])); setExclude(exclude.filter((x) => x !== id).concat(v === "out" ? [id] : [])); }}>{l}</button>; })}
                    </div></div>
                ))}
                {!tactics.data?.length && <p className="st-legend">Aucune tactique définie pour cette carte et ce camp. <Link className="pl-link" to={`/playbook?team=${ctx.team}&map=${ctx.map}&tab=manage`}>Créer une tactique ›</Link></p>}
              </div>
            )}
            {zones.length > 0 && <Button size="sm" variant="ghost" onClick={() => { setZones([]); setActive(0); }}>Effacer les zones</Button>}
          </aside>
          <section className="panel co-map pf-map">
            <div className="co-tools"><span className="st-legend">{act ? (act.zone.length < 3 ? `Zone ${active + 1} : cliquez ${3 - act.zone.length} point${3 - act.zone.length > 1 ? "s" : ""} de plus sur la carte pour fermer la zone.` : `Zone ${active + 1} : ${act.zone.length} points · cliquez pour en ajouter, ou passez aux réglages à gauche.`) : "Commencez par « + Zone de joueurs » ou « + Zone de grenades », puis cliquez sur la carte."}</span></div>
            <ZoneCanvas meta={meta} level={level} onLevel={setLevel} shapes={zones} active={active} drawing={!!act}
              onAddPoint={(p) => update(active, { zone: [...zones[active].zone, p], ...(meta && meta.levels.length > 1 ? { level } : {}) } as Partial<ZoneCond>)} testId="pf-map" />
          </section>
          <aside className="panel section pf-results">
            <div className="pf-replay">
              <Button variant="primary" onClick={() => void overlay()} disabled={!res?.ids.length} data-testid="pf-replay"><Icon name="layers" />Rejouer {res ? `${res.matched.length}/${res.total}` : "…"} rounds</Button>
              <Button size="sm" variant="ghost" onClick={saveAsTactic} disabled={!conditions.length} data-testid="pf-save">Enregistrer comme tactique</Button>
            </div>
            {res && <p className="st-legend pf-summary" data-testid="pf-summary">{conditions.length || buy.length || outcome || include.length || exclude.length || minAlive
              ? <><b>{res.matched.length}</b> round{res.matched.length > 1 ? "s" : ""} sur {res.total} correspond{res.matched.length > 1 ? "ent" : ""} à votre motif{negate ? " (inversé)" : ""}.</>
              : <>Aucun motif pour l'instant : les <b>{res.total}</b> rounds {side} de l'équipe sur cette carte sont listés.</>}</p>}
            {search.isPending && !res ? <Spinner /> : !res ? null : !res.matched.length ? <p className="cm-empty">Aucun round ne correspond : élargissez la zone, baissez le nombre de joueurs ou changez la tranche du round.</p> : (
              <ul className="pf-rounds" data-testid="pf-rounds">
                {res.matched.map((r) => (
                  <li key={r.round_id}>
                    <Link className="pl-link" to={`/matches/${r.match_id}/replay/${r.number}?${fromHere()}`}><b>R{r.number}</b> <span className={r.won ? "pos" : "neg"}>{r.won ? "V" : "D"}</span> · {r.buy} · {r.opponent}</Link>
                    <small className="rf-dim mono">{formatDate(r.date)}{conditions.length && !negate ? ` · ${clock(r.at_s)}` : ""}</small>
                  </li>
                ))}
              </ul>
            )}
            {res && <p className="st-legend">{res.total} round{res.total > 1 ? "s" : ""} {side} observé{res.total > 1 ? "s" : ""} ; la superposition prend les 25 premiers.</p>}
          </aside>
        </div>
      )}
    </div>
  );
}
