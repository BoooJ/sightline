import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../shared/api/client";
import type { MapMeta, StoryRound, StoryStep, Vec3 } from "../../../shared/api/types";
import { NADE } from "../../grenades/GrenadesPage";
import { RADAR_SIZE, levelForZ, worldToRadar } from "../../replay/engine/coords";
import { Icon } from "../../../shared/ui/Icon";
import { Popover } from "../../../shared/ui/Popover";
import { onMap, pathUntil, roundClock, UTILITY_NAME } from "./story";

/** Couleurs des étapes, bien distinctes entre elles (une grenade ne doit pas ressembler à une mort) ; les mêmes sur la
 *  carte, dans la liste et dans la légende. */
export const STEP_COLOR = { place: "var(--accent)", nade: "var(--accent-deep)", kill: "#f2f4f7", death: "var(--error)", bomb: "var(--warn)" };

export function stepColor(s: StoryStep): string {
  switch (s.kind) {
    case "kill": return s.teamkill ? STEP_COLOR.bomb : STEP_COLOR.kill;
    case "death": return STEP_COLOR.death;
    case "nade": return STEP_COLOR.nade;
    case "plant": case "defuse": return STEP_COLOR.bomb;
    case "end": case "buy": return "var(--fg-1)";
    default: return STEP_COLOR.place;
  }
}

/** Carte d'un round raconté : le trajet du joueur jusqu'à l'étape en cours, un repère numéroté par étape, et pour
 *  l'étape en cours sa cible (victime, point de chute de la grenade, tueur) reliée en pointillés. */
const EFFECT_R: Record<string, number> = { smoke: 144, molotov: 120, incendiary: 120, flash: 250, he: 350, decoy: 40 };  // unités du jeu, comme le replay

const ZOOM_MAX = 8;
const SHOW_KEY = "story-map-show";
const SHOW_DEFAULT = { mates: true, enemies: true, utility: true, traces: true, callouts: true, placeNames: true, playerNames: true };
type Show = typeof SHOW_DEFAULT;
const CONE_DEG = 70, CONE_LEN = 650;  // champ de vision dessiné : angle (degrés) et portée (unités du jeu)

