import { useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import type { DrawTool, GrenadeType, MapMeta, Shape, Strat, StratGrenade, StratPosition, Vec3 } from "../../shared/api/types";
import { Button } from "../../shared/ui/Button";
import { Icon } from "../../shared/ui/Icon";
import { levelForZ } from "../replay/engine/coords";
import { DRAW_COLORS } from "../replay/store";
import { NADE } from "../grenades/GrenadesPage";
import { StratMap, type BoardItem } from "./StratMap";

type BoardTool = "move" | "player" | "grenade" | "arrow" | "line" | "pen" | "text" | "erase";
const TOOLS: { id: BoardTool; label: string; hint: string }[] = [
  { id: "move", label: "Déplacer", hint: "Glisser un joueur, une grenade ou un dessin pour le déplacer" },
  { id: "player", label: "Joueur", hint: "Cliquer pour placer, glisser pour donner la direction du regard (5 au plus)" },
  { id: "grenade", label: "Grenade", hint: "Glisser du point de lancer jusqu'à l'impact" },
  { id: "arrow", label: "Flèche", hint: "Glisser pour tracer un déplacement" },
  { id: "line", label: "Trait", hint: "Glisser pour tracer un trait" },
  { id: "pen", label: "Crayon", hint: "Dessin libre" },
  { id: "text", label: "Texte", hint: "Cliquer pour écrire une note sur la carte" },
  { id: "erase", label: "Gomme", hint: "Cliquer sur un élément pour l'effacer" },
];
const NADE_TYPES: GrenadeType[] = ["smoke", "flash", "he", "molotov", "incendiary", "decoy"];
type Edit = Pick<Strat, "positions" | "grenades" | "shapes">;
type Pt = [number, number];

/** Trait à main levée rendu propre : les points inutiles retirés (Douglas-Peucker, tolérance en pixels du radar), puis
 *  les angles arrondis (Chaikin, deux passes). Le premier et le dernier point restent en place. */
export function smoothStroke(pts: Pt[], tolerance = 2.5): Pt[] {
  const simplify = (a: Pt[]): Pt[] => {
    if (a.length < 3) return a;
    const [x1, y1] = a[0], [x2, y2] = a[a.length - 1];
    const len = Math.hypot(x2 - x1, y2 - y1);
    let far = 0, at = 0;
    for (let i = 1; i < a.length - 1; i++) {
      // trait fermé (fin = début) : distance au point de départ, sinon distance à la droite début–fin
      const d = len === 0 ? Math.hypot(a[i][0] - x1, a[i][1] - y1)
        : Math.abs((y2 - y1) * a[i][0] - (x2 - x1) * a[i][1] + x2 * y1 - y2 * x1) / len;
      if (d > far) { far = d; at = i; }
    }
    return far > tolerance ? [...simplify(a.slice(0, at + 1)).slice(0, -1), ...simplify(a.slice(at))] : [a[0], a[a.length - 1]];
  };
  let out = simplify(pts);
  for (let pass = 0; pass < 2 && out.length > 2; pass++) {
    const next: Pt[] = [out[0]];
    for (let i = 0; i < out.length - 1; i++) {
      const [a, b] = [out[i], out[i + 1]];
      next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    next.push(out[out.length - 1]);
    out = next;
  }
  return out.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
}

/** Tableau tactique : placer les joueurs, les grenades et les dessins d'une stratégie directement sur la carte. */
export function StratBoard({ map, strat, onSave }: { map: MapMeta; strat: Strat; onSave: (p: Partial<Strat>) => Promise<void> }) {
  const [tool, setTool] = useState<BoardTool>(strat.positions.length ? "move" : "player");
  const [nade, setNade] = useState<GrenadeType>("smoke");
  const [color, setColor] = useState(DRAW_COLORS[0]);
  const [level, setLevel] = useState(map.levels[0]?.name ?? "default");
  const [draft, setDraft] = useState<{ a: [number, number]; b: [number, number]; pts: [number, number][] } | null>(null);
  const [drag, setDrag] = useState<{ item: BoardItem; at: [number, number]; from?: [number, number] } | null>(null);
  const [text, setText] = useState<{ at: [number, number]; value: string } | null>(null);
  const [history, setHistory] = useState<Edit[]>([]);
  // hauteur des points placés à la main : celle du lieu connu le plus proche (morts des démos), pour des setpos justes
  const places = useQuery({ queryKey: ["callouts", map.name], queryFn: () => api.callouts(map.name), staleTime: 60_000 });
  const busy = useRef(false);

  const lvl = map.levels.find((l) => l.name === level) ?? map.levels[0];
  const toWorld = ([px, py]: [number, number]): Vec3 => {
    const x = map.pos_x + px * map.scale, y = map.pos_y - py * map.scale;
    const known = (places.data?.places ?? []).filter((p) => p.pos && (map.levels.length < 2 || levelForZ(map, p.pos[2]) === lvl?.name));
    let z = lvl ? (lvl.z_min < -5000 ? lvl.z_max - 64 : lvl.z_max > 5000 ? lvl.z_min + 64 : (lvl.z_min + lvl.z_max) / 2) : 0;
    if (known.length) z = known.reduce((best, p) => (Math.hypot(p.pos![0] - x, p.pos![1] - y) < Math.hypot(best.pos![0] - x, best.pos![1] - y) ? p : best)).pos![2];
    return [Math.round(x), Math.round(y), Math.round(z)];
  };
  const commit = async (next: Partial<Edit>) => {
    if (busy.current) return;
    busy.current = true;
    setHistory((h) => [...h.slice(-30), { positions: strat.positions, grenades: strat.grenades, shapes: strat.shapes }]);
    try { await onSave(next); } finally { busy.current = false; }
  };
  const undo = async () => {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    await onSave(prev);
  };
  const shape = (tool: DrawTool, points: [number, number][], extra: Partial<Shape> = {}): Shape =>
    ({ id: `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, tool, color, width: 3, level, points, ...extra });

  const down = (pt: [number, number], _l: string, e: RPointerEvent) => {
    if (e.button !== 0) return;
    // le clic ne doit pas reprendre le focus au champ de texte qui apparaît
    if (tool === "text") { e.preventDefault(); if (!text) setText({ at: pt, value: "" }); return; }
    if (["player", "grenade", "arrow", "line", "pen"].includes(tool)) setDraft({ a: pt, b: pt, pts: [pt] });
  };
  const move = (pt: [number, number]) => {
    if (draft) setDraft({ ...draft, b: pt, pts: tool === "pen" ? [...draft.pts, pt] : draft.pts });
    else if (drag) setDrag({ ...drag, at: pt, from: drag.from ?? pt });
  };
  const up = async (pt: [number, number]) => {
    if (drag) {
      const d = drag; setDrag(null);
      if ("id" in d.item) {
        const id = d.item.id, from = d.from;
        if (!from) return;
        const dx = pt[0] - from[0], dy = pt[1] - from[1];
        if (Math.hypot(dx, dy) < 2) return;
        await commit({ shapes: strat.shapes.map((s) => (s.id === id ? { ...s, points: s.points.map(([x, y]) => [x + dx, y + dy] as [number, number]) } : s)) });
        return;
      }
      const i = d.item.index, w = toWorld(pt);
      if (d.item.kind === "position") {
        await commit({ positions: strat.positions.map((p, k) => (k === i ? { ...p, pos: w } : p)) });
      } else {
        await commit({ grenades: strat.grenades.map((g, k) => (k === i ? { ...g, land: w, trajectory: [] } : g)) });
      }
      return;
    }
    if (!draft) return;
    const { a, b, pts } = draft; setDraft(null);
    const moved = Math.hypot(b[0] - a[0], b[1] - a[1]) > 6;
    if (tool === "player") {
      if (strat.positions.length >= 5) return;
      const yaw = moved ? Math.round((Math.atan2(-(b[1] - a[1]), b[0] - a[0]) * 180) / Math.PI) : 0;
      const p: StratPosition = { name: `Joueur ${strat.positions.length + 1}`, role: "", pos: toWorld(a), yaw };
      await commit({ positions: [...strat.positions, p] });
    } else if (tool === "grenade" && moved) {
      if (strat.grenades.length >= 30) return;
      const g: StratGrenade = { type: nade, player: "", note: "", throw: toWorld(a), land: toWorld(b), setpos: null, timing_s: null, trajectory: [] };
      await commit({ grenades: [...strat.grenades, g] });
    } else if ((tool === "arrow" || tool === "line") && moved) {
      await commit({ shapes: [...strat.shapes, shape(tool, [a, b])] });
    } else if (tool === "pen" && pts.length > 2) {
      const thin = smoothStroke(pts).slice(0, 400);
      await commit({ shapes: [...strat.shapes, shape("pen", thin)] });
    }
  };
  const item = async (it: BoardItem, e: RPointerEvent) => {
    if (tool === "erase") {
      e.stopPropagation();
      if ("id" in it) await commit({ shapes: strat.shapes.filter((s) => s.id !== it.id) });
      else if (it.kind === "position") await commit({ positions: strat.positions.filter((_, i) => i !== it.index) });
      else await commit({ grenades: strat.grenades.filter((_, i) => i !== it.index) });
    } else if (tool === "move") {
      e.stopPropagation();
      setDrag({ item: it, at: [0, 0] });
    }
  };
  const addText = async () => {
    if (!text) return;
    const v = text.value.trim(); setText(null);
    if (v) await commit({ shapes: [...strat.shapes, shape("text", [text.at], { text: v.slice(0, 120), width: 4 })] });
  };

  // aperçus : tracé en cours, élément déplacé
  const overlay = (<>
    {draft && (tool === "player"
      ? <><circle cx={draft.a[0]} cy={draft.a[1]} r={14} fill="var(--accent)" fillOpacity={0.5} /><line x1={draft.a[0]} y1={draft.a[1]} x2={draft.b[0]} y2={draft.b[1]} stroke="var(--accent)" strokeWidth={3} /></>
      : tool === "pen" ? <polyline points={draft.pts.map((p) => p.join(",")).join(" ")} fill="none" stroke={color} strokeWidth={3} strokeLinecap="round" />
      : <line x1={draft.a[0]} y1={draft.a[1]} x2={draft.b[0]} y2={draft.b[1]} stroke={tool === "grenade" ? NADE[nade]?.color : color} strokeWidth={3} strokeDasharray={tool === "grenade" ? "8 6" : undefined} />)}
    {drag && "id" in drag.item && drag.from && (() => {
      const it = drag.item as { id: string }, s = strat.shapes.find((x) => x.id === it.id);
      if (!s) return null;
      const dx = drag.at[0] - drag.from[0], dy = drag.at[1] - drag.from[1];
      return <polyline points={s.points.map(([x, y]) => `${x + dx},${y + dy}`).join(" ")} fill="none" stroke="var(--accent)" strokeWidth={3} strokeDasharray="6 4" />;
    })()}
    {drag && !("id" in drag.item) && drag.at[0] > 0 && <circle cx={drag.at[0]} cy={drag.at[1]} r={16} fill="none" stroke="var(--accent)" strokeWidth={3} strokeDasharray="5 4" />}
    {text && <foreignObject x={text.at[0] - 4} y={text.at[1] - 18} width={260} height={36}>
      <input className="sb-board-input" autoFocus value={text.value} placeholder="Texte puis Entrée" aria-label="Texte sur la carte"
        onChange={(e) => setText({ ...text, value: e.target.value })} onBlur={addText}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") void addText(); if (e.key === "Escape") setText(null); }} />
    </foreignObject>}
  </>);

  return (
    <div className="sb-boardwrap" data-testid="strat-board">
      <div className="sb-boardbar" role="toolbar" aria-label="Outils du tableau tactique">
        {TOOLS.map((t) => (
          <button key={t.id} type="button" className={`pill ${tool === t.id ? "on" : ""}`} title={t.hint} onClick={() => setTool(t.id)} data-testid={`board-${t.id}`}>{t.label}</button>
        ))}
        <Button size="sm" variant="ghost" onClick={undo} disabled={!history.length} title="Annuler la dernière modification"><Icon name="back" />Annuler</Button>
      </div>
      {/* options de l'outil sur une ligne de hauteur fixe : la carte ne se décale pas quand on change d'outil */}
      <div className="sb-boardopts">
        {tool === "grenade" && (
          <select className="rf-select" value={nade} onChange={(e) => setNade(e.target.value as GrenadeType)} aria-label="Type de grenade">
            {NADE_TYPES.map((n) => <option key={n} value={n}>{NADE[n]?.label ?? n}</option>)}
          </select>
        )}
        {["arrow", "line", "pen", "text"].includes(tool) && (
          <span className="sb-colors">{DRAW_COLORS.map((c) => <button key={c} type="button" className={`sb-color ${c === color ? "on" : ""}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={`Couleur ${c}`} />)}</span>
        )}
        <span className="st-legend sb-boardhint">{TOOLS.find((t) => t.id === tool)?.hint}{tool === "player" ? ` · ${strat.positions.length}/5` : ""}</span>
      </div>
      <StratMap map={map} strat={strat} level={level} onLevelChange={setLevel} overlay={overlay}
        board={{ down, move, up: (pt) => void up(pt), item: (it, e) => void item(it, e) }} />
      <p className="st-legend">Chaque modification est enregistrée aussitôt. La hauteur des points placés à la main (setpos) est estimée d'après les lieux connus de la carte.</p>
    </div>
  );
}
