import { describe, expect, it } from "vitest";
import type { KillEvent } from "../../shared/api/types";
import type { Replay } from "../replay/engine/replay";
import { C4_FORCE, deathForce, FALL_FORCE, HE_FORCE, HEAD_X, HIT_BODY, KNIFE_FORCE, RIFLE_FORCE, WEAPON_FORCE } from "./deathForce";

const len = (f: number[]) => Math.hypot(f[0], f[1], f[2]);
/** Replay réduit à ce que lit deathForce : joueurs, force lue, blessures, grenades, bombe. */
function replay(o: { read?: [number, number, number] | null; damages?: object[]; grenades?: object[]; bomb?: object[] } = {}): Replay {
  return {
    players: [{ steamid: "a", name: "a", side: "CT", slot: 1, index: 0 }, { steamid: "b", name: "b", side: "T", slot: 1, index: 1 }],
    deathForce: (j: number, tick: number) => (j === 0 && tick === 200 ? o.read ?? null : null),
    payload: { kills: [], damages: o.damages ?? [], grenades: o.grenades ?? [], bomb: o.bomb ?? [] },
  } as unknown as Replay;
}
const kill = (o: Partial<KillEvent> = {}): KillEvent =>
  ({ tick: 200, victim: "a", attacker: "b", weapon: "ak47", victim_pos: [1000, 0, 0], attacker_pos: [0, 0, 0], ...o }) as KillEvent;

describe("force de la mort", () => {
  it("lue dans la démo : telle quelle ; zone de la dernière blessure", () => {
    const r = replay({ read: [100, -20, 5], damages: [{ tick: 190, victim: "a", hitgroup: "stomach" }] });
    expect(deathForce(r, kill())).toEqual({ f: [100, -20, 5], zone: "stomach", read: true });
  });
  it("estimée : du regard du tireur vers la zone touchée, norme de l'arme, × 1,3 à la tête", () => {
    const chest = deathForce(replay({ damages: [{ tick: 200, victim: "a", hitgroup: "chest" }] }), kill());
    expect(chest.read).toBe(false);
    expect(len(chest.f)).toBeCloseTo(RIFLE_FORCE, 6);
    expect(chest.f[0]).toBeGreaterThan(0.99 * RIFLE_FORCE);  // du tireur (x 0) vers la victime (x 1000)
    expect(chest.f[2]).toBeLessThan(0);  // des yeux (64 u) vers la poitrine (50 u)
    const head = deathForce(replay({ damages: [{ tick: 200, victim: "a", hitgroup: "head" }] }), kill({ weapon: "awp" }));
    expect(len(head.f)).toBeCloseTo(WEAPON_FORCE.awp * HEAD_X, 6);
    expect(len(deathForce(replay(), kill({ weapon: "glock" })).f)).toBeCloseTo(20000, 6);
    expect(len(deathForce(replay(), kill({ weapon: "knife_karambit" })).f)).toBeCloseTo(KNIFE_FORCE, 6);
  });
  it("HE : depuis l'explosion de la dernière HE du tireur ; bombe : depuis la bombe posée ; chute, monde ou feu : vers le bas", () => {
    const he = deathForce(replay({ grenades: [{ type: "he", thrower: "b", detonate_tick: 150, detonate_pos: [900, 0, 40] },
      { type: "he", thrower: "b", detonate_tick: 250, detonate_pos: [0, 900, 40] }] }), kill({ weapon: "hegrenade" }));
    expect(len(he.f)).toBeCloseTo(HE_FORCE, 6);
    expect(he.f[0]).toBeGreaterThan(0.99 * HE_FORCE);  // celle d'avant la mort (x 900), pas celle d'après
    const c4 = deathForce(replay({ bomb: [{ tick: 100, type: "plant", player: "b", site: "A", pos: [1000, -500, 0] }] }), kill({ weapon: "planted_c4", attacker: null }));
    expect(len(c4.f)).toBeCloseTo(C4_FORCE, 6);
    expect(c4.f[1]).toBeGreaterThan(0);
    for (const w of ["world", "inferno", "trigger_hurt"]) expect(deathForce(replay(), kill({ weapon: w })).f).toEqual([0, 0, -FALL_FORCE]);
    expect(deathForce(replay(), kill({ attacker_pos: null })).f).toEqual([0, 0, -FALL_FORCE]);
  });
  it("couteau et Zeus : KNIFE_FORCE des yeux du tireur vers la victime", () => {
    for (const w of ["knife", "knife_t", "bayonet", "knife_karambit", "taser"]) {
      const f = deathForce(replay(), kill({ weapon: w })).f;
      expect(len(f)).toBeCloseTo(KNIFE_FORCE, 6);
      expect(f[0]).toBeGreaterThan(0.99 * KNIFE_FORCE);  // du tireur (x 0) vers la victime (x 1000)
      expect(f[2]).toBeLessThan(0);  // des yeux (64 u) vers la zone (45 u, aucune blessure : generic)
    }
  });
  it("HE sans explosion antérieure du tireur, bombe sans pose : vers le bas", () => {
    const down = [0, 0, -FALL_FORCE];
    const grenades = [{ type: "he", thrower: "b", detonate_tick: 250, detonate_pos: [900, 0, 40] },  // après la mort
      { type: "he", thrower: "c", detonate_tick: 150, detonate_pos: [900, 0, 40] },  // d'un autre
      { type: "he", thrower: "b", detonate_tick: 150, detonate_pos: null },  // sans position
      { type: "he", thrower: "b", detonate_tick: null, detonate_pos: [900, 0, 40] },  // jamais explosée
      { type: "smoke", thrower: "b", detonate_tick: 150, detonate_pos: [900, 0, 40] }];  // pas une HE
    expect(deathForce(replay({ grenades }), kill({ weapon: "hegrenade" })).f).toEqual(down);
    expect(deathForce(replay(), kill({ weapon: "hegrenade" })).f).toEqual(down);
    for (const bomb of [[], [{ tick: 300, type: "plant", player: "b", site: "A", pos: [1000, -500, 0] }],  // posée après
      [{ tick: 100, type: "plant", player: "b", site: "A", pos: null }], [{ tick: 100, type: "defuse", player: "a", site: "A", pos: [0, 0, 0] }]]) {
      expect(deathForce(replay({ bomb }), kill({ weapon: "planted_c4", attacker: null })).f).toEqual(down);
    }
  });
  it("mort sans attacker_pos (couteau, Zeus, arme à feu) : vers le bas ; la HE, elle, part toujours de son explosion", () => {
    for (const w of ["knife", "taser", "awp", "ak47"]) expect(deathForce(replay(), kill({ weapon: w, attacker_pos: null })).f).toEqual([0, 0, -FALL_FORCE]);
    const he = deathForce(replay({ grenades: [{ type: "he", thrower: "b", detonate_tick: 150, detonate_pos: [900, 0, 40] }] }),
      kill({ weapon: "hegrenade", attacker_pos: null }));
    expect(he.f[0]).toBeGreaterThan(0.99 * HE_FORCE);
  });
  it("corps qui reçoit l'impulsion, par zone touchée (banc d'essai)", () => {
    expect(HIT_BODY).toEqual({ head: "head_0", neck: "head_0", chest: "spine_2", stomach: "pelvis", generic: "spine_2",
      left_arm: "arm_upper_l", right_arm: "arm_upper_r", left_leg: "leg_upper_l", right_leg: "leg_upper_r" });
  });
});
