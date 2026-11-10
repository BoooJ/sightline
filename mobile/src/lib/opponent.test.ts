import { describe, expect, it } from "vitest";

import type { ScoutTeam } from "@/api/types";

import { matchOpponent, normalizeName } from "./opponent";

const team = (id: number, name: string, matches = 1): ScoutTeam => ({ id, name, matches, wins: 0, maps: 1 });

describe("adversaire", () => {
  it("normalise comme le serveur (minuscules, lettres et chiffres)", () => {
    expect(normalizeName("Team Vitality!")).toBe("teamvitality");
    expect(normalizeName("Équipe 3DMAX")).toBe("equipe3dmax");
  });
  it("préfère l'égalité, puis l'inclusion, puis l'équipe la plus jouée", () => {
    const teams = [team(1, "MOUZ NXT", 2), team(2, "MOUZ", 3), team(3, "Vitality", 9)];
    expect(matchOpponent("mouz", teams)?.id).toBe(2);
    expect(matchOpponent("Team Vitality", teams)?.id).toBe(3);
    expect(matchOpponent("NXT", teams)?.id).toBe(1);
    expect(matchOpponent("FaZe", teams)).toBeNull();
    expect(matchOpponent("  ", teams)).toBeNull();
  });
});
