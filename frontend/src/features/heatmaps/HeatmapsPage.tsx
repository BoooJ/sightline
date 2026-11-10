import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../shared/api/client";
import { useUrlParams } from "../../shared/useUrlParams";
import type { HeatPoint, MapMeta } from "../../shared/api/types";
import { EmptyState } from "../../shared/ui/EmptyState";
import { Spinner } from "../../shared/ui/Spinner";
import { BUYS } from "../rounds/RoundsPage";
import { SIZE, drawControl, drawHeat, hexToRgb } from "./render";
import "../grenades/grenades.css";
import { DemoSelect } from "../library/DemoSelect";
import { weaponLabel } from "../../shared/format";
import "./heatmaps.css";

const KINDS = [["presence", "Présence"], ["control", "Contrôle"], ["kills", "Kills"], ["deaths", "Morts"]] as const;
// libellés à l'horloge du jeu (1:55 au début du round) ; la valeur reste en secondes écoulées
const WINDOWS = [[undefined, "Tout le round", ""], ["0-20", "1:55 – 1:35", "20 premières secondes"], ["20-40", "1:35 – 1:15", "de 20 à 40 s de jeu"],
  ["40-60", "1:15 – 0:55", "de 40 à 60 s de jeu"], ["60-", "0:55 et après", "après 60 s de jeu (et après le plant)"]] as const;

