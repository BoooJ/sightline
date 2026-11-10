import { create } from "zustand";
import type { DrawTool } from "../../shared/api/types";
import type { DrawOptions } from "./renderer/draw";

export type Tool = DrawTool | "eraser" | "move" | "players" | null;
export const DRAW_COLORS = ["#2ee6a6", "#ffffff", "#ffd23f", "#ff4d5e", "#5b9dff", "#1aa67c"];

export const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];
const PREFS = "replay-prefs";
/** Préférences du replayer (toutes nommées, persistées : comme les « Replayer Preferences » d'EDGE). */
export const DEFAULT_OPTIONS: Required<DrawOptions> = {
  trails: false, names: true, shots: true, radarOpacity: 0.9, flashes: true, deaths: true, dotScale: 1, nadePaths: true,
  nameSize: 1, enemies: true, solidTeammates: false, spawns: false, zoomSens: 1, freeze: true, bombsite: false, sequencer: true, killfeed: true,
};
const loadOptions = (): Required<DrawOptions> => {
  try { return { ...DEFAULT_OPTIONS, ...JSON.parse(localStorage.getItem(PREFS) ?? "{}") }; } catch { return { ...DEFAULT_OPTIONS }; }
};
const saveOptions = (o: DrawOptions) => { try { localStorage.setItem(PREFS, JSON.stringify(o)); } catch { /* stockage indisponible */ } };

interface S {
  tick: number; playing: boolean; speed: number; level: string; splitLevels: boolean; options: Required<DrawOptions>; selected: string | null;
  setTick: (t: number) => void; togglePlay: () => void; setPlaying: (p: boolean) => void; setSpeed: (s: number) => void;
  seekBy: (seconds: number, tickrate: number) => void; setLevel: (l: string) => void; toggleSplit: () => void;
  setOption: <K extends keyof DrawOptions>(k: K, v: DrawOptions[K]) => void; resetOptions: () => void; select: (sid: string | null) => void;
  tool: Tool; color: string; width: number; timed: boolean; drawBar: boolean; toggleDrawBar: () => void;
  setTool: (t: Tool) => void; setColor: (c: string) => void; setWidth: (w: number) => void; setTimed: (t: boolean) => void;
  /** mode joueur : barre d'outils réduite (lecture, rounds, morts, commentaires) ; mode analyste : tout */
  playerMode: boolean; togglePlayerMode: () => void;
  /** mode déplacement (M) : positions « et si » des joueurs, par steamid, en coordonnées du jeu ; vidé au changement de round */
  overrides: Record<string, [number, number]>; movePlayer: (sid: string, p: [number, number]) => void; clearOverrides: () => void;
}
export const useReplayStore = create<S>((set) => ({
  tick: 0, playing: false, speed: 1, level: "", splitLevels: false, selected: null,
  options: loadOptions(),
  setTick: (tick) => set({ tick }),
  togglePlay: () => set((s) => ({ playing: !s.playing })),
  setPlaying: (playing) => set({ playing }),
  setSpeed: (speed) => set({ speed }),
  seekBy: (seconds, tickrate) => set((s) => ({ tick: s.tick + seconds * tickrate })),
  setLevel: (level) => set({ level }),
  toggleSplit: () => set((s) => ({ splitLevels: !s.splitLevels })),
  setOption: (k, v) => set((s) => { const options = { ...s.options, [k]: v }; saveOptions(options); return { options }; }),
  resetOptions: () => { saveOptions(DEFAULT_OPTIONS); set({ options: { ...DEFAULT_OPTIONS } }); },
  select: (selected) => set({ selected }),
  tool: null, color: DRAW_COLORS[0], width: 3, timed: false,
  // barre de dessin affichée ou repliée (mémorisé ; repliée par défaut sur téléphone)
  drawBar: (() => { try { const v = localStorage.getItem("draw-bar"); return v === "1"; } catch { return false; } })(),  // repliée par défaut : le radar d'abord
  toggleDrawBar: () => set((s) => {
    const drawBar = !s.drawBar;
    try { localStorage.setItem("draw-bar", drawBar ? "1" : "0"); } catch { /* stockage indisponible */ }
    return { drawBar, tool: drawBar ? s.tool : null };
  }),
  setTool: (tool) => set((s) => ({ tool: s.tool === tool ? null : tool, playing: tool ? false : s.playing })),
  setColor: (color) => set({ color }), setWidth: (width) => set({ width }), setTimed: (timed) => set({ timed }),
  playerMode: (() => { try { return localStorage.getItem("replay-mode") === "player"; } catch { return false; } })(),
  togglePlayerMode: () => set((s) => {
    const playerMode = !s.playerMode;
    try { localStorage.setItem("replay-mode", playerMode ? "player" : "analyst"); } catch { /* stockage indisponible */ }
    return { playerMode, drawBar: playerMode ? false : s.drawBar, tool: playerMode ? null : s.tool };
  }),
  overrides: {},
  movePlayer: (sid, p) => set((s) => ({ overrides: { ...s.overrides, [sid]: p } })),
  clearOverrides: () => set({ overrides: {} }),
}));
