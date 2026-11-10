import type { Replay } from "../replay/engine/replay";

/** Voile blanc d'un aveuglement en vue du joueur (comportement observé sur une démo d'exemple et vérifié à l'écran) :
 *  opacité maximale 0,92, réduite pour un aveuglement de moins de 2,5 s (durée / 2,5 du
 *  maximum) ; palier jusqu'à `durée − 2 s`, puis fondu linéaire sur les 2 dernières secondes (toute la durée s'il est plus
 *  court) ; plus rien dès que la durée est écoulée. Plusieurs aveuglements en même temps : le plus fort l'emporte. */
export const FLASH_MAX = 0.92, FLASH_FULL_S = 2.5, FLASH_FADE_S = 2;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Opacité du voile (0 à 1) `elapsed` secondes après le début d'un aveuglement de `dur` secondes. */
export function flashOpacity(dur: number, elapsed: number): number {
  if (!(dur > 0) || !(elapsed >= 0) || elapsed >= dur) return 0;
  const hold = Math.max(0, dur - FLASH_FADE_S), fade = Math.max(0.001, dur - hold);
  const level = elapsed <= hold ? 1 : clamp01(1 - (elapsed - hold) / fade);
  return FLASH_MAX * clamp01(dur / FLASH_FULL_S) * level;
}

/** Un aveuglement : tick de l'image où il commence, durée en secondes. */
export interface Blind { tick: number; dur: number }

/** Écart minimal entre deux valeurs du champ pour y voir un nouvel aveuglement (bruit de flottant). */
const SAME = 1e-3;
const cache = new WeakMap<Replay, Blind[][]>();

/** Aveuglements de chaque joueur du replay (indexés par `ReplayPlayer.index`), par ordre de tick.
 *
 *  Le champ « flash » des images n'est PAS le temps restant : c'est la durée de l'aveuglement (flash_duration), constante
 *  pendant environ 1,4 fois cette durée (mesuré sur Nuke : 45 aveuglements, rapport 1,40 à 1,43), puis 0. On ne peut donc
 *  pas en tirer l'opacité à un instant : on repère le début de chaque aveuglement, à l'image où la valeur apparaît ou
 *  change, et c'est la durée lue à ce moment qui compte (`flashOpacity`). Un second flash pendant le premier fait changer
 *  la valeur (plus grande ou plus petite) : nouvel aveuglement, le plus fort des deux l'emporte (`veilOpacity`).
 *  Calculé une fois par replay, à la première demande. */
export function blindsOf(r: Replay): Blind[][] {
  let out = cache.get(r);
  if (out) return out;
  out = r.players.map(() => []);
  if (r.has("flash")) {
    for (const p of r.players) {
      const list: Blind[] = [];
      let prev = 0;
      for (let i = 0; i < r.n; i++) {
        const v = r.value("flash", i, p.index);
        if (v > 0 && Math.abs(v - prev) > SAME) list.push({ tick: r.ticks[i], dur: v });
        prev = v > 0 ? v : 0;
      }
      out[p.index] = list;
    }
  }
  cache.set(r, out);
  return out;
}

/** Opacité du voile blanc du joueur d'indice `j` (`ReplayPlayer.index`) au tick `tick` ; 0 sans aveuglement en cours. */
export function veilOpacity(r: Replay, j: number, tick: number): number {
  let o = 0;
  for (const b of blindsOf(r)[j] ?? []) {
    if (b.tick > tick) break;
    o = Math.max(o, flashOpacity(b.dur, (tick - b.tick) / r.tickrate));
  }
  return o;
}

/** Écriture du voile sans rendu React. `set` (branché sur `Viewer.onFlash`) garde la dernière opacité et l'écrit sur le
 *  voile s'il est affiché ; `ref` (ref stable du voile, `PovLayer`) l'écrit dès qu'il apparaît : la vue 3D peut changer
 *  l'opacité avant que React n'affiche le calque (entrée en vue du joueur pendant un aveuglement). La variable CSS
 *  `--r3-flash` n'est posée que sur le voile : un fondu ne restyle rien d'autre (HUD, lunette, petit radar). */
export function veilWriter(): { ref: (el: HTMLElement | null) => void; set: (opacity: number) => void } {
  let el: HTMLElement | null = null, last = 0;
  const write = () => { el?.style.setProperty("--r3-flash", String(last)); };
  return {
    ref: (e) => { el = e; write(); },
    set: (o) => { last = o; write(); },
  };
}
