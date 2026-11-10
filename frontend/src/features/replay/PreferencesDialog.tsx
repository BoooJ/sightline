import { Button } from "../../shared/ui/Button";
import { keyLabel, useShortcuts } from "./shortcuts";
import { DEFAULT_OPTIONS, useReplayStore } from "./store";
import type { DrawOptions } from "./renderer/draw";

type BoolKey = { [K in keyof DrawOptions]-?: DrawOptions[K] extends boolean | undefined ? K : never }[keyof DrawOptions];
type NumKey = { [K in keyof DrawOptions]-?: DrawOptions[K] extends number | undefined ? K : never }[keyof DrawOptions];

const GROUPS: { title: string; bools?: { key: BoolKey; label: string; hint?: string; action?: string }[]; nums?: { key: NumKey; label: string; min: number; max: number; step: number; unit?: string }[] }[] = [
  { title: "Joueurs", bools: [
    { key: "names", label: "Noms des joueurs", action: "toggleNames" },
    { key: "enemies", label: "Afficher les adversaires", hint: "le camp « à nous » est celui du joueur suivi ou sélectionné" },
    { key: "solidTeammates", label: "Coéquipiers pleins, adversaires cerclés" },
    { key: "spawns", label: "Marqueurs de spawn" },
    { key: "trails", label: "Traces de déplacement", action: "toggleTrails" },
  ], nums: [
    { key: "dotScale", label: "Taille des pastilles", min: 0.7, max: 1.6, step: 0.1, unit: "×" },
    { key: "nameSize", label: "Taille des noms", min: 0.7, max: 1.6, step: 0.1, unit: "×" },
  ] },
  { title: "Événements", bools: [
    { key: "shots", label: "Tirs" }, { key: "flashes", label: "Flashs (traits vers les aveuglés)" }, { key: "nadePaths", label: "Trajectoires des grenades" },
    { key: "deaths", label: "Croix des morts" }, { key: "killfeed", label: "Fil des kills" },
  ] },
  { title: "Analyse", bools: [
    { key: "bombsite", label: "Overlay d'attaque de site", hint: "anneaux A / B, T à proximité, site attaqué, tempo", action: "toggleBombsite" },
    { key: "sequencer", label: "Séquence des tactiques du round", hint: "tactiques du playbook détectées dans ce round, en bas du radar" },
  ] },
  { title: "Lecture et radar", bools: [{ key: "freeze", label: "Inclure le freeze time dans la lecture" }], nums: [
    { key: "radarOpacity", label: "Opacité du radar", min: 0.2, max: 1, step: 0.05 },
    { key: "zoomSens", label: "Sensibilité du zoom (molette)", min: 0.5, max: 3, step: 0.25, unit: "×" },
  ] },
];

/** Préférences du replayer, toutes nommées et persistées (comme les « Replayer Preferences » d'EDGE). */
export function PreferencesDialog({ onClose }: { onClose: () => void }) {
  const o = useReplayStore((s) => s.options);
  const setOption = useReplayStore((s) => s.setOption);
  const reset = useReplayStore((s) => s.resetOptions);
  const keys = useShortcuts((st) => st.keys);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog panel sc-dialog pref-dialog" role="dialog" aria-label="Préférences du replayer" data-testid="prefs-dialog">
        <div className="sc-dialog-head"><h2 className="display">Préférences du replayer</h2>
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="Fermer">✕</Button></div>
        <p className="st-legend">Mémorisées sur cet ordinateur et appliquées à tous les replays.</p>
        {GROUPS.map((g) => (
          <section key={g.title} className="pref-group">
            <h3 className="section-title">{g.title}</h3>
            {g.bools?.map((b) => (
              <label key={b.key} className="pref-row" title={b.hint}>
                <input type="checkbox" checked={o[b.key] !== false} onChange={(e) => setOption(b.key, e.target.checked)} data-testid={`pref-${b.key}`} />
                <span>{b.label}{b.hint && <small className="rf-dim"> · {b.hint}</small>}</span>
                {b.action && keys[b.action] && <kbd className="kbd pref-kbd">{keyLabel(keys[b.action])}</kbd>}
              </label>
            ))}
            {g.nums?.map((n) => (
              <label key={n.key} className="pref-row pref-num">
                <span>{n.label}</span>
                <input type="range" min={n.min} max={n.max} step={n.step} value={o[n.key] ?? DEFAULT_OPTIONS[n.key]} onChange={(e) => setOption(n.key, Number(e.target.value))} aria-label={n.label} />
                <b className="mono">{(o[n.key] ?? DEFAULT_OPTIONS[n.key]).toFixed(2).replace(/\.?0+$/, "")}{n.unit ?? ""}</b>
              </label>
            ))}
          </section>
        ))}
        <div className="sc-dialog-foot"><Button variant="ghost" onClick={reset}>Rétablir les valeurs par défaut</Button><Button variant="primary" onClick={onClose}>Terminé</Button></div>
      </div>
    </div>
  );
}
