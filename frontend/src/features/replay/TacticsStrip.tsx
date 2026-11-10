import { useQuery } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import type { ReplayPayload } from "../../shared/api/types";
import type { Replay } from "./engine/replay";

const clock = (s: number) => { const v = Math.max(0, 115 - s); return `${Math.floor(v / 60)}:${String(Math.floor(v % 60)).padStart(2, "0")}`; };

/** Séquence des tactiques du round (comme le « Tactics Sequencer » du replayer d'EDGE) : pour chaque camp, les tactiques du
 *  playbook détectées dans ce round avec leur horodatage ; un clic avance le replay à cet instant. */
export function TacticsStrip({ replay, tick, onJump }: { replay: Replay; tick: number; onJump: (t: number) => void }) {
  const p: ReplayPayload = replay.payload;
  const t = useQuery({ queryKey: ["playbook2", p.teams.t.id, p.map_name, "T"], queryFn: () => api.playbook2(p.teams.t.id, { map: p.map_name, side: "T" }), staleTime: 60_000 });
  const ct = useQuery({ queryKey: ["playbook2", p.teams.ct.id, p.map_name, "CT"], queryFn: () => api.playbook2(p.teams.ct.id, { map: p.map_name, side: "CT" }), staleTime: 60_000 });
  const items = [
    ...(t.data?.rounds.find((r) => r.round_id === p.round.id)?.sequence ?? []).map((s) => ({ ...s, side: "T" as const, team: p.teams.t.name })),
    ...(ct.data?.rounds.find((r) => r.round_id === p.round.id)?.sequence ?? []).map((s) => ({ ...s, side: "CT" as const, team: p.teams.ct.name })),
  ].sort((a, b) => a.at_s - b.at_s);
  if (!items.length) return null;
  const now = (tick - replay.freezeEndTick) / replay.tickrate;
  return (
    <div className="rp-strip" data-testid="tactics-strip" role="list" aria-label="Séquence des tactiques">
      {items.map((it, i) => (
        <button key={`${it.side}-${it.tactic}-${i}`} type="button" role="listitem" className={`rp-strip-item ${it.side.toLowerCase()} ${now >= it.at_s ? "past" : ""}`}
          title={`${it.team} · ${it.name} · ${clock(it.at_s)}`} onClick={() => onJump(replay.freezeEndTick + it.at_s * replay.tickrate)}>
          <span>{it.name}</span><small className="mono">{clock(it.at_s)}</small>
        </button>
      ))}
    </div>
  );
}
