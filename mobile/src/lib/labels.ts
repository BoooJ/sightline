import type { AimZone, DeathReason, EventKind, GrenadeType, Reliability, StratType } from "@/api/types";

// Mêmes libellés que le site (REASON_LABEL de features/players/PlayerPage.tsx).
export const REASON_LABEL: Record<DeathReason, string> = {
  untraded: "Non échangé", isolated: "Isolé", behind: "Pris à revers", blind: "Aveuglé", outnumbered: "En infériorité",
  utility: "Utilitaires non utilisés", opening: "Duel d'ouverture perdu", lost_cause: "Round déjà perdu",
  saveable: "Aurait dû sauver", side: "Pris de côté", unchecked: "Angle jamais regardé", dry: "Duel à sec",
};

export const AIM_ZONES: AimZone[] = ["viseur", "champ", "cote", "dos"];
export const AIM_ZONE_LABEL: Record<AimZone, { title: string; range: string }> = {
  viseur: { title: "Dans le viseur", range: "≤ 10°" },
  champ: { title: "Dans le champ", range: "10–45°" },
  cote: { title: "Sur le côté", range: "45–110°" },
  dos: { title: "Dans le dos", range: "> 110°" },
};

export const NADE_LABEL: Record<GrenadeType, string> = {
  smoke: "Smoke", flash: "Flash", he: "HE", molotov: "Molotov", incendiary: "Molotov", decoy: "Leurre",
};
export const NADE_TYPES: GrenadeType[] = ["smoke", "flash", "molotov", "he"];

// Mêmes libellés que le site (STRAT_TYPES de features/stratbook/StratbookPage.tsx).
export const STRAT_TYPE_LABEL: Record<StratType, string> = {
  execute: "Exécution", default: "Default", rush: "Rush", setup: "Setup", retake: "Retake", other: "Autre",
};

export const RELIABILITY_LABEL: Record<Reliability, string> = {
  none: "pas de donnée", anecdotal: "anecdotique", indicative: "indicatif", solid: "solide",
};

export const EVENT_KIND_LABEL: Record<EventKind, string> = {
  match: "Match", tournament: "Tournoi", scrim: "Scrim", practice: "Entraînement", other: "Autre",
};

// Mêmes noms que le site (frontend/src/shared/format.ts).
const WEAPON_LABEL: Record<string, string> = {
  m4a1_silencer: "M4A1-S", m4a1: "M4A4", usp_silencer: "USP-S", hkp2000: "P2000", glock: "Glock", ak47: "AK-47",
  awp: "AWP", deagle: "Deagle", famas: "FAMAS", galilar: "Galil", ssg08: "Scout", aug: "AUG", sg556: "SG 553",
  mp9: "MP9", mac10: "MAC-10", mp7: "MP7", ump45: "UMP-45", p90: "P90", tec9: "Tec-9", fiveseven: "Five-SeveN",
  cz75a: "CZ75", p250: "P250", elite: "Dualies", revolver: "R8", hegrenade: "HE", inferno: "Molotov",
  molotov: "Molotov", incgrenade: "Incendiaire", flashbang: "Flash", smokegrenade: "Smoke", knife: "Couteau",
  taser: "Zeus", world: "Monde", planted_c4: "C4",
};

export function weaponLabel(w: string): string {
  if (WEAPON_LABEL[w]) return WEAPON_LABEL[w];
  if (w.startsWith("knife") || w.startsWith("bayonet")) return "Couteau";
  return w.replace(/_/g, " ");
}

/** Nom de lieu du jeu lisible : « CTSpawn » → « CT Spawn », « BombsiteB » → « Bombsite B ». */
export function placeLabel(place: string | null | undefined): string {
  if (!place) return "";
  return place
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-zA-Z])(\d)/g, "$1 $2");
}

/** « de_dust2 » → « Dust2 » quand le nom affiché manque. */
export function mapLabel(name: string, display?: string | null): string {
  if (display) return display;
  const s = name.replace(/^de_/, "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
