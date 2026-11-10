import type { KillEvent, Vec3 } from "../../shared/api/types";
import type { Replay } from "../replay/engine/replay";
import type { PlayerState } from "../replay/engine/state";
import { isSniper } from "../replay/hud";
import { extent, eyeZ } from "./world";

export const TV_AHEAD_S = 5, TV_HOLD_S = 3, FREE_SPEED = 600;
export interface TvShot { sid: string | null; since: number }
export interface FreePose { pos: Vec3; yaw: number; pitch: number }
export interface MoveKeys { fwd: boolean; back: boolean; left: boolean; right: boolean; up: boolean; down: boolean }

const rad = (deg: number) => (deg * Math.PI) / 180;

/** Vecteur de visée (degrés ; tangage positif vers le haut). */
export const dirOf = (yaw: number, pitch: number): Vec3 =>
  [Math.cos(rad(pitch)) * Math.cos(rad(yaw)), Math.cos(rad(pitch)) * Math.sin(rad(yaw)), Math.sin(rad(pitch))];

/** Caméra libre : un pas de déplacement (600 unités/s, ×3 avec Maj). */
export function freeStep(p: FreePose, k: MoveKeys, dt: number, fast: boolean): FreePose {
  const f = dirOf(p.yaw, p.pitch), r: Vec3 = [Math.sin(rad(p.yaw)), -Math.cos(rad(p.yaw)), 0];
  const v = FREE_SPEED * (fast ? 3 : 1) * dt;
  const ax = Number(k.fwd) - Number(k.back), ay = Number(k.right) - Number(k.left), az = Number(k.up) - Number(k.down);
  return { ...p, pos: [p.pos[0] + v * (f[0] * ax + r[0] * ay), p.pos[1] + v * (f[1] * ax + r[1] * ay), p.pos[2] + v * (f[2] * ax + az)] };
}

/** Recul de la caméra au tir (`Replay.punchAt`) : [vertical, horizontal] en degrés, dans la convention de `pitch` (négatif =
 *  vers le haut) et de `yaw` ; aucun recul : [0, 0]. */
export type Punch = readonly [number, number];
export const NO_PUNCH: Punch = [0, 0];

/** Borne du regard vertical de la vue du joueur (degrés) : regard + recul ne passe jamais la verticale (au-delà, la vue
 *  se retournerait le temps de la rafale). */
export const POV_PITCH_MAX = 89.9;

/** Vue du joueur : à hauteur d'yeux selon l'accroupissement, regard exact + recul de la caméra (`punch`, ajouté tel quel aux
 *  angles du joueur : un tir d'AK-47 a un vertical négatif, la vue monte), borné à ±`POV_PITCH_MAX`.
 *  L'angle vertical de CS2 est positif vers le BAS, `dirOf` le veut positif vers le haut ; 0 reste 0 (−0 donnerait une
 *  composante verticale de −0). */
export const povPose = (p: PlayerState, punch: Punch = NO_PUNCH): { eye: Vec3; dir: Vec3 } => {
  const pitch = Math.min(POV_PITCH_MAX, Math.max(-POV_PITCH_MAX, p.pitch + punch[0]));
  return { eye: [p.x, p.y, p.z + eyeZ(p.duck)], dir: dirOf(p.yaw + punch[1], pitch ? -pitch : 0) };
};

/** Joueur à suivre (suivi, vue du joueur, TV) : le choisi `sid` s'il vit ; s'il est mort, un coéquipier vivant (même camp,
 *  pour ne pas sauter dans les yeux d'un adversaire) ; sinon, ou sans choix, le premier vivant. */
export function followTarget(players: readonly PlayerState[], sid: string | null): PlayerState | undefined {
  const chosen = sid === null ? undefined : players.find((x) => x.steamid === sid);
  if (chosen?.alive) return chosen;
  return (chosen && players.find((x) => x.alive && x.side === chosen.side)) || players.find((x) => x.alive);
}

/** CS2 donne son champ de vision en largeur sur un écran 4:3 (un écran plus large voit plus loin sur les côtés, pas plus
 *  haut) ; three.js veut l'angle vertical. Degrés. */
