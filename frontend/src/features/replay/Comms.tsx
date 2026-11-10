import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import type { AudioTrack } from "../../shared/api/types";
import { Icon } from "../../shared/ui/Icon";
import { attachAudio, useUploads } from "../library/uploads";
import { useReplayStore } from "./store";

const load = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const save = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* stockage indisponible */ } };
const clock = (s: number) => `${s < 0 ? "-" : ""}${Math.floor(Math.abs(s) / 60)}:${(Math.abs(s) % 60).toFixed(1).padStart(4, "0")}`;

/** Une piste audio synchronisée avec le replay : temps audio = temps démo + décalage. */
function TrackAudio({ track, tickrate, muted, volume, calibrating, el }: {
  track: AudioTrack; tickrate: number; muted: boolean; volume: number; calibrating: boolean; el: (a: HTMLAudioElement | null) => void;
}) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => { el(ref.current); return () => el(null); }, [el]);
  useEffect(() => { if (ref.current) ref.current.volume = volume; }, [volume]);
  useEffect(() => {
    const a = ref.current;
    if (!a || calibrating) return;
    const sync = () => {
      const { tick, playing, speed } = useReplayStore.getState();
      const target = tick / tickrate + track.offset_s;
      const inRange = target >= 0 && (!isFinite(a.duration) || target < a.duration);
      a.muted = muted || speed > 4;
      a.playbackRate = Math.min(4, Math.max(0.25, speed));
      if (!inRange) { if (!a.paused) a.pause(); return; }
      if (Math.abs(a.currentTime - target) > (playing ? 0.3 : 0.05)) a.currentTime = target;
      if (playing && a.paused) void a.play().catch(() => {});
      if (!playing && !a.paused) a.pause();
    };
    sync();
    const unsub = useReplayStore.subscribe(sync);
    const timer = setInterval(sync, 500);
    return () => { unsub(); clearInterval(timer); a.pause(); };
  }, [track.offset_s, calibrating, muted, tickrate]);
  return <audio ref={ref} src={track.url} preload="auto" controls={calibrating} className={calibrating ? "comms-audio" : "comms-hidden"} />;
}

/** Communications vocales synchronisées avec le replay : une piste par joueur (ou par équipe), toutes jouées ensemble,
 *  chacune assignable à un joueur et calée à 0,1 s près (comme les « voice tracks » d'EDGE). */
