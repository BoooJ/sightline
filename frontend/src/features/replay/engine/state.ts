import type { BombEvent, GrenadeEvent, KillEvent, ShotEvent, Side, Vec3 } from "../../../shared/api/types";
import { lerp, lerpAngle, lerpAngleMid, lerpMid, sampleIndex } from "./interp";
import type { Replay, Viewmodel } from "./replay";

export const ROUND_TIME_S = 115, BOMB_TIME_S = 40, SMOKE_S = 18, FIRE_S = 7;
/** Bits du champ « flags » des images, mêmes valeurs que FLAG_* de backend/app/parsing/model.py. */
export const F = { ALIVE: 1, HELMET: 2, DEFUSER: 4, BOMB: 8, DEFUSING: 16, SCOPED: 32, AIRBORNE: 64, LADDER: 128 };  // LADDER : sur une échelle ; jamais posé par un replay plus ancien
/** Bits du champ « keys » (touches tenues, marche, accroupi), mêmes valeurs que KEY_* de backend/app/parsing/model.py. */
export const KEYS = { FORWARD: 1, BACK: 2, LEFT: 4, RIGHT: 8, JUMP: 16, WALK: 32, FIRE: 64, RIGHTCLICK: 128, RELOAD: 256,
  USE: 512, INSPECT: 1024, DUCK: 2048 };
const NO_AMMO = 65535; // champs « clip » et « reserve » : munitions inconnues (NO_AMMO du serveur)
const DEFAULT_FOV = 90; // m_iFOV vaut 0 quand le joueur est au FOV par défaut du jeu

export interface PlayerState {
  steamid: string; name: string; side: Side; slot: number; x: number; y: number; z: number; yaw: number;
  hp: number; armor: number; alive: boolean; helmet: boolean; defuser: boolean; hasBomb: boolean; defusing: boolean;
  scoped: boolean; flash: number; money: number; weapon: string; inventory: string[]; equip: number;
  // vue du joueur (démos analysées depuis le 30/10/2026 ; valeurs par défaut pour un replay plus ancien)
  pitch: number; // regard vertical en degrés, convention CS2 : positif = vers le BAS ; 0 si absent
  duck: number; // 0 debout → 1 accroupi, interpolé
  airborne: boolean;
  clip: number | null; reserve: number | null; // balles dans le chargeur ; réserve en chargeurs de rechange ; null si inconnues
  zoom: number; // niveau de lunette : 0, 1 ou 2
  fov: number; // FOV réel de la caméra en degrés (90 hors lunette, 40/10… en lunette), interpolé ; 0 si le replay n'a pas ce champ
  viewmodel: Viewmodel | null; // réglages des bras du joueur, null si inconnus
  keys: number; // bits KEYS
  crosshair: string | null; // code de partage du réticule du joueur
}

