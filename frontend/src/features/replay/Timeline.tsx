import type { PlaceLabel } from "../../shared/callouts";
import { useMemo, useRef, useState } from "react";
import type { Replay } from "./engine/replay";
import { roundClock, timelineMarkers } from "./engine/state";
import { Icon } from "../../shared/ui/Icon";
import type { AnalysisRound } from "../../shared/api/types";
import { probAt, WinProbChart } from "../match/WinProbChart";

export type WinProbBand = { round: AnalysisRound; names: Record<string, string>; place: PlaceLabel };

export function Timeline({ replay, tick, onSeek, winprob, bookmarks }: {
  replay: Replay; tick: number; onSeek: (t: number) => void; winprob?: WinProbBand; bookmarks?: { id: number; tick: number; label: string }[];
}) {
  const bar = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ x: number; tick: number } | null>(null);
  const markers = useMemo(() => timelineMarkers(replay), [replay]);
  const span = Math.max(1, replay.lastTick - replay.startTick);
  const pct = (t: number) => ((t - replay.startTick) / span) * 100;
  const tickAt = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect();
    return replay.startTick + Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * span;
  };
  const clock = roundClock(replay, tick);
  return (
    <div className="timeline">
      <span className={`tl-clock mono ${clock.phase}`} data-testid="round-clock">{clock.label}</span>
      <div ref={bar} className="tl-bar" data-testid="timeline"
        onMouseDown={(e) => { onSeek(tickAt(e.clientX)); const move = (ev: MouseEvent) => onSeek(tickAt(ev.clientX));
          const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
          window.addEventListener("mousemove", move); window.addEventListener("mouseup", up); }}
        onMouseMove={(e) => setHover({ x: e.clientX - bar.current!.getBoundingClientRect().left, tick: tickAt(e.clientX) })}
        onMouseLeave={() => setHover(null)}>
        <div className="tl-freeze" style={{ width: `${pct(replay.freezeEndTick)}%` }} />
        <div className="tl-after" style={{ left: `${pct(replay.endTick)}%` }} />
        <div className="tl-progress" style={{ width: `${pct(tick)}%` }} />
        {markers.map((m, i) => (
          <span key={i} className={`tl-marker tl-${m.kind} ${m.side === "CT" ? "ct" : m.side === "T" ? "t" : ""}`}
            style={{ left: `${pct(m.tick)}%` }} title={m.label}
            onMouseDown={(e) => { e.stopPropagation(); onSeek(m.tick - replay.tickrate); }}>
            {m.kind === "plant" || m.kind === "explode" ? <Icon name="bomb" size={12} /> : m.kind === "defuse" ? <Icon name="defuse" size={12} /> : null}
          </span>
        ))}
        {bookmarks?.map((b) => (
          <span key={`bm-${b.id}`} className="tl-bookmark" style={{ left: `${pct(b.tick)}%` }} title={`Signet : ${b.label || "sans titre"}`}
            data-testid="tl-bookmark" onMouseDown={(e) => { e.stopPropagation(); onSeek(b.tick); }}><Icon name="bookmark" size={11} /></span>
        ))}
        <div className="tl-head" style={{ left: `${pct(tick)}%` }} />
        {hover && <div className="tl-hover mono" style={{ left: hover.x }}>{roundClock(replay, hover.tick).label}</div>}
      </div>
      {winprob && (<>
        <span className="tl-wp-read mono" title="Probabilité de victoire à cet instant" data-testid="winprob-now">
          <b className="wp-ct">{Math.round(probAt(winprob.round, tick) * 100)}</b><i>%</i><b className="wp-t">{Math.round((1 - probAt(winprob.round, tick)) * 100)}</b>
        </span>
        <WinProbChart compact round={winprob.round} tickrate={replay.tickrate} names={winprob.names} place={winprob.place} tick={tick}
          range={[replay.startTick, replay.lastTick]} onSeek={onSeek} />
      </>)}
    </div>
  );
}
