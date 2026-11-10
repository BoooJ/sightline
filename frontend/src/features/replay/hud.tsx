/** HUD du replay : classement des objets d'inventaire, icônes d'armes CS2 (public/weapons, en masques CSS pour
 *  piloter la couleur) et pictogrammes d'équipement (armure, kit). */
import { WEAPON_ICON_RATIO } from "./weaponIcons";

export type WeaponClass = "rifle" | "sniper" | "smg" | "heavy" | "pistol" | "knife" | "zeus";
export type NadeKind = "smoke" | "flash" | "he" | "molotov" | "decoy";

const CLASS: Record<string, WeaponClass> = {
  "AK-47": "rifle", M4A4: "rifle", "M4A1-S": "rifle", FAMAS: "rifle", "Galil AR": "rifle", AUG: "rifle", "SG 553": "rifle",
  AWP: "sniper", "SSG 08": "sniper", "SCAR-20": "sniper", G3SG1: "sniper",
  MP9: "smg", "MAC-10": "smg", MP7: "smg", "MP5-SD": "smg", "UMP-45": "smg", P90: "smg", "PP-Bizon": "smg",
  Nova: "heavy", XM1014: "heavy", "MAG-7": "heavy", "Sawed-Off": "heavy", Negev: "heavy", M249: "heavy",
  "Glock-18": "pistol", "USP-S": "pistol", P2000: "pistol", P250: "pistol", "Tec-9": "pistol", "Five-SeveN": "pistol",
  "CZ75-Auto": "pistol", "Desert Eagle": "pistol", "Dual Berettas": "pistol", "R8 Revolver": "pistol",
  "Zeus x27": "zeus",
};
const SHORT: Record<string, string> = {
  "AK-47": "AK-47", "Galil AR": "Galil", "SG 553": "SG", "SSG 08": "Scout", "Glock-18": "Glock", "Desert Eagle": "Deagle",
  "Dual Berettas": "Dualies", "R8 Revolver": "R8", "CZ75-Auto": "CZ75", "Five-SeveN": "Five-7", "PP-Bizon": "Bizon", "Zeus x27": "Zeus",
};
const NADES: Record<string, NadeKind> = {
  "Smoke Grenade": "smoke", Flashbang: "flash", "High Explosive Grenade": "he", Molotov: "molotov", "Incendiary Grenade": "molotov", "Decoy Grenade": "decoy",
};
const NADE_LABEL: Record<NadeKind, string> = { smoke: "Smoke", flash: "Flash", he: "HE", molotov: "Molotov / incendiaire", decoy: "Leurre" };

export const nadeKind = (name: string): NadeKind | undefined => NADES[name];

// nom affiché par le jeu (inventaire, arme en main) → fichier d'icône
const ICON_BY_NAME: Record<string, string> = {
  "AK-47": "ak47", AUG: "aug", AWP: "awp", "PP-Bizon": "bizon", "C4 Explosive": "c4", "CZ75-Auto": "cz75a", "Desert Eagle": "deagle",
  "Decoy Grenade": "decoy", "Dual Berettas": "elite", FAMAS: "famas", "Five-SeveN": "fiveseven", Flashbang: "flashbang", G3SG1: "g3sg1",
  "Galil AR": "galilar", "Glock-18": "glock", "High Explosive Grenade": "hegrenade", P2000: "hkp2000", "Incendiary Grenade": "incgrenade",
  M249: "m249", M4A4: "m4a1", "M4A1-S": "m4a1_silencer", "MAC-10": "mac10", "MAG-7": "mag7", Molotov: "molotov", "MP5-SD": "mp5sd",
  MP7: "mp7", MP9: "mp9", Negev: "negev", Nova: "nova", P250: "p250", P90: "p90", "R8 Revolver": "revolver", "Sawed-Off": "sawedoff",
  "SCAR-20": "scar20", "SG 553": "sg556", "Smoke Grenade": "smokegrenade", "SSG 08": "ssg08", "Zeus x27": "taser", "Tec-9": "tec9",
  "UMP-45": "ump45", "USP-S": "usp_silencer", XM1014: "xm1014",
};

