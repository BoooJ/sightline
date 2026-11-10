import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { keepPreviousData, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import { EmptyState } from "../../shared/ui/EmptyState";
import { Icon } from "../../shared/ui/Icon";
import { Spinner } from "../../shared/ui/Spinner";
import { Controls } from "./Controls";
import { Replay } from "./engine/replay";
import { playerStateAt } from "./engine/state";
import { validLevel } from "./engine/coords";
import { KillFeed } from "./KillFeed";
import { Radar } from "./renderer/Radar";
import { RoundList } from "./RoundList";
import { useReplayStore } from "./store";
import { TeamPanel } from "./TeamPanel";
import { Timeline } from "./Timeline";
import { LiveBanner, LiveButton, useLiveSession } from "./LiveSession";
import { usePlaceLabel } from "../../shared/callouts";
import { useMyPlayer } from "../../shared/myPlayer";
import { MoreMenu } from "./MoreMenu";
import { useKeyboard } from "./useKeyboard";
import { DrawToolbar } from "./annotate/DrawToolbar";
import { useAnnotations } from "./annotate/useAnnotations";
import { visibleAt } from "./annotate/shapes";
import type { Shape } from "../../shared/api/types";
import { LayerPicker } from "./LayerPicker";
import { Comms } from "./Comms";
import { GifRecorder } from "./GifRecorder";
import { AddToPlaylist } from "../playlists/AddToPlaylist";
import { TacticsStrip } from "./TacticsStrip";
import { NADES_PANEL_PX, RoundGrenades } from "./RoundGrenades";
import { AddToStratbook } from "../stratbook/AddToStratbook";
import { downloadText, positionsCfg } from "../../shared/practiceCfg";
import { Comments, useComments } from "../team/Comments";
import { playUrl } from "../playlists/PlaylistsPage";
import { loadStudy, saveStudy, studyUrl } from "../../shared/study";
import { backTarget } from "../../shared/backLink";
import "../playlists/playlists.css";
import "./replay.css";
import { Toggle3d, use3dView } from "../replay3d/Toggle3d";
import { LazyScene3D } from "../replay3d/LazyScene3D";  // three.js chargé seulement à l'ouverture de la 3D

export function ReplayPage() {
  const params = useParams();
  const matchId = Number(params.matchId), roundNumber = Number(params.roundNumber);
  const nav = useNavigate();
  const qc = useQueryClient();
  const [search, setSearch] = useSearchParams();
  const playlistId = Number(search.get("playlist")) || null;
  const back = backTarget(search.get("from"));  // page d'origine (scouting, playbook…) : lien « ← Scouting » dans l'en-tête
  const playlist = useQuery({ queryKey: ["playlist", playlistId], queryFn: () => api.playlist(playlistId!), enabled: !!playlistId });
  const s = useReplayStore();
  // séance d'étude (Apprendre un poste) : ?study=1&i=<index>, éléments gardés dans sessionStorage
  const study = useMemo(() => (search.get("study") === "1" ? loadStudy() : null), [search]);
  const [pauses, setPausesState] = useState(() => loadStudy()?.pauses ?? false);
  const setPauses = (v: boolean) => { setPausesState(v); const st = loadStudy(); if (st) saveStudy({ ...st, pauses: v }); };
  const stIndex = Number(search.get("i") ?? 0);
  const stItem = study?.items[stIndex] ?? null;
  const match = useQuery({ queryKey: ["match", matchId], queryFn: () => api.match(matchId) });
  const round = match.data?.rounds.find((r) => r.number === roundNumber);
  // round précédent gardé à l'écran pendant le chargement du suivant (pas d'écran blanc entre deux rounds)
  const payload = useQuery({ queryKey: ["replay", round?.id], queryFn: () => api.replay(round!.id), enabled: !!round,
    staleTime: Infinity, placeholderData: keepPreviousData });
  const map = useQuery({ queryKey: ["map", match.data?.map_name], queryFn: () => api.map(match.data!.map_name), enabled: !!match.data, staleTime: Infinity });
  const view3d = use3dView(match.data?.map_name);
  const analysis = useQuery({ queryKey: ["match-analysis", matchId], queryFn: () => api.matchAnalysis(matchId), staleTime: 5 * 60_000 });
  const place = usePlaceLabel(match.data?.map_name);
  const wpRound = analysis.data?.rounds.find((r) => r.number === roundNumber);
  const swings = useMemo(() => new Map((wpRound?.events ?? []).filter((e) => e.type === "kill").map((e) => [`${e.tick}-${e.victim}`, e.swing])), [wpRound]);
  const replay = useMemo(() => {
    if (!payload.data?.frames) return null;
    try { return new Replay(payload.data); } catch { return null; }
  }, [payload.data]);

  const notes = useAnnotations(round?.id, matchId);
  // analyse multi-rounds : ?layers=<ids de rounds> (même carte, éventuellement d'autres matchs)
  const layerIds = (search.get("layers") ?? "").split(",").map(Number).filter((x) => x > 0 && x !== round?.id);
  const setLayers = (ids: number[]) => setSearch((p) => { const n = new URLSearchParams(p); if (ids.length) n.set("layers", ids.join(",")); else n.delete("layers"); return n; }, { replace: true });
  const layerQueries = useQueries({ queries: layerIds.map((id) => ({ queryKey: ["replay", id], queryFn: () => api.replay(id), staleTime: Infinity })) });
  const layers = useMemo(() => layerQueries.flatMap((q) => {
    if (!q.data?.frames || q.data.map_name !== match.data?.map_name) return [];
    try { return [{ replay: new Replay(q.data), label: String(q.data.round.number), matchId: q.data.match_id }]; } catch { return []; }
  }), [layerQueries.map((q) => q.dataUpdatedAt).join(","), match.data?.map_name]);  // eslint-disable-line react-hooks/exhaustive-deps
  const comments = useComments(matchId);
  const [showComments, setShowComments] = useState(false);
  // panneau « Grenades » : lineups du round ; la grenade choisie est surlignée sur le radar
  const [showNades, setShowNades] = useState(false);
  const [focusNade, setFocusNade] = useState<number | null>(null);
  useEffect(() => setFocusNade(null), [round?.id]);
  const [addStrat, setAddStrat] = useState(false);
  // dessin joint à un commentaire, affiché par-dessus les dessins du round jusqu'à fermeture
  const [viewShapes, setViewShapes] = useState<Shape[]>([]);
  useEffect(() => setViewShapes([]), [round?.id]);
  const [copied, setCopied] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [gifOpen, setGifOpen] = useState(false);
  // mode M : positions déplacées, remises à zéro au changement de round
  useEffect(() => { s.clearOverrides(); }, [round?.id]);  // eslint-disable-line react-hooks/exhaustive-deps
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const copy = async (text: string, label: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(label); setTimeout(() => setCopied(null), 2500); } catch { setShareUrl(text); }  // presse-papiers refusé : lien affiché
  };
  const internalLink = () => { const u = new URL(window.location.href); u.searchParams.set("t", String(Math.round(useReplayStore.getState().tick))); return u.toString(); };
  const publicLink = async () => {
    const l = await api.createShare({ match_id: matchId, round_number: roundNumber, tick: Math.round(useReplayStore.getState().tick), layers: layerIds });
    const url = `${window.location.origin}${l.url}`;
    setShareUrl(url);
    await copy(url, "Lien public copié (30 jours) ✓");
  };
  const me = useMyPlayer();
  const bookmarks = useQuery({ queryKey: ["bookmarks", matchId], queryFn: () => api.bookmarks(matchId) });
  const [bmNotice, setBmNotice] = useState<string | null>(null);
  const addBookmark = async () => {
    if (!replay) return;
    const t = Math.round(useReplayStore.getState().tick);
    const secs = Math.max(0, Math.round(115 - (t - replay.freezeEndTick) / replay.tickrate));
    const label = `Round ${roundNumber} · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
    await api.addBookmark({ match_id: matchId, round_number: roundNumber, tick: t, label });
    qc.invalidateQueries({ queryKey: ["bookmarks"] });
    setBmNotice(`Signet ajouté : ${label}`); setTimeout(() => setBmNotice(null), 2500);
  };
  const live = useLiveSession({ matchId, roundNumber, tickrate: replay?.tickrate ?? 64, shapes: notes.shapes });
  const annotated = useQuery({ queryKey: ["annotated", matchId], queryFn: () => api.annotatedRounds(matchId) });
  // préchargement de tout le match, rounds voisins d'abord, 2 requêtes à la fois
  const loaded = !!payload.data && !payload.isPlaceholderData;
  useEffect(() => {
    if (!loaded || !match.data) return;
    const queue = [...match.data.rounds].sort((a, b) => Math.abs(a.number - roundNumber) - Math.abs(b.number - roundNumber)
      || b.number - a.number);
    let cancelled = false;
    const pump = async () => {
      for (let r = queue.shift(); r && !cancelled; r = queue.shift())
        await qc.prefetchQuery({ queryKey: ["replay", r.id], queryFn: () => api.replay(r.id), staleTime: Infinity }).catch(() => {});
    };
    void pump(); void pump();
    return () => { cancelled = true; };
  }, [loaded, match.data, roundNumber, qc]);
  // ?t=<tick> : ouvre le round à un instant précis (ex. lancer d'une grenade depuis la bibliothèque)
  useEffect(() => {
    if (!replay) return;
    const t = Number(search.get("t"));
    s.setTick(t >= replay.startTick && t <= replay.lastTick ? t : s.options.freeze ? replay.startTick : replay.freezeEndTick);
  }, [replay]);  // eslint-disable-line react-hooks/exhaustive-deps
  // ?focus=<steamid> : joueur sélectionné à l'ouverture (séance d'étude, liens « suivre ce joueur »)
  const focusParam = search.get("focus");
  useEffect(() => { if (focusParam) s.select(focusParam); }, [focusParam, roundNumber]);  // eslint-disable-line react-hooks/exhaustive-deps
  // séance d'étude : lecture automatique, puis élément suivant une seconde après la fin du moment étudié
  const stStarted = useRef("");
  useEffect(() => {
    if (!stItem || !replay || stItem.start < replay.startTick - 64 || stItem.start > replay.lastTick) return;
    const key = `${stIndex}`;
    if (stStarted.current === key) return;
    stStarted.current = key;
    s.setPlaying(true);
  }, [stItem, replay, stIndex]);  // eslint-disable-line react-hooks/exhaustive-deps
  // pauses commentées : arrêt à chaque moment clé du round étudié, avec son explication
  const [markText, setMarkText] = useState<string | null>(null);
  const passed = useRef<Set<number>>(new Set());
  const lastTick = useRef(0);
  useEffect(() => { passed.current = new Set(); setMarkText(null); }, [stIndex, roundNumber]);
  useEffect(() => {
    const prev = lastTick.current;
    lastTick.current = s.tick;
    if (!pauses || !stItem?.marks || !s.playing || s.tick < prev) return;
    const m = stItem.marks.find((x) => !passed.current.has(x.tick) && x.tick > prev && x.tick <= s.tick);
    if (!m) return;
    passed.current.add(m.tick);
    s.setPlaying(false);
    setMarkText(m.text);
  }, [s.tick]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (s.playing) setMarkText(null); }, [s.playing]);
  const stDone = !!stItem && !!replay && stStarted.current === `${stIndex}` && s.tick >= Math.min(stItem.end + replay.tickrate, replay.lastTick);
  useEffect(() => {
    if (!stDone || !study) return;
    const next = study.items[stIndex + 1];
    if (next) nav(studyUrl(next, stIndex + 1)); else s.setPlaying(false);
  }, [stDone]);  // eslint-disable-line react-hooks/exhaustive-deps
  // niveau mémorisé d'une autre carte (ex. « upper » de Nuke en ouvrant Mirage) : on revient au niveau par défaut
  useEffect(() => { if (map.data && validLevel(map.data, s.level) !== s.level) s.setLevel(validLevel(map.data, s.level)); }, [map.data]);  // eslint-disable-line react-hooks/exhaustive-deps

  // boucle de lecture
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

  // morts du joueur suivi (sélection sur le radar, sinon « mon joueur ») sur tout le match
  const focusId = s.selected ?? (me && analysis.data?.players.some((x) => x.steamid === me) ? me : null);
  const focusName = focusId ? analysis.data?.players.find((x) => x.steamid === focusId)?.name ?? null : null;
  const myDeaths = useMemo(() => (analysis.data?.deaths ?? []).filter((d) => d.victim === focusId)
    .sort((a, b) => a.round - b.round || a.tick - b.tick), [analysis.data, focusId]);
  // enchaînement des morts : chaque mort de −5 s à +2 s, l'une après l'autre (?reel=1)
  const reel = search.get("reel") === "1";
  const deathTarget = (d: { tick: number }) => d.tick - (reel ? 5 : 3) * (replay?.tickrate ?? 64);
  const curTick = s.tick;
  const deathIdx = myDeaths.findIndex((d) => d.round === roundNumber && Math.abs(deathTarget(d) - curTick) < (replay?.tickrate ?? 64) * 4);
  const deathPos = myDeaths.length ? `${deathIdx >= 0 ? deathIdx + 1 : "–"}/${myDeaths.length}` : "0";
  const jumpDeath = (dir: 1 | -1) => {
    const tr = replay?.tickrate ?? 64, t = useReplayStore.getState().tick;
    const after = (d: typeof myDeaths[number]) => d.round > roundNumber || (d.round === roundNumber && deathTarget(d) > t + tr / 2);
    const before = (d: typeof myDeaths[number]) => d.round < roundNumber || (d.round === roundNumber && deathTarget(d) < t - tr / 2);
    const d = dir > 0 ? myDeaths.find(after) : [...myDeaths].reverse().find(before);
    if (!d) return;
    goDeath(d);
  };
  const goDeath = (d: typeof myDeaths[number], withReel = reel) => {
    if (d.round === roundNumber && withReel === reel) { s.setTick(deathTarget(d)); s.setPlaying(true); return; }
    const lead = (withReel ? 5 : 3) * (replay?.tickrate ?? 64);
    const q = new URLSearchParams({ t: String(d.tick - lead) });
    for (const k of ["layers", "live", "from"]) { const v = search.get(k); if (v) q.set(k, v); }
    if (withReel) q.set("reel", "1");
    nav(`/matches/${matchId}/replay/${d.round}?${q}`);
  };
  const startReel = () => { if (myDeaths.length) goDeath(myDeaths[0], true); };
  const stopReel = () => {
    s.setPlaying(false);
    const q = new URLSearchParams(search); q.delete("reel"); q.delete("t");
    nav(`/matches/${matchId}/replay/${roundNumber}${q.size ? `?${q}` : ""}`, { replace: true });
  };
  // arrivée sur un round en mode enchaînement : lecture depuis la mort du round (ou la première mort si aucune ici)
  const reelStarted = useRef<string>("");
  useEffect(() => {
    if (!reel || !replay || !analysis.data) return;
    const key = `${roundNumber}`;
    if (reelStarted.current === key) return;
    reelStarted.current = key;
    const here = myDeaths.find((d) => d.round === roundNumber);
    if (here && (here.tick < replay.startTick || here.tick > replay.lastTick)) { reelStarted.current = ""; return; }  // positions du round précédent encore affichées
    if (here) { s.setTick(Math.max(replay.startTick, deathTarget(here))); s.setPlaying(true); }
    else if (myDeaths.length) goDeath(myDeaths.find((d) => d.round > roundNumber) ?? myDeaths[0], true);
    else stopReel();
  }, [reel, replay, analysis.data, roundNumber, myDeaths]);  // eslint-disable-line react-hooks/exhaustive-deps
  // 2 s après la mort : mort suivante, ou fin de l'enchaînement
  const reelHere = reel ? myDeaths.find((d) => d.round === roundNumber) : undefined;
  const reelDone = !!reelHere && !!replay && reelStarted.current === `${roundNumber}` && s.tick >= reelHere.tick + 2 * replay.tickrate;
  useEffect(() => {
    if (!reelDone || !reelHere) return;
    const next = myDeaths.find((d) => d.round > reelHere.round);
    if (next) goDeath(next, true); else stopReel();
  }, [reelDone]);  // eslint-disable-line react-hooks/exhaustive-deps
  const reelPos = reelHere ? myDeaths.indexOf(reelHere) + 1 : 0;
  const total = match.data?.rounds.length ?? 0;
  const go = (n: number) => {
    if (n < 1 || n > total) return;
    const q = new URLSearchParams();
    for (const k of ["layers", "live", "from"]) { const v = search.get(k); if (v) q.set(k, v); }
    nav(`/matches/${matchId}/replay/${n}${q.size ? `?${q}` : ""}`);
  };
  // lecture d'une playlist : N/P et les flèches passent à l'élément suivant/précédent de la playlist
  const plIndex = Number(search.get("i") ?? 0);
  const plGo = (k: number) => { const u = playlist.data && playUrl(playlist.data.id, playlist.data.items, k); if (u) nav(u); };
  const stGo = (k: number) => { const it = study?.items[k]; if (it) nav(studyUrl(it, k)); };
  const step = (d: 1 | -1) => (study ? stGo(stIndex + d) : playlist.data ? plGo(plIndex + d) : go(roundNumber + d));
  const kb = useMemo(() => ({ tickrate: replay?.tickrate ?? 64, sampleTicks: replay ? Math.max(1, replay.ticks[1] - replay.ticks[0]) : 4,
    onNext: () => step(1), onPrev: () => step(-1), onUndo: notes.undo, onDeath: jumpDeath, onBookmark: addBookmark }),
    [replay, roundNumber, total, playlist.data, plIndex, notes.undo, myDeaths, study, stIndex]);  // eslint-disable-line react-hooks/exhaustive-deps
  useKeyboard(kb);

  if (match.isLoading || payload.isLoading || map.isLoading) return <div className="page"><Spinner /></div>;
  const backLink = back ? <Link to={back.to} className="back-link" data-testid="replay-back"><Icon name="back" />{back.label}</Link>
    : <Link to={`/matches/${matchId}`} className="back-link"><Icon name="back" />Match</Link>;
  if (!match.data || !round || !map.data) return <div className="page">{backLink}<EmptyState title="Round introuvable" /></div>;
  if (!replay) return <div className="page">{backLink}<EmptyState title="Positions indisponibles pour ce round">Ré-analysez la démo depuis la bibliothèque.</EmptyState></div>;

  const tick = Math.min(Math.max(s.tick, replay.startTick), replay.lastTick);
  const states = playerStateAt(replay, tick);
  const p = payload.data!;
  // camp « à nous » : joueur sélectionné, sinon le joueur suivi ; sert aux préférences adversaires masqués / coéquipiers pleins
  const mySide = (p.players.find((x) => x.steamid === (s.selected ?? me))?.side ?? null) as "CT" | "T" | null;
  // tempo du round pour l'overlay de site : premier dégât entre camps, plant
  const sideOf = new Map(p.players.map((x) => [x.steamid, x.side]));
  const firstContact = p.damages.find((d) => d.attacker && sideOf.get(d.attacker) !== sideOf.get(d.victim) && d.tick >= replay.freezeEndTick);
  const plant = p.bomb.find((b) => b.type === "plant");
  const tempo = { contact_s: firstContact ? (firstContact.tick - replay.freezeEndTick) / replay.tickrate : null,
    plant_s: plant ? (plant.tick - replay.freezeEndTick) / replay.tickrate : null, site: plant?.site ?? null };
  const moved = Object.keys(s.overrides).length;
  const nadeCount = p.grenades.filter((g) => g.type !== "decoy").length;
  const prev = match.data.rounds.find((r) => r.number === roundNumber - 1);
  const before = { a: prev?.score_a_after ?? 0, b: prev?.score_b_after ?? 0 };
  const teamScore = (teamId: number) => (teamId === match.data.team_a.id ? before.a : before.b);

  // outils d'analyse : en ligne (mode analyste) ou dans le menu « Plus » (mode joueur)
  const secondaryTools = (withLive: boolean) => (<>
          <LayerPicker match={match.data} current={roundNumber} layers={layerIds} onChange={setLayers} />
          <button type="button" className="btn btn-sm btn-ghost" data-testid="add-to-stratbook" title="Ajouter au stratbook (positions, grenades, dessins de cet instant)"
            onClick={() => { s.setPlaying(false); setAddStrat(true); }}><Icon name="book" />Stratbook</button>
          <button type="button" className="btn btn-sm btn-ghost" data-testid="cfg-positions" title="Config CS2 : positions des joueurs vivants à cet instant (un alias pos_<joueur> chacun)"
            onClick={() => {
              const t = useReplayStore.getState().tick;
              const alive = playerStateAt(replay, t).filter((p) => p.alive);
              const secs = Math.max(0, Math.round((t - replay.freezeEndTick) / replay.tickrate));
              downloadText(`positions_${map.data!.name}_r${roundNumber}_${secs}s.cfg`, positionsCfg(
                `Positions — ${match.data!.team_a.name} vs ${match.data!.team_b.name}, ${map.data!.display_name}, round ${roundNumber}, ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`,
                alive.map((p) => ({ name: p.name, side: p.side, x: p.x, y: p.y, z: p.z, yaw: p.yaw }))));
            }}><Icon name="download" />Positions</button>
          {withLive && <LiveButton live={live} />}
          <Comms matchId={matchId} tickrate={replay.tickrate} players={p.players} />
          <AddToPlaylist size="sm" variant="ghost" roundIds={[round.id]} onDone={(msg) => { setBmNotice(msg); setTimeout(() => setBmNotice(null), 2500); }} />
          {/* le GIF rejoue le radar 2D : en 3D, il n'y en a pas (ou un ancien, d'un autre round) */}
          <button type="button" className="btn btn-sm btn-ghost" data-testid="gif-open" disabled={view3d.on}
            title={view3d.on ? "Disponible en 2D seulement" : "Enregistrer un GIF de la vue actuelle"}
            onClick={() => { s.setPlaying(false); setGifOpen(true); }}><Icon name="live" />GIF</button>
  </>);

  return (
    <div className="replay">
      <header className="rp-head">
        <div className="rp-left">
          {back ? <Link to={back.to} className="back-link" data-testid="replay-back" title={`Retour : ${back.label}`}><Icon name="back" />{back.label}</Link>
            : <Link to={`/matches/${matchId}`} className="back-link"><Icon name="back" />Match</Link>}
          <span className="rp-map">{map.data.display_name}</span>
        </div>
        {!playlist.data && (
          <div className="rp-nav">
            <button type="button" className="btn btn-sm btn-ghost" disabled={roundNumber <= 1} onClick={() => go(roundNumber - 1)} title="Round précédent (P)"><Icon name="back" /></button>
            <span className="rp-round display">Round {roundNumber}</span>
            <button type="button" className="btn btn-sm btn-ghost" disabled={roundNumber >= total} onClick={() => go(roundNumber + 1)} title="Round suivant (N)"><Icon name="back" /></button>
          </div>
        )}
        <div className="rp-scorebug">
          <span className="rp-team ct display">{p.teams.ct.name}</span>
          <span className="rp-score display">
            <b className="ct">{teamScore(p.teams.ct.id)}</b><i>:</i><b className="t">{teamScore(p.teams.t.id)}</b>
          </span>
          <span className="rp-team t display">{p.teams.t.name}</span>
        </div>
        <div className="rp-right">
        {playlist.data && (() => {
          const pl = playlist.data, n = pl.items.length, note = pl.items[plIndex]?.note;
          return (
            <div className="rp-playlist" data-testid="playlist-bar">
              <Icon name="playlist" /><Link className="name" to={`/playlists/${pl.id}`}>{pl.name}</Link>
              <span className="mono">{plIndex + 1}/{n}</span><span className="rp-round display">Round {roundNumber}</span>
              {note && <span className="rp-playlist-note" title={note}>{note}</span>}
              <button type="button" className="btn btn-sm btn-ghost" disabled={plIndex <= 0} onClick={() => plGo(plIndex - 1)} title="Élément précédent (P)"><Icon name="prev" /></button>
              <button type="button" className="btn btn-sm btn-ghost" disabled={plIndex >= n - 1} onClick={() => plGo(plIndex + 1)} title="Élément suivant (N)"><Icon name="next" /></button>
            </div>
          );
        })()}
        {study && stItem && (
          <div className="rp-playlist" data-testid="study-bar">
            <Icon name="book" /><Link className="name" to={study.back}>{study.title}</Link>
            <span className="mono">{stIndex + 1}/{study.items.length}</span>
            <span className="rp-playlist-note" title={stItem.label}>{stItem.label}</span>
            <button type="button" className="btn btn-sm btn-ghost" disabled={stIndex <= 0} onClick={() => stGo(stIndex - 1)} title="Précédent (P)"><Icon name="prev" /></button>
            <button type="button" className="btn btn-sm btn-ghost" disabled={stIndex >= study.items.length - 1} onClick={() => stGo(stIndex + 1)} title="Suivant (N)" data-testid="study-next"><Icon name="next" /></button>
            {!!stItem.marks?.length && <label className="rp-study-pauses" title="S'arrêter à chaque moment clé (utilitaire, contact, kill, rotation, mort) avec une explication">
              <input type="checkbox" checked={pauses} onChange={(e) => setPauses(e.target.checked)} data-testid="study-pauses" />Pauses</label>}
          </div>
        )}
        {study && markText && (
          <div className="rp-mark" role="status" data-testid="study-mark">
            <Icon name="comment" /><span>{markText}</span>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => { setMarkText(null); s.setPlaying(true); }} data-testid="study-continue">Continuer (Espace)</button>
          </div>
        )}
        <div className="rp-tools">
          {focusName && (
            <div className="rp-deathnav" role="group" aria-label={`Morts de ${focusName}`} data-testid="death-nav">
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => jumpDeath(-1)} title="Mort précédente (J)" aria-label="Mort précédente"><Icon name="prev" /></button>
              <span title={s.selected ? "Joueur sélectionné sur le radar" : "Joueur suivi (tableau de bord)"}><Icon name="skull" size={14} />{focusName} <b className="mono">{deathPos}</b></span>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => jumpDeath(1)} title="Mort suivante (K)" aria-label="Mort suivante" data-testid="next-death"><Icon name="next" /></button>
              {reel
                ? <button type="button" className="btn btn-sm btn-primary" onClick={stopReel} data-testid="death-reel" aria-pressed="true"
                    title="Arrêter l'enchaînement">■ Enchaînement {reelPos || "–"}/{myDeaths.length}</button>
                : <button type="button" className="btn btn-sm btn-ghost" onClick={startReel} disabled={!myDeaths.length} data-testid="death-reel" aria-pressed="false"
                    title="Revoir toutes les morts à la suite : 5 s avant, 2 s après, puis la suivante"><Icon name="play" />Enchaîner</button>}
            </div>
          )}
          {s.playerMode ? (<>
            {live.role === "leader" && <LiveButton live={live} />}
            <MoreMenu>
              {secondaryTools(live.role !== "leader")}
            </MoreMenu>
          </>) : secondaryTools(true)}
          <Toggle3d view={view3d} />
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => void addBookmark()} title="Ajouter un signet à cet instant (S)" data-testid="add-bookmark">
            <Icon name="bookmark" />Signet</button>
          <button type="button" className={`btn btn-sm btn-ghost ${showNades ? "on" : ""}`} data-testid="toggle-nades"
            title="Grenades du round et leurs lineups (setpos, config CS2, stratbook)"
            onClick={() => { setShowNades(!showNades); setShowComments(false); if (showNades) setFocusNade(null); }}>
            <Icon name="grenade" />Grenades
            {nadeCount > 0 && <span className="rp-tool-count">{nadeCount}</span>}
          </button>
          <button type="button" className={`btn btn-sm btn-ghost ${showComments ? "on" : ""}`} onClick={() => { setShowComments(!showComments); setShowNades(false); setFocusNade(null); }}
            title="Commentaires de l'équipe sur ce round" data-testid="toggle-comments">
            <Icon name="comment" />Commentaires
            {!!comments.data?.filter((c) => c.round_number === roundNumber).length && <span className="rp-tool-count">{comments.data.filter((c) => c.round_number === roundNumber).length}</span>}
          </button>
          <div className="pl-menu-wrap">
            <button type="button" className={`btn btn-sm btn-ghost ${shareOpen ? "on" : ""}`} title="Partager cet instant du replay" aria-expanded={shareOpen}
              onClick={() => setShareOpen(!shareOpen)} data-testid="share-open"><Icon name="share" />{copied ?? "Partager"}</button>
            {shareOpen && (
              <div className="pl-menu panel share-menu" role="menu" data-testid="share-menu">
                <button type="button" className="btn btn-sm" role="menuitem" onClick={() => { void copy(internalLink(), "Lien copié ✓"); setShareOpen(false); }}>Copier le lien (équipe connectée)</button>
                <button type="button" className="btn btn-sm btn-primary" role="menuitem" data-testid="share-public" onClick={() => void publicLink()}>Créer un lien public (30 jours)</button>
                <p className="st-legend">Le lien public ouvre ce round en lecture seule, sans compte ; il expire après 30 jours.</p>
                {shareUrl && <input className="rf-select mono" readOnly value={shareUrl} onFocus={(e) => e.currentTarget.select()} onKeyDown={(e) => e.stopPropagation()} aria-label="Lien public" data-testid="share-url" />}
                {copied && <p className="st-legend" data-testid="share-copied">{copied}</p>}
              </div>
            )}
          </div>
          <button type="button" className="btn btn-sm btn-ghost rp-mode" onClick={s.togglePlayerMode} data-testid="mode-toggle"
            title={s.playerMode ? "Afficher tous les outils d'analyse" : "Barre réduite : lecture, rounds, morts, commentaires"}>
            <Icon name={s.playerMode ? "layers" : "user"} />{s.playerMode ? "Mode analyste" : "Mode joueur"}</button>
        </div>
        </div>
      </header>
      <RoundList match={match.data} current={roundNumber} annotated={annotated.data} />
      <aside className="rp-side rp-side-ct">
        <TeamPanel side="CT" name={p.teams.ct.name} score={teamScore(p.teams.ct.id)} players={states.filter((x) => x.side === "CT")} selected={s.selected} onSelect={s.select} />
      </aside>
      <div className="rp-radar">
        {/* vue 3D : une fois ouverte, gardée cachée et en pause quand on repasse en 2D, pour un retour sans rien recharger
            (`LazyScene3D`) ; démontée en quittant la page, sur une autre carte (`key`) ou après un échec */}
        {view3d.available && !view3d.failed && (
          <LazyScene3D key={view3d.available.map} active={view3d.on} replay={replay} map3d={view3d.available}
            variant={view3d.variant} onVariant={view3d.setVariant} tick={tick} selected={s.selected} onSelect={s.select}
            onFail={view3d.fail} radar={map.data} score={{ ct: teamScore(p.teams.ct.id), t: teamScore(p.teams.t.id) }} />
        )}
        {!view3d.on && (
          <Radar replay={replay} map={map.data} tick={tick} level={validLevel(map.data, s.level)} splitLevels={s.splitLevels}
            options={s.options} selected={s.selected} onSelect={s.select} layers={layers}
            mySide={mySide} overrides={s.overrides} onMovePlayer={s.movePlayer} tempo={tempo} focusNade={showNades ? focusNade : null} rightInset={showNades ? NADES_PANEL_PX : 0}
            drawing={{ tool: s.tool, color: s.color, width: s.width, timed: s.timed,
              shapes: viewShapes.length || live.liveShapes.length ? [...notes.shapes, ...viewShapes, ...live.liveShapes] : notes.shapes,
              onAdd: notes.add, onErase: notes.erase,
              // seuls les dessins enregistrés du round se déplacent (pas ceux d'un commentaire ni de la session en direct)
              onMove: (id, pts) => { if (notes.shapes.some((x) => x.id === id)) notes.move(id, pts); } }} />
        )}
        {!view3d.on && <DrawToolbar count={notes.shapes.length} note={notes.note} status={notes.status} onUndo={notes.undo} onClear={notes.clear} onNote={notes.setNote} />}
        {s.options.killfeed !== false && <KillFeed replay={replay} tick={tick} onJump={s.setTick} swings={swings} place={place} />}
        {s.options.sequencer !== false && <TacticsStrip replay={replay} tick={tick} onJump={(t) => { s.setPlaying(false); s.setTick(t); }} />}
        {moved > 0 && (
          <div className="rp-viewshapes rp-moved" data-testid="moved-players">{moved} joueur{moved > 1 ? "s" : ""} déplacé{moved > 1 ? "s" : ""} (et si…)
            <button type="button" className="btn btn-sm btn-ghost" onClick={s.clearOverrides} data-testid="moved-reset">Replacer</button></div>
        )}
        {gifOpen && !view3d.on && <GifRecorder name={`${map.data.name}_r${roundNumber}`} replay={replay} onClose={() => setGifOpen(false)} />}
        <LiveBanner live={live} />
        {bmNotice && <div className="rp-toast" role="status" data-testid="bookmark-toast">{bmNotice}</div>}
        {payload.isPlaceholderData && <div className="rp-loading"><Spinner /></div>}
        {addStrat && <AddToStratbook replay={replay} tick={tick} matchId={matchId} roundNumber={roundNumber} mapName={map.data.name}
          shapes={notes.shapes} onClose={() => setAddStrat(false)} />}
        {viewShapes.length > 0 && (
          <div className="rp-viewshapes" data-testid="comment-drawing">Dessin du commentaire affiché
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setViewShapes([])} aria-label="Masquer le dessin du commentaire">✕</button></div>
        )}
        {layers.length > 0 && (
          <div className="rp-layers" data-testid="layers-legend">
            <span className="rf-label">Superposés</span>
            {layers.map((l) => (
              <span key={l.replay.payload.round.id} className="rp-layer">
                <i className="mono">{l.label}</i>{l.matchId !== matchId && <small>autre match</small>}
                <button type="button" aria-label={`Retirer le round ${l.label}`} onClick={() => setLayers(layerIds.filter((x) => x !== l.replay.payload.round.id))}>✕</button>
              </span>
            ))}
          </div>
        )}
        {showNades && (
          <RoundGrenades matchId={matchId} map={map.data.name} round={roundNumber} tickrate={replay.tickrate} focus={focusNade}
            onFocus={(id, t) => {
              setFocusNade(id);
              if (t !== undefined) { s.setPlaying(false); s.setTick(Math.max(replay.startTick, t)); }
            }}
            onClose={() => { setShowNades(false); setFocusNade(null); }} />
        )}
        {showComments && (
          <aside className="rp-comments">
            <div className="rp-comments-head"><h2 className="section-title">Commentaires · Round {roundNumber}</h2>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setShowComments(false)} aria-label="Fermer">✕</button></div>
            <Comments matchId={matchId} round={{ number: roundNumber, tick, startTick: replay.freezeEndTick, tickrate: replay.tickrate }}
              currentShapes={notes.shapes.filter((sh) => visibleAt(sh, tick))}
              onJump={(t, shapes) => {
                s.setPlaying(false); s.setTick(t);
                // affiché tel quel, quel que soit l'instant : on retire l'intervalle de visibilité d'origine
                setViewShapes(shapes.map((sh, k) => ({ ...sh, id: `c-${k}-${sh.id}`, from_tick: null, to_tick: null })));
              }} />
          </aside>
        )}
      </div>
      <aside className="rp-side rp-side-t">
        <TeamPanel side="T" name={p.teams.t.name} score={teamScore(p.teams.t.id)} players={states.filter((x) => x.side === "T")} selected={s.selected} onSelect={s.select} />
      </aside>
      <footer className="rp-bottom">
        <Controls map={map.data} tickrate={replay.tickrate} sampleTicks={kb.sampleTicks} />
        <Timeline replay={replay} tick={tick} onSeek={(t) => s.setTick(t)}
          bookmarks={(bookmarks.data ?? []).filter((b) => b.round_number === roundNumber)}
          winprob={wpRound && analysis.data ? { round: wpRound, names: analysis.data.names, place } : undefined} />
      </footer>
    </div>
  );
}
