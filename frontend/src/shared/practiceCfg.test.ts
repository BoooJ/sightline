import { describe, expect, it } from "vitest";
import { aliasName, lineupCfg, lineupPackCfg, positionsCfg } from "./practiceCfg";

describe("configs d'entraînement", () => {
  it("noms d'alias sûrs pour la console", () => {
    expect(aliasName("Ex3rcice")).toBe("ex3rcice");
    expect(aliasName("Joël \"le boss\"")).toBe("joel_le_boss");
  });
  it("lineup : grenade en main puis téléportation", () => {
    const cfg = lineupCfg("de_nuke", { type: "smoke", setpos: "setpos 1.00 2.00 3.00;setang 4.00 5.00 0", label: "Maka" });
    expect(cfg).toContain("sv_cheats 1");
    expect(cfg.indexOf("give weapon_smokegrenade")).toBeLessThan(cfg.indexOf("setpos 1.00"));
  });
  it("pack et positions : un alias par élément", () => {
    const pack = lineupPackCfg("de_nuke", [{ type: "flash", setpos: "setpos 1 2 3;setang 0 0 0", label: "a" }, { type: "he", setpos: "setpos 4 5 6;setang 0 0 0", label: "b" }]);
    expect(pack).toContain('alias lineup_1 "give weapon_flashbang; setpos 1 2 3');
    expect(pack).toContain("alias lineup_2 \"give weapon_hegrenade");
    const pos = positionsCfg("R2", [{ name: "rain", side: "CT", x: 1, y: 2, z: 3, yaw: 90 }]);
    expect(pos).toContain('alias pos_rain "setpos 1.00 2.00 3.00; setang 0 90.00 0');
  });
});
