export function formatDuration(s: number): string {
  const t = Math.max(0, Math.floor(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}
export function formatMoney(v: number): string {
  return "$" + String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}
export function formatDate(iso: string | null): string {
  if (!iso) return "—";
  // une date seule (AAAA-MM-JJ) est un jour calendaire : la lire en heure locale, pas en UTC (sinon décalage d'un jour)
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00:00`) : new Date(iso);
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
}
/** Date et heure d'un horodatage du serveur : ISO naïf (sans fuseau) = UTC, on ajoute « Z » avant de le lire. */
export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(/(Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("fr-FR", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
export const END_REASON_LABEL: Record<string, string> = {
  t_killed: "Élimination", ct_killed: "Élimination", bomb_exploded: "Explosion", bomb_defused: "Désamorçage",
  time_ran_out: "Temps écoulé", target_saved: "Temps écoulé", t_surrender: "Abandon", ct_surrender: "Abandon",
};
export const BUY_LABEL: Record<string, string> = { pistol: "Pistol", eco: "Eco", semi: "Semi", force: "Force", full: "Full" };

const WEAPON_LABEL: Record<string, string> = {
  m4a1_silencer: "M4A1-S", m4a1: "M4A4", usp_silencer: "USP-S", hkp2000: "P2000", glock: "Glock", ak47: "AK-47",
  awp: "AWP", deagle: "Deagle", famas: "FAMAS", galilar: "Galil", ssg08: "Scout", aug: "AUG", sg556: "SG 553",
  mp9: "MP9", mac10: "MAC-10", mp7: "MP7", ump45: "UMP-45", p90: "P90", tec9: "Tec-9", fiveseven: "Five-SeveN",
  cz75a: "CZ75", p250: "P250", elite: "Dualies", revolver: "R8", hegrenade: "HE", inferno: "Molotov",
  molotov: "Molotov", incgrenade: "Incendiaire", flashbang: "Flash", smokegrenade: "Smoke", knife: "Couteau",
  taser: "Zeus", world: "Monde", planted_c4: "C4",
};
/** Nom lisible d'une arme du kill feed (noms internes demoparser2 : « m4a1_silencer », « knife_karambit »…). */
export function weaponLabel(w: string): string {
  if (WEAPON_LABEL[w]) return WEAPON_LABEL[w];
  if (w.startsWith("knife") || w.startsWith("bayonet")) return "Couteau";
  return w.replace(/_/g, " ");
}
