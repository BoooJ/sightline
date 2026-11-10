import { describe, expect, it } from "vitest";
import { isSniper, nadeKind, shortWeapon, sortInventory, weaponClass, weaponIconKey } from "./hud";

describe("HUD", () => {
  it("classe les armes", () => {
    expect(weaponClass("AK-47")).toBe("rifle");
    expect(weaponClass("AWP")).toBe("sniper");
    expect(weaponClass("Glock-18")).toBe("pistol");
    expect(weaponClass("Karambit")).toBe("knife");
    expect(weaponClass("Smoke Grenade")).toBeNull();
    expect(shortWeapon("Desert Eagle")).toBe("Deagle");
    expect(nadeKind("Incendiary Grenade")).toBe("molotov");
  });
  it("une seule liste des snipers : les quatre, pas l'AUG ni le SG 553 (viseur)", () => {
    expect(["AWP", "SSG 08", "SCAR-20", "G3SG1"].every(isSniper)).toBe(true);
    expect(["AUG", "SG 553", "AK-47", "Knife", ""].some(isSniper)).toBe(false);
  });
  it("range l'inventaire : principale, pistolet, grenades dans l'ordre du jeu", () => {
    const inv = sortInventory(["Knife", "Smoke Grenade", "USP-S", "Flashbang", "M4A1-S", "High Explosive Grenade", "Flashbang", "Zeus x27"]);
    expect(inv.primary).toBe("M4A1-S");
    expect(inv.pistol).toBe("USP-S");
    expect(inv.nades).toEqual(["he", "flash", "flash", "smoke"]);
    expect(inv.zeus).toBe(true);
    expect(sortInventory(["Knife", "Glock-18"]).primary).toBeUndefined();
  });
  it("trouve l'icône CS2 d'une arme (nom affiché ou interne)", () => {
    expect(weaponIconKey("M4A1-S")).toBe("m4a1_silencer");
    expect(weaponIconKey("M4A4")).toBe("m4a1");
    expect(weaponIconKey("ak47")).toBe("ak47");
    expect(weaponIconKey("knife_karambit", "T")).toBe("knife_t");
    expect(weaponIconKey("Karambit", "CT")).toBe("knife");
    expect(weaponIconKey("inferno")).toBe("inferno");  // icône du feu, comme dans le kill feed du jeu
    expect(weaponIconKey("world")).toBeNull();
  });
});
