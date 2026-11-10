import type { MapMeta, Shape } from "../../../shared/api/types";
import { drawShapes } from "../annotate/shapes";
import { levelForZ, RADAR_SIZE, worldToRadar } from "../engine/coords";
import { sampleIndex } from "../engine/interp";
import type { Replay } from "../engine/replay";
import { activeGrenades, bombStateAt, BOMB_TIME_S, deathsUntil, extinguishedMolotovs, playerStateAt, recentKills, recentShots, smokeBreaks, SMOKE_RADIUS } from "../engine/state";
import type { GrenadeView } from "../engine/state";
import type { Theme } from "./theme";

export interface View { zoom: number; panX: number; panY: number }
export interface DrawOptions {
  trails: boolean; names: boolean; shots: boolean; radarOpacity: number; flashes?: boolean; deaths?: boolean; dotScale?: number; nadePaths?: boolean;
  /** taille des noms (×), adversaires affichés, coéquipiers en pastilles pleines (adversaires cerclés), marqueurs de spawn */
  nameSize?: number; enemies?: boolean; solidTeammates?: boolean; spawns?: boolean;
  /** sensibilité de la molette (×), freeze time inclus dans la lecture, overlay d'attaque de site, séquence des tactiques, killfeed */
  zoomSens?: number; freeze?: boolean; bombsite?: boolean; sequencer?: boolean; killfeed?: boolean;
}
export interface DrawArgs {
  replay: Replay; map: MapMeta; images: Record<string, HTMLImageElement>; tick: number; view: View; level: string;
  splitLevels: boolean; options: DrawOptions; selected: string | null; theme: Theme; dpr: number; width: number; height: number;
  shapes?: Shape[]; draft?: Shape | null;
  /** rounds superposés (fantômes), alignés sur le temps écoulé depuis la fin du freeze time */
  layers?: { replay: Replay; label: string }[];
  /** camp « à nous » (adversaires masquables, coéquipiers pleins) ; positions déplacées (mode M) ; tempo du round pour l'overlay de site */
  mySide?: "CT" | "T" | null; overrides?: Record<string, [number, number]>; tempo?: { contact_s: number | null; plant_s: number | null; site: string | null } | null;
  /** grenade choisie dans le panneau « Grenades » : trajectoire complète surlignée, quel que soit l'instant */
  focusNade?: number | null;
}

/** Position d'un joueur, déplacée si le mode M l'a bougé. */
export function statesWithOverrides(r: Replay, tick: number, overrides?: Record<string, [number, number]>) {
  const st = playerStateAt(r, tick);
  if (!overrides || !Object.keys(overrides).length) return st;
  return st.map((p) => (overrides[p.steamid] ? { ...p, x: overrides[p.steamid][0], y: overrides[p.steamid][1] } : p));
}

/** Tick d'un round superposé correspondant au tick courant du round principal. */
export const layerTick = (main: Replay, layer: Replay, tick: number) =>
  layer.freezeEndTick + ((tick - main.freezeEndTick) / main.tickrate) * layer.tickrate;
export interface Layout { offsets: Record<string, [number, number]>; scale: number; originX: number; originY: number }

/** Calcule où chaque niveau de radar est placé (en px radar avant vue), et l'échelle d'ajustement à l'écran. */
export function computeLayout(a: Pick<DrawArgs, "map" | "splitLevels" | "level" | "view" | "width" | "height">): Layout {
  const levels = a.splitLevels && a.map.levels.length > 1 ? a.map.levels.map((l) => l.name) : [a.level];
  const offsets: Record<string, [number, number]> = {};
  levels.forEach((l, k) => { offsets[l] = [k * RADAR_SIZE, 0]; });
  const contentW = RADAR_SIZE * levels.length;
  const fit = Math.min(a.width / contentW, a.height / RADAR_SIZE);
  const scale = fit * a.view.zoom;
  return { offsets, scale, originX: (a.width - contentW * scale) / 2 + a.view.panX, originY: (a.height - RADAR_SIZE * scale) / 2 + a.view.panY };
}

/** Décalage horizontal (px écran) qui ramène [x0, x1] entre la marge gauche et `right` (bord gauche d'un panneau
 *  posé sur le radar), sans pousser le début hors de l'écran. 0 si c'est déjà visible ou si la place manque. */
export function revealShift(x0: number, x1: number, right: number, margin = 24): number {
  if (right < 200) return 0;
  if (x1 > right - margin) return Math.max(right - margin - x1, margin - x0);
  if (x0 < margin) return margin - x0;
  return 0;
}