export function playerStateAt(r: Replay, tick: number): PlayerState[] {
  const { i, t } = sampleIndex(r.ticks, tick);
  const i2 = Math.min(i + 1, r.n - 1);
  // champs de la vue du joueur : absents d'un replay analysé avant le 30/10/2026 → valeurs par défaut
  const has = { pitch: r.has("pitch"), duck: r.has("duck"), clip: r.has("clip"), reserve: r.has("reserve"),
    zoom: r.has("zoom"), keys: r.has("keys"), fov: r.has("fov") };
  // regard au tick situé entre deux images (démos analysées depuis le 31/10/2026) : deux demi-intervalles par ce milieu ;
  // sans lui, interpolation linéaire entre les deux images comme avant
  const hasMid = { yaw: r.has("yawm"), pitch: has.pitch && r.has("pitchm") };
  return r.players.map((p) => {
    const j = p.index;
    const v = (k: string, idx = i) => r.value(k, idx, j);
    const ammo = (k: "clip" | "reserve") => { const a = has[k] ? v(k) : NO_AMMO; return a === NO_AMMO ? null : a; };
    const fovAt = (idx: number) => { const a = v("fov", idx); return a === 0 ? DEFAULT_FOV : a; }; // 0 → 90 avant d'interpoler
    const flags = v("flags");
    const alive = (flags & F.ALIVE) !== 0;
    const nextAlive = (v("flags", i2) & F.ALIVE) !== 0;
    const tt = alive && nextAlive ? t : 0; // pas d'interpolation vers/depuis la mort
    return {
      steamid: p.steamid, name: p.name, side: p.side, slot: p.slot,
      x: lerp(v("x"), v("x", i2), tt), y: lerp(v("y"), v("y", i2), tt), z: lerp(v("z"), v("z", i2), tt),
      yaw: hasMid.yaw ? lerpAngleMid(v("yaw"), v("yawm"), v("yaw", i2), tt) : lerpAngle(v("yaw"), v("yaw", i2), tt), hp: v("hp"), armor: v("armor"), alive,
      helmet: (flags & F.HELMET) !== 0, defuser: (flags & F.DEFUSER) !== 0, hasBomb: (flags & F.BOMB) !== 0,
      defusing: (flags & F.DEFUSING) !== 0, scoped: (flags & F.SCOPED) !== 0,
      flash: Math.max(0, v("flash") - t * ((r.ticks[i2] - r.ticks[i]) / r.tickrate)),
      money: v("money"), weapon: r.weaponAt(i, j), inventory: r.inventoryAt(i, j), equip: v("equip"),
      pitch: !has.pitch ? 0 : hasMid.pitch ? lerpMid(v("pitch"), v("pitchm"), v("pitch", i2), tt) : lerp(v("pitch"), v("pitch", i2), tt),
      duck: has.duck ? lerp(v("duck"), v("duck", i2), tt) / 255 : 0,
      airborne: (flags & F.AIRBORNE) !== 0, clip: ammo("clip"), reserve: ammo("reserve"),
      zoom: has.zoom ? v("zoom") : 0, keys: has.keys ? v("keys") : 0, crosshair: r.crosshairOf(j),
      fov: has.fov ? lerp(fovAt(i), fovAt(i2), tt) : 0, viewmodel: r.viewmodelOf(j),
    };
  });
}

export interface GrenadeView {
  id: number; type: GrenadeEvent["type"]; phase: "flying" | "active" | "done"; pos: Vec3;
  path: [number, number][]; progress: number; thrower: string;
}

function trajectoryPos(g: GrenadeEvent, tick: number): { pos: Vec3; path: [number, number][] } {
  const tr = g.trajectory;
  const path: [number, number][] = [];
  for (let k = 0; k < tr.length; k++) {
    const [tk, x, y, z] = tr[k];
    if (tk > tick) {
      const [pt, px, py, pz] = tr[k - 1] ?? tr[k];
      const f = tk === pt ? 0 : (tick - pt) / (tk - pt);
      const pos: Vec3 = [lerp(px, x, f), lerp(py, y, f), lerp(pz, z, f)];
      path.push([pos[0], pos[1]]);
      return { pos, path };
    }
    path.push([x, y]);
  }
  const last = tr[tr.length - 1];
  return { pos: [last[1], last[2], last[3]], path };
}

export function activeGrenades(r: Replay, tick: number): GrenadeView[] {
  const out: GrenadeView[] = [];
  for (const g of r.payload.grenades) {
    if (tick < g.throw_tick) continue;
    const det = g.detonate_tick ?? g.trajectory[g.trajectory.length - 1][0];
    const end = g.end_tick ?? det;
    if (tick < det) {
      const { pos, path } = trajectoryPos(g, tick);
      out.push({ id: g.id, type: g.type, phase: "flying", pos, path, progress: 0, thrower: g.thrower });
    } else if (tick <= Math.max(end, det + r.tickrate / 2)) {
      const span = Math.max(1, Math.max(end, det + r.tickrate / 2) - det);
      const flight = trajectoryPos(g, det);  // trajectoire complète, gardée pendant l'effet (lineup)
      out.push({ id: g.id, type: g.type, phase: "active", pos: g.detonate_pos ?? flight.pos,
        path: flight.path, progress: (tick - det) / span, thrower: g.thrower });
    }
  }
  return out;
}

