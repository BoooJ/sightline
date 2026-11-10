import { create } from "zustand";

/** Actions du replay pilotables au clavier, avec leur touche par défaut (modifiable, enregistrée localement). */
export const ACTIONS = [
  { id: "play", label: "Lecture / pause", key: " " },
  { id: "back5", label: "Reculer de 5 s", key: "ArrowLeft" },
  { id: "fwd5", label: "Avancer de 5 s", key: "ArrowRight" },
  { id: "stepBack", label: "Image précédente", key: "," },
  { id: "stepFwd", label: "Image suivante", key: "." },
  { id: "speedUp", label: "Accélérer", key: "ArrowUp" },
  { id: "speedDown", label: "Ralentir", key: "ArrowDown" },
  { id: "nextRound", label: "Round suivant", key: "n" },
  { id: "prevRound", label: "Round précédent", key: "p" },
  { id: "zoomIn", label: "Zoomer le radar", key: "+" },
  { id: "zoomOut", label: "Dézoomer le radar", key: "-" },
  { id: "zoomReset", label: "Recentrer le radar", key: "0" },
  { id: "bookmark", label: "Ajouter un signet à cet instant", key: "s" },
  { id: "nextDeath", label: "Mort suivante du joueur suivi", key: "k" },
  { id: "prevDeath", label: "Mort précédente du joueur suivi", key: "j" },
  { id: "toggleNames", label: "Afficher / masquer les noms", key: "h" },
  { id: "toggleTrails", label: "Afficher / masquer les traces", key: "g" },
  { id: "toggleDrawBar", label: "Afficher / masquer la barre de dessin", key: "b" },
  { id: "toggleBombsite", label: "Overlay d'attaque de site", key: "o" },
  { id: "fullscreen", label: "Plein écran", key: "f" },
  { id: "tool:pen", label: "Crayon", key: "d" },
  { id: "tool:arrow", label: "Flèche", key: "a" },
  { id: "tool:line", label: "Ligne", key: "l" },
  { id: "tool:circle", label: "Cercle", key: "c" },
  { id: "tool:rect", label: "Rectangle", key: "r" },
  { id: "tool:text", label: "Texte", key: "t" },
  { id: "tool:eraser", label: "Gomme", key: "e" },
  { id: "tool:move", label: "Déplacer un dessin", key: "v" },
  { id: "tool:players", label: "Déplacer les joueurs (et si…)", key: "m" },
] as const;
export type ActionId = (typeof ACTIONS)[number]["id"];

const STORAGE = "replay-shortcuts";
const defaults = (): Record<string, string> => Object.fromEntries(ACTIONS.map((a) => [a.id, a.key]));
const loadMap = (): Record<string, string> => {
  try { return { ...defaults(), ...JSON.parse(localStorage.getItem(STORAGE) ?? "{}") }; } catch { return defaults(); }
};
const persist = (m: Record<string, string>) => { try { localStorage.setItem(STORAGE, JSON.stringify(m)); } catch { /* stockage indisponible */ } };

/** Touche normalisée : une lettre en minuscule, sinon le nom de la touche (ArrowLeft, Espace…). */
export const normKey = (k: string) => (k.length === 1 ? k.toLowerCase() : k);
export const keyLabel = (k: string) => ({ " ": "Espace", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓" } as Record<string, string>)[k]
  ?? (k.length === 1 ? k.toUpperCase() : k);

interface S {
  keys: Record<string, string>;
  bind: (action: string, key: string) => void;
  reset: () => void;
  actionFor: (key: string) => string | undefined;
}
export const useShortcuts = create<S>((set, get) => ({
  keys: loadMap(),
  bind: (action, key) => {
    const k = normKey(key);
    const keys = { ...get().keys };
    for (const [a, v] of Object.entries(keys)) if (v === k && a !== action) keys[a] = "";  // une touche = une action
    keys[action] = k;
    persist(keys);
    set({ keys });
  },
  reset: () => { persist(defaults()); set({ keys: defaults() }); },
  actionFor: (key) => {
    const k = normKey(key);
    return Object.entries(get().keys).find(([, v]) => v === k)?.[0];
  },
}));