export function HeatmapsPage() {
  const [params, set] = useUrlParams();
  const maps = useQuery({ queryKey: ["maps"], queryFn: api.maps, staleTime: Infinity });
  const matches = useQuery({ queryKey: ["matches", "", ""], queryFn: () => api.matches() });
  const defaultMap = useMemo(() => {
    const n: Record<string, number> = {};
    matches.data?.forEach((m) => { n[m.map_name] = (n[m.map_name] ?? 0) + 1; });
    return Object.entries(n).sort((a, b) => b[1] - a[1])[0]?.[0];
  }, [matches.data]);
  const mapName = params.get("map") ?? defaultMap;
  const map = maps.data?.find((m) => m.name === mapName);
  const kind = params.get("kind") ?? "presence";
  const side = params.get("side") ?? undefined, team = params.get("team") ?? undefined, player = params.get("player") ?? undefined;
  const buy = params.get("buy") ?? undefined, win = params.get("win") ?? undefined;
  const [tFrom, tTo] = win ? win.split("-") : [undefined, undefined];
  const [level, setLevel] = useState<string | null>(null);
  const [gamma, setGamma] = useState(0.6);
  const [showPoints, setShowPoints] = useState(true);
  useEffect(() => setLevel(null), [mapName]);
  const lvl = level ?? map?.levels[0]?.name ?? "";

  const matchId = params.get("match") ?? undefined;
  const weapon = params.get("weapon") ?? undefined;
  const weaponList = useQuery({ queryKey: ["round-weapons", mapName ?? ""], queryFn: () => api.roundWeapons(mapName), enabled: !!mapName });
  const roster = useQuery({ queryKey: ["heat-players", mapName], queryFn: () => api.heatPlayers(mapName!), enabled: !!mapName });
  const matchDetail = useQuery({ queryKey: ["match", Number(matchId)], queryFn: () => api.match(Number(matchId)), enabled: !!matchId });
  const heat = useQuery({
    queryKey: ["heatmap", mapName, kind, side, team, player, buy, win, matchId, weapon],
    queryFn: () => api.heatmap({ map: mapName, kind, side, team, player, buy, t_from: tFrom || undefined, t_to: tTo || undefined, match: matchId,
      weapon: kind === "kills" || kind === "deaths" ? weapon : undefined }),
    enabled: !!mapName, placeholderData: (prev) => prev,
  });
  // une démo choisie : seulement ses équipes et ses joueurs
  const md = matchId ? matchDetail.data : undefined;
  const pool = md ? md.players.map((p) => ({ steamid: p.steamid, name: p.name, team_id: p.team_id,
    team: p.team_id === md.team_a.id ? md.team_a.name : md.team_b.name })) : roster.data ?? [];
  const teams = [...new Map(pool.map((p) => [p.team_id, p.team])).entries()];
  const players = pool.filter((p) => !team || String(p.team_id) === team);
  const buySet = new Set(buy ? buy.split(",") : []);
  const toggleBuy = (v: string) => { buySet.has(v) ? buySet.delete(v) : buySet.add(v); set("buy", buySet.size ? [...buySet].join(",") : undefined); };
  const cells = heat.data?.levels[lvl] ?? [];

  return (
    <div className="gr">
      <aside className="gr-filters">
        <div className="eyebrow">Cartes</div>
        <h1 className="display gr-title">Heatmaps</h1>
        <div className="rf-group"><span className="rf-label">Carte</span>
          <select className="rf-select" value={mapName ?? ""} onChange={(e) => set({ map: e.target.value, player: null, team: null, match: null })} aria-label="Carte">
            {maps.data?.map((m) => <option key={m.name} value={m.name}>{m.display_name}</option>)}
          </select></div>
        <div className="rf-group"><span className="rf-label">Données</span>
          <div className="hm-kinds" role="group" aria-label="Données">
            {KINDS.map(([k, l]) => <button key={k} type="button" className={`pill ${kind === k ? "on" : ""}`} onClick={() => set("kind", k === "presence" ? undefined : k)}>{l}</button>)}
          </div></div>
        <div className="rf-group"><span className="rf-label">Camp</span>
          <div className="map-pills" role="group" aria-label="Camp">
            {([undefined, "CT", "T"] as const).map((s) => (
              <button key={s ?? "all"} type="button" className={`pill ${side === s ? "on" : ""} ${s ? `pill-${s.toLowerCase()}` : ""}`} onClick={() => set("side", s)}>{s ?? "Tous"}</button>
            ))}
          </div></div>
        <DemoSelect map={mapName} value={matchId} onChange={(v) => set({ match: v, team: null, player: null })} />
        <label className="rf-group"><span className="rf-label">Équipe</span>
          <select className="rf-select" value={team ?? ""} onChange={(e) => set({ team: e.target.value, player: null })}>
            <option value="">Toutes</option>{teams.map(([id, n]) => <option key={id} value={id}>{n}</option>)}
          </select></label>
        <label className="rf-group"><span className="rf-label">Joueur</span>
          <select className="rf-select" value={player ?? ""} onChange={(e) => set("player", e.target.value || undefined)}>
            <option value="">Tous</option>{players.map((p) => <option key={p.steamid} value={p.steamid}>{p.name}</option>)}
          </select></label>
        {(kind === "kills" || kind === "deaths") && (
          <label className="rf-group"><span className="rf-label">Arme</span>
            <select className="rf-select" value={weapon ?? ""} onChange={(e) => set("weapon", e.target.value || undefined)} aria-label="Arme">
              <option value="">Toutes les armes</option>
              {weaponList.data?.map((w) => <option key={w.weapon} value={w.weapon}>{weaponLabel(w.weapon)} ({w.kills})</option>)}
            </select></label>
        )}
        <div className="rf-group"><span className="rf-label" title="Horloge du jeu : le round commence à 1:55">Moment du round (horloge)</span>
          <div className="map-pills" role="group" aria-label="Moment du round">
            {WINDOWS.map(([v, l, hint]) => <button key={String(v ?? "all")} type="button" className={`pill ${win === v ? "on" : ""}`} onClick={() => set("win", v)} title={hint || undefined}>{l}</button>)}
          </div></div>
        <div className="rf-group"><span className="rf-label">Achat</span>
          <div className="map-pills" role="group" aria-label="Achat">
            <button type="button" className={`pill ${!buySet.size ? "on" : ""}`} onClick={() => set("buy")}>Tous</button>
            {BUYS.map(([v, l]) => <button key={v} type="button" className={`pill ${buySet.has(v) ? "on" : ""}`} onClick={() => toggleBuy(v)}>{l}</button>)}
          </div></div>
        <label className="rf-group"><span className="rf-label">Contraste</span>
          <input type="range" min={0.25} max={1} step={0.05} value={gamma} onChange={(e) => setGamma(Number(e.target.value))} className="hm-range" />
        </label>
        {(kind === "kills" || kind === "deaths") && (
          <label className="hm-check"><input type="checkbox" checked={showPoints} onChange={(e) => setShowPoints(e.target.checked)} />Afficher les points</label>
        )}
        <p className="gr-count mono" data-testid="heat-count">{heat.data?.rounds ?? 0} round(s) · {kind === "kills" || kind === "deaths" ? `${heat.data?.points.length ?? 0} événement(s)` : `${cells.length} case(s)`}</p>
      </aside>

      <section className="gr-map" aria-busy={heat.isFetching}>
        {map && map.levels.length > 1 && (
          <div className="gr-levels map-pills" role="group" aria-label="Niveau">
            {map.levels.map((l) => <button key={l.name} type="button" className={`pill ${lvl === l.name ? "on" : ""}`} onClick={() => setLevel(l.name)}>{l.name === "lower" ? "Bas" : l.name === "upper" ? "Haut" : l.name}</button>)}
          </div>
        )}
        {kind === "control" && <div className="hm-legend"><span className="hm-ct">CT</span><i /><span className="hm-t">T</span></div>}
        {kind !== "control" && <div className="hm-legend heat"><span>Rare</span><i /><span>Fréquent</span></div>}
        {!map || heat.isLoading ? <Spinner /> : !heat.data?.rounds ? (
          <EmptyState title="Aucune donnée">Aucun round ne correspond à ces filtres sur cette carte.</EmptyState>
        ) : <HeatCanvas map={map} level={lvl} kind={kind} cells={cells} bin={heat.data.bin} gamma={gamma}
              points={showPoints ? heat.data.points.filter((p) => p.level === lvl) : []} />}
      </section>

      <aside className="gr-detail">
        <h2 className="section-title">{kind === "kills" ? "Kills" : kind === "deaths" ? "Morts" : "Lecture"}</h2>
        {kind === "kills" || kind === "deaths" ? (
          <ul className="gr-occ">
            {heat.data?.points.slice(0, 80).map((p, k) => (
              <li key={k}>
                <span><b className={p.side === "CT" ? "gr-ct" : "gr-t"}>{p.player}</b> <small>{p.weapon}{p.headshot ? " · HS" : ""} · R{p.round_number}</small></span>
                <Link className="btn btn-sm btn-ghost" to={`/matches/${p.match_id}/replay/${p.round_number}?t=${Math.max(0, p.tick - 320)}`} title="Voir dans le replay">▶</Link>
              </li>
            ))}
          </ul>
        ) : (
          <div className="hm-help">
            {kind === "control"
              ? <p>Chaque zone prend la couleur du camp qui l'occupe le plus : <b className="gr-ct">bleu</b> pour CT, <b className="gr-t">orange</b> pour T. Plus la couleur est franche, plus le contrôle est net.</p>
              : <p>Densité de présence des joueurs vivants, échantillonnée sur toute la durée des rounds retenus (après le freeze time).</p>}
            <p>Combinez <b>Moment du round</b> et <b>Achat</b> pour voir, par exemple, les placements CT de 1:55 à 1:35 (les 20 premières secondes) en full buy.</p>
          </div>
        )}
      </aside>
    </div>
  );
}