export function bombStateAt(r: Replay, tick: number) {
  let state: "carried" | "dropped" | "planted" | "defused" | "exploded" | "none" = "none";
  let pos: Vec3 | null = null, plantTick: number | null = null, site: string | null = null;
  for (const b of r.payload.bomb as BombEvent[]) {
    if (b.tick > tick) break;
    if (b.type === "pickup") { state = "carried"; pos = null; }
    else if (b.type === "drop") { state = "dropped"; pos = b.pos; }
    else if (b.type === "plant") { state = "planted"; pos = b.pos; plantTick = b.tick; site = b.site; }
    else if (b.type === "defuse") state = "defused";
    else if (b.type === "explode") state = "exploded";
  }
  const players = playerStateAt(r, tick);
  const carrier = players.find((p) => p.hasBomb && p.alive) ?? null;
  if (state === "none" || state === "carried") {
    state = carrier ? "carried" : state;
    if (carrier) pos = [carrier.x, carrier.y, carrier.z];
  }
  return { state, pos, carrier: carrier?.steamid ?? null, plantTick, site };
}

export function recentKills(r: Replay, tick: number, windowTicks: number): KillEvent[] {
  return r.payload.kills.filter((k) => k.tick <= tick && tick - k.tick <= windowTicks);
}
export function recentShots(r: Replay, tick: number, windowTicks: number): ShotEvent[] {
  return r.payload.shots.filter((s) => s.tick <= tick && tick - s.tick <= windowTicks);
}
export function deathsUntil(r: Replay, tick: number): KillEvent[] {
  return r.payload.kills.filter((k) => k.tick <= tick);
}

