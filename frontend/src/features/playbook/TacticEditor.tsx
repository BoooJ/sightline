import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../../shared/api/client";
import type { MapMeta, Side, TacticCondition } from "../../shared/api/types";
import { Button } from "../../shared/ui/Button";
import { Icon } from "../../shared/ui/Icon";
import { Spinner } from "../../shared/ui/Spinner";
import { COND_LABEL, clock } from "./PlaybookPage";
import { DRAFT_KEY } from "./PatternFinderPage";
import { ZoneCanvas } from "./ZoneCanvas";
import "../callouts/callouts.css";
import "./playbook.css";

const GRENADES: [string, string][] = [["smoke", "Smoke"], ["flash", "Flash"], ["he", "HE"], ["molotov", "Molotov"], ["incendiary", "Incendiaire"], ["decoy", "Leurre"]];
type Zone = [number, number][];
const hasZone = (c: TacticCondition): c is Extract<TacticCondition, { zone: Zone }> => c.kind === "players_in_zone" || c.kind === "utility_in_zone";

function fresh(kind: TacticCondition["kind"]): TacticCondition {
  switch (kind) {
    case "players_in_zone": return { kind, zone: [], min_players: 2, from_s: 0, to_s: 60 };
    case "utility_in_zone": return { kind, zone: [], types: ["smoke"], min_count: 1, position: "land", from_s: 0, to_s: 60 };
    case "bomb_planted": return { kind, site: null, before_s: 115 };
    case "contact_before": return { kind, s: 20 };
    default: return { kind: "no_contact_before", s: 40 };
  }
}

