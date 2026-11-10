import { useState } from "react";
import { keyLabel, useShortcuts } from "../shortcuts";
import { DRAW_COLORS, useReplayStore, type Tool } from "../store";

const TOOLS: { tool: Exclude<Tool, null>; label: string; key: string; path: string }[] = [
  { tool: "move", label: "Déplacer un dessin", key: "V", path: "M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3" },
  { tool: "pen", label: "Crayon", key: "D", path: "M4 20l4-1 11-11-3-3L5 16l-1 4zM14 6l3 3" },
  { tool: "arrow", label: "Flèche", key: "A", path: "M5 19L19 5M19 5h-7M19 5v7" },
  { tool: "line", label: "Ligne", key: "L", path: "M5 19L19 5" },
  { tool: "circle", label: "Cercle", key: "C", path: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z" },
  { tool: "rect", label: "Rectangle", key: "R", path: "M5 6h14v12H5z" },
  { tool: "text", label: "Texte", key: "T", path: "M6 6h12M12 6v13" },
  { tool: "eraser", label: "Gomme", key: "E", path: "M8 20h10M5 15l8-8 6 6-5 5H9z" },
  { tool: "players", label: "Déplacer les joueurs (et si…)", key: "M", path: "M12 7a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8 21v-6l-2-5h12l-2 5v6M3 12l2-2M21 12l-2-2" },
];

/** Barre d'outils de dessin, posée sur le radar (comme l'outil de dessin du replayer d'EDGE). */
export function DrawToolbar({ count, note, status, onUndo, onClear, onNote }: {
  count: number; note: string; status: string; onUndo: () => void; onClear: () => void; onNote: (n: string) => void;
}) {
  const s = useReplayStore();
  const keys = useShortcuts((st) => st.keys);
  const [noteOpen, setNoteOpen] = useState(false);
  const hideKey = keys["toggleDrawBar"] ? ` (${keyLabel(keys["toggleDrawBar"])})` : "";
  if (!s.drawBar) {
    return (
      <button type="button" className="draw-bar draw-collapsed" onClick={s.toggleDrawBar} title={`Afficher les outils de dessin${hideKey}`}
        aria-label="Afficher les outils de dessin" data-testid="draw-show">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20l4-1 11-11-3-3L5 16l-1 4zM14 6l3 3" /></svg>
        {count > 0 && <span className="rp-tool-count">{count}</span>}
      </button>
    );
  }
  return (
    <div className="draw-bar" role="toolbar" aria-label="Dessin" data-testid="draw-toolbar">
      <button type="button" className="draw-btn draw-hide" onClick={s.toggleDrawBar} title={`Masquer la barre de dessin${hideKey}`} aria-label="Masquer la barre de dessin" data-testid="draw-hide">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M15 6l-6 6 6 6" /></svg>
      </button>
      {TOOLS.map((t) => (
        <button key={t.tool} type="button" className={`draw-btn ${s.tool === t.tool ? "on" : ""}`} title={keys[`tool:${t.tool}`] ? `${t.label} (${keyLabel(keys[`tool:${t.tool}`])})` : t.label} aria-label={t.label}
          aria-pressed={s.tool === t.tool} onClick={() => s.setTool(t.tool)}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={t.path} /></svg>
        </button>
      ))}
      <span className="draw-sep" />
      {DRAW_COLORS.map((c) => (
        <button key={c} type="button" className={`draw-color ${s.color === c ? "on" : ""}`} style={{ background: c }} aria-label={`Couleur ${c}`} onClick={() => s.setColor(c)} />
      ))}
      <span className="draw-sep" />
      {[2, 3, 5].map((w) => (
        <button key={w} type="button" className={`draw-btn ${s.width === w ? "on" : ""}`} aria-label={`Épaisseur ${w}`} title={`Épaisseur ${w}`} onClick={() => s.setWidth(w)}>
          <i className="draw-w" style={{ height: w + 1 }} />
        </button>
      ))}
      <span className="draw-sep" />
      <button type="button" className={`draw-btn draw-timed ${s.timed ? "on" : ""}`} aria-pressed={s.timed} onClick={() => s.setTimed(!s.timed)}
        title="Lier les nouveaux dessins à l'instant courant (visibles 5 s) au lieu de tout le round">5 s</button>
      <button type="button" className="draw-btn" onClick={onUndo} title="Annuler (Ctrl+Z)" aria-label="Annuler" disabled={!count}>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3" /></svg>
      </button>
      <button type="button" className="draw-btn" onClick={onClear} title="Tout effacer" aria-label="Tout effacer" disabled={!count}>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></svg>
      </button>
      <span className="draw-sep" />
      <button type="button" className={`draw-btn draw-note ${noteOpen || note ? "on" : ""}`} onClick={() => setNoteOpen(!noteOpen)} title="Note du round" aria-label="Note du round">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M5 4h10l4 4v12H5zM9 12h6M9 16h4" /></svg>
      </button>
      <span className={`draw-status ${status}`}>{status === "saving" ? "…" : status === "saved" ? "✓" : status === "error" ? "!" : ""}</span>
      {noteOpen && (
        <textarea className="draw-notearea" autoFocus placeholder="Note sur ce round (enregistrée automatiquement)…" value={note}
          onChange={(e) => onNote(e.target.value)} onKeyDown={(e) => e.stopPropagation()} data-testid="round-note" />
      )}
    </div>
  );
}