const mmss = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, "0")}`;

export function roundClock(r: Replay, tick: number): { label: string; phase: "freeze" | "live" | "planted" | "over"; seconds: number } {
  const plant = r.payload.bomb.find((b) => b.type === "plant" && b.tick <= tick);
  if (tick > r.endTick) return { label: "—", phase: "over", seconds: 0 };
  if (plant) {
    const s = BOMB_TIME_S - (tick - plant.tick) / r.tickrate;
    return { label: mmss(Math.ceil(s)), phase: "planted", seconds: s };
  }
  if (tick < r.freezeEndTick) {
    const s = (r.freezeEndTick - tick) / r.tickrate;
    return { label: mmss(Math.ceil(s)), phase: "freeze", seconds: s };
  }
  const s = ROUND_TIME_S - (tick - r.freezeEndTick) / r.tickrate;
  return { label: mmss(Math.ceil(s)), phase: "live", seconds: s };
}

export function timelineMarkers(r: Replay) {
  const sideOf = new Map(r.payload.players.map((p) => [p.steamid, p.side] as const));
  const name = (sid: string | null) => r.payload.players.find((p) => p.steamid === sid)?.name ?? "?";
  const out: { tick: number; kind: "kill" | "plant" | "defuse" | "explode"; side: Side | null; label: string }[] = [];
  for (const k of r.payload.kills) out.push({ tick: k.tick, kind: "kill", side: sideOf.get(k.attacker ?? "") ?? null, label: `${name(k.attacker)} → ${name(k.victim)}` });
  for (const b of r.payload.bomb) {
    if (b.type === "plant" || b.type === "defuse" || b.type === "explode") {
      out.push({ tick: b.tick, kind: b.type, side: b.type === "defuse" ? "CT" : "T",
        label: b.type === "plant" ? `Plant ${b.site ?? ""}` : b.type === "defuse" ? "Désamorçage" : "Explosion" });
    }
  }
  return out.sort((a, b) => a.tick - b.tick);
}

/** Fumées percées : une HE dégage un trou qui se referme en ~3 s, une balle creuse un tunnel visible ~1 s. */
export const SMOKE_RADIUS = 144;
const HE_HOLE = 190, HE_HOLD_S = 1, HE_REFILL_S = 2, BULLET_S = 1.2;
export interface SmokeHole { x: number; y: number; r: number; strength: number }
export interface SmokeTunnel { a: [number, number]; b: [number, number]; strength: number }

export function smokeBreaks(r: Replay, tick: number): Map<number, { holes: SmokeHole[]; tunnels: SmokeTunnel[] }> {
  const out = new Map<number, { holes: SmokeHole[]; tunnels: SmokeTunnel[] }>();
  const smokes = r.payload.grenades.filter((g) => g.type === "smoke" && g.detonate_tick != null && g.detonate_pos
    && tick >= g.detonate_tick && tick <= (g.end_tick ?? g.detonate_tick + SMOKE_S * r.tickrate));
  if (!smokes.length) return out;
  const hes = r.payload.grenades.filter((g) => g.type === "he" && g.detonate_tick != null && g.detonate_pos
    && g.detonate_tick <= tick && tick - g.detonate_tick <= (HE_HOLD_S + HE_REFILL_S) * r.tickrate);
  const shots = r.payload.shots.filter((s) => s.tick <= tick && tick - s.tick <= BULLET_S * r.tickrate);
  for (const sm of smokes) {
    const [cx, cy] = sm.detonate_pos!;
    const holes: SmokeHole[] = [], tunnels: SmokeTunnel[] = [];
    for (const he of hes) {
      if (he.detonate_tick! < sm.detonate_tick!) continue;
      const [hx, hy] = he.detonate_pos!;
      if (Math.hypot(hx - cx, hy - cy) > SMOKE_RADIUS + HE_HOLE) continue;
      const age = (tick - he.detonate_tick!) / r.tickrate;
      holes.push({ x: hx, y: hy, r: HE_HOLE, strength: age <= HE_HOLD_S ? 1 : Math.max(0, 1 - (age - HE_HOLD_S) / HE_REFILL_S) });
    }
    for (const s of shots) {
      if (s.tick < sm.detonate_tick!) continue;
      // rayon 2D depuis le tireur : intersection avec le disque de la fumée
      const dx = Math.cos((s.yaw * Math.PI) / 180), dy = Math.sin((s.yaw * Math.PI) / 180);
      const ox = s.pos[0] - cx, oy = s.pos[1] - cy;
      const b = ox * dx + oy * dy, c = ox * ox + oy * oy - SMOKE_RADIUS * SMOKE_RADIUS;
      const disc = b * b - c;
      if (disc <= 0) continue;
      const t1 = -b - Math.sqrt(disc), t2 = -b + Math.sqrt(disc);
      if (t2 <= 0 || t1 > 3000) continue;
      const ta = Math.max(0, t1);
      tunnels.push({ a: [s.pos[0] + dx * ta, s.pos[1] + dy * ta], b: [s.pos[0] + dx * t2, s.pos[1] + dy * t2],
        strength: 1 - (tick - s.tick) / (BULLET_S * r.tickrate) });
    }
    if (holes.length || tunnels.length) out.set(sm.id, { holes, tunnels });
  }
  return out;
}

/** Molotovs éteints par une fumée (lancée dessus, ou molotov tombé dans une fumée) : id → tick d'extinction. */
export function extinguishedMolotovs(r: Replay): Map<number, number> {
  const out = new Map<number, number>();
  const smokes = r.payload.grenades.filter((g) => g.type === "smoke" && g.detonate_tick != null && g.detonate_pos);
  for (const g of r.payload.grenades) {
    if (g.type !== "molotov" && g.type !== "incendiary") continue;
    const last = g.trajectory[g.trajectory.length - 1];
    const pos = g.detonate_pos ?? (last ? [last[1], last[2], last[3]] as Vec3 : null);
    if (!pos) continue;
    const start = g.detonate_tick ?? last?.[0] ?? g.throw_tick;
    const end = g.end_tick ?? start;
    for (const s of smokes) {
      const near = Math.hypot(s.detonate_pos![0] - pos[0], s.detonate_pos![1] - pos[1]) <= SMOKE_RADIUS + 120;
      if (!near) continue;
      const sEnd = s.end_tick ?? s.detonate_tick! + SMOKE_S * r.tickrate;
      // fumée posée sur le feu : le feu s'arrête dans la seconde ; feu lancé dans une fumée active : il ne prend pas
      const smokedFire = s.detonate_tick! >= start && s.detonate_tick! <= end && end - s.detonate_tick! <= 1.5 * r.tickrate;
      const fireInSmoke = start >= s.detonate_tick! && start <= sEnd && end - start <= 1.5 * r.tickrate;
      if (smokedFire || fireInSmoke) { out.set(g.id, smokedFire ? end : start); break; }
    }
  }
  return out;
}