/** Éditeur de tactique : carte (polygones dessinés point par point), conditions et métadonnées. */
export function TacticEditor() {
  const { id } = useParams();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const existing = useQuery({ queryKey: ["tactic", id], queryFn: () => api.tactic(Number(id)), enabled: !!id });
  const maps = useQuery({ queryKey: ["maps"], queryFn: api.maps, staleTime: Infinity });
  const cats = useQuery({ queryKey: ["tactic-categories"], queryFn: api.tacticCategories, staleTime: Infinity });
  const [name, setName] = useState("");
  const [map, setMap] = useState(sp.get("map") ?? "");
  const [side, setSide] = useState<Side>((sp.get("side") as Side) || "T");
  const [category, setCategory] = useState("mid_round");
  const [tags, setTags] = useState("");
  const [description, setDescription] = useState("");
  const [conds, setConds] = useState<TacticCondition[]>([fresh("players_in_zone")]);
  const [active, setActive] = useState(0);
  const [level, setLevel] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const team = sp.get("team");
  // brouillon venu du Pattern Finder (« Enregistrer comme tactique »)
  useEffect(() => {
    if (id || sp.get("draft") !== "1") return;
    try {
      const raw = sessionStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const d = JSON.parse(raw) as { map?: string; side?: Side; conditions?: TacticCondition[] };
      if (d.map) setMap(d.map);
      if (d.side) setSide(d.side);
      if (d.conditions?.length) setConds(d.conditions);
      sessionStorage.removeItem(DRAFT_KEY);
    } catch { /* brouillon illisible */ }
  }, [id, sp]);
  useEffect(() => {
    const t = existing.data;
    if (!t) return;
    setName(t.name); setMap(t.map); setSide(t.side); setCategory(t.category); setTags(t.tags.join(", ")); setDescription(t.description);
    setConds(t.definition.conditions.length ? t.definition.conditions : [fresh("players_in_zone")]);
  }, [existing.data]);
  const meta: MapMeta | undefined = maps.data?.find((m) => m.name === map);
  useEffect(() => { if (meta && !meta.levels.some((l) => l.name === level)) setLevel(meta.levels[0]?.name ?? ""); }, [meta, level]);
  const update = (i: number, patch: Partial<TacticCondition>) => setConds((cs) => cs.map((c, j) => (j === i ? ({ ...c, ...patch } as TacticCondition) : c)));
  const addPoint = (p: [number, number]) => {
    const c = conds[active];
    if (!meta || !c || !hasZone(c)) return;
    update(active, { zone: [...c.zone, p], ...(meta.levels.length > 1 ? { level } : {}) } as Partial<TacticCondition>);
  };
  const save = async () => {
    setErr(null);
    const body = { name, map, side, category, tags: tags.split(",").map((t) => t.trim()).filter(Boolean), description, definition: { conditions: conds } };
    setBusy(true);
    try {
      const t = id ? await api.updateTactic(Number(id), body) : await api.createTactic(body);
      qc.invalidateQueries({ queryKey: ["tactics"] }); qc.invalidateQueries({ queryKey: ["playbook2"] });
      nav(`/playbook?${new URLSearchParams({ ...(team ? { team } : {}), map: t.map, side: t.side, tab: "manage" })}`);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  if (id && existing.isLoading) return <div className="page"><Spinner /></div>;
  const act = conds[active];
  return (
    <div className="page pb2-editor" data-testid="tactic-editor">
      <Link to={`/playbook?${new URLSearchParams({ ...(team ? { team } : {}), ...(map ? { map } : {}), side, tab: "manage" })}`} className="back-link"><Icon name="back" />Playbook</Link>
      <div className="lib-head">
        <div><div className="eyebrow">Playbook</div><h1 className="display">{id ? "Modifier la tactique" : "Nouvelle tactique"}</h1></div>
        <div className="lib-tools">
          <Button variant="primary" onClick={() => void save()} disabled={busy || !name.trim() || !map || conds.some((c) => hasZone(c) && c.zone.length < 3)} data-testid="tactic-save"><Icon name="book" />Enregistrer</Button>
        </div>
      </div>
      {err && <p className="auth-error">{err}</p>}
      <div className="pb2-editor-grid">
        <section className="panel co-map pb2-map">
          <div className="co-tools">
            <span className="st-legend">{act && hasZone(act) ? "Cliquez sur la carte pour ajouter les points du polygone de la condition sélectionnée." : "Sélectionnez une condition « zone » pour dessiner."}</span>
          </div>
          <ZoneCanvas meta={meta} level={level} onLevel={setLevel} shapes={conds.filter(hasZone).map((c) => ({ zone: c.zone, level: c.level, kind: c.kind }))}
            active={conds.filter(hasZone).indexOf(act as Extract<TacticCondition, { zone: Zone }>)} drawing={!!act && hasZone(act)} onAddPoint={addPoint} testId="tactic-map" />
        </section>
        <section className="panel section pb2-form">
          <label className="auth-field"><span>Nom</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="ex. Exécution B avec smoke CT" data-testid="tactic-name" /></label>
          <div className="pb2-form-row">
            <label className="auth-field"><span>Carte</span>
              <select className="rf-select" value={map} onChange={(e) => { setMap(e.target.value); setConds((cs) => cs.map((c) => (hasZone(c) ? { ...c, zone: [] } : c))); }} aria-label="Carte de la tactique" disabled={!!id}>
                <option value="">Choisir…</option>{maps.data?.map((m) => <option key={m.name} value={m.name}>{m.display_name}</option>)}</select></label>
            <div className="auth-field"><span>Camp</span>
              <div className="ts-seg" role="radiogroup" aria-label="Camp de la tactique">
                {(["T", "CT"] as Side[]).map((s) => <button key={s} type="button" role="radio" aria-checked={side === s} className={side === s ? "on" : ""} onClick={() => setSide(s)} disabled={!!id}>{s}</button>)}
              </div></div>
            <label className="auth-field"><span>Catégorie</span>
              <select className="rf-select" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Catégorie">
                {(cats.data ?? []).map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select></label>
          </div>
          <label className="auth-field"><span>Tags (séparés par des virgules)</span><input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="ex. exécution, smoke CT" /></label>
          <label className="auth-field"><span>Description</span><textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="Ce que l'équipe fait, pour les coéquipiers." /></label>
          <h2 className="section-title pb2-cond-title">Conditions <span className="rf-dim">toutes doivent être vraies</span></h2>
          <ol className="pb2-conds">
            {conds.map((c, i) => (
              <li key={i} className={`pb2-cond ${i === active ? "on" : ""}`} onClick={() => setActive(i)} data-testid="tactic-condition">
                <div className="pb2-cond-head">
                  <b>{i + 1}. {COND_LABEL[c.kind]}</b>
                  <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setConds((cs) => cs.filter((_, j) => j !== i)); setActive(0); }} aria-label="Retirer la condition" disabled={conds.length === 1}><Icon name="trash" /></Button>
                </div>
                {hasZone(c) && (<>
                  <div className="pb2-cond-row">
                    <span className="rf-dim">{c.zone.length} point{c.zone.length > 1 ? "s" : ""}{c.zone.length < 3 ? " (3 au moins)" : ""}</span>
                    <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); update(i, { zone: c.zone.slice(0, -1) } as Partial<TacticCondition>); }} disabled={!c.zone.length}>Retirer le dernier point</Button>
                    <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); update(i, { zone: [] } as Partial<TacticCondition>); }} disabled={!c.zone.length}>Effacer</Button>
                  </div>
                  <div className="pb2-cond-row">
                    <label>De <input type="number" className="input pb2-num" min={0} max={115} value={c.from_s} onChange={(e) => update(i, { from_s: Number(e.target.value) } as Partial<TacticCondition>)} /> s</label>
                    <label>à <input type="number" className="input pb2-num" min={1} max={115} value={c.to_s} onChange={(e) => update(i, { to_s: Number(e.target.value) } as Partial<TacticCondition>)} /> s</label>
                    <span className="rf-dim mono">({clock(c.from_s)} → {clock(c.to_s)})</span>
                  </div>
                </>)}
                {c.kind === "players_in_zone" && <div className="pb2-cond-row"><label>Au moins <input type="number" className="input pb2-num" min={1} max={5} value={c.min_players} onChange={(e) => update(i, { min_players: Number(e.target.value) } as Partial<TacticCondition>)} /> joueur(s) vivant(s) dans la zone</label></div>}
                {c.kind === "utility_in_zone" && (<>
                  <div className="pb2-cond-row pb2-types">
                    {GRENADES.map(([k, l]) => <label key={k} className="hm-check"><input type="checkbox" checked={c.types.includes(k)} onChange={(e) => update(i, { types: e.target.checked ? [...c.types, k] : c.types.filter((x) => x !== k) } as Partial<TacticCondition>)} />{l}</label>)}
                  </div>
                  <div className="pb2-cond-row">
                    <label>Au moins <input type="number" className="input pb2-num" min={1} max={10} value={c.min_count} onChange={(e) => update(i, { min_count: Number(e.target.value) } as Partial<TacticCondition>)} /></label>
                    <label><select className="rf-select" value={c.position} onChange={(e) => update(i, { position: e.target.value as "land" | "throw" } as Partial<TacticCondition>)} aria-label="Position"><option value="land">qui atterrissent dans la zone</option><option value="throw">lancées depuis la zone</option></select></label>
                  </div>
                </>)}
                {c.kind === "bomb_planted" && <div className="pb2-cond-row"><label>Site <select className="rf-select" value={c.site ?? ""} onChange={(e) => update(i, { site: (e.target.value || null) as "A" | "B" | null } as Partial<TacticCondition>)} aria-label="Site"><option value="">A ou B</option><option value="A">A</option><option value="B">B</option></select></label><label>avant <input type="number" className="input pb2-num" min={1} max={115} value={c.before_s} onChange={(e) => update(i, { before_s: Number(e.target.value) } as Partial<TacticCondition>)} /> s</label></div>}
                {(c.kind === "contact_before" || c.kind === "no_contact_before") && <div className="pb2-cond-row"><label>{c.kind === "contact_before" ? "Premier contact avant" : "Aucun contact avant"} <input type="number" className="input pb2-num" min={1} max={115} value={c.s} onChange={(e) => update(i, { s: Number(e.target.value) } as Partial<TacticCondition>)} /> s <span className="rf-dim mono">({clock(c.s)})</span></label></div>}
              </li>
            ))}
          </ol>
          <div className="pb2-add">
            <span className="rf-label">Ajouter</span>
            {(Object.keys(COND_LABEL) as TacticCondition["kind"][]).map((k) => <button key={k} type="button" className="pill" onClick={() => { setConds((cs) => [...cs, fresh(k)]); setActive(conds.length); }}>{COND_LABEL[k]}</button>)}
          </div>
          <p className="st-legend">Les temps sont comptés en secondes après la fin du freeze time (1:55 = 0 s). La tactique est détectée dans tous les rounds de cette carte et de ce camp, pour toutes les équipes.</p>
        </section>
      </div>
    </div>
  );
}