/** Icône d'une arme d'après son nom affiché (inventaire) ou interne (kill feed : « ak47 », « knife_karambit »). */
export function weaponIconKey(name: string, side?: "CT" | "T"): string | null {
  if (ICON_BY_NAME[name]) return ICON_BY_NAME[name];
  const n = name.replace(/^weapon_/, "");
  if (WEAPON_ICON_RATIO[n]) return n;
  if (n === "incgrenade" || n === "inferno") return "molotov";
  if (weaponClass(name) === "knife" || n.startsWith("knife") || n.startsWith("bayonet")) return side === "T" ? "knife_t" : "knife";
  return null;
}

export function WeaponIcon({ name, side, height = 14, className, title }: { name: string; side?: "CT" | "T"; height?: number; className?: string; title?: string }) {
  const key = weaponIconKey(name, side);
  if (!key) return null;
  const w = Math.round(height * (WEAPON_ICON_RATIO[key] ?? 2));
  return <span className={`wicon ${className ?? ""}`} role="img" aria-label={title ?? name} title={title ?? name}
    style={{ width: w, height, WebkitMaskImage: `url(/weapons/${key}.svg)`, maskImage: `url(/weapons/${key}.svg)` }} />;
}

export function weaponClass(name: string): WeaponClass | null {
  if (CLASS[name]) return CLASS[name];
  if (/knife|bayonet|karambit|dagger|bowie|falchion|huntsman|butterfly|navaja|stiletto|talon|ursus|kukri|classic|skeleton|nomad|paracord|survival|gut/i.test(name)) return "knife";
  return null;
}
/** Les quatre snipers (AWP, SSG 08, SCAR-20, G3SG1), d'après la classe ci-dessus : seule liste de l'app (vue du joueur :
 *  lunette noire, pas de réticule ; la même classe range l'inventaire et compte parmi les armes à feu du HUD). */
export const isSniper = (name: string) => CLASS[name] === "sniper";
export const shortWeapon = (name: string) => SHORT[name] ?? name;

/** Inventaire rangé : arme principale, pistolet, grenades (dans l'ordre du jeu), zeus. */
export function sortInventory(inv: string[]) {
  const primary = inv.find((w) => ["rifle", "sniper", "smg", "heavy"].includes(weaponClass(w) ?? ""));
  const pistol = inv.find((w) => weaponClass(w) === "pistol");
  const order: NadeKind[] = ["he", "flash", "smoke", "molotov", "decoy"];
  const nades = inv.map((w) => NADES[w]).filter(Boolean).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return { primary, pistol, nades, zeus: inv.includes("Zeus x27") };
}

const NADE_ICON: Record<NadeKind, string> = { smoke: "Smoke Grenade", flash: "Flashbang", he: "High Explosive Grenade", molotov: "Molotov", decoy: "Decoy Grenade" };

export function NadeIcon({ kind, held }: { kind: NadeKind; held?: boolean }) {
  const icon = <WeaponIcon name={NADE_ICON[kind]} height={15} className={`hud-nade hud-${kind}`} title={NADE_LABEL[kind] + (held ? " (en main)" : "")} />;
  // le masque de l'icône masquerait un contour : la mise en évidence est portée par un conteneur
  return held ? <span className="hud-held">{icon}</span> : icon;
}

export function ArmorIcon({ helmet }: { helmet: boolean }) {
  return helmet ? (
    <svg className="hud-gear" viewBox="0 0 14 14" role="img" aria-label="Gilet et casque">
      <title>Gilet et casque</title>
      <path d="M2 9a5 5 0 0 1 10 0v1H9.5V9h-5v1H2z" fill="currentColor" /><path d="M1 11h12v1.6H1z" fill="currentColor" />
    </svg>
  ) : (
    <svg className="hud-gear" viewBox="0 0 14 14" role="img" aria-label="Gilet seul">
      <title>Gilet seul</title>
      <path d="M7 1 12 3v4c0 3-2 5-5 6C4 12 2 10 2 7V3z" fill="currentColor" />
    </svg>
  );
}

export function KitIcon() {
  return (
    <svg className="hud-gear hud-kit" viewBox="0 0 14 14" role="img" aria-label="Kit de désamorçage">
      <title>Kit de désamorçage</title>
      <path d="M2 4h10v6H2z" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M5 4V2h4v2M4.5 7h5" stroke="currentColor" strokeWidth="1.5" fill="none" />
    </svg>
  );
}

export function BombIcon() {
  return <WeaponIcon name="C4 Explosive" height={13} className="hud-c4" title="Porte la bombe" />;
}
