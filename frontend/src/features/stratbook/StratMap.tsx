import { useMemo, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import type { MapMeta, Strat } from "../../shared/api/types";
import { levelForZ, RADAR_SIZE, worldToRadar } from "../replay/engine/coords";
import { NADE } from "../grenades/GrenadesPage";

export type BoardItem = { kind: "position" | "grenade"; index: number } | { kind: "shape"; id: string };
export type Layers = { players: boolean; grenades: boolean; paths: boolean; dim: boolean };
const LAYERS_KEY = "sb-layers";
const ALL_LAYERS: Layers = { players: true, grenades: true, paths: true, dim: true };
const LAYER_LABELS: [keyof Layers, string][] = [["players", "Joueurs"], ["grenades", "Grenades"], ["paths", "Tracés"], ["dim", "Fond atténué"]];
// rayon approximatif de la zone couverte, en unités du jeu : dessiné à l'échelle de la carte
const NADE_RADIUS: Partial<Record<string, number>> = { smoke: 144, molotov: 120, incendiary: 120 };

/** Joueur (index de position) d'un dessin : les déplacements importés ou relevés se nomment « …path-N » / « …arrow-N ». */
export const shapeOwner = (id: string): number | null => {
  const m = /(?:^|-)(?:path|arrow)-(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
};
/** Joueur d'une grenade : la position qui porte le nom du lanceur. */
export const grenadeOwner = (strat: Strat, player: string): number | null => {
  const i = player ? strat.positions.findIndex((p) => p.name === player) : -1;
  return i >= 0 ? i : null;
};
/** Couleur du tracé d'un joueur (pastille de la liste des positions), s'il en a un. */
export const ownerColor = (strat: Strat, i: number): string | null => strat.shapes.find((s) => shapeOwner(s.id) === i)?.color ?? null;

function readLayers(): Layers {
  try { return { ...ALL_LAYERS, ...JSON.parse(localStorage.getItem(LAYERS_KEY) ?? "{}") }; } catch { return ALL_LAYERS; }
}
export interface BoardHandlers {
  /** coordonnées radar (0–1024) du pointeur, niveau affiché */
  down?: (pt: [number, number], level: string, e: RPointerEvent) => void;
  move?: (pt: [number, number], e: RPointerEvent) => void;
  up?: (pt: [number, number], e: RPointerEvent) => void;
  item?: (item: BoardItem, e: RPointerEvent) => void;
}

/** Radar d'une stratégie : positions de départ, grenades (trajectoire, impact), dessins enregistrés.
 *  En lecture : calques Joueurs / Grenades / Tracés (mémorisés), et `focus` sur un joueur (son tracé et ses grenades,
 *  le reste estompé ; clic sur un joueur de la carte pour le choisir).
 *  En édition (`board`) : radar entier, tout affiché, niveau piloté de l'extérieur, gestionnaires de pointeur et
 *  calque d'aperçu. */
export function StratMap({ map, strat, board, level: levelProp, onLevelChange, overlay, focus = null, onFocus }: {
  map: MapMeta; strat: Strat; board?: BoardHandlers; level?: string; onLevelChange?: (l: string) => void; overlay?: ReactNode;
  focus?: number | null; onFocus?: (i: number | null) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [layersState, setLayersState] = useState<Layers>(readLayers);
  const layers = board ? ALL_LAYERS : layersState;
  const setLayers = (v: Layers) => { setLayersState(v); try { localStorage.setItem(LAYERS_KEY, JSON.stringify(v)); } catch { /* stockage indisponible */ } };
  const fo = board ? null : focus;
  // opacité d'un élément selon le joueur suivi : le sien en plein, le reste estompé, les éléments sans joueur un peu moins
  const dim = (owner: number | null) => (fo === null ? 1 : owner === fo ? 1 : owner === null ? 0.35 : 0.12);
  const toRadar = (e: RPointerEvent): [number, number] => {
    const svg = svgRef.current!, pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const r = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    return [Math.round(r.x * 10) / 10, Math.round(r.y * 10) / 10];
  };
  // niveau affiché par défaut : celui où se trouvent la plupart des positions
  const initial = useMemo(() => {
    const counts: Record<string, number> = {};
    strat.positions.forEach((p) => { const l = levelForZ(map, p.pos[2]); counts[l] = (counts[l] ?? 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? map.levels[0].name;
  }, [map, strat]);
  const [levelState, setLevelState] = useState(initial);
  const level = levelProp ?? levelState;
  const setLevel = (l: string) => { setLevelState(l); onLevelChange?.(l); };
  const lvl = map.levels.some((l) => l.name === level) ? level : map.levels[0].name;
  const image = map.levels.find((l) => l.name === lvl)?.image ?? map.image;
  const P = (v: [number, number, number]) => worldToRadar(map, v[0], v[1]);
  const onLevel = (v: [number, number, number] | null) => !v || map.levels.length < 2 || levelForZ(map, v[2]) === lvl;
  // cadrage sur le contenu
  const pts = [...strat.positions.map((p) => p.pos), ...strat.grenades.flatMap((g) => [g.throw, g.land].filter(Boolean) as [number, number, number][])].map(P);
  strat.shapes.forEach((s) => s.points.forEach((q) => pts.push(q as [number, number])));
  let view = `0 0 ${RADAR_SIZE} ${RADAR_SIZE}`;
  if (pts.length && !board) {
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const s = Math.min(RADAR_SIZE, Math.max(360, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 1.35);
    view = `${(Math.min(...xs) + Math.max(...xs)) / 2 - s / 2} ${(Math.min(...ys) + Math.max(...ys)) / 2 - s / 2} ${s} ${s}`;
  }
  const k = Number(view.split(" ")[2]) / RADAR_SIZE;
  const sideColor = strat.side === "CT" ? "var(--ct)" : "var(--t)";
  return (
    <div className="sb-map">
      {map.levels.length > 1 && (
        <div className="map-pills sb-levels" role="group" aria-label="Niveau">
          {map.levels.map((l) => <button key={l.name} type="button" className={`pill ${lvl === l.name ? "on" : ""}`} onClick={() => setLevel(l.name)}>{l.name === "upper" ? "Haut" : l.name === "lower" ? "Bas" : l.name}</button>)}
        </div>
      )}
      {!board && (
        <div className="map-pills sb-layers sb-noprint" role="group" aria-label="Calques">
          {LAYER_LABELS.map(([key, label]) => (
            <button key={key} type="button" className={`pill ${layers[key] ? "on" : ""}`} aria-pressed={layers[key]} data-testid={`layer-${key}`}
              onClick={() => setLayers({ ...layers, [key]: !layers[key] })}>{label}</button>
          ))}
          {fo !== null && onFocus && <button type="button" className="pill on" onClick={() => onFocus(null)} data-testid="focus-clear">
            {strat.positions[fo]?.name || `Joueur ${fo + 1}`} ×</button>}
        </div>
      )}
      <svg ref={svgRef} viewBox={view} className={`sb-svg ${board ? "sb-board" : ""}`} data-testid="strat-map" role="img" aria-label={`Radar de la stratégie ${strat.name}`}
        onPointerDown={board?.down ? (e) => { (e.target as Element).setPointerCapture?.(e.pointerId); board.down!(toRadar(e), lvl, e); } : undefined}
        onPointerMove={board?.move ? (e) => board.move!(toRadar(e), e) : undefined}
        onPointerUp={board?.up ? (e) => board.up!(toRadar(e), e) : undefined}>
        {/* en lecture, radar atténué : les joueurs, grenades et tracés ressortent ; net sur le tableau pour placer juste */}
        <image href={`/maps/${image}`} x={0} y={0} width={RADAR_SIZE} height={RADAR_SIZE} className={layers.dim && !board ? "sb-radar-dim" : undefined} />
        {layers.grenades && strat.grenades.filter((g) => onLevel(g.land ?? g.throw)).map((g, i) => {
          const c = NADE[g.type]?.color ?? "var(--fg-1)";
          const traj = g.trajectory.length ? g.trajectory : [g.throw, g.land].filter(Boolean) as [number, number, number][];
          return (
            <g key={`g${i}`} opacity={dim(grenadeOwner(strat, g.player))} onPointerDown={board?.item ? (e) => board.item!({ kind: "grenade", index: strat.grenades.indexOf(g) }, e) : undefined}>
              {traj.length > 1 && !board && <polyline points={traj.map((p) => P(p).join(",")).join(" ")} fill="none" stroke="#000" strokeOpacity={0.45} strokeWidth={3.4 * k} />}
              {traj.length > 1 && <polyline points={traj.map((p) => P(p).join(",")).join(" ")} fill="none" stroke={c} strokeWidth={1.6 * k} strokeDasharray={`${4 * k} ${3 * k}`} strokeOpacity={0.8} />}
              {g.throw && <circle cx={P(g.throw)[0]} cy={P(g.throw)[1]} r={5 * k} fill={c} stroke="#000" strokeWidth={k} />}
              {g.land && <circle cx={P(g.land)[0]} cy={P(g.land)[1]} r={NADE_RADIUS[g.type] ? NADE_RADIUS[g.type]! / map.scale : 16 * k} fill={c} fillOpacity={0.25} stroke={c} strokeWidth={1.6 * k} />}
              {g.land && <text x={P(g.land)[0]} y={P(g.land)[1]} dy={5 * k} textAnchor="middle" fontSize={14 * k} className="sb-gnum">{i + 1}</text>}
            </g>
          );
        })}
        {layers.paths && strat.shapes.filter((s) => map.levels.length < 2 || s.level === lvl || s.level === "default").map((s) => {
          const pp = s.points.map((q) => q.join(",")).join(" ");
          const [a, b] = [s.points[0], s.points[s.points.length - 1]];
          const owner = shapeOwner(s.id);
          // en lecture, traits plus fins ; celui du joueur suivi un peu plus épais
          const w = s.width * k * (board ? 1 : fo !== null && owner === fo ? 0.9 : 0.6);
          const pick = board?.item ? (e: RPointerEvent) => board.item!({ kind: "shape", id: s.id }, e) : undefined;
          let el: ReactNode;
          if (s.tool === "circle") el = <circle onPointerDown={pick} cx={a[0]} cy={a[1]} r={Math.hypot(b[0] - a[0], b[1] - a[1])} fill={s.color} fillOpacity={0.15} stroke={s.color} strokeWidth={w} />;
          else if (s.tool === "rect") el = <rect onPointerDown={pick} x={Math.min(a[0], b[0])} y={Math.min(a[1], b[1])} width={Math.abs(b[0] - a[0])} height={Math.abs(b[1] - a[1])} fill={s.color} fillOpacity={0.15} stroke={s.color} strokeWidth={w} />;
          else if (s.tool === "text") el = <text onPointerDown={pick} x={a[0]} y={a[1]} fill={s.color} fontSize={(12 + s.width * 2) * k} fontWeight={700} className="sb-text">{s.text}</text>;
          else {
            const linePts = s.tool === "pen" ? pp : `${a.join(",")} ${b.join(",")}`;
            el = (
              <g onPointerDown={pick} data-testid="strat-shape">
                {/* contour sombre sous le trait : lisible sur n'importe quelle zone du radar */}
                {!board && <polyline points={linePts} fill="none" stroke="#000" strokeOpacity={0.5} strokeWidth={w + 2.4 * k} strokeLinecap="round" strokeLinejoin="round" />}
                <polyline points={linePts} fill="none" stroke={s.color} strokeWidth={w}
                  strokeLinecap="round" strokeLinejoin="round" markerEnd={s.tool === "arrow" ? "url(#sb-arrow)" : undefined} style={{ color: s.color }} />
                {/* zone de clic élargie : un trait fin reste facile à attraper (gomme, déplacement) */}
                {board && <polyline points={linePts} fill="none" stroke="transparent" strokeWidth={14 * k} pointerEvents="stroke" />}
              </g>
            );
          }
          return <g key={s.id} opacity={dim(owner)}>{el}</g>;
        })}
        {layers.players && strat.positions.filter((p) => onLevel(p.pos)).map((p, i) => {
          const [x, y] = P(p.pos);
          const yaw = (p.yaw * Math.PI) / 180;
          const idx = strat.positions.indexOf(p);
          return (
            <g key={`p${i}`} data-testid="strat-position" opacity={dim(idx) < 1 ? 0.45 : 1}
              className={!board && onFocus ? "sb-pfocus" : undefined} onClick={!board && onFocus ? () => onFocus(fo === idx ? null : idx) : undefined}
              onPointerDown={board?.item ? (e) => board.item!({ kind: "position", index: idx }, e) : undefined}>
              <line x1={x} y1={y} x2={x + Math.cos(-yaw) * 28 * k} y2={y + Math.sin(-yaw) * 28 * k} stroke={sideColor} strokeWidth={3 * k} />
              <circle cx={x} cy={y} r={14 * k} fill={sideColor} stroke="var(--bg-0)" strokeWidth={2.5 * k} />
              <text x={x} y={y} dy={5 * k} textAnchor="middle" fontSize={15 * k} className="sb-pnum">{i + 1}</text>
              <text x={x} y={y + 31 * k} textAnchor="middle" fontSize={15 * k} className="sb-pname">{p.name}{p.role ? ` · ${p.role}` : ""}</text>
            </g>
          );
        })}
        {overlay}
        <defs>
          <marker id="sb-arrow" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" fill="currentColor" />
          </marker>
        </defs>
      </svg>
    </div>
  );
}
