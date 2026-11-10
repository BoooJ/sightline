import { describe, expect, it } from "vitest";

import { parseSteamId } from "./steam";

describe("SteamID collé à la main", () => {
  it("prend le SteamID64 seul ou le lien de profil /profiles/…", () => {
    expect(parseSteamId("76561198796378854")).toBe("76561198796378854");
    expect(parseSteamId("  76561198796378854 ")).toBe("76561198796378854");
    expect(parseSteamId("https://steamcommunity.com/profiles/76561198796378854/")).toBe("76561198796378854");
    expect(parseSteamId("steamcommunity.com/profiles/76561198796378854")).toBe("76561198796378854");
  });
  it("refuse ce qui n'est pas un SteamID64 de joueur", () => {
    expect(parseSteamId("")).toBeNull();
    expect(parseSteamId("12345")).toBeNull();
    expect(parseSteamId("https://steamcommunity.com/id/sk1zy")).toBeNull(); // pseudo : pas d'identifiant dans le lien
    expect(parseSteamId("https://evil.example/profiles/76561198796378854")).toBeNull();
    expect(parseSteamId("STEAM_1:0:418056563")).toBeNull();
  });
});
