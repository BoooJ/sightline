import { useEffect, useState } from "react";
import { Button } from "../../shared/ui/Button";
import { ACTIONS, keyLabel, useShortcuts } from "./shortcuts";

/** Personnalisation des raccourcis clavier du replay (comme les raccourcis personnalisables d'EDGE). */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const { keys, bind, reset } = useShortcuts();
  const [capturing, setCapturing] = useState<string | null>(null);
  useEffect(() => {
    if (!capturing) return;
    const on = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") { setCapturing(null); return; }
      if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
      bind(capturing, e.key);
      setCapturing(null);
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, [capturing, bind]);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog panel sc-dialog" role="dialog" aria-label="Raccourcis clavier" data-testid="shortcuts-dialog" {...(capturing ? { "data-capturing-shortcut": "" } : {})}>
        <div className="sc-dialog-head"><h2 className="display">Raccourcis clavier</h2>
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="Fermer">✕</Button></div>
        <p className="st-legend">Cliquez une touche puis appuyez sur la nouvelle. Échap annule. Ctrl+Z (annuler un dessin) et Échap (quitter l'outil) restent fixes.</p>
        <div className="sc-keys">
          {ACTIONS.map((a) => (
            <div key={a.id} className="sc-key-row" data-testid="shortcut-row">
              <span>{a.label}</span>
              <button type="button" className={`kbd ${capturing === a.id ? "capturing" : ""} ${!keys[a.id] ? "unset" : ""}`} onClick={() => setCapturing(a.id)}
                aria-label={`Modifier le raccourci : ${a.label}`}>{capturing === a.id ? "Appuyez sur une touche…" : keys[a.id] ? keyLabel(keys[a.id]) : "—"}</button>
            </div>
          ))}
        </div>
        <div className="sc-dialog-foot"><Button variant="ghost" onClick={reset}>Rétablir les touches par défaut</Button><Button variant="primary" onClick={onClose}>Terminé</Button></div>
      </div>
    </div>
  );
}