export const vfovFrom43 = (hfov: number) => (2 * Math.atan(Math.tan((hfov * Math.PI) / 360) * 0.75) * 180) / Math.PI;
/** `default_fov` 90 (client.dll, build 2000935), en largeur sur un écran 4:3. */
export const POV_HFOV = 90;
/** Le même en vertical, ≈ 73,74° : celui de la vue du joueur quand la vue 3D a la forme de la fenêtre. */
export const POV_FOV = vfovFrom43(POV_HFOV);

/** Angle vertical de la caméra de la vue du joueur pour un FOV de CS2 `hfov` (largeur sur 4:3, degrés). Le
 *  champ de vision horizontal est celui que CS2 aurait en plein écran sur un écran de la forme de la FENÊTRE, même quand
 *  la vue 3D est plus petite (panneaux ouverts) : vertical = 2·atan(tan(V/2) · aspect fenêtre / aspect vue), V étant
 *  `vfovFrom43(hfov)`. Vue de la forme de la fenêtre : V, sans changement. Une forme inconnue ou nulle (vue pas encore
 *  mesurée) ne corrige rien. */
export function povVfov(hfov: number, windowAspect: number, viewAspect: number): number {
  const v = vfovFrom43(hfov);
  if (!(windowAspect > 0 && viewAspect > 0)) return v;
  return (2 * Math.atan(Math.tan((v * Math.PI) / 360) * (windowAspect / viewAspect)) * 180) / Math.PI;
}
/** Lunettes (scripts/weapons.vdata, `m_nZoomFOV1` / `m_nZoomFOV2`) : nom de l'arme dans les images → FOV des zooms 1 et 2. */
export const SCOPES: Record<string, [number, number | null]> = {
  AWP: [40, 10], "SSG 08": [40, 15], "SCAR-20": [40, 15], G3SG1: [40, 15], AUG: [45, null], "SG 553": [45, null],
};
/** Famille de lunette : les snipers (`isSniper`) cachent l'arme et noircissent l'écran (`m_bHideViewModelWhenZoomed`) ;
 *  AUG et SG 553 : viseur. */
export type ScopeKind = "sniper" | "sight";

/** FOV de la lunette du joueur qui vise (même unité que `default_fov`), sinon null. `zoom` : niveau 1 ou 2 (zoom_lvl) ;
 *  0 (replay sans ce champ) : niveau 1. */
export function scopeFov(weapon: string, zoom: number, scoped: boolean): number | null {
  const s = SCOPES[weapon];
  if (!scoped || !s) return null;
  return zoom >= 2 && s[1] !== null ? s[1] : s[0];
}

/** FOV de CS2 de la vue du joueur (même unité que `default_fov`) : celui de la démo (`fov`, déjà interpolé par le moteur ;
 *  0 pour un replay qui n'en a pas), sinon la lunette de l'arme visée, sinon 90. Une valeur hors de ]0 ; 180[ (octet
 *  illisible : la caméra se retournerait) compte pour absente. */
export const povFov = (p: Pick<PlayerState, "fov" | "weapon" | "zoom" | "scoped">): number =>
  p.fov > 0 && p.fov < 180 ? p.fov : scopeFov(p.weapon, p.zoom, p.scoped) ?? POV_HFOV;

/** Lunette à dessiner par-dessus la vue (snipers, AUG, SG 553 : le même dessin), ou rien ; la valeur dit
 *  seulement de quelle famille d'arme il s'agit. */
export const scopeKind = (weapon: string, scoped: boolean): ScopeKind | null =>
  scoped && SCOPES[weapon] ? (isSniper(weapon) ? "sniper" : "sight") : null;

/** Suivi : orbite autour du buste du joueur. */
export function followPose(p: PlayerState, yaw: number, pitch: number, dist: number): { pos: Vec3; look: Vec3 } {
  const look: Vec3 = [p.x, p.y, p.z + 48];
  const d = dirOf(yaw, pitch);
  return { look, pos: [look[0] + dist * d[0], look[1] + dist * d[1], look[2] + dist * d[2]] };
}

/** Ce qu'on ôte de la carte pour voir les joueurs (Nuke : murs et plafonds partout) : un cylindre entre `from` et `to`
 *  mais seulement au-dessus de `floorZ` (rayon nul : pas de cylindre), et ce qui dépasse `aboveZ`. Les joueurs restent
 *  entiers ; grenades, croix de mort et bombe suivent `aboveZ` (vue de dessus), pas le cylindre. */
