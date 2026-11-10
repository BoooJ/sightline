import { useEffect, useMemo, useRef, useState } from "react";
import type { MapMeta, Shape } from "../../../shared/api/types";
import { hitShape } from "../annotate/shapes";
import type { Replay } from "../engine/replay";
import type { Tool } from "../store";
import { levelForZ, worldToRadar } from "../engine/coords";
import { drawFrame, fitView, hitTest, revealShift, screenToRadar, type DrawArgs, type DrawOptions, type Layout, type View } from "./draw";
import { radarSnapshot } from "./snapshot";
import { readTheme } from "./theme";

export interface DrawingProps {
  tool: Tool; color: string; width: number; timed: boolean; shapes: Shape[];
  onAdd: (s: Shape) => void; onErase: (id: string) => void;
  /** déplacement d'un dessin (outil « Déplacer ») ; absent : les dessins affichés ne sont pas modifiables */
  onMove?: (id: string, points: [number, number][]) => void;
}

interface Props {
  replay: Replay; map: MapMeta; tick: number; level: string; splitLevels: boolean; options: DrawOptions;
  selected: string | null; onSelect: (sid: string | null) => void; drawing?: DrawingProps;
  layers?: { replay: Replay; label: string }[];
  mySide?: "CT" | "T" | null; overrides?: Record<string, [number, number]>; onMovePlayer?: (sid: string, p: [number, number]) => void;
  tempo?: DrawArgs["tempo"]; focusNade?: number | null;
  /** largeur (px) d'un panneau posé sur le bord droit du radar : la grenade choisie est gardée visible à sa gauche */
  rightInset?: number;
}

const newId = () => Math.random().toString(36).slice(2, 10);
const TIMED_S = 5; // durée d'affichage d'un dessin lié à un instant