/** Vue initiale cadrée sur la zone parcourue par les joueurs pendant le round (les radars ont de larges marges vides). */
export function fitView(r: Replay, map: MapMeta, width: number, height: number): View {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < r.n; i++) {
    for (let j = 0; j < r.m; j++) {
      if (!(r.value("flags", i, j) & 1)) continue;
      const [px, py] = worldToRadar(map, r.value("x", i, j), r.value("y", i, j));
      x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
    }
  }
  if (!isFinite(x0) || width <= 0 || height <= 0) return { zoom: 1, panX: 0, panY: 0 };
  const pad = 0.22, minSpan = 360;
  const bw = Math.max(minSpan, (x1 - x0) * (1 + 2 * pad)), bh = Math.max(minSpan, (y1 - y0) * (1 + 2 * pad));
  const fit = Math.min(width / RADAR_SIZE, height / RADAR_SIZE);
  const zoom = Math.min(3, Math.max(1, Math.min(width / (bw * fit), height / (bh * fit))));
  const s = fit * zoom;
  return { zoom, panX: s * (RADAR_SIZE / 2 - (x0 + x1) / 2), panY: s * (RADAR_SIZE / 2 - (y0 + y1) / 2) };
}

export function drawFrame(ctx: CanvasRenderingContext2D, a: DrawArgs): Layout {
  const { replay: r, map, theme, tick } = a;
  const L = computeLayout(a);
  ctx.setTransform(a.dpr, 0, 0, a.dpr, 0, 0);
  ctx.clearRect(0, 0, a.width, a.height);
  ctx.save();
  ctx.translate(L.originX, L.originY);
  ctx.scale(L.scale, L.scale);
  const k = 1 / L.scale; // taille constante à l'écran pour les éléments d'interface
  const sideColor = (s: string) => (s === "CT" ? theme.ct : theme.t);
  const placeOf = (z: number): { off: [number, number]; dim: boolean } => {
    const lvl = levelForZ(map, z);
    if (L.offsets[lvl]) return { off: L.offsets[lvl], dim: false };
    return { off: Object.values(L.offsets)[0], dim: true };
  };
  const P = (x: number, y: number, z: number): [number, number, boolean] => {
    const [px, py] = worldToRadar(map, x, y);
    const { off, dim } = placeOf(z);
    return [px + off[0], py + off[1], dim];
  };

  // radars
  ctx.globalAlpha = a.options.radarOpacity;
  for (const [lvl, off] of Object.entries(L.offsets)) {
    const meta = map.levels.find((l) => l.name === lvl) ?? map.levels[0];
    const img = a.images[meta?.image ?? map.image];
    if (img?.complete) ctx.drawImage(img, off[0], off[1], RADAR_SIZE, RADAR_SIZE);
    else { ctx.fillStyle = "#151a22"; ctx.fillRect(off[0], off[1], RADAR_SIZE, RADAR_SIZE); }
  }
  ctx.globalAlpha = 1;

  // traînées
  if (a.options.trails || a.selected) {
    const { i } = sampleIndex(r.ticks, tick);
    const from = Math.max(0, i - 5 * (r.n / Math.max(1, (r.lastTick - r.startTick) / r.tickrate)));
    for (const p of r.players) {
      if (!a.options.trails && p.steamid !== a.selected) continue;
      ctx.beginPath();
      for (let s = Math.floor(from); s <= i; s++) {
        if (!(r.value("flags", s, p.index) & 1)) continue;
        const [x, y] = P(r.value("x", s, p.index), r.value("y", s, p.index), r.value("z", s, p.index));
        if (s === Math.floor(from)) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = sideColor(p.side);
      ctx.globalAlpha = p.steamid === a.selected ? 0.8 : 0.3;
      ctx.lineWidth = 2 * k;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // grenades : les fumées passent par un calque séparé, percé par les HE et les balles
  const grenades = activeGrenades(r, tick);
  drawSmokes(ctx, grenades.filter((g) => g.type === "smoke" && g.phase === "active"), smokeBreaks(r, tick), P, map.scale, theme.smoke);
  const extinguished = extinguishedOf(r);
  for (const g of grenades) {
    const [gx, gy] = P(g.pos[0], g.pos[1], g.pos[2]);
    const color = { smoke: theme.smoke, flash: theme.flash, he: theme.he, molotov: theme.fire, incendiary: theme.fire, decoy: theme.fg }[g.type];
    if (g.phase === "flying") {
      ctx.setLineDash([4 * k, 4 * k]);
      ctx.beginPath();
      g.path.forEach(([x, y], idx) => { const [px, py] = P(x, y, g.pos[2]); if (idx) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
      ctx.strokeStyle = color; ctx.globalAlpha = 0.6; ctx.lineWidth = 1.5 * k; ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.arc(gx, gy, 3 * k, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
      continue;
    }
    // trajectoire du lancer (lineup), gardée pendant l'effet de la grenade et estompée au fil de sa durée
    if (a.options.nadePaths !== false && g.path.length > 1) {
      ctx.setLineDash([4 * k, 4 * k]);
      ctx.beginPath();
      g.path.forEach(([x, y], idx) => { const [px, py] = P(x, y, g.pos[2]); if (idx) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
      ctx.strokeStyle = color; ctx.globalAlpha = 0.55 * (1 - 0.6 * Math.min(1, g.progress)); ctx.lineWidth = 1.5 * k; ctx.stroke();
      ctx.setLineDash([]);
      const [sx, sy] = P(g.path[0][0], g.path[0][1], g.pos[2]);
      ctx.beginPath(); ctx.arc(sx, sy, 2.5 * k, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
      ctx.globalAlpha = 1;
    }
    const lifeS = g.progress;
    if (g.type === "smoke") {
      // dessinée par drawSmokes
    } else if ((g.type === "molotov" || g.type === "incendiary") && extinguished.has(g.id) && tick >= extinguished.get(g.id)!) {
      // éteint par une fumée : plus de feu
    } else if (g.type === "molotov" || g.type === "incendiary") {
      ctx.beginPath(); ctx.arc(gx, gy, 120 / map.scale, 0, Math.PI * 2);
      ctx.fillStyle = color; ctx.globalAlpha = 0.4; ctx.fill();
    } else if (g.type === "flash" || g.type === "he") {
      const rad = (g.type === "he" ? 350 : 250) / map.scale * Math.min(1, lifeS * 2);
      ctx.beginPath(); ctx.arc(gx, gy, rad, 0, Math.PI * 2);
      ctx.strokeStyle = color; ctx.lineWidth = 3 * k; ctx.globalAlpha = Math.max(0, 1 - lifeS); ctx.stroke();
      if (g.type === "flash") { ctx.fillStyle = color; ctx.globalAlpha = Math.max(0, 0.5 - lifeS); ctx.fill(); }
    } else {
      ctx.setLineDash([2 * k, 3 * k]); ctx.beginPath(); ctx.arc(gx, gy, 10 * k, 0, Math.PI * 2);
      ctx.strokeStyle = color; ctx.globalAlpha = 0.7; ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.globalAlpha = 1;
  }

  // molotovs éteints par une fumée : cercle barré pendant 2 s
  for (const [id, at] of extinguished) {
    if (tick < at || tick > at + 2 * r.tickrate) continue;
    const g = r.payload.grenades.find((x) => x.id === id)!;
    const last = g.trajectory[g.trajectory.length - 1];
    const pos = g.detonate_pos ?? [last[1], last[2], last[3]];
    const [x, y] = P(pos[0], pos[1], pos[2]);
    const rad = 120 / map.scale, f = 1 - (tick - at) / (2 * r.tickrate);
    ctx.globalAlpha = 0.9 * f; ctx.strokeStyle = theme.fire; ctx.lineWidth = 2 * k; ctx.setLineDash([5 * k, 4 * k]);
    ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(x - rad * 0.6, y - rad * 0.6); ctx.lineTo(x + rad * 0.6, y + rad * 0.6); ctx.stroke();
    ctx.font = `700 ${11 * k}px sans-serif`; ctx.textAlign = "center"; ctx.fillStyle = theme.fire;
    ctx.fillText("éteint", x, y - rad - 4 * k);
    ctx.globalAlpha = 1;
  }

  // lineup choisi dans le panneau « Grenades » : trajectoire entière, point de lancer (couleur du camp) et point d'arrivée
  const focus = a.focusNade != null ? r.payload.grenades.find((g) => g.id === a.focusNade) : undefined;
  if (focus && focus.trajectory.length > 1) {
    const color = { smoke: theme.smoke, flash: theme.flash, he: theme.he, molotov: theme.fire, incendiary: theme.fire, decoy: theme.fg }[focus.type];
    const pts = focus.trajectory.map(([, x, y, z]) => P(x, y, z));
    ctx.beginPath();
    pts.forEach(([px, py], idx) => (idx ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
    ctx.strokeStyle = "#000"; ctx.globalAlpha = 0.6; ctx.lineWidth = 5 * k; ctx.stroke();
    ctx.strokeStyle = color; ctx.globalAlpha = 1; ctx.lineWidth = 2.5 * k; ctx.stroke();
    const side = r.payload.players.find((p) => p.steamid === focus.thrower)?.side;
    const [sx, sy] = P(focus.throw_pos[0], focus.throw_pos[1], focus.throw_pos[2]);
    ctx.beginPath(); ctx.arc(sx, sy, 6 * k, 0, Math.PI * 2);
    ctx.fillStyle = side ? sideColor(side) : color; ctx.fill(); ctx.strokeStyle = "#000"; ctx.lineWidth = 1.5 * k; ctx.stroke();
    const [lx, ly] = pts[pts.length - 1];
    ctx.beginPath(); ctx.arc(lx, ly, 9 * k, 0, Math.PI * 2);
    ctx.strokeStyle = color; ctx.lineWidth = 2.5 * k; ctx.stroke();
    ctx.beginPath(); ctx.arc(lx, ly, 2.5 * k, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
  }

  // morts
  for (const d of a.options.deaths === false ? [] : deathsUntil(r, tick)) {
    const [x, y] = P(d.victim_pos[0], d.victim_pos[1], d.victim_pos[2]);
    const side = r.payload.players.find((p) => p.steamid === d.victim)?.side ?? "T";
    const s = 7 * k;
    ctx.beginPath(); ctx.moveTo(x - s, y - s); ctx.lineTo(x + s, y + s); ctx.moveTo(x + s, y - s); ctx.lineTo(x - s, y + s);
    ctx.lineCap = "round"; ctx.globalAlpha = 0.9;
    ctx.strokeStyle = theme.bg; ctx.lineWidth = 5 * k; ctx.stroke();  // contour sombre : lisible sur le radar
    ctx.strokeStyle = sideColor(side); ctx.lineWidth = 2.5 * k; ctx.stroke();
    ctx.lineCap = "butt";
  }
  ctx.globalAlpha = 1;

  // kills récents : ligne attaquant → victime
  for (const kl of recentKills(r, tick, 2 * r.tickrate)) {
    if (!kl.attacker_pos) continue;
    const [ax, ay] = P(...kl.attacker_pos), [vx, vy] = P(...kl.victim_pos);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(vx, vy);
    ctx.strokeStyle = theme.fg; ctx.globalAlpha = 0.5 * (1 - (tick - kl.tick) / (2 * r.tickrate)); ctx.lineWidth = 1 * k; ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // tirs
  if (a.options.shots) {
    for (const s of recentShots(r, tick, 6)) {
      const [x, y] = P(...s.pos);
      const rad = (s.yaw * Math.PI) / 180;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(rad) * 140 * k, y - Math.sin(rad) * 140 * k);
      ctx.strokeStyle = theme.flash; ctx.globalAlpha = 0.8 * (1 - (tick - s.tick) / 6); ctx.lineWidth = 1.2 * k; ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // bombe
  const bomb = bombStateAt(r, tick);
  if (bomb.pos && bomb.state !== "carried") {
    const [x, y] = P(...bomb.pos);
    if (bomb.state === "planted" && bomb.plantTick != null) {
      const left = BOMB_TIME_S - (tick - bomb.plantTick) / r.tickrate;
      const period = left < 10 ? 0.25 : 1;
      const on = Math.floor(((tick - bomb.plantTick) / r.tickrate) / period * 2) % 2 === 0;
      ctx.beginPath(); ctx.arc(x, y, 14 * k, -Math.PI / 2, -Math.PI / 2 + (Math.max(0, left) / BOMB_TIME_S) * Math.PI * 2);
      ctx.strokeStyle = theme.he; ctx.lineWidth = 2 * k; ctx.stroke();
      ctx.fillStyle = on ? theme.he : "#7a1717";
    } else if (bomb.state === "exploded") {
      ctx.beginPath(); ctx.arc(x, y, 500 / map.scale, 0, Math.PI * 2); ctx.fillStyle = theme.fire; ctx.globalAlpha = 0.25; ctx.fill(); ctx.globalAlpha = 1;
      ctx.fillStyle = theme.he;
    } else ctx.fillStyle = bomb.state === "defused" ? theme.ct : theme.he;
    ctx.fillRect(x - 5 * k, y - 5 * k, 10 * k, 10 * k);
  }

  // marqueurs de flash : pendant 1,5 s après l'explosion, un trait vers chaque joueur aveuglé avec la durée
  // (plein pour un adversaire, en pointillés rouges pour un coéquipier)
  if (a.options.flashes !== false) {
    const now = playerStateAt(r, tick);
    const pos = new Map(now.map((p) => [p.steamid, p]));
    for (const g of r.payload.grenades) {
      if (g.type !== "flash" || g.detonate_tick == null || !g.detonate_pos) continue;
      const age = (tick - g.detonate_tick) / r.tickrate;
      if (age < 0 || age > 1.5) continue;
      const [fx, fy] = P(g.detonate_pos[0], g.detonate_pos[1], g.detonate_pos[2]);
      const thrower = pos.get(g.thrower);
      const fade = 1 - age / 1.5;
      for (const b of r.payload.blinds) {
        if (b.attacker !== g.thrower || Math.abs(b.tick - g.detonate_tick) > 8 || b.duration < 0.3) continue;
        const v = pos.get(b.victim);
        if (!v) continue;
        const [vx, vy] = P(v.x, v.y, v.z);
        const team = thrower && v.side === thrower.side;
        ctx.globalAlpha = 0.85 * fade;
        ctx.strokeStyle = team ? theme.he : theme.flash;
        ctx.lineWidth = 1.5 * k;
        ctx.setLineDash(team ? [4 * k, 3 * k] : []);
        ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(vx, vy); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = team ? theme.he : theme.flash;
        ctx.font = `700 ${9.5 * k}px "JetBrains Mono", monospace`; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
        ctx.fillText(`${b.duration.toFixed(1)}s`, vx, vy - 14 * k);
      }
      ctx.globalAlpha = 1;
    }
  }

  // rounds superposés : utilitaires (léger) puis joueurs fantômes
  for (const layer of a.layers ?? []) {
    const lt = layerTick(r, layer.replay, tick);
    for (const g of activeGrenades(layer.replay, lt)) {
      if (g.phase !== "active" || !["smoke", "molotov", "incendiary"].includes(g.type)) continue;
      const [gx, gy] = P(g.pos[0], g.pos[1], g.pos[2]);
      ctx.beginPath(); ctx.arc(gx, gy, (g.type === "smoke" ? 144 : 120) / map.scale, 0, Math.PI * 2);
      ctx.fillStyle = g.type === "smoke" ? theme.smoke : theme.fire; ctx.globalAlpha = 0.12; ctx.fill();
      ctx.setLineDash([3 * k, 3 * k]); ctx.strokeStyle = ctx.fillStyle as string; ctx.globalAlpha = 0.35; ctx.lineWidth = 1 * k; ctx.stroke(); ctx.setLineDash([]);
    }
    for (const p of playerStateAt(layer.replay, lt)) {
      if (!p.alive) continue;
      const [x, y, dim] = P(p.x, p.y, p.z);
      const col = sideColor(p.side);
      ctx.globalAlpha = dim ? 0.2 : 0.55;
      const yaw = (p.yaw * Math.PI) / 180;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(-yaw) * 13 * k, y + Math.sin(-yaw) * 13 * k);
      ctx.strokeStyle = col; ctx.lineWidth = 1.5 * k; ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, 6.5 * k, 0, Math.PI * 2); ctx.fillStyle = theme.bg; ctx.fill();
      ctx.lineWidth = 2 * k; ctx.strokeStyle = col; ctx.stroke();
      ctx.fillStyle = col; ctx.font = `700 ${8 * k}px "JetBrains Mono", monospace`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(layer.label, x, y + 0.5 * k);
    }
    ctx.globalAlpha = 1;
  }

  // overlay d'attaque de site (O) : anneaux A / B, T vivants à proximité, site attaqué et tempo
  if (a.options.bombsite) drawBombsites(ctx, a, P, k);

  // marqueurs de spawn : position de chaque joueur à la fin du freeze time
  if (a.options.spawns) {
    for (const p of playerStateAt(r, r.freezeEndTick)) {
      const [x, y] = P(p.x, p.y, p.z);
      ctx.beginPath(); ctx.arc(x, y, 5 * k, 0, Math.PI * 2);
      ctx.strokeStyle = sideColor(p.side); ctx.globalAlpha = 0.45; ctx.lineWidth = 1.5 * k; ctx.setLineDash([2 * k, 2 * k]); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.globalAlpha = 1;
  }

  // joueurs (taille réglable : kp = 1 px écran × échelle des pastilles)
  const kp = k * (a.options.dotScale ?? 1);
  const labels: { x: number; y: number; name: string; alpha: number }[] = [];  // noms dessinés après, sans se chevaucher
  const hideEnemies = a.options.enemies === false && !!a.mySide;
  for (const p of statesWithOverrides(r, tick, a.overrides)) {
    if (!p.alive) continue;
    if (hideEnemies && p.side !== a.mySide) continue;
    const [x, y, dim] = P(p.x, p.y, p.z);
    const col = sideColor(p.side);
    const moved = a.overrides?.[p.steamid];
    if (moved) {  // position réelle en pointillés, reliée à la position déplacée
      const real = playerStateAt(r, tick).find((q) => q.steamid === p.steamid)!;
      const [rx, ry] = P(real.x, real.y, real.z);
      ctx.setLineDash([3 * k, 3 * k]); ctx.beginPath(); ctx.moveTo(rx, ry); ctx.lineTo(x, y); ctx.strokeStyle = col; ctx.globalAlpha = 0.5; ctx.lineWidth = 1 * k; ctx.stroke(); ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(rx, ry, 6 * kp, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.globalAlpha = dim ? 0.35 : 1;
    const yaw = (p.yaw * Math.PI) / 180;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.arc(x, y, 26 * kp, -yaw - 0.44, -yaw + 0.44); ctx.closePath();
    ctx.fillStyle = col; ctx.globalAlpha *= 0.25; ctx.fill(); ctx.globalAlpha = dim ? 0.35 : 1;
    if (p.flash > 0) { ctx.beginPath(); ctx.arc(x, y, 14 * kp, 0, Math.PI * 2); ctx.fillStyle = theme.flash; ctx.globalAlpha = Math.min(1, p.flash / 3) * 0.8; ctx.fill(); ctx.globalAlpha = dim ? 0.35 : 1; }
    const hollow = a.options.solidTeammates && !!a.mySide && p.side !== a.mySide;  // coéquipiers pleins : les adversaires sont cerclés
    ctx.beginPath(); ctx.arc(x, y, 9 * kp, 0, Math.PI * 2); ctx.fillStyle = hollow ? theme.bg : col; ctx.fill();
    ctx.lineWidth = 2 * kp; ctx.strokeStyle = hollow ? col : theme.bg; ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, 11.5 * kp, -Math.PI / 2, -Math.PI / 2 + (p.hp / 100) * Math.PI * 2);
    ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2 * kp; ctx.stroke();
    if (p.steamid === a.selected) { ctx.beginPath(); ctx.arc(x, y, 15 * kp, 0, Math.PI * 2); ctx.strokeStyle = theme.accent; ctx.lineWidth = 2 * kp; ctx.stroke(); }
    if (p.defusing) { ctx.beginPath(); ctx.arc(x, y, 18 * kp, 0, ((tick % 64) / 64) * Math.PI * 2); ctx.strokeStyle = theme.ct; ctx.stroke(); }
    if (p.hasBomb) { ctx.fillStyle = theme.he; ctx.fillRect(x + 6 * kp, y - 11 * kp, 5 * kp, 5 * kp); }
    if (p.defuser) { ctx.fillStyle = "#4cc38a"; ctx.fillRect(x + 6 * kp, y + 7 * kp, 5 * kp, 2 * kp); }
    ctx.fillStyle = hollow ? col : "#0b0e13"; ctx.font = `600 ${10 * kp}px "JetBrains Mono", monospace`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(String(p.slot), x, y + 0.5 * kp);
    if (a.options.names) labels.push({ x, y: y + 22 * kp, name: p.name, alpha: dim ? 0.35 : 1 });
    ctx.globalAlpha = 1;
  }
  if (labels.length) {  // étiquettes empilées quand des joueurs sont au même endroit (spawn, stack)
    const kn = kp * (a.options.nameSize ?? 1);
    ctx.font = `500 ${11 * kn}px Inter, sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const h = 13 * kn, placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
    for (const l of labels.sort((p, q) => p.y - q.y || p.x - q.x)) {
      const w = ctx.measureText(l.name).width + 6 * kn;
      let y = l.y;
      for (let tries = 0; tries < 8; tries++) {
        const hit = placed.find((b) => l.x - w / 2 < b.x1 && l.x + w / 2 > b.x0 && y - h / 2 < b.y1 && y + h / 2 > b.y0);
        if (!hit) break;
        y = hit.y1 + h / 2;
      }
      placed.push({ x0: l.x - w / 2, x1: l.x + w / 2, y0: y - h / 2, y1: y + h / 2 });
      ctx.globalAlpha = l.alpha; ctx.fillStyle = theme.fg; ctx.fillText(l.name, l.x, y);
    }
    ctx.globalAlpha = 1;
  }
  // dessins et annotations, au-dessus de tout
  for (const [lvl, off] of Object.entries(L.offsets)) {
    drawShapes(ctx, (a.shapes ?? []).filter((sh) => sh.level === lvl), off, k, tick, a.draft?.level === lvl ? a.draft : null);
  }
  ctx.restore();
  return L;
}

/** Point écran → (niveau, px radar du niveau), ou null hors radar. */
export function screenToRadar(layout: Layout, sx: number, sy: number): { level: string; x: number; y: number } | null {
  const rx = (sx - layout.originX) / layout.scale, ry = (sy - layout.originY) / layout.scale;
  for (const [level, off] of Object.entries(layout.offsets)) {
    if (rx >= off[0] && rx < off[0] + RADAR_SIZE && ry >= off[1] && ry < off[1] + RADAR_SIZE) return { level, x: rx - off[0], y: ry - off[1] };
  }
  return null;
}

/** Joueur vivant le plus proche d'un point écran (rayon 14 px), pour la sélection au clic. */
export function hitTest(a: DrawArgs, layout: Layout, sx: number, sy: number): string | null {
  let best: string | null = null, bestD = 14 * 14;
  const hideEnemies = a.options.enemies === false && !!a.mySide;
  for (const p of statesWithOverrides(a.replay, a.tick, a.overrides)) {
    if (!p.alive || (hideEnemies && p.side !== a.mySide)) continue;
    const [px, py] = worldToRadar(a.map, p.x, p.y);
    const off = layout.offsets[levelForZ(a.map, p.z)] ?? Object.values(layout.offsets)[0];
    const x = layout.originX + (px + off[0]) * layout.scale, y = layout.originY + (py + off[1]) * layout.scale;
    const d = (x - sx) ** 2 + (y - sy) ** 2;
    if (d < bestD) { bestD = d; best = p.steamid; }
  }
  return best;
}

/** Overlay d'attaque de site : pour chaque site, un anneau et le nombre de T vivants à moins de 700 unités ; le site attaqué
 *  (plant, sinon le plus proche de la majorité des T) est mis en avant, avec le tempo du round (premier contact, plant). */
const SITE_R = 700;
function drawBombsites(ctx: CanvasRenderingContext2D, a: DrawArgs, P: (x: number, y: number, z: number) => [number, number, boolean], k: number) {
  const { replay: r, map, theme, tick } = a;
  const sites: ["A" | "B", [number, number]][] = [];
  if (map.bomb_a) sites.push(["A", map.bomb_a]);
  if (map.bomb_b) sites.push(["B", map.bomb_b]);
  if (!sites.length) return;
  const ts = statesWithOverrides(r, tick, a.overrides).filter((p) => p.alive && p.side === "T");
  const bomb = bombStateAt(r, tick);
  const counts = sites.map(([, [sx, sy]]) => ts.filter((p) => Math.hypot(p.x - sx, p.y - sy) <= SITE_R).length);
  const planted = bomb.state === "planted" || bomb.state === "exploded" || bomb.state === "defused" ? bomb.site : null;
  const lead = counts[0] === counts[1] ? null : counts[0] > counts[1] ? sites[0][0] : sites[1][0];
  const attacked = planted ?? a.tempo?.site ?? (ts.length ? lead : null);
  const z = r.players.length ? playerStateAt(r, r.freezeEndTick)[0]?.z ?? 0 : 0;
  sites.forEach(([name, [sx, sy]], i) => {
    const [x, y] = P(sx, sy, z);
    const on = attacked === name;
    ctx.beginPath(); ctx.arc(x, y, SITE_R / map.scale, 0, Math.PI * 2);
    ctx.fillStyle = on ? theme.t : theme.fg; ctx.globalAlpha = on ? 0.14 : 0.05; ctx.fill();
    ctx.setLineDash(on ? [] : [6 * k, 6 * k]); ctx.strokeStyle = on ? theme.t : theme.fg; ctx.globalAlpha = on ? 0.8 : 0.35; ctx.lineWidth = (on ? 2.5 : 1.5) * k; ctx.stroke(); ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.font = `800 ${22 * k}px "Saira", "Inter", sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillStyle = on ? theme.t : theme.fg; ctx.globalAlpha = on ? 0.95 : 0.5;
    ctx.fillText(name, x, y - 14 * k);
    ctx.font = `700 ${11 * k}px "JetBrains Mono", monospace`;
    ctx.fillText(`${counts[i]} T`, x, y + 10 * k);
    ctx.globalAlpha = 1;
  });
  // tempo du round, sous le site attaqué
  const target = sites.find(([n]) => n === attacked);
  if (target && a.tempo) {
    const [x, y] = P(target[1][0], target[1][1], z);
    const clock = (s: number) => { const v = Math.max(0, 115 - s); return `${Math.floor(v / 60)}:${String(Math.floor(v % 60)).padStart(2, "0")}`; };
    const parts = [a.tempo.contact_s != null ? `contact ${clock(a.tempo.contact_s)}` : null, a.tempo.plant_s != null ? `plant ${clock(a.tempo.plant_s)}` : null].filter(Boolean);
    if (parts.length) {
      ctx.font = `600 ${10 * k}px Inter, sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillStyle = theme.fg; ctx.globalAlpha = 0.85; ctx.fillText(parts.join(" · "), x, y + SITE_R / map.scale + 12 * k); ctx.globalAlpha = 1;
    }
  }
}

const extinguishedCache = new WeakMap<Replay, Map<number, number>>();
function extinguishedOf(r: Replay): Map<number, number> {
  let m = extinguishedCache.get(r);
  if (!m) { m = extinguishedMolotovs(r); extinguishedCache.set(r, m); }
  return m;
}

let smokeLayer: HTMLCanvasElement | null = null;
/** Fumées sur un calque à part : disques opaques, trous des HE et tunnels des balles découpés (destination-out),
 *  puis calque posé sur le radar en semi-transparence. */
function drawSmokes(ctx: CanvasRenderingContext2D, smokes: GrenadeView[], breaks: ReturnType<typeof smokeBreaks>,
  P: (x: number, y: number, z: number) => [number, number, boolean], scale: number, color: string) {
  if (!smokes.length) return;
  const cw = ctx.canvas.width, ch = ctx.canvas.height;
  if (!smokeLayer) smokeLayer = document.createElement("canvas");
  if (smokeLayer.width !== cw || smokeLayer.height !== ch) { smokeLayer.width = cw; smokeLayer.height = ch; }
  const o = smokeLayer.getContext("2d");
  if (!o) return;
  o.setTransform(1, 0, 0, 1, 0, 0);
  o.clearRect(0, 0, cw, ch);
  o.setTransform(ctx.getTransform());
  const rad = SMOKE_RADIUS / scale;
  for (const g of smokes) {
    const [x, y] = P(g.pos[0], g.pos[1], g.pos[2]);
    o.globalAlpha = g.progress > 0.94 ? (1 - g.progress) / 0.06 : 1;
    o.fillStyle = color;
    o.beginPath(); o.arc(x, y, rad, 0, Math.PI * 2); o.fill();
  }
  o.globalCompositeOperation = "destination-out";
  for (const g of smokes) {
    const b = breaks.get(g.id);
    if (!b) continue;
    const z = g.pos[2];
    for (const h of b.holes) {
      const [x, y] = P(h.x, h.y, z);
      const grad = o.createRadialGradient(x, y, 0, x, y, h.r / scale);
      grad.addColorStop(0, `rgba(0,0,0,${h.strength})`); grad.addColorStop(0.7, `rgba(0,0,0,${h.strength * 0.85})`); grad.addColorStop(1, "rgba(0,0,0,0)");
      o.globalAlpha = 1; o.fillStyle = grad;
      o.beginPath(); o.arc(x, y, h.r / scale, 0, Math.PI * 2); o.fill();
    }
    for (const t of b.tunnels) {
      const [ax, ay] = P(t.a[0], t.a[1], z), [bx, by] = P(t.b[0], t.b[1], z);
      o.globalAlpha = 0.85 * t.strength; o.strokeStyle = "#000"; o.lineWidth = 16 / scale; o.lineCap = "round";
      o.beginPath(); o.moveTo(ax, ay); o.lineTo(bx, by); o.stroke();
    }
  }
  o.globalCompositeOperation = "source-over"; o.globalAlpha = 1;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 0.55;
  ctx.drawImage(smokeLayer, 0, 0);
  ctx.restore();
  // contour pointillé des fumées percées : on voit qu'une fumée est ouverte, pas qu'elle a disparu
  const k = 1 / Math.hypot(ctx.getTransform().a, ctx.getTransform().b) * (window.devicePixelRatio || 1);
  for (const g of smokes) {
    if (!breaks.get(g.id)?.holes.length) continue;
    const [x, y] = P(g.pos[0], g.pos[1], g.pos[2]);
    ctx.save();
    ctx.globalAlpha = 0.8; ctx.strokeStyle = color; ctx.lineWidth = 1.5 * k; ctx.setLineDash([4 * k, 4 * k]);
    ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
}
