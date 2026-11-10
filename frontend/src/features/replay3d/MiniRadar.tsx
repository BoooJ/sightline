import { memo, useEffect, useRef, useState } from "react";
import type { MapMeta, Vec3 } from "../../shared/api/types";
import { levelForZ, validLevel } from "../replay/engine/coords";
import type { Replay } from "../replay/engine/replay";
import { playerStateAt } from "../replay/engine/state";
import { drawFrame, type DrawOptions, type View } from "../replay/renderer/draw";
import { readTheme } from "../replay/renderer/theme";

/** Dessins du petit radar par seconde, au plus. À vitesse normale, une pastille y avance d'un à deux pixels entre deux
 *  dessins ; le reste du temps de calcul va à la vue 3D (60 images/s visées sur puce graphique intégrée). */
export const RADAR_HZ = 10;

/** Instant affiché par la page. */
export interface RadarFrame { replay: Replay; tick: number }
/** Ce dont le petit radar a besoin : la carte du radar 2D, l'instant affiché (lu à chaque dessin : pas de rendu React
 *  pour faire avancer le radar) et le nom des lieux (`usePlaceAt`). */
export interface RadarSource {
  map: MapMeta;
  frame: { readonly current: RadarFrame | null };
  placeAt: (pos: Vec3) => string | null;
}

/** Toute la carte, nord en haut, comme le radar du jeu : pas de cadrage sur la zone jouée. */
const WHOLE_MAP: View = { zoom: 1, panX: 0, panY: 0 };
/** Radar 2D allégé : pas de noms, de tirs, de flashs, de croix ni de trajectoires. Pastilles réduites (la carte entière tient
 *  dans un carré d'environ 200 px), à une taille de repères relevée à l'écran. */
const OPTIONS: DrawOptions = { trails: false, names: false, shots: false, radarOpacity: 1, flashes: false, deaths: false,
  dotScale: 0.6, nadePaths: false, enemies: true, solidTeammates: false, spawns: false, bombsite: false };

/** Petit radar de la vue du joueur (en haut à gauche) : le dessin du radar 2D de la page (`drawFrame`), carte entière, à
 *  l'étage du joueur suivi (mis en évidence, avec sa trace des 5 dernières secondes) ; sous lui, le nom de l'endroit où il
 *  se trouve (callouts de l'équipe, sinon lieux du jeu). Redessiné au plus `RADAR_HZ` fois par seconde, et seulement si
 *  l'instant a changé ; le nom de zone ne fait un rendu React que s'il change. */
export const MiniRadar = memo(function MiniRadar({ radar, sid }: { radar: RadarSource; sid: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [zone, setZone] = useState<string | null>(null);
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const { map, frame, placeAt } = radar;
    const theme = readTheme();
    const images: Record<string, HTMLImageElement> = {};
    let drawn: RadarFrame | null = null, size = "";
    const draw = (force = false) => {
      const f = frame.current, w = c.clientWidth, h = c.clientHeight;
      if (!f || !w || !h) return;
      const sz = `${w}x${h}`, resized = sz !== size;
      if (!force && !resized && drawn?.replay === f.replay && drawn.tick === f.tick) return;
      drawn = f;
      size = sz;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      const me = playerStateAt(f.replay, f.tick).find((p) => p.steamid === sid);
      drawFrame(c.getContext("2d")!, { replay: f.replay, map, images, tick: f.tick, view: WHOLE_MAP,
        level: me ? levelForZ(map, me.z) : validLevel(map, null), splitLevels: false, options: OPTIONS, selected: sid, theme,
        dpr, width: w, height: h });
      setZone(me ? placeAt([me.x, me.y, me.z]) : null);
    };
    for (const name of new Set([map.image, ...map.levels.map((l) => l.image)])) {
      const img = new Image();
      img.onload = () => draw(true);
      img.src = `/maps/${name}`;
      images[name] = img;
    }
    draw();
    const timer = setInterval(() => draw(), 1000 / RADAR_HZ);
    return () => {
      clearInterval(timer);
      for (const img of Object.values(images)) img.onload = null;
    };
  }, [radar, sid]);
  return (
    <div className="r3-radar" data-testid="pov-radar">
      <div className="r3-radar-box"><canvas ref={canvas} className="r3-radar-map" role="img" aria-label="Radar" /></div>
      <span className="r3-radar-zone">{zone}</span>
    </div>
  );
});