export function HeatCanvas({ map, level, kind, cells, bin, gamma, points }: {
  map: MapMeta; level: string; kind: string; cells: number[][]; bin: number; gamma: number; points: HeatPoint[];
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  // vue : zoom s, centre (cx, cy) en % de l'image ; cadrage initial sur la zone occupée
  const [zoom, setZoom] = useState({ s: 1, cx: 50, cy: 50 });
  const fitted = useRef<string | null>(null);
  const drag = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);
  useEffect(() => {
    const key = `${map.name}/${level}`;
    if (fitted.current === key || !cells.length) return;
    fitted.current = key;
    const xs = cells.map((c) => c[0] * bin), ys = cells.map((c) => c[1] * bin);
    const x0 = Math.min(...xs), x1 = Math.max(...xs) + bin, y0 = Math.min(...ys), y1 = Math.max(...ys) + bin;
    const s = Math.min(4, Math.max(1, SIZE / (Math.max(x1 - x0, y1 - y0) * 1.15)));
    setZoom({ s, cx: ((x0 + x1) / 2 / SIZE) * 100, cy: ((y0 + y1) / 2 / SIZE) * 100 });
  }, [map.name, level, cells, bin]);
  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, SIZE, SIZE);
    if (kind === "control") {
      const css = getComputedStyle(document.documentElement);
      drawControl(ctx, cells, bin, gamma, 0.85, hexToRgb(css.getPropertyValue("--ct")), hexToRgb(css.getPropertyValue("--t")));
    } else drawHeat(ctx, cells, bin, gamma, 0.8);
  }, [cells, bin, gamma, kind]);
  const image = map.levels.find((l) => l.name === level)?.image ?? map.image;
  return (
    <div className="hm-stage" data-testid="heatmap"
      onWheel={(e) => setZoom((z) => ({ ...z, s: Math.min(6, Math.max(1, z.s * (e.deltaY > 0 ? 1 / 1.2 : 1.2))) }))}
      onMouseDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, cx: zoom.cx, cy: zoom.cy }; }}
      onMouseMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const r = e.currentTarget.getBoundingClientRect();
        setZoom((z) => ({ ...z, cx: d.cx - ((e.clientX - d.x) / r.width) * 100 / z.s, cy: d.cy - ((e.clientY - d.y) / r.height) * 100 / z.s }));
      }}
      onMouseUp={() => { drag.current = null; }} onMouseLeave={() => { drag.current = null; }}>
      <div className="hm-inner" style={{ transform: `scale(${zoom.s}) translate(${50 - zoom.cx}%, ${50 - zoom.cy}%)` }}>
        <img src={`/maps/${image}`} alt="" className="hm-radar" draggable={false} />
        <canvas ref={ref} width={SIZE} height={SIZE} className="hm-canvas" />
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="hm-points">
          {points.map((p, k) => (
            <circle key={k} cx={p.x} cy={p.y} r={4.5 / zoom.s} className={p.side === "CT" ? "ct" : "t"} />
          ))}
        </svg>
      </div>
    </div>
  );
}
