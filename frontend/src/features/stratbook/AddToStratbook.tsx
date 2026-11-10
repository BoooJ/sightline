import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api } from "../../shared/api/client";
import type { GrenadeThrow, Side, StratGrenade, StratType } from "../../shared/api/types";
import { Button } from "../../shared/ui/Button";
import { Icon } from "../../shared/ui/Icon";
import { visibleAt } from "../replay/annotate/shapes";
import type { Replay } from "../replay/engine/replay";
import { playerStateAt } from "../replay/engine/state";
import { STRAT_TYPES, stratHref } from "./strat";

/** « Ajouter au stratbook » depuis le replay : positions d'un camp à l'instant, ses grenades du round, dessins visibles. */
export function AddToStratbook({ replay, tick, matchId, roundNumber, mapName, shapes, onClose }: {
  replay: Replay; tick: number; matchId: number; roundNumber: number; mapName: string;
  shapes: import("../../shared/api/types").Shape[]; onClose: () => void;
}) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [side, setSide] = useState<Side>("T");
  const [name, setName] = useState(`Round ${roundNumber}`);
  const [type, setType] = useState<StratType>("execute");
  const [withNades, setWithNades] = useState(true), [withShapes, setWithShapes] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  // setpos des grenades : la bibliothèque de grenades les a (angles de vue au lancer)
  const lib = useQuery({ queryKey: ["grenades", mapName, matchId], queryFn: () => api.grenades({ map: mapName, match: String(matchId), lineups: "false" }) });
  const alive = playerStateAt(replay, tick).filter((p) => p.alive && p.side === side);
  const sideOf = new Map(replay.players.map((p) => [p.steamid, p.side]));
  const nameOf = new Map(replay.players.map((p) => [p.steamid, p.name]));
  const nades = replay.payload.grenades.filter((g) => sideOf.get(g.thrower) === side && g.throw_tick <= tick + 2 * replay.tickrate);
  const visible = shapes.filter((s) => visibleAt(s, tick));
  const save = async () => {
    setErr(null);
    try {
      const byId = new Map((lib.data?.throws ?? []).map((t: GrenadeThrow) => [t.id, t]));
      const grenades: Partial<StratGrenade>[] = withNades ? nades.map((g) => {
        const t = byId.get(g.id);
        const traj = g.trajectory.filter((_, i, a) => i % Math.max(1, Math.ceil(a.length / 24)) === 0 || i === a.length - 1).map((p) => [p[1], p[2], p[3]] as [number, number, number]);
        return { type: g.type, player: nameOf.get(g.thrower) ?? "", throw: g.throw_pos, land: g.detonate_pos ?? traj[traj.length - 1] ?? null,
          setpos: t?.setpos ?? null, timing_s: Math.max(0, Math.round(((g.throw_tick - replay.freezeEndTick) / replay.tickrate) * 10) / 10), trajectory: traj };
      }) : [];
      const s = await api.createStrat({
        name: name.trim() || `Round ${roundNumber}`, map: mapName, side, type,
        positions: alive.slice(0, 5).map((p) => ({ name: p.name, role: "", pos: [p.x, p.y, p.z], yaw: p.yaw })),
        grenades: grenades as StratGrenade[], shapes: withShapes ? visible : [],
        source: { match_id: matchId, round_number: roundNumber, tick: Math.round(tick) },
      });
      qc.invalidateQueries({ queryKey: ["strats"] });
      nav(stratHref(s));
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="dialog panel sc-dialog" role="dialog" aria-label="Ajouter au stratbook" data-testid="add-strat" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="sc-dialog-head"><h2 className="display">Ajouter au stratbook</h2><Button size="sm" variant="ghost" onClick={onClose} aria-label="Fermer">✕</Button></div>
        <label className="auth-field"><span>Nom de la stratégie</span><input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} autoFocus /></label>
        <div className="rf-row">
          <div className="rf-group"><span className="rf-label">Camp</span>
            <div className="map-pills" role="group" aria-label="Camp de la stratégie">
              {(["T", "CT"] as const).map((s) => <button key={s} type="button" className={`pill pill-${s.toLowerCase()} ${side === s ? "on" : ""}`} onClick={() => setSide(s)}>{s}</button>)}
            </div></div>
          <label className="rf-group"><span className="rf-label">Type</span>
            <select className="rf-select" value={type} onChange={(e) => setType(e.target.value as StratType)}>{Object.entries(STRAT_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        </div>
        <ul className="sb-list">
          <li><Icon name="user" />{alive.length} position{alive.length > 1 ? "s" : ""} ({side}) à cet instant</li>
          <li><label className="hm-check"><input type="checkbox" checked={withNades} onChange={(e) => setWithNades(e.target.checked)} />{nades.length} grenade{nades.length > 1 ? "s" : ""} {side} du round (jusqu'à cet instant)</label></li>
          <li><label className="hm-check"><input type="checkbox" checked={withShapes} onChange={(e) => setWithShapes(e.target.checked)} />{visible.length} dessin{visible.length > 1 ? "s" : ""} visible{visible.length > 1 ? "s" : ""}</label></li>
        </ul>
        {err && <p className="auth-error">{err}</p>}
        <div className="sc-dialog-foot"><Button variant="ghost" onClick={onClose}>Annuler</Button><Button type="submit" variant="primary" disabled={lib.isLoading}>Créer la stratégie</Button></div>
      </form>
    </div>
  );
}

/** Ajout d'un lineup (page Grenades) à une stratégie existante ou nouvelle de la même carte. */
export function AddLineupToStrat({ map, side, grenade }: { map: string; side: Side; grenade: Partial<StratGrenade> }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const list = useQuery({ queryKey: ["strats", map, side], queryFn: () => api.strats({ map, side }), enabled: open });
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  const add = async (id: number, label: string) => {
    await api.addStratGrenade(id, grenade);
    qc.invalidateQueries({ queryKey: ["strats"] }); qc.invalidateQueries({ queryKey: ["strat", id] });
    setOpen(false); setMsg(`Ajouté à « ${label} »`);
  };
  return (
    <div className="pl-menu-wrap" ref={ref}>
      <button type="button" className="btn btn-sm" onClick={() => setOpen(!open)} data-testid="lineup-to-strat"><Icon name="book" />Stratbook</button>
      {msg && <span className="st-legend"> {msg}</span>}
      {open && (
        <div className="pl-menu panel" role="menu">
          {list.data?.map((s) => <button key={s.id} type="button" role="menuitem" onClick={() => add(s.id, s.name)}><span>{s.name}</span><span className="mono">{s.counts.grenades}</span></button>)}
          {list.data?.length === 0 && <div className="pl-menu-empty">Aucune stratégie {side} sur cette carte.</div>}
          <button type="button" role="menuitem" onClick={async () => {
            const s = await api.createStrat({ name: `${grenade.type} ${grenade.player ?? ""}`.trim(), map, side, type: "setup", grenades: [grenade as StratGrenade] });
            qc.invalidateQueries({ queryKey: ["strats"] }); setOpen(false); setMsg(`Nouvelle stratégie « ${s.name} »`);
          }}><span>+ Nouvelle stratégie</span></button>
        </div>
      )}
    </div>
  );
}