export function Comms({ matchId, tickrate, players, tracksOverride, readOnly }: {
  matchId: number; tickrate: number; players?: { steamid: string; name: string }[];
  /** pistes déjà chargées (page de partage publique) */ tracksOverride?: AudioTrack[]; readOnly?: boolean;
}) {
  const qc = useQueryClient();
  const tracks = useQuery({ queryKey: ["audio", matchId], queryFn: () => api.audioTracks(matchId), enabled: !tracksOverride });
  const list = tracksOverride ?? tracks.data ?? [];
  const [open, setOpen] = useState(false);
  const [off, setOff] = useState<number[]>(() => { try { return JSON.parse(load(`comms-off-${matchId}`, "[]")); } catch { return []; } });
  const [volume, setVolume] = useState(() => Number(load("comms-volume", "0.8")));
  const [muted, setMuted] = useState(false);
  const [calibrating, setCalibrating] = useState<number | null>(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const els = useRef<Record<number, HTMLAudioElement | null>>({});
  const uploads = useUploads((s) => s.items);
  const refresh = () => qc.invalidateQueries({ queryKey: ["audio", matchId] });
  const active = list.filter((t) => !off.includes(t.id));
  useEffect(() => { save(`comms-off-${matchId}`, JSON.stringify(off)); }, [off, matchId]);
  useEffect(() => { save("comms-volume", String(volume)); }, [volume]);

  const shift = async (t: AudioTrack, d: number) => { await api.updateAudio(t.id, { offset_s: t.offset_s + d }); refresh(); };
  const shiftAll = async (d: number) => { await Promise.all(active.map((t) => api.updateAudio(t.id, { offset_s: t.offset_s + d }))); refresh(); };
  const calibrate = async () => {
    const t = list.find((x) => x.id === calibrating), a = calibrating != null ? els.current[calibrating] : null;
    if (!t || !a) return;
    const tick = useReplayStore.getState().tick;
    await api.updateAudio(t.id, { offset_s: a.currentTime - tick / tickrate });
    setCalibrating(null);
    refresh();
  };
  const upload = async (f: File) => {
    setBusy(`Envoi de ${f.name}…`);
    try {
      await attachAudio(matchId, f, label.trim() || f.name.replace(/\.[^.]+$/, ""));
      setLabel(""); setBusy(null); refresh();
    } catch (e) { setBusy(`Échec : ${(e as Error).message}`); }
  };
  const progress = Object.values(uploads).find((u) => u.status === "uploading" && busy?.includes(u.name));
  const playerName = (sid: string | null) => players?.find((p) => p.steamid === sid)?.name;

  return (
    <div className="pl-menu-wrap">
      <button type="button" className={`btn btn-sm btn-ghost ${active.length ? "on" : ""}`} onClick={() => setOpen(!open)} data-testid="comms-toggle"
        title="Communications vocales synchronisées">
        <Icon name={muted || !active.length ? "mute" : "voice"} />Comms{list.length > 0 && <span className="rp-tool-count">{list.length}</span>}
      </button>
      {active.map((t) => <TrackAudio key={t.id} track={t} tickrate={tickrate} muted={muted} volume={volume} calibrating={calibrating === t.id}
        el={(a) => { els.current[t.id] = a; }} />)}
      {open && (
        <div className="pl-menu panel comms-menu" data-testid="comms-panel">
          <span className="rf-label">Pistes audio · {active.length}/{list.length} jouée{active.length > 1 ? "s" : ""}</span>
          {list.map((t) => (
            <div key={t.id} className={`comms-track ${!off.includes(t.id) ? "on" : ""}`} data-testid="comms-track">
              <label className="comms-pick">
                <span className="comms-pick-head"><input type="checkbox" checked={!off.includes(t.id)} onChange={(e) => setOff(e.target.checked ? off.filter((x) => x !== t.id) : [...off, t.id])} aria-label={`Jouer ${t.label}`} />
                  <b>{t.label}</b>{t.steamid && <small className="comms-player">{playerName(t.steamid) ?? t.steamid}</small>}</span>
                <small className="mono">décalage {clock(t.offset_s)}</small>
              </label>
              {!readOnly && (<>
                <div className="comms-row comms-shift">
                  {[-1, -0.1, 0.1, 1].map((d) => <button key={d} type="button" className="pill" onClick={() => shift(t, d)} aria-label={`${t.label} ${d > 0 ? "+" : ""}${d} s`}>{d > 0 ? "+" : ""}{d} s</button>)}
                  <button type="button" className="pill" onClick={() => setCalibrating(calibrating === t.id ? null : t.id)} aria-pressed={calibrating === t.id}>Caler…</button>
                  <button type="button" className="cm-del" aria-label={`Supprimer ${t.label}`} onClick={async () => { await api.deleteAudio(t.id); refresh(); }}><Icon name="trash" size={13} /></button>
                </div>
                {players && (
                  <select className="rf-select comms-assign" value={t.steamid ?? ""} aria-label={`Joueur de la piste ${t.label}`} data-testid="comms-player"
                    onChange={async (e) => { await api.updateAudio(t.id, { steamid: e.target.value }); refresh(); }}>
                    <option value="">Piste d'équipe (aucun joueur)</option>
                    {players.map((p) => <option key={p.steamid} value={p.steamid}>{p.name}</option>)}
                  </select>
                )}
              </>)}
              {calibrating === t.id && (
                <div className="comms-cal">
                  <p className="st-legend">Positionnez le lecteur sur le moment du son qui correspond à l'instant affiché par le replay (un kill, un appel…), puis calez.</p>
                  <div className="comms-row">
                    <button type="button" className="btn btn-sm btn-primary" onClick={calibrate} data-testid="comms-calibrate">Caler sur l'instant du replay</button>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => setCalibrating(null)}>Annuler</button>
                  </div>
                </div>
              )}
            </div>
          ))}
          {!list.length && <p className="cm-empty">Aucune piste. Ajoutez l'enregistrement des comms du match (MP3, OGG, M4A, WAV…), une piste par joueur ou pour l'équipe.</p>}
          {active.length > 0 && (<>
            <div className="comms-row">
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setMuted(!muted)} aria-label={muted ? "Rétablir le son" : "Couper le son"}><Icon name={muted ? "mute" : "voice"} /></button>
              <input type="range" min={0} max={1} step={0.05} value={volume} onChange={(e) => setVolume(Number(e.target.value))} aria-label="Volume" className="hm-range" />
            </div>
            {!readOnly && active.length > 1 && (
              <div className="comms-row comms-shift"><span className="rf-label">Toutes</span>
                {[-1, -0.1, 0.1, 1].map((d) => <button key={d} type="button" className="pill" onClick={() => shiftAll(d)} aria-label={`Toutes les pistes ${d > 0 ? "+" : ""}${d} s`}>{d > 0 ? "+" : ""}{d} s</button>)}
              </div>
            )}
          </>)}
          {!readOnly && (<>
            <span className="rf-label">Ajouter une piste</span>
            <div className="comms-row">
              <input className="rf-select" placeholder="Nom (ex. FaZe ou karrigan)" value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.stopPropagation()} aria-label="Nom de la piste" />
              <label className="btn btn-sm">Fichier…<input type="file" hidden accept="audio/*,.mp3,.ogg,.opus,.m4a,.aac,.wav,.webm,.flac" data-testid="comms-file"
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f); }} /></label>
            </div>
            {busy && <p className="st-legend">{busy}{progress ? ` ${Math.round((100 * progress.sent) / Math.max(1, progress.size))} %` : ""}</p>}
          </>)}
        </div>
      )}
    </div>
  );
}
