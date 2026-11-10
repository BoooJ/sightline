import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../../shared/api/client";
import type { MapMeta, Side, StratCategory, StratStatus, StratSummary, StratType } from "../../shared/api/types";
import { useUrlParams } from "../../shared/useUrlParams";
import { Button } from "../../shared/ui/Button";
import { EmptyState } from "../../shared/ui/EmptyState";
import { Icon } from "../../shared/ui/Icon";
import { Spinner } from "../../shared/ui/Spinner";
import { NotesPanel } from "../notes/NotesPanel";
import { StratList } from "./StratList";
import type { PanelTab } from "./StratPanel";
import { StratView } from "./StratView";
import { Memo } from "./Memo";
import { STRAT_CATEGORIES, STRAT_TYPES, stratHref } from "./strat";
import "../match/match.css";
import "./stratbook.css";

export { STRAT_TYPES };

/** Stratbook en une seule page : une carte choisie, ses stratégies à gauche (T puis CT), la stratégie choisie au centre
 *  (carte, tableau tactique) et ses détails à droite (Plan · Joueurs · Grenades · Notes). Adresse :
 *  `/stratbook?map=<carte>&side=<T|CT>&s=<id>` ; sans `s`, la première de la liste. Onglet Notes : `view=notes`. */
export function StratbookPage() {
  const [params, set] = useUrlParams();
  const viewParam = params.get("view");
  const view = viewParam === "notes" || viewParam === "memo" ? viewParam : "strats";
  // filtres de la liste : genre de round (code couleur) et état
  const cat = params.get("cat") as StratCategory | null;
  const st = params.get("st") as StratStatus | null;
  const sideParam = params.get("side");
  const side = sideParam === "T" || sideParam === "CT" ? sideParam : undefined;
  const board = params.get("board") === "1";
  const maps = useQuery({ queryKey: ["maps"], queryFn: api.maps, staleTime: Infinity });
  const all = useQuery({ queryKey: ["strats", "all"], queryFn: () => api.strats() });
  const [creating, setCreating] = useState(params.get("new") === "1");
  useEffect(() => { if (params.get("new") === "1") { setCreating(true); set("new"); } }, [params]);  // eslint-disable-line react-hooks/exhaustive-deps
  // onglet du panneau de droite : gardé d'une stratégie à l'autre
  const [tab, setTab] = useState<PanelTab>("plan");

  const strats = all.data ?? [];
  // cartes de l'application, plus celles d'anciennes stratégies qui n'y figurent plus
  const known = maps.data ?? [];
  const mapList: MapMeta[] = [...known, ...[...new Set(strats.map((s) => s.map))].filter((m) => !known.some((k) => k.name === m))
    .map((m) => ({ name: m, display_name: m } as MapMeta))];
  const label = (m: string) => mapList.find((x) => x.name === m)?.display_name ?? m;
  const shown = strats.filter((s) => !side || s.side === side);
  const count = (m: string) => shown.filter((s) => s.map === m).length;
  // carte par défaut : celle qui a le plus de stratégies (tous camps confondus, pour ne pas changer en filtrant le camp)
  const busiest = mapList.reduce<{ name?: string; n: number }>((best, m) => {
    const n = strats.filter((s) => s.map === m.name).length;
    return n > best.n ? { name: m.name, n } : best;
  }, { name: mapList[0]?.name, n: 0 }).name;
  const map = params.get("map") ?? (view === "strats" ? busiest : undefined);
  const onMap = shown.filter((s) => s.map === map);
  const list = onMap.filter((s) => (!cat || s.category === cat) && (!st || s.status === st)).sort((a, b) => (a.side === b.side ? 0 : a.side === "T" ? -1 : 1));
  // stratégie choisie : celle de l'adresse si elle est dans la liste (ou si la liste se recharge juste après une création)
  const sid = Number(params.get("s")) || undefined;
  const selected = sid && (list.some((s) => s.id === sid) || all.isFetching) ? sid : list[0]?.id;

  // ↑ ↓ : stratégie précédente / suivante (hors champs de saisie, dialogues, menus et tableau tactique)
  // valeurs du dernier rendu (dont `set` : celui du premier rendu repartirait d'une adresse périmée)
  const latest = useRef({ list, selected, board, view, set });
  latest.current = { list, selected, board, view, set };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { list: l, selected: cur, board: b, view: v, set: go } = latest.current;
      if ((e.key !== "ArrowDown" && e.key !== "ArrowUp") || v !== "strats" || b) return;
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.defaultPrevented) return;
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable='true']")) return;
      if (document.querySelector(".dialog-backdrop, .pop")) return;
      const next = l[l.findIndex((s) => s.id === cur) + (e.key === "ArrowDown" ? 1 : -1)];
      if (!next) return;
      e.preventDefault();
      go({ s: String(next.id) });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // la suivante et la précédente sont chargées d'avance : le passage au clavier est immédiat
  const qc = useQueryClient();
  useEffect(() => {
    const i = list.findIndex((s) => s.id === selected);
    for (const n of [list[i - 1], list[i + 1]]) if (n) void qc.prefetchQuery({ queryKey: ["strat", n.id], queryFn: () => api.strat(n.id) });
  }, [selected, all.dataUpdatedAt]);  // eslint-disable-line react-hooks/exhaustive-deps

  const pickSide = (v: Side | undefined) => {
    const cur = strats.find((s) => s.id === selected);
    set({ side: v, s: cur && (!v || cur.side === v) ? params.get("s") : null, board: v && cur && cur.side !== v ? null : params.get("board"), cat: null, st: null });
  };
  return (
    <div className="page sb-ws-page">
      <div className="lib-head sb-pagehead">
        <div><div className="eyebrow">Équipe</div><h1 className="display">Stratbook <span className="lib-count mono">{all.data?.length ?? 0}</span></h1></div>
      </div>
      {creating && maps.data && <NewStrat maps={maps.data} map={map} side={side} onClose={() => setCreating(false)} />}
      <div className="tabs sb-head">
        <nav className="sb-head-tabs" role="tablist" aria-label="Stratbook">
          {([["strats", "Stratégies"], ["notes", "Notes"], ["memo", "Mémo"]] as const).map(([k, l]) => (
            <button key={k} type="button" role="tab" aria-selected={view === k} className={`tab ${view === k ? "on" : ""}`}
              onClick={() => set({ view: k === "strats" ? undefined : k, board: null })} data-testid={`sb-view-${k}`}>{l}</button>
          ))}
        </nav>
        <div className="map-pills tabs-filter" role="group" aria-label="Carte">
          {view !== "strats" && <button type="button" className={`pill ${!map ? "on" : ""}`} onClick={() => set("map")}>Toutes</button>}
          {mapList.map((m) => {
            const n = count(m.name);
            return (
              <button key={m.name} type="button" className={`pill ${map === m.name ? "on" : ""}`} aria-pressed={map === m.name}
                onClick={() => set({ map: m.name, s: null, board: null, cat: null, st: null })}>
                {m.display_name}{view === "strats" && n > 0 && <span className="sb-pill-n mono">{n}</span>}</button>
            );
          })}
        </div>
        <div className="map-pills tabs-filter" role="group" aria-label="Camp">
          {([undefined, "T", "CT"] as const).map((s) => (
            <button key={s ?? "all"} type="button" className={`pill ${side === s ? "on" : ""} ${s ? `pill-${s.toLowerCase()}` : ""}`} aria-pressed={side === s}
              onClick={() => pickSide(s)}>{s ?? "Tous"}</button>
          ))}
        </div>
      </div>
      {view === "memo" ? <Memo maps={known} map={map} side={side} /> : view === "notes" ? (
        <NotesPanel title={map ? `Notes · ${label(map)}` : "Notes"} filter={{ map, side }}
          draft={{ map: map ?? "", side: side ?? null }}
          empty={map ? `Aucune note sur ${label(map)}. Un timing, une habitude adverse, un contre : notez-le ici ou depuis l'app.` : "Aucune note pour l'instant. Elles s'écrivent ici ou depuis l'app mobile."} />
      ) : all.isLoading || !maps.data || !map ? <Spinner /> : (
        <div className="sb-ws">
          <StratList list={list} selectedId={selected} mapLabel={label(map)} onNew={() => setCreating(true)}
            filters={<ListFilters strats={onMap} cat={cat} st={st} set={set} />} />
          {selected ? <StratView id={selected} maps={known} tab={tab} onTab={setTab} /> : (
            <section className="panel sb-center sb-span sb-empty-center">
              <EmptyState icon="book" title={`Aucune stratégie${side ? ` ${side}` : ""} sur ${label(map)}`}>« Nouvelle stratégie » pour la dessiner sur la carte (joueurs, grenades, déplacements).
                Ou, dans un replay, « Ajouter au stratbook » enregistre les positions, les grenades et les dessins d'un instant.</EmptyState>
              <Button variant="primary" onClick={() => setCreating(true)} data-testid="new-strat-empty"><Icon name="plus" size={14} />Nouvelle stratégie</Button>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

/** Filtres de la liste : état (prêtes / à travailler) et genre de round, avec le code couleur de l'équipe. Seuls les genres
 *  présents sur la carte sont proposés. */
function ListFilters({ strats, cat, st, set }: {
  strats: StratSummary[]; cat: StratCategory | null; st: StratStatus | null; set: ReturnType<typeof useUrlParams>[1];
}) {
  const cats = (Object.keys(STRAT_CATEGORIES) as StratCategory[]).map((k) => [k, strats.filter((s) => s.category === k).length] as const).filter(([k, n]) => n > 0 || k === cat);  // le filtre actif reste visible pour pouvoir l'enlever
  const n = (v: StratStatus) => strats.filter((s) => s.status === v).length;
  if (!cats.length && !n("ready") && !n("wip")) return null;
  return (
    <div className="sb-filters" role="group" aria-label="Filtrer les stratégies">
      <div className="map-pills sb-filter-st">
        {([[null, "Toutes"], ["ready", `Prêtes ${n("ready")}`], ["wip", `À travailler ${n("wip")}`]] as const).map(([v, l]) => (
          <button key={l} type="button" className={`pill ${st === v ? "on" : ""}`} aria-pressed={st === v}
            onClick={() => set({ st: v, s: null })}>{l}</button>
        ))}
      </div>
      {cats.length > 0 && (
        <div className="sb-filter-cats">
          {cats.map(([k, count]) => (
            <button key={k} type="button" className={`sb-catpill ${cat === k ? "on" : ""}`} aria-pressed={cat === k}
              style={{ "--cat": STRAT_CATEGORIES[k].color } as React.CSSProperties} title={`${STRAT_CATEGORIES[k].label} (${count})`}
              onClick={() => set({ cat: cat === k ? null : k, s: null })}>{STRAT_CATEGORIES[k].label}<span className="mono">{count}</span></button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Ancienne adresse d'une stratégie (`/stratbook/:id`, liens du replay, des notes, de la recherche) : renvoie vers la page
 *  unique, sur sa carte, en gardant le tableau tactique ouvert (`board=1`) s'il l'était. */
export function StratRedirect() {
  const id = Number(useParams().stratId);
  const [search] = useSearchParams();
  const q = useQuery({ queryKey: ["strat", id], queryFn: () => api.strat(id), retry: false });
  if (q.isLoading) return <div className="page"><Spinner /></div>;
  if (!q.data) return (
    <div className="page"><EmptyState icon="book" title="Stratégie introuvable">Elle a peut-être été supprimée. <Link to="/stratbook" className="nt-link">Retour au stratbook</Link></EmptyState></div>
  );
  return <Navigate replace to={stratHref(q.data, search.get("board") === "1")} />;
}

/** Création d'une stratégie vierge : nom, carte, camp, type, puis ouverture du tableau tactique. */
function NewStrat({ maps, map, side, onClose }: { maps: MapMeta[]; map?: string; side?: Side; onClose: () => void }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [f, setF] = useState({ name: "", map: maps.some((m) => m.name === map) ? map! : maps[0]?.name ?? "", side: side ?? ("T" as Side), type: "execute" as StratType });
  const [err, setErr] = useState<string | null>(null);
  const create = async () => {
    setErr(null);
    try {
      const s = await api.createStrat({ name: f.name.trim() || `${STRAT_TYPES[f.type]} ${f.side}`, map: f.map, side: f.side, type: f.type });
      // la liste rechargée avant d'ouvrir : la nouvelle stratégie y est déjà surlignée
      await qc.invalidateQueries({ queryKey: ["strats"] });
      onClose();
      nav(stratHref(s, true));
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="dialog panel sb-new" role="dialog" aria-label="Nouvelle stratégie" data-testid="new-strat-dialog" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <div className="sb-new-head"><h2 className="display">Nouvelle stratégie</h2><Button size="sm" variant="ghost" onClick={onClose} aria-label="Fermer">✕</Button></div>
        <label className="auth-field"><span>Nom</span><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="ex. Exécution B rapide" autoFocus /></label>
        <div className="auth-field"><span>Carte</span>
          <div className="map-pills" role="group" aria-label="Carte de la stratégie">
            {maps.map((m) => <button key={m.name} type="button" className={`pill ${f.map === m.name ? "on" : ""}`} onClick={() => setF({ ...f, map: m.name })}>{m.display_name}</button>)}
          </div></div>
        <div className="rf-row">
          <div className="auth-field"><span>Camp</span>
            <div className="map-pills" role="group" aria-label="Camp de la stratégie">
              {(["T", "CT"] as const).map((x) => <button key={x} type="button" className={`pill pill-${x.toLowerCase()} ${f.side === x ? "on" : ""}`} onClick={() => setF({ ...f, side: x })}>{x}</button>)}
            </div></div>
          <label className="auth-field"><span>Type</span>
            <select className="rf-select" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as StratType })}>{Object.entries(STRAT_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        </div>
        {err && <p className="auth-error">{err}</p>}
        <div className="sb-new-head"><span className="st-legend">Ensuite : placez les joueurs, les grenades et les déplacements sur la carte.</span>
          <Button type="submit" variant="primary">Créer et dessiner</Button></div>
      </form>
    </div>
  );
}
