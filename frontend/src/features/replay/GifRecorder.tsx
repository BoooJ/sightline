import { useState } from "react";
import { Button } from "../../shared/ui/Button";
import { Icon } from "../../shared/ui/Icon";
import type { Replay } from "./engine/replay";
import { drawFrame } from "./renderer/draw";
import { radarSnapshot } from "./renderer/snapshot";
import { useReplayStore } from "./store";

const DURATIONS = [3, 5, 10, 15];
const FPS = [10, 15, 20];
const WIDTHS = [480, 720, 960];

/** Enregistreur GIF (comme le « GIF recorder » d'EDGE) : depuis l'instant courant, N secondes de la vue actuelle du radar,
 *  rendues hors écran image par image puis encodées (pas de capture temps réel : le résultat est net quelle que soit la machine). */
export function GifRecorder({ name, replay, onClose }: { name: string; replay: Replay; onClose: () => void }) {
  const [duration, setDuration] = useState(5);
  const [fps, setFps] = useState(15);
  const [width, setWidth] = useState(720);
  const [file, setFile] = useState(name);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ url: string; size: number } | null>(null);
  const record = async () => {
    const snap = radarSnapshot.args;
    // dernier radar dessiné : il doit montrer ce round (sinon, vue 3D ou radar d'un autre round resté en mémoire)
    if (!snap || snap.replay !== replay) { setError("Radar indisponible : le GIF se fait depuis la vue 2D."); return; }
    setError(null); setDone(null); setProgress(0);
    try {
      const { GIFEncoder, quantize, applyPalette } = await import("gifenc");
      const ratio = snap.height / snap.width;
      const w = width, h = Math.round(width * ratio);
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      const scale = w / snap.width;
      const view = { zoom: snap.view.zoom, panX: snap.view.panX * scale, panY: snap.view.panY * scale };
      const gif = GIFEncoder();
      const start = useReplayStore.getState().tick;
      const frames = Math.round(duration * fps);
      const delay = Math.round(1000 / fps);
      for (let i = 0; i < frames; i++) {
        const tick = Math.min(snap.replay.lastTick, start + (i / fps) * snap.replay.tickrate);
        drawFrame(ctx, { ...snap, tick, view, dpr: 1, width: w, height: h, draft: null });
        const { data } = ctx.getImageData(0, 0, w, h);
        const palette = quantize(data, 256);
        const index = applyPalette(data, palette);
        gif.writeFrame(index, w, h, { palette, delay });
        setProgress((i + 1) / frames);
        if (i % 5 === 4) await new Promise((r) => setTimeout(r, 0));  // l'interface reste réactive
      }
      gif.finish();
      const bytes = gif.bytes();
      const blob = new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: "image/gif" });
      setDone({ url: URL.createObjectURL(blob), size: blob.size });
    } catch (e) { setError((e as Error).message); }
    setProgress(null);
  };
  const safe = (file.trim() || "replay").replace(/[^\w.-]+/g, "_");
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog panel gif-dialog" role="dialog" aria-label="Enregistrer un GIF" data-testid="gif-dialog">
        <div className="sc-dialog-head"><h2 className="display">Enregistrer un GIF</h2><Button size="sm" variant="ghost" onClick={onClose} aria-label="Fermer">✕</Button></div>
        <p className="st-legend">Depuis l'instant affiché, avec le cadrage, le zoom et les calques actuels du radar.</p>
        <label className="pref-row pref-num"><span>Nom du fichier</span><input className="rf-select" value={file} onChange={(e) => setFile(e.target.value)} onKeyDown={(e) => e.stopPropagation()} aria-label="Nom du fichier" /></label>
        <div className="ctx-field"><span className="ctx-label">Durée</span><div className="map-pills">{DURATIONS.map((d) => <button key={d} type="button" className={`pill ${duration === d ? "on" : ""}`} onClick={() => setDuration(d)}>{d} s</button>)}</div></div>
        <div className="ctx-field"><span className="ctx-label">Images par seconde</span><div className="map-pills">{FPS.map((f) => <button key={f} type="button" className={`pill ${fps === f ? "on" : ""}`} onClick={() => setFps(f)}>{f}</button>)}</div></div>
        <div className="ctx-field"><span className="ctx-label">Largeur</span><div className="map-pills">{WIDTHS.map((w) => <button key={w} type="button" className={`pill ${width === w ? "on" : ""}`} onClick={() => setWidth(w)}>{w} px</button>)}</div></div>
        {progress !== null && <div className="gif-progress" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}><i style={{ transform: `scaleX(${progress})` }} /></div>}
        {error && <p className="cm-empty">{error}</p>}
        <div className="sc-dialog-foot">
          {done
            ? <a className="btn btn-primary" href={done.url} download={`${safe}.gif`} data-testid="gif-download"><Icon name="download" />Télécharger ({Math.round(done.size / 1024)} Ko)</a>
            : <Button variant="primary" onClick={() => void record()} disabled={progress !== null} data-testid="gif-record"><Icon name="live" />{progress === null ? "Enregistrer" : `${Math.round(progress * 100)} %`}</Button>}
          <Button variant="ghost" onClick={onClose}>Fermer</Button>
        </div>
      </div>
    </div>
  );
}