export function StoryMap({ map, round, current, label }: { map: MapMeta; round: StoryRound; current: number; label?: string | null }) {
  const steps = round.steps;
  const cur = steps[current];
  const multi = map.levels.length > 1;
  const sofar = pathUntil(round, cur?.t ?? 0);
  const curPos = cur && onMap(cur) ? cur.pos : (sofar[sofar.length - 1] ?? null);
  const autoLevel = multi && curPos ? levelForZ(map, curPos[2]) : map.levels[0]?.name ?? "";
  const [level, setLevel] = useState(autoLevel);
  useEffect(() => { setLevel(autoLevel); }, [autoLevel, round.number]);
  const onLevel = (v: Vec3) => !multi || levelForZ(map, v[2]) === level;
  const P = (v: Vec3) => worldToRadar(map, v[0], v[1]);
  // calques affichés, mémorisés sur cet appareil (on retire les noms une fois, ils restent retirés)
  const [show, setShowState] = useState<Show>(() => {
    try { return { ...SHOW_DEFAULT, ...JSON.parse(localStorage.getItem(SHOW_KEY) ?? "{}") }; } catch { return SHOW_DEFAULT; }
  });
  const setShow = (v: Show) => { setShowState(v); try { localStorage.setItem(SHOW_KEY, JSON.stringify(v)); } catch { /* stockage indisponible */ } };
  const zonesQ = useQuery({ queryKey: ["map-callouts", map.name], queryFn: () => api.mapCallouts(map.name), staleTime: Infinity });
  const mateColor = round.side === "CT" ? "var(--ct)" : "var(--t)", enemyColor = round.side === "CT" ? "var(--t)" : "var(--ct)";

  // cadrage sur tout le trajet du round, une fois par round
  const view = useMemo(() => {
    const pts = [...round.path.map((p) => [p[1], p[2]]), ...steps.flatMap((s) => [s.pos, s.target, ...s.mates.map((m) => m.pos), ...s.enemies.map((m) => m.pos)]
      .filter(Boolean).map((v) => [v![0], v![1]]))];
    if (!pts.length) return { x: 0, y: 0, s: RADAR_SIZE };
    const rp = pts.map((p) => worldToRadar(map, p[0], p[1])), xs = rp.map((p) => p[0]), ys = rp.map((p) => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const s = Math.min(RADAR_SIZE, Math.max(360, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 1.3);
    return { s, x: cx - s / 2, y: cy - s / 2 };
  }, [map, round]);  // eslint-disable-line react-hooks/exhaustive-deps
  // zoom et déplacement : facteur z (1 = cadrage du round) et centre ; « suivre » garde le joueur au centre
  const [zoom, setZoom] = useState<{ z: number; c: [number, number] | null }>({ z: 1, c: null });
  const [follow, setFollow] = useState(false);
  useEffect(() => { setZoom({ z: 1, c: null }); }, [round.number]);
  const svgRef = useRef<SVGSVGElement>(null);
  const vs = view.s / zoom.z;
  const followAt = follow && curPos ? worldToRadar(map, curPos[0], curPos[1]) : null;
  const [cx, cy] = followAt ?? zoom.c ?? [view.x + view.s / 2, view.y + view.s / 2];
  const vb = { x: cx - vs / 2, y: cy - vs / 2, s: vs };
  const k = (2 * vs) / RADAR_SIZE;  // tailles à l'écran constantes quel que soit le cadrage
  const toSvg = (clientX: number, clientY: number): [number, number] => {
    const r = svgRef.current!.getBoundingClientRect();
    return [vb.x + ((clientX - r.left) / r.width) * vb.s, vb.y + ((clientY - r.top) / r.height) * vb.s];
  };
  const zoomAt = (factor: number, at?: [number, number]) => setZoom((zm) => {
    const z = Math.min(ZOOM_MAX, Math.max(1, zm.z * factor));
    const c0: [number, number] = followAt ?? zm.c ?? [view.x + view.s / 2, view.y + view.s / 2];
    if (!at || z === zm.z) return { z, c: z === 1 ? null : c0 };
    const ratio = zm.z / z;  // le point sous le curseur reste sous le curseur
    return { z, c: z === 1 ? null : [at[0] + (c0[0] - at[0]) * ratio, at[1] + (c0[1] - at[1]) * ratio] };
  });
  useEffect(() => {  // molette : écouteur non passif pour bloquer le défilement de la page
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => { e.preventDefault(); zoomAt(e.deltaY < 0 ? 1.25 : 0.8, toSvg(e.clientX, e.clientY)); };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });
  const pointers = useRef(new Map<number, [number, number]>());
  const drag = useRef<{ start: [number, number]; c: [number, number]; scale: number; pinch?: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    pointers.current.set(e.pointerId, [e.clientX, e.clientY]);
    const r = svgRef.current!.getBoundingClientRect();
    const pts = [...pointers.current.values()];
    drag.current = { start: [e.clientX, e.clientY], c: [cx, cy], scale: vb.s / r.width,
      pinch: pts.length === 2 ? Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]) : undefined };
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!drag.current || !pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, [e.clientX, e.clientY]);
    const pts = [...pointers.current.values()];
    if (pts.length === 2 && drag.current.pinch) {  // pincement à deux doigts
      const d = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]);
      zoomAt(d / drag.current.pinch);
      drag.current.pinch = d;
      return;
    }
    const d = drag.current;
    if (zoom.z === 1 || Math.hypot(e.clientX - d.start[0], e.clientY - d.start[1]) < 3) return;
    setFollow(false);
    setZoom((zm) => ({ ...zm, c: [d.c[0] - (e.clientX - d.start[0]) * d.scale, d.c[1] - (e.clientY - d.start[1]) * d.scale] }));
  };
  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => { pointers.current.delete(e.pointerId); if (!pointers.current.size) drag.current = null; };
  const image = map.levels.find((l) => l.name === level)?.image ?? map.image;

  const line = (pts: Vec3[]) => pts.filter(onLevel).map((v) => P(v).join(",")).join(" ");
  const done = pathUntil(round, cur?.t ?? 0);
  // l'étape en cours est dessinée en dernier : au premier plan quand plusieurs étapes ont lieu au même endroit
  const numbered = steps.map((s, i) => ({ s, i })).filter(({ s }) => onMap(s) && onLevel(s.pos!))
    .sort((a, b) => Number(a.i === current) - Number(b.i === current));
  const target = cur?.target && onLevel(cur.target) && cur.pos ? { from: P(cur.pos), to: P(cur.target) } : null;
  const nade = cur?.kind === "nade" && cur.trajectory && cur.trajectory.length > 1 ? cur : null;
  // étiquettes sans chevauchement : chaque nom essaie au-dessus, en dessous, à droite puis à gauche de son point ;
  // s'il n'y a pas de place, il n'est pas écrit (survol ou zoom pour le lire)
  const placed: [number, number, number, number][] = [];
  const fsz = 9.5 * k;
  const fits = (b: [number, number, number, number]) => !placed.some((o) => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]);
  const labelSpot = (x: number, y: number, name: string): [number, number] | null => {
    const w = name.length * fsz * 0.58, h = fsz * 1.1;
    const tries: [number, number][] = [[x, y - 9 * k], [x, y + 17 * k], [x + w / 2 + 9 * k, y + 4 * k], [x - w / 2 - 9 * k, y + 4 * k]];
    for (const [lx, ly] of tries) {
      const b: [number, number, number, number] = [lx - w / 2, ly - h, lx + w / 2, ly + 2 * k];
      if (fits(b)) { placed.push(b); return [lx, ly]; }
    }
    return null;
  };
  const dots = (list: { name: string; pos: Vec3 }[]) => list.filter((m) => onLevel(m.pos));
  const allPeople = [...(cur && show.mates ? dots(cur.mates) : []), ...(cur && show.enemies ? dots(cur.enemies) : [])];
  for (const m of allPeople) { const [x, y] = P(m.pos); placed.push([x - 6 * k, y - 6 * k, x + 6 * k, y + 6 * k]); }
  const people = (list: { name: string; pos: Vec3 }[], color: string, kind: string) => dots(list).map((m) => {
    const [x, y] = P(m.pos);
    const at = labelSpot(x, y, m.name);
    return (
      <g key={`${kind}${m.name}`} data-testid={`story-${kind}`} className="sy-person">
        <title>{`${m.name} (${kind === "mate" ? "coéquipier" : "ennemi"})`}</title>
        {kind === "enemy"
          ? <rect x={x - 5.5 * k} y={y - 5.5 * k} width={11 * k} height={11 * k} transform={`rotate(45 ${x} ${y})`} fill={color} stroke="#000" strokeWidth={1.2 * k} />
          : <circle cx={x} cy={y} r={6 * k} fill={color} stroke="#000" strokeWidth={1.2 * k} />}
        {at && show.playerNames && <text x={at[0]} y={at[1]} textAnchor="middle" fontSize={fsz} className="sy-plabel">{m.name}</text>}
      </g>
    );
  });

  return (
    <div className="sy-mapwrap">
      {multi && (
        <div className="sy-levels map-pills" role="group" aria-label="Niveau">
          {map.levels.map((l) => <button key={l.name} type="button" className={`pill ${level === l.name ? "on" : ""}`} onClick={() => setLevel(l.name)}>
            {l.name === "lower" ? "Bas" : l.name === "upper" ? "Haut" : l.name}</button>)}
        </div>
      )}
      <Popover label="Affichage et légende de la carte" className="sy-layers" testId="legend-toggle" panelTestId="story-legend"
        button={<><Icon name="layers" size={14} />Affichage</>}>
        <section>
          <h4>Afficher</h4>
          <label><input type="checkbox" checked={show.traces} onChange={(e) => setShow({ ...show, traces: e.target.checked })} data-testid="show-traces" />
            <Swatch><line x1="2" y1="9" x2="24" y2="9" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" /></Swatch>Son trajet</label>
          <label><input type="checkbox" checked={show.mates} onChange={(e) => setShow({ ...show, mates: e.target.checked })} data-testid="show-mates" />
            <Swatch><circle cx="13" cy="9" r="5" fill={mateColor} stroke="#000" /></Swatch>Coéquipiers ({round.side})</label>
          <label><input type="checkbox" checked={show.enemies} onChange={(e) => setShow({ ...show, enemies: e.target.checked })} data-testid="show-enemies" />
            <Swatch><rect x="9" y="5" width="8" height="8" transform="rotate(45 13 9)" fill={enemyColor} stroke="#000" /></Swatch>Ennemis ({round.side === "CT" ? "T" : "CT"})</label>
          <label><input type="checkbox" checked={show.utility} onChange={(e) => setShow({ ...show, utility: e.target.checked })} data-testid="show-utility" />
            <Swatch><circle cx="13" cy="9" r="7" fill="var(--smoke)" fillOpacity=".55" stroke="var(--smoke)" /></Swatch>Utilitaire ennemi</label>
          <label><input type="checkbox" checked={show.callouts} onChange={(e) => setShow({ ...show, callouts: e.target.checked })} data-testid="show-callouts" />
            <Swatch><rect x="3" y="3" width="20" height="12" rx="2" fill="none" stroke="rgba(255,255,255,.45)" /></Swatch>Zones des lieux</label>
          <label><input type="checkbox" checked={show.placeNames} onChange={(e) => setShow({ ...show, placeNames: e.target.checked })} data-testid="show-place-names" />
            <Swatch><text x="13" y="13" textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--fg-1)">Ab</text></Swatch>Noms des lieux</label>
          <label><input type="checkbox" checked={show.playerNames} onChange={(e) => setShow({ ...show, playerNames: e.target.checked })} data-testid="show-player-names" />
            <Swatch><circle cx="6" cy="11" r="4" fill={mateColor} stroke="#000" /><text x="17" y="9" textAnchor="middle" fontSize="8" fontWeight="700" fill="var(--fg-1)">nom</text></Swatch>Noms des joueurs</label>
        </section>
        <section>
          <h4>Repères du joueur</h4>
          <ul>
            <li><i className="sy-dot" style={{ ["--c" as string]: STEP_COLOR.place }}>1</i>Position (n° de l'étape)</li>
            <li><i className="sy-dot" style={{ ["--c" as string]: STEP_COLOR.nade }}>2</i>Grenade lancée</li>
            <li><i className="sy-dot" style={{ ["--c" as string]: STEP_COLOR.kill }}>3</i>Kill</li>
            <li><i className="sy-dot sq" style={{ ["--c" as string]: STEP_COLOR.death }}>4</i>Mort</li>
            <li><Swatch><line x1="2" y1="9" x2="24" y2="9" stroke="var(--fg-1)" strokeWidth="2" strokeDasharray="5 3" /></Swatch>Vers la victime, le tueur ou la grenade</li>
          </ul>
        </section>
        <section data-testid="utility-legend">
          <h4>Utilitaire ennemi</h4>
          <ul>
            <li><Swatch><circle cx="13" cy="9" r="7" fill="var(--smoke)" fillOpacity=".55" stroke="var(--smoke)" /></Swatch>Smoke : bloque la vue</li>
            <li><Swatch><circle cx="13" cy="9" r="7" fill="var(--fire)" fillOpacity=".4" stroke="var(--fire)" /></Swatch>Molotov : zone en feu</li>
            <li><Swatch><circle cx="13" cy="9" r="7" fill="none" stroke="var(--flash)" strokeWidth="2.5" /></Swatch>Flash : aveugle</li>
            <li><Swatch><circle cx="13" cy="9" r="7" fill="none" stroke="var(--he)" strokeWidth="2.5" /></Swatch>HE : dégâts</li>
            <li><Swatch><line x1="2" y1="13" x2="18" y2="6" stroke="var(--smoke)" strokeWidth="1.5" strokeDasharray="3 3" /><circle cx="20" cy="5" r="3" fill="var(--smoke)" stroke="#000" /></Swatch>Grenade en vol</li>
          </ul>
        </section>
      </Popover>
      <div className="sy-zoom" role="group" aria-label="Zoom de la carte" data-testid="story-zoom">
        <button type="button" className="btn btn-sm" onClick={() => zoomAt(1.5)} aria-label="Zoomer" title="Zoomer (molette)" disabled={zoom.z >= ZOOM_MAX}>+</button>
        <button type="button" className="btn btn-sm" onClick={() => zoomAt(1 / 1.5)} aria-label="Dézoomer" title="Dézoomer" disabled={zoom.z <= 1}>−</button>
        <button type="button" className="btn btn-sm" onClick={() => { setZoom({ z: 1, c: null }); setFollow(false); }} aria-label="Recentrer" title="Voir tout le round"><Icon name="fit" size={14} /></button>
        <button type="button" className={`btn btn-sm ${follow ? "on" : ""}`} aria-pressed={follow} data-testid="story-follow" aria-label="Suivre le joueur"
          onClick={() => { setFollow(!follow); if (!follow && zoom.z < 2) setZoom((zm) => ({ ...zm, z: 2.5 })); }} title="Suivre le joueur : il reste au centre pendant la lecture"><Icon name="crosshair" size={14} /></button>
      </div>
      <svg ref={svgRef} className={`gr-svg sy-svg ${zoom.z > 1 ? "zoomed" : ""}`} viewBox={`${vb.x} ${vb.y} ${vb.s} ${vb.s}`} data-testid="story-map"
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        onDoubleClick={(e) => zoomAt(2, toSvg(e.clientX, e.clientY))}>
        <defs><marker id="sy-arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
          <path d="M0,0L10,5L0,10z" fill="#fff" /></marker></defs>
        <image href={`/maps/${image}`} x={0} y={0} width={RADAR_SIZE} height={RADAR_SIZE} />
        {show.callouts && (zonesQ.data ?? []).filter((z) => !multi || !z.level || z.level === level).map((z) => {
          const pts = z.poly.map(([x, y]) => worldToRadar(map, x, y));
          const lx = pts.reduce((a, p) => a + p[0], 0) / pts.length, ly = pts.reduce((a, p) => a + p[1], 0) / pts.length;
          return (
            <g key={z.name} className="sy-zone" data-testid="story-callout">
              <polygon points={pts.map((p) => p.join(",")).join(" ")} strokeWidth={0.8 * k} />
              {show.placeNames && <text x={lx} y={ly} textAnchor="middle" fontSize={8 * k}>{z.name}</text>}
            </g>
          );
        })}
        {show.traces && <>
          <polyline points={line(round.path.map((p) => [p[1], p[2], p[3]]))} fill="none" stroke="#fff" strokeOpacity={0.22} strokeWidth={2 * k}
            strokeDasharray={`${4 * k} ${4 * k}`} />
          <polyline points={line(done)} fill="none" stroke="var(--accent)" strokeWidth={3 * k} strokeLinecap="round" strokeLinejoin="round" />
        </>}
        {cur && show.utility && cur.enemy_utility.map((u, j) => {
          // utilitaire ennemi : zone d'effet (smoke, feu, flash, HE) ou grenade en vol avec sa trajectoire
          const color = NADE[u.type]?.color ?? "var(--fg-2)";
          const end = u.flying ? u.trajectory[u.trajectory.length - 1] : u.pos;
          return (
            <g key={`u${j}`} data-testid="story-enemy-utility">
              <title>{`${UTILITY_NAME[u.type] ?? u.type} de ${u.thrower}${u.flying ? " (en vol)" : ""}`}</title>
              {(u.flying || show.traces) && <polyline points={line(u.trajectory)} fill="none" stroke={color} strokeOpacity={u.flying ? 0.9 : 0.4}
                strokeWidth={1.5 * k} strokeDasharray={`${3 * k} ${3 * k}`} />}
              {end && onLevel(end) && (u.flying
                ? <circle cx={P(end)[0]} cy={P(end)[1]} r={4 * k} fill={color} stroke="#000" strokeWidth={k} />
                : u.type === "flash" || u.type === "he"
                  ? <circle cx={P(end)[0]} cy={P(end)[1]} r={EFFECT_R[u.type] / map.scale} fill="none" stroke={color} strokeWidth={2.5 * k} strokeOpacity={0.8} />
                  : <circle cx={P(end)[0]} cy={P(end)[1]} r={(EFFECT_R[u.type] ?? 40) / map.scale} fill={color} fillOpacity={u.type === "smoke" ? 0.55 : 0.4}
                    stroke={color} strokeWidth={k} />)}
            </g>
          );
        })}
        {cur && cur.view_yaw != null && curPos && onLevel(curPos) && (() => {
          // champ de vision du joueur suivi : ce qu'il regarde à cet instant
          const [x, y] = P(curPos), a = (-cur.view_yaw! * Math.PI) / 180, h = ((CONE_DEG / 2) * Math.PI) / 180, L = CONE_LEN / map.scale;
          const p1 = [x + Math.cos(a - h) * L, y + Math.sin(a - h) * L], p2 = [x + Math.cos(a + h) * L, y + Math.sin(a + h) * L];
          return <path d={`M${x},${y}L${p1[0]},${p1[1]}A${L},${L} 0 0 1 ${p2[0]},${p2[1]}Z`} className="sy-cone" data-testid="story-cone" />;
        })()}
        {cur && show.mates && people(cur.mates, mateColor, "mate")}
        {cur && show.enemies && people(cur.enemies, enemyColor, "enemy")}
        {nade && (() => {
          // lineup : trajectoire réelle, zone d'effet à l'arrivée, direction de visée au lancer
          const color = NADE[nade.nade!]?.color ?? STEP_COLOR.nade, end = nade.target ?? nade.trajectory![nade.trajectory!.length - 1];
          const [ex, ey] = P(end), [sx, sy] = P(nade.pos!);
          const yaw = nade.yaw != null ? (-nade.yaw * Math.PI) / 180 : null;
          return (
            <g data-testid="story-lineup">
              <polyline points={nade.trajectory!.map((v) => P(v).join(",")).join(" ")} fill="none" stroke={color} strokeWidth={2.2 * k}
                strokeDasharray={`${5 * k} ${4 * k}`} strokeLinecap="round" />
              {onLevel(end) && <circle cx={ex} cy={ey} r={(EFFECT_R[nade.nade ?? ""] ?? 60) / map.scale} fill={color} fillOpacity={0.28} stroke={color} strokeWidth={1.5 * k} />}
              {yaw !== null && <line x1={sx} y1={sy} x2={sx + Math.cos(yaw) * 26 * k} y2={sy + Math.sin(yaw) * 26 * k} stroke="#fff" strokeWidth={2 * k}
                markerEnd="url(#sy-arrow)" />}
            </g>
          );
        })()}
        {target && !nade && show.traces && (
          <g>
            <line x1={target.from[0]} y1={target.from[1]} x2={target.to[0]} y2={target.to[1]} stroke={stepColor(cur)} strokeWidth={2 * k}
              strokeDasharray={`${5 * k} ${4 * k}`} />
            {cur.kind === "nade"
              ? <circle cx={target.to[0]} cy={target.to[1]} r={16 * k} fill={stepColor(cur)} fillOpacity={0.3} stroke={stepColor(cur)} strokeWidth={2 * k} />
              : <path d={cross(target.to[0], target.to[1], 7 * k)} stroke={stepColor(cur)} strokeWidth={3 * k} strokeLinecap="round" />}
          </g>
        )}
        {numbered.map(({ s, i }) => {
          const [x, y] = P(s.pos!), on = i === current, past = i < current;
          const r = (on ? 15 : 11) * k;
          return (
            <g key={i} opacity={on || past ? 1 : 0.35} data-testid="story-marker">
              {on && <circle cx={x} cy={y} r={r * 1.8} fill="none" stroke={stepColor(s)} strokeWidth={2 * k} className="sy-pulse" />}
              {s.kind === "death"
                ? <rect x={x - r} y={y - r} width={2 * r} height={2 * r} rx={2 * k} fill={stepColor(s)} stroke="#000" strokeWidth={1.5 * k} />
                : <circle cx={x} cy={y} r={r} fill={stepColor(s)} stroke="#000" strokeWidth={1.5 * k} />}
              <text x={x} y={y + 4.5 * k * (on ? 1.3 : 1)} textAnchor="middle" fontSize={(on ? 15 : 12) * k} className="sy-num">{i + 1}</text>
              {on && label && show.placeNames && <text x={x} y={y - r - 8 * k} textAnchor="middle" fontSize={13 * k} className="sy-label">{label}</text>}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
function Swatch({ children }: { children: ReactNode }) {
  return <svg width="26" height="18" viewBox="0 0 26 18" aria-hidden="true">{children}</svg>;
}

const cross = (x: number, y: number, s: number) => `M${x - s},${y - s}L${x + s},${y + s}M${x + s},${y - s}L${x - s},${y + s}`;

/** Frise du round : chaque étape à son moment, avec l'horloge du jeu ; un clic y amène. */
export function Timeline({ round, current, onSelect }: { round: StoryRound; current: number; onSelect?: (i: number) => void }) {
  const end = Math.max(1, ...round.steps.map((s) => s.t));
  // étapes au même instant (achat et poste à 0:00, kills rapprochés) : écartées pour rester toutes cliquables
  const GAP = 3.2;
  const left: number[] = [];
  round.steps.forEach((s, i) => { left.push(Math.max((100 * s.t) / end, i ? left[i - 1] + GAP : 0)); });
  const over = Math.max(0, left[left.length - 1] - 100);
  const at = (i: number) => left[i] - (over * i) / Math.max(1, left.length - 1);
  return (
    <div className="sy-timeline" data-testid="story-timeline" aria-label="Frise du round">
      <div className="sy-tl-track">
        {round.plant_t != null && <i className="sy-tl-plant" style={{ left: `${(100 * round.plant_t) / end}%` }} title="Bombe posée" />}
        {round.steps.map((s, i) => (
          <button key={i} type="button" className={`sy-tl-dot ${i === current ? "on" : ""} ${s.kind === "death" ? "sq" : ""}`}
            style={{ left: `${at(i)}%`, background: stepColor(s) }} onClick={() => onSelect?.(i)}
            title={`${roundClock(s.t, round.plant_t).text} — étape ${i + 1}`} aria-label={`Étape ${i + 1}`}>{i + 1}</button>
        ))}
      </div>
      <div className="sy-tl-ticks"><span>1:55</span><span>{roundClock(end / 2, round.plant_t).text}</span><span>{roundClock(end, round.plant_t).text}</span></div>
    </div>
  );
}