export function Radar(p: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const layout = useRef<Layout | null>(null);
  const [size, setSize] = useState({ w: 800, h: 800 });
  const [view, setView] = useState<View>({ zoom: 1, panX: 0, panY: 0 });
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const [draft, setDraft] = useState<Shape | null>(null);
  // dessin en cours de déplacement : point de départ et décalage courant (px radar)
  const [moving, setMoving] = useState<{ id: string; from: [number, number]; dx: number; dy: number } | null>(null);
  const [dragPlayer, setDragPlayer] = useState<string | null>(null);
  const [textAt, setTextAt] = useState<{ sx: number; sy: number; level: string; x: number; y: number } | null>(null);
  const theme = useMemo(readTheme, []);
  const images = useMemo(() => {
    const out: Record<string, HTMLImageElement> = {};
    for (const l of p.map.levels) { const img = new Image(); img.src = `/maps/${l.image}`; out[l.image] = img; }
    return out;
  }, [p.map]);
  const [, setLoaded] = useState(0);
  useEffect(() => { Object.values(images).forEach((img) => (img.onload = () => setLoaded((n) => n + 1))); }, [images]);

  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    if (wrap.current) ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  // cadrage automatique sur la zone jouée (pas en mode côte à côte, où les deux radars sont affichés entiers)
  const fitted = useMemo<View>(() => (p.splitLevels ? { zoom: 1, panX: 0, panY: 0 } : fitView(p.replay, p.map, size.w, size.h)),
    [p.replay, p.map, p.splitLevels, size.w, size.h]);
  // le cadrage change (fenêtre redimensionnée, panneaux qui arrivent) : on garde le zoom choisi par l'utilisateur,
  // relatif au cadrage ; s'il n'a rien touché, on recadre simplement
  const prevFit = useRef(fitted);
  useEffect(() => {
    const prev = prevFit.current; prevFit.current = fitted;
    setView((v) => {
      const untouched = v.zoom === prev.zoom && v.panX === prev.panX && v.panY === prev.panY;
      if (untouched) return fitted;
      const zoom = Math.min(8, Math.max(0.5, fitted.zoom * (v.zoom / prev.zoom))), k = zoom / v.zoom;
      return { zoom, panX: v.panX * k, panY: v.panY * k };
    });
  }, [fitted]);

  const d = p.drawing;
  const args: DrawArgs = { replay: p.replay, map: p.map, images, tick: p.tick, view, level: p.level, splitLevels: p.splitLevels,
    options: p.options, selected: p.selected, theme, dpr: window.devicePixelRatio || 1, width: size.w, height: size.h,
    shapes: moving && d ? d.shapes.map((s) => (s.id === moving.id ? { ...s, points: s.points.map(([x, y]) => [x + moving.dx, y + moving.dy] as [number, number]) } : s)) : d?.shapes,
    draft, layers: p.layers, mySide: p.mySide, overrides: p.overrides, tempo: p.tempo, focusNade: p.focusNade };

  // grenade choisie dans le panneau « Grenades » : la vue glisse pour que sa trajectoire ne soit pas cachée par le panneau ;
  // le décalage appliqué est retenu pour être retiré quand on change de grenade ou ferme le panneau (pas d'accumulation)
  const nadeShift = useRef(0);
  useEffect(() => {
    const L = layout.current, g = p.focusNade != null ? p.replay.payload.grenades.find((x) => x.id === p.focusNade) : undefined;
    const prev = nadeShift.current;
    let dx = 0;
    if (L && g?.trajectory.length) {
      const xs = g.trajectory.map(([, x, y, z]) => {
        const off = L.offsets[levelForZ(p.map, z)] ?? Object.values(L.offsets)[0];
        return L.originX - prev + (worldToRadar(p.map, x, y)[0] + off[0]) * L.scale;
      });
      dx = revealShift(Math.min(...xs), Math.max(...xs), size.w - (p.rightInset ?? 0));
    }
    nadeShift.current = dx;
    if (dx !== prev) setView((v) => ({ ...v, panX: v.panX + dx - prev }));
  }, [p.focusNade]);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    c.width = size.w * args.dpr; c.height = size.h * args.dpr;
    layout.current = drawFrame(c.getContext("2d")!, args);
    radarSnapshot.args = args; radarSnapshot.layout = layout.current;
  });  // redessine à chaque rendu (tick, vue, options, dessins)
  const toWorld = (_level: string, x: number, y: number): [number, number] => [Math.round(p.map.pos_x + x * p.map.scale), Math.round(p.map.pos_y - y * p.map.scale)];

  const local = (e: React.MouseEvent) => {
    const rect = canvas.current!.getBoundingClientRect();
    return { sx: e.clientX - rect.left, sy: e.clientY - rect.top };
  };
  const toRadar = (e: React.MouseEvent) => {
    const { sx, sy } = local(e);
    return layout.current ? { ...screenToRadar(layout.current, sx, sy), sx, sy } : null;
  };
  const timing = () => (d?.timed ? { from_tick: Math.round(p.tick), to_tick: Math.round(p.tick + TIMED_S * p.replay.tickrate) } : {});

  // zoom au bouton ou au clavier : centré sur le milieu du radar
  const zoomBy = (f: number) => setView((v) => {
    const zoom = Math.min(8, Math.max(0.5, v.zoom * f)), k = zoom / v.zoom;
    return { zoom, panX: v.panX * k, panY: v.panY * k };
  });
  useEffect(() => {
    const on = (e: Event) => {
      const kind = (e as CustomEvent<"in" | "out" | "reset">).detail;
      if (kind === "reset") setView(fitted); else zoomBy(kind === "in" ? 1.25 : 1 / 1.25);
    };
    window.addEventListener("radar-zoom", on);
    return () => window.removeEventListener("radar-zoom", on);
  }, [fitted]);

  const onWheel = (e: React.WheelEvent) => {
    const rect = canvas.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left - size.w / 2, my = e.clientY - rect.top - size.h / 2;
    const f0 = 1 + 0.15 * (p.options.zoomSens ?? 1);
    setView((v) => {
      const zoom = Math.min(8, Math.max(0.5, v.zoom * (e.deltaY < 0 ? f0 : 1 / f0)));
      const f = zoom / v.zoom;
      return { zoom, panX: mx - (mx - v.panX) * f, panY: my - (my - v.panY) * f };
    });
  };

  const drawingMode = !!d?.tool;
  return (
    <div ref={wrap} className="radar-wrap">
      <div className="radar-zoom" role="group" aria-label="Zoom du radar">
        <button type="button" onClick={() => zoomBy(1.25)} title="Zoomer (+ ou molette)" aria-label="Zoomer" data-testid="zoom-in">+</button>
        <span className="mono" data-testid="zoom-level">{Math.round(view.zoom * 100)}%</span>
        <button type="button" onClick={() => zoomBy(1 / 1.25)} title="Dézoomer (− ou molette)" aria-label="Dézoomer" data-testid="zoom-out">−</button>
        <button type="button" onClick={() => setView(fitted)} title="Recentrer sur la zone jouée (0 ou double-clic)" aria-label="Recentrer" data-testid="zoom-reset">⤢</button>
      </div>
      <canvas ref={canvas} className={`radar-canvas ${drawingMode ? `drawing tool-${d!.tool}` : ""}`} style={{ width: size.w, height: size.h }} data-testid="radar"
        onWheel={onWheel}
        onDoubleClick={() => !drawingMode && setView(fitted)}
        onMouseDown={(e) => {
          if (drawingMode && e.button === 0) {
            e.preventDefault(); // garde le focus sur le champ texte qui va s'ouvrir
            const r = toRadar(e);
            if (!r?.level) return;
            if (d!.tool === "eraser") {
              const id = hitShape(d!.shapes, r.level, [r.x!, r.y!], 10 / layout.current!.scale, p.tick);
              if (id) d!.onErase(id);
              return;
            }
            if (d!.tool === "move") {
              const id = d!.onMove ? hitShape(d!.shapes, r.level, [r.x!, r.y!], 12 / layout.current!.scale, p.tick, true) : null;
              if (id) setMoving({ id, from: [r.x!, r.y!], dx: 0, dy: 0 });
              return;
            }
            if (d!.tool === "players") {  // mode M : on attrape un joueur et on le dépose ailleurs
              const { sx, sy } = local(e);
              const sid = layout.current ? hitTest(args, layout.current, sx, sy) : null;
              if (sid) { setDragPlayer(sid); p.onSelect(sid); }
              return;
            }
            if (d!.tool === "text") { setTextAt({ sx: r.sx, sy: r.sy, level: r.level, x: r.x!, y: r.y! }); return; }
            setDraft({ id: newId(), tool: d!.tool!, color: d!.color, width: d!.width, level: r.level, points: [[r.x!, r.y!], [r.x!, r.y!]], ...timing() });
            return;
          }
          drag.current = { x: e.clientX, y: e.clientY, moved: false };
        }}
        onMouseMove={(e) => {
          if (dragPlayer) {
            const r = toRadar(e);
            if (r?.level && r.x != null) p.onMovePlayer?.(dragPlayer, toWorld(r.level, r.x, r.y!));
            return;
          }
          if (moving) {
            const r = toRadar(e);
            if (r?.x != null) setMoving({ ...moving, dx: r.x - moving.from[0], dy: r.y! - moving.from[1] });
            return;
          }
          if (draft) {
            const r = toRadar(e);
            if (!r?.level || r.level !== draft.level) return;
            const pt: [number, number] = [r.x!, r.y!];
            setDraft((s) => s && (s.tool === "pen" ? { ...s, points: [...s.points, pt] } : { ...s, points: [s.points[0], pt] }));
            return;
          }
          const g = drag.current; if (!g) return;
          const dx = e.clientX - g.x, dy = e.clientY - g.y;
          if (Math.abs(dx) + Math.abs(dy) > 3) g.moved = true;
          g.x = e.clientX; g.y = e.clientY;
          if (g.moved) setView((v) => ({ ...v, panX: v.panX + dx, panY: v.panY + dy }));
        }}
        onMouseUp={(e) => {
          if (dragPlayer) { setDragPlayer(null); return; }
          if (moving) {
            const sh = d?.shapes.find((s) => s.id === moving.id);
            if (sh && d?.onMove && Math.hypot(moving.dx, moving.dy) * (layout.current?.scale ?? 1) > 2)
              d.onMove(sh.id, sh.points.map(([x, y]) => [x + moving.dx, y + moving.dy] as [number, number]));
            setMoving(null);
            return;
          }
          if (draft) {
            const [a, b] = [draft.points[0], draft.points[draft.points.length - 1]];
            const moved = Math.hypot(b[0] - a[0], b[1] - a[1]) * (layout.current?.scale ?? 1) > 4 || draft.points.length > 3;
            if (moved) d!.onAdd({ ...draft, points: draft.tool === "pen" ? simplify(draft.points) : draft.points });
            setDraft(null);
            return;
          }
          const g = drag.current; drag.current = null;
          if (g && !g.moved && layout.current) {
            const { sx, sy } = local(e);
            p.onSelect(hitTest(args, layout.current, sx, sy));
          }
        }}
        onMouseLeave={() => { drag.current = null; setMoving(null); setDragPlayer(null); if (draft) { d?.onAdd(draft); setDraft(null); } }} />
      {textAt && d && (
        <input className="rp-text-input" autoFocus placeholder="Texte…" style={{ left: textAt.sx, top: textAt.sy - 14, color: d.color }}
          data-testid="draw-text-input"
          onKeyDown={(e) => {
            if (e.key === "Escape") setTextAt(null);
            if (e.key === "Enter") {
              const v = e.currentTarget.value.trim();
              if (v) d.onAdd({ id: newId(), tool: "text", color: d.color, width: d.width, level: textAt.level, points: [[textAt.x, textAt.y]], text: v, ...timing() });
              setTextAt(null);
            }
            e.stopPropagation(); // pas de raccourcis clavier du replay pendant la saisie
          }}
          onBlur={() => setTextAt(null)} />
      )}
    </div>
  );
}

/** Allège un tracé à main levée (un point tous les ~2 px radar). */
function simplify(pts: [number, number][]): [number, number][] {
  const out: [number, number][] = [pts[0]];
  for (const q of pts.slice(1)) {
    const l = out[out.length - 1];
    if (Math.hypot(q[0] - l[0], q[1] - l[1]) >= 2) out.push(q);
  }
  if (out.length === 1) out.push(pts[pts.length - 1]);
  return out;
}
