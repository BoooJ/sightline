import { useEffect } from "react";
import type { DrawTool } from "../../shared/api/types";
import { useShortcuts } from "./shortcuts";
import { toggleFullscreen } from "./fullscreen";
import { SPEEDS, useReplayStore } from "./store";

export function useKeyboard(o: { tickrate: number; sampleTicks: number; onNext: () => void; onPrev: () => void; onUndo?: () => void;
  onDeath?: (dir: 1 | -1) => void; onBookmark?: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable) return;
      if (document.querySelector("[data-capturing-shortcut]")) return;  // saisie d'un nouveau raccourci en cours
      const s = useReplayStore.getState();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); o.onUndo?.(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Escape") { if (s.tool) s.setTool(null); return; }
      const action = useShortcuts.getState().actionFor(e.key);
      if (!action) return;
      e.preventDefault();
      const idx = SPEEDS.indexOf(s.speed);
      if (action.startsWith("tool:")) { s.setTool(action.slice(5) as DrawTool | "eraser" | "move" | "players"); return; }
      switch (action) {
        case "play": s.togglePlay(); break;
        case "back5": s.seekBy(-5, o.tickrate); break;
        case "fwd5": s.seekBy(5, o.tickrate); break;
        case "stepBack": s.setPlaying(false); s.setTick(s.tick - o.sampleTicks); break;
        case "stepFwd": s.setPlaying(false); s.setTick(s.tick + o.sampleTicks); break;
        case "speedUp": s.setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, idx + 1)]); break;
        case "speedDown": s.setSpeed(SPEEDS[Math.max(0, idx - 1)]); break;
        case "nextRound": o.onNext(); break;
        case "prevRound": o.onPrev(); break;
        case "bookmark": o.onBookmark?.(); break;
        case "zoomIn": case "zoomOut": case "zoomReset":
          window.dispatchEvent(new CustomEvent("radar-zoom", { detail: action === "zoomIn" ? "in" : action === "zoomOut" ? "out" : "reset" })); break;
        case "nextDeath": o.onDeath?.(1); break;
        case "prevDeath": o.onDeath?.(-1); break;
        case "toggleNames": s.setOption("names", !s.options.names); break;
        case "toggleTrails": s.setOption("trails", !s.options.trails); break;
        case "toggleDrawBar": s.toggleDrawBar(); break;
        case "toggleBombsite": s.setOption("bombsite", !s.options.bombsite); break;
        case "fullscreen": toggleFullscreen(); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [o]);
}
