import type { MapMeta } from "../../shared/api/types";
import { Button } from "../../shared/ui/Button";
import { Icon } from "../../shared/ui/Icon";
import { useState } from "react";
import { PreferencesDialog } from "./PreferencesDialog";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { toggleFullscreen } from "./fullscreen";
import { SPEEDS, useReplayStore } from "./store";

export function Controls({ map, tickrate, sampleTicks }: { map: MapMeta; tickrate: number; sampleTicks: number }) {
  const s = useReplayStore();
  const [keysOpen, setKeysOpen] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  return (
    <div className="controls">
      <Button variant="ghost" title="−5 s (←)" onClick={() => s.seekBy(-5, tickrate)}><Icon name="prev" /></Button>
      <Button variant="primary" title="Lecture/pause (Espace)" onClick={s.togglePlay} data-testid="play">
        <Icon name={s.playing ? "pause" : "play"} />
      </Button>
      <Button variant="ghost" title="+5 s (→)" onClick={() => s.seekBy(5, tickrate)}><Icon name="next" /></Button>
      {!s.playerMode && <>
        <Button size="sm" variant="ghost" title="Échantillon précédent (,)" onClick={() => { s.setPlaying(false); s.setTick(s.tick - sampleTicks); }}>‹</Button>
        <Button size="sm" variant="ghost" title="Échantillon suivant (.)" onClick={() => { s.setPlaying(false); s.setTick(s.tick + sampleTicks); }}>›</Button>
      </>}
      <div className="speeds">
        {SPEEDS.map((v) => <button key={v} type="button" className={v === s.speed ? "on" : ""} onClick={() => s.setSpeed(v)}>{v}×</button>)}
      </div>
      <span className="ctrl-sep" />
      {map.levels.length > 1 && (
        <div className="levels">
          <Icon name="layers" />
          {map.levels.map((l) => (
            <button key={l.name} type="button" className={!s.splitLevels && s.level === l.name ? "on" : ""}
              onClick={() => { if (s.splitLevels) s.toggleSplit(); s.setLevel(l.name); }}>{l.name === "upper" ? "Haut" : l.name === "lower" ? "Bas" : l.name}</button>
          ))}
          <button type="button" className={s.splitLevels ? "on" : ""} onClick={s.toggleSplit}>Côte à côte</button>
        </div>
      )}
      <div className="toggles">
        <label><input type="checkbox" checked={s.options.names} onChange={(e) => s.setOption("names", e.target.checked)} />Noms</label>
        {!s.playerMode && <label><input type="checkbox" checked={s.options.trails} onChange={(e) => s.setOption("trails", e.target.checked)} />Traces</label>}
        {!s.playerMode && <>
          <label><input type="checkbox" checked={s.options.shots} onChange={(e) => s.setOption("shots", e.target.checked)} />Tirs</label>
          <label title="Traits des flashs vers les joueurs aveuglés, avec la durée"><input type="checkbox" checked={s.options.flashes !== false} onChange={(e) => s.setOption("flashes", e.target.checked)} />Flashs</label>
        </>}
        <label title="Trajectoire de chaque grenade, du lancer jusqu'à la fin de son effet"><input type="checkbox" checked={s.options.nadePaths !== false} onChange={(e) => s.setOption("nadePaths", e.target.checked)} data-testid="opt-nade-paths" />Trajectoires</label>
        <label title="Croix sur les lieux de mort du round"><input type="checkbox" checked={s.options.deaths !== false} onChange={(e) => s.setOption("deaths", e.target.checked)} />Morts</label>
        {!s.playerMode && <>
          <label className="ctrl-scale" title="Taille des pastilles et des noms">Taille
            <input type="range" min={0.7} max={1.6} step={0.1} value={s.options.dotScale ?? 1} onChange={(e) => s.setOption("dotScale", Number(e.target.value))} aria-label="Taille des pastilles" /></label>
          <label>Radar<input type="range" min={0.2} max={1} step={0.05} value={s.options.radarOpacity}
            onChange={(e) => s.setOption("radarOpacity", Number(e.target.value))} /></label>
        </>}
      </div>
      <Button size="sm" variant="ghost" title="Plein écran (F)" aria-label="Plein écran" onClick={toggleFullscreen} data-testid="fullscreen"><Icon name="fullscreen" /></Button>
      <Button size="sm" variant="ghost" title="Raccourcis clavier" aria-label="Raccourcis clavier" onClick={() => setKeysOpen(true)} data-testid="shortcuts-open"><Icon name="keyboard" /></Button>
      <Button size="sm" variant="ghost" title="Préférences du replayer" aria-label="Préférences du replayer" onClick={() => setPrefsOpen(true)} data-testid="prefs-open"><Icon name="settings" /></Button>
      {keysOpen && <ShortcutsDialog onClose={() => setKeysOpen(false)} />}
      {prefsOpen && <PreferencesDialog onClose={() => setPrefsOpen(false)} />}
    </div>
  );
}
