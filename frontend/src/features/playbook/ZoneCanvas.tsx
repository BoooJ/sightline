import { useRef, type PointerEvent as RPointerEvent } from "react";
import type { MapMeta } from "../../shared/api/types";
import { RADAR_SIZE, worldToRadar } from "../replay/engine/coords";

export interface ZoneShape { zone: [number, number][]; level?: string; kind?: string }

/** Carte (radar, niveaux) sur laquelle on dessine des polygones point par point, en coordonnées monde.
 *  Partagée par l'éditeur de tactiques et le Pattern Finder. */
export function ZoneCanvas({ meta, level, onLevel, shapes, active, onAddPoint, drawing, children, testId = "zone-map" }:
  { meta: MapMeta | undefined; level: string; onLevel: (l: string) => void; shapes: ZoneShape[]; active: number; onAddPoint: (p: [number, number]) => void;
    drawing: boolean; children?: React.ReactNode; testId?: string }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const toRadar = (e: RPointerEvent): [number, number] => {
    const svg = svgRef.current!, pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const r = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    return [r.x, r.y];
  };
  if (!meta) return <p className="st-legend pb2-nomap">Choisissez une carte.</p>;
  const toWorld = ([px, py]: [number, number]): [number, number] => [Math.round(meta.pos_x + px * meta.scale), Math.round(meta.pos_y - py * meta.scale)];
  return (
    <div className="zc">
      {meta.levels.length > 1 && (
        <div className="map-pills zc-levels" role="group" aria-label="Niveau">
          {meta.levels.map((l) => <button key={l.name} type="button" className={`pill ${level === l.name ? "on" : ""}`} onClick={() => onLevel(l.name)}>{l.name === "upper" ? "Haut" : l.name === "lower" ? "Bas" : l.name}</button>)}
        </div>
      )}
      <svg ref={svgRef} viewBox={`0 0 ${RADAR_SIZE} ${RADAR_SIZE}`} role="img" aria-label={`Carte de ${meta.display_name}`} className={drawing ? "co-placing" : ""}
        onPointerDown={(e) => { if (!drawing) return; e.preventDefault(); onAddPoint(toWorld(toRadar(e))); }} data-testid={testId}>
        <image href={`/maps/${meta.levels.find((l) => l.name === level)?.image ?? meta.image}`} width={RADAR_SIZE} height={RADAR_SIZE} />
        {shapes.map((c, i) => c.zone.length > 0 && (!c.level || c.level === level || meta.levels.length < 2) ? (
          <g key={i} className={`pb2-zone ${i === active ? "on" : ""} ${c.kind === "utility_in_zone" ? "util" : ""}`}>
            {c.zone.length >= 3 ? <polygon points={c.zone.map(([x, y]) => worldToRadar(meta, x, y).join(",")).join(" ")} /> : <polyline points={c.zone.map(([x, y]) => worldToRadar(meta, x, y).join(",")).join(" ")} />}
            {c.zone.map(([x, y], j) => { const [px, py] = worldToRadar(meta, x, y); return <circle key={j} cx={px} cy={py} r={6} />; })}
            <text x={worldToRadar(meta, c.zone[0][0], c.zone[0][1])[0] + 8} y={worldToRadar(meta, c.zone[0][0], c.zone[0][1])[1] - 8}>{i + 1}</text>
          </g>
        ) : null)}
        {children}
      </svg>
    </div>
  );
}
