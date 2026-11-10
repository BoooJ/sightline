import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { keepPreviousData, useQueries, useQuery } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import { APP_NAME } from "../../shared/brand";
import { EmptyState } from "../../shared/ui/EmptyState";
import { Icon } from "../../shared/ui/Icon";
import { Spinner } from "../../shared/ui/Spinner";
import { Comms } from "./Comms";
import { Controls } from "./Controls";
import { Replay } from "./engine/replay";
import { playerStateAt } from "./engine/state";
import { validLevel } from "./engine/coords";
import { KillFeed } from "./KillFeed";
import { Radar } from "./renderer/Radar";
import { useReplayStore } from "./store";
import { TeamPanel } from "./TeamPanel";
import { Timeline } from "./Timeline";
import { useKeyboard } from "./useKeyboard";
import { formatDate } from "../../shared/format";
import "./replay.css";

/** Replay partagé par lien public (30 jours) : lecture seule, sans compte ; le match entier est navigable, les rounds
 *  superposés du lien sont conservés. */
export function SharePage() {
  const { token = "" } = useParams();
  const [search, setSearch] = useSearchParams();
  const s = useReplayStore();
  const shared = useQuery({ queryKey: ["shared", token], queryFn: () => api.shared(token), retry: false, staleTime: Infinity });
  const audio = useQuery({ queryKey: ["shared-audio", token], queryFn: () => api.sharedAudio(token), enabled: !!shared.data, staleTime: Infinity });
  const roundNumber = Number(search.get("r")) || shared.data?.round_number || 1;
  const match = shared.data?.match;
  const round = match?.rounds.find((r) => r.number === roundNumber);
  const payload = useQuery({ queryKey: ["shared-replay", token, round?.id], queryFn: () => api.sharedReplay(token, round!.id), enabled: !!round,
    staleTime: Infinity, placeholderData: keepPreviousData });
  const replay = useMemo(() => { if (!payload.data?.frames) return null; try { return new Replay(payload.data); } catch { return null; } }, [payload.data]);
  const layerIds = (shared.data?.layers ?? []).filter((id) => id !== round?.id);
  const layerQueries = useQueries({ queries: layerIds.map((id) => ({ queryKey: ["shared-replay", token, id], queryFn: () => api.sharedReplay(token, id), staleTime: Infinity })) });
  const layers = useMemo(() => layerQueries.flatMap((q) => { if (!q.data?.frames) return []; try { return [{ replay: new Replay(q.data), label: String(q.data.round.number) }]; } catch { return []; } }),
    [layerQueries.map((q) => q.dataUpdatedAt).join(",")]);  // eslint-disable-line react-hooks/exhaustive-deps
  const [started, setStarted] = useState(false);
  useEffect(() => {
    if (!replay) return;
    const t = !started && shared.data ? shared.data.tick : 0;
    s.setTick(t >= replay.startTick && t <= replay.lastTick ? t : s.options.freeze ? replay.startTick : replay.freezeEndTick);
    setStarted(true);
  }, [replay]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (shared.data && validLevel(shared.data.map, s.level) !== s.level) s.setLevel(validLevel(shared.data.map, s.level)); }, [shared.data]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!replay || !s.playing) return;
    let raf = 0, last = performance.now();
    const loop = (now: number) => {
      const st = useReplayStore.getState();
      const t = st.tick + ((now - last) / 1000) * replay.tickrate * st.speed;
      last = now;
      if (t >= replay.lastTick) { st.setTick(replay.lastTick); st.setPlaying(false); return; }
      st.setTick(t);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [replay, s.playing]);
  const total = match?.rounds.length ?? 0;
  const go = (n: number) => { if (n >= 1 && n <= total) setSearch((p) => { const q = new URLSearchParams(p); q.set("r", String(n)); return q; }); };
  const kb = useMemo(() => ({ tickrate: replay?.tickrate ?? 64, sampleTicks: replay ? Math.max(1, replay.ticks[1] - replay.ticks[0]) : 4,
    onNext: () => go(roundNumber + 1), onPrev: () => go(roundNumber - 1) }), [replay, roundNumber, total]);  // eslint-disable-line react-hooks/exhaustive-deps
  useKeyboard(kb);

  if (shared.isLoading) return <div className="page"><Spinner /></div>;
  if (shared.isError || !match || !shared.data) return <div className="page"><EmptyState icon="share" title="Lien de partage inconnu ou expiré">Les liens publics sont valables 30 jours. Demandez-en un nouveau à l'auteur.</EmptyState></div>;
  if (payload.isLoading) return <div className="page"><Spinner /></div>;
  if (!round || !replay) return <div className="page"><EmptyState title="Positions indisponibles pour ce round" /></div>;
  const tick = Math.min(Math.max(s.tick, replay.startTick), replay.lastTick);
  const states = playerStateAt(replay, tick);
  const p = payload.data!;
  const prev = match.rounds.find((r) => r.number === roundNumber - 1);
  const before = { a: prev?.score_a_after ?? 0, b: prev?.score_b_after ?? 0 };
  const teamScore = (teamId: number) => (teamId === match.team_a.id ? before.a : before.b);
  const map = shared.data.map;
  return (
    <div className="replay share-replay">
      <header className="rp-head">
        <div className="rp-left">
          <span className="back-link share-brand"><Icon name="share" />{APP_NAME} · lien partagé</span>
          <span className="rp-map">{map.display_name}{match.date ? ` · ${formatDate(match.date)}` : ""}</span>
        </div>
        <div className="rp-scorebug">
          <span className="rp-team ct display">{p.teams.ct.name}</span>
          <span className="rp-score display"><b className="ct">{teamScore(p.teams.ct.id)}</b><i>:</i><b className="t">{teamScore(p.teams.t.id)}</b></span>
          <span className="rp-team t display">{p.teams.t.name}</span>
        </div>
        <div className="rp-right">
          <div className="rp-nav">
            <button type="button" className="btn btn-sm btn-ghost" disabled={roundNumber <= 1} onClick={() => go(roundNumber - 1)} title="Round précédent (P)"><Icon name="back" /></button>
            <span className="rp-round display">Round {roundNumber}</span>
            <button type="button" className="btn btn-sm btn-ghost" disabled={roundNumber >= total} onClick={() => go(roundNumber + 1)} title="Round suivant (N)"><Icon name="back" /></button>
          </div>
          <div className="rp-tools">
            {!!audio.data?.length && <Comms matchId={match.id} tickrate={replay.tickrate} tracksOverride={audio.data} players={p.players} readOnly />}
            <span className="share-expires rf-dim">expire le {formatDate(shared.data.expires_at)}</span>
          </div>
        </div>
      </header>
      <nav className="round-list" aria-label="Rounds">
        {match.rounds.map((r) => (
          <button key={r.id} type="button" className={`rl-cell ${r.winner_side === "CT" ? "ct" : "t"} ${r.number === roundNumber ? "on" : ""}`} onClick={() => go(r.number)} data-testid="share-round">{r.number}</button>
        ))}
      </nav>
      <aside className="rp-side rp-side-ct"><TeamPanel side="CT" name={p.teams.ct.name} score={teamScore(p.teams.ct.id)} players={states.filter((x) => x.side === "CT")} selected={s.selected} onSelect={s.select} /></aside>
      <div className="rp-radar">
        <Radar replay={replay} map={map} tick={tick} level={validLevel(map, s.level)} splitLevels={s.splitLevels} options={s.options} selected={s.selected} onSelect={s.select} layers={layers} />
        {s.options.killfeed !== false && <KillFeed replay={replay} tick={tick} onJump={s.setTick} />}
        {payload.isPlaceholderData && <div className="rp-loading"><Spinner /></div>}
        {layers.length > 0 && <div className="rp-layers" data-testid="layers-legend"><span className="rf-label">Superposés</span>{layers.map((l) => <span key={l.label} className="rp-layer"><i className="mono">{l.label}</i></span>)}</div>}
      </div>
      <aside className="rp-side rp-side-t"><TeamPanel side="T" name={p.teams.t.name} score={teamScore(p.teams.t.id)} players={states.filter((x) => x.side === "T")} selected={s.selected} onSelect={s.select} /></aside>
      <footer className="rp-bottom">
        <Controls map={map} tickrate={replay.tickrate} sampleTicks={kb.sampleTicks} />
        <Timeline replay={replay} tick={tick} onSeek={(t) => s.setTick(t)} />
      </footer>
    </div>
  );
}
