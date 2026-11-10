/**
 * Force de la mort pour le ragdoll : celle de la démo (Replay.deathForce, lue à l'analyse depuis le plan ragdoll) ; à
 * défaut (démos analysées avant), estimée d'après le kill, comme le jeu la pose (sonde 0.1 : direction tireur → victime à
 * 12° près, normes discrètes par arme, × 1,3 à la tête) :
 *  - balle : des yeux du tireur (sa position + EYE_STAND) vers la zone touchée de la victime (ZONE_Z au-dessus de ses pieds) ;
 *  - HE : depuis l'explosion de la dernière HE du tireur avant la mort ; bombe : depuis la bombe posée ;
 *  - couteau, Zeus, impact d'une grenade : KNIFE_FORCE des yeux du tireur vers la victime ;
 *  - chute, monde, feu, tireur inconnu : FALL_FORCE vers le bas.
 * Pure : ne dépend que du replay et du kill. HIT_BODY : le corps du ragdoll qui reçoit la part de l'impulsion de la zone
 * touchée (ragdolls.ts) ; les autres zones et un corps absent du ragdoll : tout le corps.
 */
import type { KillEvent, Vec3 } from "../../shared/api/types";
import type { Replay } from "../replay/engine/replay";
import { lastZone } from "./agentAnim";
import { EYE_STAND } from "./world";

/** Normes par arme (noms des événements de la démo). Mesurées : awp, deagle, mac10, mp9, mp7, glock, usp_silencer,
 *  hkp2000, p250, fiveseven, tec9, elite ; les fusils (ak47, m4a1, m4a1_silencer, galilar, famas : 24 000) prennent
 *  RIFLE_FORCE. Estimées par famille (pas vues dans les démos de la sonde) : cz75a, revolver, mp5sd, ump45, p90, bizon. */
export const WEAPON_FORCE: Record<string, number> = {
  awp: 28000, deagle: 24000, revolver: 24000, mac10: 21000, mp5sd: 21000, ump45: 21000, p90: 21000, bizon: 21000,
  mp9: 20000, mp7: 20000, glock: 20000, usp_silencer: 20000, hkp2000: 20000, p250: 20000, fiveseven: 20000, tec9: 20000,
  elite: 20000, cz75a: 20000,
};
export const RIFLE_FORCE = 24000, HEAD_X = 1.3, KNIFE_FORCE = 300, HE_FORCE = 8500, C4_FORCE = 12417, FALL_FORCE = 1000;
/** Hauteur de la zone touchée au-dessus des pieds (unités) : vers où pousse une balle. */
export const ZONE_Z: Record<string, number> = { head: 64, neck: 60, chest: 50, left_arm: 50, right_arm: 50, stomach: 40,
  generic: 45, left_leg: 20, right_leg: 20 };
/** Corps du ragdoll qui reçoit la part de l'impulsion de la zone touchée (banc d'essai, SPX/proto/run.ts). */
export const HIT_BODY: Record<string, string> = { head: "head_0", neck: "head_0", chest: "spine_2", stomach: "pelvis",
  generic: "spine_2", left_arm: "arm_upper_l", right_arm: "arm_upper_r", left_leg: "leg_upper_l", right_leg: "leg_upper_r" };
const DOWN = (): Vec3 => [0, 0, -FALL_FORCE];
const SMALL = /^(knife|bayonet|taser|flashbang|smokegrenade|decoy)/;
const NO_PUSH = new Set(["world", "inferno", "molotov", "incgrenade", "trigger_hurt", ""]);

export interface DeathForce { f: Vec3; zone: string; read: boolean }

/** `norm` unités de force de `from` vers `to` ; vers le bas si les deux points sont confondus. */
function toward(from: Vec3, to: Vec3, norm: number): Vec3 {
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2], l = Math.hypot(dx, dy, dz);
  return l > 1e-6 ? [(dx / l) * norm, (dy / l) * norm, (dz / l) * norm] : [0, 0, -norm];
}

export function deathForce(r: Replay, k: KillEvent): DeathForce {
  const zone = lastZone(r, k.victim, k.tick), p = r.players.find((x) => x.steamid === k.victim);
  const read = p ? r.deathForce(p.index, k.tick) : null;
  if (read) return { f: [read[0], read[1], read[2]], zone, read: true };
  return { f: estimate(r, k, zone), zone, read: false };
}

function estimate(r: Replay, k: KillEvent, zone: string): Vec3 {
  const w = (k.weapon || "").toLowerCase(), v = k.victim_pos, hit: Vec3 = [v[0], v[1], v[2] + (ZONE_Z[zone] ?? ZONE_Z.generic)];
  if (w === "hegrenade") {
    let at: Vec3 | null = null, last = -Infinity;
    for (const g of r.payload.grenades) {
      if (g.type !== "he" || g.thrower !== k.attacker || g.detonate_tick === null || !g.detonate_pos) continue;
      if (g.detonate_tick <= k.tick && g.detonate_tick > last) { last = g.detonate_tick; at = g.detonate_pos; }
    }
    return at ? toward(at, hit, HE_FORCE) : DOWN();
  }
  if (w === "planted_c4") {
    const plant = r.payload.bomb.filter((b) => b.type === "plant" && b.pos && b.tick <= k.tick).at(-1);
    return plant?.pos ? toward(plant.pos, hit, C4_FORCE) : DOWN();
  }
  if (NO_PUSH.has(w) || !k.attacker_pos) return DOWN();
  const a = k.attacker_pos, eye: Vec3 = [a[0], a[1], a[2] + EYE_STAND];
  if (SMALL.test(w)) return toward(eye, hit, KNIFE_FORCE);
  return toward(eye, hit, (WEAPON_FORCE[w] ?? RIFLE_FORCE) * (zone === "head" ? HEAD_X : 1));
}