export interface Cutaway { from: Vec3; to: Vec3; radius: number; floorZ: number; aboveZ: number }
export const CUT_RADIUS = 64, CUT_KEEP = 100, CUT_ABOVE = 120, CUT_FLOOR = 24, JUMP_S = 0.8;
export const NO_CUT: Cutaway = { from: [0, 0, 0], to: [0, 0, 0], radius: 0, floorZ: -Infinity, aboveZ: Infinity };

/** Suivi et TV : percée de la caméra vers le buste suivi, arrêtée à 100 unités de lui ; rien n'est percé sous ses pieds
 *  (+ 24 : marches, pentes), même en caméra rasante. */
export function orbitCut(pos: Vec3, look: Vec3, feetZ: number): Cutaway {
  const d: Vec3 = [look[0] - pos[0], look[1] - pos[1], look[2] - pos[2]], len = Math.hypot(...d);
  if (len <= CUT_KEEP) return NO_CUT;
  const k = (len - CUT_KEEP) / len;
  return { ...NO_CUT, from: pos, to: [pos[0] + d[0] * k, pos[1] + d[1] * k, pos[2] + d[2] * k], radius: CUT_RADIUS,
    floorZ: feetZ + CUT_FLOOR };
}

/** Hauteur au sol : la plus basse des positions des 0,8 dernières secondes (`history(k)`, joueur k), car un saut dure
 *  moins ; la vue de dessus ne doit pas faire clignoter les plafonds à chaque saut. */
export function grounded(players: PlayerState[], history: (k: number) => number[]): PlayerState[] {
  return players.map((p, k) => {
    const z = Math.min(p.z, ...history(k));
    return z === p.z ? p : { ...p, z };
  });
}

/** Vue de dessus : toits ôtés, 120 unités au-dessus du joueur choisi, sinon de la hauteur médiane des vivants (un joueur
 *  perché, « heaven » sur Nuke, ne doit pas laisser les toits). */
export function topCut(players: PlayerState[], selected: string | null): Cutaway {
  const alive = players.filter((p) => p.alive), sel = alive.find((p) => p.steamid === selected);
  const zs = alive.map((p) => p.z).sort((a, b) => a - b);
  const z = sel ? sel.z : zs.length ? zs[Math.floor(zs.length / 2)] : Infinity;
  return { ...NO_CUT, aboveZ: z + CUT_ABOVE };
}

/** Caméra TV : le tueur du prochain kill s'il survient dans les 5 s, sinon le joueur choisi, sinon le vivant le plus
 *  proche de la bombe ; un plan dure au moins 3 s (sauf si son joueur meurt ou si l'on recule dans le temps). */
export function tvTarget(kills: KillEvent[], players: PlayerState[], bomb: Vec3 | null, tick: number, tickrate: number,
                         selected: string | null, current: TvShot): TvShot {
  const alive = new Set(players.filter((p) => p.alive).map((p) => p.steamid));
  if (current.sid && alive.has(current.sid) && tick >= current.since && tick - current.since < TV_HOLD_S * tickrate) return current;
  const next = kills.find((k) => k.tick >= tick && k.tick - tick <= TV_AHEAD_S * tickrate && k.attacker && alive.has(k.attacker));
  let sid: string | null = next?.attacker ?? (selected && alive.has(selected) ? selected : null);
  if (!sid && bomb) {
    let best = Infinity;
    for (const p of players) {
      const d = (p.x - bomb[0]) ** 2 + (p.y - bomb[1]) ** 2 + (p.z - bomb[2]) ** 2;
      if (p.alive && d < best) { best = d; sid = p.steamid; }
    }
  }
  sid ??= players.find((p) => p.alive)?.steamid ?? null;
  return sid === current.sid ? current : { sid, since: tick };
}

/** Zone jouable : positions des vivants (un instant sur 8), élargies de 1 500 unités autour et 400 en hauteur. Seulement
 *  avec un replay de la carte posée : pendant un changement de match, l'ancien round reste affiché le temps du chargement. */
export function playZone(r: Replay | null, map: string): { min: Vec3; max: Vec3 } | null {
  if (!r || r.payload.map_name !== map) return null;
  const pts: Vec3[] = [];
  for (let i = 0; i < r.n; i += 8) for (const p of r.players) {
    if (r.value("flags", i, p.index) & 1) pts.push([r.value("x", i, p.index), r.value("y", i, p.index), r.value("z", i, p.index)]);
  }
  return extent(pts, [1500, 1500, 400]);
}
