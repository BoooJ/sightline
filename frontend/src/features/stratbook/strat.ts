import type { Strat, StratCategory, StratStatus, StratType } from "../../shared/api/types";
import { PRACTICE_SETTINGS, aliasName } from "../../shared/practiceCfg";

export const STRAT_TYPES: Record<StratType, string> = {
  execute: "Exécution", default: "Default", rush: "Rush", setup: "Setup", retake: "Retake", other: "Autre",
};

/** Code couleur du stratbook de l'équipe (le genre de round), dans l'ordre de leur feuille. */
export const STRAT_CATEGORIES: Record<StratCategory, { label: string; color: string }> = {
  pistol: { label: "Pistol", color: "#e9c46a" },
  eco: { label: "Éco sèche", color: "#9aa5b1" },
  anti_eco: { label: "Anti-éco / force", color: "#4cc9f0" },
  force: { label: "Round 2 / force", color: "#f4a261" },
  rapide: { label: "Round rapide", color: "#ef5f67" },
  lance: { label: "Round lancé", color: "#b980f0" },
  controle: { label: "Contrôle / lent", color: "#52b788" },
  finition: { label: "Finition", color: "#5b8def" },
  reaction: { label: "Réaction", color: "#f78fb3" },
  indiv: { label: "Move indiv", color: "#c2a07a" },
};
export const STRAT_STATUS: Record<StratStatus, string> = { ready: "Prête", wip: "À travailler" };

/** Nom court d'un lien de référence : son libellé, sinon le site. */
export const hostLabel = (l: { url: string; label?: string }) => l.label || l.url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0];

/** Config CS2 d'une stratégie : alias pos_<joueur> pour les positions et nade_N pour les grenades avec setpos. */
export function stratCfg(s: Strat): string {
  const give: Record<string, string> = { smoke: "weapon_smokegrenade", flash: "weapon_flashbang", he: "weapon_hegrenade", molotov: "weapon_molotov", incendiary: "weapon_incgrenade", decoy: "weapon_decoy" };
  const pos = s.positions.map((p) => `alias pos_${aliasName(p.name || p.role || "joueur")} "setpos ${p.pos.map((v) => v.toFixed(2)).join(" ")}; setang 0 ${p.yaw.toFixed(2)} 0"`);
  const nades = s.grenades.map((g, i) => (g.setpos ? `alias nade_${i + 1} "give ${give[g.type]}; ${g.setpos}"` : null)).filter(Boolean) as string[];
  return [`// Stratbook — ${s.name} (${s.side}, ${s.map})`, "// exec <fichier> sur un serveur privé, puis pos_<joueur> / nade_N", "",
    ...PRACTICE_SETTINGS, ...pos, ...nades,
    ...s.positions.map((p) => `echo "pos_${aliasName(p.name || p.role || "joueur")}"`), ...nades.map((_, i) => `echo "nade_${i + 1}"`), ""].join("\n");
}

/** Adresse d'une stratégie dans le stratbook (une seule page : carte, puis stratégie choisie). */
export const stratHref = (s: { id: number; map: string }, board = false) =>
  `/stratbook?${new URLSearchParams({ map: s.map, s: String(s.id), ...(board ? { board: "1" } : {}) })}`;
